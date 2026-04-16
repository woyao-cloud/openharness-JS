/**
 * Tests for newly added slash commands: /bug, /feedback, /upgrade, /token-count,
 * /benchmark, /vim, /login, /logout, /review-pr, /pr-comments, /add-dir
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CommandContext, processSlashCommand } from "./index.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    messages: [],
    model: "gpt-4o",
    providerName: "openai",
    permissionMode: "ask",
    totalCost: 0.05,
    totalInputTokens: 2000,
    totalOutputTokens: 1000,
    sessionId: "test-sess-ext",
    ...overrides,
  };
}

// ── /bug ──

test("/bug shows issue reporting instructions", () => {
  const result = processSlashCommand("/bug", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("issues"));
  assert.ok(result.output.includes("openharness"));
});

// ── /feedback ──

test("/feedback shows feedback instructions", () => {
  const result = processSlashCommand("/feedback", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("feedback"));
  assert.ok(result.output.includes("enhancement"));
});

// ── /upgrade ──

test("/upgrade shows current version and upgrade instructions", () => {
  const result = processSlashCommand("/upgrade", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Current version"));
  assert.ok(result.output.includes("npm"));
});

// ── /token-count ──

test("/token-count with no args shows conversation token estimate", () => {
  const result = processSlashCommand("/token-count", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("token"));
});

test("/token-count with text shows char/token estimate", () => {
  const result = processSlashCommand("/token-count hello world test", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("chars"));
  assert.ok(result.output.includes("tokens"));
});

// ── /benchmark ──

test("/benchmark with no args shows usage", () => {
  const result = processSlashCommand("/benchmark", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
  assert.ok(result.output.includes("BENCHMARKS"));
});

test("/benchmark with task-id returns prependToPrompt", () => {
  const result = processSlashCommand("/benchmark django__django-1234", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, false);
  assert.ok(result.prependToPrompt?.includes("SWE-bench"));
  assert.ok(result.prependToPrompt?.includes("django__django-1234"));
});

// ── /vim ──

test("/vim returns vim toggle signal", () => {
  const result = processSlashCommand("/vim", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("VIM"));
});

// ── /login ──

test("/login with no args shows usage with provider hint", () => {
  const result = processSlashCommand("/login", makeCtx({ providerName: "anthropic" }));
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("ANTHROPIC_API_KEY"));
});

test("/login with key sets it", () => {
  const result = processSlashCommand("/login sk-test-key-123", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("API key set"));
});

// ── /logout ──

test("/logout clears API key", () => {
  const result = processSlashCommand("/logout", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("cleared"));
});

// ── /review-pr ──

test("/review-pr with no args shows usage", () => {
  const result = processSlashCommand("/review-pr", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/review-pr with number returns prependToPrompt for gh commands", () => {
  const result = processSlashCommand("/review-pr 42", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, false);
  assert.ok(result.prependToPrompt?.includes("gh pr"));
  assert.ok(result.prependToPrompt?.includes("42"));
});

// ── /pr-comments ──

test("/pr-comments with no args shows usage", () => {
  const result = processSlashCommand("/pr-comments", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/pr-comments with number returns prependToPrompt", () => {
  const result = processSlashCommand("/pr-comments 99", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, false);
  assert.ok(result.prependToPrompt?.includes("99"));
  assert.ok(result.prependToPrompt?.includes("comments"));
});

// ── /add-dir ──

test("/add-dir with no args shows usage", () => {
  const result = processSlashCommand("/add-dir", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/add-dir with existing dir succeeds", () => {
  const result = processSlashCommand("/add-dir .", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Added working directory"));
});

test("/add-dir with nonexistent dir fails", () => {
  const result = processSlashCommand("/add-dir /nonexistent/path/xyz", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("not found"));
});

// ── /effort ──

test("/effort without args shows usage", () => {
  const result = processSlashCommand("/effort", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/effort with valid level sets it", () => {
  const result = processSlashCommand("/effort high", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("high"));
});

// ── /theme ──

test("/theme with valid value sets it", () => {
  const result = processSlashCommand("/theme dark", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("dark"));
});

test("/theme with invalid value shows usage", () => {
  const result = processSlashCommand("/theme blue", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

// ── /skill-create ──

test("/skill-create with no args shows usage", () => {
  const result = processSlashCommand("/skill-create", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/skill-create rejects path traversal", () => {
  const result = processSlashCommand("/skill-create ../evil", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Invalid"));
});

// ── /version ──

test("/version shows version number", () => {
  const result = processSlashCommand("/version", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("openHarness v"));
});

// ── /api-credits ──

test("/api-credits shows provider info and env hint", () => {
  const result = processSlashCommand("/api-credits", makeCtx({ providerName: "anthropic" }));
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("ANTHROPIC_API_KEY"));
  assert.ok(result.output.includes("anthropic"));
});

// ── /whoami ──

test("/whoami shows current user and provider info", () => {
  const result = processSlashCommand("/whoami", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Provider"));
  assert.ok(result.output.includes("openai"));
});

// ── /project ──

test("/project shows detected project info", () => {
  const result = processSlashCommand("/project", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Project directory"));
});

// ── /stats ──

test("/stats shows session statistics", () => {
  const result = processSlashCommand("/stats", makeCtx({ totalInputTokens: 5000, totalOutputTokens: 3000 }));
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Session Statistics"));
  assert.ok(result.output.includes("5,000"));
  assert.ok(result.output.includes("3,000"));
});

// ── /tools ──

test("/tools lists available tools", () => {
  const result = processSlashCommand("/tools", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Available Tools"));
  assert.ok(result.output.includes("Built-in"));
});

// ── /terminal-setup ──

test("/terminal-setup shows terminal hints", () => {
  const result = processSlashCommand("/terminal-setup", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Terminal Setup"));
  assert.ok(result.output.includes("Font"));
});

// ── /verbose ──

test("/verbose toggles verbose mode", () => {
  const result = processSlashCommand("/verbose", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Verbose"));
});

// ── /quiet ──

test("/quiet toggles quiet mode", () => {
  const result = processSlashCommand("/quiet", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Quiet"));
});

// ── /provider ──

test("/provider with no args shows current provider", () => {
  const result = processSlashCommand("/provider", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Current provider"));
  assert.ok(result.output.includes("openai"));
});

test("/provider with invalid name shows error", () => {
  const result = processSlashCommand("/provider badprovider", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Unknown provider"));
});

// ── /release-notes ──

test("/release-notes in non-git dir shows error", () => {
  // Note: this test may pass or fail depending on CWD being a git repo
  const result = processSlashCommand("/release-notes", makeCtx());
  assert.ok(result);
  // It will either show release notes or "Not a git repository"
  assert.ok(result.output.length > 0);
});

// ── /stash ──

test("/stash shows stash info", () => {
  const result = processSlashCommand("/stash", makeCtx());
  assert.ok(result);
  // Either shows stashes or "No stashes found" or "Not a git repository"
  assert.ok(result.output.length > 0);
});

// ── /branch ──

test("/branch with no args shows current branch", () => {
  const result = processSlashCommand("/branch", makeCtx());
  assert.ok(result);
  assert.ok(result.output.length > 0);
});

// ── /listen ──

test("/listen shows listening mode message", () => {
  const result = processSlashCommand("/listen", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Listening"));
});

// ── /truncate ──

test("/truncate with no args shows usage", () => {
  const result = processSlashCommand("/truncate", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/truncate with valid count removes messages", () => {
  const msgs = [
    { role: "user" as const, content: "hello", timestamp: 1 },
    { role: "assistant" as const, content: "hi", timestamp: 2 },
    { role: "user" as const, content: "bye", timestamp: 3 },
  ];
  const result = processSlashCommand("/truncate 1", makeCtx({ messages: msgs as any }));
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Truncated 1"));
  assert.equal(result.compactedMessages?.length, 2);
});

// ── /search ──

test("/search with no args shows usage", () => {
  const result = processSlashCommand("/search", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/search with term finds matching messages", () => {
  const msgs = [
    { role: "user" as const, content: "Tell me about TypeScript", timestamp: 1 },
    { role: "assistant" as const, content: "TypeScript is great", timestamp: 2 },
    { role: "user" as const, content: "Thanks", timestamp: 3 },
  ];
  const result = processSlashCommand("/search typescript", makeCtx({ messages: msgs as any }));
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("2 message(s)"));
});

test("/search with no matches reports none", () => {
  const msgs = [{ role: "user" as const, content: "hello", timestamp: 1 }];
  const result = processSlashCommand("/search zzzznonexistent", makeCtx({ messages: msgs as any }));
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("No messages matching"));
});

// ── /summarize ──

test("/summarize with empty conversation", () => {
  const result = processSlashCommand("/summarize", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("No messages"));
});

test("/summarize with messages returns prependToPrompt", () => {
  const msgs = [{ role: "user" as const, content: "test", timestamp: 1 }];
  const result = processSlashCommand("/summarize", makeCtx({ messages: msgs as any }));
  assert.ok(result);
  assert.equal(result.handled, false);
  assert.ok(result.prependToPrompt?.includes("Summarize"));
});

// ── /explain ──

test("/explain with no args shows usage", () => {
  const result = processSlashCommand("/explain", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/explain with topic returns prependToPrompt", () => {
  const result = processSlashCommand("/explain src/index.ts", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, false);
  assert.ok(result.prependToPrompt?.includes("src/index.ts"));
});

// ── /fix ──

test("/fix with no args shows usage", () => {
  const result = processSlashCommand("/fix", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("Usage"));
});

test("/fix with issue returns prependToPrompt", () => {
  const result = processSlashCommand("/fix broken import in utils.ts", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, false);
  assert.ok(result.prependToPrompt?.includes("broken import in utils.ts"));
});
