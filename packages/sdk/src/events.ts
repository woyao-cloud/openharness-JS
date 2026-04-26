/**
 * Streamed events from `oh run --output-format stream-json` / `oh session`.
 *
 * Mirror `python/openharness/events.py`. Wire format is defined in
 * `src/main.tsx` (the stream-json branches around lines 257–530). Keep this
 * file in lockstep — divergence breaks streaming.
 */

export interface BaseEvent {
  readonly type: string;
}

export interface TextDelta extends BaseEvent {
  readonly type: "text";
  readonly content: string;
}

export interface ToolStart extends BaseEvent {
  readonly type: "tool_start";
  readonly tool: string;
}

export interface ToolEnd extends BaseEvent {
  readonly type: "tool_end";
  readonly tool: string;
  readonly output: string;
  readonly error: boolean;
}

export interface ErrorEvent extends BaseEvent {
  readonly type: "error";
  readonly message: string;
}

export interface CostUpdate extends BaseEvent {
  readonly type: "cost_update";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly model: string;
}

export interface TurnComplete extends BaseEvent {
  readonly type: "turn_complete";
  readonly reason: string;
}

export interface TurnStart extends BaseEvent {
  readonly type: "turnStart";
  readonly turnNumber: number;
}

export interface TurnStop extends BaseEvent {
  readonly type: "turnStop";
  readonly turnNumber: number;
  readonly reason: string;
}

export interface SessionStart extends BaseEvent {
  readonly type: "session_start";
  readonly sessionId: string | null;
}

export interface HookDecision extends BaseEvent {
  readonly type: "hook_decision";
  readonly event: string;
  readonly tool: string | null;
  readonly decision: string;
  readonly reason: string | null;
}

export interface UnknownEvent extends BaseEvent {
  readonly type: "unknown";
  readonly raw: Readonly<Record<string, unknown>>;
}

export type Event =
  | TextDelta
  | ToolStart
  | ToolEnd
  | ErrorEvent
  | CostUpdate
  | TurnComplete
  | TurnStart
  | TurnStop
  | SessionStart
  | HookDecision
  | UnknownEvent;

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Parse one decoded JSON object into a typed event. Unknown `type` values
 * become an `UnknownEvent` so forward-compatible CLI versions emitting new
 * event types don't break existing clients.
 *
 * `ready` (emitted by `oh session` on startup) is mapped to `SessionStart`
 * — same as the Python parser.
 */
export function parseEvent(obj: Readonly<Record<string, unknown>>): Event {
  const kind = obj.type;
  switch (kind) {
    case "text":
      return { type: "text", content: asString(obj.content) };
    case "tool_start":
      return { type: "tool_start", tool: asString(obj.tool) };
    case "tool_end":
      return {
        type: "tool_end",
        tool: asString(obj.tool),
        output: asString(obj.output),
        error: asBool(obj.error),
      };
    case "error":
      return { type: "error", message: asString(obj.message) };
    case "cost_update":
      return {
        type: "cost_update",
        inputTokens: asNumber(obj.inputTokens),
        outputTokens: asNumber(obj.outputTokens),
        cost: asNumber(obj.cost),
        model: asString(obj.model),
      };
    case "turn_complete":
      return { type: "turn_complete", reason: asString(obj.reason, "completed") };
    case "turnStart":
      return { type: "turnStart", turnNumber: asNumber(obj.turnNumber) };
    case "turnStop":
      return {
        type: "turnStop",
        turnNumber: asNumber(obj.turnNumber),
        reason: asString(obj.reason, "completed"),
      };
    case "hook_decision": {
      const tool = obj.tool;
      const reason = obj.reason;
      return {
        type: "hook_decision",
        event: asString(obj.event),
        tool: tool == null ? null : asString(tool),
        decision: asString(obj.decision),
        reason: reason == null ? null : asString(reason),
      };
    }
    case "session_start":
    case "ready": {
      const sid = obj.sessionId;
      return {
        type: "session_start",
        sessionId: sid == null || sid === "" ? null : asString(sid),
      };
    }
    default:
      return { type: "unknown", raw: { ...obj } };
  }
}
