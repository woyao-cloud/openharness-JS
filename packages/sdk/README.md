# @zhijiewang/openharness-sdk

TypeScript SDK for [openHarness](https://github.com/zhijiewong/openharness). Drive the `oh` terminal coding agent from Node.js — stream tokens and tool calls, control models and permissions, all with a small async API.

This package mirrors the [Python SDK](https://pypi.org/project/openharness-sdk/) (`openharness-sdk` 0.5.0) and follows its own independent SemVer track.

## Prerequisite

Install the `oh` CLI first (via npm):

```bash
npm install -g @zhijiewang/openharness
```

The SDK locates `oh` on `PATH`. To point at a specific build, set `OH_BINARY=/absolute/path/to/oh` or pass `{ ohBinary: "..." }` in options.

## Install

```bash
npm install @zhijiewang/openharness-sdk
```

Requires Node.js ≥ 18. ESM-only.

## Quick start

```ts
import { query } from "@zhijiewang/openharness-sdk";

for await (const event of query("Summarize README.md in this directory.", {
  model: "ollama/llama3",
  permissionMode: "trust",
  maxTurns: 5,
})) {
  if (event.type === "text") process.stdout.write(event.content);
  else if (event.type === "tool_start") console.log(`\n[tool: ${event.tool}]`);
  else if (event.type === "tool_end") console.log(`[${event.tool} → ${event.error ? "error" : "ok"}]`);
}
```

## API (v0.1)

### `query(prompt, options?) → AsyncGenerator<Event>`

Run a single prompt through `oh` and stream events as they arrive.

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | from config | Model string (e.g. `"ollama/llama3"`, `"claude-sonnet-4-6"`). |
| `permissionMode` | `PermissionMode` | `"trust"` | `"ask"`, `"trust"`, `"deny"`, `"acceptEdits"`, `"plan"`, `"auto"`, `"bypassPermissions"`. |
| `allowedTools` | `readonly string[]` | — | Whitelist of tool names. |
| `disallowedTools` | `readonly string[]` | — | Blacklist of tool names. |
| `maxTurns` | `number` | `20` | Maximum number of model turns. |
| `systemPrompt` | `string` | — | Override the default system prompt. |
| `cwd` | `string` | current dir | Working directory for the spawned CLI. |
| `env` | `Record<string, string>` | — | Env vars merged on top of `process.env`. |
| `ohBinary` | `string` | from `OH_BINARY` / PATH | Override the `oh` binary path. |

Breaking out of the iterator early (`break`) terminates the subprocess (graceful `SIGTERM` with a 5 s grace window before `SIGKILL`).

### Event types

All events have a discriminating `type` field. Use TypeScript's narrowing (`if (event.type === "...")`) or a `switch` to handle them.

- `TextDelta { type: "text"; content: string }`
- `ToolStart { type: "tool_start"; tool: string }`
- `ToolEnd { type: "tool_end"; tool: string; output: string; error: boolean }`
- `ErrorEvent { type: "error"; message: string }`
- `CostUpdate { type: "cost_update"; inputTokens: number; outputTokens: number; cost: number; model: string }`
- `TurnComplete { type: "turn_complete"; reason: string }`
- `TurnStart { type: "turnStart"; turnNumber: number }` *(CLI v2.16.0+)*
- `TurnStop { type: "turnStop"; turnNumber: number; reason: string }` *(CLI v2.16.0+)*
- `SessionStart { type: "session_start"; sessionId: string | null }` *(CLI v2.17.0+)*
- `HookDecision { type: "hook_decision"; event: string; tool: string | null; decision: string; reason: string | null }` *(CLI v2.16.0+)*
- `UnknownEvent { type: "unknown"; raw: Record<string, unknown> }` — forward-compatibility shim for future event types

### Exceptions

- `OhBinaryNotFoundError` — raised when `oh` cannot be located on PATH or via `OH_BINARY`.
- `OpenHarnessError` — raised when the subprocess exits non-zero. Has `.stderr` and `.exitCode` properties.

## Roadmap

The Python SDK shipped a v0.5 surface in five steps; this TypeScript SDK follows the same arc:

| Version | Adds |
|---|---|
| **0.1** *(this release)* | `query()`, typed events, error taxonomy |
| 0.2 | `OpenHarnessClient` stateful sessions (`oh session`) with multi-turn `send()` |
| 0.3 | Custom tools via in-process MCP server (`tools: [...]`) |
| 0.4 | `canUseTool` permission callback + turn-boundary events |
| 0.5 | `resume`, `settingSources`, `OpenHarnessOptions` typed bundle |

## Relationship to `@zhijiewang/openharness`

This package is a **thin subprocess wrapper** around the `oh` CLI shipped by the npm package `@zhijiewang/openharness`. It does not re-implement the agent loop. As a result:

- You always get the latest CLI features by upgrading the npm package.
- All providers (Anthropic, OpenAI, Ollama, OpenRouter, llama.cpp, LM Studio) work as-is.
- All tools and MCP servers configured in `.oh/config.yaml` apply.
- The SDK follows its own independent SemVer track (`0.x` series at launch).

For an **in-process** Node SDK that runs the agent loop without spawning the CLI, see the `Agent` / `createAgent` exports of [`@zhijiewang/openharness`](https://www.npmjs.com/package/@zhijiewang/openharness) itself — different product, same project.

## License

MIT. See [LICENSE](../../LICENSE).
