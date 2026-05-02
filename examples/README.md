# OpenHarness examples

Runnable examples that show common ways to drive `oh` from a script, a CI pipeline, or another program.

Each example is self-contained — read the file's header comment for prerequisites, then run it. Examples assume `oh` is installed (`npm install -g @zhijiewang/openharness`) and either Ollama is running locally OR an API key is exported for your provider of choice.

## What's here

| Example | Surface | What it shows |
|---|---|---|
| [headless-code-review.sh](headless-code-review.sh) | CLI | Headless `oh run --json` invocation suitable for CI; pipes the result through `jq` to extract assistant text |
| [sdk-python-batch-summarize.py](sdk-python-batch-summarize.py) | Python SDK | Iterate over multiple files and summarize each via `query()`; demonstrates streaming events and per-iteration sessions |
| [sdk-typescript-streaming-events.ts](sdk-typescript-streaming-events.ts) | TypeScript SDK | Stream tool-call events from a single `query()` call; shows the v2.27+ `parentCallId` field for nested tool-call rendering |
| [mcp-config-sample.yaml](mcp-config-sample.yaml) | Config | Annotated MCP server config covering stdio (filesystem + custom Python), HTTP (Linear, GitHub), and legacy SSE |

## Where to go from here

- **CLI reference:** [`docs/getting-started.md`](../docs/getting-started.md), [`docs/configuration.md`](../docs/configuration.md)
- **Hooks and event protocol:** [`docs/hooks.md`](../docs/hooks.md)
- **MCP server integration:** [`docs/mcp-servers.md`](../docs/mcp-servers.md)
- **Python SDK reference:** [`python/README.md`](../python/README.md)
- **TypeScript SDK reference:** [`packages/sdk/README.md`](../packages/sdk/README.md)
- **Architecture overview:** [`docs/architecture.md`](../docs/architecture.md)

## Contributing examples

Good example PRs:
- Demonstrate ONE clear surface (CLI, SDK, MCP, or hooks) — not a kitchen sink
- Are runnable as-is with the prerequisites in the header
- Have a header comment explaining what the example shows and the prerequisites
- Stay under ~80 lines of body code (excluding header comment)
- Don't duplicate content already in the README of the surface (CLI / SDK / docs/) — they should illustrate it via runnable code, not re-explain it

Open a PR with `examples:` prefix in the commit message.
