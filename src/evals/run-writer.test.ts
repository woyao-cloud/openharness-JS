import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunWriter } from "./run-writer.js";
import type { EvalsResult } from "./types.js";

function makeRunDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-evals-run-"));
}

const sampleResult: EvalsResult = {
  instance_id: "x__y-1",
  status: "resolved",
  resolved: true,
  cost_usd: 0.42,
  turns_used: 14,
  duration_ms: 138_000,
  model_patch: "diff --git a/foo b/foo\n+bar\n",
  tests_status: {
    FAIL_TO_PASS: { success: ["m.test_bug"], failure: [] },
    PASS_TO_PASS: { success: ["m.test_other"], failure: [] },
  },
  transcript_path: "transcripts/x__y-1.jsonl",
  started_at: "2026-05-05T14:30:00Z",
  finished_at: "2026-05-05T14:32:18Z",
};

test("RunWriter appends one result and writes valid jsonl", () => {
  const dir = makeRunDir();
  try {
    const w = new RunWriter(dir, {
      run_id: "2026-05-05T14-30-00",
      pack: "swe-bench-lite-mini",
      pack_version: "1",
      model: "claude-sonnet-4-6",
      harness_version: "2.40.0",
      max_cost_usd: 5,
      started_at: "2026-05-05T14:30:00Z",
    });
    w.appendResult(sampleResult);

    const lines = readFileSync(join(dir, "results.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.instance_id, "x__y-1");
    assert.equal(parsed.cost_usd, 0.42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunWriter updates predictions.json on every appendResult", () => {
  const dir = makeRunDir();
  try {
    const w = new RunWriter(dir, {
      run_id: "r",
      pack: "p",
      pack_version: "1",
      model: "claude-sonnet-4-6",
      harness_version: "2.40.0",
      max_cost_usd: 5,
      started_at: "2026-05-05T14:30:00Z",
    });
    w.appendResult(sampleResult);
    w.appendResult({ ...sampleResult, instance_id: "x__y-2", model_patch: "diff2" });

    const preds = JSON.parse(readFileSync(join(dir, "predictions.json"), "utf-8"));
    assert.equal(preds.length, 2);
    assert.equal(preds[0].instance_id, "x__y-1");
    assert.equal(preds[0].model_patch, "diff --git a/foo b/foo\n+bar\n");
    assert.equal(preds[0].model_name_or_path, "claude-sonnet-4-6");
    assert.equal(preds[1].instance_id, "x__y-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize writes results.json with correct aggregates", () => {
  const dir = makeRunDir();
  try {
    const w = new RunWriter(dir, {
      run_id: "r",
      pack: "p",
      pack_version: "1",
      model: "claude-sonnet-4-6",
      harness_version: "2.40.0",
      max_cost_usd: 5,
      started_at: "2026-05-05T14:30:00Z",
    });
    w.appendResult({
      ...sampleResult,
      instance_id: "i1",
      status: "resolved",
      resolved: true,
      cost_usd: 0.5,
      duration_ms: 1000,
    });
    w.appendResult({
      ...sampleResult,
      instance_id: "i2",
      status: "failed",
      resolved: false,
      cost_usd: 0.3,
      duration_ms: 2000,
    });
    w.appendResult({
      ...sampleResult,
      instance_id: "i3",
      status: "budget_exceeded",
      resolved: false,
      cost_usd: 1.0,
      duration_ms: 500,
    });
    const a = w.finalize({ partial: false, finished_at: "2026-05-05T14:35:00Z" });
    assert.equal(a.resolved, 1);
    assert.equal(a.failed, 1);
    assert.equal(a.budget_exceeded, 1);
    assert.equal(a.total_cost_usd, 1.8);
    assert.equal(a.total_duration_ms, 3500);
    assert.equal(a.pass_rate, 0.5); // 1 resolved / (1 resolved + 1 failed + 0 error + 0 timeout)

    const onDisk = JSON.parse(readFileSync(join(dir, "results.json"), "utf-8"));
    assert.equal(onDisk.resolved, 1);
    assert.equal(onDisk.results.length, 3);
    assert.equal(onDisk.partial, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadExistingResults reads back appended results (resume scenario)", () => {
  const dir = makeRunDir();
  try {
    const w = new RunWriter(dir, {
      run_id: "r",
      pack: "p",
      pack_version: "1",
      model: "m",
      harness_version: "2.40.0",
      max_cost_usd: 5,
      started_at: "2026-05-05T14:30:00Z",
    });
    w.appendResult({ ...sampleResult, instance_id: "i1" });
    w.appendResult({ ...sampleResult, instance_id: "i2" });

    // Simulate crash: instantiate a fresh writer over the same dir.
    const w2 = new RunWriter(dir, {
      run_id: "r",
      pack: "p",
      pack_version: "1",
      model: "m",
      harness_version: "2.40.0",
      max_cost_usd: 5,
      started_at: "2026-05-05T14:30:00Z",
    });
    const prior = w2.loadExistingResults();
    assert.equal(prior.length, 2);
    assert.equal(prior[0].instance_id, "i1");
    assert.equal(prior[1].instance_id, "i2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize pass_rate = 0 when no completed tasks", () => {
  const dir = makeRunDir();
  try {
    const w = new RunWriter(dir, {
      run_id: "r",
      pack: "p",
      pack_version: "1",
      model: "m",
      harness_version: "2.40.0",
      max_cost_usd: 5,
      started_at: "2026-05-05T14:30:00Z",
    });
    const a = w.finalize({ partial: true, finished_at: "2026-05-05T14:30:00Z" });
    assert.equal(a.pass_rate, 0);
    assert.equal(a.partial, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
