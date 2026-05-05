/**
 * Tests for the MCP elicitation responder (audit B4).
 *
 * Covers the decision priority chain:
 *   1. `elicitation` hook decides → that wins
 *   2. interactive handler is registered → it decides
 *   3. neither → fail-safe `decline`
 *
 * The SDK transport-level wiring is verified at build time via the type
 * check on `setRequestHandler`. Here we lock in the pure resolution logic.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { invalidateConfigCache } from "../harness/config.js";
import { invalidateHookCache } from "../harness/hooks.js";
import { makeTmpDir } from "../test-helpers.js";
import {
  _resetElicitationForTest,
  type ElicitationRequest,
  resolveElicitation,
  setElicitationHandler,
} from "./elicitation.js";

async function withConfig(yaml: string, fn: () => Promise<void>): Promise<void> {
  const dir = makeTmpDir();
  const original = process.cwd();
  process.chdir(dir);
  try {
    mkdirSync(`${dir}/.oh`, { recursive: true });
    writeFileSync(`${dir}/.oh/config.yaml`, yaml);
    invalidateConfigCache();
    invalidateHookCache();
    await fn();
  } finally {
    process.chdir(original);
    invalidateConfigCache();
    invalidateHookCache();
  }
}

const sampleRequest: ElicitationRequest = {
  serverName: "test-server",
  message: "Confirm destructive action?",
  requestedSchema: { type: "object", properties: {} },
};

describe("resolveElicitation (audit B4)", () => {
  afterEach(() => _resetElicitationForTest());

  test("default fail-safe: no hook, no handler → decline", async () => {
    await withConfig("provider: mock\nmodel: mock\npermissionMode: trust\n", async () => {
      const result = await resolveElicitation(sampleRequest);
      assert.equal(result.action, "decline");
    });
  });

  test("interactive handler called when no hook decides", async () => {
    let receivedReq: ElicitationRequest | undefined;
    setElicitationHandler(async (req) => {
      receivedReq = req;
      return { action: "accept", content: { confirmed: true } };
    });
    await withConfig("provider: mock\nmodel: mock\npermissionMode: trust\n", async () => {
      const result = await resolveElicitation(sampleRequest);
      assert.equal(result.action, "accept");
      assert.deepEqual(result.content, { confirmed: true });
    });
    assert.equal(receivedReq?.serverName, "test-server");
    assert.equal(receivedReq?.message, "Confirm destructive action?");
  });

  test("interactive handler that throws falls through to cancel (not decline)", async () => {
    setElicitationHandler(async () => {
      throw new Error("UI crashed");
    });
    await withConfig("provider: mock\nmodel: mock\npermissionMode: trust\n", async () => {
      const result = await resolveElicitation(sampleRequest);
      assert.equal(result.action, "cancel", "user didn't get to decide — cancel is the right signal");
    });
  });

  test("hook returning permissionDecision: 'allow' → accept (handler not consulted)", async () => {
    let handlerCalled = false;
    setElicitationHandler(async () => {
      handlerCalled = true;
      return { action: "decline" };
    });
    const dir = makeTmpDir();
    const captureScript = `${dir}/decide.cjs`;
    // jsonIO hooks must wrap the decision in hookSpecificOutput per the
    // parser at parseJsonIoResponse — top-level `permissionDecision` is
    // ignored (only nested `decision` is honored).
    writeFileSync(
      captureScript,
      `process.stdout.write(JSON.stringify({ hookSpecificOutput: { decision: "allow" } }));`,
    );
    const yaml = [
      "provider: mock",
      "model: mock",
      "permissionMode: trust",
      "hooks:",
      "  elicitation:",
      `    - command: 'node ${captureScript.replace(/\\/g, "/")}'`,
      "      jsonIO: true",
      "",
    ].join("\n");

    const original = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(`${dir}/.oh/config.yaml`, yaml);
      invalidateConfigCache();
      invalidateHookCache();
      const result = await resolveElicitation(sampleRequest);
      assert.equal(result.action, "accept");
      assert.equal(handlerCalled, false, "hook 'allow' must short-circuit before the interactive handler");
    } finally {
      process.chdir(original);
      invalidateConfigCache();
      invalidateHookCache();
    }
  });

  test("hook returning permissionDecision: 'deny' → decline (handler not consulted)", async () => {
    let handlerCalled = false;
    setElicitationHandler(async () => {
      handlerCalled = true;
      return { action: "accept" };
    });
    const dir = makeTmpDir();
    const captureScript = `${dir}/decide.cjs`;
    writeFileSync(captureScript, `process.stdout.write(JSON.stringify({ hookSpecificOutput: { decision: "deny" } }));`);
    const yaml = [
      "provider: mock",
      "model: mock",
      "permissionMode: trust",
      "hooks:",
      "  elicitation:",
      `    - command: 'node ${captureScript.replace(/\\/g, "/")}'`,
      "      jsonIO: true",
      "",
    ].join("\n");

    const original = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(`${dir}/.oh/config.yaml`, yaml);
      invalidateConfigCache();
      invalidateHookCache();
      const result = await resolveElicitation(sampleRequest);
      assert.equal(result.action, "decline");
      assert.equal(handlerCalled, false, "hook 'deny' must short-circuit before the interactive handler");
    } finally {
      process.chdir(original);
      invalidateConfigCache();
      invalidateHookCache();
    }
  });

  test("setElicitationHandler(undefined) clears the handler", async () => {
    setElicitationHandler(async () => ({ action: "accept" }));
    setElicitationHandler(undefined);
    await withConfig("provider: mock\nmodel: mock\npermissionMode: trust\n", async () => {
      const result = await resolveElicitation(sampleRequest);
      assert.equal(result.action, "decline", "back to default after clearing");
    });
  });

  test("elicitationResult hook fires with the final action + content", async () => {
    setElicitationHandler(async () => ({
      action: "accept",
      content: { value: 42 },
    }));
    const dir = makeTmpDir();
    const capturePath = `${dir}/captured.txt`;
    const captureScript = `${dir}/capture.cjs`;
    writeFileSync(
      captureScript,
      `require('node:fs').appendFileSync(${JSON.stringify(capturePath.replace(/\\/g, "/"))}, process.env.OH_ELICITATION_ACTION + '|' + (process.env.OH_ELICITATION_CONTENT || ''));`,
    );
    const yaml = [
      "provider: mock",
      "model: mock",
      "permissionMode: trust",
      "hooks:",
      "  elicitationResult:",
      `    - command: 'node ${captureScript.replace(/\\/g, "/")}'`,
      "",
    ].join("\n");

    const original = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(`${dir}/.oh`, { recursive: true });
      writeFileSync(`${dir}/.oh/config.yaml`, yaml);
      invalidateConfigCache();
      invalidateHookCache();
      await resolveElicitation(sampleRequest);
      const { waitForCapture } = await import("../test-helpers.js");
      const fired = await waitForCapture(capturePath, { expectedLines: 1 });
      assert.ok(fired.length > 0, "elicitationResult hook should have fired");
      const captured = fired.join("\n");
      assert.match(captured, /^accept\|/);
      assert.match(captured, /value":42/);
    } finally {
      process.chdir(original);
      invalidateConfigCache();
      invalidateHookCache();
    }
  });
});
