/**
 * oh evals — run orchestrator.
 *
 * Coordinates the full run lifecycle:
 *   - manages a concurrency pool of N parallel task workers
 *   - per task: extract repo tarball → setup.sh → spawn `oh run` subprocess
 *     → tee stdout to transcript file + parse stream-json → git diff →
 *     scoreTask → RunWriter.appendResult → cleanup worktree
 *   - aggregates total cost; halts scheduling when total >= max_cost_usd
 *   - resumability: skip instance_ids already in results.jsonl
 *   - cancellation: cancel() sets flag, SIGTERMs running subs, then SIGKILL
 *
 * Subprocess command (no --working-dir flag — we use spawn's cwd option):
 *   node dist/main.js run --bare --output-format stream-json
 *     --no-session-persistence --max-budget-usd <cap> --max-turns <n>
 *     --model <model> "<problem_statement>"
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync as nodeRmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isGitRepo, removeWorktree } from "../git/index.js";
import { RunWriter } from "./run-writer.js";
import { scoreTask } from "./scorer.js";
import type { EvalsPack, EvalsResult, EvalsTask, RunArtifacts } from "./types.js";

export type OrchestratorOptions = {
  pack: EvalsPack;
  packDir: string;
  tasks: EvalsTask[];
  model: string;
  fallbackModel?: string;
  maxCostUsd: number;
  maxTaskCostUsd?: number;
  maxTaskTurns: number;
  taskTimeoutMs: number;
  concurrency: number;
  runDir: string;
  resumeFromRunId?: string;
  /** Path to dist/main.js. Default = resolved from package root. Overridable for tests. */
  ohEntry?: string;
  /** Override the subprocess executable (default: process.execPath). Tests use the fake-oh-run stub. */
  subprocessExec?: string;
  /** Override the args (default = the `oh run` arg list). Tests use ["<stub>"]. */
  subprocessArgvBuilder?: (task: EvalsTask, opts: TaskSpawnOpts) => { exec: string; args: string[] };
  onTaskStart?: (task: EvalsTask) => void;
  onTaskComplete?: (result: EvalsResult) => void;
};

export type TaskSpawnOpts = {
  worktreeDir: string;
  perTaskCostCap: number;
  maxTurns: number;
  model: string;
};

export class RunOrchestrator {
  private readonly opts: OrchestratorOptions;
  private readonly writer: RunWriter;
  private readonly perTaskCap: number;
  private cancelled = false;
  private halted = false;
  private totalCost = 0;
  private readonly running = new Set<ChildProcess>();
  private readonly skipIds = new Set<string>();

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.perTaskCap = opts.maxTaskCostUsd ?? opts.maxCostUsd / Math.max(1, opts.tasks.length);

    const harnessVersion = readHarnessVersion();
    this.writer = new RunWriter(opts.runDir, {
      run_id: pathBaseName(opts.runDir),
      pack: opts.pack.name,
      pack_version: opts.pack.version,
      model: opts.model,
      harness_version: harnessVersion,
      max_cost_usd: opts.maxCostUsd,
      started_at: new Date().toISOString(),
    });

    if (opts.resumeFromRunId) {
      const prior = this.writer.loadExistingResults();
      for (const r of prior) {
        this.skipIds.add(r.instance_id);
        this.totalCost += r.cost_usd;
        this.writer.preloadResult(r);
      }
    }
  }

  cancel(): void {
    this.cancelled = true;
    for (const child of this.running) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
  }

  async run(): Promise<RunArtifacts> {
    const queue = this.opts.tasks.filter((t) => !this.skipIds.has(t.instance_id));
    let nextIndex = 0;
    const concurrency = Math.max(1, this.opts.concurrency);

    const worker = async () => {
      while (!this.cancelled && !this.halted) {
        if (this.totalCost >= this.opts.maxCostUsd) {
          this.halted = true;
          break;
        }
        const idx = nextIndex++;
        if (idx >= queue.length) break;
        const task = queue[idx];

        this.opts.onTaskStart?.(task);
        const result = await this.runOneTask(task);
        this.totalCost += result.cost_usd;
        this.writer.appendResult(result);
        this.opts.onTaskComplete?.(result);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    return this.writer.finalize({
      partial: this.cancelled || this.halted,
      finished_at: new Date().toISOString(),
    });
  }

  private async runOneTask(task: EvalsTask): Promise<EvalsResult> {
    const startedAt = new Date();
    const start = Date.now();

    const taskWorktreeBase = join(this.opts.runDir, "worktrees", task.instance_id);
    mkdirSync(taskWorktreeBase, { recursive: true });

    let worktreePath: string | null = null;
    let usedGitWorktree = false;
    try {
      // 1. Extract fixture into the per-task worktree dir.
      worktreePath = taskWorktreeBase;
      await extractFixture(this.opts.packDir, task.instance_id, worktreePath);

      // 2. Run setup.sh (creates a base commit so we can git diff later).
      const setupOk = await runSetupScript(this.opts.packDir, task.instance_id, worktreePath);
      if (!setupOk.ok) {
        return makeResult({
          task,
          status: "skipped",
          resolved: false,
          cost_usd: 0,
          turns_used: 0,
          duration_ms: Date.now() - start,
          model_patch: "",
          tests_status: emptyTestsStatus(),
          transcript_path: `transcripts/${task.instance_id}.jsonl`,
          error_message: `setup.sh failed: ${setupOk.error}`,
          startedAt,
        });
      }
      usedGitWorktree = isGitRepo(worktreePath);

      // 3. Spawn the subprocess.
      const { exec, args } = this.opts.subprocessArgvBuilder
        ? this.opts.subprocessArgvBuilder(task, {
            worktreeDir: worktreePath,
            perTaskCostCap: this.perTaskCap,
            maxTurns: this.opts.maxTaskTurns,
            model: this.opts.model,
          })
        : {
            exec: process.execPath,
            args: defaultRunArgs({
              ohEntry: this.opts.ohEntry ?? defaultOhEntry(),
              perTaskCostCap: this.perTaskCap,
              maxTurns: this.opts.maxTaskTurns,
              model: this.opts.model,
              fallbackModel: this.opts.fallbackModel,
              prompt: task.problem_statement,
            }),
          };

      const transcriptPath = join(this.opts.runDir, "transcripts", `${task.instance_id}.jsonl`);
      const transcriptStream = createWriteStream(transcriptPath);

      const child = spawn(exec, args, {
        cwd: worktreePath,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.running.add(child);

      // Tee stdout to transcript file + parser.
      let stdoutBuf = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        transcriptStream.write(chunk);
        stdoutBuf += chunk.toString("utf-8");
      });
      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf-8");
      });

      // 4. Race subprocess vs timeout.
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, this.opts.taskTimeoutMs);

      const exitCode: number | null = await new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
      });
      clearTimeout(timeoutHandle);
      this.running.delete(child);
      // Flush the transcript stream before proceeding to cleanup. On Windows,
      // unflushed write streams can keep file handles open, which races with
      // worktree rmSync in the finally block.
      await new Promise<void>((resolve) => {
        transcriptStream.end(() => resolve());
      });

      // 5. Parse stream-json result event.
      const parsed = parseStreamJsonResult(stdoutBuf);

      if (timedOut) {
        return makeResult({
          task,
          status: "timeout",
          resolved: false,
          cost_usd: parsed.cost_usd,
          turns_used: parsed.turns_used,
          duration_ms: Date.now() - start,
          model_patch: usedGitWorktree ? captureGitDiff(worktreePath) : "",
          tests_status: emptyTestsStatus(),
          transcript_path: `transcripts/${task.instance_id}.jsonl`,
          error_message: `task exceeded ${this.opts.taskTimeoutMs}ms timeout`,
          startedAt,
        });
      }

      if (parsed.exit_reason === "budget_exceeded") {
        return makeResult({
          task,
          status: "budget_exceeded",
          resolved: false,
          cost_usd: parsed.cost_usd,
          turns_used: parsed.turns_used,
          duration_ms: Date.now() - start,
          model_patch: usedGitWorktree ? captureGitDiff(worktreePath) : "",
          tests_status: emptyTestsStatus(),
          transcript_path: `transcripts/${task.instance_id}.jsonl`,
          startedAt,
        });
      }

      if (exitCode !== 0) {
        return makeResult({
          task,
          status: "error",
          resolved: false,
          cost_usd: parsed.cost_usd,
          turns_used: parsed.turns_used,
          duration_ms: Date.now() - start,
          model_patch: usedGitWorktree ? captureGitDiff(worktreePath) : "",
          tests_status: emptyTestsStatus(),
          transcript_path: `transcripts/${task.instance_id}.jsonl`,
          error_message: `subprocess exit ${exitCode}: ${stderrBuf.slice(-500)}`,
          startedAt,
        });
      }

      // 6. Capture model_patch.
      const modelPatch = usedGitWorktree ? captureGitDiff(worktreePath) : "";

      // 7. Score.
      const score = await scoreTask({
        task,
        worktreeDir: worktreePath,
        fixtureDir: join(this.opts.packDir, "fixtures", task.instance_id),
        packDefaultTestCommand: this.opts.pack.default_test_command,
        testTimeoutMs: this.opts.taskTimeoutMs,
      });

      const status: EvalsResult["status"] =
        score.error_message !== undefined ? "error" : score.resolved ? "resolved" : "failed";

      return makeResult({
        task,
        status,
        resolved: score.resolved,
        cost_usd: parsed.cost_usd,
        turns_used: parsed.turns_used,
        duration_ms: Date.now() - start,
        model_patch: modelPatch,
        tests_status: score.tests_status,
        transcript_path: `transcripts/${task.instance_id}.jsonl`,
        error_message: score.error_message,
        startedAt,
      });
    } finally {
      // Clean up worktree (best-effort; swallow errors so a leak doesn't stop a run).
      if (worktreePath && existsSync(worktreePath)) {
        try {
          if (usedGitWorktree) removeWorktree(worktreePath);
          // Also remove the temp dir tree under runDir/worktrees/<id> regardless.
          rmSyncIfExists(worktreePath);
        } catch {
          /* swallow */
        }
      }
    }
  }
}

// ── helpers ──

function rmSyncIfExists(p: string): void {
  try {
    nodeRmSync(p, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
}

function emptyTestsStatus(): EvalsResult["tests_status"] {
  return {
    FAIL_TO_PASS: { success: [], failure: [] },
    PASS_TO_PASS: { success: [], failure: [] },
  };
}

function makeResult(args: {
  task: EvalsTask;
  status: EvalsResult["status"];
  resolved: boolean;
  cost_usd: number;
  turns_used: number;
  duration_ms: number;
  model_patch: string;
  tests_status: EvalsResult["tests_status"];
  transcript_path: string;
  error_message?: string;
  startedAt: Date;
}): EvalsResult {
  return {
    instance_id: args.task.instance_id,
    status: args.status,
    resolved: args.resolved,
    cost_usd: args.cost_usd,
    turns_used: args.turns_used,
    duration_ms: args.duration_ms,
    model_patch: args.model_patch,
    tests_status: args.tests_status,
    transcript_path: args.transcript_path,
    error_message: args.error_message,
    started_at: args.startedAt.toISOString(),
    finished_at: new Date().toISOString(),
  };
}

type ParsedStream = {
  cost_usd: number;
  turns_used: number;
  exit_reason: string;
  final_message: string;
};

function parseStreamJsonResult(stdout: string): ParsedStream {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]) as Record<string, unknown>;
      if (evt.type === "result") {
        return {
          cost_usd: Number(evt.total_cost_usd ?? 0),
          turns_used: Number(evt.num_turns ?? 0),
          exit_reason: String(evt.subtype ?? "ok"),
          final_message: String(evt.result ?? ""),
        };
      }
    } catch {
      /* not JSON; skip */
    }
  }
  return { cost_usd: 0, turns_used: 0, exit_reason: "ok", final_message: "" };
}

function captureGitDiff(worktreeDir: string): string {
  try {
    return execFileSync("git", ["-C", worktreeDir, "diff", "HEAD"], { encoding: "utf-8" });
  } catch {
    return "";
  }
}

async function extractFixture(packDir: string, instanceId: string, dest: string): Promise<void> {
  const fxDir = join(packDir, "fixtures", instanceId);
  // Prefer .tar.gz (bundled by gzip — universally available); fall back to
  // .tar.zst for older packs that were built before v2.40.1.
  const candidates: Array<{ path: string; flag: string }> = [
    { path: join(fxDir, "repo.tar.gz"), flag: "-xzf" },
    { path: join(fxDir, "repo.tar.zst"), flag: "" },
  ];
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    if (readFileSync(c.path).length === 0) {
      // Empty tarball = test mode (synthetic pack). Caller's setup.sh
      // handles initialization; we just ensure the dest dir exists.
      return;
    }
    if (c.flag === "-xzf") {
      execFileSync("tar", ["-xzf", c.path, "-C", dest], { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      // Legacy .tar.zst path: requires the system `zstd` binary on PATH.
      execFileSync("tar", ["--use-compress-program=zstd -d", "-xf", c.path, "-C", dest], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    return;
  }
}

async function runSetupScript(
  packDir: string,
  instanceId: string,
  worktreeDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const setupPath = join(packDir, "fixtures", instanceId, "setup.sh");
  if (!existsSync(setupPath)) return { ok: true }; // No setup needed.
  // Invoke sh explicitly so the script runs without the execute bit (files created
  // programmatically via writeFileSync have no execute bit on Linux). On Windows,
  // fall through to shell:true so cmd.exe handles the POSIX-style content.
  const r =
    process.platform === "win32"
      ? spawnSync(setupPath, [], { cwd: worktreeDir, shell: true, encoding: "utf-8" })
      : spawnSync("/bin/sh", [setupPath], { cwd: worktreeDir, encoding: "utf-8" });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr ?? "").slice(-500) };
  }
  return { ok: true };
}

function defaultOhEntry(): string {
  return join(process.cwd(), "dist", "main.js");
}

function defaultRunArgs(opts: {
  ohEntry: string;
  perTaskCostCap: number;
  maxTurns: number;
  model: string;
  fallbackModel?: string;
  prompt: string;
}): string[] {
  const args = [
    opts.ohEntry,
    "run",
    "--bare",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--max-budget-usd",
    String(opts.perTaskCostCap),
    "--max-turns",
    String(opts.maxTurns),
    "--model",
    opts.model,
  ];
  if (opts.fallbackModel) args.push("--fallback-model", opts.fallbackModel);
  args.push(opts.prompt);
  return args;
}

function readHarnessVersion(): string {
  try {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function pathBaseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}
