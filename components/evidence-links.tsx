"use client";
import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  FileText,
  Link2,
  Search,
  ChartNoAxesCombined,
} from "lucide-react";
import type { Artifact, ResearchRecord, Workspace } from "@/lib/schema";
import { Modal, KindBadge, jsonOptions, useWorkspaceApi } from "./ui";

type Actions = {
  workspace: Workspace;
  onChange: () => Promise<void>;
  notify: (message: string) => void;
};

export function ArtifactLinks({
  artifact,
  workspace,
  onChange,
  notify,
  onOpen,
}: Actions & { artifact: Artifact; onOpen: (record: ResearchRecord) => void }) {
  const { api } = useWorkspaceApi();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(artifact.recordIds);
  const [revision, setRevision] = useState(artifact.revision);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="evidence-links">
      <div className="section-heading">
        <h3>
          <Link2 size={15} /> Linked entries{" "}
          <span>{artifact.recordIds.length}</span>
        </h3>
        <button
          className="button secondary compact"
          onClick={() => {
            setSelected(artifact.recordIds);
            setRevision(artifact.revision);
            setError("");
            setEditing(true);
          }}
        >
          Manage links
        </button>
      </div>
      <div className="linked-entry-chips">
        {workspace.records
          .filter((r) => artifact.recordIds.includes(r.id))
          .map((r) => (
            <button key={r.id} onClick={() => onOpen(r)}>
              <KindBadge kind={r.kind} />
              <span>{r.title}</span>
              <ArrowUpRight size={13} />
            </button>
          ))}
      </div>
      {!artifact.recordIds.length && (
        <p className="muted">
          Connect this file to notes, findings, experiments or journal entries.
        </p>
      )}
      {editing && (
        <Modal title="Link file to entries" onClose={() => setEditing(false)}>
          <div className="link-picker">
            <span className="eyebrow">ONE FILE · MANY CONNECTIONS</span>
            <h2>Put the evidence in context.</h2>
            <p className="muted">
              {artifact.name} appears in every selected entry. The original file
              stays preserved.
            </p>
            <label className="link-search">
              <Search size={16} />
              <input
                aria-label="Search entries to link"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a note, finding or journal…"
              />
            </label>
            <div className="link-picker-list">
              {workspace.records
                .filter((r) =>
                  `${r.title} ${r.kind}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((r) => (
                  <label
                    key={r.id}
                    className={selected.includes(r.id) ? "selected" : ""}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(r.id)}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, r.id]
                            : ids.filter((id) => id !== r.id),
                        )
                      }
                    />
                    <KindBadge kind={r.kind} />
                    <span>{r.title}</span>
                  </label>
                ))}
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="workspace-form-actions">
              <span className="muted">{selected.length} linked entries</span>
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api(
                      `/api/artifacts/${artifact.id}`,
                      jsonOptions("PATCH", { recordIds: selected, revision }),
                    );
                    await onChange();
                    setEditing(false);
                    notify("File links saved");
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Saving…" : "Save links"}
                <Check size={14} />
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function EvidencePicker({
  record,
  workspace,
  onChange,
  notify,
  onClose,
}: Actions & { record: ResearchRecord; onClose: () => void }) {
  const { api } = useWorkspaceApi();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("files");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const files = workspace.artifacts.filter(
    (a) =>
      !a.recordIds.includes(record.id) &&
      a.name.toLowerCase().includes(query.toLowerCase()),
  );
  const charts = workspace.records
    .filter((r) => r.kind === "experiment" && r.id !== record.id)
    .flatMap((r) =>
      [...new Set(r.metrics.map((m) => m.name))].map((metricName) => ({
        experiment: r,
        metricName,
      })),
    )
    .filter(
      (c) =>
        `${c.metricName} ${c.experiment.title}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        !workspace.chartLinks.some(
          (l) =>
            l.recordId === record.id &&
            l.experimentId === c.experiment.id &&
            l.metricName === c.metricName,
        ),
    );
  async function link(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChange();
      notify("Evidence linked to this entry");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Link existing evidence" onClose={onClose}>
      <div className="link-picker">
        <span className="eyebrow">FROM YOUR WORKSPACE</span>
        <h2>Connect the dots.</h2>
        <p className="muted">
          Add saved files or measured charts to “{record.title}”.
        </p>
        <div className="detail-tabs">
          <button
            className={mode === "files" ? "active" : ""}
            onClick={() => setMode("files")}
          >
            Figures & files
          </button>
          <button
            className={mode === "charts" ? "active" : ""}
            onClick={() => setMode("charts")}
          >
            Metric charts
          </button>
        </div>
        <label className="link-search">
          <Search size={16} />
          <input
            aria-label="Search saved evidence"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your saved evidence…"
          />
        </label>
        <div className="link-picker-list">
          {mode === "files"
            ? files.map((a) => (
                <button
                  key={a.id}
                  disabled={busy}
                  onClick={() =>
                    link(() =>
                      api(
                        `/api/artifacts/${a.id}`,
                        jsonOptions("PATCH", {
                          recordIds: [...a.recordIds, record.id],
                          revision: a.revision,
                        }),
                      ),
                    )
                  }
                >
                  <FileText size={17} />
                  <span>
                    {a.name}
                    <small>
                      {(a.size / 1024).toFixed(1)} KB · {a.recordIds.length}{" "}
                      linked entries
                    </small>
                  </span>
                  <Link2 size={14} />
                </button>
              ))
            : charts.map((c) => (
                <button
                  key={`${c.experiment.id}:${c.metricName}`}
                  disabled={busy}
                  onClick={() =>
                    link(() =>
                      api(
                        "/api/charts",
                        jsonOptions("POST", {
                          experimentId: c.experiment.id,
                          metricName: c.metricName,
                          recordId: record.id,
                        }),
                      ),
                    )
                  }
                >
                  <ChartNoAxesCombined size={17} />
                  <span>
                    {c.metricName}
                    <small>{c.experiment.title}</small>
                  </span>
                  <Link2 size={14} />
                </button>
              ))}
        </div>
        {!(mode === "files" ? files.length : charts.length) && (
          <p className="muted">
            No matching evidence to add. Upload a file or log measured
            experiment metrics first.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function ChartLinkPicker({
  experiment,
  metricName,
  workspace,
  onChange,
  notify,
  onClose,
}: Actions & {
  experiment: ResearchRecord;
  metricName: string;
  onClose: () => void;
}) {
  const { api } = useWorkspaceApi();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Link chart to an entry" onClose={onClose}>
      <div className="link-picker">
        <span className="eyebrow">MEASURED SIGNAL · SHARED CONTEXT</span>
        <h2>Give this chart a home.</h2>
        <p className="muted">
          Link “{metricName}” to an entry. It follows the original experiment’s
          recorded metrics and provenance.
        </p>
        <label className="link-search">
          <Search size={16} />
          <input
            aria-label="Search chart destinations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a note, finding or journal…"
          />
        </label>
        <div className="link-picker-list">
          {workspace.records
            .filter(
              (r) =>
                r.id !== experiment.id &&
                r.title.toLowerCase().includes(query.toLowerCase()),
            )
            .map((r) => {
              const linked = workspace.chartLinks.some(
                (l) =>
                  l.experimentId === experiment.id &&
                  l.metricName === metricName &&
                  l.recordId === r.id,
              );
              return (
                <button
                  key={r.id}
                  disabled={busy || linked}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await api(
                        "/api/charts",
                        jsonOptions("POST", {
                          experimentId: experiment.id,
                          metricName,
                          recordId: r.id,
                        }),
                      );
                      await onChange();
                      notify("Chart linked to entry");
                      onClose();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <KindBadge kind={r.kind} />
                  <span>{r.title}</span>
                  {linked ? <Check size={15} /> : <Link2 size={15} />}
                </button>
              );
            })}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
