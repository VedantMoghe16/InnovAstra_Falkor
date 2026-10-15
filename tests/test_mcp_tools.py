"""Graph tool catalogue (src/graphdb/queries.py) + policy-gated actions,
against a small fixture graph in FalkorDB graph `rudra_test`.

Skips cleanly when FalkorDB is not reachable (same spirit as the torch SKIP
sentinel in test_gnn_model.py).
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
from graphdb.schema import ensure_schema  # noqa: E402
from agent import actions as A  # noqa: E402

from falkor_fixture import FIXTURE  # noqa: E402


@pytest.fixture(scope="module")
def g():
    db, graph = connect_from_env("rudra_test")
    try:
        graph.delete()
    except Exception:
        pass
    graph = db.select_graph("rudra_test")
    graph.query(FIXTURE)
    ensure_schema(graph, fulltext=True)
    yield graph
    graph.delete()


def _json_ok(env):
    json.dumps(env)  # must be serialisable for MCP
    assert {"tool", "data", "cypher", "rows", "ms", "provenance"} <= env.keys()
    return env


def test_schema(g):
    env = _json_ok(Q.get_graph_schema(g))
    labels = {r["label"] for r in env["data"]["labels"]}
    assert {"Account", "Alert", "Incident"} <= labels


def test_incident_and_profile(g):
    env = _json_ok(Q.get_incident(g, "INC-T1"))
    assert env["rows"] == 1 and len(env["data"][0]["alerts"]) == 2
    assert env["metrics"]["min_tier"] == 1
    p = _json_ok(Q.account_profile(g, "C"))
    assert p["data"][0]["out_n"] == 2 and p["data"][0]["in_n"] == 1
    assert {a["alert_id"] for a in p["data"][0]["alerts"]} == {"AL1", "AL2"}
    assert Q.account_profile(g, "NOPE")["rows"] == 0


def test_trace_is_temporal_and_amount_preserving(g):
    env = _json_ok(Q.trace_funds(g, "A", max_hops=4, window_hours=1))
    paths = [r["path"] for r in env["data"]]
    assert ["A", "B", "C", "D", "E"] in paths           # money keeps moving forward in time
    assert not any(p[:2] == ["B", "E"] for p in paths)   # tiny hop dropped by amount preservation
    longest = env["data"][0]
    ts = [h["ts"] for h in longest["hops"]]
    assert ts == sorted(ts)
    assert env["metrics"]["trace_hops"] == 4
    back = Q.trace_funds(g, "E", direction="backward", max_hops=4, window_hours=1)
    assert ["E", "D", "C", "B", "A"] in [r["path"] for r in back["data"]]


def test_cycles_in_order(g):
    env = _json_ok(Q.find_cycles(g, "A", max_len=5))
    assert env["metrics"]["cycle_found"]
    c = env["data"][0]
    assert c["cycle"] == ["A", "B", "C", "A"] and c["tids"] == [1, 2, 3]
    assert c["total_flow"] == pytest.approx(870000.0)
    assert not Q.find_cycles(g, "D")["metrics"]["cycle_found"]


def test_neighbourhood_path_and_algorithms(g):
    k = _json_ok(Q.k_hop_neighbourhood(g, "A", k=1))
    assert {r["account"] for r in k["data"]} == {"B", "C"}
    sp = _json_ok(Q.shortest_path(g, "A", "E"))
    assert sp["data"][0]["path"] == ["A", "B", "E"]
    assert Q.shortest_path(g, "E", "A")["metrics"]["connected"] is False
    pr = _json_ok(Q.pagerank_hubs(g, limit=3))
    assert pr["rows"] == 3
    com = _json_ok(Q.community_of(g, "A"))
    assert com["data"][0]["size"] == 5


def test_identity_ring_transitive(g):
    env = _json_ok(Q.shared_identifier_ring(g, "ACC1"))
    assert env["metrics"]["ring_size"] == 3          # ACC1 -dev- ACC2 -kyc- ACC3
    assert {m["account"] for m in env["data"][0]["members"]} == {"ACC2", "ACC3"}


def test_readonly_guard(g):
    assert "error" in Q.run_cypher_readonly(g, "CREATE (n:X) RETURN n")["data"]
    assert "error" in Q.run_cypher_readonly(g, "MATCH (n) SET n.x = 1 RETURN n")["data"]
    ok = Q.run_cypher_readonly(g, "MATCH (a:Account) RETURN count(a) AS n")
    assert ok["data"][0]["n"] >= 6 and ok["cypher"].endswith("LIMIT 50")


def test_search_and_playbook(g):
    assert _json_ok(Q.search_alerts(g, "cycle"))["rows"] >= 1
    pb = _json_ok(Q.get_playbook(g, "Circular Transaction"))
    assert pb["data"][0]["tool_sequence"] == ["find_cycles"]
    assert Q.get_playbook(g, "nonexistent")["data"][0]["typology"] == "ML-Detected Anomaly"


def test_decision_trace_policy_and_precedent(g):
    iid = Q.create_investigation(g, "Investigate INC-T1", account_ids=["A"], typology="Circular Transaction")
    env = Q.find_cycles(g, "A")
    Q.write_tool_call(g, iid, 1, env, {"account_id": "A"})
    f = A.record_finding(g, iid, "A->B->C->A round-trips 8.7 lakh", "GRAPH", ["A", "B", "C"], [1, 2, 3, 999999], ["AL1"], 0.9)
    assert f["data"]["tids_verified"] == 3 and f["data"]["unverified_tids"] == [999999]

    # floor safety
    deny = A.propose_action(g, iid, "close", "looks fine")
    assert deny["data"]["status"] == "denied"
    # tier-1 alert flags the cited accounts -> escalate allowed
    esc = A.propose_action(g, iid, "escalate", "closed loop", [f["data"]["finding_id"]])
    assert esc["data"]["action_final"] == "escalate" and esc["data"]["status"] == "proposed"
    assert esc["data"]["evidence_used"]["cycle_found"] is True
    # GRAPH finding + CRITICAL -> STR draft allowed, filled from the trace
    s = A.draft_str(g, iid, "Round-tripping through a shell.")
    assert s["data"]["action_final"] == "draft_str"
    assert "STR-" + iid in s["data"]["draft_preview"]

    Q.finish_investigation(g, iid, {"verdict": "ESCALATE", "confidence": 0.9, "summary": "cycle"})
    tr = Q.investigation_trace(g, iid)
    assert tr["verdict"] == "ESCALATE" and len(tr["steps"]) == 1 and len(tr["findings"]) == 1
    assert len(tr["decisions"]) == 3

    # human rejects the escalation -> it becomes a precedent that holds the next run at monitor
    rv = Q.review_decision(g, esc["data"]["decision_id"], approve=False, reviewer_role="SUPERVISOR", note="known payroll loop")
    assert rv["status"] == "rejected" and "A" in rv["accounts"]
    assert Q.review_decision(g, esc["data"]["decision_id"], True, "SUPERVISOR") == {}  # already reviewed

    prec = Q.find_precedents(g, "C")
    assert prec["rows"] >= 1 and prec["data"][0]["investigation"] == iid

    iid2 = Q.create_investigation(g, "Re-check A", account_ids=["A"])
    A.record_finding(g, iid2, "cycle again", "GRAPH", ["A"], [1], [], 0.9)
    held = A.propose_action(g, iid2, "escalate", "cycle")
    assert held["data"]["action_final"] == "monitor"
    assert held["data"]["policy_rule"] == "P4_precedent_conflict"


def test_subgraph_and_listing(g):
    sg = Q.subgraph_for(g, ["A", "B", "C"], [4])
    assert {n["id"] for n in sg["nodes"]} >= {"A", "B", "C", "D"}
    assert any(link["cited"] for link in sg["links"])
    assert isinstance(Q.list_investigations(g), list)
    st = Q.status(g)
    assert st["labels"]["Account"] >= 6


def test_temporal_cycle_found_from_any_entry_point(g):
    # A->B->C->A is time-ordered from A; entering at B or C must still find it.
    for start in ("A", "B", "C"):
        env = Q.find_cycles(g, start, max_len=5)
        assert env["metrics"]["cycle_found"], start
        assert env["data"][0]["span_hours"] >= 0


def test_graph_algorithms_run_inside_falkordb(g):
    env = Q.refresh_graph_analytics(g)
    algos = {r["algorithm"]: r["accounts"] for r in env["data"]}
    assert set(algos) == {"pagerank", "wcc", "label_propagation"} and min(algos.values()) >= 6
    assert "algo.pageRank" in env["cypher"] and "algo.WCC" in env["cypher"]
    pr = g.ro_query("MATCH (a:Account {id:'A'}) RETURN a.pr, a.community, a.lp_community").result_set[0]
    assert pr[0] > 0 and pr[1] is not None and pr[2] is not None
    com = Q.community_of(g, "A")["data"][0]
    assert com["wcc_component_size"] == 5


def test_autonomous_watchlist_and_learned_review_status(g):
    iid = Q.create_investigation(g, "watch", account_ids=["D"])
    env = A.propose_action(g, iid, "monitor", "funds landed here", account_ids=["D", "E"])
    assert env["data"]["status"] == "executed"
    assert env["data"]["executed"] == {"watchlist": "enhanced-monitoring", "accounts_placed": 2}
    prof = Q.account_profile(g, "D")["data"][0]
    assert "enhanced-monitoring" in prof["watchlists"]

    # supervisor approves an escalation -> the cited accounts carry that knowledge forward
    # (D/E have no earlier human rejection; the ML basis comes from a recorded tool result)
    iid2 = Q.create_investigation(g, "esc", account_ids=["D"])
    Q.write_tool_call(g, iid2, 1, {"tool": "account_profile", "metrics": {"max_ml_score": 0.95}}, {})
    A.record_finding(g, iid2, "D -> E layering", "GRAPH", ["D", "E"], [5], [], 0.9)
    esc = A.propose_action(g, iid2, "escalate", "layering")
    assert esc["data"]["action_final"] == "escalate"
    Q.review_decision(g, esc["data"]["decision_id"], True, "SUPERVISOR")
    assert Q.account_profile(g, "E")["data"][0]["review_status"] == "confirmed_suspicious"
    iid3 = Q.create_investigation(g, "later", account_ids=["E"])
    A.record_finding(g, iid3, "E again", "INFERRED", ["E"], [], [], 0.3)
    ev = Q.gather_policy_evidence(g, iid3)
    assert ev["confirmed_accounts"] >= 1
    assert A.propose_action(g, iid3, "escalate", "known")["data"]["action_final"] == "escalate"


def test_decision_trail_graph(g):
    iid = Q.create_investigation(g, "trail", account_ids=["D"])
    f = A.record_finding(g, iid, "D pays E", "GRAPH", ["D", "E"], [5], [], 0.8)
    A.propose_action(g, iid, "monitor", "watch", [f["data"]["finding_id"]], account_ids=["E"])
    t = Q.decision_trail(g, iid)
    kinds = {n["kind"] for n in t["nodes"]}
    rels = {l["rel"] for l in t["links"]}
    assert {"investigation", "finding", "account", "decision"} <= kinds
    assert {"FOUND", "SUPPORTED_BY", "IN", "CAUSED_BY", "TARGETS"} <= rels
    ids = {n["id"] for n in t["nodes"]}
    assert all(l["source"] in ids and l["target"] in ids for l in t["links"])
