import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "parallax-store-test-"));
const research = path.join(temp, "research");
mkdirSync(path.join(research, "docs", "journal"), { recursive: true });
process.env.PARALLAX_DATA_DIR = path.join(temp, "private-data");
process.env.PARALLAX_RESEARCH_ROOT = research;
const store = await import("../lib/store");
const importer = await import("../lib/importer");
after(() => {
  store.closeDatabases();
  rmSync(temp, { recursive: true, force: true });
});

test("revisions survive edits; stale writers cannot overwrite a record", () => {
  const original = store.createRecord({
    kind: "experiment",
    title: "Fixture: baseline",
    provenance: {
      seed: 42,
      commit: "fixture-commit",
      config: "batch_size = 2",
    },
  });
  const revised = store.updateRecord(
    original.id,
    { ...original, title: "Fixture: baseline revised" },
    1,
  );
  assert.equal(revised.revision, 2);
  assert.equal(store.getRevisions(original.id)[1].title, original.title);
  assert.throws(
    () => store.updateRecord(original.id, original, 1),
    /changed elsewhere/,
  );
  assert.equal(store.getRecord(original.id).title, revised.title);
  assert.equal(store.getRecord(original.id).provenance.seed, 42);
});
test("journal content is immutable while pinning preserves historical text", () => {
  const journal = store.createRecord({
    kind: "journal",
    title: "Fixture: journal",
    content: "Original observation.",
  });
  assert.throws(
    () =>
      store.updateRecord(journal.id, { ...journal, content: "Rewritten" }, 1),
    /immutable/,
  );
  const pinned = store.togglePin(journal.id, 1);
  assert.equal(pinned.content, journal.content);
  assert.equal(pinned.pinned, true);
  assert.equal(store.getRevisions(journal.id).length, 2);
});
test("invalid measurements and duplicate metric steps are rejected atomically", () => {
  const run = store.createRecord({
    kind: "experiment",
    title: "Fixture: metrics",
  });
  assert.throws(
    () =>
      store.appendMetrics(run.id, [
        { name: "test", step: 0, value: 1, lower: 2, upper: 1 },
      ]),
    /Lower bound/,
  );
  store.appendMetrics(run.id, [
    { name: "fixture_only", step: 0, value: 0.5, n: 2, lower: 0.1, upper: 0.9 },
  ]);
  assert.throws(
    () =>
      store.appendMetrics(run.id, [
        { name: "fixture_only", step: 1, value: 0.6 },
        { name: "fixture_only", step: 0, value: 0.7 },
      ]),
    /already exists/,
  );
  assert.equal(store.getRecord(run.id).metrics.length, 1);
  assert.throws(
    () => store.appendMetrics(run.id, [{ name: "bad", step: 1, value: NaN }]),
    /number/,
  );
});
const storedPayload = (id: string) =>
  JSON.parse(
    (
      store
        .db()
        .prepare("SELECT payload FROM records WHERE id = ?")
        .get(id) as {
        payload: string;
      }
    ).payload,
  );
test("metrics live in their own table: appends copy no revision, re-sent points can be skipped", () => {
  const run = store.createRecord({
    kind: "experiment",
    title: "Fixture: telemetry",
    metrics: [{ name: "fixture_only/a", step: 0, value: 1 }],
  });
  const revisions = store.getRevisions(run.id).length;
  const first = store.appendMetrics(run.id, [
    { name: "fixture_only/a", step: 1, value: 0.9 },
    { name: "fixture_only/b", step: 1, value: 2 },
  ]);
  assert.deepEqual([first.added, first.skipped, first.total], [2, 0, 3]);
  assert.equal(first.revision, 2);
  assert.equal(store.getRevisions(run.id).length, revisions);
  const again = store.appendMetrics(
    run.id,
    [
      { name: "fixture_only/a", step: 1, value: 0.8 },
      { name: "fixture_only/a", step: 2, value: 0.7 },
    ],
    { onDuplicate: "skip" },
  );
  assert.deepEqual([again.added, again.skipped, again.total], [1, 1, 4]);
  assert.equal(
    store
      .getRecord(run.id)
      .metrics.find((m) => m.name === "fixture_only/a" && m.step === 1)?.value,
    0.9,
  );
  assert.throws(
    () =>
      store.appendMetrics(
        run.id,
        [
          { name: "fixture_only/c", step: 0, value: 1 },
          { name: "fixture_only/c", step: 0, value: 2 },
        ],
        { onDuplicate: "skip" },
      ),
    /twice/,
  );
  assert.deepEqual(storedPayload(run.id).metrics, []);
  assert.equal(
    store
      .getWorkspace()
      .activity.filter(
        (a) => a.recordId === run.id && a.action === "logged metrics for",
      ).length,
    1,
  );
  // An edit from an older read is refused; an edit without `metrics` keeps the points.
  assert.throws(
    () => store.updateRecord(run.id, { kind: "experiment", title: "stale" }, 1),
    /changed elsewhere/,
  );
  const kept = store.updateRecord(
    run.id,
    { kind: "experiment", title: "Fixture: telemetry renamed" },
    again.revision,
  );
  assert.equal(kept.metrics.length, 4);
  assert.equal(store.getRecord(run.id).metrics.length, 4);
  // The app's editor sends `metrics`: they replace the stored points.
  const replaced = store.updateRecord(
    run.id,
    {
      kind: "experiment",
      title: kept.title,
      metrics: [{ name: "fixture_only/a", step: 0, value: 1 }],
    },
    kept.revision,
  );
  assert.equal(store.getRecord(run.id).metrics.length, 1);
  store.deleteRecord(run.id, replaced.revision);
  assert.equal(
    (
      store
        .db()
        .prepare("SELECT count(*) AS n FROM metric_points WHERE record_id = ?")
        .get(run.id) as { n: number }
    ).n,
    0,
  );
});
test("points stored inline by older versions are read, and move to the table on the next write", () => {
  const run = store.createRecord({
    kind: "experiment",
    title: "Fixture: legacy",
  });
  const legacy = {
    ...storedPayload(run.id),
    metrics: [{ name: "fixture_only", step: 0, value: 0.5, unit: "" }],
  };
  store
    .db()
    .prepare("UPDATE records SET payload = ? WHERE id = ?")
    .run(JSON.stringify(legacy), run.id);
  assert.equal(store.getRecord(run.id).metrics.length, 1);
  assert.equal(
    store.listRecords("", "experiment").find((r) => r.id === run.id)?.metrics
      .length,
    1,
  );
  assert.throws(
    () =>
      store.appendMetrics(run.id, [
        { name: "fixture_only", step: 0, value: 0.6 },
      ]),
    /already exists/,
  );
  store.appendMetrics(run.id, [{ name: "fixture_only", step: 1, value: 0.4 }]);
  assert.deepEqual(storedPayload(run.id).metrics, []);
  assert.deepEqual(
    store.getRecord(run.id).metrics.map((m) => [m.step, m.value]),
    [
      [0, 0.5],
      [1, 0.4],
    ],
  );
});
test("artifact bytes and SHA-256 survive round-trip; unsupported files stay out", () => {
  const bytes = Buffer.from("step,value\n0,0.5\n");
  const artifact = store.addArtifact(bytes, "../../fixture.csv");
  assert.equal(artifact.name, "fixture.csv");
  assert.equal(artifact.hash, store.sha256(bytes));
  assert.deepEqual(store.getArtifact(artifact.id).buffer, bytes);
  assert.throws(
    () => store.addArtifact(bytes, "secret.env"),
    /Unsupported format/,
  );
  assert.throws(
    () => store.addArtifact(Buffer.alloc(0), "empty.txt"),
    /nonempty/,
  );
  assert.throws(
    () =>
      store.addArtifact(bytes, "test.csv", {
        recordId: "00000000-0000-4000-8000-000000000000",
      }),
    /not found/,
  );
});
test("local imports reject files and symlinks outside configured roots", () => {
  const outside = path.join(temp, "outside.txt");
  writeFileSync(outside, "not allowed");
  const link = path.join(research, "link.txt");
  symlinkSync(outside, link);
  assert.throws(() => store.attachLocalFile(outside), /inside the research/);
  assert.throws(() => store.attachLocalFile(link), /inside the research/);
  const inside = path.join(research, "allowed.csv");
  writeFileSync(inside, "a,b\n");
  assert.equal(store.attachLocalFile(inside).name, "allowed.csv");
});
test("directed graph edges are persistent, idempotent, and validate targets", () => {
  const a = store.createRecord({
    kind: "experiment",
    title: "Fixture: graph source",
  });
  const b = store.createRecord({
    kind: "finding",
    title: "Fixture: graph target",
  });
  const edge = store.linkRecords({
    source: a.id,
    target: b.id,
    type: "supports",
  });
  assert.deepEqual(
    store.linkRecords({ source: a.id, target: b.id, type: "supports" }),
    edge,
  );
  assert.equal(store.listRelations().filter((e) => e.id === edge.id).length, 1);
  assert.throws(
    () => store.linkRecords({ source: a.id, target: a.id, type: "relates" }),
    /different/,
  );
});
test("Kanban updates retain unrelated task content and protect stale revisions", () => {
  const task = store.createRecord({
    kind: "task",
    title: "Fixture: task",
    content: "Acceptance criteria",
    status: "planned",
  });
  const moved = store.updateTask(
    task.id,
    { status: "running", assignee: "Agent" },
    1,
  );
  assert.equal(moved.content, task.content);
  assert.equal(moved.status, "running");
  assert.equal(moved.assignee, "Agent");
  assert.throws(
    () => store.updateTask(task.id, { status: "completed" }, 1),
    /changed elsewhere/,
  );
});
test("repository import is idempotent; changed journal sources create linked snapshots", () => {
  writeFileSync(
    path.join(research, "README.md"),
    "# Fixture project\nUnverified source.",
  );
  const journalPath = path.join(research, "docs/journal/2026-10-13.md");
  writeFileSync(journalPath, "# 2026-10-13\nFirst source snapshot.");
  assert.equal(importer.importRepository().imported, 2);
  assert.equal(importer.importRepository().imported, 0);
  const prior = store.listRecords("First source snapshot")[0];
  assert.equal(prior.kind, "journal");
  assert.equal(prior.evidence, "unverified");
  assert.ok(prior.provenance.sourceHash);
  assert.equal(prior.linkedIds.length, 1);
  writeFileSync(journalPath, "# 2026-10-13\nChanged source snapshot.");
  assert.equal(importer.importRepository().imported, 1);
  const next = store.listRecords("Changed source snapshot")[0];
  assert.ok(next.linkedIds.includes(prior.id));
  assert.match(store.getRecord(prior.id).content, /First source/);
});
test("full export includes file bytes, all revisions, graph edges and audit trail", () => {
  const exported = store.exportWorkspace();
  assert.equal(exported.format, "parallax.v2");
  assert.ok(exported.revisions.length > 0);
  assert.ok(exported.relations.length > 0);
  assert.ok(exported.activity.length >= exported.records.length);
  for (const artifact of exported.artifacts)
    assert.equal(
      store.sha256(Buffer.from(artifact.base64, "base64")),
      artifact.hash,
    );
  assert.equal(statSync(store.dataDir).mode & 0o777, 0o700);
});

test("document figure placement links evidence atomically and retains its history", () => {
  const file = store.addArtifact(
    Buffer.from("fixture"),
    "document-fixture.png",
  );
  const url = `/api/artifacts/${file.id}?workspaceId=default`;
  const note = store.createRecord({
    kind: "note",
    title: "Figure placement",
    content: `![Local figure](${url})`,
  });
  assert.deepEqual(store.getArtifact(file.id).artifact.recordIds, [note.id]);
  assert.equal(store.getArtifact(file.id).artifact.revision, 2);
  const revision = store.updateRecord(
    note.id,
    {
      ...note,
      content: "Figure removed from the page, preserved in evidence history.",
    },
    1,
  );
  assert.deepEqual(store.getArtifact(file.id).artifact.recordIds, [note.id]);
  assert.equal(store.getArtifact(file.id).artifact.revision, 2);
  assert.match(store.getRevisions(note.id)[1].content, /Local figure/);
  assert.equal(revision.revision, 2);
  const count = store.listRecords().length;
  assert.throws(
    () =>
      store.createRecord({
        kind: "note",
        title: "Invalid foreign image",
        content: `![Foreign](/api/artifacts/${file.id}?workspaceId=11111111-1111-4111-8111-111111111111)`,
      }),
    /this workspace/,
  );
  assert.equal(store.listRecords().length, count);
  const unlinked = store.addArtifact(
    Buffer.from("another fixture"),
    "example.png",
  );
  store.createRecord({
    kind: "note",
    title: "Code example only",
    content: `\`![Example](/api/artifacts/${unlinked.id}?workspaceId=default)\``,
  });
  assert.deepEqual(store.getArtifact(unlinked.id).artifact.recordIds, []);
});
test("deleting a record removes its links, keeps history, and spares journals", () => {
  const paper = store.createRecord({ kind: "paper", title: "Fixture: doomed" });
  const note = store.createRecord({
    kind: "note",
    title: "Fixture: cites paper",
    linkedIds: [paper.id],
  });
  const exp = store.createRecord({ kind: "experiment", title: "Fixture: exp" });
  store.linkRecords({ source: exp.id, target: paper.id, type: "supports" });
  const file = store.addArtifact(Buffer.from("x"), "fixture.txt", {
    recordIds: [paper.id, note.id],
  });
  assert.throws(() => store.deleteRecord(paper.id, 0), /changed/);
  store.deleteRecord(paper.id, 1);
  assert.throws(() => store.getRecord(paper.id), /not found/);
  assert.deepEqual(store.getRecord(note.id).linkedIds, []);
  assert.deepEqual(store.getArtifact(file.id).artifact.recordIds, [note.id]);
  assert.ok(!store.listRelations().some((e) => e.target === paper.id));
  assert.ok(
    store
      .exportWorkspace()
      .revisions.some((r: { id: string }) => r.id === paper.id),
  );
  store.updateRecord(note.id, store.getRecord(note.id), 2);

  const kept = store.createRecord({ kind: "paper", title: "Fixture: cited" });
  const journal = store.createRecord({
    kind: "journal",
    title: "Fixture: log",
    linkedIds: [kept.id],
  });
  assert.throws(() => store.deleteRecord(kept.id, 1), /journal/);
  assert.throws(() => store.deleteRecord(journal.id, 1), /immutable/);
});
