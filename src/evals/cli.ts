/**
 * oh evals — CLI surface and terminal table renderer.
 *
 * Three subcommands: run, list-packs, show.
 * Terminal output: ANSI-colored Unicode-tabular layout matching the project's
 * existing /traces table style.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { RunOrchestrator } from "./orchestrator.js";
import { listAvailablePacks, loadPack, resolvePackDir } from "./pack-loader.js";
import type { EvalsResult, RunArtifacts } from "./types.js";

const STATUS_GLYPH: Record<EvalsResult["status"], string> = {
  resolved: "✓",
  failed: "✗",
  error: "⚠",
  timeout: "⏱",
  budget_exceeded: "$",
  skipped: "⊘",
};

export function renderResultsTable(artifacts: RunArtifacts): string {
  const lines: string[] = [];
  lines.push(`=== oh evals — ${artifacts.pack} ===`);
  lines.push("");
  lines.push(`  pass  task${" ".repeat(34)}turns  cost      time     note`);
  for (const r of artifacts.results) {
    const glyph = STATUS_GLYPH[r.status];
    const taskCol = r.instance_id.padEnd(38).slice(0, 38);
    const turnsCol = String(r.turns_used).padStart(5);
    const costCol = `$${r.cost_usd.toFixed(2)}`.padStart(8);
    const timeCol = formatDuration(r.duration_ms).padStart(8);
    const note = r.status === "resolved" || r.status === "failed" ? "" : statusNote(r);
    lines.push(`  ${glyph}     ${taskCol} ${turnsCol}  ${costCol}  ${timeCol}  ${note}`);
  }
  lines.push("");
  const denom = artifacts.resolved + artifacts.failed + artifacts.error + artifacts.timeout;
  const pct = denom === 0 ? "0.0" : (artifacts.pass_rate * 100).toFixed(1);
  lines.push(
    `  ${artifacts.resolved}/${denom} resolved (${pct}%) — total $${artifacts.total_cost_usd.toFixed(2)} — ${formatDuration(artifacts.total_duration_ms)} elapsed`,
  );
  if (artifacts.partial) {
    lines.push(
      `  ⚠ run halted at task ${artifacts.results.length} — total cost cap of $${artifacts.max_cost_usd} reached`,
    );
  }
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function statusNote(r: EvalsResult): string {
  switch (r.status) {
    case "error":
      return r.error_message ? r.error_message.slice(0, 40) : "error";
    case "timeout":
      return "timeout";
    case "budget_exceeded":
      return "budget_exceeded";
    case "skipped":
      return r.error_message ? r.error_message.slice(0, 40) : "skipped";
    default:
      return "";
  }
}

export function defaultOutputDir(): string {
  return join(homedir(), ".oh", "evals", "runs");
}

export function newRunDir(): string {
  const ts = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return join(defaultOutputDir(), ts);
}

export function listRunDirs(): string[] {
  const dir = defaultOutputDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => existsSync(join(dir, entry, "results.json")))
    .sort()
    .reverse();
}

export function loadRunArtifacts(runDir: string): RunArtifacts {
  return JSON.parse(readFileSync(join(runDir, "results.json"), "utf-8")) as RunArtifacts;
}

/**
 * Register the `oh evals` subcommand group on the root Commander program.
 *
 * Mounted from src/main.tsx alongside other top-level groups (auth, project,
 * etc.).
 */
export function registerEvalsCommand(program: Command): void {
  const evalsCmd = program.command("evals").description("Run eval packs against the agent");

  evalsCmd
    .command("run [pack]", { isDefault: false })
    .description("Run an eval pack (default: swe-bench-lite-mini)")
    .requiredOption("--max-cost-usd <amount>", "REQUIRED. Total cost cap for the run in USD.")
    .option("--max-task-cost-usd <amount>", "Per-task cap (default: max-cost-usd / num_tasks)")
    .option("--max-task-turns <n>", "Per-task tool-use cap", "50")
    .option("--task-timeout <seconds>", "Wall-clock per-task kill in seconds", "600")
    .option("--concurrency <n>", "Parallel subprocess agents", "1")
    .option("--model <model>", "Model under test")
    .option("--fallback-model <model>", "One-shot fallback model")
    .option("--instance <id>", "Run only this instance")
    .option("--sample <n>", "Random N instances")
    .option("--filter <regex>", "Run instances whose instance_id matches the regex")
    .option("--resume <run-id>", "Continue a partial run; skip already-completed instances")
    .option("--json", "Emit run summary as JSON to stdout (still writes files)")
    .option("--output-dir <path>", "Override default ~/.oh/evals/runs/")
    .action(async (packArg: string | undefined, opts: Record<string, string>) => {
      const packName = packArg ?? "swe-bench-lite-mini";
      const packDir = resolvePackDir(packName);
      if (!packDir) {
        console.error(`pack not found: ${packName}`);
        console.error(`available packs: ${listAvailablePacks().join(", ") || "(none)"}`);
        process.exit(2);
      }
      const { pack, tasks: allTasks } = loadPack(packDir);

      // Filter / sample.
      let tasks = allTasks;
      if (opts.instance) {
        tasks = tasks.filter((t) => t.instance_id === opts.instance);
        if (tasks.length === 0) {
          console.error(`instance not found in pack: ${opts.instance}`);
          process.exit(2);
        }
      }
      if (opts.filter) {
        const re = new RegExp(opts.filter);
        tasks = tasks.filter((t) => re.test(t.instance_id));
      }
      if (opts.sample) {
        const n = Number(opts.sample);
        tasks = [...tasks].sort(() => Math.random() - 0.5).slice(0, n);
      }
      if (tasks.length === 0) {
        console.error("no tasks selected after filters");
        process.exit(2);
      }

      const maxCostUsd = Number(opts.maxCostUsd);
      if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        console.error(`--max-cost-usd must be a positive number, got '${opts.maxCostUsd}'`);
        process.exit(2);
      }

      const concurrencyOpt = Math.max(1, Math.min(Number(opts.concurrency), cpus().length));
      const runDir = opts.outputDir
        ? join(opts.outputDir, isoSlug())
        : opts.resume
          ? join(defaultOutputDir(), opts.resume)
          : newRunDir();
      mkdirSync(runDir, { recursive: true });

      const orch = new RunOrchestrator({
        pack,
        packDir,
        tasks,
        model: opts.model ?? "claude-sonnet-4-6",
        fallbackModel: opts.fallbackModel,
        maxCostUsd,
        maxTaskCostUsd: opts.maxTaskCostUsd ? Number(opts.maxTaskCostUsd) : undefined,
        maxTaskTurns: Number(opts.maxTaskTurns),
        taskTimeoutMs: Number(opts.taskTimeout) * 1000,
        concurrency: concurrencyOpt,
        runDir,
        resumeFromRunId: opts.resume,
        onTaskStart: (t) => console.log(`▶ ${t.instance_id}`),
        onTaskComplete: (r) =>
          console.log(
            `  ${STATUS_GLYPH[r.status]} ${r.instance_id} ($${r.cost_usd.toFixed(2)}, ${r.turns_used} turns)`,
          ),
      });

      const stop = () => orch.cancel();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      const artifacts = await orch.run();

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);
      } else {
        console.log("");
        console.log(renderResultsTable(artifacts));
        console.log("");
        console.log(`Detailed:    ${join(runDir, "results.json")}`);
        console.log(`Submittable: ${join(runDir, "predictions.json")}`);
      }
    });

  evalsCmd
    .command("list-packs")
    .description("List bundled and user-installed eval packs")
    .action(() => {
      const packs = listAvailablePacks();
      if (packs.length === 0) {
        console.log("(no packs installed)");
        return;
      }
      for (const p of packs) console.log(p);
    });

  evalsCmd
    .command("show <run-id>")
    .description("Print summary table for a past run from ~/.oh/evals/runs/")
    .action((runId: string) => {
      const dir = join(defaultOutputDir(), runId);
      if (!existsSync(join(dir, "results.json"))) {
        console.error(`run not found: ${runId}`);
        console.error("available runs:");
        for (const r of listRunDirs()) console.error(`  ${r}`);
        process.exit(2);
      }
      console.log(renderResultsTable(loadRunArtifacts(dir)));
    });
}

function isoSlug(): string {
  return new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
}
