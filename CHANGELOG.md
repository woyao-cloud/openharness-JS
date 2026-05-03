# Changelog

## 2.31.0 (2026-05-03) — Project Purge + Image Auto-Downscale

Three merged PRs from the post-v2.30.1 codebase-review follow-up cycle. `oh project purge` (#107) is a new user-facing CLI command; the other two ship as quality improvements. Critical-#2 from the review (the unwired sandbox module) was also resolved this release — deleted with documentation, with OS-level sandboxing kicked to issue #106 as future work. **1541/1541 tests pass** (was 1521 on v2.30.1; +20 — +10 from `oh project purge`, +10 from image auto-downscale, −5 from the deleted sandbox suite, +5 trickle from intervening test fixes). Typecheck and Biome clean across all three PRs.

### Added
- **`oh project purge [path]`** (#107) — delete all openHarness state for a project (`.oh/` directory plus the workspace-trust entry, defaulting to cwd). Mirrors `claude project purge` UX: default prints the deletion plan + asks for confirmation; `--dry-run` previews; `-y`/`--yes` skips the prompt. Sessions in `~/.oh/sessions/`, credentials, plugins, telemetry, traces, and global config are explicitly preserved — the plan output calls this out so users know what stays. `--all` deferred (no project registry); `--interactive` deferred (`--dry-run` covers the documented spec). Trust-file path is overridable via `OH_TRUST_FILE` env var so tests don't pollute the user's real `~/.oh/`.

### Fixed
- **Auto-downscale images > 2000px before encoding** (#108) — `ImageReadTool` and `FileReadTool` now route oversized PNG/JPEG/GIF/WebP reads through a new `downscaleIfLarge()` helper that clamps the longest dimension to 2000px (aspect ratio preserved, format preserved). Mirrors Claude Code v2.1.126's image-downscale behavior. Most providers reject or downsample above ~1568-2048px on the longest side; shipping a 4000px screenshot wastes input tokens, can exceed the request size limit, and historically broke the session if the oversized image landed in conversation history. PDFs / SVGs / BMPs pass through unchanged (sharp doesn't process them reliably). `sharp` moved from `devDependencies` to `optionalDependencies` so unsupported platforms still install — the helper transparently no-ops there. Any sharp error (corrupt image, weird subformat) returns the original buffer with `reason: "sharp-error"`; never fails a tool call over a downscale failure.

### Removed
- **Unwired sandbox module deleted (Critical #2 from the v2.30.0 codebase review)** (#105). `src/harness/sandbox.ts` shipped through v2.30.1 but was never wired into any tool — `isPathAllowed`, `isCommandAllowed`, `isDomainAllowed` had zero callers outside the module's own test, so configured `sandbox` rules in `.oh/config.yaml` had no runtime effect while implying a guarantee they couldn't deliver. Per the literature (Trail of Bits Oct 2025, CWE-561, top-tier agent designs), a userland allowlist alone isn't a meaningful boundary against model-controlled input; the right fix is OS-level sandboxing (bubblewrap / Seatbelt / Landlock+seccomp) which is real work that deserves its own design. `SECURITY.md` now documents the actual state and points users to devcontainers / [`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) / [Codex `linux-sandbox`](https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox) for high-trust modes. Wiring OS-level sandboxing tracked as issue #106. Surface removed: the `/sandbox` slash command, the `sandbox?` field on `OhConfig`, and the `invalidateSandboxCache` plumbing in `/reload-plugins`.

### Internal
- **Test count: 1521 → 1541** (+20 net). +10 from `oh project purge`, +10 from image auto-downscale, +5 from intervening test fixes, −5 from the deleted sandbox suite. (The earlier announcement on PR #108 cited 1536; +5 landed between then and the v2.31.0 cut as part of merge-time test additions.)
- **Two follow-up tracking issues filed.** #106 (OS-level sandboxing) and #109 (Windows CI flake in `hooks-b2.test.ts` and similar — fixed-`setTimeout(1500ms)` for hook subprocess spawn budget needs to be replaced with a poll-loop or callback-based capture).
- **Pattern reinforced for the 2nd time this audit cycle:** when a security feature is unwired, delete it. Don't leave it as a stub. Knight Capital / Apple `goto fail` / xygeni-YAGNI all named the antipattern; deleting the userland sandbox aligns with what Claude Code, Codex CLI, and Cursor all did before they shipped real OS-level sandboxing.

## 2.30.1 (2026-05-03) — Codebase-review patch fixes

Patch release bundling 8 bug fixes surfaced by an end-to-end codebase review of v2.30.0 (#104). Highest-priority fix: published v2.30.0's `dist/` shipped bare `require()` calls inside ESM modules, throwing `ReferenceError` for end users running `node dist/main.js` whenever they invoked ~10 slash commands. Tests passed against the pre-publish source because `tsx` (the test runner) polyfills `require` — production Node does not. Other fixes cover hook-pipeline parity in the streaming tool-execution path, OTLP correctness for OTel collectors, an Anthropic SSE parser drop on chunk boundaries, a `process.cwd()` race in parallel sub-agents, and three smaller bugs. **1526/1526 tests pass** (was 1508; +18 — 15 new regression tests for these 8 fixes, every one verified to fail with its corresponding source fix reverted).

### Fixed
- **Critical — `dist/` shipped bare `require()` in ESM modules.** `package.json` declares `"type": "module"`, so `node dist/main.js` threw `ReferenceError: require is not defined` whenever end users invoked `/roles`, `/agents`, `/plugins`, `/skills`, `/git rewind`, `/settings sandbox`, `/session export`, `/info doctor`, `/mcp-registry`, REPL path autocomplete, or InitWizard MCP setup. The `configChange` hook in `writeOhConfig` was wrapped in `try/catch` so it failed silently — never fired in production. Fixed by replacing 14 lazy `require()` calls across 10 files with static imports (plus one promise-chained dynamic `import()` in `harness/config.ts` where the `config ↔ hooks` cycle must stay broken).
- **High — `AgentDispatcher.runTask` mutated `process.cwd()` for parallel sub-agents.** Two tasks in different worktrees raced on the global cwd; one task's `chdir` could clobber the other's mid-execution. Fixed by plumbing cwd through `QueryConfig.workingDir` so each task carries its own cwd in `ToolContext` — no global mutation.
- **High — `StreamingToolExecutor` skipped the entire hook pipeline.** Tools resolved during LLM streaming didn't fire `preToolUse` / `postToolUse` / `postToolUseFailure` / `permissionRequest` / `permissionDenied` / `fileChanged` — only the slow path through `executeSingleTool` did. Audit trails missed streamed tools; `preToolUse` blockers and policy hooks silently didn't apply. Fixed by mirroring the canonical hook ceremony into the streaming path.
- **High — `PowerShellTool` used `execSync(string)`** which routed the command through `cmd.exe`. Cmd.exe pre-parsed `%VAR%`, `& | < > ^` etc. before PowerShell saw the command. Switched to `execFileSync("powershell.exe", [..., "-Command", input.command])` to bypass cmd.exe entirely.
- **Medium — `exportTraceOTLP` produced invalid hex IDs.** UUID hyphens and `"span-N"` literals were left in the OTLP payload; OTel Collector / Jaeger / Tempo validate hex encoding and silently rejected every span shipped by v2.30.0's brand-new OTLP path. Added a `toHexId` helper that strips non-hex chars and pads/truncates to 32 (traceId) or 16 (spanId/parentSpanId) chars.
- **Medium — `SessionTracer` fired one fetch per span with no batching, no flush-on-exit, errors swallowed.** Spans dropped at `process.exit` if the OTLP endpoint was slow or unreachable. Spans now buffer and microtask-coalesce into one POST per tick; new public `tracer.flush()` awaits every in-flight POST so callers can guarantee no spans drop at session end.
- **Medium — `AnthropicProvider` SSE parser declared `currentEvent` inside the chunk-read loop.** A TCP/TLS framing boundary between an `event:` line and its `data:` line silently dropped the event type, including `tool_call_complete` (so tool args were lost). Hoisted the declaration out of the loop so it persists across chunks.
- **Medium — `telemetry.getSessionFile` cached the first sessionId forever.** Subsequent `--resume` sessions in the same process wrote every event into the first session's `.jsonl`. Dropped the stale module-level cache; function is now stateless, with optional `OH_TELEMETRY_DIR` env override for tests.

### Internal
- **15 new regression tests, each verified to fail with its source fix reverted.** Streaming-hooks parity (5), OTLP batching + `flush()` + hex IDs (5), Anthropic chunk-boundary (1), telemetry sessionId routing (1), AgentDispatcher cwd plumbing (1), PowerShellTool cmd.exe bypass (2). Test count 1511 → 1526.
- **Critical #2 from the review remains deferred.** `src/harness/sandbox.ts` is dead code — `isPathAllowed` / `isCommandAllowed` / `isDomainAllowed` have no callers outside the module's own test, so configured sandbox rules have no runtime effect today. Needs a design call: wire the gates into the 5 risky tools (`Bash`, `PowerShell`, `FileEdit`, `FileWrite`, `MultiEdit`) or delete the module and document that sandboxing isn't implemented yet. Filed for follow-up; not blocking this patch release.

## 2.30.0 (2026-05-03) — Observability

End-to-end observability ships. The `SessionTracer` infrastructure (built pre-v2.20, then sat unused for ~6 weeks because it was never wired) now has three integration paths landed in concert: opt-in span emission from the query loop and tool dispatch (C.1, #101); a tightened CI perf gate that actually catches regressions (C.2, #102); and OTLP HTTP shipping to remote collectors (Jaeger, Honeycomb, Grafana Tempo, etc. — C.3, #103). Plus four portfolio-piece docs PRs that landed alongside (#97 README refresh, #98 examples/, #99 CONTRIBUTING refresh, #100 ARCHITECTURE.md). 7 PRs total. **1508/1508 tests pass** (was 1502; +6).

### Added
- **End-to-end opt-in OTel-style tracing (audit C — observability)**. `SessionTracer` (built pre-v2.20, never wired into production) is now wired three ways:
  - **`OH_TRACE=1`** at REPL startup creates a session-scoped `SessionTracer` and persists every span as JSONL to `~/.oh/traces/<sessionId>.jsonl`.
  - **`query()` emits a `query` span** at function entry covering the full agent loop, ended from a `finally` block guaranteeing emission on every exit path (success / abort / budget exceeded / error). Carries `model`, `permissionMode`, `toolCount`, and final `turns` count as attributes.
  - **`executeSingleTool` and `StreamingToolExecutor`** each emit a `tool:<Name>` span per tool dispatch, parented to the query span. Status `ok` or `error`; error message captured in attributes.
  - **New `/traces` slash command** to inspect persisted traces. No args → list sessions with span counts + total duration + error counts. With session id → show full formatted span tree via `formatTrace()`.
- **OTLP HTTP shipping for live observability (C.3)**. `SessionTracer` constructor now accepts an optional `OTLPConfig` (`endpoint` + optional `headers`). Each ended span fires-and-forgets a POST of an OTLP-shaped payload to the configured collector. Errors swallowed in a `.catch(() => {})` — telemetry must never crash the agent. REPL reads `OH_OTLP_ENDPOINT` and `OH_OTLP_HEADERS` (JSON-encoded headers object for auth) env vars and threads them to the tracer. Drop-in compatible with any OTLP/HTTP receiver:
  ```bash
  OH_TRACE=1 OH_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces \
    OH_OTLP_HEADERS='{"X-Honeycomb-Team":"abc123"}' oh
  ```
- **Tightened renderer perf budgets + 3 new perf benchmarks (C.2)**. Existing `src/renderer/perf.test.ts` budgets (50ms / 100ms / 20ms) were 100-400x off actual measured performance — they'd never catch a real regression. Tightened to 10ms / 5ms / 3ms (~20-30x dev-machine headroom, ~6-7x slow-CI headroom — comfortable margin without flake risk). Plus 3 new benchmarks: `query()` 1-turn overhead (50ms budget), `buildToolCallTree` on 100 flat nodes (1ms budget), `buildToolCallTree` on 100 nested nodes depth 3 (1ms budget). Catches regressions in the per-frame hot path AND the per-call dispatch path AND the per-render tree build.
- **Examples directory (`examples/`)**. 4 self-contained, runnable examples (`headless-code-review.sh`, `sdk-python-batch-summarize.py`, `sdk-typescript-streaming-events.ts`, `mcp-config-sample.yaml`) covering CLI / Python SDK / TypeScript SDK / MCP config. Each example uses verified surfaces (cross-checked against the actual SDK source) — no fabricated APIs.
- **Root-level `ARCHITECTURE.md`**. Contributor-oriented architectural deep-dive (250 lines): high-level data-flow diagram, 8-step lifecycle of one user message with file:line pointers, key abstractions (Tool/Provider/StreamEvent/LayoutState/Hook/MCP) with their actual TypeScript signatures, major design decisions with rationale (sequential renderer vs Ink, parentCallId for nested tool calls, typed dispatch, per-task synthetic parents, progressive tool loading, worktree isolation), engineering practice (spec/plan workflow, tests, CI), guided "where to start reading" sequence.

### Changed
- **`CONTRIBUTING.md` refreshed**. Was last updated 2026-04-12; predated the spec/plan workflow that's been load-bearing for ~6 weeks. Project structure section expanded from 4 paths (1 incorrect — claimed `src/components/` is the REPL, but the REPL is `src/repl.ts` and the renderer is `src/renderer/`) to 18 paths with accurate one-liners. Added: full npm scripts table, "Adding a Tool" section (with the README badge bump reminder), spec/plan workflow section, conventional commit conventions section, testing patterns section.
- **`README.md` + `README.zh-CN.md` refreshed (bilingual)**. Test count badge `tests-890` → `tests-1502` (5 releases stale). Tools count badge `tools-42` → `tools-44`. Tool section heading `Tools (43)` → `Tools (44)` / `工具（43 个）` → `工具（44 个）`. 4 new bullets added to Terminal UI > Features list covering recently-shipped surfaces (spinner stage labels, tool-type color coding, rich tool output rendering, nested tool calls, multi-line wrap glyph).

### Internal
- **6+ "already-built-but-unwired" pattern hits across the audit cycle.** The `SessionTracer` C.1 wiring brought the count from 5 to 6. Same lesson reinforced: when designing new infrastructure, grep for existing infra first — the codebase often has a well-designed module sitting unwired, and wiring is cheaper than building. Pattern documented in `feedback_small_pr_scope.md`.
- **Small-scope correlation continued.** v2.27 (~700 src lines, 2 review-cycle bugs) → v2.28 (~150 src lines, 0 bugs) → v2.29 (~5 src lines, 0 bugs) → v2.30 = **3 separate small PRs (#101 / #102 / #103) instead of one large bundled PR for the C work, and 4 separate docs PRs (#97 / #98 / #99 / #100) instead of one big polish PR**. 0 review-cycle bugs across all 7 PRs. Pattern from `feedback_small_pr_scope.md` reinforced.
- **CC parity audit refreshed** (filed in `project_v2_30_deferred_audit.md`). Surveyed CC v2.1.126 (the only CC release between 2026-04-27 and 2026-05-02). 2 small candidate gaps found (`oh project purge` ~100 lines, image auto-downscale > 2000px ~30 lines); no structural tier-level work. Filed for later pickup; can sit deferred indefinitely without blocking.
- **Test count: 1508/1508 pass** (was 1502 on v2.29.0; +6 — 3 C.1 tracer wiring tests + 3 C.3 OTLP shipping tests; C.2 added 3 perf benchmarks not new test files. Net +6.)

## 2.29.0 (2026-05-02) — tool_output_delta Cleanup

Cleanup follow-up to U-C5 (deferred from v2.27.0 spec, line 302). Eliminates the dual-path duplication where `tool_output_delta` from inner Agent tools rendered both in the parent Agent's `liveOutput` preview AND under the child tool's row in the REPL — same lines visible twice. Single PR (#96), 1 commit, **1502/1502 tests pass** (was 1500; +2). Tiniest scope of the recent cycles — 5 source lines, 2 unit tests, 0 review-cycle bugs.

### Fixed
- **Inner `tool_output_delta` no longer renders twice in the REPL.** When `AgentTool` forwards an inner tool's `tool_output_delta` event, it now picks ONE rendering path: the v2.27.0-introduced `emitChildEvent` (forwarded path → child's row gets its own `liveOutput`) takes precedence over the legacy `onOutputChunk` (parent preview path). The `if/else` gate uses `forwardInnerEvent`'s existing boolean return value: when forwarding succeeds (`true`), `onOutputChunk` is skipped; when forwarding doesn't fire (no `emitChildEvent` in context — i.e., SDK / non-REPL caller), `onOutputChunk` runs as fallback so chunks remain visible somewhere. Pre-v2.27.0 SDK behavior preserved exactly; REPL gets clean per-row chunk rendering.

### Internal
- **Spec & plan**: `docs/superpowers/specs/2026-05-02-tool-output-delta-cleanup-design.md` (~140 lines) and `docs/superpowers/plans/2026-05-02-tool-output-delta-cleanup-plan.md` (~260 lines, 3 tasks). Approach was the obvious one given v2.27.0 already designed `forwardInnerEvent` to return `boolean` for testability — the runtime gating use is a natural consequence of that design.
- **Inline implementation, no subagent.** 5-line change too small for subagent dispatch overhead. Same lesson as v2.28.0 Task 1 (3 string-literal extensions): mechanical changes that don't require codebase exploration are faster inline.
- **Test count: 1502/1502 pass** (was 1500; +2 — both tests verify `forwardInnerEvent`'s boolean return value, the runtime contract the new gate depends on).

## 2.28.0 (2026-05-02) — ParallelAgents Task Parents

Picks up the highest-impact deferred follow-up from v2.27.0's spec (line 297-301): synthesizes per-task `tool_call_start` / `tool_call_complete` / `tool_call_end` wrapper events inside `AgentDispatcher.runTask` (toolName: `"Task"`), giving `ParallelAgents` a 3-level structure (`ParallelAgents → Task → child tool`) instead of v2.27.0's flat children. Single PR (#95), 4 commits, **1500/1500 tests pass** (was 1496; +4). Pure additive change — no new event types, no public schema changes; reuses every piece of v2.27.0 plumbing (parentCallId stamping, tree builder, hierarchical renderer, depth-3 limit). Smaller scope than v2.27.0 — 0 review-cycle bugs caught, vs 6 in v2.26.0 / 2 in v2.27.0.

### Added
- **Per-task synthetic wrapper events in `AgentDispatcher.runTask` (audit U-C5b)**. Each task now emits 3 synthetic events around its inner-query loop: `tool_call_start { toolName: "Task", callId: "task-${task.id}-${epoch36}", parentCallId: parallel.callId }`, `tool_call_complete { arguments: { description: task.description ?? task.id } }`, and `tool_call_end { output, isError }` (from the `finally` block — fires on every exit path: success, inner error event, outer catch, abort). Children inside the inner loop now stamp `parentCallId = taskCallId` (the synthetic id) instead of the bundled `parallel.callId` like v2.27.0's flat grouping. All synthesis is gated by `synthEnabled = !!emitChildEvent && !!parentCallId` — SDK / non-REPL callers see no behavior change.
- **REPL + renderer recognize `"Task"` as agent-like.** Three `isAgent` / `isAgentCall` / `isAgentTool` checks each get `|| toolName === "Task"` appended (`src/repl.ts` 2 sites, `src/renderer/layout-sections.ts` 1 site). Result: synthetic Task rows render with the same ⊕/◈/◇ icon and `S_AGENT` cyan-bold style as Agent and ParallelAgents, and their `arguments.description` flows into `agentDescription` for indented-row display via the existing v2.27.0 handler.

### Changed
- **`AgentDispatcher.runTask` exit-path restructure** — single-emission of synthetic `tool_call_end` from `finally` requires that all `return` statements inside the body assign to a single `result: AgentTaskResult` first. The inner for-await early-return on `event.type === "error"` was converted to `break` + post-loop `errorMessage` branch. Existing worktree cleanup, `process.chdir` restoration, and abort-signal handling all preserved.

### Deferred (documented for v2.29+)
- **Migration of `tool_output_delta` away from `onOutputChunk`** — once the new event-forwarding path is verified in production, deprecate the older per-call callback path. Today both fire for forwarded deltas, causing the same lines to render twice (once in parent's preview liveOutput, once under the child's row). Cleanup commit only — no behavior change for non-Agent tools.
- **Tree connector glyphs** (`├─` / `└─` / `│`). Aesthetic only; defer indefinitely or until users request.
- **Truly live mid-tool streaming for inner tool-call events.** The `Promise.race`-style refactor remains deferred — children still flush when their parent's `tool_call_end` is yielded, in temporal order, but not mid-tool execution.

### Internal
- **Spec & plan**: `docs/superpowers/specs/2026-05-02-u-c5b-parallel-task-parents-design.md` (~238 lines) and `docs/superpowers/plans/2026-05-02-u-c5b-parallel-task-parents-plan.md` (~553 lines, 4 tasks). Approach 1 (synthesize events inside runTask) chosen over (A2) adding `taskCallId` field to AgentTask schema and (A3) renderer-side virtual grouping — A1 is symmetric with how AgentTool already emits its own outer `tool_call_start/end` and reuses every v2.27.0 piece.
- **Subagent-driven development pattern with two-stage review** (matching v2.26.0 / v2.27.0). 4 tasks: Task 1 trivial enough to do inline (3 string-literal extensions), Tasks 2-3 dispatched to subagent with combined spec+quality review after both. **0 review-cycle bugs caught** — smallest scope of the recent release cycles.
- **Stale-IDE-diagnostic noise (11th occurrence in audit cycle).** Test file diagnostics were line-offset by 2 (referencing the wrong line — confirmed stale snapshot). Pattern reinforced: when system-reminder diagnostics contradict the implementer's report, run `npm run typecheck` directly.
- **Test count: 1500/1500 pass** (was 1496; +4 — 3 new dispatcher tests for synthetic emission + 1 renderer integration test for 3-level rendering. 2 existing v2.27.0 forwarding tests updated to expect the new event sequence).

## 2.27.0 (2026-05-02) — Nested Tool Calls

Closes Tier U-C5 of the 2026-04-27 UI/UX-parity plan (`~/.claude/plans/2-typescript-sdk-moonlit-hinton.md`) — the **last item** in the audit. After v2.27.0, the entire UI/UX-parity audit is closed. Single PR (#94), 14 commits, **1496/1496 tests pass** (was 1465; +31). When `Agent` or `ParallelAgents` spawns inner tool calls (Read, Bash, Edit, …), those child calls now render indented under their spawning parent in the live REPL — instead of being invisible to the outer event stream as they were in every prior release. Approach 1 (direct event passthrough via a new `ToolContext.emitChildEvent` callback) was chosen over snapshot-bundling and dual-channel alternatives because it matches OH's existing `tool_output_delta` plumbing pattern and aligns with `traces.ts`'s OTel-style `parentSpanId` shape (9th grep-first hit across the audit cycle). The new `parentCallId?` field is optional everywhere — pure additive change with a clean rollback path.

### Added
- **Optional `parentCallId?: string` on the live event layer (audit U-C5)**. Added to `ToolCallStart`, `ToolCallComplete`, `ToolCallEnd`, and `ToolOutputDelta` events, plus `ToolCallInfo` renderer state. Optional everywhere = non-breaking. Mirrors the existing OTel-style `parentSpanId` already on `traces.ts` (durable observability layer); U-C5 adds the same idea to the live UI feed.
- **`ToolContext.emitChildEvent?` callback**. New optional method on `ToolContext` that AgentTool / AgentDispatcher inner-query loops use to forward 4 event types to the outer stream, stamped with the parent's callId. Outer query loop in `src/query/tools.ts` sets the callback on every per-tool context; existing `outputChunks` buffer was renamed to `childEvents` and broadened to accept all 4 event types instead of only `tool_output_delta`. Buffer drains preserve temporal ordering — children appear in the outer stream immediately after their parent's `tool_call_end`.
- **`AgentTool` foreground inner-event forwarding (audit U-C5)**. `src/tools/AgentTool/index.ts` exports `forwardInnerEvent(event, ctx)` helper used by the foreground inner-query loop. Forwards `tool_call_start`, `tool_call_complete`, `tool_call_end`, and `tool_output_delta`. Background-execution branch (`run_in_background: true`) intentionally NOT forwarded — background agents detach from the live stream by design. The forwarding is guarded by `if (context.emitChildEvent && context.callId)` so plain (non-Agent) tool execution paths are unaffected.
- **`AgentDispatcher` (ParallelAgents) inner-event forwarding (audit U-C5)**. `src/services/AgentDispatcher.ts` exports `forwardChildEvent(event, parentCallId, emit)`; constructor extended with two trailing optional params (`parentCallId?: string`, `emitChildEvent?`). `src/tools/ParallelAgentTool/index.ts` threads `context.callId` and `context.emitChildEvent` through. **v1 simplification:** all child events from all tasks stamp `parentCallId = ParallelAgents.callId` — single level of nesting under the bundled call. Per-task synthetic-parent grouping (`ParallelAgents → task → child tool` 2-level structure) is deferred to v2.28+ pending real demand.
- **Tool-call tree builder (`src/renderer/tool-tree.ts`)**. Pure function `buildToolCallTree(toolCalls): TreeNode[]` walks the flat `Map<callId, ToolCallInfo>` and produces a depth-first parent-child tree. Cycle defense via `seen` set (cycles shouldn't occur in practice — callIds are unique, parent set once at creation — but defending is cheap). Orphan fallback: a child whose `parentCallId` references a missing call renders at depth 0 instead of being hidden. Preserves the original `ToolCallInfo` reference inside each node (no cloning). 8 unit tests cover empty / single root / one child / multiple children in insertion order / multi-level (root → child → grandchild) / orphan fallback / cycle defense / reference preservation.
- **Hierarchical rendering with depth-3 indent limit**. `src/renderer/layout-sections.ts:renderToolCallsSection` now walks the call tree depth-first instead of the flat map. Each call's column offset is `depth * 4` — child glyph at col 6, grandchild at col 10, etc. All width-affecting calls (`agentDescription` slice, `liveOutput` line slice, `renderToolOutput` width budget) reduce by `colOffset` so indented content respects available terminal width. At `depth > 3`, render `… (N more level(s))` collapse line at `MAX_DEPTH * 4 = 12` (fixed column anchored at the deepest valid depth — keeps the marker visible on narrow terminals instead of pushing it off-screen on truly deep trees) and stop descending. 4 integration tests in `ui-ux.test.ts` cover Agent → child / Agent → Agent → Read 3-level / ParallelAgents flat children / 5-level collapse marker.

### Fixed
- **Agent → Agent → Read flattening (caught in final review, fixed in same PR)**. The first iteration of `forwardInnerEvent` always wrote `parentCallId: context.callId`, which overwrote any inner-stamped parentCallId from a deeper Agent. Result: a child of an inner Agent rendered as a sibling of that Agent at depth 1 instead of as a grandchild at depth 2. Fixed to `event.parentCallId ?? context.callId` — preserves any pre-stamped parent (the same `??` fallback pattern the REPL handlers already used). The integration test for Agent → Agent → Read happened to set `parentCallId` directly on `ToolCallInfo`, bypassing the forwarding flow, so the test passed despite the bug; added a forwarding-chain unit test that actually exercises the path.
- **Singular pluralization on collapse marker**. The depth-3 collapse line was hard-coded "more levels"; now correctly pluralizes (`1 more level` / `2 more levels`).
- **`emitChildEvent` local type was wider than the `ToolContext` interface (caught in code review)**. The local lambda in `query/tools.ts` accepted `StreamEvent` (the entire union) but `ToolContext.emitChildEvent` is the narrower 4-type union (`ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta`). The mismatch compiled (function-parameter contravariance) but made the interface guard a no-op. Narrowed the local lambda to match the interface exactly.

### Changed
- **`outputChunks: StreamEvent[]` → `childEvents: StreamEvent[]`** in `src/query/tools.ts:executeToolCalls`. Same buffer pattern, broadened to carry all 4 event types instead of only `tool_output_delta`. Both call sites (concurrent batch + serial loop) now spread `{ ...context, callId: tc.id, onOutputChunk, emitChildEvent }` into the per-tool context. Drain order preserved — buffered children flush BEFORE the parent's `tool_call_end` is yielded, so the outer stream order is `child(c1).start … child(c1).end, parent.end`.

### Deferred (documented for v2.28+)
- **Per-task synthetic parents under ParallelAgents** (~1 day) — synthesize `tool_call_start` / `tool_call_end` events for each task in `AgentDispatcher`, giving 2-level structure (`ParallelAgents → task → child tool`) instead of v1's single-level grouping. Defer until user feedback confirms the flat children are insufficient.
- **Migration of `tool_output_delta` away from `onOutputChunk`** — once `emitChildEvent` is verified in production, deprecate the older per-call callback path. Today both paths fire for forwarded deltas, which causes the same lines to render twice (once in the parent's preview liveOutput, once under the child's row). Cleanup commit only — no behavior change for non-Agent tools.
- **Tree connector glyphs** (`├─` / `└─` / `│`). Aesthetic only; defer indefinitely or until users request. The current indent-only convention reads cleanly without them and avoids visual noise on streaming live updates.
- **Truly live mid-tool streaming for inner tool-call events.** Today the `childEvents` buffer drains AFTER each tool returns (lines 393, 412 in `query/tools.ts`); children appear in the outer stream when the parent Agent's `tool_call_end` is yielded, in temporal order — but not mid-execution. Truly live mid-tool interleaving would require `Promise.race`-style refactoring of the existing `await tool.call(...)` and is out of scope for v2.27.

### Internal
- **Spec & plan**: `docs/superpowers/specs/2026-05-01-u-c5-nested-tool-calls-design.md` (~302 lines) and `docs/superpowers/plans/2026-05-01-u-c5-nested-tool-calls-plan.md` (~1128 lines, 9 TDD tasks). Approach 1 (direct event passthrough via new context callback) was chosen over Approach 2 (bundled snapshot via new `agent_summary` event) and Approach 3 (separate child stream channel) — A1 matches OH's existing `tool_output_delta` plumbing pattern and adds the smallest delta from current architecture.
- **Grep-first finding (9th hit across the audit cycle).** `src/harness/traces.ts` already had OTel-style `spanId` / `parentSpanId` on the durable observability layer. Confirmed the U-C5 architectural choice: parent correlation on the live event stream uses the same idea, just on a different object (TraceSpan for durable observability, ToolCallInfo for live render state). The grep also confirmed `parentCallId` did NOT yet exist anywhere in source — genuine new infrastructure, not already-built-but-unwired.
- **Stale-IDE-diagnostic noise during agent-driven dev (10 occurrences this cycle).** Saw 10 false-positive "module not found" / "import unused" diagnostics fired by the IDE while subagents were creating/editing files. Each verified via fresh `npm run typecheck`. Pattern reinforced from v2.26.0: when a system-reminder reports a TypeScript diagnostic that contradicts the implementer's report, run `npm run typecheck` directly — don't pause to investigate the IDE.
- **Subagent-driven development with two-stage review** (matching v2.26.0 pattern) — 9 implementer dispatches, two-stage spec+quality review per task, with the final whole-branch review catching 2 real bugs (depth-flatten, pluralization) that landed as fixup commits in the same PR. Total: 14 commits.
- **Test count: 1496/1496 pass** (was 1465; +31 — exceeded the plan's +22 estimate due to upscoped helper testing in Tasks 4 & 5, where the implementer chose to extract `forwardInnerEvent` / `forwardChildEvent` helpers and unit-test them directly rather than stub the inner `query()` async generator).

## 2.26.0 (2026-05-01) — Rich Tool Output

Closes Tier U-C4 of the 2026-04-27 UI/UX-parity plan (`~/.claude/plans/2-typescript-sdk-moonlit-hinton.md`). Tool output is no longer rendered as plain split-on-newline lines — it now dispatches through a typed-or-heuristic chain to JSON-tree, markdown, image, or plain renderers. Single PR (#93), 12 commits, 1465/1465 tests pass (was 1418; +47). After this release, only U-C5 (nested tool-call display) remains in the audit, deferred to v2.27+ pending an event-protocol RFC for `parentCallId` plumbing. Approach 4 (typed dispatch with heuristic fallback) was chosen over heuristic-only after a best-practice review surfaced that MCP / Anthropic Messages API / OpenAI tool schemas all type their content — making typed dispatch the modern standard. The optional `outputType?` field is non-breaking everywhere.

### Added
- **Static colored JSON tree renderer (audit U-C4)**. New `src/renderer/json-tree.ts` exports `renderJsonTree(grid, row, col, value, width, opts)`. Theme-driven colors (keys → identifier, strings → success-green, numbers/booleans/null → tool-yellow, punctuation/truncation → dim). Two-space indent per nesting level, `MAX_DEPTH=3` collapse with `{…}` for objects and `[N items]` for arrays, line truncation with `… (N lines total)` footer, circular-reference safety (emits `[Circular]` inline with the key, not as opener+marker+closer). 12 unit tests cover primitives, nested objects/arrays, depth collapse, line truncation, circular refs, empty containers, null/booleans, and the `opts.limit` boundary.
- **Tool-output dispatcher (audit U-C4)**. New `src/renderer/output-renderer.ts` exports `renderToolOutput`, `tryParseJson`, `looksLikeMarkdown`, and the `OutputType` union. Detection chain: `__IMAGE__:` sentinel always wins; then typed `outputType` dispatch (`"json"` → JSON tree with plain fallback on parse failure, `"markdown"` → markdown renderer, `"plain"`/`"image"` → plain); then heuristic fallback (`JSON.parse` → JSON tree, structural markdown markers → markdown renderer, otherwise plain). Conservative heuristics: prose with a single `|` doesn't trigger; JSON parse requires the trimmed string to start with `{` or `[`; markdown requires a fenced code block, table separator, or ≥2 ATX headings. CRLF-aware (`\r?\n` in the fenced regex) so Windows file content via FileReadTool detects correctly. 24 unit tests cover all dispatch branches.
- **Optional `outputType?` field on `ToolResult` / `ToolCallEnd` / `ToolCallInfo`**. Renderer hint, not LLM-visible content (the model still sees only `output`). Optional everywhere = non-breaking. Plumbed end-to-end: `Tool.call()` → `executeSingleTool` → `tool_call_end` event → REPL handler → `ToolCallInfo` → `renderToolCallsSection` → `renderToolOutput`. Tools that don't stamp the field rely on the heuristic.
- **`FileReadTool` stamps `outputType` from path extension**. `.json` → `"json"`, `.md` / `.markdown` → `"markdown"`, everything else → `"plain"`. Image-output sites (PNG / PDF-fallback via `__IMAGE__:` sentinel) and error-output sites are intentionally unstamped — sentinel always wins; errors stay plain. PDF-text and notebook-text branches stamp `"plain"` (extracted text, not the binary container or the `.ipynb` JSON structure). 3 stamping tests in a new `src/tools/FileReadTool/index.test.ts`.
- **`WebFetchTool` stamps `outputType` from response Content-Type**. Matches `application/json` plus structured JSON variants per RFC 6839 (`application/vnd.api+json`, `application/ld+json`, `application/hal+json`, etc. — the regex is `/^application\/(?:[a-z0-9.+-]+\+)?json\b/`); `text/markdown` → `"markdown"`; everything else → `"plain"`. 4 stamping tests in a new `src/tools/WebFetchTool/index.test.ts` cover the JSON, markdown, structured-JSON-variant, and default-plain cases.

### Fixed
- **Renderer-state output cap was too tight for rich rendering (precondition the spec missed)**. `repl.ts:1027` truncated `tc.output` to 500 chars before storing in renderer state. JSON.parse would have failed on essentially every real JSON file (Read of `package.json` is ~3KB). Bumped to 16 KiB and extracted as a named constant `TOOL_OUTPUT_RENDER_CAP` so the storage-cap and slice-call sites stay in sync. Incidentally also fixes truncated base64 image rendering for large images (a 100KB PNG sliced to 500 bytes was unrenderable in graphical terminals).
- **`json-tree` theme cache wasn't reset on `/config theme` switch**. Like `markdown.ts` / `layout.ts` / `diff.ts`, `json-tree.ts` uses a lazy-init style cache (`_stylesInit` flag). Added `resetJsonStyleCache()` export and wired into the `__SWITCH_THEME__` block in `repl.ts` alongside the three existing renderer resets. Without this, JSON tree colors would have stayed in the old theme until process restart.
- **CRLF fenced-code blocks not detected by markdown heuristic**. The original regex `/```[\w]*\n/` required a bare `\n` immediately after the language tag. On Windows file content (read by FileReadTool from a Windows-line-ending file), `\r\n` followed the tag and the regex missed. Fixed to `\r?\n`. Markdown rendering of Windows-authored `.md` files now triggers heuristic detection correctly.
- **Truncation footer could overflow narrow terminals**. The `… (N lines total)` footer in `renderPlain` was written without a `width` slice; `grid.writeText` defaulted to `grid.width` instead of the caller's column budget. Sliced to `width` to match the per-line write pattern.
- **Structured JSON media types regressed to `"plain"`**. The first `WebFetchTool` stamping iteration used `ct.includes("application/json")`, which missed `application/vnd.api+json` etc. Before Task 8, `outputType` was undefined for those responses and the heuristic `tryParseJson` would still detect them; after the explicit "plain" stamp, they bypassed the heuristic. Broadened the regex to catch the `+json` suffix per RFC 6839.

### Changed
- `src/renderer/layout-sections.ts:219-239` — the 21-line image-or-plain branch in `renderToolCallsSection` is replaced with a 7-line `renderToolOutput(grid, r, 6, tc.output, tc.outputType, w - 8, { status: tc.status, maxLines: 20, limit })` call. `S_DIM` and `S_ERROR` declarations stay (still used elsewhere in the file). `isImageOutput` and `renderImageInline` are no longer imported here — they're internal to `output-renderer.ts` now.

### Deferred (documented for v2.27+)
- **MCP image-content preservation**. `src/mcp/client.ts:181-184` filters MCP `content[]` for `type === "text"` only and drops images / resources / audio. Refactoring would add ~2 days of plumbing including reconnect/retry edge cases for binary content. None of the popular MCP servers currently emit image content, so deferred until real-world demand.
- **Stamp every other built-in tool**. The other 37 tools rely on heuristic detection — which is correct because most return either plain text (Glob, Grep, LS, Bash output, etc.) or already-known formats that the heuristic catches reliably. Stamp opportunistically as tools are touched for unrelated reasons.
- **`OutputType` union duplicated in 3 type files**. `src/Tool.ts`, `src/types/events.ts`, and `src/renderer/layout.ts` each repeat `"json" | "markdown" | "image" | "plain"` inline. Now that `output-renderer.ts` exports `OutputType` as a named alias, those three call sites could import it. Cleanup commit can land independently.

### Internal
- **Spec & plan**: `docs/superpowers/specs/2026-05-01-u-c4-rich-tool-output-design.md` (~384 lines) and `docs/superpowers/plans/2026-05-01-u-c4-rich-tool-output-plan.md` (~1244 lines, 9 TDD tasks). Approach 4 (typed dispatch with heuristic fallback) was chosen after evaluating four alternatives; the spec rejected the original heuristic-only proposal once best-practice review surfaced that the modern tool-protocol ecosystem (MCP, Anthropic Messages API, OpenAI) all type their content.
- **Grep-first lesson hits an 8th time across the audit cycle**. The original audit framing of U-C4 was "rich tool-result display: tables / image / structured-JSON renderers" with "needs UX spec first." Grep-first inspection significantly reduced scope: `src/renderer/image.ts` was already shipped and wired (Kitty/iTerm2 protocols via `__IMAGE__:` sentinel detection in `layout-sections.ts:220-221`); `src/renderer/markdown.ts:362-420` had a complete `renderTable()` for markdown tables but it only ran inside `renderMarkdown()` for assistant-message text, never reaching tool output. The genuine gaps were: (1) wiring markdown into the tool-output path, (2) JSON-tree pretty-print, (3) auto-detection / typed dispatch.
- **Test count: 1465/1465 pass** (was 1418; +47 — exceeded the plan's +32 estimate due to fixup tests caught during the 8 spec+code-quality review cycles).

## 2.25.0 (2026-04-30) — Visibility

Closes Tier U-C1/U-C2/U-C3 of the 2026-04-27 UI/UX-parity plan (`~/.claude/plans/2-typescript-sdk-moonlit-hinton.md`). Three pure-renderer polish items in one PR (#92): differentiated spinner stage labels, multi-line input continuation glyph, and tool-type color coding. After this release, OH's interactive REPL surface matches Claude Code's stable surface where parity is meaningful — only Tier U-C4 (rich tables/JSON tree) and U-C5 (nested tool-call display) remain, both deferred to v2.26+ pending UX spec. Two real bugs were caught during code review and fixed in the same PR: a shimmer-period regression that pre-existed in the spinner formula but only became user-visible with the new longer labels, and a continuation-line alignment regression where the implementation plan accidentally diverged from the original column-base used by `computeCursorPosition`.

### Added
- **Differentiated spinner stage label (audit U-C1)**. The "Thinking…" spinner now reflects which phase the agent is in: `Thinking` while waiting on the LLM, `Running <ToolName>` when a single tool is executing (e.g., `Running Bash`, `Running Edit`), `Calling <server>:<tool>` when an MCP tool is active (e.g., `Calling filesystem:read_file` for `mcp__filesystem__read_file`), and `Running N tools` for parallel fan-out. Pure-render derivation from `state.toolCalls` — no new query events. Mirrors Claude Code's verb-form spinner labels. Elapsed-time color staging (primary → stall → error) is unchanged.
- **Multi-line input wrap glyph (audit U-C2)**. Every non-last line of a multi-line input (Alt+Enter) now ends with a dim `↵` continuation glyph so the wrap is visually marked. The last line stays unmarked. The existing `[N lines]` suffix on row 0 wins when it would collide with the glyph. Mirrors Claude Code's continuation indicator.
- **Tool-type color coding (audit U-C3)**. The tool-call section's status icon and tool name are now color-coded by category instead of a uniform yellow: Read tools (`Read`/`Glob`/`Grep`/`WebFetch`/`WebSearch`/`ExaSearch`) → cyan; mutating tools (`Edit`/`Write`/`NotebookEdit`) → yellow; exec tools (`Bash`/`PowerShell`) → magenta; MCP tools (`mcp__*`) → green. `Agent`/`ParallelAgents` keep their existing cyan-bold `S_AGENT` style via the short-circuit. Done-state and error-state colors (`S_GREEN`/`S_ERROR`) are unchanged.

### Fixed
- **Spinner shimmer no longer slows on long labels.** The shimmer's modulus was `(thinkText.length + 6)` which scaled with label length. With audit U-C1 producing labels like `Calling filesystem:read_file` (28 chars), the shimmer slowed by ~2.4x compared to the prior fixed `Thinking` label. Switched to a fixed period of 20 to match `renderThinkingSection`.

### Internal
- New `src/renderer/spinner-label.ts` — `deriveSpinnerLabel(toolCalls)` pure function. 8 unit tests cover empty / done-only / single-tool / single-mcp / malformed-mcp / mcp-with-empty-server / multi-tool / mixed-status.
- New `src/renderer/tool-color.ts` — `toolColor(toolName)` pure function. 7 unit tests cover each category, the `mcp__` prefix path, the unknown-tool fallback, and the Agent fallback (Agent is intentionally not in the map; the caller short-circuits via `isAgent` before consulting `toolColor`).
- `src/renderer/layout-sections.ts:renderSpinnerSection` (line 110) replaces hardcoded `"Thinking"` with `deriveSpinnerLabel(state.toolCalls)`. `renderToolCallsSection` (lines 163-166) replaces the single `S_YELLOW` non-Agent path with a `toolColor(tc.toolName)`-derived `Style`. `renderInputSection` appends `↵` after every non-last input line (clipped to grid width), yielding to `[N lines]` on row 0 when they would collide.
- 3 new integrated snapshot tests in `src/renderer/ui-ux.test.ts` cover the spinner-label / wrap-glyph / category-color behavior end-to-end.
- **Cleanups (carry-forward from #91):** dropped unused `_elapsed = …` line at `src/repl.ts:1024`. Migrated `require("../harness/config.js")` at `src/renderer/index.ts:430` (inside `handlePermissionKey`) to a static import — the v2.23.0 ESM-`require()`-swallow footgun memory had flagged this as the next file to touch.

## 2.24.0 (2026-04-30) — Status & Hyperlinks

Closes Tier U-B of the 2026-04-27 UI/UX-parity plan (`~/.claude/plans/2-typescript-sdk-moonlit-hinton.md`). Four shipped items (#87/#90/#91) plus one already-shipped audit closeout (U-B4 inline diff syntax — discovered grep-first). Adds Exa neural search (#88) as a peer to the existing DuckDuckGo-backed `WebSearch` tool. After this release, OH's interactive REPL surface matches Claude Code's stable surface where parity is meaningful — only Tier U-C (visibility polish: spinner stage, wrap glyph, tool-type colors, rich tables/JSON tree, nested tool-call display) remains, scheduled for v2.25.0+.

### Added
- **JSON-envelope `statusLine` script (audit U-B1)**. Mirrors Claude Code's `statusLine` config. New `statusLine: { command, refreshMs?, timeoutMs? }` config block. On each REPL refresh, OH spawns the configured shell command, pipes a JSON envelope `{ model, tokens, cost, contextPercent, sessionId, cwd, gitBranch }` on stdin, and uses the trimmed first line of stdout as the status line. Output is cached per envelope-hash for `refreshMs` (default 1000, min 100) so the script doesn't re-spawn on every keypress. Multi-line output truncates to the first line (multi-line would corrupt the row). Failures (non-zero exit, timeout, spawn error, missing command, empty stdout) silently fall through to the existing `statusLineFormat` template / default rendering. Gated through the workspace-trust system (audit U-A4) — scripts only execute in trusted dirs.
- **OSC 8 hyperlinks in tool output and markdown links (audit U-B2)**. URLs (`http://`, `https://`, `file://`) in tool output and markdown link text (`[label](url)`) are now wrapped in OSC 8 escape sequences so they're clickable in supporting terminals (Kitty, WezTerm, iTerm2, Windows Terminal, Ghostty, GNOME Terminal). Hyperlinks attach as a per-cell attribute on the cell grid — adjacent cells with the same URL coalesce into a single OSC 8 open. The legacy ` (url)` paren tail in markdown links is preserved (dim) so terminals without OSC 8 support still display the URL. Trailing punctuation (`. , ; : ! ?`) is stripped from URL matches.
- **Fuzzy slash-command search (audit U-B3)**. The `/`-picker now uses subsequence-match scoring instead of `startsWith`. Type `/gst` to surface `/git-status`, or `/perm` to surface `/permissions`. Prefix matches still rank first (the prior UX is preserved when the user types a real prefix), and word-boundary matches outrank mid-word matches. Categories stay naturally contiguous because input order breaks ties.
- **`/permissions log [n]` approval-history command (audit U-B5)**. New subcommand on the existing `/permissions` slash command shows the last `n` (default 50, max 500) approval decisions OH has made — every allow / deny / always-rule outcome plus the source (user / hook / rule / permission-prompt-tool / policy / headless) and a redacted args preview. Sourced from a new append-only JSONL at `~/.oh/approvals.log`, written at every resolution site (interactive prompt, hook decision, MCP permission-prompt-tool, headless fail-closed, auto-mode policy block, and the "Always" persistent-rule promotion). Log auto-rotates to `.1` once it exceeds 2 MiB. Mirrors Claude Code's session approval log.
- **`ExaSearch` tool — Exa neural web-search**. New deferred (extended) tool that calls Exa's neural search API as a peer to the existing DuckDuckGo-backed `WebSearch`. Auth via the `EXA_API_KEY` env var — the tool stays inert (clean error, no network call) for users who don't opt in, so it's safe to leave registered. Exposes Exa's full search surface: types (`auto` / `neural` / `fast` / `keyword`), category targeting (research paper / news / company / personal site / financial report / people), domain + text + date filters, and content modes (`text` / `highlights` / `summary`) with a configurable `max_text_chars` cap. Snippet extraction cascades through `highlights → summary → text` so output is meaningful regardless of which fields the API returns. Implemented with raw `fetch` per the no-new-deps contributing guideline.

### Changed
- `/permissions` help text now lists the new `log` subcommand alongside the mode list. `/permissions log` (no arg) defaults to 50 records; `/permissions log 200` shows up to 200.

### Already-shipped (audit U-B4 closeout)
- **Inline diff syntax highlighting in PermissionPrompt** was flagged as a parity gap but is already shipped. `src/renderer/diff.ts:renderDiff()` calls `renderHighlightedCode()` from `markdown.ts` for any file extension in `HIGHLIGHT_LANGS`, and the cell-grid permission section already calls `renderDiff()` (`layout-sections.ts:292`, `:350`) for both the boxed and unboxed prompt layouts. The `[D]iff` toggle on the prompt makes it visible/hidden. **Grep-first lesson hits a 7th time across the audit cycle** — every Tier item gets a 5-minute pre-implementation check, no exceptions.

### Internal
- New `src/harness/status-line-script.ts` — `runStatusLineScript(envelope, cfg)` plus `_resetStatusLineCacheForTest`. Synchronous `spawnSync` so the renderer doesn't need an async path; trade-off documented in the file header. Module-level cache keyed on `JSON.stringify` of the relevant envelope fields (excludes `sessionId` since the script's output shouldn't depend on it). 8 unit tests in `src/harness/status-line-script.test.ts` cover the envelope-on-stdin path, multi-line truncation, non-zero exit, empty stdout, cache hit, cache miss on envelope change, missing-command no-throw, and whitespace trimming.
- `src/repl.ts:syncRenderer` gains a script branch with priority: script (when configured + trusted) → existing `statusLineFormat` template → default. Uses static imports (`isTrusted`, `trustSystemActive` from `harness/trust.js`) — never `require()` from this ESM file (lesson from v2.23.0 where the hidden `require()` throw broke 31 hook tests).
- `Style` type in `src/renderer/cells.ts` gains an optional `hyperlink?: string | null` field; `EMPTY_STYLE.hyperlink` defaults to `null`. `cellsEqual` normalizes `undefined`/`null` so existing literal Style sites compile unchanged. New `CellGrid.writeTextWithLinks(row, col, text, baseStyle, maxCol?)` method scans for `http(s)://` and `file://` patterns, applies `{ fg: "cyan", underline: true, hyperlink: url }` to URL runs, strips trailing punctuation. Wired into `renderToolCallsSection` in `src/renderer/layout-sections.ts` for both completed and live (running) tool output.
- `diff()` in `src/renderer/differ.ts` tracks `lastHyperlink` independently of SGR state. Emits `\x1b]8;;<url>\x1b\\` when entering a linked run, `\x1b]8;;\x1b\\` when leaving, and ensures any open hyperlink is closed before the trailing SGR reset. 5 new tests in `src/renderer/differ.test.ts` cover open/close ordering, no-emission when absent, coalescing across adjacent same-URL cells, transition between adjacent different URLs, and final-close.
- `parseInline` in `src/renderer/markdown.ts` attaches `hyperlink: linkMatch[2]` to the link-text segment. 1 new test in `src/renderer/markdown.test.ts` asserts the attribute is set on link text and absent on the dim paren tail. 4 new tests in `src/renderer/cells.test.ts` cover URL detection, trailing-punctuation stripping, `file://` URLs, and `maxCol` truncation.
- New `src/utils/fuzzy.ts` — `fuzzyScore(query, name)` returns null when query isn't a subsequence of name, else an additive score (prefix bonus +100, word-boundary bonus +20, contiguous-run bonus +50, base +1 per matched char, span penalty for skipped chars). `fuzzyFilter(query, entries)` is a stable sort over `entries.name`. 12 unit tests cover null-on-non-subseq, prefix-vs-subseq ranking, contiguous-vs-scattered, word-boundary, case-insensitivity, and stable tie-breaking. Wired into `updateAutocomplete` in `src/repl.ts` — replaces the `e.name.startsWith(prefix)` filter.
- New `src/harness/approvals.ts` — `recordApproval(rec)` appends a JSONL line to `~/.oh/approvals.log`; `readApprovalLog(n)` reads the tail; `previewArgs(json, max)` truncates with ellipsis. Errors swallowed at every layer (disk-full, permission errors must not block the agent). Auto-rotates to `.1` once the file exceeds 2 MiB. `setApprovalLogPathForTests(path | null)` is a test seam. 8 unit tests in `src/harness/approvals.test.ts` cover the append, multi-line ordering, null-path silencing, missing-file empty result, tail order, malformed-line skipping, preview pass-through, and preview ellipsis.
- `src/query/tools.ts` `executeSingleTool` now records every permission resolution: hook allow/deny, permission-prompt-tool allow/deny, askUser allow/deny, headless fail-closed deny, auto-mode policy deny (with `source: "rule"` when reason is `tool-rule-deny`, else `policy`). The `denyAndEmit` helper was extended with `recordApproval`; a new `recordAllow(source)` mirrors it for the success branches. Pre-existing `denySource` strings ("user", "hook", "permission-prompt-tool", "headless") match the `ApprovalSource` union exactly.
- `handlePermissionKey` in `src/renderer/index.ts` records a supplementary `decision: "always", source: "user"` entry when the user presses `A` so the log distinguishes one-shot allows from rule-promotions. Static-imported `recordApproval` (per the v2.23.0 ESM-`require()` footgun memory).
- `/permissions` slash command in `src/commands/settings.ts` gains a `log [n]` subcommand. Records render as `YYYY-MM-DD HH:MM:SS  ✓/★/✗ <decision> <tool> <source> (reason)`. Subcommand check happens before mode-name validation so `log` doesn't collide with the mode list.

## 2.23.0 (2026-04-28) — Interaction Polish

First release of the Tier U-A bundle from the 2026-04-27 UI/UX-parity plan (`~/.claude/plans/2-typescript-sdk-moonlit-hinton.md`). Six small interaction wins that bring OH's REPL closer to Claude Code's quick-toggle / quick-pick / quick-trust UX. A5 (effort-level visible indicator) was dropped during implementation — grep-first caught that the `effortLevel` config has zero consumers; the `/effort` slash command doesn't even persist. Lesson reinforced for the 6th time.

### Added
- **"Always allow this tool" in the permission prompt (audit U-A2)**. New `[A]lways` key in the Y/N/D prompt. On press, OH approves the current call AND persists a `toolPermissions: { tool, action: "allow" }` rule to `.oh/config.yaml` so future calls to the same tool skip the prompt entirely. Mirrors Claude Code's "yes, don't ask again". No-op when there's no project config (we don't auto-create just to add a rule). De-dupes against existing exact-tool/no-pattern rules. Prompt key bar updated to show `Yes  No  Always  Diff` (boxed and unboxed renderings).
- **Workspace-trust gate for shell hooks (audit U-A4)**. New `~/.oh/trusted-dirs.json` store. The first time a session starts in a directory with shell-executing hooks (`command:` / `http:`) configured, OH asks "Trust this workspace?" — accepting persists the dir to the trust list, declining lets shell hooks silently skip. `prompt:` hooks (LLM-only) bypass the gate. Mirrors Claude Code's workspace-trust model. New `/trust` slash command (`/trust list` to enumerate, bare `/trust` to grant the cwd, `/trust <path>` to grant a specific dir).
- **`/resume` interactive picker (audit U-A6)**. With no id, `/resume` now opens the existing interactive session browser (Enter-to-resume) instead of erroring with a usage hint. Mirrors Claude Code's `/resume` UX.
- **Shift+Tab cycles permission mode (audit U-A1)**. Mirrors Claude Code's quick-toggle behavior. Cycles `ask → acceptEdits → plan → trust → ask`. The session permission mode is mutated in-place so every downstream caller (`query()`, `cronExecutor`, status hints) sees the new value without extra plumbing. Other modes (`deny`, `auto`, `bypassPermissions`) stay reachable via `/permissions <mode>` but aren't on the quick-cycle path. A toast info message reflects the new mode.
- **Categorized slash command picker (audit U-A3)**. The autocomplete dropdown now groups suggestions under `Session / Git / Info / Settings / AI / Skills / MCP / Other` headers — matches Claude Code's grouped picker. Categories are derived from the existing per-domain command files (`session.ts` / `git.ts` / `info.ts` / `settings.ts` / `ai.ts` / `skills.ts` / MCP-prompt registration). Picker now shows up to 8 entries (was 5) so the grouping is actually useful when prefix matches span multiple categories.

### Internal
- New `src/harness/trust.ts` — `isTrusted(dir)`, `trust(dir)`, `listTrusted()`. File-backed cache; normalizes paths (lowercase on Windows). 6 unit tests in `src/harness/trust.test.ts` cover default empty state, idempotent trust(), persistence across cache reset, and isolation between trusted/untrusted dirs.
- New `appendToolPermission(toolName, action?)` exported from `src/harness/config.ts`. Reads project config, appends a rule (with dedup), writes back. Returns `false` when no config exists. 5 unit tests in `src/harness/append-tool-permission.test.ts` cover append / preserve / dedup / patterned-rule-ignored / no-config-no-write.
- `src/harness/hooks.ts` `executeHookDef` and the synchronous `preToolUse` path in `emitHook` gate command/http hooks on `isTrusted(process.cwd())`. Untrusted-dir hooks act as if absent (return `true` — neither allow nor deny — so existing semantics hold for users without hooks).
- `startREPL()` in `src/repl.ts` fires a one-time trust prompt at session start when hooks are configured but the cwd isn't trusted. Non-blocking — wrapped in `void (async () => ...)()` so the REPL stays responsive.
- `handlePermissionKey` in `src/renderer/index.ts` adds the `a` branch (calls `appendToolPermission` lazily, then resolves true).
- `renderPermissionBoxSection` in `src/renderer/layout-sections.ts` renders the new `[A]lways` key in both the boxed and unboxed prompt layouts.
- New `cyclePermissionMode()` helper in `src/repl.ts` — internal closure, mutates `config.permissionMode`. Triggered by the `key.name === "tab" && key.shift` branch added before the existing tab handler.
- `parseKey` in `src/renderer/input.ts` now recognizes the xterm backtab sequence `\x1b[Z` as `{ name: "tab", shift: true }`. 2 new tests in `src/renderer/input.test.ts` cover the parse + the consumed-byte count when followed by trailing input.
- `src/commands/index.ts` gains a `CommandCategory` type + `registerFor(category)` adapter so per-domain command files keep their existing 3-arg `register()` signature. `getCommandEntries()` now returns `{ name, description, category }`. `registerMcpPromptCommands` tags MCP prompts with category `"MCP"`.
- `LayoutState` in `src/renderer/layout.ts` gains an optional `autocompleteCategories?: string[]`. `renderAutocompleteSection` draws `── <Category> ──` header rows whenever the category changes between consecutive entries (and only once per contiguous run). Footer-height calculation in both `rasterize` (`layout.ts`) and `getRenderedRows` (`index.ts`) accounts for the extra header rows.
- 3 new tests in `src/renderer/ui-ux.test.ts` cover header drawing, flat fallback when categories are absent, and re-headering when the category transitions back (e.g. Info → Session → Info shows two `── Info ──` rows).

## 2.22.1 (2026-04-27) — LSP Hover Bug Fix + Discoverability

Closes the entire 2026-04-26 audit refresh. B9 (full LSP tool) was already shipped under the `Diagnostics` tool name since v2.x — discovery during scope check, the grep-first lesson hit a fifth time this audit cycle. After this patch, the audit only has Tier C (defer-until-demand) remaining.

### Changed
- **`Diagnostics` tool description and prompt promoted to LSP framing (audit B9)**. The tool already supported all four LSP operations (diagnostics, definition, references, hover) since v2.x. Description now leads with "Language Server Protocol (LSP) code intelligence — pick action…" so the tool's full capability is discoverable to the model. No behavior change. The `name: "Diagnostics"` is preserved for back-compat with existing config and slash-command references.

### Fixed
- **`hover` action no longer hides real LSP errors as "not supported" (audit B9 polish)**. The prior implementation used `(client as any).send(...)` to bypass the private `send` method and caught any thrown error as "Hover not supported by this language server" — masking timeouts, connection drops, and protocol errors. Replaced with a proper public `LspClient.getHover(filePath, line, character)` method that lets real errors propagate to the tool's outer catch.

### Internal
- New `unwrapHoverContents(result)` pure helper in `src/lsp/client.ts` — handles all three valid LSP `contents` shapes (string, `{ kind, value }` MarkupContent envelope, array of either). Exposed via `LspClient.unwrapHoverContents` for unit testing without spawning a real language server. 5 new tests in `src/lsp/client.test.ts` cover all branches plus null-ish edge cases.

## 2.22.0 (2026-04-27) — Provider Polish + MCP Maturity

Closes the entire Tier B lane of the 2026-04-26 Claude Code parity audit refresh (`docs/superpowers/plans/2026-04-26-claude-code-parity-audit-refresh.md`). 8 of 9 Tier B items shipped across four stacked PRs (#77 / #78 / #79 / #80) plus a downstream-user-feedback fix (#81). B9 (full LSP tool) is the only Tier B item deferred — it's a 3–4 day scope that warrants its own sprint per the plan. After this release the audit only has Tier C (defer-until-demand: VS Code / JetBrains extensions, agent teams, OS-level sandbox, channels, voice, Chrome) remaining.

OH's hook count moves from 25 → 27, matching Claude Code's stable surface. The provider-agnostic `oh auth` / `oh update` commands give OH parity with `claude auth` / `claude update` without locking into Anthropic-hosted infrastructure.

### Added
- **`--fallback-model <model>` flag (audit B2)** on `oh run`, `oh session`, and the chat REPL. One-shot CLI override for the existing `fallbackProviders` config. When set, REPLACES the config entry for this run — so CI scripts can wire a fallback without editing `.oh/config.yaml`. Format mirrors the primary `--model`: `provider/model` or just `model` (provider guessed). The wrapped provider activates on retriable errors (429/5xx/network/timeout). Mirrors Claude Code's `--fallback-model`.
- **`--init` and `--init-only` flags (audit B5)** on `oh run`, `oh session`, and the chat REPL. `--init` runs the interactive setup wizard (same as `oh init`) before proceeding to the command — useful for first-run on a fresh project. `--init-only` runs the wizard then exits. Reuses the existing `oh init` action body via the new `runInitWizard({ exitOnDone })` helper.
- **`oh auth` redesigned as Commander subcommands (audit B6)**. Replaces the prior single-command `oh auth <action> <provider>` with idiomatic Commander subcommands:
  - `oh auth login [provider] [--key <value>]` — `[provider]` defaults to the configured provider in `.oh/config.yaml`; `--key` can supply the value inline; otherwise reads from stdin (TTY users get a prompt; piped input is read until EOF).
  - `oh auth logout [provider]` — `[provider]` defaults to current.
  - `oh auth status` — lists stored providers + flags any `*_API_KEY` env vars that would override.
- **`oh update` self-update guidance (audit B7)**. Detects how OH was installed and prints the right upgrade command — `npm install -g …` for npm-global, `npx …@latest` for npx-cache, `git pull && npm install && npm run build` for local clones, or all three for unknown layouts. Pure detection in `src/utils/install-method.ts` so it's testable and reusable.
- **`apiKeyHelper` config key (audit B8)**. Script-based API key resolution. The configured command runs at credential-fetch time (5s timeout, shell-true, `OH_PROVIDER` env var set so a single helper can dispatch by provider) and its trimmed stdout becomes the key. Slots between the encrypted credential store and the legacy plaintext-config step in `resolveApiKey`. Failure modes (non-zero exit, timeout, empty stdout, spawn error) all fall through silently and surface via `--debug config`. Mirrors Claude Code's `apiKeyHelper`. Lets users plug in 1Password / pass / vault / cloud secret managers.
- **MCP `roots/list` capability (audit B3)**. OH now responds to MCP `roots/list` requests with the current process `cwd` (and any extras supplied via `setExtraRoots`, ready for future `--add-dir` wiring). Capability advertised in the client constructor and re-advertised on the post-OAuth fresh client. Servers that gate behavior on which directories are in scope (filesystem MCP servers etc.) now see OH's actual workspace.
- **`--permission-prompt-tool <mcp_tool>` flag (audit B1)** on `oh run` and `oh session`. Delegates per-tool permission decisions to a configured MCP tool. When `checkPermission` says "needs-approval" and no permission hook returns a decision, OH calls the named tool (e.g. `mcp__myperm__check`) with `{ tool_name, input }` and reads the response as JSON `{ behavior: "allow" | "deny", message?: string }`. Allow → proceed; deny → block with the message; any failure (tool missing, throws, malformed JSON, unknown behavior) falls through to `askUser` / headless deny so a broken permission tool can't lock the user out. Mirrors Claude Code's `--permission-prompt-tool`. Note: the streaming-execute path (concurrent-safe tools) is intentionally unwired — those tools are read-only by partition design and don't typically hit needs-approval.
- **MCP elicitation handler (audit B4)** with two new hook events. MCP servers can now request user input from OH via `elicitation/create`; OH advertises the `elicitation` capability in its client, registers an SDK handler, and resolves each request via a three-step decision chain: (1) `elicitation` hook decides → that wins; (2) interactive handler (registered via `setElicitationHandler` for future REPL integration) → it decides; (3) fail-safe default → `{ action: "decline" }`. Symmetric `elicitationResult` hook fires after every decision so audit hooks see the full request/response pair. Brings total OH hook count from 25 to 27 (matches Claude Code's stable count). URL-mode elicitations (browser-based) are auto-declined for now — OH doesn't open browsers from the MCP path.

### Changed
- **`oh auth login <local-provider>`** now prints a "no API key needed" message and points to `oh init` instead of accepting a no-op key. Covers `ollama`, `llamacpp` / `llama.cpp`, `lmstudio` / `lm studio`. User-reported gap: prior flow let you store whatever you typed for a local provider.
- **`oh auth status`** with no stored keys now mentions both onboarding paths: `oh auth login <provider>` for cloud providers, `oh init` for local LLMs. The "no provider configured" error from `oh auth login` (no arg, no cfg.provider) gets the same hint.

### Internal
- `createProvider(modelArg, overrides, opts)` in `src/providers/index.ts` gains a third optional argument `opts.fallbackModel`. When set, it REPLACES the config-file `fallbackProviders` for that call. Existing call sites that don't pass it work unchanged. Tests in `src/providers/index.test.ts`.
- New `parseFallbackModel(raw)` exported from `src/providers/index.ts` — pure parser shared with `createProvider`. Returns the same shape as a `fallbackProviders[]` config entry. Unit-tested.
- New `runInitWizard({ exitOnDone })` helper in `src/main.tsx` — extracts the body of the `oh init` subcommand action so it can be invoked from the `--init` / `--init-only` flag paths. `exitOnDone: true` matches the standalone `oh init` behavior; `exitOnDone: false` resolves so the caller can continue.
- New `src/harness/api-key-helper.ts` — `runApiKeyHelper(command, { provider, timeoutMs })` runs the configured script via `spawnSync` with a default 5s timeout, captures stderr on failure, returns the trimmed stdout or `undefined`. Pure side-effect-only — caller owns lifetime. 7 unit tests in `src/harness/api-key-helper.test.ts` plus 2 integration tests covering the `resolveApiKey` priority chain.
- New `src/utils/install-method.ts` — `detectInstallMethod(mainPath)` classifies the install layout from a file path (no fs walk required for npx; walks up to find package.json + .git for local clones; substring-matches `node_modules/@zhijiewang/openharness/` for npm-global). 5 unit tests in `src/utils/install-method.test.ts` cover all four classifications + Windows backslash normalization.
- New `src/mcp/roots.ts` — `getRoots()` returns the live root list (cwd + extras) as `file://` URIs with basename `name`. `setExtraRoots(paths)` REPLACES (not appends) the extras, so a future `/add-dir` integration can swap them atomically. 6 unit tests in `src/mcp/roots.test.ts` cover dedup, replacement, basename extraction.
- `src/mcp/transport.ts:buildClient` advertises `roots: { listChanged: false }` in client capabilities and registers a `ListRootsRequestSchema` handler that delegates to `getRoots()`. The OAuth-fresh-client retry path does the same. listChanged is false because OH doesn't push notifications when cwd changes — servers re-query on demand.
- `src/query/types.ts:QueryConfig` gains an optional `permissionPromptTool?: string`. Threaded through `executeToolCalls` → `executeSingleTool` so the new branch in the permission gate can find the configured tool in the live tool registry. New `callPermissionPromptTool` private helper in `src/query/tools.ts` collapses every failure mode into `behavior: "fallthrough"` so callers have one branch to handle. 7 unit tests in `src/query/permission-prompt-tool.test.ts` cover allow / deny / missing tool / throws / malformed JSON / unknown behavior / headless-deny.
- New `src/mcp/elicitation.ts` — `resolveElicitation(req)` is the pure decision function (hook → interactive handler → fail-safe decline). `setElicitationHandler(handler)` is the future REPL extension point. `HookEvent` union gains `elicitation` / `elicitationResult`. `HookContext` gains `elicitationServer`, `elicitationMessage`, `elicitationSchema`, `elicitationAction`, `elicitationContent`. `buildEnv` exports them as `OH_ELICITATION_*` env vars for shell hooks. `HooksConfig` extends accordingly. 7 unit tests in `src/mcp/elicitation.test.ts` cover the priority chain.
- `src/mcp/transport.ts` advertises `elicitation: {}` capability in the client constructor (and the post-OAuth fresh client) and registers a `ElicitRequestSchema` handler. URL-mode elicitations narrow out and auto-decline; form-mode delegates to `resolveElicitation`. Same pattern as the audit-B3 roots wiring.

## 2.21.0 (2026-04-27) — Tier A Surface Polish

Closes the entire Tier A lane of the 2026-04-26 Claude Code parity audit refresh (`docs/superpowers/plans/2026-04-26-claude-code-parity-audit-refresh.md`). 11 items from the plan's A1–A12 list shipped across four stacked PRs (#73 / #74 / #75 / #76); A6 and A7 are deferred (the plan flagged them as already-built-but-unwired stubs that need their own scope check). After this release, every Claude Code stable CLI flag, slash command, and hook event has a parity equivalent in OH except for the IDE / hosted-Anthropic surface left to Tier C.

### Added
- **`--system-prompt-file <path>` / `--append-system-prompt-file <path>` (audit A1, #73)** on `oh run` and `oh session`. File-path variants of `--system-prompt` / `--append-system-prompt`. Lets CI scripts maintain prompts as version-controlled files instead of stuffing them on the command line. File-not-found exits 2 with a stderr message. File variants take precedence over inline string variants.
- **`--mcp-config <path>` / `--strict-mcp-config` flags (audit A2, #74)** on `oh run`, `oh session`, and the chat REPL. Loads MCP servers from an external JSON file (in addition to `.oh/config.yaml`). With `--strict-mcp-config`, the file's servers REPLACE `.oh/config.yaml`'s entirely — useful for SDK consumers wanting a sealed environment. Accepts CC-style `{"mcpServers": [...]}`, a bare array, or a single server object. Per-name dedup with extras winning, so the file can override a project entry without `--strict`.
- **`--no-session-persistence` flag (audit A3, #73)** on `oh run` and `oh session`. Skips writing the session record to `~/.oh/sessions/` — useful for ephemeral CI runs that don't need resume. Existing `--resume` flow is unchanged (still loads from disk).
- **`--bare` flag (audit A4, #75)** on `oh run`, `oh session`, and the chat REPL. Skips optional startup work — project detection, plugins, memory, skills, MCP servers + their instructions, output style, language directive. The system prompt collapses to the tool-use baseline only. Built-in tools still load. Useful for fast CI / SDK invocations where the model just needs the tool surface and the caller will supply its own context. `oh run --bare -p "…"` finishes noticeably faster on large repos with many CLAUDE.md / RULES.md files.
- **`--debug [categories]` and `--debug-file <path>` flags (audit A5, #75)** on `oh run`, `oh session`, and the chat REPL. Enables categorized debug logs that gate verbose internal traces behind a runtime switch (silent by default). `--debug` alone enables every category; `--debug mcp,hooks` enables only the listed ones. `--debug-file <path>` redirects to a file (appended, never truncated) instead of stderr. Falls back to `OH_DEBUG` / `OH_DEBUG_FILE` env vars when the flags aren't passed. Initial categories: `startup` (CLI entry), `mcp` (server connect / tool load), `hooks` (hook fire). Add more sites by importing `debug` from `src/utils/debug.js`.
- **`/keybindings` slash command (audit A8, #76)**. Opens `~/.oh/keybindings.json` in `$EDITOR` (or `notepad` on Windows; `vi` as POSIX fallback). Creates a starter file with the default bindings if missing so first-time users have something to edit. Edits take effect on next session start; `/reload-plugins` picks them up immediately.
- **`/copy [n]` slash command (audit A9, #76)**. Copies the Nth-last assistant response (default: most recent) to the system clipboard. Cross-platform: `clip` (Windows), `pbcopy` (macOS), `wl-copy` / `xclip` / `xsel` / `clip.exe` (Linux + WSL) — first one that works wins. Skips tool-only assistant turns so users get reply text, not blank lines. Falls back to printing the response inline when no clipboard tool is available.
- **`/recap` slash command (audit A10, #76)**. Lighter-weight cousin of `/summarize`: emits a `prependToPrompt` asking the model for a one-sentence (~25 word) recap of what's been accomplished. Useful at the end of a long session for a quick status read.
- **`disableAllHooks` config key (audit A11, #73)**. Global kill switch — when `true` in `.oh/config.yaml`, every `emitHook` / `emitHookAsync` / `emitHookWithOutcome` call short-circuits as if no hooks were configured. Configured hooks remain on disk and stay visible via `/hooks` for auditability. New `areHooksEnabled()` helper in `src/harness/hooks.ts`. Mirrors Claude Code's `disableAllHooks` setting.
- **`worktreeCreate` / `worktreeRemove` hook events (audit A12, #76)**. Symmetric to `taskCreated` / `taskCompleted` from #68. Fire from `EnterWorktreeTool` / `ExitWorktreeTool` only on the success path. Context: `worktreePath` (the new/removed worktree dir), `worktreeParent` (the parent repo, on create), `worktreeForced` (`"true"` / `"false"` on remove). Useful for audit hooks that want to react to worktree lifecycle events (e.g. set up a per-worktree scratch dir on create, archive it on remove). Brings the total OH hook count from 23 to 25.

### Fixed
- **MCP tools now load in `oh run` and `oh session` (#74)** (was REPL-only). Silent bug in the SDK `tools=[...]` feature: the SDK injects `mcpServers` into a temp `.oh/config.yaml` and runs `oh run` against it, but `oh run` previously ignored the config's `mcpServers` entirely. Now both headless commands load MCP tools the same way the chat REPL does, gated through the same `loadMcpTools()` entry point. Built-in tools + MCP tools are merged before `--allowed-tools`/`--disallowed-tools` filtering applies.

### Internal
- `loadMcpTools()` in `src/mcp/loader.ts` gains a `LoadMcpOptions` parameter (`extraServers`, `strict`) so the same entry point handles both config-file and file-flag-driven loading. Existing callers (chat REPL, `/reload-plugins`) work unchanged.
- New `parseMcpConfigFile()` helper exported from `src/mcp/loader.ts` — pure parser with shape validation, unit-tested in `src/mcp/mcp-config-flag.test.ts`.
- New `src/utils/debug.ts` module — pure-ish singleton holding the enabled-category set, debug-file path, and (test-only) sink override. Synchronous `appendFileSync` for file output so each line lands on disk before `debug()` returns (a `WriteStream` would lose its tail buffer on `process.exit`). 8 unit tests in `src/utils/debug.test.ts` cover parsing, gating, env-var fallback, file output, and re-configuration.
- `buildSystemPrompt(model, opts)` in `src/main.tsx` accepts an `opts.bare` boolean — when set, returns `DEFAULT_SYSTEM_PROMPT` only and skips every contributor. The MCP load + prompt-registration paths in chat / run / session also gate on the same `bare` value.
- `HookEvent` union in `src/harness/hooks.ts` gains `worktreeCreate` / `worktreeRemove`. `HookContext` gains `worktreePath`, `worktreeParent`, `worktreeForced`. `buildEnv` exports them as `OH_WORKTREE_PATH` / `OH_WORKTREE_PARENT` / `OH_WORKTREE_FORCED` for shell hook scripts. `HooksConfig` in `src/harness/config.ts` extends accordingly.
- `copyToClipboard(text)` exported from `src/commands/session.ts` — pure helper picking the platform-appropriate clipboard tool (Windows / macOS / Linux / WSL fallbacks). Returns `{ ok, tool }` or `{ ok: false, reason }` — no throws. Used by `/copy`.
- `openInEditor(path)` helper in `src/commands/settings.ts` — `$VISUAL` → `$EDITOR` → `notepad` (Windows) → `vi` (POSIX) fallback chain, detached + unref so the REPL doesn't block on the editor's lifetime. `OH_NO_OPEN_EDITOR=1` escape hatch for tests / CI.
- 7 new tests in `src/commands/copy-recap-keybindings.test.ts` (message-walking + Nth-last selection in `/copy`, the prependToPrompt shape of `/recap`, file-creation side of `/keybindings`). 2 new tests in `src/harness/hooks-b2.test.ts` (worktree hook events). 5 new tests in `src/harness/disable-all-hooks.test.ts` (kill switch). 8 new tests in `src/utils/debug.test.ts` (debug logger). Total: 1288 tests pass.

## 2.20.0 (2026-04-26) — Tier B Audit Closure

Closes the entire Tier B lane of the 2026-04-24 Claude Code parity audit (`docs/superpowers/plans/2026-04-24-claude-code-parity-audit.md`). Three independent items shipped as #68 / #69 / #70. After this release the audit only has Tier C remaining — all defer-until-demand items (VS Code extension, agent teams, OS-level sandboxing, …).

### Added
- **Six new hook events (audit B2, #68)** bringing the total from 17 to 23. Each fires from its natural source code path and is configurable like every other hook (`command` / `http` / `prompt` modes, optional `match` pattern, optional `jsonIO`).
  - **`userPromptExpansion`** — fires when a slash command produces a `prependToPrompt`, between the expansion and `userPromptSubmit`. Context: `slashCommand`, `originalInput`, `prompt`. Useful for audit trails that want to see the (input → expanded) boundary that's otherwise hidden from observers.
  - **`postToolBatch`** — fires once after a turn's full set of tool calls have all resolved, before the next model call. Per-tool `postToolUse` / `postToolUseFailure` still fire as before; this is the batch-level boundary for hooks that want to act once per turn instead of once per tool. Context: `batchSize`, `batchTools`.
  - **`permissionDenied`** — symmetric to `permissionRequest`. Fires whenever a tool call is denied: by a hook, by the user (interactive "no"), by a headless fail-closed default, or by an auto-mode policy block. Context: `denySource` (`hook` / `user` / `headless` / `policy`), `denyReason`, `toolName`, `toolArgs`, `permissionMode`.
  - **`taskCreated`** — fires when `TaskCreate` persists a new task. Context: `taskId`, `taskSubject`.
  - **`taskCompleted`** — fires only on the `pending|in_progress → completed` transition (not on re-saves of an already-completed task). Context: `taskId`, `taskSubject`, `taskPreviousStatus`.
  - **`instructionsLoaded`** — fires from `loadRulesAsPrompt` whenever the system prompt is rebuilt with rules in scope (CLAUDE.md / global-rules / project RULES.md). Context: `rulesCount`, `rulesChars`. Useful for compliance/audit hooks that want to log "session X is operating under these rules".
- **`/reload-plugins` slash command (audit B4, #69)**. Hot-reloads plugins, skills, hook configuration, MCP server connections, and the on-disk config without restarting the session. Useful when iterating on a plugin or hook script — edit the file, run `/reload-plugins`, see the effect on the next prompt.
  - Invalidates `config`, `hooks`, `sandbox`, and `verification` caches.
  - Disconnects then reconnects every MCP server (loads its tool list fresh).
  - Reports a count summary: hook events configured, MCP servers + tools, skills discovered, plugins discovered.
  - Note: in-flight tool registries held by the agent loop refresh on the next prompt, not retroactively.
- **MCP prompts surface as `/<server>:<prompt>` slash commands (audit B5, #70)**. Mirrors Claude Code's slash-command bridge for MCP server prompts. Several MCP servers (GitHub, Sentry, Linear) ship canned prompts that are now reachable directly from the REPL.
  - `McpClient` gains `listPrompts()` and `getPrompt(name, args)` (defensive — servers without the `prompts/list` capability return `[]` instead of throwing).
  - `loadMcpPrompts()` on the loader enumerates prompts on every connected server after `loadMcpTools()`. Returns `McpPromptHandle[]` with a `render(args)` callback per prompt.
  - `registerMcpPromptCommands(prompts)` in `src/commands/index.ts` adds each as a slash command. The handler invokes `render()` and returns the rendered text as `prependToPrompt` so the next user prompt carries it as context.
  - Argument syntax: `/<server>:<prompt> key=value key2="value with spaces"`. Single and double quotes both supported. Required arguments declared by the prompt template surface a usage error (no model call) when missing.
  - Re-registering replaces the prior set — safe to call again after `/reload-plugins` (or any future hot-reload trigger).
  - Render errors are reported in the slash-command output, not thrown.

## 2.19.0 (2026-04-26) — SDK End-to-End + Budget Cap

Three CLI fixes that close the loop on the v0.5 TypeScript SDK released to npm earlier this cycle, plus the `--max-budget-usd` audit-B3 item. Each fix was surfaced by the SDK's end-to-end smoke test and breaks an SDK consumer's use case until fixed; together they make `OpenHarnessClient` (TS) and `OpenHarnessClient` (Python) fully functional against `oh run` / `oh session` headless. The TS SDK itself ships separately on its own v0.x.x track (`@zhijiewang/openharness-sdk@0.5.0`, see "TypeScript SDK v0.5.0" section below).

### Added
- **`--max-budget-usd <amount>` flag on `oh run` and `oh session` (#67)**. Hard cap on session cost in USD; the agent halts with `reason: "budget_exceeded"` once `state.totalCost` reaches the cap. Closes audit B3 from `docs/superpowers/plans/2026-04-24-claude-code-parity-audit.md`. Mirrors Claude Code's `--max-budget-usd`.
  - Existing budget infrastructure was already in `src/query/index.ts:136` — circuit breaker at the top of every turn, plus 70% / 90% budget warnings auto-injected into the system prompt. This PR is the CLI flag wiring (memory `project_v2_18_0.md` reinforced once more — grep first; the audit's "missing feature" was already half-built).
  - Accepts plain decimals (`5`, `0.50`, `2.5`) and an optional leading `$`. Rejects zero / negative / non-numeric with exit code 2 + a stderr message.
  - Pure parser lives in `src/utils/parse-budget.ts` with 10 unit tests.

### Fixed
- **`permissionRequest` hooks now fire in headless mode (#62)**. Previously the hook block at `src/query/tools.ts:64` was gated on `askUser` being provided, so headless callers (`oh run`, `oh session`) bypassed configured `permissionRequest` hooks entirely — every tool call needing approval got a generic "Permission denied: needs-approval" without consulting any hook. SDK consumers using `canUseTool` saw the in-process HTTP server they registered never get called.
  - The hook now fires whenever `checkPermission` returns `needs-approval`, in both interactive and headless modes. Configured hooks get first say.
  - If the hook returns `allow` / `deny`, that's honored.
  - If the hook returns `ask` (or has no decision) and an interactive `askUser` is available, the prompt fires as before.
  - If no decision and no `askUser` (true headless), the call is denied fail-closed with an explanatory message ("configure a permissionRequest hook to gate this tool").
  - Behavior for users with no `permissionRequest` hooks configured is unchanged — the deny outcome is the same as before, just routed through the new code path.
  - Unblocks the SDK `canUseTool` callback (Python `can_use_tool`, TypeScript `canUseTool`) for `oh run`/`oh session` consumers.
- **`oh session` and `oh run` now mint a fresh `sessionId` on startup (#60)**. Previously a `sessionId` was only present when the run had been started with `--resume <id>`; fresh runs emitted `{"type":"ready"}` with no id, which made programmatic resume from an SDK client impossible (you had nothing to capture for the next call). Both commands now create a session record up-front via `createSession()`, persist after every completed turn, and emit the id in the `ready` (oh session) / `session_start` (oh run) events. Existing `--resume <id>` behavior is unchanged. Mirrors the REPL's save-on-exit pattern at headless scope.
- **Ollama provider — multi-turn context preservation (#61)**. Ollama's chat API defaults to a 2048-token `num_ctx`; OH's typical system prompt + tool list pushes ~4 K, so prior conversation turns were silently truncated server-side. The model appeared to "forget" what was just said. Reproducible without the SDK by piping two prompts into `oh session` — the second response would ignore everything from the first.
  - The Ollama provider now passes `options.num_ctx` on every request, sized from a char/4 token estimate of `messages + systemPrompt + tools`, padded by 25 % + 1 K headroom, rounded up to the next power of 2 ≥ 8 192, capped at 32 K. Cap exists to bound KV-cache memory; users with bigger models can override via `OLLAMA_NUM_CTX`.
  - Same fix applies to both `stream()` and `complete()` code paths.
  - Affects every multi-turn conversation through Ollama, not just `oh session` — even fresh `oh run -p` calls with long prompts were losing context.

## TypeScript SDK v0.5.0 (2026-04-26)

New companion package
`@zhijiewang/openharness-sdk` ships under `packages/sdk/` on its own
v0.x.x SemVer track, mirroring the Python SDK arc and closing **B1
(TypeScript / JavaScript SDK)** from the 2026-04-24 parity audit.

Five stacked PRs:

- **v0.1.0** — `query()` + 11 typed event interfaces + `OpenHarnessError` / `OhBinaryNotFoundError` + binary discovery (env `OH_BINARY` or PATH; auto-prefixes `node` for `.cjs`/`.mjs`/`.js` script targets, useful for development and tests).
- **v0.2.0** — `OpenHarnessClient` stateful sessions backed by `oh session`, FIFO `send()` serialization, `Symbol.asyncDispose` for `await using`, graceful three-step shutdown.
- **v0.3.0** — `tool({ name, inputSchema, handler })` helper + `tools: [...]` option backed by an in-process Streamable-HTTP MCP server (Zod schemas → JSON Schema via `zod-to-json-schema`). Existing user `.oh/config.yaml` keys (model, provider, permissionMode, …) are preserved; only `mcpServers` and `hooks` are SDK-owned.
- **v0.4.0** — `canUseTool` permission callback + in-process HTTP hook server. Sync and async callbacks both work; throw / 30 s timeout / unrecognised return value all surface as `decision: "deny"` (fail-closed).
- **v0.5.0** — `resume`, `settingSources`, and `OpenHarnessOptionsBundle` typed wrapper closing the v0.x parity arc with `@anthropic-ai/claude-agent-sdk`.

74 passing tests cover NDJSON splitting, event parsing, `query()` happy/error/early-break paths, `OpenHarnessClient` multi-turn / serialization / crash recovery, MCP server roundtrips via the official client SDK, permission server timeouts and shape coercion, and argv assembly for resume + settingSources.

Wiring at the repo level:
- New `packages/sdk/` workspace declared in root `package.json`.
- New `.github/workflows/publish-sdk.yml` publishes to npm on `sdk-v*` tags with provenance.
- `biome.json` includes `packages/sdk/src` and `packages/sdk/test`.
- Root `npm test`, `npm run typecheck`, `npm run lint` all chain into the SDK workspace; SDK has its own `npm test` / `build` / `typecheck` for isolated runs.
- README.md and README.zh-CN.md both gain a "TypeScript SDK" mention next to the existing Python SDK note.

## 2.18.0 (2026-04-26) — Personality & Plumbing

Five-feature parity bundle from the 2026-04-24 Claude Code parity audit (`docs/superpowers/plans/2026-04-24-claude-code-parity-audit.md`). Originally scoped at six tasks; one was dropped after post-grep verification revealed it was already shipped.

### Added
- **Output styles** — new `outputStyle` config key swaps the agent's personality without touching the core system prompt. Three built-ins: `default` (no preface, behavior unchanged), `explanatory` (adds an `## Insights` section between tasks), `learning` (leaves 1–3 `TODO(human)` markers at strategic points so the user writes the instructive parts). Custom styles live as YAML-frontmatter markdown under `.oh/output-styles/<name>.md` (project) or `~/.oh/output-styles/<name>.md` (user); precedence is project > user > built-in. Mirrors Claude Code's `outputStyle`. (#51)
- **`/hooks` slash command** — lists all hooks loaded from `.oh/config.yaml`, grouped by event, labeled by kind (command / http / prompt), with a 60-character source preview and the `match:` pattern when set. Counterpart to `/doctor` for introspection. (#49)
- **`language` config key** — when set in `.oh/config.yaml` (e.g., `language: zh-CN`, `language: Japanese`), the model responds in that language for every session while leaving code, shell commands, file paths, and identifiers in their original form. Mirrors Claude Code's `language` setting. (#49)
- **`ListMcpResources` and `ReadMcpResource` tools** — agent-callable wrappers around `src/mcp/client.ts`'s existing `listResources()` / `readResource()` methods. The model can now enumerate and read MCP resources during a turn (previously only user-triggered `@-mention` resolution could reach them). Both deferred (DeferredTool), low-risk, read-only. New `readMcpResource(uri, server?)` export in `src/mcp/loader.ts`. (#50)
- **`--json-schema` wiring** in `oh -p` headless mode. The flag was declared in v2.17 but never read. Now parses the supplied schema, parses model output as JSON, validates against the schema with the new minimal validator, and emits **only** the validated JSON on stdout. Exit codes: `0` valid, `2` malformed schema, `3` model output was not JSON, `4` JSON didn't match the schema. Suppresses streaming output in json-schema mode so stdout carries only the final JSON. New zero-dep validator `src/utils/json-schema.ts` covers `type` (incl. union), `properties`, `required`, `items`, `enum` with nested path reporting. (#50)

### Changed
- `buildSystemPrompt` in `src/main.tsx` now consolidates `readOhConfig()` into a single call per build (previously read twice — once for output style and once for the response-language directive). Output style preface now sits at the very top of the system prompt; language directive remains at the bottom.
- `getHooks()` in `src/harness/hooks.ts` is now exported (was internal). Used by the new `/hooks` command and available to embedders.

### Verified already-shipped (dropped from bundle)
- The audit originally listed **six** Tier A tasks. Post-grep verification at audit time and during Task 2 implementation found **five** were already wired and only documentation/discoverability was missing:
  - `--continue` / `-c` flag (already wired, `src/main.tsx:670–678`)
  - `--fork <id>` flag (already wired, `src/main.tsx:680–689`)
  - `@-mention` resolution including line ranges and MCP resources (already wired, `src/harness/submit-handler.ts:145–191`)
  - Hook `match:` field for all events (already wired, `src/harness/hooks.ts:116–162`)
  - `/doctor` command (already a full health check, `src/commands/info.ts:244`)
  - **Token-level partial messages and hook-decision events in stream-json output** — both were already streaming from `oh run` and `oh session` since v2.15/v2.16 (`text` events per chunk, `hook_decision` events via `setHookDecisionObserver`). The Python SDK already parses both. Adding `--include-partial-messages` / `--include-hook-events` would have been no-op surface clutter; the proposed Task 2 was dropped.
- The audit's hit rate on novel-feature identification was 1/6 (output styles only). Lesson reinforced: grep before designing — every gap-audit cycle so far has found ~half the proposed work already shipped but undocumented.

## 2.17.0 (2026-04-22) — Session resume + setting_sources

### Added
- `--resume <id>` flag on both `oh run` and `oh session` — replays a prior session's message history before accepting the new prompt. Previously only the default interactive command supported resume.
- `--setting-sources <sources>` flag on both `oh run` and `oh session` — comma-separated subset of `user,project,local` controlling which config layers are merged. Mirrors Claude Code's `setting_sources`. `readOhConfig()` takes an optional second argument for programmatic use.
- Two new stream-json event types: `session_start` (fires once at the top of `oh run` when `--resume` loads a session) and a `sessionId` field on the existing `ready` event (emitted by `oh session`). Lets the Python SDK capture the session ID for later resume.

### Changed
- `readOhConfig()` now accepts a `sources?: ("user" | "project" | "local")[]` second parameter. When omitted, existing global → project → local merging behavior is unchanged.

## 2.16.0 (2026-04-22) — Turn-boundary hooks + richer HTTP hook protocol

### Added
- Two new hook events: `turnStart` (fires at the start of each top-level agent turn) and `turnStop` (fires at turn end, mirrors Claude Code's `Stop` hook). Receive `OH_TURN_NUMBER` and (for `turnStop`) `OH_TURN_REASON` env vars. Fire in both `oh run` and `oh session`.
- Three new NDJSON event types in `oh run --output-format stream-json` and `oh session`: `turnStart` (`{type: "turnStart", turnNumber}`), `turnStop` (`{type: "turnStop", turnNumber, reason}`), and `hook_decision` (`{type: "hook_decision", event, tool?, decision: "allow"|"deny"|"ask", reason?}`). The Python SDK v0.4.0 consumes these as new typed events.
- HTTP hooks can now return the full structured response shape (`{decision, reason, hookSpecificOutput}`) that JSON I/O command hooks have supported since v2.10.0. Previously HTTP hooks were limited to `{allowed: boolean}`. Legacy `{allowed}` still honored.
- Public `setHookDecisionObserver(cb)` in `src/harness/hooks.ts` for embedders that want the hook-decision notifications programmatically. Observer errors are swallowed so they can never break the hook pipeline.

### Changed
- `src/harness/hooks.ts` internal refactor: added `runHttpHookDetailed` alongside `runHttpHook`; `runHookForOutcome` now uses the detailed variant for richer HTTP semantics.

## 2.15.0 (2026-04-21) — Python SDK + streaming + `oh session`

### Added
- Python SDK launched as a separate package on PyPI: `openharness-sdk` (v0.3.0; the shorter `openharness` name is taken by an unrelated project). Import path remains `from openharness import ...`. Mirrors Claude Code's `claude-agent-sdk` shape — spawns the `oh` CLI as a subprocess and streams typed events. See [`python/README.md`](python/README.md). Separate SemVer track from the npm package.
  - `query(prompt, **options)` async generator for one-shot prompts.
  - `OpenHarnessClient` class for long-lived multi-turn conversations (async context manager, `send()` returns async iterator of typed events, concurrent sends serialized, `interrupt()` and idempotent `close()` supported).
  - `@tool` decorator + `tools=[...]` kwarg on both `query()` and `OpenHarnessClient`. When tools are passed, the SDK starts an in-process MCP HTTP server hosting the Python callables and injects an ephemeral `.oh/config.yaml` pointing at it.
- `oh run --output-format stream-json` emits two additional NDJSON event types: `cost_update` (inputTokens, outputTokens, cost, model) and `turn_complete` (reason). Existing `text`, `tool_start`, `tool_end`, `error` events unchanged.
- New `oh session` command — long-lived stateful session for the Python SDK. Reads JSON prompts from stdin (`{id, prompt}` per line), emits id-tagged NDJSON events on stdout. Conversation history persists across prompts on a single warm process. Not intended for direct terminal use.
- New CI workflows: `.github/workflows/python-lint.yml` runs ruff + mypy + pytest on every Python-affecting change (matrix: ubuntu + windows × py3.10 + py3.12). `.github/workflows/publish-python.yml` triggers on `python-v*` tag and publishes to PyPI via trusted publishing (OIDC).

## 2.14.0 (2026-04-19) — Session polish + First-run wizard + Keychain storage

### Added
- OS keychain storage for MCP OAuth tokens. macOS Keychain / Windows Credential Manager / Linux Secret Service, via the optional `@napi-rs/keyring` dependency. Transparent fallback to the existing `~/.oh/credentials/mcp/*.json` filesystem store when the keychain isn't available (headless Linux without D-Bus, containers, missing prebuilt binary).
- Config: new optional `credentials: { storage: "filesystem" | "auto" }` field in `.oh/config.yaml`. Default is `"auto"` — keychain when available, filesystem otherwise. Set to `"filesystem"` to force filesystem-only storage.
- Env var: `OH_KEYCHAIN=disabled` bypasses keychain globally (used by the test runner to isolate tests from the real OS keychain).
- First-run setup wizard auto-launches on bare `oh` when no provider is configured and stdin/stdout are TTYs. Previously printed static help text and exited. Non-TTY environments (CI, piped stdin) preserve the original behavior. Matches Claude Code's `claude`-in-empty-directory flow.
- `/fork` now records a `parentSessionId` on the new session and inherits the current session's provider/model (was passing empty strings). `/history` surfaces `⤴ forked from <id>` for sessions that have a parent.
- `/export` default markdown now includes tool calls (formatted as `Tool call: <name>(<args>)`) and tool results (fenced). Previously dropped everything except user+assistant text. New `/export json` writes the raw message array to `.oh/export-<id>.json`.

### Changed
- Internal: `src/mcp/oauth-storage.ts` becomes a thin orchestrator; pure filesystem helpers moved to `src/mcp/oauth-storage-fs.ts`. Public API (`saveCredentials` / `loadCredentials` / `deleteCredentials` / `OhCredentials`) unchanged — callers in `oauth.ts` and `commands/mcp-auth.ts` untouched.

### Fixed
- `/fork` was constructing the new session with empty provider/model strings (`createSession("", "")`). Now inherits from the running context.
- CI flake in `tools.test.ts` "hooks are independent" test: fire-and-forget hook processes write to the capture file in non-deterministic order. Test now asserts set-membership rather than array order.

### Migration
- Zero. Existing filesystem OAuth tokens load via the fallback path and migrate to the keychain on next save. Filesystem files are not auto-deleted. Existing `.oh/config.yaml` files unchanged.

## 2.13.0 (2026-04-19) — Additional Hooks + ModelRouter + Fallback Providers

### Added
- Wired the existing `createFallbackProvider` into `createProvider()`. Configure `fallbackProviders:` in `.oh/config.yaml` as an array of `{provider, model?, apiKey?, baseUrl?}`; the primary is tried first, each fallback in order on retriable failure (429/5xx/network/timeout). Auth failures (401/403) and mid-stream errors do not trigger fallback. Emits one `console.warn` to stderr on fallback activation. Adds 11 new tests (9 for `createFallbackProvider`, previously untested; 2 for factory wiring).
- Three new hook events mirroring Claude Code semantics:
  - `postToolUseFailure` fires when a tool throws or returns `{isError: true}`. Mutually exclusive with `postToolUse` (success-only now).
  - `userPromptSubmit` fires before the user's prompt reaches the LLM. Can block (decision: "deny") or prepend context (`hookSpecificOutput.additionalContext`).
  - `permissionRequest` fires when a tool needs approval, between `preToolUse` and the interactive ask prompt. Can respond `{decision: "allow" | "deny" | "ask"}` to short-circuit or fall through.
- `HookOutcome` type and `emitHookWithOutcome` function (exported from `src/harness/hooks.ts`) for structured decision + context return values.
- `parseJsonIoResponse` helper (exported) for parsing hook jsonIO-mode stdout.
- Env vars: `OH_PROMPT`, `OH_TOOL_ERROR`, `OH_ERROR_MESSAGE`, `OH_PERMISSION_ACTION`.
- `docs/hooks.md` — reference for all 15 hook events.
- Wired the existing `ModelRouter` into the query loop. Configure `modelRouter.{fast,balanced,powerful}` in `.oh/config.yaml` to route per-turn based on the shipped heuristics. Sub-agents (AgentTool) route via `role`. New `/router` slash command shows current tier-to-model mapping and the last selection per session.

### Changed
- `postToolUse` now fires only on successful tool execution (not on `isError: true`). Previously fired on both. This is a semantic change; tools that report errors now route to `postToolUseFailure` instead.

## 2.12.0 (2026-04-18) — OAuth 2.1 for Remote MCP

### Added
- OAuth 2.1 for remote MCP servers: Authorization Code + PKCE with Dynamic Client Registration, auto-triggered on `401 + WWW-Authenticate`. Filesystem-backed token storage at `~/.oh/credentials/mcp/` with `0600` permissions. New slash commands: `/mcp-login <name>`, `/mcp-logout <name>`; `/mcp` extended with per-server auth-state column.
- Config: new optional `auth: "oauth" | "none"` field on `type: http` and `type: sse` server entries. Default is auto — OAuth when needed, static-bearer when `headers.Authorization` is set.

### Changed
- `McpClient.connect` now wires an `OAuthClientProvider` into the SDK transport when a server is OAuth-eligible. Existing static-bearer and stdio configs unchanged.
- `CommandHandler` type now accepts async handlers (`CommandResult | Promise<CommandResult>`). Backward-compatible for all existing sync handlers.

## 2.11.0 (2026-04-18) — Remote MCP over HTTP/SSE

### Added
- Remote MCP over HTTP and SSE transports. Configure with `type: http` or `type: sse` in `.oh/config.yaml`; supports header-based auth with `${ENV}` interpolation. See `docs/mcp-servers.md`. OAuth 2.1 deferred to a follow-up release.

### Changed
- Internal: `@modelcontextprotocol/sdk` now owns JSON-RPC framing and protocol lifecycle. `McpClient` public surface (`connect`, `listTools`, `callTool`, `listResources`, `readResource`, `disconnect`, `instructions`) unchanged.

## 2.10.0 (2026-04-18) — Hook JSON I/O + Real Prompt Hooks

### Added
- **Hook JSON I/O mode** (#27): Hooks with `jsonIO: true` receive `{event, ...context}` on stdin and respond with `{decision, reason, hookSpecificOutput}` on stdout (Claude Code convention). `decision: "deny"` blocks; non-zero exit always blocks; malformed JSON + zero exit fails closed. Env-var mode remains the default for backward compatibility.
- **Prompt hooks now work** (#28): `src/harness/hooks.ts` `runPromptHook` was a documented stub that always allowed. Now it calls the configured LLM with the hook's prompt + JSON event context, parses yes/no (`YES`/`ALLOW`/`TRUE`/`PASS`/`APPROVE` → allow), and gates with 10s hard timeout. Fail-closed on every error path.

### Summary
985 tests (+9 across the two PRs: 7 hook JSON I/O, 2 prompt-hook fail-closed paths). Tier A of the Claude Code parity roadmap is now fully complete. Tier B items (Remote MCP HTTP/SSE, session fork/export, model router, fallback providers, first-run wizard, additional hook events) remain in the backlog.

## 2.9.0 (2026-04-18) — Claude Code Ecosystem Parity

### Added
- **Ecosystem format interop** (#24): Claude Code plugins drop into `~/.oh/plugins/cache/` and auto-discover via `.claude-plugin/plugin.json`. Directory-packaged skills (`skill-name/SKILL.md` with companion docs). `.claude/skills/` and `.claude/agents/` discovered alongside `.oh/` equivalents. `.claude-plugin/marketplace.json` parser with source-typed entries (github/npm/url). Plugin-shipped `.mcp.json`, `hooks/hooks.json`, `.lsp.json` — discovered via helpers for runtime merge.
- **CLAUDE.md + @-imports** (#25): Hierarchical loader walks `./.claude/CLAUDE.md`, `./CLAUDE.md`, `./CLAUDE.local.md`, `~/.claude/CLAUDE.md`. `@path` imports resolved inline with 5-hop cycle cap. Injected alongside `.oh/memory/` (additive).
- **Read-only Bash auto-approve** (#25): Allowlist of pure inspection commands (ls, cat, grep, find, git status/log/diff, …) short-circuits the permission prompt. Rejects `sed -i`, `tee`, `git commit/push`, redirects.
- **Settings `env:` injection** (#25): New `env: { KEY: VALUE }` field in `.oh/config.yaml` (mirrors CC's `settings.json.env`). Merged into child process environment via `safeEnv()` — every spawn site picks it up automatically.
- **Skill frontmatter aliases** (#24): Anthropic kebab-case forms — `allowed-tools`, `disable-model-invocation`, `argument-hint`, `when-to-use` — accepted alongside the existing camelCase. New fields: `license` (SPDX), `paths` (glob scoping), `context: fork` + `agent: <type>`.
- **Agent frontmatter additions** (#24): `model`, `disallowedTools`, `isolation`, `mcpServers`, `hooks`. Tools field accepts YAML array OR space/comma-separated string.
- **`/plugin` command** (#24): Alias of `/plugins` with new `info <name>` subcommand showing the full manifest.
- **License gate on `/skill-install`** (#24): Refuses non-permissive SPDX licenses unless `--accept-license=<id>` passed. `installable: false` registry entries are link-only (for viral licenses like CC-BY-SA).
- **Registry expanded** (#24): 4 → 23 entries with `license` + `attribution` + `upstream` metadata. 7 OH-native MIT, 8 superpowers MIT, 6 CLI-Anything Apache-2.0, 2 Trail-of-Bits CC-BY-SA (link-only).
- **7 bundled skills** (#24): code-review, commit, debug, tdd, diagnose, plan, simplify. Shipped in npm package, loaded with `[bundled]` source tag.
- **`/skills` listing command** (#24): Lists all discoverable skills with source tags.

### Changed
- **Hook matcher** (#25): Accepts `/regex/flags` and `glob*` patterns alongside legacy substring match. Invalid regex fails closed.
- **Compound-command permission parsing** (#25): Evaluates `cmd1 && cmd2`, `a | b`, `x; y` per-sub-command with most-restrictive-wins (deny > ask > allow). Process wrappers (`timeout`, `nice`, `nohup`, `stdbuf`) stripped before matching. Closes the `git log && rm -rf /` bypass class.
- **AI review workflow** (#24): Converted from `pull_request` auto-trigger to `issue_comment`-mention trigger (`@openharness` or `/oh-review`). Shell-injection fix — PR content routed through env vars and delivered via stdin, never interpolated into a shell-quoted string. 15-min job ceiling + 10-min inner timeout.
- **MonitorTool** (#24): Use `proc.on("close")` instead of `"exit"` to avoid draining race on fast-exiting commands — fixes the previously-flaky "filters output by pattern" test.

### Fixed
- **`SessionSearchTool` test isolation** (#26): Singleton DB now honors `OH_SESSION_DB_PATH` env var for test isolation. The "empty DB returns no results" test no longer fails on machines with real session history.

### Summary
976 tests (up from 890 — **+86 tests**; 40 in this release alone across skills, plugins, agents, marketplace, memory, hooks, permissions, safe-env, session-db). 42 tools, 79 commands. Full typecheck + lint clean. Two PRs merged (#24, #25) closing the "this feels like Claude Code" ecosystem surface gap. Remaining Tier A item (hook JSON I/O mode) deferred to next sprint.

## 2.8.0 (2026-04-16) — Full Test Coverage

### Added
- **25 integration tests**: MultiEdit (4 tests, atomic failure), WebFetch SSRF (7 tests covering localhost/private/protocol blocking), Cron lifecycle (3 tests), Monitor (3 tests with pattern filtering), PowerShell (2 platform-aware tests), SendMessage (2 tests), Worktree error handling (2 tests), Pipeline/RemoteTrigger error paths (2 tests)

### Summary
890 tests, 42 tools, 78 commands. All tool directories now have test coverage. Zero Biome warnings.

## 2.7.0 (2026-04-16) — Full Parity

### Added
- **19 new slash commands**: /version, /whoami, /project, /stats, /tools, /api-credits, /terminal-setup, /verbose, /quiet, /provider, /release-notes, /stash, /branch, /listen, /truncate, /search, /summarize, /explain, /fix (78 total — near Claude Code parity)
- **22 new tool tests**: TodoWrite, Memory, TaskCreate/Update/List, ToolSearch, EnterPlanMode, ExitPlanMode, KillProcess (865 tests total)

### Changed
- **Layout decomposition**: Split `renderer/layout.ts` (929 lines) into `layout.ts` (428 lines) + `layout-sections.ts` (520 lines) — 15 section renderers extracted

### Summary
865 tests, 42 tools, 78 slash commands. Near-complete Claude Code parity. Layout engine decomposed. All Biome/TypeScript clean.

## 2.6.0 (2026-04-16) — Quality & Gap Closure

### Added
- **TodoWriteTool**: New tool for writing/updating todo items with ID-based upsert (42 tools total)
- **8 new slash commands**: `/bug`, `/feedback`, `/upgrade`, `/token-count`, `/benchmark`, `/vim`, `/login`/`/logout`, `/review-pr`, `/pr-comments`, `/add-dir` (59 total)
- **33 new tests**: Extended command tests, EvaluatorLoop tests (817 total)

### Changed
- **Command decomposition**: Split monolithic `commands/index.ts` (1,299 lines) into 6 domain modules — `session.ts`, `git.ts`, `info.ts`, `settings.ts`, `ai.ts`, `skills.ts` + thin registry (83 lines)
- **Model-aware extended thinking**: Anthropic thinking budget scales by model (Opus: 32K tokens, others: 10K). Max output tokens also model-aware (Opus: 16,384, others: 8,192)
- **OpenAI reasoning effort**: Now model-aware — full models get `high`, mini models get `medium`. Added `o4` model detection
- **InitWizard hooks**: Proper `useCallback` wrapping for `runTest`, correct dependency arrays (fixed 3 React warnings)

### Fixed
- 6 Biome lint warnings resolved (unused variables, exhaustive dependencies, dead code)
- 2 TODO comments resolved (hooks.ts prompt hook documented, skill template placeholder)
- Removed unused `inThinkingBlock` state tracking in Anthropic provider
- Removed unused `cursor` destructure in renderer layout

### Summary
817 tests, 42 tools, 59 slash commands. Zero Biome warnings. Commands decomposed for maintainability. Extended thinking now model-aware.

## 2.5.0 (2026-04-15) — Infrastructure & Community

### Added
- **MCP Server Mode**: `oh mcp-server` exposes all 41 tools as an MCP server via stdio JSON-RPC. Any MCP client (Claude Code, Cline, Gemini CLI) can call openHarness tools.
- **Skills Registry**: `oh skill search <query>` and `oh skill install <name>` for community skills. JSON-based registry at data/registry.json with 4 initial skills.
- **Auto-commit per tool**: `gitCommitPerTool` config option — atomic git commits after each file-modifying tool execution (Aider-style).
- **SWE-bench benchmark harness**: `scripts/swe-bench.mjs` runs openHarness against SWE-bench Lite with `--sample N` and `--instance` options. Results to BENCHMARKS.md.
- **Skill feedback loop**: Skills track `timesUsed` and `lastUsed` in frontmatter. Auto-extracted skills unused for 60 days (<2 uses) are pruned during consolidation.
- **Post-compact recovery**: Compression message tells LLM to re-read working files.
- **Compression circuit breaker**: Stops auto-compressing after 3 consecutive failures.
- **Compression telemetry**: Logs tokens before/after and strategy used.
- `/skill-search` and `/skill-install` slash commands.

### Changed
- README badges updated to match actual counts (784 tests, 41 tools)
- Comparison table tool count corrected

## 2.4.0 (2026-04-14) — Hermes Parity

### Added
- **Budget warnings**: 70%/90% cost and turn limit warnings injected into system prompt dynamically
- **Live memory injection**: Memory section refreshed mid-session when memories change (memoryVersion counter)
- **Skill CRUD commands**: `/skill-create`, `/skill-edit`, `/skill-delete`
- **Fallback provider chains**: `createFallbackProvider()` with transparent failover on rate limits and 5xx
- **`fallbackProviders` config**: Chain order in `.oh/config.yaml`
- **Skill system Claude Code compatibility**: Recursive directory scan, `allowedTools` parsing, `invokeModel: false`

### Changed
- USER_PROFILE_MAX_CHARS from 2000 to 1375 (Hermes-aligned)
- MEMORY_PROMPT_MAX_CHARS capped at 2200
- `memoriesToPrompt()` respects char cap
- `process.chdir()` race fixed — workingDir passed via QueryConfig
- FallbackProvider: activeFallback uses getter, stream fallback pre-stream only, 401/403 not retriable
- Removed 11 unnecessary `as any` casts

### Summary
777 tests. Hermes parity features + Claude Code skill compatibility. Budget warnings, live memory, skill CRUD, provider fallback, and recursive skill directory support.

## 2.3.1 (2026-04-14) — Polish

### Fixed
- Wire memories, skills, and user profile into system prompt (were built but never injected)
- Auto-trigger skill suggestions when user message matches skill triggers
- LLM quality gate before persisting extracted skills
- LLM-assisted user profile consolidation (replaces append+truncate)
- Fix `process.chdir()` race condition in AgentTool (pass workingDir via QueryConfig)
- 7 new tests (absolute path traversal, ScheduleWakeup lifecycle, FTS5 edge cases, agent eviction)

## 2.3.0 (2026-04-14) — Self-Evolving Agent

### Added
- **Self-Evolving Skills**: Agent automatically extracts reusable skill files from sessions with 5+ tool calls. Skills persist to `.oh/skills/auto/` with YAML frontmatter (`source: auto`, version tracking, session provenance). Powered by `SkillExtractor` service with LLM-based pattern analysis.
- **Session Search (SQLite FTS5)**: Cross-session full-text search via `SessionSearchTool`. Sessions indexed into `~/.oh/sessions.db` on every save. BM25-ranked results with snippet highlighting. `/rebuild-sessions` command for index maintenance.
- **Progressive Skill Disclosure**: Skills now use 3-level loading — Level 0 (name+description, ~30 tokens) in system prompt, Level 1 (full content) on `Skill(name)`, Level 2 (supporting files) on `Skill(name, path)`. 94% token reduction at 100+ skills.
- **User Modeling (USER.md)**: Auto-maintained user profile at `.oh/memory/USER.md` (2000 char max). Curates role, preferences, and workflows across sessions. Injected into system prompt as `# User Profile`.
- **`findSimilarSkill()`**: Fuzzy name/description matching for patch-vs-create decisions in skill extraction.
- **`/rebuild-sessions`**: Slash command to rebuild FTS5 search index from session JSON files.

### Changed
- `saveSession()` now indexes sessions into SQLite FTS5 (fire-and-forget, non-blocking)
- `sessionEnd` hook now receives session metadata (sessionId, model, provider)
- `SkillTool` accepts optional `path` parameter for Level 2 supporting file access
- New dependency: `better-sqlite3` for session search

### Summary
Hermes-inspired self-evolving agent features. The agent now learns from every session — extracting reusable skills, searching past sessions for context, and building a persistent user profile. 769 tests (was 749).

## 2.2.0 (2026-04-12) — Gap Closer

### Added
- **ScheduleWakeup Tool**: Self-paced autonomous agent loops with cache-aware timing (5-min TTL breakpoints). `suggestDelay()` utility for optimal delay calculation. `consumeWakeup()`/`cancelWakeup()` API for REPL integration.
- **`/loop` Command**: Run prompts repeatedly with fixed intervals (`/loop 5m /review`) or dynamic self-pacing via ScheduleWakeup.
- **Plan File Persistence**: `EnterPlanMode` creates unique plan files at `.oh/plans/<adjective-verb-noun>.md`. Plans persist across sessions.
- **ExitPlanMode `allowedPrompts`**: Pre-authorize specific actions (e.g., `{tool: "Bash", prompt: "run tests"}`) when exiting plan mode.
- **Agent Continuation Registry**: Background agents tracked in `AgentMessageBus`. `SendMessage` can target background agents by ID to query status and queue follow-up messages.
- **MEMORY.md Index**: Auto-generated index file with one-liner pointers to all memories. Refreshed on save and consolidation.
- **New Memory Types**: `user`, `feedback`, `reference` (Claude Code compatible) alongside legacy `convention`, `preference`, `debugging`.
- **Agent `isolation` Parameter**: Accept both `isolation: "worktree"` (Claude Code style) and `isolated: boolean` for API compatibility.
- **`/init` Command**: Initialize project with `.oh/RULES.md` and `.oh/config.yaml` templates.
- **`/permissions` Command**: View current permission mode or switch modes interactively.
- **`/allowed-tools` Command**: View configured tool permission rules from `.oh/config.yaml`.
- **Checkpoint Tests**: 9 tests covering snapshot, rewind, file extraction, and edge cases.

### Changed
- Default memory type changed from `convention` to `user`
- `/plan` command now instructs use of EnterPlanMode/ExitPlanMode tool workflow
- Memory detection prompt updated to use new type taxonomy
- `/help` categories updated with new commands

### Summary
Closes 10 of 14 identified gaps with Claude Code. 749 tests (was 716). New features: autonomous loops, persistent plans, agent continuation, memory indexing, and 3 new slash commands.

## 2.0.0 (2026-04-12) — Beyond Parity

### Added
- **Active Context Management**: Per-tool token budgets, sub-agent output folding, proactive compression. Prevents context overflow before it happens.
- **GAN-Style Evaluator Loop**: Generator→Evaluator adversarial refinement with weighted rubrics (correctness, completeness, quality, safety). `--evaluate` flag for headless mode.
- **Session Traces & Observability**: Structured spans for every turn, tool call, and compression. JSONL persistence, OpenTelemetry export format, `/trace` command.
- **Agent SDK (Library Mode)**: `createAgent()` programmatic API. `import { createAgent } from '@zhijiewang/openharness'` for CI/CD bots, PR review automation, GitHub Actions.
- **Meta-Harness Self-Optimization**: `oh optimize` command — agent modifies its own config, benchmarks after each change, keeps improvements. Based on AutoAgent research (#1 on SpreadsheetBench).

### Changed
- Package exports: `"."` now points to SDK (`dist/sdk/index.js`), CLI at `"./cli"`
- Sub-agent output automatically folded when >2KB (context folding)
- Tool output enforced against per-tool token budgets

## 1.4.0 (2026-04-11) — Full Claude Code Parity

### Added
- **12 Hook Events** (was 4): fileChanged, cwdChanged, subagentStart/Stop, preCompact/postCompact, configChange, notification
- **HTTP + Prompt Hook Types**: hooks can now POST to URLs or use LLM yes/no checks, not just shell commands
- **Path-Scoped Rules**: `.oh/rules/*.md` with `paths:` frontmatter for monorepo-aware instructions
- **@file References**: `@README.md` in prompts injects file content (up to 10KB)
- **Permission Specifiers**: `Bash(npm run *)`, `Edit(src/**/*.ts)` — glob-style argument matching in permission rules
- **Interactive Rewind**: `/rewind` shows numbered checkpoint list; `/rewind <n>` restores to specific point
- **PowerShell Tool**: Windows-native PowerShell execution (deferred, win32 only)
- **Monitor Tool**: Watch background processes with optional regex filtering and output streaming
- **--json-schema**: CLI flag for constrained structured output in headless mode
- **LSP Enhancements**: Added hover action and support for Go (gopls) and Rust (rust-analyzer) language servers

### Summary
This release closes all 10 identified gaps with Claude Code, achieving full feature parity as an open-source alternative. 39 tools, 10+ agent roles, 677 tests.

## 1.3.0 (2026-04-11)

### Added
- **Plugin Marketplace**: `marketplace.json` spec for curated plugin registries. Install from GitHub repos, npm packages, or URLs. Cached to `~/.oh/plugins/cache/`. Full `/plugins` command: search, install, uninstall, marketplace add/remove.
- **Markdown Agent Definitions**: Create agents as `.md` files in `.oh/agents/` or `~/.oh/agents/` — no TypeScript needed. YAML frontmatter for name, description, and tools.
- **Plugin Namespacing**: Skills from marketplace plugins auto-namespaced as `plugin-name:skill-name` to prevent conflicts.

## 1.2.0 (2026-04-11)

### Added
- **Tool Pipelines**: Declarative multi-step workflows via Pipeline tool. Steps execute in dependency order with $ref variable substitution. 11 tests.
- **Documentation Site**: GitHub Pages docs at docs/ — getting started, configuration reference, tools, agent roles, pipelines, MCP servers, remote API, architecture, plugins

## 1.1.0 (2026-04-11)

### Added
- **A2A HTTP Server**: POST /a2a endpoint on remote server for cross-process agent task delegation, discovery, and status queries
- **API Security Layer**: Bearer token auth, per-IP rate limiting (60/min default), tool allowlist for remote callers, X-Request-ID headers
- **Multi-Model Router**: Task-aware model selection — fast model for exploration, powerful for code review, balanced as default. Configurable via `modelRouter` in config.yaml
- **Semantic Compression**: Context window optimization with importance scoring — removes lowest-value messages first instead of oldest-first. Keeps user intent and tool decisions over assistant commentary
- **Opt-in Telemetry**: Local JSONL event logging for tool usage, errors, session stats. Default OFF. `/doctor` can show aggregate stats

### Changed
- Remote server now publishes A2A agent card on startup (auto-discovered by `/agents`)
- CORS headers include Authorization for token auth
- Context compression drops messages by importance score instead of chronological order

## 1.0.0 (2026-04-11)

### openHarness reaches v1.0

Open-source terminal coding agent — works with any LLM.

**35 tools, 10 agent roles, 633 tests, 34 slash commands.**

### Highlights since 0.11.1
- **Verification Loops**: Auto-run lint/typecheck after every file edit. Auto-detects TypeScript, ESLint, Python/ruff, Go, Rust. Configurable via `.oh/config.yaml`.
- **Agent Role System**: 10 specialized roles with tool-level isolation (code-reviewer, evaluator, planner, architect, migrator, etc.). Explicit `allowed_tools` parameter for custom filtering.
- **Progressive Tool Expansion**: 18 of 35 tools deferred (lazy-loaded), reducing system prompt by ~46%. Tools resolve on first use or via ToolSearch.
- **Cron Executor**: Background scheduler runs due tasks every 60s. Results persisted to `~/.oh/crons/history/`.
- **Hibernate-and-Wake**: Sessions save context on exit, inject wake-up summary on resume with directory change detection.
- **Global Config**: `~/.oh/config.yaml` as fallback defaults for all projects. 3-layer merge: global → project → local.
- **MCP Server Registry**: Curated catalog of 15 MCP servers. `/mcp-registry` for browsing and generating install configs.
- **Dream Consolidation**: Memory pruning on session exit with temporal decay (0.1/30 days). Defense-in-depth file deletion guard.
- **60fps Renderer**: Batched rendering at ~16ms intervals instead of per-token, reducing CPU during fast streaming.
- **Smart Init Wizard**: Auto-detects provider from env vars, MCP server selection step.
- **Plugin System**: Skills + plugins documented. `/plugins` command for discovery.
- **E2E Tests**: 9 integration tests covering the full agent loop cycle.
- **Enhanced `/doctor`**: Memory stats, cron count, verification config, Node.js version check.

### Fixed
- Agent role `suggestedTools` used wrong names (FileRead→Read, FileWrite→Write, FileEdit→Edit)
- Verification shell-escapes file paths (command injection prevention)
- Memory deletion guarded by directory boundary check
- MultiEdit verification checks all modified files
- Windows timeout detection in verification
- npm package slimmed from 2.1MB to 818KB

## 0.12.1 (2026-04-11)

### Added
- **Hibernate-and-Wake**: Sessions save context summary on exit; resumed sessions get wake-up context with previous state, working directory change warnings, and continuation guidance
- **3 New Agent Roles**: `planner` (implementation plans), `architect` (system design), `migrator` (codebase migrations) — 10 roles total
- **MCP Server Registry**: Curated catalog of 15 MCP servers with `/mcp-registry` command for browsing, searching, and generating install configs
- **Global Config Hierarchy**: `~/.oh/config.yaml` as fallback defaults for all projects; config loads global → project → local

### Fixed
- npm package size reduced from 2.1MB to 818KB (excluded test files and source maps)

## 0.12.0 (2026-04-11)

### Added
- **Verification Loops**: Auto-run lint/typecheck after file edits (Edit, Write, MultiEdit) with auto-detected or configurable rules. Supports TypeScript, ESLint, Python/ruff, Go, Rust.
- **Generator/Evaluator Split**: Agent roles now restrict sub-agent tools via `suggestedTools`. New `evaluator` role for read-only code evaluation with test running. New `allowed_tools` parameter for explicit tool filtering.
- **Dream Consolidation**: Memory pruning on session exit with temporal decay (0.1 relevance lost per 30 days of inactivity). Files below 0.1 relevance are automatically deleted.
- **Progressive Tool Expansion**: 18 of 35 tools are now deferred (lazy-loaded), reducing system prompt size by ~46%. Tools resolve on first use or via ToolSearch.
- **Cron Executor**: Background scheduler that runs due cron tasks every 60 seconds. Results persisted to `~/.oh/crons/history/`.
- **DeferredTool**: Lazy-loading wrapper for built-in tools (mirrors DeferredMcpTool pattern for MCP tools).

### Fixed
- Agent role `suggestedTools` used wrong names (`FileRead` -> `Read`, `FileWrite` -> `Write`, `FileEdit` -> `Edit`)
- Verification shell-escapes file paths to prevent command injection
- Memory deletion guarded by directory boundary check (defense-in-depth)
- MultiEdit verification now checks all modified files, not just the first

## 0.5.1 (2026-04-06)

### Fixed
- Cybergotchi panel overlapping chat text — stdout messages and Ink left column capped to `terminalWidth - panelWidth`; panel auto-hides on narrow terminals (#20)
- Duplicate thinking block in REPL JSX

## 0.5.0 (2026-04-06)

### Added
- **Permission modes**: `acceptEdits` (auto-approve file ops) and `plan` (read-only) join existing ask/trust/deny
- **Hooks system**: shell commands on `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse` events; preToolUse can block tool calls (exit code 1); configured in `.oh/config.yaml`
- **Extended thinking**: Anthropic thinking blocks, OpenAI o1/o3 reasoning tokens, Ollama `<think>` tag parsing — displayed as dimmed text above response
- **Session fork**: `--continue` flag to resume last session, `--fork <id>` to branch from existing session, `/fork` slash command
- **Provider tests**: unit tests for Ollama, OpenAI, Anthropic, LlamaCpp fetchModels/healthCheck (closes #10)
- **MCP improvements**: per-server `riskLevel` config, configurable `timeout`, auto-restart on crash
- **`llamacpp` auto-detection**: `guessProviderFromModel` recognises `.gguf` and `llamacpp` prefixes (closes #7)
- **429 rate-limit retry**: exponential backoff (2s/4s/8s) with user-visible status
- **README**: permission modes table, hooks guide, provider usage examples (closes #8)

### Changed
- `/compact` now uses smart `compressMessages` with orphan tool result cleanup instead of naive keep-last-10
- Context window tables consolidated into single `getContextWindow()` in `cost.ts`
- Sub-agents inherit parent `permissionMode` instead of hardcoding `trust`

### Fixed
- Cybergotchi panel expanding on each 500ms tick (#15)
- Cybergotchi panel overlapping chat text — capped to terminal width, auto-hides on narrow terminals (#20)
- Shell injection in `autoCommitAIEdits` (#16)
- `/model` provider mismatch — validates model is compatible with current provider (#16)
- Orphan tool results after `/compact` causing Anthropic 400 errors (#17)
- WebFetch redirect blocking — follows redirects with post-redirect SSRF host check (#17)
- `loadCybergotchiConfig()` no longer reads disk on every render (#17)

## 0.4.2 (2026-04-04)

- Fix: print banner before Ink render to eliminate frame stacking (#14)

## 0.4.1 (2026-04-03)

- Fix: surface stream errors instead of silent blank responses (#12)

## 0.4.0 (2026-04-02)

- Feat: add LM Studio provider
- Feat: add llama.cpp/GGUF provider (#6)

## 0.1.0 (2026-04-01)

Initial alpha release. TypeScript rewrite.

### Features
- Single TypeScript process with React+Ink terminal UI
- Agent loop with async generator streaming
- 5 LLM providers: Ollama, OpenAI, Anthropic, OpenRouter, OpenAI-compatible
- 7 tools: Read, Edit, Write, Bash, Glob, Grep, WebFetch (all with Zod schemas)
- Permission gate with ask/trust/deny modes and risk-based tool approval
- Tool concurrency: read-only parallel, write serial
- Project rules (.oh/RULES.md)
- Cost tracking with per-model breakdown
- Session persistence
- Project auto-detection (15+ languages, 20+ frameworks)
- Global install: `npm install -g openharness` then just `oh`
