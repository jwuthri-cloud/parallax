import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasSupportingExperiment } from "../lib/research.js";

// Resolve app paths even when Claude launches from the Python repository.
const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(home);
const store = await import("../lib/store.js");
const spaces = await import("../lib/workspaces.js");
const {
  recordInputSchema,
  metricSchema,
  chartSpecSchema,
  fieldDefinitionSchema,
  fieldValueSchema,
  kinds,
} = await import("../lib/schema.js");
const kit = await import("../lib/artifact-kit.js");
const traces = await import("../lib/traces.js");
const { spanInputSchema, traceInputSchema, traceQuerySchema } =
  await import("../lib/schema.js");
const { initializeWorkspace, importRepository } =
  await import("../lib/importer.js");
initializeWorkspace();
const server = new McpServer({ name: "parallax", version: "0.2.0" });
const workspaceId = z
  .string()
  .optional()
  .describe(
    "Workspace ID from list_workspaces. Omit to use PARALLAX_WORKSPACE_ID or the original default workspace. Browser switching does not change the agent's default.",
  );
function result(fn: () => unknown, id?: string) {
  try {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(spaces.runInWorkspace(id, fn), null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Operation failed",
        },
      ],
    };
  }
}
server.registerTool(
  "list_workspaces",
  {
    description:
      "List private workspaces and their IDs. Pass workspaceId on subsequent calls to choose the correct project.",
    inputSchema: {},
  },
  () => result(spaces.listWorkspaces),
);
server.registerTool(
  "create_workspace",
  {
    description:
      "Create an empty private workspace with separate records, files, graph, imports and budget. Optional researchRoot must be an existing absolute folder. Does not import or execute code.",
    inputSchema: spaces.workspaceInputSchema.shape,
  },
  (input) => result(() => spaces.createWorkspace(input)),
);
server.registerTool(
  "search_research",
  {
    description:
      "Search private research by title, tags, full text, provenance and custom field values. Omit query to list all. fields filters by exact custom field values. Imported claims are not verified.",
    inputSchema: {
      workspaceId,
      query: z.string().default(""),
      kind: z.enum(kinds).optional(),
      fields: z.record(z.string(), fieldValueSchema).optional(),
    },
  },
  ({ workspaceId, query, kind, fields }) =>
    result(() => store.listRecords(query, kind, fields), workspaceId),
);
server.registerTool(
  "get_record",
  {
    description:
      "Read a record, linked files, metric chart links and revision history.",
    inputSchema: { workspaceId, id: z.string().uuid() },
  },
  ({ workspaceId, id }) =>
    result(
      () => ({
        record: store.getRecord(id),
        revisions: store.getRevisions(id),
        artifacts: store
          .listArtifacts()
          .filter((a) => a.recordIds.includes(id)),
        chartLinks: store
          .listChartLinks()
          .filter((l) => l.recordId === id || l.experimentId === id),
      }),
      workspaceId,
    ),
);
server.registerTool(
  "create_record",
  {
    description:
      "Save a note, immutable journal, finding, experiment or reference. Use Markdown and link supporting IDs. Never invent results or provenance; mark evidence honestly. Keep sensitive work private. Paid compute needs a separate estimate and explicit human approval. This tool cannot launch jobs.",
    inputSchema: { ...recordInputSchema.shape, workspaceId },
  },
  ({ workspaceId, ...input }) =>
    result(() => store.createRecord(input, "Claude Code"), workspaceId),
);
server.registerTool(
  "update_record",
  {
    description:
      "Replace a record with revision history. Read first and supply its revision to prevent stale edits. Journals are immutable; add a linked correction. An experiment's measured metrics are kept: add points with log_metrics (editing or removing points is done in the app).",
    inputSchema: {
      workspaceId,
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      record: recordInputSchema.omit({ metrics: true }),
    },
  },
  ({ workspaceId, id, revision, record }) =>
    result(
      () => store.updateRecord(id, record, revision, "Claude Code"),
      workspaceId,
    ),
);
server.registerTool(
  "log_metrics",
  {
    description:
      'Append measured metrics to an experiment. Name related series "group/series" (loss/train, loss/val, accuracy/eval) and they share one chart; arrange panels with set_charts. Use unit "%" only for values already in percent. Include real sample sizes (n) and bounds (lower/upper) when available. A name+step that is already stored is rejected, or skipped with onDuplicate "skip" (for re-sent telemetry). Returns counts, not the record. Never log illustrative values as measured results.',
    inputSchema: {
      workspaceId,
      experimentId: z.string().uuid(),
      metrics: z.array(metricSchema).min(1).max(5000),
      onDuplicate: z.enum(["error", "skip"]).default("error"),
    },
  },
  ({ workspaceId, experimentId, metrics, onDuplicate }) =>
    result(
      () => store.appendMetrics(experimentId, metrics, { onDuplicate }),
      workspaceId,
    ),
);
server.registerTool(
  "set_charts",
  {
    description:
      "Arrange an experiment's charts: titled panels that plot chosen metrics together (patterns like \"loss/*\" match a group), as line, bar or scatter, with axis labels, value format, log scale, smoothing and a min/max goal that highlights the best value. Replaces the experiment's panel list; metrics are unchanged. Metrics not in any panel still appear in automatic panels. Panels may be set before metrics are logged.",
    inputSchema: {
      workspaceId,
      experimentId: z.string().uuid(),
      charts: z.array(chartSpecSchema).max(24),
    },
  },
  ({ workspaceId, experimentId, charts }) =>
    result(() => store.setCharts(experimentId, charts), workspaceId),
);
server.registerTool(
  "list_fields",
  {
    description:
      "List this workspace's custom fields: key, label, type, options and which entry kinds use them.",
    inputSchema: { workspaceId },
  },
  ({ workspaceId }) => result(store.getFieldDefinitions, workspaceId),
);
server.registerTool(
  "define_fields",
  {
    description:
      'Replace the workspace\'s custom field definitions (call list_fields first and include the ones to keep). Types: text, number, select (with options), boolean. Records then carry values in record.fields, validated on save, e.g. { judge_model: "opus", pressure_level: 3 }. Removing a definition keeps stored values.',
    inputSchema: {
      workspaceId,
      fields: z.array(fieldDefinitionSchema).max(40),
    },
  },
  ({ workspaceId, fields }) =>
    result(
      () => store.saveFieldDefinitions(fields, "Claude Code"),
      workspaceId,
    ),
);
server.registerTool(
  "get_artifact_kit",
  {
    description:
      "Get the Parallax report kit: how to write a self-contained HTML report (attach_file it) that uses the app's fonts, theme, components and interactive charts, including charts bound live to an experiment's metrics. Returns the class and chart reference plus a starter template.",
    inputSchema: {},
  },
  () => result(() => ({ guide: kit.kitGuide, template: kit.kitTemplate })),
);
server.registerTool(
  "attach_file",
  {
    description:
      "Copy a figure, notebook, CSV, HTML, PDF or Markdown file into private content-addressed storage (max 25 MB). File must be in this workspace's research repository or the Parallax app folder. Link it to several entries with recordIds; recordId remains supported. Never upload secrets or model weights.",
    inputSchema: {
      workspaceId,
      path: z.string(),
      recordId: z.string().uuid().optional(),
      recordIds: z.array(z.string().uuid()).max(50).optional(),
      caption: z.string().max(4000).optional(),
    },
  },
  ({ workspaceId, path: filePath, ...options }) =>
    result(
      () =>
        store.attachLocalFile(filePath, { ...options, actor: "Claude Code" }),
      workspaceId,
    ),
);
server.registerTool(
  "link_artifact",
  {
    description:
      "Set the entries linked to an existing file without copying its bytes. Include all desired recordIds; an empty list detaches it. Supply its current revision from list_artifacts or get_record to protect concurrent edits. Journal content is unchanged.",
    inputSchema: {
      workspaceId,
      artifactId: z.string().uuid(),
      recordIds: z.array(z.string().uuid()).max(50),
      revision: z.number().int().positive(),
    },
  },
  ({ workspaceId, artifactId, recordIds, revision }) =>
    result(
      () =>
        store.updateArtifactLinks(
          artifactId,
          recordIds,
          revision,
          "Claude Code",
        ),
      workspaceId,
    ),
);
server.registerTool(
  "list_artifacts",
  {
    description:
      "List saved figures, notebooks and files with their linked recordIds and revisions.",
    inputSchema: { workspaceId },
  },
  ({ workspaceId }) => result(store.listArtifacts, workspaceId),
);
server.registerTool(
  "link_chart",
  {
    description:
      "Embed a particular measured metric chart from an experiment into a note, journal, finding or other entry. It stays connected to the source metrics and provenance; this link alone does not establish scientific support. Idempotent.",
    inputSchema: { ...store.chartLinkSchema.shape, workspaceId },
  },
  ({ workspaceId, ...input }) =>
    result(() => store.linkChart(input, "Claude Code"), workspaceId),
);
server.registerTool(
  "unlink_chart",
  {
    description:
      "Remove a chart's link to an entry, preserving the source metrics and journal text.",
    inputSchema: { workspaceId, id: z.string().uuid() },
  },
  ({ workspaceId, id }) =>
    result(() => store.unlinkChart(id, "Claude Code"), workspaceId),
);
server.registerTool(
  "log_trace",
  {
    description:
      "Record one LLM trace: a tree of spans (agent steps, model calls, tool calls). Spans link by parentSpanId. A span sent again with the same traceId and spanId replaces the stored one. input/output take text or JSON such as a chat message list [{role, content, tool_calls}]. Give costUsd only when the provider reported it. Use sessionId to group the turns of one conversation and experimentId to tie the trace to an experiment. Shown in the app under Traces.",
    inputSchema: {
      workspaceId,
      ...traceInputSchema.shape,
      spans: z.array(spanInputSchema).min(1).max(2000),
    },
  },
  ({ workspaceId, ...trace }) =>
    result(() => traces.ingestTrace(trace, "Claude Code"), workspaceId),
);
server.registerTool(
  "import_traces",
  {
    description:
      "Import traces from a file in this workspace's research repository (max 25 MB): JSON Lines where each line is a trace ({traceId, sessionId?, experimentId?, spans}) or a single span with traceId, or an OTLP/JSON export ({resourceSpans}). Copy result files back from the cluster first. Returns how many traces and spans were stored and which lines were rejected.",
    inputSchema: { workspaceId, path: z.string() },
  },
  ({ workspaceId, path: filePath }) =>
    result(
      () =>
        traces.importTraceText(
          store.readLocalFile(filePath).buffer.toString("utf8"),
          "Claude Code",
        ),
      workspaceId,
    ),
);
server.registerTool(
  "list_traces",
  {
    description:
      "List traces, newest first: name, time, duration, span count, tokens, reported cost, models, failing flag, session and experiment, with input and answer previews. Filter by text (q), status, model, experimentId, sessionId and time (from/to in epoch ms). Page with limit/offset.",
    inputSchema: {
      workspaceId,
      ...traceQuerySchema.omit({ multi: true }).shape,
    },
  },
  ({ workspaceId, ...query }) =>
    result(() => traces.listTraces(query), workspaceId),
);
const clipText = (text: string | null, max: number) =>
  text !== null && text.length > max
    ? `${text.slice(0, max)}…[${text.length - max} more characters; pass full: true]`
    : text;
server.registerTool(
  "get_trace",
  {
    description:
      "Read one trace with all its spans in start order. Span input and output are cut to 4,000 characters unless full is true.",
    inputSchema: {
      workspaceId,
      traceId: z.string(),
      full: z.boolean().default(false),
    },
  },
  ({ workspaceId, traceId, full }) =>
    result(() => {
      const trace = traces.getTrace(traceId);
      if (full) return trace;
      return {
        ...trace,
        spanList: trace.spanList.map((s) => ({
          ...s,
          input: clipText(s.input, 4000),
          output: clipText(s.output, 4000),
        })),
      };
    }, workspaceId),
);
server.registerTool(
  "list_trace_sessions",
  {
    description:
      "List conversations: traces grouped by sessionId (a trace without one is its own session), with turn count, totals, the first question and the latest answer. multi: true keeps only multi-turn sessions. Read one session's traces with list_traces({sessionId}).",
    inputSchema: { workspaceId, ...traceQuerySchema.shape },
  },
  ({ workspaceId, ...query }) =>
    result(() => traces.listSessions(query), workspaceId),
);
const runs = await import("../lib/runs.js");
const { runEventSchema, runPatchSchema, runQuerySchema } =
  await import("../lib/schema.js");
const { differingKeys, flatten } = await import("../lib/run-dashboard.js");
server.registerTool(
  "log_run_events",
  {
    description:
      'Send run telemetry (W&B-style live training runs, shown under Runs). Events apply in order: start (name, group, tags, config, meta, experimentId; a start on a known run resumes it), log (step + values {"loss/train": 1.2}; null records NaN/Inf), config and summary (merged), heartbeat, finish (status finished/failed/killed). A point sent again for the same run, metric and step replaces the stored one. Training code should use clients/python/parallax_track.py instead; use this tool for numbers read from real result files, never illustrative values.',
    inputSchema: {
      workspaceId,
      events: z.array(runEventSchema).min(1).max(5000),
    },
  },
  ({ workspaceId, events }) =>
    result(() => runs.applyRunEvents(events, "Claude Code"), workspaceId),
);
server.registerTool(
  "import_run_file",
  {
    description:
      "Import a run event log (.jsonl, one event per line, as written by parallax_track in offline mode or on the cluster) from this workspace's research repository. Safe to repeat: points are replaced, not duplicated. Copy the file back from the cluster first. Returns runs, event and point counts, and rejected lines.",
    inputSchema: { workspaceId, path: z.string() },
  },
  ({ workspaceId, path: filePath }) =>
    result(
      () =>
        runs.importRunText(
          store.readLocalFile(filePath).buffer.toString("utf8"),
          "Claude Code",
        ),
      workspaceId,
    ),
);
server.registerTool(
  "list_runs",
  {
    description:
      'List telemetry runs, most recently active first: status (running, finished, failed, killed, or stalled = running but silent for 5 minutes), runtime, last step and a summary (last value of each training metric, overridden by explicit summary values). Filter by text, status, group or experimentId. Runs with ids "demo-…" and the tag "demo" are synthetic demo data, never results.',
    inputSchema: { workspaceId, ...runQuerySchema.shape },
  },
  ({ workspaceId, ...query }) =>
    result(() => runs.listRuns(query), workspaceId),
);
server.registerTool(
  "get_run",
  {
    description:
      "Read one run: config, meta (host, git commit, command, GPUs), status, and per-metric stats (count, last step, last, min, max, NaN/Inf count and first bad step). Pass metrics to also get those series, downsampled to maxPoints (bucket mean with min/max).",
    inputSchema: {
      workspaceId,
      runId: z.string(),
      metrics: z.array(z.string()).max(50).optional(),
      maxPoints: z.number().int().min(10).max(2000).default(200),
    },
  },
  ({ workspaceId, runId, metrics, maxPoints }) =>
    result(
      () => ({
        ...runs.getRun(runId),
        ...(metrics?.length
          ? {
              series: runs.runSeries({
                runs: [runId],
                names: metrics,
                maxPoints,
              }),
            }
          : {}),
      }),
      workspaceId,
    ),
);
server.registerTool(
  "compare_runs",
  {
    description:
      "Compare runs side by side: the config keys that differ, and for each metric (all non-system metrics by default) each run's last, min and max values and step.",
    inputSchema: {
      workspaceId,
      runIds: z.array(z.string()).min(2).max(20),
      metrics: z.array(z.string()).max(100).optional(),
    },
  },
  ({ workspaceId, runIds, metrics }) =>
    result(() => {
      const details = runIds.map((id) => runs.getRun(id));
      const keys = differingKeys(details.map((d) => d.config));
      const names =
        metrics ??
        [
          ...new Set(details.flatMap((d) => d.metrics.map((m) => m.name))),
        ].filter((n) => !n.startsWith("system/"));
      return {
        runs: details.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          runtimeMs: d.runtimeMs,
          config: Object.fromEntries(
            keys.map((k) => [k, flatten(d.config)[k] ?? null]),
          ),
        })),
        metrics: names.map((name) => ({
          name,
          runs: Object.fromEntries(
            details.map((d) => {
              const m = d.metrics.find((x) => x.name === name);
              return [
                d.id,
                m
                  ? {
                      last: m.last,
                      min: m.min,
                      max: m.max,
                      lastStep: m.lastStep,
                      nonFinite: m.nonFinite,
                    }
                  : null,
              ];
            }),
          ),
        })),
      };
    }, workspaceId),
);
server.registerTool(
  "update_run",
  {
    description:
      'Rename a run or change its group, tags, notes or linked experiment (experimentId "" unlinks). Metrics and config are unchanged.',
    inputSchema: { workspaceId, runId: z.string(), ...runPatchSchema.shape },
  },
  ({ workspaceId, runId, ...patch }) =>
    result(() => runs.updateRun(runId, patch, "Claude Code"), workspaceId),
);
server.registerTool(
  "import_repository",
  {
    description:
      "Snapshot README and docs from this workspace's configured repository. Skip unchanged files; create new linked snapshots for changed files. Does not execute code.",
    inputSchema: { workspaceId },
  },
  ({ workspaceId }) => result(importRepository, workspaceId),
);
server.registerTool(
  "workspace_summary",
  {
    description:
      "Get workspace identity, counts, budget settings and recent activity. Recorded costs are not billing-provider totals.",
    inputSchema: { workspaceId },
  },
  ({ workspaceId }) =>
    result(() => {
      const w = store.getWorkspace();
      return {
        workspace: w.info,
        settings: w.settings,
        records: w.records.length,
        artifacts: w.artifacts.length,
        chartLinks: w.chartLinks,
        recordedCostUsd: w.records
          .filter((r) => r.kind === "experiment")
          .reduce((n, r) => n + (r.costUsd || 0), 0),
        activity: w.activity.slice(0, 12),
        researchRoot: w.researchRoot,
      };
    }, workspaceId),
);
server.registerTool(
  "update_task",
  {
    description:
      "Move a Kanban task or set priority, assignee and due date. Supply current revision. Never mark work complete unless actually done.",
    inputSchema: {
      workspaceId,
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      status: z
        .enum(["draft", "planned", "running", "blocked", "completed"])
        .optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      assignee: z.string().optional(),
      dueDate: z.string().optional(),
    },
  },
  ({ workspaceId, id, revision, ...patch }) =>
    result(
      () => store.updateTask(id, patch, revision, "Claude Code"),
      workspaceId,
    ),
);
server.registerTool(
  "link_records",
  {
    description:
      "Add a directed graph edge. Use supports or contradicts only when the source provides evidence for or against the target. Other types: extends, uses, relates.",
    inputSchema: { ...store.relationSchema.shape, workspaceId },
  },
  ({ workspaceId, ...input }) =>
    result(() => store.linkRecords(input, "Claude Code"), workspaceId),
);
server.registerTool(
  "get_knowledge_graph",
  {
    description:
      "Get persistent nodes and typed edges, plus chart and shared-file connections. Record linkedIds are reference edges.",
    inputSchema: { workspaceId },
  },
  ({ workspaceId }) =>
    result(
      () => ({
        nodes: store
          .listRecords()
          .map(({ id, title, kind, tags, evidence, linkedIds }) => ({
            id,
            title,
            kind,
            tags,
            evidence,
            linkedIds,
          })),
        edges: store.listRelations(),
        chartLinks: store.listChartLinks(),
        artifacts: store
          .listArtifacts()
          .map(({ id, name, recordIds }) => ({ id, name, recordIds })),
      }),
      workspaceId,
    ),
);
server.registerTool(
  "session_handoff",
  {
    description:
      "Get active work, blockers, recent journals, unverified findings and draft manuscripts for the next session.",
    inputSchema: { workspaceId },
  },
  ({ workspaceId }) =>
    result(() => {
      const r = store.listRecords(),
        relations = store.listRelations();
      return {
        workspace: spaces.activeWorkspace(),
        activeTasks: r.filter(
          (r) => r.kind === "task" && r.status !== "completed",
        ),
        recentJournals: r.filter((r) => r.kind === "journal").slice(0, 3),
        reviewQueue: r.filter(
          (f) =>
            f.kind === "finding" &&
            (f.evidence === "unverified" ||
              !hasSupportingExperiment(f, r, relations)),
        ),
        papers: r.filter((r) => r.kind === "paper"),
        recentActivity: store.getWorkspace().activity.slice(0, 10),
      };
    }, workspaceId),
);
server.registerResource(
  "research-contract",
  "parallax://research-contract",
  {
    mimeType: "text/plain",
    description: "Research recording rules and privacy expectations.",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: "All data is private and local. Never fabricate results, numbers or citations. Preserve seeds, code commit, dataset revision/hash, configs, exact commands, sample sizes and uncertainty. Paid compute requires a separate cost estimate and explicit human approval. Journals are immutable; add linked corrections. Findings need linked evidence. Imported claims are unverified. This server cannot rent or launch compute. Use list_workspaces and explicitly pass workspaceId for the intended project. Browser workspace switching never changes an agent's default.",
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
