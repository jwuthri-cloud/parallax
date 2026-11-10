// Token + cost usage derivation, shared by the trace table and the detail-page headers.
// Parallax change: cost is only what the producer reported. Tracely's list-price estimate is
// removed, because Parallax never records estimated numbers as results.
import type { ConvNode, FullTurn, SpanOut } from "./api";

export function round(n: number, d = 6): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function pickNum(md: Record<string, string>, keys: string[]): number | undefined {
  for (const k of keys) {
    if (md[k] != null) {
      const n = Number(md[k]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return undefined;
}
export function spanUsage(span: SpanOut): Record<string, number> {
  const md = span.metadata || {};
  const u: Record<string, number> = {};
  // Accept OpenInference's `llm.token_count.*` alongside `gen_ai.usage.*` / OpenLLMetry keys — else
  // the detail view (which reads per-span metadata) shows no input/output breakdown for LangChain etc.
  const it = pickNum(md, ["gen_ai.usage.input_tokens", "input_tokens", "prompt_tokens", "llm.token_count.prompt"]);
  const ot = pickNum(md, ["gen_ai.usage.output_tokens", "output_tokens", "completion_tokens", "llm.token_count.completion"]);
  const tt = pickNum(md, ["gen_ai.usage.reasoning_tokens", "thinking_tokens", "reasoning_tokens", "llm.token_count.completion_details.reasoning"]);
  if (it != null) u.input_tokens = it;
  if (ot != null) u.output_tokens = ot;
  if (tt != null) u.thinking_tokens = tt;
  // Prompt-cache breakdown. A subset of the input count on some providers (OpenAI folds cached
  // reads into prompt_tokens) but *not* others (Anthropic reports them beside input_tokens), so
  // like thinking_tokens it's surfaced on its own and kept out of the total. Only shown when > 0 —
  // a cache-enabled call that misses reports 0 on every span.
  const cr = pickNum(md, ["gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cached_input_tokens", "cache_read_input_tokens", "cached_tokens", "llm.token_count.prompt_details.cache_read"]);
  const cw = pickNum(md, ["gen_ai.usage.cache_creation_input_tokens", "cache_creation_input_tokens", "llm.token_count.prompt_details.cache_write"]);
  if (cr) u.cached_tokens = cr;
  if (cw) u.cache_write_tokens = cw;
  // total = input + output (matches the backend token total, which excludes reasoning tokens);
  // thinking_tokens is surfaced separately.
  // Trust the input+output breakdown over any stored aggregate: a producer that reports total AND
  // its components gets them summed into `tokens` (double-count), so prefer it+ot when both exist;
  // fall back to the aggregate/total only when the components aren't both present.
  const total =
    it != null && ot != null
      ? it + ot
      : span.tokens || pickNum(md, ["gen_ai.usage.total_tokens", "llm.token_count.total"]) || (it || 0) + (ot || 0);
  if (total > 0) u.total_tokens = total;
  const ip = pickNum(md, ["input_price", "input_cost"]);
  const op = pickNum(md, ["output_price", "output_cost"]);
  if (ip != null) u.input_price = ip;
  if (op != null) u.output_price = op;
  const cost = span.cost || (ip || 0) + (op || 0);
  if (cost > 0) u.cost = round(cost);
  return u;
}
function sumUsages(items: Array<Record<string, number>>): Record<string, number> {
  const agg: Record<string, number> = {};
  for (const u of items) for (const k in u) agg[k] = round((agg[k] || 0) + u[k]);
  return agg;
}
// Build a usage breakdown from aggregate token counts and the reported cost.
function usageFrom(it: number, ot: number, total: number, cost: number): Record<string, number> {
  const u: Record<string, number> = {};
  if (it) u.input_tokens = it;
  if (ot) u.output_tokens = ot;
  const tot = it && ot ? it + ot : total || it + ot; // prefer the breakdown over a possibly-doubled total
  if (tot) u.total_tokens = tot;
  if (cost) u.cost = round(cost);
  return u;
}
// Turn usage = exact per-span aggregation when steps are loaded, else from the turn's totals.
export function turnUsage(turn: FullTurn): Record<string, number> {
  if (turn.spans?.length) {
    const agg = sumUsages(turn.spans.map(spanUsage));
    if (Object.keys(agg).length) return agg;
  }
  return usageFrom(turn.input_tokens ?? 0, turn.output_tokens ?? 0, turn.tokens, turn.cost);
}
// Conversation usage = sum of its turns when loaded, else from the thread's totals.
export function convUsage(conv: ConvNode): Record<string, number> {
  if (conv.turnsData?.length) {
    const agg = sumUsages(conv.turnsData.map(turnUsage));
    if (Object.keys(agg).length) return agg;
  }
  return usageFrom(conv.input_tokens ?? 0, conv.output_tokens ?? 0, conv.tokens, conv.cost);
}
export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  return n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`;
}
export function usageSummary(u: Record<string, number>): string {
  const parts: string[] = [];
  const tok = u.total_tokens ?? (u.input_tokens || 0) + (u.output_tokens || 0);
  if (tok) parts.push(`${tok.toLocaleString("en-US")} tok`);
  if (u.cost) parts.push(fmtUsd(u.cost));
  return parts.join(" · ") || "usage";
}
