/**
 * Tests for `appendToolPermission` (audit U-A2).
 *
 * Used by the "[A]lways" key in the permission prompt — persists a
 * `toolPermissions: { tool, action: "allow" }` rule so future calls to
 * the same tool skip the prompt.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parse } from "yaml";
import { makeTmpDir } from "../test-helpers.js";
import { appendToolPermission, invalidateConfigCache, type OhConfig } from "./config.js";

function withConfig(yaml: string, fn: (root: string) => void): void {
  const dir = makeTmpDir();
  const original = process.cwd();
  process.chdir(dir);
  try {
    mkdirSync(`${dir}/.oh`, { recursive: true });
    writeFileSync(`${dir}/.oh/config.yaml`, yaml);
    invalidateConfigCache();
    fn(dir);
  } finally {
    process.chdir(original);
    invalidateConfigCache();
  }
}

describe("appendToolPermission (audit U-A2)", () => {
  test("appends a new allow rule when none exists", () => {
    withConfig("provider: mock\nmodel: mock\npermissionMode: ask\n", (dir) => {
      const wrote = appendToolPermission("Edit");
      assert.equal(wrote, true);
      const cfg = parse(readFileSync(`${dir}/.oh/config.yaml`, "utf8")) as OhConfig;
      assert.deepEqual(cfg.toolPermissions, [{ tool: "Edit", action: "allow" }]);
    });
  });

  test("preserves existing rules when appending", () => {
    const yaml = [
      "provider: mock",
      "model: mock",
      "permissionMode: ask",
      "toolPermissions:",
      "  - tool: Bash",
      "    action: deny",
      "    pattern: '^rm .*'",
      "",
    ].join("\n");
    withConfig(yaml, (dir) => {
      const wrote = appendToolPermission("Write");
      assert.equal(wrote, true);
      const cfg = parse(readFileSync(`${dir}/.oh/config.yaml`, "utf8")) as OhConfig;
      assert.equal(cfg.toolPermissions?.length, 2);
      assert.deepEqual(cfg.toolPermissions?.[0], {
        tool: "Bash",
        action: "deny",
        pattern: "^rm .*",
      });
      assert.deepEqual(cfg.toolPermissions?.[1], { tool: "Write", action: "allow" });
    });
  });

  test("dedupes — second append of the same tool/action is a no-op", () => {
    withConfig("provider: mock\nmodel: mock\npermissionMode: ask\n", (dir) => {
      assert.equal(appendToolPermission("Edit"), true);
      const wroteAgain = appendToolPermission("Edit");
      assert.equal(wroteAgain, false, "second append should not write");
      const cfg = parse(readFileSync(`${dir}/.oh/config.yaml`, "utf8")) as OhConfig;
      assert.equal(cfg.toolPermissions?.length, 1);
    });
  });

  test("a patterned rule for the same tool does NOT block adding a generic allow", () => {
    // A patterned deny should not satisfy the dedup check — generic-allow
    // is a different rule shape.
    const yaml = [
      "provider: mock",
      "model: mock",
      "permissionMode: ask",
      "toolPermissions:",
      "  - tool: Bash",
      "    action: deny",
      "    pattern: '^rm .*'",
      "",
    ].join("\n");
    withConfig(yaml, (dir) => {
      const wrote = appendToolPermission("Bash");
      assert.equal(wrote, true);
      const cfg = parse(readFileSync(`${dir}/.oh/config.yaml`, "utf8")) as OhConfig;
      assert.equal(cfg.toolPermissions?.length, 2);
    });
  });

  test("returns false when no project config exists (no auto-create)", () => {
    const dir = makeTmpDir();
    const original = process.cwd();
    process.chdir(dir);
    try {
      invalidateConfigCache();
      const wrote = appendToolPermission("Edit");
      assert.equal(wrote, false);
      assert.equal(existsSync(`${dir}/.oh/config.yaml`), false, "no auto-create");
    } finally {
      process.chdir(original);
      invalidateConfigCache();
    }
  });
});
