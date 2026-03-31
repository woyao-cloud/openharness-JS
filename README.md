# OpenHarness

Open-source agent harness framework — build your own Claude Code with any LLM.

## Quick Start

```bash
pip install openharness
oh chat --model ollama/llama3
```

## Features

- **Any LLM**: Ollama, OpenAI, Anthropic, OpenRouter, DeepSeek, Qwen, and more
- **Tool System**: File read/edit/write, bash, glob, grep, web fetch — with permission gates
- **Agent Loop**: LLM ↔ Tool orchestration with streaming and error recovery
- **Cost Tracking**: Per-model token and cost tracking with budget enforcement
- **Session Persistence**: Save and resume conversations
- **Rules & Skills**: Project-specific instructions and reusable workflows
- **Memory**: Persistent knowledge across sessions
- **Hooks**: Lifecycle automation (before/after tool calls)

## License

MIT
