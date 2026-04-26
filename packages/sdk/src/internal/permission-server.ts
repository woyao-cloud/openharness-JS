/**
 * In-process HTTP server that fronts a user `canUseTool` callback.
 *
 * The spawned `oh` CLI POSTs `{event, toolName, toolInputJson, …}` here on
 * every permission check; we invoke the callback (with a timeout), normalise
 * its return into `{decision, reason?}`, and respond.
 *
 * Failure modes (callback throws, times out, returns garbage) all surface as
 * `decision: "deny"` so a misbehaving gate can never silently allow.
 *
 * Mirrors `python/openharness/_permission_server.py`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { OpenHarnessError } from "../errors.js";
import type { PermissionCallback, PermissionContext, PermissionDecision, PermissionVerdict } from "../permissions.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const VALID_VERDICTS: ReadonlySet<PermissionVerdict> = new Set(["allow", "deny", "ask"]);

interface NormalizedDecision {
  decision: PermissionVerdict;
  reason?: string;
}

export function coerceDecision(raw: unknown): NormalizedDecision {
  if (typeof raw === "string") {
    if (VALID_VERDICTS.has(raw as PermissionVerdict)) return { decision: raw as PermissionVerdict };
    return { decision: "deny", reason: `invalid decision '${raw}'` };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const decision = obj.decision;
    const reason = obj.reason;
    if (typeof decision === "string" && VALID_VERDICTS.has(decision as PermissionVerdict)) {
      const out: NormalizedDecision = { decision: decision as PermissionVerdict };
      if (typeof reason === "string") out.reason = reason;
      return out;
    }
    return { decision: "deny", reason: "missing or invalid 'decision' field" };
  }
  return { decision: "deny", reason: "invalid callback return type" };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface InProcessPermissionServerOptions {
  timeoutMs?: number;
}

export class InProcessPermissionServer {
  private readonly callback: PermissionCallback;
  private readonly timeoutMs: number;
  private readonly httpServer: Server;
  private port: number | null = null;
  private started = false;
  private closed = false;

  constructor(callback: PermissionCallback, options: InProcessPermissionServerOptions = {}) {
    this.callback = callback;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.httpServer = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ decision: "deny", reason: `server error: ${String(err)}` }));
        }
      });
    });
  }

  /** Endpoint URL to put in a `hooks.permissionRequest` HTTP entry. */
  get url(): string {
    if (this.port == null) throw new OpenHarnessError("permission server not started");
    return `http://127.0.0.1:${this.port}/permission`;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      const onListening = () => {
        const addr = this.httpServer.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve();
        } else {
          reject(new OpenHarnessError("permission HTTP server did not bind a port"));
        }
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(0, "127.0.0.1");
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
      this.httpServer.closeAllConnections?.();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/permission" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let ctx: PermissionContext;
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object") throw new Error("body must be an object");
      ctx = body as PermissionContext;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: "deny", reason: "invalid JSON" }));
      return;
    }

    const decision = await this.invokeWithTimeout(ctx);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(decision));
  }

  private async invokeWithTimeout(ctx: PermissionContext): Promise<NormalizedDecision> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<NormalizedDecision>((resolve) => {
      timer = setTimeout(() => resolve({ decision: "deny", reason: "callback timeout" }), this.timeoutMs);
      timer.unref?.();
    });
    const callPromise = (async (): Promise<NormalizedDecision> => {
      try {
        const result: PermissionDecision = await this.callback(ctx);
        return coerceDecision(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { decision: "deny", reason: `callback error: ${message}` };
      }
    })();
    try {
      return await Promise.race([callPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
