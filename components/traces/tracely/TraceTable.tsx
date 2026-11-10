"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConvNode, SpanOut } from "./lib/api";
import { useHiddenTypes } from "./lib/typePrefs";
import { useWide, WideToggle, WIDE_STYLE } from "./lib/useWide";
import { spanHasState } from "./state-fold";
import { useConversationTree } from "./trace-table/useConversationTree";
import { type Col, COLUMNS, KNOWN_SPAN_TYPES, PREFS_KEY } from "./trace-table/columns";
import { ChevronsUpDown, Eye, FilterIcon } from "./trace-table/icons";
import { normalizeType } from "./ui";
import { CTRL_CELLS } from "./trace-table/contexts";
import { ColumnsMenu, HeaderRow, TypesMenu, type SortHandle } from "./trace-table/header";
import { ConvRows } from "./trace-table/rows";

// ── A TurnWise-style hierarchical spreadsheet over Tracely's real tree ─────────
//   Conversation (thread)  →  Message (turn, split user / assistant)  →  Step (span)
// A real <table> with C / M / S column groups, depth-coloured rows, inline JSON +
// usage pills (→ floating popover) and smart multimodal message content. Two modes:
//   • "list"   — conversation summaries; turns + spans lazy-load on expand.
//   • "detail" — full tree seeded (turnsData populated); everything pre-open.

// ── lucide-style icons ─────────────────────────────────────────────────────────
// Icons + the shared `svg()` helper live in ./trace-table/icons.tsx (imported above).

// Column shape + constants + KNOWN_SPAN_TYPES live in ./trace-table/columns.ts (imported above).

// ── format helpers ──────────────────────────────────────────────────────────────
// usage / cost derivation (spanUsage / turnUsage / convUsage / usageSummary / fmtUsd) lives in
// ../lib/usage so the detail-page headers can reuse the exact same logic.

// ── root ────────────────────────────────────────────────────────────────────────

/** Sorting is owned by whoever runs the query, because it happens server-side across the whole
 *  list rather than over the loaded page. The table only renders the affordance and reports clicks. */
export type { SortHandle } from "./trace-table/header";

export function TraceTable({
  conversations,
  embedded = false,
  sort,
  onSelectSpan,
}: {
  conversations: ConvNode[];
  // When embedded in a tabbed trace view, the parent owns the Enlarge/Concise control + the
  // full-width breakout (so it applies across Table/Timeline), so we suppress ours.
  embedded?: boolean;
  // Passing this makes the C-group headers clickable. Omitted (embedded views) they render
  // as plain labels — those views show one conversation, so there is nothing to order.
  sort?: SortHandle;
  /** Parallax: a step-row click opens that step in the Timeline (detail pages). */
  onSelectSpan?: (span: SpanOut) => void;
}) {
  // What is open and what has been fetched — see trace-table/useConversationTree.ts.
  const { turns, spans, openConv, openTurn, toggleConv, toggleTurn, toggleAll, allOpen } =
    useConversationTree(conversations);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const { hidden: hiddenTypes, toggle: toggleType, reset: resetTypes } = useHiddenTypes();
  const [colMenu, setColMenu] = useState(false);
  const [typeMenu, setTypeMenu] = useState(false);
  const [wide, setWide] = useWide();

  const anyState = useMemo(
    () => Object.values(spans).some((list) => Array.isArray(list) && list.some(spanHasState)),
    [spans],
  );

  // Drop the State Δ columns entirely when nothing loaded carries state — a project that sends
  // none would otherwise get two permanently-empty columns it never asked for. They appear as
  // soon as a conversation with state is expanded.
  const allColumns = useMemo<Col[]>(
    () => (anyState ? COLUMNS : COLUMNS.filter((c) => c.key !== "mstate" && c.key !== "sstate")),
    [anyState],
  );
  const cols = useMemo(() => allColumns.filter((c) => !hidden.has(c.key)), [allColumns, hidden]);

  // Types listed in the filter menu: the canonical set (always) plus any extra types the current
  // data emits (so SDK additions show up automatically). Canonical order first, extras alphabetical.
  const spanTypes = useMemo(() => {
    const present = new Set<string>();
    const add = (arr?: SpanOut[]) => arr?.forEach((s) => s.type && present.add(normalizeType(s.type)));
    Object.values(spans).forEach((v) => Array.isArray(v) && add(v));
    conversations.forEach((c) => c.turnsData?.forEach((t) => add(t.spans)));
    const canonical = new Set<string>(KNOWN_SPAN_TYPES);
    const extras = [...present].filter((t) => !canonical.has(t)).sort();
    return [...KNOWN_SPAN_TYPES, ...extras];
  }, [spans, conversations]);

  // Restore saved view prefs on mount, then persist on change (skip writes until loaded so the
  // initial defaults don't clobber what's stored).
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { hidden?: unknown };
        if (Array.isArray(p.hidden)) setHidden(new Set(p.hidden as string[]));
      }
    } catch {
      /* ignore */
    }
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      // Read-modify-write so we don't clobber the hiddenTypes field owned by useHiddenTypes().
      const raw = localStorage.getItem(PREFS_KEY);
      const cur = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...cur, hidden: [...hidden] }));
    } catch {
      /* ignore */
    }
  }, [prefsLoaded, hidden]);

  function toggleCol(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div
        style={!embedded && wide ? WIDE_STYLE : undefined}
        className="overflow-hidden rounded-lg border border-line transition-[width,margin] duration-200"
      >
        <div className="flex items-center justify-between border-b border-line bg-ink-700/50 px-4 py-2">
          <div className="flex items-center gap-1">
            <button onClick={toggleAll} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-ink-700 hover:text-fg">
              <ChevronsUpDown className="h-3.5 w-3.5" />
              <span>{allOpen ? "Collapse All" : "Expand All"}</span>
            </button>
          </div>
          <div className="flex items-center gap-1">
            {!embedded && <WideToggle wide={wide} onToggle={() => setWide(!wide)} />}
            <div className="relative">
              <button onClick={() => setTypeMenu((o) => !o)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-ink-700 hover:text-fg" title="Filter step types">
                <FilterIcon className="h-3.5 w-3.5" />
                <span>Types</span>
                {hiddenTypes.size > 0 && <span className="rounded bg-signal/20 px-1.5 text-[10px] font-medium text-signal">{hiddenTypes.size}</span>}
              </button>
              {typeMenu && (
                <TypesMenu types={spanTypes} hidden={hiddenTypes}
                  onToggle={toggleType} onReset={resetTypes}
                  onClose={() => setTypeMenu(false)} />
              )}
            </div>
            <div className="relative">
              <button onClick={() => setColMenu((o) => !o)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-ink-700 hover:text-fg" title="Manage Column Visibility">
                <Eye className="h-3.5 w-3.5" />
                <span>Columns</span>
              </button>
              {colMenu && <ColumnsMenu all={allColumns} hidden={hidden} onToggle={toggleCol} onClose={() => setColMenu(false)} />}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] border-collapse">
            <thead>
              <HeaderRow cols={cols} sort={sort} />
            </thead>
            <tbody>
              {conversations.length === 0 ? (
                <tr>
                  <td colSpan={CTRL_CELLS + cols.length} className="px-6 py-14 text-center text-sm text-fg-faint">
                    No conversations.
                  </td>
                </tr>
              ) : (
                conversations.map((c) => (
                  <ConvRows
                    key={c.thread}
                    conv={c}
                    turns={turns[c.thread]}
                    spansCache={spans}
                    open={openConv.has(c.thread)}
                    openTurn={openTurn}
                    cols={cols}
                    hiddenTypes={hiddenTypes}
                    onToggleConv={toggleConv}
                    onToggleTurn={toggleTurn}
                    onSelectSpan={onSelectSpan}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
