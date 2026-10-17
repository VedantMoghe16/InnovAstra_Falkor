"""queries.inbox: the Today home screen read (pending agent proposals,
recent investigations, headline counts) against a small fixture graph.

Skips cleanly when FalkorDB is not reachable.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

falkordb = pytest.importorskip("falkordb")

from graphdb.client import connect_from_env, is_reachable  # noqa: E402

if not is_reachable():
    pytest.skip("FalkorDB not reachable (set FALKORDB_HOST/PORT)", allow_module_level=True)

from graphdb import queries as Q  # noqa: E402
from agent import actions as A  # noqa: E402

from falkor_fixture import FIXTURE  # noqa: E402

GRAPH = "rudra_inbox_test"


@pytest.fixture(scope="module")
def g():
    db, graph = connect_from_env(GRAPH)
    try:
        graph.delete()
    except Exception:
        pass
    graph = db.select_graph(GRAPH)
    graph.query(FIXTURE)
    Q.apply_fx(graph)
    yield graph
    graph.delete()


def test_empty_inbox_shape(g):
    box = Q.inbox(g)
    json.dumps(box)
    assert box["pending_decisions"] == [] and box["recent_investigations"] == []
    c = box["counts"]
    assert set(c) == {"open_incidents", "pending_decisions", "investigations_7d", "accounts", "transactions"}
    assert c["accounts"] >= 6 and c["transactions"] >= 1 and c["open_incidents"] >= 1
    assert c["pending_decisions"] == 0 and c["investigations_7d"] == 0


def test_proposed_escalation_appears_then_leaves_on_review(g):
    iid = Q.create_investigation(g, "Investigate INC-T1", account_ids=["A"], typology="Circular Transaction")
    Q.write_tool_call(g, iid, 1, Q.find_cycles(g, "A"), {"account_id": "A"})
    f = A.record_finding(g, iid, "A->B->C->A round-trips", "GRAPH", ["A", "B", "C"], [1, 2, 3], ["AL1"], 0.9)
    esc = A.propose_action(g, iid, "escalate", "closed loop", [f["data"]["finding_id"]])
    assert esc["data"]["status"] == "proposed"
    Q.finish_investigation(g, iid, {"verdict": "ESCALATE", "confidence": 0.9, "summary": "cycle"})

    box = Q.inbox(g)
    json.dumps(box)
    did = esc["data"]["decision_id"]
    items = {p["decision_id"]: p for p in box["pending_decisions"]}
    assert did in items
    p = items[did]
    assert p["investigation_id"] == iid and p["question"] == "Investigate INC-T1"
    assert p["verdict"] == "ESCALATE" and p["action_requested"] == "escalate" and p["action_final"] == "escalate"
    assert p["policy_rule"] and set(p["accounts"]) == {"A", "B", "C"} and len(p["accounts"]) <= 5
    assert box["counts"]["pending_decisions"] >= 1 and box["counts"]["investigations_7d"] >= 1
    assert box["recent_investigations"][0]["id"] == iid

    Q.review_decision(g, did, approve=True, reviewer_role="SUPERVISOR")
    assert did not in {p["decision_id"] for p in Q.inbox(g)["pending_decisions"]}
