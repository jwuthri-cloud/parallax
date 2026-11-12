// Conversation replay: turn a thread's spans into a time-ordered SCRIPT the UI can act out.
// A port of Tracely's backend/tracely/domain/traces/replay.py. Pure — no React, no fetch.
//
// The script says WHO acted, WHEN, UNDER WHOM and, for the Fleet office, WHERE: every event
// carries a `station` (desk / computer / library / peer) and a delegation carries the callee.
//
// Parallax changes: Tracely reads the agent of a span from its registry (`agent_id`) and the
// requested tools from an ingest column. Parallax has neither, so
//   - the agent is the span's declared agent attribute (AGENT_KEYS), else the NAME of the nearest
//     AGENT span (the same name in two turns is the same agent);
//   - the requested tools are read from the span output;
//   - the tools on offer (Tracely's declared agent catalog) are the `tools` a model call lists.
import type { SpanOut } from "../lib/api";
import type { ReplayActor, ReplayEvent } from "./timeline";

export type OfferedTool = { name: string; description: string };
export type OfferedAgent = { name: string; tools: OfferedTool[] };
export type ReplayScript = {
  actors: ReplayActor[];
  events: ReplayEvent[];
  /** Per agent, the tools its model calls were offered. */
  declared: OfferedAgent[];
  durationMs: number;
};

// observation type -> replay event kind. Anything else rides as "step".
const KIND: Record<string, string> = {
  AGENT: "turn",
  CHAIN: "turn",
  SUBAGENT: "spawn",
  GENERATION: "llm",
  EMBEDDING: "llm",
  THINKING: "think",
  TOOL: "tool",
  RETRIEVER: "tool",
  GUARDRAIL: "guard",
  DELEGATE: "delegate", // a container: the handover brackets the work the callee then does
  SKILL: "skill",
};
const ACTOR_TYPES = new Set(["AGENT", "SUBAGENT"]);
/** The person the whole office works for. Synthetic actor id — no agent name can collide with it. */
export const CUSTOMER = "__customer__";

// event kind -> where the actor performs it. The span TYPE is authoritative: SKILL and RETRIEVER
// are knowledge access (the library), TOOL is an action (the computer).
const STATION: Record<string, string> = {
  turn: "desk",
  spawn: "desk",
  llm: "desk",
  think: "desk",
  guard: "desk",
  step: "desk",
  tool: "computer",
  skill: "library",
  delegate: "peer",
  ask: "door",
};

/** Span attributes that name the agent a span belongs to, first match wins. */
const AGENT_KEYS = [
  "tracely.agent.id",
  "langfuse.agent.id",
  "parallax.agent.id",
  "gen_ai.agent.name",
  "gen_ai.agent.id",
  "agent",
];
const CALLEE_KEYS = ["tracely.handoff.callee_agent_id", "parallax.handoff.callee"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const firstOf = (meta: Record<string, string>, keys: string[]) => {
  for (const k of keys) if (meta[k]) return meta[k];
  return "";
};

/** Milliseconds from `a` to `b`, clamped at 0 (clock skew across services is real). */
const ms = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round(b - a)) : 0);

function preview(value: unknown, limit = 120): string {
  if (value === null || value === undefined) return "";
  const text = (typeof value === "string" ? value : JSON.stringify(value)).split(/\s+/).filter(Boolean).join(" ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function parseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

const blockText = (content: unknown[]) =>
  content
    .map((b) => (isObj(b) && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();

/** Function names of a message's tool calls. Covers both conventions: OpenAI's
 *  `tool_calls[].function.name` and Anthropic's `tool_use` content blocks. */
function calledNames(message: Json): string[] {
  const names: string[] = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isObj(call)) continue;
    const name = (isObj(call.function) ? call.function.name : null) || call.name;
    if (typeof name === "string" && name) names.push(name);
  }
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isObj(block) || (block.type !== "tool_use" && block.type !== "tool_call")) continue;
    if (typeof block.name === "string" && block.name && !names.includes(block.name)) names.push(block.name);
  }
  return names;
}

/** The tools a model REQUESTED, read from the span's stored output. */
function outputCalls(value: string | null): string[] {
  if (!value || !/^[[{]/.test(value.trimStart())) return [];
  const parsed = parseJson(value);
  if (!parsed.ok) return [];
  const names: string[] = [];
  for (const m of Array.isArray(parsed.value) ? parsed.value : [parsed.value])
    if (isObj(m)) for (const n of calledNames(m)) if (!names.includes(n)) names.push(n);
  return names;
}

/** Human text from a span output. Outputs are often a JSON message list
 *  (`[{"role": "assistant", "content": ...}]`) — a speech bubble must show the words, never the
 *  envelope. Falls back to the raw preview. */
function textOf(value: string | null, limit = 120): string {
  if (typeof value === "string" && /^[[{"]/.test(value.trimStart())) {
    const parsed = parseJson(value);
    if (!parsed.ok) return preview(value, limit);
    if (typeof parsed.value === "string") return preview(parsed.value, limit);
    const msgs = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    const envelope = msgs.some((m) => isObj(m) && ("role" in m || "tool_calls" in m));
    for (const m of [...msgs].reverse()) {
      if (!isObj(m)) continue;
      if (typeof m.content === "string" && m.content.trim()) return preview(m.content, limit);
      if (Array.isArray(m.content)) {
        const text = blockText(m.content);
        if (text) return preview(text, limit);
      }
      // A turn that ONLY calls tools has empty content — say what it reached for.
      const calls = calledNames(m);
      if (calls.length) return preview(`→ ${calls.join(", ")}`, limit);
    }
    // A message envelope with nothing sayable: better silence than raw JSON in a speech bubble.
    // Non-message payloads (a tool's `{"total": 1299}`) still preview.
    if (envelope) return "";
  }
  return preview(value, limit);
}

/** The CUSTOMER's words in a span input: the last `user` message of a message list, a plain
 *  string, or a `{"messages"|"input"|"question"|"query": …}` wrapper. Anything else (a
 *  framework's config payload, a tool's arguments) is "" — never a JSON envelope. */
export function userTextOf(value: unknown, limit = 160): string {
  if (typeof value === "string" && /^[[{"]/.test(value.trimStart())) {
    const parsed = parseJson(value);
    if (!parsed.ok) return preview(value, limit);
    value = parsed.value;
  }
  if (typeof value === "string") return preview(value, limit);
  if (isObj(value)) {
    if ("role" in value) value = [value];
    else {
      for (const key of ["messages", "input", "question", "query"])
        if (value[key]) return userTextOf(value[key], limit);
      return "";
    }
  }
  if (Array.isArray(value)) {
    for (const m of [...value].reverse()) {
      if (!isObj(m) || !["user", "human"].includes(String(m.role ?? "").toLowerCase())) continue;
      const content = Array.isArray(m.content) ? blockText(m.content) : m.content;
      if (typeof content === "string" && content.trim()) return preview(content, limit);
    }
  }
  return "";
}

/** The handoff text for a speech bubble. A DELEGATE span carries it as its input (a plain
 *  string); a tool-call-style handoff buries it in the function arguments of the assistant
 *  message. A GENERATION span's input is the prompt as a JSON message list — a bubble must NEVER
 *  show that envelope, so the direct-input shortcut only applies to plain strings. */
function delegationSay(span: SpanOut, calleeAlias: string): string {
  const direct = span.input;
  if (direct && direct.trim() && !/^[[{]/.test(direct.trimStart())) return textOf(direct);
  const raw = span.output;
  if (!raw || !/^[[{]/.test(raw.trimStart())) return "";
  const parsed = parseJson(raw);
  if (!parsed.ok) return "";
  for (const m of Array.isArray(parsed.value) ? parsed.value : [parsed.value]) {
    for (const call of isObj(m) && Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      const fn = isObj(call) ? call.function : null;
      if (!isObj(fn) || String(fn.name ?? "").toLowerCase() !== calleeAlias.toLowerCase()) continue;
      const args = typeof fn.arguments === "string" ? parseJson(fn.arguments || "{}") : { ok: true as const, value: fn.arguments ?? {} };
      if (!args.ok) return preview(fn.arguments);
      if (isObj(args.value))
        return preview(
          Object.values(args.value)
            .filter(Boolean)
            .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
            .join(" "),
        );
      return preview(args.value);
    }
  }
  return "";
}

/** The tools a model call was offered: `tools` in the request it stored as input, or the OTel
 *  `gen_ai.tool.definitions` attribute. Both the OpenAI (`{function: {name}}`) and the flat
 *  (`{name}`) shape are read. */
function offeredTools(span: SpanOut): OfferedTool[] {
  const sources: unknown[] = [];
  if (span.input && span.input.trimStart().startsWith("{")) {
    const parsed = parseJson(span.input);
    if (parsed.ok && isObj(parsed.value)) sources.push(parsed.value.tools);
  }
  const defs = span.metadata["gen_ai.tool.definitions"];
  if (defs) {
    const parsed = parseJson(defs);
    if (parsed.ok) sources.push(parsed.value);
  }
  const out: OfferedTool[] = [];
  for (const list of sources)
    for (const item of Array.isArray(list) ? list : []) {
      const tool = isObj(item) && isObj(item.function) ? item.function : item;
      if (!isObj(tool) || typeof tool.name !== "string" || !tool.name) continue;
      out.push({ name: tool.name, description: typeof tool.description === "string" ? tool.description : "" });
    }
  return out;
}

/**
 * The conversation as a playable script.
 *
 * `actors` are ordered by first appearance (stable seating), led by the synthetic `customer`
 * whose `ask` events carry each turn's user message. Each carries `parent` (the actor that
 * spawned it, empty for top-level) and `depth`. `events` are ordered by start time with `t_ms`
 * relative to the conversation's first span, so the UI plays one clock.
 */
export function buildReplay(spans: SpanOut[]): ReplayScript {
  const at = new Map<SpanOut, number>();
  for (const s of spans) at.set(s, Date.parse(s.start_time));
  const start = (s: SpanOut) => at.get(s) as number;
  const rows = spans
    .filter((s) => Number.isFinite(start(s)))
    .sort((a, b) => start(a) - start(b) || (a.span_id < b.span_id ? -1 : a.span_id > b.span_id ? 1 : 0));
  if (!rows.length) return { durationMs: 0, actors: [], events: [], declared: [] };
  const t0 = start(rows[0]);
  const end = (s: SpanOut) => (s.end_time ? Date.parse(s.end_time) : start(s));
  const traceOf = (s: SpanOut) => s.agent_run_id; // Parallax: one trace is one turn
  const typeOf = (s: SpanOut) => s.type.toUpperCase();

  // Span ids are unique per TRACE, not per thread — a conversation's turns routinely reuse them
  // (any SDK numbering spans from 1 does), so every lookup is keyed by (trace, span).
  const ref = (s: SpanOut, sid: string) => `${traceOf(s)}\u0000${sid}`;
  const byId = new Map<string, SpanOut>();
  for (const s of rows) if (s.span_id) byId.set(ref(s, s.span_id), s);
  const parentOfSpan = (s: SpanOut) => byId.get(ref(s, s.parent_span_id));
  const calls = new Map<SpanOut, string[]>();
  for (const s of rows) calls.set(s, outputCalls(s.output));
  const called = (s: SpanOut) => calls.get(s) as string[];

  // ── resolve each span's owning actor by walking up to the nearest AGENT/SUBAGENT ──
  const actorOf = new Map<SpanOut, string>();
  const parentOf = new Map<string, string>(); // actor key -> parent actor key
  const declaredAgent = (s: SpanOut) => firstOf(s.metadata, AGENT_KEYS);
  const actorKey = (s: SpanOut) => declaredAgent(s) || s.name || `${traceOf(s)}:${s.span_id}`;

  for (const span of rows) {
    // nearest ancestor that is itself an actor span
    let owner = "";
    let cursor = parentOfSpan(span);
    for (let hops = 0; cursor && hops < 64; hops++) {
      // hops: cycle guard on malformed parent chains
      if (ACTOR_TYPES.has(typeOf(cursor))) {
        owner = actorKey(cursor);
        break;
      }
      cursor = parentOfSpan(cursor);
    }
    if (ACTOR_TYPES.has(typeOf(span))) {
      const key = actorKey(span);
      actorOf.set(span, key);
      // An actor nested under another actor is that actor's sub-agent. First parent wins: a
      // sub-agent reused across turns keeps its original owner.
      if (owner && owner !== key && !parentOf.has(key)) parentOf.set(key, owner);
    } else {
      // The span's OWN agent is authoritative — real teams tag every span with the agent that
      // ran it. The ancestor walk only fills the gap for spans that carry no agent.
      actorOf.set(span, declaredAgent(span) || owner || "agent");
    }
  }
  const actor = (s: SpanOut) => actorOf.get(s) as string;

  // ── actors, ordered by first appearance ──
  const seen = new Map<string, ReplayActor>();
  for (const span of rows) {
    const key = actor(span);
    const existing = seen.get(key);
    if (existing) existing.last_ms = Math.max(existing.last_ms, ms(t0, end(span)));
    else
      seen.set(key, {
        id: key, name: key, kind: "agent", parent: "", depth: 0,
        first_ms: ms(t0, start(span)), last_ms: ms(t0, end(span)), events: 0, errors: 0,
      });
  }
  // Every actor answers to its key, case-insensitively: hierarchy edges and delegation targets.
  const byName = new Map<string, string>();
  for (const key of seen.keys()) if (!byName.has(key.toLowerCase())) byName.set(key.toLowerCase(), key);
  const resolveActor = (alias: string) => byName.get(alias.toLowerCase()) ?? "";
  // explicit callee first; else the span NAME — harnesses name the delegate span after the
  // specialist it calls ("balance", "store_locations")
  const calleeRef = (s: SpanOut) => firstOf(s.metadata, CALLEE_KEYS) || s.name;
  const calleeOf = (s: SpanOut) => resolveActor(firstOf(s.metadata, CALLEE_KEYS)) || resolveActor(s.name);

  // ── hierarchy edges beyond nesting ──
  // 1) A DELEGATE span is an EXPLICIT edge: its actor is the caller. Recorded first so it wins
  //    over the tool-name heuristic below.
  for (const span of rows) {
    if (typeOf(span) !== "DELEGATE") continue;
    const caller = actor(span);
    const callee = calleeOf(span);
    if (callee && callee !== caller && !parentOf.has(callee)) parentOf.set(callee, caller);
  }
  // 2) Multi-agent harnesses call a sub-agent as a TOOL. A tool call NAMED after another actor
  //    is an explicit, non-heuristic edge: the caller owns the callee.
  for (const span of rows) {
    const caller = actor(span);
    for (const tool of called(span)) {
      const callee = resolveActor(tool);
      if (callee && callee !== caller && !parentOf.get(callee)) parentOf.set(callee, caller);
    }
  }
  for (const [key, a] of seen) {
    let parent = parentOf.get(key) ?? "";
    // never let an edge point back into the callee's own subtree (would spin the depth walk)
    for (let cursor = parent, hops = 0; cursor && hops < 16; hops++) {
      if (cursor === key) {
        parent = "";
        break;
      }
      cursor = parentOf.get(cursor) ?? "";
    }
    a.parent = seen.has(parent) ? parent : "";
  }
  for (const a of seen.values()) {
    let depth = 0;
    for (let cursor = a.parent, hops = 0; cursor && hops < 16; hops++) {
      depth += 1;
      cursor = seen.get(cursor)?.parent ?? "";
    }
    a.depth = depth;
    a.kind = depth ? "subagent" : "agent";
  }

  // Explicit DELEGATE callees per trace: an llm span requesting the same specialist in the same
  // trace is the SAME handoff — inferring a second walk for it doubles the scene.
  const explicitDelegations = new Set<string>();
  for (const span of rows) {
    if (typeOf(span) !== "DELEGATE") continue;
    const target = resolveActor(calleeRef(span));
    if (target) explicitDelegations.add(`${traceOf(span)}\u0000${target}`);
  }

  // ── events ──
  const events: ReplayEvent[] = [];
  const offered = new Map<string, OfferedTool[]>(); // actor key -> tools its model calls listed
  for (const span of rows) {
    const stype = typeOf(span);
    const kind = KIND[stype] ?? "step";
    const key = actor(span);
    const error = span.level.toUpperCase() === "ERROR";
    const owner = seen.get(key) as ReplayActor;
    owner.events += 1;
    if (error) owner.errors += 1;

    let station = stype === "RETRIEVER" ? "library" : (STATION[kind] ?? "desk");

    // Delegation target: explicit on a DELEGATE span; inferred on a WORK event (never a
    // turn/spawn container — one inferred edge would walk the agent for the whole turn) whose
    // REQUESTED tool is another actor. A TOOL span's own name deliberately does not count: agent
    // names and tool names share a namespace ("search", "billing"), and a colliding plain tool
    // must stay a tool.
    let delegateTo = "";
    let say = "";
    if (stype === "DELEGATE") {
      delegateTo = resolveActor(calleeRef(span));
      say = delegationSay(span, calleeRef(span));
    } else if (kind !== "turn" && kind !== "spawn") {
      for (const alias of called(span)) {
        const target = resolveActor(alias);
        if (target && target !== key && !explicitDelegations.has(`${traceOf(span)}\u0000${target}`)) {
          delegateTo = target;
          station = "peer";
          say = delegationSay(span, alias);
          break;
        }
      }
    }

    // A model turn that ANSWERED with a tool call instead of words has no sayable output. Say
    // what it reached for instead. `calls` travels as its own field so the UI can render a
    // "called X" chip instead of parsing this line back out of `detail`.
    let detail = preview(span.status_message) || textOf(span.output);
    if (!detail && called(span).length) detail = preview(`→ ${called(span).join(", ")}`);

    if (kind === "llm") {
      const list = offered.get(key) ?? [];
      for (const tool of offeredTools(span)) if (!list.some((t) => t.name === tool.name)) list.push(tool);
      if (list.length) offered.set(key, list);
    }

    events.push({
      t_ms: ms(t0, start(span)),
      dur_ms: ms(start(span), end(span)),
      actor: key,
      kind,
      // the RAW span type, so the "filter step types" preference (which stores types, not replay
      // kinds) can hide the same spans here it hides in the table
      type: stype,
      name: span.name || kind,
      status: error ? "error" : "ok",
      // Containers bracket other spans rather than doing work — the UI shows them as the turn's
      // envelope, and never as the agent "working".
      container: kind === "turn" || kind === "spawn" || kind === "delegate",
      station,
      delegate_to: delegateTo,
      say,
      model: span.model_id,
      detail,
      calls: called(span),
      span_id: span.span_id,
      trace_id: traceOf(span),
      turn_id: span.turn_id,
      tokens: span.tokens,
      cost: span.cost,
    });
  }

  // ── the customer: one `ask` per turn (trace), spoken at the turn's first span ──
  // The question is the root span's input (a plain string, or a message list whose LAST user
  // message is this turn's ask). A root that carries a config payload instead falls back to the
  // earliest GENERATION's prompt.
  const turns = new Map<string, SpanOut[]>();
  for (const span of rows) turns.set(traceOf(span), [...(turns.get(traceOf(span)) ?? []), span]);
  const asks: ReplayEvent[] = [];
  for (const [traceId, tspans] of turns) {
    const roots = tspans.filter((s) => !parentOfSpan(s));
    const gens = tspans.filter((s) => typeOf(s) === "GENERATION");
    let ask = "";
    for (const s of [...roots, ...gens, ...tspans]) {
      ask = userTextOf(s.input);
      if (ask) break;
    }
    asks.push({
      t_ms: ms(t0, start(tspans[0])),
      dur_ms: 0,
      actor: CUSTOMER,
      kind: "ask",
      name: "asks",
      status: "ok",
      container: false,
      station: "door",
      type: "", // synthetic — no span type, so the type filter can never hide the ask
      delegate_to: "",
      say: "",
      model: "",
      detail: ask,
      calls: [],
      span_id: tspans[0].span_id,
      trace_id: traceId,
      turn_id: tspans[0].turn_id,
    });
  }
  const all = [...asks, ...events].sort((a, b) => a.t_ms - b.t_ms); // stable: an ask leads its turn
  const customer: ReplayActor = {
    id: CUSTOMER, name: "customer", kind: "customer", parent: "", depth: 0,
    first_ms: asks[0].t_ms, last_ms: asks[asks.length - 1].t_ms, events: asks.length, errors: 0,
  };

  return {
    durationMs: all.reduce((m, e) => Math.max(m, e.t_ms + e.dur_ms), 0),
    actors: [customer, ...seen.values()],
    events: all,
    declared: [...offered].map(([name, tools]) => ({ name, tools })),
  };
}
