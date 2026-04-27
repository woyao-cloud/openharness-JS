/**
 * MCP `roots/list` responder (audit B3).
 *
 * The MCP spec lets a server ask the client "which file system roots are in
 * scope?" via the `roots/list` request. This module owns OH's answer.
 *
 * Roots are computed at request time (no caching) so a `cd` inside the REPL
 * or a future `--add-dir` flag flip is reflected immediately. The set is:
 *   - process.cwd() — always included
 *   - any directories supplied via `setExtraRoots()` — for `--add-dir` /
 *     `/add-dir` integrations once they're properly wired (audit A7 deferred).
 *
 * Pure module with one mutable Set; the SDK handler in `transport.ts` calls
 * `getRoots()` at request time. Exported `setExtraRoots` lets later wiring
 * extend the set without restarting the MCP connection.
 */

import { pathToFileURL } from "node:url";

const extraRoots: Set<string> = new Set();

export interface McpRoot {
  uri: string;
  name?: string;
}

/**
 * Build the current root list. Always includes the process cwd. Extra roots
 * (added via `setExtraRoots`) are deduplicated against the cwd. Each root is
 * a `file://` URI per the MCP spec; `name` is the basename for readability.
 */
export function getRoots(): McpRoot[] {
  const seen = new Set<string>();
  const out: McpRoot[] = [];
  const push = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    const uri = pathToFileURL(path).toString();
    const segments = path.split(/[\\/]/).filter(Boolean);
    const name = segments[segments.length - 1] ?? path;
    out.push({ uri, name });
  };
  push(process.cwd());
  for (const p of extraRoots) push(p);
  return out;
}

/**
 * Replace the extra-roots set. Empty array clears it. Idempotent — passing
 * the same set twice is a no-op for downstream observers.
 *
 * @internal Public for tests + future `--add-dir` wiring.
 */
export function setExtraRoots(paths: readonly string[]): void {
  extraRoots.clear();
  for (const p of paths) extraRoots.add(p);
}

/** @internal Test-only reset. */
export function _resetRootsForTest(): void {
  extraRoots.clear();
}
