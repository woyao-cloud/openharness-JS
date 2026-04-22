"""Tests for v0.5.0 additions: resume kwarg, setting_sources, SessionStart event, OpenHarnessOptions."""

from __future__ import annotations

import pytest

from openharness import (
    OpenHarnessClient,
    OpenHarnessOptions,
    SessionStart,
    TextDelta,
    query,
)
from openharness.events import parse_event

# ─────────────────────────── SessionStart event parsing ──


def test_parse_session_start_event() -> None:
    e = parse_event({"type": "session_start", "sessionId": "abc-123"})
    assert isinstance(e, SessionStart)
    assert e.session_id == "abc-123"


def test_parse_ready_event_surfaces_session_id() -> None:
    # The session command emits `{type: "ready", sessionId: ...}` — SessionStart
    # also covers that shape.
    e = parse_event({"type": "ready", "sessionId": "xyz"})
    assert isinstance(e, SessionStart)
    assert e.session_id == "xyz"


def test_parse_ready_without_session_id_surfaces_none() -> None:
    e = parse_event({"type": "ready"})
    assert isinstance(e, SessionStart)
    assert e.session_id is None


# ─────────────────────────── OpenHarnessOptions ──


def test_options_to_kwargs_filters_none_defaults() -> None:
    opts = OpenHarnessOptions(model="ollama/llama3", resume="abc")
    kwargs = opts.to_kwargs()
    # Non-None fields (including the non-None default `permission_mode: "trust"`
    # and `max_turns: 20`) are surfaced.
    assert kwargs["model"] == "ollama/llama3"
    assert kwargs["resume"] == "abc"
    assert kwargs["permission_mode"] == "trust"
    assert kwargs["max_turns"] == 20
    # None-valued fields are dropped.
    assert "allowed_tools" not in kwargs
    assert "can_use_tool" not in kwargs


def test_options_to_kwargs_roundtrips_through_client() -> None:
    # Making sure the dict returned by to_kwargs is actually passable to the
    # client constructor without unknown-kwarg errors. We don't start the
    # subprocess (no __aenter__) — just construct and inspect.
    opts = OpenHarnessOptions(model="m", max_turns=3, setting_sources=["project"])
    client = OpenHarnessClient(**opts.to_kwargs())
    assert client._model == "m"
    assert client._max_turns == 3
    assert client._setting_sources == ("project",)


def test_options_default_matches_query_signature() -> None:
    # Verify the dataclass defaults don't drift from the entry-point defaults.
    opts = OpenHarnessOptions()
    assert opts.model is None
    assert opts.permission_mode == "trust"
    assert opts.max_turns == 20
    assert opts.resume is None
    assert opts.setting_sources is None


# ─────────────────── resume / setting_sources wiring (query + client) ──


@pytest.mark.asyncio
async def test_query_passes_resume_flag(make_oh_stub) -> None:
    """The --resume flag should reach the oh binary."""
    # Stub echoes its argv back as a single text event.
    make_oh_stub(
        "import sys, json\n"
        'print(json.dumps({"type": "text", "content": " ".join(sys.argv[1:])}), flush=True)\n'
        'print(json.dumps({"type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )
    captured: list[str] = []
    async for event in query("hi", resume="sess-abc", max_turns=1):
        if isinstance(event, TextDelta):
            captured.append(event.content)
    assert captured
    assert "--resume" in captured[0]
    assert "sess-abc" in captured[0]


@pytest.mark.asyncio
async def test_query_passes_setting_sources_flag(make_oh_stub) -> None:
    make_oh_stub(
        "import sys, json\n"
        'print(json.dumps({"type": "text", "content": " ".join(sys.argv[1:])}), flush=True)\n'
        'print(json.dumps({"type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )
    captured: list[str] = []
    async for event in query("hi", setting_sources=["user", "project"], max_turns=1):
        if isinstance(event, TextDelta):
            captured.append(event.content)
    assert captured
    assert "--setting-sources" in captured[0]
    assert "user,project" in captured[0]


@pytest.mark.asyncio
async def test_client_captures_session_id_from_ready(make_oh_stub) -> None:
    """OpenHarnessClient.session_id should be populated after entering the context."""
    make_oh_stub(
        "import sys, json\n"
        'print(json.dumps({"type": "ready", "sessionId": "captured-sid"}), flush=True)\n'
        "for line in sys.stdin:\n"
        "    try:\n"
        "        req = json.loads(line)\n"
        "    except Exception:\n"
        "        continue\n"
        '    if req.get("command") == "exit":\n'
        "        break\n"
    )

    async with OpenHarnessClient() as client:
        assert client.session_id == "captured-sid"


@pytest.mark.asyncio
async def test_client_session_id_none_when_cli_omits_it(make_oh_stub) -> None:
    """Older CLIs emit bare {type:'ready'} — session_id stays None."""
    make_oh_stub(
        "import sys, json\n"
        'print(json.dumps({"type": "ready"}), flush=True)\n'
        "for line in sys.stdin:\n"
        "    try:\n"
        "        req = json.loads(line)\n"
        "    except Exception:\n"
        "        continue\n"
        '    if req.get("command") == "exit":\n'
        "        break\n"
    )
    async with OpenHarnessClient() as client:
        assert client.session_id is None


@pytest.mark.asyncio
async def test_client_passes_resume_and_setting_sources(make_oh_stub) -> None:
    """Both flags should be threaded to the session subprocess argv."""
    make_oh_stub(
        "import sys, json\n"
        'print(json.dumps({"type": "ready", "sessionId": "seeded"}), flush=True)\n'
        "# Echo argv as soon as any prompt arrives.\n"
        "for line in sys.stdin:\n"
        "    try:\n"
        "        req = json.loads(line)\n"
        "    except Exception:\n"
        "        continue\n"
        '    if req.get("command") == "exit":\n'
        "        break\n"
        '    pid = req.get("id")\n'
        '    print(json.dumps({"id": pid, "type": "text", "content": " ".join(sys.argv[1:])}), flush=True)\n'
        '    print(json.dumps({"id": pid, "type": "turn_complete", "reason": "completed"}), flush=True)\n'
    )
    async with OpenHarnessClient(resume="prior-id", setting_sources=["project"]) as client:
        events = []
        async for e in await client.send("hi"):
            events.append(e)
        argv_echo = next(e.content for e in events if isinstance(e, TextDelta))
        assert "--resume" in argv_echo
        assert "prior-id" in argv_echo
        assert "--setting-sources" in argv_echo
        assert "project" in argv_echo
