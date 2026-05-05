# `oh evals` — Design Spec

**Date:** 2026-05-05
**Status:** Draft (awaiting author review)
**Tier:** 3 (final tier-3 item — headline of the May 2026 roadmap)
**Target release sequence:** v2.40 → v2.43 (5 stacked PRs, ~3–4 weeks)
**Author:** Zhijie Wong

## Context

openHarness has shipped every Tier-1/2/3 audit item as of v2.39.0 except this one. **No other agent CLI ships a self-contained eval harness.** Aider has a leaderboard but the harness lives in a separate repo and is hand-curated; Claude Code, Cursor, Cline, and Devin all rely on third-party benchmarking. Shipping `oh evals` as a first-class CLI command that runs a SWE-bench-Lite-compatible eval against any provider, locally, with hard cost caps, is the headline feature of the roadmap.

Prior art in the repo:
- `scripts/swe-bench.mjs` — heuristic harness (counts as `likely_pass` if agent output contains "```" or "diff"). Not credible. Will be deleted.
- `src/commands/info.ts:860` — `/benchmark` slash command stub that just prepends a system-prompt suffix. Will be removed.

Reusable infrastructure:
- `oh run --bare --json --no-session-persistence --max-budget-usd $X --max-turns N` — already a clean headless entry point with budget enforcement at the subprocess level.
- `src/harness/cost.ts` `CostTracker` — per-model usage + total + budget exceedance check.
- `src/services/AgentDispatcher.ts` — parallel sub-agents with worktree isolation. **Not used directly** (orchestrator owns its own subprocess pool for clean process boundaries), but pattern matched.
- `src/git/index.ts` `createWorktree` / `removeWorktree` — git worktree primitives.
- `src/harness/traces.ts` `SessionTracer` — OTLP-compatible spans; each subprocess emits its own.

## Goals

1. **Ship `oh evals run [pack]` as a first-class CLI command.** Default pack: `swe-bench-lite-mini` (10–20 cherry-picked SWE-bench Lite instances, pre-baked).
2. **SWE-bench-leaderboard-submittable output by default.** `predictions.json` matches the official SWE-bench harness submission schema verbatim.
3. **Mandatory cost cap.** `--max-cost-usd <total>` is required; per-task cap auto-derived as `total / num_tasks`. Hard refusal to run without a total cap.
4. **Pluggable pack contract.** Runner is generic; future packs (HumanEval, Aider's Exercism subset, full SWE-bench-via-Docker) plug into the same contract without runner changes.
5. **Subprocess isolation per task.** Each task is its own `oh run` Node process — clean isolation, accurate per-task `CostTracker`, kill-on-exceedance via `process.kill`.
6. **Resumability.** `--resume <run-id>` skips already-completed instance_ids in a partial run.

## Non-goals

- **Full SWE-bench Lite (300 tasks) in v1.** v1 ships the cherry-picked mini-pack only. Full SWE-bench via Docker is a v2 add-on pack — same runner contract, different fixture distribution.
- **Self-hosted leaderboard / public results dashboard.** Output is local files. Public leaderboard submission is a one-line curl with the produced `predictions.json` to SWE-bench's submission endpoint.
- **OTLP cross-process trace merging in v1.** Each subprocess emits its own OTLP spans with its own `trace_id`. Merging at the backend (Jaeger/Tempo) is the consumer's responsibility. v1 spec mentions but does not implement orchestrator-issued root span propagation.
- **Lazy fixture download in v1.** Mini-pack fixtures are bundled in `data/evals/packs/`. Lazy-fetch (`oh evals fetch <pack>`) is v2 if pack sizes grow.
- **Replacement of `AgentDispatcher`.** The orchestrator does not subsume parallel-agent execution inside agent runs; it's a peer subsystem at the same layer.

## Approach

Five decision axes, resolved during brainstorming. Each row's "winner" is what the spec implements.

| Axis | Options considered | Chosen |
|---|---|---|
| Task corpus shape | (A) hand-authored mini-bugs / (B) cherry-picked SWE-bench Lite / (C) full SWE-bench via Docker / (D) pluggable runner + bundled v1 pack | **D + (B) as the v1 pack** — pluggable runner, ships with `swe-bench-lite-mini` (10–20 pre-baked SWE-bench Lite instances) |
| Execution model | (A) in-process via `AgentDispatcher` / (B) subprocess `oh run` per task / (C) subprocess + parallel orchestrator | **C** — orchestrator spawns concurrent `oh run` subprocesses; default `--concurrency 1`, cap = `os.cpus().length` |
| Pass/fail criterion | (A) single test command + exit code / (B) `FAIL_TO_PASS` + `PASS_TO_PASS` (SWE-bench eval contract) / (C) per-task oracle script | **B with C as escape hatch** — primary contract is F2P + P2P; if a fixture ships `oracle.{sh,mjs}`, that overrides |
| Output schema | (A) custom JSON / (B) dual output: SWE-bench `predictions.json` + enriched `results.json` / (C) single rich JSON | **B** — `predictions.json` is leaderboard-submittable verbatim; `results.json` is our enriched superset |
| Cost cap mechanics | (A) both per-task and total required / (B) sensible defaults + warn / (C) total required, per-task auto-derived | **C** — `--max-cost-usd <total>` required; per-task = `total / num_tasks` unless explicitly overridden |

## Component design

### Component 1 — Pack contract (`src/evals/types.ts` + `data/evals/packs/`)

A pack is a directory with this layout:

```
data/evals/packs/<pack-name>/
├── pack.json                    # Manifest
├── instances.jsonl              # One task per line
└── fixtures/
    └── <instance_id>/
        ├── repo.tar.zst         # Pre-baked repo snapshot at base_commit
        ├── setup.sh             # Creates venv, installs pinned deps. Exits 0 on success.
        ├── test_command.txt     # Pack-default test command (e.g., "pytest --junit-xml=results.xml")
        └── oracle.sh            # OPTIONAL — overrides F2P/P2P scoring if present
```

`pack.json`:
```json
{
  "name": "swe-bench-lite-mini",
  "version": "1",
  "description": "10 cherry-picked SWE-bench Lite instances, pre-baked for local execution",
  "language": "python",
  "runner_requirements": ["python3>=3.9", "pip", "git"],
  "default_test_command": "pytest --junit-xml=.oh-evals-results.xml",
  "instance_count": 10,
  "compatible_with": "swe-bench-lite-v1"
}
```

`instances.jsonl` (one JSON-line per task, schema mirrors SWE-bench Lite):
```json
{"instance_id":"django__django-12345","repo":"django/django","base_commit":"abc123","problem_statement":"...","FAIL_TO_PASS":["tests.test_x.test_y"],"PASS_TO_PASS":["tests.test_a.test_b"],"hints_text":""}
```

TypeScript types in `src/evals/types.ts`:
```ts
export type EvalsTask = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  hints_text?: string;
};

export type EvalsPack = {
  name: string;
  version: string;
  description: string;
  language: "python" | "javascript" | "typescript" | "polyglot";
  runner_requirements: string[];
  default_test_command: string;
  instance_count: number;
  compatible_with?: string;
};

export type EvalsStatus =
  | "resolved"           // F2P + P2P all pass; counts as pass-rate numerator
  | "failed"             // tests ran, didn't all pass
  | "error"              // crash, fixture extraction fail, non-budget non-zero exit
  | "timeout"            // wall-clock --task-timeout hit
  | "budget_exceeded"    // subprocess hit per-task --max-budget-usd
  | "skipped";           // setup.sh failed, or pre-flight check failed

export type EvalsResult = {
  instance_id: string;
  status: EvalsStatus;
  resolved: boolean;
  cost_usd: number;
  turns_used: number;
  duration_ms: number;
  model_patch: string;       // git diff captured from worktree post-run
  tests_status: {
    FAIL_TO_PASS: { success: string[]; failure: string[] };
    PASS_TO_PASS: { success: string[]; failure: string[] };
  };
  transcript_path: string;   // relative path under run dir
  error_message?: string;
  started_at: string;        // ISO-8601
  finished_at: string;
};

export type RunArtifacts = {
  run_id: string;            // ISO timestamp slug, e.g., "2026-05-05T14-30-00"
  pack: string;
  pack_version: string;
  model: string;
  harness_version: string;   // openHarness version
  started_at: string;
  finished_at: string;
  total_cost_usd: number;
  max_cost_usd: number;      // the cap that was set
  total_duration_ms: number;
  resolved: number;
  failed: number;
  error: number;
  timeout: number;
  budget_exceeded: number;
  skipped: number;
  pass_rate: number;         // resolved / (resolved + failed + error + timeout)
  partial: boolean;          // true if total cap halted run before completion
  results: EvalsResult[];
};
```

### Component 2 — Pack loader (`src/evals/pack-loader.ts`)

Pure-function module. ~120 lines.

```ts
export function loadPack(packName: string): { pack: EvalsPack; tasks: EvalsTask[] };
export function resolveFixturePath(packName: string, instanceId: string): string;
export function listAvailablePacks(): string[];
export function validatePack(packDir: string): { ok: true } | { ok: false; errors: string[] };
```

Validation: `pack.json` parses + has required fields; `instances.jsonl` is line-delimited valid JSON; every `instance_id` has a corresponding `fixtures/<id>/` dir with `repo.tar.zst` and `setup.sh`. Validation errors fail fast with file:line citations.

Pack discovery: bundled packs at `data/evals/packs/`; user packs at `~/.oh/evals/packs/` (lower precedence — user can override bundled by name).

### Component 3 — Run orchestrator (`src/evals/orchestrator.ts`)

Stateful coordinator. ~250 lines.

```ts
export type OrchestratorOptions = {
  pack: EvalsPack;
  tasks: EvalsTask[];
  packDir: string;
  model: string;
  fallbackModel?: string;
  maxCostUsd: number;
  maxTaskCostUsd?: number;     // defaults to maxCostUsd / tasks.length
  maxTaskTurns: number;        // default 50
  taskTimeoutMs: number;       // default 600_000 (10 min)
  concurrency: number;         // default 1
  runDir: string;              // .oh/evals/runs/<run_id>/
  resumeFromRunId?: string;
  onTaskStart?: (task: EvalsTask) => void;
  onTaskComplete?: (result: EvalsResult) => void;
};

export class RunOrchestrator {
  constructor(options: OrchestratorOptions);
  async run(): Promise<RunArtifacts>;
  cancel(): void;
}
```

Internal flow per task:

```
1. Acquire concurrency slot (max N concurrent subprocess agents)
2. Extract fixtures/<id>/repo.tar.zst into <runDir>/worktrees/<id>/
3. Run fixtures/<id>/setup.sh in worktree (capture stdout/stderr to error_message on non-zero)
4. Spawn subprocess via `child_process.spawn` with `cwd: <worktree>` so the child inherits the worktree as its `process.cwd()` (no new flag on `oh run`):
     node dist/main.js run \
       --bare --output-format stream-json \
       --no-session-persistence \
       --max-budget-usd <perTaskCap> \
       --max-turns <maxTaskTurns> \
       --model <model> \
       <task.problem_statement>
   Subprocess inherits OH_TRACE_OTLP_* env vars if set.
5. Tee subprocess stdout to two consumers: (a) live stream-json parser that extracts cost / turns / final assistant message / exit reason, (b) `transcripts/<instance_id>.jsonl` file (the transcript IS the stream-json output, captured verbatim — no new flag needed on `oh run`).
6. Race subprocess vs taskTimeoutMs. On timeout: process.kill('SIGKILL'); status = "timeout".
7. From the parsed stream: exit reason `budget_exceeded` → `status: budget_exceeded`; non-zero non-budget exit → `status: error` with stderr tail in `error_message`.
8. Capture model_patch: `git -C <worktree> diff HEAD` (the agent's accumulated changes since `setup.sh`'s initial commit).
9. Hand off to EvalScorer with worktree, task, pack defaults.
10. Append EvalsResult to RunWriter (atomic per-task).
11. removeWorktree(<worktree>); rm -rf <runDir>/worktrees/<id>/.
12. Aggregate cost: if total >= maxCostUsd, set halt flag; future iterations of the scheduling loop skip new tasks.
```

Cancellation contract: `cancel()` sets a flag, sends SIGTERM to all running subprocesses, waits 5s, then SIGKILL. Worktrees cleaned up.

Resume contract: when `resumeFromRunId` is set, loader reads existing `results.json` from prior run dir, copies completed records to new run, queues only un-attempted instance_ids. Aggregate counters seeded from prior run.

### Component 4 — Scorer (`src/evals/scorer.ts`)

Pure dispatch + subprocess wrapper. ~150 lines.

```ts
export async function scoreTask(args: {
  task: EvalsTask;
  worktreeDir: string;
  fixtureDir: string;
  packDefaultTestCommand: string;
  testTimeoutMs: number;
}): Promise<{
  resolved: boolean;
  tests_status: EvalsResult["tests_status"];
  oracle_used: boolean;
  error_message?: string;
}>;
```

Logic:
1. If `<fixtureDir>/oracle.sh` (or `oracle.mjs`) exists → spawn it with cwd = worktreeDir, env including `INSTANCE_ID`, `WORKTREE_DIR`, `FIXTURE_DIR`. Exit 0 = `resolved: true`. `tests_status` arrays empty. `oracle_used: true`.
2. Else → run `packDefaultTestCommand` in worktreeDir, parse `.oh-evals-results.xml` (junit-xml). Map per-test results to F2P / P2P arrays.
   - `resolved: true` iff every `task.FAIL_TO_PASS` test ID is in success list AND every `task.PASS_TO_PASS` test ID is in success list.
3. On test runner crash (segfault, timeout, missing pytest): return `error_message` populated, `resolved: false`. Orchestrator translates this to status `error`.

junit-xml parsing: minimal XML reader (no full XML library; pytest's junit-xml is well-formed and small per task).

### Component 5 — Run writer (`src/evals/run-writer.ts`)

Atomic streaming output. ~120 lines.

```ts
export class RunWriter {
  constructor(runDir: string, header: Omit<RunArtifacts, "results" | "finished_at" | "total_cost_usd" | "total_duration_ms" | "resolved" | "failed" | "error" | "timeout" | "budget_exceeded" | "skipped" | "pass_rate" | "partial">);
  appendResult(result: EvalsResult): void;        // writes one JSONL line + updates predictions.json
  finalize(opts: { partial: boolean; finished_at: string }): RunArtifacts;
}
```

Writes:
- `<runDir>/results.jsonl` — append-only, one `EvalsResult` per line. Atomic per write (write to `.tmp`, rename).
- `<runDir>/predictions.json` — array, rewritten on each append. Format: `[{instance_id, model_patch, model_name_or_path}]`.
- `<runDir>/transcripts/<instance_id>.jsonl` — orchestrator-side tee of the subprocess's `--output-format stream-json` stdout. The transcript is the verbatim captured stream-json (no new flag on `oh run`); `RunOrchestrator` opens this file for write before spawn and pipes the stdout `Readable` into both the parser and the file `Writable`.
- `<runDir>/results.json` — only written by `finalize()`; merges `results.jsonl` + header + aggregates.

Crash safety: if orchestrator crashes mid-run, `results.jsonl` + `predictions.json` are valid. `oh evals run --resume <run_id>` reads `results.jsonl` to determine completed instance_ids.

### Component 6 — CLI surface (`src/evals/cli.ts` + `src/main.tsx`)

Commander.js wiring. ~180 lines + ~30 in main.tsx.

```
oh evals run [pack]              Run an eval pack (default pack: swe-bench-lite-mini)
  --max-cost-usd <amount>        REQUIRED. Total cost cap for the run.
  --max-task-cost-usd <amount>   Per-task cap (default: max-cost-usd / num_tasks).
  --max-task-turns <n>           Per-task tool-use cap (default: 50).
  --task-timeout <seconds>       Wall-clock per-task kill (default: 600).
  --concurrency <n>              Parallel subprocess agents (default: 1, max: cpu count).
  --model <provider/model>       Model under test (default: same as `oh run`).
  --fallback-model <model>       One-shot fallback (mirrors `oh run`).
  --instance <id>                Run only this instance.
  --sample <n>                   Random N instances.
  --filter <regex>               Run instances matching regex on instance_id.
  --resume <run-id>              Continue a partial run; skip already-completed instances.
  --json                         Emit run summary as JSON to stdout (still writes files).
  --output-dir <path>            Override default .oh/evals/runs/.

oh evals list-packs              List bundled and user-installed packs
oh evals show <run-id>           Print summary table for a past run from .oh/evals/runs/
```

Terminal table renderer: ANSI-colored Unicode-box (matches `/traces` table style at `src/harness/traces.ts`). Symbols: ✓ (resolved), ✗ (failed), ⚠ (error), ⊘ (skipped), ⏱ (timeout), $ (budget_exceeded). Live-updating row per task (Ink-style cursor restore from existing `src/renderer/`).

### Component 7 — Bundled v1 pack (`data/evals/packs/swe-bench-lite-mini/`)

Hand-curated 10 SWE-bench Lite instances, biased toward:
- Smaller repos (Django, sympy, requests — not scikit-learn or matplotlib)
- Fewer pinned-dep conflicts on Linux + Windows
- Test runtimes under 60 seconds

Each fixture's `setup.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
pip install -e . --quiet --no-deps
pip install -r .oh-evals-pinned-deps.txt --quiet
git add -A && git -c user.email=evals@oh -c user.name=evals commit -m "evals base" --quiet
```

Total fixture size budget: ≤ 50 MB compressed (zstd level 19). If exceeded, drop instances or move to lazy-fetch in v2.

Cross-platform: tarballs use POSIX format. On Windows, extraction via `tar` (Win10+ ships it). Symlinks in fixture repos are converted to junction points or rejected at pack-build time.

## Data flow (full run)

```
  ┌────────────────────────────────────────────────────────────────────────┐
  │  oh evals run swe-bench-lite-mini --max-cost-usd 5 --concurrency 2     │
  └─────────────────────────────────┬──────────────────────────────────────┘
                                    │
                                    ▼
              ┌───────────────────────────────────────────┐
              │  PackLoader.loadPack("swe-bench-lite-mini")│
              │  → validates pack.json, instances.jsonl,   │
              │    every fixture dir exists                │
              └─────────────┬─────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────────────────────┐
              │  RunOrchestrator(options).run()            │
              │   ├─ creates .oh/evals/runs/<run_id>/      │
              │   ├─ pre-flight: pack runner_requirements  │
              │   ├─ spawns N concurrent task workers      │
              │   └─ aggregates cost; halts at total cap   │
              └─────────────┬─────────────────────────────┘
                            │
                ┌───────────┴────────────┐
                ▼                        ▼
  ┌───────────────────────┐   ┌───────────────────────┐
  │  Worker[1]            │   │  Worker[N]            │
  │  ├─ extract fixture   │   │  ├─ extract fixture   │
  │  ├─ setup.sh          │   │  ├─ setup.sh          │
  │  ├─ spawn `oh run`    │   │  ├─ spawn `oh run`    │
  │  ├─ git diff → patch  │   │  ├─ git diff → patch  │
  │  ├─ scoreTask(...)    │   │  ├─ scoreTask(...)    │
  │  ├─ runWriter.append  │   │  ├─ runWriter.append  │
  │  └─ removeWorktree    │   │  └─ removeWorktree    │
  └───────────────────────┘   └───────────────────────┘
                            │
                            ▼
              ┌───────────────────────────────────────────┐
              │  RunWriter.finalize()                      │
              │   → writes results.json (merged)           │
              │   → writes predictions.json (final)        │
              │   → terminal: aggregate table + paths      │
              └───────────────────────────────────────────┘
```

## Error handling

| Failure | Detection | Behavior |
|---|---|---|
| Tarball missing/corrupt | `tar -xf` exits non-zero | `status: skipped`, `error_message` set, run continues |
| `setup.sh` fails | exit code != 0 | `status: skipped`, error_message = stderr tail, worktree torn down |
| Python/pytest missing | pre-flight check at run start | exit 2, message: "Pack 'swe-bench-lite-mini' requires python3>=3.9 and pytest. Install Python from https://www.python.org/downloads/ then `python3 -m pip install pytest`." |
| Subprocess hang | `--task-timeout` (default 600s) | `process.kill('SIGKILL')`, `status: timeout`, worktree cleaned up in finally |
| Subprocess OOM / segfault | exit code != 0 and not budget_exceeded | `status: error`, error_message captured |
| Per-task budget exceeded | subprocess exits with reason `budget_exceeded` | `status: budget_exceeded`, NOT counted in pass-rate denominator |
| Total budget exceeded | aggregate >= maxCostUsd after a task completes | scheduler stops queueing; in-flight tasks finish; `partial: true` |
| Orchestrator crash | (process exits abnormally) | `results.jsonl` + `predictions.json` are valid up to last appended task; `oh evals run --resume <run_id>` continues |
| Disk full on RunWriter | EIO from rename | halt with `partial: true`; clear stderr message |
| junit-xml malformed | parse error in scorer | `status: error`, error_message includes parse failure |

All worktree cleanup goes through `try/finally` to prevent leaks. Smoke test asserts no lingering worktrees post-run.

## Testing strategy

**Unit tests** (`src/evals/*.test.ts`):
- `pack-loader.test.ts` — valid pack passes; missing pack.json, malformed jsonl, missing fixture dir each fail with specific error.
- `scorer.test.ts` — F2P all-pass + P2P all-pass = `resolved: true`; one F2P fail = `resolved: false`; oracle.sh exit 0 path; oracle.sh exit non-zero path; junit-xml parse.
- `orchestrator.test.ts` — uses fake-oh-run subprocess (a 50-line `node test/fixtures/evals/fake-oh-run.mjs` that emits scripted stream-json). Tests: concurrency 1 vs 2, total-cap halt, per-task timeout, resume, cancel.
- `run-writer.test.ts` — atomic append, partial-file validity after simulated crash, predictions.json shape matches SWE-bench schema.

**Integration test** (`src/evals/e2e.test.ts`):
- Synthetic pack at `test/fixtures/evals/synthetic-mini/` with 3 tasks (always-pass, always-fail, always-error).
- No real LLM, no Python required (synthetic pack uses `node` for the test command).
- Asserts: status taxonomy, JSON shape, terminal table snapshot, predictions.json submittability check.
- Runs in <2s on CI.

**Real-pack smoke** (CI-gated, `evals-smoke` label required on PR):
- `oh evals run swe-bench-lite-mini --sample 1 --max-cost-usd 2 --model deepseek-chat`.
- Asserts run completes, produces both JSON files, total_cost > 0 and < 2.
- Skipped on non-labeled PRs to control LLM spend.

**Coverage target**: ~95% line coverage on `src/evals/*` (matches existing `src/services/*` coverage).

## Migration / cleanup

1. **Delete `scripts/swe-bench.mjs`.** Remove from any docs that reference it. Old behavior is strictly subsumed.
2. **Replace `/benchmark` slash command** in `src/commands/info.ts:860` with a stub that prints `Use 'oh evals' instead. See https://github.com/zhijiewang/openharness#evals.`
3. **Update `package.json` `files` glob** to include `data/evals/**/*` (mirrors existing `data/skills/**/*.md`).
4. **Add `oh evals` to README + CONTRIBUTING.** Brief usage example + link to spec.
5. **`feedback_small_pr_scope.md` honored:** ship as 5 stacked PRs (PR-A through PR-E), each ≤200 src lines, sequenced via `git rebase --onto` for squash-merge retargeting (matches Python SDK v0.1→v0.3 arc pattern).

## PR sequence

| PR | Scope | Lines (src) | Depends on |
|---|---|---|---|
| PR-A | `src/evals/types.ts`, `pack-loader.ts`, `scorer.ts` + tests | ~350 | none |
| PR-B | `src/evals/orchestrator.ts`, `run-writer.ts` + tests | ~380 | PR-A |
| PR-C | `src/evals/cli.ts`, terminal renderer, `main.tsx` wiring + integration test | ~200 | PR-B |
| PR-D | `data/evals/packs/swe-bench-lite-mini/` + 10 fixtures + pack-build script | ~50 src + binaries | PR-A (pack contract) |
| PR-E | Cleanup: delete `swe-bench.mjs`, replace `/benchmark`, README, CONTRIBUTING | ~30 | PR-C, PR-D |

Each PR ships independently testable. PR-A through PR-C have no user-facing surface. PR-D + PR-E together unlock the headline release (`v2.43.0 — oh evals`).

## Risks & open follow-ups (not blocking spec)

1. **Windows fixture extraction** — tarballs with symlinks may fail without admin. Mitigation: pack-build script rejects symlinks at bake time; document Linux/macOS as recommended for SWE-bench packs.
2. **Pack distribution at scale** — bundling 10 fixtures inflates `npm install` size by ~50 MB. Acceptable for v1. v2 = lazy-fetch via `oh evals fetch <pack>` from GitHub Releases.
3. **OTLP cross-process tracing** — each subprocess emits its own trace_id today. Orchestrator-issued root span propagation via `traceparent` env var is v2 work; mentioned but not implemented.
4. **Public leaderboard submission UX** — v1 docs include the curl command verbatim. v2 could add `oh evals submit <run-id>` if SWE-bench's submission API stabilizes.
5. **Provider coverage** — v1 tested against Anthropic + DeepSeek + OpenAI. Other providers should work via existing `--model provider/name` plumbing but aren't smoke-tested in CI.

## References

- SWE-bench: https://github.com/princeton-nlp/SWE-bench
- SWE-bench evaluation contract: https://github.com/princeton-nlp/SWE-bench/blob/main/swebench/harness/run_evaluation.py
- Aider leaderboard precedent: https://aider.chat/docs/leaderboards/
- openHarness `oh run` headless surface: `src/main.tsx:206`
- openHarness `CostTracker`: `src/harness/cost.ts`
- Existing prior art (to be deleted): `scripts/swe-bench.mjs`
