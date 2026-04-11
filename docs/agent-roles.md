---
layout: default
title: Agent Roles
---

# Agent Roles

Dispatch specialized sub-agents with restricted tool access for focused tasks.

## Available Roles

| Role | Description | Tools |
|------|-------------|-------|
| `code-reviewer` | Find bugs, security issues, style problems | Read-only |
| `test-writer` | Generate unit and integration tests | Read + Write |
| `docs-writer` | Write documentation and comments | Read + Write + Edit |
| `debugger` | Systematic bug investigation | Read-only + Bash |
| `refactorer` | Simplify code without changing behavior | All file tools + Bash |
| `security-auditor` | OWASP, injection, secrets, CVE scanning | Read-only + Bash |
| `evaluator` | Evaluate code quality and run tests | Read-only + Bash + Diagnostics |
| `planner` | Design step-by-step implementation plans | Read-only + Bash |
| `architect` | Analyze architecture and design structural changes | Read-only |
| `migrator` | Systematic codebase migrations and upgrades | All file tools + Bash |

## Usage

The LLM dispatches agents via the Agent tool:

```
Agent({ subagent_type: 'code-reviewer', prompt: 'Review src/query.ts for bugs' })
Agent({ subagent_type: 'evaluator', prompt: 'Run all tests and report results' })
Agent({ subagent_type: 'planner', prompt: 'Plan the auth system implementation' })
```

## Tool Filtering

Each role restricts its sub-agent to only relevant tools via `suggestedTools`. You can also filter explicitly:

```
Agent({ allowed_tools: ['Read', 'Grep'], prompt: 'Search for all TODO comments' })
```

The `AskUser` tool is always available regardless of filtering.

## Generator/Evaluator Pattern

For high-quality output, split work between a generator and evaluator:

1. **Generator** (refactorer/migrator): makes changes
2. **Evaluator**: reviews changes read-only, runs tests

```
Agent({ subagent_type: 'refactorer', prompt: 'Extract the auth logic into a module' })
Agent({ subagent_type: 'evaluator', prompt: 'Review the refactoring and run tests' })
```

The evaluator cannot modify files — it can only assess and report.
