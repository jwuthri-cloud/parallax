// Replay and Fleet: the script built from spans, the play clock and the office pose engine.
// Cases ported from Tracely (backend/tests/test_conversation_replay.py and
// frontend/app/components/replay/{timeline,office}.test.ts), plus the Parallax agent rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpanOut } from "../components/traces/tracely/lib/api";
import type { ConvNode, FullTurn } from "../components/traces/tracely/lib/api";
import { conversationVerdict } from "../components/traces/tracely/lib/conversation";
import {
  buildReplay,
  CUSTOMER,
  userTextOf,
} from "../components/traces/tracely/replay/script";
import {
  currentByActor,
  OFFICE_PACING,
  orderActors,
  realMsAt,
  toPlayEvents,
  type ReplayActor,
  type ReplayEvent,
} from "../components/traces/tracely/replay/timeline";
import {
  breakPlan,
  layoutOffice,
  narrate,
  phoneStateAt,
  poseAt,
  wallTools,
  wordOf,
} from "../components/traces/tracely/replay/office";

const t0 = Date.parse("2026-08-15T12:00:00Z");
type Extra = Partial<SpanOut> & { agent?: string; trace?: string };
function span(
  id: string,
  parent: string,
  type: string,
  name: string,
  atMs: number,
  durMs = 100,
  { agent, trace = "t1", ...extra }: Extra = {},
): SpanOut {
  return {
    span_id: id,
    parent_span_id: parent,
    name,
    type,
    level: "DEFAULT",
    status_message: "",
    start_time: new Date(t0 + atMs).toISOString(),
    end_time: new Date(t0 + atMs + durMs).toISOString(),
    latency_ms: durMs,
    agent_id: "",
    agent_run_id: trace,
    turn_id: trace,
    step_name: "",
    model_id: "",
    tokens: 0,
    cost: 0,
    metadata: agent ? { "tracely.agent.id": agent } : {},
    input: null,
    output: null,
    ...extra,
  };
}
/** The agents' script: the synthetic customer is tested on its own. */
function agentsOnly(spans: SpanOut[]) {
  const r = buildReplay(spans);
  return {
    ...r,
    actors: r.actors.filter((a) => a.id !== CUSTOMER),
    events: r.events.filter((e) => e.kind !== "ask"),
  };
}
const byName = <T extends { name: string }>(list: T[]) =>
  Object.fromEntries(list.map((e) => [e.name, e]));
const byId = (actors: ReplayActor[]) =>
  Object.fromEntries(actors.map((a) => [a.id, a]));

// A support agent calls a model and a tool, then a research sub-agent whose tool fails.
const conversation = () => [
  span("a", "", "AGENT", "support", 0, 900),
  span("b", "a", "GENERATION", "chat gpt", 20, 120, { model_id: "gpt" }),
  span("c", "a", "TOOL", "lookup_order", 160, 90),
  span("d", "a", "AGENT", "research", 300, 500),
  span("e", "d", "TOOL", "web_search", 340, 200, { level: "ERROR" }),
];

test("replay script: agents are named by their AGENT span, nested agents are sub-agents", () => {
  const r = agentsOnly(conversation());
  assert.deepEqual(
    r.actors.map((a) => a.id),
    ["support", "research"],
  );
  const actors = byId(r.actors);
  assert.equal(actors.support.kind, "agent");
  assert.equal(actors.support.depth, 0);
  assert.equal(actors.research.kind, "subagent");
  assert.equal(actors.research.parent, "support");
  const events = byName(r.events);
  assert.equal(events.lookup_order.actor, "support");
  assert.equal(events.web_search.actor, "research");
  assert.equal(events.web_search.status, "error");
  assert.equal(events["chat gpt"].kind, "llm");
  assert.equal(actors.research.errors, 1);
  assert.equal(actors.support.errors, 0);
});

test("replay script: the clock is relative to the first span and ordered", () => {
  const r = agentsOnly(conversation());
  const times = r.events.map((e) => e.t_ms);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.equal(r.events[0].t_ms, 0);
  assert.equal(r.durationMs, 900);
  assert.equal(r.events[1].dur_ms, 120);
});

test("replay script: empty and malformed input is safe", () => {
  assert.deepEqual(buildReplay([]), {
    durationMs: 0,
    actors: [],
    events: [],
    declared: [],
  });
  // a parent chain that points at a missing span must not hang or crash
  const r = agentsOnly([
    span("x", "ghost", "TOOL", "orphan", 0, 5, { agent: "solo" }),
  ]);
  assert.equal(r.actors[0].id, "solo");
  assert.equal(r.events[0].actor, "solo");
  // a span that names no agent and has no AGENT ancestor goes to the one default actor
  assert.equal(
    agentsOnly([span("y", "", "TOOL", "alone", 0, 5)]).actors[0].id,
    "agent",
  );
});

test("replay script: one agent across turns that reuse span ids", () => {
  // Two turns, each numbering spans from 1: the parent chain must not resolve across traces.
  const r = agentsOnly([
    span("1", "", "AGENT", "support", 0, 500),
    span("2", "1", "TOOL", "lookup", 50, 80),
    span("1", "", "AGENT", "billing", 900, 400, { trace: "t2" }),
    span("2", "1", "AGENT", "audit", 950, 200, { trace: "t2" }),
    span("1", "", "AGENT", "support", 2000, 300, { trace: "t3" }),
  ]);
  const actors = byId(r.actors);
  assert.deepEqual(Object.keys(actors).sort(), ["audit", "billing", "support"]);
  assert.equal(actors.audit.parent, "billing"); // not support, whose span also had id "1"
  assert.equal(actors.support.parent, "");
  assert.equal(actors.support.events, 3); // turn 1 (2 spans) and turn 3 are the same agent
});

test("replay script: a declared agent attribute wins over the enclosing AGENT span", () => {
  // Real teams tag every span with the agent that ran it; the wrapper must not swallow the team.
  const r = agentsOnly([
    span("w", "", "AGENT", "team", 0, 2000),
    span("g1", "w", "GENERATION", "chat", 100, 200, { agent: "supervisor" }),
    span("g2", "w", "GENERATION", "chat", 400, 200, {
      metadata: { "gen_ai.agent.name": "billing" },
    }),
    span("t", "w", "TOOL", "refund", 700, 100),
  ]);
  assert.deepEqual(
    r.events.map((e) => e.actor),
    ["team", "supervisor", "billing", "team"],
  );
});

test("replay script: CHAIN wrappers are containers, not work", () => {
  const events = byName(
    agentsOnly([
      span("w", "", "CHAIN", "agent_teams.turn", 0, 6000, { agent: "team" }),
      span("g", "", "GENERATION", "chat", 100, 400, { agent: "supervisor" }),
    ]).events,
  );
  assert.equal(events["agent_teams.turn"].kind, "turn");
  assert.equal(events["agent_teams.turn"].container, true);
  assert.equal(events.chat.container, false);
});

test("replay script: stations follow the span type", () => {
  const r = agentsOnly([
    span("a", "", "AGENT", "run", 0, 2000),
    span("b", "a", "GENERATION", "chat", 10, 100),
    span("c", "a", "THINKING", "thinking", 120, 50),
    span("d", "a", "TOOL", "lookup_faq", 200, 100),
    span("f", "a", "RETRIEVER", "vector_fetch", 440, 100),
    span("g", "a", "SKILL", "refund-flow", 560, 300),
  ]);
  const events = byName(r.events);
  assert.equal(events.chat.station, "desk");
  assert.equal(events.thinking.station, "desk");
  assert.equal(events.lookup_faq.station, "computer"); // a TOOL named lookup is still a tool
  assert.equal(events.vector_fetch.station, "library");
  assert.equal(events["refund-flow"].station, "library");
  assert.equal(events.thinking.kind, "think");
  assert.equal(events["refund-flow"].kind, "skill");
});

test("replay script: a DELEGATE span names its callee and carries the task", () => {
  const r = agentsOnly([
    span("a", "", "AGENT", "sup", 0, 3000),
    span("b", "a", "DELEGATE", "delegate:billing", 100, 2000, {
      metadata: { "tracely.handoff.callee_agent_id": "Billing" },
      input: "refund order 4471, card ending 1234",
    }),
    span("c", "b", "AGENT", "billing", 200, 1500),
  ]);
  const d = r.events.find((e) => e.kind === "delegate")!;
  assert.equal(d.container, true);
  assert.equal(d.delegate_to, "billing");
  assert.equal(d.say, "refund order 4471, card ending 1234");
  assert.equal(byId(r.actors).billing.parent, "sup");
  // without the attribute, the span NAME resolves the callee
  const named = agentsOnly([
    span("a", "", "AGENT", "sup", 0, 3000),
    span("b", "a", "DELEGATE", "billing", 100, 2000, { input: "refund it" }),
    span("c", "", "AGENT", "billing", 200, 1500),
  ]);
  assert.equal(
    named.events.find((e) => e.kind === "delegate")!.delegate_to,
    "billing",
  );
  assert.equal(byId(named.actors).billing.parent, "sup");
});

const toolCallOutput = (name: string, args: unknown) =>
  JSON.stringify([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  ]);

test("replay script: a tool call named after an agent is a handoff", () => {
  // Multi-agent harnesses call a sub-agent as a tool and often lose the parent span.
  const r = agentsOnly([
    span("s", "missing", "GENERATION", "chat", 0, 400, {
      agent: "sup",
      output: toolCallOutput("faq", { query: "find the remote" }),
    }),
    span("f", "also-missing", "GENERATION", "chat", 500, 300, { agent: "faq" }),
  ]);
  const first = r.events[0];
  assert.equal(first.delegate_to, "faq");
  assert.equal(first.station, "peer");
  assert.equal(first.say, "find the remote");
  assert.deepEqual(first.calls, ["faq"]);
  assert.equal(first.detail, "→ faq");
  assert.equal(byId(r.actors).faq.parent, "sup");
});

test("replay script: plain tools and tool spans never become delegations", () => {
  const plain = agentsOnly([
    span("s", "", "GENERATION", "chat", 0, 300, {
      agent: "a1",
      output: toolCallOutput("lookup_faq", {}),
    }),
    span("t", "", "TOOL", "lookup_faq", 350, 200, { agent: "a1" }),
  ]);
  assert.ok(plain.events.every((e) => e.delegate_to === ""));
  // a TOOL span named like an agent stays a tool: names share one namespace
  const collide = agentsOnly([
    span("a", "", "AGENT", "billing", 0, 300),
    span("s", "", "AGENT", "sup", 400, 600),
    span("t", "s", "TOOL", "billing", 450, 200),
  ]);
  assert.equal(
    collide.events.find((e) => e.type === "TOOL")!.station,
    "computer",
  );
  assert.ok(collide.events.every((e) => e.delegate_to === ""));
});

test("replay script: tool-call edges cannot build a cycle", () => {
  const r = agentsOnly([
    span("a", "", "GENERATION", "chat", 0, 100, {
      agent: "a",
      output: toolCallOutput("b", {}),
    }),
    span("b", "", "GENERATION", "chat", 200, 100, {
      agent: "b",
      output: toolCallOutput("a", {}),
    }),
  ]);
  const actors = byId(r.actors);
  assert.ok(actors.a.depth < 16 && actors.b.depth < 16);
  assert.ok(!(actors.a.parent === "b" && actors.b.parent === "a"));
});

test("replay script: bubbles show the words, never the JSON envelope", () => {
  const detail = (output: string | null, extra: Extra = {}) =>
    agentsOnly([
      span("g", "", "GENERATION", "chat", 0, 100, { output, ...extra }),
    ]).events[0].detail;
  assert.equal(
    detail(
      JSON.stringify([{ role: "assistant", content: "Your order shipped." }]),
    ),
    "Your order shipped.",
  );
  assert.equal(
    detail(
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
      }),
    ),
    "Part one. Part two.",
  );
  assert.equal(detail('"a JSON-encoded sentence"'), "a JSON-encoded sentence");
  assert.equal(detail("plain words"), "plain words");
  assert.equal(
    detail(JSON.stringify([{ role: "assistant", content: "" }])),
    "",
  );
  assert.equal(detail('{"total": 1299}'), '{"total": 1299}'); // not a message: still previews
  assert.equal(detail("{not json"), "{not json");
  // Anthropic tool_use blocks name the tool the model reached for
  assert.equal(
    detail(
      JSON.stringify({
        role: "assistant",
        content: [{ type: "tool_use", name: "search", input: {} }],
      }),
    ),
    "→ search",
  );
  // the failure message wins over the output
  assert.equal(
    detail("ignored", { level: "ERROR", status_message: "timeout after 30s" }),
    "timeout after 30s",
  );
  assert.equal(detail("x ".repeat(200)).length, 120);
});

test("replay script: the delegation text never shows a prompt envelope", () => {
  const r = agentsOnly([
    span("s", "", "GENERATION", "chat", 0, 400, {
      agent: "sup",
      input: JSON.stringify([{ role: "user", content: "secret prompt" }]),
      output: JSON.stringify([
        { role: "assistant", tool_calls: ["junk", { function: "junk" }] },
        {
          role: "assistant",
          tool_calls: [{ function: { name: "faq", arguments: "{bad" } }],
        },
      ]),
    }),
    span("f", "", "GENERATION", "chat", 500, 300, { agent: "faq" }),
  ]);
  assert.equal(r.events[0].delegate_to, "faq");
  assert.equal(r.events[0].say, "{bad"); // unparsable arguments are shown raw, the prompt never
});

test("replay script: the customer leads the cast and asks once per turn", () => {
  const history = JSON.stringify([
    { role: "system", content: "You help." },
    { role: "user", content: "Where is my order?" },
    { role: "assistant", content: "Shipped yesterday." },
    { role: "user", content: [{ type: "text", text: "Refund it please." }] },
  ]);
  const r = buildReplay([
    span("1", "", "AGENT", "sup", 0, 500, { input: "Where is my order?" }),
    span("2", "1", "GENERATION", "chat", 50, 80),
    span("1", "", "CHAIN", "graph", 900, 400, { trace: "t2", input: history }),
    span("2", "1", "GENERATION", "chat", 950, 200, { trace: "t2" }),
  ]);
  assert.deepEqual(r.actors[0], {
    id: CUSTOMER,
    name: "customer",
    kind: "customer",
    parent: "",
    depth: 0,
    first_ms: 0,
    last_ms: 900,
    events: 2,
    errors: 0,
  });
  const asks = r.events.filter((e) => e.kind === "ask");
  assert.deepEqual(
    asks.map((a) => [a.t_ms, a.trace_id, a.detail]),
    [
      [0, "t1", "Where is my order?"],
      [900, "t2", "Refund it please."], // the LAST user message, not the first
    ],
  );
  assert.equal(r.events[0].kind, "ask"); // the ask leads its turn on the clock
  assert.ok(
    asks.every(
      (e) => e.station === "door" && e.container === false && e.type === "",
    ),
  );
});

test("replay script: the ask falls back to the first prompt when the root is config", () => {
  const ask = buildReplay([
    span("1", "", "CHAIN", "crew", 0, 500, {
      input: '{"agents": ["x"], "verbose": true}',
    }),
    span("2", "1", "GENERATION", "chat", 100, 80, {
      input: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "Plan my trip" }],
      }),
    }),
    span("3", "1", "GENERATION", "chat", 300, 80, {
      input: JSON.stringify([
        { role: "user", content: "later internal prompt" },
      ]),
    }),
  ]).events.find((e) => e.kind === "ask")!;
  assert.equal(ask.detail, "Plan my trip");
  assert.equal(userTextOf('{"tool": "args"}'), "");
  assert.equal(
    userTextOf([{ role: "assistant", content: "not the user" }]),
    "",
  );
});

test("replay script: the tools a model call was offered", () => {
  const r = buildReplay([
    span("a", "", "AGENT", "sup", 0, 900),
    span("g", "a", "GENERATION", "chat", 10, 100, {
      input: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "refund", description: "Refund an order" },
          },
          { name: "search" },
          "junk",
        ],
      }),
    }),
    span("h", "a", "GENERATION", "chat", 200, 100, {
      metadata: {
        "gen_ai.tool.definitions": JSON.stringify([
          { name: "refund" },
          { name: "lookup" },
        ]),
      },
    }),
    span("t", "a", "TOOL", "search", 400, 100),
  ]);
  assert.deepEqual(r.declared, [
    {
      name: "sup",
      tools: [
        { name: "refund", description: "Refund an order" },
        { name: "search", description: "" },
        { name: "lookup", description: "" },
      ],
    },
  ]);
  // the wall shows what ran first (lit), then what was only offered (dim)
  const { events } = toPlayEvents(r.events);
  assert.deepEqual(wallTools(events, r.declared[0].tools), [
    { name: "search", used: true },
    { name: "refund", used: false },
    { name: "lookup", used: false },
  ]);
});

// ── the play clock (timeline.ts) ────────────────────────────────────────────────
const ev = (
  t: number,
  dur: number,
  actor: string,
  kind: string,
  name: string,
  extra: Partial<ReplayEvent> = {},
): ReplayEvent => ({
  t_ms: t,
  dur_ms: dur,
  actor,
  kind,
  name,
  status: "ok",
  model: "",
  detail: "",
  span_id: `${actor}-${name}-${t}`,
  trace_id: "t",
  turn_id: "",
  station: "desk",
  delegate_to: "",
  say: "",
  ...extra,
});

test("play clock: dead air is squeezed and short spans stay visible", () => {
  const { events, total } = toPlayEvents([
    ev(0, 100, "a", "tool", "x"),
    ev(20000, 2, "b", "tool", "y"),
  ]);
  assert.equal(events[0].pt, 0);
  assert.equal(events[1].pt, 400); // the 20 s gap collapses to the cap
  assert.equal(events[1].pdur, 140); // the visibility floor
  assert.equal(total, 540);
  // the readout still gives real trace time
  assert.equal(realMsAt(events, events[1].pt + events[1].pdur), 20002);
});

test("play clock: a container ends with the work it brackets, long calls are clamped", () => {
  const wrap = { ...ev(0, 16000, "team", "turn", "turn-1"), container: true };
  const { events, total } = toPlayEvents([
    wrap,
    ev(100, 300, "a", "tool", "x"),
    ev(12900, 9000, "a", "llm", "y"),
  ]);
  assert.equal(events[0].pt + events[0].pdur, events[2].pt + events[2].pdur);
  assert.ok(events[0].pt + events[0].pdur <= total);
  assert.ok(events[2].pdur <= 1600);
  assert.equal(currentByActor(events, 200).team, undefined); // the wrapper is not an action
  assert.equal(currentByActor(events, 200).a.name, "x");
});

test("play clock: sub-agents are ordered under their parent", () => {
  const actors = [
    { id: "billing", parent: "" },
    { id: "support", parent: "" },
    { id: "audit", parent: "billing" },
  ] as ReplayActor[];
  assert.deepEqual(
    orderActors(actors).map((a) => a.id),
    ["billing", "audit", "support"],
  );
});

// ── the office (office.ts) ──────────────────────────────────────────────────────
const actor = (id: string, parent = "", depth = 0): ReplayActor => ({
  id,
  name: id,
  kind: depth ? "subagent" : "agent",
  parent,
  depth,
  first_ms: 0,
  last_ms: 0,
  events: 0,
  errors: 0,
});

test("office: desks never stack, however big the team", () => {
  for (const n of [2, 5, 8, 12, 20]) {
    const team = [
      actor("boss"),
      ...Array.from({ length: n }, (_, i) => actor(`sub${i}`, "boss", 1)),
    ];
    const layout = layoutOffice(team);
    const desks = Object.values(layout.desks);
    assert.equal(desks.length, n + 1);
    const rows = new Map<number, number[]>();
    for (const p of desks)
      rows.set(Math.round(p.y / 14), [
        ...(rows.get(Math.round(p.y / 14)) ?? []),
        p.x,
      ]);
    for (const xs of rows.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++)
        assert.ok(xs[i] - xs[i - 1] > 12 * layout.deskScale, `team of ${n}`);
    }
    for (const p of desks) {
      assert.ok(p.x > 14 && p.x < 86 && p.y < 90); // clear of library, tool wall, stage edge
      if (p.y > 50) assert.ok(p.x > 30); // clear of the break room
    }
  }
});

test("office: a tool runs at the tool wall, a skill at the library, a handoff rings a phone", () => {
  const actors = [actor("sup"), actor("faq", "sup", 1)];
  const layout = layoutOffice(actors);
  const { events } = toPlayEvents(
    [
      ev(0, 0, CUSTOMER, "ask", "asks", {
        detail: "Where is my order?",
        station: "door",
      }),
      ev(0, 500, "sup", "llm", "chat", {
        delegate_to: "faq",
        say: "check order 7",
        station: "peer",
      }),
      ev(2000, 500, "faq", "tool", "lookup", {
        station: "computer",
        detail: "shipped",
      }),
      ev(4000, 500, "faq", "skill", "returns-policy", { station: "library" }),
      ev(6000, 500, "faq", "llm", "chat", { detail: "It shipped yesterday." }),
    ],
    OFFICE_PACING,
  );
  const at = (name: string) => events.find((e) => e.name === name)!.pt + 100;
  const faq = (t: number) => poseAt(actors[1], events, t, layout, 1);

  assert.equal(phoneStateAt("sup", events, 100), "talking");
  assert.equal(phoneStateAt("faq", events, 100), "ringing");
  assert.equal(
    narrate(events, 100, (id) => id),
    "customer asks: Where is my order?",
  );
  assert.equal(faq(at("lookup")).at, "tools");
  assert.deepEqual(faq(at("lookup")).bubble, {
    type: "chip",
    icon: "tool",
    text: "lookup",
    sub: "shipped",
    faded: false,
  });
  assert.equal(faq(at("returns-policy")).at, "library");
  const last = events[events.length - 1];
  const speaking = faq(last.pt + 100);
  assert.equal(speaking.at, "desk");
  assert.equal(speaking.working, true);
  assert.equal(speaking.bubble?.type, "speech");
  assert.ok((speaking.bubble?.progress ?? 1) < 1); // the words type out while the beat runs
  // the last word stays up after the beat, fully written
  assert.deepEqual(wordOf(last, events), {
    type: "speech",
    text: "It shipped yesterday.",
  });
  assert.equal(faq(last.pt + last.pdur + 5000).bubble?.faded, true);
});

test("office: idle sub-agents take a break, roots never do", () => {
  const actors = [actor("sup"), actor("a", "sup", 1), actor("b", "sup", 1)];
  const layout = layoutOffice(actors);
  const { events } = toPlayEvents(
    [ev(0, 500, "sup", "llm", "chat")],
    OFFICE_PACING,
  );
  const plan = breakPlan(actors, events, 100, layout);
  assert.deepEqual([...plan.keys()].sort(), ["a", "b"]);
  assert.deepEqual(
    [...plan.values()].map((s) => s.kind).sort(),
    ["pong-a", "pong-b"], // two idle agents rally at the table
  );
  assert.equal(
    poseAt(actors[1], events, 100, layout, 1, plan.get("a")).at,
    "break",
  );
});

test("conversation verdict: FAIL wins, PASS needs a grade, no grade is null", () => {
  const turn = (verdict: string | null) =>
    ({ verdict, failing: 1 }) as FullTurn;
  const conv = (...verdicts: string[]) =>
    ({ scores: verdicts.map((verdict) => ({ verdict })) }) as ConvNode;
  assert.equal(conversationVerdict(conv(), [turn(null), turn(null)]), null); // an error span is not a grade
  assert.equal(conversationVerdict(conv(), [turn("PASS"), turn(null)]), "PASS");
  assert.equal(
    conversationVerdict(conv(), [turn("PASS"), turn("FAIL")]),
    "FAIL",
  );
  assert.equal(conversationVerdict(conv("PASS"), [turn(null)]), "PASS");
  assert.equal(conversationVerdict(conv("FAIL"), [turn("PASS")]), "FAIL"); // a conversation-level grade counts
});
