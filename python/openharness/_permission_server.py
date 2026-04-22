"""In-process permission-callback HTTP server.

When ``can_use_tool`` is passed to :func:`~openharness.query` or
:class:`~openharness.OpenHarnessClient`, the SDK starts one of these
servers on a random ``127.0.0.1`` port and injects a ``permissionRequest``
HTTP hook in the ephemeral ``.oh/config.yaml`` pointing at it. When the
CLI needs a permission decision, it POSTs to ``/permission`` and waits
for the user's callback to return.

Wire contract (matches ``src/harness/hooks.ts`` v2.16.0+):

Request body::

    {"event": "permissionRequest", "toolName": "Bash", "toolInputJson": "..."}

Response body::

    {"decision": "allow" | "deny" | "ask", "reason": "..."}

The response can also wrap ``decision`` inside a ``hookSpecificOutput``
block, matching the Claude Code convention — the CLI parses either.

Failure modes (all surface as "deny" on the CLI side):

- Callback raises → 500 + "deny" response
- Callback times out → 500 + "deny" response
- Callback returns a non-decision value → "deny" response

We never let a misbehaving callback block the agent indefinitely.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import socket
from collections.abc import Awaitable, Callable
from typing import Any

__all__ = ["InProcessPermissionServer", "PermissionContext", "PermissionDecision"]

PermissionDecision = str  # "allow" | "deny" | "ask"
PermissionContext = dict[str, Any]

# User callbacks can be sync or async, return a bare decision string or a
# dict with {decision, reason}. Normalised internally.
PermissionCallback = Callable[
    [PermissionContext],
    PermissionDecision | dict[str, Any] | Awaitable[PermissionDecision | dict[str, Any]],
]


def _pick_ephemeral_port() -> int:
    """Ask the OS for a free 127.0.0.1 port, release it, and return the number."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class InProcessPermissionServer:
    """Run a minimal HTTP server that dispatches permission-hook POSTs.

    :param callback: User callable invoked for each permission request.
        Receives the raw context dict (contains ``event``, ``toolName``,
        ``toolInputJson``, plus any other fields the CLI attaches).
        Must return ``"allow"``, ``"deny"``, or ``"ask"`` — optionally
        wrapped as ``{"decision": "...", "reason": "..."}``. Sync and
        async callables both work.
    :param timeout_seconds: Cap on how long a single callback may run
        before we respond "deny" to the CLI. Default: 30 seconds.
    """

    def __init__(
        self,
        callback: PermissionCallback,
        *,
        timeout_seconds: float = 30.0,
    ) -> None:
        self._callback = callback
        self._timeout = timeout_seconds
        self._port = _pick_ephemeral_port()
        self._server: Any = None
        self._task: asyncio.Task[None] | None = None

    @property
    def url(self) -> str:
        """The URL to put in the ``hooks.permissionRequest`` hook entry."""
        return f"http://127.0.0.1:{self._port}/permission"

    async def _handle(self, request: Any) -> Any:
        """Starlette request handler. Invokes the user callback."""
        from starlette.responses import JSONResponse

        try:
            ctx: PermissionContext = await request.json()
        except Exception:
            return JSONResponse({"decision": "deny", "reason": "invalid JSON"}, status_code=400)

        try:
            result = await asyncio.wait_for(self._invoke(ctx), timeout=self._timeout)
        except (TimeoutError, asyncio.TimeoutError):
            # Python 3.10 raises asyncio.TimeoutError (not the built-in).
            # PEP 678 aliased them on 3.11+. Catch both for compat.
            return JSONResponse({"decision": "deny", "reason": "callback timeout"})
        except Exception as e:
            return JSONResponse({"decision": "deny", "reason": f"callback error: {e}"})

        decision, reason = _coerce_result(result)
        return JSONResponse({"decision": decision, "reason": reason})

    async def _invoke(self, ctx: PermissionContext) -> Any:
        """Call the user's callback, awaiting it if it's a coroutine."""
        result = self._callback(ctx)
        if inspect.isawaitable(result):
            return await result
        return result

    async def start(self) -> None:
        """Start serving in a background task. Idempotent."""
        if self._task is not None:
            return
        import uvicorn
        from starlette.applications import Starlette
        from starlette.routing import Route

        app = Starlette(routes=[Route("/permission", self._handle, methods=["POST"])])
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=self._port,
            log_level="error",
            lifespan="on",
            loop="asyncio",
            log_config=None,
        )
        self._server = uvicorn.Server(config)
        self._server.install_signal_handlers = lambda: None
        self._task = asyncio.create_task(self._server.serve())
        for _ in range(100):
            if getattr(self._server, "started", False):
                return
            await asyncio.sleep(0.02)
        raise RuntimeError("Permission server did not start within 2s")

    async def close(self) -> None:
        """Stop the server. Idempotent."""
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._task, timeout=5.0)
            self._task = None
        self._server = None


_VALID_DECISIONS = frozenset({"allow", "deny", "ask"})


def _coerce_result(result: Any) -> tuple[str, str | None]:
    """Normalise a callback's return into ``(decision, reason)``.

    Accepts a bare string (``"allow"`` / ``"deny"`` / ``"ask"``) or a
    dict with a ``decision`` key and optional ``reason``. Any other shape
    becomes ``("deny", "invalid callback return")``.
    """
    if isinstance(result, str):
        if result in _VALID_DECISIONS:
            return result, None
        return "deny", f"invalid decision {result!r}"
    if isinstance(result, dict):
        decision = result.get("decision")
        reason = result.get("reason")
        if isinstance(decision, str) and decision in _VALID_DECISIONS:
            return decision, str(reason) if reason is not None else None
        return "deny", "missing or invalid 'decision' field"
    return "deny", "invalid callback return type"
