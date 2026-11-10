import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSupportingExperiment } from "../lib/research";
import {
  recordInputSchema,
  type ResearchRecord,
  type Relation,
} from "../lib/schema";

function fixture(kind: ResearchRecord["kind"], id: string): ResearchRecord {
  return {
    ...recordInputSchema.parse({ kind, title: "Test fixture" }),
    id,
    revision: 1,
    author: "Test only",
    createdAt: "",
    updatedAt: "",
  };
}
test("evidence review requires an experiment, not merely an arbitrary link", () => {
  const run = fixture("experiment", "run");
  const note = fixture("note", "note");
  const finding = fixture("finding", "finding");
  const records = [run, note, finding];
  assert.equal(
    hasSupportingExperiment({ ...finding, linkedIds: ["note"] }, records, []),
    false,
  );
  assert.equal(
    hasSupportingExperiment({ ...finding, linkedIds: ["run"] }, records, []),
    true,
  );
});
test("typed evidence links respect relation type and direction", () => {
  const run = fixture("experiment", "run");
  const finding = fixture("finding", "finding");
  const edge: Relation = {
    id: "edge",
    source: run.id,
    target: finding.id,
    type: "supports",
    label: "",
  };
  assert.equal(hasSupportingExperiment(finding, [run, finding], [edge]), true);
  assert.equal(
    hasSupportingExperiment(
      finding,
      [run, finding],
      [{ ...edge, type: "contradicts" }],
    ),
    false,
  );
  assert.equal(
    hasSupportingExperiment(
      finding,
      [run, finding],
      [{ ...edge, source: finding.id, target: run.id }],
    ),
    false,
  );
});
