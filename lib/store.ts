import { documentArtifactReferences } from "./document-references";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  statSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import {
  recordInputSchema,
  metricSchema,
  chartSpecSchema,
  fieldDefinitionsSchema,
  type FieldDefinition,
  type FieldValue,
  type ResearchRecord,
  type Artifact,
  type Activity,
  type Workspace,
  type Relation,
  type ChartLink,
} from "./schema";
import { z } from "zod";
import { panelForLink } from "./charts";

import {
  dataDir,
  StoreError,
  activeWorkspace,
  workspaceDataDir,
  getResearchRoot,
} from "./workspaces";
export { dataDir, researchRoot, StoreError } from "./workspaces";
const connections = new Map<string, DatabaseSync>();
const transactions = new Set<DatabaseSync>();

export function db() {
  const folder = workspaceDataDir();
  const existing = connections.get(folder);
  if (existing) return existing;
  mkdirSync(path.join(folder, "artifacts"), { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const connection = new DatabaseSync(path.join(folder, "parallax.sqlite"));
  chmodSync(path.join(folder, "parallax.sqlite"), 0o600);
  connection.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (record_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(record_id, revision));
    CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, record_id TEXT, title TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (source TEXT PRIMARY KEY, hash TEXT NOT NULL, record_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chart_links (id TEXT PRIMARY KEY, experimentId TEXT NOT NULL REFERENCES records(id), metricName TEXT NOT NULL, recordId TEXT NOT NULL REFERENCES records(id), UNIQUE(experimentId,metricName,recordId));
    CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES records(id), target TEXT NOT NULL REFERENCES records(id), type TEXT NOT NULL, label TEXT NOT NULL, UNIQUE(source, target, type));
    CREATE TABLE IF NOT EXISTS metric_points (record_id TEXT NOT NULL, name TEXT NOT NULL, step REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(record_id, name, step)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS trace_spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, session_id TEXT, experiment_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL, level TEXT NOT NULL, status_message TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER, ttft_ms INTEGER, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, input TEXT, output TEXT, metadata TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(trace_id, span_id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS trace_spans_start ON trace_spans(start_ms);
    CREATE INDEX IF NOT EXISTS trace_spans_session ON trace_spans(session_id);
    CREATE INDEX IF NOT EXISTS trace_spans_experiment ON trace_spans(experiment_id);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, name TEXT NOT NULL, run_group TEXT NOT NULL, tags TEXT NOT NULL, notes TEXT NOT NULL, experiment_id TEXT, status TEXT NOT NULL, exit_code INTEGER, config TEXT NOT NULL, summary TEXT NOT NULL, meta TEXT NOT NULL, started_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL, ended_ms INTEGER);
    CREATE INDEX IF NOT EXISTS runs_last ON runs(last_ms);
    CREATE TABLE IF NOT EXISTS run_points (run_id TEXT NOT NULL, name TEXT NOT NULL, step REAL NOT NULL, time_ms INTEGER NOT NULL, value REAL, PRIMARY KEY(run_id, name, step)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS run_metrics (run_id TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, last_step REAL NOT NULL, last REAL, min REAL, max REAL, non_finite INTEGER NOT NULL, first_non_finite_step REAL, PRIMARY KEY(run_id, name)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS evaluators (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL, score_name TEXT NOT NULL UNIQUE, level TEXT NOT NULL, enabled INTEGER NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS eval_scores (id TEXT PRIMARY KEY, name TEXT NOT NULL, level TEXT NOT NULL, trace_id TEXT, session_id TEXT NOT NULL, span_id TEXT NOT NULL, data_type TEXT NOT NULL, value REAL, string_value TEXT NOT NULL, verdict TEXT NOT NULL, comment TEXT NOT NULL, graded INTEGER NOT NULL, error INTEGER NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL, calls TEXT NOT NULL, created_at TEXT NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS eval_scores_trace ON eval_scores(trace_id);
    CREATE INDEX IF NOT EXISTS eval_scores_session ON eval_scores(session_id);
    CREATE INDEX IF NOT EXISTS eval_scores_name ON eval_scores(name);
  `);
  connections.set(folder, connection);
  return connection;
}

export function transaction<T>(fn: () => T): T {
  const database = db();
  if (transactions.has(database)) return fn();
  database.exec("BEGIN IMMEDIATE");
  transactions.add(database);
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    transactions.delete(database);
  }
}

export function log(
  action: string,
  recordId: string | null,
  title: string,
  actor: string,
) {
  db()
    .prepare(
      "INSERT INTO activity(action, record_id, title, actor, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(action, recordId, title, actor, new Date().toISOString());
}

// Metrics live in their own append-only table, so an append costs the new points
// only, not a copy of the whole record in its revision history. Payloads written by
// older Parallax versions (or older processes still running) keep points inline;
// reads merge both, and the next write of the record moves them into the table.
type Metric = ResearchRecord["metrics"][number];
const metricKey = (m: { name: string; step: number }) => `${m.name}:${m.step}`;

function metricRows(id?: string) {
  return (
    id
      ? db()
          .prepare(
            "SELECT record_id, payload FROM metric_points WHERE record_id = ? ORDER BY name, step",
          )
          .all(id)
      : db()
          .prepare(
            "SELECT record_id, payload FROM metric_points ORDER BY record_id, name, step",
          )
          .all()
  ) as { record_id: string; payload: string }[];
}

function withMetrics(record: ResearchRecord, stored: Metric[]): ResearchRecord {
  const keys = new Set(stored.map(metricKey));
  const inline = (record.metrics ?? []).filter((m) => !keys.has(metricKey(m)));
  return { ...record, metrics: [...stored, ...inline] };
}

function insertMetrics(id: string, metrics: Metric[]) {
  const insert = db().prepare(
    "INSERT OR IGNORE INTO metric_points(record_id, name, step, payload) VALUES (?, ?, ?, ?)",
  );
  for (const m of metrics) insert.run(id, m.name, m.step, JSON.stringify(m));
}

/** Store the record without its points; first move any inline points of the stored payload. */
function writePayload(record: ResearchRecord, adoptInline: boolean) {
  if (adoptInline) {
    const row = db()
      .prepare("SELECT payload FROM records WHERE id = ?")
      .get(record.id) as { payload: string } | undefined;
    if (row) insertMetrics(record.id, JSON.parse(row.payload).metrics ?? []);
  }
  const payload = JSON.stringify({ ...record, metrics: [] });
  db()
    .prepare(
      "INSERT INTO records(id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
    )
    .run(record.id, payload);
  return payload;
}

export function listRecords(
  query = "",
  kind = "",
  fields: Record<string, FieldValue> = {},
): ResearchRecord[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const stored = new Map<string, Metric[]>();
  for (const row of metricRows()) {
    const list = stored.get(row.record_id) ?? [];
    list.push(JSON.parse(row.payload));
    stored.set(row.record_id, list);
  }
  return (
    db().prepare("SELECT payload FROM records").all() as { payload: string }[]
  )
    .map((row) => JSON.parse(row.payload) as ResearchRecord)
    .filter(
      (r) =>
        (!kind || r.kind === kind) &&
        Object.entries(fields).every(
          ([k, v]) => (r.fields?.[k] ?? null) === v,
        ) &&
        terms.every((t) =>
          `${r.title} ${r.content} ${r.tags.join(" ")} ${JSON.stringify(r.provenance)} ${JSON.stringify(r.fields ?? {})}`
            .toLowerCase()
            .includes(t),
        ),
    )
    .map((r) => withMetrics(r, stored.get(r.id) ?? []))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getRecord(id: string): ResearchRecord {
  const row = db()
    .prepare("SELECT payload FROM records WHERE id = ?")
    .get(id) as { payload: string } | undefined;
  if (!row) throw new StoreError("Record not found", 404);
  const record = JSON.parse(row.payload);
  return withMetrics(
    { ...recordInputSchema.parse(record), ...record },
    metricRows(id).map((r) => JSON.parse(r.payload)),
  );
}

function validateLinks(ids: string[]) {
  for (const id of ids) getRecord(id);
}

/** Values must match their definition. Undefined keys survive only if already stored. */
function validateFields(
  kind: ResearchRecord["kind"],
  fields: Record<string, FieldValue>,
  previous: Record<string, FieldValue> = {},
) {
  const definitions = new Map(getFieldDefinitions().map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(fields)) {
    const field = definitions.get(key);
    if (!field || !field.kinds.includes(kind)) {
      if (key in previous) continue;
      throw new StoreError(
        `Unknown field "${key}" for ${kind} entries. Define it in Settings or with define_fields first.`,
      );
    }
    if (value === null) continue;
    const ok =
      field.type === "number"
        ? typeof value === "number"
        : field.type === "boolean"
          ? typeof value === "boolean"
          : field.type === "select"
            ? typeof value === "string" && field.options.includes(value)
            : typeof value === "string";
    if (!ok)
      throw new StoreError(
        field.type === "select"
          ? `Field "${key}" must be one of: ${field.options.join(", ")}`
          : `Field "${key}" must be a ${field.type}`,
      );
  }
}

/**
 * Write the record and a revision. Points stay in metric_points: callers that change
 * them do it explicitly, and pass adoptInline=false when they replace the whole set.
 */
function persist(
  record: ResearchRecord,
  action: string,
  actor: string,
  adoptInline = true,
) {
  const previousContent =
    action === "updated" ? getRecord(record.id).content : "";
  const payload = writePayload(record, adoptInline);
  db()
    .prepare(
      "INSERT INTO revisions(record_id, revision, payload) VALUES (?, ?, ?)",
    )
    .run(record.id, record.revision, payload);
  log(action, record.id, record.title, actor);
  if (action === "created" || action === "updated") {
    const previous = new Set(
      documentArtifactReferences(previousContent).map(
        (ref) => `${ref.workspaceId}:${ref.id}`,
      ),
    );
    for (const ref of documentArtifactReferences(record.content)) {
      if (previous.has(`${ref.workspaceId}:${ref.id}`)) continue;
      if (ref.workspaceId !== activeWorkspace().id)
        throw new StoreError(
          "Document figures and files must belong to this workspace",
        );
      const { artifact } = getArtifact(ref.id);
      if (!artifact.recordIds.includes(record.id))
        updateArtifactLinks(
          artifact.id,
          [...artifact.recordIds, record.id],
          artifact.revision,
          actor,
        );
    }
  }
  return record;
}

export function createRecord(input: unknown, actor = "Julien") {
  const value = recordInputSchema.parse(input);
  return transaction(() => {
    validateLinks(value.linkedIds);
    validateFields(value.kind, value.fields);
    const now = new Date().toISOString();
    const record = persist(
      {
        ...value,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        revision: 1,
        author: actor,
      },
      "created",
      actor,
    );
    insertMetrics(record.id, value.metrics);
    return record;
  });
}

/**
 * Replace a record. Its metrics are replaced only when the input has a `metrics` key
 * (the app's editor); without one (MCP update_record) the measured points are kept.
 */
export function updateRecord(
  id: string,
  input: unknown,
  revision: number,
  actor = "Julien",
) {
  const replaceMetrics =
    typeof input === "object" && input !== null && "metrics" in input;
  return transaction(() => {
    const existing = getRecord(id);
    if (existing.revision !== revision)
      throw new StoreError(
        "This record changed elsewhere. Reopen it before saving.",
        409,
      );
    if (existing.kind === "journal")
      throw new StoreError(
        "Journal entries are immutable. Add a new entry linked to this one.",
        409,
      );
    const { metrics, ...value } = recordInputSchema.parse(input);
    if (value.kind !== existing.kind)
      throw new StoreError("Record type cannot be changed");
    validateLinks(value.linkedIds);
    validateFields(value.kind, value.fields, existing.fields);
    if (replaceMetrics) {
      db().prepare("DELETE FROM metric_points WHERE record_id = ?").run(id);
      insertMetrics(id, metrics);
    }
    return persist(
      {
        ...existing,
        ...value,
        metrics: replaceMetrics ? metrics : existing.metrics,
        updatedAt: new Date().toISOString(),
        revision: existing.revision + 1,
      },
      "updated",
      actor,
      !replaceMetrics,
    );
  });
}

export function togglePin(id: string, revision: number) {
  return transaction(() => {
    const record = getRecord(id);
    if (record.revision !== revision)
      throw new StoreError("Record changed. Refresh and try again.", 409);
    return persist(
      {
        ...record,
        pinned: !record.pinned,
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      },
      record.pinned ? "unpinned" : "pinned",
      "Julien",
    );
  });
}

/** Remove a record and its links. Revisions and the activity log are kept. */
export function deleteRecord(id: string, revision: number, actor = "Julien") {
  return transaction(() => {
    const record = getRecord(id);
    if (record.revision !== revision)
      throw new StoreError("Record changed. Refresh and try again.", 409);
    if (record.kind === "journal")
      throw new StoreError("Journal entries are immutable.", 409);
    const others = listRecords().filter((r) => r.linkedIds.includes(id));
    const journal = others.find((r) => r.kind === "journal");
    if (journal)
      throw new StoreError(
        `Referenced by the journal entry "${journal.title}", which is immutable.`,
        409,
      );
    for (const r of others)
      persist(
        {
          ...r,
          linkedIds: r.linkedIds.filter((x) => x !== id),
          revision: r.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        "updated",
        actor,
      );
    for (const a of listArtifacts().filter((a) => a.recordIds.includes(id)))
      updateArtifactLinks(
        a.id,
        a.recordIds.filter((x) => x !== id),
        a.revision,
        actor,
      );
    for (const sql of [
      "DELETE FROM relations WHERE source = ?1 OR target = ?1",
      "DELETE FROM chart_links WHERE experimentId = ?1 OR recordId = ?1",
      "DELETE FROM imports WHERE record_id = ?1",
      "DELETE FROM metric_points WHERE record_id = ?1",
      "UPDATE runs SET experiment_id = NULL WHERE experiment_id = ?1",
      "DELETE FROM records WHERE id = ?1",
    ])
      db().prepare(sql).run(id);
    log("deleted", id, record.title, actor);
    return { removed: id };
  });
}

/**
 * Append points to an experiment. A point whose name+step is already stored is an
 * error, or is skipped with onDuplicate "skip" (telemetry re-sent after a job resumes).
 * Appends write no revision copy, but they bump the revision so an edit based on an
 * older read cannot replace the new points.
 */
export function appendMetrics(
  id: string,
  input: unknown,
  options: { onDuplicate?: "error" | "skip" } = {},
  actor = "Claude Code",
) {
  const metrics = z.array(metricSchema).min(1).max(5000).parse(input);
  const onDuplicate = options.onDuplicate ?? "error";
  return transaction(() => {
    const record = getRecord(id);
    if (record.kind !== "experiment")
      throw new StoreError("Metrics belong to an experiment");
    const stored = new Set(record.metrics.map(metricKey));
    const batch = new Set<string>();
    const added: Metric[] = [];
    for (const metric of metrics) {
      const key = metricKey(metric);
      if (batch.has(key))
        throw new StoreError(`Metric ${key} appears twice in this batch.`, 409);
      batch.add(key);
      if (!stored.has(key)) added.push(metric);
      else if (onDuplicate === "error")
        throw new StoreError(
          `Metric ${key} already exists. Use a new step or revise the record explicitly.`,
          409,
        );
    }
    insertMetrics(id, added);
    const revision = record.revision + 1;
    writePayload(
      { ...record, revision, updatedAt: new Date().toISOString() },
      true,
    );
    logMetricsActivity(record, actor);
    return {
      experimentId: id,
      revision,
      added: added.length,
      skipped: metrics.length - added.length,
      total: record.metrics.length + added.length,
    };
  });
}

/** One activity line per experiment per 10 minutes of logging, kept at the top. */
function logMetricsActivity(record: ResearchRecord, actor: string) {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  db()
    .prepare(
      "DELETE FROM activity WHERE action = 'logged metrics for' AND record_id = ? AND created_at >= ?",
    )
    .run(record.id, since);
  log("logged metrics for", record.id, record.title, actor);
}

/** Replace an experiment's chart panels. Metrics are untouched. */
export function setCharts(id: string, input: unknown, actor = "Claude Code") {
  const charts = z.array(chartSpecSchema).max(24).parse(input);
  return transaction(() => {
    const record = getRecord(id);
    if (record.kind !== "experiment")
      throw new StoreError("Chart panels belong to an experiment");
    return persist(
      {
        ...record,
        charts,
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      },
      "arranged charts for",
      actor,
    );
  });
}

export function getRevisions(id: string) {
  getRecord(id);
  return (
    db()
      .prepare(
        "SELECT payload FROM revisions WHERE record_id = ? ORDER BY revision DESC",
      )
      .all(id) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as ResearchRecord);
}

export const fileTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "text/plain",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".ipynb": "application/x-ipynb+json",
  ".html": "text/html",
  ".toml": "text/plain",
  ".yaml": "text/plain",
};
export const maxFileSize = 25 * 1024 * 1024;
export const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

export function addArtifact(
  buffer: Buffer,
  filename: string,
  options: {
    recordId?: string;
    recordIds?: string[];
    caption?: string;
    sourcePath?: string;
    actor?: string;
  } = {},
): Artifact {
  if (buffer.length > maxFileSize || !buffer.length)
    throw new StoreError("Files must be nonempty and at most 25 MB");
  const name = path
    .basename(filename)
    .replace(/[\x00-\x1f]/g, "")
    .slice(0, 240);
  const mime = fileTypes[path.extname(name).toLowerCase()];
  if (!mime)
    throw new StoreError(
      "Unsupported format. Use an image, PDF, notebook, HTML, Markdown, config or data file.",
    );
  if ((options.caption?.length || 0) > 4000)
    throw new StoreError("Caption is too long");
  const recordIds = z
    .array(z.string().uuid())
    .max(50)
    .parse([
      ...new Set([
        ...(options.recordIds || []),
        ...(options.recordId ? [options.recordId] : []),
      ]),
    ]);
  validateLinks(recordIds);
  db();
  const hash = sha256(buffer);
  const storagePath = path.join(workspaceDataDir(), "artifacts", hash);
  try {
    writeFileSync(storagePath, buffer, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const artifact: Artifact = {
    id: randomUUID(),
    name,
    mime,
    size: buffer.length,
    hash,
    recordId: recordIds[0] || null,
    recordIds,
    revision: 1,
    caption: options.caption || "",
    createdAt: new Date().toISOString(),
    sourcePath: options.sourcePath || "",
  };
  return transaction(() => {
    db()
      .prepare("INSERT INTO artifacts(id, payload) VALUES (?, ?)")
      .run(artifact.id, JSON.stringify(artifact));
    log("attached", artifact.recordId, name, options.actor || "Julien");
    return artifact;
  });
}

/** Read a file the agent points at, only from the research or Parallax folders. */
export function readLocalFile(filePath: string) {
  const canonical = realpathSync(filePath);
  const roots = [getResearchRoot(), process.cwd()]
    .filter((p) => p && existsSync(/* turbopackIgnore: true */ p))
    .map((p) => realpathSync(p));
  if (!roots.some((root) => canonical.startsWith(root + path.sep)))
    throw new StoreError(
      "File must be inside the research repository or Parallax workspace",
    );
  if (
    existsSync(dataDir) &&
    (canonical === realpathSync(dataDir) ||
      canonical.startsWith(realpathSync(dataDir) + path.sep))
  )
    throw new StoreError("Application storage cannot be imported");
  if (
    canonical
      .split(path.sep)
      .some(
        (p) =>
          p.startsWith(".") ||
          (["node_modules", "data"].includes(p) &&
            canonical.startsWith(realpathSync(process.cwd()) + path.sep)),
      )
  ) {
    throw new StoreError(
      "Hidden files and application storage cannot be imported",
    );
  }
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.size > maxFileSize)
    throw new StoreError("File must be a regular file under 25 MB");
  return { canonical, buffer: readFileSync(canonical) };
}

export function attachLocalFile(
  filePath: string,
  options: {
    recordId?: string;
    recordIds?: string[];
    caption?: string;
    actor?: string;
  } = {},
) {
  const { canonical, buffer } = readLocalFile(filePath);
  return addArtifact(buffer, path.basename(canonical), {
    ...options,
    sourcePath: canonical,
  });
}

export function listArtifacts(): Artifact[] {
  return (
    db().prepare("SELECT payload FROM artifacts").all() as { payload: string }[]
  )
    .map((r) => {
      const a = JSON.parse(r.payload);
      return {
        ...a,
        recordIds: a.recordIds ?? (a.recordId ? [a.recordId] : []),
        revision: a.revision ?? 1,
      } as Artifact;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function getArtifact(id: string) {
  const artifact = listArtifacts().find((a) => a.id === id);
  if (!artifact) throw new StoreError("Artifact not found", 404);
  return {
    artifact,
    buffer: readFileSync(
      path.join(workspaceDataDir(), "artifacts", artifact.hash),
    ),
  };
}

const settingsSchema = z.object({
  pilotBudget: z.number().positive().max(1000000),
  fellowshipBudget: z.number().positive().max(1000000),
  phase: z.enum(["pilot", "fellowship"]),
  project: z.string().trim().min(1).max(120),
});
export function getSettings(): Workspace["settings"] {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = 'workspace'")
    .get() as { value: string } | undefined;
  return row
    ? JSON.parse(row.value)
    : {
        pilotBudget: 500,
        fellowshipBudget: 15000,
        phase: "pilot",
        project:
          activeWorkspace().id === "default"
            ? "Eval gaming under pressure"
            : activeWorkspace().name,
      };
}
export function saveSettings(input: unknown) {
  const value = settingsSchema.parse(input);
  db()
    .prepare(
      "INSERT INTO settings(key,value) VALUES ('workspace',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(JSON.stringify(value));
  return value;
}

export function getFieldDefinitions(): FieldDefinition[] {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = 'fields'")
    .get() as { value: string } | undefined;
  return row ? fieldDefinitionsSchema.parse(JSON.parse(row.value)) : [];
}
/** Removing a definition keeps existing values on records; they stay searchable. */
export function saveFieldDefinitions(input: unknown, actor = "Julien") {
  const fields = fieldDefinitionsSchema.parse(input);
  return transaction(() => {
    db()
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('fields',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(fields));
    log("updated custom fields", null, `${fields.length} fields`, actor);
    return fields;
  });
}

export function getWorkspace(): Workspace {
  return {
    info: activeWorkspace(),
    fields: getFieldDefinitions(),
    chartLinks: listChartLinks(),
    records: listRecords(),
    artifacts: listArtifacts(),
    relations: listRelations(),
    activity: db()
      .prepare(
        "SELECT id, action, record_id AS recordId, title, actor, created_at AS createdAt FROM activity ORDER BY id DESC LIMIT 60",
      )
      .all() as Activity[],
    settings: getSettings(),
    researchRoot: getResearchRoot(),
    dataDir: workspaceDataDir(),
    storageRoot: dataDir,
    mcpPath: path.join(process.cwd(), "mcp/server.ts"),
  };
}

export const relationSchema = z.object({
  source: z.string().uuid(),
  target: z.string().uuid(),
  type: z.enum(["supports", "contradicts", "extends", "uses", "relates"]),
  label: z.string().max(300).default(""),
});
export function linkRecords(input: unknown, actor = "Julien") {
  const value = relationSchema.parse(input);
  if (value.source === value.target)
    throw new StoreError("Choose two different records");
  return transaction(() => {
    const source = getRecord(value.source);
    getRecord(value.target);
    const existing = db()
      .prepare(
        "SELECT * FROM relations WHERE source = ? AND target = ? AND type = ?",
      )
      .get(value.source, value.target, value.type) as Relation | undefined;
    if (existing) return { ...existing };
    const relation: Relation = { id: randomUUID(), ...value };
    db()
      .prepare(
        "INSERT INTO relations(id,source,target,type,label) VALUES (?,?,?,?,?)",
      )
      .run(
        relation.id,
        relation.source,
        relation.target,
        relation.type,
        relation.label,
      );
    log("linked", value.source, source.title, actor);
    return relation;
  });
}
export function listRelations(): Relation[] {
  return db().prepare("SELECT * FROM relations").all() as Relation[];
}

export function updateTask(
  id: string,
  patch: unknown,
  revision: number,
  actor = "Julien",
) {
  const update = recordInputSchema
    .pick({ status: true, priority: true, assignee: true, dueDate: true })
    .partial()
    .parse(patch);
  const record = getRecord(id);
  if (record.kind !== "task") throw new StoreError("Not a task");
  return updateRecord(id, { ...record, ...update }, revision, actor);
}

export function exportWorkspace() {
  return {
    format: "parallax.v2",
    exportedAt: new Date().toISOString(),
    ...getWorkspace(),
    revisions: (
      db()
        .prepare("SELECT payload FROM revisions ORDER BY record_id, revision")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload)),
    activity: db().prepare("SELECT * FROM activity ORDER BY id").all(),
    traceSpans: db()
      .prepare("SELECT * FROM trace_spans ORDER BY trace_id, start_ms")
      .all(),
    runs: db().prepare("SELECT * FROM runs ORDER BY started_ms").all(),
    runPoints: db()
      .prepare("SELECT * FROM run_points ORDER BY run_id, name, step")
      .all(),
    evaluators: db().prepare("SELECT * FROM evaluators ORDER BY rowid").all(),
    evalScores: db()
      .prepare("SELECT * FROM eval_scores ORDER BY session_id, id")
      .all(),
    artifacts: listArtifacts().map((a) => ({
      ...a,
      base64: getArtifact(a.id).buffer.toString("base64"),
    })),
  };
}

export function closeDatabases() {
  for (const connection of connections.values()) connection.close();
  connections.clear();
}

/** Change metadata without changing the preserved file or journal contents. */
export function updateArtifactLinks(
  id: string,
  recordIds: string[],
  revision: number,
  actor = "Julien",
) {
  const ids = [...new Set(z.array(z.string().uuid()).max(50).parse(recordIds))];
  return transaction(() => {
    const { artifact } = getArtifact(id);
    if (artifact.revision !== revision)
      throw new StoreError(
        "This file was updated elsewhere. Refresh and try again.",
        409,
      );
    validateLinks(ids);
    const updated = {
      ...artifact,
      recordIds: ids,
      recordId: ids[0] || null,
      revision: artifact.revision + 1,
    };
    db()
      .prepare("UPDATE artifacts SET payload = ? WHERE id = ?")
      .run(JSON.stringify(updated), id);
    log("updated file links for", updated.recordId, artifact.name, actor);
    return updated;
  });
}

export const chartLinkSchema = z.object({
  experimentId: z.string().uuid(),
  metricName: z.string().trim().min(1).max(100),
  recordId: z.string().uuid(),
});
export function linkChart(input: unknown, actor = "Julien"): ChartLink {
  const value = chartLinkSchema.parse(input);
  return transaction(() => {
    const source = getRecord(value.experimentId);
    const target = getRecord(value.recordId);
    if (source.id === target.id)
      throw new StoreError(
        "This chart is already part of its source experiment",
      );
    if (source.kind !== "experiment" || !panelForLink(source, value.metricName))
      throw new StoreError(
        "Choose a measured metric or chart panel from an experiment",
      );
    const existing = db()
      .prepare(
        "SELECT * FROM chart_links WHERE experimentId = ? AND metricName = ? AND recordId = ?",
      )
      .get(value.experimentId, value.metricName, value.recordId) as
      ChartLink | undefined;
    if (existing) return { ...existing };
    const link = { id: randomUUID(), ...value };
    db()
      .prepare(
        "INSERT INTO chart_links(id,experimentId,metricName,recordId) VALUES (?,?,?,?)",
      )
      .run(link.id, link.experimentId, link.metricName, link.recordId);
    log("linked chart to", target.id, target.title, actor);
    return link;
  });
}
export function unlinkChart(id: string, actor = "Julien") {
  return transaction(() => {
    const link = listChartLinks().find((link) => link.id === id);
    if (!link) throw new StoreError("Chart link not found", 404);
    db().prepare("DELETE FROM chart_links WHERE id = ?").run(id);
    log(
      "unlinked chart from",
      link.recordId,
      getRecord(link.recordId).title,
      actor,
    );
    return { removed: id };
  });
}
export function listChartLinks(): ChartLink[] {
  return db()
    .prepare("SELECT * FROM chart_links")
    .all()
    .map((row) => ({ ...row })) as ChartLink[];
}
