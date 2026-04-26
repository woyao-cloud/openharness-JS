/**
 * Permission callback types — the SDK side of the `canUseTool` hook.
 *
 * Mirrors the wire contract in `python/openharness/_permission_server.py`
 * (which itself matches `src/harness/hooks.ts` v2.16.0+). When the user
 * passes `canUseTool`, the SDK starts an in-process HTTP server, injects
 * a `permissionRequest` HTTP hook into the ephemeral `.oh/config.yaml`,
 * and routes each permission check through the user's callback.
 */

export type PermissionVerdict = "allow" | "deny" | "ask";

export interface PermissionContext {
  /** Always `"permissionRequest"` for this hook; included so callers can pattern-match. */
  event: "permissionRequest";
  /** Name of the tool the agent wants to call (e.g. `"Bash"`, `"Read"`). */
  toolName: string;
  /** Stringified JSON of the tool's input arguments. Parse if you need fields. */
  toolInputJson: string;
  /** Any other fields the CLI attaches to the hook event. */
  [key: string]: unknown;
}

export interface PermissionDecisionObject {
  decision: PermissionVerdict;
  reason?: string;
}

/** A callback can return either a bare verdict string or a decision-with-reason object. */
export type PermissionDecision = PermissionVerdict | PermissionDecisionObject;

/**
 * User-supplied permission gate. Receives the hook context, returns (or
 * resolves to) a decision. Sync and async are both fine.
 *
 * Failure modes the SDK handles for you (all surface as `"deny"` to the CLI):
 * - Callback throws → `{ decision: "deny", reason: "callback error: …" }`
 * - Callback times out → `{ decision: "deny", reason: "callback timeout" }`
 * - Callback returns an unrecognised value → `{ decision: "deny", reason: "…" }`
 */
export type PermissionCallback = (ctx: PermissionContext) => PermissionDecision | Promise<PermissionDecision>;
