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

**openHarness does not sandbox tool execution today.** Built-in tools (`Bash`, `PowerShell`, `FileEdit`, `FileWrite`, `MultiEdit`, `WebFetch`, etc.) and MCP-provided tools run with the full privileges of the user running `oh` / `openharness`. There is no filesystem allowlist enforcement, no network egress filter, and no command allowlist enforced at the tool boundary. The permission system (`ask`/`trust`/`deny`/`acceptEdits`/`plan`/`auto`/`bypassPermissions`) is the only built-in gate, and it relies on user approval prompts and configured hooks — not OS-level isolation.

For untrusted prompts or model output you don't fully trust, run openHarness inside an isolated environment:

- **Devcontainer / Docker:** mount only the project directory, run as a non-root user, drop network when not needed. The lowest-effort hardening that's actually enforced by the OS.
- **VM / dedicated workspace:** strongest isolation; recommended when reviewing third-party prompts, running unattended agents, or operating with broad permission modes (`trust`, `bypassPermissions`).
- **OS-level sandbox runtimes:** [`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (used by Claude Code), bubblewrap on Linux, `sandbox-exec` (Seatbelt) on macOS, Landlock + seccomp via Codex's [linux-sandbox](https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox). Wiring one of these into openHarness is tracked work — see the issue tracker.

A lightweight userland allowlist module (`src/harness/sandbox.ts`) shipped through v2.30.1 but was never wired into any tool, so configured rules had no runtime effect. It was removed in v2.30.2 to avoid implying a guarantee that wasn't enforced. See [Trail of Bits — Prompt injection to RCE in AI agents (Oct 2025)](https://blog.trailofbits.com/2025/10/22/prompt-injection-to-rce-in-ai-agents/) for why a userland allowlist alone isn't a meaningful boundary against model-controlled input.

If you operate openHarness in higher-trust modes (`trust`, `bypassPermissions`, headless / CI), assume any prompt with attacker-controlled content can execute arbitrary tool calls and plan accordingly.
