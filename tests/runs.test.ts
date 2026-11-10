import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-runs-test-"));
mkdirSync(path.join(temp, "research"));
process.env.PARALLAX_DATA_DIR = path.join(temp, "private-data");
process.env.PARALLAX_RESEARCH_ROOT = path.join(temp, "research");
const store = await import("../lib/store");
const runs = await import("../lib/runs");
const dash = await import("../lib/run-dashboard");
after(() => {
  store.closeDatabases();
  rmSync(temp, { recursive: true, force: true });
});

const t0 = Date.now() - 60_000;
const logs = (run: string, from: number, to: number, name = "loss/train") =>
  Array.from({ length: to - from }, (_, i) => ({
    type: "log" as const,
    run,
    step: from + i,
    time: t0 + (from + i) * 10,
    values: { [name]: 1 / (from + i + 1) },
  }));

test("events create, log, summarize and finish a run", () => {
  const experiment = store.createRecord({
    kind: "experiment",
    title: "Fixture only: runs",
  });
  const r = runs.applyRunEvents([
    {
      type: "start",
      run: "fx-1",
      time: t0,
      name: "fixture sft",
      group: "sweep-a",
      tags: ["fixture"],
      experimentId: experiment.id,
      config: { optim: { lr: 0.001 }, seed: 1 },
      meta: { host: "node-3" },
    },
    ...logs("fx-1", 0, 50),
    {
      type: "log",
      run: "fx-1",
      step: 50,
      time: t0 + 500,
      values: { "loss/train": null, "acc/val": 0.5 },
    },
    { type: "summary", run: "fx-1", values: { best_acc: 0.5 } },
    {
      type: "finish",
      run: "fx-1",
      time: t0 + 600,
      status: "failed",
      exitCode: 1,
    },
  ]);
  assert.deepEqual([r.runs, r.points], [["fx-1"], 52]);
  const run = runs.getRun("fx-1");
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 1);
  assert.equal(run.runtimeMs, 600);
  assert.equal(run.lastStep, 50);
  const loss = run.metrics.find((m) => m.name === "loss/train")!;
  assert.deepEqual(
    [
      loss.count,
      loss.last,
      loss.min,
      loss.max,
      loss.nonFinite,
      loss.firstNonFiniteStep,
    ],
    [51, null, 1 / 50, 1, 1, 50],
  );
  assert.equal(run.summary.best_acc, 0.5);
  assert.equal(run.summary["acc/val"], 0.5);
  assert.deepEqual(run.config, { optim: { lr: 0.001 }, seed: 1 });
  assert.equal(runs.listRuns({ experimentId: experiment.id }).total, 1);
  assert.throws(
    () =>
      runs.applyRunEvents([
        { type: "start", run: "fx-x", experimentId: "nope" },
      ]),
    /not found|not an experiment/,
  );
  assert.throws(() =>
    runs.applyRunEvents([
      { type: "log", run: "bad id!", step: 0, values: { a: 1 } },
    ]),
  );
});

test("resent and out-of-order points replace stored ones; stats recount", () => {
  runs.applyRunEvents([
    { type: "start", run: "fx-2", time: t0 },
    ...logs("fx-2", 0, 10),
  ]);
  runs.applyRunEvents(logs("fx-2", 5, 10)); // resent tail: no duplicates
  runs.applyRunEvents([
    { type: "log", run: "fx-2", step: 3, values: { "loss/train": 9 } },
  ]);
  const loss = runs.getRun("fx-2").metrics[0];
  assert.deepEqual([loss.count, loss.max, loss.lastStep], [10, 9, 9]);
  // A start on a finished run resumes it and merges config.
  runs.applyRunEvents([{ type: "finish", run: "fx-2" }]);
  runs.applyRunEvents([
    { type: "start", run: "fx-2", config: { resumed: true } },
  ]);
  assert.equal(runs.getRun("fx-2").status, "running");
  assert.equal(runs.getRun("fx-2").config.resumed, true);
});

test("a silent running run is stalled; filters and search", () => {
  runs.applyRunEvents([
    { type: "start", run: "fx-old", time: t0 - 3_600_000, group: "sweep-a" },
  ]);
  assert.equal(runs.getRun("fx-old").status, "stalled");
  assert.deepEqual(
    runs.listRuns({ status: "stalled" }).items.map((r) => r.id),
    ["fx-old"],
  );
  assert.deepEqual(
    runs.listRuns({ status: "running" }).items.map((r) => r.id),
    ["fx-2"],
  );
  assert.deepEqual(
    runs
      .listRuns({ group: "sweep-a" })
      .items.map((r) => r.id)
      .sort(),
    ["fx-1", "fx-old"],
  );
  assert.equal(runs.listRuns({ q: "fixture sft" }).total, 1);
  assert.equal(runs.listRuns({ q: "100%_" }).total, 0);
  assert.deepEqual(runs.listRuns().groups, ["sweep-a"]);
});

test("long series are bucketed with min and max kept", () => {
  runs.applyRunEvents([
    { type: "start", run: "fx-long" },
    ...logs("fx-long", 0, 5000),
  ]);
  runs.applyRunEvents([
    { type: "log", run: "fx-long", step: 2500, values: { "loss/train": 100 } },
  ]);
  const [series] = runs.runSeries({ runs: ["fx-long"], maxPoints: 100 });
  assert.equal(series.sampled, true);
  assert.equal(series.total, 5000);
  assert.ok(series.points.length <= 101);
  assert.ok(
    series.points.some((p) => p.max === 100),
    "spike survives",
  );
  const [raw] = runs.runSeries({ runs: ["fx-2"], names: ["loss/train"] });
  assert.equal(raw.sampled, false);
  assert.equal(raw.points.length, 10);
});

test("JSONL import applies good lines and reports bad ones; update and delete", () => {
  const text = [
    JSON.stringify({ type: "start", run: "fx-file", name: "from file" }),
    "not json",
    JSON.stringify({ type: "log", run: "fx-file", step: 0, values: { x: 1 } }),
    JSON.stringify({ type: "log", run: "fx-file", step: 1, values: {} }),
  ].join("\n");
  const r = runs.importRunText(text);
  assert.deepEqual(
    [r.events, r.points, r.rejected.map((x) => x.line)],
    [2, 1, [2, 4]],
  );
  assert.equal(
    runs.updateRun("fx-file", { name: "renamed", tags: ["a"] }).name,
    "renamed",
  );
  runs.deleteRun("fx-file");
  assert.throws(() => runs.getRun("fx-file"), /not found/);
  assert.equal(runs.runSeries({ runs: ["fx-1"] }).length, 2);
});

test("dashboard groups splits, sections and GPUs", () => {
  const panels = dash.buildDashboard([
    "train/loss",
    "val/loss",
    "loss/test",
    "train/lr",
    "eval/accuracy",
    "system/gpu.0.util_pct",
    "system/gpu.1.util_pct",
    "system/cpu.util_pct",
  ]);
  const by = Object.fromEntries(panels.map((p) => [p.key, p]));
  assert.deepEqual(
    by.loss.metrics.map((m) => m.label),
    ["test", "train", "val"],
  );
  assert.equal(by.loss.section, "Loss");
  assert.equal(by.loss.goal, "min");
  assert.equal(by.lr.section, "Optimization");
  assert.equal(by.accuracy.section, "Metrics");
  assert.equal(by["system/gpu.util_pct"].metrics.length, 2);
  assert.equal(by["system/gpu.util_pct"].title, "GPU utilization");
  assert.deepEqual(
    panels.map((p) => p.section),
    ["Loss", "Metrics", "Optimization", "System", "System"],
  );
  assert.deepEqual(
    dash.differingKeys([
      { a: { b: 1 }, c: 2 },
      { a: { b: 2 }, c: 2 },
    ]),
    ["a.b"],
  );
});

test("demo seed loads synthetic, tagged runs and removes only them", () => {
  const loaded = runs.loadDemoRuns();
  assert.equal(loaded.runs.length, 4);
  assert.ok(loaded.runs.every((id) => id.startsWith("demo-")));
  const again = runs.loadDemoRuns(); // replaces, does not stack
  assert.equal(runs.listRuns({ group: "demo-lr-sweep" }).total, 4);
  assert.equal(again.points, loaded.points);
  const demo = runs.listRuns({ group: "demo-lr-sweep" }).items;
  assert.deepEqual(demo.map((r) => r.status).sort(), [
    "failed",
    "finished",
    "finished",
    "stalled",
  ]);
  assert.ok(
    demo.every((r) => r.tags.includes("demo") && r.notes.includes("Synthetic")),
  );
  const others = runs.listRuns().total - 4;
  assert.equal(runs.removeDemoRuns().removed.length, 4);
  assert.equal(runs.listRuns().total, others);
});
