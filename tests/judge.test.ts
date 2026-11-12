// The judge against a local stand-in for OpenRouter. No request leaves this machine: the base
// URL points at a server started here, and the Decisions URL follows it.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunEvent } from "../lib/judge/service";

const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-judge-test-"));
mkdirSync(path.join(temp, "research"));
process.env.PARALLAX_DATA_DIR = path.join(temp, "private-data");
process.env.PARALLAX_RESEARCH_ROOT = path.join(temp, "research");
delete process.env.OPENROUTER_API_KEY;

type Json = Record<string, unknown>;
type Call = { path: string; auth: string | undefined; body: Json };
const calls: Call[] = [];
/** What the fake provider does for the next calls; a test sets it. */
const fake = {
  chat: (body: Json): { status?: number; json: Json } => ({
    json: chatReply(body),
  }),
  decisions: (body: Json): { status?: number; json: Json } => ({
    json: decisionReply(body),
  }),
};
const completion = (content: string, extra: Json = {}) => ({
  choices: [{ message: { role: "assistant", content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0005 },
  ...extra,
});
function chatReply(body: Json): Json {
  const format = body.response_format as
    { json_schema?: { name: string } } | undefined;
  const user = String((body.messages as { content: string }[]).at(-1)?.content);
  switch (format?.json_schema?.name) {
    case "ScoreVerdict":
      // A low grade for an answer that says "I do not know".
      return completion(
        JSON.stringify({
          score: user.includes("do not know") ? 0.2 : 0.9,
          reason: "judged",
        }),
      );
    case "PassFailVerdict":
      return completion(JSON.stringify({ passed: true, reason: "fine" }));
    case "TextVerdict":
      return completion(
        JSON.stringify({ text: "an observation", reason: "why" }),
      );
    case "NumberVerdict":
      return completion(JSON.stringify({ value: 7, reason: "counted" }));
    case "EvaluationOutput":
      return completion(
        JSON.stringify({ tone: "polite", score: 0.8, reason: "kind words" }),
      );
    case "MulticlassAnswer":
      return completion(JSON.stringify({ label: "refund", confidence: 0.7 }));
    case "GeneratedEvaluatorDraft":
      return completion(
        JSON.stringify({
          name: "Politeness",
          description: "Is the answer polite?",
          level: "AGENT_RUN",
          engine: "decision",
          task: "binary",
          question: "Is the `Agent answer` polite?",
          yes_means: "Polite wording",
          no_means: "Rude wording",
          pass_when: "yes",
          labels: null,
          fail_labels: null,
          output_type: "score",
          prompt: "",
          threshold: null,
          schema_fields: null,
          execution_mode: "batch",
        }),
      );
    default:
      return completion("plain text");
  }
}
function decisionReply(body: Json): Json {
  const questions = body.questions as Record<
    string,
    { type: string; criteria: Json }
  >;
  const state = String(body.state);
  const answers: Json = {};
  for (const [id, q] of Object.entries(questions))
    answers[id] =
      q.type === "choice"
        ? {
            type: "choice",
            choice: state.includes("refund")
              ? "refund"
              : Object.keys(q.criteria)[0],
            confidence: 0.91,
            probabilities: {},
          }
        : { type: "noul", noul: state.includes("do not know") ? 0.9 : 0.1 };
  return {
    answers,
    usage: { input_tokens: 300, output_tokens: 0, cost: 0.00001 },
  };
}
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
const server = createServer(async (req, res) => {
  const body =
    req.method === "POST" ? (JSON.parse(await read(req)) as Json) : {};
  calls.push({ path: req.url ?? "", auth: req.headers.authorization, body });
  const send = (status: number, json: Json) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  if (req.url === "/api/v1/models")
    return send(200, {
      data: [
        {
          id: "openai/gpt-6-luna",
          name: "GPT-6 Luna",
          context_length: 400_000,
        },
        {
          id: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5",
          context_length: 1_000_000,
        },
        { id: "tiny/model", name: "Tiny", context_length: 4200 },
      ],
    });
  if (req.url === "/api/v1/chat/completions") {
    const r = fake.chat(body);
    return send(r.status ?? 200, r.json);
  }
  if (req.url === "/api/alpha/decisions") {
    const r = fake.decisions(body);
    return send(r.status ?? 200, r.json);
  }
  send(404, { error: { message: "not found" } });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

const store = await import("../lib/store");
const traces = await import("../lib/traces");
const judge = await import("../lib/judge/store");
const service = await import("../lib/judge/service");
const provider = await import("../lib/judge/provider");
const template = await import("../lib/judge/template");
const { generateEvaluatorConfig } = await import("../lib/judge/generation");
const { validateRunIf, evaluateRunIf } =
  await import("../lib/judge/conditions");

after(() => {
  store.closeDatabases();
  server.close();
  rmSync(temp, { recursive: true, force: true });
});

const t0 = Date.parse("2026-01-01T00:00:00Z");
/** One turn: a root agent span, one model call, and one tool call. */
const turn = (
  traceId: string,
  n: number,
  question: string,
  answer: string,
) => ({
  traceId,
  sessionId: "chat-1",
  spans: [
    {
      spanId: "root",
      name: "Support agent",
      type: "agent",
      start: t0 + n * 10_000,
      end: t0 + n * 10_000 + 3000,
      input: [{ role: "user", content: question }],
      output: answer,
    },
    {
      spanId: "llm",
      parentSpanId: "root",
      name: "chat",
      type: "generation",
      start: t0 + n * 10_000 + 100,
      end: t0 + n * 10_000 + 900,
      model: "some-model",
      input: [{ role: "user", content: question }],
      output: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            function: { name: "lookup_order", arguments: '{"id": 7}' },
          },
        ],
      },
    },
    {
      spanId: "tool",
      parentSpanId: "root",
      name: "lookup_order",
      type: "tool",
      start: t0 + n * 10_000 + 1000,
      end: t0 + n * 10_000 + 1500,
      input: { id: 7 },
      output: { status: "shipped" },
    },
  ],
});
before(() => {
  traces.ingestTrace(turn("t1", 0, "Where is my order?", "It has shipped."));
  traces.ingestTrace(
    turn("t2", 1, "I want a refund.", "I do not know how to do that."),
  );
});
const chatCalls = () =>
  calls.filter((c) => c.path.endsWith("/chat/completions"));
const lastUser = (c: Call) =>
  String((c.body.messages as { content: string }[]).at(-1)?.content);
const system = (c: Call) =>
  String((c.body.messages as { content: string }[])[0]?.content);
const runAll = (input: Parameters<typeof service.runEvaluators>[0]) => {
  const events: RunEvent[] = [];
  return service
    .runEvaluators(input, (e) => events.push(e))
    .then((summary) => ({ summary, events }));
};

test("with no key, nothing contacts the provider", async () => {
  assert.equal(provider.keyStatus().configured, false);
  const models = await provider.listModels();
  assert.ok(models.length > 10);
  assert.ok(
    models.every((m) => m.kind === "llm"),
    "decision models need a key",
  );
  assert.equal(provider.defaultColumnModelId(), "openai/gpt-6-luna");
  const ev = await judge.createEvaluator({
    name: "No key yet",
    config: { prompt: "Grade it.", model: "openai/gpt-6-luna" },
  });
  const { summary } = await runAll({ trace_ids: ["t1"] });
  assert.equal(summary.scores, 0);
  assert.equal(calls.length, 0);
  judge.deleteEvaluator(ev.id);
});

test("the key is saved in a private file and never returned", async () => {
  assert.throws(() => provider.saveKey("  "), /OpenRouter API key/);
  const status = provider.saveKey("sk-or-test-key-1234");
  assert.deepEqual(status, {
    configured: true,
    source: "saved",
    hint: "…1234",
  });
  const file = path.join(process.env.PARALLAX_DATA_DIR!, "openrouter.key");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const models = await provider.listModels();
  assert.equal(calls.at(-1)?.auth, "Bearer sk-or-test-key-1234");
  // Checked against the live catalog: only the listed ids stay, with the provider's names.
  assert.deepEqual(
    models.map((m) => [m.id, m.kind, m.context_tokens]),
    [
      ["anthropic/claude-sonnet-5", "llm", 1_000_000],
      ["openai/gpt-6-luna", "llm", 400_000],
      ["typesafe/jev-1.13", "decision", 32_000],
    ],
  );
  assert.equal(provider.defaultColumnModelId(), "typesafe/jev-1.13");
});

test("a message-level score column grades one trace and stores the score", async () => {
  const ev = await judge.createEvaluator({
    name: "Helpfulness",
    level: "AGENT_RUN",
    config: {
      prompt: "Grade the answer.",
      model: "openai/gpt-6-luna",
      threshold: 0.6,
    },
  });
  assert.equal(ev.score_name, "custom.helpfulness");
  assert.equal(ev.config.is_advanced, false);
  calls.length = 0;
  const { summary, events } = await runAll({ trace_ids: ["t1"] });
  assert.deepEqual(summary, {
    targets: 1,
    evaluators: 1,
    scores: 1,
    errors: 0,
  });
  const [call] = chatCalls();
  assert.equal(call.body.model, "openai/gpt-6-luna");
  assert.equal(system(call), "Grade the answer.");
  assert.equal(
    lastUser(call),
    "User request:\nWhere is my order?\n\nAgent answer:\nIt has shipped.",
  );
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.deepEqual(
    { ...result.score },
    {
      name: "custom.helpfulness",
      evaluation_level: "AGENT_RUN",
      observation_id: null,
      value: 0.9,
      string_value: "",
      verdict: "PASS",
      comment: "judged",
      data_type: "NUMERIC",
      trace_id: "t1",
      session_id: "chat-1",
      graded: true,
      error: false,
    },
  );
  const stored = judge.withTraceScores(traces.getTrace("t1"));
  assert.equal(stored.scores.length, 1);
  assert.equal(stored.verdict, "PASS");
  // The cell's "LLM prompt & answer" panel reads the stored call.
  const [prompt] = judge.scoreCalls({
    subject: "t1",
    level: "msg",
    name: ev.score_name,
    spanId: "",
  });
  assert.match(
    prompt.input,
    /^\[system\]\nGrade the answer\.\n\n\[user\]\nUser request:/,
  );
  assert.match(prompt.output, /"score":0.9/);
  // Tokens and the cost the provider reported.
  const cost = judge.evaluatorCost(30);
  assert.deepEqual(cost.evaluators[ev.score_name], {
    runs: 1,
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    cost_usd_cents: 0,
    model: "openai/gpt-6-luna",
  });
});

test("a run on a thread grades every turn, then the conversation columns once", async () => {
  const conv = await judge.createEvaluator({
    name: "Goal reached",
    level: "CONVERSATION",
    config: {
      prompt: "Did the user get what they needed?",
      output_type: "boolean",
      model: "openai/gpt-6-luna",
    },
  });
  calls.length = 0;
  const { summary } = await runAll({ thread_ids: ["chat-1"] });
  assert.equal(summary.scores, 3); // 2 turns × Helpfulness + 1 conversation score
  const transcript = lastUser(chatCalls().at(-1)!);
  assert.equal(
    transcript,
    "Full conversation (2 turns):\nTurn 1 — user: Where is my order?\nTurn 1 — agent: It has shipped.\n" +
      "Turn 2 — user: I want a refund.\nTurn 2 — agent: I do not know how to do that.",
  );
  const session = judge.withSessionDetailScores(traces.getSession("chat-1"));
  assert.deepEqual(
    session.scores.map((s) => [s.name, s.verdict, s.trace_id]),
    [[conv.score_name, "PASS", null]],
  );
  assert.deepEqual(
    session.traces.map((t) => [t.traceId, t.verdict]),
    [
      ["t1", "PASS"],
      ["t2", "FAIL"], // the low grade of "I do not know"
    ],
  );
  const page = judge.withSessionScores(traces.listSessions({}));
  assert.equal(page.items[0].scores.length, 1);
});

test("a step-level column grades each matching span; sequential adds the earlier steps", async () => {
  const ev = await judge.createEvaluator({
    name: "Step check",
    level: "SPAN",
    config: {
      prompt: "Was this step right?",
      output_type: "boolean",
      model: "openai/gpt-6-luna",
      span_types: ["TOOL", "GENERATION"],
      execution_mode: "sequential",
    },
  });
  calls.length = 0;
  await runAll({ trace_ids: ["t1"], evaluator_ids: [ev.id] });
  const sent = chatCalls().map(lastUser);
  assert.equal(sent.length, 2);
  assert.match(
    sent[0],
    /^User request:\nWhere is my order\?\n\nStep 1 of 2 — GENERATION `chat`\nStep input:\n/,
  );
  assert.match(sent[0], /\[calls lookup_order\(\{"id": 7\}\)\]/);
  assert.match(
    sent[1],
    /^Steps already taken in this message \(oldest first\):\n1\. GENERATION `chat`: /,
  );
  assert.match(
    sent[1],
    /Step 2 of 2 — TOOL `lookup_order`\nStep input:\n\{"id":7\}\n\nStep output:\n\{"status":"shipped"\}/,
  );
  assert.match(
    sent[1],
    /Previous result of this metric[^\n]*\n\{"value":1,"verdict":"PASS","reason":"fine"\}/,
  );
  const scores = judge
    .scoresForTraces(["t1"])
    .get("t1")!
    .filter((s) => s.name === ev.score_name);
  assert.deepEqual(scores.map((s) => s.observation_id).sort(), ["llm", "tool"]);
  // Narrowing the column retracts the score of the step it no longer grades.
  await judge.updateEvaluator(ev.id, {
    config: { ...ev.config, span_types: ["TOOL"] },
  });
  await runAll({ trace_ids: ["t1"], evaluator_ids: [ev.id] });
  const after = judge
    .scoresForTraces(["t1"])
    .get("t1")!
    .filter((s) => s.name === ev.score_name);
  assert.deepEqual(
    after.map((s) => s.observation_id),
    ["tool"],
  );
  judge.deleteEvaluator(ev.id);
  assert.equal(
    judge
      .scoresForTraces(["t1"])
      .get("t1")!
      .some((s) => s.name === ev.score_name),
    false,
  );
});

test("an advanced prompt is resolved from the trace and sent as the user message", async () => {
  const ev = await judge.createEvaluator({
    name: "Faithfulness",
    level: "AGENT_RUN",
    config: {
      model: "openai/gpt-6-luna",
      prompt:
        "Is the answer supported?\n## Request\n@CURRENT_MESSAGE.input\n## Tools\n@CURRENT_STEPS.tool\n## Docs\n@CURRENT_STEPS.retriever\n## Before\n@PREVIOUS_ASSISTANT_MSG\n## Answer\n@CURRENT_MESSAGE.output",
    },
  });
  assert.equal(ev.config.is_advanced, true);
  assert.deepEqual(ev.config.template_variables, [
    "CURRENT_MESSAGE.input",
    "CURRENT_STEPS.tool",
    "CURRENT_STEPS.retriever",
    "PREVIOUS_ASSISTANT_MSG",
    "CURRENT_MESSAGE.output",
  ]);
  calls.length = 0;
  await runAll({ trace_ids: ["t2"], evaluator_ids: [ev.id] });
  const [call] = chatCalls();
  assert.match(system(call), /^You are an evaluator\./);
  assert.equal(
    lastUser(call),
    "Is the answer supported?\n## Request\nI want a refund.\n## Tools\n" +
      'Step 1 · TOOL `lookup_order`\nArguments: {"id":7}\nResult: {"status":"shipped"}\n' +
      "## Docs\n[No CURRENT_STEPS.retriever available]\n## Before\nIt has shipped.\n## Answer\nI do not know how to do that.",
  );
  judge.deleteEvaluator(ev.id);
  // The preview uses the same resolver, and history stops at the graded turn.
  const spans = judge.readThreadSpans("chat-1");
  const preview = template.resolveTemplate(
    "@HISTORY | @AGENTS.called | @GOAL",
    template.buildContext("AGENT_RUN", {
      threadSpans: spans,
      currentTraceId: "t1",
    }),
  );
  assert.equal(
    preview.resolvedText,
    "[user]: Where is my order?\n[assistant]: It has shipped. | - lookup_order ×1 | Where is my order?",
  );
});

test("a decision model answers through the Decisions API", async () => {
  const intent = await judge.createEvaluator({
    name: "Intent",
    level: "AGENT_RUN",
    config: {
      output_type: "decision_multiclass",
      question: "What does the user want?",
      criteria: { order_status: "Where an order is", refund: "Money back" },
      include_answer: false,
    },
  });
  const unsure = await judge.createEvaluator({
    name: "Gave up",
    level: "AGENT_RUN",
    config: {
      model: "typesafe/jev-1.13",
      output_type: "decision_binary",
      question: "Did the agent give up?",
      criteria: { true: "It says it cannot help", false: "It helps" },
      pass_when: "no",
      threshold: 0.5,
    },
  });
  calls.length = 0;
  await runAll({ trace_ids: ["t2"], evaluator_ids: [intent.id, unsure.id] });
  const sent = calls.filter((c) => c.path === "/api/alpha/decisions");
  assert.equal(sent.length, 2);
  assert.equal(chatCalls().length, 0);
  assert.deepEqual(sent[0].body, {
    model: "typesafe/jev-1.13", // no model named: the column default
    state: "User message:\nI want a refund.",
    questions: {
      q: {
        type: "choice",
        instructions: "What does the user want?",
        criteria: { order_status: "Where an order is", refund: "Money back" },
      },
    },
  });
  const scores = new Map(
    judge
      .scoresForTraces(["t2"])
      .get("t2")!
      .map((s) => [s.name, s]),
  );
  const label = scores.get(intent.score_name)!;
  assert.deepEqual(
    [
      label.data_type,
      label.string_value,
      label.value,
      label.verdict,
      label.comment,
    ],
    ["CATEGORICAL", "refund", 0.91, "", "refund (confidence 0.91)"],
  );
  const gaveUp = scores.get(unsure.score_name)!;
  assert.deepEqual(
    [gaveUp.data_type, gaveUp.value, gaveUp.verdict, gaveUp.comment],
    ["NUMERIC", 0.9, "FAIL", "P(yes)=0.90 · pass when no (threshold 0.5)"],
  );
  // The pairing rules of the editor.
  await assert.rejects(
    judge.createEvaluator({
      name: "x",
      config: { model: "typesafe/jev-1.13", prompt: "rubric" },
    }),
    /is a decision model/,
  );
  await assert.rejects(
    judge.createEvaluator({
      name: "x",
      config: {
        model: "openai/gpt-6-luna",
        output_type: "decision_binary",
        question: "q?",
        criteria: { true: "a", false: "b" },
      },
    }),
    /needs a decision model/,
  );
});

test("run_if runs an LLM column only where the decision column put the label", async () => {
  const explain = await judge.createEvaluator({
    name: "Explain refunds",
    level: "AGENT_RUN",
    config: {
      model: "openai/gpt-6-luna",
      output_type: "text",
      prompt: "Explain how the agent handled the refund.",
      run_if: [
        {
          column: "custom.intent",
          field: "label",
          op: "in",
          values: ["refund"],
        },
      ],
    },
  });
  assert.deepEqual(explain.config.depends_on, ["custom.intent"]);
  calls.length = 0;
  // Running one column pulls in the column it depends on.
  await runAll({ thread_ids: ["chat-1"], evaluator_ids: [explain.id] });
  assert.equal(
    calls.filter((c) => c.path === "/api/alpha/decisions").length,
    2,
  );
  assert.equal(chatCalls().length, 1); // only the refund turn
  assert.match(
    lastUser(chatCalls()[0]),
    /Results from prerequisite evaluations[^\n]*\n- custom\.intent: \{"label":"refund","value":0\.91,"reason":"refund \(confidence 0\.91\)"\}/,
  );
  const of = (traceId: string) =>
    judge
      .scoresForTraces([traceId])
      .get(traceId)!
      .find((s) => s.name === explain.score_name)!;
  assert.deepEqual(
    [of("t2").string_value, of("t2").graded],
    ["an observation", true],
  );
  assert.deepEqual(
    [of("t1").string_value, of("t1").graded],
    ["Not run", false],
  );
  assert.match(
    of("t1").comment,
    /custom\.intent label is order_status \(runs when label is refund\)/,
  );
  assert.equal(
    validateRunIf([{ column: "a", field: "value", op: "in" }]),
    "run_if[0]: a value condition's op must be one of [gte, gt, lte, lt]",
  );
  assert.deepEqual(
    evaluateRunIf(
      [{ column: "a", field: "verdict", op: "in", values: ["FAIL"] }],
      {},
    ),
    [false, "Not run: `a` has no result for this item."],
  );
  await assert.rejects(
    judge.createEvaluator({
      name: "y",
      level: "CONVERSATION",
      config: {
        prompt: "p",
        model: "openai/gpt-6-luna",
        depends_on: ["custom.intent"],
      },
    }),
    /runs in the conversation pass but custom\.intent \(batch\)/,
  );
  await assert.rejects(
    judge.createEvaluator({
      name: "y",
      config: { prompt: "p", model: "openai/gpt-6-luna", depends_on: ["nope"] },
    }),
    /reads nope, which are not columns here/,
  );
});

test("an item too long for the model goes to the fallback model, or is skipped with a reason", async () => {
  const long = "long ".repeat(8000); // 40 kB: over the 4.2k-token context of tiny/model
  traces.ingestTrace({
    traceId: "big",
    spans: [
      {
        spanId: "root",
        name: "Agent",
        type: "agent",
        start: t0,
        end: t0 + 5,
        input: long,
        output: "done",
      },
    ],
  });
  const ev = await judge.createEvaluator({
    name: "Long items",
    config: {
      prompt: "Grade.",
      model: "tiny/model",
      fallback_model: "openai/gpt-6-luna",
    },
  });
  calls.length = 0;
  await runAll({ trace_ids: ["big"], evaluator_ids: [ev.id] });
  assert.deepEqual(
    chatCalls().map((c) => c.body.model),
    ["openai/gpt-6-luna"],
  );
  const score = () =>
    judge
      .scoresForTraces(["big"])
      .get("big")!
      .find((s) => s.name === ev.score_name)!;
  assert.match(
    score().comment,
    /^\[graded by fallback openai\/gpt-6-luna: input exceeded tiny\/model's context\] judged/,
  );
  const { fallback_model: _dropped, ...withoutFallback } = ev.config;
  await judge.updateEvaluator(ev.id, { config: withoutFallback });
  calls.length = 0;
  await runAll({ trace_ids: ["big"], evaluator_ids: [ev.id] });
  assert.equal(chatCalls().length, 0);
  assert.deepEqual(
    [score().string_value, score().verdict, score().graded],
    ["Skipped — input too long", "", false],
  );
  assert.match(
    score().comment,
    /^Input is over 5k tokens, past the 4\.2k context of tiny\/model\./,
  );
  // The provider's own rejection takes the same path.
  await judge.updateEvaluator(ev.id, {
    config: { ...withoutFallback, model: "openai/gpt-6-luna" },
  });
  fake.chat = () => ({
    status: 400,
    json: {
      error: {
        message: "This model's maximum context length is 400000 tokens",
      },
    },
  });
  await runAll({ trace_ids: ["big"], evaluator_ids: [ev.id] });
  assert.match(
    score().comment,
    /^openai\/gpt-6-luna rejected the input as longer than its 400k context\./,
  );
  fake.chat = (body) => ({ json: chatReply(body) });
  judge.deleteEvaluator(ev.id);
});

test("a provider failure is a visible Error score with no verdict; a model without structured output still works", async () => {
  const ev = await judge.createEvaluator({
    name: "Custom JSON",
    config: {
      prompt: "Describe the tone.",
      model: "openai/gpt-6-luna",
      output_type: "json",
      threshold: 0.5,
      output_schema: {
        type: "object",
        properties: {
          tone: { type: "string", enum: ["polite", "rude"] },
          score: { type: "number" },
          reason: { type: "string" },
        },
        required: ["tone", "score"],
      },
    },
  });
  const score = () =>
    judge
      .scoresForTraces(["t1"])
      .get("t1")!
      .find((s) => s.name === ev.score_name)!;
  await runAll({ trace_ids: ["t1"], evaluator_ids: [ev.id] });
  assert.deepEqual(
    [score().string_value, score().value, score().verdict, score().comment],
    [
      '{"tone":"polite","score":0.8,"reason":"kind words"}',
      0.8,
      "PASS",
      "kind words",
    ],
  );
  // OpenRouter reports credit exhaustion as HTTP 200 with an error body and no choices.
  fake.chat = () => ({
    json: { error: { message: "Insufficient credits", code: 402 } },
  });
  await runAll({ trace_ids: ["t1"], evaluator_ids: [ev.id] });
  assert.deepEqual(
    [score().string_value, score().verdict, score().error],
    ["Error", "", true],
  );
  assert.match(
    score().comment,
    /^Not graded: openai\/gpt-6-luna failed — OpenRouter returned an error instead of a completion[^:]*: Insufficient credits/,
  );
  // A provider that refuses `response_format` gets the schema in the prompt instead.
  calls.length = 0;
  fake.chat = (body) =>
    body.response_format
      ? {
          status: 400,
          json: {
            error: {
              message: "response_format is not supported by this model",
            },
          },
        }
      : {
          json: completion(
            'Here you go:\n```json\n{"tone": "rude", "score": "0.1"}\n```',
          ),
        };
  await runAll({ trace_ids: ["t1"], evaluator_ids: [ev.id] });
  assert.equal(chatCalls().length, 2);
  assert.match(
    lastUser(chatCalls()[1]),
    /Respond with ONE JSON object and nothing else\. It must match this JSON Schema:\n\{"type":"object"/,
  );
  assert.deepEqual(
    [score().string_value, score().verdict],
    ['{"tone":"rude","score":0.1,"reason":null}', "FAIL"],
  );
  fake.chat = (body) => ({ json: chatReply(body) });
  judge.deleteEvaluator(ev.id);
});

test("Use AI drafts a decision column and saves nothing", async () => {
  const before = judge.listEvaluators().length;
  calls.length = 0;
  const draft = await generateEvaluatorConfig("Is the assistant polite?");
  assert.match(
    system(chatCalls()[0]),
    /## Engine: DECISION \(the default\) vs LLM/,
  );
  assert.match(
    system(chatCalls()[0]),
    /AGENT_RUN:\n  @HISTORY — Full formatted conversation history/,
  );
  assert.deepEqual(draft, {
    name: "Politeness",
    description: "Is the answer polite?",
    kind: "llm_judge",
    level: "AGENT_RUN",
    config: {
      model: "typesafe/jev-1.13",
      question: "Is the `Agent answer` polite?",
      output_type: "decision_binary",
      threshold: 0.5,
      pass_when: "yes",
      criteria: { true: "Polite wording", false: "Rude wording" },
    },
  });
  assert.equal(judge.listEvaluators().length, before);
});

test("the template library marks installed templates; a disabled column does not run", async () => {
  const library = judge.listTemplates();
  assert.equal(library.length, 18);
  assert.ok(library.every((t) => t.kind === "llm_judge" && !t.installed));
  const quality = library.find((t) => t.score_name === "tracely.run.quality")!;
  const ev = await judge.createEvaluator({
    name: quality.name,
    level: quality.level,
    config: quality.config,
    score_name: quality.score_name,
  });
  assert.equal(
    judge.listTemplates().find((t) => t.score_name === ev.score_name)!
      .installed,
    true,
  );
  await judge.updateEvaluator(ev.id, { enabled: false });
  assert.equal(judge.enabledSpecs([ev.id]).length, 0);
  // The workspace export carries columns and scores, and never the key.
  const exported = JSON.stringify(store.exportWorkspace());
  assert.match(exported, /"score_name":"tracely\.run\.quality"/);
  assert.match(exported, /custom\.helpfulness/);
  assert.equal(exported.includes("sk-or-test-key-1234"), false);
});

test("a turn with no graded score has no verdict", () => {
  const score = (verdict: string, graded: boolean, name = "a") => ({
    name,
    evaluation_level: "AGENT_RUN",
    observation_id: null,
    value: null,
    string_value: graded ? "" : "Not run",
    verdict,
    comment: "",
    data_type: "TEXT",
    trace_id: "t",
    session_id: "t",
    graded,
    error: false,
  });
  const none = new Set<string>();
  assert.equal(judge.rollupVerdict([], none), null);
  // "Not run", "Skipped" and "Error" scores are not grades.
  assert.equal(judge.rollupVerdict([score("", false)], none), null);
  assert.equal(
    judge.rollupVerdict([score("", false), score("PASS", true)], none),
    "PASS",
  );
  assert.equal(judge.rollupVerdict([score("", true)], none), "PASS"); // graded, no verdict (a label)
  assert.equal(
    judge.rollupVerdict([score("FAIL", true), score("PASS", true)], none),
    "FAIL",
  );
  // A FAIL on an advisory column is shown but does not fail the turn.
  assert.equal(
    judge.rollupVerdict([score("FAIL", true, "adv")], new Set(["adv"])),
    "PASS",
  );
});

test("removing the key turns the judge off again", async () => {
  assert.equal(provider.clearKey().configured, false);
  calls.length = 0;
  const { summary } = await runAll({ trace_ids: ["t1"] });
  assert.equal(summary.scores, 0);
  assert.equal(calls.length, 0);
});
