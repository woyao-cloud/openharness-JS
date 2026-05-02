#!/usr/bin/env bash
# headless-code-review.sh — Headless code review via `oh run --json`.
#
# Demonstrates running OH non-interactively from a CI pipeline. Sends a single
# prompt, captures structured JSON output, extracts the assistant's response
# with jq.
#
# Prerequisites:
#   - `oh` on PATH (npm install -g @zhijiewang/openharness)
#   - `jq` for JSON parsing
#   - Ollama running locally (default) OR an API key in env (e.g. OPENAI_API_KEY)
#
# Usage:
#   ./headless-code-review.sh                       # reviews staged git diff
#   ./headless-code-review.sh path/to/file.ts       # reviews a specific file
#   PROVIDER=gpt-4o ./headless-code-review.sh       # use a different model
#
# Exit codes:
#   0 — review completed
#   1 — `oh` failed (model unavailable, prompt rejected, etc.)
#   2 — bad arguments

set -euo pipefail

MODEL="${PROVIDER:-ollama/qwen2.5:7b}"
TARGET="${1:-}"

if [[ -n "$TARGET" && ! -f "$TARGET" ]]; then
  echo "error: file not found: $TARGET" >&2
  exit 2
fi

# Build the prompt
if [[ -n "$TARGET" ]]; then
  PROMPT="Review the code in $TARGET and surface any bugs, security issues, or code-quality problems. Be concrete: file:line for every issue, and a one-line fix suggestion."
else
  PROMPT="Review the staged git diff and surface any bugs, security issues, or code-quality problems. Be concrete: file:line for every issue, and a one-line fix suggestion."
fi

# Run headless. --json emits one JSON object per event to stdout.
# --trust auto-approves all tool calls (we control the prompt; safe for this script).
# We pipe through jq to keep only assistant text events and concatenate them.
oh run "$PROMPT" --model "$MODEL" --json --trust \
  | jq -r 'select(.type == "text_delta") | .content' \
  | tee /tmp/oh-review-$$.txt

echo
echo "Full review saved to /tmp/oh-review-$$.txt"
