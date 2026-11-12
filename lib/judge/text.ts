// What a judge reads from a span: the readable text inside its stored input/output.
// Port of Tracely `domain/evaluation/text.py` and `infrastructure/text.py`. Pure: no I/O.

/** A span as the judge sees it (Tracely's span dict, from a Parallax `TraceSpan`). */
export type JudgeSpan = {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  type: string;
  level: string;
  status_message: string;
  input: string | null;
  output: string | null;
  metadata: Record<string, string>;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const empty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0);

/** The trace's root: the first span whose parent is not in the list. */
export function rootSpan(spans: JudgeSpan[]): JudgeSpan {
  const ids = new Set(spans.map((s) => s.span_id));
  return (
    spans.find((s) => !s.parent_span_id || !ids.has(s.parent_span_id)) ??
    spans[0]
  );
}

/** First human-readable text inside a (possibly nested) message value. */
export function extractText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = extractText(item);
      if (t) return t;
    }
    return "";
  }
  if (isObject(v)) {
    if (typeof v.text === "string") return v.text;
    if (typeof v.content === "string") return v.content;
    if (v.content !== undefined && v.content !== null)
      return extractText(v.content);
  }
  return "";
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
const looksJson = (s: string) => s[0] === "[" || s[0] === "{";

/** Plain strings and structured content (JSON content-block arrays, chat messages). */
export function contentText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return extractText(value);
  const s = value.trim();
  if (looksJson(s)) {
    const parsed = parseJson(s);
    return parsed === undefined ? value : extractText(parsed) || value;
  }
  return value;
}

const userRoles = new Set(["user", "human"]);
// Everything that is plainly not the person who talks to the agent. A framework that calls the
// human `customer` still resolves: the rule is "the last message that is not the agent's".
const nonUserRoles = new Set([
  "assistant",
  "ai",
  "system",
  "tool",
  "function",
  "developer",
  "model",
]);

/** `value` as a list of chat messages, or [] when it is not one. */
export function chatMessages(value: unknown): Json[] {
  if (typeof value === "string") {
    const s = value.trim();
    if (!looksJson(s)) return [];
    value = parseJson(s);
    if (value === undefined) return [];
  }
  if (isObject(value) && Array.isArray(value.messages)) value = value.messages;
  if (isObject(value)) value = [value];
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is Json => isObject(m) && !!(m.role || m.type));
}

const roleOf = (m: Json) => String(m.role || m.type || "").toLowerCase();

function lastUserText(value: unknown): string {
  const msgs = chatMessages(value);
  for (const knownOnly of [true, false])
    for (const m of [...msgs].reverse()) {
      const role = roleOf(m);
      if (knownOnly ? userRoles.has(role) : !nonUserRoles.has(role)) {
        const text = contentText("content" in m ? m.content : m);
        if (text) return text;
      }
    }
  return "";
}

/** JSON re-serialized with real characters instead of `\u` escapes. */
function unescapedJson(text: string): string {
  const s = text.trim();
  if (!looksJson(s) || !s.includes("\\u")) return text;
  const parsed = parseJson(s);
  return parsed === undefined ? text : JSON.stringify(parsed);
}

/** A message's tool calls as `name(arguments)`, comma-joined; "" when it has none. */
function toolCallsText(message: Json): string {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls
    .filter(isObject)
    .map((c) => {
      const fn = isObject(c.function) ? c.function : {};
      const args = fn.arguments || c.arguments || "";
      return `${fn.name || c.name || "tool"}(${typeof args === "string" ? args : JSON.stringify(args)})`;
    })
    .join(", ");
}

function messageText(message: Json): string {
  let text = empty(message.content) ? "" : contentText(message.content);
  const calls = toolCallsText(message);
  if (calls) text = `${text}\n[calls ${calls}]`.trim();
  return text;
}

/** A span's I/O for a judge: a chat message list as `role: text` lines (tool calls included),
 *  a single message as its text, anything else as-is. Nothing is dropped or cut. */
export function readableIo(value: unknown): string {
  const msgs = chatMessages(value);
  if (!msgs.length) return unescapedJson(contentText(value));
  if (msgs.length === 1)
    return messageText(msgs[0]) || unescapedJson(contentText(value));
  const lines: string[] = [];
  for (const m of msgs) {
    const text = messageText(m);
    if (text) lines.push(`${roleOf(m) || "?"}: ${text}`);
  }
  return lines.join("\n") || unescapedJson(contentText(value));
}

// One rule: a turn's user message is what the root span received, and its answer is what the
// root span returned. When the root carries nothing readable, the judge is told so.
export const NO_USER_MESSAGE =
  "(no user message recorded on this turn's root span)";
export const NO_ANSWER = "(no answer recorded on this turn's root span)";

/** The user's message on this turn: the last user message of the root input when it is a chat
 *  message list, otherwise the root input as text. */
export function userMessage(root: JudgeSpan): string {
  const text = lastUserText(root.input);
  if (text) return text;
  if (chatMessages(root.input).length) return "";
  return contentText(root.input).trim();
}

/** The agent's answer on this turn: the root output as text. A chat-shaped output is read as its
 *  last message; a reply that is only a tool call is shown as that call. */
export function agentAnswer(root: JudgeSpan): string {
  const msgs = chatMessages(root.output);
  if (msgs.length) {
    const last = msgs[msgs.length - 1];
    const text = empty(last.content) ? "" : contentText(last.content);
    if (text) return text;
    const calls = toolCallsText(last);
    return calls ? `[no text reply — the agent called ${calls}]` : "";
  }
  return contentText(root.output).trim();
}
