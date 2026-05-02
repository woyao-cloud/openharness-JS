import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Provider } from "../providers/base.js";
import { createMockProvider, createMockTool, makeTmpDir, textResponseEvents, toolCallEvents } from "../test-helpers.js";
import type { StreamEvent, ToolCallComplete, ToolCallEnd, ToolCallStart, ToolOutputDelta } from "../types/events.js";
import { createAssistantMessage } from "../types/message.js";
import { AgentDispatcher, forwardChildEvent } from "./AgentDispatcher.js";

describe("AgentDispatcher", () => {
  const tools = [createMockTool("Bash")];
  const systemPrompt = "You are a test agent.";

  it("single task executes and returns result", async () => {
    const provider = createMockProvider([textResponseEvents("done")]);
    const tmpDir = makeTmpDir();
    const dispatcher = new AgentDispatcher(provider, tools, systemPrompt, "trust", undefined, tmpDir);
    dispatcher.addTask({ id: "a", prompt: "Say hello" });
    const results = await dispatcher.execute();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "a");
    assert.equal(results[0]!.isError, false);
    assert.ok(results[0]!.durationMs >= 0);
  });

  it("two independent tasks both complete", async () => {
    // Each task needs its own turn of stream events
    const provider = createMockProvider([textResponseEvents("result-1"), textResponseEvents("result-2")]);
    const tmpDir = makeTmpDir();
    const dispatcher = new AgentDispatcher(provider, tools, systemPrompt, "trust", undefined, tmpDir);
    dispatcher.addTasks([
      { id: "x", prompt: "Task X" },
      { id: "y", prompt: "Task Y" },
    ]);
    const results = await dispatcher.execute();
    assert.equal(results.length, 2);
    const ids = results.map((r) => r.id).sort();
    assert.deepEqual(ids, ["x", "y"]);
  });

  it("task with blockedBy waits for blocker to complete", async () => {
    const provider = createMockProvider([textResponseEvents("first-done"), textResponseEvents("second-done")]);
    const tmpDir = makeTmpDir();
    const dispatcher = new AgentDispatcher(provider, tools, systemPrompt, "trust", undefined, tmpDir);
    dispatcher.addTasks([
      { id: "step1", prompt: "Do step 1" },
      { id: "step2", prompt: "Do step 2", blockedBy: ["step1"] },
    ]);
    const results = await dispatcher.execute();
    assert.equal(results.length, 2);
    // step1 should complete before step2
    const step1Idx = results.findIndex((r) => r.id === "step1");
    const step2Idx = results.findIndex((r) => r.id === "step2");
    assert.ok(step1Idx < step2Idx, "step1 should complete before step2");
  });

  it("abort signal stops execution", async () => {
    const ac = new AbortController();
    ac.abort(); // abort immediately
    const provider = createMockProvider([textResponseEvents("never")]);
    const tmpDir = makeTmpDir();
    const dispatcher = new AgentDispatcher(provider, tools, systemPrompt, "trust", undefined, tmpDir, ac.signal);
    dispatcher.addTask({ id: "z", prompt: "Should not run" });
    const results = await dispatcher.execute();
    // With an already-aborted signal, the loop exits immediately
    assert.equal(results.length, 0);
  });

  it("forwards tool_call_start events with parentCallId when emitChildEvent is provided", async () => {
    const captured: Array<ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta> = [];
    const emitChildEvent = (e: ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta) => {
      captured.push(e);
    };
    // Turn 1: tool call (Bash is in tools, will execute and return "Bash executed")
    // Turn 2: text response so the loop completes cleanly
    const provider = createMockProvider([
      toolCallEvents("Bash", { command: "ls" }, "inner-call-1"),
      textResponseEvents("done"),
    ]);
    const tmpDir = makeTmpDir();
    const dispatcher = new AgentDispatcher(
      provider,
      tools,
      systemPrompt,
      "trust",
      undefined,
      tmpDir,
      undefined,
      4,
      "parallel-parent",
      emitChildEvent,
    );
    dispatcher.addTask({ id: "a", prompt: "Run something" });
    const results = await dispatcher.execute();
    assert.equal(results.length, 1);
    // Three events captured now: synthetic Task start, synthetic Task complete, child Bash start
    const taskStart = captured.find((e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName === "Task");
    const childStart = captured.find((e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName === "Bash");
    assert.ok(taskStart, "expected synthetic Task tool_call_start");
    assert.equal(taskStart!.parentCallId, "parallel-parent");
    assert.match(taskStart!.callId, /^task-/);
    assert.ok(childStart, "expected child Bash tool_call_start");
    assert.equal(childStart!.parentCallId, taskStart!.callId);
  });

  it("does not crash when parentCallId and emitChildEvent are undefined", async () => {
    // Turn 1: tool call; Turn 2: text response
    const provider = createMockProvider([
      toolCallEvents("Bash", { command: "ls" }, "inner-call-2"),
      textResponseEvents("done"),
    ]);
    const tmpDir = makeTmpDir();
    // positions 8-10 omitted — no parentCallId, no emitChildEvent
    const dispatcher = new AgentDispatcher(provider, tools, systemPrompt, "trust", undefined, tmpDir);
    dispatcher.addTask({ id: "b", prompt: "Run something" });
    const results = await dispatcher.execute();
    assert.equal(results.length, 1);
    // no crash is the key assertion
  });
});

describe("AgentDispatcher per-task synthetic parents (U-C5b)", () => {
  function makeStubProvider(events: StreamEvent[]): Provider {
    return {
      name: "stub",
      async *stream() {
        for (const e of events) yield e;
      },
      async complete() {
        return createAssistantMessage("");
      },
      listModels() {
        return [];
      },
      async healthCheck() {
        return true;
      },
    };
  }

  it("emits synthetic tool_call_start with toolName=Task before children", async () => {
    const captured: StreamEvent[] = [];
    const dispatcher = new AgentDispatcher(
      makeStubProvider([
        { type: "tool_call_start", toolName: "Read", callId: "child-1" },
        { type: "tool_call_end", callId: "child-1", output: "ok", isError: false },
        { type: "turn_complete", reason: "completed" },
      ]),
      [],
      "test",
      "trust",
      undefined,
      undefined,
      undefined,
      4,
      "parallel-parent",
      (e) => captured.push(e),
    );
    dispatcher.addTask({ id: "task-A", prompt: "test", description: "fetch logs" });
    await dispatcher.execute();

    const taskStart = captured.find((e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName === "Task");
    assert.ok(taskStart, "expected a synthetic Task tool_call_start");
    assert.equal(taskStart!.parentCallId, "parallel-parent");
    assert.match(taskStart!.callId, /^task-task-A-/);

    const childStart = captured.find((e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName === "Read");
    assert.ok(childStart, "expected a child Read tool_call_start");
    assert.equal(childStart!.parentCallId, taskStart!.callId);
  });

  it("emits synthetic tool_call_complete with description in arguments", async () => {
    const captured: StreamEvent[] = [];
    const dispatcher = new AgentDispatcher(
      makeStubProvider([{ type: "turn_complete", reason: "completed" }]),
      [],
      "test",
      "trust",
      undefined,
      undefined,
      undefined,
      4,
      "parallel-parent",
      (e) => captured.push(e),
    );
    dispatcher.addTask({ id: "task-B", prompt: "test", description: "run tests" });
    await dispatcher.execute();

    const completes = captured.filter(
      (e): e is ToolCallComplete => e.type === "tool_call_complete" && e.toolName === "Task",
    );
    assert.equal(completes.length, 1);
    assert.equal(completes[0]!.arguments.description, "run tests");
  });

  it("emits synthetic tool_call_end with isError=true when task errors", async () => {
    const captured: StreamEvent[] = [];
    const dispatcher = new AgentDispatcher(
      makeStubProvider([{ type: "error", message: "boom" }]),
      [],
      "test",
      "trust",
      undefined,
      undefined,
      undefined,
      4,
      "parallel-parent",
      (e) => captured.push(e),
    );
    dispatcher.addTask({ id: "task-C", prompt: "test" });
    await dispatcher.execute();

    const ends = captured.filter((e): e is ToolCallEnd => e.type === "tool_call_end");
    const taskEnd = ends.find((e) => e.parentCallId === "parallel-parent");
    assert.ok(taskEnd, "expected a synthetic Task tool_call_end");
    assert.equal(taskEnd!.isError, true);
    assert.match(taskEnd!.output, /boom|Error/);
  });
});

describe("forwardChildEvent", () => {
  it("returns false and does not call emit when parentCallId is undefined", () => {
    const emitted: unknown[] = [];
    const event: StreamEvent = { type: "tool_call_start", toolName: "Bash", callId: "c1" };
    const result = forwardChildEvent(event, undefined, (e) => emitted.push(e));
    assert.equal(result, false);
    assert.equal(emitted.length, 0);
  });

  it("returns false and does not call emit when emit is undefined", () => {
    const event: StreamEvent = { type: "tool_call_start", toolName: "Bash", callId: "c1" };
    const result = forwardChildEvent(event, "parent-1", undefined);
    assert.equal(result, false);
  });

  it("returns false for non-tool events (e.g. text_delta)", () => {
    const emitted: unknown[] = [];
    const event: StreamEvent = { type: "text_delta", content: "hello" };
    const result = forwardChildEvent(event, "parent-1", (e) => emitted.push(e));
    assert.equal(result, false);
    assert.equal(emitted.length, 0);
  });

  it("stamps parentCallId on tool_call_start and returns true", () => {
    const emitted: Array<ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta> = [];
    const event: StreamEvent = { type: "tool_call_start", toolName: "Bash", callId: "c2" };
    const result = forwardChildEvent(event, "parent-x", (e) => emitted.push(e));
    assert.equal(result, true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.parentCallId, "parent-x");
  });

  it("stamps parentCallId on tool_call_complete and returns true", () => {
    const emitted: Array<ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta> = [];
    const event: StreamEvent = {
      type: "tool_call_complete",
      callId: "c3",
      toolName: "Bash",
      arguments: { command: "ls" },
    };
    const result = forwardChildEvent(event, "parent-y", (e) => emitted.push(e));
    assert.equal(result, true);
    assert.equal(emitted[0]!.parentCallId, "parent-y");
  });

  it("stamps parentCallId on tool_output_delta and returns true", () => {
    const emitted: Array<ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta> = [];
    const event: StreamEvent = { type: "tool_output_delta", callId: "c4", chunk: "chunk1" };
    const result = forwardChildEvent(event, "parent-z", (e) => emitted.push(e));
    assert.equal(result, true);
    assert.equal(emitted[0]!.parentCallId, "parent-z");
  });
});
