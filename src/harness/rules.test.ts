import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRulesFile, loadRules } from "./rules.js";

test("loadRules() returns empty array when no .oh dir exists", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  const rules = loadRules(tmp);
  assert.deepEqual(rules, []);
});

test("createRulesFile() creates .oh/RULES.md", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  const path = createRulesFile(tmp);
  assert.ok(existsSync(path));
  assert.ok(path.endsWith("RULES.md"));
});

test("loadRules() finds created file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  createRulesFile(tmp);
  const rules = loadRules(tmp);
  assert.equal(rules.length, 1);
  assert.ok(rules[0]!.includes("Project Rules"));
});

// ── CLAUDE.md support ──

test("loadRules() picks up CLAUDE.md in project root", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  writeFileSync(join(tmp, "CLAUDE.md"), "Always use TypeScript");
  const rules = loadRules(tmp);
  assert.ok(rules.some((r) => r.includes("Always use TypeScript")));
});

test("loadRules() picks up CLAUDE.local.md", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  writeFileSync(join(tmp, "CLAUDE.local.md"), "My personal overrides");
  const rules = loadRules(tmp);
  assert.ok(rules.some((r) => r.includes("My personal overrides")));
});

test("loadRules() loads both CLAUDE.md and .oh/RULES.md", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  writeFileSync(join(tmp, "CLAUDE.md"), "Claude rule");
  createRulesFile(tmp);
  const rules = loadRules(tmp);
  assert.ok(rules.some((r) => r.includes("Claude rule")));
  assert.ok(rules.some((r) => r.includes("Project Rules")));
});

test("loadRules() loads .oh/rules/*.md files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  const rulesDir = join(tmp, ".oh", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "extra.md"), "Extra rule content");
  const rules = loadRules(tmp);
  assert.ok(rules.some((r) => r.includes("Extra rule content")));
});

// ── AGENTS.md support (cross-tool standard, agents.md) ──

test("loadRules() picks up AGENTS.md in project root", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  writeFileSync(join(tmp, "AGENTS.md"), "Cross-tool guidance for any agent.");
  const rules = loadRules(tmp);
  assert.ok(rules.some((r) => r.includes("Cross-tool guidance")));
});

test("loadRules() loads CLAUDE.md and AGENTS.md side-by-side, CLAUDE.md first", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  writeFileSync(join(tmp, "CLAUDE.md"), "Anthropic-specific rule");
  writeFileSync(join(tmp, "AGENTS.md"), "Cross-tool rule");
  const rules = loadRules(tmp);
  const claudeIdx = rules.findIndex((r) => r.includes("Anthropic-specific"));
  const agentsIdx = rules.findIndex((r) => r.includes("Cross-tool"));
  assert.ok(claudeIdx >= 0, "CLAUDE.md should be loaded");
  assert.ok(agentsIdx >= 0, "AGENTS.md should be loaded");
  assert.ok(claudeIdx < agentsIdx, "CLAUDE.md should appear before AGENTS.md within the same dir");
});

test("loadRules() works with AGENTS.md alone (no CLAUDE.md)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "oh-test-"));
  writeFileSync(join(tmp, "AGENTS.md"), "AGENTS-only repo guidance.");
  const rules = loadRules(tmp);
  assert.equal(rules.length, 1);
  assert.ok(rules[0]!.includes("AGENTS-only"));
});
