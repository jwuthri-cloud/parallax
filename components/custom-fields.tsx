"use client";
import { useState } from "react";
import { Check, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { Select } from "./select";
import { useWorkspaceApi, jsonOptions, kindMeta } from "./ui";
import {
  fieldDefinitionsSchema,
  fieldTypes,
  kinds,
  type FieldDefinition,
  type FieldValue,
  type ResearchRecord,
} from "@/lib/schema";

type Values = Record<string, FieldValue>;

/** Inputs for the workspace's custom fields that apply to this kind of entry. */
export function CustomFieldInputs({
  kind,
  definitions,
  values,
  onChange,
}: {
  kind: ResearchRecord["kind"];
  definitions: FieldDefinition[];
  values: Values;
  onChange: (values: Values) => void;
}) {
  const fields = definitions.filter((f) => f.kinds.includes(kind));
  if (!fields.length) return null;
  const set = (key: string, value: FieldValue) =>
    onChange({ ...values, [key]: value });
  return (
    <div className="form-grid three custom-fields">
      {fields.map((field) => {
        const value = values[field.key] ?? null;
        const label = (
          <span>
            {field.label}
            {field.unit && <small> · {field.unit}</small>}
          </span>
        );
        if (field.type === "boolean")
          return (
            <label
              className="checkbox-label"
              key={field.key}
              title={field.description}
            >
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(field.key, e.target.checked)}
              />
              {label}
            </label>
          );
        if (field.type === "select")
          return (
            <label key={field.key} title={field.description}>
              {label}
              <Select
                label={field.label}
                value={typeof value === "string" ? value : ""}
                onValueChange={(v) => set(field.key, v || null)}
                options={[
                  { value: "", label: "Not set" },
                  ...field.options.map((o) => ({ value: o, label: o })),
                ]}
              />
            </label>
          );
        return (
          <label key={field.key} title={field.description}>
            {label}
            <input
              type={field.type === "number" ? "number" : "text"}
              step="any"
              value={value === null ? "" : String(value)}
              onChange={(e) =>
                set(
                  field.key,
                  e.target.value === ""
                    ? null
                    : field.type === "number"
                      ? Number(e.target.value)
                      : e.target.value,
                )
              }
            />
          </label>
        );
      })}
    </div>
  );
}

/** Recorded custom values, including ones whose definition was later removed. */
export function CustomFieldSummary({
  definitions,
  values,
}: {
  definitions: FieldDefinition[];
  values: Values;
}) {
  const entries = Object.entries(values || {}).filter(
    ([, v]) => v !== null && v !== "",
  );
  if (!entries.length) return null;
  const byKey = new Map(definitions.map((f) => [f.key, f]));
  return (
    <dl className="field-summary">
      {entries.map(([key, value]) => {
        const field = byKey.get(key);
        return (
          <div key={key}>
            <dt>{field?.label || key}</dt>
            <dd>
              {typeof value === "boolean"
                ? value
                  ? "Yes"
                  : "No"
                : String(value)}
              {field?.unit && typeof value === "number" ? ` ${field.unit}` : ""}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const blank = (): FieldDefinition => ({
  key: "",
  label: "",
  type: "text",
  options: [],
  kinds: ["experiment"],
  unit: "",
  description: "",
});

/** Settings card: define the workspace's custom fields. */
export function FieldDefinitionsEditor({
  definitions,
  onChange,
  notify,
}: {
  definitions: FieldDefinition[];
  onChange: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const { api } = useWorkspaceApi();
  const [fields, setFields] = useState(definitions);
  const [error, setError] = useState("");
  const update = (i: number, patch: Partial<FieldDefinition>) =>
    setFields((all) => all.map((f, j) => (i === j ? { ...f, ...patch } : f)));
  async function save() {
    setError("");
    try {
      const parsed = fieldDefinitionsSchema.parse(fields);
      await api("/api/fields", jsonOptions("PUT", parsed));
      await onChange();
      notify("Custom fields saved");
    } catch (e) {
      const issues = (
        e as { issues?: { path: PropertyKey[]; message: string }[] }
      ).issues;
      setError(
        issues
          ? issues
              .map((i) => `Field ${Number(i.path[0]) + 1}: ${i.message}`)
              .join("; ")
          : (e as Error).message,
      );
    }
  }
  return (
    <section className="settings-card field-settings">
      <div className="settings-title">
        <SlidersHorizontal size={19} />
        <h2>Custom fields</h2>
      </div>
      <p>
        Add structured fields for this workspace, such as a judge model or a
        pressure level. They appear in the editor for the chosen entry types,
        are searchable, and Claude Code can fill them through MCP.
      </p>
      <div className="field-rows">
        {fields.map((field, i) => (
          <div className="field-row" key={i}>
            <label>
              Label
              <input
                value={field.label}
                placeholder="Judge model"
                onChange={(e) => {
                  const label = e.target.value;
                  const derived = (l: string) =>
                    l
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_+|_+$/g, "")
                      .replace(/^(\d)/, "f_$1")
                      .slice(0, 40);
                  update(i, {
                    label,
                    ...(field.key === "" || field.key === derived(field.label)
                      ? { key: derived(label) }
                      : {}),
                  });
                }}
              />
            </label>
            <label>
              Key
              <input
                className="mono"
                value={field.key}
                placeholder="judge_model"
                onChange={(e) => update(i, { key: e.target.value })}
              />
            </label>
            <label>
              Type
              <Select
                label="Type"
                value={field.type}
                onValueChange={(v) =>
                  update(i, { type: v as FieldDefinition["type"] })
                }
                options={fieldTypes.map((t) => ({ value: t, label: t }))}
              />
            </label>
            {field.type === "select" ? (
              <label className="wide">
                Options · comma-separated
                <input
                  defaultValue={field.options.join(", ")}
                  placeholder="low, medium, high"
                  onBlur={(e) =>
                    update(i, {
                      options: e.target.value
                        .split(",")
                        .map((o) => o.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            ) : field.type === "number" ? (
              <label>
                Unit
                <input
                  value={field.unit}
                  placeholder="tokens"
                  onChange={(e) => update(i, { unit: e.target.value })}
                />
              </label>
            ) : null}
            <fieldset className="field-kinds">
              <legend>Shown on</legend>
              {kinds.map((k) => (
                <label key={k} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={field.kinds.includes(k)}
                    onChange={(e) =>
                      update(i, {
                        kinds: e.target.checked
                          ? [...field.kinds, k]
                          : field.kinds.filter((x) => x !== k),
                      })
                    }
                  />
                  {kindMeta[k].label}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${field.label || "field"}`}
              onClick={() => setFields((all) => all.filter((_, j) => j !== i))}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      <p className="field-help">
        Removing a field keeps values already saved on entries.
      </p>
      <div className="field-actions">
        <button
          type="button"
          className="button secondary"
          onClick={() => setFields((all) => [...all, blank()])}
        >
          <Plus size={15} />
          Add field
        </button>
        <button type="button" className="button primary" onClick={save}>
          <Check size={15} />
          Save fields
        </button>
      </div>
    </section>
  );
}
