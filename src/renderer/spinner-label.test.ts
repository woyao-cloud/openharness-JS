import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCallInfo } from "./layout.js";
import { deriveSpinnerLabel } from "./spinner-label.js";

function tc(toolName: string, status: ToolCallInfo["status"] = "running"): ToolCallInfo {
  return { toolName, status };
}

describe("deriveSpinnerLabel", () => {
  it("returns 'Thinking' when no tools are running", () => {
    const m = new Map<string, ToolCallInfo>();
    assert.equal(deriveSpinnerLabel(m), "Thinking");
  });

  it("returns 'Thinking' when all tools are done", () => {
    const m = new Map<string, ToolCallInfo>([["a", tc("Read", "done")]]);
    assert.equal(deriveSpinnerLabel(m), "Thinking");
  });

  it("returns 'Running <ToolName>' for a single running tool", () => {
    const m = new Map<string, ToolCallInfo>([["a", tc("Bash")]]);
    assert.equal(deriveSpinnerLabel(m), "Running Bash");
  });

  it("returns 'Calling <server>:<tool>' for a single running mcp tool", () => {
    const m = new Map<string, ToolCallInfo>([["a", tc("mcp__filesystem__read_file")]]);
    assert.equal(deriveSpinnerLabel(m), "Calling filesystem:read_file");
  });

  it("falls back to 'Running <name>' when mcp__ name lacks the second __", () => {
    const m = new Map<string, ToolCallInfo>([["a", tc("mcp__weirdname")]]);
    assert.equal(deriveSpinnerLabel(m), "Running mcp__weirdname");
  });

  it("falls back to 'Running <name>' when mcp__ name has an empty server segment", () => {
    const m = new Map<string, ToolCallInfo>([["a", tc("mcp____tool")]]);
    assert.equal(deriveSpinnerLabel(m), "Running mcp____tool");
  });

  it("returns 'Running N tools' when multiple tools are running", () => {
    const m = new Map<string, ToolCallInfo>([
      ["a", tc("Read")],
      ["b", tc("Bash")],
      ["c", tc("Edit")],
    ]);
    assert.equal(deriveSpinnerLabel(m), "Running 3 tools");
  });

  it("ignores done/error tools when counting running ones", () => {
    const m = new Map<string, ToolCallInfo>([
      ["a", tc("Read", "done")],
      ["b", tc("Bash")],
      ["c", tc("Edit", "error")],
    ]);
    assert.equal(deriveSpinnerLabel(m), "Running Bash");
  });
});
