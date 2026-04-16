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
