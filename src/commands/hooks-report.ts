/**
 * Pure formatter for the `/hooks` slash command — renders a human-readable
 * report of all hooks loaded from `.oh/config.yaml`, grouped by event name.
 */

import type { HookDef, HooksConfig } from "../harness/config.js";

const COMMAND_PREVIEW_CHARS = 60;

export function formatHooksReport(hooks: HooksConfig | null): string {
  const lines: string[] = ["─── Loaded Hooks ───", ""];

  const events = hooks
    ? (Object.keys(hooks) as Array<keyof HooksConfig>).filter((e) => (hooks[e]?.length ?? 0) > 0).sort()
    : [];

  if (events.length === 0) {
    lines.push("  No hooks configured.");
    lines.push("  Add hooks to .oh/config.yaml under `hooks:`");
    return lines.join("\n");
  }

  for (const event of events) {
    const defs = hooks?.[event] as HookDef[];
    lines.push(`  ${event} (${defs.length}):`);
    for (const def of defs) {
      const kind = def.command ? "command" : def.http ? "http" : def.prompt ? "prompt" : "?";
      const source = def.command ?? def.http ?? def.prompt ?? "";
      const preview = source.length > COMMAND_PREVIEW_CHARS ? `${source.slice(0, COMMAND_PREVIEW_CHARS)}…` : source;
      const matchSuffix = def.match ? ` [match: ${def.match}]` : "";
      lines.push(`    - ${kind}: ${preview}${matchSuffix}`);
    }
  }

  return lines.join("\n");
}
