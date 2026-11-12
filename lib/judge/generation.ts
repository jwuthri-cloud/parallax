// "Use AI" in the Add Column editor: an evaluator config from a description in plain words.
// Port of Tracely `domain/evaluation/generation.py`. One structured model call. The output is a
// DRAFT: the editor shows it for review, and nothing is stored here.
//
// Decision model first: most metrics are classifications, and those are drafted for the column
// default decision model (TypeSafe Jev). Only a metric that needs written text or an unbounded
// number gets an LLM rubric column. With no reachable decision model every draft is an LLM
// column. The variable list in the system prompt is rendered from `TEMPLATE_VARIABLES`.
import * as dec from "./decision";
import * as provider from "./provider";
import { catalogLevel, TEMPLATE_VARIABLES } from "./template";
import type { Json } from "./structured";
import type { EvaluatorConfig } from "./types";

const LEVELS = ["CONVERSATION", "AGENT_RUN", "SPAN"];
const OUTPUT_TYPES = ["score", "number", "boolean", "text", "json"];

const DECISION_SECTION = `## Engine: DECISION (the default) vs LLM

Set engine="decision" unless the metric truly needs generated prose or an unbounded number. A
decision model is a calibrated classifier: it reads the item as its state and answers ONE typed
question. Pick the task:
- "binary": a yes/no question. Give yes_means and no_means, and pass_when: "yes" when yes is the
  good outcome, "no" when yes is the failure (e.g. "Did the agent hallucinate?" -> pass_when "no").
  Ask the question the natural way round; never invert the criteria to make yes the good answer.
- "multiclass": exactly one of 2-30 labels (quality categories, intent, failure type).
- "multilabel": any subset of 2-20 labels (which problems occurred, which topics apply).
Labels: snake_case, at most 24 characters, each with a one-line description; put the labels that
mean the item FAILED in fail_labels (leave it empty for a purely informational label column).

Write the question the way the model reads it — literally:
- One atomic judgment. Split "correct AND polite" into two metrics.
- Name the part of the item you mean in backticks, matching the headings it sees
  (\`User request\`, \`Agent answer\`, \`Tool results\`, \`Step input\`, \`Step output\`).
- State the exact condition and put boundary cases in the label descriptions.
- No numbers or counting — the model reasons about meaning, not arithmetic.

For a decision metric, \`prompt\` is NOT a rubric: leave it empty to send the level's default item,
or write a STATE TEMPLATE — only labelled headings and @VARIABLES, no instructions — when the
question needs other context (see the rules below; they apply to state templates too).

Use engine="llm" (then output_type is score/number/boolean/text/json and \`prompt\` is a rubric)
only for: a free-text observation, a numeric measurement outside 0..1, or a multi-field analysis
whose fields are numbers rather than labels.

`;

const LLM_ONLY_SECTION = `## Engine
Set engine="llm" — no decision model is available in this workspace.

`;

const SYSTEM = `You design evaluation metrics for an AI-agent observability platform.
A metric grades agent traces at exactly one level:
- "CONVERSATION": one grade for a whole multi-turn conversation (goal achievement, frustration, drift).
- "AGENT_RUN": one grade per agent run / assistant turn (answer quality, tone, hallucination).
- "SPAN": one grade per step inside a run — a tool call or model generation (tool choice, argument quality).

{engine}An LLM metric produces exactly one output type:
- "score": a 0..1 quality score with a pass threshold (most metrics).
- "boolean": a pass/fail judgment.
- "number": a raw numeric measurement (counts, magnitudes — when 0..1 doesn't fit).
- "text": a short free-text observation (no pass/fail).
- "json": a structured object — USE THIS for classifications and multi-dimensional analyses.
  Define 1-6 schema_fields that capture the signal: classifications get an "enum" field with the
  allowed labels; multi-dimensional grades get a few named number sub-scores. If the column
  should drive PASS/FAIL, include a numeric "score" field (0-1) and a "reason" string;
  otherwise leave them out for an informational column. Field names must be snake_case
  identifiers.

Write the grading rubric like a strict senior reviewer would: second person, specific, naming
the failure modes to look for, and concrete about what earns a high vs low grade. Do NOT
mention JSON or output formatting in the rubric — the platform handles that.

## Choose the context: ADVANCED (default) vs BASIC

Each level auto-feeds a judge ONE fixed item, and nothing else:
- CONVERSATION -> the turn-by-turn transcript
- AGENT_RUN    -> the user request and the agent's final answer. NOT the tool calls, NOT the
                  retrieved documents, NOT the reasoning.
- SPAN         -> one step's input and output

Write an ADVANCED prompt — a rubric with \`@VARIABLE\` placeholders resolved against the real
trace — whenever the metric needs anything other than that exact item. This is the normal case:
faithfulness/hallucination needs \`@CURRENT_STEPS.tool\` (the evidence) next to the answer;
anything about earlier turns needs \`@HISTORY\` or \`@PREVIOUS_ASSISTANT_MSG\`; anything about the
user's goal needs \`@GOAL\`. Use BASIC (a rubric with NO variables) only when the level's default
item is already exactly what you would have asked for.

Rules for an advanced prompt, in order of what breaks when you get them wrong:
1. NOTHING is auto-injected. The template is the entire message the judge sees — if you don't
   reference the user's request, the judge never sees it. Include every variable it needs.
2. Use only variables listed for the level you chose; a variable from another level resolves to
   \`[No X available]\` and the judge grades on a blank.
3. Prefer the narrowest one that answers the question: \`@CURRENT_STEPS.tool\` over
   \`@CURRENT_STEPS\`, \`@PREVIOUS_ASSISTANT_MSG\` over \`@HISTORY\`. Wide variables are slower,
   dearer, and bury the signal.
4. Structure it: the instruction first, then each variable under its own labelled heading
   (\`## Tool results\` then \`@CURRENT_STEPS.tool\`), so the judge can tell the rubric from the data.
5. State what a missing value means. A variable can resolve to \`[No CURRENT_STEPS.tool
   available]\`; say whether that is a pass, a fail, or irrelevant.

## The variables, by level
{variables}

## Execution mode
"batch" (default) grades each item independently. Choose "sequential" ONLY when the grade
genuinely depends on the ones before it (drift, escalation, repetition, a running label): items
are then graded in order, and at AGENT_RUN level in advanced mode the previous item's result
reaches the judge ONLY through \`@METRIC_PREVIOUS_RESULT\` — reference it in the template or the
chain carries nothing.`;

/** The `@VARIABLE` catalog per level, rendered from `TEMPLATE_VARIABLES`. */
function variableCatalog(): string {
  return LEVELS.map((level) => {
    const cl = catalogLevel(level);
    const lines = TEMPLATE_VARIABLES.filter((v) => v.levels.includes(cl)).map(
      (v) => {
        const refs = [
          `@${v.name}`,
          ...(v.props ?? []).map(([p]) => `@${v.name}.${p}`),
        ];
        return `  ${refs.join(" ")} — ${v.description}`;
      },
    );
    return `${level}:\n${lines.join("\n")}`;
  }).join("\n");
}

const nullable = (type: string, description: string) => ({
  type: [type, "null"],
  description,
});
const DRAFT_PROPERTIES: Json = {
  name: { type: "string", description: "short metric name, 2-5 words" },
  description: {
    type: "string",
    description: "one sentence: what this metric checks",
  },
  level: { type: "string", enum: LEVELS },
  engine: {
    type: "string",
    enum: ["decision", "llm"],
    description: '"decision" (a classifier question) or "llm" (a rubric)',
  },
  task: {
    type: ["string", "null"],
    enum: ["binary", "multiclass", "multilabel", null],
    description: "decision only",
  },
  question: nullable("string", "decision only: the one literal question"),
  yes_means: nullable("string", "binary only: what a yes means"),
  no_means: nullable("string", "binary only: what a no means"),
  pass_when: {
    type: ["string", "null"],
    enum: ["yes", "no", null],
    description: "binary only",
  },
  labels: {
    type: ["array", "null"],
    description: "multiclass/multilabel only",
    items: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "snake_case label, at most 24 characters",
        },
        description: {
          type: "string",
          description: "one line: when this label applies",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    },
  },
  fail_labels: {
    type: ["array", "null"],
    items: { type: "string" },
    description: "labels that mean the item failed",
  },
  output_type: { type: "string", enum: OUTPUT_TYPES, description: "llm only" },
  prompt: {
    type: "string",
    description:
      "llm: the grading rubric. decision: empty, or a state template of headings + @VARIABLES",
  },
  threshold: nullable("number", '0..1 pass threshold, only for "score"'),
  schema_fields: {
    type: ["array", "null"],
    description: 'the output object fields, only for "json"',
    items: {
      type: "object",
      properties: {
        name: { type: "string", description: "snake_case field name" },
        type: {
          type: "string",
          enum: ["string", "number", "boolean", "enum", "array"],
        },
        description: {
          type: "string",
          description: "what this field captures",
        },
        required: { type: "boolean" },
        enum_values: {
          type: ["array", "null"],
          items: { type: "string" },
          description: 'allowed labels, only for "enum"',
        },
      },
      required: ["name", "type", "description", "required", "enum_values"],
      additionalProperties: false,
    },
  },
  execution_mode: {
    type: "string",
    enum: ["batch", "sequential"],
    description:
      '"sequential" only when the grade depends on the earlier items',
  },
};
const DRAFT_CONTRACT: provider.Contract = {
  name: "GeneratedEvaluatorDraft",
  strict: true,
  jsonSchema: {
    type: "object",
    properties: DRAFT_PROPERTIES,
    required: Object.keys(DRAFT_PROPERTIES),
    additionalProperties: false,
  },
  check(reply) {
    if (typeof reply.name !== "string" || typeof reply.level !== "string")
      throw new Error("the draft needs a name and a level");
    return reply;
  },
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const items = (v: unknown): Json[] =>
  Array.isArray(v)
    ? v.filter((x): x is Json => typeof x === "object" && x !== null)
    : [];
const labelName = (name: unknown) =>
  str(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);

/** schema_fields → the stored JSON Schema (the shape the editor's schema builder writes). */
function schemaFromFields(fields: Json[]): Json | null {
  const properties: Json = {};
  const required: string[] = [];
  for (const f of fields) {
    const name = str(f.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const type = str(f.type).toLowerCase();
    const prop: Json = {
      type: ["number", "boolean", "array"].includes(type) ? type : "string",
    };
    if (type === "enum") {
      const values = (Array.isArray(f.enum_values) ? f.enum_values : [])
        .map(str)
        .filter(Boolean);
      if (values.length) prop.enum = values;
    }
    if (str(f.description)) prop.description = str(f.description);
    properties[name] = prop;
    if (f.required !== false) required.push(name);
  }
  return Object.keys(properties).length
    ? { type: "object", properties, required }
    : null;
}

/** A decision draft → a decision column config, or null when the draft cannot be one (the
 *  caller then uses the LLM path). */
function decisionConfig(draft: Json, model: string): EvaluatorConfig | null {
  const task = str(draft.task).toLowerCase();
  const question = str(draft.question);
  if (!["binary", "multiclass", "multilabel"].includes(task) || !question)
    return null;
  const config: EvaluatorConfig = { model, question: question.slice(0, 1000) };
  if (str(draft.prompt)) config.prompt = str(draft.prompt); // a state template
  if (task === "binary") {
    if (!str(draft.yes_means) || !str(draft.no_means)) return null;
    Object.assign(config, {
      output_type: dec.BINARY,
      threshold: dec.DEFAULT_THRESHOLD,
      pass_when: str(draft.pass_when).toLowerCase() === "no" ? "no" : "yes",
      criteria: { true: str(draft.yes_means), false: str(draft.no_means) },
    });
  } else {
    const criteria: Record<string, string | null> = {};
    for (const label of items(draft.labels)) {
      const name = labelName(label.name);
      if (name && !(name in criteria))
        criteria[name] = str(label.description) || null;
    }
    let fail = [
      ...new Set(
        (Array.isArray(draft.fail_labels) ? draft.fail_labels : []).map(
          labelName,
        ),
      ),
    ].filter((n) => n in criteria);
    // every label failing = a column that cannot pass
    if (task === "multiclass" && fail.length === Object.keys(criteria).length)
      fail = fail.slice(0, -1);
    Object.assign(config, {
      output_type: task === "multiclass" ? dec.MULTICLASS : dec.MULTILABEL,
      criteria,
      fail_options: fail,
    });
    if (task === "multilabel") config.threshold = dec.DEFAULT_THRESHOLD;
  }
  return dec.validateDecision(config) === null ? config : null;
}

function llmConfig(draft: Json): EvaluatorConfig {
  let outputType = str(draft.output_type).toLowerCase();
  if (!OUTPUT_TYPES.includes(outputType)) outputType = "score";
  const config: EvaluatorConfig = {
    // pinned: "Default" in the form means the decision model
    model: provider.defaultModelId(),
    prompt: str(draft.prompt) || str(draft.question),
    output_type: outputType,
  };
  if (str(draft.execution_mode).toLowerCase() === "sequential")
    config.execution_mode = "sequential";
  if (outputType === "json") {
    const schema = schemaFromFields(items(draft.schema_fields));
    if (schema) config.output_schema = schema;
    // no usable fields: an empty object is not a metric, so use a plain 0-1 score
    else config.output_type = outputType = "score";
  }
  if (outputType === "score") {
    const threshold =
      typeof draft.threshold === "number" ? draft.threshold : 0.6;
    config.threshold = Math.min(Math.max(threshold, 0), 1);
  }
  return config;
}

/** A draft `{name, description, kind, level, config}`: a decision column when the metric is a
 *  classification and a decision model is reachable, else an LLM rubric column on the text
 *  default. Throws on transport errors. */
export async function generateEvaluatorConfig(description: string) {
  const columnModel = provider.defaultColumnModelId();
  const decisionOk = await provider.isDecisionModel(columnModel);
  const system = SYSTEM.replace(
    "{engine}",
    decisionOk ? DECISION_SECTION : LLM_ONLY_SECTION,
  );
  const { value: draft } = await provider.runStructured(
    `Design an evaluation metric for: ${description.trim().slice(0, 2000)}`,
    {
      schema: DRAFT_CONTRACT,
      systemPrompt: system.replace("{variables}", variableCatalog()),
    },
  );
  const level = str(draft.level).toUpperCase();
  const base = {
    name: str(draft.name).slice(0, 120) || "Custom metric",
    description: str(draft.description).slice(0, 400),
    kind: "llm_judge" as const,
    level: LEVELS.includes(level) ? level : "AGENT_RUN",
  };
  if (decisionOk && str(draft.engine).toLowerCase() === "decision") {
    const config = decisionConfig(draft, columnModel);
    if (config) {
      if (str(draft.execution_mode).toLowerCase() === "sequential")
        config.execution_mode = "sequential";
      return { ...base, config };
    }
  }
  return { ...base, config: llmConfig(draft) };
}
