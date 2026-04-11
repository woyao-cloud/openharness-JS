---
layout: default
title: MCP Servers
---

# MCP Servers

Connect any [Model Context Protocol](https://modelcontextprotocol.io) server to extend openHarness with new tools.

## Configuration

Add to `.oh/config.yaml`:

```yaml
mcpServers:
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ghp_...
```

MCP tools appear alongside built-in tools. `/status` shows connected servers.

## Registry

Browse the curated catalog of 15 MCP servers:

```
/mcp-registry              # browse all
/mcp-registry github       # show install config
/mcp-registry database     # search by category
```

### Categories

| Category | Servers |
|----------|---------|
| Filesystem | filesystem |
| Git | github, gitlab |
| Database | sqlite, postgres |
| Search | brave-search, fetch |
| Productivity | slack, google-drive, linear |
| Dev Tools | docker, puppeteer, context7 |
| AI | memory, sequential-thinking |

## Deferred Loading

Servers with 10+ tools use **deferred loading** — tools show a minimal description until first invocation. Use ToolSearch to discover and activate them.

## Custom MCP Server

Any MCP-compatible server works. Specify the command to start it:

```yaml
mcpServers:
  - name: my-custom-server
    command: node
    args: ["./my-server.js"]
    riskLevel: medium   # low, medium, or high
    timeout: 10000      # connection timeout (ms)
```
