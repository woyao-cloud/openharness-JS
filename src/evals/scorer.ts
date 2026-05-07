/**
 * oh evals — scorer.
 *
 * After the agent runs, we score the task by:
 *  (1) Running an oracle script (oracle.sh / oracle.mjs) if one exists in
 *      the fixture dir — exit 0 = pass.
 *  (2) Else running the pack's default test command and parsing the
 *      junit-xml output for FAIL_TO_PASS / PASS_TO_PASS test IDs.
 *
 * Test ID convention matches SWE-bench: "<classname>.<name>".
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalsTask, TestsStatus } from "./types.js";

export type TestOutcome = "pass" | "fail" | "skip";

/**
 * Minimal junit-xml parser. Returns a map of "<classname>.<name>" → outcome.
 *
 * We don't take a full XML parser dependency; pytest's junit-xml is
 * well-formed and simple enough to extract testcase elements with regex.
 */
export function parseJunitXml(xml: string): Record<string, TestOutcome> {
  const out: Record<string, TestOutcome> = {};
  const testcaseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let match: RegExpExecArray | null = testcaseRe.exec(xml);
  while (match !== null) {
    const attrs = match[1];
    const inner = match[2] ?? "";
    const cn = /classname="([^"]*)"/.exec(attrs)?.[1];
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
    if (cn && name) {
      const id = `${cn}.${name}`;
      if (/<failure\b/.test(inner) || /<error\b/.test(inner)) {
        out[id] = "fail";
      } else if (/<skipped\b/.test(inner)) {
        out[id] = "skip";
      } else {
        out[id] = "pass";
      }
    }
    match = testcaseRe.exec(xml);
  }
  return out;
}

export type ScoreResult = {
  resolved: boolean;
  tests_status: TestsStatus;
  oracle_used: boolean;
  error_message?: string;
};

const EMPTY_TESTS_STATUS: TestsStatus = {
  FAIL_TO_PASS: { success: [], failure: [] },
  PASS_TO_PASS: { success: [], failure: [] },
};

export async function scoreTask(args: {
  task: EvalsTask;
  worktreeDir: string;
  fixtureDir: string;
  packDefaultTestCommand: string;
  testTimeoutMs: number;
}): Promise<ScoreResult> {
  const { task, worktreeDir, fixtureDir, packDefaultTestCommand, testTimeoutMs } = args;

  // (1) Oracle escape hatch.
  const oracleSh = join(fixtureDir, "oracle.sh");
  const oracleMjs = join(fixtureDir, "oracle.mjs");
  if (existsSync(oracleSh)) {
    // Invoke /bin/sh explicitly so oracle.sh runs without the execute bit.
    // Files committed from Windows or via writeFileSync default to mode 100644.
    const r =
      process.platform === "win32"
        ? spawnSync(oracleSh, [], {
            cwd: worktreeDir,
            env: { ...process.env, INSTANCE_ID: task.instance_id, WORKTREE_DIR: worktreeDir, FIXTURE_DIR: fixtureDir },
            timeout: testTimeoutMs,
            shell: true,
          })
        : spawnSync("/bin/sh", [oracleSh], {
            cwd: worktreeDir,
            env: { ...process.env, INSTANCE_ID: task.instance_id, WORKTREE_DIR: worktreeDir, FIXTURE_DIR: fixtureDir },
            timeout: testTimeoutMs,
          });
    // Oracle exit code is the pass/fail signal — do NOT set error_message for a clean
    // non-zero exit (that means "test failed", not "scoring errored"). Only flag when
    // the process itself failed to run (killed, spawn error, etc.).
    return {
      resolved: r.status === 0,
      tests_status: EMPTY_TESTS_STATUS,
      oracle_used: true,
      error_message: r.status === null ? `oracle.sh did not exit cleanly: signal=${r.signal}` : undefined,
    };
  }
  if (existsSync(oracleMjs)) {
    const r = spawnSync(process.execPath, [oracleMjs], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        INSTANCE_ID: task.instance_id,
        WORKTREE_DIR: worktreeDir,
        FIXTURE_DIR: fixtureDir,
      },
      timeout: testTimeoutMs,
    });
    return {
      resolved: r.status === 0,
      tests_status: EMPTY_TESTS_STATUS,
      oracle_used: true,
      error_message: r.status === null ? `oracle.mjs did not exit cleanly: signal=${r.signal}` : undefined,
    };
  }

  // (2) Default test command.
  const r = spawnSync(packDefaultTestCommand, {
    cwd: worktreeDir,
    shell: true,
    timeout: testTimeoutMs,
  });

  const xmlPath = join(worktreeDir, ".oh-evals-results.xml");
  if (!existsSync(xmlPath)) {
    return {
      resolved: false,
      tests_status: structuredClone(EMPTY_TESTS_STATUS),
      oracle_used: false,
      error_message: `junit-xml not produced at ${xmlPath} (test command exit ${r.status}). stderr: ${r.stderr?.toString().slice(-500) ?? ""}`,
    };
  }

  const outcomes = parseJunitXml(readFileSync(xmlPath, "utf-8"));
  const tests_status: TestsStatus = {
    FAIL_TO_PASS: { success: [], failure: [] },
    PASS_TO_PASS: { success: [], failure: [] },
  };
  for (const id of task.FAIL_TO_PASS) {
    if (outcomes[id] === "pass") tests_status.FAIL_TO_PASS.success.push(id);
    else tests_status.FAIL_TO_PASS.failure.push(id);
  }
  for (const id of task.PASS_TO_PASS) {
    if (outcomes[id] === "pass") tests_status.PASS_TO_PASS.success.push(id);
    else tests_status.PASS_TO_PASS.failure.push(id);
  }
  const resolved = tests_status.FAIL_TO_PASS.failure.length === 0 && tests_status.PASS_TO_PASS.failure.length === 0;
  return { resolved, tests_status, oracle_used: false };
}
