"""Tests for openharness.tools (the @tool decorator)."""

from __future__ import annotations

import pytest

from openharness.tools import is_tool, tool, tool_description, tool_name


def test_bare_decorator_marks_function() -> None:
    @tool
    def my_fn(x: int) -> int:
        """Double a number."""
        return x * 2

    assert is_tool(my_fn) is True
    assert tool_name(my_fn) == "my_fn"
    assert tool_description(my_fn) == "Double a number."
    # Function still callable.
    assert my_fn(3) == 6


def test_decorator_with_custom_name_and_description() -> None:
    @tool(name="custom_name", description="a custom description")
    def my_fn(x: int) -> int:
        """Original docstring."""
        return x + 1

    assert is_tool(my_fn) is True
    assert tool_name(my_fn) == "custom_name"
    assert tool_description(my_fn) == "a custom description"


def test_description_falls_back_to_first_docstring_line() -> None:
    @tool
    def my_fn() -> None:
        """First line.

        Second line with more detail.
        """

    assert tool_description(my_fn) == "First line."


def test_description_empty_when_no_docstring() -> None:
    @tool
    def my_fn() -> None:
        pass

    assert tool_description(my_fn) == ""


def test_name_falls_back_to_function_name_attr() -> None:
    @tool
    def chosen_name() -> None:
        pass

    assert tool_name(chosen_name) == "chosen_name"


def test_undecorated_function_is_not_a_tool() -> None:
    def plain_fn() -> None:
        pass

    assert is_tool(plain_fn) is False


def test_undecorated_function_still_has_name_and_description() -> None:
    def plain_fn() -> None:
        """Plain docstring."""

    # is_tool is False, but name/description still derivable (for callers
    # who want to pass raw callables without decoration).
    assert tool_name(plain_fn) == "plain_fn"
    assert tool_description(plain_fn) == "Plain docstring."


def test_async_function_works() -> None:
    @tool
    async def fetch() -> str:
        """Fetch something async."""
        return "ok"

    assert is_tool(fetch) is True
    assert tool_name(fetch) == "fetch"
    assert tool_description(fetch) == "Fetch something async."


def test_decorator_preserves_function_identity() -> None:
    @tool
    def my_fn(x: int) -> int:
        return x

    # The decorator returns the same function, not a wrapper.
    assert my_fn(5) == 5
    # Calling twice with the decorator doesn't double-mark.
    decorated_again = tool(my_fn)
    assert decorated_again is my_fn


@pytest.mark.asyncio
async def test_mcp_server_lifecycle() -> None:
    """The InProcessMcpServer should start, expose a URL, and close cleanly."""
    from openharness._mcp_server import InProcessMcpServer

    @tool
    async def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    server = InProcessMcpServer([add])
    assert server.url.startswith("http://127.0.0.1:")
    assert server.url.endswith("/mcp")
    await server.start()
    try:
        # Health: the socket is accepting connections. A GET on /mcp may
        # hang because Streamable-HTTP expects POST; socket-level check
        # is enough to confirm the server is listening.
        import socket

        with socket.create_connection(("127.0.0.1", server._port), timeout=2.0):
            pass
    finally:
        await server.close()
    # Second close is a no-op.
    await server.close()


@pytest.mark.asyncio
async def test_mcp_server_start_idempotent() -> None:
    from openharness._mcp_server import InProcessMcpServer

    @tool
    def noop() -> str:
        """No-op tool."""
        return "ok"

    server = InProcessMcpServer([noop])
    await server.start()
    try:
        await server.start()  # second start: no-op
    finally:
        await server.close()
