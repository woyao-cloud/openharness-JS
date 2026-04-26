import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OpenHarnessClient } from "../src/client.js";
import { OpenHarnessError } from "../src/errors.js";
import type { Event } from "../src/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(__dirname, "fixtures", "oh-shim.cjs");

function clientWith(
  scenario: string,
  extra: Partial<ConstructorParameters<typeof OpenHarnessClient>[0]> = {},
): OpenHarnessClient {
  return new OpenHarnessClient({
    ohBinary: SHIM,
    env: { OH_SHIM_SESSION_SCENARIO: scenario },
    ...extra,
  });
}

async function collect(stream: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("OpenHarnessClient — basic lifecycle", () => {
  test("captures sessionId from the ready event after start()", async () => {
    const client = clientWith("happy");
    try {
      await client.start();
      assert.equal(client.sessionId, "shim-session-abc");
    } finally {
      await client.close();
    }
  });

  test("start() is idempotent — multiple awaits resolve to the same outcome", async () => {
    const client = clientWith("happy");
    try {
      const a = client.start();
      const b = client.start();
      await a;
      await b;
      assert.equal(client.sessionId, "shim-session-abc");
    } finally {
      await client.close();
    }
  });

  test("close() is idempotent and safe before start()", async () => {
    const client = clientWith("happy");
    await client.close();
    await client.close();
  });
});

describe("OpenHarnessClient — send()", () => {
  test("yields events for one prompt and ends on turn_complete", async () => {
    const client = clientWith("happy");
    try {
      const events = await collect(client.send("hello"));
      assert.deepEqual(events.map((e) => e.type), ["text", "turn_complete"]);
      const text = events[0];
      if (text.type === "text") assert.equal(text.content, "echo: hello");
    } finally {
      await client.close();
    }
  });

  test("multi-turn: two consecutive prompts each get their own events", async () => {
    const client = clientWith("happy");
    try {
      const first = await collect(client.send("one"));
      const second = await collect(client.send("two"));
      const t1 = first[0];
      const t2 = second[0];
      if (t1.type === "text") assert.equal(t1.content, "echo: one");
      if (t2.type === "text") assert.equal(t2.content, "echo: two");
    } finally {
      await client.close();
    }
  });

  test("concurrent sends are serialized — second prompt does not interleave", async () => {
    const client = clientWith("slow");
    try {
      const log: string[] = [];
      const a = (async () => {
        for await (const e of client.send("A")) {
          if (e.type === "text") log.push("A:text");
          else if (e.type === "turn_complete") log.push("A:done");
        }
      })();
      const b = (async () => {
        for await (const e of client.send("B")) {
          if (e.type === "text") log.push("B:text");
          else if (e.type === "turn_complete") log.push("B:done");
        }
      })();
      await Promise.all([a, b]);
      assert.deepEqual(log, ["A:text", "A:done", "B:text", "B:done"]);
    } finally {
      await client.close();
    }
  });

  test("subprocess crash mid-stream surfaces an OpenHarnessError on the in-flight send", async () => {
    const client = clientWith("die-on-second");
    try {
      // First send completes happily.
      await collect(client.send("first"));
      // Second send should get partial events then OEH error when subprocess dies.
      let caught: unknown;
      try {
        for await (const _ of client.send("second")) {
          void _;
        }
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof OpenHarnessError, "expected OpenHarnessError on subprocess death");
    } finally {
      await client.close();
    }
  });
});

describe("OpenHarnessClient — start() failures", () => {
  test("never-ready scenario: start() rejects and close() is still safe", async () => {
    const client = new OpenHarnessClient({
      ohBinary: SHIM,
      env: { OH_SHIM_SESSION_SCENARIO: "never-ready" },
    });
    // Override the timeout to keep the test fast — we monkey-patch by closing
    // early instead. Race start() against a 250 ms cancel.
    const startP = client.start();
    let caught: unknown;
    try {
      await Promise.race([
        startP,
        new Promise((_, rej) => setTimeout(() => rej(new Error("test-timeout")), 250)),
      ]);
    } catch (err) {
      caught = err;
    } finally {
      await client.close();
    }
    assert.ok(caught, "start() should not have resolved on never-ready");
  });
});

describe("OpenHarnessClient — Symbol.asyncDispose", () => {
  test("can be used with `await using` when supported", async () => {
    // Manually exercise the disposer (TS lib doesn't gate test execution on
    // explicit-resource-management support; the symbol exists in Node ≥ 20).
    const client = clientWith("happy");
    await client.start();
    assert.equal(typeof client[Symbol.asyncDispose], "function");
    await client[Symbol.asyncDispose]();
  });
});
