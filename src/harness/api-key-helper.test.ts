/**
 * Tests for runApiKeyHelper (audit B8) and the resolveApiKey integration step
 * that consults it.
 *
 * Strategy: write tiny Node helper scripts (cross-platform — calling
 * `node <script>` works on Windows + Linux without a #! interpreter) and
 * point the helper at them via a real .oh/config.yaml. The script-based
 * approach mirrors how production users will configure apiKeyHelper.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { makeTmpDir } from "../test-helpers.js";
import { runApiKeyHelper } from "./api-key-helper.js";
import { invalidateConfigCache } from "./config.js";

function helperPath(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("runApiKeyHelper (audit B8)", () => {
  test("trimmed stdout becomes the resolved key", () => {
    const dir = makeTmpDir();
    const script = helperPath(dir, "echo-key.cjs", "console.log('sk-test-12345');");
    const result = runApiKeyHelper(`node ${script.replace(/\\/g, "/")}`, { provider: "anthropic" });
    assert.equal(result, "sk-test-12345");
  });

  test("OH_PROVIDER env var is exposed to the helper script", () => {
    const dir = makeTmpDir();
    const script = helperPath(dir, "echo-provider.cjs", "process.stdout.write('key-for-' + process.env.OH_PROVIDER);");
    const result = runApiKeyHelper(`node ${script.replace(/\\/g, "/")}`, { provider: "openai" });
    assert.equal(result, "key-for-openai");
  });

  test("non-zero exit code → undefined (caller falls through)", () => {
    const dir = makeTmpDir();
    const script = helperPath(dir, "fail.cjs", "console.error('boom'); process.exit(1);");
    const result = runApiKeyHelper(`node ${script.replace(/\\/g, "/")}`, { provider: "anthropic" });
    assert.equal(result, undefined);
  });

  test("empty stdout (no output) → undefined", () => {
    const dir = makeTmpDir();
    const script = helperPath(dir, "silent.cjs", "");
    const result = runApiKeyHelper(`node ${script.replace(/\\/g, "/")}`, { provider: "anthropic" });
    assert.equal(result, undefined);
  });

  test("whitespace-only stdout is treated as empty", () => {
    const dir = makeTmpDir();
    const script = helperPath(dir, "blank.cjs", "console.log('   \\n\\n  ');");
    const result = runApiKeyHelper(`node ${script.replace(/\\/g, "/")}`, { provider: "anthropic" });
    assert.equal(result, undefined);
  });

  test("unresolved command (helper not found) → undefined, no throw", () => {
    const result = runApiKeyHelper("definitely-not-on-path-xyz123", { provider: "anthropic" });
    assert.equal(result, undefined);
  });

  test("trailing newline in stdout is stripped", () => {
    const dir = makeTmpDir();
    const script = helperPath(dir, "newline.cjs", "console.log('sk-with-newline');");
    const result = runApiKeyHelper(`node ${script.replace(/\\/g, "/")}`, { provider: "anthropic" });
    assert.equal(result, "sk-with-newline", "console.log adds \\n; helper must trim it");
  });
});

describe("resolveApiKey + apiKeyHelper integration", () => {
  test("apiKeyHelper sits between encrypted store and legacy config", async () => {
    const root = makeTmpDir();
    const original = process.cwd();
    process.chdir(root);
    const originalEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      mkdirSync(`${root}/.oh`, { recursive: true });
      const helper = join(root, "helper.cjs");
      writeFileSync(helper, "console.log('from-helper-' + process.env.OH_PROVIDER);");
      writeFileSync(
        `${root}/.oh/config.yaml`,
        [
          "provider: anthropic",
          "model: claude-sonnet-4-6",
          "permissionMode: ask",
          `apiKeyHelper: 'node ${helper.replace(/\\/g, "/")}'`,
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      // Fresh import so the per-process credential store is clean — though
      // resolveApiKey only consults the helper after env var + stored, both
      // of which are empty here.
      const { resolveApiKey } = await import(`./credentials.js?cache=${Date.now()}`);
      const result = resolveApiKey("anthropic");
      assert.equal(result, "from-helper-anthropic");
    } finally {
      process.chdir(original);
      if (originalEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalEnv;
      }
      invalidateConfigCache();
    }
  });

  test("env var still wins over apiKeyHelper", async () => {
    const root = makeTmpDir();
    const original = process.cwd();
    process.chdir(root);
    const originalEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "from-env";
    try {
      mkdirSync(`${root}/.oh`, { recursive: true });
      const helper = join(root, "helper.cjs");
      writeFileSync(helper, "console.log('from-helper');");
      writeFileSync(
        `${root}/.oh/config.yaml`,
        [
          "provider: anthropic",
          "model: claude-sonnet-4-6",
          "permissionMode: ask",
          `apiKeyHelper: 'node ${helper.replace(/\\/g, "/")}'`,
          "",
        ].join("\n"),
      );
      invalidateConfigCache();
      const { resolveApiKey } = await import(`./credentials.js?cache=${Date.now()}`);
      const result = resolveApiKey("anthropic");
      assert.equal(result, "from-env", "env var must take priority over apiKeyHelper");
    } finally {
      process.chdir(original);
      if (originalEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalEnv;
      }
      invalidateConfigCache();
    }
  });
});
