/**
 * Git commands — /diff, /undo, /rewind, /commit, /log
 */

import { execSync } from "node:child_process";
import { gitBranch, gitCommit, gitDiff, gitLog, gitUndo, isGitRepo } from "../git/index.js";
import { checkpointCount, listCheckpoints, rewindLastCheckpoint } from "../harness/checkpoints.js";
import type { CommandHandler } from "./types.js";

export function registerGitCommands(register: (name: string, description: string, handler: CommandHandler) => void) {
  register("diff", "Show uncommitted git changes", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const diff = gitDiff();
    return { output: diff || "No uncommitted changes.", handled: true };
  });

  register("undo", "Undo last AI commit", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const success = gitUndo();
    return {
      output: success ? "Undone. Last AI commit reverted." : "Nothing to undo (last commit wasn't from OpenHarness).",
      handled: true,
    };
  });

  register("rewind", "Restore files from checkpoint (interactive picker or last)", (args) => {
    const checkpoints = listCheckpoints();
    if (checkpoints.length === 0) {
      return { output: "No checkpoints available. Checkpoints are created before file modifications.", handled: true };
    }

    const idx = args.trim();

    if (!idx) {
      const lines = [`Checkpoints (${checkpoints.length}):\n`];
      for (let i = checkpoints.length - 1; i >= 0; i--) {
        const cp = checkpoints[i]!;
        const age = Math.round((Date.now() - cp.timestamp) / 60_000);
        lines.push(`  ${i + 1}. [${age}m ago] ${cp.description}`);
        lines.push(`     Files: ${cp.files.join(", ")}`);
      }
      lines.push("");
      lines.push("Usage: /rewind <number> to restore a specific checkpoint");
      lines.push("       /rewind last    to restore the most recent");
      return { output: lines.join("\n"), handled: true };
    }

    if (idx === "last") {
      const cp = rewindLastCheckpoint();
      if (!cp) return { output: "No checkpoints.", handled: true };
      return {
        output: `Rewound: ${cp.description}\nRestored ${cp.files.length} file(s): ${cp.files.join(", ")}\n${checkpointCount()} checkpoint(s) remaining.`,
        handled: true,
      };
    }

    const num = parseInt(idx, 10);
    if (Number.isNaN(num) || num < 1 || num > checkpoints.length) {
      return { output: `Invalid checkpoint number. Use 1-${checkpoints.length}.`, handled: true };
    }

    let restored = 0;
    while (checkpointCount() >= num) {
      const cp = rewindLastCheckpoint();
      if (!cp) break;
      restored++;
      if (checkpointCount() < num) break;
    }

    return {
      output: `Rewound ${restored} checkpoint(s) to point #${num}.\n${checkpointCount()} checkpoint(s) remaining.`,
      handled: true,
    };
  });

  register("commit", "Create a git commit", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const message = args.trim() || "manual commit";
    const success = gitCommit(message);
    return { output: success ? `Committed: ${message}` : "Nothing to commit.", handled: true };
  });

  register("log", "Show recent git commits", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    return { output: gitLog(10) || "No commits yet.", handled: true };
  });

  register("review-pr", "Review a pull request", (args) => {
    const pr = args.trim();
    if (!pr) {
      return { output: "Usage: /review-pr <number or URL>", handled: true };
    }
    return {
      output: `[review-pr] ${pr}`,
      handled: false,
      prependToPrompt: `Review pull request ${pr}. Use the Bash tool to run 'gh pr view ${pr} --json title,body,additions,deletions,files' and 'gh pr diff ${pr}' to fetch the PR details and diff. Then provide a thorough code review covering correctness, style, and potential issues.`,
    };
  });

  register("pr-comments", "View comments on a pull request", (args) => {
    const pr = args.trim();
    if (!pr) {
      return { output: "Usage: /pr-comments <number or URL>", handled: true };
    }
    return {
      output: `[pr-comments] ${pr}`,
      handled: false,
      prependToPrompt: `Fetch and summarize the comments on pull request ${pr}. Use the Bash tool to run 'gh pr view ${pr} --json comments,reviews' to get all comments and review feedback. Present a clear summary of the discussion.`,
    };
  });

  register("release-notes", "Generate release notes from recent commits", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const range = args.trim() || "HEAD~10..HEAD";
    let log: string;
    try {
      log = execSync(`git log --oneline ${range}`, { encoding: "utf-8" }).trim();
    } catch {
      log = gitLog(10) || "";
    }
    if (!log) return { output: "No commits found for release notes.", handled: true };
    return {
      output: `[release-notes] ${range}`,
      handled: false,
      prependToPrompt: `Generate release notes from these commits. Group by category (features, fixes, chores). Use markdown formatting.\n\nCommits:\n${log}`,
    };
  });

  register("stash", "Show git stash list", () => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    let stashList: string;
    try {
      stashList = execSync("git stash list", { encoding: "utf-8" }).trim();
    } catch {
      return { output: "Could not retrieve stash list.", handled: true };
    }
    if (!stashList) return { output: "No stashes found.", handled: true };
    return { output: `Git stashes:\n${stashList}`, handled: true };
  });

  register("branch", "Show or switch git branch", (args) => {
    if (!isGitRepo()) {
      return { output: "Not a git repository.", handled: true };
    }
    const target = args.trim();
    if (!target) {
      const current = gitBranch();
      let branches: string;
      try {
        branches = execSync("git branch --list", { encoding: "utf-8" }).trim();
      } catch {
        branches = current;
      }
      return { output: `Current branch: ${current}\n\n${branches}`, handled: true };
    }
    try {
      execSync(`git checkout ${target}`, { encoding: "utf-8" });
      return { output: `Switched to branch: ${target}`, handled: true };
    } catch {
      return { output: `Failed to switch to branch: ${target}. Does it exist?`, handled: true };
    }
  });
}
