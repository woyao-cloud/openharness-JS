/**
 * Approval log (audit U-B5).
 *
 * Append-only JSONL at `~/.oh/approvals.log` recording every permission
 * resolution OH makes during a session — the source (user / hook / rule /
 * permission-prompt-tool / headless / policy), the tool name, the decision
 * (allow / deny / always), a redacted args preview, and a timestamp.
 *
 * Rotated to a `.1` sibling once the file exceeds ~2 MiB so the log doesn't
 * grow unbounded. The slash command `/permissions log` reads the tail.
 *
 * Mirrors Claude Code's session approval log. Genuinely new — no prior art
 * in OH (grep-verified during the audit refresh).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_FILE = join(homedir(), ".oh", "approvals.log");
const ROTATE_BYTES = 2 * 1024 * 1024;

export type ApprovalSource = "user" | "hook" | "rule" | "permission-prompt-tool" | "policy" | "headless";
export type ApprovalDecision = "allow" | "deny" | "always";

export interface ApprovalRecord {
  ts: string; // ISO timestamp
  tool: string;
  decision: ApprovalDecision;
  source: ApprovalSource;
  /** Tool args as JSON, truncated to ~500 chars to keep the log compact. */
  argsPreview?: string;
  /** Optional human-readable reason (hook reason, headless reason, etc.). */
  reason?: string;
  cwd?: string;
}

/** Test seam — flip to `null` to disable logging in test runs. */
let _logFileOverride: string | null | undefined;

/**
 * Override the log file path for tests, or `null` to silence the writer.
 * Calling without arguments resets to the real `~/.oh/approvals.log`.
 */
export function setApprovalLogPathForTests(path: string | null | undefined): void {
  _logFileOverride = path;
}

function logPath(): string | null {
  if (_logFileOverride === null) return null;
  return _logFileOverride ?? LOG_FILE;
}

function rotateIfNeeded(file: string): void {
  try {
    const st = statSync(file);
    if (st.size >= ROTATE_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* file does not exist yet — no rotate needed */
  }
}

/**
 * Append a single approval decision to the log. Errors are swallowed: a
 * disk-full or permission error must not block the agent loop.
 */
export function recordApproval(rec: Omit<ApprovalRecord, "ts">): void {
  const file = logPath();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`;
    appendFileSync(file, line, "utf8");
  } catch {
    /* logging must not throw into caller */
  }
}

/**
 * Read the most recent `n` records from the log. Skips malformed lines.
 * Used by the `/permissions log` slash command.
 */
export function readApprovalLog(n = 50): ApprovalRecord[] {
  const file = logPath();
  if (!file || !existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(Math.max(0, lines.length - n));
  const out: ApprovalRecord[] = [];
  for (const line of tail) {
    try {
      const obj = JSON.parse(line) as ApprovalRecord;
      if (obj && typeof obj.tool === "string" && typeof obj.decision === "string") {
        out.push(obj);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Truncate an args string to roughly N chars without breaking JSON brackets. */
export function previewArgs(argsJson: string, max = 500): string {
  if (argsJson.length <= max) return argsJson;
  return `${argsJson.slice(0, max)}…`;
}
