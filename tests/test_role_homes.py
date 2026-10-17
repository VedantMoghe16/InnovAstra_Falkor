"""Role homes: attribution of who ran / reviewed, investigator 'my work',
supervisor oversight, admin policy log. Graph `rudra_roles_test`; skips
without FalkorDB."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))
pytest.importorskip("falkordb")
from graphdb.client import connect_from_env, is_reachable  # noqa: E402

if not is_reachable():
    pytest.skip("FalkorDB not reachable", allow_module_level=True)

from falkor_fixture import FIXTURE  # noqa: E402
from graphdb import queries as Q  # noqa: E402
from agent import actions as A  # noqa: E402

ASHA = {"email": "investigator@rudra.demo", "name": "Asha Rao", "role": "INVESTIGATOR"}


@pytest.fixture(scope="module")
def g():
    db, graph = connect_from_env("rudra_roles_test")
    try:
        graph.delete()
    except Exception:
        pass
    graph = db.select_graph("rudra_roles_test")
    graph.query(FIXTURE)
    Q.apply_fx(graph)
    yield graph
    graph.delete()


def test_handoff_investigator_to_supervisor(g):
    iid = Q.create_investigation(g, "Investigate incident INC-T1", account_ids=["A"], run_by=ASHA)
    A.record_finding(g, iid, "cycle", "GRAPH", ["A", "B", "C"], [1, 2, 3], ["AL1"], 0.9)
    esc = A.propose_action(g, iid, "escalate", "closed loop")
    A.propose_action(g, iid, "close", "looks fine")          # denied -> policy log
    Q.finish_investigation(g, iid, {"verdict": "ESCALATE", "confidence": 0.8, "summary": "s",
                                    "grounding": {"adjusted": False, "confidence_capped": True}})

    mine = Q.my_work(g, ASHA["email"])
    assert mine["investigations"][0]["id"] == iid
    assert mine["proposal_counts"]["proposed"] == 1

    ov = Q.oversight(g)
    p = [x for x in ov["pending"] if x["decision_id"] == esc["data"]["decision_id"]][0]
    assert p["run_by_name"] == "Asha Rao" and p["age_minutes"] >= 0
    assert any(t["name"] == "Asha Rao" for t in ov["team"])
    assert ov["agent_oversight"]["held_by_policy"] >= 1 and ov["agent_oversight"]["confidence_capped"] >= 1

    Q.review_decision(g, esc["data"]["decision_id"], False, "SUPERVISOR", "known payroll loop", reviewer_name="Vikram Mehta")
    after = Q.my_work(g, ASHA["email"])
    rejected = [x for x in after["proposals"] if x["decision_id"] == esc["data"]["decision_id"]][0]
    assert rejected["status"] == "rejected" and rejected["reviewed_by_name"] == "Vikram Mehta"
    assert rejected["review_note"] == "known payroll loop"
    assert Q.oversight(g)["recent_reviews"][0]["reviewer"] == "Vikram Mehta"

    log = Q.policy_log(g)
    assert any(r["requested"] == "close" and r["status"] == "denied" for r in log)
