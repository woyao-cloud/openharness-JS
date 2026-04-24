/**
 * Minimal JSON Schema validator — covers the common subset sufficient for
 * constraining LLM output in headless mode. Supported keywords:
 *
 *   - `type`: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null"
 *             (or an array of those for union types)
 *   - `properties`: object → sub-schema per field
 *   - `required`: array of field names that must be present
 *   - `items`: sub-schema for array elements
 *   - `enum`: array of allowed literal values (compared with strict equality)
 *
 * Anything else is silently accepted. This is intentional — we don't want to
 * ship a full JSON Schema engine. For cases that need more (e.g. `pattern`,
 * `oneOf`, `$ref`), use an external validator.
 */

export type JsonSchema = Record<string, unknown>;

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateAgainstJsonSchema(value: unknown, schema: JsonSchema): ValidationResult {
  const errors: string[] = [];
  validate(value, schema, "", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validate(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    if (!schema.enum.some((allowed) => deepEqual(allowed, value))) {
      errors.push(`${prefix(path)}value ${JSON.stringify(value)} is not one of the enum values`);
      return;
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${prefix(path)}expected ${types.join(" or ")}, got ${describeActual(value)}`);
      return;
    }
  }

  if (matchesType(value, "object") && schema.properties) {
    const properties = schema.properties as Record<string, JsonSchema>;
    const required = (schema.required as string[] | undefined) ?? [];
    const obj = value as Record<string, unknown>;

    for (const field of required) {
      if (!(field in obj)) {
        const fullPath = path ? `${path}.${field}` : field;
        errors.push(`missing required property '${fullPath}'`);
      }
    }

    for (const [field, subSchema] of Object.entries(properties)) {
      if (field in obj) {
        validate(obj[field], subSchema, path ? `${path}.${field}` : field, errors);
      }
    }
  }

  if (matchesType(value, "array") && schema.items) {
    const items = schema.items as JsonSchema;
    const arr = value as unknown[];
    arr.forEach((item, i) => {
      validate(item, items, `${path}[${i}]`, errors);
    });
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

function describeActual(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function prefix(path: string): string {
  return path ? `${path}: ` : "";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
