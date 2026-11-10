import { readFileSync } from "node:fs";
import path from "node:path";
import { chartPanels, seriesColors } from "./charts";
import { getRecord } from "./store";
export { kitGuide, kitTemplate } from "./kit/guide";

/** Theme tokens for reports, mirroring app/globals.css and app/themes.css. */
const palettes = {
  moss: {
    bg: "#141613",
    surface: "#1b1e18",
    raised: "#20231d",
    border: "#2d3228",
    text: "#e7e9df",
    muted: "#919889",
    accent: "#d5f69f",
    info: "#94b4d5",
    warn: "#dfa383",
  },
  glacier: {
    bg: "#0d1720",
    surface: "#131f2b",
    raised: "#1a2a38",
    border: "#253744",
    text: "#e5f1f5",
    muted: "#96aebc",
    accent: "#9de5ed",
    info: "#91c9f3",
    warn: "#eab996",
  },
  iris: {
    bg: "#191521",
    surface: "#221c2d",
    raised: "#2c233b",
    border: "#3a2f48",
    text: "#f1e9fa",
    muted: "#b1a0c1",
    accent: "#d6b5ff",
    info: "#a3c6ef",
    warn: "#e9b69b",
  },
  paper: {
    bg: "#f4f1e9",
    surface: "#fcfaf5",
    raised: "#eeeadf",
    border: "#ded9cc",
    text: "#2d352b",
    muted: "#65705e",
    accent: "#49654a",
    info: "#446e89",
    warn: "#95613d",
  },
} as const;
export type KitTheme = keyof typeof palettes;
export const kitThemes = Object.keys(palettes) as KitTheme[];

function tokens(theme: KitTheme) {
  const p = palettes[theme];
  const light = theme === "paper";
  const series = light ? seriesColors.light : seriesColors.dark;
  return `:root{--px-scheme:${light ? "light" : "dark"};--px-bg:${p.bg};--px-surface:${p.surface};--px-raised:${p.raised};--px-border:${p.border};--px-grid:${p.border};--px-text:${p.text};--px-muted:${p.muted};--px-accent:${p.accent};--px-info:${p.info};--px-warn:${p.warn};--px-good:${light ? "#2f7d4a" : "#5fbf85"};${series.map((c, i) => `--px-series-${i + 1}:${c};`).join("")}}`;
}

const cache = new Map<string, string>();
function asset(file: string, encoding: "utf8" | "base64" = "utf8") {
  const key = `${file}:${encoding}`;
  // Cache in production; re-read in development so kit edits apply.
  if (!cache.has(key) || process.env.NODE_ENV !== "production")
    cache.set(
      key,
      readFileSync(
        path.join(/* turbopackIgnore: true */ process.cwd(), file),
      ).toString(encoding),
    );
  return cache.get(key)!;
}

/** The sandbox only allows data: fonts, so the app's typefaces are embedded. */
function fonts() {
  const face = (family: string, file: string, weight: number) =>
    `@font-face{font-family:"${family}";font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${asset(file, "base64")}) format("woff2")}`;
  return [
    ...[400, 600, 700, 800].map((w) =>
      face(
        "Manrope",
        `node_modules/@fontsource/manrope/files/manrope-latin-${w}-normal.woff2`,
        w,
      ),
    ),
    face(
      "IBM Plex Mono",
      "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
      400,
    ),
  ].join("");
}

export const usesKit = (html: string) =>
  /<meta\s[^>]*name\s*=\s*["']?parallax-kit["']?/i.test(html);

/** Read-only metrics for experiments referenced by chart specs in this workspace. */
function referencedExperiments(html: string) {
  const experiments: Record<string, unknown> = {};
  for (const [, id] of html.matchAll(
    /"experiment"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi,
  )) {
    try {
      const record = getRecord(id);
      if (record.kind !== "experiment") continue;
      experiments[id] = {
        title: record.title,
        revision: record.revision,
        metrics: record.metrics,
        panels: chartPanels(record).map(({ auto: _auto, ...panel }) => panel),
      };
    } catch {
      /* Unknown IDs render as "Experiment not found". */
    }
  }
  return experiments;
}

/** Inline JSON safely inside a <script> element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * Add the kit to an opted-in HTML report. Everything is inlined, so the
 * preview's sandbox and content security policy stay unchanged.
 */
export function withArtifactKit(html: string, theme: string | null) {
  if (!usesKit(html)) return html;
  const chosen: KitTheme = kitThemes.includes(theme as KitTheme)
    ? (theme as KitTheme)
    : "moss";
  const head =
    `<style>${tokens(chosen)}${fonts()}${asset("lib/kit/report.css")}${asset("lib/kit/chart.css")}</style>` +
    `<script>window.__PARALLAX_DATA=${scriptJson({ experiments: referencedExperiments(html) })};</script>` +
    `<script>${asset("lib/kit/parallax-kit.js")}</script>`;
  const at = html.match(/<head[^>]*>/i) || html.match(/<html[^>]*>/i);
  if (!at || at.index === undefined) return head + html;
  const end = at.index + at[0].length;
  return html.slice(0, end) + head + html.slice(end);
}
