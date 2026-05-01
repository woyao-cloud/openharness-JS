# v2.27.0 "Nested Tool Calls" — Design Spec

**Date:** 2026-05-01
**Status:** Draft
**Tier:** U-C5 (UI/UX-parity plan, `~/.claude/plans/2-typescript-sdk-moonlit-hinton.md`)
**Target release:** v2.27.0 — single PR, ~3-4 days

## Context

v2.26.0 (shipped 2026-05-01) closed Tier U-C4. U-C5 (nested tool-call display: child tool calls indented under their spawning Agent / ParallelAgents parent) is the last item in the audit.

Current state: when `AgentTool.call()` runs an inner `query()` loop and the sub-agent calls `Read` / `Bash` / etc., those `tool_call_*` events stay inside the inner loop. The outer REPL only sees the parent `Agent` call's start and end. `tool_output_delta` is the only inner event type currently forwarded (via `context.onOutputChunk` for live text streaming).

**Grep-first findings:**
- `parentCallId` does not exist anywhere in the source tree. Confirmed genuine new infrastructure (not already-built-but-unwired).
- `src/harness/traces.ts` already implements full OTel-style observability with `spanId` / `parentSpanId` — but it's a **separate layer** from `StreamEvent`. Tracing is durable and exportable; StreamEvent is the live UI feed. U-C5 is specifically about adding parent correlation to the live event layer, where it doesn't yet exist.
- `ToolCallInfo` already has `isAgent?: boolean` and `agentDescription?: string` fields; the renderer special-cases Agent calls with `⊕`/`◈`/`◇` icons and renders `agentDescription` indented at col 6. Visual scaffolding for hierarchy is partially built — extending it for nested children is incremental work.
- 9th grep-first hit across the audit cycle. The traces.ts pattern is the relevant existing infrastructure that confirms the architectural choice.

## Goals

1. **Parent correlation on the live event stream.** Add optional `parentCallId?: string` to `tool_call_start`, `tool_call_complete`, `tool_call_end`, and `tool_output_delta` events. All other StreamEvent types unchanged.
2. **AgentTool inner-event forwarding.** Inner query loop's `tool_call_*` events forwarded to outer stream via a new `ToolContext.emitChildEvent` callback, stamped with `parentCallId = context.callId`.
3. **ParallelAgentTool / AgentDispatcher inner-event forwarding.** Same pattern. v1 simplification: all children stamp `parentCallId = ParallelAgents.callId` (single level of nesting under the bundled call).
4. **Hierarchical rendering.** `renderToolCallsSection` walks `state.toolCalls` as a tree (parent → children), indents children by 4 columns per depth level, applies a depth limit of 3 with a `… (N more levels)` collapse line.

## Non-goals

- **Per-task synthetic parent calls under ParallelAgents.** Would give 2 levels of structure (`ParallelAgents → task → child tool`) instead of v1's single level. ~1 extra day. Deferred to v2.28 if user demand is real. Not blocking the audit closure.
- **Tree connector glyphs (`├─` / `└─` / `│`).** Indentation alone is the convention chosen; connectors look great in dedicated tree widgets but add visual noise in a streaming live-update render where lines come and go. Easier to skip than to add and regret.
- **Collapsible/expandable tree nodes.** All children render visible by default. Toggle UX (e.g., click parent to collapse children) deferred until users ask.
- **Migration of `tool_output_delta`'s existing `onOutputChunk` path.** The new `emitChildEvent` is additive; the existing per-call `liveOutput` rendering keeps working. Cleanup of the old path can come in a future release once `emitChildEvent` is verified in production.
- **Background-agent (`run_in_background: true`) child events.** Background agents intentionally detach from the live stream; their inner events stay invisible to the outer REPL. Their summary surfaces via the existing `[background:<id> completed]` mechanism.

## Approach

**Three approaches considered:**

| Approach | Mechanism | Trade-off |
|---|---|---|
| **(A1) Direct event passthrough** ✅ chosen | AgentTool's inner loop calls `context.emitChildEvent(event)`; outer loop yields stamped events into its own stream | Streaming visibility preserved; one uniform event protocol; matches OH's existing `tool_output_delta` plumbing pattern |
| (A2) Bundled snapshot | AgentTool collects child calls internally; emits `agent_summary` event at end | Cleaner outer stream during execution but loses live streaming — Agent looks frozen until completion. New event type. Diverges from OH's "everything streams" pattern. |
| (A3) Separate child stream | AgentTool exposes a child event channel; renderer subscribes to it explicitly | Maximum architectural purity; significant overhead — two event channels to maintain; over-engineering for this scope. |

A1 wins because it matches OH's existing pattern (`tool_output_delta` already flows from inner to outer via the same `context` object), preserves streaming visibility, and adds the smallest delta from current architecture. The alignment with `traces.ts`'s existing OTel-style `parentSpanId` shape is a confirming signal — both layers use the same parent-correlation idea, just on different objects (TraceSpan for durable observability, ToolCallInfo for live render state).

## Component design

### Component 1 — Type plumbing

**Four event types extended, one ToolContext field added, one ToolCallInfo field added.** All optional, all non-breaking.

```ts
// src/types/events.ts
export type ToolCallStart = {
  readonly type: "tool_call_start";
  readonly toolName: string;
  readonly callId: string;
  readonly parentCallId?: string;        // NEW
};

export type ToolCallComplete = {
  readonly type: "tool_call_complete";
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly parentCallId?: string;        // NEW
};

export type ToolCallEnd = {
  readonly type: "tool_call_end";
  readonly callId: string;
  readonly output: string;
  readonly outputType?: "json" | "markdown" | "image" | "plain";
  readonly isError: boolean;
  readonly parentCallId?: string;        // NEW
};

export type ToolOutputDelta = {
  readonly type: "tool_output_delta";
  readonly callId: string;
  readonly chunk: string;
  readonly parentCallId?: string;        // NEW
};

// src/Tool.ts
export type ToolContext = {
  workingDir: string;
  abortSignal?: AbortSignal;
  callId?: string;
  // ...existing fields unchanged
  emitChildEvent?: (event: ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta) => void;  // NEW
};

// src/renderer/layout.ts
export type ToolCallInfo = {
  toolName: string;
  status: "running" | "done" | "error";
  output?: string;
  outputType?: "json" | "markdown" | "image" | "plain";
  parentCallId?: string;                  // NEW
  // ...existing fields unchanged
};
```

### Component 2 — Outer query loop wires the callback

`src/query/tools.ts` `executeSingleTool` (around line 88+ where `ToolContext` is constructed) — set `emitChildEvent` to a function that pushes events into the outer loop's outgoing iterator. Exact wiring depends on the outer loop's structure (queue-backed async generator vs simple `for await`); will be determined at implementation time. Two viable patterns:

- **Pattern (a) — direct queue push.** If the outer loop is a queue-backed async generator, `emitChildEvent` pushes directly into the queue. Live streaming straightforward.
- **Pattern (b) — buffer and interleave.** If not, `emitChildEvent` pushes into a buffer; the outer loop interleaves buffered events with its own event sources via `Promise.race`. Slight refactor.

Both deliver the same outward behavior. Implementation picks based on existing code shape.

### Component 3 — AgentTool inner-event forwarding

`src/tools/AgentTool/index.ts` — extend the existing inner-query consumption loop (lines 117 and 157) to forward `tool_call_*` events:

```ts
for await (const event of query(input.prompt, { ...config, role: role?.id })) {
  if (event.type === "text_delta") {
    finalText += event.content;
  } else if (event.type === "tool_output_delta") {
    outputChunks.push(event.chunk);
    if (context.onOutputChunk && context.callId) {
      context.onOutputChunk(context.callId, event.chunk);
    }
    if (context.emitChildEvent) context.emitChildEvent(event);                    // NEW
  } else if (
    event.type === "tool_call_start" ||
    event.type === "tool_call_complete" ||
    event.type === "tool_call_end"
  ) {
    if (context.emitChildEvent) context.emitChildEvent(event);                    // NEW
  } else if (event.type === "error") {
    return { output: `Sub-agent error: ${event.message}`, isError: true };
  } else if (event.type === "turn_complete" && event.reason !== "completed") {
    if (event.reason === "aborted") return { output: finalText || "Sub-agent aborted.", isError: false };
  }
}
```

The existing `onOutputChunk` path stays for backward compatibility — parent's `liveOutput` rendering still works. The `emitChildEvent` call is additive.

The same loop change applies to AgentTool's `run_in_background` branch (lines 114-138) — but that branch intentionally doesn't forward (background detaches from live stream). Preserved as-is.

### Component 4 — AgentDispatcher inner-event forwarding (ParallelAgents)

`src/services/AgentDispatcher.ts` — wherever each task's inner query loop runs. Same forwarding pattern:

```ts
for await (const event of query(task.prompt, taskConfig)) {
  // ...existing handling
  if (
    event.type === "tool_call_start" ||
    event.type === "tool_call_complete" ||
    event.type === "tool_call_end" ||
    event.type === "tool_output_delta"
  ) {
    if (context.emitChildEvent) context.emitChildEvent(event);
  }
}
```

**v1 simplification:** all child events from all tasks stamp `parentCallId = ParallelAgents.callId` (whatever `context.callId` is). Per-task grouping is lost — children render flat under the single ParallelAgents parent. v2.28 follow-up can synthesize per-task `tool_call_start`/`end` events as virtual middle layer.

### Component 5 — REPL handler stamps `parentCallId`

`src/repl.ts` — three event handlers (`tool_call_start` around line 970+, `tool_call_complete` similar, `tool_call_end` at line 1024). Each adds `parentCallId: event.parentCallId` to the `setToolCall` object literal. Three two-line additions.

### Component 6 — Renderer hierarchical layout

**New file:** `src/renderer/tool-tree.ts` (~80 lines)

```ts
export type TreeNode = {
  callId: string;
  call: ToolCallInfo;
  children: TreeNode[];
  depth: number;
};

export function buildToolCallTree(toolCalls: Map<string, ToolCallInfo>): TreeNode[];
//   roots = calls with no parentCallId (or parentCallId not present in the map)
//   each node walks children depth-first
//   maintains seen set for cycle defense
```

**Wiring:** `src/renderer/layout-sections.ts:renderToolCallsSection` (around lines 141-242). Replace the flat `for (const [callId, tc] of state.toolCalls)` iteration with a tree walk. For each node:

- Compute column offset: `colOffset = node.depth * 4`
- All existing `grid.writeText(r, 0/2/4, ...)` calls become `grid.writeText(r, 0+colOffset, ...)` etc.
- At `node.depth > 3`, render `… (N more levels)` collapsed line and stop descending into children
- All existing per-call rendering logic (icon, status, name, args, elapsed, output dispatch via `renderToolOutput`) preserved
- Children recurse before sibling top-level calls (depth-first walk)

The existing `expandedToolCalls` Set already gates output rendering on the call's own callId — children inherit their own expansion state independently of parent.

## Data flow

```
Outer query() loop
  ├─ executeSingleTool(parentToolCall, ..., ctx)
  │   ├─ ctx.callId = parentToolCall.id
  │   ├─ ctx.emitChildEvent = (e) => outerStream.push({ ...e, parentCallId: ctx.callId })
  │   └─ AgentTool.call(input, ctx)
  │        ├─ inner query() loop
  │        ├─ inner yields tool_call_start(c1)  → ctx.emitChildEvent → outerStream.push(stamped)
  │        ├─ inner yields tool_call_end(c1)    → ctx.emitChildEvent → outerStream.push(stamped)
  │        └─ returns ToolResult
  │   ↑ outer stream interleaved with inner-stamped events during the call
  │
  └─ outer yields tool_call_end(parent)

Outer event stream consumed by REPL:
  tool_call_start(p1, parent: undef)
  tool_call_start(c1, parent: p1)            ← stamped during AgentTool execution
  tool_call_end(c1, parent: p1, output: ...)
  tool_call_end(p1, parent: undef, output: ...)

REPL handlers (src/repl.ts):
  tool_call_start  → setToolCall({ ..., parentCallId: event.parentCallId })
  tool_call_end    → setToolCall({ ..., parentCallId: event.parentCallId })

LayoutState.toolCalls — flat map; relationship via parentCallId field

Renderer (per frame):
  buildToolCallTree(state.toolCalls) → tree
  walk tree depth-first; render at colOffset = depth * 4; depth-limit at 3
```

No new state shape changes beyond the optional fields. No new query event types.

## Error handling

| Failure | Behavior |
|---|---|
| Inner query throws | Existing handler catches; emits parent `tool_call_end` with `isError: true`. Already-stamped children stay in `state.toolCalls`; renderer indents them under the now-errored parent. |
| Child event arrives before parent in `state.toolCalls` (race) | Renderer treats child as root (parent lookup fails → fallback to depth 0). Should be impossible — outer loop yields parent's `tool_call_start` before invoking the tool. |
| `parentCallId` references a non-existent callId | Fallback to root-level rendering. No throw, no warning. |
| Cycle in parent chain (defensive) | `buildToolCallTree` maintains a `seen` set; on revisit, stop recursing. Cycles shouldn't be possible (callIds unique, parent set once at creation), but defending is cheap. |
| Depth exceeds 3 | Collapse to `… (N more levels)` line; don't render deeper into the tree. |
| `emitChildEvent` undefined | AgentTool's existing behavior preserved — inner calls don't propagate; visible only via summary output. Tools called outside the outer query loop (e.g., from a script) keep working. |

## Testing

| File | Tests | Coverage |
|---|---|---|
| `src/types/events.test.ts` (extend or create) | 3 | parentCallId optional and absent, parentCallId set on each of three event types |
| `src/renderer/tool-tree.test.ts` (new) | 8 | empty map / single root / root with one child / root with multiple children / multi-level (root → child → grandchild) / depth-limit at 3 (collapse marker) / cycle defense / missing-parent fallback |
| `src/renderer/ui-ux.test.ts` (extend) | 4 | Agent with one child indented at col 6 / Agent with multi-level (Read → grandchild Edit) / ParallelAgents with children flat under it (v1 simplification) / depth-limit collapse marker shown |
| `src/tools/AgentTool/index.test.ts` (extend) | 3 | inner tool_call_* events forwarded with parentCallId stamped / inner tool_output_delta also forwarded / no forwarding when emitChildEvent undefined |
| `src/services/AgentDispatcher.test.ts` (extend if exists) | 2 | each task's inner events forwarded / all stamped with ParallelAgents callId |
| Event-handler propagation via `e2e.test.ts` (extend) | 2 | parentCallId field flows from event into ToolCallInfo on tool_call_start, same on tool_call_end |
| **Total** | **+22** | **~1487/1487 expected (was 1465)** |

## Build sequence

Single PR, ordered to keep build green at every commit:

1. **Type plumbing** — extend `events.ts`, `Tool.ts`, `layout.ts` with optional fields/method. Build still passes.
2. **REPL handler** — stamp `parentCallId` from event into `ToolCallInfo` (three handlers).
3. **Outer query loop wires emitChildEvent** — exact pattern (queue-push vs buffer-interleave) determined by existing code shape.
4. **Tree builder** — new `tool-tree.ts` + `tool-tree.test.ts`. Standalone; no wiring yet.
5. **AgentTool inner-event forwarding** — extend the loop at lines 117 and 157.
6. **AgentDispatcher inner-event forwarding** — same pattern, v1 simplification.
7. **Wire tree builder into renderer** — replace flat iteration in `renderToolCallsSection` with depth-first tree walk + column offsets.
8. **Integration tests** — 4 ui-ux tests cover the end-to-end render path.
9. **Run full suite + smoke**.

**Estimated PR size:** ~700-800 lines (350 source + 400 test). If diff size pushes split, divide as PR1=plumbing+tree-builder+REPL handler (no tool wiring, no renderer wiring); PR2=tool wiring + renderer wiring + integration tests. Same protocol as v2.25.0 / v2.26.0.

## Verification

- **Multi-level nesting:** snapshot a state with `Agent` parent → `Read` child → `Edit` grandchild. Assert column offsets at 0, 4, 8.
- **Depth-limit collapse:** snapshot 5-level deep nesting. Assert `… (N more levels)` line at depth 3.
- **ParallelAgents v1:** snapshot ParallelAgents parent with 3 child tool calls from different tasks. Assert all 3 render at col 4 (depth 1, no per-task grouping).
- **Streaming visibility:** during AgentTool execution, child `tool_call_start` events flow into outer stream before parent ends. Verified by ordering check in unit test.
- **Race defense:** orphan child event (parent missing from state) renders at depth 0 without throwing.
- **Manual REPL:** trigger `Agent` with prompt that runs Read + Bash. Observe child indentation under parent in real time. Trigger `ParallelAgents` with 2 tasks. Observe children stamped under the bundled parent.

## Release pattern

Standard from v2.21–v2.26:
1. Merge PR.
2. Bump `package.json` to `2.27.0`. SDK unchanged this release.
3. Consolidate `Unreleased` → `## 2.27.0 (YYYY-MM-DD) — Nested Tool Calls`. Cross-check Unreleased against `git log v2.26.0..HEAD`.
4. Tag `v2.27.0`, push tag, npm publish via `publish.yml`.
5. Write `project_v2_27_0.md` memory entry; update `MEMORY.md` index.

After v2.27.0, **the entire UI/UX-parity audit is closed**. ParallelAgents per-task synthetic-parent enhancement (v2.28) remains as the optional follow-up.

## Rollback

Pure additive change. `parentCallId` is optional everywhere; `emitChildEvent` is optional on `ToolContext`. Reverting the PR cleanly restores prior flat-list rendering. No state-shape migration; no config-schema change; no LLM-visible behavior change (model still sees `output` strings only).

## Follow-ups (out of scope for v2.27.0)

1. **ParallelAgents per-task synthetic parents** (~1 day) — synthesize `tool_call_start`/`tool_call_end` events for each task in `AgentDispatcher`, giving 2-level structure (`ParallelAgents → task → child tool`). Defer until user demand confirms the v1 single-level grouping is insufficient.
2. **Collapsible tree nodes** — toggle UX (e.g., click parent to collapse children). Defer until users ask.
3. **Tree connector glyphs** — `├─` / `└─` / `│` for visual hierarchy. Aesthetic only; defer indefinitely or until users request.
4. **Migration of `tool_output_delta` away from `onOutputChunk`** — once `emitChildEvent` is verified in production, deprecate the old per-call callback path. Cleanup commit only; no behavior change.
