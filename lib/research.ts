import type { ResearchRecord, Relation } from "./schema";

/** Evidence coverage, not a claim that a measurement has been verified. */
export function hasSupportingExperiment(
  finding: ResearchRecord,
  records: ResearchRecord[],
  relations: Relation[],
) {
  const experiments = new Set(
    records.filter((r) => r.kind === "experiment").map((r) => r.id),
  );
  return (
    finding.linkedIds.some((id) => experiments.has(id)) ||
    relations.some(
      (edge) =>
        edge.type === "supports" &&
        edge.target === finding.id &&
        experiments.has(edge.source),
    )
  );
}
