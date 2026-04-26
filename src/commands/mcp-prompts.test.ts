/**
 * Tests for the MCP-prompts-as-slash-commands wiring (audit B5).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { McpPromptHandle } from "../mcp/loader.js";
import { parseMcpPromptArgs, processSlashCommand, registerMcpPromptCommands } from "./index.js";
import type { CommandContext } from "./types.js";

function ctx(): CommandContext {
  return {
    messages: [],
    model: "mock",
    providerName: "mock",
    permissionMode: "trust",
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessionId: "test",
  };
}

describe("parseMcpPromptArgs", () => {
  test("empty input → empty record", () => {
    assert.deepEqual(parseMcpPromptArgs(""), {});
    assert.deepEqual(parseMcpPromptArgs("   "), {});
  });

  test("single key=value", () => {
    assert.deepEqual(parseMcpPromptArgs("repo=acme/widget"), { repo: "acme/widget" });
  });

  test("multiple key=value pairs", () => {
    assert.deepEqual(parseMcpPromptArgs("repo=acme/widget pr=42"), { repo: "acme/widget", pr: "42" });
  });

  test("double-quoted values support spaces", () => {
    assert.deepEqual(parseMcpPromptArgs('title="fix the bug" repo=acme/widget'), {
      title: "fix the bug",
      repo: "acme/widget",
    });
  });

  test("single-quoted values support spaces", () => {
    assert.deepEqual(parseMcpPromptArgs("title='hello world'"), { title: "hello world" });
  });

  test("ignores bare tokens (no =)", () => {
    assert.deepEqual(parseMcpPromptArgs("just-a-token repo=acme"), { repo: "acme" });
  });

  test("hyphens and dots in keys are allowed", () => {
    assert.deepEqual(parseMcpPromptArgs("file-path=src/main.ts"), { "file-path": "src/main.ts" });
  });
});

describe("registerMcpPromptCommands → /<server>:<prompt>", () => {
  test("registered prompt becomes a slash command that returns prependToPrompt", async () => {
    const handle: McpPromptHandle = {
      qualifiedName: "github:summarize-pr",
      description: "Summarize a GitHub pull request",
      arguments: [
        { name: "repo", required: true },
        { name: "pr", required: true },
      ],
      render: async (args) => `Summarize PR ${args?.pr} in ${args?.repo}.`,
    };
    registerMcpPromptCommands([handle]);

    const result = await processSlashCommand("/github:summarize-pr repo=acme/widget pr=42", ctx());
    assert.ok(result);
    assert.equal(result.handled, false);
    assert.equal(result.prependToPrompt, "Summarize PR 42 in acme/widget.");
    assert.match(result.output, /github:summarize-pr/);
  });

  test("missing required arg surfaces a usage error and does NOT call render", async () => {
    let renderCalls = 0;
    const handle: McpPromptHandle = {
      qualifiedName: "github:open-issue",
      description: "Open a new GitHub issue",
      arguments: [{ name: "title", required: true }, { name: "body" }],
      render: async () => {
        renderCalls += 1;
        return "should not reach";
      },
    };
    registerMcpPromptCommands([handle]);

    const result = await processSlashCommand("/github:open-issue body=ignored", ctx());
    assert.ok(result);
    assert.equal(result.handled, true, "missing arg should be handled (no model call)");
    assert.match(result.output, /missing required argument/);
    assert.match(result.output, /title/);
    assert.equal(renderCalls, 0);
  });

  test("render error is reported, not thrown", async () => {
    const handle: McpPromptHandle = {
      qualifiedName: "broken:prompt",
      description: "Always fails",
      render: async () => {
        throw new Error("server unavailable");
      },
    };
    registerMcpPromptCommands([handle]);

    const result = await processSlashCommand("/broken:prompt", ctx());
    assert.ok(result);
    assert.equal(result.handled, true);
    assert.match(result.output, /broken:prompt failed: server unavailable/);
  });

  test("re-registering replaces the previous prompt set", async () => {
    registerMcpPromptCommands([
      {
        qualifiedName: "old:prompt",
        description: "old",
        render: async () => "old-content",
      },
    ]);
    const before = await processSlashCommand("/old:prompt", ctx());
    assert.ok(before);
    assert.equal(before.prependToPrompt, "old-content");

    registerMcpPromptCommands([
      {
        qualifiedName: "new:prompt",
        description: "new",
        render: async () => "new-content",
      },
    ]);
    const oldGone = await processSlashCommand("/old:prompt", ctx());
    assert.ok(oldGone);
    assert.equal(oldGone.handled, true);
    assert.match(oldGone.output, /Unknown command/);

    const newOne = await processSlashCommand("/new:prompt", ctx());
    assert.ok(newOne);
    assert.equal(newOne.prependToPrompt, "new-content");
  });

  test("empty render output surfaces a friendly error rather than blank prepend", async () => {
    registerMcpPromptCommands([
      {
        qualifiedName: "empty:thing",
        description: "returns whitespace",
        render: async () => "   \n\n  ",
      },
    ]);
    const result = await processSlashCommand("/empty:thing", ctx());
    assert.ok(result);
    assert.equal(result.handled, true);
    assert.match(result.output, /empty prompt/);
  });

  test("registering an empty list clears all MCP prompt commands", async () => {
    registerMcpPromptCommands([{ qualifiedName: "x:y", description: "x", render: async () => "z" }]);
    registerMcpPromptCommands([]);
    const result = await processSlashCommand("/x:y", ctx());
    assert.ok(result);
    assert.match(result.output, /Unknown command/);
  });
});
