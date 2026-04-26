import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { InProcessMcpServer } from "../src/internal/mcp-server.js";
import { tool } from "../src/tools.js";

async function withServer(
  tools: ConstructorParameters<typeof InProcessMcpServer>[0],
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = new InProcessMcpServer(tools);
  await server.start();
  try {
    await fn(server.url);
  } finally {
    await server.close();
  }
}

async function withMcpClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

describe("InProcessMcpServer", () => {
  test("registers tools and serves listTools over Streamable HTTP", async () => {
    const echo = tool({
      name: "echo",
      description: "Return the input verbatim",
      inputSchema: z.object({ msg: z.string() }),
      handler: ({ msg }) => msg,
    });
    await withServer([echo], async (url) => {
      await withMcpClient(url, async (client) => {
        const list = await client.listTools();
        const names = list.tools.map((t) => t.name);
        assert.ok(names.includes("echo"), `expected 'echo' in ${JSON.stringify(names)}`);
      });
    });
  });

  test("calls a registered tool with validated input and returns its result", async () => {
    let received: { city: string } | null = null;
    const weather = tool({
      name: "weather",
      description: "Get weather for a city",
      inputSchema: z.object({ city: z.string() }),
      handler: async (input) => {
        received = input;
        return `Sunny in ${input.city}, 22C`;
      },
    });
    await withServer([weather], async (url) => {
      await withMcpClient(url, async (client) => {
        const result = await client.callTool({ name: "weather", arguments: { city: "Paris" } });
        assert.deepEqual(received, { city: "Paris" });
        const content = result.content as Array<{ type: string; text?: string }>;
        assert.equal(content[0]?.type, "text");
        assert.equal(content[0]?.text, "Sunny in Paris, 22C");
      });
    });
  });

  test("handler throwing yields an error result with isError=true", async () => {
    const broken = tool({
      name: "broken",
      inputSchema: z.object({}),
      handler: () => {
        throw new Error("kaboom");
      },
    });
    await withServer([broken], async (url) => {
      await withMcpClient(url, async (client) => {
        const result = await client.callTool({ name: "broken", arguments: {} });
        assert.equal(result.isError, true);
        const content = result.content as Array<{ type: string; text?: string }>;
        assert.match(content[0]?.text ?? "", /kaboom/);
      });
    });
  });

  test("structured object return surfaces both text and structuredContent", async () => {
    const lookup = tool({
      name: "lookup",
      inputSchema: z.object({ id: z.string() }),
      handler: ({ id }) => ({ id, found: true, score: 0.97 }),
    });
    await withServer([lookup], async (url) => {
      await withMcpClient(url, async (client) => {
        const result = await client.callTool({ name: "lookup", arguments: { id: "abc" } });
        const content = result.content as Array<{ type: string; text?: string }>;
        assert.equal(content[0]?.type, "text");
        const parsed = JSON.parse(content[0]?.text ?? "{}");
        assert.deepEqual(parsed, { id: "abc", found: true, score: 0.97 });
      });
    });
  });
});
