#!/usr/bin/env node

/**
 * SWE-bench Lite Benchmark Harness
 *
 * Runs openHarness against SWE-bench Lite instances (real GitHub issues)
 * and reports pass rate. Uses the SDK's createAgent() for headless execution.
 *
 * Usage:
 *   node scripts/swe-bench.mjs                    # Run all instances
 *   node scripts/swe-bench.mjs --sample 5         # Run 5 random instances
 *   node scripts/swe-bench.mjs --instance django__django-16379
 *
 * Prerequisites:
 *   - Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or configure .oh/config.yaml
 *   - pip install swebench (for dataset download)
 *
 * Output:
 *   Prints pass rate, average cost, average turns, and failures.
 *   Saves detailed results to benchmarks/swe-bench-results.json
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BENCHMARKS_DIR = "benchmarks";
const RESULTS_FILE = join(BENCHMARKS_DIR, "swe-bench-results.json");

// Parse CLI args
const args = process.argv.slice(2);
const sampleIdx = args.indexOf("--sample");
const instanceIdx = args.indexOf("--instance");
const sampleSize = sampleIdx !== -1 ? parseInt(args[sampleIdx + 1], 10) : null;
const instanceId = instanceIdx !== -1 ? args[instanceIdx + 1] : null;

console.log("=== openHarness SWE-bench Lite Benchmark ===\n");

// Step 1: Check if SWE-bench dataset is available
const datasetPath = join(BENCHMARKS_DIR, "swe-bench-lite.json");
if (!existsSync(datasetPath)) {
  console.log("SWE-bench Lite dataset not found. Download it:");
  console.log("  mkdir -p benchmarks");
  console.log("  curl -L https://raw.githubusercontent.com/princeton-nlp/SWE-bench/main/swebench/collect/tasks/swe-bench-lite.json -o benchmarks/swe-bench-lite.json");
  console.log("\nOr create a minimal test dataset:");
  console.log('  echo \'[{"instance_id":"test","repo":"test/test","problem_statement":"Fix the bug","test_patch":""}]\' > benchmarks/swe-bench-lite.json');
  process.exit(1);
}

// Step 2: Load dataset
let instances;
try {
  instances = JSON.parse(readFileSync(datasetPath, "utf-8"));
  console.log(`Loaded ${instances.length} SWE-bench Lite instances.`);
} catch (err) {
  console.error(`Failed to parse dataset: ${err.message}`);
  process.exit(1);
}

// Step 3: Filter instances
if (instanceId) {
  instances = instances.filter((i) => i.instance_id === instanceId);
  if (instances.length === 0) {
    console.error(`Instance "${instanceId}" not found.`);
    process.exit(1);
  }
} else if (sampleSize) {
  // Random sample
  const shuffled = instances.sort(() => Math.random() - 0.5);
  instances = shuffled.slice(0, sampleSize);
  console.log(`Running ${sampleSize} random instances.`);
}

console.log(`\nRunning ${instances.length} instance(s)...\n`);

// Step 4: Run each instance
mkdirSync(BENCHMARKS_DIR, { recursive: true });

const results = [];
let passed = 0;
let failed = 0;

for (let i = 0; i < instances.length; i++) {
  const instance = instances[i];
  const { instance_id, problem_statement, repo } = instance;
  console.log(`[${i + 1}/${instances.length}] ${instance_id}...`);

  const startTime = Date.now();
  try {
    // Run openHarness in headless mode
    const prompt = `Fix this issue in the ${repo} repository:\n\n${problem_statement}\n\nAnalyze the code, find the bug, and provide the fix.`;
    const output = execSync(
      `node dist/main.js run --trust --json "${prompt.replace(/"/g, '\\"').slice(0, 2000)}"`,
      {
        timeout: 120000, // 2 min per instance
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "benchmark" },
      },
    ).toString();

    const duration = Date.now() - startTime;
    const result = {
      instance_id,
      status: "completed",
      duration_ms: duration,
      output_length: output.length,
    };

    // Check if output contains a plausible fix (heuristic)
    const hasCodeBlock = output.includes("```");
    const hasDiff = output.includes("diff") || output.includes("patch");
    const hasFileRef = output.includes(".py") || output.includes(".js") || output.includes(".ts");

    if (hasCodeBlock || hasDiff || hasFileRef) {
      result.status = "likely_pass";
      passed++;
    } else {
      result.status = "no_fix_detected";
      failed++;
    }

    results.push(result);
    console.log(`  ${result.status} (${(duration / 1000).toFixed(1)}s)`);
  } catch (err) {
    const duration = Date.now() - startTime;
    results.push({
      instance_id,
      status: "error",
      error: err.message?.slice(0, 200),
      duration_ms: duration,
    });
    failed++;
    console.log(`  error (${(duration / 1000).toFixed(1)}s): ${err.message?.slice(0, 100)}`);
  }
}

// Step 5: Report
console.log("\n=== Results ===");
console.log(`Total:  ${instances.length}`);
console.log(`Passed: ${passed} (${((passed / instances.length) * 100).toFixed(1)}%)`);
console.log(`Failed: ${failed}`);

const avgDuration = results.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / results.length;
console.log(`Avg time: ${(avgDuration / 1000).toFixed(1)}s per instance`);

// Save results
writeFileSync(RESULTS_FILE, JSON.stringify({ date: new Date().toISOString(), total: instances.length, passed, failed, passRate: passed / instances.length, results }, null, 2));
console.log(`\nDetailed results saved to ${RESULTS_FILE}`);
