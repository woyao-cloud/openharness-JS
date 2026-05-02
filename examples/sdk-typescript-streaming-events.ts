/**
 * sdk-typescript-streaming-events.ts — Stream events from the TypeScript SDK
 * and surface them as a structured run summary.
 *
 * Demonstrates consuming the full event stream from `query()`: text deltas,
 * tool start/end pairs, cost updates, and the session id (useful for resuming
 * a session later via the OpenHarnessClient API).
 *
 * Prerequisites:
 *   npm install @zhijiewang/openharness-sdk
 *   npm install -g @zhijiewang/openharness     # provides the `oh` binary
 *   Ollama running locally (default) OR an API key in env
 *
 * Run:
 *   npx tsx sdk-typescript-streaming-events.ts "list the largest files in src/"
 *
 * Output:
 *   - Live: streaming assistant text to stdout
 *   - On completion: a one-line summary (tool count, total cost, session id)
 */

import { query } from "@zhijiewang/openharness-sdk";

async function main(): Promise<void> {
  const prompt = process.argv[2] ?? "What's in this directory? Just list top-level entries.";

  let textChars = 0;
  let toolCalls = 0;
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sessionId: string | null = null;
  const toolCounts = new Map<string, number>();

  for await (const event of query(prompt, {
    model: process.env.OH_MODEL ?? "ollama/qwen2.5:7b",
    permissionMode: "trust",
    maxTurns: 5,
  })) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.content);
        textChars += event.content.length;
        break;
      case "tool_start":
        toolCalls++;
        toolCounts.set(event.tool, (toolCounts.get(event.tool) ?? 0) + 1);
        break;
      case "tool_end":
        if (event.error) console.error(`\n[warn] tool ${event.tool} ended with error`);
        break;
      case "cost_update":
        totalCost = event.cost;
        totalInputTokens = event.inputTokens;
        totalOutputTokens = event.outputTokens;
        break;
      case "session_start":
        sessionId = event.sessionId;
        break;
      case "error":
        console.error(`\n[error] ${event.message}`);
        process.exit(1);
    }
  }

  // Per-run summary
  console.log("\n");
  console.log("─".repeat(60));
  console.log(`text chars: ${textChars}`);
  console.log(`tool calls: ${toolCalls}`);
  if (toolCounts.size > 0) {
    const breakdown = [...toolCounts].map(([t, n]) => `${t}×${n}`).join(", ");
    console.log(`  ${breakdown}`);
  }
  console.log(`tokens:     ${totalInputTokens}↑ ${totalOutputTokens}↓`);
  console.log(`cost:       $${totalCost.toFixed(4)}`);
  if (sessionId) {
    console.log(`session:    ${sessionId}`);
    console.log(`            (resume with: OpenHarnessClient({ resume: "${sessionId}" }))`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
