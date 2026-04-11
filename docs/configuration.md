---
layout: default
title: Configuration
---

# Configuration

OpenHarness uses a 3-layer config hierarchy:

1. **Global**: `~/.oh/config.yaml` — defaults for all projects
2. **Project**: `.oh/config.yaml` — project-specific settings
3. **Local**: `.oh/config.local.yaml` — personal overrides (gitignored)

Later layers override earlier ones.

## Full Config Reference

```yaml
# Provider and model
provider: ollama          # ollama, openai, anthropic, openrouter, llamacpp, lmstudio
model: llama3             # model identifier
apiKey: sk-...            # API key (or use environment variable)
baseUrl: http://localhost:11434  # custom base URL

# Behavior
permissionMode: ask       # ask, trust, deny, acceptEdits, plan, auto, bypassPermissions
theme: dark               # dark or light

# Verification loops — auto-lint after file edits
verification:
  enabled: true           # default: true (auto-detect)
  mode: warn              # warn (append to output) or block (mark as error)
  rules:
    - extensions: [".ts", ".tsx"]
      lint: "npx tsc --noEmit 2>&1 | head -20"
      timeout: 15000
    - extensions: [".py"]
      lint: "ruff check {file} 2>&1 | head -10"

# Multi-model router — use different models per task type
modelRouter:
  fast: ollama/qwen2.5:7b        # exploration, search
  balanced: gpt-4o-mini           # general use
  powerful: claude-sonnet-4-6     # code review, final output

# Memory
memory:
  consolidateOnExit: true  # prune stale memories on exit

# Hooks — shell scripts at session events
hooks:
  - event: sessionStart
    command: "echo 'Started' >> ~/.oh/log"
  - event: preToolUse
    command: "scripts/check.sh"
    match: Bash
  - event: postToolUse
    command: "scripts/after.sh"
  - event: sessionEnd
    command: "scripts/cleanup.sh"

# Tool permissions
toolPermissions:
  - tool: "Bash"
    action: ask
    pattern: "^rm .*"
  - tool: "Read"
    action: allow

# MCP servers
mcpServers:
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ghp_...

# Remote server security
remote:
  tokens: ["sk-my-secret-token"]
  rateLimit: 60            # requests/minute per IP
  allowedTools: ["Read", "Glob", "Grep"]  # tool whitelist

# Telemetry (opt-in, default off)
telemetry:
  enabled: false

# Status bar
statusLineFormat: "{model} {tokens} {cost}"
```
