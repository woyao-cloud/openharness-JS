#!/usr/bin/env python
"""sdk-python-batch-summarize.py — Batch-summarize multiple files via the Python SDK.

Demonstrates the openharness Python SDK driving `oh` over multiple files in
sequence. Each file gets its own short query() session — a fresh agent loop,
fresh context, no cross-contamination.

Prerequisites:
    pip install openharness-sdk
    npm install -g @zhijiewang/openharness     # provides the `oh` binary
    Ollama running locally (default) OR an API key in env

Usage:
    python sdk-python-batch-summarize.py file1.py file2.py file3.py
    python sdk-python-batch-summarize.py "src/**/*.ts"   # globs supported

Output:
    Per-file: a one-paragraph summary printed to stdout, prefixed with ===.
    Errors are reported but don't stop the batch.
"""
from __future__ import annotations

import asyncio
import glob
import sys
from pathlib import Path

from openharness import TextDelta, ToolEnd, query


async def summarize_one(path: Path, model: str = "ollama/qwen2.5:7b") -> str:
    """Run a single summarize query for one file. Returns the assistant's response."""
    text_chunks: list[str] = []
    async for event in query(
        f"Read {path} and write a one-paragraph summary of what it does. "
        f"No code, just prose. Be concrete about responsibilities and inputs/outputs.",
        model=model,
        permission_mode="trust",   # auto-approve — we control the prompt
        allowed_tools=["Read"],     # restrict to the only tool we need
        max_turns=3,                # cap so a misbehaving model can't loop
    ):
        if isinstance(event, TextDelta):
            text_chunks.append(event.content)
        elif isinstance(event, ToolEnd) and event.error:
            print(f"  [warn] tool {event.tool} reported error", file=sys.stderr)
    return "".join(text_chunks).strip()


async def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)

    # Expand any globs the user passed
    paths: list[Path] = []
    for arg in sys.argv[1:]:
        matched = [Path(p) for p in glob.glob(arg, recursive=True)]
        if not matched:
            print(f"  [warn] no files matched: {arg}", file=sys.stderr)
            continue
        paths.extend(matched)

    if not paths:
        print("error: no files to process", file=sys.stderr)
        sys.exit(1)

    for path in paths:
        if not path.is_file():
            continue
        print(f"=== {path} ===")
        try:
            summary = await summarize_one(path)
            print(summary)
        except Exception as exc:
            print(f"  [error] {exc}", file=sys.stderr)
        print()


if __name__ == "__main__":
    asyncio.run(main())
