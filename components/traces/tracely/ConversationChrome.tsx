"use client";

import clsx from "./clsx";
import type { ReactNode } from "react";
import { fmtUsd } from "./lib/usage";
import { CopyId } from "./CopyId";
import { IconArrowLeft } from "./icons";
import { listHref, sessionHref, type ConvView } from "./links";
import { Badge, verdictVariant } from "./ui";

/* The chrome every lens of a conversation wears. Table and Timeline are client tabs on the
   conversation page; Replay and Fleet are their own routes — but all four keep the same header
   and the same strip, so switching lens never looks like landing in a different app.
   (Parallax: Tracely's scenario/share actions are not ported.) */

export function ConversationHeader({
  threadId, turns, usage, actions,
}: {
  threadId: string; turns: number; usage: Record<string, number>;
  /** Parallax: header actions, such as the experiment link. */
  actions?: ReactNode;
}) {
  return (
    <header className="reveal">
      <a href={listHref()} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-signal">
        <IconArrowLeft className="h-4 w-4" /> Traces
      </a>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[22px] font-extrabold tracking-tight">Conversation</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11.5px] text-fg-faint">
            <CopyId value={threadId} label="thread id" />
            <span>{turns} turns</span>
            {usage.input_tokens ? <span>{usage.input_tokens.toLocaleString("en-US")} in</span> : null}
            {usage.cached_tokens ? <span>{usage.cached_tokens.toLocaleString("en-US")} cached</span> : null}
            {usage.output_tokens ? <span>{usage.output_tokens.toLocaleString("en-US")} out</span> : null}
            {usage.total_tokens ? <span>{usage.total_tokens.toLocaleString("en-US")} tokens</span> : null}
            {usage.cost ? <span className="text-syn-bool/90">{fmtUsd(usage.cost)}</span> : null}
          </div>
        </div>
        {/* Only ACTIONS live up here — the lenses are tabs, and the grading hangs off the
            verdict pill. A header of eight equal ghost buttons said nothing was important. */}
        <div className="flex items-center gap-3">{actions}</div>
      </div>
    </header>
  );
}

const TAB = "relative flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium transition-colors";
const underline = <span className="absolute inset-x-3 -bottom-px h-0.5 rounded bg-signal" />;

/**
 * The strip. Table/Timeline are BUTTONS when the conversation page owns that state and LINKS
 * from Replay/Fleet (where switching back is a navigation); Replay/Fleet are always links.
 */
export function ConversationTabs({
  threadId, active, spans, onSelect, right,
}: {
  threadId: string;
  active: ConvView;
  spans: number;
  /** Provided by the conversation page, which toggles Table/Timeline client-side. */
  onSelect?: (view: "table" | "timeline") => void;
  right?: ReactNode;
}) {
  const cls = (v: ConvView) => clsx(TAB, active === v ? "text-fg" : "text-fg-faint hover:text-fg-muted");
  const local = (v: "table" | "timeline", label: ReactNode) =>
    onSelect ? (
      <button key={v} onClick={() => onSelect(v)} className={cls(v)}>{label}{active === v && underline}</button>
    ) : (
      <a key={v} href={sessionHref(threadId, v)} className={cls(v)}>{label}</a>
    );
  return (
    <div className="flex items-center justify-between gap-1 border-b border-line">
      <div className="flex items-center gap-1">
        {local("table", "Table")}
        {local("timeline", <>Timeline <span className="font-mono text-[11px] text-fg-faint">{spans}</span></>)}
        <span className="mx-1 h-4 w-px bg-line" />
        <a href={sessionHref(threadId, "replay")} className={cls("replay")}>▶ Replay{active === "replay" && underline}</a>
        <a href={sessionHref(threadId, "fleet")} className={cls("fleet")}>⌂ Fleet{active === "fleet" && underline}</a>
      </div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  );
}

/** The judge's grading of this conversation. Parallax: Tracely's pill links to its evals page;
 *  here the grades are the judge columns of the Table lens, so the pill is the status only. */
export function EvalsPill({ verdict }: { verdict: "PASS" | "FAIL" | null }) {
  if (!verdict) return null;
  return (
    <Badge variant={verdictVariant(verdict)} dot>
      evals {verdict}
    </Badge>
  );
}
