#!/usr/bin/env node
/**
 * Test shim that emulates the `oh` CLI's stream-json output for both `oh run`
 * (single-shot) and `oh session` (long-lived) modes.
 *
 * For `oh run`, behaviour is controlled by the `OH_SHIM_SCENARIO` env var.
 * For `oh session`, the shim reads `{id, prompt}` JSON lines on stdin and
 * replies with id-tagged events, terminated by `turn_complete`. The
 * `OH_SHIM_SESSION_SCENARIO` env var picks the response shape.
 *
 * `oh run` scenarios:
 *   - happy            (default) — text + tool_start + tool_end + cost_update + turn_complete, exit 0
 *   - exit-nonzero     emits one error event, then exits 7 with a stderr line
 *   - partial-lines    emits a single line in chunks split mid-content (via setTimeout)
 *   - mixed-junk       interleaves valid JSON with non-JSON garbage; exit 0
 *   - hang             emits one event then sleeps until killed; used for early-break tests
 *   - unknown-type     emits one event with an unrecognised `type` field; exit 0
 *
 * `oh session` scenarios:
 *   - happy            (default) — emits ready, then echoes each prompt as text + turn_complete
 *   - slow             same as happy but each event is delayed 30 ms — used to test send() serialization
 *   - die-on-second    emits one full response, then exits 1 in the middle of the second prompt
 *   - never-ready      sleeps forever without emitting ready (used to test start() timeout)
 */

"use strict";

const readline = require("node:readline");
const { setTimeout: delay } = require("node:timers/promises");

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const subcommand = process.argv[2];

if (subcommand === "session") {
  runSession().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(99);
  });
} else {
  runOnce().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
      process.exit(99);
    },
  );
}

async function runOnce() {
  const scenario = process.env.OH_SHIM_SCENARIO || "happy";
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

async function runSession() {
  const scenario = process.env.OH_SHIM_SESSION_SCENARIO || "happy";
  if (scenario === "never-ready") {
    await delay(60_000);
    return;
  }
  emit({ type: "ready", sessionId: "shim-session-abc" });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let promptCount = 0;
  let exitRequested = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (cmd && cmd.command === "exit") {
      exitRequested = true;
      break;
    }
    if (typeof cmd?.id !== "string" || typeof cmd?.prompt !== "string") continue;
    promptCount += 1;

    if (scenario === "die-on-second" && promptCount === 2) {
      emit({ id: cmd.id, type: "text", content: "starting second…" });
      await delay(20);
      process.stderr.write("fatal: simulated mid-turn crash\n");
      process.exit(1);
    }

    const events = [
      { id: cmd.id, type: "text", content: `echo: ${cmd.prompt}` },
      { id: cmd.id, type: "turn_complete", reason: "completed" },
    ];
    for (const ev of events) {
      if (scenario === "slow") await delay(30);
      emit(ev);
    }
  }

  if (!exitRequested) {
    process.exit(0);
  }
}
