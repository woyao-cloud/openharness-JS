# Self-Evolving Agent — Design Spec

**Date:** 2026-04-13
**Status:** Draft
**Inspired by:** Hermes Agent (NousResearch, 33k stars)

## Context

openHarness has memory, skills, and an evaluator loop — but they're passive. Users must manually author skills and memories. Hermes Agent proved that **agents that learn from use** drive massive adoption (0→33k stars in 2 months). The core idea: after every session, the agent extracts reusable skills from what worked, searches past sessions for relevant context, and builds a deepening model of the user.

This spec adds 4 features that wire the existing building blocks into an automatic feedback loop.

## Features

### Feature 1: Self-Evolving Skills

**Goal:** Automatically create reusable skill files from successful task completions.

**Trigger:** `sessionEnd` hook fires → if session had 5+ tool calls, run extraction.

**Flow:**
1. `sessionEnd` hook fires with enriched context (session ID, tool count, cost)
2. `SkillExtractor` loads full message history from session store
3. LLM analyzes messages and extracts skill candidates:
   - Each candidate: `{name, description, trigger, procedure, pitfalls, verification}`
   - Only non-obvious, reusable patterns (not one-off tasks)
4. For each candidate:
   - Fuzzy match against existing skills (name + description similarity)
   - If match found: generate a `patch` (targeted edit, not full rewrite)
   - If new: validate via `EvaluatorLoop` with skill-quality rubric
5. Write to `.oh/skills/auto/<slug>.md` with standard frontmatter + `source: auto`
6. Log extraction results for observability

**Skill Quality Rubric (for EvaluatorLoop):**
- Reusability (0.4) — would this help in future sessions?
- Completeness (0.3) — does it cover the full workflow?
- Clarity (0.2) — can the agent follow these instructions?
- Safety (0.1) — any dangerous patterns?
- Pass threshold: 0.7

**Frontmatter additions:**
```yaml
---
name: deploy-to-vercel
description: Deploy Next.js app to Vercel with environment variables
trigger: deploy vercel
source: auto           # NEW — distinguishes from manual skills
extractedFrom: abc123  # NEW — session ID that generated this skill
extractedAt: 1712345678
version: 1             # NEW — incremented on each patch
---
```

**Files to create/modify:**
- `src/services/SkillExtractor.ts` (NEW) — extraction logic, LLM prompts, patch generation
- `src/harness/plugins.ts` (MODIFY) — add `findSimilarSkill()` for fuzzy matching
- `src/harness/hooks.ts` (MODIFY) — enrich sessionEnd context with session metadata
- `src/repl.ts` (MODIFY) — pass session data to sessionEnd hook

### Feature 2: Session Search (SQLite + FTS5)

**Goal:** Let the agent search past sessions for relevant context when tackling similar tasks.

**Storage:** `~/.oh/sessions.db` — SQLite with FTS5 full-text search index. Source of truth remains the JSON files in `~/.oh/sessions/`.

**Schema:**
```sql
CREATE VIRTUAL TABLE sessions_fts USING fts5(
  session_id,
  content,          -- all user + assistant message text concatenated
  tools_used,       -- comma-separated tool names
  model,
  cost UNINDEXED,
  message_count UNINDEXED,
  created_at UNINDEXED,
  updated_at UNINDEXED
);
```

**Indexing:** On every `saveSession()` call, upsert session content into FTS5. Content is concatenation of all message text (user + assistant roles only, tools excluded to reduce noise).

**Search tool:**
```typescript
SessionSearchTool {
  input: { query: string, limit?: number }  // default limit: 5
  output: LLM-summarized excerpts from matching sessions
}
```

**Result processing:**
1. FTS5 query with BM25 ranking
2. Load top N matching sessions from JSON
3. Extract relevant message excerpts (messages containing query terms)
4. LLM-summarize excerpts into concise context (reuse `summarizeConversation()` pattern)
5. Return summarized results (not raw message dumps)

**Index rebuild:** `/rebuild-sessions` slash command — drops and rebuilds FTS5 index from all JSON session files. Useful after migration or corruption.

**Dependency:** `better-sqlite3` — synchronous SQLite binding for Node.js.

**Files to create/modify:**
- `src/harness/session-db.ts` (NEW) — SQLite connection, FTS5 schema, index/search functions
- `src/tools/SessionSearchTool/index.ts` (NEW) — deferred tool for agent to search sessions
- `src/harness/session.ts` (MODIFY) — call indexSession() after saveSession()
- `src/commands/index.ts` (MODIFY) — add /rebuild-sessions command
- `src/tools.ts` (MODIFY) — register SessionSearchTool as deferred tool

### Feature 3: Progressive Skill Disclosure

**Goal:** Reduce system prompt token usage from O(n * skill_size) to O(n * 30 tokens) as skill library grows.

**3-level loading:**

| Level | What's loaded | When | Tokens per skill |
|-------|--------------|------|-----------------|
| 0 | name + description + trigger | Always in system prompt | ~30 |
| 1 | Full markdown content | On `Skill(name)` invocation | ~200-500 |
| 2 | Supporting files (scripts, refs) | On `Skill(name, path)` invocation | Variable |

**Implementation:**
- Modify `skillsToPrompt()` to emit Level 0 only: one-liner per skill
- `SkillTool.call()` already returns full content (Level 1) — no change
- Add optional `path` parameter to SkillTool for Level 2 file access
- Supporting files live in `.oh/skills/<name>/` directories (same as Hermes layout)

**Token savings projection:**
- 100 skills × ~500 tokens each = 50,000 tokens (current)
- 100 skills × ~30 tokens each = 3,000 tokens (after)
- **94% reduction** in skill prompt overhead

**Files to modify:**
- `src/harness/plugins.ts` (MODIFY) — change `skillsToPrompt()` to Level 0 format
- `src/tools/SkillTool/index.ts` (MODIFY) — add `path` parameter for Level 2

### Feature 4: User Modeling (USER.md)

**Goal:** Maintain a persistent user profile that deepens across sessions, injected into system prompt for personalized responses.

**Storage:** `.oh/memory/USER.md` — single file, max 2000 characters. Always loaded into system prompt.

**Format:**
```markdown
---
name: User Profile
type: user_profile
updatedAt: 1712345678
---

## Role
Senior full-stack engineer, 8 years experience

## Preferences
- Prefers TypeScript strict mode
- Terse responses, no trailing summaries
- Uses Ollama with llama3 for exploration, Claude for code review

## Common Workflows
- PR review → /review → commit
- Bug fix → debug → test → commit
```

**Auto-maintenance:**
- `detectMemories()` already extracts patterns from sessions
- Add new type `"user_profile"` that routes updates to USER.md
- On session end, LLM merges new observations into USER.md
- LLM rewrites to stay within 2000-char limit (curate, don't just append)
- Manual edits preserved — LLM merges, doesn't overwrite

**System prompt injection:**
- `userProfileToPrompt()` — loads USER.md content
- Injected before general memories (higher priority)
- Distinct section: `# User Profile` (separate from `# Remembered Context`)

**Files to create/modify:**
- `src/harness/memory.ts` (MODIFY) — add `loadUserProfile()`, `updateUserProfile()`, `mergeUserProfile()`
- `src/harness/memory.ts` (MODIFY) — route `user_profile` type in `detectMemories()`

## Architecture Overview

```
Session ends (5+ tool calls)
    ├── SkillExtractor analyzes messages
    │   ├── New skill? → EvaluatorLoop validates → write .oh/skills/auto/
    │   └── Existing skill? → generate patch → update in place
    ├── Session indexed into SQLite FTS5
    ├── User profile updated (merge new observations into USER.md)
    └── Memory consolidation runs (existing)

Next session starts
    ├── System prompt loads:
    │   ├── USER.md (user profile, 2000 chars max)
    │   ├── MEMORY.md (general memories, existing)
    │   └── Skills Level 0 (names + descriptions only, ~30 tokens each)
    ├── Agent encounters similar task
    │   ├── SessionSearchTool queries FTS5 → LLM-summarized results
    │   └── SkillTool loads matching skill (Level 1 → Level 2 as needed)
    └── Agent completes task (potentially better than last time)
```

## New Dependencies

| Package | Purpose | Size | Justification |
|---------|---------|------|---------------|
| `better-sqlite3` | SQLite + FTS5 for session search | ~2MB | Industry standard, no native compilation issues, synchronous API matches our patterns |

## Testing Strategy

- **SkillExtractor:** Unit tests with mock provider (fake LLM responses with skill candidates)
- **Session DB:** Unit tests for indexing, searching, rebuilding (in-memory SQLite for tests)
- **Progressive disclosure:** Test `skillsToPrompt()` outputs Level 0 format, verify token reduction
- **User profile:** Test `updateUserProfile()` merges correctly, respects char limit
- **Integration:** E2E test: create session with 5+ tool calls → verify skill extracted → verify session indexed → verify user profile updated

## Verification

1. Start a session, perform 5+ tool operations, exit
2. Check `.oh/skills/auto/` — new skill file should exist with proper frontmatter
3. Start a new session, ask about something from the previous session
4. Agent should use `SessionSearchTool` to find relevant past context
5. Check `.oh/memory/USER.md` — should contain extracted user observations
6. Run `/rebuild-sessions` — should rebuild index without errors
7. `npm test` — all existing 749 tests still pass + new tests pass
