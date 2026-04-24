/**
 * Tests for ListMcpResourcesTool and ReadMcpResourceTool.
 * Covers the pure formatter helpers directly + integration smoke tests that
 * exercise the tool's `.call()` with zero MCP servers connected.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolContext } from "../Tool.js";
import { formatResourcesList, ListMcpResourcesTool, type McpResourceEntry } from "./ListMcpResourcesTool/index.js";
import { formatResourceContent, ReadMcpResourceTool } from "./ReadMcpResourceTool/index.js";

function ctx(): ToolContext {
  return { workingDir: process.cwd() };
}

describe("formatResourcesList", () => {
  it("returns a helpful message when no resources and no filter", () => {
    const out = formatResourcesList([]);
    assert.match(out, /No MCP resources available/);
    assert.match(out, /mcpServers/);
  });

  it("returns a scoped message when filter yields no matches", () => {
    const out = formatResourcesList([], "ghost-server");
    assert.match(out, /ghost-server/);
    assert.match(out, /No MCP resources/);
  });

  it("renders a markdown table when resources exist", () => {
    const resources: McpResourceEntry[] = [
      { server: "fs", uri: "file:///a.txt", name: "a", description: "first file" },
      { server: "fs", uri: "file:///b.txt", name: "b" },
    ];
    const out = formatResourcesList(resources);
    assert.match(out, /\| Server \| URI \| Name \| Description \|/);
    assert.match(out, /fs/);
    assert.match(out, /file:\/\/\/a\.txt/);
    assert.match(out, /first file/);
  });

  it("filters by server when serverFilter is set", () => {
    const resources: McpResourceEntry[] = [
      { server: "fs", uri: "file:///a.txt", name: "a" },
      { server: "docs", uri: "docs://intro", name: "intro" },
    ];
    const out = formatResourcesList(resources, "fs");
    assert.match(out, /file:\/\/\/a\.txt/);
    assert.doesNotMatch(out, /docs:\/\/intro/);
  });

  it("escapes pipe characters in description, name, and URI", () => {
    const resources: McpResourceEntry[] = [{ server: "x", uri: "x://a|b", name: "n|m", description: "has | pipe" }];
    const out = formatResourcesList(resources);
    assert.match(out, /has \\\| pipe/);
    assert.match(out, /n\\\|m/);
    assert.match(out, /x:\/\/a\\\|b/);
  });

  it("truncates descriptions longer than 80 chars", () => {
    const long = "d".repeat(200);
    const resources: McpResourceEntry[] = [{ server: "x", uri: "x://1", name: "n", description: long }];
    const out = formatResourcesList(resources);
    assert.ok(!out.includes(long), "full long description should not appear");
  });
});

describe("formatResourceContent", () => {
  it("returns content unchanged when under the cap", () => {
    const content = "hello world";
    assert.equal(formatResourceContent(content), content);
  });

  it("returns content unchanged when exactly at the cap", () => {
    const content = "x".repeat(100);
    assert.equal(formatResourceContent(content, 100), content);
  });

  it("truncates content above the cap and notes the original length", () => {
    const content = "x".repeat(150);
    const out = formatResourceContent(content, 100);
    assert.ok(out.length < content.length + 100);
    assert.match(out, /\[\.\.\.truncated/);
    assert.match(out, /100/);
    assert.match(out, /150/);
  });

  it("uses the default 50_000 cap when no limit is provided", () => {
    const content = "a".repeat(60_000);
    const out = formatResourceContent(content);
    assert.match(out, /truncated/);
    assert.match(out, /50000/);
  });
});

describe("ListMcpResourcesTool (integration)", () => {
  it("returns the 'no resources' message when no MCP servers are connected", async () => {
    const result = await ListMcpResourcesTool.call({}, ctx());
    assert.equal(result.isError, false);
    assert.match(result.output, /No MCP resources available/);
  });

  it("accepts a server filter without error", async () => {
    const result = await ListMcpResourcesTool.call({ server: "absent" }, ctx());
    assert.equal(result.isError, false);
    assert.match(result.output, /absent/);
  });

  it("metadata advertises read-only and concurrency-safe", () => {
    assert.equal(ListMcpResourcesTool.isReadOnly({}), true);
    assert.equal(ListMcpResourcesTool.isConcurrencySafe({}), true);
    assert.equal(ListMcpResourcesTool.riskLevel, "low");
  });
});

describe("ReadMcpResourceTool (integration)", () => {
  it("returns an error ToolResult when no server has the URI", async () => {
    const result = await ReadMcpResourceTool.call({ uri: "file:///nope.txt" }, ctx());
    assert.equal(result.isError, true);
    assert.match(result.output, /not found/);
    assert.match(result.output, /ListMcpResources/);
  });

  it("includes the server name in the not-found message when server is given", async () => {
    const result = await ReadMcpResourceTool.call({ uri: "x://1", server: "ghost" }, ctx());
    assert.equal(result.isError, true);
    assert.match(result.output, /ghost/);
  });

  it("metadata advertises read-only and concurrency-safe", () => {
    assert.equal(ReadMcpResourceTool.isReadOnly({ uri: "x" }), true);
    assert.equal(ReadMcpResourceTool.isConcurrencySafe({ uri: "x" }), true);
    assert.equal(ReadMcpResourceTool.riskLevel, "low");
  });
});
