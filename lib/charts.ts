import { chartSpecSchema, type ChartSpec, type ResearchRecord } from "./schema";

type Metric = ResearchRecord["metrics"][number];
export type Series = { name: string; unit: string; points: Metric[] };
export type Panel = ChartSpec & { auto: boolean; series: Series[] };

/** Categorical slots, validated for CVD and contrast on every theme surface. */
export const seriesColors = {
  dark: [
    "#3987e5",
    "#d95926",
    "#199e70",
    "#c98500",
    "#d55181",
    "#008300",
    "#9085e9",
    "#e66767",
  ],
  light: [
    "#2a78d6",
    "#eb6834",
    "#1baf7a",
    "#eda100",
    "#e87ba4",
    "#008300",
    "#6250d6",
    "#e34948",
  ],
};
/** Beyond this, series stay in the table instead of getting a generated hue. */
export const maxSeries = seriesColors.dark.length;

/** "loss/train" belongs to the "loss" group; ungrouped names are their own group. */
export const metricGroup = (name: string) => name.split("/")[0];

export function matchesMetric(pattern: string, name: string) {
  return pattern.endsWith("/*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

function seriesFor(metrics: Metric[], names: string[]): Series[] {
  return names.map((name) => {
    const points = metrics
      .filter((m) => m.name === name)
      .sort((a, b) => a.step - b.step);
    return { name, unit: points[0]?.unit || "", points };
  });
}

/**
 * Explicit panels first, in the order they were defined, then one automatic
 * panel per remaining metric group so nothing measured is hidden.
 */
export function chartPanels(
  record: Pick<ResearchRecord, "metrics" | "charts">,
) {
  const metrics = record.metrics;
  const names = [...new Set(metrics.map((m) => m.name))];
  const covered = new Set<string>();
  const panels: Panel[] = (record.charts || []).map((spec) => {
    const matched = names.filter((n) =>
      spec.metrics.some((p) => matchesMetric(p, n)),
    );
    matched.forEach((n) => covered.add(n));
    return { ...spec, auto: false, series: seriesFor(metrics, matched) };
  });
  const groups = new Map<string, string[]>();
  for (const name of names.filter((n) => !covered.has(n)))
    groups.set(metricGroup(name), [
      ...(groups.get(metricGroup(name)) || []),
      name,
    ]);
  for (const [group, members] of groups) {
    const series = seriesFor(metrics, members);
    const steps = new Set(series.flatMap((s) => s.points.map((p) => p.step)));
    panels.push({
      ...chartSpecSchema.parse({
        title: group,
        metrics: members,
        type: steps.size > 1 ? "line" : "bar",
      }),
      auto: true,
      series,
    });
  }
  return panels;
}

/** A chart link names either a panel title or a single metric. */
export function panelForLink(
  record: Pick<ResearchRecord, "metrics" | "charts">,
  name: string,
): Panel | null {
  const panel = chartPanels(record).find((p) => p.title === name);
  if (panel) return panel;
  if (!record.metrics.some((m) => m.name === name)) return null;
  return {
    ...chartSpecSchema.parse({ title: name, metrics: [name] }),
    auto: true,
    series: seriesFor(record.metrics, [name]),
  };
}

export function smooth(values: number[], weight: number) {
  if (!weight) return values;
  let last = values[0];
  return values.map((v) => (last = last * weight + (1 - weight) * v));
}

export function formatValue(
  value: number,
  format: ChartSpec["format"] = "auto",
  unit = "",
) {
  if (!Number.isFinite(value)) return "—";
  const suffix = unit && unit !== "%" ? ` ${unit}` : unit;
  if (format === "percent") return `${trim(value * 100, 3)}%`;
  if (format === "scientific") return value.toExponential(2) + suffix;
  if (format === "fixed") return value.toFixed(3) + suffix;
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e7))
    return value.toExponential(2) + suffix;
  if (abs >= 1e4)
    return (
      new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value) + suffix
    );
  return trim(value, 4) + suffix;
}
const trim = (value: number, digits: number) =>
  String(Number(value.toPrecision(digits)));

/** Round axis ticks: 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count = 5) {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) || raw;
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 1e-9; t += step)
    ticks.push(Number(t.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** Powers of ten spanning a positive range, for log axes. */
export function logTicks(min: number, max: number) {
  const ticks: number[] = [];
  for (
    let e = Math.floor(Math.log10(min));
    e <= Math.ceil(Math.log10(max));
    e++
  )
    ticks.push(10 ** e);
  return ticks;
}

/** Last, best (by the panel's goal) and point count for one series. */
export function summarize(series: Series, goal: ChartSpec["goal"]) {
  const last = series.points[series.points.length - 1];
  const best =
    goal === "none" || !series.points.length
      ? undefined
      : series.points.reduce((a, b) =>
          goal === "min"
            ? b.value < a.value
              ? b
              : a
            : b.value > a.value
              ? b
              : a,
        );
  return { last, best, count: series.points.length };
}
