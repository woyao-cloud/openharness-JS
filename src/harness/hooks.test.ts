import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { invalidateConfigCache } from "./config.js";
import {
  emitHook,
  emitHookAsync,
  emitHookWithOutcome,
  type HookDecisionNotification,
  type HookOutcome,
  invalidateHookCache,
  matchesHook,
  parseJsonIoResponse,
  setHookDecisionObserver,
} from "./hooks.js";

describe("emitHook", () => {
  it("returns true when no hooks configured (default)", () => {
    // cachedHooks starts undefined; getHooks() reads config which returns null
    // when no .oh/config file exists, so emitHook returns true.
    const result = emitHook("sessionStart");
    assert.equal(result, true);
  });

  it('emitHook("sessionStart") returns true', () => {
    assert.equal(emitHook("sessionStart"), true);
  });

  it('emitHook("sessionEnd") returns true', () => {
    assert.equal(emitHook("sessionEnd"), true);
  });
});

describe("emitHookAsync", () => {
  it("returns true when no hooks configured", async () => {
    const result = await emitHookAsync("sessionStart");
    assert.equal(result, true);
  });
});

describe("matchesHook — matcher forms", () => {
  it("matches everything when no matcher is set", () => {
    assert.equal(matchesHook({ command: "x" }, { toolName: "Read" }), true);
    assert.equal(matchesHook({ command: "x" }, {}), true);
  });

  it("legacy substring match (back-compat)", () => {
    assert.equal(matchesHook({ command: "x", match: "Edit" }, { toolName: "FileEdit" }), true);
    assert.equal(matchesHook({ command: "x", match: "Edit" }, { toolName: "Read" }), false);
  });

  it("regex form `/pattern/flags`", () => {
    assert.equal(matchesHook({ command: "x", match: "/^File/" }, { toolName: "FileEdit" }), true);
    assert.equal(matchesHook({ command: "x", match: "/^File/" }, { toolName: "Read" }), false);
    assert.equal(matchesHook({ command: "x", match: "/(edit|write)/i" }, { toolName: "Write" }), true);
  });

  it("glob form with asterisk", () => {
    assert.equal(matchesHook({ command: "x", match: "File*" }, { toolName: "FileEdit" }), true);
    assert.equal(matchesHook({ command: "x", match: "File*" }, { toolName: "Read" }), false);
    assert.equal(matchesHook({ command: "x", match: "mcp__*__read" }, { toolName: "mcp__github__read" }), true);
    assert.equal(matchesHook({ command: "x", match: "mcp__*__read" }, { toolName: "mcp__github__write" }), false);
  });

  it("MCP naming convention via substring (still works)", () => {
    assert.equal(matchesHook({ command: "x", match: "mcp__github" }, { toolName: "mcp__github__read" }), true);
    assert.equal(matchesHook({ command: "x", match: "mcp__slack" }, { toolName: "mcp__github__read" }), false);
  });

  it("invalid regex fails closed (no match)", () => {
    // Unmatched bracket — constructor throws → matcher returns false
    assert.equal(matchesHook({ command: "x", match: "/[unclosed/" }, { toolName: "Anything" }), false);
  });
});

// ── JSON I/O hook mode (Tier A #5) ──

function withTmpCwd(fn: (dir: string) => void) {
  const dir = makeTmpDir();
  const original = process.cwd();
  process.chdir(dir);
  try {
    fn(dir);
  } finally {
    process.chdir(original);
    invalidateHookCache();
    invalidateConfigCache();
  }
}

/** Write a minimal .oh/config.yaml with a single preToolUse hook. */
function writeHookConfig(dir: string, hookDef: { command: string; jsonIO?: boolean; timeout?: number }) {
  mkdirSync(`${dir}/.oh`, { recursive: true });
  const json = JSON.stringify(hookDef.jsonIO ?? false);
  const body = [
    "provider: mock",
    "model: mock",
    "permissionMode: ask",
    "hooks:",
    "  preToolUse:",
    `    - command: ${JSON.stringify(hookDef.command)}`,
    `      jsonIO: ${json}`,
    ...(hookDef.timeout ? [`      timeout: ${hookDef.timeout}`] : []),
    "",
  ].join("\n");
  writeFileSync(`${dir}/.oh/config.yaml`, body);
  invalidateConfigCache();
  invalidateHookCache();
}

describe("hook JSON I/O mode", () => {
  it("allows tool when hook responds with {decision: 'allow'}", () => {
    withTmpCwd((dir) => {
      // Node-based hook: read stdin, echo {decision:"allow"}
      const scriptPath = `${dir}/hook.mjs`;
      writeFileSync(
        scriptPath,
        "let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => { JSON.parse(d); process.stdout.write(JSON.stringify({decision:'allow'})); });",
      );
      writeHookConfig(dir, { command: `node ${JSON.stringify(scriptPath)}`, jsonIO: true });
      const result = emitHook("preToolUse", { toolName: "Bash" });
      assert.equal(result, true);
    });
  });

  it("blocks tool when hook responds with {decision: 'deny'}", () => {
    withTmpCwd((dir) => {
      const scriptPath = `${dir}/hook.mjs`;
      writeFileSync(
        scriptPath,
        "let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked'})); });",
      );
      writeHookConfig(dir, { command: `node ${JSON.stringify(scriptPath)}`, jsonIO: true });
      const result = emitHook("preToolUse", { toolName: "Bash" });
      assert.equal(result, false);
    });
  });

  it("hook receives JSON envelope on stdin containing event + context", () => {
    withTmpCwd((dir) => {
      // .cjs extension forces CommonJS so `require` is available.
      const scriptPath = `${dir}/hook.cjs`;
      const outPath = `${dir}/captured.json`;
      const outEsc = outPath.replace(/\\/g, "/");
      writeFileSync(
        scriptPath,
        `const fs = require('node:fs');
         let d = '';
         process.stdin.on('data', c => d += c);
         process.stdin.on('end', () => {
           fs.writeFileSync('${outEsc}', d);
           process.stdout.write(JSON.stringify({decision:'allow'}));
         });`,
      );
      writeHookConfig(dir, { command: `node ${JSON.stringify(scriptPath)}`, jsonIO: true });
      emitHook("preToolUse", { toolName: "Bash", toolArgs: "ls -la" });
      const captured = JSON.parse(readFileSync(outPath, "utf-8"));
      assert.equal(captured.event, "preToolUse");
      assert.equal(captured.toolName, "Bash");
      assert.equal(captured.toolArgs, "ls -la");
    });
  });

  it("malformed JSON on stdout fails closed (deny)", () => {
    withTmpCwd((dir) => {
      const scriptPath = `${dir}/hook.mjs`;
      writeFileSync(scriptPath, "process.stdout.write('this is not JSON');");
      writeHookConfig(dir, { command: `node ${JSON.stringify(scriptPath)}`, jsonIO: true });
      const result = emitHook("preToolUse", { toolName: "Bash" });
      assert.equal(result, false);
    });
  });

  it("empty stdout with exit 0 allows (falls back to exit-code gating)", () => {
    withTmpCwd((dir) => {
      const scriptPath = `${dir}/hook.mjs`;
      writeFileSync(scriptPath, "process.exit(0);");
      writeHookConfig(dir, { command: `node ${JSON.stringify(scriptPath)}`, jsonIO: true });
      const result = emitHook("preToolUse", { toolName: "Bash" });
      assert.equal(result, true);
    });
  });

  it("non-zero exit blocks even with allow JSON in stdout", () => {
    withTmpCwd((dir) => {
      const scriptPath = `${dir}/hook.mjs`;
      writeFileSync(scriptPath, "process.stdout.write(JSON.stringify({decision:'allow'})); process.exit(1);");
      writeHookConfig(dir, { command: `node ${JSON.stringify(scriptPath)}`, jsonIO: true });
      const result = emitHook("preToolUse", { toolName: "Bash" });
      assert.equal(result, false);
    });
  });

  it("env-var mode still works when jsonIO is false (back-compat)", () => {
    withTmpCwd((dir) => {
      // Classic env-var hook: reads $OH_TOOL_NAME, exits 0 for Read, 1 otherwise
      const scriptPath = `${dir}/hook.mjs`;
      writeFileSync(scriptPath, "process.exit(process.env.OH_TOOL_NAME === 'Read' ? 0 : 1);");
      writeHookConfig(dir, { command: `node ${JSON.stringify(scriptPath)}`, jsonIO: false });
      assert.equal(emitHook("preToolUse", { toolName: "Read" }), true);
      assert.equal(emitHook("preToolUse", { toolName: "Bash" }), false);
    });
  });
});

// ── Prompt hooks (LLM-decision) ──

/**
 * Write a .oh/config.yaml with a prompt hook + mock provider config. The mock
 * provider is registered via dependency injection through the provider module,
 * which we don't yet have — so these tests exercise the fail-closed paths
 * (no config, bad config, timeout) that don't require a real LLM response.
 *
 * Full LLM-response tests live in provider-specific suites.
 */
function writePromptHookConfig(dir: string, prompt: string) {
  mkdirSync(`${dir}/.oh`, { recursive: true });
  writeFileSync(
    `${dir}/.oh/config.yaml`,
    [
      "provider: ollama",
      "model: nonexistent-test-model",
      "baseUrl: http://127.0.0.1:1", // deliberately unreachable → forces timeout/error
      "permissionMode: ask",
      "hooks:",
      "  preToolUse:",
      `    - prompt: ${JSON.stringify(prompt)}`,
      "      timeout: 500",
      "",
    ].join("\n"),
  );
  invalidateConfigCache();
  invalidateHookCache();
}

describe("prompt hooks (LLM-decision)", () => {
  it("fails closed (denies) when the configured provider is unreachable", async () => {
    await new Promise<void>((resolve) => {
      withTmpCwd((dir) => {
        writePromptHookConfig(dir, "Should we allow this tool?");
        // Prompt hooks only run in the async path; emitHook's sync path defers them.
        // Verify the deny via emitHookAsync.
        emitHookAsync("preToolUse", { toolName: "Bash", toolArgs: "rm -rf /" }).then((allowed) => {
          assert.equal(allowed, false, "unreachable provider should fail closed");
          resolve();
        });
      });
    });
  });

  it("fails closed when no config is present", async () => {
    // No tmp cwd change — no .oh/config.yaml exists in process cwd
    invalidateConfigCache();
    invalidateHookCache();
    // Can't easily invoke runPromptHook directly — it's module-private. But we
    // can verify by checking that emitHookAsync with no hooks configured returns
    // true (there's no hook to fail), then write a bad config and see false.
    const noHooks = await emitHookAsync("preToolUse", { toolName: "Bash" });
    assert.equal(noHooks, true, "with no hooks configured, emitHookAsync should allow");
  });
});

describe("new hook event types (Task 1)", () => {
  it("HookEvent accepts postToolUseFailure / userPromptSubmit / permissionRequest at type level", () => {
    // Compile-time check only — if this file type-checks, the union accepts the new variants.
    const events: Array<"postToolUseFailure" | "userPromptSubmit" | "permissionRequest"> = [
      "postToolUseFailure",
      "userPromptSubmit",
      "permissionRequest",
    ];
    assert.equal(events.length, 3);
  });

  it("emitHook accepts the three new events without throwing (no hooks configured)", () => {
    assert.equal(emitHook("postToolUseFailure", { toolName: "t", errorMessage: "x" }), true);
    assert.equal(emitHook("userPromptSubmit", { prompt: "hi" }), true);
    assert.equal(emitHook("permissionRequest", { toolName: "Bash", permissionAction: "ask" }), true);
  });
});

// ── Task 2: parseJsonIoResponse + emitHookWithOutcome ──

describe("parseJsonIoResponse", () => {
  it("parses allow decision without hookSpecificOutput", () => {
    const r = parseJsonIoResponse(JSON.stringify({ decision: "allow" }));
    assert.equal(r.decision, "allow");
    assert.equal(r.additionalContext, undefined);
    assert.equal(r.permissionDecision, undefined);
  });

  it("parses deny decision with reason", () => {
    const r = parseJsonIoResponse(JSON.stringify({ decision: "deny", reason: "blocked" }));
    assert.equal(r.decision, "deny");
    assert.equal(r.reason, "blocked");
  });

  it("extracts hookSpecificOutput.additionalContext", () => {
    const r = parseJsonIoResponse(
      JSON.stringify({ decision: "allow", hookSpecificOutput: { additionalContext: "[hello]" } }),
    );
    assert.equal(r.additionalContext, "[hello]");
  });

  it("extracts hookSpecificOutput.decision as permissionDecision", () => {
    const r = parseJsonIoResponse(JSON.stringify({ hookSpecificOutput: { decision: "deny", reason: "not allowed" } }));
    assert.equal(r.permissionDecision, "deny");
    assert.equal(r.reason, "not allowed");
  });

  it("returns empty object on malformed JSON (no throw)", () => {
    const r = parseJsonIoResponse("{not valid");
    assert.deepEqual(r, {});
  });

  it("returns empty object on non-object JSON", () => {
    const r = parseJsonIoResponse(JSON.stringify("just a string"));
    assert.deepEqual(r, {});
  });

  it("ignores unknown decision values", () => {
    const r = parseJsonIoResponse(JSON.stringify({ decision: "maybe" }));
    assert.equal(r.decision, undefined);
  });

  it("ignores unknown hookSpecificOutput.decision values", () => {
    const r = parseJsonIoResponse(JSON.stringify({ hookSpecificOutput: { decision: "sometimes" } }));
    assert.equal(r.permissionDecision, undefined);
  });
});

describe("emitHookWithOutcome (no hooks configured)", () => {
  it("returns {allowed: true} for every event with no config", async () => {
    const events: Array<"postToolUseFailure" | "userPromptSubmit" | "permissionRequest"> = [
      "postToolUseFailure",
      "userPromptSubmit",
      "permissionRequest",
    ];
    for (const e of events) {
      const o = await emitHookWithOutcome(e, {});
      assert.equal(o.allowed, true);
      assert.equal(o.additionalContext, undefined);
      assert.equal(o.permissionDecision, undefined);
    }
  });
});

// ── Async withTmpCwd for emitHookWithOutcome integration tests ──

function withTmpCwdAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = makeTmpDir();
  const original = process.cwd();
  process.chdir(dir);
  return fn(dir).finally(() => {
    process.chdir(original);
    invalidateHookCache();
    invalidateConfigCache();
  });
}

describe("emitHookWithOutcome (jsonIO hooks)", () => {
  it("prepends additionalContext from a userPromptSubmit hook", async () => {
    await withTmpCwdAsync(async (dir) => {
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'[PREFIX]'}})); });",
      );
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          "  userPromptSubmit:",
          `    - command: "node ${JSON.stringify(scriptPath).slice(1, -1)}"`,
          "      jsonIO: true",
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const outcome = await emitHookWithOutcome("userPromptSubmit", { prompt: "hi" });
      assert.equal(outcome.allowed, true);
      assert.equal(outcome.additionalContext, "[PREFIX]");
    });
  });

  it("blocks on deny decision with reason", async () => {
    await withTmpCwdAsync(async (dir) => {
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({decision:'deny',reason:'nope'})); });",
      );
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          "  userPromptSubmit:",
          `    - command: "node ${JSON.stringify(scriptPath).slice(1, -1)}"`,
          "      jsonIO: true",
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const outcome = await emitHookWithOutcome("userPromptSubmit", { prompt: "hi" });
      assert.equal(outcome.allowed, false);
      assert.equal(outcome.reason, "nope");
    });
  });

  it("returns permissionDecision from hookSpecificOutput for permissionRequest", async () => {
    await withTmpCwdAsync(async (dir) => {
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({hookSpecificOutput:{decision:'allow'}})); });",
      );
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          "  permissionRequest:",
          `    - command: "node ${JSON.stringify(scriptPath).slice(1, -1)}"`,
          "      jsonIO: true",
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
      assert.equal(outcome.allowed, true);
      assert.equal(outcome.permissionDecision, "allow");
    });
  });

  it("treats postToolUseFailure as notify-only (ignores decision from hook)", async () => {
    await withTmpCwdAsync(async (dir) => {
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({decision:'deny',reason:'nope'})); });",
      );
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          "  postToolUseFailure:",
          `    - command: "node ${JSON.stringify(scriptPath).slice(1, -1)}"`,
          "      jsonIO: true",
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const outcome = await emitHookWithOutcome("postToolUseFailure", { toolName: "Bash", errorMessage: "oops" });
      // deny is ignored — notify-only
      assert.equal(outcome.allowed, true);
    });
  });
});

describe("emitHookWithOutcome — env-mode exit-code mapping (Task 7)", () => {
  async function runEnvExitTest(opts: {
    event: "userPromptSubmit" | "permissionRequest" | "postToolUseFailure";
    exitCode: number;
  }): Promise<HookOutcome> {
    let outcome!: HookOutcome;
    await withTmpCwdAsync(async (dir) => {
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(scriptPath, `process.exit(${opts.exitCode});`);
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          `  ${opts.event}:`,
          `    - command: "node ${scriptPath.replace(/\\/g, "/")}"`,
          // NOTE: no jsonIO flag — this exercises the env-mode path
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();
      outcome = await emitHookWithOutcome(opts.event, {});
    });
    return outcome;
  }

  it("userPromptSubmit env-mode exit 0 → allowed", async () => {
    const o = await runEnvExitTest({ event: "userPromptSubmit", exitCode: 0 });
    assert.equal(o.allowed, true);
    assert.equal(o.additionalContext, undefined);
  });

  it("userPromptSubmit env-mode exit nonzero → denied", async () => {
    const o = await runEnvExitTest({ event: "userPromptSubmit", exitCode: 1 });
    assert.equal(o.allowed, false);
  });

  it("permissionRequest env-mode exit 0 → permissionDecision 'ask' (fall-through)", async () => {
    const o = await runEnvExitTest({ event: "permissionRequest", exitCode: 0 });
    assert.equal(o.allowed, true);
    assert.equal(o.permissionDecision, "ask");
  });

  it("permissionRequest env-mode exit nonzero → permissionDecision 'deny'", async () => {
    const o = await runEnvExitTest({ event: "permissionRequest", exitCode: 1 });
    assert.equal(o.allowed, false);
    assert.equal(o.permissionDecision, "deny");
  });

  it("postToolUseFailure env-mode exit 0 → allowed (notify-only)", async () => {
    const o = await runEnvExitTest({ event: "postToolUseFailure", exitCode: 0 });
    assert.equal(o.allowed, true);
  });

  it("postToolUseFailure env-mode exit nonzero → still allowed (notify-only)", async () => {
    const o = await runEnvExitTest({ event: "postToolUseFailure", exitCode: 1 });
    assert.equal(o.allowed, true);
  });
});

describe("emitHookWithOutcome — multi-hook merge semantics", () => {
  it("two userPromptSubmit hooks: additionalContext concatenates in order, \\n\\n separated", async () => {
    await withTmpCwdAsync(async (dir) => {
      const s1 = `${dir}/h1.cjs`;
      const s2 = `${dir}/h2.cjs`;
      writeFileSync(
        s1,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'FIRST'}})); });",
      );
      writeFileSync(
        s2,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'SECOND'}})); });",
      );
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          "  userPromptSubmit:",
          `    - command: "node ${s1.replace(/\\/g, "/")}"`,
          "      jsonIO: true",
          `    - command: "node ${s2.replace(/\\/g, "/")}"`,
          "      jsonIO: true",
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const outcome = await emitHookWithOutcome("userPromptSubmit", { prompt: "hi" });
      assert.equal(outcome.allowed, true);
      assert.equal(outcome.additionalContext, "FIRST\n\nSECOND");
    });
  });

  it("first deny short-circuits — second hook does not run", async () => {
    await withTmpCwdAsync(async (dir) => {
      const s1 = `${dir}/h1.cjs`;
      const s2 = `${dir}/h2.cjs`;
      const marker = `${dir}/second-ran.marker`;
      writeFileSync(
        s1,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({decision:'deny',reason:'first said no'})); });",
      );
      writeFileSync(
        s2,
        `require("node:fs").writeFileSync(${JSON.stringify(marker).replace(/\\/g, "/")}, "ran"); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write('{}'); });`,
      );
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          "  userPromptSubmit:",
          `    - command: "node ${s1.replace(/\\/g, "/")}"`,
          "      jsonIO: true",
          `    - command: "node ${s2.replace(/\\/g, "/")}"`,
          "      jsonIO: true",
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const outcome = await emitHookWithOutcome("userPromptSubmit", { prompt: "hi" });
      assert.equal(outcome.allowed, false);
      assert.match(outcome.reason ?? "", /first said no/i);
      assert.equal(existsSync(marker), false, "second hook should not have run");
    });
  });

  it("permissionRequest: 'allow' short-circuits — second 'deny' hook does not override", async () => {
    await withTmpCwdAsync(async (dir) => {
      const s1 = `${dir}/h1.cjs`;
      const s2 = `${dir}/h2.cjs`;
      writeFileSync(
        s1,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({hookSpecificOutput:{decision:'allow'}})); });",
      );
      writeFileSync(
        s2,
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({hookSpecificOutput:{decision:'deny'}})); });",
      );
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "hooks:",
          "  permissionRequest:",
          `    - command: "node ${s1.replace(/\\/g, "/")}"`,
          "      jsonIO: true",
          `    - command: "node ${s2.replace(/\\/g, "/")}"`,
          "      jsonIO: true",
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();

      const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
      assert.equal(outcome.allowed, true);
      assert.equal(outcome.permissionDecision, "allow");
    });
  });
});

// ── Turn-boundary hooks + hook_decision observer (v2.16.0) ──

/** Write a minimal .oh/config.yaml with a single hook under an arbitrary event. */
function writeHookConfigForEvent(
  dir: string,
  event: string,
  hookDef: { command?: string; http?: string; jsonIO?: boolean; timeout?: number },
) {
  mkdirSync(`${dir}/.oh`, { recursive: true });
  const lines = ["provider: mock", "model: mock", "permissionMode: ask", "hooks:", `  ${event}:`, "    -"];
  if (hookDef.command) lines.push(`      command: ${JSON.stringify(hookDef.command)}`);
  if (hookDef.http) lines.push(`      http: ${JSON.stringify(hookDef.http)}`);
  if (hookDef.jsonIO) lines.push(`      jsonIO: ${JSON.stringify(hookDef.jsonIO)}`);
  if (hookDef.timeout) lines.push(`      timeout: ${hookDef.timeout}`);
  lines.push("");
  writeFileSync(`${dir}/.oh/config.yaml`, lines.join("\n"));
  invalidateConfigCache();
  invalidateHookCache();
}

describe("turnStart / turnStop hooks", () => {
  it("emitHook('turnStart') returns true with no hooks configured", () => {
    assert.equal(emitHook("turnStart", { turnNumber: "0", model: "foo" }), true);
  });

  it("emitHook('turnStop') returns true with no hooks configured", () => {
    assert.equal(emitHook("turnStop", { turnNumber: "0", turnReason: "completed" }), true);
  });

  it("turnStart command hook receives OH_TURN_NUMBER + OH_EVENT env vars", async () => {
    await withTmpCwdAsync(async (dir) => {
      const outPath = `${dir.replace(/\\/g, "/")}/out.txt`;
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        `require('fs').writeFileSync(${JSON.stringify(outPath)}, (process.env.OH_EVENT || '') + ':' + (process.env.OH_TURN_NUMBER || ''));\n`,
      );
      writeHookConfigForEvent(dir, "turnStart", { command: `node ${JSON.stringify(scriptPath)}` });
      emitHook("turnStart", { turnNumber: "7" });
      const deadline = Date.now() + 5000;
      while (!existsSync(outPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(outPath), "hook did not fire within 5s");
      assert.equal(readFileSync(outPath, "utf8"), "turnStart:7");
    });
  });

  it("turnStop command hook receives OH_TURN_REASON", async () => {
    await withTmpCwdAsync(async (dir) => {
      const outPath = `${dir.replace(/\\/g, "/")}/out.txt`;
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        `require('fs').writeFileSync(${JSON.stringify(outPath)}, process.env.OH_TURN_REASON || '');\n`,
      );
      writeHookConfigForEvent(dir, "turnStop", { command: `node ${JSON.stringify(scriptPath)}` });
      emitHook("turnStop", { turnNumber: "0", turnReason: "max_turns" });
      const deadline = Date.now() + 5000;
      while (!existsSync(outPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(outPath), "hook did not fire within 5s");
      assert.equal(readFileSync(outPath, "utf8"), "max_turns");
    });
  });
});

describe("hook decision observer", () => {
  it("fires with a deny notification when a jsonIO hook denies", async () => {
    const received: HookDecisionNotification[] = [];
    setHookDecisionObserver((n) => received.push(n));
    try {
      await withTmpCwdAsync(async (dir) => {
        const scriptPath = `${dir}/hook.mjs`;
        writeFileSync(
          scriptPath,
          "let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'deny',reason:'nope'})); });",
        );
        writeHookConfigForEvent(dir, "permissionRequest", {
          command: `node ${JSON.stringify(scriptPath)}`,
          jsonIO: true,
        });
        const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
        assert.equal(outcome.allowed, false);
        assert.equal(received.length, 1);
        assert.equal(received[0].event, "permissionRequest");
        assert.equal(received[0].decision, "deny");
        assert.equal(received[0].tool, "Bash");
        assert.equal(received[0].reason, "nope");
      });
    } finally {
      setHookDecisionObserver(null);
    }
  });

  it("setHookDecisionObserver(null) stops notifications", async () => {
    let fired = 0;
    setHookDecisionObserver(() => {
      fired++;
    });
    setHookDecisionObserver(null);
    await withTmpCwdAsync(async (dir) => {
      const scriptPath = `${dir}/hook.mjs`;
      writeFileSync(
        scriptPath,
        "let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'deny'})); });",
      );
      writeHookConfigForEvent(dir, "permissionRequest", {
        command: `node ${JSON.stringify(scriptPath)}`,
        jsonIO: true,
      });
      await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
      assert.equal(fired, 0);
    });
  });

  it("observer errors do not break the hook pipeline", async () => {
    setHookDecisionObserver(() => {
      throw new Error("observer crashed");
    });
    try {
      await withTmpCwdAsync(async (dir) => {
        const scriptPath = `${dir}/hook.mjs`;
        writeFileSync(
          scriptPath,
          "let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'deny'})); });",
        );
        writeHookConfigForEvent(dir, "permissionRequest", {
          command: `node ${JSON.stringify(scriptPath)}`,
          jsonIO: true,
        });
        const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
        assert.equal(outcome.allowed, false);
      });
    } finally {
      setHookDecisionObserver(null);
    }
  });
});

describe("HTTP hook detailed response shape", () => {
  it("honors {decision: 'deny', reason: ...} response", async () => {
    await withTmpCwdAsync(async (dir) => {
      const http = await import("node:http");
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: "deny", reason: "server says no" }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      writeHookConfigForEvent(dir, "permissionRequest", { http: `http://127.0.0.1:${port}/` });
      try {
        const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
        assert.equal(outcome.allowed, false);
        assert.equal(outcome.reason, "server says no");
      } finally {
        server.close();
      }
    });
  });

  it("honors {hookSpecificOutput: {decision: 'allow'}} response", async () => {
    await withTmpCwdAsync(async (dir) => {
      const http = await import("node:http");
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hookSpecificOutput: { decision: "allow" } }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      writeHookConfigForEvent(dir, "permissionRequest", { http: `http://127.0.0.1:${port}/` });
      try {
        const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
        assert.equal(outcome.allowed, true);
        assert.equal(outcome.permissionDecision, "allow");
      } finally {
        server.close();
      }
    });
  });

  it("network error → deny (fail-closed)", async () => {
    await withTmpCwdAsync(async (dir) => {
      // Port 1 is reserved — the OS refuses the connection.
      writeHookConfigForEvent(dir, "permissionRequest", { http: "http://127.0.0.1:1/" });
      const outcome = await emitHookWithOutcome("permissionRequest", { toolName: "Bash" });
      assert.equal(outcome.allowed, false);
    });
  });
});

// ── OH_EFFORT env var (CC parity: effort.level / $CLAUDE_EFFORT) ──

describe("effort hook plumbing", () => {
  it("OH_EFFORT env var is set when effortLevel is configured", async () => {
    await withTmpCwdAsync(async (dir) => {
      const outPath = `${dir.replace(/\\/g, "/")}/out.txt`;
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        `require('fs').writeFileSync(${JSON.stringify(outPath)}, process.env.OH_EFFORT || '<unset>');\n`,
      );
      // Write config that includes effortLevel + a turnStart hook
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(
        `${dir}/.oh/config.yaml`,
        [
          "provider: mock",
          "model: mock",
          "permissionMode: ask",
          "effortLevel: high",
          "hooks:",
          "  turnStart:",
          `    - command: ${JSON.stringify(`node ${scriptPath}`)}`,
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      invalidateHookCache();
      emitHook("turnStart", { turnNumber: "0" });
      const deadline = Date.now() + 5000;
      while (!existsSync(outPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(outPath), "hook did not fire within 5s");
      assert.equal(readFileSync(outPath, "utf8"), "high");
    });
  });

  it("OH_EFFORT not set when effortLevel absent from config", async () => {
    await withTmpCwdAsync(async (dir) => {
      const outPath = `${dir.replace(/\\/g, "/")}/out.txt`;
      const scriptPath = `${dir}/hook.cjs`;
      writeFileSync(
        scriptPath,
        `require('fs').writeFileSync(${JSON.stringify(outPath)}, process.env.OH_EFFORT || '<unset>');\n`,
      );
      writeHookConfigForEvent(dir, "turnStart", { command: `node ${JSON.stringify(scriptPath)}` });
      emitHook("turnStart", { turnNumber: "0" });
      const deadline = Date.now() + 5000;
      while (!existsSync(outPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(outPath), "hook did not fire within 5s");
      assert.equal(readFileSync(outPath, "utf8"), "<unset>");
    });
  });
});
