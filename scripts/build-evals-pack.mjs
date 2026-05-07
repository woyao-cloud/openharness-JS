#!/usr/bin/env node
/**
 * scripts/build-evals-pack.mjs
 *
 * Reusable helper to bake a SWE-bench Lite (or any compatible) instance into
 * a fixture for an `oh evals` pack. Workflow:
 *
 *   1. Download working-tree archive from GitHub (no git history → small tarball).
 *   2. Apply pinned-dep manifest (.oh-evals-pinned-deps.txt) to constrain installs.
 *   3. tar -czf → fixtures/<instance_id>/repo.tar.gz (gzip — built into tar everywhere).
 *   4. Drop a setup.sh that creates a venv, installs pinned deps, makes a base commit.
 *
 * Using the GitHub archive API (working-tree only) keeps fixtures ~10× smaller than
 * a full git clone. All tar operations use relative paths + cwd to avoid GNU tar
 * treating Windows drive letters (C:) as remote hostnames.
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
 * Requires on PATH: tar. Setup.sh additionally needs python3 + pip + bash at run time.
 */

import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
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
  // Download working-tree archive from GitHub (no git history → much smaller)
  const archiveUrl = `https://github.com/${repo}/archive/${baseCommit}.tar.gz`;
  const archivePath = join(tmp, "archive.tar.gz");
  console.log(`Downloading ${archiveUrl} ...`);
  await new Promise((resolve, reject) => {
    function follow(url, depth = 0) {
      if (depth > 5) return reject(new Error("too many redirects"));
      httpsGet(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location, depth + 1);
        } else if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        } else {
          const out = createWriteStream(archivePath);
          res.pipe(out);
          out.on("finish", resolve);
          out.on("error", reject);
        }
      }).on("error", reject);
    }
    follow(archiveUrl);
  });

  // GitHub names the top-level dir {repo_slug}-{sha}, rename to "repo".
  // Use cwd instead of -C flag to avoid GNU tar misreading "C:" as a hostname on Windows.
  execFileSync("tar", ["-xzf", "archive.tar.gz"], { cwd: tmp, stdio: "inherit" });
  const entries = readdirSync(tmp).filter((e) => e !== "archive.tar.gz");
  if (entries.length !== 1) throw new Error(`unexpected extract contents: ${entries}`);
  renameSync(join(tmp, entries[0]), join(tmp, "repo"));

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
  // Write to tmp first (relative path only) to avoid GNU tar treating "C:" as a hostname
  // on Windows when passed absolute paths. Then move with Node's renameSync.
  execFileSync("tar", ["-czf", "repo.tar.gz", "repo"], { cwd: tmp, stdio: "inherit" });
  // renameSync fails cross-device (e.g. C:\Temp → E:\project); use copy+delete instead.
  copyFileSync(join(tmp, "repo.tar.gz"), join(fixtureDir, "repo.tar.gz"));

  writeFileSync(
    join(fixtureDir, "setup.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
# Ensure build tools are available before installing any project.
pip install setuptools wheel --quiet
# Initialise the repo git history BEFORE pip install so setuptools-scm
# can determine the version from the commit/tag.
git -C ./repo init -q
git -C ./repo -c user.email=evals@oh -c user.name=evals add -A
git -C ./repo -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
git -C ./repo tag v0.0.0
# --no-build-isolation uses venv's setuptools directly (avoids Python 3.12 compat
# issues when pip tries to download an isolated build env for old packages).
pip install -e ./repo --quiet --no-deps --no-build-isolation
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet --no-build-isolation
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
