// OTLP/JSON → Parallax spans. A port of Tracely's backend/tracely/otel package: type
// classification, failure level, token usage, and the message conventions (OTel GenAI structured
// and event forms, OpenInference flattened, OpenLLMetry legacy, Vercel AI SDK, LangChain).
import { StoreError } from "./workspaces";
import type { SpanType } from "./schema";

/** A span after mapping: every field resolved, ready to store. */
export type MappedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sessionId: string | null;
  experimentId: string | null;
  name: string;
  type: SpanType;
  level: "DEFAULT" | "ERROR";
  statusMessage: string;
  startMs: number;
  endMs: number | null;
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

type Attrs = Record<string, unknown>;
type Json = Record<string, unknown>;

// ── attribute primitives (attributes.py) ─────────────────────────────────────────
function anyValue(v: unknown): unknown {
  if (!v || typeof v !== "object") return v ?? null;
  const o = v as Json;
  if ("stringValue" in o) return o.stringValue;
  if ("boolValue" in o) return Boolean(o.boolValue);
  if ("intValue" in o) return Number(o.intValue);
  if ("doubleValue" in o) return Number(o.doubleValue);
  if ("bytesValue" in o) return hexId(String(o.bytesValue));
  if ("arrayValue" in o)
    return (((o.arrayValue as Json)?.values as unknown[]) ?? []).map(anyValue);
  if ("kvlistValue" in o) return attrs((o.kvlistValue as Json)?.values);
  return null;
}
function attrs(list: unknown): Attrs {
  const out: Attrs = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list)
    if (kv && typeof kv === "object" && "key" in kv)
      out[String((kv as Json).key)] = anyValue((kv as Json).value);
  return out;
}
function first(a: Attrs, keys: string[]): unknown {
  for (const k of keys)
    if (a[k] !== undefined && a[k] !== null && a[k] !== "") return a[k];
  return undefined;
}
function toStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}
/** OTLP/JSON ids are hex by the spec, base64 when written by protobuf's JSON mapping. */
function hexId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (/^[0-9a-f]+$/i.test(raw) && (raw.length === 16 || raw.length === 32))
    return /^0+$/.test(raw) ? null : raw.toLowerCase();
  const hex = Buffer.from(raw, "base64").toString("hex");
  if (!hex || /^0+$/.test(hex)) return null;
  return hex;
}
function nanosToMs(v: unknown): number | null {
  if (v === undefined || v === null || v === "" || v === "0" || v === 0)
    return null;
  try {
    return Number(BigInt(String(v).split(".")[0]) / 1_000_000n);
  } catch {
    return null;
  }
}
const int = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n)
    ? null
    : Math.round(n);
};

// ── type classification (types.py) ───────────────────────────────────────────────
const knownTypes = new Set([
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
]);
const typeAliases: Record<string, SpanType> = {
  REASONING: "THINKING",
  HANDOFF: "DELEGATE",
};
const generationOps = new Set([
  "chat",
  "completion",
  "text_completion",
  "generate_content",
  "generate",
]);

export function spanType(a: Attrs): SpanType {
  const explicit = first(a, [
    "tracely.observation.type",
    "langfuse.observation.type",
    "parallax.span.type",
  ]);
  if (explicit) {
    const up = String(explicit).toUpperCase();
    if (typeAliases[up]) return typeAliases[up];
    if (knownTypes.has(up)) return up as SpanType;
  }
  const op = String(a["gen_ai.operation.name"] ?? "").toLowerCase();
  if (op) {
    if (generationOps.has(op)) return "GENERATION";
    if (op === "execute_tool") return "TOOL";
    if (op === "invoke_agent" || op === "create_agent") return "AGENT";
    if (op === "embeddings" || op === "embedding") return "EMBEDDING";
  }
  const oi = String(a["openinference.span.kind"] ?? "").toUpperCase();
  const oiTypes: Record<string, SpanType> = {
    LLM: "GENERATION",
    TOOL: "TOOL",
    AGENT: "AGENT",
    CHAIN: "CHAIN",
    RETRIEVER: "RETRIEVER",
    EMBEDDING: "EMBEDDING",
    GUARDRAIL: "GUARDRAIL",
    EVALUATOR: "EVALUATOR",
  };
  if (oiTypes[oi]) return oiTypes[oi];
  // Vercel AI SDK names the operation, not the type.
  const vercel = String(first(a, ["ai.operationId", "operation.name"]) ?? "");
  if (vercel.startsWith("ai.")) {
    if (vercel.startsWith("ai.toolCall")) return "TOOL";
    if (vercel.startsWith("ai.embed")) return "EMBEDDING";
    return "GENERATION";
  }
  const traceloop: Record<string, SpanType> = {
    workflow: "CHAIN",
    task: "CHAIN",
    agent: "AGENT",
    tool: "TOOL",
  };
  const tl = traceloop[String(a["traceloop.span.kind"] ?? "").toLowerCase()];
  if (tl) return tl;
  if (first(a, ["gen_ai.tool.name", "tool.name", "ai.toolCall.name"]))
    return "TOOL";
  if (
    first(a, [
      "gen_ai.request.model",
      "gen_ai.response.model",
      "llm.model_name",
      "llm.openai.model",
      "ai.model.id",
    ])
  )
    return "GENERATION";
  return "SPAN";
}

// ── messages (messages.py) ───────────────────────────────────────────────────────
/** A structured value may arrive decoded or as a JSON string. */
function asObj(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
      return v;
    }
  }
  return v;
}

function normalizeContent(raw: unknown): unknown {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? [raw]
      : null;
  if (!parts) return JSON.stringify(raw);
  return parts.map((p) => {
    if (typeof p === "string") return { type: "text", text: p };
    if (!p || typeof p !== "object") return p;
    const o = p as Json;
    if (typeof o.text === "string") return { type: "text", text: o.text };
    if (typeof o.content === "string" && (o.type ?? "text") === "text")
      return { type: "text", text: o.content };
    if (typeof o.thinking === "string")
      return { type: "thinking", text: o.thinking };
    return o;
  });
}

const messageExtras = ["tool_call_id", "name", "id", "finish_reason"];
function normalizeMessage(m: unknown): Json {
  if (!m || typeof m !== "object" || Array.isArray(m))
    return { role: "", content: JSON.stringify(m) };
  const o = m as Json;
  const msg: Json = {
    role: String(o.role ?? o.author ?? ""),
    content: normalizeContent(o.content ?? o.parts),
  };
  if (Array.isArray(o.tool_calls) && o.tool_calls.length)
    msg.tool_calls = o.tool_calls;
  for (const k of messageExtras)
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") msg[k] = o[k];
  return msg;
}

function structuredMessages(v: unknown): Json[] | null {
  let obj = asObj(v);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) obj = [obj];
  if (!Array.isArray(obj) || !obj.length) return null;
  return obj.map(normalizeMessage);
}

function indices(a: Attrs, prefix: string): number[] {
  const seen = new Set<number>();
  for (const k of Object.keys(a))
    if (k.startsWith(prefix)) {
      const head = k.slice(prefix.length).split(".", 1)[0];
      if (/^\d+$/.test(head)) seen.add(Number(head));
    }
  return [...seen].sort((x, y) => x - y);
}

/** OpenInference `retrieval.documents.<i>.document.*`: what a RETRIEVER span returned. */
function retrievalDocuments(a: Attrs): Json[] | null {
  const prefix = "retrieval.documents.";
  const docs: Json[] = [];
  for (const i of indices(a, prefix)) {
    const doc: Json = {};
    for (const field of ["id", "score", "content", "metadata"]) {
      const v = a[`${prefix}${i}.document.${field}`];
      if (v !== undefined && v !== null && v !== "")
        doc[field] = field === "metadata" ? asObj(v) : v;
    }
    if (Object.keys(doc).length) docs.push(doc);
  }
  return docs.length ? docs : null;
}

// OpenInference wraps each call in `tool_call.`; OpenLLMetry does not.
function flatToolCalls(a: Attrs, prefix: string, wrapped: boolean): Json[] {
  const out: Json[] = [];
  for (const j of indices(a, prefix)) {
    const b = `${prefix}${j}.` + (wrapped ? "tool_call." : "");
    const name = wrapped ? a[b + "function.name"] : a[b + "name"];
    const args = wrapped ? a[b + "function.arguments"] : a[b + "arguments"];
    const id = a[b + "id"];
    if (name || args || id)
      out.push({
        id: String(id ?? ""),
        type: "function",
        function: { name: String(name ?? ""), arguments: args ?? "" },
      });
  }
  return out;
}

function oiContents(a: Attrs, prefix: string): unknown[] | null {
  const blocks: unknown[] = [];
  for (const j of indices(a, prefix)) {
    const b = `${prefix}${j}.message_content.`;
    if (a[b + "text"] != null)
      blocks.push({ type: "text", text: a[b + "text"] });
    else if (a[b + "image.image.url"] != null)
      blocks.push({
        type: "image_url",
        image_url: { url: a[b + "image.image.url"] },
      });
    else blocks.push({ type: String(a[b + "type"] ?? "text") });
  }
  return blocks.length ? blocks : null;
}

function flatMessages(a: Attrs, prefix: string, wrapped: boolean): Json[] {
  return indices(a, prefix).map((i) => {
    const base = `${prefix}${i}.` + (wrapped ? "message." : "");
    let content = a[base + "content"];
    if (content == null && wrapped) content = oiContents(a, base + "contents.");
    const msg: Json = {
      role: String(a[base + "role"] ?? ""),
      content: normalizeContent(content),
    };
    const calls = flatToolCalls(a, base + "tool_calls.", wrapped);
    if (calls.length) msg.tool_calls = calls;
    for (const k of messageExtras) {
      const v = a[base + k];
      if (v !== undefined && v !== null && v !== "") msg[k] = v;
    }
    return msg;
  });
}

function ioMessages(a: Attrs, direction: "input" | "output"): Json[] | null {
  const structured = a[`gen_ai.${direction}.messages`];
  if (structured != null) {
    const msgs = structuredMessages(structured);
    if (msgs) return msgs;
  }
  const oi = flatMessages(a, `llm.${direction}_messages.`, true);
  if (oi.length) return oi;
  const legacy = flatMessages(
    a,
    `gen_ai.${direction === "input" ? "prompt" : "completion"}.`,
    false,
  );
  return legacy.length ? legacy : null;
}

function hasText(v: unknown): boolean {
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(hasText);
  if (v && typeof v === "object") {
    const o = v as Json;
    if (["text", "content", "value"].some((k) => k in o && hasText(o[k])))
      return true;
    return Array.isArray(o.tool_calls) && o.tool_calls.length > 0;
  }
  return false;
}
function looksLikeMessages(v: unknown): boolean {
  if (Array.isArray(v))
    return v.some(
      (m) => !!m && typeof m === "object" && ("role" in m || "content" in m),
    );
  return !!v && typeof v === "object" && ("role" in v || "content" in v);
}

// LangChain serializations: lc-constructor and messages_to_dict.
const lcRoles: Record<string, string> = {
  system: "system",
  systemmessage: "system",
  developer: "system",
  human: "user",
  humanmessage: "user",
  user: "user",
  chat: "user",
  chatmessage: "user",
  ai: "assistant",
  aimessage: "assistant",
  assistant: "assistant",
  tool: "tool",
  toolmessage: "tool",
  function: "tool",
  functionmessage: "tool",
};
function lcRole(...hints: unknown[]): string {
  for (const h of hints)
    if (typeof h === "string" && lcRoles[h.trim().toLowerCase()])
      return lcRoles[h.trim().toLowerCase()];
  return "";
}
function lcToolCalls(kw: Json): Json[] | null {
  const extra = kw.additional_kwargs as Json | undefined;
  const raw =
    (extra && Array.isArray(extra.tool_calls) && extra.tool_calls) ||
    kw.tool_calls;
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = raw
    .filter((c): c is Json => !!c && typeof c === "object")
    .map((c) =>
      c.function && typeof c.function === "object"
        ? c
        : {
            id: String(c.id ?? ""),
            type: "function",
            function: {
              name: String(c.name ?? ""),
              arguments:
                c.args && typeof c.args === "object"
                  ? JSON.stringify(c.args)
                  : (c.args ?? ""),
            },
          },
    );
  return out.length ? out : null;
}
function lcMessage(m: unknown): Json | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Json;
  let kw: Json | null = null;
  let hints: unknown[] = [];
  if (
    o.lc &&
    o.type === "constructor" &&
    o.kwargs &&
    typeof o.kwargs === "object"
  ) {
    kw = o.kwargs as Json;
    const id = Array.isArray(o.id) ? o.id[o.id.length - 1] : "";
    hints = [kw.type, kw.role, id];
  } else if (
    o.data &&
    typeof o.data === "object" &&
    typeof o.type === "string" &&
    lcRoles[o.type.toLowerCase()]
  ) {
    kw = o.data as Json;
    hints = [o.type, kw.type, kw.role];
  }
  if (!kw) return null;
  const msg: Json = { role: lcRole(...hints), content: kw.content ?? "" };
  const calls = lcToolCalls(kw);
  if (calls) msg.tool_calls = calls;
  for (const k of ["tool_call_id", "name"]) if (kw[k]) msg[k] = kw[k];
  return msg;
}
function lcMessagesFrom(v: unknown): Json[] | null {
  const value = asObj(v);
  const items: unknown[] = Array.isArray(value)
    ? value.flatMap((x) => (Array.isArray(x) ? x : [x]))
    : value && typeof value === "object"
      ? [value]
      : [];
  let sawLangChain = false;
  const decoded: Json[] = [];
  for (const item of items) {
    const message = lcMessage(item);
    if (message) {
      sawLangChain = true;
      decoded.push(message);
    } else if (
      item &&
      typeof item === "object" &&
      ("role" in item || "content" in item)
    )
      decoded.push(item as Json);
  }
  return sawLangChain && decoded.length ? decoded : null;
}
function decodeLangChain(v: unknown): Json[] | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Json;
    if ("generations" in o) {
      const gens = asObj(o.generations);
      const flat = Array.isArray(gens)
        ? gens.flatMap((g) => (Array.isArray(g) ? g : [g]))
        : [];
      const msgs: Json[] = [];
      for (const g of flat) {
        if (!g || typeof g !== "object") continue;
        const message = lcMessage((g as Json).message);
        if (message) msgs.push(message);
        else if (typeof (g as Json).text === "string" && (g as Json).text)
          msgs.push({ role: "assistant", content: (g as Json).text });
      }
      return msgs.length ? msgs : null;
    }
    return "messages" in o ? lcMessagesFrom(o.messages) : null;
  }
  if (Array.isArray(v)) {
    const updates = v.flatMap((it) =>
      it &&
      typeof it === "object" &&
      (it as Json).update &&
      typeof (it as Json).update === "object"
        ? ((((it as Json).update as Json).messages as unknown[]) ?? [])
        : [],
    );
    return lcMessagesFrom(updates.length ? updates : v);
  }
  return null;
}
/** LangChain's ToolMessage envelope `{type:"tool", data:{content}}` → its content. */
function unwrapToolMessage(v: unknown): unknown {
  if (
    v &&
    typeof v === "object" &&
    (v as Json).type === "tool" &&
    (v as Json).data &&
    typeof (v as Json).data === "object"
  ) {
    const content = ((v as Json).data as Json).content;
    if (typeof content === "string") return asObj(content);
    if (content !== undefined && content !== null) return content;
  }
  return v;
}
function normalizeMessageContent(m: unknown): unknown {
  if (!m || typeof m !== "object" || Array.isArray(m)) return m;
  const o = m as Json;
  if (typeof o.content === "string") {
    const parsed = asObj(o.content);
    if (parsed !== o.content)
      return { ...o, content: unwrapToolMessage(parsed) };
  }
  return o;
}
function normalizeParsed(value: unknown): unknown {
  const v = unwrapToolMessage(value);
  const lc = decodeLangChain(v);
  if (lc) return lc.map(normalizeMessageContent);
  if (
    Array.isArray(v) &&
    v.some((x) => x && typeof x === "object" && ("role" in x || "content" in x))
  )
    return v.map(normalizeMessageContent);
  if (v && typeof v === "object" && ("role" in v || "content" in v))
    return normalizeMessageContent(v);
  return v;
}
function normalizeIoValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const parsed = asObj(v);
    return parsed === v ? v : toStr(normalizeParsed(parsed));
  }
  return toStr(normalizeParsed(v));
}

// ── input/output resolution (io_field.py) ───────────────────────────────────────
const ioKeys = new Set([
  "tracely.input",
  "langfuse.observation.input",
  "parallax.input",
  "input.value",
  "gen_ai.prompt",
  "input",
  "traceloop.entity.input",
  "ai.prompt",
  "ai.prompt.messages",
  "ai.toolCall.args",
  "tracely.output",
  "langfuse.observation.output",
  "parallax.output",
  "output.value",
  "gen_ai.completion",
  "output",
  "traceloop.entity.output",
  "ai.response.text",
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.toolCall.result",
]);
const messagePrefixes = [
  "llm.input_messages.",
  "llm.output_messages.",
  "gen_ai.prompt.",
  "gen_ai.completion.",
  "retrieval.documents.",
];
const isMessageAttr = (k: string) =>
  ioKeys.has(k) ||
  k === "gen_ai.input.messages" ||
  k === "gen_ai.output.messages" ||
  messagePrefixes.some((p) => k.startsWith(p));

function ioField(a: Attrs, direction: "input" | "output"): string | null {
  const manual = first(a, [
    `parallax.${direction}`,
    `tracely.${direction}`,
    `langfuse.observation.${direction}`,
  ]);
  if (manual !== undefined) return normalizeIoValue(manual);
  if (direction === "output") {
    const docs = retrievalDocuments(a);
    if (docs) return toStr(docs);
  }
  const msgs = ioMessages(a, direction);
  if (msgs && hasText(msgs)) return toStr(normalizeParsed(msgs));
  const fallback =
    direction === "input"
      ? [
          "input.value",
          "gen_ai.prompt",
          "traceloop.entity.input",
          "ai.prompt.messages",
          "ai.prompt",
          "ai.toolCall.args",
          "input",
        ]
      : [
          "output.value",
          "gen_ai.completion",
          "traceloop.entity.output",
          "ai.response.text",
          "ai.response.object",
          "ai.response.toolCalls",
          "ai.toolCall.result",
          "output",
        ];
  const raw = first(a, fallback);
  if (raw === undefined) return null;
  const parsed = asObj(raw);
  if (parsed !== raw || typeof raw !== "string") {
    if (looksLikeMessages(parsed) && !hasText(parsed)) return null;
    return toStr(normalizeParsed(parsed));
  }
  return toStr(raw);
}

// ── span events (span_events.py) ─────────────────────────────────────────────────
type OtlpEvent = { name: string; timeMs: number | null; attrs: Attrs };
const roleEvents: Record<string, string> = {
  "gen_ai.system.message": "system",
  "gen_ai.user.message": "user",
  "gen_ai.assistant.message": "assistant",
  "gen_ai.tool.message": "tool",
};
function eventPayload(a: Attrs): unknown {
  for (const key of ["content", "gen_ai.event.content", "body", "message"])
    if (a[key] !== undefined && a[key] !== null && a[key] !== "")
      return asObj(a[key]);
  return null;
}
function eventsIo(events: OtlpEvent[]): [Json[] | null, Json[] | null] {
  const inputs: Json[] = [];
  const outputs: Json[] = [];
  for (const e of events) {
    if (e.name === "gen_ai.choice") {
      const body = eventPayload(e.attrs);
      const msg =
        body && typeof body === "object" && "message" in (body as Json)
          ? (body as Json).message
          : body;
      if (msg && typeof msg === "object")
        outputs.push({
          role: (msg as Json).role || "assistant",
          ...(msg as Json),
        });
      else if (msg !== null && msg !== "")
        outputs.push({ role: "assistant", content: msg });
    } else if (roleEvents[e.name]) {
      const body = eventPayload(e.attrs);
      const role = String(e.attrs.role ?? roleEvents[e.name]);
      if (body && typeof body === "object")
        inputs.push({ role: (body as Json).role || role, ...(body as Json) });
      else if (body !== null && body !== "")
        inputs.push({ role, content: body });
    }
  }
  return [inputs.length ? inputs : null, outputs.length ? outputs : null];
}
function exceptionText(events: OtlpEvent[]): string {
  for (const e of events) {
    if (e.name !== "exception") continue;
    const type = String(e.attrs["exception.type"] ?? "").trim();
    const message = String(e.attrs["exception.message"] ?? "").trim();
    if (type && message) return `${type}: ${message}`;
    if (type || message) return type || message;
  }
  return "";
}

/** ERROR from the status, a recorded exception, or `error.type`; an explicit OK wins. */
function levelOf(
  status: Json | undefined,
  events: OtlpEvent[],
  a: Attrs,
): ["DEFAULT" | "ERROR", string] {
  const code = String(status?.code ?? "");
  if (code === "2" || code === "STATUS_CODE_ERROR")
    return ["ERROR", String(status?.message || exceptionText(events) || "")];
  if (code === "1" || code === "STATUS_CODE_OK") return ["DEFAULT", ""];
  const exception = exceptionText(events);
  if (exception) return ["ERROR", exception];
  const errorType = first(a, ["error.type"]);
  return errorType ? ["ERROR", String(errorType)] : ["DEFAULT", ""];
}

// ── usage (usage.py) ─────────────────────────────────────────────────────────────
// Only model calls count tokens: a framework callback that stamps usage on an enclosing
// AGENT or CHAIN span would otherwise double-count it against the GENERATION child.
function usage(a: Attrs, type: SpanType): [number | null, number | null] {
  if (type !== "GENERATION" && type !== "EMBEDDING") return [null, null];
  return [
    int(
      first(a, [
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.prompt_tokens",
        "llm.token_count.prompt",
        "ai.usage.promptTokens",
        "ai.usage.inputTokens",
      ]),
    ),
    int(
      first(a, [
        "gen_ai.usage.output_tokens",
        "gen_ai.usage.completion_tokens",
        "llm.token_count.completion",
        "ai.usage.completionTokens",
        "ai.usage.outputTokens",
      ]),
    ),
  ];
}
function invocationModel(a: Attrs): string {
  const params = asObj(a["llm.invocation_parameters"]);
  const model =
    params && typeof params === "object" ? (params as Json).model : undefined;
  return typeof model === "string" ? model.trim() : "";
}

// ── the span mapper (span_mapper.py) ─────────────────────────────────────────────
const maxMetadataValue = 8000;

function mapSpan(resource: Attrs, scope: Json, raw: Json): MappedSpan {
  const a: Attrs = { ...resource, ...attrs(raw.attributes) };
  const traceId = hexId(raw.traceId);
  const spanId = hexId(raw.spanId);
  if (!traceId || !spanId)
    throw new StoreError("Every OTLP span needs a traceId and a spanId");
  const startMs = nanosToMs(raw.startTimeUnixNano);
  if (startMs === null)
    throw new StoreError(`Span ${spanId} has no startTimeUnixNano`);
  const events: OtlpEvent[] = (Array.isArray(raw.events) ? raw.events : []).map(
    (e: Json) => ({
      name: String(e?.name ?? ""),
      timeMs: nanosToMs(e?.timeUnixNano),
      attrs: attrs(e?.attributes),
    }),
  );
  const type = spanType(a);
  const [level, statusMessage] = levelOf(
    raw.status as Json | undefined,
    events,
    a,
  );
  let input = ioField(a, "input");
  let output = ioField(a, "output");
  if (input === null || output === null) {
    const [eventIn, eventOut] = eventsIo(events);
    if (input === null && eventIn) input = toStr(normalizeParsed(eventIn));
    if (output === null && eventOut) output = toStr(normalizeParsed(eventOut));
  }
  const [inputTokens, outputTokens] = usage(a, type);
  const completionStart =
    nanosToMs(first(a, ["tracely.completion_start_time"])) ??
    events.find((e) => e.name === "First Token Stream Event")?.timeMs ??
    null;
  const cost = Number(first(a, ["parallax.cost_usd", "gen_ai.usage.cost"]));
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (isMessageAttr(k)) continue;
    const text = toStr(v) ?? "";
    metadata[k] =
      text.length > maxMetadataValue
        ? `${text.slice(0, maxMetadataValue)}…`
        : text;
  }
  if (scope.name) metadata["otel.scope.name"] = String(scope.name);
  if (scope.version) metadata["otel.scope.version"] = String(scope.version);
  return {
    traceId,
    spanId,
    parentSpanId: hexId(raw.parentSpanId),
    sessionId:
      toStr(
        first(a, [
          "session.id",
          "gen_ai.conversation.id",
          "tracely.conversation.id",
          "tracely.session.id",
          "langfuse.session.id",
        ]),
      ) ?? null,
    experimentId: toStr(first(a, ["parallax.experiment_id"])) ?? null,
    name:
      (type === "TOOL"
        ? toStr(first(a, ["tool.name", "gen_ai.tool.name", "ai.toolCall.name"]))
        : null) || String(raw.name || "span"),
    type,
    level,
    statusMessage,
    startMs,
    endMs: nanosToMs(raw.endTimeUnixNano),
    ttftMs:
      completionStart !== null ? Math.max(0, completionStart - startMs) : null,
    model:
      type === "GENERATION" || type === "EMBEDDING"
        ? String(
            first(a, [
              "gen_ai.response.model",
              "gen_ai.request.model",
              "llm.model_name",
              "llm.openai.model",
              "ai.model.id",
              "embedding.model_name",
            ]) ?? invocationModel(a),
          )
        : "",
    inputTokens,
    outputTokens,
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    input,
    output,
    metadata,
    source: "otlp",
  };
}

/** Walk an ExportTraceServiceRequest in its JSON encoding. */
export function mapOtlpRequest(body: unknown): MappedSpan[] {
  if (!body || typeof body !== "object")
    throw new StoreError("Expected an OTLP ExportTraceServiceRequest");
  const resourceSpans = (body as Json).resourceSpans;
  if (resourceSpans === undefined) return [];
  if (!Array.isArray(resourceSpans))
    throw new StoreError("resourceSpans must be a list");
  const spans: MappedSpan[] = [];
  for (const rs of resourceSpans as Json[]) {
    const resource = attrs((rs?.resource as Json)?.attributes);
    const scopes = (rs?.scopeSpans ??
      rs?.instrumentationLibrarySpans ??
      []) as Json[];
    for (const ss of scopes) {
      const scope = ((ss?.scope ?? ss?.instrumentationLibrary) as Json) ?? {};
      for (const span of (ss?.spans ?? []) as Json[])
        spans.push(mapSpan(resource, scope, span));
    }
  }
  return spans;
}
