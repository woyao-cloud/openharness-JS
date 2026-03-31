# `@openharness/cli`

This package is the TypeScript/Node.js CLI frontend for OpenHarness.

Current status:
- working bridge-backed CLI for core commands
- built on top of the Python harness runtime over stdio
- single-turn chat support today, with room to grow into a richer UX

The intended architecture is:
- TypeScript for CLI UX
- Python for the harness runtime

See [../../docs/2026-04-01-typescript-cli-plan.md](../../docs/2026-04-01-typescript-cli-plan.md) for the rollout plan.
