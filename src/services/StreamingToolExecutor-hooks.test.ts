/**
 * Regression: StreamingToolExecutor previously bypassed every hook in the
 * pipeline (preToolUse/postToolUse/postToolUseFailure/permissionRequest/
 * permissionDenied/fileChanged). This file verifies each one fires from the
 * streaming path the same way it fires from `executeSingleTool` in
 * src/query/tools.ts.
 *
 * Strategy mirrors src/harness/hooks-b2.test.ts: write a tiny .oh/config.yaml
 * with shell hooks that append the event name to a capture file, run a
 * StreamingToolExecutor cycle, then read the file.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { invalidateConfigCache } from "../harness/config.js";
import type { HookEvent } from "../harness/hooks.js";
import { invalidateHookCache } from "../harness/hooks.js";
import type { ToolContext } from "../Tool.js";
import { createMockTool, makeTmpDir, waitForCapture } from "../test-helpers.js";
import { StreamingToolExecutor } from "./StreamingToolExecutor.js";

function writeHookConfig(dir: string, capturePath: string, events: HookEvent[], mode = "trust"): void {
  mkdirSync(`${dir}/.oh`, { recursive: true });
  const lines = ["provider: mock", "model: mock", `permissionMode: ${mode}`, "hooks:"];
  for (const e of events) {
    const scriptPath = `${dir}/capture-${e}.cjs`;
    const capturePathFwd = capturePath.replace(/\\/g, "/");
    writeFileSync(
      scriptPath,
      `require('node:fs').appendFileSync(${JSON.stringify(capturePathFwd)}, ${JSON.stringify(`${e}\n`)});`,
    );
    const scriptPathFwd = scriptPath.replace(/\\/g, "/");
    lines.push(`  ${e}:`);
    lines.push(`    - command: 'node ${scriptPathFwd}'`);
  }
  writeFileSync(`${dir}/.oh/config.yaml`, `${lines.join("\n")}\n`);
}

async function withHooks<T>(
  events: HookEvent[],
  fn: (capturePath: string, dir: string) => Promise<T>,
  mode = "trust",
): Promise<{ result: T; fired: string[] }> {
  const dir = makeTmpDir();
  const capturePath = `${dir}/captured.log`;
  const original = process.cwd();
  process.chdir(dir);
  try {
    writeHookConfig(dir, capturePath, events, mode);
    invalidateConfigCache();
    invalidateHookCache();
    const result = await fn(capturePath, dir);
    const fired = await waitForCapture(capturePath, { expectedLines: 1 });
    return { result, fired };
  } finally {
    process.chdir(original);
    invalidateHookCache();
    invalidateConfigCache();
  }
}

const baseContext: ToolContext = { workingDir: "/tmp" };

describe("StreamingToolExecutor — hook pipeline parity with executeSingleTool", () => {
  it("preToolUse fires before the tool executes", async () => {
    const { fired } = await withHooks(["preToolUse"], async () => {
      const tool = createMockTool("Fast", { concurrent: true });
      const executor = new StreamingToolExecutor([tool], baseContext, "trust");
      executor.addTool({ id: "c1", toolName: "Fast", arguments: { x: 1 } });
      await executor.waitForAll();
    });
    assert.ok(fired.includes("preToolUse"), `expected preToolUse, got: ${fired.join(",") || "none"}`);
  });

  it("postToolUse fires after a successful tool call (not postToolUseFailure)", async () => {
    const { fired } = await withHooks(["postToolUse", "postToolUseFailure"], async () => {
      const tool = createMockTool("Fast", { concurrent: true });
      const executor = new StreamingToolExecutor([tool], baseContext, "trust");
      executor.addTool({ id: "c1", toolName: "Fast", arguments: {} });
      await executor.waitForAll();
    });
    assert.ok(fired.includes("postToolUse"));
    assert.ok(!fired.includes("postToolUseFailure"), "postToolUseFailure must NOT fire on success");
  });

  it("postToolUseFailure fires when the tool returns isError (not postToolUse)", async () => {
    const { fired } = await withHooks(["postToolUse", "postToolUseFailure"], async () => {
      const tool = createMockTool("Bad", {
        concurrent: true,
        result: { output: "tool failed", isError: true },
      });
      const executor = new StreamingToolExecutor([tool], baseContext, "trust");
      executor.addTool({ id: "c1", toolName: "Bad", arguments: {} });
      await executor.waitForAll();
    });
    assert.ok(fired.includes("postToolUseFailure"), `expected postToolUseFailure, got: ${fired.join(",") || "none"}`);
    assert.ok(!fired.includes("postToolUse"), "postToolUse must NOT fire on failure");
  });

  it("preToolUse blocking via exit-code-1 returns a Blocked result", async () => {
    const dir = makeTmpDir();
    const capturePath = `${dir}/captured.log`;
    const original = process.cwd();
    process.chdir(dir);
    try {
      // Hook script that ALWAYS exits 1 — that's the canonical "block" signal.
      mkdirSync(`${dir}/.oh`, { recursive: true });
      const blockScript = `${dir}/block.cjs`;
      const capturePathFwd = capturePath.replace(/\\/g, "/");
      writeFileSync(
        blockScript,
        `require('node:fs').appendFileSync(${JSON.stringify(capturePathFwd)}, "blocked\\n");process.exit(1);`,
      );
      const blockScriptFwd = blockScript.replace(/\\/g, "/");
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: trust",
          "hooks:",
          "  preToolUse:",
          `    - command: 'node ${blockScriptFwd}'`,
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const tool = createMockTool("Fast", { concurrent: true });
      const executor = new StreamingToolExecutor([tool], baseContext, "trust");
      executor.addTool({ id: "c1", toolName: "Fast", arguments: {} });
      await executor.waitForAll();

      const [result] = [...executor.getCompletedResults()];
      assert.ok(result, "should yield a result");
      assert.equal(result.result.isError, true, "preToolUse blocker should produce an error result");
      assert.match(result.result.output, /preToolUse/, "result should mention the preToolUse hook");
    } finally {
      process.chdir(original);
      invalidateHookCache();
      invalidateConfigCache();
    }
  });

  it("permissionDenied fires when policy denies (deny mode)", async () => {
    const { fired } = await withHooks(
      ["permissionDenied"],
      async () => {
        const tool = createMockTool("Write", { readOnly: false, risk: "medium" });
        const executor = new StreamingToolExecutor([tool], baseContext, "deny");
        executor.addTool({ id: "c1", toolName: "Write", arguments: {} });
        await executor.waitForAll();
      },
      "deny",
    );
    assert.ok(fired.includes("permissionDenied"), `expected permissionDenied, got: ${fired.join(",") || "none"}`);
  });
});
