/**
 * Detect how the running OH CLI was installed (audit B7) so `oh update` can
 * print the appropriate upgrade command. Pure function — `detectInstallMethod`
 * inspects the process's own filesystem path and current working directory;
 * exported for unit testing and reuse.
 *
 * Detection rules, in order:
 *   - "local-clone"   → `dist/main.js` lives inside a git repo whose root is
 *                       the package itself (the user is running from a clone).
 *                       Suggest `git pull && npm install && npm run build`.
 *   - "npm-global"    → `dist/main.js` lives under a directory containing the
 *                       segment `node_modules/@zhijiewang/openharness/`. This
 *                       is the standard npm global install layout. Suggest
 *                       `npm install -g @zhijiewang/openharness@latest`.
 *   - "npx-cache"     → `dist/main.js` lives under a path containing
 *                       `_npx/` (npx caches packages there). npx auto-fetches
 *                       the latest by default; suggest re-running with
 *                       `@latest` to bypass cache.
 *   - "unknown"       → Couldn't classify. Print all three options and let
 *                       the user choose.
 */

import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export type InstallMethod = "local-clone" | "npm-global" | "npx-cache" | "unknown";

export interface InstallMethodResult {
  method: InstallMethod;
  /** The detected install root, mostly for diagnostics. */
  root: string;
  /** Multi-line user-facing message describing the upgrade command. */
  message: string;
}

/**
 * Classify the install method given the running script's filesystem path.
 * `mainPath` defaults to `import.meta.url`-derived path in the CLI; tests
 * override it.
 */
export function detectInstallMethod(mainPath: string): InstallMethodResult {
  // Normalize to forward slashes so the substring tests below work on Windows.
  const normalized = mainPath.replace(/\\/g, "/");

  // npx-cache: path contains `/_npx/` (Node's npx puts packages there)
  if (normalized.includes("/_npx/")) {
    return {
      method: "npx-cache",
      root: dirname(mainPath),
      message: [
        "You're running OH via npx (auto-fetched on each invocation).",
        "To force the latest version on the next run, use:",
        "",
        "  npx @zhijiewang/openharness@latest",
        "",
        "Or install globally to avoid the npx cache entirely:",
        "  npm install -g @zhijiewang/openharness@latest",
      ].join("\n"),
    };
  }

  // local-clone: walk up to find a package.json whose name matches AND a .git dir
  let dir = dirname(mainPath);
  while (dir && dir !== dirname(dir)) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const isClone = existsSync(join(dir, ".git"));
      if (isClone) {
        return {
          method: "local-clone",
          root: dir,
          message: [
            `Detected a local clone at: ${dir}`,
            "Pull the latest and rebuild:",
            "",
            `  cd ${dir}`,
            "  git pull && npm install && npm run build",
          ].join("\n"),
        };
      }
      // npm-global: the package.json belongs to OH and lives under a global
      // node_modules directory.
      if (normalized.includes("/node_modules/@zhijiewang/openharness/")) {
        return {
          method: "npm-global",
          root: dir,
          message: [
            `Detected a global npm install at: ${dir}`,
            "Upgrade with:",
            "",
            "  npm install -g @zhijiewang/openharness@latest",
          ].join("\n"),
        };
      }
      break;
    }
    dir = dirname(dir);
  }

  return {
    method: "unknown",
    root: dirname(mainPath),
    message: [
      "Could not determine how OH was installed. Pick the option that matches your setup:",
      "",
      "  Global npm install:  npm install -g @zhijiewang/openharness@latest",
      "  npx (one-shot):      npx @zhijiewang/openharness@latest",
      "  Local clone:         git pull && npm install && npm run build",
    ].join("\n"),
  };
}

/**
 * Default `mainPath` resolver — walks up from `process.argv[1]` to find the
 * package root. Exported so tests can stub it. Falls back to argv[1] verbatim
 * when nothing matches.
 */
export function getDefaultMainPath(): string {
  const entry = process.argv[1] ?? "";
  if (!entry) return "";
  // If argv[1] points at a `dist/main.js`, that's already the right anchor.
  // Otherwise return as-is and let `detectInstallMethod` figure it out.
  return entry.split(sep).join("/");
}
