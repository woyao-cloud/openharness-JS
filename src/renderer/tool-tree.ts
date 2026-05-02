/**
 * Tree builder for tool calls — walks the flat callId map and produces a
 * depth-first parent-child tree for rendering.
 */

import type { ToolCallInfo } from "./layout.js";

export type TreeNode = {
  callId: string;
  call: ToolCallInfo;
  children: TreeNode[];
  depth: number;
};

export function buildToolCallTree(toolCalls: Map<string, ToolCallInfo>): TreeNode[] {
  const childrenOf = new Map<string, string[]>();
  const allIds = new Set<string>();
  for (const [callId, info] of toolCalls) {
    allIds.add(callId);
    const parent = info.parentCallId;
    if (parent === undefined) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(callId);
    childrenOf.set(parent, list);
  }

  const roots: string[] = [];
  for (const [callId, info] of toolCalls) {
    const parent = info.parentCallId;
    if (parent === undefined || !allIds.has(parent)) {
      roots.push(callId);
    }
  }

  const seen = new Set<string>();
  const build = (callId: string, depth: number): TreeNode | null => {
    if (seen.has(callId)) return null;
    seen.add(callId);
    const info = toolCalls.get(callId);
    if (!info) return null;
    const childIds = childrenOf.get(callId) ?? [];
    const children: TreeNode[] = [];
    for (const cid of childIds) {
      const child = build(cid, depth + 1);
      if (child) children.push(child);
    }
    return { callId, call: info, children, depth };
  };

  const result: TreeNode[] = [];
  for (const rootId of roots) {
    const node = build(rootId, 0);
    if (node) result.push(node);
  }
  return result;
}
