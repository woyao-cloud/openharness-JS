import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { z } from "zod";
import { tool } from "../src/tools.js";

describe("tool()", () => {
  test("accepts a valid definition and returns it unchanged", () => {
    const schema = z.object({ city: z.string() });
    const def = tool({
      name: "weather",
      description: "Fetch weather",
      inputSchema: schema,
      handler: async ({ city }) => `Sunny in ${city}`,
    });
    assert.equal(def.name, "weather");
    assert.equal(def.description, "Fetch weather");
    assert.equal(def.inputSchema, schema);
    assert.equal(typeof def.handler, "function");
  });

  test("description is optional", () => {
    const def = tool({
      name: "noop",
      inputSchema: z.object({}),
      handler: () => null,
    });
    assert.equal(def.description, undefined);
  });

  test("missing name throws TypeError", () => {
    assert.throws(
      () =>
        tool({
          name: "",
          inputSchema: z.object({}),
          handler: () => null,
        }),
      TypeError,
    );
  });

  test("missing inputSchema throws TypeError", () => {
    assert.throws(
      () =>
        tool({
          name: "x",
          // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse to test validation
          inputSchema: undefined as any,
          handler: () => null,
        }),
      TypeError,
    );
  });

  test("missing handler throws TypeError", () => {
    assert.throws(
      () =>
        tool({
          name: "x",
          inputSchema: z.object({}),
          // biome-ignore lint/suspicious/noExplicitAny: deliberate misuse to test validation
          handler: undefined as any,
        }),
      TypeError,
    );
  });
});
