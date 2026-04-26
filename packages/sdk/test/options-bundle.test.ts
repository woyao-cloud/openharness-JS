import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { OpenHarnessOptionsBundle } from "../src/options.js";

describe("OpenHarnessOptionsBundle", () => {
  test("toOptions() omits unset fields", () => {
    const bundle = new OpenHarnessOptionsBundle({ model: "ollama/llama3", maxTurns: 5 });
    const opts = bundle.toOptions();
    assert.deepEqual(opts, { model: "ollama/llama3", maxTurns: 5 });
    assert.equal(Object.hasOwn(opts, "permissionMode"), false);
  });

  test("toOptions() preserves all explicitly-set fields including resume + settingSources", () => {
    const bundle = new OpenHarnessOptionsBundle({
      model: "claude-sonnet-4-6",
      permissionMode: "trust",
      maxTurns: 3,
      systemPrompt: "be terse",
      resume: "abc-123",
      settingSources: ["user", "project"],
    });
    const opts = bundle.toOptions();
    assert.equal(opts.model, "claude-sonnet-4-6");
    assert.equal(opts.permissionMode, "trust");
    assert.equal(opts.maxTurns, 3);
    assert.equal(opts.systemPrompt, "be terse");
    assert.equal(opts.resume, "abc-123");
    assert.deepEqual(opts.settingSources, ["user", "project"]);
  });

  test("default constructor produces an empty bundle", () => {
    const bundle = new OpenHarnessOptionsBundle();
    assert.deepEqual(bundle.toOptions(), {});
  });

  test("after construction, fields can be mutated and re-emitted", () => {
    const bundle = new OpenHarnessOptionsBundle({ model: "ollama/llama3" });
    bundle.resume = "xyz";
    bundle.settingSources = ["local"];
    assert.deepEqual(bundle.toOptions(), {
      model: "ollama/llama3",
      resume: "xyz",
      settingSources: ["local"],
    });
  });
});
