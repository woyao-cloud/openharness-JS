"""Tests for the can_use_tool permission callback wiring (v0.4.0)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from openharness import OpenHarnessClient, TextDelta, query
from openharness._permission_server import InProcessPermissionServer, _coerce_result
from openharness._tools_runtime import prepare_tools_runtime

# ─────────────────────────── _coerce_result (unit) ──


def test_coerce_bare_allow() -> None:
    assert _coerce_result("allow") == ("allow", None)


def test_coerce_bare_deny() -> None:
    assert _coerce_result("deny") == ("deny", None)


def test_coerce_bare_ask() -> None:
    assert _coerce_result("ask") == ("ask", None)


def test_coerce_invalid_string_denies() -> None:
    decision, reason = _coerce_result("yolo")
    assert decision == "deny"
    assert reason is not None and "yolo" in reason


def test_coerce_dict_with_reason() -> None:
    assert _coerce_result({"decision": "allow", "reason": "trusted"}) == ("allow", "trusted")


def test_coerce_dict_missing_decision() -> None:
    decision, _ = _coerce_result({"reason": "nope"})
    assert decision == "deny"


def test_coerce_wrong_type_denies() -> None:
    decision, _ = _coerce_result(42)
    assert decision == "deny"


def test_coerce_none_denies() -> None:
    decision, _ = _coerce_result(None)
    assert decision == "deny"


# ─────────────────────────── InProcessPermissionServer ──


@pytest.mark.asyncio
async def test_permission_server_invokes_sync_callback() -> None:
    received: list[dict] = []

    def gate(ctx: dict) -> str:
        received.append(ctx)
        return "allow"

    server = InProcessPermissionServer(gate)
    await server.start()
    try:
        async with httpx.AsyncClient() as c:
            resp = await c.post(server.url, json={"event": "permissionRequest", "toolName": "Bash"}, timeout=5.0)
        assert resp.status_code == 200
        assert resp.json() == {"decision": "allow", "reason": None}
        assert received == [{"event": "permissionRequest", "toolName": "Bash"}]
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_permission_server_invokes_async_callback() -> None:
    async def gate(ctx: dict) -> dict:
        return {"decision": "deny", "reason": "no thanks"}

    server = InProcessPermissionServer(gate)
    await server.start()
    try:
        async with httpx.AsyncClient() as c:
            resp = await c.post(server.url, json={"toolName": "Bash"}, timeout=5.0)
        assert resp.json() == {"decision": "deny", "reason": "no thanks"}
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_permission_server_callback_exception_denies() -> None:
    def gate(_ctx: dict) -> str:
        raise RuntimeError("boom")

    server = InProcessPermissionServer(gate)
    await server.start()
    try:
        async with httpx.AsyncClient() as c:
            resp = await c.post(server.url, json={"toolName": "Bash"}, timeout=5.0)
        data = resp.json()
        assert data["decision"] == "deny"
        assert "boom" in (data.get("reason") or "")
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_permission_server_callback_timeout_denies() -> None:
    import asyncio

    async def gate(_ctx: dict) -> str:
        await asyncio.sleep(10)  # way longer than the server timeout
        return "allow"

    server = InProcessPermissionServer(gate, timeout_seconds=0.2)
    await server.start()
    try:
        async with httpx.AsyncClient() as c:
            resp = await c.post(server.url, json={"toolName": "Bash"}, timeout=5.0)
        data = resp.json()
        assert data["decision"] == "deny"
        assert "timeout" in (data.get("reason") or "").lower()
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_permission_server_bad_json_400() -> None:
    def gate(_ctx: dict) -> str:
        return "allow"

    server = InProcessPermissionServer(gate)
    await server.start()
    try:
        async with httpx.AsyncClient() as c:
            resp = await c.post(
                server.url,
                content=b"not-json",
                headers={"Content-Type": "application/json"},
                timeout=5.0,
            )
        assert resp.status_code == 400
    finally:
        await server.close()


# ────────────── prepare_tools_runtime with can_use_tool (integration) ──


@pytest.mark.asyncio
async def test_runtime_writes_permission_hook_to_config() -> None:
    def gate(_ctx: dict) -> str:
        return "allow"

    runtime = await prepare_tools_runtime(tools=None, base_cwd=None, can_use_tool=gate)
    try:
        config = Path(runtime.cwd) / ".oh" / "config.yaml"
        body = config.read_text(encoding="utf-8")
        assert "hooks:" in body
        assert "permissionRequest:" in body
        assert "http://127.0.0.1:" in body
        # No mcpServers block since tools=None.
        assert "mcpServers" not in body
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_runtime_combines_mcp_tools_and_permission_hook() -> None:
    from openharness import tool

    @tool
    def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    def gate(_ctx: dict) -> str:
        return "allow"

    runtime = await prepare_tools_runtime(tools=[add], base_cwd=None, can_use_tool=gate)
    try:
        body = (Path(runtime.cwd) / ".oh" / "config.yaml").read_text(encoding="utf-8")
        assert "mcpServers:" in body
        assert "hooks:" in body
        assert "permissionRequest:" in body
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_runtime_strips_user_hooks_to_make_room() -> None:
    # If the user had their own hooks in .oh/config.yaml, the SDK
    # replaces the block (otherwise YAML would have a duplicate key).
    # Top-level non-hooks settings survive.
    from tempfile import mkdtemp

    user_cwd = Path(mkdtemp(prefix="oh-user-"))
    try:
        (user_cwd / ".oh").mkdir()
        (user_cwd / ".oh" / "config.yaml").write_text(
            'model: "ollama/llama3"\n'
            "hooks:\n"
            "  preToolUse:\n"
            "    - command: 'old'\n",
            encoding="utf-8",
        )

        def gate(_ctx: dict) -> str:
            return "allow"

        runtime = await prepare_tools_runtime(
            tools=None, base_cwd=str(user_cwd), can_use_tool=gate
        )
        try:
            body = (Path(runtime.cwd) / ".oh" / "config.yaml").read_text(encoding="utf-8")
            assert 'model: "ollama/llama3"' in body
            # User's old preToolUse hook is gone (SDK owns the hooks block now).
            assert "preToolUse" not in body
            # New permissionRequest hook is in place.
            assert "permissionRequest:" in body
        finally:
            await runtime.close()
    finally:
        import shutil

        shutil.rmtree(user_cwd, ignore_errors=True)


# ───────────────── end-to-end through query() / OpenHarnessClient ──


@pytest.mark.asyncio
async def test_query_passes_can_use_tool_cwd_to_subprocess(make_oh_stub) -> None:
    """When can_use_tool is set (even without tools), the subprocess uses the runtime cwd."""
    make_oh_stub(
        "import sys, json, os\n"
        'print(json.dumps({"type": "text", "content": os.getcwd()}), flush=True)\n'
        'print(json.dumps({"type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )

    def gate(_ctx: dict) -> str:
        return "allow"

    captured: list[str] = []
    async for event in query("hi", can_use_tool=gate, max_turns=1):
        if isinstance(event, TextDelta):
            captured.append(event.content)
    assert captured
    assert "oh-py-tools-" in captured[0]


@pytest.mark.asyncio
async def test_client_passes_can_use_tool_cwd_to_subprocess(make_oh_stub) -> None:
    make_oh_stub(
        "import sys, json, os\n"
        'print(json.dumps({"type": "ready"}), flush=True)\n'
        "for line in sys.stdin:\n"
        "    try:\n"
        "        req = json.loads(line)\n"
        "    except Exception:\n"
        "        continue\n"
        '    if req.get("command") == "exit":\n'
        "        break\n"
        '    pid = req.get("id")\n'
        '    print(json.dumps({"id": pid, "type": "text", "content": os.getcwd()}), flush=True)\n'
        '    print(json.dumps({"id": pid, "type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )

    def gate(_ctx: dict) -> str:
        return "allow"

    async with OpenHarnessClient(can_use_tool=gate) as client:
        events = []
        async for event in await client.send("hi"):
            events.append(event)
        cwd = next(e.content for e in events if isinstance(e, TextDelta))
        assert "oh-py-tools-" in cwd


# ─────────────────────── new TurnStart / TurnStop / HookDecision ──


@pytest.mark.asyncio
async def test_parse_turn_start_event() -> None:
    from openharness import TurnStart
    from openharness.events import parse_event

    e = parse_event({"type": "turnStart", "turnNumber": 3})
    assert isinstance(e, TurnStart)
    assert e.turn_number == 3


@pytest.mark.asyncio
async def test_parse_turn_stop_event() -> None:
    from openharness import TurnStop
    from openharness.events import parse_event

    e = parse_event({"type": "turnStop", "turnNumber": 0, "reason": "max_turns"})
    assert isinstance(e, TurnStop)
    assert e.turn_number == 0
    assert e.reason == "max_turns"


@pytest.mark.asyncio
async def test_parse_hook_decision_event() -> None:
    from openharness import HookDecision
    from openharness.events import parse_event

    e = parse_event(
        {
            "type": "hook_decision",
            "event": "permissionRequest",
            "tool": "Bash",
            "decision": "deny",
            "reason": "sandbox",
        }
    )
    assert isinstance(e, HookDecision)
    assert e.event == "permissionRequest"
    assert e.tool == "Bash"
    assert e.decision == "deny"
    assert e.reason == "sandbox"


@pytest.mark.asyncio
async def test_hook_decision_event_with_null_fields() -> None:
    from openharness import HookDecision
    from openharness.events import parse_event

    e = parse_event({"type": "hook_decision", "event": "permissionRequest", "decision": "allow"})
    assert isinstance(e, HookDecision)
    assert e.tool is None
    assert e.reason is None
