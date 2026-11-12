// The LLM judge: one evaluator, three levels. Port of Tracely `evaluators/llm_judge.py`.
//
// The column's rubric is the SYSTEM prompt and the graded item is the USER message (prompts.ts):
//   CONVERSATION            the whole transcript, once
//   AGENT_RUN (message)     one [user, agent] pair
//   SPAN/TOOL/GENERATION/CHAIN  one step inside the message (the message root is not a step)
//
// `config.output_type` → the stored score:
//   score (default)  value 0..1, PASS/FAIL by `threshold`
//   number           any value, PASS/FAIL only when `threshold` is set
//   boolean          1/0, PASS/FAIL
//   text             string_value, no verdict
//   json             the user's `output_schema`, exactly the user's fields. A numeric `score`
//                    drives value and PASS/FAIL; `reason`/`reasoning`/`summary` is the comment.
//   decision_*       a decision model's answer (decision.ts)
//
// `config.execution_mode`: "batch" grades every item alone; "sequential" adds the earlier items
// (earlier turns for a message judge, earlier steps for a step judge) and this column's previous
// result to what the judge reads. Tracely keeps a durable chat per sequential column; Parallax
// uses its documented fallback: the earlier items are pasted into each item's prompt.
//
// A grade that fails gives a visible "Error" result with no verdict. It never writes a fake one.
import { fits, estimateTokens, k, overflowNote } from "./budget";
import { DEFAULT_JUDGE_PROMPT } from "./catalog";
import { evaluateRunIf, type Payload } from "./conditions";
import * as decision from "./decision";
import * as prompts from "./prompts";
import * as provider from "./provider";
import {
  fromJsonSchema,
  parseJsonObject,
  type Json,
  type OutputSchema,
} from "./structured";
import {
  buildContext,
  extractTemplateVariables,
  resolveTemplate,
  type EvaluationContext,
} from "./template";
import { rootSpan, userMessage, type JudgeSpan } from "./text";
import {
  CONVERSATION,
  STEP_LEVELS,
  type EvalResult,
  type EvaluatorConfig,
  type JudgeCall,
  type Usage,
} from "./types";

export const OUTPUT_TYPES = [
  "score",
  "number",
  "boolean",
  "text",
  "json",
  ...decision.DECISION_OUTPUT_TYPES,
];
const DEFAULT_MAX_SPANS = 30; // cost guard for step judges

// Keys the runner adds to a config for one run. They are never stored.
export const CFG_PREVIOUS = "__previous_result__"; // sequential: the previous turn's result
export const CFG_DEPENDENCIES = "__dependencies__"; // depends_on: {score_name: [{span_id, payload}]}

/** The bundle every grade gets. For CONVERSATION level `spans` holds the whole thread and
 *  `traceId` is "". `threadSpans` is the whole thread when a message or step judge needs it. */
export type RunContext = {
  traceId: string;
  threadId: string;
  spans: JudgeSpan[];
  root: JudgeSpan;
  threadSpans: JudgeSpan[] | null;
};

// ── structured replies ──────────────────────────────────────────────────────────
const SCORE: OutputSchema = {
  name: "ScoreVerdict",
  description: "Quality grade with a normalized score.",
  properties: {
    score: {
      type: "number",
      description:
        "0..1 quality score: 0 = total failure, 0.5 = mediocre, 1 = flawless",
    },
    reason: {
      type: "string",
      description: "one or two sentences citing the decisive evidence",
    },
  },
};
const NUMBER: OutputSchema = {
  name: "NumberVerdict",
  description: "Numeric measurement (any range).",
  properties: {
    value: { type: "number", description: "the numeric evaluation result" },
    reason: {
      type: "string",
      description: "one or two sentences justifying the number",
    },
  },
};
const PASS_FAIL: OutputSchema = {
  name: "PassFailVerdict",
  description: "Binary check outcome.",
  properties: {
    passed: {
      type: "boolean",
      description: "true when the graded content passes this check",
    },
    reason: {
      type: "string",
      description: "the strongest signal behind the decision",
    },
  },
};
const TEXT: OutputSchema = {
  name: "TextVerdict",
  description: "Free-text observation.",
  properties: {
    text: {
      type: "string",
      description: "the observation — a short, specific paragraph",
    },
    reason: {
      type: "string",
      description: "one sentence on why this observation matters",
    },
  },
};

// ── results ─────────────────────────────────────────────────────────────────────
function makeResult(level: string, fields: Partial<EvalResult>): EvalResult {
  return {
    name: "",
    level,
    verdict: "",
    data_type: "BOOLEAN",
    value: null,
    string_value: "",
    target_span_id: "",
    comment: "",
    usage: null,
    calls: [],
    graded: true,
    error: false,
    ...fields,
  };
}

/** A result as the compact object that goes into the next item's context in sequential mode,
 *  and into a dependent column's context. A json column keeps its own fields; every other
 *  output type becomes `{label, value, verdict, reason}` without the empty fields. */
export function chainPayload(r: {
  value: number | null;
  verdict: string;
  comment: string;
  string_value: string;
}): Payload {
  let label: string | null = null;
  if (r.string_value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.string_value);
    } catch {
      label = r.string_value; // not JSON: a decision column's label
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const out: Payload = { ...(parsed as Payload) };
      if (r.value !== null && !("score" in out)) out.score = r.value;
      if (r.verdict && !("verdict" in out)) out.verdict = r.verdict;
      if (r.comment && !("reason" in out)) out.reason = r.comment;
      return out;
    }
  }
  const payload: Payload = {};
  if (label !== null) payload.label = label;
  if (r.value !== null) payload.value = r.value;
  if (r.verdict) payload.verdict = r.verdict;
  if (r.comment) payload.reason = r.comment;
  return payload;
}

type DependencyRecord = { span_id: string; payload: Payload };

/** Dependency results as `{score_name: payload | payload[]}`. Without a span id (a message or
 *  conversation grade) every result of each dependency applies. With one (a step), the
 *  dependency's result for this span, else its message-level result. */
function depsOf(
  config: EvaluatorConfig,
  spanId: string | null = null,
): Record<string, unknown> {
  const raw = (config[CFG_DEPENDENCIES] ?? {}) as Record<
    string,
    DependencyRecord[]
  >;
  const out: Record<string, unknown> = {};
  for (const [name, records] of Object.entries(raw)) {
    if (!Array.isArray(records) || !records.length) continue;
    let match = records;
    if (spanId !== null) {
      match = records.filter((r) => r.span_id === spanId);
      if (!match.length) match = records.filter((r) => !r.span_id);
    }
    if (match.length)
      out[name] =
        match.length === 1 ? match[0].payload : match.map((m) => m.payload);
  }
  return out;
}

const isSequential = (config: EvaluatorConfig) =>
  String(config.execution_mode ?? "batch") === "sequential";

function previousFromConfig(config: EvaluatorConfig): Payload | null {
  if (!isSequential(config)) return null;
  const prev = config[CFG_PREVIOUS];
  return typeof prev === "object" && prev !== null ? (prev as Payload) : null;
}

/** Runs one column on one item (a trace, or a thread for CONVERSATION level). The caller stamps
 *  the score name on the results. Returns [] when no key is configured or nothing is gradable. */
export async function runJudge(
  level: string,
  config: EvaluatorConfig,
  ctx: RunContext,
): Promise<EvalResult[]> {
  if (!provider.llmEnabled()) return [];
  return new Judge(level, config, ctx).run();
}

class Judge {
  constructor(
    private level: string,
    private config: EvaluatorConfig,
    private ctx: RunContext,
  ) {}

  async run(): Promise<EvalResult[]> {
    const { config, level } = this;
    if (!STEP_LEVELS.includes(level) && config.run_if) {
      // One item (the turn or the thread): gate it once. Step levels gate per step.
      const [ok, why] = evaluateRunIf(config.run_if, depsOf(config));
      if (!ok) return [this.notRun(why)];
    }
    if (config.is_advanced) return this.runAdvanced();
    if (level === CONVERSATION) return this.runConversation();
    if (STEP_LEVELS.includes(level)) return this.runSteps();
    return this.runMessage();
  }

  /** A neutral, visible score for an item this column's `run_if` excluded. It is written, so a
   *  re-run replaces a stale grade and the cell says why it is empty. */
  private notRun(why: string, spanId = ""): EvalResult {
    return makeResult(this.level, {
      data_type: "TEXT",
      string_value: "Not run",
      comment: why.slice(0, 500),
      target_span_id: spanId,
      graded: false,
    });
  }

  private stepGate(spanId: string): EvalResult | null {
    if (!this.config.run_if) return null;
    const [ok, why] = evaluateRunIf(
      this.config.run_if,
      depsOf(this.config, spanId),
    );
    return ok ? null : this.notRun(why, spanId);
  }

  // ── per-level runners ─────────────────────────────────────────────────────────

  /** One grade for the message: user request and final answer. Skipped only when the run has
   *  neither; an agent that gave no answer is still graded. */
  private async runMessage(): Promise<EvalResult[]> {
    const { config, ctx } = this;
    const body = prompts.messageBody(
      ctx.spans,
      config.include_answer !== false,
    );
    if (!body) return [];
    // Sequential: the earlier turns are the context this message is judged in. Batch grades the
    // message alone. That is the only difference between the modes at this level.
    let history = "";
    if (isSequential(config) && ctx.threadSpans) {
      const lines = prompts.turnLines(ctx.threadSpans, ctx.traceId);
      if (lines.length)
        history = `Conversation so far (earlier turns, oldest first):\n${lines.join("\n")}\n\n`;
    }
    return [await this.grade(history + body, previousFromConfig(config))];
  }

  /** The spans a step judge grades, capped at `max_spans`, and the count before the cap. Level
   *  SPAN takes `config.span_types` (all types when empty); TOOL/GENERATION/CHAIN take that
   *  type. The message root is never a step. */
  private stepCandidates(): [JudgeSpan[], number] {
    const { config, ctx, level } = this;
    const wanted =
      level === "SPAN"
        ? new Set((config.span_types ?? []).map((t) => String(t).toUpperCase()))
        : new Set([level]);
    const candidates = ctx.spans.filter(
      (s) =>
        (!wanted.size || wanted.has(s.type)) &&
        s.span_id !== ctx.root.span_id &&
        (s.input || s.output),
    );
    const maxSpans = Number(config.max_spans) || DEFAULT_MAX_SPANS;
    return [candidates.slice(0, maxSpans), candidates.length];
  }

  /** Said on each result of a capped run, so partial coverage is visible. */
  private coverage(graded: number, eligible: number): string {
    return eligible > graded
      ? ` [coverage: graded ${graded} of ${eligible} steps; ${eligible - graded} not evaluated (max_spans cap)]`
      : "";
  }

  /** One grade per step. */
  private async runSteps(): Promise<EvalResult[]> {
    const { config, ctx } = this;
    const [candidates, eligible] = this.stepCandidates();
    const coverage = this.coverage(candidates.length, eligible);
    const sequential = isSequential(config);
    let previous = previousFromConfig(config);
    const request = ctx.spans.length ? userMessage(rootSpan(ctx.spans)) : "";
    const out: EvalResult[] = [];
    for (const [i, s] of candidates.entries()) {
      const gated = this.stepGate(s.span_id);
      if (gated) {
        out.push(gated);
        continue;
      }
      // Sequential: the run so far is context. Batch grades each step on its own.
      const trajectory =
        sequential && i
          ? "Steps already taken in this message (oldest first):\n" +
            candidates
              .slice(0, i)
              .map((p, n) => prompts.stepLine(p, n + 1))
              .join("\n") +
            "\n\n"
          : "";
      const result = await this.grade(
        trajectory + prompts.stepBody(candidates, i, request),
        previous,
        depsOf(config, s.span_id),
      );
      result.target_span_id = s.span_id;
      if (coverage) result.comment += coverage;
      out.push(result);
      if (sequential && result.graded) previous = chainPayload(result);
    }
    return out;
  }

  /** One grade for the whole thread: a turn-by-turn transcript, and nothing else. */
  private async runConversation(): Promise<EvalResult[]> {
    const lines = prompts.turnLines(this.ctx.spans);
    if (!lines.length) return [];
    const turns =
      lines.filter((l) => l.includes(" — user: ")).length || lines.length;
    const body = `Full conversation (${turns} turn${turns !== 1 ? "s" : ""}):\n${lines.join("\n")}`;
    return [await this.grade(body)];
  }

  // ── advanced (template) grading ───────────────────────────────────────────────

  /** Resolve the user's `@VARIABLE` template against the trace or thread, then grade. */
  private async runAdvanced(): Promise<EvalResult[]> {
    const { config, ctx, level } = this;
    const template = config.prompt ?? "";
    const wanted =
      config.template_variables ?? extractTemplateVariables(template);
    const threadSpans = ctx.threadSpans ?? ctx.spans;
    if (STEP_LEVELS.includes(level))
      return this.runAdvancedSteps(template, wanted, threadSpans);
    const context = buildContext(level, {
      threadSpans,
      currentTraceId: ctx.traceId,
      metricPreviousResult: previousFromConfig(config),
      wantedVars: wanted,
      dependencies: depsOf(config),
    });
    const result = await this.gradeResolved(template, context);
    return result ? [result] : [];
  }

  /** One advanced grade per step. In sequential mode the previous result goes into
   *  `@METRIC_PREVIOUS_RESULT`. */
  private async runAdvancedSteps(
    template: string,
    wanted: string[],
    threadSpans: JudgeSpan[],
  ): Promise<EvalResult[]> {
    const { config, ctx, level } = this;
    const sequential = isSequential(config);
    let previous = previousFromConfig(config);
    const [candidates, eligible] = this.stepCandidates();
    const coverage = this.coverage(candidates.length, eligible);
    const out: EvalResult[] = [];
    for (const s of candidates) {
      const gated = this.stepGate(s.span_id);
      if (gated) {
        out.push(gated);
        continue;
      }
      const context = buildContext(level, {
        threadSpans,
        currentTraceId: ctx.traceId,
        currentSpanId: s.span_id,
        metricPreviousResult: previous,
        wantedVars: wanted,
        dependencies: depsOf(config, s.span_id),
      });
      const result = await this.gradeResolved(template, context);
      if (!result) continue;
      result.target_span_id = s.span_id;
      if (coverage) result.comment += coverage;
      out.push(result);
      if (sequential && result.graded) previous = chainPayload(result);
    }
    return out;
  }

  /** Resolve the template and grade, unless nothing resolved. A template whose every variable
   *  is missing has no subject, and a judge asked for a verdict would invent one. A turn with a
   *  request and no answer is a real failure and is still graded. */
  private async gradeResolved(
    template: string,
    context: EvaluationContext,
  ): Promise<EvalResult | null> {
    const resolved = resolveTemplate(template, context);
    if (resolved.variablesMissing.length && !resolved.variablesUsed.length)
      return null;
    // The resolved template is the prompt: it goes in the user message under a fixed preamble,
    // and nothing is added to it.
    return this.callAndBuild(prompts.ADVANCED_SYSTEM, resolved.resolvedText);
  }

  // ── grading ───────────────────────────────────────────────────────────────────

  /** Basic grade: the rubric as the system prompt; the item, the previous result and the
   *  dependency results as the user message. */
  private grade(
    body: string,
    previous: Payload | null = null,
    deps: Record<string, unknown> | null = null,
  ): Promise<EvalResult> {
    const rubric = this.config.prompt || DEFAULT_JUDGE_PROMPT;
    if (previous)
      body +=
        "\n\nPrevious result of this metric (the preceding item in the sequence — use " +
        "it for continuity and comparison):\n" +
        JSON.stringify(previous);
    deps ??= depsOf(this.config);
    if (Object.keys(deps).length)
      body +=
        "\n\nResults from prerequisite evaluations (use these as additional context):\n" +
        Object.entries(deps)
          .map(([name, v]) => `- ${name}: ${JSON.stringify(v)}`)
          .join("\n");
    return this.callAndBuild(rubric, body);
  }

  /** The model call and the result. One context gate sits in front of every call: an item that
   *  does not fit the column's model goes to its `fallback_model`, or becomes a visible skip.
   *  A provider that rejects the call for length takes the same path. */
  private async callAndBuild(
    systemPrompt: string,
    body: string,
  ): Promise<EvalResult> {
    const { config } = this;
    let outputType = String(config.output_type || "score").toLowerCase();
    if (!OUTPUT_TYPES.includes(outputType)) outputType = "score";
    let isDecision = decision.isDecisionOutput(outputType);
    // No model named: a decision column runs on the column default (Jev), an LLM column on the
    // text default.
    const primary =
      config.model || (isDecision ? provider.settings.columnModel : null);
    // A decision column whose model is an LLM: answer the same question through the LLM.
    if (isDecision && !(await provider.isDecisionModel(primary)))
      isDecision = false;
    const attempts = [
      primary,
      ...(config.fallback_model ? [config.fallback_model] : []),
    ];
    let lastOverflow = "";
    for (const [i, model] of attempts.entries()) {
      const info = await provider.modelInfo(model);
      const decisionCall = isDecision && i === 0;
      const questions = decisionCall ? decision.buildQuestions(config) : {};
      const system = decision.isDecisionOutput(outputType)
        ? decision.fallbackSystemPrompt(config)
        : systemPrompt;
      const tokens = decisionCall
        ? estimateTokens(decision.requestText(body, questions))
        : estimateTokens(system, body);
      const reserve = decisionCall ? 0 : provider.settings.maxOutputTokens;
      if (!fits(info, tokens, reserve)) {
        lastOverflow = overflowNote(tokens, info);
        continue;
      }
      let result: EvalResult;
      try {
        result = decisionCall
          ? await this.decisionCall(body, questions, info.id)
          : await this.llmCall(outputType, system, body, info.id);
      } catch (error) {
        if (error instanceof provider.ContextOverflowError) {
          const limit = info.context_tokens ? ` ${k(info.context_tokens)}` : "";
          lastOverflow =
            `${info.id} rejected the input as longer than its${limit} context. ` +
            "Set a fallback model on this column to grade long items.";
          continue;
        }
        return this.failed(
          info.id,
          error as Error,
          decisionCall ? body : provider.promptText(system, body),
        );
      }
      if (i > 0) {
        const note = `[graded by fallback ${info.id}: input exceeded ${attempts[0] || "the default model"}'s context]`;
        result.comment = `${note} ${result.comment}`.trim().slice(0, 500);
      }
      return result;
    }
    return this.skipped(lastOverflow, attempts.length > 1);
  }

  /** A neutral, visible result for a grade the model call failed to produce. */
  private failed(model: string, error: Error, input: string): EvalResult {
    const message = String(error.message ?? error);
    return makeResult(this.level, {
      data_type: "TEXT",
      string_value: "Error",
      comment: `Not graded: ${model} failed — ${message.slice(0, 400)}`,
      graded: false,
      error: true,
      usage: (error as { usage?: Usage }).usage ?? null,
      calls: [
        {
          name: model,
          model,
          input,
          output: JSON.stringify({ error: message.slice(0, 2000) }, null, 2),
        },
      ],
    });
  }

  /** A neutral, visible score for an item no configured model could read in full. */
  private skipped(note: string, hasFallback: boolean): EvalResult {
    if (hasFallback)
      note += " The fallback model's context is too small as well.";
    return makeResult(this.level, {
      data_type: "TEXT",
      string_value: "Skipped — input too long",
      comment: note.slice(0, 500),
      graded: false,
    });
  }

  private decisionResult(
    fields: decision.AnswerFields,
    usage: Usage,
    call: JudgeCall,
  ): EvalResult {
    return makeResult(this.level, {
      ...fields,
      comment: fields.comment.slice(0, 500),
      usage,
      calls: [call],
    });
  }

  private async decisionCall(
    state: string,
    questions: Record<string, decision.Question>,
    model: string,
  ): Promise<EvalResult> {
    const reply = await provider.runDecision(state, questions, model);
    return this.decisionResult(
      decision.answerFields(this.config, reply.answers),
      reply.usage,
      { name: model, model, input: reply.request, output: reply.output },
    );
  }

  private async llmCall(
    outputType: string,
    systemPrompt: string,
    body: string,
    model: string,
  ): Promise<EvalResult> {
    const { config } = this;
    const call = (prompt: string, output: string): JudgeCall => ({
      name: model,
      model,
      input: provider.promptText(systemPrompt, prompt),
      output,
    });
    if (decision.isDecisionOutput(outputType)) {
      // An LLM answering a decision column's question: limited to the same answers, mapped by
      // the same code.
      const reply = await provider.runStructured(body, {
        schema: decision.fallbackSchema(config),
        systemPrompt,
        model,
      });
      return this.decisionResult(
        decision.answerFields(
          config,
          decision.fallbackAnswers(config, reply.value),
        ),
        reply.usage,
        call(body, reply.output),
      );
    }
    if (outputType === "json") {
      const schema = fromJsonSchema(config.output_schema);
      if (schema) {
        const reply = await provider.runStructured(body, {
          schema,
          systemPrompt,
          model,
        });
        return this.jsonResult(
          reply.value,
          reply.usage,
          call(body, reply.output),
        );
      }
      // No usable schema: free-form strict JSON (the rubric defines the shape).
      const prompt =
        body +
        "\n\nRespond with ONE strict JSON object shaped exactly as your instructions describe.";
      const reply = await provider.runText(prompt, { systemPrompt, model });
      return this.jsonResult(
        parseJsonObject(reply.text),
        reply.usage,
        call(prompt, reply.text),
      );
    }
    const schema =
      outputType === "number"
        ? NUMBER
        : outputType === "boolean"
          ? PASS_FAIL
          : outputType === "text"
            ? TEXT
            : SCORE;
    const reply = await provider.runStructured(body, {
      schema,
      systemPrompt,
      model,
    });
    return {
      ...this.toResult(outputType, reply.value),
      usage: reply.usage,
      calls: [call(body, reply.output)],
    };
  }

  private toResult(outputType: string, verdict: Json): EvalResult {
    const { config, level } = this;
    const reason = String(verdict.reason ?? "").slice(0, 500);
    if (outputType === "number") {
      const value = Number(verdict.value);
      const threshold = config.threshold;
      return makeResult(level, {
        verdict:
          typeof threshold === "number"
            ? value >= threshold
              ? "PASS"
              : "FAIL"
            : "",
        data_type: "NUMERIC",
        value,
        comment: reason,
      });
    }
    if (outputType === "boolean") {
      const ok = verdict.passed === true;
      return makeResult(level, {
        verdict: ok ? "PASS" : "FAIL",
        value: ok ? 1 : 0,
        comment: reason,
      });
    }
    if (outputType === "text")
      return makeResult(level, {
        data_type: "TEXT",
        string_value: String(verdict.text ?? "").slice(0, 2000),
        comment: reason,
      });
    const score = Math.min(Math.max(Number(verdict.score), 0), 1);
    const threshold =
      typeof config.threshold === "number" ? config.threshold : 0.6;
    return makeResult(level, {
      verdict: score >= threshold ? "PASS" : "FAIL",
      data_type: "NUMERIC",
      value: score,
      comment: reason,
    });
  }

  /** A custom-schema result: exactly the user's fields. A numeric `score`/`overall_score`
   *  drives the 0..1 value (PASS/FAIL by `threshold`); a `reason`/`reasoning`/`summary` string
   *  is the comment. With neither, the column is informational. */
  private jsonResult(parsed: Json, usage: Usage, call: JudgeCall): EvalResult {
    const candidate = parsed.score ?? parsed.overall_score;
    const value =
      typeof candidate === "number"
        ? Math.min(Math.max(candidate, 0), 1)
        : null;
    const reason = parsed.reason || parsed.reasoning || parsed.summary;
    const threshold = this.config.threshold;
    return makeResult(this.level, {
      verdict:
        value !== null && typeof threshold === "number"
          ? value >= threshold
            ? "PASS"
            : "FAIL"
          : "",
      data_type: "TEXT",
      value,
      string_value: JSON.stringify(parsed).slice(0, 4000),
      comment: String(reason || "").slice(0, 500),
      usage,
      calls: [call],
    });
  }
}
