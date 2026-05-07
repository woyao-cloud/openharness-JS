/**
 * oh evals — run writer.
 *
 * Streams per-task results to disk atomically:
 *  - results.jsonl   : append-only, one EvalsResult per line
 *  - predictions.json: array, rewritten on each append, SWE-bench-submittable
 *  - results.json    : merged + aggregates, written ONLY by finalize()
 *
 * Crash-safety: results.jsonl + predictions.json are valid up to the last
 * successful append. `oh evals run --resume <run_id>` reads results.jsonl
 * to determine completed instance_ids.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalsResult, RunArtifacts } from "./types.js";

export type RunHeader = {
  run_id: string;
  pack: string;
  pack_version: string;
  model: string;
  harness_version: string;
  max_cost_usd: number;
  started_at: string;
};

type Prediction = {
  instance_id: string;
  model_patch: string;
  model_name_or_path: string;
};

export class RunWriter {
  private readonly runDir: string;
  private readonly header: RunHeader;
  private readonly results: EvalsResult[] = [];

  constructor(runDir: string, header: RunHeader) {
    this.runDir = runDir;
    this.header = header;
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(runDir, "transcripts"), { recursive: true });
  }

  appendResult(result: EvalsResult): void {
    this.results.push(result);

    // results.jsonl — append a single line atomically.
    const line = `${JSON.stringify(result)}\n`;
    appendFileSync(join(this.runDir, "results.jsonl"), line);

    // predictions.json — rewrite the array atomically (.tmp → rename).
    const preds: Prediction[] = this.results.map((r) => ({
      instance_id: r.instance_id,
      model_patch: r.model_patch,
      model_name_or_path: this.header.model,
    }));
    const tmp = join(this.runDir, "predictions.json.tmp");
    writeFileSync(tmp, JSON.stringify(preds, null, 2));
    renameSync(tmp, join(this.runDir, "predictions.json"));
  }

  /** Load a result that was written in a prior run into the in-memory array without
   *  re-writing it to disk (used by the resume path so finalize() includes all results). */
  preloadResult(result: EvalsResult): void {
    this.results.push(result);
  }

  loadExistingResults(): EvalsResult[] {
    const path = join(this.runDir, "results.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as EvalsResult);
  }

  finalize(opts: { partial: boolean; finished_at: string }): RunArtifacts {
    const counts: Record<EvalsResult["status"], number> = {
      resolved: 0,
      failed: 0,
      error: 0,
      timeout: 0,
      budget_exceeded: 0,
      skipped: 0,
    };
    let totalCost = 0;
    let totalDuration = 0;
    for (const r of this.results) {
      counts[r.status]++;
      totalCost += r.cost_usd;
      totalDuration += r.duration_ms;
    }
    const denom = counts.resolved + counts.failed + counts.error + counts.timeout;
    const passRate = denom === 0 ? 0 : counts.resolved / denom;

    const artifacts: RunArtifacts = {
      run_id: this.header.run_id,
      pack: this.header.pack,
      pack_version: this.header.pack_version,
      model: this.header.model,
      harness_version: this.header.harness_version,
      started_at: this.header.started_at,
      finished_at: opts.finished_at,
      total_cost_usd: totalCost,
      max_cost_usd: this.header.max_cost_usd,
      total_duration_ms: totalDuration,
      resolved: counts.resolved,
      failed: counts.failed,
      error: counts.error,
      timeout: counts.timeout,
      budget_exceeded: counts.budget_exceeded,
      skipped: counts.skipped,
      pass_rate: passRate,
      partial: opts.partial,
      results: [...this.results],
    };

    const tmp = join(this.runDir, "results.json.tmp");
    writeFileSync(tmp, JSON.stringify(artifacts, null, 2));
    renameSync(tmp, join(this.runDir, "results.json"));
    return artifacts;
  }
}
