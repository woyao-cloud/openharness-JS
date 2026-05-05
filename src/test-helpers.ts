/**
 * Shared test helpers — mock provider, mock tools, tmpdir, mock fetch.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ModelInfo, Provider } from "./providers/base.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import type { StreamEvent } from "./types/events.js";
import type { Message } from "./types/message.js";
import { createAssistantMessage } from "./types/message.js";

// ── Mock Provider ──

export function createMockProvider(
  streamEvents: StreamEvent[][] = [[]], // one array per turn
  completeResponses: string[] = [], // one response string per complete() call
): Provider & { calls: Array<{ messages: Message[]; systemPrompt: string }> } {
  let turnIndex = 0;
  let completeIndex = 0;
  const calls: Array<{ messages: Message[]; systemPrompt: string }> = [];

  return {
    name: "mock",
    calls,

    async *stream(messages, systemPrompt, _tools?, _model?) {
      calls.push({ messages, systemPrompt });
      const events = streamEvents[turnIndex] ?? [];
      turnIndex++;
      for (const event of events) {
        yield event;
      }
    },

    async complete(messages, systemPrompt, _tools?, _model?) {
      calls.push({ messages, systemPrompt });
      const content = completeResponses[completeIndex++] ?? "mock response";
      return createAssistantMessage(content);
    },

    listModels(): ModelInfo[] {
      return [
        {
          id: "mock-model",
          provider: "mock",
          contextWindow: 128_000,
          supportsTools: true,
          supportsStreaming: true,
          supportsVision: false,
          inputCostPerMtok: 0,
          outputCostPerMtok: 0,
        },
      ];
    },

    async healthCheck() {
      return true;
    },
  };
}

/** Create events for a simple text response */
export function textResponseEvents(text: string): StreamEvent[] {
  return [
    { type: "text_delta", content: text },
    { type: "cost_update", inputTokens: 10, outputTokens: 5, cost: 0, model: "mock" },
  ];
}

/** Create events for a tool call response */
export function toolCallEvents(toolName: string, args: Record<string, unknown>, callId = "call-1"): StreamEvent[] {
  return [
    { type: "tool_call_start", toolName, callId },
    { type: "tool_call_complete", toolName, callId, arguments: args },
    { type: "cost_update", inputTokens: 10, outputTokens: 5, cost: 0, model: "mock" },
  ];
}

/** Create a mock provider that throws on stream */
export function createErrorProvider(error: Error): Provider {
  return {
    name: "mock-error",
    async *stream() {
      throw error;
    },
    async complete() {
      throw error;
    },
    listModels() {
      return [];
    },
    async healthCheck() {
      return false;
    },
  };
}

// ── Mock Tool ──

export function createMockTool(
  name: string,
  opts: {
    readOnly?: boolean;
    concurrent?: boolean;
    risk?: "low" | "medium" | "high";
    result?: ToolResult;
    delay?: number;
  } = {},
): Tool {
  const inputSchema = z.object({ input: z.string().optional() });
  const result = opts.result ?? { output: `${name} executed`, isError: false };

  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema,
    riskLevel: opts.risk ?? "low",
    isReadOnly() {
      return opts.readOnly ?? true;
    },
    isConcurrencySafe() {
      return opts.concurrent ?? true;
    },
    async call(_input: unknown, _context: ToolContext): Promise<ToolResult> {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return result;
    },
    prompt() {
      return `Mock tool ${name}`;
    },
  };
}

// ── Tmpdir ──

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-test-"));
}

export function writeFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// ── Mock Fetch ──

const originalFetch = globalThis.fetch;

export function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  globalThis.fetch = handler as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export function mockFetchJson(data: unknown, status = 200): () => void {
  return mockFetch(async () => new Response(JSON.stringify(data), { status }));
}

// ── Hook-capture wait ──

/**
 * Poll for a hook-capture file to reach `expectedLines`. Survives Windows-CI
 * cold node-spawn (~1-3s) without burning a fixed pessimistic budget — local
 * runs exit in <100ms, slow runners get up to `timeoutMs` (default 5000ms).
 *
 * After the count is reached, a small grace period catches stragglers so
 * tests asserting "exactly N" can still detect a buggy duplicate. Returns
 * whatever's captured if the timeout elapses, so the test assertion provides
 * the failure message rather than a deadlock.
 */
export async function waitForCapture(
  capturePath: string,
  opts: { expectedLines?: number; timeoutMs?: number; pollMs?: number; graceMs?: number } = {},
): Promise<string[]> {
  const expectedLines = opts.expectedLines ?? 1;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const graceMs = opts.graceMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const read = (): string[] =>
    existsSync(capturePath) ? readFileSync(capturePath, "utf8").split("\n").filter(Boolean) : [];
  let lines: string[] = [];
  while (Date.now() < deadline) {
    lines = read();
    if (lines.length >= expectedLines) {
      await new Promise((r) => setTimeout(r, graceMs));
      return read();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return lines;
}
