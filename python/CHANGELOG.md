# Changelog — openharness (Python SDK)

This package follows its own SemVer track, independent of the `@zhijiewang/openharness` npm package.

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
