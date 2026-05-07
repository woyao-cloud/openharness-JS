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
# Patch Python 3.10+ incompatibilities in old requests source:
#  1. ssl_match_hostname uses a Python 2-style absolute import (needs relative)
#  2. urllib3/_collections.py and sessions.py use collections.MutableMapping/Mapping
#     which were removed from collections in Python 3.10 (moved to collections.abc).
python3 -c "
import pathlib
# Files that use collections.MutableMapping/Mapping via 'import collections' need
# collections.abc shim (Python 3.10+ removed these from the top-level namespace).
abc_shim = 'import collections.abc; collections.MutableMapping = collections.abc.MutableMapping; collections.Mapping = collections.abc.Mapping\n'
for path in [
    './repo/requests/cookies.py',
    './repo/requests/structures.py',
    './repo/requests/utils.py',
]:
    f = pathlib.Path(path)
    if not f.exists(): continue
    t = f.read_text(encoding='utf-8')
    if 'collections.abc' not in t and ('collections.MutableMapping' in t or 'collections.Mapping' in t):
        t = t.replace('import collections\n', 'import collections\n' + abc_shim, 1)
        f.write_text(t, encoding='utf-8')
# Fix Python 2-style absolute import and MutableMapping in urllib3 internals
patches = {
    './repo/requests/packages/urllib3/packages/ssl_match_hostname/__init__.py': [
        ('from _implementation import', 'from ._implementation import'),
    ],
    './repo/requests/packages/urllib3/_collections.py': [
        ('from collections import MutableMapping', 'from collections.abc import MutableMapping'),
    ],
    './repo/requests/sessions.py': [
        ('from collections import Mapping', 'from collections.abc import Mapping'),
    ],
}
for path, replacements in patches.items():
    f = pathlib.Path(path)
    if not f.exists(): continue
    t = f.read_text(encoding='utf-8')
    for old, new in replacements:
        t = t.replace(old, new)
    f.write_text(t, encoding='utf-8')
" 2>/dev/null || true
# --no-build-isolation uses venv's setuptools directly (avoids Python 3.12 compat
# issues when pip tries to download an isolated build env for old packages).
pip install -e ./repo --quiet --no-deps --no-build-isolation
pip install -r ./repo/.oh-evals-pinned-deps.txt --quiet --no-build-isolation
