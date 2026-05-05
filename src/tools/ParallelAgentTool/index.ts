import { z } from "zod";
import { AgentDispatcher, type AgentTask } from "../../services/AgentDispatcher.js";
import type { Tool, ToolContext, ToolResult } from "../../Tool.js";
import type { PermissionMode } from "../../types/permissions.js";

const taskSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  description: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  allowed_tools: z.array(z.string()).optional(),
  permission_mode: z
    .enum(["ask", "trust", "deny", "acceptEdits", "plan", "auto", "bypassPermissions"])
    .optional()
    .describe(
      "Restrict THIS task's permission mode. Narrowing-only — clamps to the outer mode if a less-restrictive value is requested. Use to mark a single task as read-only review/audit while sibling tasks keep full write access.",
    ),
});

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(1),
});

export const ParallelAgentTool: Tool<typeof inputSchema> = {
  name: "ParallelAgents",
  description: "Dispatch multiple sub-agents in parallel with optional task dependencies.",
  inputSchema,
  riskLevel: "medium",

  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return false;
  },

  async call(input, context: ToolContext): Promise<ToolResult> {
    if (!context.provider || !context.tools) {
      return { output: "Parallel agents unavailable: provider not in context.", isError: true };
    }

    const systemPrompt = context.systemPrompt ?? "You are a sub-agent. Complete the delegated task concisely.";
    const dispatcher = new AgentDispatcher(
      context.provider,
      context.tools,
      systemPrompt,
      context.permissionMode ?? "trust",
      context.model,
      context.workingDir,
      context.abortSignal,
      4, // maxConcurrency default
      context.callId,
      context.emitChildEvent,
    );

    // Map snake_case input fields to the AgentTask camelCase shape — the
    // input schema uses `allowed_tools` / `permission_mode` to stay
    // consistent with AgentTool, but the dispatcher's task type uses
    // `allowedTools` / `permissionMode`.
    dispatcher.addTasks(
      input.tasks.map((t) => ({
        id: t.id,
        prompt: t.prompt,
        description: t.description,
        blockedBy: t.blockedBy,
        allowedTools: t.allowed_tools,
        permissionMode: t.permission_mode as PermissionMode | undefined,
      })) as AgentTask[],
    );
    const results = await dispatcher.execute();

    const output = results
      .map((r) => {
        const status = r.isError ? "✗" : "✓";
        const duration = (r.durationMs / 1000).toFixed(1);
        return `${status} [${r.id}] (${duration}s)\n${r.output}`;
      })
      .join("\n\n---\n\n");

    const hasErrors = results.some((r) => r.isError);
    return { output, isError: hasErrors };
  },

  prompt() {
    return `Dispatch multiple sub-agents in parallel with optional task dependencies. Each agent runs in an isolated git worktree. Tasks with blockedBy wait for their dependencies to complete before starting.

Parameters:
- tasks (array, required): List of tasks to execute. Each task has:
  - id (string): Unique task identifier
  - prompt (string): Instructions for the sub-agent
  - description (string, optional): Short label
  - blockedBy (string[], optional): IDs of tasks that must complete first
  - allowed_tools (string[], optional): Restrict THIS task's agent to specific tools
  - permission_mode (string, optional): Override THIS task's permission mode. Narrowing-only — a less-restrictive value clamps to the outer mode. Useful for marking review/audit tasks as "plan" or "deny" while sibling tasks keep full write access.

Example: parallel test-write + read-only review:
tasks: [
  { id: "tests", prompt: "Add tests for the new auth module" },
  { id: "review", prompt: "Audit the new auth module for security issues", permission_mode: "plan" }
]`;
  },
};
