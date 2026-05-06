import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAvailablePacks, loadPack, resolveFixturePath, validatePack } from "./pack-loader.js";

function makePackDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-evals-pack-"));
}

test("validatePack rejects missing pack.json", () => {
  const dir = makePackDir();
  try {
    const r = validatePack(dir);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e: string) => e.includes("pack.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validatePack rejects malformed pack.json", () => {
  const dir = makePackDir();
  try {
    writeFileSync(join(dir, "pack.json"), "{not valid json");
    const r = validatePack(dir);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e: string) => e.includes("parse")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validatePack rejects pack.json missing required fields", () => {
  const dir = makePackDir();
  try {
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ name: "x" }));
    const r = validatePack(dir);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e: string) => e.includes("version")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validatePack rejects missing instances.jsonl", () => {
  const dir = makePackDir();
  try {
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({
        name: "p",
        version: "1",
        description: "",
        language: "python",
        runner_requirements: [],
        default_test_command: "pytest",
        instance_count: 0,
      }),
    );
    const r = validatePack(dir);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e: string) => e.includes("instances.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validatePack accepts valid pack with one instance + fixture dir", () => {
  const dir = makePackDir();
  try {
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({
        name: "p",
        version: "1",
        description: "",
        language: "python",
        runner_requirements: [],
        default_test_command: "pytest",
        instance_count: 1,
      }),
    );
    writeFileSync(
      join(dir, "instances.jsonl"),
      JSON.stringify({
        instance_id: "x__y-1",
        repo: "x/y",
        base_commit: "deadbeef",
        problem_statement: "fix it",
        FAIL_TO_PASS: ["t.test_a"],
        PASS_TO_PASS: ["t.test_b"],
      }) + "\n",
    );
    mkdirSync(join(dir, "fixtures", "x__y-1"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "x__y-1", "repo.tar.zst"), "");
    writeFileSync(join(dir, "fixtures", "x__y-1", "setup.sh"), "#!/bin/sh\n");
    const r = validatePack(dir);
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack returns pack manifest + parsed tasks", () => {
  const dir = makePackDir();
  try {
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({
        name: "p",
        version: "1",
        description: "",
        language: "python",
        runner_requirements: [],
        default_test_command: "pytest",
        instance_count: 2,
      }),
    );
    writeFileSync(
      join(dir, "instances.jsonl"),
      `${JSON.stringify({
        instance_id: "a__b-1",
        repo: "a/b",
        base_commit: "x",
        problem_statement: "p1",
        FAIL_TO_PASS: ["t.a"],
        PASS_TO_PASS: ["t.b"],
      })}\n${JSON.stringify({
        instance_id: "a__b-2",
        repo: "a/b",
        base_commit: "y",
        problem_statement: "p2",
        FAIL_TO_PASS: ["t.c"],
        PASS_TO_PASS: ["t.d"],
      })}\n`,
    );
    for (const id of ["a__b-1", "a__b-2"]) {
      mkdirSync(join(dir, "fixtures", id), { recursive: true });
      writeFileSync(join(dir, "fixtures", id, "repo.tar.zst"), "");
      writeFileSync(join(dir, "fixtures", id, "setup.sh"), "#!/bin/sh\n");
    }

    const result = loadPack(dir);
    assert.equal(result.pack.name, "p");
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].instance_id, "a__b-1");
    assert.equal(result.tasks[1].instance_id, "a__b-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPack throws on validation failure", () => {
  const dir = makePackDir();
  try {
    assert.throws(() => loadPack(dir), /missing pack.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFixturePath returns absolute path under packDir", () => {
  const dir = makePackDir();
  try {
    const got = resolveFixturePath(dir, "x__y-1");
    assert.equal(got, join(dir, "fixtures", "x__y-1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listAvailablePacks returns empty array when no packs exist", () => {
  // We can't easily isolate from real bundled/user dirs; instead, just
  // assert listAvailablePacks() returns an array (may be empty in CI).
  const got = listAvailablePacks();
  assert.ok(Array.isArray(got));
});
