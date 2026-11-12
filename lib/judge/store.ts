// Evaluators (judge columns) and their scores in the workspace SQLite.
// An evaluator row is a column of the traces table: `score_name` is the stable key its scores
// are stored under, `level` picks the row (conversation / message / step) and `config` holds the
// prompt, model and output type. Validation is the port of Tracely `api/routers/evaluators.py`.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, log, StoreError, transaction } from "../store";
import { getSession, getTrace } from "../traces";
import { spanTypes, type TraceSpan } from "../schema";
import { TEMPLATES } from "./catalog";
import { conditionColumns, validateRunIf } from "./conditions";
import {
  DECISION_OUTPUT_TYPES,
  isDecisionOutput,
  validateDecision,
} from "./decision";
import { OUTPUT_TYPES } from "./llm-judge";
import { isDecisionModel } from "./provider";
import { fromJsonSchema } from "./structured";
import { extractTemplateVariables } from "./template";
import type { JudgeSpan } from "./text";
import {
  CONVERSATION,
  LEVELS,
  type EvalResult,
  type EvalScore,
  type Evaluator,
  type EvaluatorConfig,
  type JudgeCall,
  type Level,
} from "./types";

const configSchema = z.record(z.string(), z.unknown());
export const evaluatorCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).default(""),
  kind: z.string().default("llm_judge"),
  level: z.enum(LEVELS).default("AGENT_RUN"),
  enabled: z.boolean().default(true),
  config: configSchema.default({}),
  score_name: z.string().trim().max(80).default(""),
});
export const evaluatorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(400).optional(),
  level: z.enum(LEVELS).optional(),
  enabled: z.boolean().optional(),
  config: configSchema.optional(),
});

type Row = {
  id: string;
  name: string;
  description: string;
  kind: string;
  score_name: string;
  level: string;
  enabled: number;
  config: string;
  created_at: string;
};
const toEvaluator = (r: Row): Evaluator => ({
  id: r.id,
  name: r.name,
  description: r.description,
  kind: "llm_judge",
  score_name: r.score_name,
  level: r.level as Level,
  enabled: r.enabled === 1,
  config: JSON.parse(r.config),
  created_at: r.created_at,
});

/** Every evaluator of the workspace, in creation order. */
export function listEvaluators(): Evaluator[] {
  return (
    db().prepare("SELECT * FROM evaluators ORDER BY rowid").all() as Row[]
  ).map(toEvaluator);
}

export function getEvaluator(id: string): Evaluator {
  const row = db().prepare("SELECT * FROM evaluators WHERE id = ?").get(id) as
    Row | undefined;
  if (!row) throw new StoreError("evaluator not found", 404);
  return toEvaluator(row);
}

/** The template library, with a flag on the templates this workspace already has. */
export function listTemplates() {
  const installed = new Set(listEvaluators().map((e) => e.score_name));
  return TEMPLATES.map((t) => ({
    ...t,
    installed: installed.has(t.score_name),
  }));
}

// ── validation ──────────────────────────────────────────────────────────────────
const bad = (message: string): never => {
  throw new StoreError(message);
};

/** `is_advanced` and `template_variables` follow the prompt: a prompt with an `@VARIABLE` is a
 *  template. This is the one place that decides it. */
function stampAdvanced(config: EvaluatorConfig): EvaluatorConfig {
  if (typeof config.prompt !== "string") return config;
  const refs = extractTemplateVariables(config.prompt);
  return { ...config, template_variables: refs, is_advanced: refs.length > 0 };
}

/** Every column a `run_if` reads joins `depends_on`: that is what runs it first. */
function withConditionDeps(config: EvaluatorConfig): EvaluatorConfig {
  const needed = conditionColumns(config.run_if);
  if (!needed.length) return config;
  const deps = [...(config.depends_on ?? [])];
  return {
    ...config,
    depends_on: [...deps, ...needed.filter((n) => !deps.includes(n))],
  };
}

/** A decision model answers typed questions, not rubrics, so it and the `decision_*` output
 *  types come as a pair. A context fallback must be an LLM. */
async function validateModels(outputType: string, config: EvaluatorConfig) {
  const model = String(config.model ?? "").trim();
  const wantsDecision = isDecisionOutput(outputType);
  if (model && !wantsDecision && (await isDecisionModel(model)))
    bad(
      `${model} is a decision model: it answers one typed question instead of grading a ` +
        `rubric, so output_type must be one of ${DECISION_OUTPUT_TYPES.join(", ")}`,
    );
  if (wantsDecision) {
    if (model && !(await isDecisionModel(model)))
      bad(
        `output_type ${outputType} needs a decision model (e.g. typesafe/jev-1.13); ` +
          `${model} is an LLM — use score/number/boolean/text/json with it`,
      );
    const problem = validateDecision(config);
    if (problem) bad(problem);
  }
  const fallback = config.fallback_model;
  if (fallback !== undefined && fallback !== null) {
    if (typeof fallback !== "string" || !fallback.trim())
      bad("fallback_model must be a model id, or omitted");
    if (await isDecisionModel(fallback as string))
      bad(
        "fallback_model must be an LLM (it grades items too long for the column's model); " +
          "decision models have small fixed contexts",
      );
    if ((fallback as string).trim() === model)
      bad("fallback_model must differ from the column's model");
  }
}

async function validateEvaluator(kind: string, config: EvaluatorConfig) {
  if (kind !== "llm_judge")
    bad(
      'kind must be "llm_judge" (Tracely\'s structural checks are not in Parallax)',
    );
  const outputType = String(config.output_type || "score").toLowerCase();
  if (!OUTPUT_TYPES.includes(outputType))
    bad(`output_type must be one of ${OUTPUT_TYPES.join(", ")}`);
  if (
    !["batch", "sequential"].includes(String(config.execution_mode || "batch"))
  )
    bad("execution_mode must be 'batch' or 'sequential'");
  // A bad value here does not crash a run: the column silently stops producing scores.
  if (
    config.threshold !== undefined &&
    config.threshold !== null &&
    typeof config.threshold !== "number"
  )
    bad("threshold must be a number");
  if (
    config.max_spans !== undefined &&
    config.max_spans !== null &&
    !(Number.isInteger(config.max_spans) && (config.max_spans as number) >= 1)
  )
    bad("max_spans must be a positive integer");
  const types = config.span_types;
  if (types !== undefined && types !== null) {
    const allowed: readonly string[] = spanTypes;
    if (
      !Array.isArray(types) ||
      !types.every((t) => allowed.includes(String(t)))
    )
      bad(`span_types must be a list drawn from ${spanTypes.join(", ")}`);
  }
  const dependsOn = config.depends_on;
  if (
    dependsOn !== undefined &&
    dependsOn !== null &&
    !(Array.isArray(dependsOn) && dependsOn.every((d) => typeof d === "string"))
  )
    bad("depends_on must be a list of score names");
  await validateModels(outputType, config);
  const problem = validateRunIf(config.run_if);
  if (problem) bad(problem);
  if (
    outputType === "json" &&
    config.output_schema !== undefined &&
    config.output_schema !== null &&
    !fromJsonSchema(config.output_schema)
  )
    bad(
      "output_schema is not a usable JSON Schema (object with typed properties)",
    );
}

/** Which pass a column runs in. Columns see each other's results only inside one pass:
 *  conversation columns in the thread pass, the others per turn. */
const passOf = (level: string, config: EvaluatorConfig) =>
  level === CONVERSATION
    ? "conversation"
    : String(config.execution_mode ?? "batch") === "sequential"
      ? "sequential"
      : "batch";

/** Reject a Depends On / Run only when it could never be satisfied: a column that does not
 *  exist, one in another pass, or a cycle. */
function checkDependencies(
  level: string,
  config: EvaluatorConfig,
  ownScoreName = "",
) {
  const deps = [
    ...new Set([
      ...(config.depends_on ?? []),
      ...conditionColumns(config.run_if),
    ]),
  ];
  if (!deps.length) return;
  if (ownScoreName && deps.includes(ownScoreName))
    bad("a column cannot depend on itself");
  const known = new Map(listEvaluators().map((e) => [e.score_name, e]));
  const missing = deps.filter((n) => !known.has(n));
  if (missing.length)
    bad(
      `depends_on/run_if reads ${missing.join(", ")}, which are not columns here; ` +
        `existing: ${[...known.keys()].sort().join(", ") || "none"}`,
    );
  const mine = passOf(level, config);
  const wrong = deps
    .map((n) => [n, passOf(known.get(n)!.level, known.get(n)!.config)] as const)
    .filter(([, pass]) => pass !== mine);
  if (wrong.length)
    bad(
      `this column runs in the ${mine} pass but ${wrong.map(([n, p]) => `${n} (${p})`).join(", ")} ` +
        "run in another; passes don't share results, so the dependency could never be read. " +
        "Give both the same level group (conversation vs message/step) and execution_mode.",
    );
  if (!ownScoreName) return;
  const graph = new Map(
    [...known].map(([n, e]) => [n, e.config.depends_on ?? []] as const),
  );
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === ownScoreName)
      bad(`depends_on makes a cycle through ${ownScoreName}`);
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(graph.get(n) ?? []));
  }
}

const slugScoreName = (name: string) =>
  `custom.${
    (name || "metric")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "metric"
  }`;

// ── writes ──────────────────────────────────────────────────────────────────────
/** Add a column. `score_name` comes from the name when it is not given, with a number suffix
 *  when it is taken. Creating a column runs nothing. */
export async function createEvaluator(input: unknown, actor = "Julien") {
  const value = evaluatorCreateSchema.parse(input);
  const config = withConditionDeps(
    stampAdvanced(value.config as EvaluatorConfig),
  );
  await validateEvaluator(value.kind, config);
  return transaction(() => {
    checkDependencies(value.level, config);
    const taken = new Set(listEvaluators().map((e) => e.score_name));
    let scoreName = value.score_name || slugScoreName(value.name);
    if (taken.has(scoreName)) {
      const base = scoreName;
      let n = 2;
      while (taken.has(`${base}_${n}`.slice(0, 80))) n++;
      scoreName = `${base}_${n}`.slice(0, 80);
    }
    const id = randomUUID();
    db()
      .prepare(
        "INSERT INTO evaluators (id, name, description, kind, score_name, level, enabled, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        value.name,
        value.description,
        value.kind,
        scoreName,
        value.level,
        value.enabled ? 1 : 0,
        JSON.stringify(config),
        new Date().toISOString(),
      );
    log("created evaluator", null, value.name, actor);
    return getEvaluator(id);
  });
}

/** Change a column. A level change removes its scores: they address items the column no longer
 *  grades. Changes apply to the next run. */
export async function updateEvaluator(
  id: string,
  input: unknown,
  actor = "Julien",
) {
  const patch = evaluatorUpdateSchema.parse(input);
  const existing = getEvaluator(id);
  const config =
    patch.config === undefined
      ? existing.config
      : withConditionDeps(stampAdvanced(patch.config as EvaluatorConfig));
  const level = patch.level ?? existing.level;
  await validateEvaluator(existing.kind, config);
  return transaction(() => {
    checkDependencies(level, config, existing.score_name);
    db()
      .prepare(
        "UPDATE evaluators SET name = ?, description = ?, level = ?, enabled = ?, config = ? WHERE id = ?",
      )
      .run(
        patch.name ?? existing.name,
        patch.description ?? existing.description,
        level,
        (patch.enabled ?? existing.enabled) ? 1 : 0,
        JSON.stringify(config),
        id,
      );
    if (level !== existing.level) retractEvaluator(existing.score_name);
    log("updated evaluator", null, patch.name ?? existing.name, actor);
    return getEvaluator(id);
  });
}

/** Remove a column and its scores. */
export function deleteEvaluator(id: string, actor = "Julien") {
  const existing = getEvaluator(id);
  return transaction(() => {
    db().prepare("DELETE FROM evaluators WHERE id = ?").run(id);
    retractEvaluator(existing.score_name);
    log("deleted evaluator", null, existing.name, actor);
    return { deleted: id };
  });
}

// ── specs: the runner's view ────────────────────────────────────────────────────
export type Spec = {
  id: string;
  kind: string;
  config: EvaluatorConfig;
  score_name: string;
  level: string;
};

/** The enabled evaluators to run, in creation order. When narrowed by id, the enabled columns
 *  they depend on come too (a dependent cannot be graded without its prerequisites). */
export function enabledSpecs(evaluatorIds?: string[]): Spec[] {
  const all: Spec[] = listEvaluators()
    .filter((e) => e.enabled)
    .map(({ id, kind, config, score_name, level }) => ({
      id,
      kind,
      config,
      score_name,
      level,
    }));
  if (!evaluatorIds?.length) return all;
  const byName = new Map(all.map((s) => [s.score_name, s]));
  const selected = new Set(
    all.filter((s) => evaluatorIds.includes(s.id)).map((s) => s.id),
  );
  const frontier = all.filter((s) => selected.has(s.id));
  while (frontier.length) {
    const spec = frontier.pop()!;
    for (const name of spec.config.depends_on ?? []) {
      const dep = byName.get(name);
      if (dep && !selected.has(dep.id)) {
        selected.add(dep.id);
        frontier.push(dep);
      }
    }
  }
  return all.filter((s) => selected.has(s.id));
}

/** Score names of the columns marked `config.advisory`: a FAIL on one is shown but does not
 *  make the turn fail. */
export function advisoryNames(): Set<string> {
  return new Set(
    listEvaluators()
      .filter((e) => e.config.advisory === true)
      .map((e) => e.score_name),
  );
}

// ── spans for the judge ─────────────────────────────────────────────────────────
const toJudgeSpan = (s: TraceSpan): JudgeSpan => ({
  trace_id: s.traceId,
  span_id: s.spanId,
  parent_span_id: s.parentSpanId ?? "",
  name: s.name,
  type: s.type,
  level: s.level,
  status_message: s.statusMessage,
  input: s.input,
  output: s.output,
  metadata: s.metadata,
});

/** One trace's spans by start time, and the thread it belongs to. Null when there is none. */
export function readTrace(traceId: string) {
  try {
    const trace = getTrace(traceId);
    return {
      spans: trace.spanList.map(toJudgeSpan),
      threadId: trace.sessionId ?? traceId,
    };
  } catch (error) {
    if (error instanceof StoreError && error.status === 404) return null;
    throw error;
  }
}

/** Every span of a thread, by start time, so first-seen trace order is turn order. */
export function readThreadSpans(threadId: string): JudgeSpan[] {
  try {
    return getSession(threadId).spanList.map(toJudgeSpan);
  } catch (error) {
    if (error instanceof StoreError && error.status === 404) return [];
    throw error;
  }
}

// ── scores ──────────────────────────────────────────────────────────────────────
type ScoreRow = {
  id: string;
  name: string;
  level: string;
  trace_id: string | null;
  session_id: string;
  span_id: string;
  data_type: string;
  value: number | null;
  string_value: string;
  verdict: string;
  comment: string;
  graded: number;
  error: number;
  calls: string;
};
const toScore = (r: ScoreRow): EvalScore => ({
  name: r.name,
  evaluation_level: r.level,
  observation_id: r.span_id || null,
  value: r.value,
  string_value: r.string_value,
  verdict: r.verdict,
  comment: r.comment,
  data_type: r.data_type,
  trace_id: r.trace_id,
  session_id: r.session_id,
  graded: r.graded === 1,
  error: r.error === 1,
});

/** One score per (thread, column) at conversation level, else per (trace, column, span). The
 *  id is the address, so a re-run replaces the score. */
export function scoreId(
  traceId: string,
  threadId: string,
  r: EvalResult,
): string {
  return r.level === CONVERSATION
    ? `thread:${threadId}:${r.name}`
    : `${traceId}:${r.name}:${r.target_span_id}`;
}

export function resultToScore(
  r: EvalResult,
  traceId: string,
  threadId: string,
): EvalScore {
  return {
    name: r.name,
    evaluation_level: r.level,
    observation_id: r.target_span_id || null,
    value: r.value,
    string_value: r.string_value,
    verdict: r.verdict,
    comment: r.comment,
    data_type: r.data_type,
    trace_id: r.level === CONVERSATION ? null : traceId,
    session_id: threadId || null,
    graded: r.graded,
    error: r.error,
  };
}

/** Store the results of one item. `traceId` is "" for a conversation pass. */
export function writeScores(
  traceId: string,
  threadId: string,
  results: EvalResult[],
) {
  if (!results.length) return;
  transaction(() => {
    const insert = db().prepare(
      `INSERT OR REPLACE INTO eval_scores (id, name, level, trace_id, session_id, span_id, data_type, value, string_value, verdict, comment, graded, error, model, input_tokens, output_tokens, cost_usd, calls, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const r of results)
      insert.run(
        scoreId(traceId, threadId, r),
        r.name,
        r.level,
        r.level === CONVERSATION ? null : traceId,
        threadId,
        r.target_span_id,
        r.data_type,
        r.value,
        r.string_value,
        r.verdict,
        r.comment,
        r.graded ? 1 : 0,
        r.error ? 1 : 0,
        r.usage?.model ?? r.calls[0]?.model ?? "",
        r.usage?.input_tokens ?? 0,
        r.usage?.output_tokens ?? 0,
        r.usage?.cost_usd ?? null,
        JSON.stringify(r.calls),
        now,
      );
  });
}

/** Remove what the columns in `ran` did not produce this time, for this item: a column's run
 *  replaces its previous results (a step it stopped grading is retracted, not left failing). */
export function retractStale(
  ran: string[],
  results: EvalResult[],
  item: { traceId: string; threadId: string },
) {
  if (!ran.length) return;
  const keep = new Set(
    results.map((r) => scoreId(item.traceId, item.threadId, r)),
  );
  const marks = ran.map(() => "?").join(",");
  const rows = (
    item.traceId
      ? db()
          .prepare(
            `SELECT id FROM eval_scores WHERE trace_id = ? AND name IN (${marks})`,
          )
          .all(item.traceId, ...ran)
      : db()
          .prepare(
            `SELECT id FROM eval_scores WHERE trace_id IS NULL AND session_id = ? AND name IN (${marks})`,
          )
          .all(item.threadId, ...ran)
  ) as { id: string }[];
  const stale = rows.filter((r) => !keep.has(r.id));
  const remove = db().prepare("DELETE FROM eval_scores WHERE id = ?");
  for (const r of stale) remove.run(r.id);
}

function retractEvaluator(scoreName: string) {
  db().prepare("DELETE FROM eval_scores WHERE name = ?").run(scoreName);
}

const scoreColumns =
  "id, name, level, trace_id, session_id, span_id, data_type, value, string_value, verdict, comment, graded, error, calls";

/** Message and step scores of these traces, by trace id. */
export function scoresForTraces(traceIds: string[]): Map<string, EvalScore[]> {
  const out = new Map<string, EvalScore[]>();
  if (!traceIds.length) return out;
  const rows = db()
    .prepare(
      `SELECT ${scoreColumns} FROM eval_scores WHERE trace_id IN (${traceIds.map(() => "?").join(",")}) ORDER BY name, span_id`,
    )
    .all(...traceIds) as ScoreRow[];
  for (const r of rows)
    out.set(r.trace_id!, [...(out.get(r.trace_id!) ?? []), toScore(r)]);
  return out;
}

/** Conversation-level scores of these threads, by thread id. */
export function scoresForSessions(
  sessionIds: string[],
): Map<string, EvalScore[]> {
  const out = new Map<string, EvalScore[]>();
  if (!sessionIds.length) return out;
  const rows = db()
    .prepare(
      `SELECT ${scoreColumns} FROM eval_scores WHERE trace_id IS NULL AND session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY name`,
    )
    .all(...sessionIds) as ScoreRow[];
  for (const r of rows)
    out.set(r.session_id, [...(out.get(r.session_id) ?? []), toScore(r)]);
  return out;
}

/** The roll-up shown on a turn: FAIL when a non-advisory column failed, PASS when there are
 *  scores and none did, null with no scores. */
export function rollupVerdict(
  scores: EvalScore[],
  advisory: Set<string>,
): string | null {
  if (!scores.length) return null;
  return scores.some((s) => s.verdict === "FAIL" && !advisory.has(s.name))
    ? "FAIL"
    : "PASS";
}

/** The model calls behind one score cell: the judge's prompt and what came back. `subject` is
 *  the trace id for a message or step score, the thread id for a conversation score. */
export function scoreCalls(input: {
  subject: string;
  level: string;
  name: string;
  spanId: string;
}): JudgeCall[] {
  const row = (
    input.level === "conv"
      ? db()
          .prepare(
            "SELECT calls FROM eval_scores WHERE trace_id IS NULL AND session_id = ? AND name = ?",
          )
          .get(input.subject, input.name)
      : db()
          .prepare(
            "SELECT calls FROM eval_scores WHERE trace_id = ? AND name = ? AND span_id = ?",
          )
          .get(
            input.subject,
            input.name,
            input.level === "step" ? input.spanId : "",
          )
  ) as { calls: string } | undefined;
  return row ? JSON.parse(row.calls) : [];
}

/** Token use and reported cost of each judge column over the last `days`. Cost is the sum of
 *  what the provider reported; there is no price table. */
export function evaluatorCost(daysInput: unknown = 30) {
  const days = Math.max(1, Math.min(Math.round(Number(daysInput)) || 30, 365));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db()
    .prepare(
      `SELECT name, COUNT(*) AS runs, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cost_usd) AS cost_usd, MAX(model) AS model
       FROM eval_scores WHERE created_at >= ? AND (input_tokens > 0 OR output_tokens > 0) GROUP BY name`,
    )
    .all(since) as {
    name: string;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    model: string;
  }[];
  const { traces } = db()
    .prepare(
      "SELECT COUNT(DISTINCT trace_id) AS traces FROM trace_spans WHERE start_ms >= ?",
    )
    .get(Date.parse(since)) as { traces: number };
  const cents = (usd: number | null) => Math.round((usd ?? 0) * 100);
  const evaluators = Object.fromEntries(
    rows.map((r) => [
      r.name,
      {
        runs: r.runs,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        total_tokens: r.input_tokens + r.output_tokens,
        cost_usd_cents: cents(r.cost_usd),
        model: r.model,
      },
    ]),
  );
  return {
    evaluators,
    summary: {
      days,
      traces_in_window: traces,
      total_runs: rows.reduce((n, r) => n + r.runs, 0),
      total_input_tokens: rows.reduce((n, r) => n + r.input_tokens, 0),
      total_output_tokens: rows.reduce((n, r) => n + r.output_tokens, 0),
      total_cost_usd_cents: cents(
        rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
      ),
    },
  };
}

// ── scores on the trace reads ───────────────────────────────────────────────────
/** A page of sessions, each with its conversation-level scores. */
export function withSessionScores<T extends { sessionId: string }>(page: {
  items: T[];
  total: number;
}) {
  const scores = scoresForSessions(page.items.map((s) => s.sessionId));
  return {
    ...page,
    items: page.items.map((s) => ({
      ...s,
      scores: scores.get(s.sessionId) ?? [],
    })),
  };
}

/** A trace with its message and step scores and the roll-up verdict. */
export function withTraceScores<T extends { traceId: string }>(trace: T) {
  const scores = scoresForTraces([trace.traceId]).get(trace.traceId) ?? [];
  return { ...trace, scores, verdict: rollupVerdict(scores, advisoryNames()) };
}

/** One session with its conversation scores, and the scores and verdict of every turn. */
export function withSessionDetailScores<
  S extends { sessionId: string },
  T extends { traceId: string },
>({ traces, ...session }: S & { traces: T[] }) {
  const byTrace = scoresForTraces(traces.map((t) => t.traceId));
  const advisory = advisoryNames();
  return {
    ...session,
    scores: scoresForSessions([session.sessionId]).get(session.sessionId) ?? [],
    traces: traces.map((t) => {
      const scores = byTrace.get(t.traceId) ?? [];
      return { ...t, scores, verdict: rollupVerdict(scores, advisory) };
    }),
  };
}
