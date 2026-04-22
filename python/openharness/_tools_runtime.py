"""Runtime glue for user-defined Python tools and permission callbacks.

Given a list of Python callables and/or a ``can_use_tool`` permission
callback, this module:

1. Starts an in-process MCP HTTP server hosting tool callables
   (when ``tools=[...]`` is passed).
2. Starts an in-process permission HTTP server
   (when ``can_use_tool=...`` is passed).
3. Creates a temporary directory with ``.oh/config.yaml`` whose
   ``mcpServers`` entry points at the tool server and whose
   ``hooks.permissionRequest`` entry points at the permission server.
4. Returns the cwd to use when spawning the ``oh`` subprocess, plus a
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
from ._permission_server import InProcessPermissionServer, PermissionCallback

__all__ = ["ToolsRuntime", "prepare_tools_runtime"]


class ToolsRuntime:
    """Bundle of resources created when ``tools=[...]`` and/or
    ``can_use_tool=...`` is passed.

    Exposes :attr:`cwd` for the subprocess and :meth:`close` to tear
    everything down.
    """

    def __init__(
        self,
        mcp_server: InProcessMcpServer | None,
        permission_server: InProcessPermissionServer | None,
        tempdir: Path,
    ) -> None:
        self._mcp_server = mcp_server
        self._permission_server = permission_server
        self._tempdir = tempdir
        self._closed = False

    @property
    def cwd(self) -> str:
        """Path the ``oh`` subprocess should use as its working directory."""
        return str(self._tempdir)

    async def close(self) -> None:
        """Stop any running servers and remove the temp directory. Idempotent."""
        if self._closed:
            return
        self._closed = True
        if self._mcp_server is not None:
            await self._mcp_server.close()
        if self._permission_server is not None:
            await self._permission_server.close()
        shutil.rmtree(self._tempdir, ignore_errors=True)


def _strip_top_level_key(lines: list[str], key: str) -> list[str]:
    """Remove any top-level ``<key>:`` block (plus its indented body) from ``lines``.

    Used to make room for the SDK-injected ``mcpServers:`` and ``hooks:``
    blocks. We don't parse YAML here — just drop the key's contiguous
    indented block. If ``key`` doesn't appear, ``lines`` is returned
    unchanged.
    """
    out: list[str] = []
    skipping = False
    for line in lines:
        if not skipping and line.startswith(f"{key}:"):
            skipping = True
            continue
        if skipping and (line.startswith("  ") or line.startswith("- ") or line == ""):
            if line == "":
                skipping = False
            continue
        skipping = False
        out.append(line)
    return out


def _write_ephemeral_config(
    tempdir: Path,
    *,
    mcp_url: str | None,
    mcp_server_name: str,
    permission_url: str | None,
    base_cwd: Path | None,
) -> None:
    """Write ``.oh/config.yaml`` with SDK-injected hooks and MCP servers.

    If ``base_cwd`` has its own ``.oh/config.yaml``, its top-level keys
    other than ``mcpServers`` and ``hooks`` are preserved (so model,
    provider, permissionMode etc. carry through). Existing
    ``mcpServers`` and ``hooks`` blocks are dropped — the SDK owns those
    entries for the duration of the runtime.
    """
    oh_dir = tempdir / ".oh"
    oh_dir.mkdir(parents=True, exist_ok=True)
    config_path = oh_dir / "config.yaml"

    existing: str = ""
    if base_cwd is not None:
        src = base_cwd / ".oh" / "config.yaml"
        if src.is_file():
            existing = src.read_text(encoding="utf-8").rstrip() + "\n"

    lines = existing.splitlines()
    lines = _strip_top_level_key(lines, "mcpServers")
    lines = _strip_top_level_key(lines, "hooks")

    body = "\n".join(lines).rstrip()
    if body:
        body += "\n\n"

    injected: list[str] = []
    if mcp_url is not None:
        injected += [
            "mcpServers:",
            f"  - name: {mcp_server_name}",
            '    type: "http"',
            f'    url: "{mcp_url}"',
        ]
    if permission_url is not None:
        injected += [
            "hooks:",
            "  permissionRequest:",
            f'    - http: "{permission_url}"',
        ]
    injected.append("")
    body += "\n".join(injected)
    config_path.write_text(body, encoding="utf-8")


async def prepare_tools_runtime(
    tools: Sequence[Callable[..., Any] | Callable[..., Awaitable[Any]]] | None = None,
    *,
    base_cwd: str | None,
    server_name: str = "openharness-python-tools",
    can_use_tool: PermissionCallback | None = None,
) -> ToolsRuntime:
    """Spin up the MCP and/or permission servers and write the ephemeral config.

    At least one of ``tools`` or ``can_use_tool`` must be provided — callers
    should gate this function behind that check.

    :param tools: Callables to expose as MCP tools. ``None`` or empty skips
        the MCP server.
    :param base_cwd: If set, any existing ``.oh/config.yaml`` there is
        preserved (its non-mcpServers/non-hooks contents copied into the
        temp dir).
    :param server_name: Name used in the MCP entry. Visible to the agent.
    :param can_use_tool: Permission callback. When set, a permission HTTP
        server is started and wired into ``hooks.permissionRequest``.
    """
    mcp_server: InProcessMcpServer | None = None
    permission_server: InProcessPermissionServer | None = None
    tempdir = Path(tempfile.mkdtemp(prefix="oh-py-tools-"))
    try:
        if tools:
            mcp_server = InProcessMcpServer(list(tools), name=server_name)
            await mcp_server.start()
        if can_use_tool is not None:
            permission_server = InProcessPermissionServer(can_use_tool)
            await permission_server.start()
        _write_ephemeral_config(
            tempdir,
            mcp_url=mcp_server.url if mcp_server else None,
            mcp_server_name=server_name,
            permission_url=permission_server.url if permission_server else None,
            base_cwd=Path(base_cwd) if base_cwd else None,
        )
    except Exception:
        if mcp_server is not None:
            await mcp_server.close()
        if permission_server is not None:
            await permission_server.close()
        shutil.rmtree(tempdir, ignore_errors=True)
        raise
    return ToolsRuntime(mcp_server, permission_server, tempdir)
