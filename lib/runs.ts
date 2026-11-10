// Runs: live training telemetry, W&B-style. Clients send events (start, log, config,
// summary, heartbeat, finish). The same events arrive over HTTP while a job runs, or from
// a JSONL file written offline and synced later, so a resent event must be harmless:
// a point sent again replaces the stored one, and config/summary/meta merge.
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, transaction, getRecord, log, StoreError } from "./store";
import {
  runEventsSchema,
  runEventSchema,
  runPatchSchema,
  runQuerySchema,
  runStallMs,
  type MetricStats,
  type RunDetail,
  type RunPoint,
  type RunSeries,
  type RunStatus,
  type RunSummary,
} from "./schema";

type RunRow = {
  id: string;
  name: string;
  run_group: string;
  tags: string;
  notes: string;
  experiment_id: string | null;
  status: string;
  exit_code: number | null;
  config: string;
  summary: string;
  meta: string;
  started_ms: number;
  last_ms: number;
  ended_ms: number | null;
};
type StatsRow = {
  run_id: string;
  name: string;
  count: number;
  last_step: number;
  last: number | null;
  min: number | null;
  max: number | null;
  non_finite: number;
  first_non_finite_step: number | null;
};

const isSystem = (name: string) => name.startsWith("system/");
const toMs = (v: string | number | undefined, now: number) =>
  v === undefined ? now : typeof v === "number" ? Math.round(v) : Date.parse(v);

function checkExperiment(id: string) {
  if (getRecord(id).kind !== "experiment")
    throw new StoreError(`${id} is not an experiment`);
}

function insertRun(id: string, time: number) {
  db()
    .prepare(
      `INSERT INTO runs (id, name, run_group, tags, notes, experiment_id, status, exit_code, config, summary, meta, started_ms, last_ms, ended_ms)
       VALUES (?, ?, '', '[]', '', NULL, 'running', NULL, '{}', '{}', '{}', ?, ?, NULL)`,
    )
    .run(id, id, time, time);
}
const getRow = (id: string) =>
  db().prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;

/** Apply events in order, in one transaction. Returns what changed. */
export function applyRunEvents(input: unknown, actor = "Run client") {
  const events = runEventsSchema.parse(input);
  const now = Date.now();
  return transaction(() => {
    const insertPoint = db().prepare(
      "INSERT OR REPLACE INTO run_points (run_id, name, step, time_ms, value) VALUES (?, ?, ?, ?, ?)",
    );
    // Points per run+metric, so summary statistics update once per batch.
    const touched = new Map<string, { step: number; value: number | null }[]>();
    const runs = new Set<string>();
    let points = 0;
    for (const event of events) {
      const time = toMs(event.time, now);
      let row = getRow(event.run);
      const created = !row;
      if (!row) {
        insertRun(event.run, time);
        row = getRow(event.run) as RunRow;
      }
      runs.add(event.run);
      const set = (sql: string, ...args: (string | number | null)[]) =>
        db()
          .prepare(`UPDATE runs SET ${sql} WHERE id = ?`)
          .run(...args, event.run);
      const merge = (column: "config" | "summary" | "meta", values: object) =>
        set(
          `${column} = ?`,
          JSON.stringify({ ...JSON.parse(row[column]), ...values }),
        );
      switch (event.type) {
        case "start":
          if (event.name !== undefined) set("name = ?", event.name);
          if (event.group !== undefined) set("run_group = ?", event.group);
          if (event.tags !== undefined)
            set("tags = ?", JSON.stringify(event.tags));
          if (event.notes !== undefined) set("notes = ?", event.notes);
          if (event.experimentId) {
            checkExperiment(event.experimentId);
            set("experiment_id = ?", event.experimentId);
          }
          if (event.config) merge("config", event.config);
          if (event.meta) merge("meta", event.meta);
          // A start on a known run resumes it, e.g. a preempted Slurm job requeued.
          set("status = 'running', exit_code = NULL, ended_ms = NULL");
          log(
            created ? "started run" : "resumed run",
            event.experimentId || row.experiment_id,
            event.name ?? row.name,
            actor,
          );
          break;
        case "log":
          for (const [name, value] of Object.entries(event.values)) {
            insertPoint.run(event.run, name, event.step, time, value);
            const key = JSON.stringify([event.run, name]);
            touched.set(key, [
              ...(touched.get(key) ?? []),
              { step: event.step, value },
            ]);
            points++;
          }
          break;
        case "config":
          merge("config", event.values);
          break;
        case "summary":
          merge("summary", event.values);
          break;
        case "heartbeat":
          break;
        case "finish":
          set(
            "status = ?, exit_code = ?, ended_ms = ?",
            event.status,
            event.exitCode ?? null,
            time,
          );
          log(
            event.status === "finished"
              ? "finished run"
              : `run ${event.status}`,
            row.experiment_id,
            row.name,
            actor,
          );
          break;
      }
      set(
        "last_ms = MAX(last_ms, ?), started_ms = MIN(started_ms, ?)",
        time,
        time,
      );
    }
    for (const [key, added] of touched) {
      const [run, name] = JSON.parse(key) as [string, string];
      updateStats(run, name, added);
    }
    return { runs: [...runs], events: events.length, points };
  });
}

/** Appends (every new step after the stored last step) update stats in place; anything else recounts. */
function updateStats(
  run: string,
  name: string,
  added: { step: number; value: number | null }[],
) {
  const old = db()
    .prepare("SELECT * FROM run_metrics WHERE run_id = ? AND name = ?")
    .get(run, name) as StatsRow | undefined;
  const steps = added.map((p) => p.step);
  const appended =
    old &&
    new Set(steps).size === steps.length &&
    Math.min(...steps) > old.last_step;
  let next: Omit<StatsRow, "run_id" | "name">;
  if (appended) {
    const finite = added.flatMap((p) => (p.value === null ? [] : [p.value]));
    const bad = added.filter((p) => p.value === null).map((p) => p.step);
    const last = added.reduce((a, b) => (b.step > a.step ? b : a));
    next = {
      count: old.count + added.length,
      last_step: last.step,
      last: last.value,
      min: finite.length ? Math.min(old.min ?? Infinity, ...finite) : old.min,
      max: finite.length ? Math.max(old.max ?? -Infinity, ...finite) : old.max,
      non_finite: old.non_finite + bad.length,
      first_non_finite_step:
        old.first_non_finite_step ?? (bad.length ? Math.min(...bad) : null),
    };
  } else {
    const agg = db()
      .prepare(
        `SELECT COUNT(*) AS count, MAX(step) AS last_step, MIN(value) AS min, MAX(value) AS max,
                SUM(value IS NULL) AS non_finite, MIN(CASE WHEN value IS NULL THEN step END) AS first_non_finite_step
         FROM run_points WHERE run_id = ? AND name = ?`,
      )
      .get(run, name) as Omit<StatsRow, "run_id" | "name" | "last">;
    const last = db()
      .prepare(
        "SELECT value FROM run_points WHERE run_id = ? AND name = ? ORDER BY step DESC LIMIT 1",
      )
      .get(run, name) as { value: number | null };
    next = { ...agg, last: last.value };
  }
  db()
    .prepare(
      `INSERT OR REPLACE INTO run_metrics (run_id, name, count, last_step, last, min, max, non_finite, first_non_finite_step)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run,
      name,
      next.count,
      next.last_step,
      next.last,
      next.min,
      next.max,
      next.non_finite,
      next.first_non_finite_step,
    );
}

function statsFor(runIds: string[]) {
  const byRun = new Map<string, MetricStats[]>();
  if (!runIds.length) return byRun;
  const rows = db()
    .prepare(
      `SELECT * FROM run_metrics WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY run_id, name`,
    )
    .all(...runIds) as StatsRow[];
  for (const r of rows)
    byRun.set(r.run_id, [
      ...(byRun.get(r.run_id) ?? []),
      {
        name: r.name,
        count: r.count,
        lastStep: r.last_step,
        last: r.last,
        min: r.min,
        max: r.max,
        nonFinite: r.non_finite,
        firstNonFiniteStep: r.first_non_finite_step,
      },
    ]);
  return byRun;
}

function toSummary(row: RunRow, stats: MetricStats[], now: number): RunSummary {
  const status: RunStatus =
    row.status === "running" && now - row.last_ms > runStallMs
      ? "stalled"
      : (row.status as RunStatus);
  const training = stats.filter((s) => !isSystem(s.name));
  return {
    id: row.id,
    name: row.name,
    group: row.run_group,
    tags: JSON.parse(row.tags),
    notes: row.notes,
    experimentId: row.experiment_id,
    status,
    exitCode: row.exit_code,
    startedAt: row.started_ms,
    lastSeenAt: row.last_ms,
    endedAt: row.ended_ms,
    runtimeMs: (row.ended_ms ?? row.last_ms) - row.started_ms,
    lastStep: training.length
      ? Math.max(...training.map((s) => s.lastStep))
      : null,
    summary: {
      ...Object.fromEntries(training.map((s) => [s.name, s.last])),
      ...JSON.parse(row.summary),
    },
  };
}

export function listRuns(input: unknown = {}) {
  const query = runQuerySchema.parse(input);
  const now = Date.now();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (query.q) {
    where.push(
      "(id LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR run_group LIKE ?1 ESCAPE '\\' OR tags LIKE ?1 ESCAPE '\\' OR notes LIKE ?1 ESCAPE '\\')",
    );
    args.push(`%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const p = () => `?${args.length + 1}`;
  if (query.status === "running" || query.status === "stalled") {
    where.push(
      `status = 'running' AND last_ms ${query.status === "running" ? ">=" : "<"} ${p()}`,
    );
    args.push(now - runStallMs);
  } else if (query.status !== "all") {
    where.push(`status = ${p()}`);
    args.push(query.status);
  }
  if (query.group) {
    where.push(`run_group = ${p()}`);
    args.push(query.group);
  }
  if (query.experimentId) {
    where.push(`experiment_id = ${p()}`);
    args.push(query.experimentId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db()
      .prepare(`SELECT COUNT(*) AS n FROM runs ${clause}`)
      .get(...args) as {
      n: number;
    }
  ).n;
  const rows = db()
    .prepare(
      `SELECT * FROM runs ${clause} ORDER BY last_ms DESC LIMIT ${query.limit} OFFSET ${query.offset}`,
    )
    .all(...args) as RunRow[];
  const stats = statsFor(rows.map((r) => r.id));
  const groups = (
    db()
      .prepare(
        "SELECT DISTINCT run_group FROM runs WHERE run_group != '' ORDER BY run_group",
      )
      .all() as { run_group: string }[]
  ).map((g) => g.run_group);
  return {
    items: rows.map((r) => toSummary(r, stats.get(r.id) ?? [], now)),
    total,
    groups,
  };
}

export function getRun(id: string): RunDetail {
  const row = getRow(id);
  if (!row) throw new StoreError(`Run ${id} not found`, 404);
  const stats = statsFor([id]).get(id) ?? [];
  return {
    ...toSummary(row, stats, Date.now()),
    config: JSON.parse(row.config),
    meta: JSON.parse(row.meta),
    metrics: stats,
  };
}

export const seriesQuerySchema = z.object({
  runs: z.array(z.string()).min(1).max(20),
  names: z
    .array(z.string())
    .max(500)
    .optional()
    .describe("Metric names; every metric of the runs when omitted"),
  maxPoints: z.coerce.number().int().min(10).max(10000).default(1000),
});

/**
 * Metric series of one or more runs. A series longer than maxPoints is cut into equal
 * step buckets: each point is the bucket mean with its min and max, so a spike stays visible.
 */
export function runSeries(input: unknown): RunSeries[] {
  const query = seriesQuerySchema.parse(input);
  const stats = statsFor(query.runs);
  const out: RunSeries[] = [];
  for (const run of query.runs) {
    if (!getRow(run)) throw new StoreError(`Run ${run} not found`, 404);
    const wanted = query.names ? new Set(query.names) : null;
    for (const s of stats.get(run) ?? []) {
      if (wanted && !wanted.has(s.name)) continue;
      const first = (
        db()
          .prepare(
            "SELECT MIN(step) AS step FROM run_points WHERE run_id = ? AND name = ?",
          )
          .get(run, s.name) as { step: number }
      ).step;
      const width = (s.lastStep - first) / query.maxPoints;
      const sampled = s.count > query.maxPoints && width > 0;
      const points = sampled
        ? (
            db()
              .prepare(
                `SELECT MIN(step) AS step, MIN(time_ms) AS time, AVG(value) AS value, MIN(value) AS min, MAX(value) AS max
                 FROM run_points WHERE run_id = ? AND name = ?
                 GROUP BY CAST((step - ?) / ? AS INTEGER) ORDER BY step`,
              )
              .all(run, s.name, first, width) as {
              step: number;
              time: number;
              value: number | null;
              min: number | null;
              max: number | null;
            }[]
          ).map((p): RunPoint =>
            p.value === null || p.min === p.max
              ? { step: p.step, time: p.time, value: p.value }
              : (p as RunPoint),
          )
        : (db()
            .prepare(
              "SELECT step, time_ms AS time, value FROM run_points WHERE run_id = ? AND name = ? ORDER BY step",
            )
            .all(run, s.name) as RunPoint[]);
      out.push({ run, name: s.name, total: s.count, sampled, points });
    }
  }
  return out;
}

export function updateRun(id: string, input: unknown, actor = "Julien") {
  const patch = runPatchSchema.parse(input);
  return transaction(() => {
    const row = getRow(id);
    if (!row) throw new StoreError(`Run ${id} not found`, 404);
    if (patch.experimentId) checkExperiment(patch.experimentId);
    db()
      .prepare(
        "UPDATE runs SET name = ?, run_group = ?, tags = ?, notes = ?, experiment_id = ? WHERE id = ?",
      )
      .run(
        patch.name ?? row.name,
        patch.group ?? row.run_group,
        patch.tags ? JSON.stringify(patch.tags) : row.tags,
        patch.notes ?? row.notes,
        patch.experimentId === undefined
          ? row.experiment_id
          : patch.experimentId || null,
        id,
      );
    log("edited run", null, patch.name ?? row.name, actor);
    return getRun(id);
  });
}

export function deleteRun(id: string, actor = "Julien") {
  return transaction(() => {
    const row = getRow(id);
    if (!row) throw new StoreError(`Run ${id} not found`, 404);
    for (const table of ["run_points", "run_metrics"])
      db().prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(id);
    db().prepare("DELETE FROM runs WHERE id = ?").run(id);
    log("deleted run", null, row.name, actor);
    return { removed: id };
  });
}

/** Import a JSONL event log (the Python client's offline file), applying valid lines. */
export function importRunText(text: string, actor = "Run sync") {
  const rejected: { line: number; error: string }[] = [];
  const events: unknown[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(runEventSchema.parse(JSON.parse(line)));
    } catch (e) {
      rejected.push({
        line: i + 1,
        error:
          e instanceof z.ZodError
            ? e.issues
                .map((x) => `${x.path.join(".")}: ${x.message}`)
                .join("; ")
            : "Invalid JSON",
      });
    }
  });
  if (!events.length && !rejected.length)
    throw new StoreError("The file is empty");
  const runs = new Set<string>();
  let points = 0;
  for (let i = 0; i < events.length; i += 5000) {
    const r = applyRunEvents(events.slice(i, i + 5000), actor);
    r.runs.forEach((id) => runs.add(id));
    points += r.points;
  }
  return { runs: [...runs], events: events.length, points, rejected };
}

// Demo seed: SYNTHETIC runs from seeds/demo-runs.jsonl (made by seeds/make-demo-runs.py).
// Their ids start with "demo-" and they carry the tag "demo", so they are never mistaken
// for results and can be removed together.
const isDemo = (id: string, tags: string[]) =>
  id.startsWith("demo-") && tags.includes("demo");

export function removeDemoRuns(actor = "Julien") {
  const rows = db()
    .prepare("SELECT id, tags FROM runs WHERE id LIKE 'demo-%'")
    .all() as { id: string; tags: string }[];
  const ids = rows
    .filter((r) => isDemo(r.id, JSON.parse(r.tags)))
    .map((r) => r.id);
  for (const id of ids) deleteRun(id, actor);
  return { removed: ids };
}

/** Replace the demo runs with a fresh copy of the seed, shifted so it ended 10 minutes ago. */
export function loadDemoRuns(actor = "Julien") {
  const file = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "seeds",
    "demo-runs.jsonl",
  );
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => runEventSchema.parse(JSON.parse(line)));
  for (const e of events)
    if (!e.run.startsWith("demo-"))
      throw new StoreError(
        `Seed run ${e.run} must have an id starting with "demo-"`,
      );
  const times = events.map((e) => toMs(e.time, 0));
  const shift = Date.now() - 10 * 60_000 - Math.max(...times);
  removeDemoRuns(actor);
  const shifted = events.map((e, i) => ({ ...e, time: times[i] + shift }));
  const runs = new Set<string>();
  let points = 0;
  for (let i = 0; i < shifted.length; i += 5000) {
    const r = applyRunEvents(shifted.slice(i, i + 5000), "Demo seed");
    r.runs.forEach((id) => runs.add(id));
    points += r.points;
  }
  return { runs: [...runs], events: shifted.length, points };
}
