"use client";

import { useEffect, useState } from "react";
import { deleteColumnError, deleteEvaluator, listEvaluators, updateEvaluator, type EvaluatorDef } from "./lib/evaluators";
import { AddColumnModal } from "./AddColumnModal";
import { Toggle } from "./Toggle";
import { Badge } from "./ui";

const LEVEL_LABEL: Record<string, string> = {
  CONVERSATION: "Conversation", AGENT_RUN: "Message", SPAN: "Step",
  TOOL: "Tool step", GENERATION: "Generation step", CHAIN: "Chain step",
};

/** The Evaluators page list: create, edit, enable/disable, delete. Parallax change: no
 *  "Alert on fail" (Tracely's alerts are not ported). */
export function EvaluatorsManager() {
  const [rows, setRows] = useState<EvaluatorDef[] | null>(null);
  const [modal, setModal] = useState<{ open: boolean; editing: EvaluatorDef | null }>({ open: false, editing: null });
  const [err, setErr] = useState<string | null>(null);

  const reload = () => void listEvaluators().then(setRows);
  useEffect(reload, []);

  async function toggle(ev: EvaluatorDef, enabled: boolean) {
    try {
      const d = await updateEvaluator(ev.id, { enabled });
      setRows((prev) => prev?.map((x) => (x.id === d.id ? d : x)) ?? null);
    } catch {
      setErr(`Could not ${enabled ? "enable" : "disable"} “${ev.name}”.`);
    }
  }

  async function remove(ev: EvaluatorDef) {
    if (!confirm(`Delete evaluator “${ev.name}”? Its column and its scores are removed.`)) return;
    try {
      await deleteEvaluator(ev.id);
      setRows((prev) => prev?.filter((x) => x.id !== ev.id) ?? null);
    } catch (e) {
      setErr(deleteColumnError(e, ev.name));
    }
  }

  return (
    <section className="reveal card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-[13px] font-semibold text-fg">
          Evaluators {rows ? <span className="font-mono text-[11px] text-fg-faint">({rows.length})</span> : null}
        </span>
        <button onClick={() => setModal({ open: true, editing: null })} className="btn-primary text-[12.5px]">
          + New evaluator
        </button>
      </div>

      {err ? (
        <p role="alert" className="border-b border-line px-4 py-2 text-[12.5px] text-fail">
          {err}
        </p>
      ) : null}

      {rows === null ? (
        <div className="px-4 py-12 text-center text-[13px] text-fg-faint">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-12 text-center text-[13px] text-fg-muted">
          No evaluators yet. Start from the template library — an answer-quality judge and an intent
          label are a good first pair.
          <div className="mt-4">
            <button onClick={() => setModal({ open: true, editing: null })} className="btn-primary text-[12.5px]">
              Browse templates
            </button>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-line">
          {rows.map((ev) => (
            <div key={ev.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setModal({ open: true, editing: ev })}
                    className="text-[13.5px] font-medium text-fg transition-colors hover:text-signal"
                  >
                    {ev.name}
                  </button>
                  <Badge variant={ev.kind === "llm_judge" ? "signal" : "info"}>
                    {ev.kind === "llm_judge" ? "LLM judge" : "Check"}
                  </Badge>
                  <span className="font-mono text-[10.5px] text-fg-faint">{LEVEL_LABEL[ev.level] ?? ev.level}</span>
                </div>
                {ev.description ? (
                  <p className="mt-1 truncate text-[12px] text-fg-muted">{ev.description}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                <Toggle checked={ev.enabled} onChange={(next) => toggle(ev, next)} label={ev.enabled ? "on" : "off"} />
                <button onClick={() => setModal({ open: true, editing: ev })} className="btn-ghost text-[12px]">
                  Edit
                </button>
                <button onClick={() => remove(ev)} className="btn-ghost text-[12px]" title="Delete">
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddColumnModal
        open={modal.open}
        editing={modal.editing}
        onClose={() => setModal({ open: false, editing: null })}
        onSaved={reload}
      />
    </section>
  );
}
