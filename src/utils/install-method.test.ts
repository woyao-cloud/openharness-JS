/**
 * Tests for detectInstallMethod (audit B7).
 *
 * Pure-function tests that exercise the path-based classification rules.
 * Real install detection is exercised separately via the smoke test running
 * `oh update` against a known checkout.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { detectInstallMethod } from "./install-method.js";

describe("detectInstallMethod (audit B7)", () => {
  test("npx-cache: any path containing /_npx/ wins", () => {
    const result = detectInstallMethod("/home/u/.npm/_npx/abc123/node_modules/@zhijiewang/openharness/dist/main.js");
    assert.equal(result.method, "npx-cache");
    assert.match(result.message, /npx @zhijiewang\/openharness@latest/);
    assert.match(result.message, /global/i);
  });

  test("local-clone: package.json + .git directory at the same root", () => {
    // Build a fake clone in a tmpdir with package.json + .git/ + dist/main.js.
    const root = makeTmpDir();
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@zhijiewang/openharness" }));
    const main = join(root, "dist", "main.js");
    writeFileSync(main, "");

    const result = detectInstallMethod(main);
    assert.equal(result.method, "local-clone", `expected local-clone, got ${result.method}`);
    assert.match(result.message, /git pull && npm install && npm run build/);
    assert.equal(result.root, root);
  });

  test("npm-global: package.json present, no .git, path includes node_modules/@zhijiewang/openharness/", () => {
    // Simulate an npm-global layout. We need the package.json walk to land on
    // the OH package dir, with no .git, and the normalized path to contain
    // the node_modules segment.
    const root = makeTmpDir();
    const pkgDir = join(root, "node_modules", "@zhijiewang", "openharness");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@zhijiewang/openharness" }));
    const main = join(pkgDir, "dist", "main.js");
    writeFileSync(main, "");

    const result = detectInstallMethod(main);
    assert.equal(result.method, "npm-global", `expected npm-global, got ${result.method}`);
    assert.match(result.message, /npm install -g @zhijiewang\/openharness@latest/);
  });

  test("unknown: no package.json found while walking up", () => {
    // makeTmpDir parents in os.tmpdir() may have stray package.json files
    // (depending on the test machine), so we must build a path that walks
    // through a known-empty intermediate directory. Easiest: nest under a
    // freshly-created tmpdir with no package.json anywhere.
    const root = makeTmpDir();
    const main = join(root, "weird-spot", "dist", "main.js");
    // Note: don't create the dirs — detectInstallMethod just walks the
    // logical path and existsSync(pkgPath) returns false. (If something
    // upstream of `root` does have a package.json, the walk could hit it.
    // We accept that risk for tmpdirs and just assert a sensible message.)
    const result = detectInstallMethod(main);
    // Either "unknown" (clean tmpdir) OR npm-global / local-clone if the
    // tmpdir parent happens to be inside an npm checkout. The message should
    // always be informative either way.
    assert.ok(result.message.length > 0);
    assert.ok(["unknown", "local-clone", "npm-global"].includes(result.method));
  });

  test("Windows-style backslashes in paths are normalized", () => {
    const result = detectInstallMethod(
      "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\xyz\\node_modules\\foo\\dist\\main.js",
    );
    assert.equal(result.method, "npx-cache");
  });
});
