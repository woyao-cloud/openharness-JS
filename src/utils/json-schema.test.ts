import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAgainstJsonSchema } from "./json-schema.js";

describe("validateAgainstJsonSchema — type", () => {
  it("accepts a matching string", () => {
    const r = validateAgainstJsonSchema("hi", { type: "string" });
    assert.equal(r.ok, true);
  });

  it("rejects a string when number is expected", () => {
    const r = validateAgainstJsonSchema("hi", { type: "number" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0]!, /expected number/);
  });

  it("accepts an integer when type is 'integer'", () => {
    const r = validateAgainstJsonSchema(42, { type: "integer" });
    assert.equal(r.ok, true);
  });

  it("rejects a non-integer number when type is 'integer'", () => {
    const r = validateAgainstJsonSchema(3.14, { type: "integer" });
    assert.equal(r.ok, false);
  });

  it("accepts null when type is 'null'", () => {
    const r = validateAgainstJsonSchema(null, { type: "null" });
    assert.equal(r.ok, true);
  });

  it("accepts a boolean and rejects a string when type is 'boolean'", () => {
    assert.equal(validateAgainstJsonSchema(true, { type: "boolean" }).ok, true);
    assert.equal(validateAgainstJsonSchema("true", { type: "boolean" }).ok, false);
  });

  it("accepts an array when type is 'array'", () => {
    const r = validateAgainstJsonSchema([1, 2, 3], { type: "array" });
    assert.equal(r.ok, true);
  });

  it("rejects an object when type is 'array' (arrays are not objects)", () => {
    const r = validateAgainstJsonSchema({ foo: 1 }, { type: "array" });
    assert.equal(r.ok, false);
  });

  it("accepts any of a union type", () => {
    const schema = { type: ["string", "null"] };
    assert.equal(validateAgainstJsonSchema("x", schema).ok, true);
    assert.equal(validateAgainstJsonSchema(null, schema).ok, true);
    assert.equal(validateAgainstJsonSchema(1, schema).ok, false);
  });
});

describe("validateAgainstJsonSchema — properties and required", () => {
  it("validates required object fields", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    };
    assert.equal(validateAgainstJsonSchema({ name: "Ada" }, schema).ok, true);
    assert.equal(validateAgainstJsonSchema({ name: "Ada", age: 28 }, schema).ok, true);
    assert.equal(validateAgainstJsonSchema({ age: 28 }, schema).ok, false);
  });

  it("returns all missing-required errors in one pass", () => {
    const schema = { type: "object", properties: {}, required: ["a", "b", "c"] };
    const r = validateAgainstJsonSchema({}, schema);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("a")));
      assert.ok(r.errors.some((e) => e.includes("b")));
      assert.ok(r.errors.some((e) => e.includes("c")));
    }
  });

  it("validates property types", () => {
    const schema = {
      type: "object",
      properties: { age: { type: "number" } },
    };
    const r = validateAgainstJsonSchema({ age: "twenty" }, schema);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => /age/.test(e)));
  });

  it("reports nested property paths in errors", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      required: ["user"],
    };
    const r = validateAgainstJsonSchema({ user: {} }, schema);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => /user\.name/.test(e)));
  });
});

describe("validateAgainstJsonSchema — array items", () => {
  it("validates items against the item schema", () => {
    const schema = { type: "array", items: { type: "number" } };
    assert.equal(validateAgainstJsonSchema([1, 2, 3], schema).ok, true);
    assert.equal(validateAgainstJsonSchema([1, "two", 3], schema).ok, false);
  });

  it("reports the failing index in array errors", () => {
    const schema = { type: "array", items: { type: "number" } };
    const r = validateAgainstJsonSchema([1, "two", 3], schema);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => /\[1\]/.test(e)));
  });
});

describe("validateAgainstJsonSchema — enum", () => {
  it("accepts a value in the enum", () => {
    const schema = { enum: ["red", "green", "blue"] };
    assert.equal(validateAgainstJsonSchema("red", schema).ok, true);
  });

  it("rejects a value not in the enum", () => {
    const schema = { enum: ["red", "green", "blue"] };
    const r = validateAgainstJsonSchema("yellow", schema);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0]!, /enum|not one of/i);
  });

  it("works with enum of numbers", () => {
    const schema = { enum: [1, 2, 3] };
    assert.equal(validateAgainstJsonSchema(2, schema).ok, true);
    assert.equal(validateAgainstJsonSchema(4, schema).ok, false);
  });
});

describe("validateAgainstJsonSchema — composition", () => {
  it("validates a realistic mixed schema", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { enum: ["person", "team"] },
        name: { type: "string" },
        members: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "name"],
    };

    assert.equal(
      validateAgainstJsonSchema({ kind: "team", name: "Alpha", members: ["Ada", "Grace"] }, schema).ok,
      true,
    );
    assert.equal(validateAgainstJsonSchema({ kind: "person", name: "Ada" }, schema).ok, true);
    assert.equal(validateAgainstJsonSchema({ kind: "company", name: "Alpha" }, schema).ok, false);
    assert.equal(validateAgainstJsonSchema({ name: "Alpha" }, schema).ok, false);
    assert.equal(validateAgainstJsonSchema({ kind: "team", name: "Alpha", members: ["Ada", 1] }, schema).ok, false);
  });

  it("accepts an empty schema (anything validates)", () => {
    assert.equal(validateAgainstJsonSchema(42, {}).ok, true);
    assert.equal(validateAgainstJsonSchema("hello", {}).ok, true);
    assert.equal(validateAgainstJsonSchema(null, {}).ok, true);
  });
});
