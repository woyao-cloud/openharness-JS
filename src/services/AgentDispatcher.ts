/**
 * AgentDispatcher — parallel sub-agent execution with task dependency DAG.
 *
 * Accepts a list of tasks with optional dependencies (blockedBy),
 * dispatches independent tasks to parallel worktrees, collects results,
 * and triggers dependent tasks when their blockers complete.
 */

import { createWorktree, isGitRepo, removeWorktree } from "../git/index.js";
import type { Provider } from "../providers/base.js";
import type { Tools } from "../Tool.js";
import type { StreamEvent, ToolCallComplete, ToolCallEnd, ToolCallStart, ToolOutputDelta } from "../types/events.js";
import type { PermissionMode } from "../types/permissions.js";

/**
 * Forward inner-loop tool events to the outer stream, stamping parentCallId.
 * Exported for direct unit testing.
 */
export function forwardChildEvent(
  event: StreamEvent,
  parentCallId: string | undefined,
  emit: ((e: ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta) => void) | undefined,
): boolean {
  if (!emit || !parentCallId) return false;
  if (
    event.type === "tool_call_start" ||
    event.type === "tool_call_complete" ||
    event.type === "tool_call_end" ||
    event.type === "tool_output_delta"
  ) {
    emit({ ...event, parentCallId });
    return true;
  }
  return false;
}

export type AgentTask = {
  id: string;
  prompt: string;
  description?: string;
  blockedBy?: string[]; // task IDs that must complete before this one starts
  allowedTools?: string[]; // restrict this task's agent to specific tools
};

export type AgentTaskResult = {
  id: string;
  output: string;
  isError: boolean;
  durationMs: number;
};

type InternalTask = AgentTask & {
  status: "pending" | "running" | "completed" | "failed";
  result?: AgentTaskResult;
};

export class AgentDispatcher {
  private tasks: Map<string, InternalTask>;
  private results: Map<string, AgentTaskResult> = new Map();
  private maxConcurrency: number;

  constructor(
    private provider: Provider,
    private tools: Tools,
    private systemPrompt: string,
    private permissionMode: PermissionMode,
    private model?: string,
    private workingDir?: string,
    private abortSignal?: AbortSignal,
    maxConcurrency = 4,
    private parentCallId?: string,
    private emitChildEvent?: (event: ToolCallStart | ToolCallComplete | ToolCallEnd | ToolOutputDelta) => void,
  ) {
    this.tasks = new Map();
    this.maxConcurrency = maxConcurrency;
  }

  addTask(task: AgentTask): void {
    this.tasks.set(task.id, { ...task, status: "pending" });
  }

  addTasks(tasks: AgentTask[]): void {
    for (const t of tasks) this.addTask(t);
  }

  /** Execute all tasks respecting dependencies. Returns results in completion order. */
  async execute(): Promise<AgentTaskResult[]> {
    const results: AgentTaskResult[] = [];

    while (true) {
      if (this.abortSignal?.aborted) break;

      // Find tasks ready to run (all blockers completed)
      const ready = [...this.tasks.values()].filter((t) => t.status === "pending" && this.isReady(t));
      const running = [...this.tasks.values()].filter((t) => t.status === "running");

      // All done?
      if (ready.length === 0 && running.length === 0) break;

      // Dispatch up to maxConcurrency
      const toStart = ready.slice(0, this.maxConcurrency - running.length);
      if (toStart.length === 0 && running.length === 0) {
        // Deadlock — blocked tasks with no way to unblock
        for (const t of this.tasks.values()) {
          if (t.status === "pending") {
            t.status = "failed";
            const result: AgentTaskResult = {
              id: t.id,
              output: "Deadlock: blocked dependencies never completed.",
              isError: true,
              durationMs: 0,
            };
            this.results.set(t.id, result);
            results.push(result);
          }
        }
        break;
      }

      // Run tasks in parallel
      const promises = toStart.map((t) => {
        t.status = "running";
        return this.runTask(t).then((result) => {
          t.status = "completed";
          t.result = result;
          this.results.set(t.id, result);
          results.push(result);
        });
      });

      // Wait for at least one to complete before scheduling more
      if (promises.length > 0) {
        await Promise.race(promises);
        // Wait for remaining in this batch
        await Promise.allSettled(promises);
      } else {
        // Running tasks exist but we can't start more — wait for all running
        const runningPromises = [...this.tasks.values()]
          .filter((t) => t.status === "running" && t.result)
          .map((_t) => Promise.resolve());
        if (runningPromises.length === 0) {
          // Need to poll — running tasks haven't resolved yet
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    return results;
  }

  private isReady(task: InternalTask): boolean {
    if (!task.blockedBy || task.blockedBy.length === 0) return true;
    return task.blockedBy.every((id) => {
      const blocker = this.tasks.get(id);
      return blocker && (blocker.status === "completed" || blocker.status === "failed");
    });
  }

  private async runTask(task: InternalTask): Promise<AgentTaskResult> {
    const start = Date.now();
    const cwd = this.workingDir ?? process.cwd();
    const useWorktree = isGitRepo(cwd);
    let worktreePath: string | null = null;
    let result: AgentTaskResult;

    const taskCallId = `task-${task.id}-${Date.now().toString(36)}`;
    const taskDescription = task.description ?? task.id;
    const synthEnabled = !!this.emitChildEvent && !!this.parentCallId;
    if (synthEnabled) {
      this.emitChildEvent!({
        type: "tool_call_start",
        toolName: "Task",
        callId: taskCallId,
        parentCallId: this.parentCallId,
      });
      this.emitChildEvent!({
        type: "tool_call_complete",
        toolName: "Task",
        callId: taskCallId,
        arguments: { description: taskDescription },
        parentCallId: this.parentCallId,
      });
    }

    if (useWorktree) {
      worktreePath = createWorktree(cwd);
    }

    try {
      const { query } = await import("../query.js");

      // Filter tools if task specifies allowed tools
      let taskTools = this.tools;
      if (task.allowedTools && task.allowedTools.length > 0) {
        const allowSet = new Set(task.allowedTools.map((n) => n.toLowerCase()));
        allowSet.add("askuser");
        const filtered = this.tools.filter((t) => allowSet.has(t.name.toLowerCase()));
        if (filtered.length > 0) taskTools = filtered;
      }

      // Plumb cwd through config.workingDir so parallel runTask calls don't
      // race on the global process.cwd(). The query loop seeds ToolContext
      // with this value; built-in tools (FileRead, Glob, Bash, …) honor it.
      // Previously this method called `process.chdir(worktreePath)` and a
      // matching `process.chdir(originalCwd)` in `finally` — but since
      // `process.cwd()` is process-wide, two concurrent tasks would clobber
      // each other's directory mid-execution.
      const config = {
        provider: this.provider,
        tools: taskTools,
        systemPrompt: this.systemPrompt,
        permissionMode: this.permissionMode,
        model: this.model,
        maxTurns: 20,
        abortSignal: this.abortSignal,
        workingDir: worktreePath ?? cwd,
      };

      // Inject blocker results as context
      let promptWithContext = task.prompt;
      if (task.blockedBy && task.blockedBy.length > 0) {
        const blockerContext = task.blockedBy
          .map((id) => {
            const r = this.results.get(id);
            return r ? `## Result from task "${id}":\n${r.output.slice(0, 1000)}` : "";
          })
          .filter(Boolean)
          .join("\n\n");
        if (blockerContext) {
          promptWithContext = `${blockerContext}\n\n---\n\n${task.prompt}`;
        }
      }

      let output = "";
      let errorMessage: string | null = null;
      for await (const event of query(promptWithContext, config)) {
        if (event.type === "text_delta") output += event.content;
        if (event.type === "error") {
          errorMessage = event.message;
          break;
        }
        forwardChildEvent(event, taskCallId, this.emitChildEvent);
      }

      if (errorMessage !== null) {
        result = { id: task.id, output: `Error: ${errorMessage}`, isError: true, durationMs: Date.now() - start };
      } else {
        result = { id: task.id, output: output || "(no output)", isError: false, durationMs: Date.now() - start };
      }
    } catch (err) {
      result = {
        id: task.id,
        output: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        durationMs: Date.now() - start,
      };
    } finally {
      if (worktreePath) {
        removeWorktree(worktreePath, cwd);
      }
      if (synthEnabled) {
        this.emitChildEvent!({
          type: "tool_call_end",
          callId: taskCallId,
          output: result!.output,
          isError: result!.isError,
          parentCallId: this.parentCallId,
        });
      }
    }
    return result!;
  }
}
