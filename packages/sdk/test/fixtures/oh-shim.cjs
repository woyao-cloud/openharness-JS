#!/usr/bin/env node
/**
 * Test shim that emulates `oh run --output-format stream-json`. Behaviour is
 * controlled by the `OH_SHIM_SCENARIO` env var. When unset, emits a small,
 * happy-path stream and exits 0.
 *
 * Scenarios:
 *   - happy            (default) — text + tool_start + tool_end + cost_update + turn_complete, exit 0
 *   - exit-nonzero     emits one error event, then exits 7 with a stderr line
 *   - partial-lines    emits a single line in chunks split mid-content (via setTimeout)
 *   - mixed-junk       interleaves valid JSON with non-JSON garbage; exit 0
 *   - hang             emits one event then sleeps until killed; used for early-break tests
 *   - unknown-type     emits one event with an unrecognised `type` field; exit 0
 */

"use strict";

const { setTimeout: delay } = require("node:timers/promises");

const scenario = process.env.OH_SHIM_SCENARIO || "happy";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  switch (scenario) {
    case "happy":
      emit({ type: "text", content: "Hello " });
      emit({ type: "text", content: "world" });
      emit({ type: "tool_start", tool: "Read" });
      emit({ type: "tool_end", tool: "Read", output: "ok", error: false });
      emit({
        type: "cost_update",
        inputTokens: 12,
        outputTokens: 5,
        cost: 0.000123,
        model: "ollama/llama3",
      });
      emit({ type: "turn_complete", reason: "completed" });
      return 0;

    case "exit-nonzero":
      emit({ type: "error", message: "boom" });
      process.stderr.write("fatal: provider request failed\n");
      return 7;

    case "partial-lines": {
      // Write the first event as two chunks split inside the JSON body, then
      // write a second event normally. The splitter must reassemble the line.
      const first = JSON.stringify({ type: "text", content: "split-payload" });
      process.stdout.write(first.slice(0, 5));
      await delay(20);
      process.stdout.write(first.slice(5) + "\n");
      emit({ type: "turn_complete", reason: "completed" });
      return 0;
    }

    case "mixed-junk":
      process.stdout.write("not json at all\n");
      emit({ type: "text", content: "valid" });
      process.stdout.write("\n");
      process.stdout.write("[ also bad\n");
      emit({ type: "turn_complete", reason: "completed" });
      return 0;

    case "hang":
      emit({ type: "text", content: "I will hang now" });
      // Sleep up to 60s; the test should have killed us long before.
      await delay(60_000);
      return 0;

    case "unknown-type":
      emit({ type: "future_event_v3", someField: 42 });
      emit({ type: "turn_complete", reason: "completed" });
      return 0;

    default:
      process.stderr.write("unknown scenario: " + scenario + "\n");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(99);
  },
);
