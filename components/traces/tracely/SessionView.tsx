"use client";

import { useMemo, useState } from "react";
import type { ConvNode, FullTurn, SpanOut } from "./lib/api";
import { useWide, WideToggle, WIDE_STYLE } from "./lib/useWide";
import { StateIcon, StatePanel } from "./StatePanel";
import { spanHasState } from "./state-fold";
import { ConversationTabs, type ConvView } from "./ConversationChrome";
import { TraceTable } from "./TraceTable";
import { Waterfall } from "./Waterfall";

// A whole multi-turn conversation, with the same two lenses a single trace gets:
//   • Table    — the hierarchical conversation → message → step tree (pre-expanded)
//   • Timeline — a waterfall across every span of every turn, with idle think-time between
//                turns collapsed (so an hour-later reply doesn't render an hour of empty track)
// Parallax: Tracely's evaluation pill and Agents drawer are not ported; a step clicked in the
// Table opens in the Timeline.
export function SessionView({ conv, turns }: { conv: ConvNode; turns: FullTurn[] }) {
  const [tab, setTab] = useState<ConvView>("table");
  const [focus, setFocus] = useState<string | null>(null);

  // Every span across all turns; the Waterfall compresses the idle gaps between turns.
  const allSpans = useMemo(
    () => turns.flatMap((t) => t.spans).sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()),
    [turns],
  );
  // Only offer the State drawer when there's state to show — an empty drawer is worse than no button.
  const hasState = useMemo(() => allSpans.some(spanHasState), [allSpans]);

  const [wide, setWide] = useWide();
  const [showState, setShowState] = useState(false);
  const openStep = (s: SpanOut) => {
    setFocus(`${s.agent_run_id}/${s.span_id}`);
    setTab("timeline");
  };
  return (
    <div className="space-y-4">
      <ConversationTabs
        active={tab}
        spans={allSpans.length}
        onSelect={setTab}
        right={
          <>
            {hasState && (
              <button
                onClick={() => setShowState(true)}
                title="Shared state threaded through this conversation"
                className="btn-ghost"
              >
                <StateIcon />
                State
              </button>
            )}
            <WideToggle wide={wide} onToggle={() => setWide(!wide)} />
          </>
        }
      />

      {showState && (
        <StatePanel threadId={conv.thread} spans={allSpans} onClose={() => setShowState(false)} />
      )}

      <div style={wide ? WIDE_STYLE : undefined} className="transition-[width,margin] duration-200">
        {tab === "table" && <TraceTable conversations={[conv]} embedded onSelectSpan={openStep} />}
        {tab === "timeline" && <Waterfall key={focus ?? ""} spans={allSpans} initialSpanId={focus} />}
      </div>
    </div>
  );
}
