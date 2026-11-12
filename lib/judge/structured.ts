// JSON Schemas for the judge's structured replies, and the check of what a model returned.
// Tracely compiles these to pydantic models; here the schema goes to the provider as
// `response_format` and `coerce` validates the reply.
export type Json = Record<string, unknown>;
export type Property = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: { type?: string; enum?: string[] };
  /** Not required by the author: the model may return null. */
  optional?: boolean;
};
export type OutputSchema = {
  name: string;
  description?: string;
  properties: Record<string, Property>;
};

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON Schema sent to the provider. Every property is listed as required (strict mode
 *  needs that); an optional one accepts null. */
export function toJsonSchema(schema: OutputSchema): Json {
  const properties: Json = {};
  for (const [name, p] of Object.entries(schema.properties)) {
    const out: Json = { type: p.optional ? [p.type, "null"] : p.type };
    if (p.description) out.description = p.description;
    if (p.enum) out.enum = p.optional ? [...p.enum, null] : p.enum;
    if (p.type === "array") {
      const items: Json = { type: p.items?.type ?? "string" };
      if (p.items?.enum) items.enum = p.items.enum;
      out.items = items;
    }
    properties[name] = out;
  }
  return {
    type: "object",
    properties,
    required: Object.keys(schema.properties),
    additionalProperties: false,
  };
}

/** Strict mode cannot describe a free-form object. */
export const isStrict = (schema: OutputSchema) =>
  Object.values(schema.properties).every((p) => p.type !== "object");

function coerceValue(name: string, p: Property, v: unknown): unknown {
  const fail = (what: string) => {
    throw new Error(`field "${name}" must be ${what}`);
  };
  if (p.enum) {
    if (typeof v !== "string" || !p.enum.includes(v))
      fail(`one of ${p.enum.join(", ")}`);
    return v;
  }
  if (p.type === "string") return typeof v === "string" ? v : fail("a string");
  if (p.type === "number" || p.type === "integer") {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) return fail("a number");
    if (p.type === "integer" && !Number.isInteger(n)) return fail("an integer");
    return n;
  }
  if (p.type === "boolean") {
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "false") return v === "true";
    return fail("true or false");
  }
  if (p.type === "array") {
    if (!Array.isArray(v)) return fail("a list");
    const item: Property = {
      type: (p.items?.type as Property["type"]) ?? "string",
      enum: p.items?.enum,
    };
    return v.map((x) => coerceValue(name, item, x));
  }
  return isObject(v) ? v : fail("an object");
}

/** The reply as the schema's fields, in schema order. Throws when a required field is absent or
 *  a value has the wrong type. An absent optional field is null. */
export function coerce(schema: OutputSchema, reply: unknown): Json {
  if (!isObject(reply))
    throw new Error("the model did not return a JSON object");
  const out: Json = {};
  for (const [name, p] of Object.entries(schema.properties)) {
    const v = reply[name];
    if (v === undefined || v === null) {
      if (!p.optional) throw new Error(`field "${name}" is missing`);
      out[name] = null;
    } else out[name] = coerceValue(name, p, v);
  }
  return out;
}

/** Strict-JSON parse of a model reply. Accepts a ```json fence around the object. */
export function parseJsonObject(text: string): Json {
  const t = (text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    // A model without native structured output may wrap the object in prose.
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start)
      throw new Error("the model did not return JSON");
    parsed = JSON.parse(t.slice(start, end + 1));
  }
  if (!isObject(parsed)) throw new Error("the model returned non-object JSON");
  return parsed;
}

const PRIMITIVES = ["string", "number", "integer", "boolean"];

/** A column's `config.output_schema` (the flat JSON Schema the Add Column builder stores) as an
 *  `OutputSchema`, or null when it cannot be a structured-output contract. Nesting is one level
 *  deep: nested objects stay free-form, arrays type their items. */
export function fromJsonSchema(
  schema: unknown,
  name = "EvaluationOutput",
): OutputSchema | null {
  if (!isObject(schema)) return null;
  if (PRIMITIVES.includes(schema.type as string))
    return {
      name,
      properties: {
        value: {
          type: schema.type as Property["type"],
          description: String(schema.description ?? ""),
        },
      },
    };
  if (schema.type !== "object" || !isObject(schema.properties)) return null;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  const properties: Record<string, Property> = {};
  for (const [field, raw] of Object.entries(schema.properties)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return null;
    const spec = isObject(raw) ? raw : {};
    const p: Property = { type: "string" };
    const type = String(spec.type ?? "string");
    if (Array.isArray(spec.enum) && spec.enum.length)
      p.enum = spec.enum.map(String);
    else if (type === "array") {
      p.type = "array";
      const items = isObject(spec.items) ? spec.items : {};
      p.items =
        Array.isArray(items.enum) && items.enum.length
          ? { type: "string", enum: items.enum.map(String) }
          : {
              type: PRIMITIVES.includes(items.type as string)
                ? (items.type as string)
                : "string",
            };
    } else if (type === "object") p.type = "object";
    else if (PRIMITIVES.includes(type)) p.type = type as Property["type"];
    if (spec.description) p.description = String(spec.description);
    if (!required.has(field)) p.optional = true;
    properties[field] = p;
  }
  return Object.keys(properties).length ? { name, properties } : null;
}
