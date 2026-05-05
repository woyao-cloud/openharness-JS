/**
 * Lock-in tests for the ACP bridge — the StreamEvent → session/update
 * translation layer that's the load-bearing piece of `oh acp`.
 *
 * We test the pure-function `bridgeStreamEventToAcp` and `extractPromptText`
 * directly, without loading the SDK. The full agent wired via `createAcpAgent`
 * is covered by an integration smoke test that uses a fake connection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bridgeStreamEventToAcp, createAcpAgent, extractPromptText } from "./agent.js";

const SID = "test-session";

describe("bridgeStreamEventToAcp — OH StreamEvent → ACP session/update", () => {
  it("text_delta → agent_message_chunk { type: text }", () => {
    const out = bridgeStreamEventToAcp({ type: "text_delta", content: "hello" }, SID);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sessionId, SID);
    assert.equal(out[0]!.update.sessionUpdate, "agent_message_chunk");
    assert.deepEqual(out[0]!.update.content, { type: "text", text: "hello" });
  });

  it("thinking_delta → agent_thought_chunk (separate channel from message)", () => {
    const out = bridgeStreamEventToAcp({ type: "thinking_delta", content: "internal monologue" }, SID);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.update.sessionUpdate, "agent_thought_chunk");
    assert.deepEqual(out[0]!.update.content, { type: "text", text: "internal monologue" });
  });

  it("tool_call_start → tool_call { status: pending } with derived kind", () => {
    const out = bridgeStreamEventToAcp({ type: "tool_call_start", toolName: "Read", callId: "c1" }, SID);
    assert.equal(out.length, 1);
    const u = out[0]!.update;
    assert.equal(u.sessionUpdate, "tool_call");
    assert.equal(u.toolCallId, "c1");
    assert.equal(u.title, "Read");
    assert.equal(u.kind, "read");
    assert.equal(u.status, "pending");
  });

  it("tool_call_complete → tool_call_update { status: in_progress, rawInput }", () => {
    const out = bridgeStreamEventToAcp(
      { type: "tool_call_complete", toolName: "Bash", callId: "c2", arguments: { command: "ls" } },
      SID,
    );
    assert.equal(out.length, 1);
    const u = out[0]!.update;
    assert.equal(u.sessionUpdate, "tool_call_update");
    assert.equal(u.toolCallId, "c2");
    assert.equal(u.status, "in_progress");
    assert.deepEqual(u.rawInput, { command: "ls" });
  });

  it("tool_call_end (success) → tool_call_update { status: completed, content: text }", () => {
    const out = bridgeStreamEventToAcp(
      { type: "tool_call_end", callId: "c3", output: "file contents", isError: false },
      SID,
    );
    const u = out[0]!.update;
    assert.equal(u.status, "completed");
    assert.deepEqual(u.content, [{ type: "content", content: { type: "text", text: "file contents" } }]);
  });

  it("tool_call_end (error) → tool_call_update { status: failed }", () => {
    const out = bridgeStreamEventToAcp(
      { type: "tool_call_end", callId: "c4", output: "permission denied", isError: true },
      SID,
    );
    assert.equal(out[0]!.update.status, "failed");
  });

  it("kind derivation — Read/Edit/Bash/Glob/WebFetch/Memory hit the right ACP buckets", () => {
    const cases: Array<[string, string]> = [
      ["Read", "read"],
      ["Edit", "edit"],
      ["Write", "edit"],
      ["MultiEdit", "edit"],
      ["NotebookEdit", "edit"],
      ["Bash", "execute"],
      ["PowerShell", "execute"],
      ["KillProcess", "execute"],
      ["Glob", "search"],
      ["Grep", "search"],
      ["LS", "search"],
      ["WebFetch", "fetch"],
      ["WebSearch", "fetch"],
      ["ExaSearch", "fetch"],
      ["TodoWrite", "think"],
      ["Memory", "think"],
      ["TotallyMadeUpTool", "other"],
    ];
    for (const [tool, kind] of cases) {
      const [out] = bridgeStreamEventToAcp({ type: "tool_call_start", toolName: tool, callId: "c" }, SID);
      assert.equal(out!.update.kind, kind, `${tool} should map to ${kind}, got ${out!.update.kind}`);
    }
  });

  it("events without ACP equivalents return [] (cost_update / turn_complete / error / rate_limited / permission_request / ask_user / tool_output_delta)", () => {
    const noOpEvents = [
      { type: "cost_update", inputTokens: 1, outputTokens: 1, cost: 0.001, model: "m" },
      { type: "turn_complete", reason: "end_turn" },
      { type: "error", message: "boom" },
      { type: "rate_limited", retryIn: 5, attempt: 1 },
      { type: "permission_request", toolName: "Bash", callId: "c", description: "x", riskLevel: "high" },
      { type: "ask_user", callId: "c", question: "are you sure?" },
      { type: "tool_output_delta", callId: "c", chunk: "partial output" },
    ] as const;
    for (const event of noOpEvents) {
      assert.deepEqual(bridgeStreamEventToAcp(event, SID), [], `${event.type} should produce no ACP update`);
    }
  });
});

describe("extractPromptText — ACP ContentBlock[] → OH prompt string", () => {
  it("concatenates text blocks with double-newline separators", () => {
    const text = extractPromptText([
      { type: "text", text: "First paragraph." },
      { type: "text", text: "Second paragraph." },
    ]);
    assert.equal(text, "First paragraph.\n\nSecond paragraph.");
  });

  it("surfaces resource_link blocks as [resource: <uri>] markers", () => {
    const text = extractPromptText([
      { type: "text", text: "Look at this file:" },
      { type: "resource_link", uri: "file:///src/foo.ts" },
    ]);
    assert.equal(text, "Look at this file:\n\n[resource: file:///src/foo.ts]");
  });

  it("handles embedded resource blocks gracefully", () => {
    const text = extractPromptText([{ type: "resource", resource: { uri: "file:///bar.ts", text: "..." } }]);
    assert.equal(text, "[resource: file:///bar.ts]");
  });

  it("ignores unknown block types rather than throwing", () => {
    const text = extractPromptText([
      { type: "text", text: "hi" },
      { type: "image", data: "base64..." } as { type: string; [k: string]: unknown },
    ]);
    assert.equal(text, "hi");
  });

  it("empty prompt array returns empty string", () => {
    assert.equal(extractPromptText([]), "");
  });
});

describe("createAcpAgent — full lifecycle with a fake connection", () => {
  it("initialize returns protocolVersion + agentCapabilities", async () => {
    const updates: unknown[] = [];
    const fakeConn = { sessionUpdate: async (u: unknown) => void updates.push(u) };
    const agent = createAcpAgent(fakeConn, { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = (await agent.initialize({})) as { protocolVersion: number; agentCapabilities: unknown };
    assert.equal(result.protocolVersion, 1);
    assert.deepEqual(result.agentCapabilities, { loadSession: false });
  });

  it("newSession returns a UUID-shaped sessionId", async () => {
    const fakeConn = { sessionUpdate: async () => {} };
    const agent = createAcpAgent(fakeConn, { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = (await agent.newSession({})) as { sessionId: string };
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/, "sessionId should be UUID-formatted");
  });

  it("authenticate returns empty object (OH resolves credentials its own way)", async () => {
    const fakeConn = { sessionUpdate: async () => {} };
    const agent = createAcpAgent(fakeConn, { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = await agent.authenticate({});
    assert.deepEqual(result, {});
  });

  it("setSessionMode is a no-op success", async () => {
    const fakeConn = { sessionUpdate: async () => {} };
    const agent = createAcpAgent(fakeConn, { provider: "anthropic", model: "claude-sonnet-4-6" });
    const result = await agent.setSessionMode({});
    assert.deepEqual(result, {});
  });

  it("prompt with unknown sessionId throws", async () => {
    const fakeConn = { sessionUpdate: async () => {} };
    const agent = createAcpAgent(fakeConn, { provider: "anthropic", model: "claude-sonnet-4-6" });
    await assert.rejects(
      () => agent.prompt({ sessionId: "never-created", prompt: [{ type: "text", text: "hi" }] }),
      /Session never-created not found/,
    );
  });

  it("cancel on unknown sessionId is a silent no-op", async () => {
    const fakeConn = { sessionUpdate: async () => {} };
    const agent = createAcpAgent(fakeConn, { provider: "anthropic", model: "claude-sonnet-4-6" });
    // Should not throw.
    await agent.cancel({ sessionId: "never-existed" });
  });
});
