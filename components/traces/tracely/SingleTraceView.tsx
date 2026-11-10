"use client";

import clsx from "./clsx";
import { useMemo, useState } from "react";
import type { ConvNode, SpanOut } from "./lib/api";
import { useWide, WideToggle, WIDE_STYLE } from "./lib/useWide";
import { StateIcon, StatePanel } from "./StatePanel";
import { spanHasState } from "./state-fold";
import { TraceTable } from "./TraceTable";
import { Waterfall } from "./Waterfall";

// One trace = a single-turn conversation. The hierarchical table is primary; the waterfall
// timeline remains as an alternate lens. (Parallax: the Agents drawer and evaluation verdict are
// not ported; a step clicked in the Table opens in the Timeline.)
export function SingleTraceView({ conv, spans }: { conv: ConvNode; spans: SpanOut[] }) {
  const [tab, setTab] = useState<"table" | "timeline">("table");
  const [focus, setFocus] = useState<string | null>(null);
  const [wide, setWide] = useWide();
  const [showState, setShowState] = useState(false);
  const hasState = useMemo(() => spans.some(spanHasState), [spans]);
  const openStep = (s: SpanOut) => {
    setFocus(`${s.agent_run_id}/${s.span_id}`);
    setTab("timeline");
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-1 border-b border-line">
        <div className="flex items-center gap-1">
          <TabButton active={tab === "table"} onClick={() => setTab("table")}>
            Table
          </TabButton>
          <TabButton active={tab === "timeline"} onClick={() => setTab("timeline")}>
            Timeline <span className="font-mono text-[11px] text-fg-faint">{spans.length}</span>
          </TabButton>
        </div>
        <div className="flex items-center gap-2">
          {hasState && (
            <button
              onClick={() => setShowState(true)}
              title="Shared state threaded through this trace"
              className="btn-ghost"
            >
              <StateIcon />
              State
            </button>
          )}
          <WideToggle wide={wide} onToggle={() => setWide(!wide)} />
        </div>
      </div>
      <div style={wide ? WIDE_STYLE : undefined} className="transition-[width,margin] duration-200">
        {tab === "table" && <TraceTable conversations={[conv]} embedded onSelectSpan={openStep} />}
        {tab === "timeline" && <Waterfall key={focus ?? ""} spans={spans} initialSpanId={focus} />}
      </div>
      {showState && (
        <StatePanel threadId={conv.thread} spans={spans} onClose={() => setShowState(false)} />
      )}
    </div>
  );
}

const TAB_CLASS = "relative flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium transition-colors";

export function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(TAB_CLASS, active ? "text-fg" : "text-fg-faint hover:text-fg-muted")}
    >
      {children}
      {active && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded bg-signal" />}
    </button>
  );
}
