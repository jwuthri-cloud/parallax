// The one LLM gateway of the judge: every model call goes to OpenRouter from here.
// Port of Tracely `infrastructure/llm/provider.py` (which drives LangChain); this one calls the
// HTTP API with `fetch`.
//
// - `runStructured` / `runText`: one chat completion (`/chat/completions`). A structured call
//   sends the reply's JSON Schema as `response_format`; a model or provider without native
//   structured output gets the schema in the prompt instead, so every chat model works.
// - `runDecision`: one Decisions API call. Decision models (classifiers such as TypeSafe Jev)
//   have no chat endpoint.
// - The key is the user's own OpenRouter key: saved from the Evaluators page (one private file
//   in the data folder), or `OPENROUTER_API_KEY`. With no key nothing here contacts OpenRouter.
//
// What leaves this machine: the judged trace content and the rubric, to OpenRouter, only when
// the user runs a column. Cost is stored only when the provider reports it.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { dataDir, StoreError } from "../workspaces";
import type { ModelInfo } from "./budget";
import type { Answers, Question } from "./decision";
import {
  coerce,
  isStrict,
  parseJsonObject,
  toJsonSchema,
  type Json,
  type OutputSchema,
} from "./structured";
import type { Usage } from "./types";

const env = (name: string, fallback: string) =>
  (process.env[name] ?? "").trim() || fallback;

/** Tracely's setting names, read at call time so a test can point them at a local server. */
export const settings = {
  get baseUrl() {
    return env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").replace(
      /\/+$/,
      "",
    );
  },
  /** Decision models are served on the Decisions API, not `/chat/completions`. A custom base
   *  URL moves this one with it, so a test server never leaks a call to the real API. */
  get decisionsUrl() {
    const explicit = (process.env.OPENROUTER_DECISIONS_URL ?? "").trim();
    if (explicit) return explicit;
    return this.baseUrl.replace(/\/v1$/, "") + "/alpha/decisions";
  },
  /** The default text model: an LLM column with no model, and the "Use AI" generator. */
  get judgeModel() {
    return env("LLM_JUDGE_MODEL", "openai/gpt-6-luna");
  },
  /** The model a new column starts on, and what a decision column with no model runs on. */
  get columnModel() {
    return env("COLUMN_DEFAULT_MODEL", "typesafe/jev-1.13");
  },
  /** Always bounded: without it OpenRouter reserves credit for the provider's default. */
  get maxOutputTokens() {
    return Number(env("LLM_MAX_OUTPUT_TOKENS", "4096")) || 4096;
  },
};

// ── the key ─────────────────────────────────────────────────────────────────────
const keyFile = () => path.join(dataDir, "openrouter.key");

/** The OpenRouter key in effect: the saved one, else the environment's. "" when none. */
export function openrouterKey(): string {
  try {
    const saved = readFileSync(keyFile(), "utf8").trim();
    if (saved) return saved;
  } catch {
    // no saved key
  }
  return (process.env.OPENROUTER_API_KEY ?? "").trim();
}

export function keyStatus() {
  const saved = existsSync(keyFile());
  const key = openrouterKey();
  return {
    configured: !!key,
    source: !key ? null : saved ? ("saved" as const) : ("environment" as const),
    // The value is never returned: only enough to tell two keys apart.
    hint: key ? `…${key.slice(-4)}` : "",
  };
}

export function saveKey(input: unknown) {
  const key = typeof input === "string" ? input.trim() : "";
  if (key.length < 8 || key.length > 500 || /\s/.test(key))
    throw new StoreError("Paste one OpenRouter API key (sk-or-…)");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(), key, { mode: 0o600 });
  chmodSync(keyFile(), 0o600);
  resetModelCache();
  return keyStatus();
}

export function clearKey() {
  rmSync(keyFile(), { force: true });
  resetModelCache();
  return keyStatus();
}

export const llmEnabled = () => !!openrouterKey();

const NO_KEY =
  "No OpenRouter API key. Add one on the Evaluators page (Traces → Evaluators) to run LLM judges.";

// ── models ──────────────────────────────────────────────────────────────────────
/** OpenRouter ids are `provider/model`; a bare OpenAI-style id gets the `openai/` prefix. */
export const normalizeModel = (model: string) =>
  model.includes("/") ? model : `openai/${model}`;

// The choices the column editor offers (Tracely's curated list, 2026-09-27). With a key they are
// checked against the live catalog: ids that are gone are dropped, labels become OpenRouter's
// names. Any other OpenRouter model id can be typed in the editor.
const CURATED_MODELS: [string, string][] = [
  ["openai/gpt-6-luna", "OpenAI GPT-6 Luna"],
  ["openai/gpt-6-luna-pro", "OpenAI GPT-6 Luna Pro"],
  ["openai/gpt-6-sol", "OpenAI GPT-6 Sol"],
  ["openai/gpt-6-sol-pro", "OpenAI GPT-6 Sol Pro"],
  ["openai/gpt-6-astra", "OpenAI GPT-6 Astra"],
  ["openai/gpt-6-astra-pro", "OpenAI GPT-6 Astra Pro"],
  ["google/gemini-3.5-flash-lite", "Google Gemini 3.5 Flash Lite"],
  ["google/gemini-3.8-flash", "Google Gemini 3.8 Flash"],
  ["google/gemini-3.1-pro-preview", "Google Gemini 3.1 Pro"],
  ["anthropic/claude-haiku-4.5", "Anthropic Claude Haiku 4.5"],
  ["anthropic/claude-sonnet-5", "Anthropic Claude Sonnet 5"],
  ["anthropic/claude-opus-5.5", "Anthropic Claude Opus 5.5"],
  ["anthropic/claude-fable-5.1", "Anthropic Claude Fable 5.1"],
  ["x-ai/grok-4.7", "xAI Grok 4.7"],
  ["inclusionai/ling-3.0-flash:free", "Ling 3.0 Flash (free)"],
  ["openai/gpt-oss-120b", "OpenAI GPT-OSS 120B"],
  ["qwen/qwen3-32b", "Qwen3 32B"],
  ["minimax/minimax-m2.7", "MiniMax M2.7"],
];
// Decision models: classifiers on the Decisions API. Static, because OpenRouter's public
// `/models` does not list them. `context_tokens` is the budget for the state plus one question.
const DECISION_MODELS: Record<
  string,
  { label: string; context_tokens: number }
> = {
  "typesafe/jev-1.13": { label: "TypeSafe Jev 1.13", context_tokens: 32_000 },
};

type CatalogEntry = {
  name: string;
  context_length: number | null;
  output_modalities: string[];
};
type Catalog = Map<string, CatalogEntry>;
const MODELS_TTL_MS = 3600_000;
let modelCache: { at: number; url: string; byId: Catalog } | undefined;
function resetModelCache() {
  modelCache = undefined;
}

/** OpenRouter's model catalog, kept for an hour. Empty without a key (no call is made). After a
 *  failed refresh the last catalog keeps serving and the next try waits 60 s. */
async function openrouterModels(): Promise<Catalog> {
  const key = openrouterKey();
  if (!key) return new Map();
  const url = `${settings.baseUrl}/models`;
  const now = Date.now();
  if (
    modelCache &&
    modelCache.url === url &&
    now - modelCache.at < MODELS_TTL_MS
  )
    return modelCache.byId;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Json[] };
    const byId: Catalog = new Map();
    for (const m of body.data ?? []) {
      if (!m.id) continue;
      const architecture = (m.architecture ?? {}) as Json;
      const context = Number(m.context_length);
      byId.set(String(m.id), {
        name: String(m.name || m.id),
        context_length: context > 0 ? context : null,
        output_modalities: Array.isArray(architecture.output_modalities)
          ? architecture.output_modalities.map(String)
          : [],
      });
    }
    modelCache = { at: now, url, byId };
    return byId;
  } catch (error) {
    console.warn(`OpenRouter model list failed: ${(error as Error).message}`);
    modelCache = {
      at: now - MODELS_TTL_MS + 60_000,
      url,
      byId: modelCache?.url === url ? modelCache.byId : new Map(),
    };
    return modelCache.byId;
  }
}

/** What the judge needs to know about a model before a call. `context_tokens` is null when it
 *  is unknown; an unknown context never blocks a call. */
export async function modelInfo(
  model: string | null | undefined,
): Promise<ModelInfo> {
  const id = normalizeModel((model || settings.judgeModel).trim());
  const decision = DECISION_MODELS[id];
  if (decision)
    return { id, kind: "decision", context_tokens: decision.context_tokens };
  const live = (await openrouterModels()).get(id);
  return {
    id,
    kind: live?.output_modalities.includes("decisions") ? "decision" : "llm",
    context_tokens: live?.context_length ?? null,
  };
}

export const isDecisionModel = async (model: string | null | undefined) =>
  !!model && (await modelInfo(model)).kind === "decision";

/** The default text model. Never a decision model, which writes no text. */
export const defaultModelId = () => normalizeModel(settings.judgeModel);

/** What a new column starts on: the decision model when a key makes it reachable, else the
 *  text default, so the form never offers a model that cannot run. */
export function defaultColumnModelId(): string {
  const column = normalizeModel(settings.columnModel);
  return openrouterKey() && column in DECISION_MODELS
    ? column
    : defaultModelId();
}

export type ModelOption = {
  id: string;
  label: string;
  kind: "llm" | "decision";
  context_tokens: number | null;
};

/** The model choices of the column editor, by label. Decision models only with a key. */
export async function listModels(): Promise<ModelOption[]> {
  const catalog = await openrouterModels();
  const llm = ([id, label]: [string, string]): ModelOption => ({
    id,
    label: catalog.get(id)?.name ?? label,
    kind: "llm",
    context_tokens: catalog.get(id)?.context_length ?? null,
  });
  let out = CURATED_MODELS.filter(([id]) => catalog.has(id)).map(llm);
  if (!out.length) out = CURATED_MODELS.map(llm);
  if (openrouterKey())
    for (const [id, d] of Object.entries(DECISION_MODELS))
      out.push({
        id,
        label: d.label,
        kind: "decision",
        context_tokens: d.context_tokens,
      });
  return out.sort((a, b) =>
    a.label.toLowerCase().localeCompare(b.label.toLowerCase()),
  );
}

// ── calls ───────────────────────────────────────────────────────────────────────
/** The provider refused the call because the input is longer than the model's context. The
 *  judge answers it with the column's fallback model, or a visible skip. */
export class ContextOverflowError extends Error {}

/** A reply that is not the JSON it was asked for. Carries the tokens the call used. */
class ReplyFormatError extends Error {
  constructor(
    message: string,
    public usage: Usage,
    public output: string,
  ) {
    super(message);
  }
}
class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// What providers say for "input too long". OpenRouter passes the upstream message through.
const OVERFLOW_MARKERS = [
  "context length",
  "context_length",
  "context window",
  "maximum context",
  "too many tokens",
  "prompt is too long",
  "input is too long",
  "exceeds the maximum",
  "token limit",
  "tokens exceeds",
  "payload too large",
  "request too large",
  // TypeSafe on the Decisions API: HTTP 400 {"detail":{"error_type":"max_tokens_exceeded"}}
  "max_tokens_exceeded",
  "tokens_exceeded",
];
export function isContextOverflow(message: string): boolean {
  const m = (message || "").toLowerCase();
  return OVERFLOW_MARKERS.some((marker) => m.includes(marker));
}

const RETRY_STATUSES = [429, 502, 503, 529];
const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST JSON with the key. 429/502/503/529 retry with backoff (`retry-after` is honoured). */
async function post(
  url: string,
  body: Json,
): Promise<{ status: number; text: string }> {
  const key = openrouterKey();
  if (!key) throw new StoreError(NO_KEY, 503);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!RETRY_STATUSES.includes(response.status) || attempt === ATTEMPTS - 1)
      return { status: response.status, text };
    const after = Number(response.headers.get("retry-after"));
    await sleep(
      Number.isFinite(after) && after > 0
        ? Math.min(after, 10) * 1000
        : 500 * 2 ** attempt,
    );
  }
}

/** The provider's own message from an error body, or the raw text. */
function errorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as Json;
    const err = body.error ?? body.detail;
    if (err && typeof err === "object") {
      const e = err as Json;
      // OpenRouter nests the upstream provider's message in `metadata.raw`.
      const raw = (e.metadata as Json | undefined)?.raw;
      return [e.message, e.error_type, typeof raw === "string" ? raw : ""]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 500);
    }
    if (typeof err === "string") return err.slice(0, 500);
  } catch {
    // not JSON
  }
  return (text || "").slice(0, 500);
}

function usageOf(raw: unknown, model: string): Usage {
  const u = (raw ?? {}) as Json;
  const input = Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens) || 0;
  const usage: Usage = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    model,
  };
  if (typeof u.cost === "number") usage.cost_usd = u.cost;
  return usage;
}
function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    model: b.model,
  };
  if (a.cost_usd !== undefined || b.cost_usd !== undefined)
    sum.cost_usd = (a.cost_usd ?? 0) + (b.cost_usd ?? 0);
  return sum;
}

type Message = { role: "system" | "user"; content: string };

async function chat(
  model: string,
  messages: Message[],
  extra: Json = {},
): Promise<{ content: string; usage: Usage }> {
  const { status, text } = await post(`${settings.baseUrl}/chat/completions`, {
    model,
    messages,
    temperature: 0,
    max_tokens: settings.maxOutputTokens,
    usage: { include: true },
    ...extra,
  });
  if (status >= 400) {
    const detail = errorMessage(text);
    if (status === 413 || isContextOverflow(detail))
      throw new ContextOverflowError(`${model}: ${detail}`);
    throw new ProviderError(
      `OpenRouter ${status} for ${model}: ${detail}`,
      status,
    );
  }
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    throw new ProviderError(`OpenRouter returned no JSON for ${model}`, 502);
  }
  const choice = Array.isArray(body.choices)
    ? (body.choices[0] as Json)
    : undefined;
  if (!choice) {
    // OpenRouter reports some failures (credit exhaustion above all) as HTTP 200 with an
    // `{"error": …}` body and no `choices`.
    const detail = errorMessage(text);
    if (isContextOverflow(detail))
      throw new ContextOverflowError(`${model}: ${detail}`);
    throw new ProviderError(
      `OpenRouter returned an error instead of a completion for ${model}: ${detail || "no choices"}. ` +
        "If this is a credit error, check the balance at https://openrouter.ai/settings/credits.",
      502,
    );
  }
  const content = (choice.message as Json | undefined)?.content;
  const reply =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => String((part as Json)?.text ?? "")).join("")
        : "";
  return { content: reply, usage: usageOf(body.usage, model) };
}

const messagesOf = (
  systemPrompt: string | undefined,
  prompt: string,
): Message[] => [
  ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
  { role: "user", content: prompt },
];

function chatModel(model: string | null | undefined): string {
  const id = normalizeModel((model || settings.judgeModel).trim());
  if (id in DECISION_MODELS)
    throw new Error(
      `${id} is a decision model (classifier): it has no chat endpoint and is called through the Decisions API.`,
    );
  return id;
}

/** Whether a failed structured call is worth one more try with the schema in the prompt: the
 *  reply was not the JSON asked for, or the provider refused `response_format`. */
function formatProblem(error: unknown): boolean {
  if (error instanceof ReplyFormatError) return true;
  return (
    error instanceof ProviderError &&
    [400, 404, 422].includes(error.status) &&
    /response_format|json_schema|structured|json mode|no endpoints/i.test(
      error.message,
    )
  );
}

export type StructuredReply = { value: Json; usage: Usage; output: string };

/** A reply contract with its own JSON Schema, for a shape `OutputSchema` cannot describe
 *  (nested objects). `check` validates the parsed reply and returns it. */
export type Contract = {
  name: string;
  jsonSchema: Json;
  strict: boolean;
  check: (reply: Json) => Json;
};
const contractOf = (schema: OutputSchema | Contract): Contract =>
  "jsonSchema" in schema
    ? schema
    : {
        name: schema.name,
        jsonSchema: toJsonSchema(schema),
        strict: isStrict(schema),
        check: (reply) => coerce(schema, reply),
      };

/** One chat completion that returns an object of `schema`. Throws on transport errors and on a
 *  reply that still does not fit the schema after the second try. */
export async function runStructured(
  prompt: string,
  options: {
    schema: OutputSchema | Contract;
    systemPrompt?: string;
    model?: string | null;
  },
): Promise<StructuredReply> {
  const model = chatModel(options.model);
  const contract = contractOf(options.schema);
  const { jsonSchema } = contract;
  const parse = (reply: { content: string; usage: Usage }): StructuredReply => {
    try {
      return {
        value: contract.check(parseJsonObject(reply.content)),
        usage: reply.usage,
        output: reply.content,
      };
    } catch (error) {
      throw new ReplyFormatError(
        `${model} did not return the requested JSON: ${(error as Error).message}`,
        reply.usage,
        reply.content,
      );
    }
  };
  let spent: Usage | undefined;
  try {
    return parse(
      await chat(model, messagesOf(options.systemPrompt, prompt), {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: contract.name,
            strict: contract.strict,
            schema: jsonSchema,
          },
        },
      }),
    );
  } catch (error) {
    if (!formatProblem(error)) throw error;
    if (error instanceof ReplyFormatError) spent = error.usage;
  }
  // No native structured output on this model or provider: put the contract in the prompt.
  const instruction =
    "\n\nRespond with ONE JSON object and nothing else. It must match this JSON Schema:\n" +
    JSON.stringify(jsonSchema);
  try {
    const reply = parse(
      await chat(model, messagesOf(options.systemPrompt, prompt + instruction)),
    );
    return spent ? { ...reply, usage: addUsage(spent, reply.usage) } : reply;
  } catch (error) {
    if (error instanceof ReplyFormatError && spent)
      error.usage = addUsage(spent, error.usage);
    throw error;
  }
}

/** One chat completion that returns the reply text. */
export async function runText(
  prompt: string,
  options: { systemPrompt?: string; model?: string | null } = {},
): Promise<{ text: string; usage: Usage }> {
  const reply = await chat(
    chatModel(options.model),
    messagesOf(options.systemPrompt, prompt),
  );
  return { text: reply.content, usage: reply.usage };
}

/** One Decisions API call. `questions` maps our ids to typed questions, all answered against
 *  the same state; the answers come back under the same ids. */
export async function runDecision(
  state: string,
  questions: Record<string, Question>,
  model: string,
): Promise<{
  answers: Answers;
  usage: Usage;
  request: string;
  output: string;
}> {
  const id = normalizeModel(model.trim());
  const body = { model: id, state, questions };
  const request = JSON.stringify(body, null, 2);
  const { status, text } = await post(settings.decisionsUrl, body);
  if (status >= 400) {
    const detail = errorMessage(text);
    if (status === 413 || (status === 400 && isContextOverflow(detail)))
      throw new ContextOverflowError(`${id}: ${detail}`);
    throw new ProviderError(
      `Decisions API ${status} for ${id}: ${detail}`,
      status,
    );
  }
  let data: Json;
  try {
    data = JSON.parse(text) as Json;
  } catch {
    throw new ProviderError(`Decisions API returned no JSON for ${id}`, 502);
  }
  const raw = (data.answers ?? {}) as Json;
  const missing = Object.keys(questions).filter(
    (q) => typeof raw[q] !== "object" || raw[q] === null,
  );
  if (missing.length)
    throw new ProviderError(
      `Decisions API left ${missing.join(", ")} unanswered for ${id}: ${text.slice(0, 300)}`,
      502,
    );
  const answers = Object.fromEntries(
    Object.keys(questions).map((q) => [q, raw[q] as Json]),
  );
  return {
    answers,
    usage: usageOf(data.usage, id),
    request,
    output: JSON.stringify(answers, null, 2),
  };
}

/** What went to the model, system rubric included. */
export const promptText = (systemPrompt: string | undefined, prompt: string) =>
  systemPrompt ? `[system]\n${systemPrompt}\n\n[user]\n${prompt}` : prompt;
