import type { ConvNode, FullTurn } from "./api";

/** One verdict for the whole thread: FAIL if anything failed, PASS if anything passed, null
 *  when nothing has been graded. Mirrors Tracely's `conversationVerdict`.
 *  Parallax: a turn's `verdict` is already the roll-up of its non-advisory judge columns, and
 *  `failing` means "has an error span" here, so it does not count as a failed evaluation. */
export function conversationVerdict(conv: ConvNode, turns: FullTurn[]): "PASS" | "FAIL" | null {
  const verdicts = [...turns.map((t) => t.verdict), ...(conv.scores ?? []).map((s) => s.verdict)];
  return verdicts.includes("FAIL") ? "FAIL" : verdicts.includes("PASS") ? "PASS" : null;
}
