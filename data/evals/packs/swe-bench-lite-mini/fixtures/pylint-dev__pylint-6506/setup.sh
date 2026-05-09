#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
pip install setuptools wheel --quiet
git -C ./repo init -q
git -C ./repo -c user.email=evals@oh -c user.name=evals add -A
git -C ./repo -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
git -C ./repo tag v0.0.0
# Pylint 2.13.x runtime deps. astroid<=2.10 pinned because pylint's setup.cfg
# requires that exact range. `py` is a legacy test-only dep used by some pylint tests.
# astroid 2.12+ for Python 3.12 compat (older astroid 2.10 needs wrapt<1.14
# which uses removed inspect.formatargspec). pylint 2.13's <=2.10 constraint
# is a soft pip warning; runtime usage of astroid.decorators.cachedproperty
# is preserved through 2.x.
pip install --quiet "astroid>=2.12,<3" "isort>=4.2.5,<6" "mccabe>=0.6" "platformdirs>=2.2" "tomlkit>=0.10.1" "dill>=0.2" "toml>=0.10" "wrapt>=1.14" "py" "gitpython"
pip install -e ./repo --quiet --no-deps --no-build-isolation
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet
