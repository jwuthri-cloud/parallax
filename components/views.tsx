"use client";
import { useState, useMemo, useRef } from "react";
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
  Focus,
  GitBranch,
  Image as ImageIcon,
  Link2,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  ResearchRecord,
  Workspace,
  Artifact,
  Relation,
} from "@/lib/schema";
import {
  useWorkspaceApi,
  jsonOptions,
  kindMeta,
  KindBadge,
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

const graphColors: Record<ResearchRecord["kind"], string> = {
  note: "var(--blue)",
  journal: "var(--orange)",
  finding: "var(--pink)",
  experiment: "var(--lime)",
  reference: "var(--purple)",
  task: "var(--lime)",
  paper: "var(--blue)",
};
export function KnowledgeGraph({
  workspace,
  onOpen,
  onChange,
  notify,
}: {
  workspace: Workspace;
  onOpen: (r: ResearchRecord) => void;
  onChange: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const { api } = useWorkspaceApi();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );
  const [linkOpen, setLinkOpen] = useState(false);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [type, setType] = useState<Relation["type"]>("relates");
  const [busy, setBusy] = useState(false);
  const records = workspace.records.filter(
    (r) =>
      (filter === "all" || r.kind === filter) &&
      `${r.title} ${r.tags.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const edges = [
    ...workspace.relations,
    ...workspace.chartLinks.map((l) => ({
      id: l.id,
      source: l.recordId,
      target: l.experimentId,
      type: "uses" as const,
      label: `chart: ${l.metricName}`,
    })),
    ...workspace.artifacts.flatMap((a) =>
      a.recordIds.slice(1).map((target) => ({
        id: `${a.id}-${target}`,
        source: a.recordIds[0],
        target,
        type: "relates" as const,
        label: `shared file: ${a.name}`,
      })),
    ),
    ...workspace.records.flatMap((r) =>
      r.linkedIds.map((target) => ({
        id: `${r.id}-${target}`,
        source: r.id,
        target,
        type: "relates" as const,
        label: "reference",
      })),
    ),
  ];
  const connected = new Set(
    edges
      .filter((e) => e.source === selected || e.target === selected)
      .flatMap((e) => [e.source, e.target]),
  );
  const positions = useMemo(() => {
    const positions: Record<string, { x: number; y: number }> = {};
    records.forEach((r, i) => {
      const angle = i * 2.399963 - Math.PI / 2;
      const radius = 65 + Math.sqrt(i) * 70;
      positions[r.id] = {
        x: 450 + Math.cos(angle) * radius,
        y: 300 + Math.sin(angle) * radius * 0.73,
      };
    });
    return positions;
  }, [records.map((r) => r.id).join(",")]); // Positions only change when the visible node set changes.
  const active = workspace.records.find((r) => r.id === selected);
  const addLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(
        "/api/relations",
        jsonOptions("POST", { source, target, type }),
      );
      await onChange();
      setLinkOpen(false);
      notify("Connection added to your knowledge graph");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="page-description">
        Follow the connections. See what your research is trying to tell you.
      </p>
      <div className="graph-toolbar">
        <div className="graph-search">
          <Search size={14} />
          <input
            aria-label="Search graph"
            placeholder="Find a thread…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select
          label="Filter graph nodes"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: "All record types" },
            ...Object.entries(kindMeta).map(([value, meta]) => ({
              value,
              label: meta.label,
            })),
          ]}
        />
        <span className="graph-count">
          {records.length} nodes ·{" "}
          {
            edges.filter((e) => positions[e.source] && positions[e.target])
              .length
          }{" "}
          connections
        </span>
        <button
          className="button secondary"
          onClick={() => {
            setSource(selected || "");
            setLinkOpen(true);
          }}
        >
          <Link2 size={14} />
          Connect entries
        </button>
      </div>
      <div className="graph-layout">
        <div className="graph-canvas">
          <div className="graph-corner-label">
            <span className="status-dot" />
            PERSISTENT MEMORY / {filter.toUpperCase()}
          </div>
          <svg
            viewBox="0 0 900 610"
            role="group"
            aria-label="Interactive knowledge graph. Select a record to explore its connections."
            onPointerDown={(e) => {
              if ((e.target as Element).closest("[data-node]")) return;
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                px: pan.x,
                py: pan.y,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (drag.current) {
                const ratio =
                  900 / e.currentTarget.getBoundingClientRect().width;
                setPan({
                  x: drag.current.px + (e.clientX - drag.current.x) * ratio,
                  y: drag.current.py + (e.clientY - drag.current.y) * ratio,
                });
              }
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <defs>
              <pattern
                id="dots"
                width="22"
                height="22"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="1" cy="1" r=".8" fill="var(--border)" />
              </pattern>
              <radialGradient id="graph-glow">
                <stop stopColor="var(--lime)" stopOpacity=".045" />
                <stop offset="1" stopColor="var(--lime)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width="900" height="610" fill="url(#dots)" />
            <circle cx="450" cy="300" r="270" fill="url(#graph-glow)" />
            <g
              transform={`translate(${pan.x + 450 * (1 - scale)} ${pan.y + 300 * (1 - scale)}) scale(${scale})`}
            >
              {edges.map((edge) => {
                const a = positions[edge.source],
                  b = positions[edge.target];
                if (!a || !b) return null;
                const emphasized =
                  selected === edge.source || selected === edge.target;
                return (
                  <g key={edge.id}>
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={
                        edge.type === "contradicts"
                          ? "var(--orange)"
                          : emphasized
                            ? "var(--lime)"
                            : "var(--dim)"
                      }
                      opacity={selected && !emphasized ? 0.15 : 0.65}
                      strokeDasharray={
                        edge.type === "relates" ? "3 5" : undefined
                      }
                    />
                    {emphasized && (
                      <text
                        x={(a.x + b.x) / 2}
                        y={(a.y + b.y) / 2 - 6}
                        textAnchor="middle"
                        fill="var(--muted)"
                        fontSize="9"
                      >
                        {edge.type}
                      </text>
                    )}
                  </g>
                );
              })}
              {records.map((record) => {
                const p = positions[record.id];
                const color = graphColors[record.kind];
                const picked = selected === record.id;
                const faded = selected && !connected.has(record.id) && !picked;
                return (
                  <g
                    key={record.id}
                    data-node={record.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${record.title}, ${kindMeta[record.kind].label}`}
                    className="graph-node"
                    transform={`translate(${p.x},${p.y})`}
                    opacity={faded ? 0.28 : 1}
                    onClick={() => setSelected(record.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(record.id);
                      }
                    }}
                  >
                    <circle
                      r={picked ? 32 : 25}
                      fill={color}
                      fillOpacity={picked ? 0.12 : 0.035}
                      stroke={color}
                      strokeOpacity={picked ? 0.9 : 0.2}
                    />
                    {picked && (
                      <circle
                        r="39"
                        stroke={color}
                        strokeOpacity=".2"
                        strokeDasharray="2 4"
                      />
                    )}
                    <circle r="7" fill={color} />
                    <text
                      y="49"
                      textAnchor="middle"
                      fill={picked ? "var(--text)" : "var(--muted)"}
                      fontSize="11"
                      fontWeight="500"
                    >
                      {record.title.length > 28
                        ? record.title.slice(0, 27) + "…"
                        : record.title}
                    </text>
                    <text
                      y="63"
                      textAnchor="middle"
                      fill={color}
                      opacity=".65"
                      fontSize="8"
                      letterSpacing="1.3"
                    >
                      {kindMeta[record.kind].label.toUpperCase()}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          <div className="graph-controls">
            <button
              aria-label="Zoom out"
              onClick={() => setScale((s) => Math.max(0.35, s - 0.15))}
            >
              <ZoomOut size={16} />
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              aria-label="Zoom in"
              onClick={() => setScale((s) => Math.min(2, s + 0.15))}
            >
              <ZoomIn size={16} />
            </button>
            <button
              aria-label="Reset graph view"
              onClick={() => {
                setScale(1);
                setPan({ x: 0, y: 0 });
                setSelected(null);
              }}
            >
              <Focus size={16} />
            </button>
          </div>
          <span className="graph-instruction">
            DRAG TO EXPLORE · SELECT TO CONNECT
          </span>
        </div>
        <aside className="graph-inspector">
          {active ? (
            <>
              <KindBadge kind={active.kind} />
              <h2>{active.title}</h2>
              <p>{excerpt(active.content, 240)}</p>
              <button
                className="button secondary"
                onClick={() => onOpen(active)}
              >
                Open entry
                <ArrowUpRight size={15} />
              </button>
              <div className="inspector-divider" />
              <span className="eyebrow">CONNECTED THREADS</span>
              <div className="graph-connections">
                {edges
                  .filter(
                    (e) => e.source === active.id || e.target === active.id,
                  )
                  .map((edge) => {
                    const neighbor = workspace.records.find(
                      (r) =>
                        r.id ===
                        (edge.source === active.id ? edge.target : edge.source),
                    );
                    return neighbor ? (
                      <button
                        key={edge.id}
                        onClick={() => setSelected(neighbor.id)}
                      >
                        <small>
                          {edge.source === active.id ? "→" : "←"} {edge.type}
                        </small>
                        <span>{neighbor.title}</span>
                      </button>
                    ) : null;
                  })}
                {!connected.size && (
                  <p>
                    No connections yet. Add a relationship to start building
                    context.
                  </p>
                )}
              </div>
              <button
                className="text-button"
                onClick={() => {
                  setSource(active.id);
                  setLinkOpen(true);
                }}
              >
                <Plus size={14} />
                Add connection
              </button>
            </>
          ) : (
            <>
              <div className="inspector-art">
                <Network size={45} strokeWidth={1} />
              </div>
              <span className="eyebrow">THINK IN CONNECTIONS</span>
              <h2>
                No idea lives
                <br />
                in isolation.
              </h2>
              <p>
                Select a node to follow its evidence, related thoughts, and open
                questions.
              </p>
              <div className="graph-legend">
                {Object.entries(kindMeta).map(([id, meta]) => (
                  <button
                    key={id}
                    onClick={() => setFilter(filter === id ? "all" : id)}
                  >
                    <span
                      style={{
                        background: graphColors[id as ResearchRecord["kind"]],
                      }}
                    />
                    {meta.label}
                  </button>
                ))}
              </div>
              <div className="graph-storage-note">
                <GitBranch size={15} />
                <span>
                  A persistent graph in your local SQLite database. Every edge
                  is explicit.
                </span>
              </div>
            </>
          )}
        </aside>
      </div>
      {linkOpen && (
        <Modal
          title="Connect research entries"
          onClose={() => setLinkOpen(false)}
        >
          <form className="connection-form" onSubmit={addLink}>
            <span className="eyebrow">MAKE A CONNECTION</span>
            <h2>One idea leads to another.</h2>
            <label>
              Source entry
              <Select
                label="Source entry"
                value={source}
                onValueChange={(value) => {
                  setSource(value);
                  if (target === value) setTarget("");
                }}
                options={[
                  { value: "", label: "Choose an entry" },
                  ...workspace.records.map((r) => ({
                    value: r.id,
                    label: r.title,
                  })),
                ]}
              />
            </label>
            <label>
              Relationship
              <Select
                label="Relationship"
                value={type}
                onValueChange={(value) => setType(value as Relation["type"])}
                options={[
                  "relates",
                  "supports",
                  "contradicts",
                  "extends",
                  "uses",
                ].map((value) => ({
                  value,
                  label: value === "relates" ? "relates to" : value,
                }))}
              />
            </label>
            <label>
              Target entry
              <Select
                label="Target entry"
                value={target}
                onValueChange={setTarget}
                options={[
                  { value: "", label: "Choose an entry" },
                  ...workspace.records
                    .filter((r) => r.id !== source)
                    .map((r) => ({ value: r.id, label: r.title })),
                ]}
              />
            </label>
            <p className="field-help">
              “Supports” and “contradicts” describe evidence, not just
              similarity. Direction goes from source to target.
            </p>
            <button
              className="button primary"
              disabled={busy || !source || !target || source === target}
            >
              <Link2 size={15} />
              {busy ? "Connecting…" : "Save connection"}
            </button>
          </form>
        </Modal>
      )}
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
