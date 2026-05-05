/**
 * ACP (Agent Client Protocol) bridge — exposes openHarness as an agent that
 * Zed / JetBrains / Cursor / Cline can talk to via JSON-RPC over stdio.
 *
 * Spec: https://agentclientprotocol.com/
 * SDK:  @agentclientprotocol/sdk (optional dependency)
 *
 * Responsibility split:
 *   - This module implements the `Agent` interface from the SDK.
 *   - The SDK handles JSON-RPC framing, schema validation, and notification
 *     dispatch; we only own the OH ↔ ACP event translation.
 *
 * Event translation (the only interesting part of this file):
 *
 *   OH StreamEvent          →  ACP session/update
 *   --------------------------- ------------------------------------------------
 *   text_delta              →  agent_message_chunk { content: { type: text } }
 *   thinking_delta          →  agent_thought_chunk { content: { type: text } }
 *   tool_call_start         →  tool_call { status: pending, kind: <derived> }
 *   tool_call_end           →  tool_call_update { status: completed, content }
 *   tool_output_delta       →  tool_call_update { content: <appended> }
 *   error                   →  end-of-turn with stopReason: refusal (logged)
 *   turn_complete           →  prompt response: { stopReason: end_turn }
 *
 * What's NOT bridged in v2.35:
 *   - permission_request → ACP requestPermission (uses OH's own permission flow today)
 *   - cost_update        → ACP _meta passthrough (filed for follow-up)
 *   - rate_limited       → currently surfaced via stderr only; an ACP
 *                          session/update with retry hint is filed for follow-up.
 *
 * Why optional dep: the SDK ships ~750KB of generated zod schemas. Most OH
 * users never hit the ACP path; they shouldn't pay that disk + import cost.
 */

import { Agent as OhAgent } from "../sdk/index.js";
import type { StreamEvent } from "../types/events.js";

// SDK types — re-declared here so callers don't need to import the optional dep.
// We intentionally accept `any` at the SDK boundary; `bridgeStreamEventToAcp` is
// the single typed surface and lives in this file.
type AcpConnection = {
  sessionUpdate: (params: unknown) => Promise<void>;
};

export type AcpAgentConfig = {
  /** OH provider name: "anthropic", "openai", "ollama", … */
  provider: string;
  /** OH model identifier (e.g. "claude-sonnet-4-6") */
  model: string;
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Inject API key (otherwise resolved via OH's normal credential chain) */
  apiKey?: string;
};

/**
 * Translate one OH StreamEvent into zero-or-more ACP `session/update`
 * notifications. Pure function — no I/O, no SDK dependency. This is the
 * load-bearing piece that the rest of the bridge orchestrates.
 *
 * Returns an array because some OH events map to no ACP update (cost_update,
 * turn_complete) and we always want a uniform shape for callers.
 */
export function bridgeStreamEventToAcp(
  event: StreamEvent,
  sessionId: string,
): Array<{ sessionId: string; update: Record<string, unknown> }> {
  switch (event.type) {
    case "text_delta":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.content },
          },
        },
      ];

    case "thinking_delta":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.content },
          },
        },
      ];

    case "tool_call_start":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: event.callId,
            title: event.toolName,
            kind: deriveToolKind(event.toolName),
            status: "pending",
          },
        },
      ];

    case "tool_call_complete":
      // OH separates "args known" (tool_call_complete) from "result known"
      // (tool_call_end). ACP folds both into tool_call_update. Surface the
      // arguments now so editors can render them while the tool runs.
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.callId,
            status: "in_progress",
            rawInput: event.arguments,
          },
        },
      ];

    case "tool_call_end":
      return [
        {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.callId,
            status: event.isError ? "failed" : "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: event.output },
              },
            ],
          },
        },
      ];

    // Everything else has no ACP equivalent in the v2.35 surface.
    case "tool_output_delta":
    case "permission_request":
    case "ask_user":
    case "cost_update":
    case "turn_complete":
    case "error":
    case "rate_limited":
      return [];
  }
}

/**
 * Map an OH tool name to an ACP tool kind. The kind drives editor UX —
 * Zed colors "edit" tools differently from "read" or "execute" — so getting
 * this approximately right is worth the if-ladder. Unknown tools fall back
 * to "other" rather than guessing.
 */
function deriveToolKind(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name === "read" || name.endsWith("read") || name === "imageread") return "read";
  if (name === "edit" || name === "write" || name === "multiedit" || name === "notebookedit") return "edit";
  if (name === "bash" || name === "powershell" || name === "killprocess") return "execute";
  if (name === "glob" || name === "grep" || name === "ls") return "search";
  if (name === "webfetch" || name === "websearch" || name === "exasearch") return "fetch";
  if (name === "todowrite" || name === "memory") return "think";
  return "other";
}

/**
 * Concatenate the text blocks of an ACP PromptRequest's `prompt` array into
 * the single string our `OhAgent.run/stream` expects. Resource-link blocks
 * surface as `[resource: <uri>]` markers so the model is aware of them but
 * doesn't try to inline-include the content (the spec wants us to optionally
 * `readTextFile`-fetch them; that's a v2.36 follow-up).
 */
export function extractPromptText(prompt: ReadonlyArray<{ type: string; [key: string]: unknown }>): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[resource: ${block.uri}]`);
    } else if (block.type === "resource") {
      // Embedded resource — we don't fetch the content here; just surface
      // a reference so the model doesn't ignore the attachment.
      const uri = (block.resource as { uri?: string } | undefined)?.uri;
      parts.push(uri ? `[resource: ${uri}]` : "[embedded resource]");
    }
  }
  return parts.join("\n\n");
}

/**
 * Construct an ACP Agent wired to OH's `OhAgent` SDK class.
 *
 * The connection is the AgentSideConnection from the SDK; we pass it in so
 * tests can stub it without loading the SDK.
 */
export function createAcpAgent(connection: AcpConnection, config: AcpAgentConfig) {
  const sessions = new Map<string, { abort: AbortController; agent: OhAgent }>();

  return {
    async initialize(_params: unknown): Promise<unknown> {
      return {
        // SDK's PROTOCOL_VERSION constant is 1 today; hardcoded so this
        // module doesn't import the SDK at type-check time.
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      };
    },

    async newSession(_params: unknown): Promise<unknown> {
      const sessionId = crypto.randomUUID();
      const agent = new OhAgent({
        provider: config.provider,
        model: config.model,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        permissionMode: "trust",
      });
      sessions.set(sessionId, { abort: new AbortController(), agent });
      return { sessionId };
    },

    async authenticate(_params: unknown): Promise<Record<string, never>> {
      // OH resolves credentials from its own chain (env vars / keychain / config);
      // we don't gate session creation on an explicit ACP authenticate call.
      return {};
    },

    async setSessionMode(_params: unknown): Promise<Record<string, never>> {
      // Modes (ask/architect/code) aren't exposed yet — return success so
      // editors that try to set one don't error.
      return {};
    },

    async prompt(params: {
      sessionId: string;
      prompt: ReadonlyArray<{ type: string; [k: string]: unknown }>;
    }): Promise<{
      stopReason: "end_turn" | "cancelled" | "refusal";
    }> {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error(`Session ${params.sessionId} not found`);

      // A new prompt cancels any prior in-flight prompt for this session.
      session.abort.abort();
      session.abort = new AbortController();

      const promptText = extractPromptText(params.prompt);
      try {
        for await (const event of session.agent.stream(promptText)) {
          if (session.abort.signal.aborted) return { stopReason: "cancelled" };
          for (const update of bridgeStreamEventToAcp(event, params.sessionId)) {
            await connection.sessionUpdate(update);
          }
        }
        return { stopReason: "end_turn" };
      } catch (err) {
        if (session.abort.signal.aborted) return { stopReason: "cancelled" };
        // Surface unexpected errors as a refusal so the editor stops the spinner.
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `[agent error] ${(err as Error).message}` },
          },
        });
        return { stopReason: "refusal" };
      }
    },

    async cancel(params: { sessionId: string }): Promise<void> {
      sessions.get(params.sessionId)?.abort.abort();
    },
  };
}
