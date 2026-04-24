import { z } from "zod";
import { readMcpResource } from "../../mcp/loader.js";
import type { Tool, ToolResult } from "../../Tool.js";

const inputSchema = z.object({
  uri: z.string(),
  server: z.string().optional(),
});

const MAX_OUTPUT_CHARS = 50_000;

/**
 * Pure helper — truncates resource content to MAX_OUTPUT_CHARS with a
 * trailing `[...truncated]` marker when exceeded. Exported for testing.
 */
export function formatResourceContent(content: string, maxChars: number = MAX_OUTPUT_CHARS): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[...truncated at ${maxChars} chars, original length ${content.length}]`;
}

export const ReadMcpResourceTool: Tool<typeof inputSchema> = {
  name: "ReadMcpResource",
  description: "Read a specific MCP resource by URI from a connected MCP server.",
  inputSchema,
  riskLevel: "low",

  isReadOnly() {
    return true;
  },

  isConcurrencySafe() {
    return true;
  },

  async call(input): Promise<ToolResult> {
    try {
      const content = await readMcpResource(input.uri, input.server);
      if (content === null) {
        const where = input.server ? ` from server '${input.server}'` : "";
        return {
          output: `Resource '${input.uri}' not found${where}. Run ListMcpResources to see available URIs.`,
          isError: true,
        };
      }
      return { output: formatResourceContent(content), isError: false };
    } catch (err: any) {
      return { output: `Error reading MCP resource: ${err.message}`, isError: true };
    }
  },

  prompt() {
    return `Read a specific resource from an MCP server by URI. Parameters:
- uri (string, required): the resource URI, as shown by ListMcpResources.
- server (string, optional): restrict lookup to this server. When omitted, the first server whose readResource call succeeds is used.
Output is truncated at ~50KB. For discovery, call ListMcpResources first to get URIs.`;
  },
};
