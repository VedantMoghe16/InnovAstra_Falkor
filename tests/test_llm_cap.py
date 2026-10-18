"""Public-demo guard: RUDRA_LLM_RUNS_PER_HOUR caps paid LLM investigations; over the
cap the route falls back to the free autopilot. No DB or LLM needed (both stubbed)."""
import json
import os
import sys

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path[:0] = [os.path.join(ROOT, "src"), os.path.join(ROOT, "backend")]
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import agent_routes  # noqa: E402
from agent import investigator  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("RUDRA_LLM_RUNS_PER_HOUR", "2")
    seen = []

    async def fake_run(question, *, graph, graph_tools, mode, run_by):
        seen.append(mode)
        yield {"type": "done", "investigation_id": "INV-T"}

    monkeypatch.setattr(investigator, "run_investigation", fake_run)
    monkeypatch.setattr(investigator, "pick_brain", lambda: {"mode": "gemini", "model": "m", "reasons": {}})
    app = FastAPI()
    agent_routes.register(app, {"falkor": object()}, lambda: None)
    return TestClient(app), seen


def _events(resp):
    return [json.loads(l[6:]) for l in resp.text.splitlines() if l.startswith("data: ")]


def test_cap_falls_back_to_autopilot(client):
    c, seen = client
    for _ in range(3):
        r = c.post("/api/agent/investigate", json={"question": "Investigate incident INC-1"})
        assert r.status_code == 200
    assert seen == [None, None, "playbook"]
    assert _events(r)[0]["type"] == "thinking"


def test_playbook_runs_do_not_use_the_budget(client):
    c, seen = client
    for _ in range(3):
        c.post("/api/agent/investigate", json={"question": "q", "mode": "playbook"})
    c.post("/api/agent/investigate", json={"question": "q"})
    assert seen[-1] is None
