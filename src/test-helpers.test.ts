/**
 * Lock-in tests for waitForCapture — the shared helper that 5 hook tests
 * depend on. A regression here would silently flake all 5 simultaneously.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { makeTmpDir, waitForCapture } from "./test-helpers.js";

describe("waitForCapture", () => {
  it("returns early once expectedLines is reached", async () => {
    const dir = makeTmpDir();
    const path = `${dir}/cap.log`;
    setTimeout(() => writeFileSync(path, "a\nb\n"), 50);
    const start = Date.now();
    const fired = await waitForCapture(path, { expectedLines: 2, timeoutMs: 5000 });
    const elapsed = Date.now() - start;
    assert.deepEqual(fired, ["a", "b"]);
    assert.ok(elapsed < 1000, `expected early-exit (<1s), took ${elapsed}ms`);
  });

  it("returns whatever it has after timeoutMs without hanging", async () => {
    const dir = makeTmpDir();
    const path = `${dir}/cap.log`;
    const start = Date.now();
    const fired = await waitForCapture(path, { expectedLines: 1, timeoutMs: 200 });
    const elapsed = Date.now() - start;
    assert.deepEqual(fired, []);
    assert.ok(elapsed >= 200 && elapsed < 1000, `expected ~200ms timeout, took ${elapsed}ms`);
  });

  it("grace period catches stragglers after expected count is reached", async () => {
    const dir = makeTmpDir();
    const path = `${dir}/cap.log`;
    writeFileSync(path, "a\n");
    setTimeout(() => writeFileSync(path, "a\nb\n"), 30);
    const fired = await waitForCapture(path, { expectedLines: 1, graceMs: 150 });
    assert.deepEqual(fired, ["a", "b"], "grace period should observe the second line");
  });

  it("missing capture file is not an error — returns empty array", async () => {
    const fired = await waitForCapture(`/nonexistent/${Date.now()}/x.log`, { timeoutMs: 100 });
    assert.deepEqual(fired, []);
  });
});
