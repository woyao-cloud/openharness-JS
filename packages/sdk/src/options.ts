/**
 * Public option types for `query()` and `OpenHarnessClient`.
 *
 * Mirrors `python/openharness/options.py` and `query.py`. Field shape is the
 * canonical TypeScript surface; the wire is camelCase already, so no
 * conversion is needed here.
 */

import type { PermissionCallback } from "./permissions.js";
import type { ToolDefinition } from "./tools.js";

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
  /**
   * TypeScript tools to expose to the agent for the lifetime of this call.
   * The SDK starts an in-process MCP HTTP server, registers each tool, and
   * writes an ephemeral `.oh/config.yaml` pointing the spawned `oh` CLI at
   * it. Use {@link tool} for ergonomic construction.
   */
  tools?: ToolDefinition[];
  /**
   * Permission gate. When set, the SDK starts an in-process HTTP server and
   * routes every `permissionRequest` hook through this callback. Sync and
   * async callbacks both work. Failures (throw / timeout / unrecognised
   * return) all surface as `deny` — fail-closed.
   *
   * Requires the `oh` CLI shipped in `@zhijiewang/openharness` v2.16.0+.
   */
  canUseTool?: PermissionCallback;
}
