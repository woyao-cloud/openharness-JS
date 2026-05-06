#!/usr/bin/env node
/**
 * scripts/build-evals-pack.mjs
 *
 * Reusable helper to bake a SWE-bench Lite (or any compatible) instance into
 * a fixture for an `oh evals` pack. Workflow:
 *
 *   1. Clone the upstream repo at base_commit into a temp dir.
 *   2. Apply pinned-dep manifest (.oh-evals-pinned-deps.txt) to constrain installs.
 *   3. tar -czf → fixtures/<instance_id>/repo.tar.gz (gzip — built into tar everywhere).
 *   4. Drop a setup.sh that creates a venv, installs pinned deps, makes a base commit.
 *
 * Usage:
 *   node scripts/build-evals-pack.mjs \
 *     --instance-id django__django-12345 \
 *     --repo django/django \
 *     --base-commit deadbeef \
 *     --problem 'fix it ...' \
 *     --fail-to-pass tests.test_x.test_y \
 *     --pass-to-pass tests.test_a.test_b \
 *     --pack data/evals/packs/swe-bench-lite-mini/ \
 *     [--append]
 *
 * Without --append the script prints the JSON line for instances.jsonl on
 * stdout so you can review and paste it manually. With --append it writes
 * the line directly.
 *
 * Requires on PATH: git, tar. Setup.sh additionally needs python3 + pip + bash at run time.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const instanceId = arg("instance-id");
const repo = arg("repo");
const baseCommit = arg("base-commit");
const problem = arg("problem");
const failToPass = (arg("fail-to-pass") ?? "").split(",").filter(Boolean);
const passToPass = (arg("pass-to-pass") ?? "").split(",").filter(Boolean);
const packDir = arg("pack");
const append = flag("append");

if (!instanceId || !repo || !baseCommit || !problem || !packDir) {
  console.error("missing required flag. See file header for usage.");
  process.exit(2);
}

const fixtureDir = join(packDir, "fixtures", instanceId);
mkdirSync(fixtureDir, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), "oh-pack-build-"));
try {
  console.log(`Cloning ${repo} @ ${baseCommit} into ${tmp}/repo ...`);
  execFileSync("git", ["clone", `https://github.com/${repo}.git`, "repo"], {
    cwd: tmp,
    stdio: "inherit",
  });
  execFileSync("git", ["-C", join(tmp, "repo"), "checkout", baseCommit], {
    stdio: "inherit",
  });

  // Optional pinned-deps file: if the pack already has one for this instance, copy it
  // into the cloned repo. Otherwise drop a default that just installs pytest.
  const pinnedSrc = join(packDir, "fixtures", instanceId, "pinned-deps.txt");
  if (existsSync(pinnedSrc)) {
    writeFileSync(
      join(tmp, "repo", ".oh-evals-pinned-deps.txt"),
      readFileSync(pinnedSrc),
    );
  } else {
    writeFileSync(join(tmp, "repo", ".oh-evals-pinned-deps.txt"), "pytest\n");
  }

  console.log(`Building repo.tar.gz ...`);
  execFileSync(
    "tar",
    ["-czf", join(fixtureDir, "repo.tar.gz"), "-C", tmp, "repo"],
    { stdio: "inherit" },
  );

  writeFileSync(
    join(fixtureDir, "setup.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
pip install -e ./repo --quiet --no-deps
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet
cd repo
git -c user.email=evals@oh -c user.name=evals add -A
git -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
`,
  );
  spawnSync("chmod", ["+x", join(fixtureDir, "setup.sh")]);

  const line = JSON.stringify({
    instance_id: instanceId,
    repo,
    base_commit: baseCommit,
    problem_statement: problem,
    FAIL_TO_PASS: failToPass,
    PASS_TO_PASS: passToPass,
  });

  if (append) {
    appendFileSync(join(packDir, "instances.jsonl"), line + "\n");
  }

  console.log(`Done: ${fixtureDir}`);
  console.log(`Instance line:`);
  console.log(line);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
