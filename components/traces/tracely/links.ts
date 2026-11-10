// Parallax change: Tracely routes are pages (/traces/:id, /sessions/:id); in Parallax the Traces
// tab lives in the URL hash of the workspace page, so every link goes through these helpers.
export const traceHref = (id: string) => `#traces/trace/${encodeURIComponent(id)}`;
export const sessionHref = (id: string) => `#traces/session/${encodeURIComponent(id)}`;
export const listHref = (query = "") => `#traces${query ? `?${query}` : ""}`;
export function go(href: string) {
  window.location.hash = href;
}
