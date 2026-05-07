import { type SpawnOptions, spawn } from "node:child_process";
import { z } from "zod";
import { readOhConfig } from "../../harness/config.js";
import { wrapForSandbox } from "../../harness/sandbox-runtime.js";
import type { Tool, ToolResult } from "../../Tool.js";
import { safeEnv } from "../../utils/safe-env.js";

const inputSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().optional(),
  run_in_background: z.boolean().optional(),
});

const MAX_OUTPUT = 100_000;
const _DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

export const BashTool: Tool<typeof inputSchema> = {
  name: "Bash",
  description: "Execute a shell command and return its output.",
  inputSchema,
  riskLevel: "high",

  isReadOnly() {
    return false;
  },

  isConcurrencySafe() {
    return false;
  },

  async call(input, context): Promise<ToolResult> {
    // input.timeout is in seconds; convert to ms. Default 120s.
    const timeoutMs = Math.min((input.timeout ?? 120) * 1000, MAX_TIMEOUT);
    const isWin = process.platform === "win32";

    // Optional OS-level sandbox via @anthropic-ai/sandbox-runtime. Returns null
    // when disabled / on Windows / when the optional dep isn't installed —
    // caller falls back to the existing unsandboxed spawn unchanged.
    const sandboxCfg = readOhConfig()?.sandbox;
    const wrappedCommand = sandboxCfg ? await wrapForSandbox(input.command, sandboxCfg) : null;

    let shell: string;
    let shellArgs: string[];
    let extraSpawnOpts: SpawnOptions = {};
    if (wrappedCommand) {
      // sandbox-runtime returns a shell-string. Pin the shell to /bin/bash so
      // the surrounding command syntax (heredocs, $((...)) etc.) keeps working
      // — `shell: true` would default to /bin/sh on Linux.
      shell = wrappedCommand;
      shellArgs = [];
      extraSpawnOpts = { shell: "/bin/bash" };
    } else {
      shell = isWin ? "cmd.exe" : "/bin/bash";
      shellArgs = isWin ? ["/c", input.command] : ["-c", input.command];
    }

    // Background execution: spawn and return immediately
    if (input.run_in_background) {
      const bgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const proc = spawn(shell, shellArgs, {
        cwd: context.workingDir,
        env: safeEnv(context.sessionId ? { OH_SESSION_ID: context.sessionId } : undefined),
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        ...extraSpawnOpts,
      });

      let stdout = "";
      let stderr = "";

      // stdio is fixed to ["ignore", "pipe", "pipe"] above, so stdout/stderr
      // are always streams. Adding `...extraSpawnOpts` widens the spawn
      // overload's return type to potentially-null pipes; assert non-null.
      proc.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
      }, timeoutMs);

      if (context.abortSignal) {
        context.abortSignal.addEventListener("abort", () => {
          proc.kill("SIGTERM");
        });
      }

      proc.on("close", (code) => {
        clearTimeout(timer);
        let output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        if (output.length > MAX_OUTPUT) {
          output = `${output.slice(0, MAX_OUTPUT)}\n... [truncated]`;
        }
        // Notify via output chunk when background process completes
        if (context.onOutputChunk && context.callId) {
          context.onOutputChunk(context.callId, `\n[background:${bgId} completed, exit code ${code}]\n${output}`);
        }
      });

      return Promise.resolve({
        output: `Background process started (id: ${bgId}, pid: ${proc.pid}). You will be notified when it completes.`,
        isError: false,
      });
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const proc = spawn(shell, shellArgs, {
        cwd: context.workingDir,
        env: safeEnv(context.sessionId ? { OH_SESSION_ID: context.sessionId } : undefined),
        stdio: ["ignore", "pipe", "pipe"],
        ...extraSpawnOpts,
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
      }, timeoutMs);

      // stdio: ["ignore", "pipe", "pipe"] is set above — pipes are always
      // present here; the spread of extraSpawnOpts just widens the return
      // type. Non-null asserts are safe.
      proc.stdout!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (context.onOutputChunk && context.callId) {
          context.onOutputChunk(context.callId, text);
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (context.onOutputChunk && context.callId) {
          context.onOutputChunk(context.callId, text);
        }
      });

      if (context.abortSignal) {
        context.abortSignal.addEventListener("abort", () => {
          proc.kill("SIGTERM");
        });
      }

      proc.on("close", (code) => {
        clearTimeout(timer);
        let output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        if (output.length > MAX_OUTPUT) {
          output = `${output.slice(0, MAX_OUTPUT)}\n... [truncated]`;
        }
        if (killed) {
          output += "\n[timed out]";
        }
        resolve({
          output: output || `(exit code ${code})`,
          isError: code !== 0,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ output: `Error spawning process: ${err.message}`, isError: true });
      });
    });
  },

  prompt() {
    return `Execute a bash command and return stdout/stderr. Parameters:
- command (string, required): The shell command to run.
- description (string, optional): A human-readable description of what the command does.
- timeout (number, optional): Timeout in seconds (default 120, max 600).
- run_in_background (boolean, optional): Run the command in the background. Returns immediately with a process ID. You will be notified when it completes.
Output is truncated at 100K characters.`;
  },
};
