---
layout: default
title: Remote API
---

# Remote API

Run openHarness as an HTTP server for external integrations.

## Start the Server

```bash
oh remote --port 3141
oh remote --port 3141 --model gpt-4o
```

## Endpoints

### POST /dispatch

Send a prompt and receive streaming Server-Sent Events:

```bash
curl -X POST http://localhost:3141/dispatch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-token" \
  -d '{"prompt": "fix the failing tests", "maxTurns": 10}'
```

Response: SSE stream of events (`text_delta`, `tool_call_start`, `tool_call_end`, `cost_update`).

### POST /a2a

A2A protocol endpoint for inter-agent communication:

```bash
# Discover agent capabilities
curl -X POST http://localhost:3141/a2a \
  -H "Content-Type: application/json" \
  -d '{"id":"msg-1","from":"agent-2","to":"agent-1","type":"discover","payload":{"kind":"discover"},"timestamp":1234}'

# Delegate a task
curl -X POST http://localhost:3141/a2a \
  -H "Content-Type: application/json" \
  -d '{"id":"msg-2","from":"agent-2","to":"agent-1","type":"task","payload":{"kind":"task","capability":"code-review","input":"Review src/main.ts"},"timestamp":1234}'
```

### GET /status

Health check:

```bash
curl http://localhost:3141/status
# {"status":"ok","provider":"openai","model":"gpt-4o","channels":0,"agentId":"oh-abc123"}
```

### WS /channel

Bidirectional WebSocket for persistent sessions:

```javascript
const ws = new WebSocket('ws://localhost:3141/channel');
ws.send(JSON.stringify({ type: 'dispatch', prompt: 'explain this code' }));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

## Authentication

Configure bearer tokens in `.oh/config.yaml`:

```yaml
remote:
  tokens: ["sk-my-secret-token", "sk-another-token"]
  rateLimit: 60              # requests/minute per IP
  allowedTools: ["Read", "Glob", "Grep"]  # optional tool whitelist
```

If no tokens are configured, the server is open access (no auth required).

## A2A Protocol

When the remote server starts, it publishes an **Agent Card** to `~/.oh/agents/` for discovery by other agents.

Use `/agents` in any openHarness session to see running agents:

```
/agents

Running Agents (2):
  openharness-abc123
    Provider: openai / gpt-4o
    Dir:      /home/user/project-a
    Endpoint: http:3141
    Caps:     code-generation, code-review, test-generation
```
