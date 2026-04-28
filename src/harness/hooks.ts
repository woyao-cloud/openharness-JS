/**
 * Hooks system — run commands, HTTP requests, or LLM prompts on lifecycle events.
 *
 * preToolUse hooks can block tool execution (exit code 1 / allowed: false).
 * All other hooks are fire-and-forget (errors are silently ignored).
 *
 * Hook types:
 * - command: shell script (existing)
 * - http: POST JSON to URL, expect { allowed: true/false }
 * - prompt: LLM yes/no check via provider.complete()
 */

import { spawn, spawnSync } from "node:child_process";
import { debug } from "../utils/debug.js";
import type { HookDef, HooksConfig } from "./config.js";
import { readOhConfig } from "./config.js";
import { isTrusted, trustSystemActive } from "./trust.js";

export type HookEvent =
  | "sessionStart"
  | "sessionEnd"
  | "preToolUse"
  | "postToolUse"
  | "postToolUseFailure"
  | "postToolBatch"
  | "userPromptSubmit"
  | "userPromptExpansion"
  | "permissionRequest"
  | "permissionDenied"
  | "fileChanged"
  | "cwdChanged"
  | "subagentStart"
  | "subagentStop"
  | "preCompact"
  | "postCompact"
  | "configChange"
  | "notification"
  | "turnStart"
  | "turnStop"
  | "taskCreated"
  | "taskCompleted"
  | "worktreeCreate"
  | "worktreeRemove"
  | "elicitation"
  | "elicitationResult"
  | "instructionsLoaded";

export type HookContext = {
  toolName?: string;
  toolArgs?: string;
  toolOutput?: string;
  toolInputJson?: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  permissionMode?: string;
  cost?: string;
  tokens?: string;
  /** For fileChanged: the file path that changed */
  filePath?: string;
  /** For cwdChanged: the new working directory */
  newCwd?: string;
  /** For subagentStart/Stop: the agent ID */
  agentId?: string;
  /** For notification: the message */
  message?: string;
  /** For userPromptSubmit: the raw prompt text the user is about to submit */
  prompt?: string;
  /** For postToolUseFailure: short error label ("TimeoutError", "ExecutionError", "ReportedError") */
  toolError?: string;
  /** For postToolUseFailure: full error message */
  errorMessage?: string;
  /** For permissionRequest: the decision OH would take absent the hook ("ask", "allow", "deny") — informational */
  permissionAction?: "ask" | "allow" | "deny";
  /** For turnStart/turnStop: zero-indexed turn number within the current session */
  turnNumber?: string;
  /** For turnStop: reason the turn ended ("completed", "max_turns", "error", "interrupted") */
  turnReason?: string;
  /** For userPromptExpansion: the slash command that triggered the expansion (e.g. "/plan") */
  slashCommand?: string;
  /** For userPromptExpansion: the original user input before expansion */
  originalInput?: string;
  /** For postToolBatch: comma-separated list of tool names in the batch */
  batchTools?: string;
  /** For postToolBatch: number of tool calls in the batch (as a string for env-var parity) */
  batchSize?: string;
  /** For permissionDenied: stage at which the deny happened ("hook", "user", "headless", "policy") */
  denySource?: string;
  /** For permissionDenied: human-readable reason */
  denyReason?: string;
  /** For taskCreated/taskCompleted: the task id */
  taskId?: string;
  /** For taskCreated/taskCompleted: the task subject */
  taskSubject?: string;
  /** For taskCompleted: the previous status before completion (usually "in_progress") */
  taskPreviousStatus?: string;
  /** For worktreeCreate/worktreeRemove: absolute path to the worktree directory */
  worktreePath?: string;
  /** For worktreeCreate/worktreeRemove: the parent repo directory the worktree was forked from */
  worktreeParent?: string;
  /** For worktreeRemove: whether `force: true` was passed to skip the dirty-state check */
  worktreeForced?: string;
  /** For elicitation/elicitationResult: the MCP server that issued the elicitation request */
  elicitationServer?: string;
  /** For elicitation/elicitationResult: human-readable message the server wants to show (capped at 500 chars) */
  elicitationMessage?: string;
  /** For elicitation: JSON-stringified `requestedSchema` from the server (capped at 2000 chars) */
  elicitationSchema?: string;
  /** For elicitationResult: the final action ("accept" | "decline" | "cancel") */
  elicitationAction?: string;
  /** For elicitationResult: JSON-stringified content payload returned to the server (when action="accept") */
  elicitationContent?: string;
  /** For instructionsLoaded: count of rules concatenated (as a string for env-var parity) */
  rulesCount?: string;
  /** For instructionsLoaded: total character length of the loaded rules */
  rulesChars?: string;
};

let cachedHooks: HooksConfig | null | undefined;

export function getHooks(): HooksConfig | null {
  if (cachedHooks !== undefined) return cachedHooks;
  const cfg = readOhConfig();
  cachedHooks = cfg?.hooks ?? null;
  return cachedHooks;
}

/** Clear hook cache (call after config changes) */
export function invalidateHookCache(): void {
  cachedHooks = undefined;
  cachedDisableAllHooks = undefined;
}

let cachedDisableAllHooks: boolean | undefined;

/**
 * Whether the configured `disableAllHooks` kill switch is set.
 * Cached so the per-emit cost is a single boolean read.
 */
export function areHooksEnabled(): boolean {
  if (cachedDisableAllHooks === undefined) {
    cachedDisableAllHooks = readOhConfig()?.disableAllHooks === true;
  }
  return !cachedDisableAllHooks;
}

function buildEnv(event: HookEvent, ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OH_EVENT: event,
  };
  if (ctx.toolName) env.OH_TOOL_NAME = ctx.toolName;
  if (ctx.toolArgs) env.OH_TOOL_ARGS = ctx.toolArgs;
  if (ctx.toolOutput) env.OH_TOOL_OUTPUT = ctx.toolOutput;
  if (ctx.toolInputJson) env.OH_TOOL_INPUT_JSON = ctx.toolInputJson;
  if (ctx.sessionId) env.OH_SESSION_ID = ctx.sessionId;
  if (ctx.model) env.OH_MODEL = ctx.model;
  if (ctx.provider) env.OH_PROVIDER = ctx.provider;
  if (ctx.permissionMode) env.OH_PERMISSION_MODE = ctx.permissionMode;
  if (ctx.cost) env.OH_COST = ctx.cost;
  if (ctx.tokens) env.OH_TOKENS = ctx.tokens;
  if (ctx.filePath) env.OH_FILE_PATH = ctx.filePath;
  if (ctx.newCwd) env.OH_NEW_CWD = ctx.newCwd;
  if (ctx.agentId) env.OH_AGENT_ID = ctx.agentId;
  if (ctx.message) env.OH_MESSAGE = ctx.message;
  if (ctx.prompt !== undefined) {
    // Cap at 8KB to avoid Windows env-var length limits.
    const PROMPT_MAX = 8 * 1024;
    env.OH_PROMPT = ctx.prompt.length > PROMPT_MAX ? ctx.prompt.slice(0, PROMPT_MAX) : ctx.prompt;
  }
  if (ctx.toolError !== undefined) env.OH_TOOL_ERROR = ctx.toolError;
  if (ctx.errorMessage !== undefined) env.OH_ERROR_MESSAGE = ctx.errorMessage;
  if (ctx.permissionAction !== undefined) env.OH_PERMISSION_ACTION = ctx.permissionAction;
  if (ctx.turnNumber !== undefined) env.OH_TURN_NUMBER = ctx.turnNumber;
  if (ctx.turnReason !== undefined) env.OH_TURN_REASON = ctx.turnReason;
  if (ctx.worktreePath !== undefined) env.OH_WORKTREE_PATH = ctx.worktreePath;
  if (ctx.worktreeParent !== undefined) env.OH_WORKTREE_PARENT = ctx.worktreeParent;
  if (ctx.worktreeForced !== undefined) env.OH_WORKTREE_FORCED = ctx.worktreeForced;
  if (ctx.elicitationServer !== undefined) env.OH_ELICITATION_SERVER = ctx.elicitationServer;
  if (ctx.elicitationMessage !== undefined) env.OH_ELICITATION_MESSAGE = ctx.elicitationMessage;
  if (ctx.elicitationSchema !== undefined) env.OH_ELICITATION_SCHEMA = ctx.elicitationSchema;
  if (ctx.elicitationAction !== undefined) env.OH_ELICITATION_ACTION = ctx.elicitationAction;
  if (ctx.elicitationContent !== undefined) env.OH_ELICITATION_CONTENT = ctx.elicitationContent;
  return env;
}

/**
 * Evaluate a hook matcher against the current tool name.
 *
 * Supported forms (Claude Code compatible):
 *  - No matcher → always matches.
 *  - `/pattern/flags` → treated as a regex. Flags optional.
 *  - `mcp__server__tool` → literal match is a substring check (works for the
 *    standard `mcp__<server>__<tool>` naming convention).
 *  - `prefix*` or glob-ish → simple wildcard translated to regex.
 *  - Anything else → case-sensitive substring (legacy behavior — back-compat).
 */
/** @internal Exposed for testing. */
export function matchesHook(def: HookDef, ctx: HookContext): boolean {
  if (!def.match) return true;
  if (!ctx.toolName) return true;

  const match = def.match;

  // /regex/flags form
  if (match.length > 2 && match.startsWith("/")) {
    const lastSlash = match.lastIndexOf("/");
    if (lastSlash > 0) {
      try {
        const pattern = match.slice(1, lastSlash);
        const flags = match.slice(lastSlash + 1);
        return new RegExp(pattern, flags).test(ctx.toolName);
      } catch {
        return false;
      }
    }
  }

  // Simple glob: asterisks translated to `.*`, anchored. Only activates if the
  // match contains an asterisk — otherwise treat as substring for back-compat.
  if (match.includes("*")) {
    const escaped = match
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    try {
      return new RegExp(`^${escaped}$`).test(ctx.toolName);
    } catch {
      return false;
    }
  }

  // Legacy substring match
  return ctx.toolName.includes(match);
}

// ── Hook Executors ──

/** Run a command hook. Returns exit code (0 = success/allowed). */
function runCommandHookAsync(command: string, env: Record<string, string>, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command, {
      shell: true,
      timeout: timeoutMs,
      stdio: "pipe",
      env,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve(1);
      }
    }, timeoutMs);

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code ?? 1);
      }
    });

    proc.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(1);
      }
    });
  });
}

/**
 * Run a JSON-mode command hook and return the raw stdout string.
 *
 * Rejects (throws) on timeout or spawn error so callers can decide how to
 * interpret the failure. Returns an empty string when stdout is empty.
 * Rejects when the process exits with a non-zero code (callers treat this as
 * a block).
 */
function runJsonIoHookCaptureStdout(
  command: string,
  env: Record<string, string>,
  event: HookEvent,
  ctx: HookContext,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, {
      shell: true,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let settled = false;
    let stdoutBuf = "";
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("hook timed out"));
      }
    }, timeoutMs);

    proc.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
    });

    // Write the event + context JSON envelope to stdin then close it so the
    // hook knows there's no more input coming.
    try {
      const payload = JSON.stringify({ event, ...ctx });
      proc.stdin?.end(payload);
    } catch {
      /* stdin already closed — ignore */
    }

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if ((code ?? 1) !== 0) {
        reject(new Error(`hook exited with code ${code ?? 1}`));
        return;
      }

      resolve(stdoutBuf);
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Run a JSON-mode command hook (Claude Code convention).
 *
 * Sends `{event, ...context}` as JSON on stdin. Parses stdout as JSON
 * `{ decision: "allow" | "deny", reason?: string, hookSpecificOutput?: any }`.
 *
 * Gating logic:
 *   - `decision: "deny"` → blocks (returns false).
 *   - `decision: "allow"` or omitted decision → allow (returns true).
 *   - Non-zero exit code → block.
 *   - Invalid/empty JSON on stdout → fall back to exit code (0 = allow).
 *   - Timeout or spawn error → block.
 */
async function runJsonIoHookAsync(
  command: string,
  env: Record<string, string>,
  event: HookEvent,
  ctx: HookContext,
  timeoutMs = 10_000,
): Promise<boolean> {
  let stdout: string;
  try {
    stdout = await runJsonIoHookCaptureStdout(command, env, event, ctx, timeoutMs);
  } catch {
    // timeout, spawn error, or non-zero exit — block
    return false;
  }

  // Empty stdout → treat exit code as the signal (allow for exit 0).
  if (!stdout.trim()) {
    return true;
  }

  try {
    const parsed = JSON.parse(stdout) as { decision?: string };
    return parsed.decision !== "deny";
  } catch {
    // Malformed JSON with a zero exit — fail closed conservatively.
    return false;
  }
}

/** Run an HTTP hook. POSTs context as JSON, expects { allowed: true/false }. */
async function runHttpHook(url: string, event: HookEvent, ctx: HookContext, timeoutMs = 10_000): Promise<boolean> {
  try {
    const body = JSON.stringify({ event, ...ctx });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { allowed?: boolean };
    return data.allowed !== false;
  } catch {
    return false;
  }
}

/**
 * Run an HTTP hook and return its full structured response. POSTs `{event, ...ctx}`
 * as JSON and parses the response body with the same jsonIO envelope shape used
 * by command hooks:
 *   { decision?: "allow" | "deny", reason?: string,
 *     hookSpecificOutput?: { decision?: "allow" | "deny" | "ask", reason?, additionalContext? } }
 *
 * Also honors a legacy `{ allowed: boolean }` shape (downgrades to decision).
 *
 * Network errors / non-2xx responses / malformed JSON all return a "deny" outcome
 * so the caller can fail closed.
 */
async function runHttpHookDetailed(
  url: string,
  event: HookEvent,
  ctx: HookContext,
  timeoutMs = 10_000,
): Promise<ParsedJsonIoResponse> {
  try {
    const body = JSON.stringify({ event, ...ctx });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { decision: "deny", reason: `hook HTTP ${res.status}` };
    const text = await res.text();
    if (!text.trim()) return {};
    const parsed = parseJsonIoResponse(text);
    // If the response only used the legacy `{ allowed: false }` shape, surface as deny.
    if (!parsed.decision && !parsed.permissionDecision) {
      try {
        const legacy = JSON.parse(text) as { allowed?: boolean };
        if (legacy.allowed === false) return { decision: "deny", reason: "hook denied" };
      } catch {
        // already handled by parseJsonIoResponse
      }
    }
    return parsed;
  } catch {
    return { decision: "deny", reason: "hook HTTP error" };
  }
}

/**
 * Run a prompt hook. Uses an LLM to make a yes/no allow/deny decision.
 *
 * The hook's `prompt:` field is the question posed to the model along with
 * the event context. The response is parsed case-insensitively: responses
 * starting with YES / ALLOW / TRUE / PASS / APPROVE allow; anything else
 * (including explicit NO, DENY, errors, timeouts, empty) blocks.
 *
 * Fail-closed semantics: if the provider isn't reachable or the response
 * can't be parsed, the hook denies. This matches command hooks (non-zero
 * exit = deny) and HTTP hooks (network error = deny).
 *
 * Provider selection: reads `.oh/config.yaml` to get the configured provider
 * and model. A separate provider instance is created per call — no caching,
 * since hooks are rare and cold-start cost is negligible compared to the
 * LLM call itself.
 */
async function runPromptHook(promptText: string, ctx: HookContext, timeoutMs = 10_000): Promise<boolean> {
  try {
    const cfg = readOhConfig();
    if (!cfg) return false; // no config → no provider → fail closed

    const { createProvider } = (await import("../providers/index.js")) as typeof import("../providers/index.js");
    const modelArg = cfg.model ? `${cfg.provider}/${cfg.model}` : cfg.provider;
    const overrides: Partial<import("../providers/base.js").ProviderConfig> = {};
    if (cfg.apiKey) overrides.apiKey = cfg.apiKey;
    if (cfg.baseUrl) overrides.baseUrl = cfg.baseUrl;
    const { provider, model } = await createProvider(modelArg, overrides);

    const systemPrompt =
      "You are a policy gate. Read the question and the event context. Answer with a single word: YES to allow, NO to deny. Do not explain unless asked.";
    const userContent = [
      `Question: ${promptText}`,
      "",
      "Event context:",
      JSON.stringify({ event: ctx }, null, 2),
      "",
      "Answer (YES or NO):",
    ].join("\n");

    const { createUserMessage } = (await import("../types/message.js")) as typeof import("../types/message.js");
    const messages = [createUserMessage(userContent)];

    // Race the completion against a hard timeout so a hung provider doesn't
    // block the agent loop indefinitely.
    const completion = await Promise.race([
      provider.complete(messages, systemPrompt, undefined, model),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (!completion) return false; // timeout → deny
    const text = (completion.content ?? "").trim().toUpperCase();
    if (!text) return false;
    // Accept multiple allow synonyms; default to deny on anything else.
    return /^(YES|ALLOW|TRUE|PASS|APPROVE)\b/.test(text);
  } catch {
    return false; // any error path → deny
  }
}

// ── Hook Execution ──

/** Execute a single hook definition. Returns true if allowed. */
async function executeHookDef(def: HookDef, event: HookEvent, ctx: HookContext): Promise<boolean> {
  const timeout = def.timeout ?? 10_000;

  // Workspace-trust gate (audit U-A4). Shell-executing hook types
  // (`command`, `http`) require the cwd to be on the trust list — a fresh
  // clone of a hostile repo can't auto-execute on first launch. Allowed by
  // default for `prompt` hooks (LLM-only, no shell).
  //
  // Soft rollout: the gate is only enforced once the user has interacted
  // with the trust system (i.e., `~/.oh/trusted-dirs.json` exists). Until
  // then, existing behavior is preserved. The first session in a hooked
  // workspace fires a startup prompt that creates the file — from that
  // point on every other dir requires explicit trust.
  if ((def.command || def.http) && trustSystemActive() && !isTrusted(process.cwd())) {
    // Allow as if the hook didn't exist. The REPL surfaces a one-time
    // prompt at session start when hooks are configured but the dir is
    // untrusted; the user can also grant trust via `/trust`.
    return true;
  }

  if (def.command) {
    const env = buildEnv(event, ctx);
    // JSON-mode (Claude Code convention): send `{event, ...ctx}` on stdin,
    // parse `{decision}` from stdout. Env-var mode (legacy default): gate on
    // exit code.
    if (def.jsonIO) {
      return runJsonIoHookAsync(def.command, env, event, ctx, timeout);
    }
    const code = await runCommandHookAsync(def.command, env, timeout);
    return code === 0;
  }

  if (def.http) {
    return runHttpHook(def.http, event, ctx, timeout);
  }

  if (def.prompt) {
    return runPromptHook(def.prompt, ctx);
  }

  return true; // No handler = allow
}

/**
 * Emit a hook event. For preToolUse, returns false if any hook blocks the call.
 *
 * preToolUse hooks run synchronously (they must block before tool execution).
 * All other hooks run asynchronously to avoid blocking the event loop.
 */
export function emitHook(event: HookEvent, ctx: HookContext = {}): boolean {
  if (!areHooksEnabled()) return true;
  const hooks = getHooks();
  if (!hooks) return true;

  const defs: HookDef[] = hooks[event] ?? [];
  if (defs.length > 0) debug("hooks", "fire", { event, count: defs.length, tool: ctx.toolName });
  const env = buildEnv(event, ctx);

  if (event === "preToolUse") {
    // preToolUse command hooks must be synchronous — they gate tool execution.
    // Workspace-trust gate (audit U-A4): once the trust system is active
    // (file exists), shell-executing hooks in untrusted dirs act as absent.
    // Soft rollout: when no trust file exists at all, treat as legacy mode
    // and run all hooks normally.
    const enforceTrust = trustSystemActive() && !isTrusted(process.cwd());
    for (const def of defs) {
      if (!matchesHook(def, ctx)) continue;
      if ((def.command || def.http) && enforceTrust) continue;

      if (def.command) {
        const input = def.jsonIO ? JSON.stringify({ event, ...ctx }) : undefined;
        const result = spawnSync(def.command, {
          shell: true,
          timeout: def.timeout ?? 10_000,
          stdio: "pipe",
          env,
          input,
        });
        if (result.status !== 0 || result.error) return false;
        // JSON mode: parse stdout for {decision: "deny"} → block. Allow on empty
        // stdout (exit-code already gated above). Malformed JSON fails closed.
        if (def.jsonIO) {
          const out = result.stdout?.toString() ?? "";
          if (out.trim()) {
            try {
              const parsed = JSON.parse(out) as { decision?: string };
              if (parsed.decision === "deny") return false;
            } catch {
              return false;
            }
          }
        }
      }
      // HTTP and prompt hooks for preToolUse are handled in emitHookAsync
    }
    return true;
  }

  // All other hooks run asynchronously (fire-and-forget)
  for (const def of defs) {
    if (!matchesHook(def, ctx)) continue;
    executeHookDef(def, event, ctx).catch(() => {
      /* fire-and-forget: non-preToolUse hooks must not block the agent loop */
    });
  }
  return true;
}

/**
 * Async version of emitHook that waits for all hooks to complete.
 * Supports all hook types (command, HTTP, prompt).
 */
export async function emitHookAsync(event: HookEvent, ctx: HookContext = {}): Promise<boolean> {
  if (!areHooksEnabled()) return true;
  const hooks = getHooks();
  if (!hooks) return true;

  const defs: HookDef[] = hooks[event] ?? [];

  for (const def of defs) {
    if (!matchesHook(def, ctx)) continue;
    const allowed = await executeHookDef(def, event, ctx);
    if (event === "preToolUse" && !allowed) return false;
  }
  return true;
}

// ── Structured-outcome hook emitter (Task 2) ──

/** Parsed shape of a jsonIO hook's stdout JSON response. */
export type ParsedJsonIoResponse = {
  decision?: "allow" | "deny";
  reason?: string;
  additionalContext?: string;
  permissionDecision?: "allow" | "deny" | "ask";
};

/** Parse a hook's stdout as a jsonIO envelope. Returns an empty object on malformed input. */
export function parseJsonIoResponse(raw: string): ParsedJsonIoResponse {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const rec = obj as Record<string, unknown>;
  const out: ParsedJsonIoResponse = {};
  if (rec.decision === "allow" || rec.decision === "deny") out.decision = rec.decision;
  if (typeof rec.reason === "string") out.reason = rec.reason;
  const hso = rec.hookSpecificOutput;
  if (hso && typeof hso === "object" && !Array.isArray(hso)) {
    const hsoRec = hso as Record<string, unknown>;
    if (typeof hsoRec.additionalContext === "string") out.additionalContext = hsoRec.additionalContext;
    if (hsoRec.decision === "allow" || hsoRec.decision === "deny" || hsoRec.decision === "ask") {
      out.permissionDecision = hsoRec.decision;
    }
    if (typeof hsoRec.reason === "string" && !out.reason) out.reason = hsoRec.reason;
  }
  return out;
}

export type HookOutcome = {
  allowed: boolean;
  additionalContext?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  reason?: string;
};

/** Events for which "notify-only" semantics apply — outcome.allowed is always true. */
const NOTIFY_ONLY_OUTCOME_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(["postToolUseFailure"]);

/**
 * Map a command-hook's boolean (exit 0 / nonzero) result to a ParsedJsonIoResponse
 * for the given event, applying per-event semantics:
 *
 * - userPromptSubmit: exit 0 → allow ({}); nonzero → deny.
 * - permissionRequest: exit 0 → "ask" (fall through to user); nonzero → deny.
 * - postToolUseFailure: notify-only — exit code is irrelevant, always return {}.
 * - All other events: same as userPromptSubmit (exit 0 allow, nonzero deny).
 */
function mapEnvExitToOutcome(event: HookEvent, allowed: boolean): ParsedJsonIoResponse {
  switch (event) {
    case "permissionRequest":
      return allowed
        ? { permissionDecision: "ask" }
        : { permissionDecision: "deny", decision: "deny", reason: "hook denied (exit code)" };
    case "postToolUseFailure":
      // notify-only; exit code is irrelevant
      return {};
    default:
      return allowed ? {} : { decision: "deny", reason: "hook denied (exit code)" };
  }
}

/**
 * Execute a single hook definition and return a ParsedJsonIoResponse for outcome merging.
 * Private to this module — not exported.
 */
async function runHookForOutcome(def: HookDef, event: HookEvent, ctx: HookContext): Promise<ParsedJsonIoResponse> {
  if (def.jsonIO && def.command) {
    const env = buildEnv(event, ctx);
    let raw: string;
    try {
      raw = await runJsonIoHookCaptureStdout(def.command, env, event, ctx, def.timeout ?? 10_000);
    } catch {
      // timeout, spawn error, non-zero exit — treat as deny for gating events
      return { decision: "deny", reason: "hook failed (timeout or non-zero exit)" };
    }
    if (!raw.trim()) {
      // empty stdout with exit 0 — treat as allow (no decision)
      return {};
    }
    return parseJsonIoResponse(raw);
  }

  if (def.command) {
    // env-var mode — apply per-event exit-code semantics
    const env = buildEnv(event, ctx);
    const code = await runCommandHookAsync(def.command, env, def.timeout ?? 10_000);
    return mapEnvExitToOutcome(event, code === 0);
  }

  if (def.http) {
    return await runHttpHookDetailed(def.http, event, ctx, def.timeout ?? 10_000);
  }

  if (def.prompt) {
    const allowed = await runPromptHook(def.prompt, ctx, def.timeout ?? 10_000);
    return allowed ? {} : { decision: "deny", reason: "prompt hook denied" };
  }

  return {};
}

/**
 * Emit a hook event and return a structured HookOutcome parsed from jsonIO responses.
 *
 * Merge semantics:
 * - First `deny` (or `permissionDecision: "deny"`) short-circuits: {allowed: false, ...}.
 * - `permissionDecision: "allow"` short-circuits: {allowed: true, permissionDecision: "allow"}.
 * - `additionalContext` from multiple hooks is concatenated in order, "\n\n" separated.
 * - For NOTIFY_ONLY_OUTCOME_EVENTS (postToolUseFailure), decision/permissionDecision
 *   from hooks is ignored — outcome.allowed is always true. additionalContext is still collected.
 */
export async function emitHookWithOutcome(event: HookEvent, ctx: HookContext = {}): Promise<HookOutcome> {
  if (!areHooksEnabled()) return { allowed: true };
  const hooks = getHooks();
  const list = hooks?.[event];
  if (!list || list.length === 0) return { allowed: true };
  const notifyOnly = NOTIFY_ONLY_OUTCOME_EVENTS.has(event);

  const additionalContexts: string[] = [];
  let reason: string | undefined;
  let askSeen = false;

  for (const def of list) {
    if (def.match && !matchesHook(def, ctx)) continue;
    const parsed = await runHookForOutcome(def, event, ctx);

    if (!notifyOnly) {
      if (parsed.decision === "deny" || parsed.permissionDecision === "deny") {
        const outcome: HookOutcome = {
          allowed: false,
          reason: parsed.reason ?? reason,
          permissionDecision: parsed.permissionDecision,
        };
        notifyHookDecision(event, ctx, outcome);
        return outcome;
      }
      if (parsed.permissionDecision === "allow") {
        if (parsed.additionalContext) additionalContexts.push(parsed.additionalContext);
        const outcome: HookOutcome = {
          allowed: true,
          permissionDecision: "allow",
          additionalContext: additionalContexts.length ? additionalContexts.join("\n\n") : undefined,
        };
        notifyHookDecision(event, ctx, outcome);
        return outcome;
      }
      if (parsed.permissionDecision === "ask") askSeen = true;
    }
    if (parsed.additionalContext) additionalContexts.push(parsed.additionalContext);
    if (!reason && parsed.reason) reason = parsed.reason;
  }

  const outcome: HookOutcome = {
    allowed: true,
    additionalContext: additionalContexts.length ? additionalContexts.join("\n\n") : undefined,
    permissionDecision: askSeen ? "ask" : undefined,
    reason,
  };
  notifyHookDecision(event, ctx, outcome);
  return outcome;
}

// ── Hook-decision observer (for stream-json NDJSON emission) ──

export type HookDecisionNotification = {
  event: HookEvent;
  /** Present when the hook fired in a tool-specific context. */
  tool?: string;
  /** The effective decision. "ask" means defer to the user / default permission flow. */
  decision: "allow" | "deny" | "ask";
  /** Reason returned by the hook, if any. */
  reason?: string;
};

type HookDecisionObserver = (n: HookDecisionNotification) => void;
let hookDecisionObserver: HookDecisionObserver | null = null;

/**
 * Register (or clear) a single observer that receives one notification per
 * `emitHookWithOutcome` call that produces a decision. Used by
 * `oh run --output-format stream-json` to emit `hook_decision` NDJSON events
 * so the Python SDK can surface permission outcomes in real time.
 */
export function setHookDecisionObserver(cb: HookDecisionObserver | null): void {
  hookDecisionObserver = cb;
}

function notifyHookDecision(event: HookEvent, ctx: HookContext, outcome: HookOutcome): void {
  if (!hookDecisionObserver) return;
  // Prefer the richer permissionDecision when present; fall back to deny if the hook blocked.
  let decision: "allow" | "deny" | "ask" | undefined = outcome.permissionDecision;
  if (!decision) {
    if (!outcome.allowed) decision = "deny";
    else if (outcome.reason) decision = "allow";
  }
  if (!decision) return;
  try {
    hookDecisionObserver({ event, tool: ctx.toolName, decision, reason: outcome.reason });
  } catch {
    // Observer errors must not break the hook pipeline.
  }
}
