import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunOrchestrator } from "./orchestrator.js";
import type { EvalsPack, EvalsTask } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, "..", "..", "test", "fixtures", "evals", "fake-oh-run.mjs");

function makePackOnDisk(): { dir: string; pack: EvalsPack; tasks: EvalsTask[] } {
  const dir = mkdtempSync(join(tmpdir(), "oh-evals-orch-"));
  const pack: EvalsPack = {
    name: "synth",
    version: "1",
    description: "synthetic test pack",
    language: "javascript",
    runner_requirements: [],
    default_test_command: process.platform === "win32" ? "cmd /c exit /b 0" : "true",
    instance_count: 2,
  };
  const tasks: EvalsTask[] = [
    {
      instance_id: "synth-1",
      repo: "synth/synth",
      base_commit: "x",
      problem_statement: "task 1",
      FAIL_TO_PASS: [],
      PASS_TO_PASS: [],
    },
    {
      instance_id: "synth-2",
      repo: "synth/synth",
      base_commit: "x",
      problem_statement: "task 2",
      FAIL_TO_PASS: [],
      PASS_TO_PASS: [],
    },
  ];
  writeFileSync(join(dir, "pack.json"), JSON.stringify(pack));
  writeFileSync(join(dir, "instances.jsonl"), `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
  for (const t of tasks) {
    const fx = join(dir, "fixtures", t.instance_id);
    mkdirSync(fx, { recursive: true });
    // Empty tarball — orchestrator short-circuits when length === 0.
    writeFileSync(join(fx, "repo.tar.zst"), "");
    // setup.sh inits a git repo with an empty base commit so git diff works after.
    const setup =
      process.platform === "win32"
        ? "git init -q && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m base\r\n"
        : "#!/usr/bin/env bash\nset -e\ngit init -q && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m base\n";
    writeFileSync(join(fx, "setup.sh"), setup);
  }
  return { dir, pack, tasks };
}

test("fake-oh-run stub emits stream-json with cost and turns", () => {
  const r = spawnSync(process.execPath, [STUB], {
    env: { ...process.env, FAKE_COST_USD: "0.42", FAKE_TURNS: "14" },
    encoding: "utf-8",
  });
  assert.equal(r.status, 0);
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  const result = JSON.parse(lines[lines.length - 1]);
  assert.equal(result.type, "result");
  assert.equal(result.total_cost_usd, 0.42);
  assert.equal(result.num_turns, 14);
});

test("fake-oh-run stub honors FAKE_EXIT_REASON=budget_exceeded", () => {
  const r = spawnSync(process.execPath, [STUB], {
    env: { ...process.env, FAKE_EXIT_REASON: "budget_exceeded", FAKE_EXIT_CODE: "1" },
    encoding: "utf-8",
  });
  assert.equal(r.status, 1);
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  const result = JSON.parse(lines[lines.length - 1]);
  assert.equal(result.subtype, "budget_exceeded");
});

test("RunOrchestrator runs all tasks in sequence (concurrency 1)", { timeout: 20000 }, async () => {
  const { dir, pack, tasks } = makePackOnDisk();
  const runDir = mkdtempSync(join(tmpdir(), "oh-evals-rundir-"));
  try {
    const stub = join(here, "..", "..", "test", "fixtures", "evals", "fake-oh-run.mjs");
    const completed: string[] = [];
    const orch = new RunOrchestrator({
      pack,
      packDir: dir,
      tasks,
      model: "fake-model",
      maxCostUsd: 10,
      maxTaskTurns: 5,
      taskTimeoutMs: 10_000,
      concurrency: 1,
      runDir,
      subprocessArgvBuilder: () => ({ exec: process.execPath, args: [stub] }),
      onTaskComplete: (r) => completed.push(r.instance_id),
    });
    const artifacts = await orch.run();
    assert.equal(artifacts.results.length, 2);
    assert.deepEqual(completed, ["synth-1", "synth-2"]);
    assert.equal(artifacts.partial, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("RunOrchestrator halts when total cost exceeds maxCostUsd", { timeout: 20000 }, async () => {
  const { dir, pack, tasks } = makePackOnDisk();
  const runDir = mkdtempSync(join(tmpdir(), "oh-evals-rundir-"));
  try {
    const stub = join(here, "..", "..", "test", "fixtures", "evals", "fake-oh-run.mjs");
    const orch = new RunOrchestrator({
      pack,
      packDir: dir,
      tasks: [...tasks, { ...tasks[0], instance_id: "synth-3" }, { ...tasks[0], instance_id: "synth-4" }],
      model: "fake-model",
      maxCostUsd: 0.25, // each fake task costs 0.10 → halts after 2-3 tasks
      maxTaskTurns: 5,
      taskTimeoutMs: 10_000,
      concurrency: 1,
      runDir,
      subprocessArgvBuilder: () => ({ exec: process.execPath, args: [stub] }),
    });
    const a = await orch.run();
    assert.equal(a.partial, true);
    assert.ok(a.results.length < 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("RunOrchestrator status=budget_exceeded when subprocess exits with that reason", { timeout: 20000 }, async () => {
  const { dir, pack, tasks } = makePackOnDisk();
  const runDir = mkdtempSync(join(tmpdir(), "oh-evals-rundir-"));
  try {
    const stub = join(here, "..", "..", "test", "fixtures", "evals", "fake-oh-run.mjs");
    const orch = new RunOrchestrator({
      pack,
      packDir: dir,
      tasks: [tasks[0]],
      model: "m",
      maxCostUsd: 5,
      maxTaskTurns: 5,
      taskTimeoutMs: 10_000,
      concurrency: 1,
      runDir,
      subprocessArgvBuilder: () => ({ exec: process.execPath, args: [stub] }),
    });
    process.env.FAKE_EXIT_REASON = "budget_exceeded";
    process.env.FAKE_EXIT_CODE = "1";
    try {
      const a = await orch.run();
      const r = a.results[0];
      assert.equal(r.status, "budget_exceeded");
    } finally {
      delete process.env.FAKE_EXIT_REASON;
      delete process.env.FAKE_EXIT_CODE;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("RunOrchestrator timeout SIGKILLs the subprocess and reports status=timeout", { timeout: 20000 }, async () => {
  const { dir, pack, tasks } = makePackOnDisk();
  const runDir = mkdtempSync(join(tmpdir(), "oh-evals-rundir-"));
  try {
    const stub = join(here, "..", "..", "test", "fixtures", "evals", "fake-oh-run.mjs");
    process.env.FAKE_HANG_MS = "10000";
    try {
      const orch = new RunOrchestrator({
        pack,
        packDir: dir,
        tasks: [tasks[0]],
        model: "m",
        maxCostUsd: 5,
        maxTaskTurns: 5,
        taskTimeoutMs: 500,
        concurrency: 1,
        runDir,
        subprocessArgvBuilder: () => ({ exec: process.execPath, args: [stub] }),
      });
      const a = await orch.run();
      assert.equal(a.results[0].status, "timeout");
    } finally {
      delete process.env.FAKE_HANG_MS;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
