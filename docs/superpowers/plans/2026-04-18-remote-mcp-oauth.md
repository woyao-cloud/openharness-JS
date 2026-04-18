# Remote MCP — OAuth 2.1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OAuth 2.1 (Auth Code + PKCE + Dynamic Client Registration) to openHarness's remote MCP transports, auto-triggered on `401 + WWW-Authenticate`, with filesystem-backed token storage and three slash commands (`/mcp-login`, `/mcp-logout`, extended `/mcp`).

**Architecture:** Implement the MCP TypeScript SDK's `OAuthClientProvider` interface in a new `src/mcp/oauth.ts`, backed by a small atomic-write filesystem store in `src/mcp/oauth-storage.ts`. `src/mcp/transport.ts` gains one new export `buildAuthProvider(cfg, storageDir)` that returns a provider when the config warrants it, passed to `StreamableHTTPClientTransport`/`SSEClientTransport` via their `authProvider` option. Slash commands live in `src/commands/mcp-auth.ts` and are registered alongside existing `/mcp` in `src/commands/info.ts`.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@^1.29`, `open@^10` (browser launcher), Node `node:http` (callback listener), Node `node:test`.

**Source spec:** `docs/superpowers/specs/2026-04-18-remote-mcp-oauth-design.md`

---

## File Structure

### Create
- `src/mcp/oauth-storage.ts` — atomic write/read + mode enforcement for `~/.oh/credentials/mcp/<name>.json`.
- `src/mcp/oauth-storage.test.ts` — hermetic tests against a temp dir.
- `src/mcp/oauth.ts` — `OhOAuthProvider` class implementing SDK's `OAuthClientProvider`, plus `buildAuthProvider`, `getAuthStatus`, `clearTokens`, `redactToken` helpers.
- `src/mcp/oauth.test.ts` — hermetic tests for provider methods + callback listener + redaction.
- `src/commands/mcp-auth.ts` — `/mcp-login` and `/mcp-logout` handlers.
- `src/commands/mcp-auth.test.ts` — command handler tests.

### Modify
- `package.json` — add `open` dep.
- `src/harness/config.ts` — add `auth?: "oauth" | "none"` to `McpHttpConfig` and `McpSseConfig`.
- `src/mcp/config-normalize.ts` — pass through the `auth` field on http/sse configs.
- `src/mcp/config-normalize.test.ts` — cover the new `auth` field.
- `src/mcp/transport.ts` — wire `authProvider` into HTTP and SSE transports when `buildAuthProvider` returns non-undefined.
- `src/mcp/transport.test.ts` — tests for `buildAuthProvider`.
- `src/commands/info.ts` — register the two new commands; extend `/mcp` handler output with auth state.
- `tests/integration/mcp-remote.test.ts` — add a second test exercising the full OAuth flow against an in-process OAuth server.
- `docs/mcp-servers.md` — document `auth:` field + slash commands + storage location.
- `README.md` — one-liner pointing to the auth section.
- `CHANGELOG.md` — Unreleased entry.

### Unchanged (indirectly exercised)
- `src/mcp/client.ts`, `src/mcp/loader.ts`, `src/mcp/McpTool.ts`, `src/mcp/DeferredMcpTool.ts`.

---

## Task 1: Add `open` dependency

**Files:** Modify: `package.json`

- [ ] **Step 1: Install the dep**

```bash
npm install open
```

Expected: `dependencies` gains `"open": "^10.x.y"`. `package-lock.json` updates.

- [ ] **Step 2: Verify import resolves**

Create `src/mcp/_probe.ts`:
```ts
import open from "open";
export const _probe = typeof open;
```

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Delete probe, commit**

```bash
rm src/mcp/_probe.ts
git add package.json package-lock.json
git commit -m "deps: add open for OAuth browser launch"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 2: Config `auth` field

**Files:**
- Modify: `src/harness/config.ts`
- Modify: `src/mcp/config-normalize.ts`
- Modify: `src/mcp/config-normalize.test.ts`

- [ ] **Step 1: Extend the union in `src/harness/config.ts`**

Find the existing `McpHttpConfig` and `McpSseConfig` definitions (introduced in v2.11.0). Add an optional `auth` field to both:

```ts
export type McpHttpConfig = McpCommonConfig & {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "none";
};

export type McpSseConfig = McpCommonConfig & {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "none";
};
```

`McpStdioConfig` and `McpCommonConfig` are unchanged.

- [ ] **Step 2: Write failing tests in `src/mcp/config-normalize.test.ts`**

Append to the existing `describe("normalizeMcpConfig", ...)` block:

```ts
  it("preserves auth='oauth' on http configs", () => {
    const out = normalizeMcpConfig(
      { name: "linear", type: "http", url: "https://x/mcp", auth: "oauth" } as McpServerConfig,
      {},
    );
    assert.equal(out.kind, "ok");
    if (out.kind !== "ok" || out.cfg.type !== "http") return;
    assert.equal(out.cfg.auth, "oauth");
  });

  it("preserves auth='none' on sse configs", () => {
    const out = normalizeMcpConfig(
      { name: "legacy", type: "sse", url: "https://x/sse", auth: "none" } as McpServerConfig,
      {},
    );
    assert.equal(out.kind, "ok");
    if (out.kind !== "ok" || out.cfg.type !== "sse") return;
    assert.equal(out.cfg.auth, "none");
  });

  it("leaves auth undefined when not set (auto mode)", () => {
    const out = normalizeMcpConfig(
      { name: "api", type: "http", url: "https://x/mcp" } as McpServerConfig,
      {},
    );
    assert.equal(out.kind, "ok");
    if (out.kind !== "ok" || out.cfg.type !== "http") return;
    assert.equal(out.cfg.auth, undefined);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx tsx --test src/mcp/config-normalize.test.ts
```
Expected: FAIL — existing `normalizeMcpConfig` drops `auth` (not in the `{ ...raw, type: ..., headers: ... }` spread explicitly preserving `auth`). **NOTE:** the existing spread via `{ ...(raw as McpHttpConfig | McpSseConfig), type: effectiveType, headers: interp.headers }` already preserves extra fields via `...raw`. Tests likely PASS without any change to `normalizeMcpConfig`. If so, that's acceptable — the field flows through by virtue of the existing spread.

**If the tests all pass already**, skip Step 4 and go to Step 5.

- [ ] **Step 4: If tests fail, update `normalizeMcpConfig`**

If any test failed, the field must be explicitly preserved. In `src/mcp/config-normalize.ts`, the http/sse branch currently ends with:

```ts
  const base = { ...(raw as McpHttpConfig | McpSseConfig), type: effectiveType, headers: interp.headers };
```

The `...raw` spread should already carry `auth`. If TypeScript narrows incorrectly, add an explicit field:

```ts
  const base = {
    ...(raw as McpHttpConfig | McpSseConfig),
    type: effectiveType,
    headers: interp.headers,
    auth: (raw as McpHttpConfig | McpSseConfig).auth,
  };
```

Re-run the tests.

- [ ] **Step 5: Full typecheck + suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean; full suite +3 tests (1015 → 1018).

- [ ] **Step 6: Commit**

```bash
git add src/harness/config.ts src/mcp/config-normalize.ts src/mcp/config-normalize.test.ts
git commit -m "feat(mcp): add auth field to http/sse configs"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 3: Filesystem storage layer

**Files:**
- Create: `src/mcp/oauth-storage.ts`
- Create: `src/mcp/oauth-storage.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/mcp/oauth-storage.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCredentials, saveCredentials, deleteCredentials, type OhCredentials } from "./oauth-storage.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-oauth-storage-"));
}

const sample: OhCredentials = {
  issuerUrl: "https://auth.example.com",
  clientInformation: { client_id: "abc", client_secret: undefined },
  tokens: { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 60_000, token_type: "Bearer" },
  codeVerifier: undefined,
  updatedAt: new Date().toISOString(),
};

describe("oauth-storage", () => {
  it("saveCredentials + loadCredentials round-trip", async () => {
    const dir = freshDir();
    try {
      await saveCredentials(dir, "linear", sample);
      const loaded = await loadCredentials(dir, "linear");
      assert.deepEqual(loaded, sample);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadCredentials returns undefined when file is absent", async () => {
    const dir = freshDir();
    try {
      const loaded = await loadCredentials(dir, "nope");
      assert.equal(loaded, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadCredentials returns undefined on corrupt JSON (without throwing)", async () => {
    const dir = freshDir();
    try {
      // Seed a corrupt file at the exact path saveCredentials would use.
      await saveCredentials(dir, "x", sample);
      writeFileSync(join(dir, "x.json"), "{not valid json");
      const loaded = await loadCredentials(dir, "x");
      assert.equal(loaded, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deleteCredentials removes the file idempotently", async () => {
    const dir = freshDir();
    try {
      await saveCredentials(dir, "bye", sample);
      await deleteCredentials(dir, "bye");
      assert.equal(await loadCredentials(dir, "bye"), undefined);
      // Idempotent: second delete does not throw.
      await deleteCredentials(dir, "bye");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveCredentials writes mode 0600 on non-Windows", async () => {
    if (process.platform === "win32") return; // mode bits don't apply cleanly on Windows
    const dir = freshDir();
    try {
      await saveCredentials(dir, "m", sample);
      const s = statSync(join(dir, "m.json"));
      assert.equal(s.mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/mcp/oauth-storage.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/oauth-storage.ts`**

```ts
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export type OhCredentials = {
  issuerUrl: string;
  clientInformation: { client_id: string; client_secret?: string } & Record<string, unknown>;
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    token_type?: string;
    scope?: string;
  };
  codeVerifier?: string;
  updatedAt: string;
};

function pathFor(storageDir: string, name: string): string {
  return join(storageDir, `${name}.json`);
}

/** Atomically write credentials for one server. Creates the directory with 0o700 on first use. */
export async function saveCredentials(storageDir: string, name: string, creds: OhCredentials): Promise<void> {
  const filePath = pathFor(storageDir, name);
  const tmpPath = `${filePath}.tmp`;
  await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(creds, null, 2);
  await fs.writeFile(tmpPath, body, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

/** Load credentials. Returns undefined on missing file OR corrupt JSON. Warns on world/group-readable mode. */
export async function loadCredentials(storageDir: string, name: string): Promise<OhCredentials | undefined> {
  const filePath = pathFor(storageDir, name);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    if (process.platform !== "win32") {
      const s = await fs.stat(filePath);
      if ((s.mode & 0o077) !== 0) {
        // biome-ignore lint/suspicious/noConsole: user-facing diagnostic
        console.warn(
          `[mcp] credentials file for '${name}' is world/group-readable; run 'chmod 600 ${filePath}'`,
        );
      }
    }
  } catch {
    // stat failure is non-fatal for load
  }
  try {
    return JSON.parse(raw) as OhCredentials;
  } catch {
    // biome-ignore lint/suspicious/noConsole: user-facing diagnostic
    console.warn(`[mcp] credentials file for '${name}' is corrupt; ignoring`);
    return undefined;
  }
}

/** Idempotent delete — ENOENT is swallowed. */
export async function deleteCredentials(storageDir: string, name: string): Promise<void> {
  const filePath = pathFor(storageDir, name);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/mcp/oauth-storage.test.ts
```
Expected: all 5 tests pass (the mode-bits test is a no-op on Windows but still "passes" by early-returning).

- [ ] **Step 5: Full typecheck + suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean; suite grows by 5 (1018 → 1023).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/oauth-storage.ts src/mcp/oauth-storage.test.ts
git commit -m "feat(mcp): oauth credential storage (atomic writes, 0600 perms)"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 4: Callback listener

**Files:**
- Create (partial): `src/mcp/oauth.ts`
- Create (partial): `src/mcp/oauth.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/mcp/oauth.test.ts`:

```ts
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { awaitOAuthCallback } from "./oauth.js";

describe("awaitOAuthCallback", () => {
  it("resolves with {code, state} on a valid GET /oauth/callback", async () => {
    const pending = awaitOAuthCallback({ timeoutMs: 2_000 });
    // Trigger the callback via a real HTTP GET
    const res = await fetch(`${pending.redirectUri}?code=CODE123&state=STATE456`);
    assert.ok(res.ok);
    const result = await pending.done;
    assert.equal(result.code, "CODE123");
    assert.equal(result.state, "STATE456");
  });

  it("rejects on timeout", async () => {
    const pending = awaitOAuthCallback({ timeoutMs: 200 });
    await assert.rejects(() => pending.done, /timeout/i);
    pending.close(); // idempotent
  });

  it("rejects non-/oauth/callback paths with 404 and does NOT resolve", async () => {
    const pending = awaitOAuthCallback({ timeoutMs: 1_000 });
    const res = await fetch(`${pending.redirectUri.replace("/oauth/callback", "/evil")}?code=X&state=Y`);
    assert.equal(res.status, 404);
    // The main promise should still be waiting; close to tidy up.
    pending.close();
    await assert.rejects(() => pending.done, /closed|cancel|timeout/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: FAIL — `awaitOAuthCallback` not exported.

- [ ] **Step 3: Implement `awaitOAuthCallback` in `src/mcp/oauth.ts`**

Create `src/mcp/oauth.ts` with this initial content:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type OAuthCallbackResult = { code: string; state: string };

export type PendingCallback = {
  /** The full redirect URI clients should be sent to. */
  readonly redirectUri: string;
  /** Resolves with the captured code+state; rejects on timeout or close. */
  readonly done: Promise<OAuthCallbackResult>;
  /** Close the listener immediately. Idempotent. */
  close: () => void;
};

const SUCCESS_HTML = `<!doctype html><html><body style="font-family: system-ui; padding: 2rem">
<h2>Authorization complete</h2>
<p>You can close this tab and return to openHarness.</p>
</body></html>`;

/**
 * Bind a single-shot HTTP listener on 127.0.0.1 to receive the OAuth redirect.
 * Returns immediately with the bound URI and a promise that resolves when the
 * callback arrives (or rejects on timeout/close).
 */
export function awaitOAuthCallback(opts: { timeoutMs: number }): PendingCallback {
  let server: Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const resultPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    server = createServer((req, res) => {
      // Host-header check — reject anything not targeting our loopback
      const host = req.headers.host ?? "";
      if (!host.startsWith("127.0.0.1:")) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method !== "GET" || url.pathname !== "/oauth/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      cleanup();
      resolve({ code, state });
    });

    server.listen(0, "127.0.0.1");

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`OAuth callback timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    function cleanup(): void {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (server) server.close();
    }

    // Expose close via closure to the outer object below
    (resultPromise as any)._close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (server) server.close();
      reject(new Error("OAuth callback closed before completion"));
    };
  });

  // Wait for bind to complete so we can read the port.
  // server.listen is async; we resolve the port via the 'listening' event.
  // We block here via a quick synchronous wait using deasync-free polling.
  // Simpler: return a lazy URI constructed after bind.
  // (Implementation below uses a started-barrier promise.)
  const bound = new Promise<AddressInfo>((resolve, reject) => {
    if (!server) {
      reject(new Error("server not constructed"));
      return;
    }
    if (server.listening) {
      resolve(server.address() as AddressInfo);
    } else {
      server.once("listening", () => resolve(server!.address() as AddressInfo));
      server.once("error", reject);
    }
  });

  const pending: PendingCallback = {
    get redirectUri() {
      throw new Error("redirectUri must be awaited via ready() before access");
    },
    done: resultPromise,
    close: () => {
      const fn = (resultPromise as any)._close as (() => void) | undefined;
      if (fn) fn();
    },
  };

  // Attach a ready() helper the caller can await to obtain the URI.
  (pending as any).ready = async () => {
    const addr = await bound;
    return `http://127.0.0.1:${addr.port}/oauth/callback`;
  };

  // For test ergonomics, also eagerly set redirectUri once bound.
  bound.then((addr) => {
    Object.defineProperty(pending, "redirectUri", {
      value: `http://127.0.0.1:${addr.port}/oauth/callback`,
      writable: false,
      configurable: true,
    });
  });

  return pending;
}
```

**NOTE:** The above reveals an API wart — `redirectUri` is only readable after bind completes. The tests will fail until the getter is resolved. Simpler fix: make `awaitOAuthCallback` async and return the fully-formed object. Replace the body with:

```ts
export async function awaitOAuthCallback(opts: { timeoutMs: number }): Promise<PendingCallback> {
  let server: Server;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // Start server and wait for bind.
  server = createServer(/* handler assigned below */);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const addr = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${addr.port}/oauth/callback`;

  let resolveResult!: (r: OAuthCallbackResult) => void;
  let rejectResult!: (e: Error) => void;
  const done = new Promise<OAuthCallbackResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    server.close();
  }

  server.on("request", (req, res) => {
    const host = req.headers.host ?? "";
    if (!host.startsWith("127.0.0.1:")) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method !== "GET" || url.pathname !== "/oauth/callback") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(SUCCESS_HTML);
    cleanup();
    resolveResult({ code, state });
  });

  timer = setTimeout(() => {
    cleanup();
    rejectResult(new Error(`OAuth callback timeout after ${opts.timeoutMs}ms`));
  }, opts.timeoutMs);

  return {
    redirectUri,
    done,
    close: () => {
      if (closed) return;
      cleanup();
      rejectResult(new Error("OAuth callback closed before completion"));
    },
  };
}
```

Use this async version. Also update the test file (Step 1) to `await awaitOAuthCallback(...)` since it's now async. Replace the test calls:

```ts
    const pending = await awaitOAuthCallback({ timeoutMs: 2_000 });
```

(repeat for all 3 tests).

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: 3/3 pass.

- [ ] **Step 5: Full typecheck + suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean; suite +3 (1023 → 1026).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/oauth.ts src/mcp/oauth.test.ts
git commit -m "feat(mcp): one-shot OAuth callback listener on 127.0.0.1"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 5: Token redaction helper

**Files:**
- Modify: `src/mcp/oauth.ts` (append)
- Modify: `src/mcp/oauth.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `src/mcp/oauth.test.ts`:

```ts
import { redactToken } from "./oauth.js";

describe("redactToken", () => {
  it("redacts access_token= in query strings", () => {
    const msg = "failed: https://a/token?access_token=sk-1234&state=x";
    assert.match(redactToken(msg), /access_token=<redacted>/);
    assert.doesNotMatch(redactToken(msg), /sk-1234/);
  });

  it("redacts refresh_token= in form bodies", () => {
    const msg = "body: grant_type=refresh_token&refresh_token=rt-9999&client_id=foo";
    assert.match(redactToken(msg), /refresh_token=<redacted>/);
    assert.doesNotMatch(redactToken(msg), /rt-9999/);
  });

  it("redacts bearer tokens in Authorization strings", () => {
    const msg = 'header: "Authorization: Bearer sk-secret-abc"';
    assert.match(redactToken(msg), /Bearer <redacted>/);
    assert.doesNotMatch(redactToken(msg), /sk-secret-abc/);
  });

  it("is a no-op on strings without tokens", () => {
    assert.equal(redactToken("nothing to see here"), "nothing to see here");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: FAIL — `redactToken` not exported.

- [ ] **Step 3: Implement `redactToken`**

Append to `src/mcp/oauth.ts`:

```ts
/** Strip access_token=, refresh_token=, and "Bearer <x>" from a log message. */
export function redactToken(msg: string): string {
  return msg
    .replace(/(access_token|refresh_token|code)=[^&\s"']+/gi, "$1=<redacted>")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: 4 new tests pass (7 total in this file).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/oauth.ts src/mcp/oauth.test.ts
git commit -m "feat(mcp): redactToken helper for log hygiene"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 6: `OhOAuthProvider` class implementing the SDK interface

**Files:**
- Modify: `src/mcp/oauth.ts` (append)
- Modify: `src/mcp/oauth.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `src/mcp/oauth.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OhOAuthProvider } from "./oauth.js";

describe("OhOAuthProvider", () => {
  function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "oh-oauth-provider-"));
  }

  it("tokens() returns undefined when no credentials file exists", async () => {
    const dir = freshDir();
    try {
      const p = new OhOAuthProvider({ name: "srv", storageDir: dir, openFn: async () => {} });
      await p.ready();
      assert.equal(await p.tokens(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveTokens + tokens() round-trip", async () => {
    const dir = freshDir();
    try {
      const p = new OhOAuthProvider({ name: "srv", storageDir: dir, openFn: async () => {} });
      await p.ready();
      await p.saveTokens({
        access_token: "at",
        refresh_token: "rt",
        token_type: "Bearer",
        expires_in: 60,
      } as any);
      const t = await p.tokens();
      assert.equal(t?.access_token, "at");
      assert.equal(t?.refresh_token, "rt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveClientInformation + clientInformation round-trip", async () => {
    const dir = freshDir();
    try {
      const p = new OhOAuthProvider({ name: "srv", storageDir: dir, openFn: async () => {} });
      await p.ready();
      await p.saveClientInformation({ client_id: "cid", client_secret: "cs" } as any);
      const info = await p.clientInformation();
      assert.equal(info?.client_id, "cid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveCodeVerifier + codeVerifier round-trip; cleared after saveTokens", async () => {
    const dir = freshDir();
    try {
      const p = new OhOAuthProvider({ name: "srv", storageDir: dir, openFn: async () => {} });
      await p.ready();
      await p.saveCodeVerifier("v-abc");
      assert.equal(await p.codeVerifier(), "v-abc");
      await p.saveTokens({ access_token: "at", token_type: "Bearer" } as any);
      // After tokens save, verifier is cleared.
      await assert.rejects(() => p.codeVerifier(), /no code verifier/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("codeVerifier() throws if called before saveCodeVerifier", async () => {
    const dir = freshDir();
    try {
      const p = new OhOAuthProvider({ name: "srv", storageDir: dir, openFn: async () => {} });
      await p.ready();
      await assert.rejects(() => p.codeVerifier(), /no code verifier/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redirectUrl is available after ready()", async () => {
    const dir = freshDir();
    try {
      const p = new OhOAuthProvider({ name: "srv", storageDir: dir, openFn: async () => {} });
      await p.ready();
      assert.match(p.redirectUrl as string, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redirectToAuthorization calls openFn with the URL", async () => {
    const dir = freshDir();
    try {
      const seen: string[] = [];
      const p = new OhOAuthProvider({
        name: "srv",
        storageDir: dir,
        openFn: async (url) => {
          seen.push(url);
        },
      });
      await p.ready();
      await p.redirectToAuthorization(new URL("https://auth.example.com/authorize?foo=bar"));
      assert.equal(seen.length, 1);
      assert.equal(seen[0], "https://auth.example.com/authorize?foo=bar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: FAIL — `OhOAuthProvider` not exported.

- [ ] **Step 3: Implement `OhOAuthProvider`**

Append to `src/mcp/oauth.ts`:

```ts
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { deleteCredentials, loadCredentials, saveCredentials, type OhCredentials } from "./oauth-storage.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

export type OhOAuthProviderOptions = {
  name: string;
  storageDir: string;
  /** Browser launch hook — injected for tests; production wires to `open` from the npm package. */
  openFn: (url: string) => Promise<void>;
};

/**
 * Implements the SDK's OAuthClientProvider backed by OhCredentials on disk.
 * Lazily binds the callback listener on ready() (called before the SDK reads redirectUrl).
 */
export class OhOAuthProvider implements OAuthClientProvider {
  private readonly name: string;
  private readonly storageDir: string;
  private readonly openFn: (url: string) => Promise<void>;

  private pending: PendingCallback | null = null;
  private _redirectUri: string | null = null;
  private inMemoryCodeVerifier: string | null = null;

  constructor(opts: OhOAuthProviderOptions) {
    this.name = opts.name;
    this.storageDir = opts.storageDir;
    this.openFn = opts.openFn;
  }

  /** Bind the callback listener and prepare redirectUri. Call before first SDK access. */
  async ready(): Promise<void> {
    if (this.pending) return;
    this.pending = await awaitOAuthCallback({ timeoutMs: CALLBACK_TIMEOUT_MS });
    this._redirectUri = this.pending.redirectUri;
  }

  /** Release the callback listener (no-op if already resolved/closed). */
  close(): void {
    this.pending?.close();
    this.pending = null;
    this._redirectUri = null;
  }

  get redirectUrl(): string | URL | undefined {
    return this._redirectUri ?? undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "openharness",
      redirect_uris: this._redirectUri ? [this._redirectUri] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const creds = await loadCredentials(this.storageDir, this.name);
    return creds?.clientInformation as OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const creds = (await loadCredentials(this.storageDir, this.name)) ?? this.emptyCreds();
    creds.clientInformation = info as OhCredentials["clientInformation"];
    creds.updatedAt = new Date().toISOString();
    await saveCredentials(this.storageDir, this.name, creds);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const creds = await loadCredentials(this.storageDir, this.name);
    if (!creds?.tokens) return undefined;
    return {
      access_token: creds.tokens.access_token,
      refresh_token: creds.tokens.refresh_token,
      token_type: creds.tokens.token_type ?? "Bearer",
      scope: creds.tokens.scope,
      expires_in:
        creds.tokens.expires_at && creds.tokens.expires_at > Date.now()
          ? Math.floor((creds.tokens.expires_at - Date.now()) / 1000)
          : 0,
    } as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const creds = (await loadCredentials(this.storageDir, this.name)) ?? this.emptyCreds();
    creds.tokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type ?? "Bearer",
      scope: (tokens as any).scope,
      expires_at: (tokens as any).expires_in
        ? Date.now() + Number((tokens as any).expires_in) * 1000
        : undefined,
    };
    creds.codeVerifier = undefined; // clear verifier once tokens land
    this.inMemoryCodeVerifier = null;
    creds.updatedAt = new Date().toISOString();
    await saveCredentials(this.storageDir, this.name, creds);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.openFn(url.toString());
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.inMemoryCodeVerifier = verifier;
    const creds = (await loadCredentials(this.storageDir, this.name)) ?? this.emptyCreds();
    creds.codeVerifier = verifier;
    creds.updatedAt = new Date().toISOString();
    await saveCredentials(this.storageDir, this.name, creds);
  }

  async codeVerifier(): Promise<string> {
    if (this.inMemoryCodeVerifier) return this.inMemoryCodeVerifier;
    const creds = await loadCredentials(this.storageDir, this.name);
    if (!creds?.codeVerifier) {
      throw new Error(`no code verifier saved for '${this.name}'`);
    }
    return creds.codeVerifier;
  }

  /** Await a resolved callback from the listener bound in ready(). */
  async awaitCallback(): Promise<OAuthCallbackResult> {
    if (!this.pending) throw new Error("awaitCallback called before ready()");
    return this.pending.done;
  }

  private emptyCreds(): OhCredentials {
    return {
      issuerUrl: "",
      clientInformation: { client_id: "" },
      tokens: { access_token: "" },
      updatedAt: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: all new tests pass (14 total in file: 3 callback + 4 redact + 7 provider).

- [ ] **Step 5: Full typecheck + suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean; suite +7 (1026 → 1033).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/oauth.ts src/mcp/oauth.test.ts
git commit -m "feat(mcp): OhOAuthProvider implementing SDK OAuthClientProvider"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 7: `buildAuthProvider`, `clearTokens`, `getAuthStatus`

**Files:**
- Modify: `src/mcp/oauth.ts` (append)
- Modify: `src/mcp/oauth.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `src/mcp/oauth.test.ts`:

```ts
import { buildAuthProvider, clearTokens, getAuthStatus } from "./oauth.js";
import type { NormalizedConfig } from "./config-normalize.js";

describe("buildAuthProvider", () => {
  function cfgHttp(overrides: Partial<NormalizedConfig> = {}): NormalizedConfig {
    return { name: "srv", type: "http", url: "https://x/mcp", ...overrides } as NormalizedConfig;
  }

  it("returns a provider for http configs without headers.Authorization and without auth='none'", () => {
    const p = buildAuthProvider(cfgHttp(), "/tmp/oh-test", async () => {});
    assert.ok(p !== undefined);
  });

  it("returns undefined when headers.Authorization is set", () => {
    const p = buildAuthProvider(cfgHttp({ headers: { Authorization: "Bearer x" } } as any), "/tmp/oh-test", async () => {});
    assert.equal(p, undefined);
  });

  it("returns undefined when auth='none'", () => {
    const p = buildAuthProvider(cfgHttp({ auth: "none" } as any), "/tmp/oh-test", async () => {});
    assert.equal(p, undefined);
  });

  it("returns undefined for stdio configs", () => {
    const p = buildAuthProvider(
      { name: "fs", type: "stdio", command: "x" } as NormalizedConfig,
      "/tmp/oh-test",
      async () => {},
    );
    assert.equal(p, undefined);
  });

  it("returns a provider for sse configs when eligible", () => {
    const p = buildAuthProvider(
      { name: "legacy", type: "sse", url: "https://x/sse" } as NormalizedConfig,
      "/tmp/oh-test",
      async () => {},
    );
    assert.ok(p !== undefined);
  });
});

describe("getAuthStatus", () => {
  function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "oh-oauth-status-"));
  }

  it("returns 'n/a' for stdio configs", async () => {
    const status = await getAuthStatus(
      { name: "fs", type: "stdio", command: "x" } as NormalizedConfig,
      "/tmp/nope",
    );
    assert.equal(status, "n/a");
  });

  it("returns 'n/a' when headers.Authorization is set", async () => {
    const status = await getAuthStatus(
      { name: "s", type: "http", url: "http://x", headers: { Authorization: "Bearer x" } } as NormalizedConfig,
      "/tmp/nope",
    );
    assert.equal(status, "n/a");
  });

  it("returns 'none' when no credentials file exists", async () => {
    const dir = freshDir();
    try {
      const status = await getAuthStatus(
        { name: "s", type: "http", url: "http://x" } as NormalizedConfig,
        dir,
      );
      assert.equal(status, "none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'authenticated' when expires_at is in the future", async () => {
    const dir = freshDir();
    try {
      await saveCredentials(dir, "s", {
        issuerUrl: "x",
        clientInformation: { client_id: "c" },
        tokens: { access_token: "at", expires_at: Date.now() + 60_000 },
        updatedAt: new Date().toISOString(),
      });
      const status = await getAuthStatus(
        { name: "s", type: "http", url: "http://x" } as NormalizedConfig,
        dir,
      );
      assert.equal(status, "authenticated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'expired' when expires_at is in the past", async () => {
    const dir = freshDir();
    try {
      await saveCredentials(dir, "s", {
        issuerUrl: "x",
        clientInformation: { client_id: "c" },
        tokens: { access_token: "at", expires_at: Date.now() - 60_000 },
        updatedAt: new Date().toISOString(),
      });
      const status = await getAuthStatus(
        { name: "s", type: "http", url: "http://x" } as NormalizedConfig,
        dir,
      );
      assert.equal(status, "expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clearTokens", () => {
  it("deletes the credentials file idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-oauth-clear-"));
    try {
      await saveCredentials(dir, "bye", {
        issuerUrl: "x",
        clientInformation: { client_id: "c" },
        tokens: { access_token: "at" },
        updatedAt: new Date().toISOString(),
      });
      await clearTokens(dir, "bye");
      assert.equal(await loadCredentials(dir, "bye"), undefined);
      // Idempotent:
      await clearTokens(dir, "bye");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Also add this import at the top of `oauth.test.ts` if not already present:

```ts
import { loadCredentials, saveCredentials } from "./oauth-storage.js";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: FAIL — `buildAuthProvider`, `clearTokens`, `getAuthStatus` not exported.

- [ ] **Step 3: Implement the three functions**

Append to `src/mcp/oauth.ts`:

```ts
import type { NormalizedConfig } from "./config-normalize.js";

export type AuthStatus = "n/a" | "none" | "authenticated" | "expired";

/**
 * Construct an OAuth provider for a normalized config, iff:
 * - type is http or sse
 * - no static headers.Authorization
 * - auth !== "none"
 * Otherwise return undefined — the transport proceeds without OAuth.
 */
export function buildAuthProvider(
  cfg: NormalizedConfig,
  storageDir: string,
  openFn: (url: string) => Promise<void>,
): OhOAuthProvider | undefined {
  if (cfg.type === "stdio") return undefined;
  const headers = (cfg as any).headers as Record<string, string> | undefined;
  if (headers?.Authorization) return undefined;
  if ((cfg as any).auth === "none") return undefined;
  return new OhOAuthProvider({ name: cfg.name, storageDir, openFn });
}

/** Delete stored credentials for a server. Safe to call when none exist. */
export async function clearTokens(storageDir: string, name: string): Promise<void> {
  await deleteCredentials(storageDir, name);
}

/** Compute auth state for a server for /mcp display. */
export async function getAuthStatus(cfg: NormalizedConfig, storageDir: string): Promise<AuthStatus> {
  if (cfg.type === "stdio") return "n/a";
  const headers = (cfg as any).headers as Record<string, string> | undefined;
  if (headers?.Authorization) return "n/a";
  const creds = await loadCredentials(storageDir, cfg.name);
  if (!creds?.tokens?.access_token) return "none";
  if (creds.tokens.expires_at && creds.tokens.expires_at <= Date.now()) return "expired";
  return "authenticated";
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/mcp/oauth.test.ts
```
Expected: new tests pass (11 more; file total now 25).

- [ ] **Step 5: Full typecheck + suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean; suite +11 (1033 → 1044).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/oauth.ts src/mcp/oauth.test.ts
git commit -m "feat(mcp): buildAuthProvider, clearTokens, getAuthStatus"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 8: Wire `authProvider` into `buildTransport`

**Files:**
- Modify: `src/mcp/transport.ts`
- Modify: `src/mcp/transport.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/mcp/transport.test.ts`:

```ts
// Top-of-file imports (if not already present):
//   import { buildAuthProvider } from "./oauth.js";

describe("buildTransport with auth provider", () => {
  function cfgHttp(overrides: Partial<NormalizedConfig> = {}): NormalizedConfig {
    return { name: "srv", type: "http", url: "https://x/mcp", ...overrides } as NormalizedConfig;
  }

  it("passes authProvider through to StreamableHTTPClientTransport", async () => {
    const storageDir = "/tmp/oh-test";
    const cfg = cfgHttp();
    const authProvider = buildAuthProvider(cfg, storageDir, async () => {});
    assert.ok(authProvider);
    // Build the transport with the provider; the SDK transport stores it on _authProvider.
    const t = await buildTransport(cfg, { authProvider }) as any;
    assert.ok(t._authProvider === authProvider);
  });

  it("no authProvider option → transport has no _authProvider", async () => {
    const t = await buildTransport(cfgHttp()) as any;
    assert.equal(t._authProvider, undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/mcp/transport.test.ts
```
Expected: FAIL — `buildTransport` doesn't accept a second argument yet.

- [ ] **Step 3: Extend `buildTransport` signature**

In `src/mcp/transport.ts`, modify the `buildTransport` function to accept an optional `{ authProvider }` second arg and pass it through to the HTTP/SSE transports:

```ts
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export type BuildTransportOptions = {
  authProvider?: OAuthClientProvider;
};

export async function buildTransport(
  cfg: NormalizedConfig,
  opts: BuildTransportOptions = {},
): Promise<Transport> {
  if (cfg.type === "stdio") {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    });
  }
  if (cfg.type === "http") {
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      authProvider: opts.authProvider,
    });
  }
  if (cfg.type === "sse") {
    return new SSEClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      authProvider: opts.authProvider,
    });
  }
  throw new Error(`unknown transport type: ${(cfg as any).type}`);
}
```

Also update callers within `transport.ts` — `buildClient` currently calls `buildTransport(cfg)` with no options. For the OAuth integration to work end-to-end we need `buildClient` to optionally accept a provider. Update `buildClient`:

```ts
export type BuildClientOptions = {
  authProvider?: OAuthClientProvider;
};

export async function buildClient(cfg: NormalizedConfig, opts: BuildClientOptions = {}): Promise<Client> {
  const transport = await buildTransport(cfg, opts);
  // ...rest unchanged
}
```

And `connectWithFallback` takes a `doConnect` callback; that callback (in `client.ts`) becomes responsible for threading the auth provider through. We'll fix the `client.ts` call-site in Task 9.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/mcp/transport.test.ts
```
Expected: all transport tests pass (14 pre-existing + 2 new = 16).

- [ ] **Step 5: Full typecheck + suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean. Since `client.ts` still calls `buildClient` without a provider, nothing regresses. Suite +2 (1044 → 1046).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/transport.ts src/mcp/transport.test.ts
git commit -m "feat(mcp): thread authProvider through buildTransport and buildClient"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 9: Wire OAuth into `McpClient.connect`

**Files:**
- Modify: `src/mcp/client.ts`

- [ ] **Step 1: Extend `McpClient.connect`**

At the top of `src/mcp/client.ts`, add imports:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import open from "open";
import { buildAuthProvider, type OhOAuthProvider } from "./oauth.js";
```

And a helper at module scope:

```ts
function credentialsDir(): string {
  return join(homedir(), ".oh", "credentials", "mcp");
}
```

Modify `McpClient.connect` to construct the auth provider and pass it through:

```ts
  static async connect(
    cfg: McpServerConfig,
    timeoutMs: number = cfg.timeout ?? DEFAULT_TIMEOUT_MS,
  ): Promise<McpClient> {
    const normalized = normalizeMcpConfig(cfg, process.env);
    if (normalized.kind === "error") {
      throw new Error(normalized.message);
    }
    const authProvider = buildAuthProvider(normalized.cfg, credentialsDir(), async (url) => {
      await open(url);
    });
    if (authProvider) await authProvider.ready();
    try {
      const sdk = await connectWithFallback(normalized.cfg, (c) => buildClient(c, { authProvider }));
      return new McpClient(cfg.name, cfg, sdk, timeoutMs);
    } finally {
      authProvider?.close();
    }
  }
```

Also update `defaultReconnect` to mirror the same pattern:

```ts
  private async defaultReconnect(): Promise<SdkClient> {
    const normalized = normalizeMcpConfig(this.cfg, process.env);
    if (normalized.kind === "error") throw new Error(normalized.message);
    const authProvider = buildAuthProvider(normalized.cfg, credentialsDir(), async (url) => {
      await open(url);
    });
    if (authProvider) await authProvider.ready();
    try {
      return await connectWithFallback(normalized.cfg, (c) => buildClient(c, { authProvider }));
    } finally {
      authProvider?.close();
    }
  }
```

- [ ] **Step 2: Full typecheck + suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean. Full suite stays at 1046 — no new tests, but existing tests (particularly `client.test.ts`) should continue passing because `buildAuthProvider` returns undefined in tests that don't pass http/sse configs.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/client.ts
git commit -m "feat(mcp): wire OAuth into McpClient.connect"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 10: `/mcp-login` and `/mcp-logout` commands

**Files:**
- Create: `src/commands/mcp-auth.ts`
- Create: `src/commands/mcp-auth.test.ts`
- Modify: `src/commands/info.ts` (register the two commands)

- [ ] **Step 1: Write failing tests**

Create `src/commands/mcp-auth.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { saveCredentials } from "../mcp/oauth-storage.js";
import { mcpLogoutHandler } from "./mcp-auth.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-cmd-mcpauth-"));
}

describe("/mcp-logout", () => {
  it("wipes credentials and reports success", async () => {
    const dir = freshDir();
    try {
      await saveCredentials(dir, "linear", {
        issuerUrl: "x",
        clientInformation: { client_id: "c" },
        tokens: { access_token: "at" },
        updatedAt: new Date().toISOString(),
      });
      const res = await mcpLogoutHandler("linear", { storageDir: dir });
      assert.equal(res.handled, true);
      assert.match(res.output, /wiped/i);
      assert.match(res.output, /linear/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no-op when no credentials exist (still handled)", async () => {
    const dir = freshDir();
    try {
      const res = await mcpLogoutHandler("nope", { storageDir: dir });
      assert.equal(res.handled, true);
      assert.match(res.output, /no credentials/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects empty/missing server name", async () => {
    const res = await mcpLogoutHandler("", { storageDir: "/tmp" });
    assert.equal(res.handled, true);
    assert.match(res.output, /usage:|please specify/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/commands/mcp-auth.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/commands/mcp-auth.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readOhConfig } from "../harness/config.js";
import { normalizeMcpConfig } from "../mcp/config-normalize.js";
import { McpClient } from "../mcp/client.js";
import { clearTokens } from "../mcp/oauth.js";
import { loadCredentials } from "../mcp/oauth-storage.js";

export type CommandResult = { output: string; handled: true };

function defaultStorageDir(): string {
  return join(homedir(), ".oh", "credentials", "mcp");
}

export async function mcpLogoutHandler(
  name: string,
  opts: { storageDir?: string } = {},
): Promise<CommandResult> {
  const storageDir = opts.storageDir ?? defaultStorageDir();
  const trimmed = name.trim();
  if (!trimmed) {
    return { output: "Usage: /mcp-logout <server-name>", handled: true };
  }
  const existing = await loadCredentials(storageDir, trimmed);
  if (!existing) {
    return { output: `No credentials stored for '${trimmed}'.`, handled: true };
  }
  await clearTokens(storageDir, trimmed);
  return {
    output: `Local token for '${trimmed}' wiped. Server-side session may remain valid until expiry.`,
    handled: true,
  };
}

export async function mcpLoginHandler(
  name: string,
  opts: { storageDir?: string } = {},
): Promise<CommandResult> {
  const storageDir = opts.storageDir ?? defaultStorageDir();
  const trimmed = name.trim();
  if (!trimmed) {
    return { output: "Usage: /mcp-login <server-name>", handled: true };
  }
  const cfg = readOhConfig();
  const servers = cfg?.mcpServers ?? [];
  const entry = servers.find((s) => s.name === trimmed);
  if (!entry) {
    return { output: `No MCP server named '${trimmed}' in .oh/config.yaml.`, handled: true };
  }
  const normalized = normalizeMcpConfig(entry, process.env);
  if (normalized.kind === "error") {
    return { output: `Invalid config for '${trimmed}': ${normalized.message}`, handled: true };
  }
  if (normalized.cfg.type === "stdio") {
    return { output: `Server '${trimmed}' is stdio; OAuth is not applicable.`, handled: true };
  }
  // Wipe existing tokens to force a fresh flow.
  await clearTokens(storageDir, trimmed);
  try {
    const client = await McpClient.connect(entry);
    client.disconnect();
    return { output: `✓ Authenticated to '${trimmed}'.`, handled: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `❌ Authentication failed for '${trimmed}': ${msg}`, handled: true };
  }
}
```

- [ ] **Step 4: Register in `src/commands/info.ts`**

Add imports near the existing imports in `src/commands/info.ts`:

```ts
import { mcpLoginHandler, mcpLogoutHandler } from "./mcp-auth.js";
```

Add registrations next to the existing `register("mcp", ...)` block:

```ts
  register("mcp-login", "Authenticate to a remote MCP server via OAuth", async (args) => {
    return mcpLoginHandler(args);
  });

  register("mcp-logout", "Wipe local OAuth tokens for an MCP server", async (args) => {
    return mcpLogoutHandler(args);
  });
```

**NOTE:** If `register()` requires a sync handler signature (check the type in `src/commands/types.ts`), you may need an `await`-inside-handler pattern or adjust the `CommandHandler` type. If `CommandHandler` is sync only, dispatch the async work without awaiting (fire-and-forget) and print an "authenticating..." placeholder, OR adjust `CommandHandler` to allow returning `Promise<CommandResult>`. Check current shape first:

```bash
grep -n "CommandHandler\|CommandResult" src/commands/types.ts
```

If it's sync-only, extend it to allow `CommandResult | Promise<CommandResult>` — that's a one-line change to the type alias.

- [ ] **Step 5: Run tests**

```bash
npx tsx --test src/commands/mcp-auth.test.ts
```
Expected: 3 tests pass.

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean; suite +3 (1046 → 1049).

- [ ] **Step 6: Commit**

```bash
git add src/commands/mcp-auth.ts src/commands/mcp-auth.test.ts src/commands/info.ts
# If you had to change CommandHandler type:
# git add src/commands/types.ts
git commit -m "feat(commands): /mcp-login and /mcp-logout for OAuth"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 11: Extend `/mcp` with auth state

**Files:**
- Modify: `src/commands/info.ts`

- [ ] **Step 1: Update the `/mcp` handler**

In `src/commands/info.ts`, find the existing `register("mcp", ...)` handler (around line 413). Replace it with:

```ts
  register("mcp", "Show MCP server status", async () => {
    const connected = connectedMcpServers();
    if (connected.length === 0) {
      return {
        output:
          "No MCP servers connected.\nConfigure in .oh/config.yaml under mcpServers.\nRun /mcp-registry to browse available servers.",
        handled: true,
      };
    }
    const cfg = readOhConfig();
    const servers = cfg?.mcpServers ?? [];
    const storageDir = join(homedir(), ".oh", "credentials", "mcp");

    const lines = [`MCP Servers (${connected.length} connected):`, ""];
    for (const name of connected) {
      const entry = servers.find((s) => s.name === name);
      if (!entry) {
        lines.push(`  ${name.padEnd(20)}  unknown  —`);
        continue;
      }
      const normalized = normalizeMcpConfig(entry, process.env);
      if (normalized.kind === "error") {
        lines.push(`  ${name.padEnd(20)}  error    ${normalized.message}`);
        continue;
      }
      const kind = normalized.cfg.type;
      const status = await getAuthStatus(normalized.cfg, storageDir);
      let statusText: string;
      switch (status) {
        case "n/a":
          statusText = "—";
          break;
        case "none":
          statusText = "not authenticated";
          break;
        case "authenticated":
          statusText = "authenticated";
          break;
        case "expired":
          statusText = "expired (re-authenticate with /mcp-login)";
          break;
      }
      lines.push(`  ${name.padEnd(20)}  ${kind.padEnd(6)}  ${statusText}`);
    }
    lines.push("");
    lines.push("Run /mcp-registry to browse and add more servers.");
    return { output: lines.join("\n"), handled: true };
  });
```

Add the missing imports at the top of `src/commands/info.ts` (if not already present):

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readOhConfig } from "../harness/config.js";
import { normalizeMcpConfig } from "../mcp/config-normalize.js";
import { getAuthStatus } from "../mcp/oauth.js";
```

- [ ] **Step 2: Run the full suite**

```bash
npx tsc --noEmit
npm test
```
Expected: tsc clean; full suite unchanged (1049 — no new tests here, handler is covered indirectly).

- [ ] **Step 3: Manual smoke test (optional)**

```bash
npm run dev
# In REPL: type `/mcp`
```
Expected: shows each connected server with type + auth state column.

- [ ] **Step 4: Commit**

```bash
git add src/commands/info.ts
git commit -m "feat(commands): extend /mcp with per-server auth state"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 12: Integration test (opt-in)

**Files:**
- Modify: `tests/integration/mcp-remote.test.ts`

- [ ] **Step 1: Add a second `it()` block**

Append (inside the existing `describe` block, after the current `it(...)`):

```ts
  it("completes OAuth flow end-to-end (DCR + PKCE + token exchange)", async () => {
    const { createServer } = await import("node:http");
    const { AddressInfo } = await import("node:net");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const storageDir = mkdtempSync(join(tmpdir(), "oh-oauth-itest-"));

    // Minimal OAuth-capable server: /authorize, /token, /register, well-known metadata.
    const ISSUED_TOKEN = "access-token-12345";
    let issuedCode: string | null = null;

    const oauthServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const base = `http://${req.headers.host}`;
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (url.pathname === "/register" && req.method === "POST") {
        res.end(JSON.stringify({ client_id: "dyn-client", redirect_uris: (await readBody(req)).redirect_uris }));
        return;
      }
      if (url.pathname === "/authorize") {
        // Simulate user approval: immediately redirect with a fake code.
        issuedCode = "auth-code-xyz";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        res.statusCode = 302;
        res.setHeader("location", `${redirectUri}?code=${issuedCode}&state=${state}`);
        res.end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const body = await readBody(req);
        if (body.grant_type === "authorization_code" && body.code === issuedCode) {
          res.end(
            JSON.stringify({
              access_token: ISSUED_TOKEN,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "rt-9999",
            }),
          );
          return;
        }
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => oauthServer.listen(0, "127.0.0.1", r));
    const oauthPort = (oauthServer.address() as any).port;

    // Existing Streamable HTTP MCP server, but guarded by bearer-token check.
    let mcpRequestCount = 0;
    // ... build it just like the first test's `http` server, but check Authorization header;
    // on missing/wrong token, return 401 with WWW-Authenticate: Bearer resource_metadata=...;
    // On correct token, proceed with the normal handshake.
    //
    // Specifically:
    // - On first POST without Authorization, return 401 with WWW-Authenticate header pointing
    //   at http://127.0.0.1:<oauthPort>/.well-known/oauth-protected-resource (or
    //   oauth-authorization-server — both are acceptable for auto-discovery).
    // - On POST with Authorization: Bearer <ISSUED_TOKEN>, continue normally.

    // (Full mcp-server boilerplate omitted here for brevity; reuse the factory used in the first test.)

    // Patch `open` so we don't actually launch a browser: hit the /authorize URL directly.
    const realOpen = (await import("open")).default;
    const capturedAuthUrls: string[] = [];
    (await import("open")).default = (async (u: string) => {
      capturedAuthUrls.push(u);
      // Simulate browser flow: GET the authorize URL, follow the redirect.
      const response = await fetch(u, { redirect: "manual" });
      const location = response.headers.get("location");
      if (location) await fetch(location);
    }) as any;

    try {
      const client = await McpClient.connect({
        name: "oauth-itest",
        type: "http",
        url: `http://127.0.0.1:${mcpPort}/mcp`,
        auth: "oauth",
      } as any);

      const tools = await client.listTools();
      assert.equal(tools.length, 1);

      // Verify credentials persisted
      const creds = await loadCredentials(storageDir, "oauth-itest");
      assert.equal(creds?.tokens.access_token, ISSUED_TOKEN);

      client.disconnect();
    } finally {
      (await import("open")).default = realOpen;
      oauthServer.close();
      mcpServer.close();
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
```

`readBody` helper (add near the top of the file):

```ts
async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/json")) return JSON.parse(raw);
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return {};
}
```

**NOTE:** This test is intentionally sketch-level — the MCP server side is the most fiddly part and reuses the factory from the existing first test. When implementing, factor out the MCP server construction into a helper shared between both tests. Also: patching `open`'s default export at runtime requires the ESM mutable-namespace-via-proxy trick; an alternative is to expose an `openFn` override on `McpClient.connect` for testing purposes. Prefer that seam if the module-patching approach proves fragile.

Suggested cleaner approach: add an optional `connectOptions.openFn` seam to `McpClient.connect`. This is a small refactor. If you take that path, update Task 9 accordingly.

- [ ] **Step 2: Run the integration test**

```bash
OH_INTEGRATION=1 npx tsx --test tests/integration/mcp-remote.test.ts
```
Expected: 2 tests pass (the pre-existing HTTP smoke test plus the new OAuth flow).

- [ ] **Step 3: Run default suite**

```bash
npm test
```
Expected: 1049/1049, integration test skipped.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/mcp-remote.test.ts
# If you added an openFn seam on McpClient.connect, also include src/mcp/client.ts:
# git add src/mcp/client.ts
git commit -m "test(mcp): opt-in OAuth end-to-end integration test"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 13: User-facing docs

**Files:**
- Modify: `docs/mcp-servers.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `docs/mcp-servers.md`**

Add a new section after the existing "Authentication" section (which currently documents the OAuth-not-supported error). Replace that section entirely with:

```markdown
## Authentication

OpenHarness supports two auth modes for HTTP and SSE transports:

### Static bearer token

Set `headers.Authorization` in the config. OAuth is not attempted.

```yaml
mcpServers:
  - name: linear
    type: http
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: "Bearer ${LINEAR_API_KEY}"
```

### OAuth 2.1 (auto)

If no `headers.Authorization` is set, OpenHarness attempts OAuth automatically when the server returns `401 + WWW-Authenticate`. The flow uses Authorization Code + PKCE with Dynamic Client Registration (RFC 7591):

```yaml
mcpServers:
  - name: linear
    type: http
    url: https://mcp.linear.app/mcp
```

On first connect, OH:
1. Discovers the OAuth server metadata.
2. Dynamically registers as a client (if the server supports DCR).
3. Binds a local callback listener on `127.0.0.1:<ephemeral-port>`.
4. Opens your system browser to the authorization URL.
5. On approval, exchanges the code for tokens and stores them at `~/.oh/credentials/mcp/<name>.json` (mode `0600`).

On subsequent connects, OH uses stored tokens and refreshes them automatically.

### Forcing OAuth before a 401

Set `auth: "oauth"` to run the flow on first connect without waiting for a 401:

```yaml
mcpServers:
  - name: linear
    type: http
    url: https://mcp.linear.app/mcp
    auth: oauth
```

### Disabling OAuth

Set `auth: "none"` to suppress the OAuth auto-flow. A 401 response will surface as an error instead.

## Slash commands

- `/mcp` — show connected servers with per-server transport + auth state.
- `/mcp-login <name>` — force a fresh OAuth flow (useful after token revocation or to switch accounts).
- `/mcp-logout <name>` — wipe local tokens for the given server. Server-side session is not revoked.

## Token storage

Tokens and dynamically registered client info live at `~/.oh/credentials/mcp/<server-name>.json` with file mode `0600` and directory mode `0700` on Linux/macOS (mode checks do not apply on Windows). Corrupt files are treated as "no tokens" without crashing.

OS keychain storage is not supported in this release and is tracked as a future enhancement.
```

- [ ] **Step 2: Update `README.md`**

Locate the remote MCP subsection added in v2.11.0. Add a one-liner below:

```markdown
See [docs/mcp-servers.md](docs/mcp-servers.md#authentication) for OAuth 2.1 setup (auto-triggered on 401; `/mcp-login` and `/mcp-logout` commands available).
```

- [ ] **Step 3: Update `CHANGELOG.md`**

Add a new `## Unreleased` section at the top:

```markdown
## Unreleased

### Added
- OAuth 2.1 for remote MCP servers: Authorization Code + PKCE with Dynamic Client Registration, auto-triggered on `401 + WWW-Authenticate`. Filesystem-backed token storage at `~/.oh/credentials/mcp/` with `0600` permissions. New slash commands: `/mcp-login <name>`, `/mcp-logout <name>`; `/mcp` extended with per-server auth-state column.
- Config: new optional `auth: "oauth" | "none"` field on `type: http` and `type: sse` server entries. Default is auto — OAuth when needed, static-bearer when `headers.Authorization` is set.

### Changed
- `McpClient.connect` now wires an `OAuthClientProvider` into the SDK transport when a server is OAuth-eligible. Existing static-bearer and stdio configs unchanged.
```

- [ ] **Step 4: Commit**

```bash
git add docs/mcp-servers.md README.md CHANGELOG.md
git commit -m "docs: OAuth 2.1 reference and changelog"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 14: Release prep (local only; no push, no publish)

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Pre-flight verification**

```bash
npx tsc --noEmit
npm run lint
npm test
OH_INTEGRATION=1 npx tsx --test tests/integration/mcp-remote.test.ts
```

All four must succeed. If any fails, STOP and report BLOCKED — do not bump the version.

- [ ] **Step 2: Bump version**

Edit `package.json`:
```diff
-  "version": "2.11.0",
+  "version": "2.12.0",
```

- [ ] **Step 3: Finalize changelog**

In `CHANGELOG.md`, replace the `## Unreleased` header with:

```markdown
## 2.12.0 (2026-04-XX) — OAuth 2.1 for Remote MCP
```

(Use the actual commit date for the placeholder.)

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release v2.12.0 — OAuth 2.1 for remote MCP"
```

Commit footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

- [ ] **Step 5: DO NOT push, tag, or publish**

Do NOT run `git push`, `git tag`, or `npm publish`. The user (or the `.github/workflows/publish.yml` automation triggered by a tag push) handles rollout.

---

## Self-Review

### Spec coverage

| Spec section | Implementing task(s) |
|---|---|
| § 1 Dependency & module boundary (`open` dep, `oauth.ts`, transport wiring) | 1, 6, 7, 8 |
| § 2 Config schema (`auth` field) | 2 |
| § 3 Storage layout (atomic writes, 0600 perms, corrupt-file handling) | 3 |
| § 4 OAuth flow (listener, DCR, PKCE, browser, token exchange, refresh) | 4, 5, 6, 7, 8, 9 |
| § 5 Slash commands (`/mcp-login`, `/mcp-logout`, extended `/mcp`) | 10, 11 |
| § 6 Error taxonomy (OAuthFlowError via callback rejection, reuse v2.11.0 typed errors) | 4, 9 |
| § 7 REPL diagnostics (progress strings) | 9 (via `open`), 10 (command output) |
| Testing — unit tests | 3, 4, 5, 6, 7, 8, 10 |
| Testing — integration test | 12 |
| Security (file-mode enforcement, redaction, callback hardening) | 3, 4, 5 |
| Migration (zero) | 2 (back-compat preserved by optional field) |
| Release prep | 14 |
| Docs | 13 |

All spec requirements covered by a task.

### Placeholder scan

- Task 2 Step 3 explicitly flags a conditional branch ("tests likely PASS without any change") with a fallback Step 4 — acceptable because both branches produce working code.
- Task 4 Step 3 includes two candidate implementations (sync-and-buggy, then an async replacement). The instruction is clear: "Use this async version." Not a placeholder — it's a documented decision-with-alternative.
- Task 10 Step 4 flags a conditional around `CommandHandler` type: "If it's sync-only, extend it to allow `CommandResult | Promise<CommandResult>` — that's a one-line change to the type alias." Acceptable — precisely-scoped fallback.
- Task 12 Step 1 explicitly notes the MCP server reuse is sketched ("Full mcp-server boilerplate omitted here for brevity; reuse the factory used in the first test"). This is a plan instruction (share a factory) with a clean alternative path (add `openFn` seam to McpClient.connect). Both paths are fully specified.

No "TBD" / "TODO" / "handle edge cases" / "implement later" anywhere.

### Type consistency

- `OhCredentials` shape used identically across Tasks 3, 6, 7, 10 tests.
- `OhOAuthProvider` constructor signature `{name, storageDir, openFn}` stable across Tasks 6, 7, 9.
- `buildAuthProvider(cfg, storageDir, openFn)` signature stable across Tasks 7, 8, 9.
- `getAuthStatus(cfg, storageDir): Promise<AuthStatus>` stable across Tasks 7, 11.
- `clearTokens(storageDir, name): Promise<void>` stable across Tasks 7, 10.
- `BuildTransportOptions` / `BuildClientOptions` types shared between Tasks 8 and 9.
- SDK types (`OAuthClientProvider`, `OAuthClientInformationMixed`, `OAuthTokens`) imported consistently from the same SDK paths.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-remote-mcp-oauth.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
