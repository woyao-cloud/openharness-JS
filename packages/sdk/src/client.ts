/**
 * Long-lived `OpenHarnessClient` — drives a single `oh session` subprocess
 * across multiple prompts, preserving conversation state in the CLI.
 *
 * Mirrors `python/openharness/client.py`. Per-prompt event streams are
 * demultiplexed by the `id` field on each NDJSON line; concurrent `send()`
 * calls are serialized FIFO via an internal mutex.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { OpenHarnessError } from "./errors.js";
import { type Event, parseEvent } from "./events.js";
import { AsyncQueue, EOF } from "./internal/async-queue.js";
import { findOhBinary } from "./internal/binary.js";
import { Mutex } from "./internal/mutex.js";
import { splitNdjson } from "./internal/ndjson.js";
import { sendInterrupt, sendKill, sendTerminate } from "./internal/signals.js";
import type { OpenHarnessOptions } from "./options.js";

const DEFAULT_PERMISSION_MODE = "trust" as const;
const DEFAULT_MAX_TURNS = 20;
const READY_TIMEOUT_MS = 30_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 5_000;
const FORCE_TERM_TIMEOUT_MS = 3_000;

function buildSessionArgv(options: OpenHarnessOptions): string[] {
  const argv: string[] = ["session"];
  if (options.model) argv.push("--model", options.model);
  argv.push("--permission-mode", options.permissionMode ?? DEFAULT_PERMISSION_MODE);
  if (options.allowedTools && options.allowedTools.length > 0) {
    argv.push("--allowed-tools", options.allowedTools.join(","));
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    argv.push("--disallowed-tools", options.disallowedTools.join(","));
  }
  argv.push("--max-turns", String(options.maxTurns ?? DEFAULT_MAX_TURNS));
  if (options.systemPrompt) argv.push("--system-prompt", options.systemPrompt);
  return argv;
}

export class OpenHarnessClient {
  private readonly options: OpenHarnessOptions;
  private proc: ChildProcess | null = null;
  private readerPromise: Promise<void> | null = null;
  private readonly queues = new Map<string, AsyncQueue<Event>>();
  private readonly sendMutex = new Mutex();
  private startPromise: Promise<void> | null = null;
  private fatal: Error | null = null;
  private closed = false;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private readonly readyPromise: Promise<void>;
  private _sessionId: string | null = null;

  constructor(options: OpenHarnessOptions = {}) {
    this.options = options;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /** Session ID surfaced from the CLI's `ready` event. `null` until start completes. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Spawn the `oh session` subprocess and wait for the `ready` marker. Idempotent —
   * subsequent calls return the same promise. Auto-invoked on the first `send()`.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._doStart();
    return this.startPromise;
  }

  private async _doStart(): Promise<void> {
    const handle = findOhBinary(this.options.ohBinary);
    const argv = [...handle.prefixArgs, ...buildSessionArgv(this.options)];
    const env = { ...process.env, ...(this.options.env ?? {}) };

    const proc = spawn(handle.command, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd,
      env,
      windowsHide: true,
    });
    this.proc = proc;
    proc.stderr?.setEncoding("utf8");
    // Drain stderr so the child never blocks on a full pipe.
    proc.stderr?.on("data", () => {});
    proc.once("exit", () => {
      // If the subprocess dies before/while a prompt is in flight, fail every queue.
      const err = this.fatal ?? new OpenHarnessError("'oh session' subprocess exited");
      this.fatal = err;
      this.readyReject(err);
      for (const q of this.queues.values()) q.end();
      this.queues.clear();
    });
    proc.once("error", (err) => {
      this.fatal = err;
      this.readyReject(err);
    });

    if (!proc.stdout) {
      throw new OpenHarnessError("subprocess stdout was not piped");
    }
    this.readerPromise = this._readLoop(proc.stdout).catch((err) => {
      this.fatal = err instanceof Error ? err : new OpenHarnessError(String(err));
      for (const q of this.queues.values()) q.end();
      this.queues.clear();
    });

    const timer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new OpenHarnessError(`'oh session' did not become ready within ${READY_TIMEOUT_MS}ms`)),
        READY_TIMEOUT_MS,
      ).unref(),
    );
    try {
      await Promise.race([this.readyPromise, timer]);
    } catch (err) {
      await this.close().catch(() => {});
      throw err;
    }
  }

  private async _readLoop(stdout: NodeJS.ReadableStream): Promise<void> {
    for await (const obj of splitNdjson(stdout as NodeJS.ReadableStream as never)) {
      const kind = obj.type;
      if (kind === "ready") {
        const sid = obj.sessionId;
        if (typeof sid === "string" && sid) this._sessionId = sid;
        this.readyResolve();
        continue;
      }
      const id = obj.id;
      if (typeof id !== "string" || !id) continue;
      const queue = this.queues.get(id);
      if (!queue) continue;
      const { id: _ignored, ...rest } = obj;
      void _ignored;
      queue.push(parseEvent(rest));
      if (kind === "turn_complete") {
        queue.end();
        this.queues.delete(id);
      }
    }
  }

  /**
   * Send a prompt and stream the resulting events. Concurrent calls are
   * serialized in submission order — the second one waits for the first to
   * finish.
   */
  send(prompt: string): AsyncGenerator<Event, void, void> {
    return this._sendStream(prompt);
  }

  private async *_sendStream(prompt: string): AsyncGenerator<Event, void, void> {
    if (this.closed) throw new OpenHarnessError("client is closed");
    const initialFatal = this.fatal;
    if (initialFatal) {
      throw new OpenHarnessError(`subprocess failed: ${initialFatal.message}`, { cause: initialFatal });
    }
    await this.start();

    const release = await this.sendMutex.acquire();
    let queueClaimed = false;
    const promptId = randomUUID();
    const queue = new AsyncQueue<Event>();

    try {
      if (!this.proc?.stdin || this.proc.stdin.destroyed) {
        throw new OpenHarnessError("subprocess stdin is not writable");
      }
      this.queues.set(promptId, queue);
      queueClaimed = true;

      const payload = `${JSON.stringify({ id: promptId, prompt })}\n`;
      const writeOk = this.proc.stdin.write(payload, "utf8");
      if (!writeOk) {
        await new Promise<void>((resolve, reject) => {
          this.proc?.stdin?.once("drain", resolve);
          this.proc?.stdin?.once("error", reject);
        });
      }

      while (true) {
        const item = await queue.next();
        if (item === EOF) {
          const fatal = this.fatal;
          if (fatal) throw new OpenHarnessError(`subprocess failed: ${fatal.message}`, { cause: fatal });
          return;
        }
        yield item;
      }
    } finally {
      if (queueClaimed) this.queues.delete(promptId);
      release();
    }
  }

  /**
   * Send `SIGINT` (or the Windows equivalent) to interrupt an in-flight prompt.
   * The CLI today treats this as termination, so subsequent `send()` calls will
   * fail. Use sparingly.
   */
  async interrupt(): Promise<void> {
    if (!this.proc || this.proc.exitCode != null || this.proc.signalCode != null) return;
    sendInterrupt(this.proc);
  }

  /**
   * Close the subprocess cleanly: send `{command:"exit"}` on stdin, wait up
   * to 5 s for graceful exit, escalate to `SIGTERM`, then `SIGKILL` after
   * another 3 s. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    if (!proc) return;

    const exitPromise = new Promise<void>((resolve) => {
      if (proc.exitCode != null || proc.signalCode != null) resolve();
      else proc.once("exit", () => resolve());
    });

    if (proc.stdin && !proc.stdin.destroyed) {
      try {
        proc.stdin.write('{"command":"exit"}\n', "utf8");
        proc.stdin.end();
      } catch {
        // pipe may already be closed — ignore
      }
    }

    let exited = false;
    try {
      await Promise.race([
        exitPromise.then(() => {
          exited = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_EXIT_TIMEOUT_MS).unref()),
      ]);
      if (!exited) {
        sendTerminate(proc);
        await Promise.race([
          exitPromise.then(() => {
            exited = true;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, FORCE_TERM_TIMEOUT_MS).unref()),
        ]);
      }
      if (!exited) {
        sendKill(proc);
        await exitPromise;
      }
    } finally {
      // Drain reader; it will exit naturally once stdout closes.
      if (this.readerPromise) {
        await this.readerPromise.catch(() => {});
      }
      // End any queues that are still waiting.
      for (const q of this.queues.values()) q.end();
      this.queues.clear();
    }
  }

  /** TC39 explicit-resource-management hook so callers can use `await using client = new OpenHarnessClient()`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
