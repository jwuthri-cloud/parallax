// Decision-model columns: the questions a classifier answers, and its answers as a score.
// Port of Tracely `domain/evaluation/decision.py`. Pure.
//
// A decision model (TypeSafe Jev on OpenRouter's Decisions API) reads a `state` (the graded
// item) and answers typed questions with calibrated probabilities. It writes no text. A decision
// column stores a question, and the output type is the classification task:
//
//   decision_binary     yes/no. criteria = {true, false}. One `noul`. value = P(yes).
//                       PASS when (P ≥ threshold) matches `pass_when` ("yes" by default).
//   decision_multiclass one of 2–255 labels. criteria = {label: description | null}. One
//                       `choice`. string_value = the label, value = confidence. FAIL when the
//                       label is in `fail_options`; no verdict when none are marked.
//   decision_multilabel any subset of 2–50 labels. One `noul` per label, all in one request.
//                       A label fires at P ≥ threshold. FAIL when a fired label is in
//                       `fail_options`.
//
// The column's `fallback_model` (an LLM) answers the same questions when the item is too long
// for the decision model. `fallbackSchema` limits it to the same answers and `fallbackAnswers`
// reshapes its reply, so `answerFields` is the one mapping to a score.
import type { Json, OutputSchema, Property } from "./structured";

export const BINARY = "decision_binary";
export const MULTICLASS = "decision_multiclass";
export const MULTILABEL = "decision_multilabel";
export const DECISION_OUTPUT_TYPES = [BINARY, MULTICLASS, MULTILABEL];
const MAX_MULTICLASS_LABELS = 255; // Jev's per-choice limit
const MAX_MULTILABEL_LABELS = 50; // one question each
export const DEFAULT_THRESHOLD = 0.5;

export type Config = Record<string, unknown>;
export type Question = {
  type: "noul" | "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};
export type Answers = Record<string, Json>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const isDecisionOutput = (outputType: unknown) =>
  DECISION_OUTPUT_TYPES.includes(String(outputType ?? "").toLowerCase());
const outputTypeOf = (config: Config) =>
  String(config.output_type ?? "").toLowerCase();
const criteriaOf = (config: Config): Json =>
  isObject(config.criteria) ? config.criteria : {};
const labelsOf = (config: Config) => Object.keys(criteriaOf(config));
const text = (v: unknown) => String(v ?? "").trim();
const thresholdOf = (config: Config) =>
  typeof config.threshold === "number" ? config.threshold : DEFAULT_THRESHOLD;
const unit = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
};

/** The first problem with a decision column's config, or null. */
export function validateDecision(config: Config): string | null {
  const ot = outputTypeOf(config);
  if (!DECISION_OUTPUT_TYPES.includes(ot))
    return `output_type must be one of ${DECISION_OUTPUT_TYPES.join(", ")} for a decision model`;
  if (!text(config.question))
    return "question is required: the yes/no or classification question the model answers";
  const t = config.threshold ?? DEFAULT_THRESHOLD;
  if (ot !== MULTICLASS && !(typeof t === "number" && t > 0 && t < 1))
    return `threshold must be a probability strictly between 0 and 1 for ${ot}`;
  const crit = config.criteria;
  if (ot === BINARY) {
    if (!isObject(crit) || !text(crit.true) || !text(crit.false))
      return 'criteria must be {"true": "<what yes means>", "false": "<what no means>"} for decision_binary';
    if (!["yes", "no"].includes(String(config.pass_when ?? "yes")))
      return 'pass_when must be "yes" or "no"';
    return null;
  }
  if (!isObject(crit))
    return 'criteria must map each label to a description (or null), e.g. {"billing": "Payments, refunds"}';
  const labels = labelsOf(config).map((l) => l.trim());
  const cap = ot === MULTICLASS ? MAX_MULTICLASS_LABELS : MAX_MULTILABEL_LABELS;
  if (labels.length < 2 || labels.length > cap)
    return `${ot} needs between 2 and ${cap} labels (got ${labels.length})`;
  if (labels.some((l) => !l) || new Set(labels).size !== labels.length)
    return "label names must be non-empty and unique";
  const fail = config.fail_options ?? [];
  if (!Array.isArray(fail) || fail.some((f) => !labels.includes(String(f))))
    return `fail_options must be a subset of the labels: ${labels.join(", ")}`;
  if (ot === MULTICLASS && new Set(fail.map(String)).size === labels.length)
    return "fail_options cannot contain every label — every answer would FAIL";
  return null;
}

/** The Decisions API `questions` map: one question, or one per label for multi-label. */
export function buildQuestions(config: Config): Record<string, Question> {
  const ot = outputTypeOf(config);
  const question = text(config.question);
  const crit = criteriaOf(config);
  if (ot === BINARY)
    return {
      q: {
        type: "noul",
        instructions: question,
        criteria: { true: String(crit.true), false: String(crit.false) },
      },
    };
  if (ot === MULTICLASS)
    return {
      q: {
        type: "choice",
        instructions: question,
        criteria: Object.fromEntries(
          Object.entries(crit).map(([k, v]) => [
            k,
            v === null || v === "" ? null : String(v),
          ]),
        ),
      },
    };
  const out: Record<string, Question> = {};
  Object.entries(crit).forEach(([label, desc], i) => {
    const meaning =
      typeof desc === "string" && desc.trim() ? desc : `\`${label}\` applies`;
    out[`l${i}`] = {
      type: "noul",
      instructions: `${question}\nDoes the label \`${label}\` apply?`,
      criteria: { true: meaning, false: `\`${label}\` does not apply` },
    };
  });
  return out;
}

/** What the decision model reads against its budget: the state plus the longest question. */
export function requestText(
  state: string,
  questions: Record<string, Question>,
): string {
  const longest = Object.values(questions)
    .map((q) => JSON.stringify(q))
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  return state + longest;
}

export type AnswerFields = {
  verdict: "PASS" | "FAIL" | "";
  data_type: "NUMERIC" | "CATEGORICAL";
  value: number | null;
  string_value: string;
  comment: string;
};

/** Decisions API answers (keyed like `buildQuestions`) → the score fields. Shared by the
 *  decision call and the LLM fallback. Comments lead with the decision, in a stable order. */
export function answerFields(config: Config, answers: Answers): AnswerFields {
  const ot = outputTypeOf(config);
  const fail = new Set(
    (Array.isArray(config.fail_options) ? config.fail_options : []).map(String),
  );
  const thr = thresholdOf(config);
  if (ot === BINARY) {
    const p = unit(answers.q?.noul);
    const wantYes = String(config.pass_when ?? "yes") === "yes";
    return {
      verdict: p >= thr === wantYes ? "PASS" : "FAIL",
      data_type: "NUMERIC",
      value: p,
      string_value: "",
      comment: `P(yes)=${p.toFixed(2)} · pass when ${wantYes ? "yes" : "no"} (threshold ${thr})`,
    };
  }
  if (ot === MULTICLASS) {
    const a = answers.q ?? {};
    const label = String(a.choice ?? "");
    const conf = typeof a.confidence === "number" ? a.confidence : null;
    return {
      verdict: fail.size ? (fail.has(label) ? "FAIL" : "PASS") : "",
      data_type: "CATEGORICAL",
      value: conf === null ? null : unit(conf),
      string_value: label,
      comment:
        label + (conf === null ? "" : ` (confidence ${conf.toFixed(2)})`),
    };
  }
  const fired = labelsOf(config)
    .map((label, i) => [label, unit(answers[`l${i}`]?.noul)] as const)
    .filter(([, p]) => p >= thr); // label order, not probability order
  return {
    verdict: fail.size
      ? fired.some(([label]) => fail.has(label))
        ? "FAIL"
        : "PASS"
      : "",
    data_type: "CATEGORICAL",
    value: fired.length,
    string_value: fired.map(([label]) => label).join(", ") || "none",
    comment:
      (fired.length
        ? "applies: " +
          fired.map(([label, p]) => `${label} ${p.toFixed(2)}`).join(", ")
        : "no label applies") + ` (threshold ${thr})`,
  };
}

// ── LLM fallback: the same questions, the same answers ──────────────────────────

/** The system prompt an LLM fallback grades under: the column's question and criteria as a
 *  closed-answer classification. */
export function fallbackSystemPrompt(config: Config): string {
  const ot = outputTypeOf(config);
  const crit = criteriaOf(config);
  const lines = [
    "You answer one classification question about the STATE in the user message.",
    "Read the question literally and answer only from the state.",
    "",
    `Question: ${text(config.question)}`,
  ];
  if (ot === BINARY)
    return [
      ...lines,
      `- yes means: ${crit.true}`,
      `- no means: ${crit.false}`,
      "Return probability_yes: your calibrated probability (0..1) that the answer is yes.",
    ].join("\n");
  lines.push("Labels:");
  for (const [k, v] of Object.entries(crit))
    lines.push(
      `- ${k}` +
        (v === null || v === ""
          ? ""
          : `: ${typeof v === "string" ? v : JSON.stringify(v)}`),
    );
  lines.push(
    ot === MULTICLASS
      ? "Return the single best label and your confidence (0..1)."
      : "Judge each label on its own (any number may apply, including none) and return, for " +
          "every label, your calibrated probability (0..1) that it applies.",
  );
  return lines.join("\n");
}

export function fallbackSchema(config: Config): OutputSchema {
  const ot = outputTypeOf(config);
  if (ot === BINARY)
    return {
      name: "BinaryAnswer",
      properties: {
        probability_yes: {
          type: "number",
          description: "probability the answer is yes",
        },
      },
    };
  if (ot === MULTICLASS)
    return {
      name: "MulticlassAnswer",
      properties: {
        label: {
          type: "string",
          enum: labelsOf(config),
          description: "the single best label",
        },
        confidence: { type: "number" },
      },
    };
  // One probability per label, the same answer Jev gives. Field names are positional (label
  // names need not be identifiers); the description carries the label.
  const crit = criteriaOf(config);
  const properties: Record<string, Property> = {};
  labelsOf(config).forEach((label, i) => {
    const desc = crit[label];
    const extra = typeof desc === "string" && desc.trim() ? ` (${desc})` : "";
    properties[`l${i}`] = {
      type: "number",
      description: `probability that label \`${label}\` applies${extra}`,
    };
  });
  return { name: "MultilabelAnswer", properties };
}

/** An LLM fallback's structured reply, reshaped as the Decisions API answers. */
export function fallbackAnswers(config: Config, reply: Json): Answers {
  const ot = outputTypeOf(config);
  if (ot === BINARY)
    return { q: { type: "noul", noul: reply.probability_yes } };
  if (ot === MULTICLASS)
    return {
      q: {
        type: "choice",
        choice: reply.label,
        confidence: reply.confidence,
        probabilities: { [String(reply.label)]: reply.confidence },
      },
    };
  return Object.fromEntries(
    labelsOf(config).map((_, i) => [
      `l${i}`,
      { type: "noul", noul: reply[`l${i}`] },
    ]),
  );
}
