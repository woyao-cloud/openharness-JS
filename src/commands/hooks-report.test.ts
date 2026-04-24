import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HooksConfig } from "../harness/config.js";
import { formatHooksReport } from "./hooks-report.js";

describe("formatHooksReport", () => {
  it("shows the 'No hooks configured' message when input is null", () => {
    const out = formatHooksReport(null);
    assert.match(out, /No hooks configured/);
    assert.match(out, /\.oh\/config\.yaml/);
  });

  it("shows the 'No hooks configured' message when all event arrays are empty", () => {
    const hooks: HooksConfig = { preToolUse: [], sessionStart: [] };
    const out = formatHooksReport(hooks);
    assert.match(out, /No hooks configured/);
  });

  it("groups hooks by event name", () => {
    const hooks: HooksConfig = {
      preToolUse: [{ command: "echo pre" }],
      sessionStart: [{ command: "echo start" }],
    };
    const out = formatHooksReport(hooks);
    assert.match(out, /preToolUse/);
    assert.match(out, /sessionStart/);
  });

  it("labels each hook by kind (command, http, prompt)", () => {
    const hooks: HooksConfig = {
      preToolUse: [{ command: "scripts/gate.sh" }, { http: "https://example.com/hook" }, { prompt: "Is this safe?" }],
    };
    const out = formatHooksReport(hooks);
    assert.match(out, /command/);
    assert.match(out, /http/);
    assert.match(out, /prompt/);
    assert.match(out, /scripts\/gate\.sh/);
    assert.match(out, /example\.com/);
  });

  it("shows the event's hook count in the header", () => {
    const hooks: HooksConfig = {
      preToolUse: [{ command: "a" }, { command: "b" }, { command: "c" }],
    };
    const out = formatHooksReport(hooks);
    assert.match(out, /preToolUse.*\(3\)/);
  });

  it("includes the match pattern when set", () => {
    const hooks: HooksConfig = {
      preToolUse: [{ command: "echo x", match: "Bash" }],
    };
    const out = formatHooksReport(hooks);
    assert.match(out, /match: Bash/);
  });

  it("omits the match pattern when absent", () => {
    const hooks: HooksConfig = {
      sessionStart: [{ command: "echo x" }],
    };
    const out = formatHooksReport(hooks);
    assert.doesNotMatch(out, /match:/);
  });

  it("truncates long commands with an ellipsis", () => {
    const long = "a".repeat(200);
    const hooks: HooksConfig = {
      preToolUse: [{ command: long }],
    };
    const out = formatHooksReport(hooks);
    assert.match(out, /…/);
    assert.ok(!out.includes(long), "full long command should not be emitted");
  });

  it("sorts events alphabetically for stable output", () => {
    const hooks: HooksConfig = {
      sessionStart: [{ command: "a" }],
      postToolUse: [{ command: "b" }],
      preToolUse: [{ command: "c" }],
    };
    const out = formatHooksReport(hooks);
    const postIdx = out.indexOf("postToolUse");
    const preIdx = out.indexOf("preToolUse");
    const sessIdx = out.indexOf("sessionStart");
    assert.ok(postIdx < preIdx && preIdx < sessIdx, "events should be sorted alphabetically");
  });
});
