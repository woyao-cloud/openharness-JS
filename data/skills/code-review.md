---
name: code-review
description: Systematic code review for bugs, security, and quality
whenToUse: When reviewing code changes, PRs, or completed implementations
allowedTools: [Read, Glob, Grep, Bash]
---

# Code Review

Review the code systematically for:

1. **Correctness** — Does the code do what it claims? Logic errors?
2. **Security** — SQL injection, XSS, command injection, path traversal, secrets in code?
3. **Error handling** — Are errors caught and handled appropriately?
4. **Edge cases** — Null/empty inputs, boundary conditions, concurrent access?
5. **Performance** — Unnecessary loops, missing indexes, N+1 queries?
6. **Readability** — Clear naming, reasonable complexity, adequate (not excessive) comments?

Report findings with file path, line number, severity (critical/warning/info), and suggested fix.
