// Run evaluators on traces and threads and store the scores. Port of Tracely
// `services/evaluation_service.py`, for runs the user starts (the table's Play buttons, MCP).
//
// - `evaluateTrace`: the message and step columns on one trace.
// - `evaluateThread`: every turn of a conversation, oldest first, then the conversation columns
//   once. Sequential columns chain across the turns: each turn gets the previous turn's result
//   of the same column.
//
// Scores have a deterministic address, so a re-run replaces them. Not ported: the automatic run
// on ingest (and with it debounce, targeting, sampling and incremental chains), failure
// clustering and alerts. Parallax never starts a paid model call on its own.
import { log } from "../store";
import {
  chainPayload,
  CFG_DEPENDENCIES,
  CFG_PREVIOUS,
  runJudge,
  type RunContext,
} from "./llm-judge";
import type { Payload } from "./conditions";
import { llmEnabled } from "./provider";
import {
  enabledSpecs,
  readThreadSpans,
  readTrace,
  resultToScore,
  retractStale,
  writeScores,
  type Spec,
} from "./store";
import { referencesConversationScope } from "./template";
import { rootSpan, type JudgeSpan } from "./text";
import { CONVERSATION, RUN, type EvalResult, type EvalScore } from "./types";

export type OnResult = (score: EvalScore) => void;

const executionMode = (spec: Spec) =>
  String(spec.config.execution_mode ?? "batch").toLowerCase() === "sequential"
    ? "sequential"
    : "batch";

/** Order specs so the columns in `depends_on` run before their dependents. A cycle keeps the
 *  given order. */
function topoSort(specs: Spec[]): Spec[] {
  const byName = new Map(specs.map((s) => [s.score_name, s]));
  const dependents = new Map<string, string[]>(
    specs.map((s) => [s.score_name, []]),
  );
  const inDegree = new Map<string, number>();
  for (const s of specs) {
    const deps = (s.config.depends_on ?? []).filter((d) => byName.has(d));
    inDegree.set(s.score_name, deps.length);
    for (const dep of deps) dependents.get(dep)!.push(s.score_name);
  }
  const queue = specs.filter((s) => inDegree.get(s.score_name) === 0);
  const ordered: Spec[] = [];
  while (queue.length) {
    const spec = queue.shift()!;
    ordered.push(spec);
    for (const name of dependents.get(spec.score_name)!) {
      inDegree.set(name, inDegree.get(name)! - 1);
      if (inDegree.get(name) === 0) queue.push(byName.get(name)!);
    }
  }
  if (ordered.length !== specs.length) {
    console.warn(
      `evaluator dependency cycle: ${specs.map((s) => s.score_name).join(", ")}`,
    );
    return specs;
  }
  return ordered;
}

type Completed = Map<string, { span_id: string; payload: Payload }[]>;

/** A copy of the spec with the results of its dependencies in the config. */
function injectDependencies(spec: Spec, completed: Completed): Spec {
  const deps = Object.fromEntries(
    (spec.config.depends_on ?? [])
      .filter((name) => completed.has(name))
      .map((name) => [name, completed.get(name)]),
  );
  if (!Object.keys(deps).length) return spec;
  return { ...spec, config: { ...spec.config, [CFG_DEPENDENCIES]: deps } };
}

/** True when a message or step column needs the whole thread: a sequential message judge (it
 *  grades a message in the light of the earlier turns), or a template that names a
 *  conversation-scoped variable. */
function needsThreadContext(specs: Spec[]): boolean {
  return specs.some(
    (s) =>
      (executionMode(s) === "sequential" && s.level === RUN) ||
      (s.config.is_advanced &&
        referencesConversationScope(s.config.template_variables)),
  );
}

/** Run `specs` on one item. `ran` collects the columns that ran to the end: their previous
 *  results for this item may be replaced. A column that threw is not in it. */
async function dispatchSpecs(
  specs: Spec[],
  ctx: RunContext,
  ran: string[],
): Promise<EvalResult[]> {
  const completed: Completed = new Map();
  const results: EvalResult[] = [];
  for (const base of topoSort(specs)) {
    const spec = injectDependencies(base, completed);
    try {
      const found = await runJudge(spec.level, spec.config, ctx);
      for (const r of found) r.name = spec.score_name;
      // It ran, unless it gave nothing because it could not (no OpenRouter key).
      if (found.length || llmEnabled()) ran.push(spec.score_name);
      results.push(...found);
      const graded = found.filter((r) => r.graded); // "Not run" and "Skipped" are not evidence
      if (graded.length)
        completed.set(
          spec.score_name,
          graded.map((r) => ({
            span_id: r.target_span_id,
            payload: chainPayload(r),
          })),
        );
    } catch (error) {
      // One bad column must not stop the others.
      console.warn(
        `evaluator ${spec.score_name} failed: ${(error as Error).message}`,
      );
    }
  }
  return results;
}

function emit(
  onResult: OnResult | undefined,
  results: EvalResult[],
  traceId: string,
  threadId: string,
) {
  if (onResult)
    for (const r of results) onResult(resultToScore(r, traceId, threadId));
}

type TraceOutcome = {
  scores: number;
  failures: number;
  threadId: string;
  ran: string[];
};

/** Run the message and step columns of `specs` on one trace. */
export async function evaluateTrace(
  traceId: string,
  specs: Spec[],
  options: { onResult?: OnResult; threadSpans?: JudgeSpan[] | null } = {},
): Promise<TraceOutcome> {
  const trace = readTrace(traceId);
  if (!trace) return { scores: 0, failures: 0, threadId: traceId, ran: [] };
  const { spans, threadId } = trace;
  const traceSpecs = specs.filter((s) => s.level !== CONVERSATION);
  let threadSpans = options.threadSpans ?? null;
  if (!threadSpans && threadId !== traceId && needsThreadContext(traceSpecs))
    threadSpans = readThreadSpans(threadId);
  const ctx: RunContext = {
    traceId,
    threadId,
    spans,
    root: rootSpan(spans),
    threadSpans,
  };
  const ran: string[] = [];
  const results = await dispatchSpecs(traceSpecs, ctx, ran);
  writeScores(traceId, threadId, results);
  emit(options.onResult, results, traceId, threadId);
  retractStale(ran, results, { traceId, threadId });
  return {
    scores: results.length,
    failures: results.filter((r) => r.verdict === "FAIL").length,
    threadId,
    ran,
  };
}

/** Run the CONVERSATION-level specs once over every span of the thread. */
async function evaluateConversation(
  threadId: string,
  specs: Spec[],
  spans: JudgeSpan[],
  onResult?: OnResult,
): Promise<number> {
  if (!spans.length || !specs.length) return 0;
  const ctx: RunContext = {
    traceId: "",
    threadId,
    spans,
    root: rootSpan(spans),
    threadSpans: null,
  };
  const ran: string[] = [];
  const results = await dispatchSpecs(specs, ctx, ran);
  writeScores("", threadId, results);
  emit(onResult, results, "", threadId);
  retractStale(ran, results, { traceId: "", threadId });
  return results.length;
}

/** Run `specs` on a whole conversation: every turn with the message and step columns, then the
 *  conversation columns once. Every run grades all turns again, from the first. */
export async function evaluateThread(
  threadId: string,
  specs: Spec[],
  onResult?: OnResult,
): Promise<{ scores: number; failures: number }> {
  const threadSpans = readThreadSpans(threadId);
  const turnIds = [...new Set(threadSpans.map((s) => s.trace_id))];
  const traceSpecs = specs.filter((s) => s.level !== CONVERSATION);
  const convSpecs = specs.filter((s) => s.level === CONVERSATION);
  let scores = 0;
  let failures = 0;
  if (traceSpecs.length && turnIds.length) {
    const sequential = new Set(
      traceSpecs
        .filter((s) => executionMode(s) === "sequential")
        .map((s) => s.score_name),
    );
    // The previous turn's result of each sequential column, as the next turn's seed.
    const chain = new Map<string, Payload>();
    const errored = new Set<string>();
    const halted = new Set<string>();
    const capture: OnResult = (score) => {
      if (sequential.has(score.name)) {
        if (score.error) errored.add(score.name);
        if (score.graded) chain.set(score.name, chainPayload(score));
      }
      onResult?.(score);
    };
    for (const traceId of turnIds) {
      const due = traceSpecs.filter((s) => !halted.has(s.score_name));
      if (!due.length) break;
      const staged = due.map((s) =>
        chain.has(s.score_name)
          ? {
              ...s,
              config: { ...s.config, [CFG_PREVIOUS]: chain.get(s.score_name) },
            }
          : s,
      );
      const r = await evaluateTrace(traceId, staged, {
        onResult: capture,
        threadSpans,
      });
      scores += r.scores;
      failures += r.failures;
      // A sequential column whose grade failed on this turn (or that did not run) stops here:
      // the next turn would chain on a result that does not exist.
      for (const name of sequential)
        if (errored.has(name) || !r.ran.includes(name)) halted.add(name);
      errored.clear();
    }
  }
  scores += await evaluateConversation(
    threadId,
    convSpecs,
    threadSpans,
    onResult,
  );
  return { scores, failures };
}

export type RunEvent =
  | { type: "start"; targets: number; evaluators: number }
  | { type: "result"; score: EvalScore }
  | { type: "target_done"; target: string; scores: number }
  | { type: "target_error"; target: string; detail: string };

export const MAX_TARGETS = 200;
const CONCURRENCY = 3;

/** A run the user started: `thread_ids` are conversation rows (every turn, then the
 *  conversation columns), `trace_ids` are turn rows. An empty `evaluator_ids` means every
 *  enabled column. Up to three targets run at the same time. */
export async function runEvaluators(
  input: {
    evaluator_ids?: string[];
    thread_ids?: string[];
    trace_ids?: string[];
  },
  onEvent: (event: RunEvent) => void = () => undefined,
  actor = "Julien",
) {
  const unique = (ids: string[] | undefined) =>
    [...new Set((ids ?? []).filter(Boolean))].slice(0, MAX_TARGETS);
  const threads = unique(input.thread_ids);
  const traces = unique(input.trace_ids);
  const specs = enabledSpecs(input.evaluator_ids);
  const targets = [
    ...threads.map((id) => ({ kind: "thread" as const, id })),
    ...traces.map((id) => ({ kind: "trace" as const, id })),
  ];
  let scores = 0;
  let errors = 0;
  onEvent({ type: "start", targets: targets.length, evaluators: specs.length });
  const onResult: OnResult = (score) => onEvent({ type: "result", score });
  const next = targets[Symbol.iterator]();
  const worker = async () => {
    for (const target of next) {
      try {
        const r =
          target.kind === "thread"
            ? await evaluateThread(target.id, specs, onResult)
            : await evaluateTrace(target.id, specs, { onResult });
        scores += r.scores;
        onEvent({ type: "target_done", target: target.id, scores: r.scores });
      } catch (error) {
        errors += 1;
        onEvent({
          type: "target_error",
          target: target.id,
          detail: String((error as Error).message).slice(0, 300),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (targets.length && specs.length)
    log(
      "ran evaluators",
      null,
      `${specs.length} evaluator${specs.length === 1 ? "" : "s"} on ${targets.length} item${targets.length === 1 ? "" : "s"}: ${scores} score${scores === 1 ? "" : "s"}`,
      actor,
    );
  return { targets: targets.length, evaluators: specs.length, scores, errors };
}
