// `@VARIABLE` templates for advanced judge columns. Port of Tracely
// `domain/evaluation/template_resolver.py`.
//
// A basic column gets its item from the level (request and answer, transcript, one step). An
// advanced column writes the rubric with `@VARIABLE` placeholders, and they are replaced with
// the real trace data at run time.
//
// - `TEMPLATE_VARIABLES`: the catalog. `components/traces/tracely/lib/templateVariables.ts`
//   holds the same list for the editor.
// - `buildContext`: pure; builds only the variables the template names.
// - `resolveTemplate`: a value that is not present becomes `[No <REF> available]`.
//
// Parallax changes: no `@ROLLING_SUMMARY` (rolling summaries are not ported); a span belongs to
// its nearest AGENT ancestor (Parallax spans have no agent id); the tool calls a model step
// requested are read from its output messages.
import {
  agentAnswer,
  chatMessages,
  contentText,
  readableIo,
  rootSpan,
  userMessage,
  type JudgeSpan,
} from "./text";
import type { Payload } from "./conditions";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Group 1 = UPPERCASE name, group 2 = optional lowercase `.property`. */
const VARIABLE_RE = /@([A-Z_]+)(?:\.([a-z_]+))?/g;

type CatalogLevel = "conversation" | "message" | "step";
export type TemplateVariable = {
  name: string;
  description: string;
  type: "string" | "object";
  levels: CatalogLevel[];
  props?: [string, string][];
  sequentialOnly?: boolean;
};
const ALL: CatalogLevel[] = ["conversation", "message", "step"];
const STEP_TYPE_PROPS: [string, string][] = [
  ["tool", "Only the TOOL steps — each call with its arguments and result"],
  ["retriever", "Only the RETRIEVER steps — the retrieved context"],
  ["generation", "Only the GENERATION steps — the model calls"],
  ["thinking", "Only the THINKING steps — the agent's reasoning"],
  ["chain", "Only the CHAIN steps"],
  ["skill", "Only the SKILL steps — the named capabilities the agent ran"],
  ["delegate", "Only the DELEGATE steps — handovers to another agent"],
];
const STEP_PROPS: [string, string][] = [
  ["tool_call", "The tool invocation (name + arguments) at this step"],
  ["tool_result", "The tool's returned result"],
  ["thinking", "The step's reasoning/thinking text (THINKING steps)"],
  ["output_content", "The readable text output of the step"],
  ["output_structured", "The raw structured (JSON) output of the step"],
  [
    "input",
    "The step's readable input (tool arguments, a model call's messages, a query, a task)",
  ],
  ["error", "The step's error message, when it failed"],
];

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  // common (all levels)
  {
    name: "HISTORY",
    description: "Full formatted conversation history",
    type: "string",
    levels: ALL,
  },
  {
    name: "GOAL",
    description: "User's overall goal/intent (first request in the thread)",
    type: "string",
    levels: ALL,
  },
  {
    name: "AGENTS",
    description:
      "The agents of this conversation, each with its tools — offered to the model, or only seen being called",
    type: "object",
    levels: ALL,
    props: [
      [
        "tools",
        "Every tool the agents had, with where it came from and how often it was called",
      ],
      ["called", "Only the tools that were called, with how many times"],
    ],
  },
  {
    name: "DEPENDENCIES",
    description:
      "This item's results from the columns in Depends On — label, value, verdict and reason each",
    type: "string",
    levels: ALL,
  },
  // conversation only
  {
    name: "MESSAGES",
    description: "All turns formatted ([role]: text)",
    type: "string",
    levels: ["conversation"],
  },
  {
    name: "USER_MESSAGES",
    description: "All user requests only",
    type: "string",
    levels: ["conversation"],
  },
  {
    name: "ASSISTANT_MESSAGES",
    description: "All assistant answers only",
    type: "string",
    levels: ["conversation"],
  },
  {
    name: "FIRST_USER_MSG",
    description: "The first user request",
    type: "string",
    levels: ["conversation"],
  },
  {
    name: "LAST_USER_MSG",
    description: "The last user request",
    type: "string",
    levels: ["conversation"],
  },
  {
    name: "LAST_ASSISTANT_MSG",
    description: "The last assistant answer",
    type: "string",
    levels: ["conversation"],
  },
  // message level (step inherits)
  {
    name: "PREVIOUS_USER_MSG",
    description: "The previous turn's user request",
    type: "string",
    levels: ["message", "step"],
  },
  {
    name: "PREVIOUS_ASSISTANT_MSG",
    description: "The previous turn's assistant answer",
    type: "string",
    levels: ["message", "step"],
  },
  {
    name: "CURRENT_MESSAGE",
    description: "The turn under evaluation",
    type: "object",
    levels: ["message", "step"],
    props: [
      ["input", "The user request"],
      ["output", "The assistant answer"],
      ["role", "Always 'assistant'"],
    ],
  },
  {
    name: "CURRENT_STEPS",
    description:
      "All steps of the current turn, formatted — `.tool` / `.retriever` / … narrow it to one " +
      "step type, which is how a message-level rubric asks for the evidence it grades against",
    type: "object",
    levels: ["message", "step"],
    props: STEP_TYPE_PROPS,
  },
  {
    name: "CURRENT_STEPS_COUNT",
    description: "Number of steps in the current turn",
    type: "string",
    levels: ["message", "step"],
  },
  // step only
  {
    name: "PREVIOUS_STEP",
    description: "The previous step in this turn",
    type: "object",
    levels: ["step"],
    props: STEP_PROPS,
  },
  {
    name: "CURRENT_STEP",
    description: "The step under evaluation",
    type: "object",
    levels: ["step"],
    props: STEP_PROPS,
  },
  {
    name: "STEP_NUMBER",
    description: "1-indexed position of the current step",
    type: "string",
    levels: ["step"],
  },
  // sequential mode only (message + step)
  {
    name: "METRIC_PREVIOUS_RESULT",
    description: "The previous item's result of this metric (sequential mode)",
    type: "string",
    levels: ["message", "step"],
    sequentialOnly: true,
  },
];

export function catalogLevel(level: string): CatalogLevel {
  const upper = (level || "").toUpperCase();
  if (upper === "CONVERSATION") return "conversation";
  if (upper === "AGENT_RUN") return "message";
  return "step";
}

/** De-duplicated refs used in `prompt`, e.g. ["HISTORY", "CURRENT_STEP.tool_call"]. */
export function extractTemplateVariables(prompt: string): string[] {
  const out: string[] = [];
  for (const m of (prompt || "").matchAll(VARIABLE_RE)) {
    const ref = m[1] + (m[2] ? `.${m[2]}` : "");
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

const baseNames = (refs: string[] | null | undefined) =>
  refs ? new Set(refs.map((r) => r.split(".", 1)[0])) : null;

/** Variables that need the whole thread, not only the current trace. */
const CONVERSATION_SCOPED = new Set([
  "HISTORY",
  "MESSAGES",
  "USER_MESSAGES",
  "ASSISTANT_MESSAGES",
  "FIRST_USER_MSG",
  "LAST_USER_MSG",
  "LAST_ASSISTANT_MSG",
  "GOAL",
  "AGENTS",
  "PREVIOUS_USER_MSG",
  "PREVIOUS_ASSISTANT_MSG",
]);
export function referencesConversationScope(
  refs: string[] | undefined,
): boolean {
  const names = baseNames(refs);
  return !!names && [...names].some((n) => CONVERSATION_SCOPED.has(n));
}

// ── resolution context (one per evaluated item) ─────────────────────────────────
type ToolView = {
  name: string;
  description: string;
  source: "offered" | "called";
  ran: number;
  requested: number;
};
type AgentView = { name: string; tools: Map<string, ToolView> };
type MessageView = { input: string; output: string; role: string };

/** Everything a template can reference for one item. An absent field renders as
 *  `[No <REF> available]`. */
export type EvaluationContext = {
  strings: Record<string, string | null>;
  agents: AgentView[] | null;
  currentMessage: MessageView | null;
  currentStepSpans: JudgeSpan[];
  /** The turn's top-level agent. Steps of another agent are attributed. */
  rootAgent: string;
  agentOf: (span: JudgeSpan) => string;
  previousStep: JudgeSpan | null;
  currentStep: JudgeSpan | null;
  metricPreviousResult: Payload | null;
  dependencies: Record<string, unknown> | null;
};
export type ResolvedTemplate = {
  resolvedText: string;
  variablesUsed: string[];
  variablesMissing: string[];
};

function groupTurns(threadSpans: JudgeSpan[]): [string, JudgeSpan[]][] {
  const byTrace = new Map<string, JudgeSpan[]>();
  for (const s of threadSpans) {
    const list = byTrace.get(s.trace_id);
    if (list) list.push(s);
    else byTrace.set(s.trace_id, [s]);
  }
  return [...byTrace.entries()];
}

/** `span → agent name`: the nearest AGENT ancestor (the span itself included), else "". */
function agentResolver(spans: JudgeSpan[]): (span: JudgeSpan) => string {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  return (span) => {
    let node: JudgeSpan | undefined = span;
    for (let i = 0; i < 64 && node; i++) {
      if (node.type === "AGENT") return node.name;
      node = node.parent_span_id ? byId.get(node.parent_span_id) : undefined;
    }
    return "";
  };
}

// ── @AGENTS: the conversation's agents and their tools ──────────────────────────
// A tool's definition comes from the tool list a model call was offered (OpenInference
// `llm.tools.N.tool.json_schema`, OTel `gen_ai.tool.definitions`) or from the TOOL span of a
// call (`tool.description`). A tool that nothing describes is known only because it was called.

function toolDefs(raw: unknown): [string, string][] {
  let obj: unknown = raw;
  if (typeof raw === "string")
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  const out: [string, string][] = [];
  for (const item of Array.isArray(obj) ? obj : [obj]) {
    if (!isObject(item)) continue;
    const fn = isObject(item.function) ? item.function : item;
    if (fn.name) out.push([String(fn.name), String(fn.description ?? "")]);
  }
  return out;
}

function offeredTools(meta: Record<string, string>): [string, string][] {
  const index = (key: string) => Number(key.split(".")[2]) || 0;
  const keys = Object.keys(meta)
    .filter(
      (k) => k.startsWith("llm.tools.") && k.endsWith(".tool.json_schema"),
    )
    .sort((a, b) => index(a) - index(b));
  const out = keys.flatMap((k) => toolDefs(meta[k]));
  if ("gen_ai.tool.definitions" in meta)
    out.push(...toolDefs(meta["gen_ai.tool.definitions"]));
  return out;
}

/** The tool calls in a model step's output messages. */
function requestedCalls(span: JudgeSpan): Json[] {
  return chatMessages(span.output).flatMap((m) =>
    Array.isArray(m.tool_calls) ? m.tool_calls.filter(isObject) : [],
  );
}
const callName = (c: Json) =>
  String((isObject(c.function) ? c.function.name : undefined) ?? c.name ?? "");

function collectAgents(
  spans: JudgeSpan[],
  agentOf: (s: JudgeSpan) => string,
): AgentView[] {
  const agents = new Map<string, AgentView>();
  const agent = (span: JudgeSpan) => {
    const name = agentOf(span) || "agent";
    let view = agents.get(name);
    if (!view) agents.set(name, (view = { name, tools: new Map() }));
    return view;
  };
  const tool = (
    view: AgentView,
    name: string,
    description = "",
    source: ToolView["source"] = "called",
  ) => {
    let t = view.tools.get(name);
    if (!t)
      view.tools.set(
        name,
        (t = { name, description, source, ran: 0, requested: 0 }),
      );
    else if (source === "offered" && t.source === "called") {
      t.source = source;
      t.description = description || t.description;
    } else t.description = t.description || description;
    return t;
  };
  for (const s of spans) {
    const offered = s.type === "GENERATION" ? offeredTools(s.metadata) : [];
    const requested =
      s.type !== "TOOL" ? requestedCalls(s).map(callName).filter(Boolean) : [];
    const ran = s.type === "TOOL" ? s.metadata["tool.name"] || s.name : "";
    if (!(offered.length || requested.length || ran || s.type === "AGENT"))
      continue;
    const view = agent(s);
    for (const [name, desc] of offered) tool(view, name, desc, "offered");
    for (const name of requested) tool(view, name).requested += 1;
    if (ran) tool(view, ran, s.metadata["tool.description"] ?? "").ran += 1;
  }
  return [...agents.values()];
}

// Executions when the tools are instrumented; the model's requests when they are not.
const calls = (t: ToolView) => t.ran || t.requested;

function toolLine(t: ToolView, prefix = ""): string {
  const head =
    `${prefix}${t.name}` + (t.description ? ` — ${t.description}` : "");
  if (t.source === "called")
    return `${head} [called ${calls(t)}×, no definition]`;
  return `${head} [${t.source} · ${calls(t) ? `called ${calls(t)}×]` : "not called]"}`;
}

/** `@AGENTS` (each agent and its tools), `.tools` (every tool) or `.called` (only the used
 *  tools, with counts). Names and descriptions only. */
function formatAgents(agents: AgentView[], prop: string | null): string | null {
  if (prop === null) {
    const lines: string[] = [];
    for (const a of agents) {
      lines.push(`- ${a.name}`);
      for (const t of a.tools.values()) lines.push(`    • ${toolLine(t)}`);
    }
    return lines.join("\n") || null;
  }
  const multi = agents.filter((a) => a.tools.size).length > 1;
  const pre = (a: AgentView) => (multi ? `${a.name} / ` : "");
  let lines: string[];
  if (prop === "tools")
    lines = agents.flatMap((a) =>
      [...a.tools.values()].map((t) => toolLine(t, pre(a))),
    );
  else if (prop === "called")
    lines = agents.flatMap((a) =>
      [...a.tools.values()]
        .filter((t) => calls(t))
        .map((t) => `${pre(a)}${t.name} ×${calls(t)}`),
    );
  else return null;
  return lines.map((l) => `- ${l}`).join("\n") || null;
}

// ── steps ───────────────────────────────────────────────────────────────────────

/** A failed step's error. A step can be ERROR-level with no message. */
function stepError(span: JudgeSpan): string | null {
  const msg = span.status_message.trim();
  if (msg) return msg;
  return span.level.toUpperCase() === "ERROR"
    ? "(failed, no error message)"
    : null;
}

/** The tool calls a model step requested. Not for a TOOL span. */
function requestedTools(span: JudgeSpan): string | null {
  const found = requestedCalls(span);
  return found.length ? JSON.stringify(found, null, 2) : null;
}

/** The step output as pretty JSON when it is structured. */
function structured(out: string | null): string | null {
  const s = (out ?? "").trim();
  if (s[0] !== "[" && s[0] !== "{") return null;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}

/** One property of a step span. Null when the field does not apply to this span. */
function resolveStepField(span: JudgeSpan, prop: string): string | null {
  const type = span.type;
  if (prop === "tool_call") {
    if (type !== "TOOL") return requestedTools(span);
    // A TOOL span's call is its name and arguments.
    const args = readableIo(span.input);
    return args ? `${span.name}(${args})` : span.name || null;
  }
  if (prop === "tool_result")
    return type === "TOOL" ? readableIo(span.output) || stepError(span) : null;
  if (prop === "thinking")
    return type === "THINKING"
      ? contentText(span.output) || contentText(span.input) || null
      : null;
  if (prop === "input") return readableIo(span.input) || null;
  if (prop === "error") return stepError(span);
  if (prop === "output_content") return contentText(span.output) || null;
  if (prop === "output_structured") return structured(span.output);
  return null;
}

// How each step type's input and output read to a judge. Other types use Input / Output.
const IO_LABELS: Record<string, [string, string]> = {
  TOOL: ["Arguments", "Result"],
  GENERATION: ["Prompt", "Response"],
  RETRIEVER: ["Query", "Retrieved"],
  DELEGATE: ["Task", "Returned"],
  AGENT: ["Input", "Output"],
  GUARDRAIL: ["Checked", "Verdict"],
  SKILL: ["Input", "Output"],
};

/** Everything one step did: what it was, whose it was, what went in, what came out, and if it
 *  failed. Each field once. Nothing is cut. */
function formatStep(span: JudgeSpan, ctx: EvaluationContext): string {
  const type = span.type || "STEP";
  let head = type + (span.name ? ` \`${span.name}\`` : "");
  const agent = ctx.agentOf(span);
  if (agent && agent !== ctx.rootAgent && type !== "AGENT")
    head += ` (agent: ${agent})`;
  const lines = [head];
  if (type === "THINKING") {
    const thought = resolveStepField(span, "thinking");
    if (thought) lines.push(`Thinking: ${thought}`);
  } else {
    const [inLabel, outLabel] = IO_LABELS[type] ?? ["Input", "Output"];
    const input = resolveStepField(span, "input");
    if (input) lines.push(`${inLabel}: ${input}`);
    const output = readableIo(span.output);
    if (output) lines.push(`${outLabel}: ${output}`);
    if (type !== "TOOL") {
      const requested = requestedTools(span);
      if (requested) lines.push(`Requested tool calls: ${requested}`);
    }
  }
  const err = stepError(span);
  if (err) lines.push(`ERROR: ${err}`);
  return lines.join("\n");
}

function formatSteps(
  spans: JudgeSpan[],
  ctx: EvaluationContext,
): string | null {
  if (!spans.length) return null;
  return spans
    .map((s, i) => `Step ${i + 1} · ${formatStep(s, ctx)}`)
    .join("\n\n");
}

function formatMessage(msg: MessageView): string | null {
  const parts: string[] = [];
  if (msg.input) parts.push(`User: ${msg.input}`);
  if (msg.output) parts.push(`Assistant: ${msg.output}`);
  return parts.join("\n") || null;
}

// ── context builder (pure) ──────────────────────────────────────────────────────

/** Build the context for one evaluated item from already-read spans.
 *
 *  `threadSpans` is the whole conversation when conversation-scoped variables are used, else
 *  the current trace's spans. `wantedVars` limits the work to the variables the template names.
 *  At message and step level `@HISTORY` ends at the current turn: a judge that grades turn 2
 *  must not read how turns 3-10 went. */
export function buildContext(
  level: string,
  options: {
    threadSpans: JudgeSpan[];
    currentTraceId?: string;
    currentSpanId?: string | null;
    metricPreviousResult?: Payload | null;
    wantedVars?: string[] | null;
    dependencies?: Record<string, unknown> | null;
  },
): EvaluationContext {
  const { threadSpans } = options;
  const deps = options.dependencies;
  const ctx: EvaluationContext = {
    strings: {},
    agents: null,
    currentMessage: null,
    currentStepSpans: [],
    rootAgent: "",
    agentOf: () => "",
    previousStep: null,
    currentStep: null,
    metricPreviousResult: options.metricPreviousResult ?? null,
    dependencies: deps && Object.keys(deps).length ? deps : null,
  };
  const want = baseNames(options.wantedVars);
  const need = (name: string) => want === null || want.has(name);

  const turns = groupTurns(threadSpans);
  if (!turns.length) return ctx;
  const ios = turns.map(([, spans]) => {
    const root = rootSpan(spans);
    return [userMessage(root), agentAnswer(root)] as const;
  });
  const cl = catalogLevel(level);
  let curIdx = turns.findIndex(([tid]) => tid === options.currentTraceId);
  if (curIdx < 0) curIdx = turns.length - 1;
  const upto = cl === "conversation" ? ios : ios.slice(0, curIdx + 1);
  const set = (name: string, value: string | null | undefined) => {
    ctx.strings[name] = value || null;
  };

  if (need("HISTORY") || need("MESSAGES")) {
    const lines: string[] = [];
    for (const [user, answer] of upto) {
      if (user) lines.push(`[user]: ${user}`);
      if (answer) lines.push(`[assistant]: ${answer}`);
    }
    set("HISTORY", lines.join("\n"));
    set("MESSAGES", lines.join("\n"));
  }
  const users = ios.map(([u]) => u).filter(Boolean);
  const answers = ios.map(([, a]) => a).filter(Boolean);
  if (need("USER_MESSAGES"))
    set("USER_MESSAGES", users.map((u) => `[user]: ${u}`).join("\n"));
  if (need("ASSISTANT_MESSAGES"))
    set(
      "ASSISTANT_MESSAGES",
      answers.map((a) => `[assistant]: ${a}`).join("\n"),
    );
  if (need("FIRST_USER_MSG") || need("GOAL")) {
    set("FIRST_USER_MSG", users[0]);
    set("GOAL", users[0]); // the first request is the user's goal
  }
  if (need("LAST_USER_MSG")) set("LAST_USER_MSG", users[users.length - 1]);
  if (need("LAST_ASSISTANT_MSG"))
    set("LAST_ASSISTANT_MSG", answers[answers.length - 1]);
  if (need("AGENTS")) {
    // Like @HISTORY, stops at the graded turn.
    const seen =
      cl === "conversation"
        ? threadSpans
        : turns.slice(0, curIdx + 1).flatMap(([, spans]) => spans);
    const agents = collectAgents(seen, agentResolver(seen));
    ctx.agents = agents.length ? agents : null;
  }
  if (cl === "conversation") return ctx;

  // message / step: the current turn
  const curSpans = turns[curIdx][1];
  const [curUser, curAnswer] = ios[curIdx];
  const curRoot = rootSpan(curSpans);
  // "steps" = the turn's spans without the root, so the first real step is step 1.
  const rest = curSpans.filter((s) => s.span_id !== curRoot.span_id);
  const stepSpans = rest.length ? rest : curSpans;
  ctx.agentOf = agentResolver(curSpans);
  ctx.rootAgent = ctx.agentOf(curRoot);
  ctx.currentStepSpans = stepSpans;
  if (need("CURRENT_MESSAGE"))
    ctx.currentMessage = {
      input: curUser,
      output: curAnswer,
      role: "assistant",
    };
  if (need("CURRENT_STEPS")) set("CURRENT_STEPS", formatSteps(stepSpans, ctx));
  if (need("CURRENT_STEPS_COUNT"))
    set("CURRENT_STEPS_COUNT", String(stepSpans.length));
  if (curIdx > 0) {
    const [prevUser, prevAnswer] = ios[curIdx - 1];
    if (need("PREVIOUS_USER_MSG")) set("PREVIOUS_USER_MSG", prevUser);
    if (need("PREVIOUS_ASSISTANT_MSG"))
      set("PREVIOUS_ASSISTANT_MSG", prevAnswer);
  }
  if (cl !== "step") return ctx;

  const stepIdx = Math.max(
    stepSpans.findIndex((s) => s.span_id === options.currentSpanId),
    0,
  );
  if (need("CURRENT_STEP")) ctx.currentStep = stepSpans[stepIdx];
  if (need("STEP_NUMBER")) set("STEP_NUMBER", String(stepIdx + 1));
  if (need("PREVIOUS_STEP") && stepIdx > 0)
    ctx.previousStep = stepSpans[stepIdx - 1];
  return ctx;
}

// ── resolver ────────────────────────────────────────────────────────────────────

function resolveVariable(
  name: string,
  prop: string | null,
  ctx: EvaluationContext,
): string | null {
  if (name === "DEPENDENCIES")
    return ctx.dependencies
      ? Object.entries(ctx.dependencies)
          .map(([n, p]) => `- ${n}: ${JSON.stringify(p)}`)
          .join("\n")
      : null;
  if (name === "METRIC_PREVIOUS_RESULT")
    return ctx.metricPreviousResult
      ? JSON.stringify(ctx.metricPreviousResult, null, 2)
      : null;
  if (name === "AGENTS")
    return ctx.agents ? formatAgents(ctx.agents, prop) : null;
  if (name === "CURRENT_STEPS" && prop)
    return formatSteps(
      ctx.currentStepSpans.filter(
        (s) => s.type.toUpperCase() === prop.toUpperCase(),
      ),
      ctx,
    );
  if (name === "CURRENT_MESSAGE") {
    const msg = ctx.currentMessage;
    if (!msg) return null;
    if (!prop) return formatMessage(msg);
    if (prop === "role") return msg.role;
    return prop === "input" || prop === "output" ? msg[prop] || null : null;
  }
  if (name === "CURRENT_STEP" || name === "PREVIOUS_STEP") {
    const span = name === "CURRENT_STEP" ? ctx.currentStep : ctx.previousStep;
    if (!span) return null;
    return prop ? resolveStepField(span, prop) : formatStep(span, ctx);
  }
  return ctx.strings[name] ?? null;
}

/** Replace every `@VARIABLE` / `@VARIABLE.prop`. A missing value becomes
 *  `[No <REF> available]`. It never throws. */
export function resolveTemplate(
  template: string,
  context: EvaluationContext,
): ResolvedTemplate {
  const used: string[] = [];
  const missing: string[] = [];
  const text = (template || "").replace(
    VARIABLE_RE,
    (_match, name: string, prop: string | undefined) => {
      const ref = name + (prop ? `.${prop}` : "");
      let value: string | null = null;
      try {
        value = resolveVariable(name, prop ?? null, context);
      } catch {
        value = null;
      }
      if (!value) {
        if (!missing.includes(ref)) missing.push(ref);
        return `[No ${ref} available]`;
      }
      if (!used.includes(ref)) used.push(ref);
      return value;
    },
  );
  return { resolvedText: text, variablesUsed: used, variablesMissing: missing };
}
