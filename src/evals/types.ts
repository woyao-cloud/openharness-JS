/**
 * oh evals — type definitions for the eval harness.
 *
 * Schema mirrors SWE-bench's evaluation contract so packs of cherry-picked
 * SWE-bench Lite instances drop in unmodified. Our `EvalsResult` is a
 * superset of SWE-bench's `results.json` per-instance shape, with cost,
 * turns, duration, and transcript-path enrichments.
 */

export type EvalsTask = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  hints_text?: string;
};

export type EvalsPack = {
  name: string;
  version: string;
  description: string;
  language: "python" | "javascript" | "typescript" | "polyglot";
  runner_requirements: string[];
  default_test_command: string;
  instance_count: number;
  compatible_with?: string;
};

export type EvalsStatus = "resolved" | "failed" | "error" | "timeout" | "budget_exceeded" | "skipped";

export type TestsStatus = {
  FAIL_TO_PASS: { success: string[]; failure: string[] };
  PASS_TO_PASS: { success: string[]; failure: string[] };
};

export type EvalsResult = {
  instance_id: string;
  status: EvalsStatus;
  resolved: boolean;
  cost_usd: number;
  turns_used: number;
  duration_ms: number;
  model_patch: string;
  tests_status: TestsStatus;
  transcript_path: string;
  error_message?: string;
  started_at: string;
  finished_at: string;
};

export type RunArtifacts = {
  run_id: string;
  pack: string;
  pack_version: string;
  model: string;
  harness_version: string;
  started_at: string;
  finished_at: string;
  total_cost_usd: number;
  max_cost_usd: number;
  total_duration_ms: number;
  resolved: number;
  failed: number;
  error: number;
  timeout: number;
  budget_exceeded: number;
  skipped: number;
  pass_rate: number;
  partial: boolean;
  results: EvalsResult[];
};
