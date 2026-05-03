/**
 * `oh project purge` core logic — extracted from the CLI command for testability.
 *
 * Deletes per-project openHarness state at a target directory:
 *   1. The entire `.oh/` directory at that path (config, RULES.md, memory/,
 *      skills/, agents/, output-styles/, plans/, checkpoints/, exports).
 *   2. The workspace-trust entry for that path in `~/.oh/trusted-dirs.json`,
 *      if present.
 *
 * What it does NOT touch (these are global-and-cross-project):
 *   - `~/.oh/sessions/`              session transcripts (may span projects)
 *   - `~/.oh/credentials.enc`        global API keys
 *   - `~/.oh/memory/` (etc.)         global counterparts of project state
 *   - `~/.oh/plugins/`, marketplaces installed plugins
 *   - `~/.oh/telemetry/`, traces/    global observability data
 *   - `~/.oh/approvals.log`          append-only audit log
 *   - `~/.oh/keybindings.json`,
 *     `~/.oh/config.yaml`            global config
 *
 * Mirrors Claude Code's `claude project purge` UX surface (--dry-run, --yes,
 * default plan + confirm). `--all` and `--interactive` are deferred — openHarness
 * has no project registry, so `--all` would need a session-cwd scan, and
 * `--dry-run` already covers the spec for `--interactive`.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Path to the workspace-trust file. Resolved per-call so `OH_TRUST_FILE`
 * env-var overrides (used by tests) take effect without re-importing.
 */
function trustFilePath(): string {
  return process.env.OH_TRUST_FILE ?? join(homedir(), ".oh", "trusted-dirs.json");
}

export type PurgeEntry = {
  /** Filesystem path that will be removed. */
  path: string;
  /** Human-readable label shown in the plan. */
  label: string;
  /** Cumulative size in bytes. 0 when the entry is metadata-only (e.g. a trust-store entry). */
  bytes: number;
  /** When false, this entry is reported but doesn't currently exist on disk. */
  exists: boolean;
  /** When true, removal is via JSON edit instead of `rmSync`. Used for the trust-store entry. */
  jsonEdit?: boolean;
};

export type PurgePlan = {
  projectPath: string;
  entries: PurgeEntry[];
  totalBytes: number;
};

/** Walk a directory and return the cumulative size in bytes. Errors swallowed. */
function dirSize(path: string): number {
  let total = 0;
  try {
    if (!existsSync(path)) return 0;
    const stats = statSync(path);
    if (stats.isFile()) return stats.size;
    if (!stats.isDirectory()) return 0;
    for (const entry of readdirSync(path)) {
      total += dirSize(join(path, entry));
    }
  } catch {
    /* permission errors etc. — best-effort sizing */
  }
  return total;
}

/** Format bytes as a short human string (e.g. `1.2 MB`, `342 B`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Normalize a directory the same way `harness/trust.ts` does. Lowercase on Windows. */
function normalizeForTrust(dir: string): string {
  const abs = resolve(dir);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Build the list of things `purge` would delete, without touching the filesystem.
 * Inspects the `.oh/` directory at `projectPath` and looks for a trust-store entry.
 */
export function planPurge(projectPath: string): PurgePlan {
  const project = resolve(projectPath);
  const ohDir = join(project, ".oh");
  const entries: PurgeEntry[] = [];

  if (existsSync(ohDir)) {
    // Group sub-paths so the plan is informative without listing every file.
    const knownChildren: Array<{ rel: string; label: string }> = [
      { rel: "config.yaml", label: "Project config (config.yaml)" },
      { rel: "RULES.md", label: "Project rules (RULES.md)" },
      { rel: "memory", label: "Memories (.oh/memory/)" },
      { rel: "skills", label: "Skills (.oh/skills/)" },
      { rel: "agents", label: "Agent roles (.oh/agents/)" },
      { rel: "output-styles", label: "Output styles (.oh/output-styles/)" },
      { rel: "plans", label: "Plans (.oh/plans/)" },
      { rel: "checkpoints", label: "Checkpoints (.oh/checkpoints/)" },
    ];
    for (const child of knownChildren) {
      const path = join(ohDir, child.rel);
      if (existsSync(path)) {
        entries.push({ path, label: child.label, bytes: dirSize(path), exists: true });
      }
    }
    // Anything else under .oh/ that we didn't enumerate (export-*, etc.).
    try {
      const explicit = new Set(knownChildren.map((c) => c.rel));
      for (const name of readdirSync(ohDir)) {
        if (explicit.has(name)) continue;
        const path = join(ohDir, name);
        entries.push({
          path,
          label: `Other .oh/ entry (${name})`,
          bytes: dirSize(path),
          exists: true,
        });
      }
    } catch {
      /* directory unreadable — caught later when we try to remove */
    }
    // Finally, add the .oh dir itself so it's removed after children are reported.
    entries.push({ path: ohDir, label: ".oh/ directory", bytes: 0, exists: true });
  }

  // Workspace-trust entry, if any.
  const trustFile = trustFilePath();
  if (existsSync(trustFile)) {
    try {
      const raw = readFileSync(trustFile, "utf8");
      const parsed = JSON.parse(raw) as { trusted?: unknown };
      if (Array.isArray(parsed.trusted)) {
        const target = normalizeForTrust(project);
        const isTrusted = parsed.trusted.some(
          (p): p is string => typeof p === "string" && normalizeForTrust(p) === target,
        );
        if (isTrusted) {
          entries.push({
            path: trustFile,
            label: "Workspace-trust entry (~/.oh/trusted-dirs.json)",
            bytes: 0,
            exists: true,
            jsonEdit: true,
          });
        }
      }
    } catch {
      /* malformed trust file — nothing to remove */
    }
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  return { projectPath: project, entries, totalBytes };
}

/** Render a plan as a multi-line string for display. */
export function formatPurgePlan(plan: PurgePlan): string {
  const lines: string[] = [];
  lines.push(`Purge plan for ${plan.projectPath}`);
  lines.push("");
  if (plan.entries.length === 0) {
    lines.push("  (nothing to delete — no .oh/ directory and no trust entry)");
    return lines.join("\n");
  }
  for (const entry of plan.entries) {
    const size = entry.bytes > 0 ? `  [${formatBytes(entry.bytes)}]` : "";
    lines.push(`  - ${entry.label}${size}`);
  }
  lines.push("");
  lines.push(`Total: ${plan.entries.length} target(s), ${formatBytes(plan.totalBytes)}`);
  lines.push("");
  lines.push("Not touched (global state): ~/.oh/sessions/, credentials, plugins,");
  lines.push("  telemetry, traces, approvals.log, keybindings, global config.");
  return lines.join("\n");
}

/** Execute the plan. Returns the count of successfully removed entries and any errors. */
export function executePurge(plan: PurgePlan): { deleted: number; errors: string[] } {
  let deleted = 0;
  const errors: string[] = [];

  for (const entry of plan.entries) {
    if (entry.jsonEdit) {
      // Trust entry — JSON edit, not file delete.
      try {
        const raw = readFileSync(entry.path, "utf8");
        const parsed = JSON.parse(raw) as { trusted?: unknown };
        if (Array.isArray(parsed.trusted)) {
          const target = normalizeForTrust(plan.projectPath);
          const filtered = parsed.trusted.filter(
            (p): p is string => typeof p === "string" && normalizeForTrust(p) !== target,
          );
          writeFileSync(entry.path, JSON.stringify({ trusted: filtered }, null, 2));
          deleted++;
        }
      } catch (err) {
        errors.push(`${entry.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    try {
      if (existsSync(entry.path)) {
        rmSync(entry.path, { recursive: true, force: true });
        deleted++;
      }
    } catch (err) {
      errors.push(`${entry.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { deleted, errors };
}
