/**
 * Custom tools — TypeScript functions the agent can call during a session.
 *
 * Pass an array of `ToolDefinition`s to `query()` or `OpenHarnessClient` via
 * `tools: [...]`. The SDK starts an in-process MCP HTTP server, registers
 * each tool, and writes an ephemeral `.oh/config.yaml` pointing the spawned
 * `oh` CLI at it.
 *
 * Mirrors `python/openharness/tools.py`. Python uses an optional `@tool`
 * decorator over plain callables; TS uses an explicit `ToolDefinition`
 * object with a Zod input schema.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { tool } from "@zhijiewang/openharness-sdk";
 *
 * const getWeather = tool({
 *   name: "get_weather",
 *   description: "Fetch the current weather for a city.",
 *   inputSchema: z.object({ city: z.string() }),
 *   handler: async ({ city }) => `Sunny in ${city}, 22°C`,
 * });
 * ```
 */

import type { z } from "zod";

// The default type parameter uses `z.ZodObject<any>` (rather than the tighter
// `z.ZodObject<z.ZodRawShape>`) so that `ToolDefinition[]` and `OpenHarnessOptions.tools`
// can hold a collection of tools with different concrete input shapes. Without
// this, the handler's parameter contravariance prevents assigning, e.g.,
// `ToolDefinition<ZodObject<{ msg: ZodString }>>` to the array's element type.
// Individual tool authors still get strong typing via the `tool()` helper.
export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<any>> {
  /** Tool name as exposed to the agent. Should be a stable identifier. */
  name: string;
  /** One-line human description. Shown to the model when it considers calling the tool. */
  description?: string;
  /** Zod object schema describing the tool's input. Validated by the MCP runtime. */
  inputSchema: S;
  /**
   * Tool implementation. Called with the validated input. May return any value;
   * non-string return values are JSON-stringified before being sent back to the
   * agent.
   */
  handler: (input: z.infer<S>) => unknown | Promise<unknown>;
}

/**
 * Identity helper that asserts the shape of a `ToolDefinition` and provides
 * useful inference. Equivalent to a plain object literal but catches typos
 * eagerly and surfaces nicer errors when a required field is missing.
 */
export function tool<S extends z.ZodObject<z.ZodRawShape>>(def: ToolDefinition<S>): ToolDefinition<S> {
  if (!def || typeof def !== "object") throw new TypeError("tool() requires a definition object");
  if (!def.name || typeof def.name !== "string") throw new TypeError("tool() requires a 'name' string");
  if (!def.inputSchema) throw new TypeError(`tool('${def.name}') requires an 'inputSchema' (Zod object schema)`);
  if (typeof def.handler !== "function") throw new TypeError(`tool('${def.name}') requires a 'handler' function`);
  return def;
}
