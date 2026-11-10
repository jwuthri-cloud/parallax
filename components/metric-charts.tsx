"use client";
import "@/lib/kit/parallax-kit.js";
import { useEffect, useRef } from "react";
import { Link2 } from "lucide-react";
import { chartPanels, panelForLink, type Panel } from "@/lib/charts";
import type { ResearchRecord } from "@/lib/schema";

type Kit = {
  mount: (el: HTMLElement, spec: unknown, data?: unknown) => () => void;
};

/** Draws one panel with the same renderer HTML reports use. */
function KitChart({ panel }: { panel: Panel }) {
  const ref = useRef<HTMLDivElement>(null);
  const spec = JSON.stringify({
    ...panel,
    series: panel.series.map((s) => ({
      name: s.name,
      unit: s.unit,
      points: s.points,
    })),
  });
  useEffect(() => {
    const kit = (window as unknown as { ParallaxKit?: Kit }).ParallaxKit;
    if (!ref.current || !kit) return;
    return kit.mount(ref.current, JSON.parse(spec));
  }, [spec]);
  return <div ref={ref} className="kit-chart" />;
}

function EmptyMetrics() {
  return (
    <div className="metrics-empty">
      <div className="empty-chart-lines">
        <i />
        <i />
        <i />
      </div>
      <span>No measured metrics yet</span>
      <small>Log a real result to bring this chart to life.</small>
    </div>
  );
}

export function ExperimentCharts({
  record,
  onLink,
}: {
  record: ResearchRecord;
  onLink?: (name: string) => void;
}) {
  const panels = chartPanels(record);
  if (!record.metrics.length && !panels.length) return <EmptyMetrics />;
  const points = record.metrics.length;
  return (
    <section className="metrics-board">
      <div className="chart-heading">
        <span className="eyebrow">MEASURED SIGNAL</span>
        <small>
          {panels.length} chart{panels.length === 1 ? "" : "s"} · {points}{" "}
          measurement{points === 1 ? "" : "s"}
        </small>
      </div>
      <div className={`metrics-grid ${panels.length > 1 ? "two" : ""}`}>
        {panels.map((panel) => (
          <div className="metrics-panel" key={panel.title}>
            <KitChart panel={panel} />
            {onLink && panel.series.some((s) => s.points.length) && (
              <button
                className="button secondary compact"
                onClick={() => onLink(panel.title)}
              >
                <Link2 size={13} />
                Link chart
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** A chart linked into another entry: a whole panel or a single metric. */
export function LinkedChart({
  record,
  name,
}: {
  record: ResearchRecord;
  name: string;
}) {
  const panel = panelForLink(record, name);
  if (!panel) return <EmptyMetrics />;
  return (
    <div className="metrics-panel">
      <KitChart panel={panel} />
    </div>
  );
}
