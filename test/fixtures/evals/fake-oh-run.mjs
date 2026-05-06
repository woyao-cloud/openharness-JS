#!/usr/bin/env node
/**
 * Test stub used in src/evals/orchestrator.test.ts in place of the real
 * `oh run` subprocess. Reads its behavior from env vars:
 *   FAKE_EXIT_CODE        — exit code (default 0)
 *   FAKE_EXIT_REASON      — text written into the final stream-json event's
 *                           `subtype` field. Use "budget_exceeded" to trigger
 *                           that orchestrator branch.
 *   FAKE_COST_USD         — cost (default 0.10)
 *   FAKE_TURNS            — turns_used (default 5)
 *   FAKE_FINAL_MESSAGE    — final assistant message text (default "ok")
 *   FAKE_HANG_MS          — sleep this many ms before exiting (default 0).
 *                           Used to test --task-timeout.
 *   FAKE_WRITE_FILE_PATH  — if set, write a "fix" line to this file inside
 *                           process.cwd() before exit (lets orchestrator
 *                           pick up a non-empty model_patch via git diff).
 */
const reason = process.env.FAKE_EXIT_REASON ?? "ok";
const cost = Number(process.env.FAKE_COST_USD ?? "0.10");
const turns = Number(process.env.FAKE_TURNS ?? "5");
const finalMsg = process.env.FAKE_FINAL_MESSAGE ?? "ok";
const exitCode = Number(process.env.FAKE_EXIT_CODE ?? "0");
const hangMs = Number(process.env.FAKE_HANG_MS ?? "0");

if (process.env.FAKE_WRITE_FILE_PATH) {
  const fs = await import("node:fs");
  fs.writeFileSync(process.env.FAKE_WRITE_FILE_PATH, "fixed\n");
}

// Emit a few stream-json events.
process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
process.stdout.write(
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalMsg }] } })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: reason,
    duration_ms: 100,
    total_cost_usd: cost,
    num_turns: turns,
    is_error: exitCode !== 0,
    result: finalMsg,
  })}\n`,
);

if (hangMs > 0) {
  await new Promise((r) => setTimeout(r, hangMs));
}
process.exit(exitCode);
