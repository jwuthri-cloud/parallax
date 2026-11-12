// Every string the judge sends about an item. Port of Tracely `evaluators/prompts.py`.
//
// - SYSTEM prompt = the column's rubric, unchanged for every item.
// - USER message = the item: `turnLines` (conversation), `messageBody` (message), `stepBody`
//   (step), plus the earlier items in sequential mode and the results of the columns in
//   Depends On.
// Nothing is cut: what the span recorded is what the judge reads. An item that is too long for
// the model goes to the fallback model or is skipped with a visible reason (budget.ts).
import {
  NO_ANSWER,
  NO_USER_MESSAGE,
  agentAnswer,
  contentText,
  readableIo,
  rootSpan,
  userMessage,
  type JudgeSpan,
} from "./text";

/** The system prompt of an advanced (template) grade. The resolved template is the rubric and
 *  the context, and it arrives as the user message. */
export const ADVANCED_SYSTEM =
  "You are an evaluator. Follow the instructions in the message exactly and return the " +
  "structured verdict you are asked for — nothing else.";

/** The thread's spans grouped into traces (turns), oldest first. */
export function byTrace(spans: JudgeSpan[]): JudgeSpan[][] {
  const grouped = new Map<string, JudgeSpan[]>();
  for (const s of spans) {
    const list = grouped.get(s.trace_id);
    if (list) list.push(s);
    else grouped.set(s.trace_id, [s]);
  }
  return [...grouped.values()];
}

/** One message as the judge reads it: user request and final answer. Empty only when there is
 *  neither. `includeAnswer: false` sends the user message alone (intent columns). */
export function messageBody(spans: JudgeSpan[], includeAnswer = true): string {
  const root = rootSpan(spans);
  const userIn = userMessage(root);
  if (!includeAnswer) return userIn ? `User message:\n${userIn}` : "";
  const answer = agentAnswer(root);
  if (!answer && !userIn) return "";
  return `User request:\n${userIn || NO_USER_MESSAGE}\n\nAgent answer:\n${answer || NO_ANSWER}`;
}

/** One step: the turn's user message, then `Step i of n` with its input, output and error. */
export function stepBody(
  candidates: JudgeSpan[],
  i: number,
  userRequest = "",
): string {
  const s = candidates[i];
  const head = userRequest ? `User request:\n${userRequest}\n\n` : "";
  let body =
    head +
    `Step ${i + 1} of ${candidates.length} — ${s.type} \`${s.name}\`\n` +
    `Step input:\n${readableIo(s.input)}\n\n` +
    `Step output:\n${readableIo(s.output)}`;
  const err = s.status_message.trim();
  if (err || s.level.toUpperCase() === "ERROR")
    body += `\n\nStep error:\n${err || "(failed, no error message)"}`;
  return body;
}

/** One earlier step, as a sequential judge sees it. Output over input. */
export function stepLine(span: JudgeSpan, n: number): string {
  const body = contentText(span.output) || contentText(span.input);
  return `${n}. ${span.type} \`${span.name}\`: ${body}`;
}

/** The thread as `Turn n — user/agent` lines, oldest first. `stopBefore` cuts it at that trace,
 *  so a sequential message judge sees the turns before the message it grades. */
export function turnLines(spans: JudgeSpan[], stopBefore = ""): string[] {
  const lines: string[] = [];
  byTrace(spans).some((traceSpans, index) => {
    if (stopBefore && traceSpans[0].trace_id === stopBefore) return true;
    const root = rootSpan(traceSpans);
    const userIn = userMessage(root);
    const answer = agentAnswer(root);
    if (userIn) lines.push(`Turn ${index + 1} — user: ${userIn}`);
    if (answer) lines.push(`Turn ${index + 1} — agent: ${answer}`);
    return false;
  });
  return lines;
}
