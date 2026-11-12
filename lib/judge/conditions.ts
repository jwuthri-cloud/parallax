// Conditional columns: `config.run_if` runs a column only when the results of the columns it
// depends on match. Port of Tracely `domain/evaluation/conditions.py`. Pure.
//
//   run_if = [                                  // every condition must hold (AND)
//     { column: "custom.intent", field: "label",   op: "in", values: ["refund"] },
//     { column: "custom.quality", field: "verdict", op: "in", values: ["FAIL"] },
//     { column: "custom.helpful", field: "value",   op: "lt", value: 0.5 },
//   ]
//
// A dependency with no result for the item makes the condition false.
export type Payload = Record<string, unknown>;
export type RunIfCondition = {
  column: string;
  field: "label" | "verdict" | "value";
  op: "in" | "not_in" | "gte" | "gt" | "lte" | "lt";
  values?: string[];
  value?: number;
};

const FIELDS = ["verdict", "label", "value"];
const SET_OPS = ["in", "not_in"];
const NUM_OPS = ["gte", "gt", "lte", "lt"];
const VERDICTS = ["PASS", "FAIL", "NONE"];
const MAX_CONDITIONS = 5;
const OP_WORDS: Record<string, string> = {
  in: "is",
  not_in: "is not",
  gte: "≥",
  gt: ">",
  lte: "≤",
  lt: "<",
};
const isObject = (v: unknown): v is Payload =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: string[]) => `[${v.join(", ")}]`;

/** The first problem with a `run_if`, or null. */
export function validateRunIf(runIf: unknown): string | null {
  if (runIf === undefined || runIf === null) return null;
  if (!Array.isArray(runIf) || !runIf.length)
    return (
      "run_if must be a non-empty list of conditions, e.g. " +
      '[{"column": "custom.intent", "field": "label", "op": "in", "values": ["refund"]}]'
    );
  if (runIf.length > MAX_CONDITIONS)
    return `run_if takes at most ${MAX_CONDITIONS} conditions`;
  for (const [i, c] of runIf.entries()) {
    const where = `run_if[${i}]`;
    if (!isObject(c) || !String(c.column ?? "").trim())
      return `${where} needs \`column\`: the score_name of the column it reads`;
    const { field, op } = c;
    if (!FIELDS.includes(field as string))
      return `${where}.field must be one of ${list(FIELDS)}`;
    if (field === "value") {
      if (!NUM_OPS.includes(op as string))
        return `${where}: a value condition's op must be one of ${list(NUM_OPS)}`;
      if (typeof c.value !== "number" || !Number.isFinite(c.value))
        return `${where}.value must be a number`;
    } else {
      if (!SET_OPS.includes(op as string))
        return `${where}: a ${field} condition's op must be one of ${list(SET_OPS)}`;
      const values = c.values;
      if (
        !Array.isArray(values) ||
        !values.length ||
        !values.every((x) => typeof x === "string" && x)
      )
        return `${where}.values must be a non-empty list of strings`;
      if (
        field === "verdict" &&
        values.some((v: string) => !VERDICTS.includes(v.toUpperCase()))
      )
        return `${where}.values for a verdict condition are drawn from ${list(VERDICTS)}`;
    }
  }
  return null;
}

/** The score names a `run_if` reads. Each one must run first (`depends_on`). */
export function conditionColumns(runIf: unknown): string[] {
  if (!Array.isArray(runIf)) return [];
  return [
    ...new Set(
      runIf.filter((c) => isObject(c) && c.column).map((c) => String(c.column)),
    ),
  ];
}

/** The labels of a result: a decision column's `label` (a multi-label column's comma-joined
 *  set, split), else the first short string field of a json column. */
function labels(payload: Payload): string[] {
  const label = payload.label;
  if (typeof label === "string" && label)
    return label
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && x !== "none");
  for (const [k, v] of Object.entries(payload))
    if (
      k !== "verdict" &&
      k !== "reason" &&
      typeof v === "string" &&
      v &&
      v.length <= 64
    )
      return [v];
  return [];
}

function one(cond: RunIfCondition, payload: Payload): [boolean, string] {
  if (cond.field === "verdict") {
    const actual = String(payload.verdict || "NONE").toUpperCase();
    const hit = (cond.values ?? []).some((v) => v.toUpperCase() === actual);
    return [cond.op === "in" ? hit : !hit, actual];
  }
  if (cond.field === "label") {
    const got = labels(payload);
    const hit = got.some((l) => (cond.values ?? []).includes(l));
    return [cond.op === "in" ? hit : !hit, got.join(", ") || "none"];
  }
  const v = payload.value ?? payload.score;
  if (typeof v !== "number") return [false, "no value"];
  const t = cond.value as number;
  const ok = { gte: v >= t, gt: v > t, lte: v <= t, lt: v < t }[
    cond.op as "gte" | "gt" | "lte" | "lt"
  ];
  return [ok, String(v)];
}

/** Whether every condition holds against `deps` (`{score_name: payload | payload[]}`), and the
 *  sentence a skipped cell shows. A list of payloads passes when any of them does. */
export function evaluateRunIf(
  runIf: RunIfCondition[] | undefined,
  deps: Record<string, unknown>,
): [boolean, string] {
  if (!runIf?.length) return [true, ""];
  for (const cond of runIf) {
    const raw = deps[cond.column];
    const payloads = (Array.isArray(raw) ? raw : [raw]).filter(isObject);
    if (!payloads.length)
      return [
        false,
        `Not run: \`${cond.column}\` has no result for this item.`,
      ];
    const outcomes = payloads.map((p) => one(cond, p));
    if (!outcomes.some(([ok]) => ok)) {
      const shown =
        cond.field === "value" ? cond.value : (cond.values ?? []).join(", ");
      return [
        false,
        `Not run: ${cond.column} ${cond.field} is ${outcomes[0][1]} ` +
          `(runs when ${cond.field} ${OP_WORDS[cond.op]} ${shown}).`,
      ];
    }
  }
  return [true, ""];
}
