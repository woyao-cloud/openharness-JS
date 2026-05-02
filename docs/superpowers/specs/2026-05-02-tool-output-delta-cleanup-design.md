# v2.29.0 "tool_output_delta Cleanup" — Design Spec

**Date:** 2026-05-02
**Status:** Draft
**Tier:** v2.28+ follow-up to U-C5 (deferred from v2.27.0 spec, line 302)
**Target release:** v2.29.0 — single PR, ~½ hour

## Context

In v2.27.0, `AgentTool.forwardInnerEvent` was added with the spec note:

> The existing `onOutputChunk` path stays for backward compatibility — parent's `liveOutput` rendering still works. The `emitChildEvent` call is additive.

Both paths fire for every forwarded `tool_output_delta`:
1. `context.onOutputChunk(context.callId, event.chunk)` writes the chunk into the **parent Agent's** `liveOutput` preview buffer
2. `context.emitChildEvent({ ...event, parentCallId: context.callId })` forwards the event so the **child's row** gets its own `liveOutput`

→ the same lines render twice in the REPL: once under the Agent's row (preview path), once indented under the child tool's row (forwarded path).

v2.27.0's release memory documented this for cleanup once `emitChildEvent` was verified in production.

## Goals

1. **Eliminate the duplication in REPL contexts.** When `emitChildEvent` is available (every REPL invocation since v2.27.0), use it exclusively — children render under their own rows, not also in parent's preview.
2. **Preserve backward compat for SDK / non-REPL contexts.** When `emitChildEvent` is not set (older callers, SDK-only invocations), fall back to the `onOutputChunk` parent-preview path so chunks remain visible somewhere.

## Non-goals

- **Removing `onOutputChunk` entirely.** It's still the canonical callback for live streaming inner output to the parent's preview when no event-stream forwarding is wired up. SDK callers and any future non-REPL contexts depend on it.
- **Changing `outputChunks` (AgentTool's local string[] buffer).** That feeds the final `ToolResult.output` return value — unrelated to rendering. Stays untouched.
- **Touching AgentDispatcher.** It only uses `forwardChildEvent` (no `onOutputChunk` path) — already deduplicated.

## Approach

Mutual-exclusion if/else with `emitChildEvent` taking precedence:

```ts
} else if (event.type === "tool_output_delta") {
  outputChunks.push(event.chunk);  // unchanged: feeds ToolResult.output
  if (context.emitChildEvent && context.callId) {
    context.emitChildEvent({ ...event, parentCallId: context.callId });
  } else if (context.onOutputChunk && context.callId) {
    context.onOutputChunk(context.callId, event.chunk);
  }
}
```

Old logic was both blocks fired sequentially; new logic is `if/else if` so exactly one fires per chunk.

The same change applies inside `forwardInnerEvent` — currently the helper handles the 4 forwarding event types and stamps `parentCallId`. The `tool_output_delta` branch in there remains unchanged because `forwardInnerEvent` doesn't know about `onOutputChunk`. The if/else change is in the **inline call site** in AgentTool's foreground inner loop (the place that calls both `onOutputChunk` and `forwardInnerEvent`).

Wait — re-reading v2.27.0 code: `forwardInnerEvent` is called from the inner loop INSTEAD of inline emit. So the call site in the loop reads:

```ts
} else if (event.type === "tool_output_delta") {
  outputChunks.push(event.chunk);
  if (context.onOutputChunk && context.callId) {
    context.onOutputChunk(context.callId, event.chunk);
  }
  forwardInnerEvent(event, context);  // does the emitChildEvent stamping internally
}
```

The cleanup: gate the `onOutputChunk` call on `forwardInnerEvent` returning `false` (i.e., no forwarding happened, fall back to preview).

**Final shape:**

```ts
} else if (event.type === "tool_output_delta") {
  outputChunks.push(event.chunk);
  const forwarded = forwardInnerEvent(event, context);
  if (!forwarded && context.onOutputChunk && context.callId) {
    context.onOutputChunk(context.callId, event.chunk);
  }
}
```

`forwardInnerEvent` already returns `true` when forwarding happens (when `emitChildEvent && callId` are both set), `false` otherwise. The boolean return value was added to the helper in v2.27.0 specifically for testing — now it serves runtime gating too.

## Component design

Single file modified: `src/tools/AgentTool/index.ts`. Inside the foreground `for await` loop, replace the existing `tool_output_delta` branch (5 lines) with the new 5-line shape above.

`forwardInnerEvent` itself is unchanged. Its `tool_output_delta` handling already correctly stamps `parentCallId` and emits via `context.emitChildEvent`.

## Data flow

**Before (REPL context, both paths fire):**
```
inner Read tool produces chunk
  → inner outputChunks.push, inner onOutputChunk fires
    → inner buffer drains as tool_output_delta event
      → AgentTool's foreground loop catches event:
         ├─ outputChunks.push(chunk)               (ToolResult.output buffer)
         ├─ context.onOutputChunk(...)             ← writes to parent Agent's liveOutput
         └─ forwardInnerEvent → context.emitChildEvent(...)  ← writes to child Read's liveOutput
                                                      ↑ DUPLICATION
```

**After (REPL context, one path fires):**
```
inner Read tool produces chunk
  → ... same as above ...
    → AgentTool's foreground loop catches event:
       ├─ outputChunks.push(chunk)
       ├─ forwardInnerEvent → context.emitChildEvent(...) → child Read's liveOutput
       └─ (onOutputChunk SKIPPED because forwarded === true)
```

**After (SDK context, no emitChildEvent — fallback path fires):**
```
inner Read tool produces chunk
  → ... 
    → AgentTool's foreground loop:
       ├─ outputChunks.push(chunk)
       ├─ forwardInnerEvent returns false (no emitChildEvent)
       └─ context.onOutputChunk(...) → parent's liveOutput preview (existing SDK behavior preserved)
```

## Error handling

| Failure | Behavior |
|---|---|
| `emitChildEvent` undefined, `onOutputChunk` undefined | Both branches skip; chunks land only in `outputChunks` local buffer for final return — no live render anywhere (matches existing pre-v2.27 behavior for that case) |
| `emitChildEvent` set, `callId` undefined | `forwardInnerEvent` returns false (the helper's existing guard); falls through to `onOutputChunk` path which also requires `callId` — both skip |
| Throw inside `emitChildEvent` callback | Propagates up the for-await — caller's try/catch already handles. Same as v2.27.0. |

## Testing

| File | Tests | Coverage |
|---|---|---|
| `src/tools/AgentTool/index.test.ts` | +2 | (1) when `emitChildEvent` is set, `onOutputChunk` is NOT called (deduplication verified) / (2) when `emitChildEvent` is undefined, `onOutputChunk` IS called (SDK fallback preserved) |
| **Total** | **+2** | **~1502/1502 expected** (was 1500) |

## Build sequence

Single PR, single commit:

1. Modify the `tool_output_delta` branch in AgentTool's foreground inner loop (5 lines).
2. Add 2 tests.
3. Run full suite + verify 1502/1502.

**Estimated PR size:** ~30 lines (5 source + 25 test).

## Verification

- **Unit tests:** the 2 new tests verify both gating paths.
- **Manual REPL:** trigger `Agent` with prompt that runs `Read`. Observe child Read's chunks appear ONCE under the Read row, not also duplicated in Agent's preview.

## Release pattern

Standard from v2.21–v2.28:
1. Merge PR.
2. Bump `package.json` to `2.29.0`. SDK unchanged.
3. Consolidate `Unreleased` → `## 2.29.0 (YYYY-MM-DD) — tool_output_delta Cleanup`. Cross-check Unreleased against `git log v2.28.0..HEAD`.
4. Tag `v2.29.0`, push tag, npm publish via `publish.yml`.
5. Write `project_v2_29_0.md` memory entry; update `MEMORY.md` index.

After v2.29.0, the only remaining v2.28+ follow-up is tree connector glyphs (`├─` / `└─` / `│`) — pure aesthetic; defer until users request.

## Rollback

Pure additive change to gating logic. Reverting the PR cleanly restores v2.27.0/v2.28.0 dual-path behavior (live duplication, but no broken paths). No state-shape migration; no config-schema change; no LLM-visible behavior change.
