/**
 * Tests for the JSON-envelope status line script runner (audit U-B1).
 *
 * Strategy: write small Node helper scripts and exercise the runner
 * against them. `node <script>` works cross-platform without a #!
 * interpreter, mirroring the apiKeyHelper test pattern.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { _resetStatusLineCacheForTest, runStatusLineScript, type StatusLineEnvelope } from "./status-line-script.js";

const sampleEnv: StatusLineEnvelope = {
  model: "claude-sonnet-4-6",
  tokens: { input: 1234, output: 567 },
  cost: 0.05,
  contextPercent: 0.32,
  sessionId: "sess-001",
  cwd: "/tmp/test",
  gitBranch: "main",
};

function makeScript(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return `node ${p.replace(/\\/g, "/")}`;
}

describe("runStatusLineScript (audit U-B1)", () => {
  afterEach(() => _resetStatusLineCacheForTest());

  test("envelope is delivered on stdin and stdout becomes the status line", () => {
    const dir = makeTmpDir();
    const cmd = makeScript(
      dir,
      "echo-model.cjs",
      `let buf = ''; process.stdin.on('data', d => buf += d); process.stdin.on('end', () => { const e = JSON.parse(buf); process.stdout.write('m=' + e.model); });`,
    );
    const out = runStatusLineScript(sampleEnv, { command: cmd });
    assert.equal(out, "m=claude-sonnet-4-6");
  });

  test("multi-line stdout is truncated to the first line", () => {
    const dir = makeTmpDir();
    const cmd = makeScript(
      dir,
      "multi.cjs",
      `console.log('line one'); console.log('line two'); console.log('line three');`,
    );
    const out = runStatusLineScript(sampleEnv, { command: cmd });
    assert.equal(out, "line one");
  });

  test("non-zero exit returns null (caller falls through to template / default)", () => {
    const dir = makeTmpDir();
    const cmd = makeScript(dir, "fail.cjs", `console.log('partial'); process.exit(7);`);
    const out = runStatusLineScript(sampleEnv, { command: cmd });
    assert.equal(out, null);
  });

  test("empty stdout returns null", () => {
    const dir = makeTmpDir();
    const cmd = makeScript(dir, "silent.cjs", ``);
    const out = runStatusLineScript(sampleEnv, { command: cmd });
    assert.equal(out, null);
  });

  test("cache hit: same envelope within refresh window returns cached output", () => {
    const dir = makeTmpDir();
    // Script writes a counter file each invocation; cache hit means counter doesn't change.
    const counterPath = join(dir, "counter.txt").replace(/\\/g, "/");
    const cmd = makeScript(
      dir,
      "counter.cjs",
      `const fs = require('node:fs'); const p = ${JSON.stringify(counterPath)}; let n = 0; try { n = parseInt(fs.readFileSync(p, 'utf8'), 10) || 0; } catch {} n++; fs.writeFileSync(p, String(n)); process.stdout.write('count=' + n);`,
    );
    const out1 = runStatusLineScript(sampleEnv, { command: cmd, refreshMs: 5000 });
    const out2 = runStatusLineScript(sampleEnv, { command: cmd, refreshMs: 5000 });
    assert.equal(out1, "count=1");
    assert.equal(out2, "count=1", "cache hit must not re-spawn");
  });

  test("cache miss when envelope changes (different model)", () => {
    const dir = makeTmpDir();
    const cmd = makeScript(
      dir,
      "echo-model.cjs",
      `let buf = ''; process.stdin.on('data', d => buf += d); process.stdin.on('end', () => { const e = JSON.parse(buf); process.stdout.write('m=' + e.model); });`,
    );
    const a = runStatusLineScript(sampleEnv, { command: cmd, refreshMs: 5000 });
    const b = runStatusLineScript({ ...sampleEnv, model: "gpt-4o" }, { command: cmd, refreshMs: 5000 });
    assert.equal(a, "m=claude-sonnet-4-6");
    assert.equal(b, "m=gpt-4o", "envelope changed → cache miss → re-spawn");
  });

  test("missing command (PATH-not-found) returns null without throwing", () => {
    const out = runStatusLineScript(sampleEnv, { command: "definitely-not-a-real-command-xyz123" });
    assert.equal(out, null);
  });

  test("output is trimmed of leading/trailing whitespace", () => {
    const dir = makeTmpDir();
    const cmd = makeScript(dir, "padded.cjs", `process.stdout.write('   trimmed   \\n');`);
    const out = runStatusLineScript(sampleEnv, { command: cmd });
    assert.equal(out, "trimmed");
  });
});
