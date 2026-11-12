// Shared shapes of the judge. An evaluator is one column on the traces table; a score is one
// cell. The JSON shapes are Tracely's, so its UI components read them unchanged.
import type { RunIfCondition } from "./conditions";

export const LEVELS = [
  "CONVERSATION",
  "AGENT_RUN",
  "SPAN",
  "TOOL",
  "GENERATION",
  "CHAIN",
] as const;
export type Level = (typeof LEVELS)[number];
export const CONVERSATION: Level = "CONVERSATION";
export const RUN: Level = "AGENT_RUN";
/** Levels that address one span (the score carries the span id). */
export const STEP_LEVELS: readonly string[] = [
  "SPAN",
  "TOOL",
  "GENERATION",
  "CHAIN",
];

/** What the user saved, plus keys the runner adds for one run (never stored). */
export type EvaluatorConfig = {
  prompt?: string;
  threshold?: number;
  output_type?: string;
  output_schema?: Record<string, unknown>;
  execution_mode?: "batch" | "sequential";
  is_advanced?: boolean;
  template_variables?: string[];
  depends_on?: string[];
  run_if?: RunIfCondition[];
  model?: string;
  fallback_model?: string;
  question?: string;
  criteria?: Record<string, string | null>;
  fail_options?: string[];
  pass_when?: "yes" | "no";
  span_types?: string[];
  max_spans?: number;
  include_answer?: boolean;
  advisory?: boolean;
  [key: string]: unknown;
};

export type Evaluator = {
  id: string;
  name: string;
  description: string;
  kind: "llm_judge";
  score_name: string;
  level: Level;
  enabled: boolean;
  config: EvaluatorConfig;
  created_at: string;
};

export type EvaluatorTemplate = {
  name: string;
  description: string;
  kind: string;
  score_name: string;
  level: string;
  config: EvaluatorConfig;
  recommended?: boolean;
  category?: string;
};

/** Token use of one judge call, as the provider reported it. */
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model: string;
  /** Only when the provider reported a cost. */
  cost_usd?: number;
};

/** One model call behind a score: what the judge read and what came back. */
export type JudgeCall = {
  name: string;
  model: string;
  input: string;
  output: string;
};

/** The raw output of one grade. */
export type EvalResult = {
  name: string;
  level: string;
  verdict: "PASS" | "FAIL" | "";
  data_type: "BOOLEAN" | "NUMERIC" | "TEXT" | "CATEGORICAL";
  value: number | null;
  string_value: string;
  target_span_id: string;
  comment: string;
  usage: Usage | null;
  calls: JudgeCall[];
  /** False for "Not run" and "Skipped": the cell says why, but it is not evidence. */
  graded: boolean;
  /** True when the grade was attempted and failed (provider error, bad reply). */
  error: boolean;
};

/** A stored score, in the shape Tracely's table reads. */
export type EvalScore = {
  name: string;
  evaluation_level: string;
  observation_id: string | null;
  value: number | null;
  string_value: string;
  verdict: string;
  comment: string;
  data_type: string;
  trace_id: string | null;
  session_id: string | null;
  graded: boolean;
  error: boolean;
};
