import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("real MCP stdio client: tools, records, metrics, tasks, graph, attachments and handoff", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-mcp-test-"));
  const repo = path.join(temp, "research");
  mkdirSync(repo);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/server.ts"],
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      OPENROUTER_API_KEY: "", // the judge stays off: no call can leave this test
      PARALLAX_DATA_DIR: path.join(temp, "data"),
      PARALLAX_RESEARCH_ROOT: repo,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "parallax-verification",
    version: "1.0.0",
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(
      (result.content as { type: string; text: string }[])[0].text,
    );
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 38);
    const experiment = await call("create_record", {
      kind: "experiment",
      title: "Fixture only: MCP baseline",
      provenance: { seed: 123, commit: "test-only" },
    });
    const metrics = await call("log_metrics", {
      experimentId: experiment.id,
      metrics: [{ name: "fixture_only", step: 0, value: 0.25, n: 4 }],
    });
    assert.deepEqual(
      [metrics.added, metrics.skipped, metrics.total],
      [1, 0, 1],
    );
    const logged = await call("get_record", { id: experiment.id });
    assert.equal(logged.record.metrics[0].n, 4);
    await call("log_trace", {
      traceId: "fixture-trace",
      experimentId: experiment.id,
      spans: [
        {
          spanId: "root",
          name: "Fixture agent",
          type: "agent",
          start: 0,
          end: 10,
        },
        {
          spanId: "llm",
          parentSpanId: "root",
          name: "chat",
          type: "generation",
          start: 1,
          end: 9,
          output: "x".repeat(5000),
        },
      ],
    });
    const listed = await call("list_traces", { experimentId: experiment.id });
    assert.equal(listed.total, 1);
    const trace = await call("get_trace", { traceId: "fixture-trace" });
    assert.match(trace.spanList[1].output, /more characters; pass full: true/);
    const traceFile = path.join(repo, "fixture-traces.jsonl");
    writeFileSync(
      traceFile,
      JSON.stringify({
        traceId: "fixture-2",
        spanId: "a",
        name: "imported",
        start: 0,
      }) + "\n",
    );
    const imported = await call("import_traces", { path: traceFile });
    assert.deepEqual(
      [imported.traces, imported.spans, imported.rejected],
      [1, 1, []],
    );
    assert.equal((await call("list_trace_sessions")).total, 2);
    // Judge columns: created and read here; a run is started by the user in the app only.
    assert.ok(!tools.tools.some((t) => /run_eval/.test(t.name)));
    assert.equal((await call("list_evaluator_templates")).length, 18);
    const column = await call("create_evaluator", {
      name: "Fixture judge",
      level: "AGENT_RUN",
      config: {
        prompt: "Grade @CURRENT_MESSAGE.output",
        model: "openai/gpt-6-luna",
      },
    });
    assert.deepEqual(
      [column.score_name, column.config.is_advanced, column.enabled],
      ["custom.fixture_judge", true, true],
    );
    const paused = await call("update_evaluator", {
      id: column.id,
      enabled: false,
    });
    assert.equal(paused.enabled, false);
    const columns = await call("list_evaluators");
    assert.equal(columns.evaluators.length, 1);
    assert.equal(columns.openrouterKeyConfigured, false);
    const rejected = await client.callTool({
      name: "create_evaluator",
      arguments: { name: "x", config: { output_type: "decision_binary" } },
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /question is required/);
    assert.deepEqual(await call("list_scores", { traceId: "fixture-trace" }), {
      traceId: "fixture-trace",
      verdict: null,
      scores: [],
    });
    const sent = await call("log_run_events", {
      events: [
        {
          type: "start",
          run: "fx-mcp-a",
          name: "fixture a",
          config: { lr: 0.1 },
          experimentId: experiment.id,
        },
        { type: "log", run: "fx-mcp-a", step: 0, values: { "loss/train": 2 } },
        { type: "log", run: "fx-mcp-a", step: 1, values: { "loss/train": 1 } },
        { type: "start", run: "fx-mcp-b", config: { lr: 0.2 } },
        { type: "log", run: "fx-mcp-b", step: 0, values: { "loss/train": 3 } },
        { type: "finish", run: "fx-mcp-b", status: "failed" },
      ],
    });
    assert.deepEqual([sent.runs.length, sent.points], [2, 3]);
    assert.equal((await call("list_runs", { status: "failed" })).total, 1);
    const run = await call("get_run", {
      runId: "fx-mcp-a",
      metrics: ["loss/train"],
    });
    assert.equal(run.metrics[0].min, 1);
    assert.equal(run.series[0].points.length, 2);
    const compared = await call("compare_runs", {
      runIds: ["fx-mcp-a", "fx-mcp-b"],
    });
    assert.deepEqual(
      compared.runs.map((r: { config: object }) => r.config),
      [{ lr: 0.1 }, { lr: 0.2 }],
    );
    assert.equal(compared.metrics[0].runs["fx-mcp-b"].last, 3);
    writeFileSync(
      path.join(repo, "run.jsonl"),
      JSON.stringify({
        type: "log",
        run: "fx-mcp-a",
        step: 2,
        values: { "loss/train": 0.5 },
      }) + "\n",
    );
    assert.equal(
      (await call("import_run_file", { path: path.join(repo, "run.jsonl") }))
        .points,
      1,
    );
    assert.equal(
      (await call("update_run", { runId: "fx-mcp-a", tags: ["fixture"] }))
        .tags[0],
      "fixture",
    );
    const finding = await call("create_record", {
      kind: "finding",
      title: "Fixture only: observation",
      linkedIds: [experiment.id],
    });
    await call("link_records", {
      source: experiment.id,
      target: finding.id,
      type: "supports",
    });
    const graph = await call("get_knowledge_graph");
    assert.ok(
      graph.edges.some((e: { target: string }) => e.target === finding.id),
    );
    const task = await call("create_record", {
      kind: "task",
      title: "Fixture only: task",
      status: "planned",
    });
    const moved = await call("update_task", {
      id: task.id,
      revision: task.revision,
      status: "running",
    });
    assert.equal(moved.status, "running");
    const file = path.join(repo, "fixture.csv");
    writeFileSync(file, "x,y\n1,2\n");
    const artifact = await call("attach_file", {
      path: file,
      recordId: experiment.id,
    });
    assert.equal(artifact.name, "fixture.csv");
    const linkedFile = await call("link_artifact", {
      artifactId: artifact.id,
      recordIds: [experiment.id, finding.id],
      revision: artifact.revision,
    });
    assert.equal(linkedFile.recordIds.length, 2);
    assert.equal(
      (await call("get_record", { id: finding.id })).artifacts.length,
      1,
    );
    const chart = await call("link_chart", {
      experimentId: experiment.id,
      metricName: "fixture_only",
      recordId: finding.id,
    });
    assert.equal(
      (await call("get_record", { id: finding.id })).chartLinks.length,
      1,
    );
    await call("unlink_chart", { id: chart.id });
    const second = await call("create_workspace", {
      name: "Fixture second project",
    });
    assert.equal((await call("list_workspaces")).length, 2);
    assert.equal(
      (await call("search_research", { workspaceId: second.id })).length,
      0,
    );
    const privateNote = await call("create_record", {
      workspaceId: second.id,
      kind: "note",
      title: "Fixture: isolated",
    });
    assert.equal(
      (await call("workspace_summary", { workspaceId: second.id })).records,
      1,
    );
    assert.equal(
      (await call("search_research", { query: "isolated" })).length,
      0,
    );
    const foreign = await client.callTool({
      name: "get_record",
      arguments: { workspaceId: second.id, id: experiment.id },
    });
    assert.equal(foreign.isError, true);
    assert.equal(
      (await call("get_record", { workspaceId: second.id, id: privateNote.id }))
        .record.id,
      privateNote.id,
    );
    const record = await call("get_record", { id: experiment.id });
    assert.equal(record.artifacts.length, 1);
    assert.equal(record.revisions.length, 1); // log_metrics writes no revision copy
    assert.equal(record.record.revision, 2); // ...but bumps the revision
    const found = await call("search_research", { query: "MCP baseline" });
    assert.equal(found.length, 1);
    const handoff = await call("session_handoff");
    assert.ok(
      handoff.activeTasks.some((r: { id: string }) => r.id === task.id),
    );
    const invalid = await client.callTool({
      name: "update_task",
      arguments: { id: task.id, revision: 1, status: "completed" },
    });
    assert.equal(invalid.isError, true);
    const resource = await client.readResource({
      uri: "parallax://research-contract",
    });
    const contract = resource.contents[0];
    assert.ok("text" in contract);
    assert.match(contract.text, /Never fabricate/);
  } finally {
    await client.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
