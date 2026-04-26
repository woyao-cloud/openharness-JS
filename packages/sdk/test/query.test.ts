import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OpenHarnessError } from "../src/errors.js";
import type { Event } from "../src/events.js";
import { buildArgv, query } from "../src/query.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(__dirname, "fixtures", "oh-shim.cjs");

async function runQuery(scenario: string, options: Parameters<typeof query>[1] = {}): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of query("any prompt", {
    ohBinary: SHIM,
    env: { OH_SHIM_SCENARIO: scenario },
    ...options,
  })) {
    events.push(event);
  }
  return events;
}

describe("buildArgv", () => {
  test("includes the prompt, output format, defaulted permission mode, and max turns", () => {
    const argv = buildArgv("hello", {});
    assert.deepEqual(argv, [
      "run",
      "hello",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "trust",
      "--max-turns",
      "20",
    ]);
  });

  test("threads model, system prompt, and tool allow/deny lists", () => {
    const argv = buildArgv("hi", {
      model: "ollama/llama3",
      systemPrompt: "be terse",
      allowedTools: ["Read", "Glob"],
      disallowedTools: ["Bash"],
      maxTurns: 3,
      permissionMode: "deny",
    });
    assert.deepEqual(argv, [
      "run",
      "hi",
      "--output-format",
      "stream-json",
      "--model",
      "ollama/llama3",
      "--permission-mode",
      "deny",
      "--allowed-tools",
      "Read,Glob",
      "--disallowed-tools",
      "Bash",
      "--max-turns",
      "3",
      "--system-prompt",
      "be terse",
    ]);
  });

  test("threads resume and settingSources when provided", () => {
    const argv = buildArgv("go", { resume: "sid-9", settingSources: ["user", "project"] });
    assert.ok(argv.includes("--resume"));
    assert.equal(argv[argv.indexOf("--resume") + 1], "sid-9");
    assert.ok(argv.includes("--setting-sources"));
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "user,project");
  });

  test("omits resume + settingSources flags when not set", () => {
    const argv = buildArgv("go", {});
    assert.equal(argv.includes("--resume"), false);
    assert.equal(argv.includes("--setting-sources"), false);
  });

  test("omits --setting-sources when the array is explicitly empty", () => {
    const argv = buildArgv("go", { settingSources: [] });
    assert.equal(argv.includes("--setting-sources"), false);
  });
});

describe("query()", () => {
  test("happy path: yields all events and exits cleanly", async () => {
    const events = await runQuery("happy");
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "text",
      "text",
      "tool_start",
      "tool_end",
      "cost_update",
      "turn_complete",
    ]);
    const cost = events.find((e) => e.type === "cost_update");
    assert.equal(cost?.type, "cost_update");
    if (cost?.type === "cost_update") {
      assert.equal(cost.inputTokens, 12);
      assert.equal(cost.model, "ollama/llama3");
    }
  });

  test("non-zero exit throws OpenHarnessError carrying stderr and exitCode", async () => {
    let caught: unknown;
    try {
      await runQuery("exit-nonzero");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof OpenHarnessError, "expected OpenHarnessError");
    if (caught instanceof OpenHarnessError) {
      assert.equal(caught.exitCode, 7);
      assert.match(caught.stderr ?? "", /provider request failed/);
    }
  });

  test("reassembles JSON split across stdout chunks", async () => {
    const events = await runQuery("partial-lines");
    assert.deepEqual(events.map((e) => e.type), ["text", "turn_complete"]);
    const text = events[0];
    if (text.type === "text") assert.equal(text.content, "split-payload");
  });

  test("non-JSON noise on stdout is silently skipped", async () => {
    const events = await runQuery("mixed-junk");
    assert.deepEqual(events.map((e) => e.type), ["text", "turn_complete"]);
  });

  test("unrecognised event types surface as UnknownEvent", async () => {
    const events = await runQuery("unknown-type");
    assert.equal(events[0].type, "unknown");
    if (events[0].type === "unknown") assert.equal(events[0].raw.type, "future_event_v3");
  });

  test("breaking out of the iterator early terminates the subprocess", async () => {
    let count = 0;
    const start = Date.now();
    for await (const event of query("any prompt", {
      ohBinary: SHIM,
      env: { OH_SHIM_SCENARIO: "hang" },
    })) {
      count += 1;
      void event;
      break;
    }
    const elapsed = Date.now() - start;
    assert.equal(count, 1);
    // The shim sleeps 60 s; we should be back in well under that.
    assert.ok(elapsed < 10_000, `early-break should not block on subprocess: took ${elapsed}ms`);
  });
});
