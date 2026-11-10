"use client";
// The pre-built run dashboard: sections of charts (Loss, Metrics, Optimization, System),
// shared by one run and by a comparison of runs.
import "@/lib/kit/parallax-kit.js";
import { useEffect, useMemo, useRef } from "react";
import { buildDashboard, sections, type RunPanel } from "@/lib/run-dashboard";
import type { RunSeries, RunSummary } from "@/lib/schema";

type Kit = {
  mount: (el: HTMLElement, spec: unknown) => () => void;
};
export type ChartOptions = {
  x: "step" | "time";
  smoothing: number;
  logY: boolean;
  filter: string;
};

function KitChart({ spec }: { spec: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const kit = (window as unknown as { ParallaxKit?: Kit }).ParallaxKit;
    if (!ref.current || !kit) return;
    return kit.mount(ref.current, JSON.parse(spec));
  }, [spec]);
  return <div ref={ref} className="kit-chart" />;
}

/** One chart: every metric of the panel, for every run. System charts always use time. */
function panelSpec(
  panel: RunPanel,
  runs: RunSummary[],
  series: Map<string, RunSeries>,
  options: ChartOptions,
) {
  const useTime = options.x === "time" || panel.section === "System";
  const span = Math.max(...runs.map((r) => r.lastSeenAt - r.startedAt), 1);
  const [unit, scale] =
    span > 3 * 3600_000 ? ["hours", 3600_000] : ["minutes", 60_000];
  const lines = runs.flatMap((run) =>
    panel.metrics.flatMap(({ name, label }) => {
      const s = series.get(JSON.stringify([run.id, name]));
      if (!s) return [];
      return [
        {
          name:
            runs.length === 1
              ? label
              : panel.metrics.length === 1
                ? run.name
                : `${run.name} · ${label}`,
          // NaN/Inf points (value null) are left out; the run page flags them.
          points: s.points
            .filter((p) => p.value !== null)
            .map((p) => ({
              x: useTime ? (p.time - run.startedAt) / scale : p.step,
              y: p.value,
              ...(p.min !== undefined ? { lower: p.min, upper: p.max } : {}),
            })),
        },
      ];
    }),
  );
  const sampled = panel.metrics.some(({ name }) =>
    runs.some((r) => series.get(JSON.stringify([r.id, name]))?.sampled),
  );
  return JSON.stringify({
    title: panel.title,
    description: sampled
      ? "Long series: bucket means, band = bucket min–max"
      : "",
    type: "line",
    xLabel: useTime ? unit : "step",
    yLabel: panel.yLabel,
    logY: options.logY && panel.section !== "System",
    smoothing: panel.section === "System" ? 0 : options.smoothing,
    goal: runs.length === 1 ? panel.goal : "none",
    series: lines,
  });
}

export function RunCharts({
  runs,
  series,
  options,
}: {
  runs: RunSummary[];
  series: RunSeries[];
  options: ChartOptions;
}) {
  const bySeries = useMemo(
    () => new Map(series.map((s) => [JSON.stringify([s.run, s.name]), s])),
    [series],
  );
  const panels = useMemo(() => {
    const filter = options.filter.trim().toLowerCase();
    return buildDashboard(series.map((s) => s.name)).filter(
      (p) =>
        !filter ||
        p.title.toLowerCase().includes(filter) ||
        p.metrics.some((m) => m.name.toLowerCase().includes(filter)),
    );
  }, [series, options.filter]);
  if (!panels.length)
    return (
      <p className="run-muted">
        {series.length
          ? "No chart matches this filter."
          : "No metrics logged yet."}
      </p>
    );
  return (
    <>
      {sections.map((section) => {
        const inSection = panels.filter((p) => p.section === section);
        if (!inSection.length) return null;
        return (
          <section className="run-section" key={section}>
            <h3>
              {section}
              <small>{inSection.length}</small>
            </h3>
            <div className="run-grid">
              {inSection.map((panel) => (
                <div className="metrics-panel" key={panel.key}>
                  <KitChart spec={panelSpec(panel, runs, bySeries, options)} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
