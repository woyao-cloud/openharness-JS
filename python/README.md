# openharness — Python SDK for openHarness

Drive the `oh` terminal coding agent from Python. Stream tokens and tool calls, control permissions and models, all with a small async API.

## Prerequisite

Install the `oh` CLI first (via npm):

```bash
npm install -g @zhijiewang/openharness
```

The Python SDK finds `oh` on PATH. To point at a specific binary, set `OH_BINARY=/absolute/path/to/oh`.

## Install

```bash
pip install openharness
```

Requires Python ≥3.10. Small dependency surface: the `mcp` SDK and `uvicorn` (pulled in to host Python-defined tools as MCP servers). Both are optional to *use* — `query()` without `tools=` never touches them at runtime — but they're installed eagerly for simplicity.

## Quick start

```python
import asyncio
from openharness import query, TextDelta, ToolStart, ToolEnd

async def main() -> None:
    async for event in query(
        "Summarize the README.md in this directory.",
        model="ollama/llama3",
        permission_mode="trust",
        max_turns=5,
    ):
        if isinstance(event, TextDelta):
            print(event.content, end="", flush=True)
        elif isinstance(event, ToolStart):
            print(f"\n[tool: {event.tool}]", flush=True)
        elif isinstance(event, ToolEnd):
            print(f"[{event.tool} → {'error' if event.error else 'ok'}]", flush=True)

asyncio.run(main())
```

## Multi-turn sessions

For conversations that span multiple prompts (notebooks, chatbots, agents), use `OpenHarnessClient`:

```python
import asyncio
from openharness import OpenHarnessClient, TextDelta

async def main() -> None:
    async with OpenHarnessClient(model="ollama/llama3", permission_mode="trust") as client:
        async for event in await client.send("What is 1+1?"):
            if isinstance(event, TextDelta):
                print(event.content, end="")
        print()
        async for event in await client.send("And times 3?"):  # remembers the prior turn
            if isinstance(event, TextDelta):
                print(event.content, end="")

asyncio.run(main())
```

The client keeps a single `oh session` subprocess warm across calls, preserving conversation state in-process. Concurrent `send()` calls on one client are serialized via an `asyncio.Lock`. Call `close()` (or exit the async context) to terminate the subprocess.

## Custom Python tools

Expose your own Python functions to the agent. Decorate with `@tool`, then pass the callables via `tools=[...]` on either `query()` or `OpenHarnessClient`:

```python
import asyncio
from openharness import OpenHarnessClient, ToolEnd, tool


@tool
async def get_weather(city: str) -> str:
    """Fetch the current weather for a city."""
    return f"Sunny in {city}, 22°C"


async def main() -> None:
    async with OpenHarnessClient(
        model="ollama/llama3",
        tools=[get_weather],
    ) as client:
        async for event in await client.send("What's the weather in Paris?"):
            if isinstance(event, ToolEnd):
                print(event.tool, event.output)


asyncio.run(main())
```

Under the hood the SDK spins up an in-process MCP HTTP server on a random `127.0.0.1` port, writes an ephemeral `.oh/config.yaml` pointing at it, and runs `oh` with that temp dir as its cwd. Any existing user config at the caller-supplied `cwd=` is preserved.

Use `@tool(name="custom-name", description="…")` to override the auto-inferred metadata. Sync and async functions both work.

## API

### `query(prompt, **options) -> AsyncIterator[Event]`

Run a single prompt and stream events as they arrive. Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `model` | `str \| None` | from config | Model string (e.g. `"ollama/llama3"`, `"claude-sonnet-4-6"`). |
| `permission_mode` | `str` | `"trust"` | One of `"ask"`, `"trust"`, `"deny"`, `"acceptEdits"`, `"plan"`, `"auto"`, `"bypassPermissions"`. |
| `allowed_tools` | `Sequence[str] \| None` | `None` | Whitelist of tool names. |
| `disallowed_tools` | `Sequence[str] \| None` | `None` | Blacklist of tool names. |
| `max_turns` | `int` | `20` | Maximum number of model turns. |
| `system_prompt` | `str \| None` | `None` | Override the default system prompt. |
| `cwd` | `str \| None` | current dir | Working directory for the spawned CLI. |
| `env` | `dict[str, str] \| None` | `None` | Env vars merged on top of `os.environ`. |
| `tools` | `Sequence[Callable] \| None` | `None` | Python callables (optionally `@tool`-decorated) to expose to the agent via an in-process MCP server. |

### Event types

All events are frozen dataclasses. Use `isinstance` to discriminate.

- `TextDelta(content: str)` — streaming text from the assistant
- `ToolStart(tool: str)` — the assistant is about to call a tool
- `ToolEnd(tool: str, output: str, error: bool)` — tool invocation finished
- `ErrorEvent(message: str)` — recoverable error during the turn
- `CostUpdate(input_tokens: int, output_tokens: int, cost: float, model: str)` — cost + usage
- `TurnComplete(reason: str)` — one model turn ended; `reason` is `"completed"`, `"max_turns"`, `"error"`, etc.
- `UnknownEvent(raw: dict)` — forward-compatibility shim for future event types

### Exceptions

- `OhBinaryNotFoundError` — raised when `oh` can't be located on PATH or via `OH_BINARY`.
- `OpenHarnessError` — raised when the subprocess exits non-zero. Has `.stderr` and `.exit_code` attributes.

## Cancellation

Standard `asyncio` cancellation works. The spawned subprocess is sent `SIGTERM` (`SIGBREAK` on Windows) and given up to 5 seconds to exit cleanly before being `kill()`ed.

```python
task = asyncio.create_task(collect_events())
await asyncio.sleep(1)
task.cancel()
```

## Relationship to `@zhijiewang/openharness`

This Python package is a **thin subprocess wrapper** around the `oh` CLI shipped by the npm package `@zhijiewang/openharness`. It does not re-implement the agent loop. This means:

- You always get the latest CLI features by upgrading the npm package.
- All providers (Anthropic, OpenAI, Ollama, OpenRouter, llama.cpp, LM Studio) work as-is.
- All tools and MCP servers configured in `.oh/config.yaml` apply.
- The Python SDK follows its own independent SemVer track (`0.x` series at launch).

## License

MIT. See [LICENSE](../LICENSE).
