"use client";

import clsx from "../clsx";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { getConversation, wsUrl, type ConvNode, type EvalScore, type FullTurn, type SpanOut } from "../lib/api";
import { convUsage, fmtUsd, spanUsage, turnUsage, usageSummary } from "../lib/usage";
import { levelGroup, LEVEL_LABEL, type EvaluatorDef } from "../lib/evaluators";
import { mergeMeta } from "../lib/meta";
import { FloatingPanel, IconBox, JsonPill, Pill, Plain } from "../JsonView";
import { IconCheck, IconCopy } from "../icons";
import { TypeChip } from "../ui";
import { AgentBadge, MessageContent, ModelBadge, RoleBadge, StateCell, stateWritesOf, TurnMessage } from "./content";
import { asRoleMessage, deriveTitle, durationMs, lastTurnMessage, fmtDateTime, fmtMs, fmtPanelOutput, fmtScoreValue, jsonResultLabel, nearestAgentLabel, selfMs } from "./format";
import type { Col } from "./columns";
import { EvalViewContext, ExperimentContext, useLiveScore } from "./contexts";
import { sessionHref } from "../links";

// Leaf renderers: one cell of the grid. `renderCell` is the per-column dispatch every row
// level funnels through, so a new column is a case here rather than a change in three rows.

// Formatted Tokens / Cost breakdown for the usage popover (nicer than raw JSON).
function UsageBody({ usage }: { usage: Record<string, number> }) {
  const tokenRows = ([["Input", "input_tokens"], ["Cached", "cached_tokens"], ["Cache write", "cache_write_tokens"], ["Output", "output_tokens"], ["Thinking", "thinking_tokens"], ["Total", "total_tokens"]] as Array<[string, string]>).filter(([, k]) => usage[k] != null);
  const costRows = ([["Input", "input_price"], ["Output", "output_price"], ["Total", "cost"]] as Array<[string, string]>).filter(([, k]) => usage[k] != null);
  const row = (label: string, k: string, fmt: (n: number) => string, cls: string) => (
    <div key={k} className={clsx("flex items-center justify-between gap-4", k === "total_tokens" || k === "cost" ? "mt-0.5 border-t border-line/60 pt-1 font-medium" : "")}>
      <span className="text-fg-muted">{label}</span>
      <span className={clsx("font-mono tabular-nums", cls)}>{fmt(usage[k])}</span>
    </div>
  );
  return (
    <div className="space-y-3 p-3 text-[12px]">
      {tokenRows.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-faint">Tokens</div>
          {tokenRows.map(([l, k]) => row(l, k, (n) => n.toLocaleString("en-US"), "text-fg"))}
        </div>
      )}
      {costRows.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-faint">Cost</div>
          {costRows.map(([l, k]) => row(l, k, fmtUsd, "text-warn"))}
        </div>
      )}
    </div>
  );
}

function UsageCell({ usage }: { usage: Record<string, number> }) {
  if (Object.keys(usage).length === 0) return <span className="text-fg-faint">—</span>;
  const icon = <IconBox accent="amber"><span className="text-[10px] font-bold">Σ</span></IconBox>;
  return (
    <Pill
      iconBox={icon}
      summary={<span className="text-fg/90">{usageSummary(usage)}</span>}
      panel={(a, c) => (
        <FloatingPanel anchor={a} onClose={c} icon={icon} title="usage" subtitle={usageSummary(usage)} copyText={JSON.stringify(usage, null, 2)}>
          <UsageBody usage={usage} />
        </FloatingPanel>
      )}
    />
  );
}


/** Copy the whole conversation — every message, step, and score — as one JSON object.
 *
 *  Fetches on click rather than serialising what the table happens to hold: the rows carry only
 *  the turns that have been expanded, so copying from state gives a different object depending on
 *  what you had open. */
export function CopyConvButton({ thread }: { thread: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    setState("busy");
    try {
      const { conv, turns } = await getConversation(thread);
      await navigator.clipboard.writeText(JSON.stringify({ ...conv, turnsData: undefined, turns }, null, 2));
      setState("done");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 1600);
  }

  return (
    <button
      tabIndex={-1}
      onClick={copy}
      title="Copy this conversation as JSON"
      className={clsx(
        "inline-flex h-6 w-6 items-center justify-center rounded-lg transition-opacity hover:bg-ink-600",
        // Stays visible once it has something to say; otherwise it is hover-only like its neighbours.
        state === "idle" ? "opacity-0 group-hover:opacity-100" : "opacity-100",
      )}
    >
      {state === "done" ? (
        <IconCheck className="h-3 w-3 text-ok" />
      ) : state === "error" ? (
        <IconCopy className="h-3 w-3 text-fail" />
      ) : (
        <IconCopy className={clsx("h-3 w-3 text-fg-muted", state === "busy" && "animate-pulse")} />
      )}
    </button>
  );
}

// A conversation row always opens the conversation view, even at one turn — where the thread id
// IS the trace id and the session lookup matches on either.
export const convHref = (conv: ConvNode) => sessionHref(conv.thread);

function ConvTitleCell({ conv }: { conv: ConvNode }) {
  const href = convHref(conv);
  const title = deriveTitle(conv.first_input);
  // The title always reads as the opening message's pill — the one the Content column shows — so
  // every row looks the same regardless of length. (A list with no user message has no pill.)
  const pill = lastTurnMessage(conv.first_input, "user") !== null;
  return (
    // `w-0` + a floor: the table is auto-layout, so a cell's widest unbreakable run sets its
    // column's width — one pasted URL stretched this column across the screen. Sized to nothing,
    // it holds the column's 260px (less padding) and still grows when the table has room to spare.
    <div className="flex w-0 min-w-[max(100%,236px)] items-center gap-2" title={conv.thread}>
      <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", conv.failing ? "bg-fail" : "bg-ok/70")} />
      {pill ? (
        <TurnMessage raw={conv.first_input} role="user" />
      ) : (
        <a href={href} className="truncate text-sm font-medium text-fg hover:underline">
          {title}
        </a>
      )}
    </div>
  );
}


// Parallax: the experiment a conversation's traces belong to, opening that experiment.
function ExperimentCell({ id }: { id: string | null | undefined }) {
  const links = useContext(ExperimentContext);
  if (!id) return <span className="text-fg-faint">—</span>;
  const title = links.title(id) ?? id;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        links.open(id);
      }}
      className="inline-flex max-w-full items-center truncate rounded border border-signal/30 bg-signal/10 px-2 py-0.5 text-[11px] font-medium text-signal hover:bg-signal/20"
      title={`Open experiment: ${title}`}
    >
      {title}
    </button>
  );
}

// Where a streamed score lands in `live` (mirrors the per-cell lookup keys).
function VerdictChip({ verdict }: { verdict: string }) {
  if (verdict !== "PASS" && verdict !== "FAIL") return null;
  const ok = verdict === "PASS";
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider",
        ok ? "border-ok/30 bg-ok/10 text-ok" : "border-fail/30 bg-fail/10 text-fail",
      )}
    >
      {verdict}
    </span>
  );
}

// A classification column (intent, risk_level…) never emits PASS/FAIL — the predicted LABEL is
// its badge. Same shape as VerdictChip so a mixed row reads as one family of chips; lowercase,
// because `technical_support` shouted in caps is unreadable at 9px.
function LabelChip({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-info/30 bg-info/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-info">
      {label}
    </span>
  );
}

// The judge's own model calls for this cell, lazily fetched. Collapsed by default: the prompt is
// thousands of characters and the panel's job is still the verdict.
// Parallax change: the calls are stored on the score itself (Tracely reads them from the trace
// it records about its own evaluation work), so there is no "eval trace" to open.
type PromptCall = { name: string; model: string; input: string; output: string };
type PromptState = { steps: PromptCall[] } | { error: string } | null;

export function JudgePrompt({
  subject,
  level,
  name,
  spanId,
}: {
  subject: string;
  level: string;
  name: string;
  spanId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PromptState>(null);
  useEffect(() => {
    if (!open || state) return;
    let alive = true;
    fetch(wsUrl("/api/evaluations/prompt", { subject, level, name, span_id: spanId }))
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        // Surfaced, not swallowed: a 500 rendered as "no recording" sent the reader looking
        // for a missing recording instead of a broken request.
        if (!r.ok) setState({ error: d.error ? String(d.error) : `request failed (${r.status})` });
        else setState({ steps: d.steps ?? [] });
      })
      .catch((e) => alive && setState({ error: String(e?.message ?? e) }));
    return () => {
      alive = false;
    };
  }, [open, state, subject, level, name, spanId]);
  if (!subject) return null;
  return (
    <div className="border-t border-line pt-2">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="text-[11px] text-fg-muted transition-colors hover:text-fg"
      >
        {open ? "▾" : "▸"} LLM prompt &amp; answer
      </button>
      {open && state === null && <p className="pt-2 text-[11px] text-fg-faint">loading…</p>}
      {open && state && "error" in state && (
        <p className="pt-2 text-[11px] text-fail">Couldn&apos;t load the prompt: {state.error}</p>
      )}
      {open && state && "steps" in state && (
        <>
          {state.steps.length === 0 ? (
            <p className="pt-2 text-[11px] text-fg-faint">
              No model call behind this cell — the item was not sent to a model (not run, or
              skipped). Re-run the column to grade it.
            </p>
          ) : (
            state.steps.map((st, i) => (
              <div key={i} className="space-y-1 pt-2">
                <div className="text-[10px] uppercase tracking-wider text-fg-faint">
                  {st.name}
                  {st.model && st.model !== st.name ? ` · ${st.model}` : ""}
                </div>
                {([["Prompt", st.input], ["Answer", st.output]] as Array<[string, string]>).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[10px] text-fg-muted">{k}</div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-ink-800 p-2 font-mono text-[10.5px] text-fg/90">
                      {fmtPanelOutput(v || "")}
                    </pre>
                  </div>
                ))}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

const EvalSpinner = () => (
  <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-faint">
    <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-signal" />
    evaluating
  </span>
);

// One metric result in a cell: verdict chip + value (or reason teaser), click → floating
// detail panel with the judge's full reasoning.
function EvalScorePill({ score, evaluator, busy, subject, level, spanId }: { score: EvalScore; evaluator: EvaluatorDef; busy: boolean; subject: string; level: string; spanId: string }) {
  // Label first: with the intent in the badge, the pill beside it carries the judge's reason
  // instead of repeating the label.
  // Parallax change: a decision column's answer (CATEGORICAL: the label, or the fired labels) is
  // headlined too. Upstream shows only its confidence number, so an intent column read "0.87".
  const categorical = score.data_type === "CATEGORICAL" && score.graded !== false ? score.string_value ?? "" : "";
  const label = score.verdict ? null : categorical || jsonResultLabel(score.string_value ?? "");
  const val = (label ? score.comment : categorical || fmtScoreValue(score) || score.comment) || "";
  const icon = (
    <IconBox accent={score.verdict === "FAIL" ? "fuchsia" : "cyan"}>
      <span className="text-[10px] font-bold">✓</span>
    </IconBox>
  );
  const rows: Array<[string, string]> = [];
  if (score.verdict) rows.push(["Verdict", score.verdict]);
  if (score.value != null) rows.push(["Value", String(score.value)]);
  if (score.string_value) {
    rows.push([
      score.data_type === "CATEGORICAL" ? "Category" : "Output",
      fmtPanelOutput(score.string_value),
    ]);
  }
  if (score.comment) rows.push(["Reason", score.comment]);
  return (
    // max-w-full + overflow-hidden: the pill can NEVER bleed into the neighboring column —
    // the teaser text is hard-trimmed to fit and the full reason lives in the click panel.
    <span className={clsx("inline-flex max-w-full items-center gap-1.5 overflow-hidden", busy && "opacity-50")}>
      {score.verdict ? <VerdictChip verdict={score.verdict} /> : label ? <LabelChip label={label} /> : null}
      {val ? (
        <Pill
          iconBox={icon}
          summary={<span className="text-fg/90">{val.length > 16 ? `${val.slice(0, 16).trimEnd()}…` : val}</span>}
          panel={(a, c) => (
            <FloatingPanel
              anchor={a}
              onClose={c}
              icon={icon}
              title={evaluator.name}
              subtitle={LEVEL_LABEL[score.evaluation_level] ?? score.evaluation_level.toLowerCase()}
              copyText={JSON.stringify(score, null, 2)}
            >
              <div className="space-y-2 p-3 text-[12px]">
                {evaluator.description && <p className="text-fg-faint">{evaluator.description}</p>}
                {rows.map(([k, v]) => (
                  <div key={k} className="flex items-start justify-between gap-4">
                    <span className="shrink-0 text-fg-muted">{k}</span>
                    <span
                      className={clsx(
                        "whitespace-pre-wrap break-words font-mono text-[11.5px]",
                        k === "Output" ? "text-left" : "text-right",
                        k === "Verdict" ? (v === "FAIL" ? "text-fail" : "text-ok") : "text-fg",
                      )}
                    >
                      {v}
                    </span>
                  </div>
                ))}
                <JudgePrompt subject={subject} level={level} name={score.name} spanId={spanId} />
              </div>
            </FloatingPanel>
          )}
        />
      ) : null}
    </span>
  );
}

// Span types a step-level evaluator grades — used to blank non-target step rows.
// Parallax: an empty `span_types` on a SPAN-level column grades every step type, like the runner.
function evaluatorSpanTypes(ev: EvaluatorDef): string[] | null {
  if (ev.level === "SPAN") {
    const types = ev.config?.span_types as string[] | undefined;
    return types?.length ? types : null;
  }
  if (ev.level === "TOOL" || ev.level === "GENERATION" || ev.level === "CHAIN") return [ev.level];
  return null;
}

// The live-store key for this (evaluator, row) cell — "" when the cell isn't applicable, so the
// useLiveScore hook stays unconditional (hooks rule) without subscribing.
function liveKeyFor(evaluator: EvaluatorDef, ctx: RowCtx): string {
  if (levelGroup(evaluator.level) !== ctx.level) return "";
  const name = evaluator.score_name;
  if (ctx.level === "C") return `th:${ctx.conv.thread}|${name}`;
  if (ctx.level === "M") return ctx.role === "assistant" ? `tr:${ctx.turn.trace_id}|${name}` : "";
  const types = evaluatorSpanTypes(evaluator);
  if (types && !types.includes(ctx.span.type)) return "";
  return `span:${ctx.span.span_id}|${name}`;
}

function EvalColumnCell({ evaluator, ctx }: { evaluator: EvaluatorDef; ctx: RowCtx }) {
  const view = useContext(EvalViewContext);
  const live = useLiveScore(liveKeyFor(evaluator, ctx)); // subscribes to just this cell's score
  if (levelGroup(evaluator.level) !== ctx.level) return null;
  const name = evaluator.score_name;
  let score: EvalScore | undefined;
  let busy = view.busyCols.has(name);
  if (ctx.level === "C") {
    score = live ?? ctx.conv.scores?.find((s) => s.name === name && s.evaluation_level === "CONVERSATION");
    busy = busy || view.busyRows.has(`th:${ctx.conv.thread}`);
  } else if (ctx.level === "M") {
    if (ctx.role !== "assistant") return null; // run-level grades attach to the agent's reply
    score =
      live ?? ctx.turn.scores?.find((s) => s.name === name && !s.observation_id && s.evaluation_level !== "CONVERSATION");
    busy = busy || view.busyRows.has(`tr:${ctx.turn.trace_id}`) || view.busyRows.has(`th:${ctx.conv.thread}`);
  } else {
    const types = evaluatorSpanTypes(evaluator);
    if (types && !types.includes(ctx.span.type)) return null;
    score = live ?? ctx.turn.scores?.find((s) => s.name === name && s.observation_id === ctx.span.span_id);
    busy = busy || view.busyRows.has(`tr:${ctx.turn.trace_id}`);
  }
  if (!score) return busy ? <EvalSpinner /> : <span className="text-fg-faint">—</span>;
  // Where the score is stored: under the thread for a conversation pass, the trace otherwise.
  const subject = ctx.level === "C" ? ctx.conv.thread : ctx.turn.trace_id;
  const level = ctx.level === "C" ? "conv" : ctx.level === "M" ? "msg" : "step";
  return (
    <EvalScorePill
      score={score}
      evaluator={evaluator}
      busy={busy}
      subject={subject}
      level={level}
      spanId={ctx.level === "S" ? ctx.span.span_id : ""}
    />
  );
}

// ── row context + per-column dispatch ───────────────────────────────────────────
export type RowCtx =
  | { level: "C"; conv: ConvNode }
  | { level: "M"; role: "user" | "assistant"; conv: ConvNode; turn: FullTurn; index: number }
  | { level: "S"; span: SpanOut; index: number; turn: FullTurn };

export function renderCell(col: Col, ctx: RowCtx): ReactNode {
  if (col.evaluator) return <EvalColumnCell evaluator={col.evaluator} ctx={ctx} />;
  switch (col.key) {
    // C group
    case "conversation":
      return ctx.level === "C" ? <ConvTitleCell conv={ctx.conv} /> : null;
    case "ctime":
      return ctx.level === "C"
        ? <span className="font-mono text-xs text-fg-muted">{fmtDateTime(ctx.conv.first_ts)}</span>
        : null;
    case "cdur": {
      if (ctx.level !== "C") return null;
      const durMs = ctx.conv.first_ts
        ? new Date(ctx.conv.last_ts).getTime() - new Date(ctx.conv.first_ts).getTime()
        : null;
      return <span className="font-mono text-xs tabular-nums text-fg-muted">{fmtMs(durMs)}</span>;
    }
    // The conversation's agent (its tenant, when one was declared) — what this thread is gated,
    // clustered and tested as. Distinct from the S-row "Agent", which labels who did each step.
    case "cagent":
      return ctx.level === "C" && ctx.conv.agent ? <AgentBadge agent={ctx.conv.agent} /> : null;
    case "cexp":
      return ctx.level === "C" ? <ExperimentCell id={ctx.conv.experiment_id} /> : null;
    case "cmeta": {
      if (ctx.level !== "C") return null;
      // backend-aggregated thread metadata (available in the list); else union from loaded spans.
      const m =
        ctx.conv.metadata && Object.keys(ctx.conv.metadata).length
          ? ctx.conv.metadata
          : mergeMeta((ctx.conv.turnsData ?? []).flatMap((t) => t.spans));
      return Object.keys(m).length ? <JsonPill raw={JSON.stringify(m)} /> : <span className="text-fg-faint">—</span>;
    }
    case "cusage":
      return ctx.level === "C" ? <UsageCell usage={convUsage(ctx.conv)} /> : null;
    // M group
    case "role": {
      if (ctx.level !== "M") return null;
      const failed = ctx.role === "assistant" && ctx.turn.failing === 1;
      return (
        <span className="flex items-center gap-1.5">
          {failed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fail" title="failing" />}
          <RoleBadge role={ctx.role} />
        </span>
      );
    }
    case "mindex":
      return ctx.level === "M" ? <span className="font-mono text-xs tabular-nums text-fg-faint">{ctx.index}</span> : null;
    case "mtime":
      return ctx.level === "M" ? <span className="font-mono text-xs text-fg-muted">{fmtDateTime(ctx.turn.ts)}</span> : null;
    case "mdur":
      return ctx.level === "M" && ctx.role === "assistant"
        ? <span className="font-mono text-xs tabular-nums text-fg-muted">{fmtMs(ctx.turn.latency_ms)}</span>
        : null;
    case "content":
      return ctx.level === "M" ? <TurnMessage raw={ctx.role === "user" ? ctx.turn.input : ctx.turn.output} role={ctx.role} /> : null;
    // Assistant-side only: a turn renders a user row and an assistant row, and the state writes
    // belong to the work the agent did — showing them twice reads as two separate changes.
    case "mstate":
      return ctx.level === "M" && ctx.role === "assistant"
        ? <StateCell writes={stateWritesOf(ctx.turn.spans ?? [])} />
        : null;
    case "musage":
      return ctx.level === "M" && ctx.role === "assistant" ? <UsageCell usage={turnUsage(ctx.turn)} /> : null;
    // S group
    case "sindex":
      return ctx.level === "S" ? <span className="font-mono text-xs tabular-nums text-fg-faint">{ctx.index}</span> : null;
    case "type":
      return ctx.level === "S" ? <TypeChip type={ctx.span.type} /> : null;
    case "stime":
      return ctx.level === "S" ? <span className="font-mono text-xs text-fg-muted">{fmtDateTime(ctx.span.start_time)}</span> : null;
    // Wall time, plus SELF time when this span wraps others. A `thinking()` block around an LLM
    // call shows the call's 3.4s on both rows; without the second number there is no way to read
    // which one actually spent it.
    case "sdur": {
      if (ctx.level !== "S") return null;
      const total = durationMs(ctx.span);
      const self = selfMs(ctx.span, ctx.turn.spans ?? []);
      const nested = self != null && total != null && total - self >= 1;
      // A streamed call carries the first-content-token mark, which is the real split between
      // waiting on the model and receiving its answer — the only number that separates thinking
      // from generating inside one request.
      const ttft = ctx.span.ttft_ms;
      const split = ttft != null && total != null && ttft > 0 && ttft < total;
      return (
        <span className="font-mono text-xs tabular-nums text-fg-muted">
          {fmtMs(total)}
          {split && (
            <span
              className="ml-1.5 text-fg-faint"
              title={`${fmtMs(ttft)} to the first token, then ${fmtMs(total! - ttft!)} streaming the answer`}
            >
              {fmtMs(ttft)} + {fmtMs(total! - ttft!)}
            </span>
          )}
          {!split && nested && (
            <span
              className="ml-1.5 text-fg-faint"
              title="Time this span spent itself — the rest was its nested spans"
            >
              {fmtMs(self)} self
            </span>
          )}
        </span>
      );
    }
    case "agent": {
      if (ctx.level !== "S") return null;
      const label = nearestAgentLabel(ctx.span, ctx.turn.spans ?? []);
      return label ? <AgentBadge agent={label} /> : null;
    }
    case "model":
      return ctx.level === "S" && ctx.span.model_id ? <ModelBadge model={ctx.span.model_id} /> : null;
    case "name":
      if (ctx.level !== "S") return null;
      // For TOOL spans the framework `step_name` is usually the dispatching node ("tools" in
      // LangGraph), not the tool itself — prefer the actual tool name so the column shows
      // `get_order_status` instead of `tools`.
      return (
        <Plain
          text={ctx.span.type === "TOOL"
            ? (ctx.span.name || ctx.span.step_name || "")
            : (ctx.span.step_name || ctx.span.name || "")}
        />
      );
    case "input": {
      if (ctx.level !== "S") return null;
      // AGENT spans represent the run as a whole — wrap their I/O as a chat message so it reads as
      // a USER pill (matches the M-row layout). TOOL/GENERATION/CHAIN keep their raw shape: tools
      // carry structured args dicts, generations carry full message lists, chains carry framework
      // state.
      const raw = ctx.span.input;
      return ctx.span.type === "AGENT"
        ? <MessageContent raw={asRoleMessage("user", raw)} />
        : <MessageContent raw={raw} />;
    }
    case "output": {
      if (ctx.level !== "S") return null;
      // THINKING is its own Type — its reasoning text lives in the span's output, shown here.
      // AGENT outputs render as an ASSISTANT pill, again matching the M-row.
      const raw = ctx.span.output;
      return ctx.span.type === "AGENT"
        ? <MessageContent raw={asRoleMessage("assistant", raw)} />
        : <MessageContent raw={raw} />;
    }
    case "sstate":
      return ctx.level === "S" ? <StateCell writes={stateWritesOf([ctx.span])} /> : null;
    case "susage":
      return ctx.level === "S" ? <UsageCell usage={spanUsage(ctx.span)} /> : null;
    default:
      return null;
  }
}

