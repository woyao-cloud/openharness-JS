# TypeScript CLI Plan

**Date:** 2026-04-01  
**Status:** Proposed

## Goal

Add a first-class Node.js/TypeScript CLI to OpenHarness without rewriting the Python core.

The intended end state is:
- Python remains the core harness runtime
- TypeScript becomes a primary CLI experience
- both fronts share one agent engine and one config/session model

## Why This Direction

TypeScript CLI support improves:
- npm-based distribution
- adoption by developer-tool users
- terminal UX flexibility
- future IDE/editor integrations in the JavaScript ecosystem

Keeping the Python core improves:
- reuse of the existing agent loop
- reuse of provider and tool implementations
- lower maintenance cost than a full dual-runtime rewrite

## Architecture

```text
packages/cli (TypeScript)
  command parsing
  streaming terminal UI
  prompts and interactive UX
  local config helpers
  transport client

transport boundary
  stdio JSON messages
  request/response commands
  event streaming from Python core

openharness Python core
  agent loop
  provider adapters
  tool registry
  permission logic
  sessions, rules, skills, memory, cost
```

## Phase Plan

### Phase 1: Define transport

Add a stable transport contract between the TypeScript CLI and Python:
- command request envelope
- event stream envelope
- error envelope
- session lifecycle commands

Recommended transport:
- `stdio` first

Why `stdio` first:
- matches CLI expectations
- no daemon lifecycle needed initially
- easy to debug
- easy to wrap from Node.js

### Phase 2: Python bridge mode

Add a Python entrypoint that runs as a machine-facing bridge, for example:

```text
python -m oh.bridge
```

Responsibilities:
- read JSON commands from stdin
- execute agent/config/session operations
- stream structured events to stdout
- preserve human-facing CLI behavior in the existing `oh` commands

### Phase 3: TypeScript CLI MVP

Build a Node CLI that supports:
- `oh chat`
- `oh config show`
- `oh config set`
- `oh sessions`
- `oh cost`
- `oh version`

MVP principle:
- match current functionality before expanding UX

### Phase 4: Shared UX improvements

After the MVP works:
- richer terminal rendering
- slash commands
- better resume flows
- improved permission prompts
- packaging and installer story

## Proposed Transport Shapes

### Request

```json
{
  "id": "req_123",
  "method": "chat.start",
  "params": {
    "model": "ollama/llama3",
    "permission_mode": "ask",
    "cwd": "/workspace/project"
  }
}
```

### Event

```json
{
  "id": "req_123",
  "event": "text_delta",
  "data": {
    "content": "I found the bug."
  }
}
```

### Error

```json
{
  "id": "req_123",
  "error": {
    "code": "provider_unavailable",
    "message": "Cannot connect to LLM provider."
  }
}
```

## Command Mapping

Initial TS CLI commands should map directly to current Python behavior:

| TS command | Python operation |
|---|---|
| `oh chat` | agent run loop |
| `oh config show` | config load/display |
| `oh config set` | config mutation |
| `oh sessions` | session listing |
| `oh cost` | cost summary |
| `oh version` | version query |

## Repo Layout

```text
packages/
  cli/
    package.json
    tsconfig.json
    src/
      index.ts
      protocol.ts
      transport/
        stdio.ts
```

## Non-Goals For Now

Do not do these in the first pass:
- full TypeScript rewrite of the core agent engine
- duplicate provider implementations in Node.js
- divergent feature sets between Python CLI and TypeScript CLI
- background daemon requirement for local usage

## Recommended Next Steps

1. Implement a tiny Python bridge with `version` and `config.show`
2. Wire the TypeScript CLI to call that bridge over `stdio`
3. Expand to `chat` event streaming
4. Decide later whether to deprecate the Python CLI or keep both
