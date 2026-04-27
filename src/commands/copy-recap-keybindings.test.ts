/**
 * Tests for the audit A8/A9/A10 slash commands:
 *   /keybindings — opens (and creates if missing) ~/.oh/keybindings.json
 *   /copy [n]    — copies the Nth-last assistant response to the clipboard
 *   /recap       — one-sentence session recap (handed to model as prependToPrompt)
 *
 * The clipboard side-effect is tested separately (`copyToClipboard` is exported
 * from session.ts) so we can avoid depending on `pbcopy` / `clip.exe` etc.
 * being on PATH in CI. The `/copy` slash-command path here exercises the
 * message-walking + Nth-last selection logic; the actual clipboard hand-off
 * is allowed to fail (Linux CI has no clipboard tool by default — the
 * fallback prints the response text inline).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessage, createUserMessage } from "../types/message.js";
import { type CommandContext, processSlashCommand } from "./index.js";
import { copyToClipboard } from "./session.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    messages: [],
    model: "gpt-4o",
    providerName: "openai",
    permissionMode: "ask",
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessionId: "test-sess",
    ...overrides,
  };
}

// ── /recap ────────────────────────────────────────────────────────────────────

test("/recap emits prependToPrompt asking for a one-sentence summary", async () => {
  const ctx = makeCtx({
    messages: [createUserMessage("hi"), createAssistantMessage("hello back")],
  });
  const result = await processSlashCommand("/recap", ctx);
  assert.ok(result);
  assert.equal(result.handled, false, "recap should defer to the LLM, not handle locally");
  assert.ok(result.prependToPrompt, "recap must produce a prependToPrompt");
  assert.match(result.prependToPrompt!, /ONE sentence/i);
  assert.ok(result.output.includes("[recap]"));
});

test("/recap on an empty session is a no-op with a clear message", async () => {
  const result = await processSlashCommand("/recap", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /no messages/i);
});

// ── /copy ─────────────────────────────────────────────────────────────────────

test("/copy with no assistant messages yet is a no-op with a clear message", async () => {
  const result = await processSlashCommand("/copy", makeCtx());
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /no assistant responses/i);
});

test("/copy defaults to the most recent assistant response (n=1)", async () => {
  const ctx = makeCtx({
    messages: [
      createUserMessage("a"),
      createAssistantMessage("first reply"),
      createUserMessage("b"),
      createAssistantMessage("LATEST reply"),
    ],
  });
  const result = await processSlashCommand("/copy", ctx);
  assert.ok(result);
  assert.equal(result.handled, true);
  // Either succeeded (clipboard tool present) or fell back to inline print —
  // both branches surface the response text so we can assert on it.
  assert.ok(result.output.includes("LATEST reply"), `expected LATEST reply in output, got: ${result.output}`);
});

test("/copy 2 copies the second-most-recent assistant response", async () => {
  const ctx = makeCtx({
    messages: [
      createAssistantMessage("oldest"),
      createUserMessage("u1"),
      createAssistantMessage("middle"),
      createUserMessage("u2"),
      createAssistantMessage("newest"),
    ],
  });
  const result = await processSlashCommand("/copy 2", ctx);
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("middle"), `expected middle reply in output, got: ${result.output}`);
  assert.equal(result.output.includes("newest"), false, "n=2 must skip the newest message");
});

test("/copy with n out of range surfaces a clear range error", async () => {
  const ctx = makeCtx({
    messages: [createAssistantMessage("only one")],
  });
  const result = await processSlashCommand("/copy 5", ctx);
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.match(result.output, /Only 1 assistant response/i);
});

test("/copy ignores non-text assistant messages (tool-call only) when picking the Nth-last", async () => {
  // Tool-only assistant turns have empty content — /copy must skip them so
  // the user gets the actual reply text, not a blank line.
  const ctx = makeCtx({
    messages: [
      createAssistantMessage("real reply"),
      createUserMessage("u"),
      createAssistantMessage("", [{ id: "x", toolName: "Read", arguments: {} }]),
    ],
  });
  const result = await processSlashCommand("/copy", ctx);
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.ok(result.output.includes("real reply"), `expected /copy to skip the tool-only turn, got: ${result.output}`);
});

// ── copyToClipboard helper ────────────────────────────────────────────────────

test("copyToClipboard returns a structured result (ok or fail) — no throws", () => {
  const result = copyToClipboard("hello");
  if (result.ok) {
    assert.equal(typeof result.tool, "string");
    assert.ok(result.tool.length > 0);
  } else {
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  }
});

// ── /keybindings ──────────────────────────────────────────────────────────────

test("/keybindings creates ~/.oh/keybindings.json with starter content if missing", async () => {
  // Don't actually launch a GUI editor during the suite — the OH_NO_OPEN_EDITOR
  // escape hatch on settings.ts:openInEditor reports a successful spawn without
  // calling spawn(). Without this, on Windows the test would pop a notepad
  // window and node --test would hang waiting for its stdio handle to close.
  const prevEnv = process.env.OH_NO_OPEN_EDITOR;
  process.env.OH_NO_OPEN_EDITOR = "1";
  const path = join(homedir(), ".oh", "keybindings.json");
  // Snapshot pre-existing file so we don't clobber a real user setup.
  const preExisting = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (preExisting === null) {
    // Clean slate — ensure absent, run command, file should appear.
    try {
      const result = await processSlashCommand("/keybindings", makeCtx());
      assert.ok(result);
      assert.equal(result.handled, true);
      assert.ok(existsSync(path), "keybindings.json should have been created");
      const body = readFileSync(path, "utf8");
      assert.match(body, /ctrl\+d/);
      assert.match(body, /\/diff/);
      // Output mentions either creation or opening; both are acceptable.
      assert.ok(
        result.output.includes("Created") || result.output.includes("Opening"),
        `expected creation/open in output, got: ${result.output}`,
      );
    } finally {
      // Restore the absent state so we don't leave artifacts in $HOME.
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  } else {
    // File already existed for this user — just verify the command runs and
    // surfaces the path without altering content.
    const result = await processSlashCommand("/keybindings", makeCtx());
    assert.ok(result);
    assert.equal(result.handled, true);
    const after = readFileSync(path, "utf8");
    assert.equal(after, preExisting, "/keybindings must not modify an existing file");
  }
  if (prevEnv === undefined) {
    delete process.env.OH_NO_OPEN_EDITOR;
  } else {
    process.env.OH_NO_OPEN_EDITOR = prevEnv;
  }
});
