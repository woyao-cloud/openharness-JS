import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolColor } from "./tool-color.js";

describe("toolColor", () => {
  it("maps Read tools to cyan", () => {
    for (const t of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "ExaSearch"]) {
      assert.equal(toolColor(t), "cyan", `${t} should be cyan`);
    }
  });

  it("maps Mutate tools to yellow", () => {
    for (const t of ["Edit", "Write", "NotebookEdit"]) {
      assert.equal(toolColor(t), "yellow", `${t} should be yellow`);
    }
  });

  it("maps Exec tools to magenta", () => {
    for (const t of ["Bash", "PowerShell"]) {
      assert.equal(toolColor(t), "magenta", `${t} should be magenta`);
    }
  });

  it("maps mcp__ prefixed tools to green", () => {
    assert.equal(toolColor("mcp__filesystem__read_file"), "green");
    assert.equal(toolColor("mcp__github__create_issue"), "green");
  });

  it("returns yellow fallback for unknown tools", () => {
    assert.equal(toolColor("SomeRandomTool"), "yellow");
    assert.equal(toolColor(""), "yellow");
  });

  it("returns yellow fallback for Agent / ParallelAgents (handled by isAgent short-circuit at the call site)", () => {
    assert.equal(toolColor("Agent"), "yellow");
    assert.equal(toolColor("ParallelAgents"), "yellow");
  });

  it("does not match a tool name that contains 'mcp__' but does not start with it", () => {
    assert.equal(toolColor("not_mcp__filesystem"), "yellow");
  });
});
