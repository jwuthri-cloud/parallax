"use client";
import { useState } from "react";
import { ThemePicker } from "./theme-picker";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Circle,
  Clock3,
  Code2,
  Columns3,
  Copy,
  Download,
  FileText,
  Flag,
  GitBranch,
  Image as ImageIcon,
  Link2,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Upload,
} from "lucide-react";
import type { ResearchRecord, Workspace, Artifact } from "@/lib/schema";
import {
  useWorkspaceApi,
  jsonOptions,
  EmptyState,
  Modal,
  RecordCard,
  excerpt,
} from "./ui";
import { ArtifactPreview, UploadButton } from "./records";
import { hasSupportingExperiment } from "@/lib/research";
import { Select } from "./select";
import { BudgetInput } from "./budget-input";
import { FieldDefinitionsEditor } from "./custom-fields";
import { ReportKitCard } from "./report-kit";

export function Board({
  workspace,
  onOpen,
  onCreate,
  onMove,
}: {
  workspace: Workspace;
  onOpen: (r: ResearchRecord) => void;
  onCreate: (status?: ResearchRecord["status"]) => void;
  onMove: (
    r: ResearchRecord,
    status: ResearchRecord["status"],
  ) => Promise<void>;
}) {
  const [filter, setFilter] = useState("all");
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState("");
  const tasks = workspace.records.filter(
    (r) => r.kind === "task" && (filter === "all" || r.priority === filter),
  );
  const columns = [
    { status: "draft", label: "Backlog", color: "var(--muted)" },
    { status: "planned", label: "Up next", color: "var(--purple)" },
    { status: "running", label: "In progress", color: "var(--lime)" },
    { status: "blocked", label: "Blocked", color: "var(--orange)" },
    { status: "completed", label: "Done", color: "var(--blue)" },
  ] as const;
  return (
    <>
      <p className="page-description">
        A clear next move, for you and your agents.
      </p>
      <div className="board-toolbar">
        <span className="subtle-label">
          <span className="status-dot" />
          Shared with your MCP agent
          <span className="toolbar-count">{tasks.length} tasks</span>
        </span>
        <div>
          <Select
            label="Filter tasks by priority"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "all", label: "All priorities" },
              ...["urgent", "high", "medium", "low"].map((value) => ({
                value,
                label: `${value} priority`,
              })),
            ]}
          />
          <button className="button secondary" onClick={() => onCreate()}>
            <Plus size={14} />
            New task
          </button>
        </div>
      </div>
      <div className="kanban-board">
        {columns.map((column) => {
          const items = tasks.filter((r) =>
            column.status === "draft"
              ? ["draft", "inconclusive"].includes(r.status)
              : r.status === column.status,
          );
          return (
            <section
              key={column.status}
              className={`kanban-column ${over === column.status ? "drag-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(column.status);
              }}
              onDragLeave={() => setOver("")}
              onDrop={(e) => {
                e.preventDefault();
                const task = tasks.find((r) => r.id === drag);
                setDrag(null);
                setOver("");
                if (task && task.status !== column.status)
                  void onMove(task, column.status);
              }}
            >
              <div className="column-heading">
                <span style={{ background: column.color }} />
                <h2>{column.label}</h2>
                <b>{items.length}</b>
                <button
                  className="icon-button"
                  aria-label={`Add task to ${column.label}`}
                  onClick={() => onCreate(column.status)}
                >
                  <Plus size={14} />
                </button>
              </div>
              <div className="column-content">
                {items.map((task) => (
                  <article
                    className={`kanban-card ${drag === task.id ? "dragging" : ""}`}
                    draggable
                    key={task.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", task.id);
                      setDrag(task.id);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver("");
                    }}
                  >
                    <button className="task-open" onClick={() => onOpen(task)}>
                      <div className="task-top">
                        <span className={`task-priority ${task.priority}`}>
                          <Flag size={11} />
                          {task.priority}
                        </span>
                        <ArrowUpRight size={13} />
                      </div>
                      <h3>{task.title}</h3>
                      <p>{excerpt(task.content, 100)}</p>
                    </button>
                    <div className="task-tags">
                      {task.tags.slice(0, 2).map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="task-footer">
                      <span className="avatar tiny" title={task.assignee}>
                        {task.assignee?.[0] || "?"}
                      </span>
                      {task.dueDate && (
                        <span className="task-date">
                          <Clock3 size={11} />
                          {task.dueDate.slice(5)}
                        </span>
                      )}
                      <Select
                        label={`Move ${task.title}`}
                        value={
                          task.status === "inconclusive" ? "draft" : task.status
                        }
                        onValueChange={(value) =>
                          void onMove(task, value as ResearchRecord["status"])
                        }
                        options={columns.map((c) => ({
                          value: c.status,
                          label: c.label,
                        }))}
                      />
                    </div>
                  </article>
                ))}
                {!items.length && (
                  <div className="column-empty">Room for what’s next.</div>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div className="board-help">
        <Columns3 size={14} />
        Drag tasks between columns, or use a card’s status menu.
        <span>
          Agents use <code>create_record</code> and <code>update_task</code>.
        </span>
      </div>
    </>
  );
}

export function ArtifactsView({
  workspace,
  onChange,
  onOpen,
  notify,
}: {
  workspace: Workspace;
  onChange: () => Promise<void>;
  onOpen: (record: ResearchRecord) => void;
  notify: (s: string) => void;
}) {
  const { url } = useWorkspaceApi();
  const [filter, setFilter] = useState("all");
  const [preview, setPreview] = useState<Artifact | null>(null);
  const files = workspace.artifacts.filter(
    (a) =>
      filter === "all" ||
      (filter === "figures"
        ? a.mime.startsWith("image/")
        : filter === "notebooks"
          ? a.name.endsWith(".ipynb")
          : filter === "data"
            ? /\.(csv|tsv|json|jsonl)$/.test(a.name)
            : /\.(pdf|html|md|txt|toml|yaml)$/.test(a.name)),
  );
  return (
    <>
      <p className="page-description">
        Every figure, notebook, and artifact. Preserved with its fingerprint.
      </p>
      <div className="collection-toolbar">
        <div className="tabs">
          {["all", "figures", "notebooks", "data", "documents"].map((f) => (
            <button
              key={f}
              className={filter === f ? "active" : ""}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All files" : f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <UploadButton
          onChange={onChange}
          notify={notify}
          label="Upload files"
        />
      </div>
      {files.length ? (
        <div className="artifacts-grid">
          {files.map((a) => {
            const raster = /^image\/(png|jpeg|webp|gif)$/.test(a.mime);
            const notebook = a.name.endsWith(".ipynb");
            return (
              <button
                className="artifact-card"
                key={a.id}
                onClick={() => setPreview(a)}
              >
                <div
                  className={`artifact-thumbnail ${notebook ? "notebook-thumbnail" : ""}`}
                >
                  {raster ? (
                    <img
                      src={url(`/api/artifacts/${a.id}`)}
                      alt={a.caption || a.name}
                    />
                  ) : (
                    <>
                      <div className="document-lines">
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                      </div>
                      {notebook ? (
                        <Code2 size={32} strokeWidth={1.1} />
                      ) : a.mime === "text/html" ? (
                        <Network size={36} strokeWidth={1} />
                      ) : (
                        <FileText size={34} strokeWidth={1} />
                      )}
                      <span>{a.name.split(".").pop()?.toUpperCase()}</span>
                    </>
                  )}
                  <span className="file-private">
                    <LockKeyhole size={11} />
                  </span>
                </div>
                <div className="artifact-card-info">
                  <h3>
                    {a.name}
                    <ArrowUpRight size={14} />
                  </h3>
                  <p>
                    {a.caption ||
                      (a.recordId
                        ? workspace.records.find((r) => r.id === a.recordId)
                            ?.title
                        : "Unlinked artifact")}
                  </p>
                  <footer>
                    <span>{(a.size / 1024).toFixed(1)} KB</span>
                    <span>
                      <Link2 size={11} /> {a.recordIds.length} links
                    </span>
                  </footer>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={ImageIcon}
          title="The evidence belongs here."
          description="Upload figures, Jupyter notebooks, data, PDFs, or interactive HTML. Original bytes are preserved. HTML opens in an isolated interactive viewer."
        />
      )}
      <div className="file-formats">
        <Upload size={14} />
        PNG · SVG · PDF · CSV · JSON · IPYNB · HTML · Markdown
        <span>25 MB per file · stored locally</span>
      </div>
      {preview && (
        <ArtifactPreview
          artifact={
            workspace.artifacts.find((a) => a.id === preview.id) || preview
          }
          workspace={workspace}
          onChange={onChange}
          notify={notify}
          onOpen={(r) => {
            setPreview(null);
            onOpen(r);
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

export function SettingsView({
  workspace,
  onChange,
  notify,
}: {
  workspace: Workspace;
  onChange: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const { api, url } = useWorkspaceApi();
  const [settings, setSettings] = useState(workspace.settings);
  const [busy, setBusy] = useState(false);
  const root = workspace.mcpPath.replace(/\/mcp\/server\.ts$/, "");
  const config = JSON.stringify(
    {
      mcpServers: {
        parallax: {
          command: "node",
          args: [root + "/node_modules/tsx/dist/cli.mjs", workspace.mcpPath],
          env: {
            PARALLAX_DATA_DIR: workspace.storageRoot,
            PARALLAX_WORKSPACE_ID: workspace.info.id,
          },
        },
      },
    },
    null,
    2,
  );
  const copy = (value: string) =>
    navigator.clipboard
      .writeText(value)
      .then(() => notify("Copied to clipboard"))
      .catch(() => notify("Clipboard unavailable. Select and copy the text."));
  const runImport = async () => {
    setBusy(true);
    try {
      const r = await api<{ message: string }>("/api/import", {
        method: "POST",
      });
      await onChange();
      notify(r.message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="page-description">
        Your workspace, your infrastructure, your rules.
      </p>
      <section className="settings-card appearance-card">
        <ThemePicker />
      </section>
      <div className="settings-grid">
        <section className="settings-card workspace-settings-card">
          <div className="settings-title">
            <Settings2 size={19} />
            <h2>The research workspace</h2>
          </div>
          <form
            className="workspace-settings-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/api/workspace", jsonOptions("PATCH", settings));
                await onChange();
                notify("Workspace settings saved");
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            <label>
              Project name
              <input
                required
                value={settings.project}
                onChange={(e) =>
                  setSettings({ ...settings, project: e.target.value })
                }
              />
            </label>
            <label>
              Current phase
              <Select
                label="Current phase"
                value={settings.phase}
                onValueChange={(value) =>
                  setSettings({
                    ...settings,
                    phase: value as typeof settings.phase,
                  })
                }
                showDescription
                options={[
                  {
                    value: "pilot",
                    label: "Pre-fellowship pilot",
                    description: "Small experiments · one total budget",
                  },
                  {
                    value: "fellowship",
                    label: "Fellowship",
                    description: "Full-time research · a monthly budget",
                  },
                ]}
              />
            </label>
            <div className="settings-budget-grid">
              <BudgetInput
                label="Pilot budget"
                period="total for the pilot"
                value={settings.pilotBudget}
                onChange={(pilotBudget) =>
                  setSettings({ ...settings, pilotBudget })
                }
              />
              <BudgetInput
                label="Fellowship budget"
                period="per month"
                value={settings.fellowshipBudget}
                onChange={(fellowshipBudget) =>
                  setSettings({ ...settings, fellowshipBudget })
                }
              />
            </div>
            <p className="field-help settings-budget-note">
              Spend is manually recorded. Fellowship totals group experiments by
              creation month. This is a planning aid, not a billing integration.
            </p>
            <button className="button primary settings-save" type="submit">
              <Check size={15} />
              Save settings
            </button>
          </form>
        </section>
        <section className="settings-card">
          <div className="settings-title">
            <GitBranch size={19} />
            <h2>Connected repository</h2>
          </div>
          <span className="eyebrow">READ-ONLY SOURCE</span>
          <code className="path-box">{workspace.researchRoot}</code>
          <p>
            Import README and documentation as source snapshots. Changed
            documents become new versions linked to the previous import.
          </p>
          <button
            className="button secondary"
            onClick={runImport}
            disabled={busy}
          >
            <RefreshCw size={15} className={busy ? "spin" : ""} />
            {busy ? "Importing…" : "Import latest documentation"}
          </button>
          <div className="settings-divider" />
          <span className="eyebrow">YOUR PRIVATE STORE</span>
          <code className="path-box">{workspace.dataDir}</code>
          <p>
            SQLite records, revision history, and content-addressed files. Back
            up this whole folder, or export a portable JSON snapshot including
            all file bytes.
          </p>
          <a className="button secondary" href={url("/api/export")}>
            <Download size={15} />
            Export full workspace
          </a>
        </section>
        <FieldDefinitionsEditor
          key={JSON.stringify(workspace.fields)}
          definitions={workspace.fields}
          onChange={onChange}
          notify={notify}
        />
        <ReportKitCard copy={copy} />
        <section className="settings-card mcp-settings">
          <div className="settings-title">
            <Terminal size={19} />
            <h2>Give your agent a memory</h2>
            <span className="tag lime">MCP / STDIO</span>
          </div>
          <p>
            Claude Code can keep the board current, save research, attach
            evidence, and connect ideas. It writes to the same local database as
            this app—even when the browser is closed.
          </p>
          <div className="mcp-tools-grid">
            {[
              ["search_research", "Find notes, findings, and context"],
              ["create_record", "Save research, tasks, and manuscripts"],
              ["update_task", "Keep the Kanban board current"],
              ["link_records", "Build the persistent knowledge graph"],
              ["log_metrics", "Append real measurements"],
              ["attach_file", "Preserve figures and notebooks"],
              ["session_handoff", "Resume with context"],
              ["get_record", "Read evidence and revision history"],
              ["set_charts", "Arrange loss, accuracy and metric panels"],
              ["define_fields", "Shape custom fields for this workspace"],
              ["get_artifact_kit", "Write themed HTML reports"],
              ["log_trace", "Record LLM traces for the Traces tab"],
              ["list_runs", "Read live training runs from the Runs tab"],
            ].map(([name, description]) => (
              <div key={name}>
                <code>{name}</code>
                <span>{description}</span>
              </div>
            ))}
          </div>
          <div className="config-heading">
            <span className="eyebrow">CLAUDE CODE · PROJECT .mcp.json</span>
            <button className="text-button" onClick={() => copy(config)}>
              <Copy size={13} />
              Copy config
            </button>
          </div>
          <pre className="config-code">{config}</pre>
          <p className="field-help">
            Merge this into .mcp.json in your Python repository. Restart Claude
            Code and approve the local server when prompted. Do not replace
            existing server entries.
          </p>
          <div className="notice">
            <LockKeyhole size={17} />
            No network server. No cloud sync. No paid compute execution. Agent
            actions appear in the lab activity log.
          </div>
        </section>
      </div>
    </>
  );
}

function hasEvidence(record: ResearchRecord, workspace: Workspace) {
  return hasSupportingExperiment(
    record,
    workspace.records,
    workspace.relations,
  );
}
export function ManuscriptView({
  workspace,
  onOpen,
  onCreate,
}: {
  workspace: Workspace;
  onOpen: (r: ResearchRecord) => void;
  onCreate: () => void;
}) {
  const papers = workspace.records.filter((r) => r.kind === "paper");
  const findings = workspace.records.filter((r) => r.kind === "finding");
  const ready = findings.filter(
    (r) => r.evidence !== "unverified" && hasEvidence(r, workspace),
  );
  const review = findings.filter((r) => !ready.includes(r));
  return (
    <>
      <p className="page-description">
        Build the paper from the trail you’ve already left.
      </p>
      <div className="manuscript-banner">
        <div className="manuscript-illustration">
          <ScrollTextIcon />
        </div>
        <div>
          <span className="eyebrow">FROM LAB NOTES TO A PUBLIC OUTPUT</span>
          <h2>
            The paper starts
            <br />
            before the writing.
          </h2>
          <p>Gather claims, trace their evidence, and see the gaps.</p>
        </div>
        <button className="button primary" onClick={onCreate}>
          <Plus size={15} />
          Start a manuscript
        </button>
      </div>
      {papers.length > 0 && (
        <div className="records-grid manuscript-records">
          {papers.map((r) => (
            <RecordCard key={r.id} record={r} onOpen={onOpen} />
          ))}
        </div>
      )}
      <div className="evidence-columns">
        <section className="evidence-column">
          <div className="section-title">
            <h2>
              <ShieldCheck size={17} />
              Evidence-linked findings
            </h2>
            <span className="tag">{ready.length}</span>
          </div>
          <p className="muted">
            Observed or replicated, with an experiment attached. Still needs
            your review before publication.
          </p>
          {ready.length ? (
            ready.map((r) => (
              <button
                className="evidence-row"
                key={r.id}
                onClick={() => onOpen(r)}
              >
                <Check size={16} />
                <span>
                  {r.title}
                  <small>{r.evidence}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            ))
          ) : (
            <EmptyState
              icon={ShieldCheck}
              title="Evidence first."
              description="Findings appear here once you mark them observed or replicated and link a supporting experiment."
            />
          )}
        </section>
        <section className="evidence-column">
          <div className="section-title">
            <h2>
              <Flag size={17} />
              Review queue
            </h2>
            <span className="tag">{review.length}</span>
          </div>
          <p className="muted">
            Claims to check, experiments to connect, uncertainty to resolve.
          </p>
          {review.length ? (
            review.map((r) => (
              <button
                className="evidence-row"
                key={r.id}
                onClick={() => onOpen(r)}
              >
                <Circle size={15} />
                <span>
                  {r.title}
                  <small>
                    {r.evidence === "unverified"
                      ? "Evidence unverified"
                      : "No supporting experiment linked"}
                  </small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            ))
          ) : (
            <EmptyState
              icon={Check}
              title="No findings awaiting review."
              description="New unverified findings will appear here automatically."
            />
          )}
        </section>
      </div>
    </>
  );
}
function ScrollTextIcon() {
  return (
    <svg
      width="110"
      height="120"
      viewBox="0 0 110 120"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M23 12h52l16 17v78H23z"
        stroke="var(--muted)"
        strokeOpacity=".7"
      />
      <path
        d="M75 12v19h16M36 48h43M36 58h35M36 68h43M36 78h26"
        stroke="var(--muted)"
        strokeOpacity=".4"
      />
      <path d="M17 24H9v87h66v-5" stroke="var(--muted)" strokeOpacity=".2" />
      <circle
        cx="80"
        cy="88"
        r="16"
        fill="var(--surface2)"
        stroke="var(--muted)"
        strokeOpacity=".4"
      />
      <path d="m73 88 5 5 10-11" stroke="var(--lime)" />
    </svg>
  );
}

export function Handoff({
  workspace,
  onClose,
  onOpen,
  onCreate,
}: {
  workspace: Workspace;
  onClose: () => void;
  onOpen: (r: ResearchRecord) => void;
  onCreate: () => void;
}) {
  const tasks = workspace.records.filter(
    (r) =>
      r.kind === "task" && ["running", "blocked", "planned"].includes(r.status),
  );
  const latest = workspace.records.find((r) => r.kind === "journal");
  const blockers = tasks.filter((r) => r.status === "blocked");
  const review = workspace.records.filter(
    (r) =>
      r.kind === "finding" &&
      (r.evidence === "unverified" || !hasEvidence(r, workspace)),
  );
  return (
    <Modal title="Session handoff" onClose={onClose} wide>
      <div className="handoff">
        <span className="eyebrow">
          <Sparkles size={13} /> YOUR NEXT SESSION
        </span>
        <h2>Back in the loop.</h2>
        <p className="muted">
          The context you need to take the next useful step.
        </p>
        <div className="handoff-stats">
          <div>
            <strong>{tasks.length}</strong>
            <span>active & planned</span>
          </div>
          <div>
            <strong>{blockers.length}</strong>
            <span>blocked</span>
          </div>
          <div>
            <strong>{review.length}</strong>
            <span>findings to review</span>
          </div>
        </div>
        <h3>The work in motion</h3>
        {tasks.length ? (
          tasks.map((r) => (
            <button
              className="handoff-task"
              key={r.id}
              onClick={() => onOpen(r)}
            >
              <span className={`status-pill ${r.status}`}>{r.status}</span>
              <span>{r.title}</span>
              <ArrowUpRight size={14} />
            </button>
          ))
        ) : (
          <p className="muted">
            No active tasks. Add one on the Mission board.
          </p>
        )}
        <h3>Last lab entry</h3>
        {latest ? (
          <button className="handoff-journal" onClick={() => onOpen(latest)}>
            <BookOpen size={20} />
            <div>
              <strong>{latest.title}</strong>
              <p>{excerpt(latest.content, 260)}</p>
            </div>
            <ArrowUpRight size={16} />
          </button>
        ) : (
          <p className="muted">Your first journal entry will show up here.</p>
        )}
        <div className="handoff-footer">
          <span>Leave context for your future self.</span>
          <button className="button primary" onClick={onCreate}>
            <Plus size={15} />
            Write a journal entry
          </button>
        </div>
      </div>
    </Modal>
  );
}
