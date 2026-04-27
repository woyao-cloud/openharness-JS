/**
 * MCP `elicitation/create` responder (audit B4).
 *
 * MCP servers can ask the client to elicit user input — for confirmations
 * ("are you sure?"), for form fills, or for free-form text. The spec defines
 * three response actions:
 *   - `accept`   → user agreed; `content` may contain form values
 *   - `decline`  → user explicitly said no
 *   - `cancel`   → user dismissed without choosing (e.g. closed the prompt)
 *
 * Default behavior is **fail-safe decline** — when nothing decides, OH
 * returns `{ action: "decline" }`. This keeps OH from accepting actions
 * silently in headless / unattended mode. To accept, configure an
 * `elicitation` hook that returns `permissionDecision: "allow"`, or wire an
 * interactive handler via `setElicitationHandler` (the REPL will plug in
 * when its UX support lands; until then the hook path is the supported
 * extension point).
 *
 * Two hook events fire per elicitation:
 *   - `elicitation`        — request received, before any decision
 *   - `elicitationResult`  — final action + content, after decision is made
 *
 * Both carry the server name and message so audit hooks can log the
 * full request/response pair.
 */

import { emitHook, emitHookWithOutcome } from "../harness/hooks.js";

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationRequest {
  /** Server name — for hook context. Not part of the MCP wire format. */
  serverName: string;
  /** Human-readable message the server wants to show the user. */
  message: string;
  /** JSON Schema describing the structured content the server expects on accept. */
  requestedSchema: unknown;
}

export interface ElicitationResponse {
  action: ElicitationAction;
  content?: Record<string, unknown>;
}

/**
 * Optional interactive handler — called when no hook decided. The REPL is
 * the natural caller; until that lands, leaving this unset means OH falls
 * straight from the hook to the auto-decline default.
 */
export type InteractiveElicitationHandler = (req: ElicitationRequest) => Promise<ElicitationResponse>;

let interactiveHandler: InteractiveElicitationHandler | undefined;

/**
 * Register / replace the interactive elicitation handler. Pass `undefined`
 * to clear (for tests / REPL teardown). Idempotent.
 */
export function setElicitationHandler(handler: InteractiveElicitationHandler | undefined): void {
  interactiveHandler = handler;
}

/**
 * Resolve an MCP `elicitation/create` request into an `ElicitationResponse`.
 *
 * Decision priority:
 *   1. `elicitation` hook returns a decision → honor it (allow → accept, deny → decline)
 *   2. Interactive handler is registered → delegate to it
 *   3. Default → `{ action: "decline" }`
 *
 * Always fires the symmetric `elicitationResult` hook last, so audit hooks
 * see the full request/response pair regardless of which branch decided.
 *
 * @internal Exported for tests; transport.ts is the production caller.
 */
export async function resolveElicitation(req: ElicitationRequest): Promise<ElicitationResponse> {
  const hookCtx = {
    elicitationServer: req.serverName,
    elicitationMessage: req.message.slice(0, 500),
    // Schema can be large; cap at 2 KB so hooks don't OOM env vars.
    elicitationSchema: JSON.stringify(req.requestedSchema).slice(0, 2_000),
  };

  let response: ElicitationResponse;

  const hookOutcome = await emitHookWithOutcome("elicitation", hookCtx);
  if (hookOutcome.permissionDecision === "allow") {
    response = { action: "accept", content: {} };
  } else if (hookOutcome.permissionDecision === "deny" || !hookOutcome.allowed) {
    response = { action: "decline" };
  } else if (interactiveHandler) {
    try {
      response = await interactiveHandler(req);
    } catch {
      // Interactive handler crashed — fail-safe decline rather than swallow.
      response = { action: "cancel" };
    }
  } else {
    // Headless default — never accept silently.
    response = { action: "decline" };
  }

  emitHook("elicitationResult", {
    elicitationServer: req.serverName,
    elicitationMessage: req.message.slice(0, 500),
    elicitationAction: response.action,
    elicitationContent: response.content ? JSON.stringify(response.content).slice(0, 2_000) : undefined,
  });

  return response;
}

/** @internal Test-only reset. */
export function _resetElicitationForTest(): void {
  interactiveHandler = undefined;
}
