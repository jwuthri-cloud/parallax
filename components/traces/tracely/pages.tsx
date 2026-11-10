"use client";

// Tracely's three trace pages — /traces, /traces/[traceId], /sessions/[threadId] — as client
// components. Tracely renders them on its server; Parallax fetches on mount instead.
import { useEffect, useState, type ReactNode } from "react";
import { getConversation, getTraceConversation, type ConvNode, type FullTurn } from "./lib/api";
import { convUsage, fmtUsd } from "./lib/usage";
import { ConversationHeader } from "./ConversationChrome";
import { CopyId } from "./CopyId";
import { IconArrowLeft } from "./icons";
import { SessionView } from "./SessionView";
import { SingleTraceView } from "./SingleTraceView";
import { TracesExplorer } from "./TracesExplorer";
import { Badge } from "./ui";
import { listHref, sessionHref } from "./links";
import type { AgentRow } from "./lib/api";

const PAGE = 50;

export function TracesPage({
  models,
  experiments,
  emptyHint,
  actions,
}: {
  models: AgentRow[];
  experiments: AgentRow[];
  emptyHint: string;
  /** Parallax: header actions (the demo-traces button). */
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <header className="reveal flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-extrabold tracking-tight">Traces</h1>
          <p className="mt-1.5 text-[14px] text-fg-muted">
            Agent runs grouped into conversation threads — expand any conversation into its messages and steps.
          </p>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>

      <TracesExplorer pageSize={PAGE} models={models} experiments={experiments} emptyHint={emptyHint} />
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let alive = true;
    setState({});
    load().then(
      (data) => alive && setState({ data }),
      (e: Error) => alive && setState({ error: e.message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function Pending({ error, what }: { error?: string; what: string }) {
  return (
    <div className="space-y-6">
      <a href={listHref()} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-signal">
        <IconArrowLeft className="h-4 w-4" /> Traces
      </a>
      <div className={`card px-4 py-14 text-center text-[13px] ${error ? "text-fail" : "text-fg-faint"}`}>
        {error ?? `Loading ${what}…`}
      </div>
    </div>
  );
}

export function TracePage({ traceId, experimentLink }: { traceId: string; experimentLink: (id: string | null | undefined) => ReactNode }) {
  const { data, error } = useLoad(() => getTraceConversation(traceId), traceId);
  if (!data) return <Pending error={error} what="trace" />;
  const { conv, turn, sessionId } = data;
  const spans = turn.spans;
  const hasError = spans.some((s) => s.level === "ERROR");
  const failing = hasError || turn.failing === 1;
  const root = spans.find((s) => s.parent_span_id === "") ?? spans[0];
  const totalMs = turn.latency_ms;
  const usage = convUsage(conv);

  return (
    <div className="space-y-6">
      <header className="reveal space-y-4">
        <a href={listHref()} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-signal">
          <IconArrowLeft className="h-4 w-4" /> Traces
        </a>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-[24px] font-extrabold tracking-tight">{root?.name ?? "trace"}</h1>
              {failing ? (
                <Badge variant="fail" dot>{hasError ? "error" : "failing"}</Badge>
              ) : (
                <Badge variant="ok" dot>ok</Badge>
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-3 font-mono text-[11.5px] text-fg-faint">
              <CopyId value={traceId} label="trace id" />
              <span>{spans.length} spans</span>
              <span>{totalMs < 1000 ? `${Math.round(totalMs)}ms` : `${(totalMs / 1000).toFixed(2)}s`}</span>
              {usage.input_tokens ? <span>{usage.input_tokens.toLocaleString("en-US")} in</span> : null}
              {usage.cached_tokens ? <span>{usage.cached_tokens.toLocaleString("en-US")} cached</span> : null}
              {usage.output_tokens ? <span>{usage.output_tokens.toLocaleString("en-US")} out</span> : null}
              {usage.total_tokens ? <span>{usage.total_tokens.toLocaleString("en-US")} tokens</span> : null}
              {usage.cost ? <span className="text-warn/90">{fmtUsd(usage.cost)}</span> : null}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {experimentLink(conv.experiment_id)}
            {/* only when the turn belongs to a real conversation thread */}
            {sessionId && (
              <a href={sessionHref(sessionId)} className="btn-ghost">
                ← Conversation
              </a>
            )}
          </div>
        </div>
      </header>

      <SingleTraceView conv={conv} spans={spans} />
    </div>
  );
}

export function SessionPage({ threadId, experimentLink }: { threadId: string; experimentLink: (id: string | null | undefined) => ReactNode }) {
  const { data, error } = useLoad<{ conv: ConvNode; turns: FullTurn[] }>(() => getConversation(threadId), threadId);
  if (!data) return <Pending error={error} what="conversation" />;
  const { conv, turns } = data;
  return (
    <div className="space-y-6">
      <ConversationHeader threadId={threadId} turns={turns.length} usage={convUsage(conv)} actions={experimentLink(conv.experiment_id)} />
      <div className="reveal" style={{ animationDelay: "60ms" }}>
        <SessionView conv={conv} turns={turns} />
      </div>
    </div>
  );
}
