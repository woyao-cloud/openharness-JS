---
layout: default
title: Tool Pipelines
---

# Tool Pipelines

Pipelines execute multiple tools in sequence without LLM involvement — faster, cheaper, and deterministic.

## Basic Usage

The LLM can invoke pipelines via the Pipeline tool:

```json
{
  "steps": [
    { "id": "find", "tool": "Glob", "args": { "pattern": "src/**/*.ts" } },
    { "id": "search", "tool": "Grep", "args": { "pattern": "TODO", "path": "$find" }, "dependsOn": ["find"] }
  ]
}
```

## Variable Substitution

Use `$stepId` in args to reference the output of a completed step:

```json
{
  "steps": [
    { "id": "files", "tool": "Glob", "args": { "pattern": "**/*.test.ts" } },
    { "id": "count", "tool": "Bash", "args": { "command": "echo '$files' | wc -l" }, "dependsOn": ["files"] }
  ]
}
```

## Dependencies

Steps execute in dependency order. Use `dependsOn` to declare which steps must complete first:

```json
{
  "steps": [
    { "id": "a", "tool": "ToolA", "args": {} },
    { "id": "b", "tool": "ToolB", "args": {} },
    { "id": "c", "tool": "ToolC", "args": {}, "dependsOn": ["a", "b"] }
  ]
}
```

Steps `a` and `b` run first (in sequence). Step `c` runs after both complete.

## Error Handling

If a step fails, all dependent steps are **skipped** (not executed). This prevents cascading failures.

```
✓ Step "find" (12ms)
  src/main.ts, src/query.ts, ...
✗ Step "lint" (150ms)
  error TS2345: Argument of type...
✗ Step "deploy" (0ms)
  Skipped: dependency failed

Pipeline: 1/3 steps passed (162ms total)
```

## Examples

### Find all TODO comments

```json
{
  "steps": [
    { "id": "files", "tool": "Glob", "args": { "pattern": "src/**/*.ts" } },
    { "id": "todos", "tool": "Grep", "args": { "pattern": "TODO|FIXME|HACK", "path": "$files" }, "dependsOn": ["files"] }
  ],
  "description": "Find all TODO/FIXME/HACK comments in TypeScript files"
}
```

### Lint and test

```json
{
  "steps": [
    { "id": "typecheck", "tool": "Bash", "args": { "command": "npx tsc --noEmit" } },
    { "id": "test", "tool": "Bash", "args": { "command": "npm test" }, "dependsOn": ["typecheck"] }
  ]
}
```

### Gather project metrics

```json
{
  "steps": [
    { "id": "ts", "tool": "Glob", "args": { "pattern": "src/**/*.ts" } },
    { "id": "lines", "tool": "Bash", "args": { "command": "find src -name '*.ts' | xargs wc -l | tail -1" } },
    { "id": "tests", "tool": "Bash", "args": { "command": "grep -r 'it(' src --include='*.test.ts' | wc -l" } }
  ]
}
```
