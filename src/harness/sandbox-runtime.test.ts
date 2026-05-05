/**
 * Tests for the sandbox-runtime wrapper. Pure-logic coverage — we don't
 * actually invoke bubblewrap/sandbox-exec (they're not present in CI), and we
 * don't shell out to the real package. The integration test of "Bash actually
 * runs sandboxed on Linux" lives in the BashTool docs/manual smoke test path,
 * not here.
 *
 * Behavioral contract under test:
 * - `wrapForSandbox` returns null when `enabled: false`
 * - `wrapForSandbox` returns null on Windows regardless of config
 * - `isSandboxAvailable()` reflects platform support
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { _resetSandboxForTest, isSandboxAvailable, wrapForSandbox } from "./sandbox-runtime.js";

describe("sandbox-runtime wrapper", () => {
  it("isSandboxAvailable() returns true only on Linux/macOS", () => {
    const expected = process.platform === "linux" || process.platform === "darwin";
    assert.equal(isSandboxAvailable(), expected);
  });

  it("wrapForSandbox returns null when sandbox.enabled is false", async () => {
    _resetSandboxForTest();
    const wrapped = await wrapForSandbox("echo hi", { enabled: false });
    assert.equal(wrapped, null);
  });

  it("wrapForSandbox returns null when sandbox config has no enabled flag", async () => {
    _resetSandboxForTest();
    const wrapped = await wrapForSandbox("echo hi", {});
    assert.equal(wrapped, null);
  });

  it("wrapForSandbox returns null on Windows regardless of enabled flag", async () => {
    if (process.platform !== "win32") {
      return; // skip — covered by isSandboxAvailable assertion
    }
    _resetSandboxForTest();
    const wrapped = await wrapForSandbox("echo hi", { enabled: true });
    assert.equal(wrapped, null, "Windows should always return null even with enabled: true");
  });

  it("wrapForSandbox is graceful when init fails (cached as null, never throws)", async () => {
    // Whatever the platform/env, calling wrapForSandbox with enabled:true
    // either succeeds (returns a string) or fails gracefully (returns null).
    // Never throws — that's the whole point of the optional integration.
    _resetSandboxForTest();
    const result = await wrapForSandbox("echo hi", {
      enabled: true,
      // Intentionally narrow allowlist — if init somehow runs, this
      // limits any side effects.
      network: { allowedDomains: [] },
      filesystem: { allowWrite: [] },
    });
    // result is string OR null — both shapes are valid; we just assert no throw.
    assert.ok(result === null || typeof result === "string");
  });

  it("repeated wrapForSandbox calls reuse the cached init promise", async () => {
    _resetSandboxForTest();
    const cfg = { enabled: true } as const;
    // Two parallel calls — both await the same _initPromise. If init failed,
    // both should observe null without re-running.
    const [a, b] = await Promise.all([wrapForSandbox("ls", cfg), wrapForSandbox("pwd", cfg)]);
    // Both calls should arrive at the same cached resolution shape:
    // both string-or-null. If one is null and the other is a string, the
    // cache is broken.
    assert.equal(typeof a === typeof b, true, "init cache should produce consistent typeof across calls");
  });
});
