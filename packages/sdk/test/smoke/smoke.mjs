// End-to-end smoke test against a real `oh` binary + a real LLM (Ollama).
// Run from repo root with:  node packages/sdk/test/smoke/smoke.mjs
//
// What this verifies vs. what it deliberately does NOT:
//
// VERIFIES (SDK plumbing + cross-turn context):
//   - PR1: subprocess spawn, stream-json parse, typed events, exit-0 path
//   - PR2: stateful session — multi-turn context preserved across send()s
//          (the Ollama-num_ctx fix in #61 makes this reliable now)
//   - PR3: tools-runtime writes a correct mcpServers entry, MCP server is up
//   - PR4: tools-runtime writes a correct hooks.permissionRequest entry,
//          permission server is up
//   - PR5: argv assembly carries --resume + --setting-sources (unit-tested)
//
// DOES NOT VERIFY (out of scope; CLI behavior, not SDK):
//   - Whether the model decides to call a custom tool
//     (depends on model capability + prompt; flaky for small Ollama models)
//   - End-to-end canUseTool firing through `oh run`
//     (CLI gap — permissionRequest hook only fires in interactive TUI mode,
//     src/query/tools.ts:64 — issue #62)
//   - End-to-end resume= round-trip
//     (CLI gap — fresh `oh session` does not emit a sessionId,
//     src/main.tsx:447 + 416 — issue #60)
//
// Set OH_BINARY or OH_SMOKE_MODEL to override defaults. Exits 0 on all-pass.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");

const ohBinary = process.env.OH_BINARY ?? path.join(repoRoot, "dist", "main.js");
const model = process.env.OH_SMOKE_MODEL ?? "ollama/qwen2.5:7b-instruct";

const sdkRoot = path.join(repoRoot, "packages", "sdk");
const { query, OpenHarnessClient, tool } = await import(`file://${path.join(sdkRoot, "src", "index.ts")}`);
const { prepareToolsRuntime } = await import(`file://${path.join(sdkRoot, "src", "internal", "tools-runtime.ts")}`);
const { parse } = await import("yaml");
const { z } = await import("zod");

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(name, false, message.split("\n")[0]);
  }
}

// ── PR 1: query() against a real CLI + LLM ──
await step("v0.1 query() streams events and exits 0", async () => {
  const events = [];
  for await (const e of query("Reply with exactly the word 'pong'.", {
    ohBinary,
    model,
    permissionMode: "trust",
    maxTurns: 1,
  })) {
    events.push(e);
  }
  const types = new Set(events.map((e) => e.type));
  if (events.length === 0) throw new Error("no events received");
  if (!types.has("turn_complete")) throw new Error(`missing turn_complete: ${[...types].join(",")}`);
  if (!types.has("text")) throw new Error("no text events from model");
  return `${events.length} events, types=${[...types].sort().join(",")}`;
});

// ── PR 2: OpenHarnessClient — multi-turn context preserved across send()s ──
await step("v0.2 OpenHarnessClient preserves multi-turn context", async () => {
  const client = new OpenHarnessClient({ ohBinary, model, permissionMode: "trust", maxTurns: 1 });
  try {
    await client.start();
    let firstText = "";
    for await (const e of client.send("My favorite color is teal. Reply with just the word 'noted'.")) {
      if (e.type === "text") firstText += e.content;
    }
    let secondText = "";
    for await (const e of client.send("What color did I just tell you? Reply with one word only.")) {
      if (e.type === "text") secondText += e.content;
    }
    if (!secondText.toLowerCase().includes("teal")) {
      throw new Error(`second turn did not recall 'teal' — got: ${JSON.stringify(secondText.slice(0, 80))}`);
    }
    return `first='${firstText.trim().slice(0, 30)}', recall ok`;
  } finally {
    await client.close();
  }
});

// ── PR 3: tools-runtime writes correct mcpServers entry, server is reachable ──
await step("v0.3 tools-runtime injects an mcpServers entry pointing at a live server", async () => {
  const echo = tool({
    name: "echo",
    inputSchema: z.object({ msg: z.string() }),
    handler: ({ msg }) => msg,
  });
  const runtime = await prepareToolsRuntime({ tools: [echo] });
  try {
    const cfgPath = path.join(runtime.cwd, ".oh", "config.yaml");
    if (!existsSync(cfgPath)) throw new Error("no config.yaml written");
    const cfg = parse(readFileSync(cfgPath, "utf8"));
    const entry = cfg.mcpServers?.[0];
    if (!entry || entry.type !== "http") throw new Error(`bad mcpServers entry: ${JSON.stringify(entry)}`);
    const res = await fetch(entry.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
      }),
    });
    if (!res.ok) throw new Error(`MCP HTTP server returned ${res.status}`);
    return `entry=${entry.url}, server initialized ok`;
  } finally {
    await runtime.close();
  }
});

// ── PR 4: tools-runtime writes correct permissionRequest hook + server up ──
await step("v0.4 tools-runtime injects a permissionRequest hook pointing at a live server", async () => {
  const runtime = await prepareToolsRuntime({ canUseTool: () => "deny" });
  try {
    const cfgPath = path.join(runtime.cwd, ".oh", "config.yaml");
    const cfg = parse(readFileSync(cfgPath, "utf8"));
    const hookEntry = cfg.hooks?.permissionRequest?.[0];
    if (!hookEntry || typeof hookEntry.http !== "string") {
      throw new Error(`bad hooks.permissionRequest entry: ${JSON.stringify(hookEntry)}`);
    }
    const res = await fetch(hookEntry.http, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "permissionRequest", toolName: "Bash", toolInputJson: "{}" }),
    });
    if (!res.ok) throw new Error(`permission HTTP server returned ${res.status}`);
    const body = await res.json();
    if (body.decision !== "deny") throw new Error(`expected deny, got ${JSON.stringify(body)}`);
    return `entry=${hookEntry.http}, server returned ${JSON.stringify(body)}`;
  } finally {
    await runtime.close();
  }
});

// ── PR 5: argv carries --resume + --setting-sources (unit-tested at the SDK level) ──
await step("v0.5 buildArgv threads resume + settingSources", async () => {
  const { buildArgv } = await import(`file://${path.join(sdkRoot, "src", "query.ts")}`);
  const argv = buildArgv("hi", { resume: "abc-123", settingSources: ["user", "project"] });
  const i = argv.indexOf("--resume");
  if (i < 0 || argv[i + 1] !== "abc-123") throw new Error(`--resume not threaded: ${argv.join(" ")}`);
  const j = argv.indexOf("--setting-sources");
  if (j < 0 || argv[j + 1] !== "user,project") throw new Error(`--setting-sources not threaded: ${argv.join(" ")}`);
  return `--resume abc-123 --setting-sources user,project`;
});

console.log("\n--- known CLI gaps (filed) ---");
console.log("• #60 — `oh session` does not emit a sessionId for fresh sessions (blocks programmatic resume).");
console.log("• #62 — `permissionRequest` hooks only fire in interactive TUI mode (blocks end-to-end canUseTool through oh run).");
console.log("• (#61 fixed in this branch — Ollama num_ctx now sized to actual prompt; multi-turn works.)");

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length === 0 ? 0 : 1);
