#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
# Ensure build tools are available before installing any project.
pip install setuptools wheel setuptools_scm --quiet
# Initialise the repo git history BEFORE pip install so setuptools-scm
# can determine the version from the commit/tag.
git -C ./repo init -q
git -C ./repo -c user.email=evals@oh -c user.name=evals add -A
git -C ./repo -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
git -C ./repo tag v0.0.0
# SETUPTOOLS_SCM_PRETEND_VERSION prevents setuptools-scm from failing if git
# describe doesn't return a clean version string.
SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0 pip install -e ./repo --quiet --no-deps --no-build-isolation
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet --no-build-isolation
# Create _version.py stub if setuptools-scm didn't generate it (required by pytest's own import).
python3 -c "
import pathlib
for vpath in ['./repo/src/_pytest/_version.py', './repo/_pytest/_version.py']:
    f = pathlib.Path(vpath)
    if f.parent.exists() and not f.exists():
        f.write_text('version = \"0.0.0\"\nversion_tuple = (0, 0, 0)\n')
" 2>/dev/null || true
