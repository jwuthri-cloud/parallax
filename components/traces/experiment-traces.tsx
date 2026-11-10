"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Page, TraceSummary } from "@/lib/schema";
import { useWorkspaceApi } from "../ui";

/** On an experiment page: how many traces it has, with a link to them in the Traces tab. */
export function ExperimentTraces({ experimentId }: { experimentId: string }) {
  const { api } = useWorkspaceApi();
  const [counts, setCounts] = useState<{
    traces: number;
    failing: number;
  } | null>(null);
  useEffect(() => {
    const base = `/api/traces?experimentId=${encodeURIComponent(experimentId)}&limit=1`;
    Promise.all([
      api<Page<TraceSummary>>(base),
      api<Page<TraceSummary>>(`${base}&status=failing`),
    ]).then(
      ([all, failing]) =>
        setCounts({ traces: all.total, failing: failing.total }),
      () => setCounts(null),
    );
  }, [api, experimentId]);
  if (!counts?.traces) return null;
  return (
    <a
      className="experiment-traces"
      href={`#traces?experiment=${encodeURIComponent(experimentId)}`}
    >
      <span className="eyebrow">LLM TRACES</span>
      <span>
        {counts.traces} trace{counts.traces === 1 ? "" : "s"}
        {counts.failing > 0 && <b> · {counts.failing} failing</b>}
      </span>
      <ArrowUpRight size={14} />
    </a>
  );
}
