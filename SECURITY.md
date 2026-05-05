# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | ✅        |
| 1.x     | ⚠️ Security fixes only |
| < 1.0   | ❌        |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities via public GitHub issues.

Instead, open a [GitHub Security Advisory](https://github.com/zhijiewong/openharness/security/advisories/new) or contact the maintainer directly via the profile on GitHub.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You can expect a response within 48 hours. If confirmed, a patch will be prioritized and released as soon as possible.

## Sandboxing — current state

**Default: tool execution is not sandboxed.** Built-in tools (`Bash`, `PowerShell`, `FileEdit`, `FileWrite`, `MultiEdit`, `WebFetch`, etc.) and MCP-provided tools run with the full privileges of the user running `oh` / `openharness` unless you opt in to the integration below. The permission system (`ask`/`trust`/`deny`/`acceptEdits`/`plan`/`auto`/`bypassPermissions`) is the default gate; it relies on user approval prompts and configured hooks — not OS-level isolation.

### Opt-in OS-level sandbox via `@anthropic-ai/sandbox-runtime`

Since v2.33.0 openHarness ships an opt-in integration with [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (the same package that backs Claude Code's sandbox layer). Currently wires `BashTool` only; other risky tools (`PowerShell`, `FileEdit`, `FileWrite`, `MultiEdit`, `WebFetch`) remain unsandboxed in the v2.33 surface.

Enable in `.oh/config.yaml`:

```yaml
sandbox:
  enabled: true
  network:
    allowedDomains: ["github.com", "registry.npmjs.org"]
  filesystem:
    allowWrite: ["."]            # cwd by default
    denyWrite: [".env", ".oh/sessions"]
    denyRead: ["~/.ssh"]
```

Platform support is set by the underlying package:

- **Linux**: bubblewrap (must be installed separately; e.g. `apt install bubblewrap`).
- **macOS**: `sandbox-exec` (Seatbelt — built into the OS).
- **Windows**: not supported by the package; `sandbox.enabled: true` is a silent no-op there. Use a devcontainer / WSL2 instead.

When sandboxing is enabled and unavailable (no bubblewrap, init failure, optional dep absent), the wrapper returns silently and the tool falls back to its unsandboxed path — so opting in promises "use the sandbox if it's reachable," not "fail closed." A future revision will add a `requireSandbox: true` mode that fails the tool call instead of falling back.

### Stronger isolation

For untrusted prompts or model output you don't fully trust, run openHarness inside an isolated environment regardless of the in-tool sandbox:

- **Devcontainer / Docker:** mount only the project directory, run as a non-root user, drop network when not needed. The lowest-effort hardening that's actually enforced by the OS.
- **VM / dedicated workspace:** strongest isolation; recommended when reviewing third-party prompts, running unattended agents, or operating with broad permission modes (`trust`, `bypassPermissions`).
- **OS-level sandbox runtimes (alternatives):** Codex's [linux-sandbox](https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox) (Landlock + seccomp), bubblewrap directly, `sandbox-exec` directly.

A lightweight userland allowlist module (`src/harness/sandbox.ts`) shipped through v2.30.1 but was never wired into any tool, so configured rules had no runtime effect. It was removed in v2.31.0 to avoid implying a guarantee that wasn't enforced. See [Trail of Bits — Prompt injection to RCE in AI agents (Oct 2025)](https://blog.trailofbits.com/2025/10/22/prompt-injection-to-rce-in-ai-agents/) for why a userland allowlist alone isn't a meaningful boundary against model-controlled input.

If you operate openHarness in higher-trust modes (`trust`, `bypassPermissions`, headless / CI), assume any prompt with attacker-controlled content can execute arbitrary tool calls and plan accordingly — even with `sandbox.enabled: true`, only `BashTool` is currently gated through the OS sandbox.
