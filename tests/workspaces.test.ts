import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-spaces-test-"));
process.env.PARALLAX_DATA_DIR = path.join(temp, "data");
process.env.PARALLAX_RESEARCH_ROOT = path.join(temp, "research");
mkdirSync(process.env.PARALLAX_RESEARCH_ROOT);
const s = await import("../lib/store");
const w = await import("../lib/workspaces");
const imports = await import("../lib/importer");
const http = await import("../lib/http");
const route = await import("../app/api/artifacts/[id]/route");
const recordsRoute = await import("../app/api/records/route");
const workspaceRoute = await import("../app/api/workspace/route");
const req = (
  url: string,
  options?: NonNullable<ConstructorParameters<typeof NextRequest>[1]>,
) =>
  new NextRequest(`http://127.0.0.1:3000${url}`, {
    ...options,
    headers: { host: "127.0.0.1:3000", ...options?.headers },
  });
after(() => {
  s.closeDatabases();
  w.closeCatalog();
  rmSync(temp, { recursive: true, force: true });
});

test("original data remains in place; new workspaces start empty with separate settings and files", () => {
  const original = s.createRecord({ kind: "note", title: "Fixture: original" });
  const legacy = s.addArtifact(Buffer.from("legacy"), "legacy.txt", {
    recordId: original.id,
  });
  // Simulate a file saved before multi-entry links existed.
  const { recordIds: _ids, revision: _revision, ...oldFile } = legacy;
  s.db()
    .prepare("UPDATE artifacts SET payload = ? WHERE id = ?")
    .run(JSON.stringify(oldFile), legacy.id);
  assert.deepEqual(s.getArtifact(legacy.id).artifact.recordIds, [original.id]);
  const second = w.createWorkspace({ name: "Fixture: alternate project" });
  w.runInWorkspace(second.id, () => {
    imports.initializeWorkspace();
    assert.equal(s.listRecords().length, 0);
    assert.equal(s.listArtifacts().length, 0);
    assert.equal(s.getWorkspace().activity.length, 0);
    assert.equal(s.getSettings().project, second.name);
    s.saveSettings({
      pilotBudget: 125,
      fellowshipBudget: 15000,
      phase: "pilot",
      project: "Second",
    });
    assert.throws(() => s.getRecord(original.id), /not found/);
    assert.throws(() => s.getArtifact(legacy.id), /not found/);
    assert.throws(
      () =>
        s.createRecord({
          kind: "note",
          title: "Foreign link",
          linkedIds: [original.id],
        }),
      /not found/,
    );
    assert.throws(
      () =>
        s.addArtifact(Buffer.from("x"), "x.csv", { recordIds: [original.id] }),
      /not found/,
    );
  });
  assert.equal(s.getSettings().pilotBudget, 500);
  assert.equal(s.getRecord(original.id).title, original.title);
  assert.equal(s.getWorkspace().dataDir, process.env.PARALLAX_DATA_DIR);
  assert.throws(
    () => w.runInWorkspace("../outside", () => s.listRecords()),
    /Workspace not found/,
  );
});

test("concurrent asynchronous HTTP scopes cannot leak selections into each other", async () => {
  const a = w.createWorkspace({ name: "Fixture concurrent A" }),
    b = w.createWorkspace({ name: "Fixture concurrent B" });
  const perform = (id: string, title: string) =>
    http.inWorkspace(req(`/api/records?workspaceId=${id}`), async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const record = s.createRecord({ kind: "note", title });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(w.activeWorkspace().id, id);
      assert.equal(s.listRecords().length, 1);
      return record;
    });
  const [first, second] = await Promise.all([
    perform(a.id, "Fixture A"),
    perform(b.id, "Fixture B"),
  ]);
  assert.notEqual(first.id, second.id);
  assert.equal(w.activeWorkspace().id, "default");
  const response = await recordsRoute.GET(
    req(`/api/records?workspaceId=${a.id}`),
  );
  assert.deepEqual(
    (await response.json()).map((r: { id: string }) => r.id),
    [first.id],
  );
  assert.equal(
    (await recordsRoute.GET(req("/api/records?workspaceId=missing"))).status,
    404,
  );
  const snapshot = await (
    await workspaceRoute.GET(req(`/api/workspace?workspaceId=${b.id}`))
  ).json();
  assert.equal(snapshot.info.id, b.id);
  assert.equal(snapshot.records[0].id, second.id);
});

test("file links are many-to-many, stale-safe and preserve immutable journal text and bytes", () => {
  const note = s.createRecord({ kind: "note", title: "Fixture file note" }),
    journal = s.createRecord({
      kind: "journal",
      title: "Fixture file journal",
      content: "Original text",
    });
  const file = s.addArtifact(Buffer.from("original bytes"), "shared.svg", {
    recordId: note.id,
  });
  const linked = s.updateArtifactLinks(
    file.id,
    [note.id, journal.id, note.id],
    1,
  );
  assert.deepEqual(linked.recordIds, [note.id, journal.id]);
  assert.equal(linked.revision, 2);
  assert.throws(
    () => s.updateArtifactLinks(file.id, [], 1),
    /updated elsewhere/,
  );
  assert.deepEqual(
    s.getArtifact(file.id).buffer,
    Buffer.from("original bytes"),
  );
  assert.equal(s.getRecord(journal.id).revision, 1);
  assert.equal(s.getRecord(journal.id).content, "Original text");
  assert.equal(s.updateArtifactLinks(file.id, [], 2).recordIds.length, 0);
});

test("chart links validate source metrics and targets, remain idempotent, and export with source provenance", () => {
  const experiment = s.createRecord({
    kind: "experiment",
    title: "Fixture chart",
    metrics: [{ name: "fixture_only", step: 0, value: 0.2 }],
    provenance: { seed: 7 },
  });
  const note = s.createRecord({ kind: "note", title: "Fixture chart note" });
  const input = {
    experimentId: experiment.id,
    recordId: note.id,
    metricName: "fixture_only",
  };
  const link = s.linkChart(input);
  assert.deepEqual(s.linkChart(input), link);
  assert.throws(
    () => s.linkChart({ ...input, metricName: "missing" }),
    /measured metric/,
  );
  assert.throws(
    () => s.linkChart({ ...input, recordId: experiment.id }),
    /already part/,
  );
  const other = w.createWorkspace({ name: "Fixture foreign chart" });
  w.runInWorkspace(other.id, () =>
    assert.throws(() => s.linkChart(input), /not found/),
  );
  s.appendMetrics(experiment.id, [
    { name: "fixture_only", step: 1, value: 0.3 },
  ]);
  const backup = s.exportWorkspace();
  assert.ok(backup.chartLinks.some((l) => l.id === link.id));
  assert.equal(
    backup.records.find((r) => r.id === experiment.id)?.metrics.length,
    2,
  );
  assert.equal(
    backup.records.find((r) => r.id === experiment.id)?.provenance.seed,
    7,
  );
  s.unlinkChart(link.id);
  assert.equal(s.listChartLinks().filter((l) => l.id === link.id).length, 0);
  assert.equal(s.getRecord(experiment.id).metrics.length, 2);
});

test("HTML preview preserves full documents and applies an opaque script sandbox with networking blocked", async () => {
  const bytes = Buffer.from(
    `<html><body><div id="result"></div><script>document.getElementById('result').textContent='Interactive fixture';</script>${" ".repeat(510000)}</body></html>`,
  );
  const file = s.addArtifact(bytes, "interactive.html");
  const response = await route.GET(req(`/api/artifacts/${file.id}?preview`), {
    params: Promise.resolve({ id: file.id }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const policy = response.headers.get("content-security-policy") || "";
  assert.match(policy, /sandbox allow-scripts/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.doesNotMatch(policy, /allow-same-origin|unsafe-eval/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  const download = await route.GET(req(`/api/artifacts/${file.id}?download`), {
    params: Promise.resolve({ id: file.id }),
  });
  assert.match(
    download.headers.get("content-disposition") || "",
    /^attachment/,
  );
  const denied = await route.GET(
    req(`/api/artifacts/${file.id}?preview`, { headers: { origin: "null" } }),
    { params: Promise.resolve({ id: file.id }) },
  );
  assert.equal(denied.status, 403);
});

test("the embedding app restricts frame navigations to its own origin", async () => {
  const config = (await import("../next.config")).default;
  const rules = await config.headers!();
  assert.ok(
    rules.some(
      (rule) =>
        rule.source === "/" &&
        rule.headers.some(
          (header) =>
            header.key === "Content-Security-Policy" &&
            header.value === "frame-src 'self'",
        ),
    ),
  );
  assert.ok(
    rules
      .filter((rule) => rule.source === "/:path*")
      .every(
        (rule) =>
          !rule.headers.some((header) =>
            ["Content-Security-Policy", "X-Frame-Options"].includes(header.key),
          ),
      ),
    "Global config must not override the preview Route Handler policies",
  );
});

test("repository imports use the selected workspace folder and deduplicate independently", () => {
  const root = path.join(temp, "another-repository");
  mkdirSync(root);
  writeFileSync(
    path.join(root, "README.md"),
    "# Fixture repository\nOnly for another workspace.",
  );
  const a = w.createWorkspace({ name: "Fixture import A", researchRoot: root }),
    b = w.createWorkspace({ name: "Fixture import B", researchRoot: root });
  for (const id of [a.id, b.id])
    w.runInWorkspace(id, () => {
      assert.equal(imports.importRepository().imported, 1);
      assert.equal(imports.importRepository().imported, 0);
      assert.equal(
        s.listRecords()[0].provenance.repository,
        realpathSync(root),
      );
    });
  assert.equal(s.listRecords("Only for another workspace").length, 0);
});
