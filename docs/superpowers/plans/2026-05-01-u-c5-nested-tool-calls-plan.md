# v2.27.0 "Nested Tool Calls" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `parentCallId?` correlation to `tool_call_*`/`tool_output_delta` events, forward inner-query events from `AgentTool` and `AgentDispatcher` via a new `ToolContext.emitChildEvent` callback, and render the resulting parent-child relationships as a depth-first indented tree in the REPL.

**Architecture:** Reuses the existing `outputChunks` buffer pattern in `src/query/tools.ts` (renamed to `childEvents`, broadened to accept all 4 inner event types). Outer loop drains the buffer when the parent tool returns and yields each event into its own outgoing stream. REPL handlers stamp `parentCallId` into `ToolCallInfo`; renderer walks `state.toolCalls` as a tree and indents children by 4 columns per depth level (depth limit = 3, then a `… (N more levels)` collapse line).

**Tech Stack:** TypeScript, Node test runner (`node:test` + `node:assert/strict`), the project's existing `CellGrid` rendering primitive, no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-01-u-c5-nested-tool-calls-design.md`

**Files created:**
- `src/renderer/tool-tree.ts` (~80 lines)
- `src/renderer/tool-tree.test.ts`

**Files modified:**
- `src/types/events.ts` — extend 4 event types with optional `parentCallId?`
- `src/Tool.ts` — extend `ToolContext` with optional `emitChildEvent?`
- `src/renderer/layout.ts` — extend `ToolCallInfo` with optional `parentCallId?`
- `src/repl.ts` — stamp `parentCallId` in 3 event handlers (`tool_call_start`, `tool_call_complete`, `tool_call_end`)
- `src/query/tools.ts` — rename `outputChunks` → `childEvents`, broaden to accept all 4 event types, set `context.emitChildEvent`
- `src/tools/AgentTool/index.ts` — forward inner-query `tool_call_*` events via `context.emitChildEvent`
- `src/services/AgentDispatcher.ts` — same forwarding pattern in `runTask`
- `src/renderer/layout-sections.ts` — replace flat tool-call iteration with depth-first tree walk + column offsets
- `src/renderer/ui-ux.test.ts` — extend with 4 integration tests

**Behavioral notes:**
- Today's `outputChunks` buffer is drained AFTER the tool returns (`query/tools.ts:390`, `:409`). Plan keeps that pattern — child tool-call events appear in the outer stream when the Agent's `tool_call_end` is yielded, in temporal order. Truly live mid-tool streaming is out of scope; would require Promise.race-style interleaving across the existing `await tool.call(...)`.
- All children of a `ParallelAgents` call stamp `parentCallId = ParallelAgents.callId` (single level under the bundled parent). Per-task synthetic parent calls deferred to v2.28.

---

## Task 1: Type plumbing — add optional `parentCallId` to events + ToolCallInfo, `emitChildEvent` to ToolContext

**Files:**
- Modify: `src/types/events.ts:10-29` (3 event types) and `:69-73` (ToolOutputDelta)
- Modify: `src/Tool.ts:16-32` (ToolContext)
- Modify: `src/renderer/layout.ts:46-56` (ToolCallInfo)

Type-only. No runtime changes; all fields optional. Verifies via `npm run typecheck`.

- [ ] **Step 1: Add `parentCallId?` to ToolCallStart in `src/types/events.ts`**

Replace lines 10-14:

```ts
export type ToolCallStart = {
  readonly type: "tool_call_start";
  readonly toolName: string;
  readonly callId: string;
  readonly parentCallId?: string;
};
```

- [ ] **Step 2: Add `parentCallId?` to ToolCallComplete in `src/types/events.ts`**

Replace lines 16-21:

```ts
export type ToolCallComplete = {
  readonly type: "tool_call_complete";
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly parentCallId?: string;
};
```

- [ ] **Step 3: Add `parentCallId?` to ToolCallEnd in `src/types/events.ts`**

Replace lines 23-29:

```ts
export type ToolCallEnd = {
  readonly type: "tool_call_end";
  readonly callId: string;
  readonly output: string;
  readonly outputType?: "json" | "markdown" | "image" | "plain";
  readonly isError: boolean;
  readonly parentCallId?: string;
};
```

- [ ] **Step 4: Add `parentCallId?` to ToolOutputDelta in `src/types/events.ts`**

Replace lines 69-73:

```ts
export type ToolOutputDelta = {
  readonly type: "tool_output_delta";
  readonly callId: string;
  readonly chunk: string;
  readonly parentCallId?: string;
};
```

- [ ] **Step 5: Add `emitChildEvent?` to ToolContext in `src/Tool.ts`**

After the existing fields in the `ToolContext` type, add:

```ts
import type { ToolCallStart, ToolCallComplete, ToolCallEnd, ToolOutputDelta } from "./types/events.js";
```

(at the top of `src/Tool.ts` if not already present)

Then extend the `ToolContext` type (after line 31's `gitCommitPerTool?`):

```ts
  /** Forward an inner-query tool event to the outer event stream, stamped with the parent's callId. Used by AgentTool and AgentDispatcher to surface nested tool calls. */
  emitChildEvent?: (event: ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta) => void;
```

- [ ] **Step 6: Add `parentCallId?` to ToolCallInfo in `src/renderer/layout.ts`**

In the `ToolCallInfo` type (lines 46-56), add `parentCallId?: string;` (place it adjacent to `output?` and `outputType?` which were added in v2.26):

```ts
export type ToolCallInfo = {
  toolName: string;
  status: "running" | "done" | "error";
  output?: string;
  outputType?: "json" | "markdown" | "image" | "plain";
  parentCallId?: string;
  args?: string;
  isAgent?: boolean;
  agentDescription?: string;
  liveOutput?: string[];
  startedAt?: number;
  resultSummary?: string;
};
```

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors. Optional fields are non-breaking.

- [ ] **Step 8: Commit**

```bash
git add src/types/events.ts src/Tool.ts src/renderer/layout.ts
git commit -m "feat(types): add optional parentCallId to event types + ToolCallInfo + emitChildEvent on ToolContext (U-C5 plumbing)"
```

---

## Task 2: REPL handlers stamp `parentCallId` from event into ToolCallInfo

**Files:**
- Modify: `src/repl.ts:978-1031` (three event handlers)

- [ ] **Step 1: Add `parentCallId` stamping to `tool_call_start` handler**

In `src/repl.ts` around line 978-988, add `parentCallId: event.parentCallId` to the `setToolCall` object literal. Final block reads:

```ts
case "tool_call_start": {
  callIdToToolName.set(event.callId, event.toolName);
  const isAgentTool = event.toolName === "Agent" || event.toolName === "ParallelAgents";
  renderer.setToolCall(event.callId, {
    toolName: event.toolName,
    status: "running",
    startedAt: Date.now(),
    isAgent: isAgentTool,
    parentCallId: event.parentCallId,
  });
  break;
}
```

- [ ] **Step 2: Add `parentCallId` stamping to `tool_call_complete` handler**

Around line 990-1005, add `parentCallId: event.parentCallId` to the `setToolCall` object literal. Final block reads:

```ts
case "tool_call_complete": {
  const tcToolName = callIdToToolName.get(event.callId) ?? "";
  const existingTc = renderer.getToolCall(event.callId);
  const isAgentCall = tcToolName === "Agent" || tcToolName === "ParallelAgents";
  const agentDesc = isAgentCall
    ? ((event.arguments as Record<string, unknown>).description as string | undefined)
    : undefined;
  renderer.setToolCall(event.callId, {
    ...existingTc,
    toolName: tcToolName,
    status: "running",
    args: formatToolArgs(tcToolName, event.arguments),
    agentDescription: agentDesc ?? existingTc?.agentDescription,
    parentCallId: event.parentCallId ?? existingTc?.parentCallId,
  });
  break;
}
```

(`event.parentCallId ?? existingTc?.parentCallId` preserves a previously-stamped parent if the `complete` event omits it, which protects against re-stamping with `undefined`.)

- [ ] **Step 3: Add `parentCallId` stamping to `tool_call_end` handler**

Around line 1024-1031, add `parentCallId: event.parentCallId` to the `setToolCall` object literal. Final block reads:

```ts
case "tool_call_end": {
  const toolName = callIdToToolName.get(event.callId) ?? event.callId;
  const prevTc = renderer.getToolCall(event.callId);
  renderer.setToolCall(event.callId, {
    toolName,
    status: event.isError ? "error" : "done",
    output: event.output?.slice(0, TOOL_OUTPUT_RENDER_CAP),
    outputType: event.outputType,
    parentCallId: event.parentCallId ?? prevTc?.parentCallId,
    args: prevTc?.args,
    resultSummary: event.output ? summarizeToolOutput(event.output) : undefined,
    startedAt: prevTc?.startedAt,
  });
  // ... existing cybergotchi + auto-commit code unchanged ...
  break;
}
```

- [ ] **Step 4: Verify build passes**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/repl.ts
git commit -m "feat(repl): stamp parentCallId from event into ToolCallInfo (U-C5 plumbing)"
```

---

## Task 3: Outer query loop sets `emitChildEvent`, broadens buffer to accept all 4 event types

**Files:**
- Modify: `src/query/tools.ts:367-416` (`executeToolCalls` function)

The existing pattern uses `outputChunks: StreamEvent[]` (line 369) buffered via `onOutputChunk` callback (line 370-372), drained after each tool returns (line 390, 409). This task generalizes the pattern: rename to `childEvents`, broaden to accept tool_call_start / tool_call_complete / tool_call_end / tool_output_delta, and add `emitChildEvent` to the context.

- [ ] **Step 1: Generalize the buffer and add emitChildEvent**

In `src/query/tools.ts`, replace lines 369-372:

```ts
const outputChunks: StreamEvent[] = [];
const onOutputChunk = (callId: string, chunk: string) => {
  outputChunks.push({ type: "tool_output_delta", callId, chunk });
};
```

with:

```ts
const childEvents: StreamEvent[] = [];
const onOutputChunk = (callId: string, chunk: string) => {
  childEvents.push({ type: "tool_output_delta", callId, chunk });
};
const emitChildEvent = (event: StreamEvent) => {
  childEvents.push(event);
};
```

- [ ] **Step 2: Pass `emitChildEvent` into the per-tool ToolContext**

Update both call sites at line 383 and line 404. Replace:

```ts
{ ...context, callId: tc.id, onOutputChunk },
```

with:

```ts
{ ...context, callId: tc.id, onOutputChunk, emitChildEvent },
```

(both occurrences; one inside the `Promise.all` for the concurrent batch, one in the serial loop.)

- [ ] **Step 3: Update the buffer drains to use the renamed variable**

Replace `outputChunks.splice(0)` (lines 390 and 409) with `childEvents.splice(0)`. The `for ... yield` pattern is unchanged.

After both edits, the relevant blocks read:

```ts
// concurrent branch (around line 388-398)
for (const chunk of childEvents.splice(0)) yield chunk;
for (let i = 0; i < batch.calls.length; i++) {
  const tc = batch.calls[i]!;
  const result = results[i]!;
  yield { type: "tool_call_end", callId: tc.id, output: result.output, isError: result.isError };
  // ...
}
```

```ts
// serial branch (around line 408-413)
for (const chunk of childEvents.splice(0)) yield chunk;
yield { type: "tool_call_end", callId: tc.id, output: result.output, isError: result.isError };
```

- [ ] **Step 4: Verify build passes**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/query/tools.ts
git commit -m "feat(query): generalize outputChunks→childEvents buffer + add emitChildEvent context callback (U-C5 plumbing)"
```

---

## Task 4: AgentTool forwards inner-query tool events

**Files:**
- Modify: `src/tools/AgentTool/index.ts:117-122` (foreground inner loop) and `:155-175` (foreground secondary site)
- Modify: `src/tools/AgentTool/index.test.ts` (extend if exists, create otherwise)

The foreground inner-query loop at line 157 currently only consumes `text_delta`, `tool_output_delta`, `error`, and `turn_complete`. Extend it to forward `tool_call_*` and `tool_output_delta` via `context.emitChildEvent`.

The background-execution branch at line 117 intentionally does NOT forward (background detaches from live stream). Keep it as-is.

- [ ] **Step 1: Add forwarding to the foreground inner loop**

In `src/tools/AgentTool/index.ts`, find the `for await (const event of query(...))` loop around line 157. Replace:

```ts
for await (const event of query(input.prompt, { ...config, role: role?.id })) {
  if (event.type === "text_delta") {
    finalText += event.content;
  } else if (event.type === "tool_output_delta") {
    outputChunks.push(event.chunk);
    if (context.onOutputChunk && context.callId) {
      context.onOutputChunk(context.callId, event.chunk);
    }
  } else if (event.type === "error") {
    return { output: `Sub-agent error: ${event.message}`, isError: true };
  } else if (event.type === "turn_complete" && event.reason !== "completed") {
    if (event.reason === "aborted") {
      return { output: finalText || "Sub-agent aborted.", isError: false };
    }
  }
}
```

with:

```ts
for await (const event of query(input.prompt, { ...config, role: role?.id })) {
  if (event.type === "text_delta") {
    finalText += event.content;
  } else if (event.type === "tool_output_delta") {
    outputChunks.push(event.chunk);
    if (context.onOutputChunk && context.callId) {
      context.onOutputChunk(context.callId, event.chunk);
    }
    // Forward to outer stream with parent correlation (U-C5)
    if (context.emitChildEvent && context.callId) {
      context.emitChildEvent({ ...event, parentCallId: context.callId });
    }
  } else if (
    event.type === "tool_call_start" ||
    event.type === "tool_call_complete" ||
    event.type === "tool_call_end"
  ) {
    // Forward inner tool calls with parent correlation (U-C5)
    if (context.emitChildEvent && context.callId) {
      context.emitChildEvent({ ...event, parentCallId: context.callId });
    }
  } else if (event.type === "error") {
    return { output: `Sub-agent error: ${event.message}`, isError: true };
  } else if (event.type === "turn_complete" && event.reason !== "completed") {
    if (event.reason === "aborted") {
      return { output: finalText || "Sub-agent aborted.", isError: false };
    }
  }
}
```

- [ ] **Step 2: Write tests for the forwarding**

Check whether `src/tools/AgentTool/index.test.ts` exists:

```bash
ls src/tools/AgentTool/index.test.ts 2>&1 || echo "does not exist"
```

If it exists, append the tests below. If not, create it with the imports first:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ToolCallEnd, ToolCallStart, ToolOutputDelta, StreamEvent } from "../../types/events.js";
import type { ToolContext } from "../../Tool.js";
import { AgentTool } from "./index.js";
```

Then append (or write) these 3 tests:

```ts
describe("AgentTool inner-event forwarding (U-C5)", () => {
  it("forwards inner tool_call_start with parentCallId stamped", async () => {
    const captured: StreamEvent[] = [];
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      callId: "parent-1",
      emitChildEvent: (event) => captured.push(event),
      // Stub provider/tools so the inner query loop runs but yields a controlled event sequence.
      provider: makeStubProvider([
        { type: "tool_call_start", toolName: "Read", callId: "child-1" },
        { type: "tool_call_end", callId: "child-1", output: "file contents", isError: false },
        { type: "turn_complete", reason: "completed" },
      ]),
      tools: [],
    };
    await AgentTool.call({ prompt: "test" }, ctx);
    const startEvents = captured.filter((e) => e.type === "tool_call_start") as ToolCallStart[];
    assert.equal(startEvents.length, 1);
    assert.equal(startEvents[0]!.callId, "child-1");
    assert.equal(startEvents[0]!.parentCallId, "parent-1");
  });

  it("forwards inner tool_output_delta with parentCallId stamped", async () => {
    const captured: StreamEvent[] = [];
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      callId: "parent-2",
      emitChildEvent: (event) => captured.push(event),
      provider: makeStubProvider([
        { type: "tool_output_delta", callId: "child-2", chunk: "streaming line\n" },
        { type: "turn_complete", reason: "completed" },
      ]),
      tools: [],
    };
    await AgentTool.call({ prompt: "test" }, ctx);
    const deltas = captured.filter((e) => e.type === "tool_output_delta") as ToolOutputDelta[];
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0]!.parentCallId, "parent-2");
  });

  it("does not forward when emitChildEvent is undefined (no crash)", async () => {
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      callId: "parent-3",
      // emitChildEvent intentionally undefined
      provider: makeStubProvider([
        { type: "tool_call_start", toolName: "Read", callId: "child-3" },
        { type: "tool_call_end", callId: "child-3", output: "ok", isError: false },
        { type: "turn_complete", reason: "completed" },
      ]),
      tools: [],
    };
    const result = await AgentTool.call({ prompt: "test" }, ctx);
    assert.equal(result.isError, false);
  });
});

// Stub provider that mocks the query() loop by returning a fixed event sequence.
function makeStubProvider(events: StreamEvent[]) {
  return {
    name: "stub",
    estimateTokens: () => 0,
    getModelInfo: () => ({ contextWindow: 100_000, supportsTools: true }),
    stream: async function* () {
      for (const e of events) yield e;
    },
  } as unknown as import("../../providers/base.js").Provider;
}
```

If the existing test file uses a different stubbing pattern, follow that pattern. If `provider` doesn't have a `stream` method matching what `query()` expects, look at how existing AgentTool tests (or similar tool tests in `src/tools/*.test.ts`) handle the inner query loop.

**If there's no easy way to stub the inner query loop**, replace the 3 unit tests with 1 integration test that uses a real cheap model (e.g., from a fixture or an Ollama smoke test). Document the change in your report — the spec's intent is "forwarding works correctly" and any test that demonstrates that satisfies it.

- [ ] **Step 3: Run tests**

Run: `npx tsx --test src/tools/AgentTool/index.test.ts`
Expected: 3 tests pass (or however many you ended up with after stubbing-strategy adjustments).

- [ ] **Step 4: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/index.ts src/tools/AgentTool/index.test.ts
git commit -m "feat(agent): forward inner-query tool events via emitChildEvent with parent correlation (U-C5)"
```

---

## Task 5: AgentDispatcher forwards inner-query tool events for ParallelAgents

**Files:**
- Modify: `src/services/AgentDispatcher.ts:134-180` (`runTask` method)
- Modify: `src/services/AgentDispatcher.test.ts` (extend with 2 tests)

`AgentDispatcher.runTask` runs an inner query loop per task. Same forwarding pattern as AgentTool. v1 simplification: all tasks' children stamp `parentCallId = ParallelAgents.callId` (passed via the context the dispatcher receives — needs to thread through).

**First, check whether `runTask` currently has access to a parent `callId`.** Read `AgentDispatcher.ts:60-180` and look for how the parent's callId enters the dispatcher. If the constructor or `execute()` doesn't accept it, you'll need to thread it in.

- [ ] **Step 1: Thread parent callId + emitChildEvent into AgentDispatcher**

In `src/services/AgentDispatcher.ts`, extend the constructor signature to accept the new optional fields (around line 39-51):

```ts
constructor(
  private provider: Provider,
  private tools: Tools,
  private systemPrompt: string,
  private permissionMode: PermissionMode,
  private model?: string,
  private workingDir?: string,
  private abortSignal?: AbortSignal,
  maxConcurrency = 4,
  private parentCallId?: string,
  private emitChildEvent?: (event: StreamEvent) => void,
) {
  this.tasks = new Map();
  this.maxConcurrency = maxConcurrency;
}
```

Add the import at the top:

```ts
import type { StreamEvent } from "../types/events.js";
```

- [ ] **Step 2: Forward events from each task's inner query loop**

In `runTask` (around line 134-180), find the inner query consumption loop. If `runTask` currently uses `for await (const event of query(...))`, extend it to call `this.emitChildEvent` for the 4 event types. If it currently consumes events differently (e.g., only collects final text), check what events it sees and add the forwarding alongside.

Pattern to add inside the inner consumption:

```ts
if (this.emitChildEvent && this.parentCallId) {
  if (
    event.type === "tool_call_start" ||
    event.type === "tool_call_complete" ||
    event.type === "tool_call_end" ||
    event.type === "tool_output_delta"
  ) {
    this.emitChildEvent({ ...event, parentCallId: this.parentCallId });
  }
}
```

Place this branch alongside the existing event-type checks; don't remove anything that's already there.

- [ ] **Step 3: Update ParallelAgentTool to pass parent callId + emitChildEvent**

In `src/tools/ParallelAgentTool/index.ts:35-43`, the `AgentDispatcher` constructor call needs to receive the new params. Replace the existing call:

```ts
const dispatcher = new AgentDispatcher(
  context.provider,
  context.tools,
  systemPrompt,
  context.permissionMode ?? "trust",
  context.model,
  context.workingDir,
  context.abortSignal,
);
```

with:

```ts
const dispatcher = new AgentDispatcher(
  context.provider,
  context.tools,
  systemPrompt,
  context.permissionMode ?? "trust",
  context.model,
  context.workingDir,
  context.abortSignal,
  4, // maxConcurrency default
  context.callId,
  context.emitChildEvent,
);
```

- [ ] **Step 4: Add tests to `src/services/AgentDispatcher.test.ts`**

Append:

```ts
describe("AgentDispatcher inner-event forwarding (U-C5)", () => {
  it("forwards each task's inner tool_call_start with parentCallId = ParallelAgents callId", async () => {
    const captured: StreamEvent[] = [];
    const dispatcher = new AgentDispatcher(
      makeStubProvider([
        { type: "tool_call_start", toolName: "Read", callId: "task1-child" },
        { type: "tool_call_end", callId: "task1-child", output: "ok", isError: false },
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
    dispatcher.addTask({ id: "task1", prompt: "test" });
    await dispatcher.execute();
    const starts = captured.filter((e) => e.type === "tool_call_start");
    assert.equal(starts.length, 1);
    assert.equal((starts[0] as ToolCallStart).parentCallId, "parallel-parent");
  });

  it("does not forward when emitChildEvent is undefined", async () => {
    const dispatcher = new AgentDispatcher(
      makeStubProvider([
        { type: "tool_call_start", toolName: "Read", callId: "task2-child" },
        { type: "turn_complete", reason: "completed" },
      ]),
      [],
      "test",
      "trust",
    );
    dispatcher.addTask({ id: "task2", prompt: "test" });
    const results = await dispatcher.execute();
    assert.equal(results.length, 1);
    // No throw, no crash — passes by completing
  });
});
```

(Reuse the `makeStubProvider` helper from Task 4, or copy if test files don't share imports.)

- [ ] **Step 5: Run tests**

Run: `npx tsx --test src/services/AgentDispatcher.test.ts`
Expected: existing tests + 2 new tests pass.

- [ ] **Step 6: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/AgentDispatcher.ts src/services/AgentDispatcher.test.ts src/tools/ParallelAgentTool/index.ts
git commit -m "feat(parallel-agents): forward inner-query tool events with parent correlation (U-C5)"
```

---

## Task 6: Tree builder

**Files:**
- Create: `src/renderer/tool-tree.ts`
- Create: `src/renderer/tool-tree.test.ts`

Pure data structure. Walks the flat `Map<callId, ToolCallInfo>` and produces a depth-first tree. Used by the renderer to indent children under parents.

- [ ] **Step 1: Create `src/renderer/tool-tree.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCallInfo } from "./layout.js";
import { buildToolCallTree } from "./tool-tree.js";

function tc(toolName: string, parentCallId?: string): ToolCallInfo {
  return { toolName, status: "running", parentCallId };
}

describe("buildToolCallTree", () => {
  it("returns empty array for empty map", () => {
    const result = buildToolCallTree(new Map());
    assert.deepEqual(result, []);
  });

  it("returns single root for one call with no parent", () => {
    const m = new Map<string, ToolCallInfo>([["a", tc("Read")]]);
    const result = buildToolCallTree(m);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.callId, "a");
    assert.equal(result[0]!.depth, 0);
    assert.equal(result[0]!.children.length, 0);
  });

  it("renders root with one child indented", () => {
    const m = new Map<string, ToolCallInfo>([
      ["p", tc("Agent")],
      ["c", tc("Read", "p")],
    ]);
    const result = buildToolCallTree(m);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.callId, "p");
    assert.equal(result[0]!.children.length, 1);
    assert.equal(result[0]!.children[0]!.callId, "c");
    assert.equal(result[0]!.children[0]!.depth, 1);
  });

  it("renders root with multiple children in insertion order", () => {
    const m = new Map<string, ToolCallInfo>([
      ["p", tc("Agent")],
      ["c1", tc("Read", "p")],
      ["c2", tc("Bash", "p")],
      ["c3", tc("Edit", "p")],
    ]);
    const result = buildToolCallTree(m);
    assert.equal(result[0]!.children.length, 3);
    assert.deepEqual(
      result[0]!.children.map((n) => n.callId),
      ["c1", "c2", "c3"],
    );
  });

  it("renders multi-level tree (root → child → grandchild)", () => {
    const m = new Map<string, ToolCallInfo>([
      ["p", tc("Agent")],
      ["c", tc("Agent", "p")],
      ["gc", tc("Read", "c")],
    ]);
    const result = buildToolCallTree(m);
    assert.equal(result[0]!.depth, 0);
    assert.equal(result[0]!.children[0]!.depth, 1);
    assert.equal(result[0]!.children[0]!.children[0]!.depth, 2);
    assert.equal(result[0]!.children[0]!.children[0]!.callId, "gc");
  });

  it("treats child whose parent is missing from map as a root (fallback)", () => {
    const m = new Map<string, ToolCallInfo>([
      ["orphan", tc("Read", "missing-parent")],
    ]);
    const result = buildToolCallTree(m);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.callId, "orphan");
    assert.equal(result[0]!.depth, 0);
  });

  it("defends against parent cycles (does not infinite-loop)", () => {
    const m = new Map<string, ToolCallInfo>([
      ["a", tc("Agent", "b")],
      ["b", tc("Agent", "a")],
    ]);
    // Either ordering is acceptable; the important thing is termination + no duplicates
    const result = buildToolCallTree(m);
    const totalNodes = countNodes(result);
    assert.ok(totalNodes <= 2, `expected at most 2 nodes, got ${totalNodes}`);
  });

  it("preserves the ToolCallInfo reference inside each node", () => {
    const info = tc("Read");
    const m = new Map<string, ToolCallInfo>([["a", info]]);
    const result = buildToolCallTree(m);
    assert.strictEqual(result[0]!.call, info);
  });
});

function countNodes(nodes: ReturnType<typeof buildToolCallTree>): number {
  let n = 0;
  for (const node of nodes) {
    n++;
    n += countNodes(node.children);
  }
  return n;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/renderer/tool-tree.test.ts`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Implement `src/renderer/tool-tree.ts`**

```ts
/**
 * Tree builder for tool calls — walks the flat callId map and produces a
 * depth-first parent-child tree for rendering.
 */

import type { ToolCallInfo } from "./layout.js";

export type TreeNode = {
  callId: string;
  call: ToolCallInfo;
  children: TreeNode[];
  depth: number;
};

export function buildToolCallTree(toolCalls: Map<string, ToolCallInfo>): TreeNode[] {
  // Compute children index keyed by parentCallId
  const childrenOf = new Map<string, string[]>();
  const allIds = new Set<string>();
  for (const [callId, info] of toolCalls) {
    allIds.add(callId);
    const parent = info.parentCallId;
    if (parent === undefined) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(callId);
    childrenOf.set(parent, list);
  }

  // Roots: calls with no parent OR parent missing from the map (orphan fallback).
  const roots: string[] = [];
  for (const [callId, info] of toolCalls) {
    const parent = info.parentCallId;
    if (parent === undefined || !allIds.has(parent)) {
      roots.push(callId);
    }
  }

  // Walk depth-first with a seen set for cycle defense.
  const seen = new Set<string>();
  const build = (callId: string, depth: number): TreeNode | null => {
    if (seen.has(callId)) return null;
    seen.add(callId);
    const info = toolCalls.get(callId);
    if (!info) return null;
    const childIds = childrenOf.get(callId) ?? [];
    const children: TreeNode[] = [];
    for (const cid of childIds) {
      const child = build(cid, depth + 1);
      if (child) children.push(child);
    }
    return { callId, call: info, children, depth };
  };

  const result: TreeNode[] = [];
  for (const rootId of roots) {
    const node = build(rootId, 0);
    if (node) result.push(node);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/renderer/tool-tree.test.ts`
Expected: 8 tests pass.

If a test fails on the cycle-defense case (`countNodes <= 2`), check whether `seen` is set BEFORE recursing; the order matters because mutual cycles will revisit during descent.

- [ ] **Step 5: Run lint**

Run: `npm run lint -- src/renderer/tool-tree.ts src/renderer/tool-tree.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/tool-tree.ts src/renderer/tool-tree.test.ts
git commit -m "feat(renderer): add tool-call tree builder with cycle defense and orphan fallback (U-C5)"
```

---

## Task 7: Renderer hierarchical layout

**Files:**
- Modify: `src/renderer/layout-sections.ts:141-242` (`renderToolCallsSection`)

Replace the flat `for (const [callId, tc] of state.toolCalls)` iteration with a depth-first tree walk. Each call's column offset = `depth * 4`. At depth > 3, render `… (N more levels)` collapse line and stop descending.

- [ ] **Step 1: Add import for the tree builder**

Near the top of `src/renderer/layout-sections.ts`, add:

```ts
import { buildToolCallTree, type TreeNode } from "./tool-tree.js";
```

- [ ] **Step 2: Replace the flat iteration with a tree walk**

Find `renderToolCallsSection` (around line 141). The current body iterates `state.toolCalls` directly:

```ts
for (const [callId, tc] of state.toolCalls) {
  // ... ~80 lines of per-call rendering ...
}
return r;
```

Refactor into a recursive helper. New top-level body:

```ts
const tree = buildToolCallTree(state.toolCalls);
const MAX_DEPTH = 3;
const renderNode = (node: TreeNode): void => {
  if (r >= limit) return;
  if (node.depth > MAX_DEPTH) {
    grid.writeText(r, node.depth * 4, `… (${countDescendants(node) + 1} more levels)`, S_DIM);
    r++;
    return;
  }
  renderSingleCall(node.callId, node.call, node.depth);
  for (const child of node.children) renderNode(child);
};
for (const root of tree) renderNode(root);
return r;
```

Then extract the existing per-call body (the original ~80 lines of icon / status / args / output rendering) into `renderSingleCall(callId, tc, depth)`. Every existing `grid.writeText(r, X, ...)` call where X is a column literal (0, 2, 4, 6, etc.) becomes `grid.writeText(r, X + depth * 4, ...)`.

Specific column adjustments inside `renderSingleCall`:
- The ▶/▼ expand glyph at col 0 → col `0 + depth * 4`
- The icon at col 2 → col `2 + depth * 4`
- The tool name at col 4 → col `4 + depth * 4`
- `afterName` calculation starts at `4 + tc.toolName.length + 1 + depth * 4`
- The args text at `afterName` (computed) — no extra adjustment needed; `afterName` already includes `depth * 4`
- Elapsed-time / resultSummary text at `Math.min(afterName, w - elapsedStr.length - 2)` — no adjustment
- `agentDescription` indented block at col 6 → col `6 + depth * 4`
- `liveOutput` lines at col 6 → col `6 + depth * 4`
- The output dispatch via `renderToolOutput(grid, r, 6, tc.output, tc.outputType, w - 8, ...)` → `renderToolOutput(grid, r, 6 + depth * 4, tc.output, tc.outputType, w - 8 - depth * 4, ...)`. Width also reduces by `depth * 4` so the rendered output respects the total available width inside the indent.

Add a helper to count descendants for the collapse-line message:

```ts
function countDescendants(node: TreeNode): number {
  let n = node.children.length;
  for (const c of node.children) n += countDescendants(c);
  return n;
}
```

(Place above `renderToolCallsSection` or as a top-level helper.)

- [ ] **Step 3: Verify build passes**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

If you get a type error on `r` (declared in the outer function but mutated inside `renderNode` closure), use a `let` capture pattern — i.e., define `renderNode` after `r` is declared so it captures by reference, not value.

- [ ] **Step 4: Run existing renderer tests to verify no regressions**

Run: `npx tsx --test src/renderer/ui-ux.test.ts src/renderer/e2e.test.ts`
Expected: All existing tests pass. Tests that don't set `parentCallId` on any ToolCallInfo will see all calls as roots at depth 0 — no column offset, identical to current behavior.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/layout-sections.ts
git commit -m "feat(renderer): walk tool-call tree depth-first with depth-3 indent limit (U-C5)"
```

---

## Task 8: Integration tests in ui-ux.test.ts

**Files:**
- Modify: `src/renderer/ui-ux.test.ts` (extend with 4 integration tests)

End-to-end render tests covering the new tree layout.

- [ ] **Step 1: Add the 4 integration tests at the bottom of `src/renderer/ui-ux.test.ts`**

Append:

```ts
describe("U-C5: nested tool call rendering", () => {
  it("renders Agent parent with one child indented at col 6", () => {
    const parent: ToolCallInfo = {
      toolName: "Agent",
      status: "running",
      isAgent: true,
    };
    const child: ToolCallInfo = {
      toolName: "Read",
      status: "done",
      output: "file contents",
      parentCallId: "p",
    };
    const state = makeState({
      toolCalls: new Map([
        ["p", parent],
        ["c", child],
      ]),
    });
    const grid = new CellGrid(80, 30);
    rasterize(state, grid);
    const text = gridAllText(grid);
    // Parent renders at col 0 with Agent label
    assert.match(text, /Agent/);
    // Child renders at col 4 (depth 1 * 4) — look for "Read" preceded by 4+ spaces
    assert.match(text, /^ {4,}.*Read/m);
  });

  it("renders Agent with multi-level nesting (Agent → Agent → Read)", () => {
    const root: ToolCallInfo = { toolName: "Agent", status: "running", isAgent: true };
    const mid: ToolCallInfo = { toolName: "Agent", status: "running", isAgent: true, parentCallId: "p" };
    const leaf: ToolCallInfo = { toolName: "Read", status: "done", output: "ok", parentCallId: "m" };
    const state = makeState({
      toolCalls: new Map([
        ["p", root],
        ["m", mid],
        ["l", leaf],
      ]),
    });
    const grid = new CellGrid(80, 30);
    rasterize(state, grid);
    const text = gridAllText(grid);
    // Leaf at depth 2 renders at col 8 — look for "Read" preceded by 8+ spaces
    assert.match(text, /^ {8,}.*Read/m);
  });

  it("renders ParallelAgents with all children flat under the bundled parent (v1 simplification)", () => {
    const parent: ToolCallInfo = { toolName: "ParallelAgents", status: "running", isAgent: true };
    const child1: ToolCallInfo = { toolName: "Read", status: "done", output: "a", parentCallId: "p" };
    const child2: ToolCallInfo = { toolName: "Bash", status: "done", output: "b", parentCallId: "p" };
    const state = makeState({
      toolCalls: new Map([
        ["p", parent],
        ["c1", child1],
        ["c2", child2],
      ]),
    });
    const grid = new CellGrid(80, 30);
    rasterize(state, grid);
    const text = gridAllText(grid);
    // Both children render at depth 1 (col 4), siblings under the same parent
    assert.match(text, /^ {4,}.*Read/m);
    assert.match(text, /^ {4,}.*Bash/m);
  });

  it("collapses depth > 3 with '… (N more levels)' marker", () => {
    // 5-level deep chain: a → b → c → d → e
    const calls = new Map<string, ToolCallInfo>([
      ["a", { toolName: "Agent", status: "running", isAgent: true }],
      ["b", { toolName: "Agent", status: "running", isAgent: true, parentCallId: "a" }],
      ["c", { toolName: "Agent", status: "running", isAgent: true, parentCallId: "b" }],
      ["d", { toolName: "Agent", status: "running", isAgent: true, parentCallId: "c" }],
      ["e", { toolName: "Read", status: "done", output: "ok", parentCallId: "d" }],
    ]);
    const state = makeState({ toolCalls: calls });
    const grid = new CellGrid(80, 30);
    rasterize(state, grid);
    const text = gridAllText(grid);
    assert.match(text, /more levels/);
  });
});
```

(`gridAllText`, `makeState`, `rasterize`, `CellGrid` are existing helpers in `ui-ux.test.ts`.)

- [ ] **Step 2: Run tests**

Run: `npx tsx --test src/renderer/ui-ux.test.ts`
Expected: all existing tests + 4 new "U-C5" tests pass.

If any test fails because the col-N indentation isn't matching (e.g., the regex `/^ {4,}.*Read/m` finds 0 matches), inspect the actual rendered grid via `console.log(gridAllText(grid))` inside the failing test — the depth-multiplier or column-offset calculation may need adjustment.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ui-ux.test.ts
git commit -m "test(renderer): integration tests for nested tool-call tree rendering (U-C5)"
```

---

## Task 9: Run full suite + smoke test + manual verification

**Files:** none modified. Verification only.

- [ ] **Step 1: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

- [ ] **Step 2: Full test suite**

Run: `npm run test:cli`
Expected: ~1487 passing (was 1465; +22 expected — 8 tree builder + 3 AgentTool + 2 AgentDispatcher + 4 ui-ux + 5 buffer overhead). If the count differs by a few, that's fine.

- [ ] **Step 3: SDK smoke test (regression check, optional if no Ollama)**

Run: `node packages/sdk/test/smoke/smoke.mjs`
Expected: passes if Ollama is available locally. Skip if not — pure renderer change should not affect SDK behavior.

- [ ] **Step 4: Manual REPL smoke (~3 min)**

Build and launch:
```bash
npm run build
node dist/main.js
```

In the REPL:
1. Trigger an `Agent` call with a sub-prompt that runs `Read` then `Bash`. Observe the child `Read` and `Bash` lines indented under the `Agent` parent when the agent finishes.
2. Trigger a `ParallelAgents` call with 2 simple tasks. Observe child tool calls from both tasks rendered indented under the single `ParallelAgents` parent (v1: no per-task grouping).
3. Trigger a deeply-nested Agent (Agent → Agent → Agent → Read) by prompting the model to spawn sub-agents recursively. Observe `… (N more levels)` collapse line at depth 4.
4. Trigger a normal (non-Agent) tool like `Read` or `Bash`. Observe it renders at col 0/2/4 with no indentation (depth 0, no offset).

If any smoke check renders incorrectly, fix before proceeding to release.

---

## Self-review

Spec coverage check:

| Spec section | Task |
|---|---|
| Component 1 (type plumbing) | Task 1 |
| Component 2 (outer query loop wires emitChildEvent) | Task 3 |
| Component 3 (AgentTool inner-event forwarding) | Task 4 |
| Component 4 (AgentDispatcher inner-event forwarding) | Task 5 |
| Component 5 (REPL handler stamps parentCallId) | Task 2 |
| Component 6 (renderer hierarchical layout) | Tasks 6 + 7 |
| Data flow | Tasks 1, 2, 3, 4, 5, 7 (end-to-end) |
| Error handling (cycle, orphan, depth limit, missing emitChildEvent) | Tasks 6 (tree builder), 4 + 5 (forwarding guards), 7 (depth limit) |
| Testing matrix (~22 tests) | Tasks 4, 5, 6, 8 |
| Build sequence | Task ordering 1→2→3→4→5→6→7→8→9 |
| Verification (multi-level, depth-limit, ParallelAgents, race defense, manual REPL) | Tasks 6, 7, 8, 9 |

**Plan-review note:** the spec said "live streaming visibility — child calls appear live as they fire under the parent." That was over-optimistic. The actual `outputChunks` buffer in `query/tools.ts` is drained after each tool returns (lines 390, 409); children appear in the outer stream when the Agent's `tool_call_end` is yielded, in temporal order — but not mid-tool-execution. Truly live mid-tool streaming would require a `Promise.race`-style interleaving across the existing `await tool.call(...)` and is out of scope for v2.27. Plan reflects the realistic mechanism.

**Type consistency check:** `parentCallId?: string` — same name, same type across all 6 places (3 events + ToolOutputDelta + ToolCallInfo + ToolContext.emitChildEvent's event union). `emitChildEvent?: (event: ...) => void` — consistent signature. `TreeNode` shape used in tool-tree.ts and consumed by layout-sections.ts identically.
