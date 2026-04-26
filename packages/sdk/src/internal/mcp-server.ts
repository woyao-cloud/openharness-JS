/**
 * In-process MCP HTTP server. Hosts user-defined tools so the spawned `oh`
 * CLI can call back into them over a Streamable-HTTP MCP transport.
 *
 * Mirrors `python/openharness/_mcp_server.py`, which wraps FastMCP +
 * uvicorn. Here we use `@modelcontextprotocol/sdk`'s `McpServer` +
 * `StreamableHTTPServerTransport` on a tiny `node:http` server.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OpenHarnessError } from "../errors.js";
import type { ToolDefinition } from "../tools.js";

const DEFAULT_NAME = "openharness-typescript-tools";

interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toCallToolResult(value: unknown): CallToolResult {
  if (value === undefined) {
    return { content: [{ type: "text", text: "" }] };
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { content: [{ type: "text", text: String(value) }] };
  }
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (isPlainObject(value)) result.structuredContent = value;
  return result;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export class InProcessMcpServer {
  private readonly mcp: McpServer;
  private readonly transport: StreamableHTTPServerTransport;
  private readonly httpServer: Server;
  private readonly serverName: string;
  private port: number | null = null;
  private started = false;
  private closed = false;

  constructor(tools: ToolDefinition[], options: { name?: string } = {}) {
    this.serverName = options.name ?? DEFAULT_NAME;
    this.mcp = new McpServer({ name: this.serverName, version: "0.1.0" });

    for (const def of tools) {
      this.mcp.registerTool(
        def.name,
        {
          description: def.description ?? "",
          inputSchema: def.inputSchema.shape,
        },
        // The MCP SDK's ToolCallback signature is generic over the input shape;
        // a cast is the cleanest way to bridge our user-facing handler shape.
        (async (args: unknown) => {
          try {
            const out = await def.handler(args as never);
            return toCallToolResult(out);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `tool '${def.name}' threw: ${message}` }],
              isError: true,
            };
          }
        }) as never,
      );
    }

    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    this.httpServer = createServer((req, res) => this.handle(req, res));
  }

  /** The Streamable-HTTP endpoint URL — drop this into an `mcpServers` config entry. */
  get url(): string {
    if (this.port == null) throw new OpenHarnessError("MCP server not started");
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** The advertised server name (visible to the agent in tool listings). */
  get name(): string {
    return this.serverName;
  }

  /** Start serving. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.mcp.connect(this.transport);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.httpServer.removeListener("error", onError);
        const addr = this.httpServer.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve();
        } else {
          reject(new OpenHarnessError("MCP HTTP server did not bind a port"));
        }
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(0, "127.0.0.1");
    });
  }

  /** Stop the server. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.mcp.close();
    } catch {
      // best-effort
    }
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
      // Force-close any keep-alive sockets so close() returns promptly.
      this.httpServer.closeAllConnections?.();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      body = await readBody(req);
    }
    try {
      await this.transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: -32603, message: String(err) } }));
      }
    }
  }
}

/** Use `zodToJsonSchema(schema)` if you ever need the JSON Schema form externally. */
export { zodToJsonSchema };
