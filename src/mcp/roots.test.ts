/**
 * Tests for the MCP `roots/list` responder (audit B3).
 *
 * The transport-level handler registration is exercised at integration time
 * via the SDK; here we just lock in the pure roots-getter behavior.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { _resetRootsForTest, getRoots, setExtraRoots } from "./roots.js";

describe("getRoots / setExtraRoots (audit B3)", () => {
  afterEach(() => _resetRootsForTest());

  test("always includes process.cwd() as a file:// URI", () => {
    const roots = getRoots();
    assert.ok(roots.length >= 1);
    assert.match(roots[0]!.uri, /^file:\/\//);
    assert.equal(typeof roots[0]!.name, "string");
  });

  test("setExtraRoots adds entries that are deduplicated against cwd", () => {
    setExtraRoots(["/tmp/scratch", "/var/data"]);
    const roots = getRoots();
    assert.equal(roots.length, 3, "cwd + two extras");
    assert.equal(roots.filter((r) => r.uri.includes("scratch")).length, 1);
  });

  test("setExtraRoots replaces (not appends) the prior set", () => {
    // Use distinctive segments that won't collide with the cwd path on any
    // platform (Windows CI's cwd contains "/a" — see the failure on PR #79).
    setExtraRoots(["/oh-test-rep-aaa", "/oh-test-rep-bbb"]);
    assert.equal(getRoots().length, 3);
    setExtraRoots(["/oh-test-rep-ccc"]);
    const roots = getRoots();
    assert.equal(roots.length, 2);
    assert.ok(roots.some((r) => r.uri.includes("oh-test-rep-ccc")));
    assert.equal(
      roots.some((r) => r.uri.includes("oh-test-rep-aaa")),
      false,
      "previous extras should be cleared",
    );
  });

  test("empty array clears extras", () => {
    setExtraRoots(["/a"]);
    setExtraRoots([]);
    const roots = getRoots();
    assert.equal(roots.length, 1, "only cwd remains");
  });

  test("each root has a basename `name` (last path segment)", () => {
    setExtraRoots(["/foo/bar/baz"]);
    const roots = getRoots();
    const last = roots[roots.length - 1]!;
    assert.equal(last.name, "baz");
  });

  test("duplicate extras are deduped within the same call", () => {
    // Distinctive segment so the substring match isn't confused by the cwd
    // path (e.g. Windows CI's "/a/openharness/openharness").
    setExtraRoots(["/oh-test-dup-zzz", "/oh-test-dup-zzz", "/oh-test-dup-zzz"]);
    const roots = getRoots();
    const matches = roots.filter((r) => r.uri.includes("oh-test-dup-zzz"));
    assert.equal(matches.length, 1);
  });
});
