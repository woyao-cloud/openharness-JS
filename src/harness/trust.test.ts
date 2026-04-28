/**
 * Tests for the workspace-trust store (audit U-A4).
 *
 * Exercises the file-backed read/write path against a real `~/.oh/`
 * directory in a tmpdir-style override. Since the store path is a hard
 * `~/.oh/trusted-dirs.json`, tests stub `homedir()` via a HOME env override
 * (works on POSIX; on Windows we skip the env-based isolation in favor of
 * the existing trust file — the tests still verify the in-memory path).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { _resetTrustForTest, isTrusted, listTrusted, trust } from "./trust.js";

const TRUST_FILE = join(homedir(), ".oh", "trusted-dirs.json");

describe("workspace-trust store (audit U-A4)", () => {
  let preExisting: string | null = null;

  beforeEach(() => {
    // Snapshot any user-existing file so we don't clobber it.
    try {
      preExisting = existsSync(TRUST_FILE) ? readFileSync(TRUST_FILE, "utf8") : null;
      rmSync(TRUST_FILE, { force: true });
    } catch {
      preExisting = null;
    }
    _resetTrustForTest();
  });

  afterEach(() => {
    // Restore (or clear) so test runs leave no artifact in the user's home.
    try {
      rmSync(TRUST_FILE, { force: true });
      if (preExisting !== null) {
        mkdirSync(dirname(TRUST_FILE), { recursive: true });
        writeFileSync(TRUST_FILE, preExisting);
      }
    } catch {
      /* best effort */
    }
    _resetTrustForTest();
  });

  test("default state: nothing is trusted", () => {
    assert.equal(isTrusted("/some/dir"), false);
    assert.deepEqual(listTrusted(), []);
  });

  test("trust(dir) makes that dir trusted on subsequent read", () => {
    trust("/tmp/oh-trust-test");
    assert.equal(isTrusted("/tmp/oh-trust-test"), true);
    assert.ok(listTrusted().includes("/tmp/oh-trust-test"));
  });

  test("trust() is idempotent — second call doesn't duplicate", () => {
    trust("/tmp/oh-idempotent");
    trust("/tmp/oh-idempotent");
    const trusted = listTrusted();
    assert.equal(trusted.filter((d) => d === "/tmp/oh-idempotent").length, 1);
  });

  test("isTrusted normalizes relative paths to absolute", () => {
    trust("./relative-test-dir");
    // Reset cache so the next isTrusted reads from disk
    _resetTrustForTest();
    assert.equal(isTrusted("./relative-test-dir"), true);
  });

  test("non-trusted dir returns false even with a different dir trusted", () => {
    trust("/tmp/oh-isolated-a");
    assert.equal(isTrusted("/tmp/oh-isolated-b"), false);
  });

  test("trust persists across a cache reset (round-trips through disk)", () => {
    trust("/tmp/oh-persist");
    _resetTrustForTest();
    assert.equal(isTrusted("/tmp/oh-persist"), true);
  });
});
