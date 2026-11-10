"use client";

import clsx from "../clsx";
import type { SessionSort, SortOrder } from "../lib/api";
import { TypeChip } from "../ui";
import { type Col, CTRL, HEAD_TH, LEVEL_BADGE, SORTABLE } from "./columns";
import { CTRL_CELLS } from "./contexts";

/** How the table asks its owner to re-sort. Lives here, with the header that renders it, so the
 *  header module does not have to import a type back out of the root component. */
export type SortHandle = {
  sort: SessionSort;
  order: SortOrder;
  onSort: (key: SessionSort) => void;
  busy?: boolean;
};

// The header row and the menus that hang off it: column visibility and the step-type filter.

// ── column-visibility menu ──────────────────────────────────────────────────────
export function ColumnsMenu({ all, hidden, onToggle, onClose }: { all: Col[]; hidden: Set<string>; onToggle: (k: string) => void; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-line bg-ink-900 p-2 shadow-xl shadow-ink-950/50">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-faint">Toggle columns</div>
        <div className="max-h-72 overflow-auto">
          {all.map((col) => (
            <label key={col.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg hover:bg-ink-700">
              <input type="checkbox" checked={!hidden.has(col.key)} onChange={() => onToggle(col.key)} className="accent-signal" />
              <span className="truncate">{col.label}</span>
              <span className={clsx("ml-auto rounded px-1 text-[10px] font-medium", LEVEL_BADGE[col.group])}>{col.group}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// ── step-type filter menu ────────────────────────────────────────────────────────
// Hide noisy span types (e.g. the many CHAIN spans some frameworks emit) from the step rows.
export function TypesMenu({ types, hidden, onToggle, onReset, onClose }: {
  types: string[]; hidden: Set<string>;
  onToggle: (t: string) => void; onReset: () => void; onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-line bg-ink-900 p-2 shadow-xl shadow-ink-950/50">
        <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wider text-fg-faint">
          <span>Filter step types</span>
          {hidden.size > 0 && (
            <button onClick={onReset} className="rounded px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-signal hover:bg-ink-700 hover:text-signal" title="Show all types">
              Reset
            </button>
          )}
        </div>
        <div className="max-h-72 overflow-auto">
          {types.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg hover:bg-ink-700">
              <input type="checkbox" checked={!hidden.has(t)} onChange={() => onToggle(t)} className="accent-signal" />
              <TypeChip type={t} />
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// ── header ──────────────────────────────────────────────────────────────────────
/** Sort affordance on a C-group header. Inactive columns show a muted glyph on hover only, so the
 *  header row stays quiet until you go looking for it. */
function SortGlyph({ active, order }: { active: boolean; order: SortOrder }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "font-mono text-[9px] leading-none transition-opacity",
        active ? "text-signal opacity-100" : "text-fg-faint opacity-0 group-hover:opacity-60",
      )}
    >
      {active && order === "asc" ? "▲" : "▼"}
    </span>
  );
}

export function HeaderRow({ cols, sort }: { cols: Col[]; sort?: SortHandle }) {
  return (
    <tr className="border-b border-line bg-ink-700">
      {Array.from({ length: CTRL_CELLS }, (_, i) => (
        <th key={`ctrl-${i}`} style={CTRL} className={HEAD_TH} />
      ))}
      {cols.map((col, i) => {
        // Sorting reorders the whole list server-side, so it is only offered where the parent owns
        // the query (the /traces list). Embedded and shared views get plain headers.
        const sortKey = sort ? SORTABLE[col.key] : undefined;
        const active = sortKey !== undefined && sort!.sort === sortKey;
        const label = <span>{col.label}</span>;
        return (
          <th
            key={col.key}
            style={{ width: col.width, minWidth: 80 }}
            aria-sort={active ? (sort!.order === "asc" ? "ascending" : "descending") : undefined}
            className={clsx(
              HEAD_TH,
              i > 0 && cols[i - 1].group !== col.group && "border-l border-line-bright/60",
            )}
          >
            <div className="flex items-center gap-1">
              {sortKey ? (
                <button
                  type="button"
                  onClick={() => sort!.onSort(sortKey)}
                  disabled={sort!.busy}
                  title={`Sort every conversation by ${col.label.toLowerCase()}${active ? (sort!.order === "desc" ? " (ascending)" : " (descending)") : ""}`}
                  className={clsx(
                    "group -mx-1 flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider transition-colors hover:bg-ink-600 disabled:opacity-50",
                    active ? "text-signal" : "text-fg-muted hover:text-fg",
                  )}
                >
                  {label}
                  <SortGlyph active={active} order={sort!.order} />
                </button>
              ) : (
                label
              )}
              <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-medium", LEVEL_BADGE[col.group])}>{col.group}</span>
            </div>
          </th>
        );
      })}
    </tr>
  );
}

