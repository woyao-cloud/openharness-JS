import { z } from "zod";
import { listMcpResources } from "../../mcp/loader.js";
import type { Tool, ToolResult } from "../../Tool.js";

const inputSchema = z.object({
  server: z.string().optional(),
});

export type McpResourceEntry = {
  server: string;
  uri: string;
  name: string;
  description?: string;
};

/**
 * Pure formatter — renders the resource list as a markdown table.
 * Exported for testing; production callers should use the tool's `.call()`.
 */
export function formatResourcesList(resources: McpResourceEntry[], serverFilter?: string): string {
  const filtered = serverFilter ? resources.filter((r) => r.server === serverFilter) : resources;

  if (filtered.length === 0) {
    if (serverFilter) {
      return `No MCP resources available from server '${serverFilter}'.`;
    }
    return "No MCP resources available. Connect an MCP server that exposes resources under mcpServers in .oh/config.yaml.";
  }

  const lines: string[] = ["| Server | URI | Name | Description |", "|--------|-----|------|-------------|"];
  for (const r of filtered) {
    const desc = (r.description ?? "").replace(/\|/g, "\\|").slice(0, 80);
    const name = r.name.replace(/\|/g, "\\|");
    const uri = r.uri.replace(/\|/g, "\\|");
    lines.push(`| ${r.server} | ${uri} | ${name} | ${desc} |`);
  }
  return lines.join("\n");
}

export const ListMcpResourcesTool: Tool<typeof inputSchema> = {
  name: "ListMcpResources",
  description: "List resources exposed by connected MCP servers.",
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
      const resources = await listMcpResources();
      return { output: formatResourcesList(resources, input.server), isError: false };
    } catch (err: any) {
      return { output: `Error listing MCP resources: ${err.message}`, isError: true };
    }
  },

  prompt() {
    return `List resources exposed by connected MCP servers. Parameters:
- server (string, optional): restrict to this server's resources.
Returns a markdown table with columns: Server, URI, Name, Description. Use ReadMcpResource with a URI from the table to fetch the content. Resources are read-only data sources (docs, indices, state) — distinct from MCP tools, which are actions.`;
  },
};
