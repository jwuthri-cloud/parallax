// Parallax change: Tracely routes are pages (/traces/:id, /sessions/:id); in Parallax the Traces
// tab lives in the URL hash of the workspace page, so every link goes through these helpers.
export const traceHref = (id: string) => `#traces/trace/${encodeURIComponent(id)}`;
/** The four lenses of a conversation. Table is the default and has no suffix. */
export type ConvView = "table" | "timeline" | "replay" | "fleet";
export const sessionHref = (id: string, view: ConvView = "table") =>
  `#traces/session/${encodeURIComponent(id)}${view === "table" ? "" : `/${view}`}`;
export const listHref = (query = "") => `#traces${query ? `?${query}` : ""}`;
/** The Evaluators page: every judge column and the OpenRouter key. */
export const evaluatorsHref = () => "#traces/evaluators";
export function go(href: string) {
  window.location.hash = href;
}
