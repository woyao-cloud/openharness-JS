"""Runtime glue for user-defined Python tools.

Given a list of Python callables, this module:

1. Starts an in-process MCP HTTP server hosting those callables as tools.
2. Creates a temporary directory with ``.oh/config.yaml`` whose
   ``mcpServers`` entry points at the in-process server.
3. Returns the cwd to use when spawning the ``oh`` subprocess, plus a
   cleanup coroutine.

Used by both :func:`openharness.query` and
:class:`openharness.OpenHarnessClient`.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any

from ._mcp_server import InProcessMcpServer

__all__ = ["ToolsRuntime", "prepare_tools_runtime"]


class ToolsRuntime:
    """Bundle of resources created when ``tools=[...]`` is passed.

    Exposes :attr:`cwd` for the subprocess and :meth:`close` to tear
    everything down.
    """

    def __init__(self, server: InProcessMcpServer, tempdir: Path) -> None:
        self._server = server
        self._tempdir = tempdir
        self._closed = False

    @property
    def cwd(self) -> str:
        """Path the ``oh`` subprocess should use as its working directory."""
        return str(self._tempdir)

    async def close(self) -> None:
        """Stop the MCP server and remove the temp directory. Idempotent."""
        if self._closed:
            return
        self._closed = True
        await self._server.close()
        shutil.rmtree(self._tempdir, ignore_errors=True)


def _write_ephemeral_config(
    tempdir: Path,
    mcp_url: str,
    server_name: str,
    *,
    base_cwd: Path | None,
) -> None:
    """Write ``.oh/config.yaml`` pointing at ``mcp_url``.

    If ``base_cwd`` is given and has its own ``.oh/config.yaml``, copy it
    in first so existing user settings (model, providers, other MCP
    servers) survive. The injected server is appended to the
    ``mcpServers`` list.
    """
    oh_dir = tempdir / ".oh"
    oh_dir.mkdir(parents=True, exist_ok=True)
    config_path = oh_dir / "config.yaml"

    existing: str = ""
    if base_cwd is not None:
        src = base_cwd / ".oh" / "config.yaml"
        if src.is_file():
            existing = src.read_text(encoding="utf-8").rstrip() + "\n"

    injected_lines = [
        "mcpServers:",
        f"  - name: {server_name}",
        '    type: "http"',
        f'    url: "{mcp_url}"',
        "",
    ]
    # Naive append — if the existing config already has an mcpServers list,
    # YAML will complain about the duplicate key. Strip any prior entry.
    lines = existing.splitlines()
    filtered: list[str] = []
    skipping = False
    for line in lines:
        if not skipping and line.startswith("mcpServers"):
            skipping = True
            continue
        if skipping and (line.startswith("  ") or line.startswith("- ") or line == ""):
            # still inside the mcpServers block (or a blank line)
            if line == "":
                skipping = False
            continue
        skipping = False
        filtered.append(line)

    body = "\n".join(filtered).rstrip()
    if body:
        body += "\n\n"
    body += "\n".join(injected_lines)
    config_path.write_text(body, encoding="utf-8")


async def prepare_tools_runtime(
    tools: Sequence[Callable[..., Any] | Callable[..., Awaitable[Any]]],
    *,
    base_cwd: str | None,
    server_name: str = "openharness-python-tools",
) -> ToolsRuntime:
    """Spin up the MCP server and write the ephemeral config.

    :param tools: Callables to expose as MCP tools.
    :param base_cwd: If set, any existing ``.oh/config.yaml`` there is
        preserved (its non-mcpServers contents copied into the temp dir).
    :param server_name: Name used in the MCP entry. Visible to the agent.
    """
    server = InProcessMcpServer(list(tools), name=server_name)
    await server.start()
    tempdir = Path(tempfile.mkdtemp(prefix="oh-py-tools-"))
    try:
        _write_ephemeral_config(
            tempdir,
            server.url,
            server_name,
            base_cwd=Path(base_cwd) if base_cwd else None,
        )
    except Exception:
        await server.close()
        shutil.rmtree(tempdir, ignore_errors=True)
        raise
    return ToolsRuntime(server, tempdir)
