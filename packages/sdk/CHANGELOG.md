# @zhijiewang/openharness-sdk — Changelog

## 0.5.0 (unreleased)

Mirrors Python SDK v0.5.0 — session resume, setting sources, and a typed options bundle.

- `resume?: string` option on `query()` and `OpenHarnessClient`. When set, the CLI replays the named session's message history before the new prompt. Capture the ID from `client.sessionId` (or a `SessionStart` event yielded by `query()`) on a previous run.
- `settingSources?: ReadonlyArray<"user" | "project" | "local">` option. Subset of config layers the CLI should merge from `.oh/config.yaml`. Omit to use all three (default precedence: local > project > user).
- `OpenHarnessOptionsBundle` — a class wrapper bundling every option into one object, with `.toOptions()` returning a plain `OpenHarnessOptions` containing only the explicitly-set fields. Convenient for test helpers and factory functions. Mirrors Python's `OpenHarnessOptions` dataclass + `to_kwargs()`.
- Argv assembly threads the new flags as `--resume <id>` and `--setting-sources user,project,local` (comma-joined) on both `oh run` and `oh session`.
- `client.sessionId` continues to populate from either `ready` (always emitted by `oh session`) or a `session_start` event — no behaviour change.
- Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.17.0+ (the version that wired `--resume` and `--setting-sources`).

## 0.4.0 (unreleased)

Mirrors Python SDK v0.4.0 — `canUseTool` permission callback + turn-boundary events.

- `canUseTool: PermissionCallback` option on `query()` and `OpenHarnessClient`. The SDK starts an in-process HTTP server, injects a `permissionRequest` HTTP hook into the ephemeral `.oh/config.yaml`, and routes each permission check through the user's callback. Sync and async callbacks both work.
- Failure modes all surface as `decision: "deny"` (fail-closed):
  - Callback throws ⇒ `{decision:"deny", reason:"callback error: …"}`
  - Callback exceeds the 30 s default timeout ⇒ `{decision:"deny", reason:"callback timeout"}`
  - Callback returns an unrecognised value ⇒ `{decision:"deny", reason:"…"}`
- Public types in the new `permissions` module (re-exported from the package root): `PermissionCallback`, `PermissionContext`, `PermissionDecision`, `PermissionDecisionObject`, `PermissionVerdict`.
- `tools` and `canUseTool` can be set together — the SDK starts both servers and points the CLI's ephemeral config at both.
- Existing `TurnStart` / `TurnStop` / `HookDecision` event types (parsed since v0.1) are now meaningfully populated by the CLI in this scenario.
- Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.16.0+ (turn-boundary hooks + richer HTTP hook envelope).

## 0.3.0 (unreleased)

Mirrors Python SDK v0.3.0 — custom TypeScript tools via an in-process MCP server.

- `tool({ name, description?, inputSchema, handler })` — define a custom tool with a Zod input schema. Strong typing flows from the schema to the `handler` argument.
- `tools: [...]` option on both `query()` and `OpenHarnessClient`. The SDK starts an in-process Streamable-HTTP MCP server (built on `@modelcontextprotocol/sdk`), registers each tool with a JSON Schema generated from its Zod schema (via `zod-to-json-schema`), and writes an ephemeral `.oh/config.yaml` pointing the spawned `oh` CLI at the server.
- Existing user `.oh/config.yaml` at the caller-supplied `cwd` is preserved (model, provider, permissionMode, …); only `mcpServers` and `hooks` are SDK-owned for the lifetime of the runtime.
- Temp dir + MCP server are torn down when the iterator ends or the client closes.
- Handler return values are normalized: strings ⇒ text content; objects ⇒ JSON text + structured content; thrown errors ⇒ MCP `isError: true`.
- New deps: `@modelcontextprotocol/sdk ^1.29.0`, `yaml ^2.7.0`, `zod ^3.24.0` (peer), `zod-to-json-schema ^3.24.0`.
- Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.11.0 or newer (the version that introduced HTTP MCP servers).

## 0.2.0 (unreleased)

Mirrors Python SDK v0.2.0 — long-lived stateful sessions.

- `OpenHarnessClient` — spawns one `oh session` subprocess per client and keeps it warm across many `send()` calls, preserving conversation history in the CLI.
- `client.send(prompt)` returns an `AsyncGenerator<Event>`; concurrent calls are serialized FIFO via an internal mutex (matching Python's `asyncio.Lock`).
- Per-prompt event streams are demultiplexed by the `id` field on each NDJSON line.
- `client.sessionId` exposes the ID surfaced by the CLI's `ready` event so callers can capture it for a future `resume=` (lands in v0.5).
- `client.interrupt()` sends `SIGINT` (POSIX) / `taskkill /T` (Windows) to abort an in-flight prompt.
- `client.close()` is a graceful three-step shutdown: `{command:"exit"}` on stdin → 5 s grace → `SIGTERM` → 3 s grace → `SIGKILL`. Idempotent.
- Implements `Symbol.asyncDispose` so callers can use `await using client = new OpenHarnessClient()` (TS 5.2+ / Node ≥ 20 explicit-resource-management).
- Subprocess crash mid-prompt surfaces an `OpenHarnessError` on the in-flight `send()` rather than hanging.
- Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.15.0 or newer (the version that introduced `oh session`).

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
