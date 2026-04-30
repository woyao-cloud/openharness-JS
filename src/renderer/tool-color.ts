/**
 * Maps a tool name to a display color for the tool-call section.
 * Read-class tools → cyan, Mutate-class → yellow, Exec-class → magenta,
 * MCP tools (mcp__ prefix) → green, everything else → yellow fallback.
 */

const READ = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "ExaSearch"]);
const MUTATE = new Set(["Edit", "Write", "NotebookEdit"]);
const EXEC = new Set(["Bash", "PowerShell"]);

export type ToolColor = "cyan" | "yellow" | "magenta" | "green";

export function toolColor(toolName: string): ToolColor {
  if (READ.has(toolName)) return "cyan";
  if (MUTATE.has(toolName)) return "yellow";
  if (EXEC.has(toolName)) return "magenta";
  if (toolName.startsWith("mcp__")) return "green";
  return "yellow";
}
