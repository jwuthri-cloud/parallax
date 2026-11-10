"use client";
import { useState, useEffect } from "react";
import { Select } from "./select";
import {
  ArtifactLinks,
  EvidencePicker,
  ChartLinkPicker,
} from "./evidence-links";
import { Markdown } from "./document-reader";
import { DocumentEditor } from "./document-editor";
import { ExperimentCharts, LinkedChart } from "./metric-charts";
import { ExperimentTraces } from "./traces/experiment-traces";
import { ExperimentRuns } from "./runs/runs-view";
import { CustomFieldInputs, CustomFieldSummary } from "./custom-fields";
export { Markdown } from "./document-reader";
import { z } from "zod";
import {
  ArrowUpRight,
  ChevronRight,
  Copy,
  Download,
  FileText,
  History,
  Link2,
  LockKeyhole,
  Pencil,
  Pin,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  recordInputSchema,
  type ResearchRecord,
  type Workspace,
  type Artifact,
} from "@/lib/schema";
import {
  useWorkspaceApi,
  jsonOptions,
  KindBadge,
  kindMeta,
  dateLabel,
  Modal,
  Money,
  EmptyState,
} from "./ui";

const templates: Record<ResearchRecord["kind"], string> = {
  note: "",
  reference: "## Why this matters\n\n\n## Source\n\n\n## Notes\n\n",
  journal:
    "## Goal\n\n\n## Did\n\n\n## Results\n\nInclude measured numbers, sample sizes, uncertainty, and links to run artifacts.\n\n## Decisions\n\n\n## Open questions\n\n\n## Next\n\n",
  experiment:
    "## Question\n\n\n## Hypothesis\n\n\n## Method\n\n\n## Results\n\nNot run yet.\n\n## Limitations\n\n",
  finding:
    "## Observation\n\n\n## Evidence\n\nLink the supporting experiment and artifacts.\n\n## Interpretation\n\n\n## Limitations & alternative explanations\n\n",
  task: "## Outcome\n\n\n## Acceptance criteria\n\n- [ ] \n",
  paper:
    "# Working title\n\n## Abstract\n\n## Introduction\n\n## Related work\n\n## Methods\n\n## Results\n\nLink verified findings and their supporting experiments.\n\n## Limitations\n\n## Safety & dual-use considerations\n\n## References\n\nInclude only sources you have checked.\n",
};

export function RecordEditor({
  kind,
  record,
  initialStatus,
  workspace,
  onClose,
  onSave,
}: {
  kind: ResearchRecord["kind"];
  record?: ResearchRecord;
  initialStatus?: ResearchRecord["status"];
  workspace: Workspace;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const { api } = useWorkspaceApi();
  const [draft, setDraft] = useState(() => ({
    ...recordInputSchema.parse(
      record || {
        kind,
        title: "Untitled",
        content: templates[kind],
        status:
          initialStatus ||
          (["experiment", "task"].includes(kind) ? "planned" : "draft"),
      },
    ),
    title: record?.title || "",
  }));
  const [tab, setTab] = useState("write");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState(record?.tags.join(", ") || "");
  const [initialMetrics] = useState(() =>
    JSON.stringify(record?.metrics || [], null, 2),
  );
  const [metrics, setMetrics] = useState(initialMetrics);
  const [charts, setCharts] = useState(
    JSON.stringify(record?.charts || [], null, 2),
  );
  const [dirty, setDirty] = useState(false);
  const update = (value: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...value }));
    setDirty(true);
  };
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const [confirmClose, setConfirmClose] = useState(false);
  const close = () => (dirty ? setConfirmClose(true) : onClose());
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      // Send points only when they were edited: the server keeps stored metrics when
      // the body has no `metrics` key (telemetry can stream points while this is open).
      const metricsEdited = !record || metrics !== initialMetrics;
      const { metrics: points, ...input } = recordInputSchema.parse({
        ...draft,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        ...(metricsEdited ? { metrics: JSON.parse(metrics) } : {}),
        charts: JSON.parse(charts),
        ...(record ? { revision: record.revision } : {}),
      });
      await api(
        record ? `/api/records/${record.id}` : "/api/records",
        jsonOptions(record ? "PATCH" : "POST", {
          ...input,
          ...(metricsEdited ? { metrics: points } : {}),
          ...(record ? { revision: record.revision } : {}),
        }),
      );
      await onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={record ? "Edit research entry" : "Create research entry"}
      onClose={close}
      wide
    >
      <form onSubmit={submit} className="editor-form">
        <div className="editor-header">
          <KindBadge kind={kind} />
          <span className="eyebrow">
            {record
              ? `REVISION ${record.revision + 1}`
              : "A NEW THREAD IN YOUR RESEARCH"}
          </span>
        </div>
        <input
          className="title-input"
          placeholder={`Give this ${kindMeta[kind].label.toLowerCase()} a title…`}
          aria-label="Entry title"
          required
          maxLength={200}
          value={draft.title}
          onChange={(e) => update({ title: e.target.value })}
        />
        <div className="editor-meta">
          <label>
            Status
            <Select
              label="Status"
              value={draft.status}
              onValueChange={(value) =>
                update({ status: value as typeof draft.status })
              }
              options={[
                "draft",
                "planned",
                "running",
                "completed",
                "inconclusive",
                "blocked",
              ].map((value) => ({ value, label: value }))}
            />
          </label>
          <label>
            Tags
            <input
              placeholder="pilot, arm-a, oversight"
              value={tags}
              onChange={(e) => {
                setTags(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          {kind === "finding" && (
            <label>
              Evidence
              <Select
                label="Evidence"
                value={draft.evidence}
                onValueChange={(value) =>
                  update({ evidence: value as typeof draft.evidence })
                }
                options={[
                  { value: "unverified", label: "Unverified / hypothesis" },
                  { value: "observed", label: "Observed" },
                  { value: "replicated", label: "Replicated" },
                ]}
              />
            </label>
          )}
        </div>
        <CustomFieldInputs
          kind={kind}
          definitions={workspace.fields}
          values={draft.fields}
          onChange={(fields) => update({ fields })}
        />
        {kind === "task" && (
          <div className="form-grid three">
            <label>
              Priority
              <Select
                label="Priority"
                value={draft.priority}
                onValueChange={(value) =>
                  update({ priority: value as typeof draft.priority })
                }
                options={["low", "medium", "high", "urgent"].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </label>
            <label>
              Assignee
              <input
                value={draft.assignee}
                onChange={(e) => update({ assignee: e.target.value })}
              />
            </label>
            <label>
              Due date
              <input
                type="date"
                value={draft.dueDate}
                onChange={(e) => update({ dueDate: e.target.value })}
              />
            </label>
          </div>
        )}
        <div className="editor-tabs">
          <div className="tabs">
            {[
              "write",
              "provenance",
              "connections",
              ...(kind === "experiment" ? ["run & metrics"] : []),
            ].map((t) => (
              <button
                type="button"
                key={t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {tab === "write" && (
          <DocumentEditor
            value={draft.content}
            title={draft.title}
            artifacts={workspace.artifacts}
            onChange={(content) => update({ content })}
          />
        )}
        {tab === "provenance" && (
          <div className="editor-panel">
            <p className="muted">
              Leave unknown fields blank. A content hash identifies the source
              snapshot, even when the working tree has uncommitted changes.
            </p>
            <div className="form-grid">
              {(
                [
                  "repository",
                  "commit",
                  "model",
                  "dataset",
                  "sourcePath",
                  "sourceHash",
                ] as const
              ).map((key) => (
                <label key={key}>
                  {
                    {
                      repository: "Repository path / URL",
                      commit: "Exact code commit",
                      model: "Model + revision",
                      dataset: "Dataset version / hash",
                      sourcePath: "Source path",
                      sourceHash: "Source SHA-256",
                    }[key]
                  }
                  <input
                    value={draft.provenance[key]}
                    onChange={(e) =>
                      update({
                        provenance: {
                          ...draft.provenance,
                          [key]: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              ))}
              <label>
                Random seed
                <input
                  type="number"
                  value={draft.provenance.seed ?? ""}
                  onChange={(e) =>
                    update({
                      provenance: {
                        ...draft.provenance,
                        seed:
                          e.target.value === "" ? null : Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            </div>
            <label>
              Exact command
              <input
                className="mono"
                value={draft.provenance.command}
                onChange={(e) =>
                  update({
                    provenance: {
                      ...draft.provenance,
                      command: e.target.value,
                    },
                  })
                }
              />
            </label>
            <label>
              Configuration snapshot
              <textarea
                className="code-input"
                rows={7}
                value={draft.provenance.config}
                onChange={(e) =>
                  update({
                    provenance: { ...draft.provenance, config: e.target.value },
                  })
                }
              />
            </label>
          </div>
        )}
        {tab === "connections" && (
          <div className="editor-panel">
            <p className="muted">
              Link related work. Use the Knowledge graph to add specific
              relationships such as “supports” or “contradicts.”
            </p>
            <div className="connection-picker">
              {workspace.records
                .filter((r) => r.id !== record?.id)
                .map((r) => (
                  <label key={r.id}>
                    <input
                      type="checkbox"
                      checked={draft.linkedIds.includes(r.id)}
                      onChange={(e) =>
                        update({
                          linkedIds: e.target.checked
                            ? [...draft.linkedIds, r.id]
                            : draft.linkedIds.filter((id) => id !== r.id),
                        })
                      }
                    />
                    <KindBadge kind={r.kind} />
                    <span>{r.title}</span>
                  </label>
                ))}
            </div>
          </div>
        )}
        {tab === "run & metrics" && (
          <div className="editor-panel">
            <div className="form-grid three">
              <label>
                Estimated cost · USD
                <input
                  min={0}
                  type="number"
                  step="any"
                  value={draft.estimateUsd ?? ""}
                  onChange={(e) =>
                    update({
                      estimateUsd:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Recorded cost · USD
                <input
                  min={0}
                  type="number"
                  step="any"
                  value={draft.costUsd ?? ""}
                  onChange={(e) =>
                    update({
                      costUsd:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                GPU hours
                <input
                  min={0}
                  type="number"
                  step="any"
                  value={draft.gpuHours ?? ""}
                  onChange={(e) =>
                    update({
                      gpuHours:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label>
              Decision gate
              <textarea
                rows={3}
                placeholder="What result means go, stop, or revise?"
                value={draft.gate}
                onChange={(e) => update({ gate: e.target.value })}
              />
            </label>
            <label>
              Decision
              <Select
                label="Decision"
                value={draft.decision}
                onValueChange={(value) =>
                  update({ decision: value as typeof draft.decision })
                }
                options={["pending", "go", "no-go", "revise"].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </label>
            <label>
              Measured metrics · JSON
              <textarea
                rows={8}
                className="code-input"
                value={metrics}
                onChange={(e) => {
                  setMetrics(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <p className="field-help">
              Each item: name, step, value, optional unit, n, lower, upper. Name
              related series group/series (loss/train, loss/val) to share a
              chart. Only record actual measurements. Agents can append via
              log_metrics.
            </p>
            <label>
              Chart panels · JSON
              <textarea
                rows={6}
                className="code-input"
                placeholder='[{ "title": "Loss", "metrics": ["loss/*"], "goal": "min", "smoothing": 0.6 }]'
                value={charts}
                onChange={(e) => {
                  setCharts(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <p className="field-help">
              Optional. Each panel: title, metrics (names or group/*), type line
              | bar | scatter, xLabel, yLabel, format auto | percent | fixed |
              scientific, logY, smoothing 0–0.99, goal min | max. Metrics
              outside every panel are grouped automatically. Agents can use
              set_charts.
            </p>
          </div>
        )}
        {kind === "journal" && (
          <div className="notice">
            <History size={16} />
            Journal text is permanent once saved. Add a linked entry for later
            corrections.
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {confirmClose && (
          <div className="unsaved-prompt">
            Discard your unsaved changes?
            <button type="button" onClick={() => setConfirmClose(false)}>
              Keep editing
            </button>
            <button type="button" onClick={onClose}>
              Discard
            </button>
          </div>
        )}
        <div className="editor-footer">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.sensitive}
              onChange={(e) => update({ sensitive: e.target.checked })}
            />
            <LockKeyhole size={13} />
            Sensitive research
          </label>
          <span className="field-help">Stored locally · never published</span>
          <button className="button primary" disabled={saving} type="submit">
            <Save size={15} />
            {saving ? "Saving…" : record ? "Save revision" : "Save entry"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RecordDetail({
  record,
  workspace,
  onClose,
  onEdit,
  onOpen,
  onChange,
  notify,
}: {
  record: ResearchRecord;
  workspace: Workspace;
  onClose: () => void;
  onEdit: () => void;
  onOpen: (r: ResearchRecord) => void;
  onChange: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const { api } = useWorkspaceApi();
  const [tab, setTab] = useState("entry");
  const [evidencePicker, setEvidencePicker] = useState(false);
  const [chartToLink, setChartToLink] = useState<string | null>(null);
  const [history, setHistory] = useState<ResearchRecord[]>([]);
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const related = new Set([
    ...record.linkedIds,
    ...workspace.records
      .filter((r) => r.linkedIds.includes(record.id))
      .map((r) => r.id),
  ]);
  const edges = workspace.relations.filter(
    (e) => e.source === record.id || e.target === record.id,
  );
  edges.forEach((e) =>
    related.add(e.source === record.id ? e.target : e.source),
  );
  const artifacts = workspace.artifacts.filter((a) =>
    a.recordIds.includes(record.id),
  );
  artifacts.forEach((a) =>
    a.recordIds.forEach((id) => {
      if (id !== record.id) related.add(id);
    }),
  );
  const chartLinks = workspace.chartLinks.filter(
    (l) => l.recordId === record.id,
  );
  chartLinks.forEach((l) => related.add(l.experimentId));
  workspace.chartLinks
    .filter((l) => l.experimentId === record.id)
    .forEach((l) => related.add(l.recordId));
  useEffect(() => {
    setTab("entry");
    setHistory([]);
  }, [record.id]);
  const showHistory = async () => {
    try {
      setHistory(
        await api<ResearchRecord[]>(`/api/records/${record.id}?history`),
      );
      setTab("history");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  async function pin() {
    try {
      await api(
        `/api/records/${record.id}`,
        jsonOptions("PATCH", { action: "pin", revision: record.revision }),
      );
      await onChange();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function remove() {
    try {
      await api(
        `/api/records/${record.id}`,
        jsonOptions("DELETE", { revision: record.revision }),
      );
      onClose();
      await onChange();
      notify("Deleted; revision history kept in exports");
    } catch (e) {
      setConfirmDelete(false);
      notify((e as Error).message);
    }
  }
  return (
    <>
      <Modal title={record.title} onClose={onClose} wide>
        <article className="record-detail">
          <div className="detail-topline">
            <KindBadge kind={record.kind} />
            <span className={`status-pill ${record.status}`}>
              {record.status}
            </span>
            {record.sensitive && (
              <span className="sensitive-label">
                <LockKeyhole size={12} />
                Sensitive
              </span>
            )}
          </div>
          <h2>{record.title}</h2>
          <div className="detail-byline">
            <span className="avatar tiny">{record.author[0]}</span>
            {record.author}
            <span>·</span>
            {dateLabel(record.createdAt, true)}
            <span>·</span>rev {record.revision}
            <div className="detail-actions">
              <button
                className={`icon-button ${record.pinned ? "is-pinned" : ""}`}
                onClick={pin}
                aria-label={record.pinned ? "Unpin entry" : "Pin entry"}
              >
                <Pin size={16} />
              </button>
              {record.kind !== "journal" && (
                <button className="button secondary compact" onClick={onEdit}>
                  <Pencil size={13} />
                  Edit
                </button>
              )}
              {record.kind !== "journal" && (
                <button
                  className="icon-button"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete entry"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </div>
          {confirmDelete && (
            <div className="unsaved-prompt" role="alert">
              Delete this entry and its links? Files stay in the workspace.
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button type="button" onClick={remove}>
                Delete
              </button>
            </div>
          )}
          <div className="detail-tags">
            {record.tags.map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
          </div>
          <CustomFieldSummary
            definitions={workspace.fields}
            values={record.fields}
          />
          <div className="tabs detail-tabs">
            <button
              onClick={() => setTab("entry")}
              className={tab === "entry" ? "active" : ""}
            >
              Entry
            </button>
            <button
              onClick={() => setTab("provenance")}
              className={tab === "provenance" ? "active" : ""}
            >
              Provenance
            </button>
            <button
              onClick={() => setTab("connections")}
              className={tab === "connections" ? "active" : ""}
            >
              Connections <span>{related.size}</span>
            </button>
            <button
              onClick={showHistory}
              className={tab === "history" ? "active" : ""}
            >
              History
            </button>
          </div>
          {tab === "entry" && (
            <>
              {record.tags.includes("imported") && (
                <div className="notice">
                  <FileText size={16} />
                  Source snapshot. Claims were imported as written and have not
                  been independently verified.
                </div>
              )}
              {record.kind === "finding" && (
                <div className={`evidence-banner ${record.evidence}`}>
                  <ShieldCheck size={18} />
                  <span>
                    Evidence: <strong>{record.evidence}</strong>{" "}
                    <small>
                      Recorded by the author; not an automated verification.
                    </small>
                  </span>
                </div>
              )}
              {record.kind === "experiment" && (
                <>
                  <div className="run-summary">
                    <div>
                      <span>MODEL</span>
                      <strong>
                        {record.provenance.model || "Not recorded"}
                      </strong>
                    </div>
                    <div>
                      <span>SEED</span>
                      <strong>{record.provenance.seed ?? "—"}</strong>
                    </div>
                    <div>
                      <span>ESTIMATED</span>
                      <strong>
                        {record.estimateUsd === null ? (
                          "—"
                        ) : (
                          <Money value={record.estimateUsd} />
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>RECORDED</span>
                      <strong>
                        {record.costUsd === null ? (
                          "—"
                        ) : (
                          <Money value={record.costUsd} />
                        )}
                      </strong>
                    </div>
                  </div>
                  {record.gate && (
                    <div className="decision-gate">
                      <span className="eyebrow">
                        GO / NO-GO GATE <b>{record.decision}</b>
                      </span>
                      <p>{record.gate}</p>
                    </div>
                  )}
                  <ExperimentCharts record={record} onLink={setChartToLink} />
                  <ExperimentRuns experimentId={record.id} />
                  <ExperimentTraces experimentId={record.id} />
                </>
              )}
              {record.kind === "task" && (
                <div className="task-detail-meta">
                  <span className={`priority-dot ${record.priority}`} />
                  {record.priority} priority<span>·</span>
                  {record.assignee || "Unassigned"}
                  {record.dueDate && (
                    <>
                      <span>·</span>Due {record.dueDate}
                    </>
                  )}
                </div>
              )}
              <Markdown>{record.content || "*No content yet.*"}</Markdown>
              {chartLinks.length > 0 && (
                <section className="linked-charts">
                  <h3>
                    Linked charts <span>{chartLinks.length}</span>
                  </h3>
                  {chartLinks.map((link) => {
                    const source = workspace.records.find(
                      (r) => r.id === link.experimentId,
                    );
                    if (!source) return null;
                    return (
                      <div className="linked-chart" key={link.id}>
                        <div className="linked-chart-source">
                          <button onClick={() => onOpen(source)}>
                            <Link2 size={13} />
                            {source.title}
                            <ArrowUpRight size={13} />
                          </button>
                          <button
                            className="text-button"
                            onClick={async () => {
                              try {
                                await api(
                                  "/api/charts",
                                  jsonOptions("DELETE", { id: link.id }),
                                );
                                await onChange();
                                notify(
                                  "Chart unlinked; source metrics preserved",
                                );
                              } catch (e) {
                                notify((e as Error).message);
                              }
                            }}
                          >
                            Unlink
                          </button>
                        </div>
                        <LinkedChart record={source} name={link.metricName} />
                        <p className="form-hint">
                          Live source · revision {source.revision} · linking
                          does not establish scientific support.
                        </p>
                      </div>
                    );
                  })}
                </section>
              )}
              <div className="attached-section">
                <h3>
                  Attached evidence <span>{artifacts.length}</span>
                </h3>
                <div className="attached-files">
                  {artifacts.map((a) => (
                    <button key={a.id} onClick={() => setPreviewArtifact(a)}>
                      <FileText size={17} />
                      <span>
                        {a.name}
                        <small>
                          {(a.size / 1024).toFixed(1)} KB · SHA-256{" "}
                          {a.hash.slice(0, 10)}
                        </small>
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
                <button
                  className="button secondary compact"
                  onClick={() => setEvidencePicker(true)}
                >
                  <Link2 size={14} />
                  Link existing file or chart
                </button>
                <UploadButton
                  recordId={record.id}
                  onChange={onChange}
                  notify={notify}
                />
              </div>
            </>
          )}
          {tab === "provenance" && (
            <div className="provenance-panel">
              <p className="muted">
                Recorded context for reproducing this work. Blank fields are
                unknown, not inferred.
              </p>
              <dl>
                {Object.entries(record.provenance)
                  .filter(([k]) => k !== "config")
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                      <dd>
                        {value === "" || value === null ? (
                          <span className="unknown">Not recorded</span>
                        ) : (
                          String(value)
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
              {record.provenance.config && (
                <>
                  <h3>Configuration snapshot</h3>
                  <pre>{record.provenance.config}</pre>
                </>
              )}
            </div>
          )}
          {tab === "connections" && (
            <div className="detail-connections">
              {related.size ? (
                workspace.records
                  .filter((r) => related.has(r.id))
                  .map((r) => (
                    <button
                      className="connection-row"
                      key={r.id}
                      onClick={() => onOpen(r)}
                    >
                      <KindBadge kind={r.kind} />
                      <strong>{r.title}</strong>
                      <small>
                        {edges.find(
                          (e) => e.source === r.id || e.target === r.id,
                        )?.type ||
                          (workspace.chartLinks.some(
                            (l) =>
                              (l.recordId === record.id &&
                                l.experimentId === r.id) ||
                              (l.experimentId === record.id &&
                                l.recordId === r.id),
                          )
                            ? "chart"
                            : artifacts.some((a) => a.recordIds.includes(r.id))
                              ? "shared file"
                              : "related")}
                      </small>
                      <ArrowUpRight size={15} />
                    </button>
                  ))
              ) : (
                <EmptyState
                  icon={Link2}
                  title="Connect this thought"
                  description="Edit this entry to link related work, or add a typed relationship in the Knowledge graph."
                />
              )}
            </div>
          )}
          {tab === "history" && (
            <div className="history-list">
              {history.map((r) => (
                <details key={r.revision}>
                  <summary>
                    <History size={15} />
                    Revision {r.revision}
                    <span>
                      {dateLabel(r.updatedAt, true)} ·{" "}
                      {new Date(r.updatedAt).toLocaleTimeString()}
                    </span>
                    <ChevronRight size={15} />
                  </summary>
                  <h3>{r.title}</h3>
                  <Markdown>{r.content}</Markdown>
                  <details className="snapshot-json">
                    <summary>Full record snapshot</summary>
                    <pre>{JSON.stringify(r, null, 2)}</pre>
                  </details>
                </details>
              ))}
            </div>
          )}
          <div className="record-id">
            {record.id}
            <button
              aria-label="Copy record ID"
              onClick={() =>
                navigator.clipboard
                  .writeText(record.id)
                  .then(() => notify("Record ID copied"))
                  .catch(() => notify("Clipboard is unavailable"))
              }
            >
              <Copy size={12} />
            </button>
          </div>
        </article>
      </Modal>
      {evidencePicker && (
        <EvidencePicker
          record={record}
          workspace={workspace}
          onChange={onChange}
          notify={notify}
          onClose={() => setEvidencePicker(false)}
        />
      )}
      {chartToLink && (
        <ChartLinkPicker
          experiment={record}
          metricName={chartToLink}
          workspace={workspace}
          onChange={onChange}
          notify={notify}
          onClose={() => setChartToLink(null)}
        />
      )}
      {previewArtifact && (
        <ArtifactPreview
          artifact={
            workspace.artifacts.find((a) => a.id === previewArtifact.id) ||
            previewArtifact
          }
          workspace={workspace}
          onChange={onChange}
          notify={notify}
          onOpen={(r) => {
            setPreviewArtifact(null);
            onOpen(r);
          }}
          onClose={() => setPreviewArtifact(null)}
        />
      )}
    </>
  );
}

export function UploadButton({
  recordId,
  onChange,
  notify,
  label = "Attach a file",
}: {
  recordId?: string;
  onChange: () => Promise<void>;
  notify: (s: string) => void;
  label?: string;
}) {
  const { api } = useWorkspaceApi();
  const [busy, setBusy] = useState(false);
  return (
    <label
      className={`button secondary upload-button ${busy ? "disabled" : ""}`}
    >
      <Upload size={15} />
      {busy ? "Uploading…" : label}
      <input
        type="file"
        multiple
        disabled={busy}
        accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,.csv,.tsv,.json,.jsonl,.md,.txt,.ipynb,.html,.toml,.yaml"
        onChange={async (e) => {
          const files = [...(e.target.files || [])];
          setBusy(true);
          try {
            for (const file of files) {
              const form = new FormData();
              form.append("file", file);
              if (recordId) form.append("recordId", recordId);
              await api("/api/artifacts", { method: "POST", body: form });
            }
            notify(
              `${files.length} file${files.length > 1 ? "s" : ""} saved with content hashes`,
            );
          } catch (err) {
            notify((err as Error).message);
          } finally {
            await onChange();
            setBusy(false);
            e.target.value = "";
          }
        }}
      />
    </label>
  );
}

export function ArtifactPreview({
  artifact,
  workspace,
  onChange,
  notify,
  onOpen,
  onClose,
}: {
  artifact: Artifact;
  workspace: Workspace;
  onChange: () => Promise<void>;
  notify: (message: string) => void;
  onOpen: (record: ResearchRecord) => void;
  onClose: () => void;
}) {
  const { api, url } = useWorkspaceApi();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const interactive =
    artifact.mime === "text/html" || artifact.mime === "image/svg+xml";
  const raster = /^image\/(png|jpeg|webp|gif)$/.test(artifact.mime);
  useEffect(() => {
    if (!raster && !interactive && artifact.mime !== "application/pdf")
      api<{ text: string; truncated: boolean }>(
        `/api/artifacts/${artifact.id}?text`,
      )
        .then((r) => {
          setText(r.text);
          setTruncated(r.truncated);
        })
        .catch((e) => setError(e.message));
  }, [artifact.id, artifact.mime, raster, interactive, api]);
  let notebook: {
    cells: {
      cell_type: string;
      source: string | string[];
      outputs?: {
        text?: string | string[];
        data?: Record<string, string | string[]>;
      }[];
    }[];
  } | null = null;
  if (artifact.name.endsWith(".ipynb") && text) {
    try {
      const stringOrLines = z.union([z.string(), z.array(z.string())]);
      notebook = z
        .object({
          cells: z.array(
            z.object({
              cell_type: z.string(),
              source: stringOrLines,
              outputs: z
                .array(
                  z.object({
                    text: stringOrLines.optional(),
                    data: z.record(z.string(), stringOrLines).optional(),
                  }),
                )
                .optional(),
            }),
          ),
        })
        .parse(JSON.parse(text));
    } catch {
      /* Show the raw content if the notebook is invalid or truncated. */
    }
  }
  return (
    <Modal title={artifact.name} onClose={onClose} wide full={expanded}>
      <div className={`artifact-preview ${expanded ? "expanded" : ""}`}>
        <span className="eyebrow">RESEARCH ARTIFACT</span>
        <h2>{artifact.name}</h2>
        <p className="muted">
          {artifact.caption || "A preserved file from your research."}
        </p>
        <div className="artifact-metadata">
          <span>{(artifact.size / 1024).toFixed(1)} KB</span>
          <span>{dateLabel(artifact.createdAt, true)}</span>
          <a
            className="button secondary compact"
            href={url(`/api/artifacts/${artifact.id}?download`)}
          >
            <Download size={14} />
            Download original
          </a>
          {interactive && (
            <button
              className="button secondary compact"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Compact view" : "Expand viewer"}
              <ArrowUpRight size={14} />
            </button>
          )}
        </div>
        <ArtifactLinks
          artifact={artifact}
          workspace={workspace}
          onChange={onChange}
          notify={notify}
          onOpen={onOpen}
        />
        {error && <p className="form-error">{error}</p>}
        {truncated && (
          <div className="notice">
            Preview shows the first 500,000 characters. Download the original
            for the complete file.
          </div>
        )}
        {raster ? (
          <img
            className="artifact-image"
            src={url(`/api/artifacts/${artifact.id}`)}
            alt={artifact.caption || artifact.name}
          />
        ) : artifact.mime === "application/pdf" ? (
          <EmptyState
            icon={FileText}
            title="PDF preserved"
            description="Download the original PDF to inspect it in your preferred reader."
          />
        ) : artifact.mime === "text/html" ||
          artifact.mime === "image/svg+xml" ? (
          <>
            <div className="notice">
              Interactive preview · runs in an isolated frame. External
              resources stay offline; use a self-contained HTML export. Reports
              using the Parallax kit follow your theme.
            </div>
            <iframe
              title={artifact.name}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              src={url(
                `/api/artifacts/${artifact.id}?preview&theme=${document.documentElement.dataset.theme || "moss"}`,
              )}
              className="html-preview"
            />
          </>
        ) : notebook?.cells ? (
          <div className="notebook-preview">
            {notebook.cells.map((cell, i) => (
              <div className="notebook-cell" key={i}>
                <span className="eyebrow">
                  {cell.cell_type === "code" ? `CELL ${i + 1}` : "MARKDOWN"}
                </span>
                {cell.cell_type === "markdown" ? (
                  <Markdown>
                    {Array.isArray(cell.source)
                      ? cell.source.join("")
                      : cell.source}
                  </Markdown>
                ) : (
                  <pre>
                    {Array.isArray(cell.source)
                      ? cell.source.join("")
                      : cell.source}
                  </pre>
                )}
                {cell.outputs?.map((o, j) => {
                  const content = o.text || o.data?.["text/plain"];
                  const png = o.data?.["image/png"];
                  const image = Array.isArray(png) ? png.join("") : png;
                  return (
                    <div key={j}>
                      {content && (
                        <pre className="notebook-output">
                          {Array.isArray(content) ? content.join("") : content}
                        </pre>
                      )}
                      {image && (
                        <img
                          className="artifact-image"
                          alt={`Saved output from notebook cell ${i + 1}`}
                          src={`data:image/png;base64,${image}`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : artifact.mime === "text/markdown" ? (
          <Markdown>{text}</Markdown>
        ) : (
          <pre className="file-preview-text">{text || "Loading file…"}</pre>
        )}
        <div className="file-hash">
          <span>SHA-256</span>
          <code>{artifact.hash}</code>
        </div>
        {artifact.sourcePath && (
          <p className="source-path">Source: {artifact.sourcePath}</p>
        )}
      </div>
    </Modal>
  );
}
