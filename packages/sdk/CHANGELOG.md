# @zhijiewang/openharness-sdk — Changelog

## 0.1.0 (unreleased)

First release. Mirrors the v0.1 of the Python SDK (`openharness-sdk` 0.1.0).

- `query(prompt, options)` — async generator that spawns `oh run --output-format stream-json` and yields typed events.
- Typed events: `TextDelta`, `ToolStart`, `ToolEnd`, `ErrorEvent`, `CostUpdate`, `TurnComplete`, `TurnStart`, `TurnStop`, `SessionStart`, `HookDecision`, `UnknownEvent`.
- `parseEvent(obj)` — public parser for callers that already have NDJSON in hand.
- `OpenHarnessError` / `OhBinaryNotFoundError` exception types.
- Binary discovery via `OH_BINARY` env var or PATH lookup. `OH_BINARY` may point at a `.cjs` / `.mjs` / `.js` file — in that case the SDK runs the script with the current Node binary.
- Early iterator break terminates the spawned subprocess (5 s grace window before `SIGKILL`).
- Forward-compatible: unrecognised event types surface as `UnknownEvent` instead of throwing.
- Requires Node ≥ 18 and the `oh` CLI installed separately (e.g. `npm i -g @zhijiewang/openharness`).
