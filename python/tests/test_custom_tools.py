"""End-to-end tests for ``tools=`` wired through query() and OpenHarnessClient."""

from __future__ import annotations

import socket
from pathlib import Path

import pytest

from openharness import OpenHarnessClient, TextDelta, TurnComplete, query, tool
from openharness._tools_runtime import prepare_tools_runtime


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


@pytest.mark.asyncio
async def test_prepare_runtime_writes_config_and_starts_server() -> None:
    runtime = await prepare_tools_runtime([add], base_cwd=None)
    try:
        config = Path(runtime.cwd) / ".oh" / "config.yaml"
        assert config.is_file()
        body = config.read_text(encoding="utf-8")
        assert "mcpServers" in body
        assert "openharness-python-tools" in body
        assert 'type: "http"' in body
        # URL points at the in-process server.
        assert "http://127.0.0.1:" in body
        # Server port is actually listening.
        port = int(body.rsplit(":", 1)[1].split("/", 1)[0])
        with socket.create_connection(("127.0.0.1", port), timeout=2.0):
            pass
    finally:
        await runtime.close()
    # After close, the temp dir is gone.
    assert not Path(runtime.cwd).exists()


@pytest.mark.asyncio
async def test_prepare_runtime_preserves_user_config(tmp_path: Path) -> None:
    # Caller's cwd has an existing .oh/config.yaml with a model setting and
    # unrelated mcpServers entry. Our runtime should carry the model forward
    # and replace the mcpServers block (not duplicate it).
    (tmp_path / ".oh").mkdir()
    (tmp_path / ".oh" / "config.yaml").write_text(
        'model: "ollama/llama3"\n'
        "mcpServers:\n"
        "  - name: old\n"
        '    type: "http"\n'
        '    url: "http://unused/mcp"\n',
        encoding="utf-8",
    )
    runtime = await prepare_tools_runtime([add], base_cwd=str(tmp_path))
    try:
        body = (Path(runtime.cwd) / ".oh" / "config.yaml").read_text(encoding="utf-8")
        # User's top-level settings survive.
        assert 'model: "ollama/llama3"' in body
        # Old MCP entry was dropped.
        assert "http://unused/mcp" not in body
        assert "name: old" not in body
        # New entry is present.
        assert "openharness-python-tools" in body
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_query_passes_tools_cwd_to_subprocess(make_oh_stub) -> None:
    """When tools=[...] is set, `oh` is spawned with cwd=<tempdir-with-mcp-config>."""
    # Stub echoes its cwd as a TextDelta so we can assert.
    make_oh_stub(
        'import sys, json, os\n'
        'print(json.dumps({"type": "text", "content": os.getcwd()}), flush=True)\n'
        'print(json.dumps({"type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )
    captured: list[str] = []
    async for event in query("hello", tools=[add], max_turns=1):
        if isinstance(event, TextDelta):
            captured.append(event.content)
        if isinstance(event, TurnComplete):
            break
    assert captured, "stub produced no text events"
    cwd = captured[0]
    # By the time this assert runs, query() has cleaned up — the path
    # won't exist on disk. Assert on the temp-dir prefix instead.
    assert "oh-py-tools-" in cwd, f"unexpected cwd: {cwd!r}"


@pytest.mark.asyncio
async def test_client_passes_tools_cwd_to_subprocess(make_oh_stub) -> None:
    """OpenHarnessClient also spawns with the tools-runtime cwd."""
    make_oh_stub(
        'import sys, json, os\n'
        'print(json.dumps({"type": "ready"}), flush=True)\n'
        'for line in sys.stdin:\n'
        '    try:\n'
        '        req = json.loads(line)\n'
        '    except Exception:\n'
        '        continue\n'
        '    if req.get("command") == "exit":\n'
        '        break\n'
        '    pid = req.get("id")\n'
        '    print(json.dumps({"id": pid, "type": "text", "content": os.getcwd()}), flush=True)\n'
        '    print(json.dumps({"id": pid, "type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )
    async with OpenHarnessClient(tools=[add]) as client:
        events = []
        async for event in await client.send("hi"):
            events.append(event)
        assert any(isinstance(e, TextDelta) for e in events)
        cwd = next(e.content for e in events if isinstance(e, TextDelta))
        assert "oh-py-tools-" in cwd, f"unexpected cwd: {cwd!r}"


@pytest.mark.asyncio
async def test_query_without_tools_uses_caller_cwd(make_oh_stub, tmp_path: Path) -> None:
    """Sanity check: no tools=, no MCP runtime — caller's cwd is honored."""
    make_oh_stub(
        'import sys, json, os\n'
        'print(json.dumps({"type": "text", "content": os.getcwd()}), flush=True)\n'
        'print(json.dumps({"type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )
    target = tmp_path / "user-cwd"
    target.mkdir()
    captured: list[str] = []
    async for event in query("hi", cwd=str(target), max_turns=1):
        if isinstance(event, TextDelta):
            captured.append(event.content)
    assert captured
    assert Path(captured[0]).resolve() == target.resolve()
