/** Reference for writing kit reports; shared by MCP and the Settings page. */
export const kitGuide = `Parallax report kit (v1)

Add <meta name="parallax-kit" content="1"> to a self-contained HTML file, then attach_file it.
Parallax inlines its fonts, theme colors (following the viewer's theme), components and chart
renderer when the file is previewed. Write no CSS for these pieces and load nothing external:
the preview sandbox blocks network requests, external scripts, fonts and images.

Layout and components (plain HTML classes):
- .px-page                     centered page container
- .px-header > .px-eyebrow, h1, p.px-lede, .px-meta > .px-badge   report header
- .px-grid (.two)              responsive card grid; .px-card for a panel
- .px-stats > .px-stat > .px-stat-label, .px-stat-value, .px-stat-note   headline numbers;
  .px-delta.up / .px-delta.down inside a note adds ▲/▼
- .px-callout (.note | .warn | .good) with a leading <strong>Label</strong>
- .px-table-wrap > table.px-table   sortable headers; td.num / th.num right-align; tr.best bolds a row
- figure.px-figure > img + figcaption   (images must be data: URIs)
- dl.px-kv                     key/value provenance list; .px-badge(.accent); .px-muted; hr

Charts: a JSON block per chart, rendered in place with hover tooltips, legend toggles,
uncertainty bands/error bars, a per-series summary and a data table.
<script type="application/json" class="px-chart">
{ "title": "Loss", "type": "line", "xLabel": "step", "yLabel": "loss", "goal": "min",
  "smoothing": 0.6, "logY": false, "format": "auto",
  "series": [ { "name": "train", "points": [[0, 2.31], [100, 1.92]] },
              { "name": "val", "points": [ { "x": 100, "y": 2.01, "lower": 1.95, "upper": 2.07, "n": 512 } ] } ] }
</script>
- type: line | bar | scatter. format: auto | percent (0-1 shown as %) | fixed | scientific.
- goal: min | max marks the best point. smoothing: EMA weight for lines (raw stays faint).
- Grouped bars: { "type": "bar", "categories": ["A", "B"], "series": [ { "name": "accuracy", "values": [0.81, 0.77], "lower": [...], "upper": [...] } ] }
- Live data from a recorded experiment in the same workspace, instead of "series":
  "source": { "experiment": "<experiment id>", "panel": "<chart panel title>" }
  or "source": { "experiment": "<experiment id>", "metrics": ["loss/*", "accuracy"] }
  The chart then follows that experiment's logged metrics; spec fields override the panel's.
Up to 8 series are drawn per chart; extra series appear in the table. Never use made-up values.`;

export const kitTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="parallax-kit" content="1">
<title>Report title</title>
</head>
<body>
<main class="px-page">
  <header class="px-header">
    <span class="px-eyebrow">Experiment report</span>
    <h1>Report title</h1>
    <p class="px-lede">One or two sentences: the question and the answer.</p>
    <div class="px-meta"><span class="px-badge accent">status</span><span class="px-badge">model</span><span class="px-badge">seed</span></div>
  </header>

  <section class="px-stats">
    <div class="px-stat"><span class="px-stat-label">Headline metric</span><span class="px-stat-value">—</span><span class="px-stat-note">n = —</span></div>
  </section>

  <script type="application/json" class="px-chart">
  { "title": "Training curves", "source": { "experiment": "EXPERIMENT_ID", "metrics": ["loss/*"] }, "goal": "min", "smoothing": 0.6 }
  </script>

  <div class="px-callout note"><strong>Caveat</strong><p>Limitations and alternative explanations.</p></div>

  <h2>Results</h2>
  <div class="px-table-wrap"><table class="px-table">
    <thead><tr><th>Condition</th><th class="num">Metric</th><th class="num">n</th></tr></thead>
    <tbody><tr><td>—</td><td class="num">—</td><td class="num">—</td></tr></tbody>
  </table></div>
</main>
</body>
</html>
`;
