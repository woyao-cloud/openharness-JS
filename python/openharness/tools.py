"""Custom tools — Python functions the agent can call during a session.

Use :func:`tool` to decorate a Python callable, then pass the decorated
function (or any regular callable) to :func:`query` or
:class:`OpenHarnessClient`. The SDK spins up an in-process MCP server,
registers your functions as MCP tools, and wires the spawned `oh` CLI
to call back into it.

Example::

    import asyncio
    from openharness import OpenHarnessClient, tool

    @tool
    async def get_weather(city: str) -> str:
        '''Fetch the current weather for a city.'''
        return f"Sunny in {city}, 22°C"

    async def main() -> None:
        async with OpenHarnessClient(tools=[get_weather]) as client:
            async for event in await client.send("What's the weather in Paris?"):
                print(event)

    asyncio.run(main())
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar, overload

__all__ = ["is_tool", "tool", "tool_description", "tool_name"]

F = TypeVar("F", bound=Callable[..., Any])

# Attribute keys used to stamp decorated functions.
_IS_TOOL_ATTR = "_oh_is_tool"
_TOOL_NAME_ATTR = "_oh_tool_name"
_TOOL_DESCRIPTION_ATTR = "_oh_tool_description"


@overload
def tool(fn: F, /) -> F: ...


@overload
def tool(
    *,
    name: str | None = None,
    description: str | None = None,
) -> Callable[[F], F]: ...


def tool(
    fn: F | None = None,
    /,
    *,
    name: str | None = None,
    description: str | None = None,
) -> F | Callable[[F], F]:
    """Mark a function as an OH-callable tool.

    Can be used with or without arguments::

        @tool
        def a(x: int) -> int: ...

        @tool(name="custom-name", description="override")
        def b(x: int) -> int: ...

    Without the decorator, a plain callable still works — decoration is
    purely optional metadata for overriding the inferred name and
    description.

    :param name: Override the tool name exposed to the agent.
        Defaults to ``fn.__name__``.
    :param description: Override the tool description. Defaults to
        the first line of ``fn.__doc__``.
    """

    def _wrap(f: F) -> F:
        setattr(f, _IS_TOOL_ATTR, True)
        if name is not None:
            setattr(f, _TOOL_NAME_ATTR, name)
        if description is not None:
            setattr(f, _TOOL_DESCRIPTION_ATTR, description)
        return f

    if fn is None:
        return _wrap
    return _wrap(fn)


def is_tool(fn: Callable[..., Any]) -> bool:
    """Return True if ``fn`` was decorated with :func:`tool`."""
    return getattr(fn, _IS_TOOL_ATTR, False) is True


def tool_name(fn: Callable[..., Any]) -> str:
    """Return the tool name for ``fn`` (custom or inferred from ``__name__``)."""
    override = getattr(fn, _TOOL_NAME_ATTR, None)
    if isinstance(override, str):
        return override
    return getattr(fn, "__name__", "tool")


def tool_description(fn: Callable[..., Any]) -> str:
    """Return the tool description (custom or first docstring line)."""
    override = getattr(fn, _TOOL_DESCRIPTION_ATTR, None)
    if isinstance(override, str):
        return override
    doc = getattr(fn, "__doc__", None)
    if isinstance(doc, str) and doc.strip():
        return doc.strip().splitlines()[0]
    return ""
