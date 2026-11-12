// Context-window budget for judge calls. Port of Tracely `domain/evaluation/budget.py`. Pure.
//
// Before a call the judge asks `fits()`. An item that does not fit is graded by the column's
// fallback model, or recorded as skipped. Nothing is cut to fit: a verdict on half an item is a
// wrong verdict that looks right.
//
// The estimate is a LOWER bound (8 bytes per token, below what real text reaches). When even
// the lower bound is over the limit, the item certainly does not fit and no call is made. A
// closer item is sent, and the provider's own rejection is the exact check.
export type ModelInfo = {
  id: string;
  kind: "llm" | "decision";
  context_tokens: number | null;
};

const BYTES_PER_TOKEN_FLOOR = 8;

export function estimateTokens(
  ...parts: (string | null | undefined)[]
): number {
  const bytes = parts.reduce((n, p) => n + Buffer.byteLength(p ?? ""), 0);
  return Math.ceil(bytes / BYTES_PER_TOKEN_FLOOR);
}

/** Whether a prompt fits the model. A decision model's budget is input only; an LLM's context
 *  holds the prompt and the completion. An unknown context never blocks. */
export function fits(
  info: ModelInfo,
  promptTokens: number,
  reservedOutput = 0,
): boolean {
  if (!info.context_tokens) return true;
  if (info.kind === "decision") return promptTokens <= info.context_tokens;
  return promptTokens + Math.max(reservedOutput, 0) <= info.context_tokens;
}

/** `32000` → `32k`. */
export function k(n: number): string {
  return n >= 1000
    ? `${(n / 1000).toFixed(1)}k`.replace(".0k", "k")
    : String(n);
}

/** The sentence a skipped cell shows. */
export function overflowNote(promptTokens: number, info: ModelInfo): string {
  return (
    `Input is over ${k(promptTokens)} tokens, past the ${k(info.context_tokens ?? 0)} context of ${info.id}. ` +
    "Set a fallback model on this column to grade long items."
  );
}
