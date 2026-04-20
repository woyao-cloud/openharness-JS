"""In-process MCP HTTP server for hosting user-defined Python tools.

Spawned per-session (or per-query) when the caller passes ``tools=[...]``.
The spawned ``oh`` CLI connects to this server over HTTP and invokes
the registered Python callables.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket
from collections.abc import Callable
from typing import Any

from .tools import tool_description, tool_name

__all__ = ["InProcessMcpServer"]


def _pick_ephemeral_port() -> int:
    """Ask the OS for a free 127.0.0.1 port, release it, and return the number.

    There is a small race window between release and the server reopening
    the port. For a developer-machine use case this is negligible.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class InProcessMcpServer:
    """Run a FastMCP HTTP server in the current asyncio event loop.

    Registers each provided callable as an MCP tool. FastMCP infers the
    JSON schema from Python type hints on the function signature.

    :param tools: Python callables to expose as tools. Each one's name
        and description come from :func:`~openharness.tools.tool_name`
        and :func:`~openharness.tools.tool_description`.
    :param name: The MCP server's advertised name. Default:
        ``"openharness-python-tools"``.
    """

    def __init__(
        self,
        tools: list[Callable[..., Any]],
        *,
        name: str = "openharness-python-tools",
    ) -> None:
        # Import lazily so the `mcp` dep isn't loaded unless tools are used.
        from mcp.server.fastmcp import FastMCP

        self._port = _pick_ephemeral_port()
        self._mcp = FastMCP(name, host="127.0.0.1", port=self._port)

        for fn in tools:
            self._mcp.tool(name=tool_name(fn), description=tool_description(fn))(fn)

        self._server: Any = None
        self._task: asyncio.Task[None] | None = None

    @property
    def url(self) -> str:
        """The Streamable-HTTP endpoint URL to put in an ``mcpServers`` entry."""
        return f"http://127.0.0.1:{self._port}/mcp"

    async def start(self) -> None:
        """Start serving in a background task. Idempotent."""
        if self._task is not None:
            return
        import uvicorn

        app = self._mcp.streamable_http_app()
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=self._port,
            log_level="error",
            lifespan="on",
            loop="asyncio",
            # Avoid installing signal handlers — we're in-process.
            log_config=None,
        )
        self._server = uvicorn.Server(config)
        self._server.install_signal_handlers = lambda: None
        self._task = asyncio.create_task(self._server.serve())
        # Wait for uvicorn to report started, with a hard cap.
        for _ in range(100):
            if getattr(self._server, "started", False):
                return
            await asyncio.sleep(0.02)
        raise RuntimeError("MCP server did not start within 2s")

    async def close(self) -> None:
        """Stop the server. Idempotent."""
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._task, timeout=5.0)
            self._task = None
        self._server = None
