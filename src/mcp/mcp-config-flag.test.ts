/**
 * Tests for parseMcpConfigFile + LoadMcpOptions plumbing (audit A2).
 *
 * loadMcpTools itself spawns subprocesses + connects to MCP servers, which
 * is integration-test territory. Here we cover the pure-parse + shape
 * rules that gate everything below them.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { parseMcpConfigFile } from "./loader.js";

function writeJson(dir: string, name: string, body: unknown): string {
  const p = path.join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return p;
}

describe("parseMcpConfigFile (audit A2)", () => {
  test("Claude Code shape: { mcpServers: [...] }", () => {
    const dir = makeTmpDir();
    const file = writeJson(dir, "mcp.json", {
      mcpServers: [
        { name: "fs", type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
        { name: "github", type: "http", url: "https://example.com/mcp" },
      ],
    });
    const result = parseMcpConfigFile(file);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "fs");
    assert.equal(result[1].name, "github");
  });

  test("bare array of servers also accepted", () => {
    const dir = makeTmpDir();
    const file = writeJson(dir, "mcp.json", [{ name: "only", command: "echo" }]);
    const result = parseMcpConfigFile(file);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "only");
  });

  test("single server object is wrapped into an array", () => {
    const dir = makeTmpDir();
    const file = writeJson(dir, "mcp.json", { name: "single", command: "echo" });
    const result = parseMcpConfigFile(file);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "single");
  });

  test("malformed JSON is rejected with a useful error", () => {
    const dir = makeTmpDir();
    const file = writeJson(dir, "mcp.json", "{ broken json");
    assert.throws(() => parseMcpConfigFile(file), /not valid JSON/);
  });

  test("missing name on a server entry is rejected", () => {
    const dir = makeTmpDir();
    const file = writeJson(dir, "mcp.json", { mcpServers: [{ command: "echo" }] });
    assert.throws(() => parseMcpConfigFile(file), /must be an object with a 'name' string/);
  });

  test("non-array mcpServers field is rejected", () => {
    const dir = makeTmpDir();
    const file = writeJson(dir, "mcp.json", { mcpServers: { name: "x" } });
    assert.throws(() => parseMcpConfigFile(file), /mcpServers must be an array/);
  });

  test("unrecognized top-level shape is rejected", () => {
    const dir = makeTmpDir();
    const file = writeJson(dir, "mcp.json", "true");
    assert.throws(() => parseMcpConfigFile(file), /expected an mcpServers array/);
  });
});
