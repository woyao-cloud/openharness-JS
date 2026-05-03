import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { invalidateConfigCache } from "./config.js";
import { recordSessionStart, resetTelemetry } from "./telemetry.js";

describe("telemetry", () => {
  let projectDir: string;
  let telemetryDirPath: string;
  let prevCwd: string;
  let prevTelemEnv: string | undefined;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevTelemEnv = process.env.OH_TELEMETRY_DIR;
    projectDir = mkdtempSync(join(tmpdir(), "oh-telem-proj-"));
    telemetryDirPath = mkdtempSync(join(tmpdir(), "oh-telem-out-"));
    mkdirSync(join(projectDir, ".oh"), { recursive: true });
    writeFileSync(
      join(projectDir, ".oh", "config.yaml"),
      "provider: ollama\nmodel: llama3\npermissionMode: ask\ntelemetry:\n  enabled: true\n",
    );
    process.chdir(projectDir);
    process.env.OH_TELEMETRY_DIR = telemetryDirPath;
    invalidateConfigCache();
    resetTelemetry();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevTelemEnv === undefined) delete process.env.OH_TELEMETRY_DIR;
    else process.env.OH_TELEMETRY_DIR = prevTelemEnv;
    invalidateConfigCache();
    resetTelemetry();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(telemetryDirPath, { recursive: true, force: true });
  });

  it("writes events for distinct sessionIds to distinct files (no module-level cache)", () => {
    // Regression: previously a module-level `_sessionFile` cache locked onto
    // the first sessionId seen in the process, so a second session's events
    // were written to the first session's .jsonl file.
    recordSessionStart("session-a", "ollama", "llama3");
    recordSessionStart("session-b", "openai", "gpt-4");

    const fileA = join(telemetryDirPath, "session-a.jsonl");
    const fileB = join(telemetryDirPath, "session-b.jsonl");

    assert.ok(existsSync(fileA), "session-a.jsonl should exist");
    assert.ok(existsSync(fileB), "session-b.jsonl should exist (would fail under the singleton bug)");

    const eventsA = readFileSync(fileA, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const eventsB = readFileSync(fileB, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    assert.equal(eventsA.length, 1);
    assert.equal(eventsA[0].sessionId, "session-a");
    assert.equal(eventsA[0].payload.provider, "ollama");

    assert.equal(eventsB.length, 1);
    assert.equal(eventsB[0].sessionId, "session-b");
    assert.equal(eventsB[0].payload.provider, "openai");
  });
});
