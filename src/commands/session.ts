/**
 * Session commands — /clear, /compact, /export, /history, /browse, /resume, /fork, /pin, /unpin
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getContextWindow } from "../harness/cost.js";
import { createSession, listSessions, loadSession, saveSession } from "../harness/session.js";
import { compressMessages } from "../query/index.js";
import type { CommandContext, CommandHandler, CommandResult } from "./types.js";

function setPinned(args: string, ctx: CommandContext, pinned: boolean): CommandResult {
  const idx = parseInt(args.trim(), 10);
  if (Number.isNaN(idx) || idx < 1 || idx > ctx.messages.length) {
    return { output: `Usage: /${pinned ? "pin" : "unpin"} <message-number> (1-${ctx.messages.length})`, handled: true };
  }
  const updatedMessages = ctx.messages.map((m, i) => (i === idx - 1 ? { ...m, meta: { ...m.meta, pinned } } : m));
  return {
    output: `Message #${idx} ${pinned ? "pinned" : "unpinned"}.`,
    handled: true,
    compactedMessages: updatedMessages,
  };
}

export function registerSessionCommands(
  register: (name: string, description: string, handler: CommandHandler) => void,
) {
  register("clear", "Clear conversation history", () => {
    return { output: "Conversation cleared.", handled: true, clearMessages: true };
  });

  register("compact", "Compress conversation history (optional: focus keyword or message number)", (args, ctx) => {
    const focus = args.trim();
    const before = ctx.messages.length;
    const targetTokens = Math.floor(getContextWindow(ctx.model) * 0.6);

    if (focus && /^\d+$/.test(focus)) {
      const cutoff = parseInt(focus, 10);
      if (cutoff < 1 || cutoff >= before) {
        return { output: `Invalid: use 1-${before - 1}`, handled: true };
      }
      const kept = ctx.messages.slice(cutoff);
      return {
        output: `Compacted: removed first ${cutoff} messages, kept ${kept.length}.`,
        handled: true,
        compactedMessages: kept,
      };
    }

    if (focus) {
      const focusLower = focus.toLowerCase();
      const preserved = ctx.messages.filter((m) => m.content.toLowerCase().includes(focusLower) || m.meta?.pinned);
      const others = ctx.messages.filter((m) => !m.content.toLowerCase().includes(focusLower) && !m.meta?.pinned);
      const compactedOthers = compressMessages(others, targetTokens);
      const merged = [...compactedOthers, ...preserved].sort((a, b) => a.timestamp - b.timestamp);
      return {
        output: `Compacted with focus "${focus}": ${before} → ${merged.length} messages (preserved ${preserved.length} matching).`,
        handled: true,
        compactedMessages: merged,
      };
    }

    const compacted = compressMessages(ctx.messages, targetTokens);
    const dropped = before - compacted.length;
    return {
      output: `Compacted: ${before} → ${compacted.length} messages (dropped ${dropped} older turns).`,
      handled: true,
      compactedMessages: compacted,
    };
  });

  register("export", "Export conversation to file", (_args, ctx) => {
    const lines = ctx.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const filename = `.oh/export-${ctx.sessionId}.md`;
    try {
      mkdirSync(dirname(filename), { recursive: true });
      const { writeFileSync } = require("node:fs");
      writeFileSync(filename, lines);
      return { output: `Exported to ${filename}`, handled: true };
    } catch {
      return { output: `Export failed. Content:\n\n${lines.slice(0, 500)}`, handled: true };
    }
  });

  register("history", "List recent sessions or search across them", (args) => {
    const parts = args.trim().split(/\s+/);
    const sessionDir = join(homedir(), ".oh", "sessions");

    if (parts[0] === "search" && parts[1]) {
      const term = parts.slice(1).join(" ").toLowerCase();
      const sessions = listSessions(sessionDir);
      const matches: string[] = [];
      for (const s of sessions) {
        try {
          const full = loadSession(s.id, sessionDir);
          const hit = full.messages.find(
            (m) => typeof m.content === "string" && m.content.toLowerCase().includes(term),
          );
          if (hit) {
            const date = new Date(s.updatedAt).toLocaleDateString();
            matches.push(`  ${s.id}  ${date}  ${s.model || "?"}`);
          }
        } catch {
          /* skip */
        }
      }
      if (matches.length === 0) return { output: `No sessions matching "${term}".`, handled: true };
      return { output: `Sessions matching "${term}":\n${matches.join("\n")}`, handled: true };
    }

    const n = parseInt(parts[0] ?? "10", 10) || 10;
    const sessions = listSessions(sessionDir).slice(0, n);
    if (sessions.length === 0) return { output: "No saved sessions.", handled: true };

    const lines = sessions.map((s) => {
      const date = new Date(s.updatedAt).toLocaleDateString();
      const cost = s.cost > 0 ? ` $${s.cost.toFixed(4)}` : "";
      return `  ${s.id}  ${date}  ${String(s.messages).padStart(3)} msgs  ${(s.model || "?").slice(0, 24)}${cost}`;
    });
    return { output: `Recent sessions (use /resume <id> to continue):\n${lines.join("\n")}`, handled: true };
  });

  register("browse", "Open interactive session browser", () => {
    return { output: "__OPEN_SESSION_BROWSER__", handled: true };
  });

  register("resume", "Resume a saved session by ID", (args) => {
    const id = args.trim();
    if (!id) return { output: "Usage: /resume <session-id>", handled: true };
    const sessionDir = join(homedir(), ".oh", "sessions");
    try {
      loadSession(id, sessionDir);
      return { output: `Resuming session ${id}...`, handled: true, resumeSessionId: id };
    } catch {
      return { output: `Session not found: ${id}`, handled: true };
    }
  });

  register("fork", "Fork current session (create a branch you can resume later)", (_args, ctx) => {
    const forked = createSession("", "");
    forked.messages = [...ctx.messages];
    saveSession(forked);
    return {
      output: `Session forked as ${forked.id}. Resume later with: oh --resume ${forked.id}`,
      handled: true,
    };
  });

  register("pin", "Pin a message (survives /compact)", (args, ctx) => setPinned(args, ctx, true));
  register("unpin", "Unpin a message", (args, ctx) => setPinned(args, ctx, false));

  register("rebuild-sessions", "Rebuild session search index", () => {
    import("../harness/session-db.js")
      .then(({ openSessionDb, rebuildIndex, closeSessionDb }) => {
        const db = openSessionDb();
        const count = rebuildIndex(db);
        closeSessionDb(db);
        console.log(`Rebuilt session search index: ${count} sessions indexed.`);
      })
      .catch((err) => {
        console.log(`Failed to rebuild index: ${err.message}`);
      });
    return { output: "Rebuilding session search index...", handled: true };
  });

  register("add-dir", "Add an additional working directory", (args) => {
    const dir = args.trim();
    if (!dir) {
      return {
        output:
          "Usage: /add-dir <path>\n\nAdds a directory to the session's working directories, allowing the AI to access files in multiple locations.",
        handled: true,
      };
    }
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      return { output: `Directory not found: ${resolved}`, handled: true };
    }
    return { output: `Added working directory: ${resolved}`, handled: true };
  });
}
