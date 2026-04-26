/**
 * Cross-platform subprocess termination helpers.
 *
 * POSIX: `SIGTERM` for graceful, `SIGKILL` for force. `SIGINT` for interrupt.
 * Windows: there's no real "graceful" signal Node can deliver to a child. We
 * fall back to `SIGTERM` (which Node maps to `TerminateProcess`) and let the
 * caller drive a soft shutdown via stdin protocol when one exists.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";

export function sendTerminate(proc: ChildProcess): void {
  if (proc.exitCode != null || proc.signalCode != null) return;
  try {
    if (isWindows) {
      proc.kill("SIGTERM");
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // Process may have already exited — ignore.
  }
}

export function sendKill(proc: ChildProcess): void {
  if (proc.exitCode != null || proc.signalCode != null) return;
  try {
    if (isWindows && proc.pid != null) {
      // SIGKILL on Windows is mapped to TerminateProcess by Node, but it
      // doesn't reach grandchildren. Use taskkill /T /F to kill the tree.
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => {
        // Fallback: synchronous kill.
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    // ignore
  }
}

export function sendInterrupt(proc: ChildProcess): void {
  if (proc.exitCode != null || proc.signalCode != null) return;
  try {
    if (isWindows && proc.pid != null) {
      spawn("taskkill", ["/PID", String(proc.pid), "/T"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      });
    } else {
      proc.kill("SIGINT");
    }
  } catch {
    // ignore
  }
}
