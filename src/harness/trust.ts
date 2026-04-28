/**
 * Workspace-trust store (audit U-A4).
 *
 * OH lets users configure shell hooks (`.oh/config.yaml` `hooks:`) and
 * arbitrary status-line scripts (Tier U-B1) that auto-execute as part of
 * the session loop. That's a footgun for fresh-cloned projects — a hostile
 * `.oh/config.yaml` could run shell on first launch.
 *
 * This module gates user-defined-shell execution on a one-time
 * "trust this directory" prompt, persisted in `~/.oh/trusted-dirs.json`.
 * The first time a hook or status-line script tries to run in an untrusted
 * directory, the REPL pops a question; trusted dirs skip the prompt forever.
 *
 * Mirrors Claude Code's workspace-trust model. Per the prior audit's
 * already-built check, OH had zero `trustedDirectories` matches anywhere —
 * this is genuinely new.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TRUST_FILE = join(homedir(), ".oh", "trusted-dirs.json");

interface TrustStore {
  /** Absolute, normalized directory paths the user has accepted. */
  trusted: string[];
}

let cached: TrustStore | undefined;

function loadStore(): TrustStore {
  if (cached) return cached;
  if (!existsSync(TRUST_FILE)) {
    cached = { trusted: [] };
    return cached;
  }
  try {
    const raw = readFileSync(TRUST_FILE, "utf8");
    const parsed = JSON.parse(raw) as { trusted?: unknown };
    if (Array.isArray(parsed.trusted)) {
      cached = { trusted: parsed.trusted.filter((p): p is string => typeof p === "string") };
      return cached;
    }
  } catch {
    /* malformed file — treat as empty so the user can re-grant */
  }
  cached = { trusted: [] };
  return cached;
}

function saveStore(store: TrustStore): void {
  cached = store;
  mkdirSync(dirname(TRUST_FILE), { recursive: true });
  writeFileSync(TRUST_FILE, JSON.stringify({ trusted: store.trusted }, null, 2));
}

/**
 * Normalize a directory for comparison. Resolves to an absolute path and
 * lowercases on Windows (which is case-insensitive for paths). Other
 * platforms keep case so distinct dirs that differ only in case are treated
 * as distinct.
 */
function normalize(dir: string): string {
  const abs = resolve(dir);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Check whether `dir` is trusted. Pure read — never prompts. */
export function isTrusted(dir: string): boolean {
  const store = loadStore();
  const target = normalize(dir);
  return store.trusted.some((t) => normalize(t) === target);
}

/**
 * Whether the user has ever interacted with the trust system. Used by the
 * hook gate as a soft-rollout switch: before the file exists, we treat all
 * dirs as trusted (legacy behavior — existing users not affected). Once
 * the user grants trust to even one workspace, the gate switches on for
 * every other dir. Mirrors the design pattern of "explicit opt-in once,
 * enforce always after."
 *
 * Bypasses the in-memory cache so it picks up writes from a parallel
 * process (e.g., `oh trust` run from another shell while a session is up).
 */
export function trustSystemActive(): boolean {
  return existsSync(TRUST_FILE);
}

/**
 * Mark `dir` as trusted. Idempotent — a second call is a no-op. Persists
 * immediately so a process crash before the next prompt doesn't lose the
 * grant.
 */
export function trust(dir: string): void {
  const store = loadStore();
  const target = normalize(dir);
  if (store.trusted.some((t) => normalize(t) === target)) return;
  saveStore({ trusted: [...store.trusted, dir] });
}

/** List currently-trusted dirs. For diagnostics / `oh status`. */
export function listTrusted(): readonly string[] {
  return loadStore().trusted;
}

/** @internal Test-only reset. */
export function _resetTrustForTest(): void {
  cached = undefined;
}
