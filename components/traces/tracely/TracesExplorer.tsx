"use client";

import clsx from "./clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionsPage, type AgentRow, type ConvNode, type SessionSort } from "./lib/api";
import { PRESETS, paramsFromView, queryFromView, viewFromParams, type SortBy, type View } from "./lib/tracesView";
import { AgentPicker } from "./AgentPicker";
import { DateRangePicker } from "./DateRangePicker";
import { TraceTable } from "./TraceTable";
import { listHref } from "./links";

/** The `#traces?…` hash's query part as params. */
export function hashParams(): Record<string, string> {
  const query = window.location.hash.split("?")[1] ?? "";
  return Object.fromEntries(new URLSearchParams(query).entries());
}

// The traces landing: every filter — time range, model, experiment, sort, status, multi-turn,
// text — is a server query over the whole thread set, never a pass over the rows on screen, so a
// match past the loaded page is found and the count, the empty state and the pages describe one
// result set. The view lives in the URL hash (shareable); responses are sequenced so a slow older
// query can never overwrite a newer one. (Parallax: the first page loads on mount rather than
// server-side, and delete is not offered.)
export function TracesExplorer({
  pageSize,
  models,
  experiments,
  emptyHint,
}: {
  pageSize: number;
  /** Parallax facets for the Model and Experiment pickers (AgentPicker rows). */
  models: AgentRow[];
  experiments: AgentRow[];
  emptyHint: string;
}) {
  const [view, setView] = useState<View>(() => viewFromParams(hashParams()));
  const [rows, setRows] = useState<ConvNode[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [qText, setQText] = useState(view.q);
  const seq = useRef(0); // the newest request wins; anything older is dropped on arrival

  const fetchPage = useCallback(
    async (v: View, offset: number, replace: boolean, limit = pageSize) => {
      const mine = ++seq.current;
      setLoading(true);
      setError("");
      try {
        const page = await getSessionsPage({ ...queryFromView(v), limit, offset });
        if (mine !== seq.current) return; // a newer filter change already superseded this
        setRows((prev) => (replace ? page.items : [...prev, ...page.items]));
        setHasMore(offset + page.items.length < page.total);
        setTotal(page.total);
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : "request failed");
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [pageSize],
  );

  // One entry point for every view change: state, URL (replace — filters are not history), query.
  const apply = useCallback(
    (next: View) => {
      setView(next);
      window.history.replaceState(null, "", listHref(paramsFromView(next)));
      void fetchPage(next, 0, true);
    },
    [fetchPage],
  );

  // First page on mount; then follow the hash when the browser moves it (back/forward, a link).
  useEffect(() => {
    void fetchPage(view, 0, true);
    const follow = () => {
      if (!window.location.hash.startsWith("#traces") || window.location.hash.startsWith("#traces/")) return;
      const fromUrl = viewFromParams(hashParams());
      setView(fromUrl);
      setQText(fromUrl.q);
      void fetchPage(fromUrl, 0, true);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text filter: debounced, then a server query like every other filter.
  useEffect(() => {
    if (qText === view.q) return;
    const t = setTimeout(() => apply({ ...view, q: qText.trim().slice(0, 200) }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qText]);

  const onSort = useCallback(
    (key: SessionSort) => {
      const next: SortBy =
        key === view.sortBy.sort
          ? { sort: key, order: view.sortBy.order === "desc" ? "asc" : "desc" }
          : { sort: key, order: "desc" };
      apply({ ...view, sortBy: next });
    },
    [apply, view],
  );

  function applyPreset(p: (typeof PRESETS)[number]) {
    apply({
      ...view,
      preset: p.key,
      range: { from: p.hours == null ? null : new Date(Date.now() - p.hours * 3_600_000).toISOString(), to: null },
    });
  }

  function applyCustom(from: string | null, to: string | null) {
    if (!from && !to) return applyPreset(PRESETS[0]);
    apply({ ...view, preset: "custom", range: { from, to } });
  }

  const filtered =
    view.range.from != null || view.range.to != null || view.model !== "" || view.experimentId !== "" || view.filter !== "all" || view.q !== "";
  const picker = (
    label: string,
    rows: AgentRow[],
    value: string,
    onChange: (v: string) => void,
    allLabel: string,
  ) =>
    rows.length > 0 && (
      <>
        <span className="h-5 w-px bg-line" aria-hidden />
        <label className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-faint">{label}</span>
          <AgentPicker
            agents={rows}
            value={value}
            onChange={onChange}
            allLabel={allLabel}
            ariaLabel={`Filter by ${label.toLowerCase()}`}
            id={`traces-${label.toLowerCase()}`}
            disabled={loading}
            className="w-52 rounded-lg border border-line bg-ink-800 px-2 py-1.5 font-mono text-[12px] text-fg placeholder:text-fg-faint transition-colors focus:border-signal/40 focus:outline-none disabled:opacity-50"
          />
        </label>
      </>
    );
  const shareUrl = paramsFromView(view);

  return (
    <div className="space-y-3">
      <div className="reveal flex flex-wrap items-center gap-2" suppressHydrationWarning>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-faint">Range</span>
        <div className="flex items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p)}
              disabled={loading}
              className={clsx(
                "rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50",
                view.preset === p.key ? "border-signal/50 bg-signal/15 text-signal" : "border-line bg-ink-800 text-fg-muted hover:text-fg",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="h-5 w-px bg-line" aria-hidden />
        <DateRangePicker
          from={view.preset === "custom" ? view.range.from : null}
          to={view.preset === "custom" ? view.range.to : null}
          disabled={loading}
          onApply={applyCustom}
        />
        {picker("Model", models, view.model, (model) => apply({ ...view, model }), "All models")}
        {picker("Experiment", experiments, view.experimentId, (experimentId) => apply({ ...view, experimentId }), "All experiments")}
      </div>

      {/* Status + text filters — server-side over the whole set, like the range. */}
      <div className="reveal flex flex-wrap items-center justify-between gap-3" style={{ animationDelay: "60ms" }} suppressHydrationWarning>
        <div className="flex items-center gap-1.5" role="group" aria-label="Status filter">
          {(["all", "failing", "multi"] as const).map((f) => (
            <button
              key={f}
              onClick={() => apply({ ...view, filter: f })}
              disabled={loading}
              aria-pressed={view.filter === f}
              className={clsx(
                "rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50",
                view.filter !== f ? "border-line bg-ink-800 text-fg-muted hover:text-fg" : "border-signal/50 bg-signal/15 text-signal",
              )}
            >
              {f === "all" ? "All" : f === "failing" ? "Failing" : "Multi-turn"}
            </button>
          ))}
          <span className="ml-2 font-mono text-[10.5px] text-fg-faint" aria-live="polite">
            {total == null ? "" : `${total.toLocaleString("en-US")} matching`}
          </span>
        </div>
        <input
          value={qText}
          onChange={(e) => setQText(e.target.value)}
          placeholder="Search input, answer, model, metadata, id…"
          aria-label="Search conversations"
          className="w-64 rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-[12.5px] text-fg placeholder:text-fg-faint focus:border-signal/40 focus:outline-none"
          suppressHydrationWarning
        />
      </div>

      {error && <div className="card border-fail/30 px-4 py-3 text-[12.5px] text-fail">{error}</div>}
      {rows.length === 0 ? (
        <div className="card px-4 py-14 text-center text-[13px] text-fg-faint">
          {loading ? (
            "Loading…"
          ) : filtered ? (
            <>No conversations match these filters across the whole workspace{total === 0 ? "" : ` (${total ?? 0} counted)`} — clear a filter or widen the range.</>
          ) : (
            emptyHint
          )}
        </div>
      ) : (
        <div className="reveal space-y-3" style={{ animationDelay: "80ms" }}>
          <TraceTable conversations={rows} sort={{ ...view.sortBy, onSort, busy: loading }} />
          <div className="flex items-center justify-center gap-3 pt-1">
            {hasMore ? (
              <button
                onClick={() => void fetchPage(view, rows.length, false)}
                disabled={loading}
                className="rounded-lg border border-line bg-ink-800 px-4 py-2 text-[12.5px] font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            ) : null}
            <span className="font-mono text-[10.5px] text-fg-faint">
              {rows.length} of {total ?? "?"} loaded
            </span>
            {shareUrl && (
              <a href={listHref(shareUrl)} className="font-mono text-[10.5px] text-fg-faint hover:text-signal" title="This URL reproduces the current view">
                link to this view
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
