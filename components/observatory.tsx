"use client";
import { ThemePicker } from "./theme-picker";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  ArrowUpRight,
  Plus,
  Search,
  LayoutDashboard,
  Columns3,
  FlaskConical,
  Lightbulb,
  BookOpen,
  Network,
  Images,
  ScrollText,
  Settings2,
  ChevronDown,
  ChevronsUpDown,
  Menu,
  Pin,
  Check,
  Activity,
  X,
  RefreshCw,
  Waypoints,
  LineChart,
} from "lucide-react";
import type { Workspace, ResearchRecord } from "@/lib/schema";
import {
  api,
  useWorkspaceApi,
  WorkspaceContext,
  jsonOptions,
  kindMeta,
  RecordCard,
  Money,
  timeAgo,
  EmptyState,
  Modal,
  PrivacyBadge,
} from "./ui";
import { WorkspacePicker } from "./workspace-picker";
import { Select } from "./select";
import { Signal } from "./signal";
import { RecordEditor, RecordDetail } from "./records";
import {
  Board,
  ArtifactsView,
  SettingsView,
  Handoff,
  ManuscriptView,
} from "./views";
import { KnowledgeGraph } from "./knowledge-graph";
import { TracesView } from "./traces/traces-view";
import { RunsView } from "./runs/runs-view";

type View =
  | "overview"
  | "board"
  | "experiments"
  | "findings"
  | "notebook"
  | "graph"
  | "artifacts"
  | "manuscript"
  | "traces"
  | "runs"
  | "settings";
const navigation: {
  id: View;
  label: string;
  icon: typeof LayoutDashboard;
  shortcut?: string;
}[] = [
  {
    id: "overview",
    label: "Observatory",
    icon: LayoutDashboard,
    shortcut: "01",
  },
  { id: "board", label: "Mission board", icon: Columns3, shortcut: "02" },
  { id: "experiments", label: "Experiments", icon: FlaskConical },
  { id: "findings", label: "Findings", icon: Lightbulb },
  { id: "notebook", label: "Notebook", icon: BookOpen },
  { id: "graph", label: "Knowledge graph", icon: Network },
  { id: "artifacts", label: "Figures & files", icon: Images },
  { id: "runs", label: "Runs", icon: LineChart },
  { id: "traces", label: "Traces", icon: Waypoints },
  { id: "manuscript", label: "Manuscript", icon: ScrollText },
];
export function Observatory() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ id: string }[]>("/api/workspaces")
      .then((items) => {
        const requested =
          new URLSearchParams(window.location.search).get("workspaceId") ||
          localStorage.getItem("parallax.workspace") ||
          "default";
        setActiveId(
          items.some((w) => w.id === requested) ? requested : "default",
        );
      })
      .catch((e) => setError(e.message));
  }, []);
  const select = (id: string) => {
    localStorage.setItem("parallax.workspace", id);
    const url = new URL(window.location.href);
    url.searchParams.set("workspaceId", id);
    window.history.replaceState(null, "", url);
    setActiveId(id);
  };
  if (!activeId)
    return (
      <div className="loading-screen">
        {error || "Opening your research workspace…"}
      </div>
    );
  return (
    <WorkspaceContext.Provider value={activeId}>
      <WorkspaceScreen key={activeId} onWorkspaceSelect={select} />
    </WorkspaceContext.Provider>
  );
}
function WorkspaceScreen({
  onWorkspaceSelect,
}: {
  onWorkspaceSelect: (id: string) => void;
}) {
  const { api } = useWorkspaceApi();
  const [workspacePicker, setWorkspacePicker] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<View>("overview");
  const [mobile, setMobile] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [selected, setSelected] = useState<ResearchRecord | null>(null);
  const [editor, setEditor] = useState<{
    kind: ResearchRecord["kind"];
    record?: ResearchRecord;
    initialStatus?: ResearchRecord["status"];
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [newMenu, setNewMenu] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  }, []);
  const refresh = useCallback(async () => {
    try {
      setWorkspace(await api<Workspace>("/api/workspace"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setNewMenu(false);
        setMobile(false);
      }
      if (
        e.key === "n" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement).tagName,
        ) &&
        !editor &&
        !selected
      )
        setEditor({ kind: "note" });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editor, selected]);
  useEffect(() => {
    // The Traces tab keeps its own state after the view id: #traces/trace/<id>, #traces?q=…
    const sync = () => {
      const hash = window.location.hash.slice(1).split(/[/?]/)[0];
      if ([...navigation.map((n) => n.id), "settings"].includes(hash)) {
        setView(hash as View);
        if (hash === "traces" || hash === "runs") setSelected(null);
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const navigate = (id: View) => {
    setView(id);
    setFilter("all");
    setMobile(false);
    window.history.replaceState(null, "", `#${id}`);
  };
  const create = (
    kind: ResearchRecord["kind"],
    initialStatus?: ResearchRecord["status"],
  ) => {
    setNewMenu(false);
    setEditor({ kind, initialStatus });
  };
  const open = (r: ResearchRecord) => {
    setSelected(r);
    setSearchOpen(false);
    setQuery("");
  };
  const save = async () => {
    await refresh();
    setEditor(null);
    setSelected(null);
    notify("Saved to your research workspace");
  };
  const mutate = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      await refresh();
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const records = workspace?.records || [];
  const selectedLive = selected
    ? records.find((r) => r.id === selected.id) || selected
    : null;
  const searchResults = records
    .filter((r) =>
      query
        .toLowerCase()
        .split(/\s+/)
        .every((t) =>
          `${r.title} ${r.content} ${r.tags.join(" ")} ${JSON.stringify(r.provenance)}`
            .toLowerCase()
            .includes(t),
        ),
    )
    .slice(0, 30);
  const viewMeta = navigation.find((n) => n.id === view);
  const costs = records
    .filter((r) => r.kind === "experiment")
    .reduce((s, r) => s + (r.costUsd || 0), 0);
  const monthlyCosts = records
    .filter(
      (r) =>
        r.kind === "experiment" &&
        r.createdAt.slice(0, 7) === new Date().toISOString().slice(0, 7),
    )
    .reduce((s, r) => s + (r.costUsd || 0), 0);
  const spend =
    workspace?.settings.phase === "fellowship" ? monthlyCosts : costs;
  const budget =
    workspace?.settings.phase === "fellowship"
      ? workspace.settings.fellowshipBudget
      : workspace?.settings.pilotBudget || 500;

  return (
    <div className={`app-shell ${mobile ? "nav-open" : ""}`}>
      {mobile && (
        <button
          className="sidebar-scrim"
          onClick={() => setMobile(false)}
          aria-label="Close navigation"
        />
      )}
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate("overview")}
          aria-label="Parallax home"
        >
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>
            parallax<span className="brand-dot">®</span>
          </span>
        </button>
        <button
          className="workspace-switch"
          onClick={() => setWorkspacePicker(true)}
          aria-label="Switch workspace"
        >
          <span className="workspace-symbol">
            P<span>01</span>
          </span>
          <span>
            {workspace?.info.name || "Research workspace"}
            <small>
              {workspace?.info.description || "Private research workspace"}
            </small>
          </span>
          <ChevronsUpDown size={14} />
        </button>
        <button className="sidebar-search" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon, shortcut }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => navigate(id)}
            >
              <Icon size={17} strokeWidth={1.65} />
              <span>{label}</span>
              {shortcut ? (
                <span className="nav-shortcut">{shortcut}</span>
              ) : id === "board" &&
                records.filter(
                  (r) => r.kind === "task" && r.status === "running",
                ).length > 0 ? (
                <span className="nav-count">
                  {
                    records.filter(
                      (r) => r.kind === "task" && r.status === "running",
                    ).length
                  }
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-note">
          <span className="eyebrow">
            <span className="status-dot" /> LOCAL-FIRST RESEARCH
          </span>
          <p>
            Big questions.
            <br />
            Traceable answers.
          </p>
          <button onClick={() => navigate("settings")}>
            Connect your agent <ArrowUpRight size={14} />
          </button>
        </div>
        <button
          className={`nav-item settings-nav ${view === "settings" ? "active" : ""}`}
          onClick={() => navigate("settings")}
        >
          <Settings2 size={17} />
          <span>Workspace settings</span>
        </button>
        <ThemePicker compact />
        <div className="user-row">
          <span className="avatar">J</span>
          <span>
            Julien<small>Independent researcher</small>
          </span>
          <span className="user-status" title="Local workspace" />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb-root">Workspace</span>
            <span className="slash">/</span>
            <span>{viewMeta?.label || "Settings"}</span>
          </div>
          <div className="topbar-right">
            <span className="local-indicator">
              <span className="status-dot" />
              {error ? "Connection interrupted" : "Local workspace"}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              aria-label="Search research"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={17} />
            </button>
            <span className="avatar small">J</span>
          </div>
        </header>
        <main className={`main-content view-${view}`}>
          {error && (
            <div className="error-banner">
              {error}
              <button onClick={refresh}>
                Retry <RefreshCw size={13} />
              </button>
            </div>
          )}
          {!workspace ? (
            <div className="loading">
              <span className="brand-mark">
                <i />
                <i />
                <i />
              </span>
              <p>Bringing your research into focus…</p>
            </div>
          ) : (
            <>
              {/* The Traces tab wears Tracely's own page header. */}
              {view !== "traces" && (
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">
                      {view === "overview"
                        ? "YOUR RESEARCH, CONNECTED"
                        : "PARALLAX / RESEARCH WORKSPACE"}
                    </div>
                    <h1>
                      {view === "overview"
                        ? "Observatory"
                        : viewMeta?.label || "Workspace settings"}
                      <span className="heading-period">.</span>
                    </h1>
                  </div>
                  <div className="heading-actions">
                    {view === "overview" && (
                      <span className="today">
                        {new Date().toLocaleDateString("en-US", {
                          weekday: "short",
                          month: "short",
                          day: "2-digit",
                        })}
                      </span>
                    )}
                    <div className="new-button-wrap">
                      <button
                        className="button primary"
                        onClick={() => setNewMenu(!newMenu)}
                      >
                        <Plus size={16} />
                        New entry
                        <ChevronDown size={13} />
                      </button>
                      {newMenu && (
                        <>
                          <button
                            className="menu-scrim"
                            aria-label="Close new-entry menu"
                            onClick={() => setNewMenu(false)}
                          />
                          <div className="dropdown new-menu">
                            {Object.entries(kindMeta).map(([kind, meta]) => (
                              <button
                                key={kind}
                                onClick={() =>
                                  create(kind as ResearchRecord["kind"])
                                }
                              >
                                <meta.icon size={16} />
                                {meta.label}
                                <span>↗</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {view === "overview" && (
                <>
                  <section className="hero">
                    <div className="hero-grid" />
                    <div className="hero-copy">
                      <div className="hero-label">
                        <span className="mini-cross">✳</span> A HOME FOR YOUR
                        NEXT DISCOVERY
                      </div>
                      <h2>
                        Research,
                        <br />
                        <span>in perspective.</span>
                      </h2>
                      <p>
                        The experiments. The unexpected findings. The ideas
                        <br className="desktop-break" /> between them. A little
                        more connected.
                      </p>
                      <button
                        className="button hero-button"
                        onClick={() => setHandoff(true)}
                      >
                        Pick up where you left off <ArrowUpRight size={17} />
                      </button>
                      <span className="hero-footnote">
                        {workspace.settings.project} <span> / </span>{" "}
                        {workspace.settings.phase === "pilot"
                          ? "PRE-FELLOWSHIP"
                          : "FELLOWSHIP"}
                      </span>
                    </div>
                    <Signal />
                  </section>
                  <div className="stats-grid">
                    {[
                      {
                        label: "Research entries",
                        count: records.filter((r) => r.kind !== "task").length,
                        icon: BookOpen,
                        color: "purple",
                        target: "notebook" as View,
                        foot: "Every thought, accounted for",
                      },
                      {
                        label: "Experiments",
                        count: records.filter((r) => r.kind === "experiment")
                          .length,
                        icon: FlaskConical,
                        color: "lime",
                        target: "experiments" as View,
                        foot: `${records.filter((r) => r.kind === "experiment" && r.status === "running").length} currently running`,
                      },
                      {
                        label: "Findings",
                        count: records.filter((r) => r.kind === "finding")
                          .length,
                        icon: Lightbulb,
                        color: "orange",
                        target: "findings" as View,
                        foot: "From observation to evidence",
                      },
                      {
                        label: "Open tasks",
                        count: records.filter(
                          (r) => r.kind === "task" && r.status !== "completed",
                        ).length,
                        icon: Columns3,
                        color: "blue",
                        target: "board" as View,
                        foot: "One next step at a time",
                      },
                    ].map((s) => (
                      <button
                        className="stat-card"
                        key={s.label}
                        onClick={() => navigate(s.target)}
                      >
                        <div>
                          <span>{s.label}</span>
                          <s.icon className={s.color} size={17} />
                        </div>
                        <strong>
                          {String(s.count).padStart(2, "0")}
                          <ArrowUpRight size={17} />
                        </strong>
                        <small>{s.foot}</small>
                      </button>
                    ))}
                  </div>
                  <div className="overview-columns">
                    <section className="pinned-section">
                      <SectionTitle
                        icon={Pin}
                        title="Within reach"
                        label="PINNED"
                        action="All entries"
                        onAction={() => navigate("notebook")}
                      />
                      <div className="pinned-grid">
                        {records
                          .filter((r) => r.pinned)
                          .slice(0, 4)
                          .map((r) => (
                            <RecordCard key={r.id} record={r} onOpen={open} />
                          ))}
                      </div>
                    </section>
                    <section className="next-section">
                      <SectionTitle
                        icon={Columns3}
                        title="Your next moves"
                        action="Open board"
                        onAction={() => navigate("board")}
                      />
                      <div className="next-list">
                        {records
                          .filter(
                            (r) =>
                              r.kind === "task" && r.status !== "completed",
                          )
                          .sort(
                            (a, b) =>
                              Number(["urgent", "high"].includes(b.priority)) -
                              Number(["urgent", "high"].includes(a.priority)),
                          )
                          .slice(0, 3)
                          .map((r, i) => (
                            <button key={r.id} onClick={() => open(r)}>
                              <span className="next-number">0{i + 1}</span>
                              <span>
                                <strong>{r.title}</strong>
                                <small>
                                  <span
                                    className={`priority-dot ${r.priority}`}
                                  />
                                  {r.priority} priority <span>·</span>{" "}
                                  {r.status === "draft" ? "Backlog" : r.status}
                                </small>
                              </span>
                              <ArrowUpRight size={15} />
                            </button>
                          ))}
                        {!records.some(
                          (r) => r.kind === "task" && r.status !== "completed",
                        ) && (
                          <EmptyState
                            title="A clear horizon"
                            description="Add your next research step to the board."
                            action="Create task"
                            onAction={() => create("task")}
                          />
                        )}
                      </div>
                    </section>
                  </div>
                  <div className="overview-columns lower-columns">
                    <section>
                      <SectionTitle
                        icon={Activity}
                        title="Lab activity"
                        label="LIVE LOG"
                      />
                      <div className="activity-list">
                        {workspace.activity.slice(0, 5).map((a) => (
                          <button
                            key={a.id}
                            onClick={() => {
                              const r = records.find(
                                (r) => r.id === a.recordId,
                              );
                              if (r) open(r);
                            }}
                          >
                            <span className="activity-node" />
                            <span>
                              <strong>{a.title}</strong>
                              <small>
                                {a.actor} <span>{a.action}</span>
                              </small>
                            </span>
                            <time>{timeAgo(a.createdAt)}</time>
                          </button>
                        ))}
                      </div>
                    </section>
                    <section className="budget-card">
                      <div className="budget-head">
                        <span className="eyebrow">COMPUTE RESERVE</span>
                        <span className="tag">
                          {workspace.settings.phase === "pilot"
                            ? "PILOT"
                            : "THIS MONTH"}
                        </span>
                      </div>
                      <div className="budget-value">
                        <Money value={Math.max(0, budget - spend)} />
                        <span>
                          of <Money value={budget} />
                        </span>
                      </div>
                      <p>Remaining against recorded spend</p>
                      <div className="budget-track">
                        <span
                          style={{
                            width: `${Math.min(100, (spend / budget) * 100)}%`,
                          }}
                        />
                      </div>
                      <div className="budget-footer">
                        <span>
                          <span className="status-dot" />
                          <Money value={spend} /> recorded
                        </span>
                        <button onClick={() => navigate("settings")}>
                          Manage <ArrowUpRight size={13} />
                        </button>
                      </div>
                      <small>
                        Estimates don’t count as spend. Paid jobs need your
                        approval.
                      </small>
                    </section>
                  </div>
                  <div className="bottom-note">
                    <span className="mini-cross">✳</span> Good research leaves a
                    trail. You’re building yours.
                    <PrivacyBadge />
                  </div>
                </>
              )}
              {["experiments", "findings", "notebook"].includes(view) && (
                <>
                  <p className="page-description">
                    {view === "experiments"
                      ? "Small bets. Clear gates. Reproducible answers."
                      : view === "findings"
                        ? "What you observed, what it means, and the evidence behind it."
                        : "A second memory for your research. Notes, journals, and the things worth keeping."}
                  </p>
                  <div className="collection-toolbar">
                    <div className="tabs">
                      {(view === "notebook"
                        ? ["all", "note", "journal", "reference"]
                        : view === "findings"
                          ? ["all", "unverified", "observed", "replicated"]
                          : ["all", "planned", "running", "completed"]
                      ).map((f) => (
                        <button
                          className={filter === f ? "active" : ""}
                          key={f}
                          onClick={() => setFilter(f)}
                        >
                          {f === "all"
                            ? "All entries"
                            : f.charAt(0).toUpperCase() + f.slice(1)}
                        </button>
                      ))}
                    </div>
                    <Select
                      label="Sort records"
                      value={sort}
                      onValueChange={setSort}
                      options={[
                        { value: "recent", label: "Recently updated" },
                        { value: "title", label: "Title A–Z" },
                        { value: "oldest", label: "Oldest first" },
                      ]}
                    />
                  </div>
                  {(() => {
                    const filtered = records
                      .filter((r) =>
                        view === "experiments"
                          ? r.kind === "experiment" &&
                            (filter === "all" || r.status === filter)
                          : view === "findings"
                            ? r.kind === "finding" &&
                              (filter === "all" || r.evidence === filter)
                            : ["note", "journal", "reference"].includes(
                                r.kind,
                              ) &&
                              (filter === "all" || r.kind === filter),
                      )
                      .sort((a, b) =>
                        sort === "title"
                          ? a.title.localeCompare(b.title)
                          : sort === "oldest"
                            ? a.createdAt.localeCompare(b.createdAt)
                            : b.updatedAt.localeCompare(a.updatedAt),
                      );
                    return filtered.length ? (
                      view === "experiments" ? (
                        <div className="experiment-list">
                          {filtered.map((r) => (
                            <button
                              onClick={() => open(r)}
                              key={r.id}
                              className="experiment-row"
                            >
                              <span className="experiment-icon">
                                <FlaskConical size={19} />
                              </span>
                              <span>
                                <strong>{r.title}</strong>
                                <small>
                                  {r.provenance.model || "Model not recorded"}{" "}
                                  <span>·</span>{" "}
                                  {r.provenance.seed !== null
                                    ? `seed ${r.provenance.seed}`
                                    : "Seed not recorded"}
                                </small>
                              </span>
                              <span className={`status-pill ${r.status}`}>
                                {r.status}
                              </span>
                              <span className="experiment-cost">
                                {r.costUsd === null ? (
                                  "No cost logged"
                                ) : (
                                  <Money value={r.costUsd} />
                                )}
                              </span>
                              <ArrowUpRight size={18} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="records-grid">
                          {filtered.map((r) => (
                            <RecordCard key={r.id} record={r} onOpen={open} />
                          ))}
                        </div>
                      )
                    ) : (
                      <EmptyState
                        icon={
                          view === "experiments"
                            ? FlaskConical
                            : view === "findings"
                              ? Lightbulb
                              : BookOpen
                        }
                        title={
                          filter === "all"
                            ? view === "experiments"
                              ? "Your first signal is waiting."
                              : view === "findings"
                                ? "Make room for the unexpected."
                                : "A fresh page."
                            : "Nothing here yet."
                        }
                        description={
                          view === "experiments"
                            ? "Start with a question, a small pilot, and a clear decision gate. Measured metrics will become charts here."
                            : view === "findings"
                              ? "Save an observation and connect it to the experiment that supports it. Negative results belong here, too."
                              : "Capture a thought or import your existing research documentation."
                        }
                        action={
                          view === "experiments"
                            ? "Plan an experiment"
                            : view === "findings"
                              ? "Add a finding"
                              : "Write a note"
                        }
                        onAction={() =>
                          create(
                            view === "experiments"
                              ? "experiment"
                              : view === "findings"
                                ? "finding"
                                : "note",
                          )
                        }
                      />
                    );
                  })()}
                </>
              )}
              {view === "board" && (
                <Board
                  workspace={workspace}
                  onOpen={open}
                  onCreate={(status) => create("task", status)}
                  onMove={(r, status) =>
                    mutate(
                      () =>
                        api(
                          `/api/records/${r.id}`,
                          jsonOptions("PATCH", { ...r, status }),
                        ),
                      "Task moved",
                    )
                  }
                />
              )}
              {view === "graph" && (
                <KnowledgeGraph
                  workspace={workspace}
                  onOpen={open}
                  onChange={refresh}
                  notify={notify}
                />
              )}
              {view === "artifacts" && (
                <ArtifactsView
                  onOpen={open}
                  workspace={workspace}
                  onChange={refresh}
                  notify={notify}
                />
              )}
              {view === "manuscript" && (
                <ManuscriptView
                  workspace={workspace}
                  onOpen={open}
                  onCreate={() => create("paper")}
                />
              )}
              {view === "runs" && (
                <RunsView records={workspace.records} onOpenRecord={open} />
              )}
              {view === "traces" && (
                <TracesView records={workspace.records} onOpenRecord={open} />
              )}
              {view === "settings" && (
                <SettingsView
                  workspace={workspace}
                  onChange={refresh}
                  notify={notify}
                />
              )}
            </>
          )}
        </main>
      </div>
      {workspacePicker && workspace && (
        <WorkspacePicker
          activeId={workspace.info.id}
          onClose={() => setWorkspacePicker(false)}
          onSelect={(id) => {
            setWorkspacePicker(false);
            onWorkspaceSelect(id);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {workspace && selectedLive && !editor && (
        <RecordDetail
          record={selectedLive}
          workspace={workspace}
          onClose={() => setSelected(null)}
          onEdit={() =>
            setEditor({ kind: selectedLive.kind, record: selectedLive })
          }
          onOpen={open}
          onChange={refresh}
          notify={notify}
        />
      )}
      {workspace && editor && (
        <RecordEditor
          kind={editor.kind}
          record={editor.record}
          initialStatus={editor.initialStatus}
          workspace={workspace}
          onClose={() => setEditor(null)}
          onSave={save}
        />
      )}
      {workspace && handoff && (
        <Handoff
          workspace={workspace}
          onClose={() => setHandoff(false)}
          onOpen={(r) => {
            setHandoff(false);
            open(r);
          }}
          onCreate={() => {
            setHandoff(false);
            create("journal");
          }}
        />
      )}
      {searchOpen && (
        <Modal
          title="Search your research"
          onClose={() => setSearchOpen(false)}
        >
          <div className="search-heading">
            <Search size={22} />
            <input
              autoFocus
              placeholder="Search your research, tags, or a commit…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="search-hint">
            {query
              ? `${searchResults.length} matching entries`
              : "RECENT ENTRIES"}
            <kbd>esc to close</kbd>
          </div>
          <div className="search-results">
            {searchResults.length ? (
              searchResults.map((r) => {
                const Icon = kindMeta[r.kind].icon;
                return (
                  <button onClick={() => open(r)} key={r.id}>
                    <span
                      className={`search-result-icon ${kindMeta[r.kind].color}`}
                    >
                      <Icon size={18} />
                    </span>
                    <span>
                      <strong>{r.title}</strong>
                      <small>
                        {kindMeta[r.kind].label} · {r.tags.join(", ")}
                      </small>
                    </span>
                    <ArrowUpRight size={16} />
                  </button>
                );
              })
            ) : (
              <EmptyState
                title="No matching entries"
                description="Try another phrase, tag, or source path."
              />
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function SectionTitle({
  icon: Icon,
  title,
  label,
  action,
  onAction,
}: {
  icon: typeof Pin;
  title: string;
  label?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-title">
      <div>
        <Icon size={16} />
        <h2>{title}</h2>
        {label && <span className="section-label">{label}</span>}
      </div>
      {action && (
        <button onClick={onAction}>
          {action}
          <ArrowUpRight size={13} />
        </button>
      )}
    </div>
  );
}
