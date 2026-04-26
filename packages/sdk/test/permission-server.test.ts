import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { coerceDecision, InProcessPermissionServer } from "../src/internal/permission-server.js";
import type { PermissionContext } from "../src/permissions.js";

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body: parsed };
}

const sampleContext: PermissionContext = {
  event: "permissionRequest",
  toolName: "Bash",
  toolInputJson: '{"command":"ls"}',
};

describe("coerceDecision", () => {
  test("bare allow string", () => {
    assert.deepEqual(coerceDecision("allow"), { decision: "allow" });
  });

  test("bare deny + reason in object", () => {
    assert.deepEqual(coerceDecision({ decision: "deny", reason: "policy" }), {
      decision: "deny",
      reason: "policy",
    });
  });

  test("ask with no reason", () => {
    assert.deepEqual(coerceDecision({ decision: "ask" }), { decision: "ask" });
  });

  test("invalid string defaults to deny with explanation", () => {
    const out = coerceDecision("yes");
    assert.equal(out.decision, "deny");
    assert.match(out.reason ?? "", /yes/);
  });

  test("missing decision field defaults to deny", () => {
    const out = coerceDecision({ reason: "no decision" });
    assert.equal(out.decision, "deny");
    assert.match(out.reason ?? "", /missing or invalid/);
  });

  test("garbage type defaults to deny", () => {
    assert.equal(coerceDecision(42).decision, "deny");
    assert.equal(coerceDecision(null).decision, "deny");
    assert.equal(coerceDecision(undefined).decision, "deny");
  });
});

describe("InProcessPermissionServer", () => {
  test("invokes a sync callback and returns the decision", async () => {
    const server = new InProcessPermissionServer((ctx) => (ctx.toolName === "Bash" ? "deny" : "allow"));
    await server.start();
    try {
      const { status, body } = await postJson(server.url, sampleContext);
      assert.equal(status, 200);
      assert.deepEqual(body, { decision: "deny" });
    } finally {
      await server.close();
    }
  });

  test("invokes an async callback and surfaces the reason", async () => {
    const server = new InProcessPermissionServer(async () => ({ decision: "allow", reason: "trusted" }));
    await server.start();
    try {
      const { status, body } = await postJson(server.url, sampleContext);
      assert.equal(status, 200);
      assert.deepEqual(body, { decision: "allow", reason: "trusted" });
    } finally {
      await server.close();
    }
  });

  test("callback throws → deny with the error message", async () => {
    const server = new InProcessPermissionServer(() => {
      throw new Error("kaboom");
    });
    await server.start();
    try {
      const { status, body } = await postJson(server.url, sampleContext);
      assert.equal(status, 200);
      const decision = body as { decision: string; reason?: string };
      assert.equal(decision.decision, "deny");
      assert.match(decision.reason ?? "", /kaboom/);
    } finally {
      await server.close();
    }
  });

  test("callback exceeding timeout → deny with timeout reason", async () => {
    const server = new InProcessPermissionServer(
      () => new Promise<"allow">((resolve) => setTimeout(() => resolve("allow"), 1_000)),
      { timeoutMs: 80 },
    );
    await server.start();
    try {
      const { body } = await postJson(server.url, sampleContext);
      const decision = body as { decision: string; reason?: string };
      assert.equal(decision.decision, "deny");
      assert.match(decision.reason ?? "", /timeout/);
    } finally {
      await server.close();
    }
  });

  test("non-JSON body → 400 + deny", async () => {
    const server = new InProcessPermissionServer(() => "allow");
    await server.start();
    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      assert.equal(res.status, 400);
      const decision = (await res.json()) as { decision: string };
      assert.equal(decision.decision, "deny");
    } finally {
      await server.close();
    }
  });

  test("wrong path → 404", async () => {
    const server = new InProcessPermissionServer(() => "allow");
    await server.start();
    try {
      const res = await fetch(server.url.replace("/permission", "/other"), {
        method: "POST",
      });
      assert.equal(res.status, 404);
    } finally {
      await server.close();
    }
  });

  test("close() is idempotent", async () => {
    const server = new InProcessPermissionServer(() => "allow");
    await server.start();
    await server.close();
    await server.close();
  });
});
