"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import type { EvalScore } from "../lib/api";
import type { EvaluatorDef } from "../lib/evaluators";

// The contexts the table's cells read instead of taking props. Rows nest four deep
// (conversation → turn → span → cell), so threading run state and live scores down by hand meant
// every intermediate row re-rendering on any change. They live here, apart from the components
// that consume them, because the row and cell modules both need them and importing either from
// the other would be a cycle.
//
// Parallax change: Tracely's rolling-summary and multi-select contexts are not ported.

// Control cells the table always renders, in order: chevron · run · copy. The header, the body
// rows and every colSpan all count off this ONE constant.
export const CTRL_CELLS = 3;

// ── evaluation columns (dynamic metric columns + live run state) ─────────────────
// Live results and run actions reach the deeply nested cells via context, so the
// row/cell component tree stays prop-free. Keys:
//   live score   →  `th:<thread>|<name>` | `tr:<trace>|<name>` | `span:<span>|<name>`
//   busy row     →  `th:<thread>` | `tr:<trace>`     busy column → score_name
export type EvalView = {
  busyCols: Set<string>;
  busyRows: Set<string>;
  hasEvaluators: boolean;
  runThread: (thread: string) => void;
  runTrace: (trace: string) => void;
  runColumn: (ev: EvaluatorDef) => void;
  editColumn: (ev: EvaluatorDef) => void;
  removeColumn: (ev: EvaluatorDef) => void;
};
export const EvalViewContext = createContext<EvalView>({
  busyCols: new Set(), busyRows: new Set(), hasEvaluators: false,
  runThread: () => {}, runTrace: () => {}, runColumn: () => {}, editColumn: () => {}, removeColumn: () => {},
});

// Live eval-run scores ride a SEPARATE, reference-stable store (not the EvalView context value) so a
// streamed result re-renders ONLY the cell whose score arrived — not the whole grid. Each cell
// subscribes to its own key via useSyncExternalStore; the store object's identity never changes, so
// providing it through context never triggers a re-render.
export type LiveScoreStore = {
  get: (key: string) => EvalScore | undefined;
  set: (key: string, score: EvalScore) => void;
  subscribe: (key: string, cb: () => void) => () => void;
};
export const LiveScoreContext = createContext<LiveScoreStore>({
  get: () => undefined, set: () => {}, subscribe: () => () => {},
});

export function useLiveScoreStore(): LiveScoreStore {
  const scores = useRef(new Map<string, EvalScore>());
  const listeners = useRef(new Map<string, Set<() => void>>());
  return useMemo(
    () => ({
      get: (key) => scores.current.get(key),
      set: (key, score) => {
        scores.current.set(key, score);
        listeners.current.get(key)?.forEach((cb) => cb());
      },
      subscribe: (key, cb) => {
        let set = listeners.current.get(key);
        if (!set) {
          set = new Set();
          listeners.current.set(key, set);
        }
        set.add(cb);
        return () => {
          set!.delete(cb);
        };
      },
    }),
    [],
  );
}

// Subscribe a cell to just its own score key (empty key = N/A cell → never subscribes/re-renders).
export function useLiveScore(key: string): EvalScore | undefined {
  const store = useContext(LiveScoreContext);
  return useSyncExternalStore(
    useCallback((cb) => (key ? store.subscribe(key, cb) : () => {}), [store, key]),
    () => (key ? store.get(key) : undefined),
    () => undefined,
  );
}

/** How the table names and opens Parallax experiments (the C-row Experiment column). */
export type ExperimentLinks = {
  title: (id: string) => string | undefined;
  open: (id: string) => void;
};
export const ExperimentContext = createContext<ExperimentLinks>({
  title: () => undefined,
  open: () => {},
});
