"use client";

import { useEffect, useState } from "react";

type Status = "loading" | "unset" | "set";

/** Evaluators page: the OpenRouter key every judge call runs on. Parallax changes: one key for
 *  this Parallax (a private file in its data folder, or OPENROUTER_API_KEY), not one per
 *  workspace. The key is only ever sent once — after saving, the server shows "configured",
 *  never the value again. */
export function LlmKeyPanel({ onChange }: { onChange?: (configured: boolean) => void }) {
  const [status, setStatusState] = useState<Status>("loading");
  const [source, setSource] = useState<string | null>(null);
  const setStatus = (next: Status) => {
    setStatusState(next);
    if (next !== "loading") onChange?.(next === "set");
  };
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/llm-key", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setSource(d?.source ?? null);
        setStatus(d?.configured ? "set" : "unset");
      })
      .catch(() => setStatus("unset"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!value.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/llm-key", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: value.trim() }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(d?.error ?? `Save failed (HTTP ${r.status})`);
        return;
      }
      setSource("saved");
      setStatus("set");
      setEditing(false);
      setValue("");
    } catch {
      setErr("Save failed: could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/llm-key", { method: "DELETE" });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(d?.error ?? `Remove failed (HTTP ${r.status})`);
        return;
      }
      // A key in the server environment still applies after the saved one is removed.
      setSource(d?.source ?? null);
      setStatus(d?.configured ? "set" : "unset");
    } catch {
      setErr("Remove failed: could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="hairline px-4 py-3 text-[13px] font-semibold text-fg">OpenRouter key</div>
      <div className="space-y-4 p-5">
        <p className="text-[13.5px] leading-relaxed text-fg-muted">
          Required to run judges. Every evaluator call — LLM judges, decision models, and
          &ldquo;Use AI&rdquo; in the column editor — goes to OpenRouter with your own key and
          bills to your account. A run sends the judged trace content and the rubric to
          OpenRouter. Without a key, Parallax contacts nobody.
        </p>

        {status === "unset" && (
          <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
            No key configured — evaluators will not run.
          </p>
        )}

        {status === "loading" && <p className="text-[13px] text-fg-faint">Loading…</p>}

        {status === "set" && !editing && (
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-[13px] text-ok">
              {source === "environment" ? "A key from OPENROUTER_API_KEY is in use" : "A key is configured"}
            </span>
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="rounded-lg border border-line bg-ink-800 px-3.5 py-2 text-[13px] font-medium text-fg transition-colors hover:border-line-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              Replace
            </button>
            {source !== "environment" && (
              <button
                onClick={remove}
                disabled={busy}
                className="rounded-lg border border-fail/40 bg-fail/15 px-3.5 py-2 text-[13px] font-medium text-fail transition-colors hover:bg-fail/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Removing…" : "Remove"}
              </button>
            )}
          </div>
        )}

        {(status === "unset" || editing) && (
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="sk-or-v1-…"
              aria-label="OpenRouter API key"
              className="w-72 max-w-full rounded-lg border border-line bg-ink-900 px-3 py-2 font-mono text-[13px] text-fg placeholder:text-fg-faint focus:border-signal/50 focus:outline-none"
            />
            <button
              onClick={save}
              disabled={!value.trim() || busy}
              className="rounded-lg border border-signal/40 bg-signal/15 px-3.5 py-2 text-[13px] font-medium text-signal transition-colors hover:bg-signal/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save key"}
            </button>
            {editing && (
              <button
                onClick={() => {
                  setEditing(false);
                  setValue("");
                  setErr(null);
                }}
                disabled={busy}
                className="text-[13px] text-fg-faint transition-colors hover:text-fg-muted"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {err && (
          <p role="alert" className="text-[12.5px] text-fail">
            {err}
          </p>
        )}
      </div>
    </section>
  );
}
