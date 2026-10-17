"""Investigation agent contract: event stream shape, MCP discovery, decision
trace persistence, policy gating, and the graph-tools-off removal test.

The LLM is replaced by a scripted fake client, so this runs with no API key.
Needs FalkorDB (skips otherwise); uses graph `rudra_agent_test`.
"""
import asyncio
import os
import sys
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

pytest.importorskip("falkordb")
pytest.importorskip("mcp")

from graphdb.client import connect_from_env, is_reachable  # noqa: E402

if not is_reachable():
    pytest.skip("FalkorDB not reachable", allow_module_level=True)

from falkor_fixture import FIXTURE  # noqa: E402
from graphdb import queries as Q  # noqa: E402
from graphdb.schema import ensure_schema  # noqa: E402

GRAPH = "rudra_agent_test"


@pytest.fixture(scope="module")
def g():
    os.environ["FALKORDB_GRAPH"] = GRAPH
    from mcp_server import server
    server._graph = None
    db, graph = connect_from_env(GRAPH)
    try:
        graph.delete()
    except Exception:
        pass
    graph = db.select_graph(GRAPH)
    graph.query(FIXTURE)
    Q.apply_fx(graph)
    ensure_schema(graph)
    yield graph
    graph.delete()
    server._graph = None
    os.environ.pop("FALKORDB_GRAPH", None)


def _tool(name, i, **inp):
    return NS(type="tool_use", name=name, input=inp, id=f"tu_{i}")


class FakeClient:
    """Plays back a fixed sequence of assistant turns; records what it was sent."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.calls = []
        self.messages = self

    async def create(self, **kw):
        self.calls.append(kw)
        content = self.turns.pop(0)
        return NS(content=content, usage=NS(input_tokens=100, output_tokens=20, cache_read_input_tokens=0))


def _collect(gen):
    async def go():
        return [e async for e in gen]
    return asyncio.run(go())


def test_llm_loop_contract(g):
    from agent.investigator import run_investigation
    from agent.runners import DirectToolRunner
    fake = FakeClient([
        [NS(type="text", text="Looking at the incident."), _tool("get_incident", 1, incident_id="INC-T1")],
        [_tool("find_cycles", 2, account_id="A")],
        [_tool("record_finding", 3, claim="A->B->C->A round trip", provenance="GRAPH",
               account_ids=["A", "B", "C"], tids=[1, 2, 3], confidence=0.9)],
        [_tool("propose_action", 4, action="escalate", rationale="closed loop, tier-1")],
        [_tool("submit_verdict", 5, verdict="ESCALATE", confidence=0.88, summary="Account A sends funds to B, B forwards to C and C returns them to A within hours (tids 1, 2, 3): a round trip.")],
    ])
    events = _collect(run_investigation("Investigate incident INC-T1", graph=g, runner=DirectToolRunner(),
                                        mode="llm", client=fake))
    types = [e["type"] for e in events]
    assert types[0] == "mcp" and types[-1] == "done" and "verdict" in types
    mcp = events[0]
    assert "find_cycles" in mcp["tools"] and mcp["transport"] == "in-process"

    # tools sent to Claude: no hidden investigation_id, submit_verdict present, cache_control on last tool
    sent = fake.calls[0]["tools"]
    names = [t["name"] for t in sent]
    assert "submit_verdict" in names and "trace_funds" in names
    rf = [t for t in sent if t["name"] == "record_finding"][0]
    assert "investigation_id" not in rf["input_schema"]["properties"]
    assert sent[-1].get("cache_control") == {"type": "ephemeral"}

    steps = [e for e in events if e["type"] == "step"]
    assert [s["tool"] for s in steps] == ["get_incident", "find_cycles", "record_finding", "propose_action"]
    cyc = steps[1]
    assert "MATCH" in cyc["cypher"] and cyc["metrics"]["cycle_found"] and set(cyc["tids"]) >= {1, 2, 3}

    v = [e for e in events if e["type"] == "verdict"][0]
    assert v["verdict"] == "ESCALATE" and v["typology"] == "Circular Transaction"
    assert len(v["findings"]) == 1 and v["findings"][0]["provenance"] == "GRAPH"
    assert v["decisions"][0]["action"] == "escalate" and v["decisions"][0]["status"] == "proposed"
    assert "".join(e["text"] for e in events if e["type"] == "token") == "Account A sends funds to B, B forwards to C and C returns them to A within hours (tids 1, 2, 3): a round trip."

    tr = Q.investigation_trace(g, v["investigation_id"])
    assert len(tr["steps"]) == 4 and tr["status"] == "complete" and "A" in tr["about"]


def test_forced_verdict_on_last_round(g):
    """Last round forces submit_verdict; a junk verdict with no findings is sent back once."""
    from agent.investigator import run_investigation
    from agent.runners import DirectToolRunner
    fake = FakeClient([[_tool("account_profile", 1, account_id="A")],
                       [_tool("submit_verdict", 2, verdict="REVIEW", confidence=0.4, summary="Need more.")],
                       [_tool("submit_verdict", 3, verdict="REVIEW", confidence=0.4,
                              summary="Profile of A shows flagged activity but no traversal was run, so this needs analyst review.")]])
    events = _collect(run_investigation("Is A a mule?", graph=g, runner=DirectToolRunner(),
                                        mode="llm", client=fake, max_rounds=2))
    assert fake.calls[1]["tool_choice"] == {"type": "tool", "name": "submit_verdict"}
    assert any(e["type"] == "thinking" and e["text"].startswith("Verdict sent back") for e in events)
    v = [e for e in events if e["type"] == "verdict"][0]
    assert v["verdict"] == "REVIEW" and v["grounding"]["graph_findings"] == 0 and v["confidence"] <= 0.5


def test_removal_mode_llm_cannot_escalate_without_graph_evidence(g):
    """The removal test holds for an LLM brain: a confident ESCALATE claim with
    graph tools off is grounded down to REVIEW <= 0.5."""
    from agent.investigator import run_investigation
    from agent.runners import DirectToolRunner
    fake = FakeClient([
        [_tool("get_incident", 1, incident_id="INC-T1")],
        [_tool("record_finding", 2, claim="Incident has a tier-1 alert", provenance="RULE", alert_ids=["AL1"])],
        [_tool("propose_action", 3, action="escalate", rationale="tier-1")],
        [_tool("submit_verdict", 4, verdict="ESCALATE", confidence=0.95,
               summary="Incident INC-T1 has a tier-1 round-trip alert AL1 flagging A, B and C; escalate it now.")],
    ])
    events = _collect(run_investigation("Investigate incident INC-T1", graph=g, runner=DirectToolRunner(),
                                        mode="llm", client=fake, graph_tools=False))
    v = [e for e in events if e["type"] == "verdict"][0]
    assert v["grounding"]["claimed_verdict"] == "ESCALATE"
    assert v["verdict"] == "REVIEW" and v["confidence"] <= 0.5 and v["grounding"]["adjusted"]


def test_removal_mode_hides_graph_tools(g):
    from agent.investigator import run_investigation
    from agent.runners import DirectToolRunner
    fake = FakeClient([[_tool("find_cycles", 1, account_id="A")],
                       [_tool("submit_verdict", 2, verdict="UNCERTAIN", confidence=0.2, summary="Cannot trace.")]])
    events = _collect(run_investigation("Investigate incident INC-T1", graph=g, runner=DirectToolRunner(),
                                        mode="llm", client=fake, graph_tools=False))
    assert "find_cycles" not in events[0]["tools"] and not events[0]["graph_tools"]
    assert "find_cycles" not in [t["name"] for t in fake.calls[0]["tools"]]
    step = [e for e in events if e["type"] == "step"][0]
    assert "disabled" in (step["error"] or "")


def test_playbook_autopilot_follows_graph_playbook(g):
    from agent.investigator import run_investigation
    from agent.runners import DirectToolRunner
    events = _collect(run_investigation("Investigate incident INC-T1", graph=g, runner=DirectToolRunner(),
                                        mode="playbook"))
    tools = [e["tool"] for e in events if e["type"] == "step"]
    assert tools[:2] == ["get_incident", "record_finding"]
    assert "get_playbook" in tools and "find_cycles" in tools          # sequence came from (:Playbook)
    v = [e for e in events if e["type"] == "verdict"][0]
    assert v["verdict"] == "ESCALATE"
    assert any(d["action"] in ("escalate", "draft_str") for d in v["decisions"])

    flat = _collect(run_investigation("Investigate incident INC-T1", graph=g, runner=DirectToolRunner(),
                                      mode="playbook", graph_tools=False))
    ftools = [e["tool"] for e in flat if e["type"] == "step"]
    assert "find_cycles" not in ftools and "get_playbook" not in ftools
    fv = [e for e in flat if e["type"] == "verdict"][0]
    assert not any(f["provenance"] == "GRAPH" for f in fv["findings"])


def test_mcp_stdio_discovery(g):
    """Real MCP round-trip: spawn the server, list tools, call one."""
    from agent.runners import MCPToolRunner

    async def go():
        async with MCPToolRunner(env={"FALKORDB_GRAPH": GRAPH}) as r:
            names = {t.name for t in r.tools}
            env = await r.call("find_cycles", {"account_id": "A"})
            return names, env
    names, env = asyncio.run(go())
    assert {"trace_funds", "find_cycles", "propose_action", "find_precedents"} <= names
    assert env["metrics"]["cycle_found"] and env["data"][0]["tids"] == [1, 2, 3]


def test_autopilot_follows_graph_leads_across_accounts(g):
    """No-LLM brain is graph-driven: results nominate next accounts, a relevance
    gate filters them, and more than one account is investigated."""
    from agent.investigator import run_investigation
    from agent.runners import DirectToolRunner
    events = _collect(run_investigation("Investigate incident INC-T1", graph=g, runner=DirectToolRunner(),
                                        mode="playbook"))
    thinking = [e["text"] for e in events if e["type"] == "thinking"]
    assert any(t.startswith("Next lead:") for t in thinking), thinking
    assert any(t.startswith("Following ") for t in thinking)          # B or C carry alert AL1 -> followed
    v = [e for e in events if e["type"] == "verdict"][0]
    assert len(v["key_accounts"]) >= 2
    assert any(f["claim"].startswith("Followed the money to") for f in v["findings"])


def test_relevance_gate_drops_clean_accounts():
    from agent.autopilot import _relevant
    assert _relevant({"alerts": [], "max_ml_score": 0.1, "labelled_fraud_txns": 0})[0] is False
    assert _relevant({"alerts": [{"alert_id": "x"}], "max_ml_score": 0, "labelled_fraud_txns": 0})[0] is True
    assert _relevant({"alerts": [], "max_ml_score": 0.6, "labelled_fraud_txns": 0})[0] is True
    assert _relevant(None)[0] is False


class FakeGemini:
    """Mimics client.aio.models.generate_content; records configs it was sent."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.configs = []
        self.aio = self
        self.models = self

    async def generate_content(self, model, contents, config):
        self.configs.append(config)
        parts = self.turns.pop(0)
        return NS(candidates=[NS(content=NS(role="model", parts=parts))],
                  usage_metadata=NS(prompt_token_count=50, candidates_token_count=10, cached_content_token_count=0))


def _fc(name, **args):
    return NS(function_call=NS(name=name, args=args), text=None, thought=False)


def test_gemini_loop_contract(g):
    pytest.importorskip("google.genai")
    from agent import gemini_brain
    from agent.investigator import _Session, _step_event, _truncate_for_model, SUBMIT_VERDICT, SYSTEM_PROMPT
    from agent.runners import DirectToolRunner
    fake = FakeGemini([
        [NS(function_call=None, text="Checking the incident.", thought=False), _fc("get_incident", incident_id="INC-T1")],
        [_fc("find_cycles", account_id="A")],
        [_fc("record_finding", claim="A->B->C->A", provenance="GRAPH", account_ids=["A", "B", "C"], tids=[1, 2, 3])],
        [_fc("propose_action", action="monitor", rationale="watch the ring", account_ids=["B", "C"])],
        [_fc("submit_verdict", verdict="ESCALATE", confidence=0.85, summary="Account A sends funds to B, B forwards to C and C returns them to A within hours (tids 1, 2, 3): a round trip.")],
    ])

    async def go():
        iid = Q.create_investigation(g, "gemini contract")
        async with DirectToolRunner() as r:
            sess = _Session(g, r, iid, None)
            return [e async for e in gemini_brain.gemini_loop(
                sess, "Investigate incident INC-T1", True, None, 6, SYSTEM_PROMPT.format(iid=iid, schema=Q.SCHEMA_PROMPT),
                SUBMIT_VERDICT, _step_event, _truncate_for_model, client=fake)]
    events = asyncio.run(go())
    steps = [e for e in events if e["type"] == "step"]
    assert [s["tool"] for s in steps] == ["get_incident", "find_cycles", "record_finding", "propose_action"]
    assert steps[1]["metrics"]["cycle_found"] and "MATCH" in steps[1]["cypher"]
    assert steps[3]["preview"]["status"] == "executed"                    # tiered autonomy through Gemini too
    decls = fake.configs[0].tools[0].function_declarations
    names = {d.name for d in decls}
    assert "submit_verdict" in names and "trace_funds" in names
    rf = [d for d in decls if d.name == "record_finding"][0]
    assert "investigation_id" not in rf.parameters_json_schema["properties"]
    v = [e for e in events if e["type"] == "_verdict"][0]["verdict"]
    assert v["verdict"] == "ESCALATE"
    assert any(e["type"] == "thinking" and "incident" in e["text"] for e in events)


def test_gemini_schema_cleaning():
    from agent.gemini_brain import _clean_schema
    s = _clean_schema({"type": "object", "title": "x", "properties": {
        "typology": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None, "title": "T"}}})
    assert s["properties"]["typology"]["type"] == "string" and "title" not in s


def test_lazy_model_gets_auto_findings_and_grounded_summary(g):
    """A model that runs graph tools but records nothing and submits 'test' still
    leaves a checkable trace: findings are auto-recorded from tool output and the
    summary is rebuilt from them."""
    from agent.investigator import run_investigation
    from agent.runners import DirectToolRunner
    fake = FakeClient([[_tool("find_cycles", 1, account_id="A")],
                       [_tool("submit_verdict", 2, verdict="ESCALATE", confidence=0.95, summary="test")],
                       [_tool("submit_verdict", 3, verdict="ESCALATE", confidence=0.95, summary="test")]])
    events = _collect(run_investigation("Investigate incident INC-T1", graph=g, runner=DirectToolRunner(),
                                        mode="llm", client=fake))
    v = [e for e in events if e["type"] == "verdict"][0]
    assert any(f["claim"].startswith("[auto-recorded") and f["tids"] for f in v["findings"])
    assert v["summary"].startswith("Grounded summary")
    assert v["grounding"]["notes"] and v["grounding"]["graph_findings"] >= 1
    assert v["verdict"] == "REVIEW"   # graph evidence, but no policy-endorsed escalation was proposed
