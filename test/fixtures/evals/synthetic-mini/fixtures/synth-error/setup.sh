#!/usr/bin/env bash
set -e
git init -q
git -c user.email=t@t -c user.name=t commit --allow-empty -q -m base
