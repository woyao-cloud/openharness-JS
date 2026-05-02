# v2.28.0 "ParallelAgents Task Parents" — Design Spec

**Date:** 2026-05-02
**Status:** Draft
**Tier:** v2.28 follow-up to U-C5 (deferred from v2.27.0 spec, line 297-301)
**Target release:** v2.28.0 — single PR, ~½ day

## Context

v2.27.0 (shipped 2026-05-02) closed Tier U-C5 with a v1 simplification for `ParallelAgents`: all child tool calls from all tasks stamp `parentCallId = ParallelAgents.callId`, rendering as flat siblings under the bundled parent. The grouping by task is lost — a `Read` and a `Bash` from different tasks render indistinguishably side-by-side.

Today's render:
```
◈ ParallelAgents
    ✓ Read       (which task?)
    ✓ Bash       (which task?)
    ✓ Edit       (which task?)
```

Target render:
```
◈ ParallelAgents
    ◈ Task          ← synthetic per-task wrapper
       fetch logs   ← task.description
        ✓ Read
        ✓ Edit
    ◈ Task
       run tests
        ✓ Bash
```

**Why now:** v2.27.0 declared the entire UI/UX-parity audit closed. This is the most impactful of the four documented v2.28+ follow-ups (the other three are aesthetic / hygiene). Demonstrates the v2.27.0 plumbing extends cleanly without protocol changes.

## Goals

1. **Per-task synthetic parent rows.** `AgentDispatcher.runTask` synthesizes `tool_call_start` / `tool_call_complete` / `tool_call_end` events around the existing inner-query loop, with `toolName: "Task"`.
2. **Children stamp the synthetic task callId, not ParallelAgents.callId.** v1's flat grouping is replaced with proper 2-level nesting under the bundled parent.
3. **Pure additive change.** No new event types, no new types in the public API, no schema change to `AgentTask`. All work is internal to `AgentDispatcher` plus tiny renderer extensions for the new `"Task"` toolName.

## Non-goals

- **New AgentTask schema fields.** Synthetic callId is generated internally — task.id stays as a user-facing identifier separate from internal callId plumbing.
- **Live elapsed-time per task with sub-second precision.** The synthetic task row uses the existing elapsed-time rendering (1-second granularity, same as Agent rows).
- **Live mid-task event streaming.** Same as v2.27.0 — children flush when their parent's `tool_call_end` is yielded, in temporal order. The `Promise.race`-style refactor for true mid-tool streaming remains deferred.
- **Migration of existing v1 ParallelAgents tests.** Tests that asserted "all children stamp parentCallId = parallel.callId" will need updating — that's expected breakage of the v1 simplification.

## Approach

**Three approaches considered:**

| Approach | Mechanism | Trade-off |
|---|---|---|
| **(A1) Synthesize events inside `runTask`** ✅ chosen | Dispatcher wraps inner query loop with synthetic start/complete/end events; children's parentCallId = synthetic id | Symmetric with AgentTool; pure event-stream synthesis; reuses all v2.27.0 plumbing; tiny ~2-line renderer extensions for "Task" tool name |
| (A2) Add `taskCallId` field to `AgentTask` schema | Pre-generate task callIds at addTask time; thread through; renderer detects | Clutters public schema; couples internal plumbing to user-facing API |
| (A3) Renderer-side virtual grouping (no events) | Add `metadata.taskId` to ToolCallInfo; renderer groups visually without extra row | Moves complexity to renderer; loses live elapsed/running status for task row; breaks symmetry with AgentTool |

A1 wins because it matches AgentTool's existing pattern (AgentTool's outer `tool_call_start/end` is also synthesized by the outer query loop, not by the model), reuses every piece of v2.27.0 infrastructure (parentCallId stamping, tree builder, hierarchical renderer, depth-3 limit), and adds the smallest delta from current architecture.

## Component design

### Component 1 — Synthetic event synthesis in `AgentDispatcher.runTask`

`src/services/AgentDispatcher.ts:runTask` (around line 134-221). Add a small block at the top of `runTask` (before the existing `try`) and at exit points:

```ts
private async runTask(task: InternalTask): Promise<AgentTaskResult> {
  const start = Date.now();
  const cwd = this.workingDir ?? process.cwd();
  const useWorktree = isGitRepo(cwd);
  let worktreePath: string | null = null;

  // NEW: synthesize a "Task" parent call id and emit start + complete events
  const taskCallId = `task-${task.id}-${Date.now().toString(36)}`;
  const taskDescription = task.description ?? task.id;
  if (this.emitChildEvent && this.parentCallId) {
    this.emitChildEvent({
      type: "tool_call_start",
      toolName: "Task",
      callId: taskCallId,
      parentCallId: this.parentCallId,
    });
    this.emitChildEvent({
      type: "tool_call_complete",
      toolName: "Task",
      callId: taskCallId,
      arguments: { description: taskDescription },
      parentCallId: this.parentCallId,
    });
  }

  // ... existing worktree creation, query loop, etc. ...
  // Inside the existing for-await loop, replace the existing
  //   forwardChildEvent(event, this.parentCallId, this.emitChildEvent)
  // with
  //   forwardChildEvent(event, taskCallId, this.emitChildEvent)
  // so children stamp the synthetic callId instead of the bundled parent's

  // ... existing logic produces `result: AgentTaskResult` ...

  // NEW: emit synthetic tool_call_end with the result
  if (this.emitChildEvent && this.parentCallId) {
    this.emitChildEvent({
      type: "tool_call_end",
      callId: taskCallId,
      output: result.output,
      isError: result.isError,
      parentCallId: this.parentCallId,
    });
  }

  return result;
}
```

**Critical:** the synthetic `tool_call_end` must fire on EVERY exit path (success, error inside loop, error in catch, abort). Easiest: wrap result derivation so the existing return statements thread through a single emission point. Or fire from the outer `finally`.

**callId format:** `task-${task.id}-${Date.now().toString(36)}` ensures uniqueness across multiple ParallelAgents calls in the same session and across multiple tasks within one call. Falls back to `task.id` for the human-readable portion.

### Component 2 — REPL handler recognizes "Task" as agent-like

`src/repl.ts` — extend two existing checks to include the `"Task"` toolName.

`tool_call_start` handler (currently around line 980-988):
```ts
const isAgentTool = event.toolName === "Agent" || event.toolName === "ParallelAgents" || event.toolName === "Task";
```

`tool_call_complete` handler (currently around line 990-1005):
```ts
const isAgentCall = tcToolName === "Agent" || tcToolName === "ParallelAgents" || tcToolName === "Task";
```

Two-character addition to each. The existing `agentDescription` extraction pulls `arguments.description` into ToolCallInfo, which renders indented under the row.

### Component 3 — Renderer recognizes "Task" as agent-like

`src/renderer/layout-sections.ts:renderToolCallsSection` (currently around line 152-167 — the `isAgent` check inside `renderSingleCall`):

```ts
const isAgent = tc.isAgent || tc.toolName === "Agent" || tc.toolName === "ParallelAgents" || tc.toolName === "Task";
```

One-character addition. Gives the synthetic Task row the ⊕/◈/◇ icon and `S_AGENT` cyan-bold style — same treatment as Agent and ParallelAgents.

### Component 4 — `forwardChildEvent` already supports the new flow

`src/services/AgentDispatcher.ts:forwardChildEvent` is already exported and tested. v2.27.0's call site passes `this.parentCallId`; v2.28's call site passes `taskCallId` (the synthesized id) instead. Helper signature unchanged. Existing 6 unit tests of `forwardChildEvent` continue to pass.

## Data flow

```
ParallelAgents.call(input, ctx)
  └─ AgentDispatcher.execute()
       └─ runTask(task1)
            ├─ taskCallId = "task-task1-mxyz123"
            ├─ emit tool_call_start{toolName:"Task", callId:taskCallId, parentCallId:parallel}
            ├─ emit tool_call_complete{toolName:"Task", callId:taskCallId, args:{description}, parentCallId:parallel}
            ├─ for await event:
            │     forwardChildEvent(event, taskCallId, emit)  ← NEW: was parentCallId
            │     → emit {...event, parentCallId: taskCallId}
            └─ emit tool_call_end{callId:taskCallId, output:result.output, isError:result.isError, parentCallId:parallel}

Outer stream:
  tool_call_start(parallel)
  tool_call_start(task-task1-xxx, parent: parallel)
  tool_call_complete(task-task1-xxx, args:{description:"fetch logs"})
  tool_call_start(read-c1, parent: task-task1-xxx)
  tool_call_end(read-c1, parent: task-task1-xxx)
  tool_call_start(task-task2-yyy, parent: parallel)  ← parallel: tasks may interleave
  tool_call_complete(task-task2-yyy, args:{description:"run tests"})
  tool_call_start(bash-c2, parent: task-task2-yyy)
  tool_call_end(bash-c2, parent: task-task2-yyy)
  tool_call_end(task-task1-xxx, parent: parallel, output: ...)
  tool_call_end(task-task2-yyy, parent: parallel, output: ...)
  tool_call_end(parallel)

REPL handlers stamp parentCallId into ToolCallInfo (existing v2.27.0 behavior).

LayoutState.toolCalls — still flat map keyed by callId.

Renderer:
  buildToolCallTree → 3-level tree (parallel → synth-task → child tools)
  walks at depth 0, 1, 2 (depth-3 limit not reached)
```

No state-shape changes. No new event types. No protocol-layer changes.

## Error handling

| Failure | Behavior |
|---|---|
| Inner query throws inside runTask | Existing `catch` builds error result; synthetic `tool_call_end` still fires with `isError: true` and the error message |
| Worktree creation fails | Existing fallback (no worktree); synthetic events still fire normally |
| Abort signal triggered mid-task | Existing abort check breaks the loop; synthetic `tool_call_end` fires with the partial output and `isError: false` (matches v1 abort behavior) |
| `emitChildEvent` or `parentCallId` undefined | All synthesis is gated by `if (this.emitChildEvent && this.parentCallId)` — no events fire, dispatcher behavior unchanged for non-REPL callers |
| Multiple tasks complete concurrently | Each task's synthetic events flush as that task's `tool_call_end` is yielded by the dispatcher's `for await` loop on its own children — interleave is by-task atomic, not per-event interleaved |
| Task ID contains characters that break the callId format | `task-${task.id}-${epoch}` accepts any string; ID is opaque downstream |

## Testing

| File | Tests | Coverage |
|---|---|---|
| `src/services/AgentDispatcher.test.ts` | +3 | runTask emits synthetic start before children / synthetic end fires on success / synthetic end fires on error |
| `src/services/AgentDispatcher.test.ts` (existing v2.27.0 tests) | update 2 | `parentCallId` of forwarded children is now `taskCallId` not `parentCallId` — update assertions on the 2 existing tests |
| `src/renderer/ui-ux.test.ts` | +1 | ParallelAgents → Task → Read renders at correct depths (cols 0, 4, 8); Task row uses Agent icon |
| **Total** | **+4 new, 2 updated** | **~1500/1500 expected** (was 1496) |

## Build sequence

Single PR, ordered to keep build green at every commit:

1. **Renderer + REPL "Task" recognition** — extend three `isAgent` / `isAgentCall` checks. Build still passes; renderer just gives Task rows the agent treatment if any test asserts it.
2. **AgentDispatcher synthetic event emission** — add the 3 emit blocks; switch `forwardChildEvent` parentCallId arg from `this.parentCallId` to `taskCallId`. Update the 2 existing tests' assertions.
3. **Add 3 new dispatcher tests** + 1 renderer integration test. All 1500 tests pass.

**Estimated PR size:** ~150 lines (50 source + 100 test).

## Verification

- **Per-task grouping:** snapshot a state with ParallelAgents → 2 synthetic Task rows → Read child of task1, Bash child of task2. Assert column offsets at 0, 4, 8.
- **Single-task ParallelAgents:** snapshot with 1 task running 1 tool. Assert ParallelAgents → Task → Read renders at cols 0, 4, 8 (the bundled parent is still a level even with one task — no special-casing).
- **Error propagation:** snapshot with one task that errors. Assert synthetic Task row shows `✗` icon (error state) and the parent ParallelAgents stays in running state until all tasks complete.
- **Manual REPL:** trigger `ParallelAgents` with 2 tasks, each calling Read + Bash. Observe each child indented under its own Task row, not flat under ParallelAgents.

## Release pattern

Standard from v2.21–v2.27:
1. Merge PR.
2. Bump `package.json` to `2.28.0`. SDK unchanged.
3. Consolidate `Unreleased` → `## 2.28.0 (YYYY-MM-DD) — ParallelAgents Task Parents`. Cross-check Unreleased against `git log v2.27.0..HEAD`.
4. Tag `v2.28.0`, push tag, npm publish via `publish.yml`.
5. Write `project_v2_28_0.md` memory entry; update `MEMORY.md` index.

After v2.28.0, the remaining v2.28+ follow-ups are: `tool_output_delta` cleanup (hygiene) and tree connector glyphs (aesthetic). Both indefinitely deferrable.

## Rollback

Pure additive change. Synthetic events don't fire when `emitChildEvent` is undefined (preserves dispatcher behavior for non-REPL callers like SDK use). The renderer's "Task" recognition is a no-op when no Task events are emitted. Reverting the PR cleanly restores v2.27.0's flat-children rendering. No state-shape migration; no config-schema change; no LLM-visible behavior change.
