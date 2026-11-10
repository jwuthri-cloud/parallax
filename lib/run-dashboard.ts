// The pre-built run dashboard: which metrics share a chart, and in which section.
// Pure functions, shared by the app and tests.

/** Split names: "train/loss", "val/loss" and "loss/val" all chart as "loss". */
const splits = new Set([
  "train",
  "training",
  "val",
  "valid",
  "validation",
  "eval",
  "evaluation",
  "test",
  "dev",
]);
export const sections = ["Loss", "Metrics", "Optimization", "System"] as const;
export type Section = (typeof sections)[number];
export type RunPanel = {
  key: string;
  title: string;
  section: Section;
  /** Metric names in the panel, each with the label it gets in the legend. */
  metrics: { name: string; label: string }[];
  goal: "min" | "max" | "none";
  yLabel: string;
};

const systemTitles: Record<string, [string, string]> = {
  "system/gpu.util_pct": ["GPU utilization", "%"],
  "system/gpu.mem_pct": ["GPU memory used", "%"],
  "system/gpu.mem_gb": ["GPU memory used", "GB"],
  "system/gpu.temp_c": ["GPU temperature", "°C"],
  "system/gpu.power_w": ["GPU power", "W"],
  "system/cpu.util_pct": ["CPU utilization", "%"],
  "system/mem.used_pct": ["System memory used", "%"],
  "system/proc.rss_gb": ["Process memory (RSS)", "GB"],
  "system/disk.used_pct": ["Disk used", "%"],
  "system/net.recv_mbps": ["Network received", "MB/s"],
  "system/net.sent_mbps": ["Network sent", "MB/s"],
};

export function panelFor(name: string): Omit<RunPanel, "metrics"> & {
  label: string;
} {
  if (name.startsWith("system/")) {
    // system/gpu.3.util_pct: one panel for every GPU, one line per GPU.
    const gpu = name.match(/^system\/gpu\.(\d+)\.(.+)$/);
    const key = gpu ? `system/gpu.${gpu[2]}` : name;
    const [title, yLabel] = systemTitles[key] ?? [key.slice(7), ""];
    return {
      key,
      title,
      section: "System",
      goal: "none",
      yLabel,
      label: gpu ? `GPU ${gpu[1]}` : title,
    };
  }
  const parts = name.split("/");
  const kept = parts.filter((p) => !splits.has(p.toLowerCase()));
  const split = parts.find((p) => splits.has(p.toLowerCase()));
  const key = kept.length && kept.length < parts.length ? kept.join("/") : name;
  const leaf = key.toLowerCase();
  const section: Section = /loss|perplexity|\bppl\b|nll/.test(leaf)
    ? "Loss"
    : /(^|[/_.])(lr|learning_rate|grad|grad_norm|gradient|weight_norm|momentum|epoch|throughput|tokens_per_s(ec)?|samples_per_s(ec)?|step_time|it_per_s)/.test(
          leaf,
        )
      ? "Optimization"
      : "Metrics";
  return {
    key,
    title: key,
    section,
    goal: section === "Loss" ? "min" : "none",
    yLabel: "",
    label: split ?? name,
  };
}

/** Group metric names into panels, ordered by section, then by name. */
export function buildDashboard(names: string[]): RunPanel[] {
  const panels = new Map<string, RunPanel>();
  for (const name of [...new Set(names)].sort()) {
    const { label, ...panel } = panelFor(name);
    const existing = panels.get(panel.key);
    if (existing) existing.metrics.push({ name, label });
    else panels.set(panel.key, { ...panel, metrics: [{ name, label }] });
  }
  return [...panels.values()].sort(
    (a, b) =>
      sections.indexOf(a.section) - sections.indexOf(b.section) ||
      a.key.localeCompare(b.key, "en", { numeric: true }),
  );
}

/** {"optim": {"lr": 1e-4}} → {"optim.lr": 1e-4}, for config tables and diffs. */
export function flatten(
  value: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v))
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = v;
  }
  return out;
}

/** Keys whose values are not the same in every config. */
export function differingKeys(configs: Record<string, unknown>[]) {
  const flat = configs.map((c) => flatten(c));
  const keys = [...new Set(flat.flatMap((c) => Object.keys(c)))].sort();
  return keys.filter(
    (k) => new Set(flat.map((c) => JSON.stringify(c[k] ?? null))).size > 1,
  );
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
