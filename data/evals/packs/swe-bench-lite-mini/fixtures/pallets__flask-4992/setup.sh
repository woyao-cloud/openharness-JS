#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
source .venv/bin/activate
pip install setuptools wheel --quiet
git -C ./repo init -q
git -C ./repo -c user.email=evals@oh -c user.name=evals add -A
git -C ./repo -c user.email=evals@oh -c user.name=evals commit -q -m "evals base" --allow-empty
git -C ./repo tag v0.0.0
# Flask 2.3 runtime deps. werkzeug<3 because flask 2.3 doesn't support werkzeug 3.x APIs.
pip install --quiet "markupsafe>=2.1,<3" "werkzeug>=2.2.2,<3" "jinja2>=3.1,<4" "itsdangerous>=2.1,<3" "click>=8.1,<9" blinker
pip install -e ./repo --quiet --no-deps --no-build-isolation
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet
