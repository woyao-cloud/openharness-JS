/**
 * Tests for `--permission-prompt-tool <mcp_tool>` (audit B1).
 *
 * Strategy: build a minimal mock tool registry containing both a "permissioned"
 * tool (medium risk so it triggers needs-approval under "ask" mode) and a
 * "permission-prompt" tool that returns canned JSON. Then call
 * executeSingleTool with the permissionPromptTool name set and assert on the
 * outcome. Mirrors the pattern in tools.test.ts.
 *
 * The 6 cases below cover the full failure-mode taxonomy from the
 * callPermissionPromptTool helper:
 *   - allow → proceeds to execution
 *   - deny  → blocked with the tool's message
 *   - missing tool → fall through to askUser
 *   - tool throws → fall through
 *   - malformed JSON → fall through
 *   - unknown behavior value → fall through
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import { executeSingleTool } from "./tools.js";

function ctx(): ToolContext {
  return { workingDir: process.cwd(), gitCommitPerTool: false };
}

/** A "real" tool that the model wants to call — medium risk so it needs approval under "ask". */
const targetTool: Tool = {
  name: "DangerousAction",
  description: "test target",
  inputSchema: z.object({ value: z.string() }),
  riskLevel: "medium",
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input): Promise<ToolResult> {
    return { output: `executed with ${(input as { value: string }).value}`, isError: false };
  },
  prompt: () => "DangerousAction",
};

/** Build a mock permission-prompt tool that returns the given output. */
function makePromptTool(name: string, response: string | (() => Promise<ToolResult>)): Tool {
  return {
    name,
    description: "permission gate",
    inputSchema: z.object({ tool_name: z.string(), input: z.unknown() }),
    riskLevel: "low",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(): Promise<ToolResult> {
      if (typeof response === "function") return response();
      return { output: response, isError: false };
    },
    prompt: () => name,
  };
}

describe("--permission-prompt-tool (audit B1)", () => {
  test("behavior: allow → tool executes", async () => {
    const promptTool = makePromptTool("mcp__perm__check", JSON.stringify({ behavior: "allow" }));
    const result = await executeSingleTool(
      { id: "1", toolName: "DangerousAction", arguments: { value: "x" } },
      [targetTool, promptTool],
      ctx(),
      "ask",
      undefined, // no askUser — only the prompt tool decides
      "mcp__perm__check",
    );
    assert.equal(result.isError, false, `expected execution, got error: ${result.output}`);
    assert.match(result.output, /executed with x/);
  });

  test("behavior: deny → tool is blocked with the message", async () => {
    const promptTool = makePromptTool(
      "mcp__perm__check",
      JSON.stringify({ behavior: "deny", message: "policy violation" }),
    );
    const result = await executeSingleTool(
      { id: "1", toolName: "DangerousAction", arguments: { value: "x" } },
      [targetTool, promptTool],
      ctx(),
      "ask",
      undefined,
      "mcp__perm__check",
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /Permission denied by mcp__perm__check/);
    assert.match(result.output, /policy violation/);
  });

  test("missing tool → falls through to askUser when available", async () => {
    let askUserCalled = false;
    const askUser = async () => {
      askUserCalled = true;
      return false; // user denies
    };
    const result = await executeSingleTool(
      { id: "1", toolName: "DangerousAction", arguments: { value: "x" } },
      [targetTool], // permission tool NOT in registry
      ctx(),
      "ask",
      askUser,
      "mcp__perm__nope",
    );
    assert.equal(askUserCalled, true, "askUser must be called when prompt tool is missing");
    assert.equal(result.isError, true);
    assert.match(result.output, /Permission denied by user/);
  });

  test("tool throws → falls through to askUser", async () => {
    const promptTool = makePromptTool("mcp__perm__check", () => {
      throw new Error("upstream service down");
    });
    let askUserCalled = false;
    const askUser = async () => {
      askUserCalled = true;
      return true; // user allows
    };
    const result = await executeSingleTool(
      { id: "1", toolName: "DangerousAction", arguments: { value: "x" } },
      [targetTool, promptTool],
      ctx(),
      "ask",
      askUser,
      "mcp__perm__check",
    );
    assert.equal(askUserCalled, true);
    assert.equal(result.isError, false, "askUser allowed; tool should execute");
  });

  test("malformed JSON → falls through to askUser", async () => {
    const promptTool = makePromptTool("mcp__perm__check", "this is not JSON at all");
    let askUserCalled = false;
    const askUser = async () => {
      askUserCalled = true;
      return true;
    };
    const result = await executeSingleTool(
      { id: "1", toolName: "DangerousAction", arguments: { value: "x" } },
      [targetTool, promptTool],
      ctx(),
      "ask",
      askUser,
      "mcp__perm__check",
    );
    assert.equal(askUserCalled, true);
    assert.equal(result.isError, false);
  });

  test("unknown behavior value → falls through to askUser", async () => {
    const promptTool = makePromptTool("mcp__perm__check", JSON.stringify({ behavior: "maybe?" }));
    let askUserCalled = false;
    const askUser = async () => {
      askUserCalled = true;
      return false;
    };
    const result = await executeSingleTool(
      { id: "1", toolName: "DangerousAction", arguments: { value: "x" } },
      [targetTool, promptTool],
      ctx(),
      "ask",
      askUser,
      "mcp__perm__check",
    );
    assert.equal(askUserCalled, true);
    assert.equal(result.isError, true);
  });

  test("missing tool + no askUser → headless deny with descriptive message", async () => {
    const result = await executeSingleTool(
      { id: "1", toolName: "DangerousAction", arguments: { value: "x" } },
      [targetTool],
      ctx(),
      "ask",
      undefined, // no askUser
      "mcp__perm__nope",
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /mcp__perm__nope did not produce a usable decision/);
  });
});
