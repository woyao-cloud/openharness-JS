# OpenHarness — Design Specification

**Date:** 2026-03-31
**Status:** Draft
**Author:** wangz + Claude

---

## 1. Problem Statement

Developers want Claude Code's power — an AI agent that reads files, edits code, runs commands, and manages context — but with **any LLM** (local or cloud), **full transparency**, and **no vendor lock-in**.

The Claude Code source leak (March 31, 2026) revealed the architectural patterns that make it work: a layered agent harness with permission gates, tool orchestration, lifecycle hooks, and multi-agent coordination. No open-source project has replicated this architecture cleanly in Python.

**OpenHarness** is an open-source Python agent harness framework that lets anyone build their own Claude Code with any LLM provider.

---

## 2. Target Users

1. **Developers** who want a ready-to-use CLI coding agent (`oh chat`) powered by any LLM
2. **AI engineers** who want a Python library to build custom agents for any domain

---

## 3. Architecture Overview

Four-layer design, each layer independently usable:

```
Layer 4: CLI Shell (oh)
    ├── oh chat, oh config, oh cost, oh models, oh sessions, oh tools, oh rules
    └── Uses: rich terminal UI, streaming output, interactive prompts

Layer 3: Agent Engine (openharness.agent)
    ├── AgentLoop: LLM ↔ Tool orchestration cycle
    ├── PermissionGate: risk-based tool approval
    ├── ContextManager: smart context window management
    ├── SubAgent: isolated parallel workers
    └── Router: smart model selection

Layer 2: Providers + Tools (openharness.providers, openharness.tools)
    ├── Providers: Ollama, OpenAI, Anthropic, OpenRouter, OpenAI-compatible
    ├── Tools: FileRead, FileEdit, FileWrite, Bash, Glob, Grep, WebFetch
    └── MCP: connect to external MCP servers

Layer 1: Core (openharness.core)
    ├── Types: Message, ToolSpec, ToolResult, ModelInfo
    ├── Config: AgentConfig, ProviderConfig
    ├── Session: conversation persistence + history
    └── Events: streaming event types
```

Plus a cross-cutting **Harness** layer:
- **Rules**: project-specific instructions (`.oh/rules/`, `.oh/RULES.md`)
- **Skills**: reusable packaged workflows (TDD, debug, review)
- **Hooks**: lifecycle automation (before/after tool calls)
- **Memory**: persistent knowledge across sessions
- **Cost**: spending tracker with budget enforcement
- **Onboarding**: auto-detect project type and context

---

## 4. Layer 1: Core Types

### 4.1 Message Types

```python
@dataclass(frozen=True)
class Message:
    role: str                    # "user", "assistant", "system", "tool"
    content: str                 # Text content
    tool_calls: tuple = ()       # LLM requesting tool use
    tool_results: tuple = ()     # Results from tool execution
    timestamp: datetime = None

@dataclass(frozen=True)
class ToolCall:
    id: str                      # Unique call ID
    tool_name: str
    arguments: dict              # Parsed arguments

@dataclass(frozen=True)
class ToolResult:
    call_id: str                 # Matches ToolCall.id
    output: str
    is_error: bool = False
```

### 4.2 Tool Specification

```python
@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict             # JSON Schema for input validation
    risk_level: str              # "low", "medium", "high"
    requires_approval: bool      # Derived from risk_level + permission mode
```

### 4.3 Model Information

```python
@dataclass(frozen=True)
class ModelInfo:
    id: str                      # "gpt-4o", "claude-sonnet-4-6", "llama3"
    provider: str                # "openai", "anthropic", "ollama"
    context_window: int          # Max tokens
    supports_tools: bool         # Function calling support
    supports_streaming: bool
    supports_vision: bool
    input_cost_per_mtok: float   # Cost per million input tokens
    output_cost_per_mtok: float  # Cost per million output tokens
```

### 4.4 Configuration

```python
@dataclass
class ProviderConfig:
    name: str
    api_key: str | None
    base_url: str
    default_model: str

@dataclass
class AgentConfig:
    provider: str                 # Default provider name
    model: str                    # Default model
    tools: list[str]              # Enabled tool names
    rules_paths: list[Path]       # Rule file locations
    permission_mode: str          # "ask", "auto", "trust", "deny"
    max_cost_per_session: float   # Budget ceiling
    session_dir: Path             # Where to save sessions
    memory_dir: Path              # Where to save memories

    @classmethod
    def from_file(cls, path: Path) -> "AgentConfig": ...

    @classmethod
    def default(cls) -> "AgentConfig": ...
```

Config file location: `~/.oh/config.yaml`

### 4.5 Session

```python
@dataclass
class Session:
    id: str
    messages: list[Message]
    created_at: datetime
    updated_at: datetime
    provider: str
    model: str
    cost: float
    metadata: dict

    def save(self, session_dir: Path) -> None:
        """Persist session to JSON file."""

    @classmethod
    def load(cls, path: Path) -> "Session":
        """Resume a saved session."""

    @classmethod
    def list_all(cls, session_dir: Path) -> list["SessionSummary"]:
        """List all saved sessions with summary info."""
```

### 4.6 Streaming Events

```python
@dataclass(frozen=True)
class TextDelta:
    content: str

@dataclass(frozen=True)
class ToolCallStart:
    tool_name: str
    call_id: str

@dataclass(frozen=True)
class ToolCallResult:
    call_id: str
    output: str
    is_error: bool

@dataclass(frozen=True)
class CostUpdate:
    input_tokens: int
    output_tokens: int
    cost: float

Event = TextDelta | ToolCallStart | ToolCallResult | CostUpdate
```

---

## 5. Layer 2: Providers

### 5.1 Base Provider Interface

```python
class BaseProvider(ABC):
    config: ProviderConfig

    @abstractmethod
    async def complete(
        self,
        messages: list[Message],
        tools: list[ToolSpec] | None = None,
        model: str | None = None,
    ) -> Message:
        """Send messages and get a complete response."""

    @abstractmethod
    async def stream(
        self,
        messages: list[Message],
        tools: list[ToolSpec] | None = None,
        model: str | None = None,
    ) -> AsyncIterator[Event]:
        """Stream response events."""

    @abstractmethod
    def list_models(self) -> list[ModelInfo]:
        """List available models from this provider."""

    @abstractmethod
    async def health_check(self) -> bool:
        """Check if provider is reachable."""
```

### 5.2 Provider Implementations

| Provider | Class | Models | Notes |
|----------|-------|--------|-------|
| Ollama | `OllamaProvider` | llama3, deepseek-coder, mistral, phi, qwen | Auto-detect local instance at localhost:11434 |
| OpenAI | `OpenAIProvider` | gpt-4o, gpt-4o-mini, o3, o3-mini | Via `openai` SDK |
| Anthropic | `AnthropicProvider` | claude-sonnet, claude-opus, claude-haiku | Via `anthropic` SDK |
| OpenRouter | `OpenRouterProvider` | 300+ models | Single API key, universal fallback |
| OpenAI-Compatible | `OpenAICompatProvider` | Any | Base class for DeepSeek, Qwen, Groq, Mistral, Together, etc. |

### 5.3 Provider Registry

```python
class ProviderRegistry:
    """Discover and manage providers."""

    providers: dict[str, BaseProvider]

    def register(self, name: str, provider: BaseProvider): ...
    def get(self, name: str) -> BaseProvider: ...
    def list_all_models(self) -> list[ModelInfo]: ...
    def auto_detect_local(self) -> list[str]:
        """Check if Ollama/LM Studio is running locally."""
```

### 5.4 Model Pricing Data

Stored in `data/models.json`:
```json
{
  "gpt-4o": {"input": 2.50, "output": 10.00, "context": 128000},
  "claude-sonnet-4-6": {"input": 3.00, "output": 15.00, "context": 200000},
  "llama3:8b": {"input": 0, "output": 0, "context": 8192}
}
```

---

## 6. Layer 2: Tools

### 6.1 Base Tool Interface

```python
class BaseTool(ABC):
    name: str
    description: str
    parameters_schema: dict      # JSON Schema
    risk_level: str              # "low", "medium", "high"

    @abstractmethod
    async def execute(self, arguments: dict, context: ToolContext) -> ToolResult:
        """Execute the tool with validated arguments."""

    def to_spec(self) -> ToolSpec:
        """Convert to ToolSpec for sending to LLM."""
```

### 6.2 Built-in Tools

| Tool | Risk | Description |
|------|------|-------------|
| `FileReadTool` | low | Read file contents, supports line ranges |
| `FileEditTool` | medium | Search-and-replace edits in files |
| `FileWriteTool` | medium | Create or overwrite files |
| `BashTool` | high | Execute shell commands with timeout |
| `GlobTool` | low | Find files by pattern |
| `GrepTool` | low | Search file contents with regex |
| `WebFetchTool` | medium | Fetch URL content |

### 6.3 Tool Context

```python
@dataclass
class ToolContext:
    working_dir: Path            # Current working directory
    session: Session             # Current session
    config: AgentConfig          # Agent configuration
    cost_tracker: CostTracker    # For tools that make API calls
```

### 6.4 Tool Registry

```python
class ToolRegistry:
    tools: dict[str, BaseTool]

    def register(self, tool: BaseTool): ...
    def get(self, name: str) -> BaseTool: ...
    def list_all(self) -> list[ToolSpec]: ...
    def from_mcp(self, server) -> list[BaseTool]:
        """Import tools from an MCP server."""
```

---

## 7. Layer 2: MCP Integration

### 7.1 MCP Client

```python
class MCPClient:
    """Connect to Model Context Protocol servers."""

    async def connect(self, config: MCPServerConfig) -> None:
        """Connect to an MCP server (stdio or HTTP)."""

    async def list_tools(self) -> list[ToolSpec]:
        """Get available tools from connected server."""

    async def call_tool(self, name: str, arguments: dict) -> ToolResult:
        """Execute a tool on the MCP server."""

    async def list_resources(self) -> list[Resource]:
        """Get available resources (files, data) from server."""

    async def read_resource(self, uri: str) -> str:
        """Read a resource from the server."""
```

### 7.2 MCP Server (expose OpenHarness as MCP)

```python
class MCPServer:
    """Expose OpenHarness agent as an MCP server."""

    # Other tools/agents can connect to OpenHarness via MCP
    # Enables integration with VS Code, other editors, etc.
```

---

## 8. Layer 3: Agent Engine

### 8.1 Agent Loop (the core)

```python
class AgentLoop:
    provider: BaseProvider
    tools: ToolRegistry
    permission_gate: PermissionGate
    context_manager: ContextManager
    cost_tracker: CostTracker
    session: Session
    rules: list[str]
    hooks: HookSystem

    async def run(self, user_message: str) -> AsyncIterator[Event]:
        """
        Main agent loop:

        1. Add user message to session
        2. Build context (system prompt + rules + history + tools)
        3. Send to LLM provider
        4. Process response:
           a. If text: yield TextDelta events, add to session
           b. If tool_calls:
              - For each tool call:
                - Check permission gate
                - Run before_tool_call hooks
                - Execute tool
                - Run after_tool_call hooks
                - Add result to session
              - Go to step 3 (send tool results back to LLM)
        5. Record cost
        6. Auto-save session
        """

    async def spawn_sub_agent(self, task: str, tools: list[str] | None = None) -> str:
        """Spawn an isolated sub-agent for a delegated task."""
```

### 8.2 Permission Gate

```python
class PermissionGate:
    mode: str  # "ask", "auto", "trust", "deny"

    # Risk matrix (from Claude Code leak):
    # LOW risk tools (read-only): always allowed
    # MEDIUM risk tools (file writes): ask in "ask" mode, allow in "auto"/"trust"
    # HIGH risk tools (bash, network): always ask unless "trust" mode

    async def check(self, tool: BaseTool, arguments: dict) -> PermissionResult:
        """Check if tool execution is permitted."""

    def escalate(self, reason: str) -> None:
        """Flag action for manual review."""

@dataclass(frozen=True)
class PermissionResult:
    allowed: bool
    reason: str              # "auto-approved", "user-approved", "denied", "escalated"
    risk_level: str
```

### 8.3 Context Manager

```python
class ContextManager:
    max_tokens: int

    def build_messages(
        self,
        session: Session,
        rules: list[str],
        tools: list[ToolSpec],
        memories: list[Memory],
    ) -> list[Message]:
        """
        Build the message list for the LLM, fitting within context window.

        Priority order:
        1. System prompt (always)
        2. Rules and memories (always)
        3. Tool definitions (always)
        4. Recent messages (most recent first)
        5. Older messages (compressed/summarized if needed)
        """

    def estimate_tokens(self, messages: list[Message]) -> int:
        """Estimate token count for a message list."""

    def compress_history(self, messages: list[Message]) -> list[Message]:
        """Summarize old messages to save context space."""
```

### 8.4 Sub-Agent

```python
class SubAgent:
    """Isolated agent for parallel task delegation."""

    parent_session: Session
    task: str
    agent_loop: AgentLoop  # Own loop with own context

    async def run(self) -> SubAgentResult:
        """Execute task in isolation, return results to parent."""

    # Isolation guarantees:
    # - Own session (doesn't pollute parent history)
    # - Own cost tracking (rolled up to parent)
    # - Shared tool registry (same permissions)
    # - Can be run concurrently with other sub-agents
```

### 8.5 Smart Router

```python
class ModelRouter:
    """Route requests to the best model based on strategy."""

    providers: ProviderRegistry

    async def route(
        self,
        prompt: str,
        strategy: str,  # "cheapest", "best", "local-first", "balanced"
    ) -> tuple[BaseProvider, str]:
        """Select provider + model based on strategy."""

    # Strategies:
    # "cheapest"    — pick lowest cost model that supports required tools
    # "best"        — pick highest capability model
    # "local-first" — try Ollama first, fall back to cloud
    # "balanced"    — cost-quality tradeoff
```

---

## 9. Harness Features

### 9.1 Rules System

```python
class RulesLoader:
    """Load project and global rules into agent context."""

    # Discovery order:
    # 1. ~/.oh/global-rules/*.md     (user-wide)
    # 2. .oh/RULES.md                (project main rules)
    # 3. .oh/rules/*.md              (project rule files)

    def load(self, project_path: Path) -> list[str]:
        """Load and merge all applicable rules."""

    def create_rules_file(self, project_path: Path) -> None:
        """Initialize .oh/RULES.md for a project."""
```

### 9.2 Skills System

```python
@dataclass(frozen=True)
class Skill:
    name: str                   # "tdd", "code-review", "debug"
    description: str
    system_prompt: str          # Instructions injected into LLM context
    required_tools: list[str]   # Tools this skill needs

class SkillRegistry:
    def load_builtin(self) -> list[Skill]: ...
    def load_user_skills(self, path: Path) -> list[Skill]: ...
    def get(self, name: str) -> Skill | None: ...
    def activate(self, name: str, agent: AgentLoop) -> None:
        """Activate a skill for the current session."""

    # Built-in skills:
    # tdd          — test-driven development workflow
    # code-review  — systematic code review
    # debug        — systematic debugging
    # refactor     — safe refactoring with tests
    # explain      — explain code clearly
    # commit       — create well-formed git commits
```

### 9.3 Hook System

```python
class HookSystem:
    """Lifecycle hooks for automation."""

    hooks: dict[str, list[HookConfig]]

    # Hook events:
    # on_session_start    — agent session begins
    # on_session_end      — agent session ends
    # before_tool_call    — before any tool executes
    # after_tool_call     — after tool completes
    # on_file_edit        — when a file is modified
    # on_file_create      — when a file is created
    # on_error            — when an error occurs
    # on_cost_threshold   — when cost exceeds threshold

    async def trigger(self, event: str, context: dict) -> list[HookResult]:
        """Run all hooks registered for this event."""

@dataclass(frozen=True)
class HookConfig:
    event: str
    command: str       # Shell command to execute
    blocking: bool     # Wait for completion before continuing
```

Config in `.oh/hooks.yaml`:
```yaml
hooks:
  on_file_edit:
    - command: "prettier --write {file}"
      blocking: true
  on_session_start:
    - command: "echo 'OpenHarness session started'"
```

### 9.4 Memory System

```python
class MemorySystem:
    """Persistent knowledge across sessions."""

    memory_dir: Path  # ~/.oh/memory/

    def save(self, memory: Memory) -> None:
        """Save a memory to disk."""

    def search(self, query: str) -> list[Memory]:
        """Search memories by keyword."""

    def load_relevant(self, context: str) -> list[Memory]:
        """Load memories relevant to current context."""

    def forget(self, memory_id: str) -> None:
        """Remove a memory."""

@dataclass
class Memory:
    id: str
    type: str          # "user", "project", "feedback", "reference"
    title: str
    content: str
    created_at: datetime
```

### 9.5 Project Onboarding

```python
class ProjectDetector:
    """Auto-detect project type and configure agent."""

    def detect(self, path: Path) -> ProjectContext:
        """
        Detect:
        - Language: Python, JavaScript, TypeScript, Rust, Go, etc.
        - Framework: React, Django, FastAPI, Express, etc.
        - Package manager: pip, npm, cargo, go mod
        - Test runner: pytest, jest, cargo test
        - Git state: branch, clean/dirty, remote
        - README contents for project context
        """

    def generate_system_context(self, project: ProjectContext) -> str:
        """Generate system prompt additions from project detection."""
```

### 9.6 Cost Tracker

```python
@dataclass
class CostEvent:
    timestamp: datetime
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cost: float
    label: str           # "chat", "sub-agent", "tool-retry"

class CostTracker:
    events: list[CostEvent]
    budget: float | None

    def record(self, event: CostEvent) -> None: ...
    def total(self) -> float: ...
    def by_provider(self) -> dict[str, float]: ...
    def by_model(self) -> dict[str, float]: ...
    def by_day(self) -> dict[str, float]: ...
    def check_budget(self) -> BudgetStatus: ...
        # BudgetStatus: "ok", "warning" (>80%), "exceeded"

    def save(self, path: Path) -> None:
        """Persist to ~/.oh/costs/YYYY-MM-DD.json"""

    def dashboard(self) -> str:
        """Render rich terminal cost dashboard."""
```

---

## 10. Layer 4: CLI

### 10.1 Commands

| Command | Description |
|---------|-------------|
| `oh chat` | Interactive chat with agent (main command) |
| `oh chat --model X` | Chat with specific model |
| `oh chat --resume` | Resume last session |
| `oh chat --skill tdd` | Activate skill for session |
| `oh config` | Interactive configuration wizard |
| `oh config set KEY VALUE` | Set config value |
| `oh config show` | Show current config |
| `oh models` | List all available models |
| `oh models --provider X` | List models from provider |
| `oh cost` | Show cost dashboard |
| `oh cost --today` | Today's spending |
| `oh cost --budget N` | Set daily budget |
| `oh sessions` | List saved sessions |
| `oh sessions --resume ID` | Resume specific session |
| `oh tools` | List available tools |
| `oh tools --add mcp://X` | Add MCP tool server |
| `oh rules` | Show loaded rules |
| `oh rules --init` | Create .oh/RULES.md |
| `oh skills` | List available skills |
| `oh memory` | View/search memories |

### 10.2 Terminal UI

Built with `rich` library:
- Markdown rendering for LLM responses
- Syntax-highlighted code blocks
- Progress spinners during tool execution
- Tables for cost dashboard and model listing
- Permission prompts with color-coded risk levels
- Streaming text output

### 10.3 Configuration Files

```
~/.oh/
├── config.yaml              # Global config (providers, defaults)
├── global-rules/            # User-wide rules
├── memory/                  # Persistent memories
├── sessions/                # Saved conversations
├── costs/                   # Daily cost logs
└── skills/                  # User-defined skills

.oh/                         # Project-local (in any repo)
├── RULES.md                 # Project rules
├── rules/                   # Additional rule files
├── hooks.yaml               # Lifecycle hooks
└── skills/                  # Project-specific skills
```

---

## 11. Project Structure

```
openharness/
├── pyproject.toml                 # Package config, dependencies, CLI entry point
├── README.md
├── LICENSE                        # MIT
├── oh/                            # CLI package
│   ├── __init__.py
│   ├── __main__.py                # python -m oh
│   └── cli/
│       ├── main.py                # Typer app, command registration
│       ├── chat.py                # oh chat command
│       ├── config.py              # oh config command
│       ├── cost.py                # oh cost command
│       ├── models.py              # oh models command
│       ├── sessions.py            # oh sessions command
│       ├── tools_cmd.py           # oh tools command
│       ├── rules.py               # oh rules command
│       ├── skills.py              # oh skills command
│       ├── memory.py              # oh memory command
│       └── ui.py                  # Shared rich rendering utilities
├── openharness/                   # Library package
│   ├── __init__.py                # Public API exports
│   ├── core/
│   │   ├── __init__.py
│   │   ├── types.py               # Message, ToolCall, ToolResult, ToolSpec
│   │   ├── config.py              # AgentConfig, ProviderConfig
│   │   ├── session.py             # Session, SessionSummary
│   │   ├── events.py              # TextDelta, ToolCallStart, CostUpdate
│   │   └── exceptions.py          # Custom exception hierarchy
│   ├── providers/
│   │   ├── __init__.py
│   │   ├── base.py                # BaseProvider ABC
│   │   ├── registry.py            # ProviderRegistry
│   │   ├── ollama.py              # OllamaProvider
│   │   ├── openai.py              # OpenAIProvider
│   │   ├── anthropic.py           # AnthropicProvider
│   │   ├── openrouter.py          # OpenRouterProvider
│   │   └── openai_compat.py       # OpenAICompatProvider (DeepSeek, Qwen, Groq, etc.)
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── base.py                # BaseTool ABC
│   │   ├── registry.py            # ToolRegistry
│   │   ├── file_read.py           # FileReadTool (risk: low)
│   │   ├── file_edit.py           # FileEditTool (risk: medium)
│   │   ├── file_write.py          # FileWriteTool (risk: medium)
│   │   ├── bash.py                # BashTool (risk: high)
│   │   ├── glob_tool.py           # GlobTool (risk: low)
│   │   ├── grep.py                # GrepTool (risk: low)
│   │   └── web_fetch.py           # WebFetchTool (risk: medium)
│   ├── agent/
│   │   ├── __init__.py
│   │   ├── loop.py                # AgentLoop — the core orchestrator
│   │   ├── permissions.py         # PermissionGate
│   │   ├── context.py             # ContextManager
│   │   ├── sub_agent.py           # SubAgent spawning
│   │   └── router.py              # ModelRouter (smart model selection)
│   ├── harness/
│   │   ├── __init__.py
│   │   ├── rules.py               # RulesLoader
│   │   ├── skills.py              # SkillRegistry, Skill
│   │   ├── hooks.py               # HookSystem, HookConfig
│   │   ├── memory.py              # MemorySystem, Memory
│   │   ├── onboarding.py          # ProjectDetector
│   │   └── cost.py                # CostTracker, CostEvent
│   └── mcp/
│       ├── __init__.py
│       ├── client.py              # MCPClient
│       ├── server.py              # MCPServer (expose as MCP)
│       └── types.py               # MCP protocol types
├── data/
│   ├── models.json                # Model capabilities + pricing registry
│   ├── prompts/
│   │   └── system.md              # Default system prompt template
│   └── skills/
│       ├── tdd.yaml               # Test-driven development
│       ├── code-review.yaml       # Code review
│       ├── debug.yaml             # Systematic debugging
│       ├── refactor.yaml          # Safe refactoring
│       ├── explain.yaml           # Code explanation
│       └── commit.yaml            # Git commit workflow
└── tests/
    ├── conftest.py                # Shared fixtures
    ├── test_core/
    │   ├── test_types.py
    │   ├── test_config.py
    │   └── test_session.py
    ├── test_providers/
    │   ├── test_ollama.py
    │   ├── test_openai.py
    │   └── test_registry.py
    ├── test_tools/
    │   ├── test_file_read.py
    │   ├── test_bash.py
    │   └── test_registry.py
    ├── test_agent/
    │   ├── test_loop.py
    │   ├── test_permissions.py
    │   └── test_context.py
    └── test_harness/
        ├── test_rules.py
        ├── test_skills.py
        ├── test_hooks.py
        └── test_cost.py
```

---

## 12. Dependencies

```toml
[project]
name = "openharness"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.27",         # Async HTTP client (for providers)
    "rich>=13.0",          # Terminal UI (tables, markdown, progress)
    "typer>=0.12",         # CLI framework
    "pyyaml>=6.0",         # Config file parsing
    "pydantic>=2.0",       # Input validation for tool arguments
]

[project.optional-dependencies]
openai = ["openai>=1.0"]
anthropic = ["anthropic>=0.40"]
mcp = ["mcp>=1.0"]
all = ["openharness[openai,anthropic,mcp]"]

[project.scripts]
oh = "oh.cli.main:app"
```

---

## 13. Implementation Phases

### Phase 1: Foundation
- Core types (types.py, config.py, events.py, session.py)
- Base provider interface + Ollama provider (free, local, easy to test)
- Base tool interface + FileReadTool + BashTool
- Minimal agent loop (single LLM → Tool cycle)
- Basic CLI: `oh chat --model ollama/llama3`

### Phase 2: Full Tool Set + More Providers
- All 7 built-in tools
- OpenAI + Anthropic + OpenRouter providers
- OpenAI-compatible base (DeepSeek, Qwen, Groq)
- Permission gate with risk levels
- Cost tracking
- Session save/resume

### Phase 3: Harness Features
- Rules system (.oh/RULES.md)
- Skills system (built-in + user-defined)
- Hook system (lifecycle automation)
- Memory system (persistent knowledge)
- Project onboarding (auto-detect)
- Context management (smart window handling)

### Phase 4: Advanced + Polish
- Sub-agent spawning
- MCP client integration
- Smart model router
- MCP server (expose OpenHarness)
- Rich terminal UI polish
- PyPI packaging + distribution
- Documentation + examples

---

## 14. Verification Plan

### Unit Tests
- Each tool: mock filesystem, verify read/edit/write behavior
- Each provider: mock HTTP responses, verify message formatting
- Permission gate: test all modes with all risk levels
- Context manager: test token counting and compression
- Cost tracker: test recording, budgets, persistence

### Integration Tests
- Full agent loop with Ollama (local, free)
- Session save → resume → verify history intact
- Rules loading from .oh/ directory
- Hook execution at lifecycle events
- MCP client connecting to a test server

### End-to-End Tests
- `oh chat` sends prompt, gets response, streams to terminal
- `oh chat` with tool use: reads file, makes edit, confirms
- `oh config set` persists to config file
- `oh cost` shows accurate dashboard after multiple sessions
- `oh sessions --resume` continues conversation

### Manual Testing
- Test with real providers: Ollama, OpenAI, Anthropic
- Test permission prompts in terminal
- Test streaming output rendering
- Test with large codebases (context management)

---

## 15. What Makes This Different

| Feature | Claude Code | LangChain | CrewAI | **OpenHarness** |
|---------|-------------|-----------|--------|-----------------|
| Open source | No | Yes | Yes | **Yes** |
| Any LLM | No (Claude only) | Yes | Yes | **Yes** |
| CLI agent | Yes | No | No | **Yes** |
| Python library | No | Yes | Yes | **Yes** |
| Permission gates | Yes | No | No | **Yes** |
| Rules system | Yes (CLAUDE.md) | No | No | **Yes (.oh/RULES.md)** |
| Hooks | Yes | No | No | **Yes** |
| Skills | Yes | No | No | **Yes** |
| Cost tracking | Internal | No | No | **Yes (user-facing)** |
| Memory | Yes | Via chains | No | **Yes** |
| MCP support | Yes | Via tools | No | **Yes** |
| Local-first | No | No | No | **Yes (Ollama)** |
| Lightweight | No (512K LOC) | No (heavy) | Medium | **Yes (<5K LOC)** |
