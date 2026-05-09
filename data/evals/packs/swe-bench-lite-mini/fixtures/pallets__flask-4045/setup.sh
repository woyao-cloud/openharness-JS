#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
pip install setuptools wheel --quiet
git -C ./repo init -q
git -C ./repo -c user.email=evals@oh -c user.name=evals add -A
git -C ./repo -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
git -C ./repo tag v0.0.0
# Flask 2.0.x runtime deps. werkzeug<2.1 is required because flask 2.0 still
# uses EnvironBuilder(as_tuple=...), removed in werkzeug 2.1.
pip install --quiet "markupsafe>=2.0,<2.2" "werkzeug>=2.0,<2.1" "jinja2>=3.0,<3.1" "itsdangerous>=2.0,<2.1" "click>=7.1.2,<9" blinker
pip install -e ./repo --quiet --no-deps --no-build-isolation
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet
