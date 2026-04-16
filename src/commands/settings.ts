/**
 * Settings commands — /theme, /companion, /fast, /keys, /effort, /sandbox, /permissions, /allowed-tools
 */

import { readOhConfig } from "../harness/config.js";
import { loadKeybindings } from "../harness/keybindings.js";
import type { CommandHandler } from "./types.js";

export function registerSettingsCommands(
  register: (name: string, description: string, handler: CommandHandler) => void,
) {
  register("theme", "Switch theme (dark/light)", (args) => {
    const theme = args.trim().toLowerCase();
    if (theme !== "dark" && theme !== "light") {
      return { output: "Usage: /theme dark or /theme light", handled: true };
    }
    return { output: `__SWITCH_THEME__:${theme}`, handled: true };
  });

  register("companion", "Toggle companion visibility (off/on)", (args) => {
    const arg = args.trim().toLowerCase();
    if (arg === "off") return { output: "__COMPANION_OFF__", handled: true };
    if (arg === "on") return { output: "__COMPANION_ON__", handled: true };
    return { output: "Usage: /companion off or /companion on", handled: true };
  });

  register("fast", "Toggle fast mode (optimized for speed)", () => {
    return { output: "", handled: true, toggleFastMode: true };
  });

  register("keys", "Show keyboard shortcuts", () => {
    const bindings = loadKeybindings();

    const shortcuts = [
      "Keyboard Shortcuts:",
      "",
      "  Navigation:",
      "    ↑ / ↓           Input history",
      "    Tab              Cycle autocomplete suggestions",
      "    Escape           Cancel / clear autocomplete",
      "    Ctrl+C           Abort current request / exit",
      "    Scroll wheel     Scroll through messages",
      "",
      "  Editing:",
      "    Alt+Enter        Insert newline (multi-line input)",
      "    Ctrl+A           Move cursor to start of line",
      "    Ctrl+E           Move cursor to end of line",
      "",
      "  Display:",
      "    Ctrl+K           Toggle code block expansion",
      "    Ctrl+O           Toggle thinking block expansion",
      "    Tab (in output)  Expand/collapse tool call output",
      "",
      "  Custom keybindings (~/.oh/keybindings.json):",
    ];
    for (const b of bindings) {
      shortcuts.push(`    ${b.key.padEnd(18)} ${b.action}`);
    }
    shortcuts.push(
      "",
      "  Session:",
      "    /vim              Toggle Vim mode",
      "    /browse           Interactive session browser",
      "    /theme dark|light Switch theme",
    );
    return { output: shortcuts.join("\n"), handled: true };
  });

  register("effort", "Set reasoning effort level (low/medium/high/max)", (args) => {
    const level = args.trim().toLowerCase();
    const valid = ["low", "medium", "high", "max"];
    if (!valid.includes(level)) {
      return {
        output: `Usage: /effort <${valid.join("|")}>\n\nlow    — fast, minimal reasoning\nmedium — balanced (default)\nhigh   — thorough reasoning\nmax    — maximum depth (Opus only)`,
        handled: true,
      };
    }
    return { output: `Effort level set to: ${level}`, handled: true };
  });

  register("sandbox", "Show sandbox status and restrictions", () => {
    const { sandboxStatus } = require("../harness/sandbox.js");
    return { output: `${sandboxStatus()}\n\nConfigure in .oh/config.yaml under sandbox:`, handled: true };
  });

  register("permissions", "View or change permission mode", (args, ctx) => {
    const mode = args.trim().toLowerCase();
    if (!mode) {
      return {
        output: `Current permission mode: ${ctx.permissionMode}\n\nAvailable modes:\n  ask            Prompt for medium/high risk (default)\n  trust          Auto-approve everything\n  deny           Only low-risk read-only\n  acceptEdits    Auto-approve file edits\n  plan           Read-only mode\n  auto           Auto-approve, block dangerous bash\n  bypassPermissions  CI/CD only`,
        handled: true,
      };
    }
    const valid = ["ask", "trust", "deny", "acceptedits", "plan", "auto", "bypasspermissions"];
    if (!valid.includes(mode)) {
      return { output: `Unknown mode: ${mode}. Valid: ${valid.join(", ")}`, handled: true };
    }
    return {
      output: `Permission mode set to: ${mode}\n(Note: takes effect for new tool calls in this session)`,
      handled: true,
    };
  });

  register("allowed-tools", "View tool permission rules", () => {
    const config = readOhConfig();
    const rules = config?.toolPermissions;
    if (!rules || rules.length === 0) {
      return {
        output:
          'No custom tool permission rules configured.\n\nAdd rules to .oh/config.yaml:\n\ntoolPermissions:\n  - tool: Bash\n    action: ask\n    pattern: "^rm .*"',
        handled: true,
      };
    }
    const lines = rules.map((r: any) => {
      const parts = [`  ${r.tool}: ${r.action}`];
      if (r.pattern) parts.push(`(pattern: ${r.pattern})`);
      return parts.join(" ");
    });
    return { output: `Tool permission rules:\n${lines.join("\n")}`, handled: true };
  });

  register("vim", "Toggle Vim mode", () => {
    return { output: "__TOGGLE_VIM__", handled: true };
  });

  register("login", "Set API key for current provider", (args, ctx) => {
    const key = args.trim();
    if (!key) {
      const envHint =
        ctx.providerName === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : ctx.providerName === "openai"
            ? "OPENAI_API_KEY"
            : `${ctx.providerName.toUpperCase()}_API_KEY`;
      return {
        output: `Usage: /login <api-key>\n\nAlternatively, set the ${envHint} environment variable.\nCurrent provider: ${ctx.providerName}`,
        handled: true,
      };
    }
    return {
      output: `API key set for ${ctx.providerName}. (Takes effect for new requests in this session.)`,
      handled: true,
    };
  });

  register("logout", "Clear API key for current provider", (_args, ctx) => {
    return {
      output: `API key cleared for ${ctx.providerName}. Set via environment variable or /login to re-authenticate.`,
      handled: true,
    };
  });
}
