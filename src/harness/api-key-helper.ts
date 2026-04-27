/**
 * Run the configured `apiKeyHelper` script and return its trimmed stdout as
 * the API key (audit B8). Mirrors Claude Code's `apiKeyHelper`.
 *
 * Invocation:
 *   - shell: true (so `helper-script.sh` and pipelines work without an explicit shell)
 *   - 5s timeout (helper should be fast — it's invoked at credential-fetch time)
 *   - OH_PROVIDER env var set so a single helper can dispatch by provider
 *   - stderr captured and surfaced on failure
 *
 * Failure modes — all return undefined (caller falls through to legacy config):
 *   - non-zero exit code
 *   - timeout
 *   - empty stdout
 *   - spawn error (helper not found, permission denied, etc.)
 *
 * Failures are logged via `debug("config", ...)` so users can opt into
 * visibility with `--debug config` without polluting normal output.
 */

import { spawnSync } from "node:child_process";
import { debug } from "../utils/debug.js";

export interface RunApiKeyHelperOptions {
  /** Provider name passed to the helper as `OH_PROVIDER`. */
  provider: string;
  /** Spawn timeout in ms. Defaults to 5_000. */
  timeoutMs?: number;
}

/**
 * Execute `command` via the user's shell with `OH_PROVIDER` set, return the
 * trimmed stdout on success, undefined on any failure. Pure side-effect-only —
 * no caching here; resolveApiKey owns lifetime.
 */
export function runApiKeyHelper(command: string, opts: RunApiKeyHelperOptions): string | undefined {
  const timeout = opts.timeoutMs ?? 5_000;
  try {
    const result = spawnSync(command, {
      shell: true,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OH_PROVIDER: opts.provider },
      encoding: "utf8",
    });
    if (result.error) {
      debug("config", "apiKeyHelper spawn failed", { provider: opts.provider, err: result.error.message });
      return undefined;
    }
    if (result.signal === "SIGTERM") {
      debug("config", "apiKeyHelper timed out", { provider: opts.provider, timeoutMs: timeout });
      return undefined;
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").toString().trim().slice(0, 500);
      debug("config", "apiKeyHelper non-zero exit", {
        provider: opts.provider,
        exit: result.status,
        stderr,
      });
      return undefined;
    }
    const out = (result.stdout ?? "").toString().trim();
    if (!out) {
      debug("config", "apiKeyHelper produced empty stdout", { provider: opts.provider });
      return undefined;
    }
    debug("config", "apiKeyHelper resolved", { provider: opts.provider, length: out.length });
    return out;
  } catch (err) {
    debug("config", "apiKeyHelper threw", {
      provider: opts.provider,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
