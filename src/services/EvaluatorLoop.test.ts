/**
 * Tests for EvaluatorLoop — GAN-style Generator→Evaluator adversarial refinement.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RUBRIC,
  type EvaluationRubric,
  EvaluatorLoop,
  type EvaluatorResult,
  formatEvaluatorResult,
} from "./EvaluatorLoop.js";

// ── DEFAULT_RUBRIC tests ──

test("DEFAULT_RUBRIC has criteria that sum to weight 1.0", () => {
  const totalWeight = DEFAULT_RUBRIC.criteria.reduce((sum, c) => sum + c.weight, 0);
  assert.ok(Math.abs(totalWeight - 1.0) < 0.001, `Weights sum to ${totalWeight}, expected 1.0`);
});

test("DEFAULT_RUBRIC has a reasonable passThreshold", () => {
  assert.ok(DEFAULT_RUBRIC.passThreshold >= 0.5);
  assert.ok(DEFAULT_RUBRIC.passThreshold <= 1.0);
});

test("DEFAULT_RUBRIC has 4 criteria", () => {
  assert.equal(DEFAULT_RUBRIC.criteria.length, 4);
});

test("DEFAULT_RUBRIC includes correctness, completeness, quality, safety", () => {
  const names = DEFAULT_RUBRIC.criteria.map((c) => c.name);
  assert.ok(names.includes("correctness"));
  assert.ok(names.includes("completeness"));
  assert.ok(names.includes("quality"));
  assert.ok(names.includes("safety"));
});

// ── formatEvaluatorResult tests ──

test("formatEvaluatorResult shows PASSED for passing result", () => {
  const result: EvaluatorResult = {
    output: "good output",
    scores: [{ criterion: "correctness", score: 0.9, feedback: "Looks correct" }],
    weightedScore: 0.9,
    passed: true,
    iterations: 1,
    refinements: [],
  };
  const formatted = formatEvaluatorResult(result);
  assert.ok(formatted.includes("PASSED"));
  assert.ok(formatted.includes("0.90"));
  assert.ok(formatted.includes("correctness"));
  assert.ok(formatted.includes("Looks correct"));
  assert.ok(formatted.includes("Iterations: 1"));
});

test("formatEvaluatorResult shows NEEDS IMPROVEMENT for failing result", () => {
  const result: EvaluatorResult = {
    output: "mediocre output",
    scores: [
      { criterion: "correctness", score: 0.4, feedback: "Has bugs" },
      { criterion: "quality", score: 0.3, feedback: "Messy code" },
    ],
    weightedScore: 0.35,
    passed: false,
    iterations: 3,
    refinements: ["Iteration 1: score 0.20 — refining", "Iteration 2: score 0.30 — refining"],
  };
  const formatted = formatEvaluatorResult(result);
  assert.ok(formatted.includes("NEEDS IMPROVEMENT"));
  assert.ok(formatted.includes("0.35"));
  assert.ok(formatted.includes("Has bugs"));
  assert.ok(formatted.includes("Refinements:"));
  assert.ok(formatted.includes("Iteration 1"));
});

test("formatEvaluatorResult omits Refinements section when empty", () => {
  const result: EvaluatorResult = {
    output: "output",
    scores: [],
    weightedScore: 0.8,
    passed: true,
    iterations: 1,
    refinements: [],
  };
  const formatted = formatEvaluatorResult(result);
  assert.ok(!formatted.includes("Refinements:"));
});

// ── EvaluatorLoop constructor ──

test("EvaluatorLoop accepts custom rubric and maxIterations", () => {
  const customRubric: EvaluationRubric = {
    criteria: [{ name: "test", weight: 1.0, description: "test criterion" }],
    passThreshold: 0.5,
  };

  // Mock provider — we just need to verify construction doesn't throw
  const mockProvider = {
    name: "mock",
    stream: async function* () {},
    complete: async () => ({ role: "assistant" as const, content: "[]", uuid: "x", timestamp: 0 }),
    listModels: () => [],
    healthCheck: async () => true,
  };

  const loop = new EvaluatorLoop(mockProvider as any, [], "system prompt", "ask", "model", customRubric, 5);
  assert.ok(loop);
});

// ── Score rendering ──

test("formatEvaluatorResult renders visual score bars", () => {
  const result: EvaluatorResult = {
    output: "output",
    scores: [{ criterion: "quality", score: 0.7, feedback: "Pretty good" }],
    weightedScore: 0.7,
    passed: true,
    iterations: 1,
    refinements: [],
  };
  const formatted = formatEvaluatorResult(result);
  // Should contain block characters for the bar
  assert.ok(formatted.includes("█"));
  assert.ok(formatted.includes("░"));
});
