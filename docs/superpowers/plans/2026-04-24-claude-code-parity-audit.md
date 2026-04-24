# Claude Code Parity Audit — 2026-04-24

**State:** openHarness v2.17.0 / Python SDK v0.5.0 (as of 2026-04-22).
**Baseline:** Claude Code (~April 2026) + claude-agent-sdk (Python + TypeScript).
**Purpose:** Identify concrete, actionable parity gaps and prioritize them into the next release bundle(s). Feeds into follow-up implementation plans (one per bundle).

## Methodology

Dispatched two research agents in parallel:
- **claude-code-guide** — enumerated Claude Code's current surface (slash commands, hooks, settings, CLI flags, tools, MCP, SDK features, IDE integrations).
- **Explore** — enumerated openHarness's surface from source (`src/slashCommands/`, `src/hooks/`, `src/tools/`, `python/`, etc.) + recent gap-closure history from `docs/superpowers/plans/` and `CHANGELOG.md`.

Cross-referenced the two inventories category-by-category.

## Already shipped (for context)

Last six releases closed these parity gaps (don't repeat):

- **v2.12** — OAuth 2.1 for Remote MCP
- **v2.13** — postToolUseFailure / userPromptSubmit / permissionRequest hooks, ModelRouter, fallback providers
- **v2.14** — OS keychain for MCP OAuth, first-run wizard, session fork/export
- **v2.15** — Python SDK (query, OpenHarnessClient, @tool, MCP), `oh session` streaming
- **v2.16** — turnStart / turnStop hooks, structured HTTP hook protocol
- **v2.17** — `--resume` + `--setting-sources` on `oh run` / `oh session`, OpenHarnessOptions dataclass

Already at ~95% parity on core CLI use cases. Remaining gaps break down as follows.

---

## Verification pass (post-audit grep)

After drafting this audit, grepped the "unknowns" to avoid redesigning already-built infra. Found four items from the original Tier A were **already shipped** and one was partially built. Corrections:

- ✅ **`--continue` / `-c`** — FULLY WIRED (`src/main.tsx:549, 670–678`). Calls `getLastSessionId()`, aliases to `--resume`. **Already done — dropped from Tier A.**
- ✅ **`--fork <id>`** — FULLY WIRED (`src/main.tsx:550, 680–689`). Loads source session messages. **Not a gap.**
- ✅ **`@-mention` resolution in REPL** — FULLY WIRED (`src/harness/submit-handler.ts:145–191`). Supports `@file`, `@file#L5-10`, line ranges, 10K-char truncation, MCP resource fallback via `resolveMcpMention`. **Not a gap — assumption in the initial audit was wrong.**
- ✅ **Hook matcher** — FULLY WORKING (`src/harness/hooks.ts:116–162, 483/516/535/671`). `def.match` supports regex (`/pattern/flags`), globs (`*`), and substring. Applied at all four emitter sites (sync, async, structured-outcome, preToolUse). **B6 dropped — already done.**
- ✅ **`/doctor`** — FULLY IMPLEMENTED (`src/commands/info.ts:244`). Detailed health check: provider/model/permission, API-key presence, context usage %, git status, MCP servers, config file, session info, cost. **Not a stub.**
- ⚠ **`--json-schema`** — flag is DECLARED (`src/main.tsx:553`) but **not wired** (no `opts.jsonSchema` reference anywhere in the codebase). Partially built — just needs the validator plumbing. **Keeps Tier B4, re-scoped.**
- ⚠ **MCP resources** — client-level `listResources()` / `readResource()` methods EXIST (`src/mcp/client.ts:106–117`) and are used by the `@-mention` resolver (`src/mcp/loader.ts:120/135/140`), but NOT exposed as agent-callable tools. The model can't list or read resources during a turn. **Kept as a gap, re-scoped as "wrap existing client methods as tools".**
- ❌ **outputStyle** — genuinely missing. No matches anywhere in `src/`.
- ❌ **`language` setting** — genuinely missing.
- ❌ **`/hooks` command** — not registered in `src/commands/info.ts`. Genuinely missing (distinct from `/doctor`).
- ❌ **`/reload-plugins`** — genuinely missing.
- ❌ **`--include-partial-messages` / `--include-hook-events`** — genuinely missing.
- ❌ **`--max-budget-usd`** — genuinely missing.
- ❌ **MCP prompts-as-slash-commands** (JSON-RPC `prompts/list`, `prompts/get`) — genuinely missing.

**Takeaway:** ~60% of what I initially called "Tier A gaps" were already shipped. Memory rule reinforced again — grep before designing.

---

## Tier A — ship next (CORRECTED, low effort, high value)

Natural next-release bundle. Each item is 1–2 days of focused work.

### A1. Output styles (`outputStyle` setting + `.oh/output-styles/`)

CC ships **Default / Explanatory / Learning** + user-defined styles via YAML frontmatter. Each swaps the system prompt preface. OH has `effortLevel` but no equivalent — every session gets the same personality.

**Why it matters:** Teacher/learner use cases (Explanatory, Learning with `TODO(human)` markers) are CC's signature differentiator for non-professional developers. Cheap to port: one config key, one system-prompt injection point, three built-in styles.

**Effort:** ~1 day. Add `outputStyle` to config schema, build a style loader, inject into `buildSystemPrompt` (`src/main.tsx:697`).

### A2. `--include-partial-messages` / `--include-hook-events` on `oh run --print`

CC's Agent SDK streams token-level deltas and hook events when asked. OH's `oh run --output-format stream-json` already emits tool boundaries and cost updates (`src/main.tsx:707+`) but not token-level deltas to the NDJSON stream, or hook lifecycle events. Closes a real SDK parity gap — Python consumers who want to stream tokens to a UI currently can't.

**Effort:** ~1 day. `text_delta` events already exist internally (`src/main.tsx:708`); flag guards their inclusion in stream-json mode. Hook fan-out requires reading `ctx` from the existing hook emitter.

### A3. New `/hooks` slash command

List all loaded hooks grouped by event, showing source (`.oh/config.yaml` / plugin name / skill) and matcher. Useful for debugging "why isn't my hook firing" — currently the only way to introspect is to read the config file.

**Effort:** ~3 hours. New `register("hooks", ...)` in `src/commands/info.ts`, iterate `getHooks()` output (`src/harness/hooks.ts`).

### A4. `language` setting

Single key that prepends "Respond in {language}" to the system prompt. Dovetails with the Chinese README work — users who read the Chinese README should be able to set `language: zh-CN` and get Chinese responses without manual prompting per turn.

**Effort:** ~1 hour. Config key + prompt injection in `buildSystemPrompt`.

### A5. MCP resource tools (`ListMcpResources` + `ReadMcpResource`)

Client-level methods exist in `src/mcp/client.ts:106–117`. Wrap them as two built-in tools so the agent can enumerate and read resources during a turn (not just via user `@-mention`). Closes MCP tool-surface parity.

**Effort:** ~3 hours. Two new tool files under `src/tools/`, register in `src/tools.ts`, call existing `client.listResources()` / `client.readResource(uri)`.

### A6. Wire `--json-schema` to output validation

Flag is declared (`src/main.tsx:553`) but `opts.jsonSchema` is never read. Finish the job: parse the schema, validate the final assistant message after the agent loop completes in `--print` mode, exit non-zero with validation errors on stderr.

**Effort:** ~3 hours. Schema parsing via Zod (already a dep), validation hook in the `--print` branch of `main.tsx`.

**Proposed bundle: v2.18.0 "Personality & Plumbing"** (A1 + A2 + A3 + A4 + A5 + A6). Total ~2.5 days of focused work. All six are additive, independent, and low-risk.

---

## Tier B — plan after Tier A (medium effort)

### B1. TypeScript / JavaScript SDK

openHarness is written in TypeScript but only ships a Python SDK. Biggest ecosystem gap. JS/TS developers who want to embed `oh` in a Node app, a VS Code extension, or an Electron tool have no native SDK — they'd shell out to `oh session` manually.

**Parity mirror:** `@anthropic-ai/claude-agent-sdk` on npm. Should expose `query()`, `OpenHarnessClient`, MCP tool helpers, and turn events mirroring the Python SDK.

**Effort:** ~1 week. Can reuse the stream-json protocol the Python SDK already drives; most of the work is API shape + typings + tests + packaging under `@zhijiewang/openharness-sdk`.

### B2. Missing hook events

CC has 28 hook events; OH has 15. Practical gaps worth closing:

- **`userPromptExpansion`** — fires after slash command → prompt expansion (OH currently hides this boundary)
- **`postToolBatch`** — after parallel tools resolve, before next model call (OH has individual `postToolUse` but no batch boundary)
- **`permissionDenied`** — fires when auto-mode blocks (OH has `permissionRequest` but no symmetric deny event)
- **`taskCreated` / `taskCompleted`** — TaskCreate/TaskUpdate already emit internally; just need external hook fan-out
- **`instructionsLoaded`** — when CLAUDE.md / rules files load; useful for audit trails

**Effort:** ~2 days. Plumbing into existing emitter, matcher semantics, docs.

### B3. `--max-budget-usd` hard cap

OH tracks cost but has no mechanism to stop a runaway session. CC's flag halts the agent loop once the session exceeds a dollar threshold.

**Effort:** ~3 hours. Check inside the turn loop before each LLM call.

### B4. `/reload-plugins` hot reload

Rediscover plugins / skills / hooks / MCP configs without restarting the session. Developer-experience win when iterating on a plugin.

**Effort:** ~1 day. Invalidate the three discovery caches and re-run loaders.

### B5. MCP prompts-as-slash-commands

CC lets MCP servers expose prompts that surface as `/server:prompt` inside the CLI. OH doesn't call `prompts/list` or `prompts/get` on connected servers. Closes another MCP-spec capability gap — several MCP servers (GitHub, Sentry) ship canned prompts.

**Effort:** ~1 day. Add `listPrompts()` / `getPrompt(name)` to `src/mcp/client.ts`, enumerate at connect time, register as `/<server>:<prompt>` slash commands.

*(B6 dropped — hook matcher already works for all events, confirmed in post-audit grep.)*

---

## Tier C — defer (large scope or niche)

### C1. VS Code extension

Single largest gap vs CC. Requires inline diff viewer, selection context, `@-mention` file references, plan review, session history UI, diagnostics injection. CC's VS Code integration is one of its stickiest features.

**Scope:** 2–4 weeks for a credible MVP. Needs its own roadmap doc; tracking-only in this audit.

### C2. Agent teams

CC has `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` behind a flag — `SendMessage` between peer agents, `TeamCreate`, `TeamDelete`. OH has `SendMessage` already. TeamCreate/TeamDelete would round it out, but this is experimental in CC too and niche.

**Scope:** ~1 week. Defer until demand.

### C3. Remote control / teleport / `--from-pr`

CC can sync sessions between claude.ai web and local via Remote Control; `--from-pr` resumes a session linked to a GitHub PR. These require a cloud backend OH doesn't have (and, per the recent `readme-zh-cn-sync` discussion, user explicitly does not want to build cloud infra for docs sync).

**Scope:** Indefinite. No plan unless OH grows a hosted backend.

### C4. Channels (MCP external notifications)

Research preview in CC. Push notifications from external systems into a running session via MCP.

**Scope:** Wait for CC to exit research preview and prove the pattern.

### C5. Sandbox — OS-level enforcement

OH has `sandbox.*` config (allowed paths, domains, blocked commands). CC additionally does filesystem isolation and network allowlist via OS primitives (sandbox-exec on macOS, namespaces on Linux). OH is config-based only.

**Scope:** ~2 weeks. Defer unless specific security request.

### C6. Attribution customization

`attribution` setting in CC lets orgs customize git commit trailer format. Niche — mostly requested by Enterprise customers with compliance requirements. Skip unless asked.

### C7. Voice dictation

Niche.

### C8. Desktop app / Chrome extension

Very large scope. Skip.

---

## Recommended next action

Spin off **v2.18.0 "Personality & Plumbing"** implementation plan (Tier A: A1–A6). Estimated at ~2.5 days of focused work after the post-audit grep corrections. See the sibling plan doc `2026-04-24-v2.18.0-personality-plumbing.md`.

After that ships, the natural next move is the **TypeScript SDK (B1)** — largest remaining ecosystem gap, and the repo is already TS so the idiomatic surface area is well-understood.

Defer everything in Tier C until there's explicit user demand or a specific project context that makes the investment payoff clear.
