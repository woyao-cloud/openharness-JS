# Changelog

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
