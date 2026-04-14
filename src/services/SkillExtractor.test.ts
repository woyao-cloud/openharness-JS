import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findSimilarSkill } from "../harness/plugins.js";
import { createMockProvider, makeTmpDir } from "../test-helpers.js";
import { createAssistantMessage, createUserMessage } from "../types/message.js";
import { extractSkills, persistSkill, shouldExtract } from "./SkillExtractor.js";

// ── shouldExtract ──

describe("shouldExtract", () => {
  it("returns false for fewer than 5 tool calls", () => {
    const messages = [
      { ...createUserMessage("hello"), toolCalls: [{ id: "1", toolName: "bash", arguments: {} }] },
      { ...createAssistantMessage("ok"), toolCalls: [{ id: "2", toolName: "read", arguments: {} }] },
    ];
    // 2 tool calls total
    assert.equal(shouldExtract(messages), false);
  });

  it("returns true for 5 or more tool calls", () => {
    const toolCall = (id: string) => ({ id, toolName: "bash", arguments: {} });
    const messages = [
      { ...createUserMessage("do stuff"), toolCalls: [toolCall("1"), toolCall("2"), toolCall("3")] },
      { ...createAssistantMessage("done"), toolCalls: [toolCall("4"), toolCall("5")] },
    ];
    // 5 tool calls total
    assert.equal(shouldExtract(messages), true);
  });
});

// ── findSimilarSkill ──

describe("findSimilarSkill", () => {
  it("matches by name word overlap", () => {
    const skills = [
      { name: "run-tests", description: "Execute the test suite" },
      { name: "deploy-app", description: "Deploy the application to production" },
    ];
    const result = findSimilarSkill("run-unit-tests", "Run some tests", skills);
    assert.ok(result !== null);
    assert.equal(result.name, "run-tests");
  });

  it("returns null when no skill matches", () => {
    const skills = [
      { name: "deploy-app", description: "Deploy the application to production" },
      { name: "build-image", description: "Build a Docker image" },
    ];
    const result = findSimilarSkill("send-email", "Send an email notification", skills);
    assert.equal(result, null);
  });
});

// ── extractSkills ──

describe("extractSkills", () => {
  it("parses LLM JSON response into SkillCandidates", async () => {
    const candidate = {
      name: "run-tests",
      description: "Run the test suite",
      trigger: "run tests",
      procedure: "Execute npm test",
      pitfalls: "Make sure dependencies are installed",
      verification: "All tests pass",
    };
    const jsonString = JSON.stringify([candidate]);

    const provider = createMockProvider(
      [], // no stream turns needed
      [jsonString], // complete() returns this
    );

    const messages = [createUserMessage("please run the tests for me")];
    const result = await extractSkills(provider, messages);

    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "run-tests");
    assert.equal(result[0]!.description, "Run the test suite");
    assert.equal(result[0]!.trigger, "run tests");
  });
});

// ── persistSkill ──

describe("persistSkill", () => {
  it("writes markdown file with correct frontmatter", () => {
    const tmp = makeTmpDir();
    const originalCwd = process.cwd();
    try {
      process.chdir(tmp);

      const candidate = {
        name: "run-tests",
        description: "Run the test suite",
        trigger: "run tests",
        procedure: "Execute npm test",
        pitfalls: "Ensure deps installed",
        verification: "All tests green",
      };

      const filePath = persistSkill(candidate, "session-123");

      assert.ok(existsSync(filePath));
      const content = readFileSync(filePath, "utf-8");
      assert.ok(content.includes("name: run-tests"));
      assert.ok(content.includes("source: auto"));
      assert.ok(content.includes("extractedFrom: session-123"));
      assert.ok(content.includes("version: 1"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("increments version on overwrite", () => {
    const tmp = makeTmpDir();
    const originalCwd = process.cwd();
    try {
      process.chdir(tmp);

      // Pre-create the auto dir with an existing skill file
      mkdirSync(join(tmp, ".oh", "skills", "auto"), { recursive: true });

      const candidate = {
        name: "deploy-app",
        description: "Deploy the application",
        trigger: "deploy",
        procedure: "Run deploy script",
        pitfalls: "Check env vars",
        verification: "App is live",
      };

      // First write
      persistSkill(candidate, "session-001");
      // Second write — should increment version
      const filePath = persistSkill(candidate, "session-002");

      const content = readFileSync(filePath, "utf-8");
      assert.ok(content.includes("version: 2"));
      assert.ok(content.includes("extractedFrom: session-002"));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
