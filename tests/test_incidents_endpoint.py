"""queries.incident_list (GET /api/agent/incidents): the Incidents triage list -
filters, facets, sorts, search and pagination - against a small fixture graph.

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

from falkor_fixture import FIXTURE  # noqa: E402

GRAPH = "rudra_incidents_test"

# Two more incidents next to the fixture's INC-T1 (A->B->C->A cycle, CRITICAL, 2 alerts).
EXTRA = """
MATCH (d:Account {id:'D'}), (e:Account {id:'E'})
CREATE
 (al3:Alert {alert_id:'AL3', pattern_type:'ML-Detected Anomaly', severity:'HIGH', tier:2, ml_score:0.99,
             total_flow:260000.0, description:'ML anomaly on D->E'}),
 (al4:Alert {alert_id:'AL4', pattern_type:'Profile Mismatch', severity:'MEDIUM', tier:3, ml_score:0.10,
             total_flow:10.0, description:'Profile mismatch on E'}),
 (al3)-[:FLAGS]->(d), (al3)-[:FLAGS]->(e), (al4)-[:FLAGS]->(e),
 (i2:Incident {incident_id:'INC-T2', primary_pattern:'ML-Detected Anomaly', severity:'HIGH',
               total_flow:260000.0, alert_count:1, n_entities:2}),
 (i3:Incident {incident_id:'INC-X3', primary_pattern:'Profile Mismatch', severity:'MEDIUM',
               total_flow:10.0, alert_count:1, n_entities:1}),
 (i2)-[:CONTAINS]->(al3), (i3)-[:CONTAINS]->(al4)
"""


@pytest.fixture(scope="module")
def g():
    db, graph = connect_from_env(GRAPH)
    try:
        graph.delete()
    except Exception:
        pass
    graph = db.select_graph(GRAPH)
    graph.query(FIXTURE)
    graph.query(EXTRA)
    Q.apply_fx(graph)
    yield graph
    graph.delete()


def ids(r):
    return [i["incident_id"] for i in r["items"]]


def test_shape_and_default_usd_sort(g):
    r = Q.incident_list(g)
    json.dumps(r)
    assert r["total"] == 3 and len(r["items"]) == 3
    assert set(r) >= {"items", "total", "patterns", "severities"}
    it = {i["incident_id"]: i for i in r["items"]}
    assert set(it["INC-T1"]) >= {"incident_id", "primary_pattern", "severity", "total_flow_usd",
                                 "alert_count", "n_entities", "top_tier", "max_ml_score"}
    # INC-T1 has a tier-1 and a tier-2 alert -> top tier 1; max ml 0.91
    assert it["INC-T1"]["top_tier"] == 1 and it["INC-T1"]["max_ml_score"] == pytest.approx(0.91)
    assert it["INC-X3"]["top_tier"] == 3
    usd = [i["total_flow_usd"] for i in r["items"]]
    assert usd == sorted(usd, reverse=True)
    assert ids(r)[0] == "INC-T1"  # the cycle moves the most money
    assert {s["severity"]: s["count"] for s in r["severities"]} == {"CRITICAL": 1, "HIGH": 1, "MEDIUM": 1}
    assert [s["severity"] for s in r["severities"]] == ["CRITICAL", "HIGH", "MEDIUM"]
    assert {p["pattern"]: p["count"] for p in r["patterns"]} == {
        "Circular Transaction": 1, "ML-Detected Anomaly": 1, "Profile Mismatch": 1}


def test_other_sorts(g):
    assert ids(Q.incident_list(g, sort="ml"))[0] == "INC-T2"
    assert ids(Q.incident_list(g, sort="alerts"))[0] == "INC-T1"
    assert ids(Q.incident_list(g, sort="bogus")) == ids(Q.incident_list(g))  # falls back to usd


def test_filters_and_facets_respect_other_filters(g):
    r = Q.incident_list(g, severity="high")
    assert ids(r) == ["INC-T2"] and r["total"] == 1
    # severity facet ignores the severity filter itself, pattern facet honours it
    assert len(r["severities"]) == 3
    assert r["patterns"] == [{"pattern": "ML-Detected Anomaly", "count": 1}]
    r = Q.incident_list(g, pattern="Profile Mismatch")
    assert ids(r) == ["INC-X3"]
    assert r["severities"] == [{"severity": "MEDIUM", "count": 1}]
    assert Q.incident_list(g, severity="CRITICAL", pattern="Profile Mismatch")["total"] == 0


def test_search_by_incident_id_and_account(g):
    assert sorted(ids(Q.incident_list(g, q="inc-t"))) == ["INC-T1", "INC-T2"]
    assert ids(Q.incident_list(g, q="X3")) == ["INC-X3"]
    # E is flagged by AL3 (INC-T2) and AL4 (INC-X3)
    assert sorted(ids(Q.incident_list(g, q="E"))) == ["INC-T2", "INC-X3"]
    assert ids(Q.incident_list(g, q="A")) == ["INC-T1"]
    r = Q.incident_list(g, q="no-such-thing")
    assert r["total"] == 0 and r["items"] == [] and r["severities"] == []
    assert ids(Q.incident_list(g, q="E", severity="MEDIUM")) == ["INC-X3"]


def test_pagination_and_clamping(g):
    p1 = Q.incident_list(g, limit=2, offset=0)
    p2 = Q.incident_list(g, limit=2, offset=2)
    assert len(p1["items"]) == 2 and len(p2["items"]) == 1
    assert p1["total"] == p2["total"] == 3
    assert not set(ids(p1)) & set(ids(p2))
    r = Q.incident_list(g, limit=10_000, offset=-5)
    assert r["limit"] == 200 and r["offset"] == 0 and len(r["items"]) == 3
    # the injected-number path never reaches Cypher as text
    assert Q.incident_list(g, limit="1; DROP", offset="x")["limit"] == 50


def test_http_endpoint(g):
    """GET /api/agent/incidents through agent_routes.register on a bare app."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
    import agent_routes

    app = FastAPI()
    agent_routes.register(app, {"falkor": g}, lambda: None)
    c = TestClient(app)
    r = c.get("/api/agent/incidents", params={"severity": "CRITICAL", "sort": "ml", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1 and body["items"][0]["incident_id"] == "INC-T1"
    assert c.get("/api/agent/incidents", params={"sort": "nope"}).status_code == 400
    assert c.get("/api/agent/incidents", params={"limit": 0}).status_code == 422
