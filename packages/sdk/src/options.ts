/**
 * Public option types for `query()` and `OpenHarnessClient`.
 *
 * Mirrors `python/openharness/options.py` and `query.py`. Field shape is the
 * canonical TypeScript surface; the wire is camelCase already, so no
 * conversion is needed here.
 */

export type PermissionMode = "ask" | "trust" | "deny" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export interface OpenHarnessOptions {
  /** Model string (e.g. `"ollama/llama3"`, `"claude-sonnet-4-6"`). */
  model?: string;
  /** Permission gate mode for the spawned CLI. Defaults to `"trust"` so headless callers don't hang on prompts. */
  permissionMode?: PermissionMode;
  /** Whitelist of tool names. Tools outside this list are blocked. */
  allowedTools?: readonly string[];
  /** Blacklist of tool names. */
  disallowedTools?: readonly string[];
  /** Maximum number of model turns before the session ends. Defaults to 20. */
  maxTurns?: number;
  /** Override the default system prompt. */
  systemPrompt?: string;
  /** Working directory for the spawned CLI. */
  cwd?: string;
  /** Environment variables for the CLI. Merged on top of `process.env`. */
  env?: Record<string, string>;
  /** Optional override for the `oh` binary path. Equivalent to `OH_BINARY=`. */
  ohBinary?: string;
}
