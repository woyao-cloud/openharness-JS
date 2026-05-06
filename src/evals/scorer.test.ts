import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseJunitXml, scoreTask } from "./scorer.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "oh-evals-score-"));
}

const baseTask = {
  instance_id: "x__y-1",
  repo: "x/y",
  base_commit: "deadbeef",
  problem_statement: "fix",
  FAIL_TO_PASS: ["m.test_bug"],
  PASS_TO_PASS: ["m.test_other"],
};

test("parseJunitXml — empty XML returns empty results", () => {
  const xml = `<?xml version="1.0"?><testsuites></testsuites>`;
  assert.deepEqual(parseJunitXml(xml), {});
});

test("parseJunitXml — passing test", () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite>
    <testcase classname="tests.test_a" name="test_one"/>
  </testsuite>
</testsuites>`;
  const got = parseJunitXml(xml);
  assert.equal(got["tests.test_a.test_one"], "pass");
});

test("parseJunitXml — failing test", () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite>
    <testcase classname="tests.test_a" name="test_two">
      <failure message="boom">stack trace here</failure>
    </testcase>
  </testsuite>
</testsuites>`;
  const got = parseJunitXml(xml);
  assert.equal(got["tests.test_a.test_two"], "fail");
});

test("parseJunitXml — errored test counts as fail", () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite>
    <testcase classname="x" name="y">
      <error message="oops"/>
    </testcase>
  </testsuite>
</testsuites>`;
  assert.equal(parseJunitXml(xml)["x.y"], "fail");
});

test("parseJunitXml — skipped test", () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite>
    <testcase classname="x" name="y">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;
  assert.equal(parseJunitXml(xml)["x.y"], "skip");
});

test("parseJunitXml — multiple testcases", () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite>
    <testcase classname="m" name="a"/>
    <testcase classname="m" name="b"><failure/></testcase>
    <testcase classname="m" name="c"/>
  </testsuite>
</testsuites>`;
  const got = parseJunitXml(xml);
  assert.equal(got["m.a"], "pass");
  assert.equal(got["m.b"], "fail");
  assert.equal(got["m.c"], "pass");
});

// oracle.sh requires bash-on-PATH; tested via oracle.mjs on Windows
const skipOracleSh = process.platform === "win32";

test("scoreTask uses oracle.sh when present (exit 0 = resolved)", { skip: skipOracleSh }, async () => {
  const fx = makeTmp();
  const wt = makeTmp();
  try {
    const oracle = join(fx, "oracle.sh");
    writeFileSync(oracle, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(oracle, 0o755);
    const r = await scoreTask({
      task: baseTask,
      worktreeDir: wt,
      fixtureDir: fx,
      packDefaultTestCommand: "false",
      testTimeoutMs: 10000,
    });
    assert.equal(r.resolved, true);
    assert.equal(r.oracle_used, true);
  } finally {
    rmSync(fx, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("scoreTask uses oracle.sh exit non-zero = not resolved", { skip: skipOracleSh }, async () => {
  const fx = makeTmp();
  const wt = makeTmp();
  try {
    const oracle = join(fx, "oracle.sh");
    writeFileSync(oracle, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(oracle, 0o755);
    const r = await scoreTask({
      task: baseTask,
      worktreeDir: wt,
      fixtureDir: fx,
      packDefaultTestCommand: "false",
      testTimeoutMs: 10000,
    });
    assert.equal(r.resolved, false);
    assert.equal(r.oracle_used, true);
  } finally {
    rmSync(fx, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("scoreTask runs default test command when no oracle, all pass = resolved", async () => {
  const fx = makeTmp();
  const wt = makeTmp();
  try {
    // Fake test command: writes a junit-xml where both F2P and P2P pass,
    // then exits 0.
    const xml = `<?xml version="1.0"?><testsuites><testsuite>
      <testcase classname="m" name="test_bug"/>
      <testcase classname="m" name="test_other"/>
    </testsuite></testsuites>`;
    const xmlPath = join(wt, ".oh-evals-results.xml");
    writeFileSync(xmlPath, xml);
    const cmd = process.platform === "win32" ? `cmd /c exit /b 0` : `true`;

    const r = await scoreTask({
      task: baseTask,
      worktreeDir: wt,
      fixtureDir: fx,
      packDefaultTestCommand: cmd,
      testTimeoutMs: 10000,
    });
    assert.equal(r.resolved, true);
    assert.equal(r.oracle_used, false);
    assert.deepEqual(r.tests_status.FAIL_TO_PASS.success, ["m.test_bug"]);
    assert.deepEqual(r.tests_status.PASS_TO_PASS.success, ["m.test_other"]);
  } finally {
    rmSync(fx, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("scoreTask — F2P fail makes resolved false even if P2P passes", async () => {
  const fx = makeTmp();
  const wt = makeTmp();
  try {
    const xml = `<?xml version="1.0"?><testsuites><testsuite>
      <testcase classname="m" name="test_bug"><failure/></testcase>
      <testcase classname="m" name="test_other"/>
    </testsuite></testsuites>`;
    writeFileSync(join(wt, ".oh-evals-results.xml"), xml);
    const cmd = process.platform === "win32" ? `cmd /c exit /b 0` : `true`;
    const r = await scoreTask({
      task: baseTask,
      worktreeDir: wt,
      fixtureDir: fx,
      packDefaultTestCommand: cmd,
      testTimeoutMs: 10000,
    });
    assert.equal(r.resolved, false);
    assert.deepEqual(r.tests_status.FAIL_TO_PASS.failure, ["m.test_bug"]);
  } finally {
    rmSync(fx, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("scoreTask — missing junit xml = error_message set", async () => {
  const fx = makeTmp();
  const wt = makeTmp();
  try {
    const cmd = process.platform === "win32" ? `cmd /c exit /b 0` : `true`;
    const r = await scoreTask({
      task: baseTask,
      worktreeDir: wt,
      fixtureDir: fx,
      packDefaultTestCommand: cmd,
      testTimeoutMs: 10000,
    });
    assert.equal(r.resolved, false);
    assert.ok(r.error_message);
    assert.match(r.error_message!, /junit/);
  } finally {
    rmSync(fx, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
