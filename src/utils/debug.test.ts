/**
 * Tests for the categorized debug logger (audit A5).
 *
 * Covers parsing, gating, file-sink, and env-var fallback. Real stderr writes
 * are exercised via an injected `sink: PassThrough` so we don't pollute
 * test output.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { _resetDebugForTest, configureDebug, debug, isDebugEnabled, parseDebugCategories } from "./debug.js";

function captureSink(): { sink: PassThrough; lines: () => string[]; raw: () => string } {
  const sink = new PassThrough();
  let buf = "";
  sink.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
  });
  // `lines()` counts only header lines (`[debug:...]` prefixes) so multi-line
  // payloads (Error stacks) don't inflate the per-call count.
  return {
    sink,
    raw: () => buf,
    lines: () => (buf.match(/^\[debug:/gm) ?? []).map((_, i) => `entry ${i + 1}`),
  };
}

describe("parseDebugCategories", () => {
  test("undefined / empty / false → no categories", () => {
    assert.equal(parseDebugCategories(undefined).size, 0);
    assert.equal(parseDebugCategories("").size, 0);
    assert.equal(parseDebugCategories(false).size, 0);
  });

  test("true / '*' / 'all' / '1' → wildcard", () => {
    for (const v of [true, "*", "all", "ALL", "true", "1"] as Array<string | boolean>) {
      const cats = parseDebugCategories(v);
      assert.equal(cats.has("*"), true, `expected wildcard for ${JSON.stringify(v)}`);
    }
  });

  test("comma-separated list trims whitespace and drops empties", () => {
    const cats = parseDebugCategories("mcp, hooks ,, provider");
    assert.deepEqual([...cats].sort(), ["hooks", "mcp", "provider"]);
  });
});

describe("configureDebug + debug + isDebugEnabled", () => {
  beforeEach(() => {
    delete process.env.OH_DEBUG;
    delete process.env.OH_DEBUG_FILE;
    _resetDebugForTest();
  });
  afterEach(() => {
    delete process.env.OH_DEBUG;
    delete process.env.OH_DEBUG_FILE;
    _resetDebugForTest();
  });

  test("disabled by default — debug() is a no-op", () => {
    const { sink, lines } = captureSink();
    configureDebug({ sink });
    debug("mcp", "should not appear");
    assert.equal(lines().length, 0);
    assert.equal(isDebugEnabled("mcp"), false);
  });

  test("explicit category gates emission", () => {
    const { sink, lines, raw } = captureSink();
    configureDebug({ categories: "mcp", sink });
    debug("mcp", "shown");
    debug("hooks", "hidden");
    assert.equal(lines().length, 1);
    assert.match(raw(), /\[debug:mcp\] \+\d+ms shown/);
    assert.equal(raw().includes("hidden"), false);
  });

  test("wildcard enables every category", () => {
    const { sink, lines } = captureSink();
    configureDebug({ categories: true, sink });
    debug("mcp", "a");
    debug("hooks", "b");
    debug("anything", "c");
    assert.equal(lines().length, 3);
  });

  test("OH_DEBUG env var is the fallback when --debug isn't passed", () => {
    process.env.OH_DEBUG = "session";
    const { sink, lines, raw } = captureSink();
    configureDebug({ sink });
    debug("session", "from env");
    debug("mcp", "ignored");
    assert.equal(lines().length, 1);
    assert.match(raw(), /from env/);
  });

  test("explicit categories override OH_DEBUG", () => {
    process.env.OH_DEBUG = "session";
    const { sink, lines, raw } = captureSink();
    configureDebug({ categories: "mcp", sink });
    debug("session", "should be hidden");
    debug("mcp", "wins");
    assert.equal(lines().length, 1);
    assert.match(raw(), /wins/);
    assert.equal(raw().includes("should be hidden"), false);
  });

  test("non-string args are JSON-stringified; Errors keep their stack", () => {
    const { sink, lines, raw } = captureSink();
    configureDebug({ categories: true, sink });
    debug("mcp", { tool: "Read" }, ["a", "b"], 42);
    debug("mcp", new Error("boom"));
    // Two emit calls → two header lines (Error stacks span multiple newlines
    // but still belong to the second entry).
    assert.equal(lines().length, 2);
    assert.match(raw(), /\{"tool":"Read"\} \["a","b"\] 42/);
    assert.match(raw(), /Error: boom/);
  });

  test("--debug-file appends to a file (synchronously, no flush race)", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "debug.log");
    configureDebug({ categories: "mcp", file });
    debug("mcp", "first line");
    debug("hooks", "ignored");
    debug("mcp", "second line");
    // Synchronous appendFileSync — file is on disk before debug() returns,
    // so we can read it without resetting first.
    const body = readFileSync(file, "utf8");
    assert.match(body, /first line/);
    assert.match(body, /second line/);
    assert.equal(body.includes("ignored"), false);
  });

  test("a second configureDebug call replaces prior state", () => {
    const a = captureSink();
    configureDebug({ categories: "mcp", sink: a.sink });
    debug("mcp", "before");
    const b = captureSink();
    configureDebug({ categories: "hooks", sink: b.sink });
    debug("mcp", "should not reach b");
    debug("hooks", "after");
    assert.equal(a.lines().length, 1);
    assert.equal(b.lines().length, 1);
    assert.match(b.raw(), /after/);
    assert.equal(b.raw().includes("should not reach b"), false);
  });
});
