import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-trace-test-"));
mkdirSync(path.join(temp, "research"));
process.env.PARALLAX_DATA_DIR = path.join(temp, "private-data");
process.env.PARALLAX_RESEARCH_ROOT = path.join(temp, "research");
const store = await import("../lib/store");
const traces = await import("../lib/traces");
const { mapOtlpRequest } = await import("../lib/otlp");
after(() => {
  store.closeDatabases();
  rmSync(temp, { recursive: true, force: true });
});

const t0 = Date.parse("2026-01-01T00:00:00Z");
const fixtureTrace = (
  traceId: string,
  extra: Record<string, unknown> = {},
) => ({
  traceId,
  spans: [
    {
      spanId: "root",
      name: "Fixture agent",
      type: "agent",
      start: t0,
      end: t0 + 3000,
      input: "fixture question",
    },
    {
      spanId: "llm",
      parentSpanId: "root",
      name: "chat",
      type: "generation",
      start: t0 + 100,
      end: t0 + 1100,
      model: "fixture-model",
      usage: { input: 10, output: 5 },
      output: [{ role: "assistant", content: "fixture answer" }],
    },
  ],
  ...extra,
});

test("native traces store, re-send idempotently and list with filters", () => {
  const r = traces.ingestTrace(fixtureTrace("trace-a"));
  assert.deepEqual(r, { traces: ["trace-a"], spans: 2 });
  traces.ingestTrace(fixtureTrace("trace-a"));
  const a = traces.getTrace("trace-a");
  assert.equal(a.spans, 2);
  assert.equal(a.name, "Fixture agent");
  assert.equal(a.inputTokens, 10);
  assert.equal(a.costUsd, null, "unknown cost stays blank");
  assert.equal(a.durationMs, 3000);
  assert.equal(a.input, "fixture question");
  assert.match(a.output!, /fixture answer/);
  assert.equal(a.spanList[1].type, "GENERATION");
  assert.equal(a.spanList[1].latencyMs, 1000);

  traces.ingestTrace({
    traceId: "trace-b",
    spans: [
      {
        spanId: "x",
        name: "Broken tool",
        type: "tool",
        start: t0 + 10_000,
        end: t0 + 10_500,
        status: "error",
        statusMessage: "boom",
        costUsd: 0.5,
      },
    ],
  });
  assert.equal(traces.listTraces().total, 2);
  assert.deepEqual(
    traces.listTraces({ status: "failing" }).items.map((t) => t.traceId),
    ["trace-b"],
  );
  assert.deepEqual(
    traces.listTraces({ q: "fixture answer" }).items.map((t) => t.traceId),
    ["trace-a"],
  );
  assert.deepEqual(
    traces.listTraces({ q: "100%" }).items,
    [],
    "LIKE wildcards are escaped",
  );
  assert.deepEqual(
    traces.listTraces({ model: "fixture-model" }).items.map((t) => t.traceId),
    ["trace-a"],
  );
  assert.deepEqual(
    traces.listTraces({ sort: "cost" }).items.map((t) => t.traceId),
    ["trace-b", "trace-a"],
  );
  assert.deepEqual(
    traces
      .listTraces({ sort: "recent", order: "asc", limit: 1, offset: 1 })
      .items.map((t) => t.traceId),
    ["trace-b"],
  );
  assert.deepEqual(
    traces.listTraces({ from: t0 + 5000 }).items.map((t) => t.traceId),
    ["trace-b"],
  );
  assert.throws(() => traces.getTrace("missing"), /Trace not found/);
  assert.throws(
    () =>
      traces.ingestTrace({
        spans: [{ spanId: "z", name: "n", start: t0, end: t0 - 1 }],
      }),
    /ends before it starts/,
  );
});

test("sessions group traces; experiments link and are checked", () => {
  const experiment = store.createRecord({
    kind: "experiment",
    title: "Fixture: traced",
  });
  const note = store.createRecord({
    kind: "note",
    title: "Fixture: not an experiment",
  });
  traces.ingestTrace(
    fixtureTrace("turn-1", {
      sessionId: "conv-1",
      experimentId: experiment.id,
    }),
  );
  traces.ingestTrace({
    ...fixtureTrace("turn-2", { sessionId: "conv-1" }),
    spans: fixtureTrace("turn-2").spans.map((s) => ({
      ...s,
      start: s.start + 60_000,
      end: s.end + 60_000,
    })),
  });
  const sessions = traces.listSessions({ multi: true });
  assert.equal(sessions.total, 1);
  assert.equal(sessions.items[0].sessionId, "conv-1");
  assert.equal(sessions.items[0].turns, 2);
  assert.equal(sessions.items[0].inputTokens, 20);
  const session = traces.getSession("conv-1");
  assert.deepEqual(
    session.traces.map((t) => t.traceId),
    ["turn-1", "turn-2"],
  );
  assert.equal(session.spanList.length, 4);
  assert.equal(
    traces.listSessions().total,
    3,
    "a trace without a session is its own session",
  );
  assert.deepEqual(traces.traceStats(experiment.id), { traces: 1, failing: 0 });
  assert.throws(
    () => traces.ingestTrace(fixtureTrace("t", { experimentId: note.id })),
    /not an experiment/,
  );
  assert.throws(
    () => traces.ingestTrace(fixtureTrace("t", { experimentId: "nope" })),
    /not found/i,
  );
});

test("large payloads are cut with a marker", () => {
  traces.ingestTrace({
    traceId: "big",
    spans: [
      {
        spanId: "s",
        name: "big",
        start: t0,
        input: "x".repeat(traces.maxPayloadBytes + 10),
      },
    ],
  });
  const span = traces.getTrace("big").spanList[0];
  assert.match(span.input!, /cut by Parallax: 262154 bytes/);
});

test("JSONL import accepts traces, bare spans and reports bad lines", () => {
  const file = path.join(temp, "research", "traces.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify(fixtureTrace("jsonl-1")),
      JSON.stringify({
        traceId: "jsonl-2",
        spanId: "a",
        name: "first",
        start: t0,
      }),
      JSON.stringify({
        traceId: "jsonl-2",
        spanId: "b",
        parentSpanId: "a",
        name: "second",
        start: t0 + 1,
      }),
      "{not json",
      JSON.stringify({ hello: "world" }),
    ].join("\n"),
  );
  const result = traces.importTraceText(
    store.readLocalFile(file).buffer.toString("utf8"),
  );
  assert.equal(result.traces, 2);
  assert.equal(result.spans, 4);
  assert.deepEqual(
    result.rejected.map((r) => r.line),
    [4, 5],
  );
  assert.equal(traces.getTrace("jsonl-2").spans, 2);
});

// ── OTLP mapping, one fixture per convention ────────────────────────────────────
const kv = (key: string, value: unknown) => ({
  key,
  value:
    typeof value === "number"
      ? Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { stringValue: String(value) },
});
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const otlp = (spans: object[], resource: object[] = []) => ({
  resourceSpans: [
    {
      resource: { attributes: resource },
      scopeSpans: [{ scope: { name: "fixture", version: "1" }, spans }],
    },
  ],
});
const traceHex = "5b8efff798038103d269b633813fc60c";
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

test("OTLP: GenAI semconv, hex and base64 ids, usage, messages, error status", () => {
  const [span] = mapOtlpRequest(
    otlp(
      [
        {
          traceId: b64(traceHex),
          spanId: b64("eee19b7ec3c1b174"),
          parentSpanId: "eee19b7ec3c1b173",
          name: "chat fixture-model",
          startTimeUnixNano: ns(t0),
          endTimeUnixNano: ns(t0 + 250),
          status: { code: 2, message: "rate limited" },
          attributes: [
            kv("gen_ai.operation.name", "chat"),
            kv("gen_ai.request.model", "fixture-model"),
            kv("gen_ai.usage.input_tokens", 12),
            kv("gen_ai.usage.output_tokens", 3),
            kv("gen_ai.conversation.id", "conv-otlp"),
            kv(
              "gen_ai.input.messages",
              JSON.stringify([
                { role: "user", parts: [{ type: "text", content: "hi" }] },
              ]),
            ),
          ],
        },
      ],
      [kv("service.name", "fixture-service")],
    ),
  );
  assert.equal(span.traceId, traceHex);
  assert.equal(span.spanId, "eee19b7ec3c1b174");
  assert.equal(span.parentSpanId, "eee19b7ec3c1b173");
  assert.equal(span.type, "GENERATION");
  assert.equal(span.level, "ERROR");
  assert.equal(span.statusMessage, "rate limited");
  assert.equal(span.model, "fixture-model");
  assert.deepEqual([span.inputTokens, span.outputTokens], [12, 3]);
  assert.equal(span.sessionId, "conv-otlp");
  assert.equal(span.endMs! - span.startMs, 250);
  assert.deepEqual(JSON.parse(span.input!), [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.equal(span.metadata["service.name"], "fixture-service");
  assert.equal(
    span.metadata["gen_ai.input.messages"],
    undefined,
    "messages are not duplicated into metadata",
  );
});

test("OTLP: OpenInference flattened messages and tool calls, retrieval documents", () => {
  const [llm, retriever, tool] = mapOtlpRequest(
    otlp([
      {
        traceId: traceHex,
        spanId: "0000000000000001",
        name: "ChatOpenAI",
        startTimeUnixNano: ns(t0),
        endTimeUnixNano: ns(t0 + 5),
        attributes: [
          kv("openinference.span.kind", "LLM"),
          kv(
            "llm.invocation_parameters",
            JSON.stringify({ model: "fixture-oi" }),
          ),
          kv("llm.token_count.prompt", 7),
          kv("llm.input_messages.0.message.role", "system"),
          kv("llm.input_messages.0.message.content", "be brief"),
          kv("llm.input_messages.1.message.role", "user"),
          kv("llm.input_messages.1.message.content", "weather?"),
          kv("llm.output_messages.0.message.role", "assistant"),
          kv(
            "llm.output_messages.0.message.tool_calls.0.tool_call.function.name",
            "get_weather",
          ),
          kv(
            "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments",
            '{"city":"Paris"}',
          ),
        ],
      },
      {
        traceId: traceHex,
        spanId: "0000000000000002",
        name: "retrieve",
        startTimeUnixNano: ns(t0),
        endTimeUnixNano: ns(t0 + 1),
        attributes: [
          kv("openinference.span.kind", "RETRIEVER"),
          kv("retrieval.documents.0.document.id", "doc-1"),
          kv("retrieval.documents.0.document.content", "fixture text"),
        ],
      },
      {
        traceId: traceHex,
        spanId: "0000000000000003",
        name: "FunctionTool.acall",
        startTimeUnixNano: ns(t0),
        endTimeUnixNano: ns(t0 + 1),
        events: [
          {
            name: "exception",
            attributes: [
              kv("exception.type", "ValueError"),
              kv("exception.message", "bad city"),
            ],
          },
        ],
        attributes: [
          kv("openinference.span.kind", "TOOL"),
          kv("tool.name", "get_weather"),
          kv("input.value", '{"city":"Paris"}'),
        ],
      },
    ]),
  );
  assert.equal(llm.model, "fixture-oi");
  assert.equal(llm.inputTokens, 7);
  const input = JSON.parse(llm.input!);
  assert.deepEqual(
    input.map((m: { role: string }) => m.role),
    ["system", "user"],
  );
  const output = JSON.parse(llm.output!);
  assert.equal(output[0].tool_calls[0].function.name, "get_weather");
  assert.equal(retriever.type, "RETRIEVER");
  assert.deepEqual(JSON.parse(retriever.output!), [
    { id: "doc-1", content: "fixture text" },
  ]);
  assert.equal(tool.name, "get_weather", "tool spans show the tool name");
  assert.equal(tool.level, "ERROR");
  assert.equal(tool.statusMessage, "ValueError: bad city");
  assert.deepEqual(JSON.parse(tool.input!), { city: "Paris" });
});

test("OTLP: OpenLLMetry legacy, Vercel AI SDK, GenAI events, explicit OK and first token", () => {
  const [legacy, vercel, events] = mapOtlpRequest(
    otlp([
      {
        traceId: traceHex,
        spanId: "0000000000000004",
        name: "openai.chat",
        startTimeUnixNano: ns(t0),
        endTimeUnixNano: ns(t0 + 9),
        status: { code: "STATUS_CODE_OK" },
        attributes: [
          kv("gen_ai.request.model", "fixture-legacy"),
          kv("gen_ai.prompt.0.role", "user"),
          kv("gen_ai.prompt.0.content", "legacy question"),
          kv("gen_ai.completion.0.role", "assistant"),
          kv("gen_ai.completion.0.content", "legacy answer"),
          kv("error.type", "ignored because status is OK"),
        ],
      },
      {
        traceId: traceHex,
        spanId: "0000000000000005",
        name: "ai.generateText",
        startTimeUnixNano: ns(t0),
        endTimeUnixNano: ns(t0 + 9),
        attributes: [
          kv("ai.operationId", "ai.generateText"),
          kv("ai.model.id", "fixture-vercel"),
          kv("ai.usage.promptTokens", 4),
          kv("ai.response.text", "vercel answer"),
        ],
      },
      {
        traceId: traceHex,
        spanId: "0000000000000006",
        name: "chat",
        startTimeUnixNano: ns(t0),
        endTimeUnixNano: ns(t0 + 900),
        events: [
          {
            name: "gen_ai.user.message",
            attributes: [kv("content", "event question")],
          },
          { name: "First Token Stream Event", timeUnixNano: ns(t0 + 120) },
          {
            name: "gen_ai.choice",
            attributes: [
              kv(
                "message",
                JSON.stringify({ role: "assistant", content: "event answer" }),
              ),
            ],
          },
        ],
        attributes: [kv("gen_ai.operation.name", "chat")],
      },
    ]),
  );
  assert.equal(legacy.level, "DEFAULT");
  assert.deepEqual(JSON.parse(legacy.input!), [
    { role: "user", content: "legacy question" },
  ]);
  assert.deepEqual(JSON.parse(legacy.output!), [
    { role: "assistant", content: "legacy answer" },
  ]);
  assert.equal(vercel.type, "GENERATION");
  assert.equal(vercel.model, "fixture-vercel");
  assert.equal(vercel.inputTokens, 4);
  assert.equal(vercel.output, "vercel answer");
  assert.deepEqual(JSON.parse(events.input!), [
    { role: "user", content: "event question" },
  ]);
  assert.equal(JSON.parse(events.output!)[0].content, "event answer");
  assert.equal(events.ttftMs, 120);
});

test("OTLP: ingest stores spans; bad payloads are rejected", () => {
  const experiment = store.createRecord({
    kind: "experiment",
    title: "Fixture: otlp",
  });
  traces.ingestOtlp(
    otlp(
      [
        {
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          spanId: "bbbbbbbbbbbbbbbb",
          name: "root",
          startTimeUnixNano: ns(t0),
          endTimeUnixNano: ns(t0 + 2),
        },
      ],
      [kv("parallax.experiment_id", experiment.id)],
    ),
  );
  assert.equal(
    traces.getTrace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").experimentId,
    experiment.id,
  );
  assert.deepEqual(mapOtlpRequest({}), []);
  assert.throws(
    () => mapOtlpRequest(otlp([{ name: "no ids", startTimeUnixNano: ns(t0) }])),
    /traceId and a spanId/,
  );
  assert.throws(() => mapOtlpRequest({ resourceSpans: 3 }), /must be a list/);
});

test("demo traces load into the temporary demo workspace only", async () => {
  const { runInWorkspace, workspaceDataDir } =
    await import("../lib/workspaces");
  const demoDir = runInWorkspace("demo", workspaceDataDir);
  try {
    const before = traces.listTraces({ limit: 1 }).total;
    const first = traces.loadDemoTraces();
    assert.equal(first.traces, 23);
    assert.ok(demoDir.startsWith(os.tmpdir()));
    assert.ok(!demoDir.startsWith(process.env.PARALLAX_DATA_DIR!));
    // Idempotent: a second click does not duplicate traces or experiments.
    assert.equal(traces.loadDemoTraces().traces, 23);
    runInWorkspace("demo", () => {
      const experiments = store
        .listRecords()
        .filter((r) => r.kind === "experiment");
      assert.deepEqual(experiments.map((r) => r.title).sort(), [
        "DEMO: judge pressure sweep",
        "DEMO: retrieval ablation",
      ]);
      assert.equal(traces.traceStats(experiments[0].id).traces > 0, true);
    });
    assert.equal(traces.listTraces({ limit: 1 }).total, before);
    assert.ok(
      !(await import("../lib/workspaces"))
        .listWorkspaces()
        .some((w) => w.id === "demo"),
    );
  } finally {
    store.closeDatabases();
    rmSync(demoDir, { recursive: true, force: true });
  }
});
