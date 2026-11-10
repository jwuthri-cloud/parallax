"use client";
import { useSyncExternalStore } from "react";
import { Check, Palette } from "lucide-react";

export const themes = [
  {
    id: "moss",
    name: "Moss",
    description: "The original observatory",
    colors: ["#141613", "#29371f", "#d5f69f"],
  },
  {
    id: "glacier",
    name: "Glacier",
    description: "Midnight blue · arctic light",
    colors: ["#0d1720", "#203748", "#9de5ed"],
  },
  {
    id: "iris",
    name: "Iris",
    description: "Deep violet · electric lavender",
    colors: ["#191521", "#392d48", "#d6b5ff"],
  },
  {
    id: "paper",
    name: "Paper",
    description: "Warm ivory · quiet focus",
    colors: ["#f4f1e9", "#ded8cb", "#49654a"],
  },
] as const;
function subscribe(callback: () => void) {
  window.addEventListener("parallax-theme", callback);
  const storage = (e: StorageEvent) => {
    if (e.key === "parallax.theme") {
      applyTheme(e.newValue || "moss", false);
      callback();
    }
  };
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener("parallax-theme", callback);
    window.removeEventListener("storage", storage);
  };
}
function applyTheme(id: string, persist = true) {
  const theme = themes.some((t) => t.id === id) ? id : "moss";
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem("parallax.theme", theme);
    } catch {
      /* Theme still works when storage is unavailable. */
    }
  }
  window.dispatchEvent(new Event("parallax-theme"));
}
export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const selected = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme || "moss",
    () => "moss",
  );
  return (
    <div className={compact ? "theme-quick" : "appearance-settings"}>
      {!compact && (
        <>
          <div className="settings-title">
            <Palette size={19} />
            <h2>Make yourself at home</h2>
          </div>
          <p>
            Four atmospheres. One observatory. Your choice follows you across
            workspaces on this browser.
          </p>
        </>
      )}
      {compact && <span className="eyebrow">ATMOSPHERE</span>}
      <div
        className={compact ? "theme-swatches" : "theme-options"}
        role="group"
        aria-label="Color theme"
      >
        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={`theme-option ${selected === theme.id ? "selected" : ""}`}
            aria-label={`${theme.name} theme`}
            aria-pressed={selected === theme.id}
            title={theme.name}
            onClick={() => applyTheme(theme.id)}
          >
            <span
              className="theme-preview"
              style={{
                background: theme.colors[0],
                color: theme.colors[2],
                borderColor: theme.colors[1],
              }}
            >
              <span style={{ background: theme.colors[1] }} />
              <i style={{ background: theme.colors[2] }} />
              {selected === theme.id && <Check size={14} />}
            </span>
            {!compact && (
              <span className="theme-copy">
                <strong>{theme.name}</strong>
                <small>{theme.description}</small>
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
