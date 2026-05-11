import { z } from "zod";
import { createWorktree, isGitRepo } from "../../git/index.js";
import { readOhConfig } from "../../harness/config.js";
import { emitHook } from "../../harness/hooks.js";
import type { Tool, ToolContext, ToolResult } from "../../Tool.js";

const inputSchema = z.object({
  branch: z.string().optional().describe("Branch name for the worktree (auto-generated if omitted)"),
});

export const EnterWorktreeTool: Tool<typeof inputSchema> = {
  name: "EnterWorktree",
  description:
    "Create an isolated git worktree for safe experimentation. Changes won't affect the main working directory.",
  inputSchema,
  riskLevel: "medium",
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  async call(_input, context: ToolContext): Promise<ToolResult> {
    if (!isGitRepo(context.workingDir)) {
      return { output: "Not a git repository — worktrees require git.", isError: true };
    }
    const baseRef = readOhConfig()?.worktree?.baseRef ?? "head";
    const path = createWorktree(context.workingDir, baseRef);
    if (!path) {
      return { output: "Failed to create worktree.", isError: true };
    }
    // Symmetric to taskCreated — fire only on the success path so audit hooks
    // can react to the new worktree (e.g. set up a per-worktree scratch dir).
    emitHook("worktreeCreate", { worktreePath: path, worktreeParent: context.workingDir });
    return { output: `Worktree created at: ${path}\nUse ExitWorktree to clean up when done.`, isError: false };
  },

  prompt() {
    return "EnterWorktree: Create an isolated git worktree for safe code changes.";
  },
};
