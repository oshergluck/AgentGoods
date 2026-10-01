/**
 * A safe subset of JSON Schema for service inputs and outputs.
 *
 * Schemas here are written by sellers, so the validator is a plain interpreter: no code generation,
 * no regular expressions (a seller `pattern` is a ReDoS waiting for a buyer's input), bounded depth
 * and size. What it supports is what a machine caller needs to know how to call a service:
 *
 *   type (string | number | integer | boolean | object | array | null, or a list of them),
 *   properties, required, additionalProperties (boolean), items, enum, const,
 *   minimum, maximum, minLength, maxLength, minItems, maxItems, description, title, default, examples
 *
 * Anything else is refused at listing time, by name, so a seller never believes a constraint is
 * enforced when it is not.
 */

export const MAX_SCHEMA_BYTES = 8_192;
const MAX_DEPTH = 8;
const MAX_ERRORS = 10;

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "description",
  "title",
  "default",
  "examples",
  "$schema",
]);

export type JsonSchema = Record<string, unknown>;

/** Problems with a schema itself; empty when the schema is usable. */
export function checkSchema(schema: unknown, at = "$"): string[] {
  const problems: string[] = [];
  if (at === "$") {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(schema) ?? "", "utf8");
    } catch {
      return ["$: the schema is not JSON"];
    }
    if (size > MAX_SCHEMA_BYTES) return [`$: the schema is ${size} bytes; the limit is ${MAX_SCHEMA_BYTES}`];
  }
  const walk = (node: unknown, path: string, depth: number) => {
    if (problems.length >= MAX_ERRORS) return;
    if (depth > MAX_DEPTH) {
      problems.push(`${path}: nested deeper than ${MAX_DEPTH} levels`);
      return;
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      problems.push(`${path}: a schema must be an object`);
      return;
    }
    const s = node as JsonSchema;
    for (const key of Object.keys(s)) {
      if (!KEYWORDS.has(key)) problems.push(`${path}.${key}: not supported (supported: ${[...KEYWORDS].join(", ")})`);
    }
    if (s.type !== undefined) {
      const list = Array.isArray(s.type) ? s.type : [s.type];
      if (list.length === 0 || !list.every((t) => typeof t === "string" && TYPES.has(t))) {
        problems.push(`${path}.type: must be one of ${[...TYPES].join(", ")} or a list of them`);
      }
    }
    for (const k of ["minimum", "maximum"]) {
      if (s[k] !== undefined && typeof s[k] !== "number") problems.push(`${path}.${k}: must be a number`);
    }
    for (const k of ["minLength", "maxLength", "minItems", "maxItems"]) {
      if (s[k] !== undefined && !(Number.isInteger(s[k]) && (s[k] as number) >= 0)) problems.push(`${path}.${k}: must be a whole number`);
    }
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.length > 100)) {
      problems.push(`${path}.enum: must be a list of 1-100 values`);
    }
    if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every((r) => typeof r === "string"))) {
      problems.push(`${path}.required: must be a list of property names`);
    }
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") {
      problems.push(`${path}.additionalProperties: only true or false is supported`);
    }
    if (s.properties !== undefined) {
      if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) {
        problems.push(`${path}.properties: must be an object of schemas`);
      } else {
        for (const [name, sub] of Object.entries(s.properties as Record<string, unknown>)) walk(sub, `${path}.properties.${name}`, depth + 1);
      }
    }
    if (s.items !== undefined) walk(s.items, `${path}.items`, depth + 1);
  };
  walk(schema, at, 0);
  return problems;
}

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Where a value breaks a (checked) schema; empty when it conforms. */
export function validate(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  const walk = (s: JsonSchema, v: unknown, path: string, depth: number) => {
    if (errors.length >= MAX_ERRORS || depth > MAX_DEPTH + 1) return;
    if (s.type !== undefined) {
      const allowed = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      const actual = typeOf(v);
      const ok = allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
      if (!ok) {
        errors.push(`${path}: expected ${allowed.join(" or ")}, got ${actual}`);
        return;
      }
    }
    if (s.const !== undefined && !deepEqual(s.const, v)) errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) errors.push(`${path}: must be >= ${s.minimum}`);
      if (typeof s.maximum === "number" && v > s.maximum) errors.push(`${path}: must be <= ${s.maximum}`);
    }
    if (typeof v === "string") {
      const len = [...v].length;
      if (typeof s.minLength === "number" && len < s.minLength) errors.push(`${path}: at least ${s.minLength} characters`);
      if (typeof s.maxLength === "number" && len > s.maxLength) errors.push(`${path}: at most ${s.maxLength} characters`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) errors.push(`${path}: at least ${s.minItems} items`);
      if (typeof s.maxItems === "number" && v.length > s.maxItems) errors.push(`${path}: at most ${s.maxItems} items`);
      if (s.items && typeof s.items === "object") v.forEach((item, i) => walk(s.items as JsonSchema, item, `${path}[${i}]`, depth + 1));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      for (const r of (s.required as string[] | undefined) ?? []) {
        if (!(r in obj)) errors.push(`${path}.${r}: required`);
      }
      for (const [k, sub] of Object.entries(props)) if (k in obj) walk(sub, obj[k], `${path}.${k}`, depth + 1);
      if (s.additionalProperties === false) {
        for (const k of Object.keys(obj)) if (!(k in props)) errors.push(`${path}.${k}: not allowed (additionalProperties is false)`);
      }
    }
  };
  walk(schema, value, "$", 0);
  return errors;
}
