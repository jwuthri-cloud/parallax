import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-custom-test-"));
mkdirSync(path.join(temp, "research"));
process.env.PARALLAX_DATA_DIR = path.join(temp, "private-data");
process.env.PARALLAX_RESEARCH_ROOT = path.join(temp, "research");
const store = await import("../lib/store");
const charts = await import("../lib/charts");
const kit = await import("../lib/artifact-kit");
after(() => {
  store.closeDatabases();
  rmSync(temp, { recursive: true, force: true });
});

test("custom fields are defined per workspace and validated on save", () => {
  store.saveFieldDefinitions([
    { key: "judge_model", label: "Judge model", type: "text" },
    {
      key: "pressure",
      label: "Pressure",
      type: "select",
      options: ["low", "high"],
    },
    {
      key: "budget_tokens",
      label: "Budget",
      type: "number",
      kinds: ["experiment", "finding"],
    },
  ]);
  assert.equal(store.getWorkspace().fields.length, 3);
  const record = store.createRecord({
    kind: "experiment",
    title: "Fixture: fields",
    fields: {
      judge_model: "fixture-judge",
      pressure: "high",
      budget_tokens: 8,
    },
  });
  assert.deepEqual(record.fields.pressure, "high");
  assert.throws(
    () =>
      store.createRecord({
        kind: "experiment",
        title: "Fixture: bad select",
        fields: { pressure: "medium" },
      }),
    /must be one of: low, high/,
  );
  assert.throws(
    () =>
      store.createRecord({
        kind: "experiment",
        title: "Fixture: bad number",
        fields: { budget_tokens: "eight" },
      }),
    /must be a number/,
  );
  assert.throws(
    () =>
      store.createRecord({
        kind: "note",
        title: "Fixture: wrong kind",
        fields: { judge_model: "x" },
      }),
    /Unknown field "judge_model" for note/,
  );
  assert.throws(
    () =>
      store.saveFieldDefinitions([
        { key: "a", label: "A" },
        { key: "a", label: "Again" },
      ]),
    /unique/,
  );
  assert.throws(
    () =>
      store.saveFieldDefinitions([{ key: "x", label: "X", type: "select" }]),
    /at least one option/,
  );
  // Removing a definition keeps stored values editable and searchable.
  store.saveFieldDefinitions([]);
  const kept = store.updateRecord(
    record.id,
    { ...record, title: "Fixture: fields kept" },
    record.revision,
  );
  assert.equal(kept.fields.judge_model, "fixture-judge");
  assert.equal(store.listRecords("fixture-judge").length, 1);
  assert.equal(
    store.listRecords("", "", { pressure: "high" })[0].id,
    record.id,
  );
  assert.equal(store.listRecords("", "", { pressure: "low" }).length, 0);
});

test("metric groups become panels; explicit panels come first; links accept panels", () => {
  const experiment = store.createRecord({
    kind: "experiment",
    title: "Fixture: curves",
  });
  store.appendMetrics(experiment.id, [
    { name: "loss/train", step: 0, value: 2 },
    { name: "loss/train", step: 10, value: 1 },
    { name: "loss/val", step: 10, value: 1.2, lower: 1.1, upper: 1.3 },
    { name: "accuracy", step: 10, value: 0.7 },
    { name: "refusal_rate", step: 10, value: 0.1 },
  ]);
  const arranged = store.setCharts(experiment.id, [
    { title: "Rates", metrics: ["accuracy", "refusal_rate"], type: "bar" },
  ]);
  assert.equal(arranged.metrics.length, 5);
  const panels = charts.chartPanels(arranged);
  assert.deepEqual(
    panels.map((p) => [p.title, p.auto, p.series.map((s) => s.name)]),
    [
      ["Rates", false, ["accuracy", "refusal_rate"]],
      ["loss", true, ["loss/train", "loss/val"]],
    ],
  );
  assert.equal(panels[1].type, "line");
  const note = store.createRecord({ kind: "note", title: "Fixture: notes" });
  assert.equal(
    store.linkChart({
      experimentId: experiment.id,
      metricName: "loss",
      recordId: note.id,
    }).metricName,
    "loss",
  );
  assert.equal(charts.panelForLink(arranged, "loss/val")?.series.length, 1);
  assert.throws(
    () =>
      store.linkChart({
        experimentId: experiment.id,
        metricName: "missing",
        recordId: note.id,
      }),
    /metric or chart panel/,
  );
  assert.throws(() => store.setCharts(note.id, []), /belong to an experiment/);
  assert.throws(
    () => store.setCharts(experiment.id, [{ title: "Empty", metrics: [] }]),
    /metrics/,
  );
});

test("value formatting and axis ticks", () => {
  assert.equal(charts.formatValue(0.8123, "percent"), "81.2%");
  assert.equal(charts.formatValue(12345678), "1.23e+7");
  assert.equal(charts.formatValue(25000, "auto", "tokens"), "25K tokens");
  assert.equal(charts.formatValue(0.0001234), "1.23e-4");
  assert.deepEqual(charts.niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(charts.smooth([1, 3], 0.5), [1, 2]);
});

test("the report kit is injected only on opt-in, follows the theme and embeds safe data", () => {
  const plain = "<html><head></head><body>plain</body></html>";
  assert.equal(kit.withArtifactKit(plain, "paper"), plain);
  const experiment = store.createRecord({
    kind: "experiment",
    title: "Fixture: </script><b>",
  });
  store.appendMetrics(experiment.id, [{ name: "score", step: 1, value: 0.5 }]);
  const html = `<!doctype html><html><head><meta name="parallax-kit" content="1"></head><body><script type="application/json" class="px-chart">{"source":{"experiment":"${experiment.id}","metrics":["score"]}}</script></body></html>`;
  const out = kit.withArtifactKit(html, "paper");
  assert.ok(out.indexOf("--px-bg:#f4f1e9") > 0);
  assert.ok(out.indexOf("--px-series-1:#2a78d6") > 0);
  assert.ok(out.indexOf("@font-face") > 0);
  assert.ok(out.indexOf("window.ParallaxKit") > 0);
  assert.ok(out.indexOf(experiment.id) > 0);
  // The embedded title cannot close the data script early.
  assert.equal(out.match(/<\/script><b>/g), null);
  assert.ok(out.indexOf("\\u003c/script>\\u003cb>") > 0);
  // Unknown themes fall back to Moss; the head order is preserved.
  assert.ok(kit.withArtifactKit(html, "bogus").includes("--px-bg:#141613"));
  assert.ok(out.startsWith("<!doctype html><html><head><style>"));
});
