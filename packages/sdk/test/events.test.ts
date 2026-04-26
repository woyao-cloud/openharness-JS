import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { parseEvent } from "../src/events.js";

describe("parseEvent", () => {
  test("text", () => {
    assert.deepEqual(parseEvent({ type: "text", content: "hi" }), {
      type: "text",
      content: "hi",
    });
  });

  test("text with missing content defaults to empty string", () => {
    assert.deepEqual(parseEvent({ type: "text" }), {
      type: "text",
      content: "",
    });
  });

  test("tool_start", () => {
    assert.deepEqual(parseEvent({ type: "tool_start", tool: "Read" }), {
      type: "tool_start",
      tool: "Read",
    });
  });

  test("tool_end", () => {
    assert.deepEqual(parseEvent({ type: "tool_end", tool: "Read", output: "ok", error: false }), {
      type: "tool_end",
      tool: "Read",
      output: "ok",
      error: false,
    });
  });

  test("error", () => {
    assert.deepEqual(parseEvent({ type: "error", message: "boom" }), {
      type: "error",
      message: "boom",
    });
  });

  test("cost_update parses numeric fields", () => {
    assert.deepEqual(
      parseEvent({
        type: "cost_update",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.0025,
        model: "claude-sonnet-4-6",
      }),
      {
        type: "cost_update",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.0025,
        model: "claude-sonnet-4-6",
      },
    );
  });

  test("cost_update tolerates missing fields with sane defaults", () => {
    assert.deepEqual(parseEvent({ type: "cost_update" }), {
      type: "cost_update",
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      model: "",
    });
  });

  test("turn_complete defaults reason to 'completed'", () => {
    assert.deepEqual(parseEvent({ type: "turn_complete" }), {
      type: "turn_complete",
      reason: "completed",
    });
  });

  test("turnStart and turnStop preserve camelCase wire fields", () => {
    assert.deepEqual(parseEvent({ type: "turnStart", turnNumber: 3 }), {
      type: "turnStart",
      turnNumber: 3,
    });
    assert.deepEqual(parseEvent({ type: "turnStop", turnNumber: 3, reason: "max_turns" }), {
      type: "turnStop",
      turnNumber: 3,
      reason: "max_turns",
    });
  });

  test("hook_decision normalises tool/reason nullability", () => {
    assert.deepEqual(
      parseEvent({
        type: "hook_decision",
        event: "permissionRequest",
        tool: "Bash",
        decision: "deny",
        reason: "policy",
      }),
      {
        type: "hook_decision",
        event: "permissionRequest",
        tool: "Bash",
        decision: "deny",
        reason: "policy",
      },
    );
    assert.deepEqual(
      parseEvent({ type: "hook_decision", event: "permissionRequest", decision: "allow" }),
      {
        type: "hook_decision",
        event: "permissionRequest",
        tool: null,
        decision: "allow",
        reason: null,
      },
    );
  });

  test("ready and session_start both map to SessionStart", () => {
    assert.deepEqual(parseEvent({ type: "ready", sessionId: "abc-123" }), {
      type: "session_start",
      sessionId: "abc-123",
    });
    assert.deepEqual(parseEvent({ type: "session_start", sessionId: "" }), {
      type: "session_start",
      sessionId: null,
    });
    assert.deepEqual(parseEvent({ type: "session_start" }), {
      type: "session_start",
      sessionId: null,
    });
  });

  test("unrecognised type becomes UnknownEvent with raw payload", () => {
    const result = parseEvent({ type: "future_event_v3", someField: 42 });
    assert.equal(result.type, "unknown");
    if (result.type === "unknown") {
      assert.deepEqual(result.raw, { type: "future_event_v3", someField: 42 });
    }
  });
});
