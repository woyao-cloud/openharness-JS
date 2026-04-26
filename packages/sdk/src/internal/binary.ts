/**
 * Locate the `oh` CLI binary. Mirrors `python/openharness/_binary.py`.
 *
 * Resolution order:
 *   1. The `override` argument, if provided.
 *   2. `OH_BINARY` env var, if it points to an existing file.
 *   3. `oh` on PATH.
 *
 * Returns a `{ command, prefixArgs }` handle so the spawn caller can pass
 * `[...prefixArgs, ...userArgs]`. The split lets us point `OH_BINARY` at a
 * `.cjs`/`.mjs`/`.js` file (useful for development and tests) — in that case
 * `command` is `process.execPath` (the current node binary) and the script
 * path is the first prefix arg.
 */

import { accessSync, constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { OhBinaryNotFoundError } from "../errors.js";

export interface OhBinaryHandle {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

const SCRIPT_EXT = /\.(c?js|mjs)$/i;

function exists(p: string): boolean {
  try {
    accessSync(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | null {
  const PATH = process.env.PATH ?? process.env.Path ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim())
      : [""];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function findOhBinary(override?: string): OhBinaryHandle {
  const candidate = override ?? process.env.OH_BINARY ?? findOnPath("oh");
  if (!candidate || !exists(candidate)) {
    throw new OhBinaryNotFoundError();
  }
  if (SCRIPT_EXT.test(candidate)) {
    return { command: process.execPath, prefixArgs: [candidate] };
  }
  return { command: candidate, prefixArgs: [] };
}
