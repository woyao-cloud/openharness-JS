/**
 * Tests for the `disableAllHooks` config kill switch (audit A11).
 *
 * When set, every hook emit short-circuits as if no hooks were configured —
 * even though configured hooks remain in `.oh/config.yaml` and are still
 * visible via `/hooks` for auditability.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { invalidateConfigCache } from "./config.js";
import { areHooksEnabled, emitHook, emitHookAsync, emitHookWithOutcome, invalidateHookCache } from "./hooks.js";

function writeConfig(dir: string, body: string): void {
  mkdirSync(`${dir}/.oh`, { recursive: true });
  writeFileSync(`${dir}/.oh/config.yaml`, body, "utf8");
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    invalidateConfigCache();
    invalidateHookCache();
    return await fn();
  } finally {
    process.chdir(original);
    invalidateConfigCache();
    invalidateHookCache();
  }
}

describe("disableAllHooks (audit A11)", () => {
  it("areHooksEnabled() reflects the config flag", async () => {
    const dir = makeTmpDir();
    writeConfig(dir, "provider: mock\nmodel: mock\npermissionMode: trust\ndisableAllHooks: true\n");
    await withCwd(dir, async () => {
      assert.equal(areHooksEnabled(), false);
    });

    writeConfig(dir, "provider: mock\nmodel: mock\npermissionMode: trust\ndisableAllHooks: false\n");
    await withCwd(dir, async () => {
      assert.equal(areHooksEnabled(), true);
    });

    writeConfig(dir, "provider: mock\nmodel: mock\npermissionMode: trust\n");
    await withCwd(dir, async () => {
      assert.equal(areHooksEnabled(), true, "default to enabled when key absent");
    });
  });

  it("emitHook short-circuits to allowed when disabled", async () => {
    const dir = makeTmpDir();
    const capturePath = `${dir}/captured.log`;
    const captureScript = `${dir}/capture.cjs`;
    writeFileSync(
      captureScript,
      `require('node:fs').appendFileSync(${JSON.stringify(capturePath.replace(/\\/g, "/"))}, 'fired\\n');`,
    );
    writeConfig(
      dir,
      `provider: mock\nmodel: mock\npermissionMode: trust\ndisableAllHooks: true\nhooks:\n  preToolUse:\n    - command: 'node ${captureScript.replace(/\\/g, "/")}'\n`,
    );
    await withCwd(dir, async () => {
      const allowed = emitHook("preToolUse", { toolName: "X" });
      assert.equal(allowed, true, "should default-allow when hooks are disabled");
      // Yield so any escapee fire-and-forget would have flushed.
      await new Promise<void>((r) => setTimeout(r, 80));
      assert.equal(existsSync(capturePath), false, "capture file must NOT exist — the hook was bypassed");
    });
  });

  it("emitHookAsync short-circuits to allowed when disabled", async () => {
    const dir = makeTmpDir();
    writeConfig(
      dir,
      `provider: mock\nmodel: mock\npermissionMode: trust\ndisableAllHooks: true\nhooks:\n  userPromptSubmit:\n    - command: 'exit 1'\n`,
    );
    await withCwd(dir, async () => {
      const allowed = await emitHookAsync("userPromptSubmit", { prompt: "test" });
      assert.equal(allowed, true, "exit-1 hook would normally deny — but disabled means allowed");
    });
  });

  it("emitHookWithOutcome returns {allowed:true} when disabled", async () => {
    const dir = makeTmpDir();
    writeConfig(
      dir,
      `provider: mock\nmodel: mock\npermissionMode: trust\ndisableAllHooks: true\nhooks:\n  permissionRequest:\n    - command: 'exit 1'\n      jsonIO: false\n`,
    );
    await withCwd(dir, async () => {
      const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "X" });
      assert.equal(outcome.allowed, true);
      assert.equal(outcome.permissionDecision, undefined);
      assert.equal(outcome.reason, undefined);
    });
  });

  it("hooks fire normally when disableAllHooks is absent or false", async () => {
    const dir = makeTmpDir();
    const capturePath = `${dir}/captured.log`;
    const captureScript = `${dir}/capture.cjs`;
    writeFileSync(
      captureScript,
      `require('node:fs').appendFileSync(${JSON.stringify(capturePath.replace(/\\/g, "/"))}, 'fired\\n');`,
    );
    writeConfig(
      dir,
      `provider: mock\nmodel: mock\npermissionMode: trust\nhooks:\n  postToolUse:\n    - command: 'node ${captureScript.replace(/\\/g, "/")}'\n`,
    );
    await withCwd(dir, async () => {
      emitHook("postToolUse", { toolName: "Read" });
      // postToolUse runs async; wait for the spawned node child to flush.
      // Windows CI takes ~1s to spawn + run a node child; 1500ms covers
      // the worst case without slowing local runs meaningfully (matches
      // the bump in hooks-b2.test.ts).
      await new Promise<void>((r) => setTimeout(r, 1500));
      assert.ok(existsSync(capturePath), "with disableAllHooks absent, the hook should fire");
      const fired = readFileSync(capturePath, "utf8");
      assert.match(fired, /fired/);
    });
  });
});
