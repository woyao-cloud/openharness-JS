---
name: commit
description: Create well-formed git commits
whenToUse: When the user asks to commit changes or create a PR
allowedTools: [Bash, Read, Glob]
---

# Git Commit Workflow

1. Run `git status` and `git diff` to see what changed
2. Run `git log --oneline -5` to match the repo's commit message style
3. Stage specific files (not `git add -A`) to avoid committing secrets or binaries
4. Write a concise commit message:
   - First line: imperative mood, under 72 chars, describes the "why"
   - Body (if needed): explain context, not just what changed
5. Create the commit
6. Run `git status` to verify success
