import { z } from "zod";

export const kinds = [
  "note",
  "journal",
  "finding",
  "experiment",
  "reference",
  "task",
  "paper",
] as const;
export const statuses = [
  "draft",
  "planned",
  "running",
  "completed",
  "inconclusive",
  "blocked",
] as const;
export const metricSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    step: z.number().finite().nonnegative(),
    value: z.number().finite(),
    unit: z.string().max(30).default(""),
    n: z.number().int().positive().optional(),
    lower: z.number().finite().optional(),
    upper: z.number().finite().optional(),
  })
  .refine(
    (m) => m.lower === undefined || m.upper === undefined || m.lower <= m.upper,
    "Lower bound must not exceed upper bound",
  );
/** A chart panel: which metrics to draw together and how to present them. */
export const chartSpecSchema = z.object({
  title: z.string().trim().min(1).max(100),
  metrics: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(12)
    .describe(
      'Metric names to plot together. A trailing "/*" matches a group, e.g. "loss/*" for loss/train and loss/val.',
    ),
  type: z.enum(["line", "bar", "scatter"]).default("line"),
  xLabel: z.string().max(40).default("step"),
  yLabel: z.string().max(40).default(""),
  format: z
    .enum(["auto", "percent", "fixed", "scientific"])
    .default("auto")
    .describe("percent shows 0-1 values as %; fixed uses 3 decimals"),
  logY: z.boolean().default(false),
  smoothing: z
    .number()
    .min(0)
    .max(0.99)
    .default(0)
    .describe("Exponential moving average weight for line charts"),
  goal: z
    .enum(["min", "max", "none"])
    .default("none")
    .describe("Highlights the best value when lower or higher is better"),
  description: z.string().max(400).default(""),
});
export type ChartSpec = z.infer<typeof chartSpecSchema>;

export const fieldTypes = ["text", "number", "select", "boolean"] as const;
export const fieldDefinitionSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and _"),
    label: z.string().trim().min(1).max(60),
    type: z.enum(fieldTypes).default("text"),
    options: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    kinds: z
      .array(z.enum(kinds))
      .default(["experiment"])
      .describe("Entry types that show this field"),
    unit: z.string().max(20).default(""),
    description: z.string().max(200).default(""),
  })
  .refine(
    (f) => f.type !== "select" || f.options.length > 0,
    "Select fields need at least one option",
  );
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
export const fieldDefinitionsSchema = z
  .array(fieldDefinitionSchema)
  .max(40)
  .refine(
    (fields) => new Set(fields.map((f) => f.key)).size === fields.length,
    "Field keys must be unique",
  );
export const fieldValueSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type FieldValue = z.infer<typeof fieldValueSchema>;

export const provenanceSchema = z.object({
  repository: z.string().max(2000).default(""),
  commit: z.string().max(100).default(""),
  seed: z.number().int().nullable().default(null),
  model: z.string().max(300).default(""),
  dataset: z.string().max(2000).default(""),
  config: z.string().max(30000).default(""),
  command: z.string().max(4000).default(""),
  sourcePath: z.string().max(2000).default(""),
  sourceHash: z.string().max(64).default(""),
});
export const recordInputSchema = z.object({
  kind: z.enum(kinds),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(300000).default(""),
  status: z.enum(statuses).default("draft"),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  pinned: z.boolean().default(false),
  sensitive: z.boolean().default(true),
  evidence: z
    .enum(["unverified", "observed", "replicated"])
    .default("unverified"),
  linkedIds: z.array(z.string().uuid()).max(50).default([]),
  provenance: provenanceSchema.default(() => provenanceSchema.parse({})),
  metrics: z
    .array(metricSchema)
    .max(20000)
    .refine(
      (items) =>
        new Set(items.map((m) => `${m.name}:${m.step}`)).size === items.length,
      "Metric names and steps must be unique",
    )
    .default([]),
  costUsd: z.number().finite().nonnegative().nullable().default(null),
  estimateUsd: z.number().finite().nonnegative().nullable().default(null),
  gpuHours: z.number().finite().nonnegative().nullable().default(null),
  decision: z.enum(["pending", "go", "no-go", "revise"]).default("pending"),
  gate: z.string().max(4000).default(""),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  dueDate: z
    .string()
    .refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use YYYY-MM-DD")
    .default(""),
  assignee: z.string().max(100).default("Julien"),
  fields: z
    .record(z.string().max(40), fieldValueSchema)
    .refine((v) => Object.keys(v).length <= 40, "At most 40 custom fields")
    .default({})
    .describe("Custom field values keyed by the workspace's field definitions"),
  charts: z
    .array(chartSpecSchema)
    .max(24)
    .default([])
    .describe(
      "Experiment chart panels; metrics without a panel are grouped automatically",
    ),
});
export type RecordInput = z.infer<typeof recordInputSchema>;
export type ResearchRecord = RecordInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  author: string;
};
export type Artifact = {
  id: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  recordId: string | null;
  recordIds: string[];
  revision: number;
  caption: string;
  createdAt: string;
  sourcePath: string;
};
export type Activity = {
  id: number;
  action: string;
  recordId: string | null;
  title: string;
  actor: string;
  createdAt: string;
};
export type Relation = {
  id: string;
  source: string;
  target: string;
  type: "supports" | "contradicts" | "extends" | "uses" | "relates";
  label: string;
};
export type WorkspaceInfo = {
  id: string;
  name: string;
  description: string;
  researchRoot: string;
  createdAt: string;
};
export type ChartLink = {
  id: string;
  experimentId: string;
  metricName: string;
  recordId: string;
};
export type Workspace = {
  info: WorkspaceInfo;
  fields: FieldDefinition[];
  chartLinks: ChartLink[];
  records: ResearchRecord[];
  artifacts: Artifact[];
  activity: Activity[];
  relations: Relation[];
  settings: {
    pilotBudget: number;
    fellowshipBudget: number;
    phase: "pilot" | "fellowship";
    project: string;
  };
  researchRoot: string;
  dataDir: string;
  storageRoot: string;
  mcpPath: string;
};

/** LLM trace spans, one row per span (the Tracely model). */
export const spanTypes = [
  "GENERATION",
  "AGENT",
  "TOOL",
  "CHAIN",
  "RETRIEVER",
  "EMBEDDING",
  "GUARDRAIL",
  "THINKING",
  "DELEGATE",
  "SKILL",
  "SPAN",
  "EVENT",
  "EVALUATOR",
] as const;
export type SpanType = (typeof spanTypes)[number];
const spanTypeAliases: Record<string, SpanType> = {
  REASONING: "THINKING",
  HANDOFF: "DELEGATE",
  LLM: "GENERATION",
};
const traceIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/, "Use letters, digits and _ . : - only");
const timeSchema = z
  .union([z.iso.datetime({ offset: true }), z.number().finite()])
  .describe("ISO 8601 time or epoch milliseconds");
export const spanInputSchema = z.object({
  spanId: traceIdSchema,
  parentSpanId: traceIdSchema.nullish(),
  name: z.string().trim().min(1).max(300),
  type: z
    .string()
    .transform((t) => t.toUpperCase())
    .transform((t) => spanTypeAliases[t] ?? t)
    .pipe(z.enum(spanTypes))
    .default("SPAN"),
  start: timeSchema,
  end: timeSchema.nullish(),
  status: z.enum(["ok", "error"]).default("ok"),
  statusMessage: z.string().max(2000).default(""),
  model: z.string().trim().max(200).default(""),
  usage: z
    .object({
      input: z.number().int().nonnegative().optional(),
      output: z.number().int().nonnegative().optional(),
    })
    .default({}),
  costUsd: z
    .number()
    .finite()
    .nonnegative()
    .optional()
    .describe("Reported cost only. Leave it out when unknown."),
  input: z
    .unknown()
    .optional()
    .describe("Text, or JSON such as a chat message list"),
  output: z.unknown().optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});
export const traceInputSchema = z.object({
  traceId: traceIdSchema.optional(),
  sessionId: z.string().trim().max(200).optional(),
  experimentId: z.string().trim().max(100).optional(),
  spans: z.array(spanInputSchema).min(1).max(2000),
});
export type TraceInput = z.input<typeof traceInputSchema>;
export const traceQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  status: z.enum(["all", "failing"]).default("all"),
  from: z.coerce.number().finite().optional(),
  to: z.coerce.number().finite().optional(),
  model: z.string().trim().max(200).default(""),
  experimentId: z.string().trim().max(100).default(""),
  sessionId: z.string().trim().max(200).default(""),
  multi: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((v) => v === "true"),
    ])
    .default(false),
  sort: z
    .enum(["recent", "started", "duration", "tokens", "cost"])
    .default("recent"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TraceQuery = z.input<typeof traceQuerySchema>;
export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sessionId: string | null;
  experimentId: string | null;
  name: string;
  type: string;
  level: "DEFAULT" | "ERROR";
  statusMessage: string;
  startTime: string;
  endTime: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  input: string | null;
  output: string | null;
  metadata: Record<string, string>;
  source: string;
};
export type TraceSummary = {
  traceId: string;
  name: string;
  sessionId: string | null;
  experimentId: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  spans: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  failing: boolean;
  models: string[];
  input: string | null;
  output: string | null;
};
export type SessionSummary = {
  sessionId: string;
  /** The root span name of the first turn: the agent that answered. */
  agent: string;
  turns: number;
  startTime: string;
  endTime: string;
  durationMs: number;
  spans: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  failing: boolean;
  models: string[];
  experimentId: string | null;
  input: string | null;
  output: string | null;
};
export type Page<T> = { items: T[]; total: number };

// Runs: live training telemetry (W&B-style). A client sends events; each event names a run.
export const runIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "Run ids use letters, digits, '.', '_' and '-' (max 128)",
  );
export const runMetricNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[^\u0000-\u001f]+$/,
    "Metric names cannot contain control characters",
  );
const runTimeSchema = z
  .union([z.number().finite().nonnegative(), z.iso.datetime({ offset: true })])
  .optional()
  .describe("Epoch milliseconds or ISO time; the server time when omitted");
const jsonObjectSchema = z
  .record(z.string().max(200), z.unknown())
  .refine(
    (v) => JSON.stringify(v).length <= 256 * 1024,
    "At most 256 KB of JSON",
  );
const runEventBase = { run: runIdSchema, time: runTimeSchema };
export const runStatuses = ["running", "finished", "failed", "killed"] as const;
export const runEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    ...runEventBase,
    name: z.string().trim().min(1).max(200).optional(),
    group: z.string().trim().max(200).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    notes: z.string().max(4000).optional(),
    experimentId: z.string().trim().max(100).optional(),
    config: jsonObjectSchema.optional().describe("Hyperparameters; merged"),
    meta: jsonObjectSchema
      .optional()
      .describe("Host, git commit, command, GPUs, Slurm job; merged"),
  }),
  z.object({
    type: z.literal("log"),
    ...runEventBase,
    step: z.number().finite().nonnegative(),
    values: z
      .record(runMetricNameSchema, z.number().finite().nullable())
      .refine((v) => Object.keys(v).length >= 1, "Log at least one value")
      .refine((v) => Object.keys(v).length <= 2000, "At most 2000 values")
      .describe("null records NaN or Inf: the run diverged at this step"),
  }),
  z.object({
    type: z.literal("config"),
    ...runEventBase,
    values: jsonObjectSchema,
  }),
  z.object({
    type: z.literal("summary"),
    ...runEventBase,
    values: jsonObjectSchema.describe("Final or best values; merged"),
  }),
  z.object({ type: z.literal("heartbeat"), ...runEventBase }),
  z.object({
    type: z.literal("finish"),
    ...runEventBase,
    status: z.enum(["finished", "failed", "killed"]).default("finished"),
    exitCode: z.number().int().optional(),
  }),
]);
export type RunEvent = z.input<typeof runEventSchema>;
export const runEventsSchema = z.array(runEventSchema).min(1).max(20000);
export const runPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  group: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  notes: z.string().max(4000).optional(),
  experimentId: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Experiment record id; "" unlinks'),
});
export const runQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  status: z.enum(["all", ...runStatuses, "stalled"]).default("all"),
  group: z.string().trim().max(200).default(""),
  experimentId: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
/** running with no event for this long is shown as stalled (crashed, preempted or lost). */
export const runStallMs = 5 * 60 * 1000;
export type RunStatus = (typeof runStatuses)[number] | "stalled";
export type MetricStats = {
  name: string;
  count: number;
  lastStep: number;
  last: number | null;
  min: number | null;
  max: number | null;
  /** Points logged as NaN or Inf, and the first step where that happened. */
  nonFinite: number;
  firstNonFiniteStep: number | null;
};
export type RunSummary = {
  id: string;
  name: string;
  group: string;
  tags: string[];
  notes: string;
  experimentId: string | null;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
  runtimeMs: number;
  lastStep: number | null;
  /** Explicit summary values over the last value of every metric. */
  summary: Record<string, unknown>;
};
export type RunDetail = RunSummary & {
  config: Record<string, unknown>;
  meta: Record<string, unknown>;
  metrics: MetricStats[];
};
/** A downsampled point: the bucket mean, with the bucket's min and max when sampled. */
export type RunPoint = {
  step: number;
  time: number;
  value: number | null;
  min?: number;
  max?: number;
};
export type RunSeries = {
  run: string;
  name: string;
  total: number;
  sampled: boolean;
  points: RunPoint[];
};
