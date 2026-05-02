/**
 * Unit tests for AgentTool inner-event forwarding (Task 4, v2.27.0 U-C5).
 *
 * Strategy: Option A — test the exported `forwardInnerEvent` helper directly
 * with synthetic events. This avoids having to stub the complex `query()` async
 * generator (which composes provider, tools, system prompt, compression, etc.),
 * while still verifying all four forwarding-event types, parentCallId stamping,
 * and the guard behaviour when emitChildEvent / callId are absent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolContext } from "../../Tool.js";
import type { StreamEvent } from "../../types/events.js";
import { forwardInnerEvent } from "./index.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal ToolContext with emitChildEvent wired up.
// ---------------------------------------------------------------------------
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext & { captured: StreamEvent[] } {
  const captured: StreamEvent[] = [];
  return {
    workingDir: process.cwd(),
    callId: "parent-call-1",
    emitChildEvent: (ev) => captured.push(ev),
    captured,
    ...overrides,
  } as ToolContext & { captured: StreamEvent[] };
}

// ---------------------------------------------------------------------------
// Tests: forwarding of the four event types.
// ---------------------------------------------------------------------------

describe("forwardInnerEvent — forwarding logic", () => {
  it("forwards tool_call_start with parentCallId stamped", () => {
    const ctx = makeCtx();
    const event: StreamEvent = {
      type: "tool_call_start",
      toolName: "BashTool",
      callId: "inner-1",
    };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, true);
    assert.equal(ctx.captured.length, 1);
    const captured = ctx.captured[0] as typeof event & { parentCallId?: string };
    assert.equal(captured.type, "tool_call_start");
    assert.equal(captured.parentCallId, "parent-call-1");
    assert.equal(captured.callId, "inner-1");
  });

  it("forwards tool_call_complete with parentCallId stamped", () => {
    const ctx = makeCtx();
    const event: StreamEvent = {
      type: "tool_call_complete",
      callId: "inner-2",
      toolName: "BashTool",
      arguments: { command: "ls" },
    };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, true);
    assert.equal(ctx.captured.length, 1);
    const captured = ctx.captured[0] as typeof event & { parentCallId?: string };
    assert.equal(captured.type, "tool_call_complete");
    assert.equal(captured.parentCallId, "parent-call-1");
  });

  it("forwards tool_call_end with parentCallId stamped", () => {
    const ctx = makeCtx();
    const event: StreamEvent = {
      type: "tool_call_end",
      callId: "inner-3",
      output: "hello",
      isError: false,
    };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, true);
    assert.equal(ctx.captured.length, 1);
    const captured = ctx.captured[0] as typeof event & { parentCallId?: string };
    assert.equal(captured.type, "tool_call_end");
    assert.equal(captured.parentCallId, "parent-call-1");
    assert.equal((captured as any).output, "hello");
  });

  it("forwards tool_output_delta with parentCallId stamped", () => {
    const ctx = makeCtx();
    const event: StreamEvent = {
      type: "tool_output_delta",
      callId: "inner-4",
      chunk: "streaming chunk",
    };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, true);
    assert.equal(ctx.captured.length, 1);
    const captured = ctx.captured[0] as typeof event & { parentCallId?: string };
    assert.equal(captured.type, "tool_output_delta");
    assert.equal(captured.parentCallId, "parent-call-1");
    assert.equal((captured as any).chunk, "streaming chunk");
  });

  it("does NOT forward text_delta (returns false)", () => {
    const ctx = makeCtx();
    const event: StreamEvent = { type: "text_delta", content: "hello" };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, false);
    assert.equal(ctx.captured.length, 0);
  });

  it("does NOT forward error events (returns false)", () => {
    const ctx = makeCtx();
    const event: StreamEvent = { type: "error", message: "boom" };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, false);
    assert.equal(ctx.captured.length, 0);
  });

  it("does nothing and returns false when emitChildEvent is absent", () => {
    const ctx = makeCtx({ emitChildEvent: undefined });
    const event: StreamEvent = {
      type: "tool_call_start",
      toolName: "BashTool",
      callId: "inner-5",
    };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, false);
    assert.equal(ctx.captured.length, 0);
  });

  it("does nothing and returns false when callId is absent", () => {
    const ctx = makeCtx({ callId: undefined });
    const event: StreamEvent = {
      type: "tool_call_start",
      toolName: "BashTool",
      callId: "inner-6",
    };
    const forwarded = forwardInnerEvent(event, ctx);
    assert.equal(forwarded, false);
    assert.equal(ctx.captured.length, 0);
  });

  it("preserves inner-stamped parentCallId (Agent → Agent → Read keeps grandchild's depth)", () => {
    const ctx = makeCtx({ callId: "outer-A" });
    const event: StreamEvent = {
      type: "tool_call_end",
      callId: "inner-grandchild",
      output: "result",
      isError: false,
      parentCallId: "inner-B",
    };
    forwardInnerEvent(event, ctx);
    const captured = ctx.captured[0] as typeof event;
    assert.equal(captured.parentCallId, "inner-B");
  });

  it("falls back to context.callId when event has no parentCallId", () => {
    const ctx = makeCtx({ callId: "outer-A" });
    const event: StreamEvent = {
      type: "tool_call_end",
      callId: "inner-direct-child",
      output: "result",
      isError: false,
    };
    forwardInnerEvent(event, ctx);
    const captured = ctx.captured[0] as typeof event;
    assert.equal(captured.parentCallId, "outer-A");
  });
});

// ---------------------------------------------------------------------------
// Guard test: AgentTool.call() returns early when no provider is in context.
// (Tests the top-of-function guard, not the forwarding path.)
// ---------------------------------------------------------------------------
describe("AgentTool.call() — no-provider guard", () => {
  it("returns error when provider is not in context", async () => {
    const { AgentTool } = await import("./index.js");
    const result = await AgentTool.call({ prompt: "hello" }, { workingDir: process.cwd() });
    assert.equal(result.isError, true);
    assert.ok(result.output.includes("provider"));
  });
});
