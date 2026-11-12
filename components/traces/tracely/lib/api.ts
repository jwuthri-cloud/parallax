// Tracely's API types, served from Parallax's trace endpoints. The vendored Tracely components
// read these shapes unchanged; this file is the only place that knows both sides.
import type {
  Page,
  SessionSummary,
  TraceSpan,
  TraceSummary,
} from "@/lib/schema";

export type EvalScore = {
  name: string;
  evaluation_level: string;
  observation_id: string | null;
  value: number | null;
  string_value?: string;
  verdict: string;
  comment: string;
  data_type: string;
  trace_id?: string | null;
  session_id?: string | null;
  /** False for "Not run" / "Skipped": the cell says why, but it is not a grade. */
  graded?: boolean;
  /** True when the judge call failed. */
  error?: boolean;
};

export type SpanOut = {
  span_id: string;
  parent_span_id: string;
  name: string;
  type: string;
  level: string;
  status_message: string;
  start_time: string;
  end_time: string | null;
  latency_ms: number | null;
  ttft_ms?: number | null;
  agent_id: string;
  agent_run_id: string;
  turn_id: string;
  step_name: string;
  model_id: string;
  tokens: number;
  cost: number;
  metadata: Record<string, string>;
  input: string | null;
  output: string | null;
};

export type Thread = {
  thread: string;
  turns: number;
  first_input: string | null;
  last_output: string | null;
  tokens: number;
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
  cost: number;
  first_ts: string;
  last_ts: string;
  last_trace_id: string;
  failing: number;
  agent?: string;
  agent_id?: string;
  metadata?: Record<string, string>;
  scores?: EvalScore[];
  internal_kind?: string;
  subject_id?: string;
  /** Parallax: the experiment these traces belong to, when one was given. */
  experiment_id?: string | null;
};

export type ThreadTurn = {
  trace_id: string;
  input: string | null;
  output: string | null;
  tokens: number;
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
  cost: number;
  latency_ms: number;
  ts: string;
  failing: number;
  scores: EvalScore[];
  verdict: string | null;
  /** Parallax: the root span's name and the experiment link. */
  name?: string;
  experiment_id?: string | null;
};

export type FullTurn = ThreadTurn & { spans: SpanOut[] };
export type ConvNode = Thread & { turnsData?: FullTurn[] };

export type SessionSort = "recent" | "started" | "duration" | "tokens";
export type SortOrder = "asc" | "desc";
export type SessionsQuery = {
  limit?: number;
  offset?: number;
  from?: string | null;
  to?: string | null;
  sort?: SessionSort;
  order?: SortOrder;
  agent?: string;
  failing?: boolean;
  multi?: boolean;
  q?: string;
  /** Parallax filters. */
  model?: string;
  experimentId?: string;
};

// ── Parallax → Tracely shapes ──────────────────────────────────────────────────
export function toSpanOut(s: TraceSpan): SpanOut {
  const tokens = (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
  const metadata: Record<string, string> = { ...s.metadata };
  // Tracely's usage pill reads token splits from the span metadata.
  if (s.inputTokens != null) metadata["gen_ai.usage.input_tokens"] = String(s.inputTokens);
  if (s.outputTokens != null) metadata["gen_ai.usage.output_tokens"] = String(s.outputTokens);
  return {
    span_id: s.spanId,
    parent_span_id: s.parentSpanId ?? "",
    name: s.name,
    type: s.type,
    level: s.level,
    status_message: s.statusMessage,
    start_time: s.startTime,
    end_time: s.endTime,
    latency_ms: s.latencyMs,
    ttft_ms: s.ttftMs,
    agent_id: "",
    agent_run_id: s.traceId,
    turn_id: s.traceId,
    step_name: "",
    model_id: s.model,
    tokens,
    cost: s.costUsd ?? 0,
    metadata,
    input: s.input,
    output: s.output,
  };
}

/** Parallax: the trace and session reads carry the judge scores (lib/judge/store.ts). */
type Scored = { scores?: EvalScore[]; verdict?: string | null };

export function toTurn(t: TraceSummary & Scored): ThreadTurn {
  return {
    trace_id: t.traceId,
    input: t.input,
    output: t.output,
    tokens: t.inputTokens + t.outputTokens,
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    model: t.models[0],
    cost: t.costUsd ?? 0,
    latency_ms: t.durationMs,
    ts: t.startTime,
    failing: t.failing ? 1 : 0,
    scores: t.scores ?? [],
    verdict: t.verdict ?? null,
    name: t.name,
    experiment_id: t.experimentId,
  };
}

function toThread(s: SessionSummary & Scored): ConvNode {
  return {
    thread: s.sessionId,
    turns: s.turns,
    first_input: s.input,
    last_output: s.output,
    tokens: s.inputTokens + s.outputTokens,
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    model: s.models[0],
    cost: s.costUsd ?? 0,
    first_ts: s.startTime,
    last_ts: s.endTime,
    last_trace_id: s.sessionId,
    failing: s.failing ? 1 : 0,
    agent: s.agent,
    experiment_id: s.experimentId,
    scores: s.scores ?? [],
  };
}

// ── client ─────────────────────────────────────────────────────────────────────
// The workspace is set by TracesView before any of these run (Parallax scopes every call).
let workspaceId = "default";
export function setWorkspace(id: string) {
  workspaceId = id;
}

/** `path` with the workspace (every Parallax API call is scoped to one) and `params`. */
export function wsUrl(path: string, params: Record<string, unknown> = {}): string {
  const qs = new URLSearchParams({ workspaceId });
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "" && v !== false) qs.set(k, String(v));
  return `${path}?${qs}`;
}

async function get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(wsUrl(path, params), { cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed (${r.status})`);
  return body as T;
}

function listParams(q: SessionsQuery) {
  return {
    limit: q.limit,
    offset: q.offset,
    from: q.from ? Date.parse(q.from) : undefined,
    to: q.to ? Date.parse(q.to) : undefined,
    sort: q.sort,
    order: q.order,
    status: q.failing ? "failing" : undefined,
    multi: q.multi,
    q: q.q,
    model: q.model,
    experimentId: q.experimentId,
  };
}

export async function getSessionsPage(q: SessionsQuery): Promise<{ items: ConvNode[]; total: number }> {
  const page = await get<Page<SessionSummary & Scored>>("/api/trace-sessions", listParams(q));
  return { items: page.items.map(toThread), total: page.total };
}

export async function getSessions(q: SessionsQuery): Promise<ConvNode[]> {
  return (await getSessionsPage(q)).items;
}

export async function getSessionsCount(q: SessionsQuery): Promise<number> {
  return (await getSessionsPage({ ...q, limit: 1, offset: 0 })).total;
}

type SessionDetail = SessionSummary &
  Scored & { traces: (TraceSummary & Scored)[]; spanList: TraceSpan[] };

/** One conversation with every turn's spans, as Tracely's detail pages expect it. */
export async function getConversation(threadId: string): Promise<{
  conv: ConvNode;
  turns: FullTurn[];
}> {
  const d = await get<SessionDetail>(`/api/trace-sessions/${encodeURIComponent(threadId)}`);
  const turns: FullTurn[] = d.traces.map((t) => ({
    ...toTurn(t),
    spans: d.spanList.filter((s) => s.traceId === t.traceId).map(toSpanOut),
  }));
  return { conv: { ...toThread(d), turnsData: turns }, turns };
}

/** One trace as a one-turn conversation (Tracely's trace page shape). */
export async function getTraceConversation(traceId: string): Promise<{
  conv: ConvNode;
  turn: FullTurn;
  sessionId: string | null;
}> {
  const d = await get<TraceSummary & Scored & { spanList: TraceSpan[] }>(
    `/api/traces/${encodeURIComponent(traceId)}`,
  );
  const turn: FullTurn = { ...toTurn(d), spans: d.spanList.map(toSpanOut) };
  const conv: ConvNode = {
    thread: d.traceId,
    turns: 1,
    first_input: d.input,
    last_output: d.output,
    tokens: turn.tokens,
    input_tokens: d.inputTokens,
    output_tokens: d.outputTokens,
    model: d.models[0],
    cost: turn.cost,
    first_ts: d.startTime,
    last_ts: d.endTime,
    last_trace_id: d.traceId,
    failing: turn.failing,
    agent: d.name,
    experiment_id: d.experimentId,
    turnsData: [turn],
  };
  return { conv, turn, sessionId: d.sessionId };
}

export async function getSessionTurns(threadId: string): Promise<FullTurn[]> {
  return (await getConversation(threadId)).turns;
}

export async function getFacets(): Promise<{ models: string[]; experiments: string[] }> {
  return get("/api/trace-facets");
}

/** A row in Tracely's searchable picker (its agent registry; Parallax uses it for models and experiments). */
export type AgentRow = { id: string; slug: string; display_name: string };
