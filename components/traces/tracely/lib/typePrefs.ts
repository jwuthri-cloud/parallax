"use client";

import { useCallback, useEffect, useState } from "react";

// Single source of truth for the "hidden span types" preference — shared between the trace
// table and the timeline so one filter applies everywhere. Parallax change: this browser's
// choice only (Tracely also keeps a workspace-wide default on its server).
const PREFS_KEY = "tracely.traceTable.prefs";
const EVENT = "tracely:prefs";

function readLocal(): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { hiddenTypes?: unknown };
    return Array.isArray(p.hiddenTypes) ? new Set(p.hiddenTypes as string[]) : null;
  } catch {
    return null;
  }
}

function writeLocal(next: Set<string>) {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const cur = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    cur.hiddenTypes = [...next];
    localStorage.setItem(PREFS_KEY, JSON.stringify(cur));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* ignore */
  }
}

export function useHiddenTypes(): {
  hidden: Set<string>;
  toggle: (type: string) => void;
  /** Show every type again. */
  reset: () => void;
} {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    const sync = () => setHidden(readLocal() ?? new Set());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync); // cross-tab sync
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggle = useCallback((type: string) => {
    const cur = readLocal() ?? new Set(hidden);
    if (cur.has(type)) cur.delete(type);
    else cur.add(type);
    writeLocal(cur);
    setHidden(cur);
  }, [hidden]);

  const reset = useCallback(() => {
    const empty = new Set<string>();
    writeLocal(empty);
    setHidden(empty);
  }, []);

  return { hidden, toggle, reset };
}
