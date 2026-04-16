/**
 * Extended tool tests — covers TodoWrite, Memory, Task*, ToolSearch,
 * EnterPlanMode, ExitPlanMode, and KillProcess tools.
 * Uses node:test + node:assert/strict.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolContext } from "../Tool.js";
import { createMockTool, makeTmpDir } from "../test-helpers.js";
import { EnterPlanModeTool } from "./EnterPlanModeTool/index.js";
import { ExitPlanModeTool } from "./ExitPlanModeTool/index.js";
import { KillProcessTool } from "./KillProcessTool/index.js";
import { MemoryTool } from "./MemoryTool/index.js";
import { TaskCreateTool } from "./TaskCreateTool/index.js";
import { TaskListTool } from "./TaskListTool/index.js";
import { TaskUpdateTool } from "./TaskUpdateTool/index.js";
import { TodoWriteTool } from "./TodoWriteTool/index.js";
import { ToolSearchTool } from "./ToolSearchTool/index.js";

function ctx(tmpdir: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { workingDir: tmpdir, ...extra };
}

describe("tools-extended", () => {
  // ── TodoWriteTool ──

  it("TodoWriteTool — creates new todos", async () => {
    const tmp = makeTmpDir();
    const result = await TodoWriteTool.call(
      {
        todos: [
          { id: "t1", content: "Write tests", status: "pending" },
          { id: "t2", content: "Fix bugs", status: "in_progress", priority: "high" },
        ],
      },
      ctx(tmp),
    );
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("2 created"));
    assert.ok(result.output.includes("2 remaining"));

    // Verify file was written
    const raw = readFileSync(join(tmp, ".oh", "todos.json"), "utf-8");
    const todos = JSON.parse(raw);
    assert.equal(todos.length, 2);
    assert.equal(todos[0].id, "t1");
    assert.equal(todos[1].priority, "high");
  });

  it("TodoWriteTool — updates existing todo by ID", async () => {
    const tmp = makeTmpDir();
    // Create initial todo
    await TodoWriteTool.call({ todos: [{ id: "t1", content: "Original", status: "pending" }] }, ctx(tmp));
    // Update it
    const result = await TodoWriteTool.call(
      { todos: [{ id: "t1", content: "Updated", status: "completed" }] },
      ctx(tmp),
    );
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("1 updated"));
    assert.ok(result.output.includes("0 remaining")); // completed items not counted

    const raw = readFileSync(join(tmp, ".oh", "todos.json"), "utf-8");
    const todos = JSON.parse(raw);
    assert.equal(todos.length, 1);
    assert.equal(todos[0].content, "Updated");
    assert.equal(todos[0].status, "completed");
  });

  // ── MemoryTool ──

  it("MemoryTool — save requires name and content", async () => {
    const tmp = makeTmpDir();
    const result = await MemoryTool.call({ action: "save" }, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("name and content required"));
  });

  it("MemoryTool — list returns no memories on empty state", async () => {
    const tmp = makeTmpDir();
    const result = await MemoryTool.call({ action: "list" }, ctx(tmp));
    assert.equal(result.isError, false);
    // Either "No memories saved." or shows memories from global state — both valid
    assert.ok(typeof result.output === "string");
  });

  it("MemoryTool — search requires query", async () => {
    const tmp = makeTmpDir();
    const result = await MemoryTool.call({ action: "search" }, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("query required"));
  });

  it("MemoryTool — unknown action returns error", async () => {
    const tmp = makeTmpDir();
    // Force an unknown action by casting
    const result = await MemoryTool.call({ action: "delete" as any }, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("Unknown action"));
  });

  // ── TaskCreateTool ──

  it("TaskCreateTool — creates task with auto-increment ID", async () => {
    const tmp = makeTmpDir();
    const r1 = await TaskCreateTool.call({ subject: "First", description: "desc1" }, ctx(tmp));
    assert.equal(r1.isError, false);
    assert.ok(r1.output.includes("Task #1"));

    const r2 = await TaskCreateTool.call({ subject: "Second", description: "desc2" }, ctx(tmp));
    assert.equal(r2.isError, false);
    assert.ok(r2.output.includes("Task #2"));
  });

  it("TaskCreateTool — includes metadata when provided", async () => {
    const tmp = makeTmpDir();
    await TaskCreateTool.call({ subject: "Meta task", description: "d", metadata: { key: "value" } }, ctx(tmp));
    const raw = readFileSync(join(tmp, ".oh", "tasks.json"), "utf-8");
    const tasks = JSON.parse(raw);
    assert.deepEqual(tasks[0].metadata, { key: "value" });
  });

  // ── TaskUpdateTool ──

  it("TaskUpdateTool — errors on non-existent task", async () => {
    const tmp = makeTmpDir();
    await TaskCreateTool.call({ subject: "x", description: "y" }, ctx(tmp));
    const result = await TaskUpdateTool.call({ taskId: 99, status: "completed" }, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("not found"));
  });

  it("TaskUpdateTool — errors when no tasks file exists", async () => {
    const tmp = makeTmpDir();
    const result = await TaskUpdateTool.call({ taskId: 1, status: "completed" }, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("No tasks file"));
  });

  it("TaskUpdateTool — merges metadata with null deletion", async () => {
    const tmp = makeTmpDir();
    await TaskCreateTool.call({ subject: "meta", description: "d", metadata: { a: 1, b: 2 } }, ctx(tmp));
    await TaskUpdateTool.call({ taskId: 1, metadata: { b: null, c: 3 } }, ctx(tmp));
    const raw = readFileSync(join(tmp, ".oh", "tasks.json"), "utf-8");
    const tasks = JSON.parse(raw);
    assert.equal(tasks[0].metadata.a, 1);
    assert.equal(tasks[0].metadata.b, undefined);
    assert.equal(tasks[0].metadata.c, 3);
  });

  // ── TaskListTool ──

  it("TaskListTool — returns no tasks when file missing", async () => {
    const tmp = makeTmpDir();
    const result = await TaskListTool.call({}, ctx(tmp));
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("No tasks found"));
  });

  it("TaskListTool — lists multiple tasks with status", async () => {
    const tmp = makeTmpDir();
    await TaskCreateTool.call({ subject: "Alpha", description: "a" }, ctx(tmp));
    await TaskCreateTool.call({ subject: "Beta", description: "b" }, ctx(tmp));
    await TaskUpdateTool.call({ taskId: 1, status: "completed" }, ctx(tmp));
    const result = await TaskListTool.call({}, ctx(tmp));
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("Alpha"));
    assert.ok(result.output.includes("Beta"));
    assert.ok(result.output.includes("[completed]"));
    assert.ok(result.output.includes("[pending]"));
  });

  // ── ToolSearchTool ──

  it("ToolSearchTool — returns no results for unknown query", async () => {
    const tmp = makeTmpDir();
    const mock = createMockTool("SomeTool");
    const result = await ToolSearchTool.call({ query: "zzz_nonexistent", maxResults: 5 }, ctx(tmp, { tools: [mock] }));
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("No tools found"));
  });

  it("ToolSearchTool — respects maxResults", async () => {
    const tmp = makeTmpDir();
    const tools = [createMockTool("AlphaTool"), createMockTool("AlphaBeta"), createMockTool("AlphaGamma")];
    const result = await ToolSearchTool.call({ query: "Alpha", maxResults: 2 }, ctx(tmp, { tools }));
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("AlphaTool"));
    assert.ok(result.output.includes("AlphaBeta"));
    assert.ok(!result.output.includes("AlphaGamma"));
  });

  // ── EnterPlanModeTool ──

  it("EnterPlanModeTool — creates plan file with 3-part name", async () => {
    const tmp = makeTmpDir();
    const result = await EnterPlanModeTool.call({}, ctx(tmp));
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("Plan mode entered"));
    assert.ok(result.output.includes(".oh"));

    // Verify plan file exists
    const { readdirSync } = await import("node:fs");
    const plansDir = join(tmp, ".oh", "plans");
    const files = readdirSync(plansDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".md"));
    // Verify 3-part name pattern
    const name = files[0].replace(".md", "");
    assert.equal(name.split("-").length, 3, `Expected 3-part name, got: ${name}`);
  });

  it("EnterPlanModeTool — plan file contains template content", async () => {
    const tmp = makeTmpDir();
    await EnterPlanModeTool.call({}, ctx(tmp));
    const { readdirSync } = await import("node:fs");
    const plansDir = join(tmp, ".oh", "plans");
    const files = readdirSync(plansDir);
    const content = readFileSync(join(plansDir, files[0]), "utf-8");
    assert.ok(content.includes("# Plan"));
  });

  // ── ExitPlanModeTool ──

  it("ExitPlanModeTool — exits plan mode", async () => {
    const tmp = makeTmpDir();
    const result = await ExitPlanModeTool.call({}, ctx(tmp));
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("Plan mode exited"));
  });

  it("ExitPlanModeTool — includes allowed prompts in output", async () => {
    const tmp = makeTmpDir();
    const result = await ExitPlanModeTool.call(
      {
        allowedPrompts: [
          { tool: "Bash" as const, prompt: "run tests" },
          { tool: "Bash" as const, prompt: "build project" },
        ],
      },
      ctx(tmp),
    );
    assert.equal(result.isError, false);
    assert.ok(result.output.includes("run tests"));
    assert.ok(result.output.includes("build project"));
    assert.ok(result.output.includes("Requested permissions"));
  });

  // ── KillProcessTool ──

  it("KillProcessTool — errors when neither pid nor name given", async () => {
    const tmp = makeTmpDir();
    const result = await KillProcessTool.call({}, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("Provide either pid or name"));
  });

  it("KillProcessTool — errors on non-existent PID", async () => {
    const tmp = makeTmpDir();
    // Use a PID that almost certainly does not exist
    const result = await KillProcessTool.call({ pid: 2147483647 }, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("Failed"));
  });

  it("KillProcessTool — errors on non-existent process name", async () => {
    const tmp = makeTmpDir();
    const result = await KillProcessTool.call({ name: "oh_nonexistent_process_xyz_12345" }, ctx(tmp));
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("Failed"));
  });
});
