#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
pip install -e ./repo --quiet --no-deps
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet
cd repo
# Archive-sourced fixtures have no .git dir; initialise one so the orchestrator
# can create the "evals base" commit against which patches are applied.
git init -q
git -c user.email=evals@oh -c user.name=evals add -A
git -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
