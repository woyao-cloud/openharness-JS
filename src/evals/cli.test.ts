import assert from "node:assert/strict";
import test from "node:test";
import { renderResultsTable } from "./cli.js";
import type { RunArtifacts } from "./types.js";

const sampleArtifacts: RunArtifacts = {
  run_id: "2026-05-05T14-30-00",
  pack: "swe-bench-lite-mini",
  pack_version: "1",
  model: "claude-sonnet-4-6",
  harness_version: "2.40.0",
  started_at: "2026-05-05T14:30:00Z",
  finished_at: "2026-05-05T14:35:00Z",
  total_cost_usd: 0.91,
  max_cost_usd: 5,
  total_duration_ms: 300_000,
  resolved: 1,
  failed: 1,
  error: 0,
  timeout: 0,
  budget_exceeded: 0,
  skipped: 0,
  pass_rate: 0.5,
  partial: false,
  results: [
    {
      instance_id: "django__django-12345",
      status: "resolved",
      resolved: true,
      cost_usd: 0.42,
      turns_used: 14,
      duration_ms: 138_000,
      model_patch: "",
      tests_status: {
        FAIL_TO_PASS: { success: ["t.a"], failure: [] },
        PASS_TO_PASS: { success: ["t.b"], failure: [] },
      },
      transcript_path: "",
      started_at: "",
      finished_at: "",
    },
    {
      instance_id: "pytest-dev__pytest-67890",
      status: "failed",
      resolved: false,
      cost_usd: 0.49,
      turns_used: 20,
      duration_ms: 162_000,
      model_patch: "",
      tests_status: {
        FAIL_TO_PASS: { success: [], failure: ["t.c"] },
        PASS_TO_PASS: { success: ["t.d"], failure: [] },
      },
      transcript_path: "",
      started_at: "",
      finished_at: "",
    },
  ],
};

test("renderResultsTable produces non-empty plain string", () => {
  const s = renderResultsTable(sampleArtifacts);
  assert.equal(typeof s, "string");
  assert.ok(s.length > 0);
});

test("renderResultsTable contains both instance_ids", () => {
  const s = renderResultsTable(sampleArtifacts);
  assert.ok(s.includes("django__django-12345"));
  assert.ok(s.includes("pytest-dev__pytest-67890"));
});

test("renderResultsTable shows 1/2 resolved (50.0%)", () => {
  const s = renderResultsTable(sampleArtifacts);
  assert.ok(/1\/2 resolved/.test(s));
  assert.ok(/50\.0%/.test(s));
});

test("renderResultsTable shows total cost", () => {
  const s = renderResultsTable(sampleArtifacts);
  assert.ok(s.includes("$0.91"));
});

test("renderResultsTable shows partial banner when artifacts.partial=true", () => {
  const s = renderResultsTable({ ...sampleArtifacts, partial: true });
  assert.ok(/halted/i.test(s) || /partial/i.test(s));
});
