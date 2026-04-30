import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { previewArgs, readApprovalLog, recordApproval, setApprovalLogPathForTests } from "./approvals.js";

let tmpFile: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "oh-approvals-test-"));
  tmpFile = join(dir, "approvals.log");
  setApprovalLogPathForTests(tmpFile);
});

afterEach(() => {
  setApprovalLogPathForTests(undefined);
});

describe("recordApproval", () => {
  it("appends a JSONL line", () => {
    recordApproval({ tool: "Bash", decision: "allow", source: "user", argsPreview: '{"command":"ls"}' });
    const raw = readFileSync(tmpFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]!);
    assert.equal(rec.tool, "Bash");
    assert.equal(rec.decision, "allow");
    assert.equal(rec.source, "user");
    assert.ok(typeof rec.ts === "string", "should include ISO timestamp");
  });

  it("appends multiple lines preserving order", () => {
    recordApproval({ tool: "Read", decision: "allow", source: "rule" });
    recordApproval({ tool: "Edit", decision: "deny", source: "hook", reason: "no writes" });
    const lines = readFileSync(tmpFile, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).tool, "Read");
    assert.equal(JSON.parse(lines[1]!).tool, "Edit");
  });

  it("swallows errors when log path is null", () => {
    setApprovalLogPathForTests(null);
    // Should not throw.
    recordApproval({ tool: "Bash", decision: "allow", source: "user" });
    // No file written.
    assert.throws(() => statSync(tmpFile));
  });
});

describe("readApprovalLog", () => {
  it("returns empty array when log does not exist", () => {
    setApprovalLogPathForTests(join(tmpdir(), "nonexistent-approvals.log"));
    assert.deepEqual(readApprovalLog(), []);
  });

  it("returns the tail in chronological order", () => {
    for (let i = 0; i < 10; i++) {
      recordApproval({ tool: `Tool${i}`, decision: "allow", source: "user" });
    }
    const out = readApprovalLog(3);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.tool, "Tool7");
    assert.equal(out[2]!.tool, "Tool9");
  });

  it("skips malformed lines", () => {
    writeFileSync(tmpFile, '{"tool":"Bash","decision":"allow","source":"user","ts":"2026-04-30"}\nGARBAGE\n', "utf8");
    const out = readApprovalLog();
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tool, "Bash");
  });
});

describe("previewArgs", () => {
  it("returns input unchanged when below limit", () => {
    assert.equal(previewArgs("short", 100), "short");
  });

  it("truncates with ellipsis when over limit", () => {
    const long = "x".repeat(600);
    const out = previewArgs(long, 500);
    assert.equal(out.length, 501); // 500 + ellipsis
    assert.ok(out.endsWith("…"));
  });
});
