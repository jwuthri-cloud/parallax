"use client";

// Tracely's trace pages — /traces, /traces/[traceId], /sessions/[threadId] and its /replay and
// /fleet lenses — as client components. Tracely renders them on its server; Parallax fetches on
// mount instead.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getConversation, getTraceConversation, type ConvNode, type FullTurn } from "./lib/api";
import { convUsage, fmtUsd } from "./lib/usage";
import { ConversationHeader, ConversationTabs, EvalsPill } from "./ConversationChrome";
import { conversationVerdict } from "./lib/conversation";
import { CopyId } from "./CopyId";
import { EvaluatorsManager } from "./EvaluatorsManager";
import { IconArrowLeft } from "./icons";
import { LlmKeyPanel } from "./LlmKeyPanel";
import { listEvaluators } from "./lib/evaluators";
import { SessionView } from "./SessionView";
import { SingleTraceView } from "./SingleTraceView";
import { TracesExplorer } from "./TracesExplorer";
import { Badge } from "./ui";
import { evaluatorsHref, listHref, sessionHref, type ConvView } from "./links";
import type { AgentRow } from "./lib/api";
import { ConversationStage } from "./replay/ConversationStage";
import { OfficeStage } from "./replay/OfficeStage";
import { buildReplay } from "./replay/script";

const PAGE = 50;

/** Shown on the Traces list while there are judge columns and no OpenRouter key: without one
 *  every run is refused, and silence is the worst way to learn that. (Tracely shows its banner
 *  on every page; here it appears only once a column exists.) */
function MissingLlmKeyBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      fetch("/api/llm-key", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      listEvaluators(),
    ])
      .then(([key, evaluators]) => alive && setShow(key?.configured === false && evaluators.length > 0))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!show) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-[13px] text-warn">
      <span className="font-semibold">No OpenRouter key</span>
      <span className="text-fg-muted">Evaluators need your own key before they can run.</span>
      <a href={evaluatorsHref()} className="font-medium text-warn underline underline-offset-2">
        Add a key
      </a>
    </div>
  );
}

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
        <div className="flex items-center gap-2">
          {actions}
          <a href={evaluatorsHref()} className="btn-ghost" title="Judge columns and the OpenRouter key">
            Evaluators
          </a>
        </div>
      </header>

      <MissingLlmKeyBanner />

      <TracesExplorer pageSize={PAGE} models={models} experiments={experiments} emptyHint={emptyHint} />
    </div>
  );
}

/** Every judge column in one list, and the key they run on (Tracely's /evaluators page plus its
 *  Settings → LLM key panel). */
export function EvaluatorsPage() {
  return (
    <div className="space-y-6">
      <header className="reveal space-y-4">
        <a href={listHref()} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-signal">
          <IconArrowLeft className="h-4 w-4" /> Traces
        </a>
        <div>
          <h1 className="font-display text-[26px] font-extrabold tracking-tight">Evaluators</h1>
          <p className="mt-1.5 max-w-[760px] text-[14px] text-fg-muted">
            Every judge that grades your traces. An evaluator is a column on the Traces table: an LLM
            rubric or a decision-model question, at conversation, message or step level. Judges run
            only when you press a Run button.
          </p>
        </div>
      </header>
      <LlmKeyPanel />
      <EvaluatorsManager />
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
            {/* Watch this run act itself out. A trace without a conversation is its own
                one-turn thread — but prefer the thread when there is one, so the replay covers
                every turn. */}
            <a href={sessionHref(sessionId || traceId, "replay")} className="btn-ghost">
              ▶ Replay
            </a>
            <a href={sessionHref(sessionId || traceId, "fleet")} className="btn-ghost">
              ⌂ Fleet
            </a>
          </div>
        </div>
      </header>

      <SingleTraceView conv={conv} spans={spans} />
    </div>
  );
}

/** One conversation under one of its four lenses. The lens is part of the route, and all four
 *  read the same load: a lens change must not look like a different page. */
export function SessionPage({ threadId, view, experimentLink }: {
  threadId: string;
  view: ConvView;
  experimentLink: (id: string | null | undefined) => ReactNode;
}) {
  const { data, error } = useLoad<{ conv: ConvNode; turns: FullTurn[] }>(() => getConversation(threadId), threadId);
  const spans = useMemo(() => (data?.turns ?? []).flatMap((t) => t.spans), [data]);
  // The Replay and Fleet lenses play the same script.
  const replay = useMemo(() => buildReplay(spans), [spans]);
  if (!data) return <Pending error={error} what="conversation" />;
  const { conv, turns } = data;
  const header = (
    <ConversationHeader threadId={threadId} turns={turns.length} usage={convUsage(conv)} actions={experimentLink(conv.experiment_id)} />
  );
  if (view === "replay" || view === "fleet") {
    const verdict = conversationVerdict(conv, turns);
    return (
      <div className="space-y-6">
        {header}
        <ConversationTabs threadId={threadId} active={view} spans={spans.length}
          right={<EvalsPill verdict={verdict} />} />
        {view === "replay" ? (
          <ConversationStage threadId={threadId} data={replay} spans={spans} />
        ) : (
          <OfficeStage threadId={threadId} data={replay} verdict={verdict} />
        )}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {header}
      <div className="reveal" style={{ animationDelay: "60ms" }}>
        <SessionView conv={conv} turns={turns} initialTab={view} />
      </div>
    </div>
  );
}
