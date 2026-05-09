#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
pip install setuptools wheel setuptools_scm --quiet
git -C ./repo init -q
git -C ./repo -c user.email=evals@oh -c user.name=evals add -A
git -C ./repo -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
git -C ./repo tag v8.0.0
# SETUPTOOLS_SCM_PRETEND_VERSION must be > pyproject's minversion (2.0).
# Pytest's own deps. iniconfig + pluggy + tomli are required at runtime; install
# them from PyPI first so the project's --no-deps install doesn't skip them.
pip install --quiet "iniconfig>=1.1" "pluggy>=1.0" "tomli>=1.1" "exceptiongroup>=1.0; python_version<'3.11'" "hypothesis" "xmlschema" "attrs"
SETUPTOOLS_SCM_PRETEND_VERSION=8.0.0 pip install -e ./repo --quiet --no-deps --no-build-isolation
# Create _version.py stub if setuptools-scm didn't generate it.
python3 -c "
import pathlib
for vpath in ['./repo/src/_pytest/_version.py', './repo/_pytest/_version.py']:
    f = pathlib.Path(vpath)
    if f.parent.exists() and not f.exists():
        f.write_text('version = \"8.0.0\"\nversion_tuple = (8, 0, 0)\n')
" 2>/dev/null || true
