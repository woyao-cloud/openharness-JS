import { z } from "zod";
import { createWorktree, hasWorktreeChanges, isGitRepo, removeWorktree } from "../../git/index.js";
import { emitHook } from "../../harness/hooks.js";
import { getMessageBus } from "../../services/agent-messaging.js";
import type { Tool, ToolContext, ToolResult } from "../../Tool.js";
import type { StreamEvent } from "../../types/events.js";
import { clampSubagentPermissionMode, type PermissionMode } from "../../types/permissions.js";

/**
 * Forward a single inner-query event to the outer stream via `context.emitChildEvent`,
 * stamping it with `parentCallId = context.callId`.
 *
 * Handles: tool_call_start, tool_call_complete, tool_call_end, tool_output_delta.
 * Returns true when the event was forwarded, false otherwise.
 *
 * Exported for unit testing — the hot path in AgentTool.call() calls this inline
 * to keep the forwarding logic isolated and testable without stubbing query().
 */
export function forwardInnerEvent(event: StreamEvent, context: ToolContext): boolean {
  if (!context.emitChildEvent || !context.callId) return false;
  if (
    event.type === "tool_call_start" ||
    event.type === "tool_call_complete" ||
    event.type === "tool_call_end" ||
    event.type === "tool_output_delta"
  ) {
    context.emitChildEvent({ ...event, parentCallId: event.parentCallId ?? context.callId });
    return true;
  }
  return false;
}

const inputSchema = z.object({
  prompt: z.string(),
  description: z.string().optional(),
  isolated: z.boolean().optional().describe("Whether to run in an isolated git worktree (default: true in git repos)"),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe("Isolation mode — 'worktree' creates a temporary git worktree (Claude Code compatible)"),
  run_in_background: z.boolean().optional(),
  model: z.string().optional(),
  subagent_type: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  permission_mode: z
    .enum(["ask", "trust", "deny", "acceptEdits", "plan", "auto", "bypassPermissions"])
    .optional()
    .describe(
      "Restrict the sub-agent's permission mode. Narrowing-only: the harness clamps to the parent's mode if a less-restrictive value is requested. Useful for spawning read-only review/audit agents while the parent runs in 'trust'.",
    ),
});

export const AgentTool: Tool<typeof inputSchema> = {
  name: "Agent",
  description: "Spawn a sub-agent with its own query loop to handle a delegated task.",
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
      return {
        output: "Sub-agent unavailable: provider not in context. Handle this task directly instead.",
        isError: true,
      };
    }

    const { query } = await import("../../query.js");

    // Worktree isolation: create isolated copy of repo if requested or if in git repo
    // Supports both `isolation: "worktree"` (Claude Code) and `isolated: boolean` (legacy)
    const explicitWorktree = input.isolation === "worktree";
    const useWorktree = (explicitWorktree || input.isolated !== false) && isGitRepo(context.workingDir);
    let worktreePath: string | null = null;
    let agentWorkingDir = context.workingDir;

    if (useWorktree) {
      worktreePath = createWorktree(context.workingDir);
      if (worktreePath) {
        agentWorkingDir = worktreePath;
      }
    }

    // Subagent type modifies the system prompt — check built-in types first, then agent roles
    let systemPrompt = context.systemPrompt ?? "You are a sub-agent. Complete the delegated task concisely.";
    let role: import("../../agents/roles.js").AgentRole | undefined;
    if (input.subagent_type) {
      const builtinHints: Record<string, string> = {
        explore:
          "You are an exploration agent. Search the codebase to answer questions. Use only read-only tools (Read, Grep, Glob, LS). Do not modify any files.",
        plan: "You are a planning agent. Analyze the codebase and design implementation plans. Use only read-only tools. Return a detailed step-by-step plan.",
      };
      const hint = builtinHints[input.subagent_type.toLowerCase()];
      if (hint) {
        systemPrompt = `${hint}\n\n${systemPrompt}`;
      } else {
        // Check agent roles (code-reviewer, test-writer, debugger, evaluator, etc.)
        const { getRole } = await import("../../agents/roles.js");
        role = getRole(input.subagent_type.toLowerCase());
        if (role) {
          systemPrompt = `${role.systemPromptSupplement}\n\n${systemPrompt}`;
        }
      }
    }

    // Tool filtering: restrict sub-agent to allowed tools (explicit or role-based)
    let agentTools = context.tools;
    const allowList = input.allowed_tools ?? (role?.suggestedTools?.length ? role.suggestedTools : null);
    if (allowList) {
      const allowSet = new Set(allowList.map((n) => n.toLowerCase()));
      allowSet.add("askuser"); // Always allow user communication
      const filtered = context.tools.filter((t) => allowSet.has(t.name.toLowerCase()));
      if (filtered.length > 0) agentTools = filtered; // Fallback to all tools if filter produces empty set
    }

    // Model override for sub-agent
    const agentModel = input.model ?? context.model;

    // Permission mode override — narrowing-only. Subagent can be same-or-stricter
    // than parent; a less-restrictive request silently clamps to the parent so a
    // model in `ask` can't spawn a `trust`-mode subagent to bypass user approval.
    //
    // Resolution order, most-specific-wins:
    //   1. input.permission_mode (the call site's explicit choice)
    //   2. role.permissionMode (the role's documented default — e.g.
    //      code-reviewer / security-auditor / planner default to "plan")
    //   3. parent's mode (no narrowing — current default)
    // The clamp applies in all cases so #1 and #2 can only narrow, not loosen.
    const parentMode: PermissionMode = context.permissionMode ?? "trust";
    const requestedMode = (input.permission_mode as PermissionMode | undefined) ?? role?.permissionMode;
    const subagentMode = clampSubagentPermissionMode(parentMode, requestedMode);

    const config = {
      provider: context.provider,
      tools: agentTools,
      systemPrompt,
      permissionMode: subagentMode,
      model: agentModel,
      maxTurns: 20,
      abortSignal: context.abortSignal,
      workingDir: agentWorkingDir,
    };

    const agentId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    emitHook("subagentStart", { agentId, toolName: input.subagent_type ?? "general" });

    // Background execution: start agent and return immediately
    if (input.run_in_background) {
      const bgId = agentId;
      const bus = getMessageBus();
      bus.registerBackgroundAgent(bgId, input.subagent_type ?? "general");

      const runAgent = async () => {
        let finalText = "";
        try {
          for await (const event of query(input.prompt, { ...config, role: role?.id })) {
            if (event.type === "text_delta") finalText += event.content;
          }
        } finally {
          // Clean up worktree only if no changes were made
          if (worktreePath) {
            const hasChanges = hasWorktreeChanges(worktreePath);
            if (!hasChanges) {
              removeWorktree(worktreePath, context.workingDir);
            } else if (context.onOutputChunk && context.callId) {
              context.onOutputChunk(
                context.callId,
                `\n[background:${bgId} worktree preserved at ${worktreePath} — agent made changes]`,
              );
            }
          }
        }
        bus.completeBackgroundAgent(bgId, finalText);
        if (context.onOutputChunk && context.callId) {
          context.onOutputChunk(context.callId, `\n[background:${bgId} completed]\n${finalText}`);
        }
      };
      runAgent().catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        bus.errorBackgroundAgent(bgId, errMsg);
        if (context.onOutputChunk && context.callId) {
          context.onOutputChunk(context.callId, `\n[background:${bgId} failed: ${errMsg}]`);
        }
      });
      return {
        output: `Background agent started (id: ${bgId}). You will be notified when it completes. Use SendMessage with to:'${bgId}' to send it messages.`,
        isError: false,
      };
    }

    const outputChunks: string[] = [];
    let finalText = "";

    try {
      try {
        for await (const event of query(input.prompt, { ...config, role: role?.id })) {
          if (event.type === "text_delta") {
            finalText += event.content;
          } else if (event.type === "tool_output_delta") {
            outputChunks.push(event.chunk);
            const forwarded = forwardInnerEvent(event, context);
            if (!forwarded && context.onOutputChunk && context.callId) {
              context.onOutputChunk(context.callId, event.chunk);
            }
          } else if (
            event.type === "tool_call_start" ||
            event.type === "tool_call_complete" ||
            event.type === "tool_call_end"
          ) {
            forwardInnerEvent(event, context);
          } else if (event.type === "error") {
            return { output: `Sub-agent error: ${event.message}`, isError: true };
          } else if (event.type === "turn_complete" && event.reason !== "completed") {
            if (event.reason === "aborted") {
              return { output: finalText || "Sub-agent aborted.", isError: false };
            }
          }
        }
      } finally {
        /* workingDir passed via config — no process.chdir cleanup needed */
      }
    } catch (err) {
      return {
        output: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    } finally {
      // Clean up worktree only if no changes were made
      if (worktreePath) {
        const hasChanges = hasWorktreeChanges(worktreePath);
        if (!hasChanges) {
          removeWorktree(worktreePath, context.workingDir);
        } else {
          finalText += `\n\n[Worktree preserved at ${worktreePath} — agent made changes that can be reviewed/merged]`;
        }
      }
    }

    emitHook("subagentStop", { agentId });

    // Context folding: collapse long sub-agent output to summary
    let output = finalText || "(sub-agent completed with no text output)";
    if (output.length > 2000) {
      const { ContextManager } = await import("../../query/context-manager.js");
      const cm = new ContextManager();
      output = cm.foldSubagentResult(agentId, output);
    }

    return { output, isError: false };
  },

  prompt() {
    return `Spawn a sub-agent with its own tool-use loop to handle a delegated task autonomously. The sub-agent runs in an isolated git worktree to prevent file conflicts. Parameters:
- prompt (string, required): The full instructions for the sub-agent.
- description (string, optional): A short label for what the sub-agent is doing.
- isolated (boolean, optional): Whether to use git worktree isolation (default: true if in a git repo).
- run_in_background (boolean, optional): Run the agent in the background. Returns immediately; you will be notified when it completes.
- model (string, optional): Override the model for this sub-agent (e.g., use a faster model for exploration).
- subagent_type (string, optional): Specialize the agent behavior. Types: "Explore" (read-only codebase search), "Plan" (design implementation plans), "code-reviewer", "test-writer", "debugger", "refactorer", "security-auditor", "evaluator" (read-only evaluation), "planner" (implementation plans), "architect" (system design), "migrator" (codebase migrations).
- allowed_tools (string[], optional): Restrict the sub-agent to only these tools by name. If omitted and a role has suggested tools, those are used.
- permission_mode (string, optional): Override the sub-agent's permission mode (one of: ask, trust, deny, acceptEdits, plan, auto, bypassPermissions). Narrowing-only — a less-restrictive value silently clamps to the parent's mode. Use to spawn a read-only audit/review sub-agent in "plan" or "deny" while the parent runs in "trust".`;
  },
};
