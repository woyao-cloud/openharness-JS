---
layout: default
title: Getting Started
---

# Getting Started

## Installation

```bash
# From npm (recommended)
npm install -g @zhijiewang/openharness

# From source
git clone https://github.com/zhijiewong/openharness.git
cd openharness
npm install && npm run build
npm link
```

Requires Node.js 18+.

## First Run

```bash
oh init     # Interactive setup wizard
```

The wizard will:
1. Auto-detect your provider from environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY)
2. Test the connection and list available models
3. Let you choose a permission mode
4. Optionally suggest MCP servers to install
5. Write `.oh/config.yaml`

Then start coding:

```bash
oh                              # Interactive REPL
oh -p "fix the failing tests"   # Single prompt (headless)
oh run "add error handling"     # Alternative headless syntax
```

## Project Setup

Create `.oh/RULES.md` in any repo to set project-specific instructions:

```markdown
- Always run tests after changes
- Use strict TypeScript
- Follow the existing code style
```

Rules are loaded into every session automatically.

## Key Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/status` | Model, mode, git branch, MCP servers |
| `/doctor` | Run health checks |
| `/diff` | Show uncommitted changes |
| `/undo` | Revert last AI commit |
| `/rewind` | Restore files from checkpoint |
| `/roles` | List agent roles |
| `/agents` | Discover running agents |
| `/exit` | Save session and quit |

## Permission Modes

| Mode | Behavior |
|------|----------|
| `ask` | Prompt before each tool call (recommended) |
| `trust` | Auto-approve everything |
| `deny` | Read-only, block write/run tools |
| `acceptEdits` | Auto-approve file edits, ask for bash |
| `plan` | Read-only exploration, then switch to ask |
| `auto` | Like trust but with safety checks |

Set in config: `permissionMode: 'ask'`

## Global Defaults

Set default provider/model for all projects:

```yaml
# ~/.oh/config.yaml
provider: ollama
model: llama3
permissionMode: ask
theme: dark
```

Per-project configs in `.oh/config.yaml` override global defaults.
