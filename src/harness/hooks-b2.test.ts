/**
 * Tests for the audit-B2 hook events: taskCreated / taskCompleted /
 * permissionDenied / postToolBatch / userPromptExpansion / instructionsLoaded.
 *
 * Strategy: write a tiny .oh/config.yaml registering a shell hook that appends
 * the event name to a capture file, trigger the action that should emit, then
 * read the file. Same pattern as src/query/tools.test.ts and the existing
 * hooks tests — robust to monkey-patching limits in ESM.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { z } from "zod";
import { executeSingleTool, executeToolCalls } from "../query/tools.js";
import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import { makeTmpDir } from "../test-helpers.js";
import { TaskCreateTool } from "../tools/TaskCreateTool/index.js";
import { TaskUpdateTool } from "../tools/TaskUpdateTool/index.js";
import { invalidateConfigCache } from "./config.js";
import type { HookEvent } from "./hooks.js";
import { invalidateHookCache } from "./hooks.js";
import { loadRulesAsPrompt } from "./rules.js";

function writeHookConfig(dir: string, capturePath: string, events: HookEvent[]): void {
  mkdirSync(`${dir}/.oh`, { recursive: true });
  const lines = ["provider: mock", "model: mock", "permissionMode: deny", "hooks:"];
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
  fn: (capturePath: string) => Promise<T>,
): Promise<{ result: T; fired: string[] }> {
  const dir = makeTmpDir();
  const capturePath = `${dir}/captured.log`;
  const original = process.cwd();
  process.chdir(dir);
  try {
    writeHookConfig(dir, capturePath, events);
    invalidateConfigCache();
    invalidateHookCache();

    const result = await fn(capturePath);
    // Yield so fire-and-forget async hook processes can flush. Windows CI
    // takes ~1s to spawn + run a node child process, so the wait is generous.
    // Local runs see the file appear well under 300 ms; this just budgets for
    // the worst-case CI runner.
    await new Promise<void>((r) => setTimeout(r, 1500));
    const fired = existsSync(capturePath) ? readFileSync(capturePath, "utf8").split("\n").filter(Boolean) : [];
    return { result, fired };
  } finally {
    process.chdir(original);
    invalidateHookCache();
    invalidateConfigCache();
  }
}

function ctx(workingDir: string): ToolContext {
  return { workingDir, gitCommitPerTool: false };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("audit B2 — new hook events fire from their source code paths", () => {
  it("taskCreated fires when TaskCreate persists a new task", async () => {
    const { fired } = await withHooks(["taskCreated"], async () => {
      await TaskCreateTool.call({ subject: "hook-test", description: "verify hook fires" }, ctx(process.cwd()));
    });
    assert.ok(fired.includes("taskCreated"), `expected taskCreated, got ${fired.join(",") || "none"}`);
  });

  it("taskCompleted fires only on transition to completed (not on re-save)", async () => {
    const { fired } = await withHooks(["taskCompleted"], async () => {
      await TaskCreateTool.call({ subject: "to complete", description: "x" }, ctx(process.cwd()));
      await TaskUpdateTool.call({ taskId: 1, status: "in_progress" }, ctx(process.cwd()));
      await TaskUpdateTool.call({ taskId: 1, status: "completed" }, ctx(process.cwd()));
      // Re-saving an already-completed task must NOT fire again.
      await TaskUpdateTool.call({ taskId: 1, status: "completed" }, ctx(process.cwd()));
    });
    const completedCount = fired.filter((e) => e === "taskCompleted").length;
    assert.equal(completedCount, 1, `expected exactly 1 taskCompleted, got ${completedCount}`);
  });

  it("permissionDenied fires when a tool is blocked by deny mode", async () => {
    // Set up a high-risk tool that will trip the deny-mode policy block.
    const danger: Tool = {
      name: "DangerTool",
      description: "high risk for test",
      inputSchema: z.object({}),
      riskLevel: "high",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(): Promise<ToolResult> {
        return { output: "should-not-run", isError: false };
      },
      prompt: () => "DangerTool",
    };
    const { fired } = await withHooks(["permissionDenied"], async () => {
      // permissionMode "deny" → checkPermission returns "blocked-by-mode" (not needs-approval),
      // so the policy-block branch fires permissionDenied with denySource="policy".
      await executeSingleTool({ id: "1", toolName: "DangerTool", arguments: {} }, [danger], ctx(process.cwd()), "deny");
    });
    assert.ok(fired.includes("permissionDenied"), `expected permissionDenied, got ${fired.join(",") || "none"}`);
  });

  it("postToolBatch fires once after a turn's tool calls all resolve", async () => {
    const safe: Tool = {
      name: "SafeTool",
      description: "low-risk read for test",
      inputSchema: z.object({}),
      riskLevel: "low",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(): Promise<ToolResult> {
        return { output: "ok", isError: false };
      },
      prompt: () => "SafeTool",
    };
    const { fired } = await withHooks(["postToolBatch"], async () => {
      const calls = [
        { id: "a", toolName: "SafeTool", arguments: {} },
        { id: "b", toolName: "SafeTool", arguments: {} },
      ];
      // Drain the generator so the post-loop emit runs.
      for await (const _ of executeToolCalls(calls, [safe], ctx(process.cwd()), "trust")) {
        void _;
      }
    });
    const batchCount = fired.filter((e) => e === "postToolBatch").length;
    assert.equal(batchCount, 1, `expected exactly 1 postToolBatch, got ${batchCount}`);
  });

  it("instructionsLoaded fires when loadRulesAsPrompt has rules to load", async () => {
    const { fired } = await withHooks(["instructionsLoaded"], async () => {
      // Create a project rules file so loadRules has something to return.
      writeFileSync(`${process.cwd()}/.oh/RULES.md`, "Always test your code.\n");
      const out = loadRulesAsPrompt();
      assert.ok(out.length > 0, "rules prompt should be non-empty");
    });
    assert.ok(fired.includes("instructionsLoaded"), `expected instructionsLoaded, got ${fired.join(",") || "none"}`);
  });
});
