---
name: tdd
description: Test-driven development workflow
whenToUse: When implementing any feature or bugfix, before writing implementation code
allowedTools: [Read, Edit, Write, Bash, Glob, Grep]
---

# Test-Driven Development

Follow this workflow strictly:

1. **Write the test first** — Create a failing test that describes the expected behavior
2. **Run the test** — Verify it fails for the right reason
3. **Write minimal implementation** — Only enough code to make the test pass
4. **Run tests again** — Verify all tests pass
5. **Refactor** — Clean up the code while keeping tests green

Rules:
- Never write implementation before the test
- Each test should test one thing
- Keep tests fast and isolated
- Use descriptive test names that explain the behavior
