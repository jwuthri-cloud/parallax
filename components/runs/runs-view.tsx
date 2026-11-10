"use client";
// The Runs tab: live training telemetry (W&B-style). The view lives in the URL hash:
// #runs?status=…, #runs/run/<id>, #runs/compare/<id>,<id>. Running runs refresh every few
// seconds; series are refetched only when a run reports something new.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Play,
  Square,
  AlertTriangle,
  ArrowLeft,
  Copy,
  GitCompare,
  LineChart,
  Trash2,
} from "lucide-react";
import type {
  ResearchRecord,
  RunDetail,
  RunEvent,
  RunSeries,
  RunSummary,
} from "@/lib/schema";
import {
  buildDashboard,
  differingKeys,
  flatten,
  formatDuration,
  sections,
} from "@/lib/run-dashboard";
import { formatValue } from "@/lib/charts";
import { EmptyState, jsonOptions, timeAgo, useWorkspaceApi } from "../ui";
import {
  startSimulation,
  stopAllSimulations,
  stopSimulation,
  useSimulations,
} from "./simulator";
import { Select } from "../select";
import { RunCharts, type ChartOptions } from "./run-charts";

const statuses = [
  "all",
  "running",
  "stalled",
  "finished",
  "failed",
  "killed",
] as const;
type Route =
  | { kind: "list"; status: string; group: string; q: string }
  | { kind: "run"; id: string }
  | { kind: "compare"; ids: string[] };

function parseHash(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const [, kind, id] = path.split("/");
  if (kind === "run" && id) return { kind: "run", id: decodeURIComponent(id) };
  if (kind === "compare" && id)
    return { kind: "compare", ids: decodeURIComponent(id).split(",") };
  const p = new URLSearchParams(query);
  return {
    kind: "list",
    status: p.get("status") ?? "all",
    group: p.get("group") ?? "",
    q: p.get("q") ?? "",
  };
}
const go = (hash: string) => {
  window.location.hash = hash;
};

/** Re-run fn every ms while active and the page is visible. */
function usePoll(fn: () => void, ms: number, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") fn();
    }, ms);
    return () => clearInterval(timer);
  }, [fn, ms, active]);
}

export function RunsView({
  records,
  onOpenRecord,
}: {
  records: ResearchRecord[];
  onOpenRecord: (record: ResearchRecord) => void;
}) {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof window === "undefined" ? "" : window.location.hash),
  );
  useEffect(() => {
    const sync = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const experiments = useMemo(
    () =>
      new Map(
        records.filter((r) => r.kind === "experiment").map((r) => [r.id, r]),
      ),
    [records],
  );
  return (
    <div className="run-view">
      {route.kind === "list" && (
        <RunList route={route} experiments={experiments} />
      )}
      {route.kind === "run" && (
        <RunPage
          key={route.id}
          ids={[route.id]}
          experiments={experiments}
          onOpenRecord={onOpenRecord}
        />
      )}
      {route.kind === "compare" && (
        <RunPage
          key={route.ids.join(",")}
          ids={route.ids}
          experiments={experiments}
          onOpenRecord={onOpenRecord}
        />
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: RunSummary["status"] }) {
  return (
    <span className={`run-status ${status}`}>
      <i />
      {status}
    </span>
  );
}

const fmt = (v: unknown) =>
  typeof v === "number"
    ? formatValue(v)
    : v === null
      ? "NaN/Inf"
      : v === undefined
        ? "—"
        : typeof v === "string"
          ? v
          : JSON.stringify(v);
/** Config, summary and meta values: null there is just a missing value (in metrics it marks NaN/Inf). */
const fmtField = (v: unknown) => (v === null ? "—" : fmt(v));

/** Up to 3 metrics to show as columns: loss first, then the most common. */
function keyMetrics(runs: RunSummary[]) {
  const counts = new Map<string, number>();
  for (const run of runs)
    for (const [name, value] of Object.entries(run.summary))
      if (typeof value === "number" || value === null)
        counts.set(name, (counts.get(name) ?? 0) + 1);
  const panels = buildDashboard([...counts.keys()]);
  const order = new Map(
    panels.flatMap((p) =>
      p.metrics.map((m) => [m.name, sections.indexOf(p.section)]),
    ),
  );
  return [...counts.keys()]
    .sort(
      (a, b) =>
        (order.get(a) ?? 9) - (order.get(b) ?? 9) ||
        (counts.get(b) ?? 0) - (counts.get(a) ?? 0) ||
        a.localeCompare(b),
    )
    .slice(0, 3);
}

/** Start a synthetic live run in this browser and open its page. */
function useSimulate() {
  const { api } = useWorkspaceApi();
  const post = useCallback(
    (events: RunEvent[]) => api("/api/runs", jsonOptions("POST", { events })),
    [api],
  );
  const start = useCallback(async () => {
    const id = await startSimulation(post);
    go(`#runs/run/${encodeURIComponent(id)}`);
  }, [post]);
  return { start, post };
}

function SimulateButton({ onError }: { onError: (message: string) => void }) {
  const { start } = useSimulate();
  return (
    <button
      className="button secondary"
      title="Stream a synthetic training run (tagged demo) to see live charts"
      onClick={() => start().catch((e: Error) => onError(e.message))}
    >
      <Play size={15} />
      Simulate live run
    </button>
  );
}

function QuickStart({
  onDemo,
  onError,
}: {
  onDemo: () => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="run-quickstart">
      <EmptyState
        icon={LineChart}
        title="No runs yet"
        description="Stream loss, metrics and GPU use from any training script. Runs appear here live. To see the dashboard first, load synthetic demo runs (tagged demo, removable in one click)."
        action="Load demo runs"
        onAction={onDemo}
      />
      <div className="run-quickstart-actions">
        <SimulateButton onError={onError} />
      </div>
      <pre>{`# clients/python/parallax_track.py (standard library only)
import parallax_track as px

run = px.init(name="sft-lr3e-5", group="lr-sweep", config={"lr": 3e-5})
for step in range(1000):
    run.log({"train/loss": loss, "train/lr": lr}, step=step)
run.log({"val/loss": val_loss, "val/accuracy": acc}, step=step)
run.finish()

# On a cluster: PARALLAX_MODE=offline, then on the laptop
python parallax_track.py sync parallax-runs/`}</pre>
    </div>
  );
}

function RunList({
  route,
  experiments,
}: {
  route: Extract<Route, { kind: "list" }>;
  experiments: Map<string, ResearchRecord>;
}) {
  const { api } = useWorkspaceApi();
  const [page, setPage] = useState<{
    items: RunSummary[];
    total: number;
    groups: string[];
  } | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState(route.q);
  const [picked, setPicked] = useState<string[]>([]);
  const simulations = useSimulations();
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (route.status !== "all") p.set("status", route.status);
    if (route.group) p.set("group", route.group);
    if (route.q) p.set("q", route.q);
    return p.toString();
  }, [route]);
  const load = useCallback(
    () =>
      api<NonNullable<typeof page>>(`/api/runs?${query}`).then(
        (r) => {
          setPage(r);
          setError("");
        },
        (e: Error) => setError(e.message),
      ),
    [api, query],
  );
  useEffect(() => {
    void load();
  }, [load]);
  usePoll(load, 3000, true);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text !== route.q) set({ q: text });
    }, 300);
    return () => clearTimeout(timer);
  });
  function set(change: Partial<Extract<Route, { kind: "list" }>>) {
    const next = { ...route, ...change };
    const p = new URLSearchParams();
    if (next.status !== "all") p.set("status", next.status);
    if (next.group) p.set("group", next.group);
    if (next.q) p.set("q", next.q);
    const search = p.toString();
    window.history.replaceState(null, "", `#runs${search ? `?${search}` : ""}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
  if (!page && !error) return <p className="run-muted">Loading runs…</p>;
  const empty = page && page.total === 0 && !query;
  const hasDemo = !!page?.items.some(
    (r) => r.id.startsWith("demo-") && r.tags.includes("demo"),
  );
  async function demo(method: "POST" | "DELETE") {
    try {
      if (method === "DELETE") await stopAllSimulations();
      await api("/api/run-demo", { method });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const columns = keyMetrics(page?.items ?? []);
  return (
    <>
      {(error || simulations.error) && (
        <p className="run-error">{error || simulations.error}</p>
      )}
      {hasDemo && (
        <div className="run-warning">
          <AlertTriangle size={15} />
          <span>
            Demo runs (tag <b>demo</b>) are synthetic data from
            seeds/demo-runs.jsonl, not results.
          </span>
          <button
            className="button secondary compact"
            onClick={() => demo("DELETE")}
          >
            Remove demo runs
          </button>
        </div>
      )}
      {empty ? (
        <QuickStart onDemo={() => demo("POST")} onError={setError} />
      ) : (
        <>
          <div className="run-toolbar">
            <div className="run-segment" role="group" aria-label="Status">
              {statuses.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={route.status === s ? "active" : ""}
                  onClick={() => set({ status: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            {!!page?.groups.length && (
              <Select
                label="Group"
                value={route.group}
                onValueChange={(group) => set({ group })}
                options={[
                  { value: "", label: "All groups" },
                  ...page.groups.map((g) => ({ value: g, label: g })),
                ]}
              />
            )}
            <input
              className="run-search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search name, id, group, tags…"
              aria-label="Search runs"
            />
            <SimulateButton onError={setError} />
            <button
              className="button secondary"
              disabled={picked.length < 2}
              title="Select two or more runs to compare"
              onClick={() => go(`#runs/compare/${picked.join(",")}`)}
            >
              <GitCompare size={15} />
              Compare{picked.length ? ` (${picked.length})` : ""}
            </button>
          </div>
          <div className="run-table-wrap">
            <table className="run-table">
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Status</th>
                  <th>Run</th>
                  <th>Group</th>
                  <th>Experiment</th>
                  <th>Started</th>
                  <th>Runtime</th>
                  <th>Step</th>
                  {columns.map((c) => (
                    <th key={c} className="num">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page?.items.map((run) => (
                  <tr
                    key={run.id}
                    onClick={() =>
                      go(`#runs/run/${encodeURIComponent(run.id)}`)
                    }
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${run.name}`}
                        checked={picked.includes(run.id)}
                        onChange={(e) =>
                          setPicked((p) =>
                            e.target.checked
                              ? [...p, run.id]
                              : p.filter((x) => x !== run.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <StatusPill status={run.status} />
                    </td>
                    <td>
                      <b>{run.name}</b>
                      {run.name !== run.id && (
                        <small className="mono"> {run.id}</small>
                      )}
                      {run.tags.map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </td>
                    <td>{run.group || "—"}</td>
                    <td>
                      {run.experimentId
                        ? (experiments.get(run.experimentId)?.title ??
                          run.experimentId)
                        : "—"}
                    </td>
                    <td>{timeAgo(new Date(run.startedAt).toISOString())}</td>
                    <td>{formatDuration(run.runtimeMs)}</td>
                    <td className="num">{run.lastStep ?? "—"}</td>
                    {columns.map((c) => (
                      <td key={c} className="num">
                        {fmt(run.summary[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {page && page.items.length < page.total && (
              <p className="run-muted">
                Showing the {page.items.length} most recent of {page.total}{" "}
                runs.
              </p>
            )}
            {page?.total === 0 && <p className="run-muted">No run matches.</p>}
          </div>
        </>
      )}
    </>
  );
}

function RunPage({
  ids,
  experiments,
  onOpenRecord,
}: {
  ids: string[];
  experiments: Map<string, ResearchRecord>;
  onOpenRecord: (record: ResearchRecord) => void;
}) {
  const { api } = useWorkspaceApi();
  const [runs, setRuns] = useState<RunDetail[] | null>(null);
  const [series, setSeries] = useState<RunSeries[]>([]);
  const [error, setError] = useState("");
  const [options, setOptions] = useState<ChartOptions>({
    x: "step",
    smoothing: 0,
    logY: false,
    filter: "",
  });
  const [version, setVersion] = useState("");
  const load = useCallback(
    () =>
      Promise.all(
        ids.map((id) => api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`)),
      ).then(
        (details) => {
          setRuns(details);
          setError("");
          // Points changed: fetch the series again.
          setVersion(
            details.map((d) => `${d.lastSeenAt}:${d.metrics.length}`).join(","),
          );
        },
        (e: Error) => setError(e.message),
      ),
    [api, ids],
  );
  useEffect(() => {
    void load();
  }, [load]);
  usePoll(load, 2500, !!runs?.some((r) => r.status === "running"));
  useEffect(() => {
    if (!version) return;
    api<RunSeries[]>(
      `/api/run-series?runs=${ids.map(encodeURIComponent).join(",")}&maxPoints=${ids.length > 1 ? 500 : 800}`,
    ).then(setSeries, (e: Error) => setError(e.message));
  }, [api, ids, version]);
  if (error && !runs)
    return (
      <>
        <BackLink />
        <p className="run-error">{error}</p>
      </>
    );
  if (!runs) return <p className="run-muted">Loading…</p>;
  const single = runs.length === 1 ? runs[0] : null;
  const diverged = runs.flatMap((r) =>
    r.metrics
      .filter((m) => m.nonFinite > 0)
      .map((m) => ({ run: r.name, ...m })),
  );
  return (
    <>
      <BackLink />
      {single ? (
        <RunHeader
          run={single}
          experiments={experiments}
          onOpenRecord={onOpenRecord}
        />
      ) : (
        <header className="run-head">
          <div>
            <span className="eyebrow">COMPARE</span>
            <h1>{runs.length} runs</h1>
            <div className="run-chips">
              {runs.map((r) => (
                <a key={r.id} href={`#runs/run/${encodeURIComponent(r.id)}`}>
                  {r.name} <StatusPill status={r.status} />
                </a>
              ))}
            </div>
          </div>
        </header>
      )}
      {diverged.length > 0 && (
        <div className="run-warning">
          <AlertTriangle size={15} />
          <span>
            {diverged
              .slice(0, 4)
              .map(
                (d) =>
                  `${runs.length > 1 ? `${d.run}: ` : ""}${d.name} was NaN/Inf ${d.nonFinite}× (first at step ${d.firstNonFiniteStep})`,
              )
              .join(" · ")}
            {diverged.length > 4 && ` · +${diverged.length - 4} more`}
          </span>
        </div>
      )}
      <div className="run-toolbar">
        <div className="run-segment" role="group" aria-label="X axis">
          {(["step", "time"] as const).map((x) => (
            <button
              key={x}
              type="button"
              className={options.x === x ? "active" : ""}
              onClick={() => setOptions({ ...options, x })}
            >
              {x === "step" ? "Step" : "Relative time"}
            </button>
          ))}
        </div>
        <label className="run-control">
          Smoothing
          <input
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={options.smoothing}
            onChange={(e) =>
              setOptions({ ...options, smoothing: Number(e.target.value) })
            }
          />
          <span className="mono">{options.smoothing.toFixed(2)}</span>
        </label>
        <label className="run-control">
          <input
            type="checkbox"
            checked={options.logY}
            onChange={(e) => setOptions({ ...options, logY: e.target.checked })}
          />
          Log scale
        </label>
        <input
          className="run-search"
          value={options.filter}
          onChange={(e) => setOptions({ ...options, filter: e.target.value })}
          placeholder="Filter charts…"
          aria-label="Filter charts"
        />
      </div>
      <RunCharts runs={runs} series={series} options={options} />
      {single ? <RunTables run={single} /> : <CompareTables runs={runs} />}
    </>
  );
}

function BackLink() {
  return (
    <a className="run-back" href="#runs">
      <ArrowLeft size={14} /> All runs
    </a>
  );
}

function RunHeader({
  run,
  experiments,
  onOpenRecord,
}: {
  run: RunDetail;
  experiments: Map<string, ResearchRecord>;
  onOpenRecord: (record: ResearchRecord) => void;
}) {
  const { api } = useWorkspaceApi();
  const { post } = useSimulate();
  const simulating = useSimulations().running.includes(run.id);
  const git = run.meta.git as
    { commit?: string; branch?: string; dirty?: boolean } | undefined;
  const slurm = run.meta.slurm as Record<string, string> | undefined;
  const experiment = run.experimentId
    ? experiments.get(run.experimentId)
    : undefined;
  const facts: [string, React.ReactNode][] = [
    ["Started", new Date(run.startedAt).toLocaleString()],
    ["Runtime", formatDuration(run.runtimeMs)],
    ["Last signal", timeAgo(new Date(run.lastSeenAt).toISOString())],
    ["Step", run.lastStep ?? "—"],
    ...(run.exitCode !== null
      ? [["Exit code", run.exitCode] as [string, number]]
      : []),
    ...(run.meta.host
      ? [["Host", String(run.meta.host)] as [string, string]]
      : []),
    ...(git?.commit
      ? [
          [
            "Commit",
            <span className="mono" key="c">
              {git.commit.slice(0, 10)}
              {git.dirty ? " (dirty)" : ""} {git.branch}
            </span>,
          ] as [string, React.ReactNode],
        ]
      : []),
    ...(slurm?.job_id
      ? [
          ["Slurm", `${slurm.job_name ?? ""} #${slurm.job_id}`] as [
            string,
            string,
          ],
        ]
      : []),
  ];
  return (
    <header className="run-head">
      <div>
        <span className="eyebrow">RUN{run.group ? ` · ${run.group}` : ""}</span>
        <h1>
          {run.name} <StatusPill status={run.status} />
        </h1>
        <div className="run-facts">
          {facts.map(([k, v]) => (
            <span key={k}>
              <small>{k}</small>
              {v}
            </span>
          ))}
          {experiment && (
            <button
              className="run-link"
              onClick={() => onOpenRecord(experiment)}
            >
              <small>Experiment</small>
              {experiment.title}
            </button>
          )}
        </div>
        {run.notes && <p className="run-notes">{run.notes}</p>}
      </div>
      <div className="run-actions">
        {simulating && (
          <button
            className="button secondary compact"
            onClick={() => void stopSimulation(run.id, post)}
          >
            <Square size={13} />
            Stop simulation
          </button>
        )}
        <button
          className="icon-button"
          title="Copy run id"
          aria-label="Copy run id"
          onClick={() => navigator.clipboard.writeText(run.id)}
        >
          <Copy size={15} />
        </button>
        <button
          className="icon-button"
          title="Delete run"
          aria-label="Delete run"
          onClick={async () => {
            if (
              !window.confirm(
                `Delete run "${run.name}" and all its metrics? This cannot be undone.`,
              )
            )
              return;
            await api(`/api/runs/${encodeURIComponent(run.id)}`, {
              method: "DELETE",
            });
            go("#runs");
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </header>
  );
}

function KeyValues({
  title,
  values,
}: {
  title: string;
  values: Record<string, unknown>;
}) {
  const entries = Object.entries(values);
  if (!entries.length) return null;
  return (
    <section className="run-kv">
      <h3>{title}</h3>
      <table className="run-table">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td className="mono">
                {typeof v === "number" ? String(v) : fmtField(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RunTables({ run }: { run: RunDetail }) {
  const { command, ...meta } = run.meta;
  return (
    <div className="run-tables">
      <section className="run-kv">
        <h3>Metrics</h3>
        <table className="run-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Last</th>
              <th className="num">Min</th>
              <th className="num">Max</th>
              <th className="num">Points</th>
              <th className="num">Last step</th>
            </tr>
          </thead>
          <tbody>
            {run.metrics
              .filter((m) => !m.name.startsWith("system/"))
              .map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td className="num">{fmt(m.last)}</td>
                  <td className="num">{fmt(m.min ?? undefined)}</td>
                  <td className="num">{fmt(m.max ?? undefined)}</td>
                  <td className="num">{m.count}</td>
                  <td className="num">{m.lastStep}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      <KeyValues title="Config" values={flatten(run.config)} />
      <KeyValues
        title="Summary"
        values={Object.fromEntries(
          Object.entries(run.summary).filter(
            ([k]) => !run.metrics.some((m) => m.name === k),
          ),
        )}
      />
      <KeyValues title="System" values={flatten(meta)} />
      {typeof command === "string" && (
        <section className="run-kv">
          <h3>Command</h3>
          <pre className="mono">{command}</pre>
        </section>
      )}
    </div>
  );
}

function CompareTables({ runs }: { runs: RunDetail[] }) {
  const keys = differingKeys(runs.map((r) => r.config));
  const configs = runs.map((r) => flatten(r.config));
  const metrics = [
    ...new Set(runs.flatMap((r) => r.metrics.map((m) => m.name))),
  ].filter((n) => !n.startsWith("system/"));
  const header = (
    <tr>
      <th />
      {runs.map((r) => (
        <th key={r.id}>{r.name}</th>
      ))}
    </tr>
  );
  return (
    <div className="run-tables">
      <section className="run-kv">
        <h3>Config differences</h3>
        {keys.length ? (
          <table className="run-table">
            <thead>{header}</thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  {configs.map((c, i) => (
                    <td key={i} className="mono">
                      {fmtField(c[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="run-muted">The configs are identical.</p>
        )}
      </section>
      <section className="run-kv">
        <h3>Last values</h3>
        <table className="run-table">
          <thead>{header}</thead>
          <tbody>
            {metrics.map((name) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                {runs.map((r) => {
                  const m = r.metrics.find((x) => x.name === name);
                  return (
                    <td key={r.id} className="num">
                      {m ? fmt(m.last) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** On an experiment page: its runs, with a link to each. */
export function ExperimentRuns({ experimentId }: { experimentId: string }) {
  const { api } = useWorkspaceApi();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => {
    api<{ items: RunSummary[] }>(
      `/api/runs?experimentId=${encodeURIComponent(experimentId)}&limit=20`,
    ).then(
      (r) => setRuns(r.items),
      () => setRuns([]),
    );
  }, [api, experimentId]);
  if (!runs.length) return null;
  return (
    <div className="experiment-runs">
      <span className="eyebrow">RUNS</span>
      {runs.map((r) => (
        <a key={r.id} href={`#runs/run/${encodeURIComponent(r.id)}`}>
          <StatusPill status={r.status} />
          {r.name}
          <small>{formatDuration(r.runtimeMs)}</small>
        </a>
      ))}
      {runs.length > 1 && (
        <a
          href={`#runs/compare/${runs
            .slice(0, 8)
            .map((r) => encodeURIComponent(r.id))
            .join(",")}`}
        >
          <GitCompare size={13} /> Compare
        </a>
      )}
    </div>
  );
}
