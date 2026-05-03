import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executePurge, formatBytes, formatPurgePlan, planPurge } from "./project-purge.js";

describe("project purge", () => {
  let projectDir: string;
  let trustFile: string;
  let prevTrustEnv: string | undefined;

  beforeEach(() => {
    prevTrustEnv = process.env.OH_TRUST_FILE;
    projectDir = mkdtempSync(join(tmpdir(), "oh-purge-proj-"));
    const trustHome = mkdtempSync(join(tmpdir(), "oh-purge-home-"));
    trustFile = join(trustHome, "trusted-dirs.json");
    process.env.OH_TRUST_FILE = trustFile;
  });

  afterEach(() => {
    if (prevTrustEnv === undefined) delete process.env.OH_TRUST_FILE;
    else process.env.OH_TRUST_FILE = prevTrustEnv;
    rmSync(projectDir, { recursive: true, force: true });
    if (existsSync(trustFile)) rmSync(trustFile, { force: true });
  });

  describe("planPurge", () => {
    it("returns an empty plan when no .oh/ directory and no trust entry", () => {
      const plan = planPurge(projectDir);
      assert.equal(plan.entries.length, 0);
      assert.equal(plan.totalBytes, 0);
    });

    it("enumerates known .oh/ subpaths with sizes", () => {
      const ohDir = join(projectDir, ".oh");
      mkdirSync(ohDir, { recursive: true });
      mkdirSync(join(ohDir, "memory"), { recursive: true });
      mkdirSync(join(ohDir, "skills"), { recursive: true });
      writeFileSync(join(ohDir, "config.yaml"), "provider: ollama\nmodel: llama3\n");
      writeFileSync(join(ohDir, "RULES.md"), "# rules\n");
      writeFileSync(join(ohDir, "memory", "facts.md"), "fact: x\n");
      writeFileSync(join(ohDir, "skills", "skill.md"), "---\nname: x\n---\n");

      const plan = planPurge(projectDir);
      const labels = plan.entries.map((e) => e.label);
      assert.ok(labels.some((l) => l.includes("config.yaml")));
      assert.ok(labels.some((l) => l.includes("RULES.md")));
      assert.ok(labels.some((l) => l.includes("memory")));
      assert.ok(labels.some((l) => l.includes("skills")));
      assert.ok(
        labels.some((l) => l === ".oh/ directory"),
        "should include the .oh/ wrapper itself",
      );
      assert.ok(plan.totalBytes > 0, "total bytes should reflect file sizes");
    });

    it("buckets unknown .oh/ children under 'Other .oh/ entry'", () => {
      const ohDir = join(projectDir, ".oh");
      mkdirSync(ohDir, { recursive: true });
      writeFileSync(join(ohDir, "export-abc.md"), "# export\n");

      const plan = planPurge(projectDir);
      const otherEntry = plan.entries.find((e) => e.label.startsWith("Other .oh/ entry"));
      assert.ok(otherEntry, "should bucket export-* under 'Other .oh/ entry'");
      assert.match(otherEntry.label, /export-abc\.md/);
    });

    it("includes the workspace-trust entry only when this dir is trusted", () => {
      // First: dir not in trust file → no entry
      writeFileSync(trustFile, JSON.stringify({ trusted: ["/some/other/dir"] }));
      const plan1 = planPurge(projectDir);
      assert.ok(
        !plan1.entries.some((e) => e.label.startsWith("Workspace-trust")),
        "no trust entry should be planned when dir isn't trusted",
      );

      // Then: trust the dir → entry appears
      writeFileSync(trustFile, JSON.stringify({ trusted: [projectDir] }));
      const plan2 = planPurge(projectDir);
      const trustEntry = plan2.entries.find((e) => e.label.startsWith("Workspace-trust"));
      assert.ok(trustEntry, "trust entry should be planned when dir is trusted");
      assert.equal(trustEntry.jsonEdit, true);
      assert.equal(trustEntry.bytes, 0);
    });
  });

  describe("executePurge", () => {
    it("removes the .oh/ directory and reports deleted count", () => {
      const ohDir = join(projectDir, ".oh");
      mkdirSync(join(ohDir, "memory"), { recursive: true });
      writeFileSync(join(ohDir, "config.yaml"), "x");
      writeFileSync(join(ohDir, "memory", "f.md"), "x");

      const plan = planPurge(projectDir);
      const result = executePurge(plan);

      assert.equal(existsSync(ohDir), false, ".oh/ should be gone");
      assert.equal(result.errors.length, 0);
      assert.ok(result.deleted >= 1);
    });

    it("removes only the matching trust entry, leaving others intact", () => {
      writeFileSync(trustFile, JSON.stringify({ trusted: ["/keep/this/one", projectDir, "/and/this"] }));
      const plan = planPurge(projectDir);
      executePurge(plan);

      const after = JSON.parse(readFileSync(trustFile, "utf8")) as { trusted: string[] };
      assert.deepEqual(
        after.trusted.sort(),
        ["/and/this", "/keep/this/one"].sort(),
        "only the project's trust entry should be removed",
      );
    });

    it("is a no-op when called twice (idempotent)", () => {
      const ohDir = join(projectDir, ".oh");
      mkdirSync(ohDir, { recursive: true });
      writeFileSync(join(ohDir, "config.yaml"), "x");

      const plan1 = planPurge(projectDir);
      executePurge(plan1);
      const plan2 = planPurge(projectDir);
      const result2 = executePurge(plan2);

      assert.equal(plan2.entries.length, 0);
      assert.equal(result2.deleted, 0);
      assert.equal(result2.errors.length, 0);
    });
  });

  describe("formatPurgePlan", () => {
    it("renders 'nothing to delete' message for an empty plan", () => {
      const plan = planPurge(projectDir);
      const out = formatPurgePlan(plan);
      assert.match(out, /nothing to delete/);
    });

    it("includes the project path, totals, and the 'Not touched' disclaimer", () => {
      const ohDir = join(projectDir, ".oh");
      mkdirSync(ohDir, { recursive: true });
      writeFileSync(join(ohDir, "config.yaml"), "x");

      const plan = planPurge(projectDir);
      const out = formatPurgePlan(plan);
      assert.ok(out.includes(projectDir), "plan should mention the target path");
      assert.match(out, /Total:/);
      assert.match(out, /Not touched/, "plan should remind users what stays");
      assert.match(out, /sessions/, "plan should call out sessions specifically");
    });
  });

  describe("formatBytes", () => {
    it("renders bytes/KB/MB/GB", () => {
      assert.equal(formatBytes(0), "0 B");
      assert.equal(formatBytes(512), "512 B");
      assert.match(formatBytes(2048), /KB$/);
      assert.match(formatBytes(2 * 1024 * 1024), /MB$/);
      assert.match(formatBytes(3 * 1024 * 1024 * 1024), /GB$/);
    });
  });
});
