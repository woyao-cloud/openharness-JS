# v2.28.0 "ParallelAgents Task Parents" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synthesize per-task `tool_call_start`/`tool_call_complete`/`tool_call_end` events inside `AgentDispatcher.runTask` (toolName: `"Task"`), and re-stamp child events to use the new synthetic callId — giving ParallelAgents a 2-level structure (`ParallelAgents → Task → child tool`) instead of v2.27.0's flat children.

**Architecture:** Pure event-stream synthesis. Symmetric with how AgentTool already emits its own outer `tool_call_start/end`. Adds 3 emit blocks in `runTask` and switches one argument in the existing `forwardChildEvent` call from `this.parentCallId` to the new synthetic `taskCallId`. Renderer + REPL get tiny `"Task"` recognition extensions (each adds `|| event.toolName === "Task"` to one existing check).

**Tech Stack:** TypeScript, Node test runner, no new runtime deps. Reuses every piece of v2.27.0 plumbing.

**Spec:** `docs/superpowers/specs/2026-05-02-u-c5b-parallel-task-parents-design.md`

**Files modified:**
- `src/repl.ts` — extend 2 `isAgentTool` / `isAgentCall` checks to include `"Task"`
- `src/renderer/layout-sections.ts` — extend 1 `isAgent` check to include `"Task"`
- `src/services/AgentDispatcher.ts` — add synthetic event emission in `runTask` + switch `forwardChildEvent` callId argument
- `src/services/AgentDispatcher.test.ts` — 3 new tests + update 2 existing v2.27.0 tests
- `src/renderer/ui-ux.test.ts` — 1 new integration test

**Behavioral notes:**
- Synthetic events fire only when `this.emitChildEvent && this.parentCallId` are both set (i.e., from REPL invocation). SDK / non-REPL callers see no behavior change.
- The synthetic `tool_call_end` MUST fire on every exit path (success / inner-loop error early-return / catch / abort). The current `runTask` has multiple `return` statements; emitting from a `finally` block is the cleanest way to guarantee single-emission on every exit.

---

## Task 1: REPL + renderer recognize "Task" as an agentic toolName

**Files:**
- Modify: `src/repl.ts` (2 sites — `tool_call_start` handler ~line 980-988 and `tool_call_complete` handler ~line 990-1005)
- Modify: `src/renderer/layout-sections.ts` (1 site — inside `renderSingleCall` around line 152)

Type-only string-comparison extensions. No tests yet — Task 3 covers integration tests. Verifies via `npm run typecheck && npm run lint`.

- [ ] **Step 1: Extend `isAgentTool` check in REPL `tool_call_start` handler**

In `src/repl.ts`, find the `case "tool_call_start":` block. Replace the line that defines `isAgentTool`:

```ts
const isAgentTool = event.toolName === "Agent" || event.toolName === "ParallelAgents";
```

with:

```ts
const isAgentTool = event.toolName === "Agent" || event.toolName === "ParallelAgents" || event.toolName === "Task";
```

- [ ] **Step 2: Extend `isAgentCall` check in REPL `tool_call_complete` handler**

In the same file, find the `case "tool_call_complete":` block. Replace:

```ts
const isAgentCall = tcToolName === "Agent" || tcToolName === "ParallelAgents";
```

with:

```ts
const isAgentCall = tcToolName === "Agent" || tcToolName === "ParallelAgents" || tcToolName === "Task";
```

- [ ] **Step 3: Extend `isAgent` check in renderer**

In `src/renderer/layout-sections.ts`, find the `renderSingleCall` function. Locate the line:

```ts
const isAgent = tc.isAgent || tc.toolName === "Agent" || tc.toolName === "ParallelAgents";
```

Replace with:

```ts
const isAgent = tc.isAgent || tc.toolName === "Agent" || tc.toolName === "ParallelAgents" || tc.toolName === "Task";
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors. Pure string-comparison extensions are non-breaking.

- [ ] **Step 5: Commit**

```bash
git add src/repl.ts src/renderer/layout-sections.ts
git commit -m "feat(repl,renderer): recognize \"Task\" toolName as agent-like (U-C5b plumbing)"
```

---

## Task 2: AgentDispatcher synthesizes per-task wrapper events

**Files:**
- Modify: `src/services/AgentDispatcher.ts:runTask` (currently around line 134-221)

This is the main behavior change. Three emit sites + one argument switch.

- [ ] **Step 1: Read the current `runTask` method**

Run: `cat src/services/AgentDispatcher.ts | sed -n '134,221p'` (or use the Read tool — line range 134-221).

You need to understand the current structure: `start = Date.now()` → worktree creation → existing `try` block containing the `for await` query loop with multiple early-return paths → `catch` block returning error result → `finally` block cleaning up worktree.

- [ ] **Step 2: Add synthetic call id + emit start/complete events at top of runTask**

In `src/services/AgentDispatcher.ts`, in the `runTask` method, immediately after the existing `let worktreePath: string | null = null;` line and BEFORE the `if (useWorktree) { ... }` block, add:

```ts
// Synthesize a "Task" parent call so children of this task render under it
// in the REPL (instead of flat under ParallelAgents). v2.28 U-C5b.
const taskCallId = `task-${task.id}-${Date.now().toString(36)}`;
const taskDescription = task.description ?? task.id;
const synthEnabled = !!this.emitChildEvent && !!this.parentCallId;
if (synthEnabled) {
  this.emitChildEvent!({
    type: "tool_call_start",
    toolName: "Task",
    callId: taskCallId,
    parentCallId: this.parentCallId,
  });
  this.emitChildEvent!({
    type: "tool_call_complete",
    toolName: "Task",
    callId: taskCallId,
    arguments: { description: taskDescription },
    parentCallId: this.parentCallId,
  });
}
```

The non-null assertions (`!`) are safe because `synthEnabled` already gates on truthiness of both fields. (TypeScript flow-narrowing won't carry through the boolean; the explicit assertions document the safety.)

- [ ] **Step 3: Switch `forwardChildEvent` callId argument from this.parentCallId to taskCallId**

In the same `runTask` method, find the line inside the `for await (const event of query(...))` loop:

```ts
forwardChildEvent(event, this.parentCallId, this.emitChildEvent);
```

Replace with:

```ts
forwardChildEvent(event, taskCallId, this.emitChildEvent);
```

(Now children of this task stamp `parentCallId = taskCallId` instead of `parentCallId = this.parentCallId`. The synthetic Task wrapper sits between ParallelAgents and the actual child tools.)

- [ ] **Step 4: Restructure exit paths to emit synthetic tool_call_end on every path**

The current `runTask` has multiple return statements (early return on `error` event around line 195, success return around line 208, catch return around line 210-216). Emitting the synthetic end after each is fragile. Use the existing `finally` block.

The current outer structure looks roughly:

```ts
try {
  // ... worktree, query loop, success return ...
} catch (err) {
  return { id: task.id, output: `Failed: ${...}`, isError: true, ... };
} finally {
  if (worktreePath) {
    removeWorktree(worktreePath, cwd);
  }
}
```

Restructure to capture the result first and emit at the single exit:

```ts
let result: AgentTaskResult;
try {
  result = await runTaskInner();  // see below — extract or inline
} catch (err) {
  result = {
    id: task.id,
    output: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
    durationMs: Date.now() - start,
  };
} finally {
  if (worktreePath) {
    removeWorktree(worktreePath, cwd);
  }
  if (synthEnabled) {
    this.emitChildEvent!({
      type: "tool_call_end",
      callId: taskCallId,
      output: result!.output,
      isError: result!.isError,
      parentCallId: this.parentCallId,
    });
  }
}
return result!;
```

**Concrete refactor** (do this — don't extract a helper, inline change):

Replace the current `try { ... } catch { ... } finally { ... }` block with a refactored version that uses a single `let result` variable and a finally that emits the synthetic end. Specifically, change every internal `return { ... }` inside the try block to assign-and-break or assign-and-return-after-break. The simplest mechanical shape:

```ts
let result: AgentTaskResult;
try {
  // ... ALL the existing try-block logic that builds and returns AgentTaskResult ...
  // BUT each `return { id: task.id, output: ..., isError: ..., durationMs: ... };`
  // becomes `result = { ... }; break;` (where the surrounding for-await is the loop being broken)
  // OR if not inside the for-await: `result = { ... };`
  // After all the existing logic that produces `output`, the existing line
  //   return { id: task.id, output: output || "(no output)", isError: false, durationMs: Date.now() - start };
  // becomes
  //   result = { id: task.id, output: output || "(no output)", isError: false, durationMs: Date.now() - start };
} catch (err) {
  result = {
    id: task.id,
    output: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
    durationMs: Date.now() - start,
  };
} finally {
  if (worktreePath) {
    removeWorktree(worktreePath, cwd);
  }
  if (synthEnabled) {
    this.emitChildEvent!({
      type: "tool_call_end",
      callId: taskCallId,
      output: result!.output,
      isError: result!.isError,
      parentCallId: this.parentCallId,
    });
  }
}
return result!;
```

**Subtlety with the for-await early return:** the current code has:

```ts
for await (const event of query(promptWithContext, config)) {
  if (event.type === "text_delta") output += event.content;
  if (event.type === "error") {
    return { id: task.id, output: `Error: ${event.message}`, isError: true, durationMs: Date.now() - start };
  }
  forwardChildEvent(event, this.parentCallId, this.emitChildEvent);
}
```

The early `return` inside the for-await would skip the finally. Convert to:

```ts
let errorEvent: { message: string } | null = null;
for await (const event of query(promptWithContext, config)) {
  if (event.type === "text_delta") output += event.content;
  if (event.type === "error") {
    errorEvent = { message: event.message };
    break;
  }
  forwardChildEvent(event, taskCallId, this.emitChildEvent);
}
if (errorEvent) {
  result = { id: task.id, output: `Error: ${errorEvent.message}`, isError: true, durationMs: Date.now() - start };
} else {
  result = { id: task.id, output: output || "(no output)", isError: false, durationMs: Date.now() - start };
}
```

Now `finally` always runs and the synthetic end always fires.

- [ ] **Step 5: Verify build and existing tests**

```bash
npm run typecheck && npm run lint
npx tsx --test src/services/AgentDispatcher.test.ts
```

Existing tests will FAIL (Task 3 updates them). Typecheck + lint must be clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/AgentDispatcher.ts
git commit -m "feat(parallel-agents): synthesize per-task wrapper events around inner-query loop (U-C5b)"
```

---

## Task 3: Update existing AgentDispatcher tests + add 3 new tests + 1 renderer integration test

**Files:**
- Modify: `src/services/AgentDispatcher.test.ts` (update 2 existing v2.27.0 tests; add 3 new)
- Modify: `src/renderer/ui-ux.test.ts` (add 1 new integration test)

The 2 existing v2.27.0 tests asserted that forwarded children's `parentCallId` equals the dispatcher's `parentCallId` constructor arg. Now they get stamped with the synthetic `taskCallId`. Update assertions to expect a string starting with `task-`.

- [ ] **Step 1: Update the 2 existing v2.27.0 tests in AgentDispatcher.test.ts**

Open `src/services/AgentDispatcher.test.ts`. Find the `describe("AgentDispatcher inner-event forwarding (U-C5)", ...)` block (or whatever name was used for the v2.27.0 forwarding tests). It contains tests that assert something like:

```ts
assert.equal((starts[0] as ToolCallStart).parentCallId, "parallel-parent");
```

Update each such assertion to expect a synthetic task callId. Since the format is `task-${task.id}-${epoch36}`, the test should assert it starts with `task-`:

```ts
assert.match((starts[0] as ToolCallStart).parentCallId!, /^task-/);
```

For the test that captured a tool_call_start with `parentCallId = "parallel-parent"`, the captured event is a CHILD's event (toolName: "Read" in the spec). That child now has `parentCallId = synthetic taskCallId`. Update accordingly.

The synthetic Task events themselves (`toolName: "Task"`) will ALSO appear in `captured`. Update test logic to filter:
- Synthetic Task starts: `parentCallId === "parallel-parent"` (the constructor arg)
- Child tool starts (e.g., Read): `parentCallId` matches `/^task-/`

Specifically:

```ts
// Find the synthetic Task event(s)
const taskStarts = captured.filter(
  (e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName === "Task",
);
assert.ok(taskStarts.length >= 1);
assert.equal(taskStarts[0]!.parentCallId, "parallel-parent");

// Find the child tool start (e.g., Read)
const childStarts = captured.filter(
  (e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName !== "Task",
);
assert.ok(childStarts.length >= 1);
assert.match(childStarts[0]!.parentCallId!, /^task-/);
```

Apply the analogous update to the second v2.27.0 test (the one that asserted no events are captured when emit is undefined — that should still hold; no synthesis fires when `synthEnabled` is false).

- [ ] **Step 2: Add 3 new tests for synthetic event emission**

Add these 3 tests inside the same describe block (or a new one named "AgentDispatcher per-task synthetic parents (U-C5b)"):

```ts
describe("AgentDispatcher per-task synthetic parents (U-C5b)", () => {
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

    // Find the synthetic Task start
    const taskStart = captured.find(
      (e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName === "Task",
    );
    assert.ok(taskStart, "expected a synthetic Task tool_call_start");
    assert.equal(taskStart!.parentCallId, "parallel-parent");
    assert.match(taskStart!.callId, /^task-task-A-/);

    // Find the child Read start
    const childStart = captured.find(
      (e): e is ToolCallStart => e.type === "tool_call_start" && e.toolName === "Read",
    );
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

    const ends = captured.filter(
      (e): e is ToolCallEnd => e.type === "tool_call_end",
    );
    // Find the synthetic Task end (it's the one with parentCallId === "parallel-parent")
    const taskEnd = ends.find((e) => e.parentCallId === "parallel-parent");
    assert.ok(taskEnd, "expected a synthetic Task tool_call_end");
    assert.equal(taskEnd!.isError, true);
    assert.match(taskEnd!.output, /boom|Error/);
  });
});
```

You may need to import additional types (`ToolCallComplete`, `ToolCallEnd`) at the top of the file. Check the existing imports.

- [ ] **Step 3: Add 1 integration test in ui-ux.test.ts**

In `src/renderer/ui-ux.test.ts`, append at the end of the `describe("U-C5: nested tool call rendering", ...)` block:

```ts
  it("renders ParallelAgents → Task → child as 3-level tree (U-C5b)", () => {
    const parallel: ToolCallInfo = {
      toolName: "ParallelAgents",
      status: "running",
      isAgent: true,
    };
    const task: ToolCallInfo = {
      toolName: "Task",
      status: "running",
      agentDescription: "fetch logs",
      parentCallId: "p",
    };
    const child: ToolCallInfo = {
      toolName: "Read",
      status: "done",
      output: "file contents",
      parentCallId: "t",
    };
    const state = makeState({
      toolCalls: new Map([
        ["p", parallel],
        ["t", task],
        ["c", child],
      ]),
    });
    const grid = new CellGrid(80, 30);
    rasterize(state, grid);
    const text = gridAllText(grid);
    assert.match(text, /ParallelAgents/);
    // Task at depth 1 — name at col 8 (4 + depth*4)
    assert.match(text, /^ {4,}.*Task/m);
    // Read at depth 2 — name at col 12 (4 + 2*4)
    assert.match(text, /^ {8,}.*Read/m);
  });
```

- [ ] **Step 4: Run all updated/added tests**

```bash
npx tsx --test src/services/AgentDispatcher.test.ts src/renderer/ui-ux.test.ts
```

Expected: all tests pass (existing + updated + new). If any fail, inspect the actual rendered grid via `console.log(gridAllText(grid))` inside the failing test and adjust thresholds.

- [ ] **Step 5: Run full suite**

```bash
npm run typecheck && npm run lint
npm run test:cli
```

Expected: typecheck/lint clean. ~1500 tests pass (was 1496; +4 new in this task).

- [ ] **Step 6: Commit**

```bash
git add src/services/AgentDispatcher.test.ts src/renderer/ui-ux.test.ts
git commit -m "test: per-task synthetic parents in AgentDispatcher + ParallelAgents 3-level rendering (U-C5b)"
```

---

## Task 4: Manual REPL smoke + release prep notes

**Files:** none modified. Verification only.

- [ ] **Step 1: Build dist**

```bash
npm run build
```

Expected: clean, no errors.

- [ ] **Step 2: Manual REPL smoke (~2 min)**

```bash
node dist/main.js
```

In the REPL:
1. Trigger a `ParallelAgents` call with 2 simple tasks (each with a clear `description`). Each task should call 1-2 child tools (Read, Bash, etc.). Observe:
   - ParallelAgents at col 0 (depth 0)
   - Each Task row at col 4 (depth 1) with `agentDescription` (e.g., "fetch logs") indented under
   - Each task's child tools at col 8 (depth 2) under their respective Task row — NOT flat under ParallelAgents
2. Trigger an Agent call (single sub-agent, not ParallelAgents). Observe its single inner Read/Bash renders at depth 1 — unchanged from v2.27.0 (no Task wrapper on solo Agent).

If any smoke check renders incorrectly, fix before release.

- [ ] **Step 3: Release prep**

After PR merges, the release pattern is the same as v2.27.0:
1. Bump `package.json` to `2.28.0`
2. Add `## 2.28.0 (YYYY-MM-DD) — ParallelAgents Task Parents` entry to CHANGELOG
3. Cross-check Unreleased against `git log v2.27.0..HEAD`
4. Tag `v2.28.0`, push tag, npm publish via `publish.yml`
5. Write `project_v2_28_0.md` memory entry; update `MEMORY.md` index

---

## Self-review

Spec coverage check:

| Spec section | Task |
|---|---|
| Component 1 (synthetic event synthesis in runTask) | Task 2 |
| Component 2 (REPL recognizes "Task" as agent-like) | Task 1 |
| Component 3 (renderer recognizes "Task" as agent-like) | Task 1 |
| Component 4 (forwardChildEvent stays unchanged, just receives new arg) | Task 2 (Step 3) |
| Data flow | Tasks 1 + 2 (end-to-end) |
| Error handling (synth gated; finally guarantees end emission; abort/error paths) | Task 2 (Step 4 with finally restructure) |
| Testing matrix (+4 new, 2 updated) | Task 3 |
| Build sequence | Task ordering 1 → 2 → 3 → 4 |
| Verification (per-task grouping, single-task, error propagation, manual REPL) | Tasks 3 + 4 |

**Type consistency check:** `taskCallId: string` consistent across emit sites. `synthEnabled: boolean` gates all 3 emits + the forwardChildEvent call site uses taskCallId regardless (since forwardChildEvent itself guards on `parentCallId` being non-null — passing taskCallId when `synthEnabled` is false still works because forwardChildEvent's own guard short-circuits when emit is missing). Synthetic event field shapes match v2.27.0 exactly (`type`, `toolName`, `callId`, `parentCallId`, optional `arguments`/`output`/`isError`).
