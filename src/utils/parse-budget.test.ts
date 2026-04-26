import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMaxBudgetUsd } from "./parse-budget.js";

describe("parseMaxBudgetUsd", () => {
  test("plain integer", () => {
    const r = parseMaxBudgetUsd("5");
    assert.deepEqual(r, { ok: true, value: 5 });
  });

  test("decimal", () => {
    const r = parseMaxBudgetUsd("0.50");
    assert.deepEqual(r, { ok: true, value: 0.5 });
  });

  test("strips a leading dollar sign", () => {
    const r = parseMaxBudgetUsd("$2.5");
    assert.deepEqual(r, { ok: true, value: 2.5 });
  });

  test("trims whitespace", () => {
    const r = parseMaxBudgetUsd("  3.14  ");
    assert.deepEqual(r, { ok: true, value: 3.14 });
  });

  test("rejects zero", () => {
    const r = parseMaxBudgetUsd("0");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /positive/);
  });

  test("rejects negative", () => {
    const r = parseMaxBudgetUsd("-1");
    assert.equal(r.ok, false);
  });

  test("rejects non-numeric", () => {
    const r = parseMaxBudgetUsd("five dollars");
    assert.equal(r.ok, false);
  });

  test("rejects empty after stripping", () => {
    const r = parseMaxBudgetUsd("$");
    assert.equal(r.ok, false);
  });

  test("rejects NaN", () => {
    const r = parseMaxBudgetUsd("NaN");
    assert.equal(r.ok, false);
  });

  test("rejects Infinity", () => {
    const r = parseMaxBudgetUsd("Infinity");
    assert.equal(r.ok, false);
  });
});
