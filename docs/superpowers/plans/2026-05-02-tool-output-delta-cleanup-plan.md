# v2.29.0 "tool_output_delta Cleanup" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the dual-path duplication where `tool_output_delta` from inner Agent tools renders both in the parent Agent's `liveOutput` preview AND under the child tool's row. Make `emitChildEvent` (forwarded path) take precedence; fall back to `onOutputChunk` (parent preview) only when forwarding isn't wired up (SDK contexts).

**Architecture:** One file modified — `src/tools/AgentTool/index.ts`. Convert the existing sequential `onOutputChunk` + `forwardInnerEvent` calls into a guard: gate `onOutputChunk` on `forwardInnerEvent` returning `false`. The boolean return value already exists from v2.27.0 (added for testing) — now also used at runtime.

**Tech Stack:** TypeScript, Node test runner, no new runtime deps. Reuses every piece of v2.27.0/v2.28.0 plumbing.

**Spec:** `docs/superpowers/specs/2026-05-02-tool-output-delta-cleanup-design.md`

**Files modified:**
- `src/tools/AgentTool/index.ts` — 5-line change in the foreground inner loop's `tool_output_delta` branch
- `src/tools/AgentTool/index.test.ts` — +2 tests verifying the if/else gating

---

## Task 1: Gate onOutputChunk on forwardInnerEvent returning false

**Files:**
- Modify: `src/tools/AgentTool/index.ts` (the foreground inner-query for-await loop, around line 180-200)

This is the entire behavior change. ~5 lines.

- [ ] **Step 1: Locate the foreground inner-query loop**

In `src/tools/AgentTool/index.ts`, find the `for await (const event of query(...))` loop in `AgentTool.call`. Specifically the `else if (event.type === "tool_output_delta")` branch.

The current shape (post-v2.27.0):

```ts
} else if (event.type === "tool_output_delta") {
  outputChunks.push(event.chunk);
  if (context.onOutputChunk && context.callId) {
    context.onOutputChunk(context.callId, event.chunk);
  }
  forwardInnerEvent(event, context);
}
```

(The exact line numbers may have drifted; locate by searching for `event.type === "tool_output_delta"` inside the foreground branch — NOT the background branch around line 117.)

- [ ] **Step 2: Replace with gated if/else**

Replace the branch with:

```ts
} else if (event.type === "tool_output_delta") {
  outputChunks.push(event.chunk);
  const forwarded = forwardInnerEvent(event, context);
  if (!forwarded && context.onOutputChunk && context.callId) {
    context.onOutputChunk(context.callId, event.chunk);
  }
}
```

The change: `forwardInnerEvent` now runs unconditionally first (capturing the boolean). Then `onOutputChunk` runs only if forwarding didn't happen (SDK / non-REPL fallback path).

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint
```

Both must be 0 errors.

- [ ] **Step 4: Run AgentTool tests**

```bash
npx tsx --test src/tools/AgentTool/index.test.ts
```

Existing 11 tests should still pass (no test was specifically asserting the dual-path behavior — it was an undocumented side effect).

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/index.ts
git commit -m "fix(agent): gate onOutputChunk on emitChildEvent absence to deduplicate inner tool_output_delta (U-C5b cleanup)"
```

---

## Task 2: Add 2 tests verifying the if/else gating

**Files:**
- Modify: `src/tools/AgentTool/index.test.ts` (append to existing forwarding-test describe block or add new one)

- [ ] **Step 1: Read existing test file structure**

Open `src/tools/AgentTool/index.test.ts`. Note the existing `makeCtx` helper and the `describe("forwardInnerEvent — forwarding logic", ...)` block. The new tests verify the AgentTool.call() integration, not just the helper — they need to invoke the foreground loop end-to-end.

Look at how the existing test "AgentTool.call() returns early when provider is missing" sets up a stub provider+tools to actually invoke `AgentTool.call`. Use that pattern.

- [ ] **Step 2: Add new describe block at end of file**

```ts
describe("AgentTool tool_output_delta deduplication (v2.29 U-C5b cleanup)", () => {
  it("calls emitChildEvent and skips onOutputChunk when both are set (REPL context)", async () => {
    // Assemble a stub provider that yields one tool_output_delta from an inner tool.
    // Use the same makeStubProvider pattern as other AgentTool tests if it exists,
    // or build inline. The provider must yield a turn_complete to terminate the inner loop.

    const captured: Array<{ kind: "emit" | "chunk"; chunk?: string }> = [];
    const onOutputChunkCalls: Array<{ callId: string; chunk: string }> = [];

    // ... build a ToolContext with both emitChildEvent and onOutputChunk wired up.
    // ... invoke AgentTool.call({ prompt: "test" }, ctx).
    // ... assert: captured includes the forwarded tool_output_delta event.
    //     onOutputChunkCalls is EMPTY (deduplication verified).
  });

  it("calls onOutputChunk when emitChildEvent is undefined (SDK fallback)", async () => {
    // Same setup but ctx has only onOutputChunk, no emitChildEvent.
    // Assert onOutputChunkCalls received the chunk.
  });
});
```

**Implementation hint:** if stubbing `AgentTool.call`'s inner query loop is too involved (it composes provider, tools, system prompt, etc. via `import("../../query.js")`), an alternative is to test the gating logic INDIRECTLY by extracting it. But since the entire change is one if/!forwarded gate, the cleanest unit test is direct on `forwardInnerEvent`'s return value plus a separate assertion that the inner loop respects it.

**Simpler alternative — test the helper return value + manual gating reproduction:**

```ts
describe("AgentTool tool_output_delta deduplication (v2.29 U-C5b cleanup)", () => {
  it("forwardInnerEvent returns true for tool_output_delta when emitChildEvent is set", () => {
    const captured: StreamEvent[] = [];
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      callId: "parent-1",
      emitChildEvent: (e) => captured.push(e),
    };
    const event: StreamEvent = {
      type: "tool_output_delta",
      callId: "child-1",
      chunk: "streaming line\n",
    };
    const result = forwardInnerEvent(event, ctx);
    assert.equal(result, true, "should return true to signal forwarding happened");
    assert.equal(captured.length, 1);
  });

  it("forwardInnerEvent returns false for tool_output_delta when emitChildEvent is undefined", () => {
    const ctx: ToolContext = {
      workingDir: process.cwd(),
      callId: "parent-1",
      // emitChildEvent intentionally omitted
    };
    const event: StreamEvent = {
      type: "tool_output_delta",
      callId: "child-1",
      chunk: "streaming line\n",
    };
    const result = forwardInnerEvent(event, ctx);
    assert.equal(result, false, "should return false to signal SDK fallback path needed");
  });
});
```

These two tests verify the pre-condition that the new gating logic relies on. Combined with the existing AgentTool tests passing (which exercise the foreground loop), this proves the whole flow works.

If you can ALSO write a true integration test that invokes `AgentTool.call()` and asserts the `onOutputChunk` callback isn't called when `emitChildEvent` is set, even better. But the unit tests above are sufficient if integration stubbing is complex.

- [ ] **Step 3: Run tests**

```bash
npx tsx --test src/tools/AgentTool/index.test.ts
```

Expected: existing 11 + 2 new = 13 tests pass.

- [ ] **Step 4: Run full suite**

```bash
npm run typecheck && npm run lint
npm run test:cli 2>&1 | tail -5
```

Expected: ~1502/1502 pass (was 1500; +2 new).

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/index.test.ts
git commit -m "test(agent): forwardInnerEvent return value gating for tool_output_delta dedup (v2.29)"
```

---

## Task 3: Manual REPL smoke + release prep

**Files:** none modified. Verification only.

- [ ] **Step 1: Build dist**

```bash
npm run build
```

- [ ] **Step 2: Manual REPL smoke (~1 min)**

```bash
node dist/main.js
```

In the REPL, trigger an `Agent` call that runs `Read` on a file. Observe the Read tool's output chunks appear:
- Indented under the `Read` row (correct — forwarded path)
- NOT also previewed in the `Agent` row's `liveOutput` (correct — deduplication working)

Compare to v2.28.0 behavior: previously the same lines would appear in BOTH places.

- [ ] **Step 3: Release prep notes**

After PR merges:
1. Bump `package.json` to `2.29.0`
2. Add `## 2.29.0 (YYYY-MM-DD) — tool_output_delta Cleanup` entry to CHANGELOG
3. Cross-check Unreleased against `git log v2.28.0..HEAD`
4. Tag `v2.29.0`, push tag, npm publish via `publish.yml`
5. Write `project_v2_29_0.md` memory entry; update `MEMORY.md` index

---

## Self-review

Spec coverage check:

| Spec section | Task |
|---|---|
| Goal 1 (eliminate REPL duplication) | Task 1 |
| Goal 2 (preserve SDK fallback) | Task 1 (the `if (!forwarded ...)` else-branch) |
| Component design (single file 5-line change) | Task 1 |
| Data flow (REPL one-path / SDK fallback / no-context skip) | Tasks 1 + 2 |
| Error handling (callId-undefined: both branches skip; throw: caller catches) | Task 1 |
| Testing matrix (+2 tests) | Task 2 |
| Build sequence (single PR, single commit) | Task ordering 1 → 2 → 3 |
| Verification (manual REPL) | Task 3 |

**Type consistency check:** `forwarded: boolean` matches the existing `forwardInnerEvent` return type. No new types introduced.
