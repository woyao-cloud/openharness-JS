import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCallInfo } from "./layout.js";
import { buildToolCallTree } from "./tool-tree.js";

function tc(toolName: string, parentCallId?: string): ToolCallInfo {
  return { toolName, status: "running", parentCallId };
}

describe("buildToolCallTree", () => {
  it("returns empty array for empty map", () => {
    const result = buildToolCallTree(new Map());
    assert.deepEqual(result, []);
  });

  it("returns single root for one call with no parent", () => {
    const m = new Map<string, ToolCallInfo>([["a", tc("Read")]]);
    const result = buildToolCallTree(m);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.callId, "a");
    assert.equal(result[0]!.depth, 0);
    assert.equal(result[0]!.children.length, 0);
  });

  it("renders root with one child indented", () => {
    const m = new Map<string, ToolCallInfo>([
      ["p", tc("Agent")],
      ["c", tc("Read", "p")],
    ]);
    const result = buildToolCallTree(m);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.callId, "p");
    assert.equal(result[0]!.children.length, 1);
    assert.equal(result[0]!.children[0]!.callId, "c");
    assert.equal(result[0]!.children[0]!.depth, 1);
  });

  it("renders root with multiple children in insertion order", () => {
    const m = new Map<string, ToolCallInfo>([
      ["p", tc("Agent")],
      ["c1", tc("Read", "p")],
      ["c2", tc("Bash", "p")],
      ["c3", tc("Edit", "p")],
    ]);
    const result = buildToolCallTree(m);
    assert.equal(result[0]!.children.length, 3);
    assert.deepEqual(
      result[0]!.children.map((n) => n.callId),
      ["c1", "c2", "c3"],
    );
  });

  it("renders multi-level tree (root → child → grandchild)", () => {
    const m = new Map<string, ToolCallInfo>([
      ["p", tc("Agent")],
      ["c", tc("Agent", "p")],
      ["gc", tc("Read", "c")],
    ]);
    const result = buildToolCallTree(m);
    assert.equal(result[0]!.depth, 0);
    assert.equal(result[0]!.children[0]!.depth, 1);
    assert.equal(result[0]!.children[0]!.children[0]!.depth, 2);
    assert.equal(result[0]!.children[0]!.children[0]!.callId, "gc");
  });

  it("treats child whose parent is missing from map as a root (fallback)", () => {
    const m = new Map<string, ToolCallInfo>([["orphan", tc("Read", "missing-parent")]]);
    const result = buildToolCallTree(m);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.callId, "orphan");
    assert.equal(result[0]!.depth, 0);
  });

  it("defends against parent cycles (does not infinite-loop)", () => {
    const m = new Map<string, ToolCallInfo>([
      ["a", tc("Agent", "b")],
      ["b", tc("Agent", "a")],
    ]);
    // Either ordering is acceptable; the important thing is termination + no duplicates
    const result = buildToolCallTree(m);
    const totalNodes = countNodes(result);
    assert.ok(totalNodes <= 2, `expected at most 2 nodes, got ${totalNodes}`);
  });

  it("preserves the ToolCallInfo reference inside each node", () => {
    const info = tc("Read");
    const m = new Map<string, ToolCallInfo>([["a", info]]);
    const result = buildToolCallTree(m);
    assert.strictEqual(result[0]!.call, info);
  });
});

function countNodes(nodes: ReturnType<typeof buildToolCallTree>): number {
  let n = 0;
  for (const node of nodes) {
    n++;
    n += countNodes(node.children);
  }
  return n;
}
