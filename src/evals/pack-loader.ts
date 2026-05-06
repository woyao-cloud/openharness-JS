/**
 * oh evals — pack loader. Loads, validates, and resolves fixture paths
 * for eval packs from disk.
 *
 * Bundled packs live under `data/evals/packs/<name>/`. User-installed packs
 * live under `~/.oh/evals/packs/<name>/`. Bundled packs win precedence on
 * name collision (so users can't shadow `swe-bench-lite-mini` accidentally).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalsPack, EvalsTask } from "./types.js";

const REQUIRED_PACK_FIELDS: (keyof EvalsPack)[] = [
  "name",
  "version",
  "description",
  "language",
  "runner_requirements",
  "default_test_command",
  "instance_count",
];

const REQUIRED_TASK_FIELDS: (keyof EvalsTask)[] = [
  "instance_id",
  "repo",
  "base_commit",
  "problem_statement",
  "FAIL_TO_PASS",
  "PASS_TO_PASS",
];

export function validatePack(packDir: string): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const packJsonPath = join(packDir, "pack.json");

  if (!existsSync(packJsonPath)) {
    errors.push(`missing pack.json at ${packJsonPath}`);
    return { ok: false, errors };
  }

  let pack: unknown;
  try {
    pack = JSON.parse(readFileSync(packJsonPath, "utf-8"));
  } catch (err) {
    errors.push(`failed to parse pack.json: ${(err as Error).message}`);
    return { ok: false, errors };
  }

  if (typeof pack !== "object" || pack === null) {
    errors.push(`pack.json is not an object`);
    return { ok: false, errors };
  }

  for (const field of REQUIRED_PACK_FIELDS) {
    if (!(field in (pack as Record<string, unknown>))) {
      errors.push(`pack.json missing required field: ${field}`);
    }
  }

  const instancesPath = join(packDir, "instances.jsonl");
  if (!existsSync(instancesPath)) {
    errors.push(`missing instances.jsonl at ${instancesPath}`);
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }

  const lines = readFileSync(instancesPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let task: unknown;
    try {
      task = JSON.parse(lines[i]);
    } catch (err) {
      errors.push(`instances.jsonl:${lineNo} parse error: ${(err as Error).message}`);
      continue;
    }
    if (typeof task !== "object" || task === null) {
      errors.push(`instances.jsonl:${lineNo} not an object`);
      continue;
    }
    for (const field of REQUIRED_TASK_FIELDS) {
      if (!(field in (task as Record<string, unknown>))) {
        errors.push(`instances.jsonl:${lineNo} missing required field: ${field}`);
      }
    }
    const instanceId = (task as { instance_id?: string }).instance_id;
    if (typeof instanceId === "string") {
      const fixtureDir = join(packDir, "fixtures", instanceId);
      if (!existsSync(fixtureDir)) {
        errors.push(`fixture dir missing for ${instanceId} at ${fixtureDir}`);
      } else {
        if (!existsSync(join(fixtureDir, "repo.tar.zst"))) {
          errors.push(`fixture missing repo.tar.zst for ${instanceId}`);
        }
        if (!existsSync(join(fixtureDir, "setup.sh"))) {
          errors.push(`fixture missing setup.sh for ${instanceId}`);
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function loadPack(packDir: string): { pack: EvalsPack; tasks: EvalsTask[] } {
  const r = validatePack(packDir);
  if (!r.ok) {
    throw new Error(`pack at ${packDir} failed validation:\n  - ${r.errors.join("\n  - ")}`);
  }
  const pack = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf-8")) as EvalsPack;
  const lines = readFileSync(join(packDir, "instances.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const tasks = lines.map((l) => JSON.parse(l) as EvalsTask);
  return { pack, tasks };
}

export function resolveFixturePath(packDir: string, instanceId: string): string {
  return join(packDir, "fixtures", instanceId);
}

/** Returns names of packs found in bundled and user directories. Bundled wins on collision. */
export function listAvailablePacks(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const root of packSearchRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory() && existsSync(join(full, "pack.json")) && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out;
}

/**
 * Resolve a pack by name to its on-disk directory. Bundled packs (under
 * the package's data/evals/packs/) win precedence over user packs
 * (~/.oh/evals/packs/).
 */
export function resolvePackDir(packName: string): string | null {
  for (const root of packSearchRoots()) {
    const candidate = join(root, packName);
    if (existsSync(join(candidate, "pack.json"))) return candidate;
  }
  return null;
}

function packSearchRoots(): string[] {
  // Bundled: packaged data/evals/packs/, located relative to this module.
  // In dev: src/evals/pack-loader.ts → ../../data/evals/packs/
  // In published build: dist/evals/pack-loader.js → ../../data/evals/packs/
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "..", "data", "evals", "packs");
  const user = join(homedir(), ".oh", "evals", "packs");
  return [bundled, user];
}
