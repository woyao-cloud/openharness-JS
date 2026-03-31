---
name: debug
description: Systematic debugging approach
whenToUse: When encountering any bug, test failure, or unexpected behavior
allowedTools: [Read, Bash, Grep, Glob]
---

# Systematic Debugging

Follow this process:

1. **Reproduce** — Confirm the bug exists. Run the failing test or command.
2. **Read the error** — What does the error message actually say? Read the full stack trace.
3. **Locate** — Find the exact line where the error occurs. Read the surrounding code.
4. **Understand** — Why does this code produce the wrong result? Trace the data flow.
5. **Hypothesize** — Form a specific theory about the cause.
6. **Verify** — Test your theory with a minimal change or print statement.
7. **Fix** — Make the smallest change that fixes the bug.
8. **Confirm** — Run the test/command again to verify the fix works.

Rules:
- Don't guess. Read the error message carefully.
- Don't change multiple things at once.
- Don't skip the reproduce step.
