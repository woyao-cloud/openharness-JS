# Remote MCP — OAuth 2.1 — Design Spec

**Date:** 2026-04-18
**Status:** Draft
**Tier:** B+ (follow-up to v2.11.0's Remote MCP HTTP/SSE)
**Target release:** `@zhijiewang/openharness@2.12.0`

## Context

v2.11.0 shipped remote MCP over HTTP/SSE with header-based auth (`Authorization: "Bearer ${ENV}"`). Servers that respond with `401 + WWW-Authenticate` surface today as a typed `RemoteAuthRequiredError` pointing the user at `headers.Authorization` — no OAuth is attempted.

This spec adds real OAuth 2.1 support (Auth Code + PKCE + DCR) so hosted MCP servers work zero-config: drop the URL into `.oh/config.yaml`, and OH walks the user through a browser-based authorization the first time.

## Goals

1. Auto-trigger OAuth 2.1 with PKCE on `401 + WWW-Authenticate` for `type: http` and `type: sse` servers.
2. Dynamic Client Registration (RFC 7591) so no pre-registered client credentials are required.
3. Token persistence across sessions with automatic refresh.
4. Three slash commands — `/mcp-login`, `/mcp-logout`, extended `/mcp` — for explicit flow control and state visibility.
5. Preserve v2.11.0's static-header auth path when `headers.Authorization` is set (no OAuth attempted).

## Non-goals

- **Device Authorization Grant (RFC 8628)** — deferred. Can be added behind a `--device` flag if a headless/SSH customer asks.
- **OS keychain storage** — deferred. Filesystem with `0600` permissions for v1, matching `gh`, `aws-cli`, `gcloud`. Keychain is a Tier-C polish item.
- **Server-side token revocation** — `/mcp-logout` wipes local tokens only. Most providers don't expose portable revocation; document this in the command output.
- **Cross-server token sharing** — each server gets its own credentials file.

## Approach

Adopt the MCP TypeScript SDK's `OAuthClientProvider` interface. The SDK owns protocol discovery, PKCE generation, code exchange, token refresh, and retry-with-fresh-token logic. OH owns:

- Token and client-registration persistence (filesystem).
- PKCE code-verifier persistence (session-scoped, per server).
- Browser launch via `open`.
- Temporary callback HTTP listener on `127.0.0.1` with an ephemeral port.
- Slash commands for explicit login/logout/status.
- Per-server scoping.

Rejected alternatives:

| Option | Why rejected |
|---|---|
| Device code flow only | Most hosted MCP servers don't implement RFC 8628; Claude Code and the MCP spec assume browser + PKCE |
| Explicit opt-in config (`oauth: true` required) | Defeats zero-config UX; inconsistent with how the MCP spec assumes auth negotiation works |
| OS keychain only | Native deps (`keytar`/`keyring-rs`) break on Linux/WSL/CI; filesystem is portable and already-trusted-enough for OH |

## Design

### 1. Dependency & module boundary

- New runtime dep: `open` (cross-platform browser launcher — tiny, zero runtime deps of its own).
- New file: `src/mcp/oauth.ts` — implements `OAuthClientProvider` + exports `buildAuthProvider(cfg, storageDir)` and `getAuthStatus(name)`.
- `src/mcp/transport.ts` grows one wire: when `cfg.type === "http" || cfg.type === "sse"`, no `headers.Authorization` is set, and `cfg.auth !== "none"`, build and attach an auth provider to the transport's `authProvider` option.
- SDK owns discovery, DCR protocol, PKCE generation, token exchange, refresh, and re-auth-on-expiry.

Net code delta: `oauth.ts` ~300 lines; `transport.ts` +~15 lines; `config.ts` +1 optional field.

### 2. Config schema

Add one optional field to http/sse configs:

```ts
export type McpHttpConfig = McpCommonConfig & {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "none"; // default "auto"
};
// McpSseConfig gets the same auth field
```

Effective-auth logic:

| `headers.Authorization` | `auth` | Behavior |
|---|---|---|
| set | (any) | Static bearer — no OAuth attempted |
| absent | `"oauth"` | Force OAuth on first connect (don't wait for a 401) |
| absent | `"none"` | OAuth disabled; 401 surfaces as `RemoteAuthRequiredError` (today's behavior) |
| absent | absent (auto) | Try unauthenticated; on 401+`WWW-Authenticate`, SDK invokes our provider |

Back-compat: every v2.11.0 config loads unchanged.

### 3. Storage layout

Root: `~/.oh/credentials/mcp/` (created with mode `0700` on first write).

Per server: `~/.oh/credentials/mcp/<server-name>.json`, mode `0600`:

```json
{
  "issuerUrl": "https://auth.linear.app",
  "clientInformation": {
    "client_id": "...",
    "client_secret": "..."
  },
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_at": 1745000000000,
    "token_type": "Bearer",
    "scope": "..."
  },
  "codeVerifier": "...",
  "updatedAt": "2026-04-18T11:45:00Z"
}
```

**Atomicity:** write to `<name>.json.tmp` → `fs.rename` to `<name>.json` to avoid half-written files.

**Mode enforcement on read:** `fs.stat`; if on non-Windows `(stat.mode & 0o077) !== 0`, log a one-line warning (`[mcp] credentials file for '<name>' is world/group-readable; run 'chmod 600 <path>'`). Don't fail — warn.

**Missing/corrupt file:** return no tokens / no client info, forcing a fresh flow. Log a one-line diagnostic on JSON parse error.

**`codeVerifier`** lives in the same file only during an in-flight flow — cleared to `undefined` on successful `saveTokens` call.

### 4. OAuth flow end-to-end

**Cold start (no stored tokens):**

1. SDK POSTs the initialize request to the MCP endpoint.
2. Server responds `401` + `WWW-Authenticate: Bearer resource_metadata="https://…"`.
3. SDK discovers authorization-server metadata via RFC 9728 resource-metadata document (or `.well-known/oauth-authorization-server`).
4. If the server exposes `registration_endpoint`, SDK performs Dynamic Client Registration (RFC 7591): POSTs our `clientMetadata`:
   ```json
   {
     "client_name": "openharness",
     "redirect_uris": ["http://127.0.0.1:<port>/oauth/callback"],
     "grant_types": ["authorization_code", "refresh_token"],
     "response_types": ["code"],
     "token_endpoint_auth_method": "none",
     "application_type": "native"
   }
   ```
   SDK calls our `saveClientInformation(info)`.
5. OH's provider binds a `127.0.0.1` HTTP listener on an ephemeral port (`listen(0)`) before the SDK reads `redirectUrl`. Because the SDK's `redirectUrl` getter is synchronous, the listener is bound as part of an async `initFlow()` step that the provider runs lazily on the first method that can be awaited (`clientInformation()` or `saveCodeVerifier()`). The listener handles exactly one GET to `/oauth/callback`, extracts `code` + `state`, renders a small HTML success page, closes. Hard timeout: 5 minutes.
6. SDK generates a PKCE code verifier + challenge. Calls our `saveCodeVerifier(verifier)` and `redirectToAuthorization(url)`.
7. OH opens the system browser to `url` via `open(url)`. Also prints the URL to stderr in case the browser fails to open (SSH, headless, etc.).
8. User authorizes in browser; server redirects to `http://127.0.0.1:<port>/oauth/callback?code=…&state=…`.
9. Listener resolves; SDK validates state; exchanges code at `token_endpoint` using the verifier; calls our `saveTokens(tokens)`.
10. SDK retries the initialize POST with `Authorization: Bearer <access_token>`. Connection succeeds.

**Warm start (stored tokens, access not expired):**
SDK uses the stored token directly. No network traffic beyond the normal MCP handshake.

**Warm start (access expired, refresh valid):**
SDK calls `token_endpoint` with the refresh token, calls `saveTokens` with the new pair, retries.

**Warm start (refresh invalid / revoked server-side):**
SDK falls through to the cold-start flow. User sees the browser launch again.

**User cancels or timeout:**
Listener rejects → SDK surfaces an `UnauthorizedError`. OH wraps as `UnreachableError` (consistent with how other init-time failures surface today).

### 5. Slash commands

All three registered in `src/commands/info.ts` alongside existing `/mcp`.

**`/mcp-login <name>`**
- Validates the server exists in `.oh/config.yaml` and has `type: http` or `type: sse`.
- Deletes any existing tokens via `clearTokens(name)` (a repo-local helper on `oauth.ts` that unlinks the credentials file — the SDK's `OAuthClientProvider.saveTokens` takes a non-optional `OAuthTokens`, so we don't go through it for wipe) and runs the OAuth flow immediately — does NOT wait for 401.
- On success: `✓ Authenticated to '<name>' (expires in <N>m)`.
- On failure: clear message + actionable next step (e.g., "browser did not open — visit <url> manually" if `open()` threw).

**`/mcp-logout <name>`**
- Deletes `~/.oh/credentials/mcp/<name>.json` (if present).
- Output: `Local token for '<name>' wiped. Server-side session may remain valid until expiry.`

**`/mcp` (extended)**
Current output shows connected servers. New output adds a per-server auth-state column:

```
MCP servers:
  filesystem  stdio  —
  linear      http   authenticated (expires 2026-04-19 04:23 UTC)
  sentry      http   expired (will re-authenticate on next use)
  make        http   not authenticated
```

Auth-state resolution via `getAuthStatus(name)` in `oauth.ts`:
- stdio / sse-with-static-header → `"n/a"` (shown as `—`)
- no credentials file → `"none"` (shown as `not authenticated`)
- tokens present, `expires_at > now` → `"authenticated"`
- tokens present, `expires_at <= now`, `refresh_token` present → `"expired"` (shown as "will re-authenticate on next use")
- tokens present, `expires_at <= now`, no refresh_token → `"expired"` (shown as "re-authenticate with /mcp-login")

### 6. Error taxonomy

| Error | When | User-facing message |
|---|---|---|
| `OAuthFlowError` (new, exported from `oauth.ts`) | Callback timeout, user cancelled, state mismatch | `"OAuth flow for '<name>' failed: <reason>"` |
| `RemoteAuthRequiredError` (v2.11.0) | Server returns 401+WWW-Authenticate AND `auth: "none"` OR OAuth-but-no-metadata | Same as today |
| `UnreachableError` / `ProtocolError` (v2.11.0) | Network/protocol failures during OAuth | Today's wrapping |

OAuth flow failures are logged per server and surface via `loader.ts:31-33`'s existing policy — OH continues without that server.

### 7. REPL diagnostics

During an auto-flow (first 401), the REPL shows a three-line progress indicator:

```
[mcp] linear: requires OAuth. Opening browser to https://auth.linear.app/…
[mcp] linear: waiting for authorization (timeout 5:00)
[mcp] linear: ✓ authenticated
```

On failure: `❌ Authentication failed: <reason>`. Server skipped; `loadMcpTools` continues.

## Testing

### Unit tests (hermetic)

- **`oauth-storage.test.ts`** — atomic writes via `.tmp` + rename; `0600`/`0700` mode enforcement on non-Windows; corrupt-file (invalid JSON) returns "no tokens" without throwing; concurrent reads while a write is in flight return either the old or new value, never a partial.
- **`oauth-provider.test.ts`** — each `OAuthClientProvider` method against a temp-dir-backed storage: `tokens()` returns `undefined` on cold start; `saveTokens` then `tokens()` round-trips; same for `clientInformation`/`saveClientInformation`; `codeVerifier()` throws without prior `saveCodeVerifier`; `saveTokens` clears the in-flight code verifier.
- **`oauth-flow.test.ts`** — simulate the callback listener's round-trip: start the listener, fire an HTTP GET to `/oauth/callback?code=X&state=Y`, assert the promise resolves with `{code: "X", state: "Y"}`; timeout path rejects cleanly; non-`127.0.0.1` Host header rejects with 403.
- **`transport.test.ts`** — `buildAuthProvider(cfg)` returns a provider iff `cfg.type !== "stdio"`, no `headers.Authorization`, and `cfg.auth !== "none"`; returns undefined otherwise.
- **Command tests** — `/mcp-login`, `/mcp-logout`, extended `/mcp` rendering. Mock the oauth module; assert command output strings.

### Integration test (opt-in, gated on `OH_INTEGRATION=1`)

Extend `tests/integration/mcp-remote.test.ts` with a second test:
- Spin up a tiny in-process OAuth-capable server: `/authorize`, `/token`, `/register`, `/.well-known/oauth-authorization-server`, plus the existing SDK test-harness MCP server that returns 401 on the first request and accepts `Authorization: Bearer <known-token>` thereafter.
- Connect via OH's `McpClient.connect({type: "http", url, auth: "oauth"})`.
- Assert the browser-launch hook is called (inject a fake `open` implementation); simulate the redirect by hitting the captured callback URL directly.
- Assert the second init POST carries the bearer token.
- Run stored-token round-trip by calling `McpClient.connect` a second time — assert no `/authorize` call is made.

### Existing tests

v2.11.0's unit and integration tests should pass unchanged — OAuth is additive; `buildAuthProvider` returns undefined for today's configs (which don't set `auth:`).

## Security

- **File mode on write:** `writeFile` with `{ mode: 0o600 }`. Directory created with `{ mode: 0o700, recursive: true }`.
- **File mode on read:** `fs.stat`; warn (don't fail) if world/group-readable on non-Windows.
- **Token redaction in logs:** audit `console.warn` / `console.error` call sites in the OAuth path; before emitting any `err.message` that might include token content, regex-strip `(access_token|refresh_token|code)=[^&\s"]+`. Centralize in a `redactToken(msg: string)` helper in `oauth.ts`.
- **Callback listener hardening:**
  - Bind `127.0.0.1`, not `0.0.0.0` or `::`.
  - Validate inbound `Host` header matches `127.0.0.1:<port>`; 403 otherwise.
  - Only handle `GET /oauth/callback`; 404 all other paths.
  - One-shot — close after first valid request regardless of outcome.
  - Hard timeout: 5 minutes; closes listener and rejects.
- **State parameter:** SDK-generated and SDK-validated; our provider only persists the PKCE verifier.
- **Redirect URI registered via DCR:** SDK uses the exact URI we returned from `redirectUrl`. No user-controllable redirect target.
- **Code verifier scope:** one verifier per server, cleared on `saveTokens`. Prevents a stale-verifier attack across concurrent flows.
- **No tokens in stack traces:** set `toString()` on the tokens object to redact, or avoid passing the object to `console.*` directly.

## Migration

Zero. Existing `.oh/config.yaml` entries load unchanged; OAuth is opt-in via either a 401 response from the server (with no static `Authorization`) or explicit `auth: "oauth"`.

## Release

Target `@zhijiewang/openharness@2.12.0`. Minor bump (additive feature, no breaking changes).

## Open questions

1. **PKCE-only vs. confidential client** — if DCR returns a `client_secret`, do we treat it as a confidential client (send secret on token requests) or always PKCE-only? SDK handles either; we should default to `token_endpoint_auth_method: "none"` in our DCR metadata, which requests a public client and skips the secret. Servers that refuse `"none"` can fall through to secret-based; the SDK handles both.
2. **Logout UX — should `/mcp-logout` also prompt for a re-auth?** Default: no, just wipe. User can run `/mcp-login` immediately after if desired.
3. **Concurrency — two sessions auth'ing the same server simultaneously** — storage file rename is atomic per write, but a second flow could overwrite an in-flight verifier. Mitigation: per-server file lock via a `<name>.json.lock` flag written at flow start, released on completion or timeout. Low priority for v1; single-session use case dominates.

## Out of scope (tracked for later)

- Device Authorization Grant (RFC 8628)
- OS-keychain credential storage
- Server-side token revocation on logout
- Multi-account per server (user profiles)
- mTLS-based client authentication
- Web-based OAuth completion (e.g., paste-back-the-code UX for fully headless sessions)
