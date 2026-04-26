import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parse } from "yaml";
import { z } from "zod";
import { prepareToolsRuntime } from "../src/internal/tools-runtime.js";
import { tool } from "../src/tools.js";

let baseCwd: string;

beforeEach(() => {
  baseCwd = path.join(tmpdir(), `oh-ts-runtime-base-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(baseCwd, ".oh"), { recursive: true });
});

afterEach(() => {
  rmSync(baseCwd, { recursive: true, force: true });
});

describe("prepareToolsRuntime", () => {
  test("creates a temp dir with .oh/config.yaml containing the SDK MCP entry", async () => {
    const echo = tool({
      name: "echo",
      inputSchema: z.object({ msg: z.string() }),
      handler: ({ msg }) => msg,
    });
    const runtime = await prepareToolsRuntime({ tools: [echo], baseCwd });
    try {
      const cfgPath = path.join(runtime.cwd, ".oh", "config.yaml");
      assert.ok(existsSync(cfgPath), "ephemeral config.yaml not found");
      const cfg = parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      assert.ok(Array.isArray(cfg.mcpServers), "mcpServers should be an array");
      const entry = (cfg.mcpServers as Array<Record<string, unknown>>)[0];
      assert.equal(entry.type, "http");
      assert.match(String(entry.url), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    } finally {
      await runtime.close();
    }
  });

  test("preserves user keys from baseCwd/.oh/config.yaml (model, provider, …)", async () => {
    writeFileSync(
      path.join(baseCwd, ".oh", "config.yaml"),
      `provider: ollama
model: llama3
permissionMode: ask
mcpServers:
  - name: stale-entry
    type: http
    url: http://example.com
hooks:
  preToolUse:
    - command: should-be-dropped
`,
      "utf8",
    );

    const echo = tool({
      name: "echo",
      inputSchema: z.object({ msg: z.string() }),
      handler: ({ msg }) => msg,
    });
    const runtime = await prepareToolsRuntime({ tools: [echo], baseCwd });
    try {
      const cfg = parse(readFileSync(path.join(runtime.cwd, ".oh", "config.yaml"), "utf8")) as Record<string, unknown>;
      assert.equal(cfg.provider, "ollama");
      assert.equal(cfg.model, "llama3");
      assert.equal(cfg.permissionMode, "ask");
      // SDK-owned blocks should be replaced, not merged.
      const servers = cfg.mcpServers as Array<Record<string, unknown>>;
      assert.equal(servers.length, 1);
      assert.notEqual(servers[0]?.name, "stale-entry");
      // Hooks block is dropped (PR 4 will start adding hooks back when canUseTool is set).
      assert.equal(cfg.hooks, undefined);
    } finally {
      await runtime.close();
    }
  });

  test("close() removes the temp dir and stops the server", async () => {
    const echo = tool({
      name: "echo",
      inputSchema: z.object({ msg: z.string() }),
      handler: ({ msg }) => msg,
    });
    const runtime = await prepareToolsRuntime({ tools: [echo], baseCwd });
    const dir = runtime.cwd;
    await runtime.close();
    assert.equal(existsSync(dir), false, "temp dir should be removed");
  });

  test("with no tools and no baseCwd, still creates a temp dir with empty config", async () => {
    const runtime = await prepareToolsRuntime({});
    try {
      const cfgPath = path.join(runtime.cwd, ".oh", "config.yaml");
      assert.ok(existsSync(cfgPath));
      const cfg = parse(readFileSync(cfgPath, "utf8"));
      // No mcpServers and no hooks since neither tools nor canUseTool were provided.
      assert.equal((cfg as Record<string, unknown> | null)?.mcpServers, undefined);
    } finally {
      await runtime.close();
    }
  });
});
