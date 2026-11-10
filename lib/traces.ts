// LLM traces: one SQLite row per span, read back as traces (spans sharing a trace id) and
// sessions (traces sharing a session id; a trace without one is its own session).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  db,
  transaction,
  getRecord,
  createRecord,
  log,
  StoreError,
} from "./store";
import { demoWorkspaceId, runInWorkspace } from "./workspaces";
import { mapOtlpRequest, type MappedSpan } from "./otlp";
import {
  traceInputSchema,
  traceQuerySchema,
  type Page,
  type SessionSummary,
  type TraceQuery,
  type TraceSpan,
  type TraceSummary,
} from "./schema";

/** Larger payloads are cut, with a marker, so one span cannot bloat the database. */
export const maxPayloadBytes = 256 * 1024;

function clip(value: string | null): string | null {
  if (value === null || Buffer.byteLength(value) <= maxPayloadBytes)
    return value;
  const kept = Buffer.from(value).subarray(0, maxPayloadBytes).toString();
  return `${kept}\n…[cut by Parallax: ${Buffer.byteLength(value)} bytes in total]`;
}
const payload = (v: unknown) =>
  v === undefined || v === null
    ? null
    : typeof v === "string"
      ? v
      : JSON.stringify(v);
const toMs = (v: string | number) =>
  typeof v === "number" ? Math.round(v) : Date.parse(v);

/** Parallax's own JSON format (MCP, HTTP, JSONL) → mapped spans. */
export function mapTraceInput(input: unknown): MappedSpan[] {
  const trace = traceInputSchema.parse(input);
  const traceId = trace.traceId ?? randomBytes(16).toString("hex");
  return trace.spans.map((s) => ({
    traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId ?? null,
    sessionId: trace.sessionId || null,
    experimentId: trace.experimentId || null,
    name: s.name,
    type: s.type,
    level: s.status === "error" ? "ERROR" : "DEFAULT",
    statusMessage: s.statusMessage,
    startMs: toMs(s.start),
    endMs: s.end === undefined || s.end === null ? null : toMs(s.end),
    ttftMs: null,
    model: s.model,
    inputTokens: s.usage.input ?? null,
    outputTokens: s.usage.output ?? null,
    costUsd: s.costUsd ?? null,
    input: payload(s.input),
    output: payload(s.output),
    metadata: Object.fromEntries(
      Object.entries(s.metadata).map(([k, v]) => [k, String(v)]),
    ),
    source: "parallax",
  }));
}

/** Store spans. A span sent again replaces the stored one, so exporters can retry. */
export function writeSpans(spans: MappedSpan[], actor: string) {
  if (!spans.length) return { traces: [] as string[], spans: 0 };
  for (const s of spans)
    if (s.endMs !== null && s.endMs < s.startMs)
      throw new StoreError(`Span ${s.spanId} ends before it starts`);
  return transaction(() => {
    for (const id of new Set(spans.map((s) => s.experimentId).filter(Boolean)))
      if (getRecord(id as string).kind !== "experiment")
        throw new StoreError(`${id} is not an experiment`);
    const insert = db().prepare(
      `INSERT OR REPLACE INTO trace_spans (trace_id, span_id, parent_span_id, session_id, experiment_id, name, type, level, status_message, start_ms, end_ms, ttft_ms, model, input_tokens, output_tokens, cost_usd, input, output, metadata, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const s of spans)
      insert.run(
        s.traceId,
        s.spanId,
        s.parentSpanId,
        s.sessionId,
        s.experimentId,
        s.name,
        s.type,
        s.level,
        s.statusMessage,
        s.startMs,
        s.endMs,
        s.ttftMs,
        s.model,
        s.inputTokens,
        s.outputTokens,
        s.costUsd,
        clip(s.input),
        clip(s.output),
        JSON.stringify(s.metadata),
        s.source,
        now,
      );
    const traces = [...new Set(spans.map((s) => s.traceId))];
    for (const id of traces) logTraceActivity(id, actor);
    return { traces, spans: spans.length };
  });
}

export const ingestTrace = (input: unknown, actor = "Claude Code") =>
  writeSpans(mapTraceInput(input), actor);
export const ingestOtlp = (body: unknown, actor = "OTLP exporter") =>
  writeSpans(mapOtlpRequest(body), actor);

/** One activity line per trace per 10 minutes, however many batches it arrives in. */
function logTraceActivity(traceId: string, actor: string) {
  const root = db()
    .prepare(
      "SELECT name, experiment_id FROM trace_spans WHERE trace_id = ? ORDER BY (parent_span_id IS NOT NULL), start_ms LIMIT 1",
    )
    .get(traceId) as { name: string; experiment_id: string | null };
  const title = `${root.name} · trace ${traceId.slice(0, 8)}`;
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  db()
    .prepare(
      "DELETE FROM activity WHERE action = 'recorded trace' AND title = ? AND created_at >= ?",
    )
    .run(title, since);
  log("recorded trace", root.experiment_id, title, actor);
}

/** Import a .jsonl of Parallax traces or spans, or an OTLP/JSON export, line by line. */
export function importTraceText(text: string, actor = "Claude Code") {
  const trimmed = text.trim();
  if (!trimmed) throw new StoreError("The file is empty");
  const whole = (() => {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  })();
  const lines = whole === undefined ? trimmed.split("\n") : [trimmed];
  const rejected: { line: number; error: string }[] = [];
  const orphans = new Map<string, unknown[]>();
  let spans = 0;
  const traces = new Set<string>();
  const accept = (r: { traces: string[]; spans: number }) => {
    spans += r.spans;
    r.traces.forEach((t) => traces.add(t));
  };
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const value = whole ?? JSON.parse(line);
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item && typeof item === "object" && "resourceSpans" in item)
          accept(ingestOtlp(item, actor));
        else if (item && typeof item === "object" && "spans" in item)
          accept(ingestTrace(item, actor));
        else if (item && typeof item === "object" && "traceId" in item) {
          // A bare span line: group with the other spans of its trace.
          const { traceId, sessionId, experimentId, ...span } = item as Record<
            string,
            unknown
          >;
          const key = JSON.stringify([
            traceId,
            sessionId ?? null,
            experimentId ?? null,
          ]);
          orphans.set(key, [...(orphans.get(key) ?? []), span]);
        } else
          throw new StoreError(
            "Expected a trace, a span with traceId, or an OTLP request",
          );
      }
    } catch (error) {
      rejected.push({ line: i + 1, error: errorText(error) });
    }
  });
  for (const [key, group] of orphans) {
    const [traceId, sessionId, experimentId] = JSON.parse(key);
    try {
      accept(
        ingestTrace(
          {
            traceId,
            sessionId: sessionId ?? undefined,
            experimentId: experimentId ?? undefined,
            spans: group,
          },
          actor,
        ),
      );
    } catch (error) {
      rejected.push({
        line: 0,
        error: `trace ${traceId}: ${errorText(error)}`,
      });
    }
  }
  return { traces: traces.size, spans, rejected };
}
function errorText(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  return (error as Error).message;
}

// ── reads ─────────────────────────────────────────────────────────────────────
type SpanRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  session_id: string | null;
  experiment_id: string | null;
  name: string;
  type: string;
  level: "DEFAULT" | "ERROR";
  status_message: string;
  start_ms: number;
  end_ms: number | null;
  ttft_ms: number | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  input: string | null;
  output: string | null;
  metadata: string;
  source: string;
};
const toSpan = (r: SpanRow): TraceSpan => ({
  traceId: r.trace_id,
  spanId: r.span_id,
  parentSpanId: r.parent_span_id,
  sessionId: r.session_id,
  experimentId: r.experiment_id,
  name: r.name,
  type: r.type,
  level: r.level,
  statusMessage: r.status_message,
  startTime: new Date(r.start_ms).toISOString(),
  endTime: r.end_ms === null ? null : new Date(r.end_ms).toISOString(),
  latencyMs: r.end_ms === null ? null : r.end_ms - r.start_ms,
  ttftMs: r.ttft_ms,
  model: r.model,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  costUsd: r.cost_usd,
  input: r.input,
  output: r.output,
  metadata: JSON.parse(r.metadata),
  source: r.source,
});

// Per-trace aggregates. Filters choose traces by id, so the totals always cover every span.
const traceAggregate = `SELECT trace_id, COALESCE(MAX(session_id), trace_id) AS sid,
  MIN(start_ms) AS s, MAX(COALESCE(end_ms, start_ms)) AS e, COUNT(*) AS n,
  COALESCE(SUM(input_tokens), 0) AS it, COALESCE(SUM(output_tokens), 0) AS ot, SUM(cost_usd) AS c,
  MAX(level = 'ERROR') AS f, MAX(experiment_id) AS x,
  GROUP_CONCAT(DISTINCT NULLIF(model, '')) AS m
  FROM trace_spans`;
// "recent" is the latest activity, "started" the first span (Tracely's two time sorts).
const sortColumns = {
  recent: "e",
  started: "s",
  duration: "e - s",
  tokens: "it + ot",
  cost: "COALESCE(c, 0)",
};

function filters(query: z.output<typeof traceQuerySchema>) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const match = (sql: string, ...values: (string | number)[]) => {
    where.push(`trace_id IN (SELECT trace_id FROM trace_spans WHERE ${sql})`);
    params.push(...values);
  };
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    match(
      "trace_id = ? OR session_id = ? OR " +
        ["name", "model", "input", "output", "metadata", "status_message"]
          .map((c) => `${c} LIKE ? ESCAPE '\\'`)
          .join(" OR "),
      query.q,
      query.q,
      like,
      like,
      like,
      like,
      like,
      like,
    );
  }
  if (query.model) match("model = ?", query.model);
  if (query.experimentId) match("experiment_id = ?", query.experimentId);
  if (query.sessionId)
    match("COALESCE(session_id, trace_id) = ?", query.sessionId);
  const having: string[] = [];
  if (query.status === "failing") having.push("f = 1");
  if (query.from !== undefined)
    (having.push("s >= ?"), params.push(query.from));
  if (query.to !== undefined) (having.push("s <= ?"), params.push(query.to));
  return {
    sql: `${traceAggregate} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY trace_id ${having.length ? `HAVING ${having.join(" AND ")}` : ""}`,
    params,
  };
}

type Aggregate = {
  trace_id: string;
  sid: string;
  s: number;
  e: number;
  n: number;
  it: number;
  ot: number;
  c: number | null;
  f: number;
  x: string | null;
  m: string | null;
};
const preview = 4000;

/** The opening input and the final answer of each trace, for list titles and previews. */
function endpoints(traceIds: string[]) {
  const out = new Map<
    string,
    { name: string; input: string | null; output: string | null }
  >();
  if (!traceIds.length) return out;
  const marks = traceIds.map(() => "?").join(",");
  const roots = db()
    .prepare(
      `SELECT trace_id, name, substr(input, 1, ${preview}) AS input, substr(output, 1, ${preview}) AS output FROM trace_spans t
       WHERE trace_id IN (${marks}) AND (parent_span_id IS NULL OR parent_span_id NOT IN (SELECT span_id FROM trace_spans p WHERE p.trace_id = t.trace_id))
       ORDER BY start_ms`,
    )
    .all(...traceIds) as {
    trace_id: string;
    name: string;
    input: string | null;
    output: string | null;
  }[];
  for (const r of roots) if (!out.has(r.trace_id)) out.set(r.trace_id, r);
  // Prefer the last model reply as the answer; a root's output is often framework state.
  const replies = db()
    .prepare(
      `SELECT trace_id, substr(output, 1, ${preview}) AS output FROM trace_spans
       WHERE trace_id IN (${marks}) AND type = 'GENERATION' AND output IS NOT NULL ORDER BY start_ms DESC`,
    )
    .all(...traceIds) as { trace_id: string; output: string }[];
  const seen = new Set<string>();
  for (const r of replies) {
    if (seen.has(r.trace_id)) continue;
    seen.add(r.trace_id);
    const entry = out.get(r.trace_id);
    if (entry) entry.output = r.output;
  }
  const firstInputs = db()
    .prepare(
      `SELECT trace_id, substr(input, 1, ${preview}) AS input FROM trace_spans
       WHERE trace_id IN (${marks}) AND input IS NOT NULL ORDER BY start_ms`,
    )
    .all(...traceIds) as { trace_id: string; input: string }[];
  for (const r of firstInputs) {
    const entry = out.get(r.trace_id);
    if (entry && entry.input === null) entry.input = r.input;
  }
  return out;
}

const models = (m: string | null) => [
  ...new Set((m ?? "").split(",").filter(Boolean)),
];
function toSummary(
  a: Aggregate,
  ends: ReturnType<typeof endpoints>,
): TraceSummary {
  const end = ends.get(a.trace_id);
  return {
    traceId: a.trace_id,
    name: end?.name ?? a.trace_id,
    sessionId: a.sid === a.trace_id ? null : a.sid,
    experimentId: a.x,
    startTime: new Date(a.s).toISOString(),
    endTime: new Date(a.e).toISOString(),
    durationMs: a.e - a.s,
    spans: a.n,
    inputTokens: a.it,
    outputTokens: a.ot,
    costUsd: a.c,
    failing: a.f === 1,
    models: models(a.m),
    input: end?.input ?? null,
    output: end?.output ?? null,
  };
}

export function listTraces(input: TraceQuery = {}): Page<TraceSummary> {
  const query = traceQuerySchema.parse(input);
  const { sql, params } = filters(query);
  const order = `${sortColumns[query.sort]} ${query.order === "asc" ? "ASC" : "DESC"}, trace_id`;
  const rows = db()
    .prepare(`SELECT * FROM (${sql}) ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset) as Aggregate[];
  const { total } = db()
    .prepare(`SELECT COUNT(*) AS total FROM (${sql})`)
    .get(...params) as { total: number };
  const ends = endpoints(rows.map((r) => r.trace_id));
  return { items: rows.map((r) => toSummary(r, ends)), total };
}

export function listSessions(input: TraceQuery = {}): Page<SessionSummary> {
  const query = traceQuerySchema.parse(input);
  const { sql, params } = filters(query);
  const grouped = `SELECT sid, COUNT(*) AS turns, MIN(s) AS s, MAX(e) AS e, SUM(n) AS n, SUM(it) AS it,
    SUM(ot) AS ot, SUM(c) AS c, MAX(f) AS f, MAX(x) AS x, GROUP_CONCAT(m) AS m
    FROM (${sql}) GROUP BY sid ${query.multi ? "HAVING COUNT(*) > 1" : ""}`;
  const order = `${sortColumns[query.sort]} ${query.order === "asc" ? "ASC" : "DESC"}, sid`;
  const rows = db()
    .prepare(`SELECT * FROM (${grouped}) ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset) as (Omit<
    Aggregate,
    "trace_id"
  > & {
    turns: number;
  })[];
  const { total } = db()
    .prepare(`SELECT COUNT(*) AS total FROM (${grouped})`)
    .get(...params) as { total: number };
  // The first turn gives the session its title; the last turn gives its latest answer.
  const turns = new Map<string, string[]>();
  if (rows.length) {
    const members = db()
      .prepare(
        `SELECT sid, trace_id FROM (${sql}) WHERE sid IN (${rows.map(() => "?").join(",")}) ORDER BY s`,
      )
      .all(...params, ...rows.map((r) => r.sid)) as {
      sid: string;
      trace_id: string;
    }[];
    for (const m of members)
      turns.set(m.sid, [...(turns.get(m.sid) ?? []), m.trace_id]);
  }
  const ends = endpoints(
    [...turns.values()].flatMap((ids) => [ids[0], ids[ids.length - 1]]),
  );
  return {
    total,
    items: rows.map((r) => {
      const ids = turns.get(r.sid) ?? [];
      return {
        sessionId: r.sid,
        agent: ends.get(ids[0])?.name ?? "",
        turns: r.turns,
        startTime: new Date(r.s).toISOString(),
        endTime: new Date(r.e).toISOString(),
        durationMs: r.e - r.s,
        spans: r.n,
        inputTokens: r.it,
        outputTokens: r.ot,
        costUsd: r.c,
        failing: r.f === 1,
        models: models(r.m),
        experimentId: r.x,
        input: ends.get(ids[0])?.input ?? null,
        output: ends.get(ids[ids.length - 1])?.output ?? null,
      };
    }),
  };
}

const maxSpansPerRead = 5000;
function spansWhere(sql: string, ...params: string[]): TraceSpan[] {
  const rows = db()
    .prepare(
      `SELECT * FROM trace_spans WHERE ${sql} ORDER BY start_ms, span_id LIMIT ${maxSpansPerRead + 1}`,
    )
    .all(...params) as SpanRow[];
  if (rows.length > maxSpansPerRead)
    throw new StoreError(
      `More than ${maxSpansPerRead} spans; narrow the query`,
      413,
    );
  return rows.map(toSpan);
}

export function getTrace(traceId: string) {
  const spans = spansWhere("trace_id = ?", traceId);
  if (!spans.length) throw new StoreError("Trace not found", 404);
  const aggregate = db()
    .prepare(`${traceAggregate} WHERE trace_id = ? GROUP BY trace_id`)
    .get(traceId) as Aggregate;
  return { ...toSummary(aggregate, endpoints([traceId])), spanList: spans };
}

export function getSession(sessionId: string) {
  const traces = listTraces({ sessionId, order: "asc", limit: 200 });
  if (!traces.total) throw new StoreError("Session not found", 404);
  const session = listSessions({ sessionId, limit: 1 }).items[0];
  const spans = spansWhere(
    "trace_id IN (SELECT trace_id FROM trace_spans WHERE COALESCE(session_id, trace_id) = ?)",
    sessionId,
  );
  return { ...session, traces: traces.items, spanList: spans };
}

export function traceStats(experimentId: string) {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS traces, COALESCE(SUM(f), 0) AS failing FROM (SELECT MAX(level = 'ERROR') AS f FROM trace_spans WHERE experiment_id = ? GROUP BY trace_id)`,
    )
    .get(experimentId) as { traces: number; failing: number };
  return { traces: row.traces, failing: row.failing };
}

/** Distinct models and experiments that have traces, for the filter menus. */
export function traceFacets() {
  return {
    models: (
      db()
        .prepare(
          "SELECT DISTINCT model FROM trace_spans WHERE model != '' ORDER BY model",
        )
        .all() as { model: string }[]
    ).map((r) => r.model),
    experiments: (
      db()
        .prepare(
          "SELECT DISTINCT experiment_id FROM trace_spans WHERE experiment_id IS NOT NULL",
        )
        .all() as { experiment_id: string }[]
    ).map((r) => r.experiment_id),
  };
}

const demoFile = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  "fixtures/demo-traces.jsonl",
);
/** Loads the bundled synthetic traces into the temporary demo workspace, once per server run.
 *  A `"demo-exp:<name>"` reference in the file becomes the demo experiment "DEMO: <name>". */
export function loadDemoTraces() {
  return runInWorkspace(demoWorkspaceId, () => {
    const existing = listTraces({ limit: 1 }).total;
    if (existing) return { traces: existing };
    let text = readFileSync(demoFile, "utf8");
    const refs = new Set(
      [...text.matchAll(/"demo-exp:([\w-]+)"/g)].map((m) => m[1]),
    );
    for (const ref of refs) {
      const experiment = createRecord(
        {
          kind: "experiment",
          title: `DEMO: ${ref.replace(/-/g, " ")}`,
          status: "completed",
        },
        "Demo",
      );
      text = text.replaceAll(
        `"demo-exp:${ref}"`,
        JSON.stringify(experiment.id),
      );
    }
    return { traces: importTraceText(text, "Demo").traces };
  });
}
