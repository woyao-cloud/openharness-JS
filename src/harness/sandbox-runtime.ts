/**
 * OS-level sandbox integration via the optional `@anthropic-ai/sandbox-runtime`
 * package. The package wraps a shell command in bubblewrap (Linux) or
 * sandbox-exec (macOS) plus a network proxy that filters by domain allowlist.
 *
 * Boundaries:
 * - **Linux + macOS**: real sandboxing via the package's static API.
 * - **Windows**: not supported by the package — every wrap call returns null
 *   (graceful passthrough; tools spawn unsandboxed). Documented in SECURITY.md.
 * - **Package not installed**: same passthrough behavior — installs cleanly
 *   without the optional dep on any platform.
 *
 * Lifecycle:
 * - Initialized once per process on the first wrap request.
 * - One `SandboxManager.initialize` covers all subsequent wrap calls.
 * - No reset — the package documents auto-cleanup on process exit.
 *
 * Opt-in: callers pass `{ enabled: true }` (typically derived from
 * `OhConfig.sandbox.enabled` or the `--sandbox` CLI flag). The default is
 * off so existing users see no behavior change.
 */

import type { OhConfig } from "./config.js";

export type SandboxConfig = NonNullable<OhConfig["sandbox"]>;

// Cached, lazy-initialized handle. We deliberately don't expose this — callers
// only see `wrapForSandbox` / `isSandboxAvailable` / `resetSandboxForTest`.
let _initPromise: Promise<SandboxModule | null> | null = null;

type SandboxModule = {
  SandboxManager: {
    initialize: (cfg: unknown) => Promise<void>;
    wrapWithSandbox: (command: string) => Promise<string>;
    reset: () => Promise<void>;
  };
};

/**
 * Returns true on Linux/macOS where sandboxing is supported. Windows is
 * unsupported by the underlying package, so we short-circuit there to avoid
 * a misleading "tried to load and failed" log.
 */
export function isSandboxAvailable(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

async function loadAndInitialize(config: SandboxConfig): Promise<SandboxModule | null> {
  if (!isSandboxAvailable()) return null;
  let mod: SandboxModule;
  try {
    mod = (await import("@anthropic-ai/sandbox-runtime")) as unknown as SandboxModule;
  } catch {
    // Optional dep not installed — graceful passthrough.
    return null;
  }
  try {
    await mod.SandboxManager.initialize({
      network: {
        allowedDomains: config.network?.allowedDomains ?? [],
        deniedDomains: config.network?.deniedDomains ?? [],
      },
      filesystem: {
        allowWrite: config.filesystem?.allowWrite ?? [process.cwd()],
        denyWrite: config.filesystem?.denyWrite ?? [],
        denyRead: config.filesystem?.denyRead ?? [],
      },
    });
  } catch {
    // Init can fail when bubblewrap / sandbox-exec aren't installed, or when
    // the user's profile rejects the proxy ports. Falling back to passthrough
    // is correct — opting in promised "use sandbox if you can," not "fail
    // closed" — that's a separate `requireSandbox` mode for a future revision.
    return null;
  }
  return mod;
}

/**
 * Wrap a shell command for sandboxed execution.
 *
 * Returns the wrapped command (a single shell string suitable for
 * `spawn(cmd, { shell: "/bin/bash" })`) when sandboxing is enabled and
 * available. Returns null in every other case — Windows, missing package,
 * disabled config, init failure — so the caller falls through to the
 * unsandboxed code path unchanged.
 */
export async function wrapForSandbox(command: string, config: SandboxConfig): Promise<string | null> {
  if (!config.enabled) return null;
  if (!_initPromise) {
    _initPromise = loadAndInitialize(config);
  }
  const mod = await _initPromise;
  if (!mod) return null;
  try {
    return await mod.SandboxManager.wrapWithSandbox(command);
  } catch {
    return null;
  }
}

/**
 * Test-only: reset the cached init promise so unit tests can re-init with
 * different configs.
 *
 * @internal
 */
export function _resetSandboxForTest(): void {
  _initPromise = null;
}
