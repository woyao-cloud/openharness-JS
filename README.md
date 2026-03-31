# OpenHarness

```
        ___
       /   \
      (     )        ___  ___  ___ _  _ _  _   _ ___ _  _ ___ ___ ___
       `~w~`        / _ \| _ \| __| \| | || | /_\ | _ \ \| | __/ __/ __|
       (( ))       | (_) |  _/| _|| .` | __ |/ _ \|   / .` | _|\__ \__ \
        ))((        \___/|_|  |___|_|\_|_||_/_/ \_\_|_\_|\_|___|___/___/
       ((  ))
        `--`                Build your own Claude Code with any LLM.
```

<!-- Badges: PyPI version, Python versions, License, CI status -->
<!-- ![PyPI](https://img.shields.io/pypi/v/openharness) -->
<!-- ![Python](https://img.shields.io/pypi/pyversions/openharness) -->
<!-- ![License](https://img.shields.io/github/license/wangz/openharness) -->

**OpenHarness** is an open-source Python agent harness framework that lets you build your own Claude Code with any LLM provider -- local or cloud, free or paid, no vendor lock-in.

---

## Quick Start

```bash
# 1. Install
pip install openharness

# 2. Initialize your project (creates .oh/ directory with config)
oh init

# 3. Start chatting with any model
oh chat --model ollama/llama3
```

That's it. Point it at Ollama running locally for a fully offline coding agent, or use OpenAI/Anthropic/OpenRouter for cloud models.

---

## Why OpenHarness?

|                        | OpenHarness          | Claude Code         | LangChain            | CrewAI               |
|------------------------|----------------------|---------------------|----------------------|----------------------|
| Any LLM provider       | Yes (5+ providers)  | Anthropic only      | Yes                  | Yes                  |
| CLI coding agent       | Built-in (`oh chat`)| Built-in            | Build-your-own       | No                   |
| Tool permission gates  | Yes (risk-based)    | Yes                 | No                   | No                   |
| Local/offline models   | Ollama native       | No                  | Manual setup         | Manual setup         |
| Cost tracking          | Built-in            | Partial             | No                   | No                   |
| Session persistence    | Built-in            | Yes                 | Manual               | No                   |
| Rules, skills, hooks   | Yes                 | Yes                 | No                   | No                   |
| License                | MIT                 | Proprietary         | MIT                  | MIT                  |
| Language               | Python              | TypeScript          | Python               | Python               |

---

## Features

### LLM Providers
- **Ollama** -- Local models (Llama 3, DeepSeek Coder, Mistral, Phi, Qwen)
- **OpenAI** -- GPT-4o, GPT-4o-mini, o3, o3-mini
- **Anthropic** -- Claude Sonnet, Claude Opus, Claude Haiku
- **OpenRouter** -- 300+ models via a single API key
- **OpenAI-Compatible** -- Any provider with an OpenAI-compatible API (DeepSeek, Groq, Together, LM Studio, etc.)

### Tools (with Permission Gates)
| Tool       | Risk   | Description                                    |
|------------|--------|------------------------------------------------|
| FileRead   | low    | Read file contents with optional line ranges   |
| FileEdit   | medium | Search-and-replace edits in existing files     |
| FileWrite  | medium | Create or overwrite files                      |
| Bash       | high   | Execute shell commands                         |
| Glob       | low    | Find files by pattern                          |
| Grep       | low    | Search file contents with regex                |
| WebFetch   | medium | Fetch content from URLs                        |

Every tool has a risk level. In the default `ask` permission mode, medium and high risk tools require your approval before execution.

### Agent Engine
- **Agent loop** with LLM-to-tool orchestration, streaming, and error recovery
- **Smart router** for automatic model selection based on task complexity
- **Sub-agents** for isolated parallel task execution
- **MCP client** to connect to external MCP tool servers
- **Context manager** for smart context window management

### Harness Layer
- **Rules** -- Project-specific instructions via `.oh/rules/` and `.oh/RULES.md`
- **Skills** -- Reusable packaged workflows (commit, TDD, debug, review)
- **Hooks** -- Lifecycle automation (before/after tool calls)
- **Memory** -- Persistent knowledge across sessions
- **Cost tracking** -- Per-model token and cost tracking with budget enforcement
- **Session persistence** -- Save and resume any conversation

---

## Architecture

Four-layer design, each layer independently usable:

```
Layer 4: CLI Shell (oh)
    |-- oh chat, oh config, oh cost, oh models, oh sessions, oh tools, oh rules
    '-- Uses: rich terminal UI, streaming output, interactive prompts

Layer 3: Agent Engine (openharness.agent)
    |-- AgentLoop: LLM <-> Tool orchestration cycle
    |-- PermissionGate: risk-based tool approval
    |-- ContextManager: smart context window management
    |-- SubAgent: isolated parallel workers
    '-- Router: smart model selection

Layer 2: Providers + Tools (openharness.providers, openharness.tools)
    |-- Providers: Ollama, OpenAI, Anthropic, OpenRouter, OpenAI-compatible
    |-- Tools: FileRead, FileEdit, FileWrite, Bash, Glob, Grep, WebFetch
    '-- MCP: connect to external MCP servers

Layer 1: Core (openharness.core)
    |-- Types: Message, ToolSpec, ToolResult, ModelInfo
    |-- Config: AgentConfig, ProviderConfig
    |-- Session: conversation persistence + history
    '-- Events: streaming event types
```

---

## CLI Commands

| Command          | Description                                      |
|------------------|--------------------------------------------------|
| `oh chat`        | Start an interactive coding agent session        |
| `oh init`        | Initialize a project (creates `.oh/` directory)  |
| `oh config`      | View and modify configuration                    |
| `oh config set`  | Set a configuration value                        |
| `oh models`      | List available models across all providers       |
| `oh tools`       | List available tools and their risk levels       |
| `oh cost`        | Show token usage and cost summary                |
| `oh sessions`    | List and manage saved sessions                   |
| `oh rules`       | View and manage project rules                    |
| `oh skills`      | List and run packaged skills                     |
| `oh doctor`      | Check system health (providers, tools, config)   |

---

## Configuration

### Global config

```bash
# Set your default provider and model
oh config set provider openai
oh config set model gpt-4o

# Set API keys
oh config set openai.api_key sk-...
oh config set openrouter.api_key sk-or-...

# Set permission mode (ask, auto, trust, deny)
oh config set permission_mode ask

# Set a session budget ceiling
oh config set max_cost_per_session 1.00
```

### Project-level config

```bash
oh init    # Creates .oh/ in your project root
```

This creates:
```
.oh/
  config.yaml      # Project-specific settings
  rules/           # Rule files loaded into system prompt
  RULES.md         # Quick project rules (always loaded)
  memory/          # Persistent knowledge store
  sessions/        # Saved conversations
```

### Project rules

Write instructions in `.oh/RULES.md` that are loaded into every session:

```markdown
# Project Rules

- Use Python 3.12 features
- Always write tests before implementation
- Use absolute imports only
- Format with ruff, lint with ruff
```

---

## Built-in Skills

| Skill    | Description                                        |
|----------|----------------------------------------------------|
| `commit` | Stage, diff, and create a well-formatted git commit|
| `tdd`    | Test-driven development workflow                   |
| `debug`  | Systematic debugging with hypothesis testing       |
| `review` | Code review with structured feedback               |

```bash
# Run a skill directly
oh skills run commit
oh skills run tdd
```

---

## Contributing

Contributions are welcome. To get started:

```bash
git clone https://github.com/wangz/openharness.git
cd openharness
pip install -e ".[dev]"
pytest
```

Please open an issue before submitting large changes so we can discuss the approach.

---

## License

MIT -- see [LICENSE](LICENSE) for details.

---

## Inspired By

OpenHarness's architecture was studied from the patterns revealed in Claude Code's source (v2.1.88, March 2026). The goal is to provide the same agent harness capabilities as an open-source Python framework that works with any LLM, not just Anthropic's models.

This project is not affiliated with Anthropic.
