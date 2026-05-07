#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
# Ensure build tools are available before installing any project.
pip install setuptools wheel --quiet
# Initialise the repo git history BEFORE pip install so setuptools-scm
# can determine the version from the commit/tag.
git -C ./repo init -q
git -C ./repo -c user.email=evals@oh -c user.name=evals add -A
git -C ./repo -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
git -C ./repo tag v0.0.0
# --no-build-isolation uses venv's setuptools directly (avoids Python 3.12 compat
# issues when pip tries to download an isolated build env for old packages).
pip install -e ./repo --quiet --no-deps --no-build-isolation
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet --no-build-isolation
