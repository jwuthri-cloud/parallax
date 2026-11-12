"use client";
// The Traces tab: Tracely's trace UI (vendored in ./tracely) inside a Parallax workspace. The
// view lives in the URL hash — #traces?…, #traces/trace/<id>, #traces/session/<id> and its
// lenses #traces/session/<id>/timeline|replay|fleet — so a link reproduces it. "Load demo traces" switches the tab to a temporary demo workspace filled with
// synthetic traces; the real workspace is never written to.
import { useEffect, useMemo, useState } from "react";
import type { ResearchRecord, Workspace } from "@/lib/schema";
import { api, useWorkspaceApi } from "../ui";
import { getFacets, setWorkspace, type AgentRow } from "./tracely/lib/api";
import {
  EvaluatorsPage,
  SessionPage,
  TracePage,
  TracesPage,
} from "./tracely/pages";
import { ExperimentContext } from "./tracely/trace-table/contexts";
import { listHref, type ConvView } from "./tracely/links";

type Route =
  | { kind: "list" | "evaluators" }
  | { kind: "trace"; id: string }
  | { kind: "session"; id: string; view: ConvView };
const demoWorkspace = "demo";
const convViews: ConvView[] = ["table", "timeline", "replay", "fleet"];

export function parseTraceHash(hash: string): Route {
  const [path] = hash.replace(/^#/, "").split("?");
  const [, kind, id, lens] = path.split("/");
  if (kind === "trace" && id) return { kind, id: decodeURIComponent(id) };
  if (kind === "session" && id) {
    const view = convViews.find((v) => v === lens) ?? "table";
    return { kind, id: decodeURIComponent(id), view };
  }
  // The Evaluators page: every judge column and the OpenRouter key.
  if (kind === "evaluators") return { kind };
  return { kind: "list" };
}

export function TracesView({
  records,
  onOpenRecord,
}: {
  records: ResearchRecord[];
  onOpenRecord: (r: ResearchRecord) => void;
}) {
  const { id: workspaceId, url } = useWorkspaceApi();
  const [demo, setDemo] = useState(false);
  const [demoRecords, setDemoRecords] = useState<ResearchRecord[]>([]);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [demoError, setDemoError] = useState("");
  const source = demo ? demoWorkspace : workspaceId;
  // Set before the children render: the vendored Tracely code calls plain fetch helpers.
  useMemo(() => setWorkspace(source), [source]);
  const [route, setRoute] = useState<Route>(() =>
    parseTraceHash(window.location.hash),
  );
  useEffect(() => {
    const sync = () => {
      if (window.location.hash.startsWith("#traces"))
        setRoute(parseTraceHash(window.location.hash));
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const [facets, setFacets] = useState<{
    models: string[];
    experiments: string[];
  }>({
    models: [],
    experiments: [],
  });
  useEffect(() => {
    getFacets().then(setFacets, () => undefined);
  }, [source]);

  const switchTo = (next: boolean) => {
    setDemo(next);
    window.history.replaceState(null, "", listHref());
    setRoute({ kind: "list" });
  };
  const loadDemo = async () => {
    setLoadingDemo(true);
    setDemoError("");
    try {
      await api(`/api/trace-demo`, { method: "POST" });
      const { records } = await api<Workspace>(
        `/api/workspace?workspaceId=${demoWorkspace}`,
      );
      setDemoRecords(records);
      switchTo(true);
    } catch (e) {
      setDemoError((e as Error).message);
    } finally {
      setLoadingDemo(false);
    }
  };

  const experiments = useMemo(
    () =>
      new Map(
        (demo ? demoRecords : records)
          .filter((r) => r.kind === "experiment")
          .map((r) => [r.id, r]),
      ),
    [demo, demoRecords, records],
  );
  // Demo experiments live in the demo workspace, which has no page to open.
  const openExperiment = (record: ResearchRecord) => {
    if (!demo) onOpenRecord(record);
  };
  const experimentLink = (id: string | null | undefined) => {
    const record = id ? experiments.get(id) : undefined;
    if (!record) return null;
    return (
      <button
        className="btn-ghost"
        onClick={() => openExperiment(record)}
        disabled={demo}
        title={demo ? "Demo experiment" : "Open the experiment in Parallax"}
      >
        ⚗ {record.title}
      </button>
    );
  };
  const experimentLinks = {
    title: (id: string) => experiments.get(id)?.title,
    open: (id: string) => {
      const record = experiments.get(id);
      if (record) openExperiment(record);
    },
  };
  const pickerRows = (
    values: string[],
    label: (v: string) => string,
  ): AgentRow[] =>
    values.map((v) => ({ id: v, slug: label(v), display_name: label(v) }));
  const endpoint = `${typeof window === "undefined" ? "" : window.location.origin}${url("/v1/traces")}`;

  return (
    <ExperimentContext.Provider value={experimentLinks}>
      <div className="trc-scope trc-stage">
        {/* Tracely's app shell: a gridded canvas around a 1240px main column. */}
        <div className="bg-grid relative flex min-h-full flex-1 flex-col">
          <main
            key={source}
            className="mx-auto w-full max-w-[1240px] flex-1 px-8 py-8"
          >
            {demo && (
              <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-[13px] text-warn">
                <span>
                  Demo traces: synthetic data in a temporary folder. Nothing is
                  saved in this workspace, and it is gone when the server
                  restarts.
                </span>
                <button className="btn-ghost" onClick={() => switchTo(false)}>
                  Back to your traces
                </button>
              </div>
            )}
            {route.kind === "trace" ? (
              <TracePage
                key={route.id}
                traceId={route.id}
                experimentLink={experimentLink}
              />
            ) : route.kind === "session" ? (
              <SessionPage
                key={route.id}
                threadId={route.id}
                view={route.view}
                experimentLink={experimentLink}
              />
            ) : route.kind === "evaluators" ? (
              <EvaluatorsPage />
            ) : (
              <TracesPage
                models={pickerRows(facets.models, (m) => m)}
                experiments={pickerRows(
                  facets.experiments,
                  (id) => experiments.get(id)?.title ?? id,
                )}
                emptyHint={`No traces yet — ask Claude Code to call log_trace or import_traces, or point an OTLP exporter at ${endpoint} with OTEL_EXPORTER_OTLP_PROTOCOL=http/json. To look around first, use "Load demo traces".`}
                actions={
                  demo ? null : (
                    <>
                      {demoError && (
                        <span className="text-[12px] text-fail">
                          {demoError}
                        </span>
                      )}
                      <button
                        className="btn-ghost"
                        onClick={() => void loadDemo()}
                        disabled={loadingDemo}
                        title="Open synthetic traces in a temporary demo workspace; your workspace is not changed"
                      >
                        {loadingDemo ? "Loading…" : "Load demo traces"}
                      </button>
                    </>
                  )
                }
              />
            )}
          </main>
        </div>
      </div>
    </ExperimentContext.Provider>
  );
}
