# Changelog — openharness (Python SDK)

This package follows its own SemVer track, independent of the `@zhijiewang/openharness` npm package.

## 0.5.0 — 2026-04-22

### Added
- `resume: str | None` kwarg on both `query()` and `OpenHarnessClient`. When set, the CLI replays the prior session's message history before the new prompt. Capture the ID from `OpenHarnessClient.session_id` (populated from the CLI's `ready` event) or from a `SessionStart` event emitted by `query()`.
- `setting_sources: Sequence[str] | None` kwarg on both entry points — passes through to the CLI's `--setting-sources` flag. Any subset of `"user"`, `"project"`, `"local"`. Mirrors Claude Code's `setting_sources`.
- `OpenHarnessClient.session_id` read-only property — surfaces the session ID after entering the async context (None on older CLIs).
- New `SessionStart(session_id)` event type, emitted when the CLI's `session_start` or `ready` NDJSON message arrives.
- New `OpenHarnessOptions` frozen dataclass bundling all 12 kwargs. Use `**opts.to_kwargs()` to unpack into `query()` or `OpenHarnessClient`. Mirrors Claude Code's `ClaudeAgentOptions`.

### CLI dependency
Requires `@zhijiewang/openharness` v2.17.0+ for the new `--resume` and `--setting-sources` flags on `oh run` / `oh session`, and for the `sessionId` field on the `ready` stream-json event.

## 0.4.0 — 2026-04-22

### Added
- `can_use_tool: Callable[[ctx], decision]` kwarg on both `query()` and `OpenHarnessClient`. When set, the SDK starts an in-process HTTP server and injects a `permissionRequest` hook into the ephemeral `.oh/config.yaml` so every permission check is routed through the Python callback. Sync and async callables both work. Callback returns `"allow"` / `"deny"` / `"ask"`, optionally wrapped as `{"decision": "...", "reason": "..."}`. Mirrors Claude Code's `can_use_tool` SDK hook.
- New event types: `TurnStart(turn_number)`, `TurnStop(turn_number, reason)`, `HookDecision(event, tool, decision, reason)` — surface the new NDJSON events introduced in openHarness CLI v2.16.0. `TurnComplete` is unchanged (per-subagent); `TurnStart`/`TurnStop` mark top-level turn boundaries.
- Windows interrupt polish — `OpenHarnessClient` now spawns the CLI with `CREATE_NEW_PROCESS_GROUP` so `interrupt()`'s `CTRL_BREAK_EVENT` delivers cleanly to the child without taking down the parent.

### Changed
- `_tools_runtime.prepare_tools_runtime()` now accepts an optional `can_use_tool` and writes the `hooks.permissionRequest` block in the ephemeral config. `tools` is now optional — either or both may be supplied.
- When the SDK injects hooks, it strips any user-configured `hooks:` block from the caller's `.oh/config.yaml` (top-level non-hooks settings like `model` survive). Previously the SDK only owned `mcpServers`.

### CLI dependency
Requires `@zhijiewang/openharness` v2.16.0+ which emits the `turnStart`, `turnStop`, and `hook_decision` NDJSON events and honors the full `{decision, reason, hookSpecificOutput}` response shape on HTTP hooks. Older CLI versions will work for `query()`/`client.send()` without `can_use_tool`, but the new event types simply won't appear.

## 0.3.0 — 2026-04-20

### Added
- `@tool` decorator for registering Python callables as MCP tools. Accepts `name=` and `description=` overrides; falls back to `__name__` and the first line of the docstring.
- `tools=[...]` parameter on both `query()` and `OpenHarnessClient`. When set, the SDK starts an in-process MCP HTTP server hosting those callables and injects it into an ephemeral `.oh/config.yaml` used as the subprocess `cwd`. Any existing user config at the caller's `cwd` is preserved.
- The MCP server is cleaned up automatically when `query()` completes or the client is closed.

### Dependencies
- Adds `mcp>=1.27` and `uvicorn>=0.30` as runtime deps (previously zero-dep). Both are pulled in only when `tools=` is used, but Python's import graph loads `openharness.tools` eagerly.

### CLI dependency
Works with any `@zhijiewang/openharness` version that supports `type: "http"` MCP servers — v2.11.0 and later. No CLI changes required for this release.

## 0.2.0 — 2026-04-19

### Added
- `OpenHarnessClient` class for long-lived multi-turn conversations. Use as an async context manager; `send(prompt)` returns an async iterator of typed events. Mirrors Claude Code's `ClaudeSDKClient`.
- Concurrent `send()` calls on the same client are serialized via an `asyncio.Lock`.
- `close()` is idempotent; sends a `{command: "exit"}` graceful shutdown sentinel, then falls back to SIGTERM → SIGKILL on timeout.
- `interrupt()` method sends SIGINT to the active subprocess (SIGBREAK on Windows).

### CLI dependency (npm side)
Requires `@zhijiewang/openharness` v2.15.0+ which adds the `oh session` command. Older CLI versions cannot start a stateful session and will error with "unknown command: session".

## 0.1.0 — 2026-04-19

### Added
- Initial release. `query(prompt, **options)` async generator that spawns the `oh` CLI and streams typed events.
- Event dataclasses: `TextDelta`, `ToolStart`, `ToolEnd`, `ErrorEvent`, `CostUpdate`, `TurnComplete`, `UnknownEvent`.
- Exceptions: `OhBinaryNotFoundError`, `OpenHarnessError`.
- Binary discovery via `OH_BINARY` env var (first choice) or `shutil.which("oh")` on PATH.
- Zero runtime dependencies; stdlib async only.
- Typed package (`py.typed` marker); mypy-strict clean.
