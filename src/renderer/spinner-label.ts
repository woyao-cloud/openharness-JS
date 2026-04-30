/**
 * Derives the spinner section label from the live tool-call map.
 */

import type { ToolCallInfo } from "./layout.js";

export function deriveSpinnerLabel(toolCalls: Map<string, ToolCallInfo>): string {
  const running: ToolCallInfo[] = [];
  for (const tc of toolCalls.values()) {
    if (tc.status === "running") running.push(tc);
  }
  if (running.length === 0) return "Thinking";
  if (running.length === 1) {
    const name = running[0]!.toolName;
    if (name.startsWith("mcp__")) {
      const rest = name.slice("mcp__".length);
      const idx = rest.indexOf("__");
      if (idx > 0) return `Calling ${rest.slice(0, idx)}:${rest.slice(idx + 2)}`;
    }
    return `Running ${name}`;
  }
  return `Running ${running.length} tools`;
}
