"use client";
import { Copy, Download, LayoutTemplate } from "lucide-react";
import { kitGuide, kitTemplate } from "@/lib/kit/guide";

/** Settings card: the starter template and reference for kit reports. */
export function ReportKitCard({ copy }: { copy: (value: string) => void }) {
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([kitTemplate], { type: "text/html" }),
    );
    link.download = "parallax-report.html";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <section className="settings-card report-kit-card">
      <div className="settings-title">
        <LayoutTemplate size={19} />
        <h2>Report kit</h2>
        <span className="tag lime">HTML</span>
      </div>
      <p>
        Add <code>&lt;meta name=&quot;parallax-kit&quot;&gt;</code> to a
        self-contained HTML file and attach it. Previews get this app&apos;s
        fonts, your theme, stat tiles, callouts, sortable tables and interactive
        charts, including charts bound live to an experiment&apos;s logged
        metrics. Nothing loads from the network.
      </p>
      <div className="field-actions">
        <button className="button secondary" onClick={() => copy(kitTemplate)}>
          <Copy size={15} />
          Copy starter template
        </button>
        <button className="button secondary" onClick={download}>
          <Download size={15} />
          Download template
        </button>
      </div>
      <details className="kit-guide">
        <summary>Component and chart reference</summary>
        <pre className="config-code">{kitGuide}</pre>
      </details>
      <p className="field-help">
        Claude Code gets the same reference from the get_artifact_kit MCP tool.
      </p>
    </section>
  );
}
