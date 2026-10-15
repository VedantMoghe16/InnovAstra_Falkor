"""The Cypher catalogue - every graph tool the investigation agent can call.

Single source of truth shared by the MCP server (agent path) and the backend
(UI reads + human approval). Each read tool returns an *envelope*:

    {tool, data, cypher, params, rows, ms, provenance, metrics, timed_out?}

`cypher` is the exact query executed (shown live in the UI), `ms` is FalkorDB's
own reported run time, and `metrics` carries the few numbers the policy engine
reasons over (cycle_found, ring_size, ...).

FalkorDB notes baked in here (verified on falkordb 4.22 / v6):
  * variable-length bounds must be literals -> hop counts are clamped ints
    formatted into the string, never user text;
  * a path that closes on its own start node reports nodes(p) reversed, so
    cycles are matched as (a)-[*]->(x)-[last]->(a), which keeps order intact;
  * read tools use GRAPH.RO_QUERY with a per-query timeout.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Sequence

READ_TIMEOUT_MS = 5000
SEV_RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}
PROVENANCE = ("GRAPH", "ML", "RULE", "PRECEDENT", "INFERRED")


# -- helpers -------------------------------------------------------------------

def _clean(cypher: str) -> str:
    return re.sub(r"\n\s*\n", "\n", cypher.strip("\n")).rstrip()


def _clamp(v, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _jsonable(v: Any) -> Any:
    """FalkorDB Node/Edge/Path -> plain dicts so envelopes survive json.dumps."""
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if hasattr(v, "labels") and hasattr(v, "properties"):          # Node
        return {"_labels": list(v.labels or []), **_jsonable(v.properties)}
    if hasattr(v, "relation") and hasattr(v, "properties"):        # Edge
        return {"_type": v.relation, **_jsonable(v.properties)}
    if hasattr(v, "nodes") and hasattr(v, "edges"):                # Path
        return {"nodes": _jsonable(v.nodes()), "edges": _jsonable(v.edges())}
    return str(v)


def _run(graph, cypher: str, params: Optional[Dict] = None, write: bool = False,
         timeout: int = READ_TIMEOUT_MS):
    """Execute and return (rows-as-dicts, ms, timed_out)."""
    try:
        if write:
            res = graph.query(cypher, params or {})
        else:
            res = graph.ro_query(cypher, params or {}, timeout=timeout)
    except Exception as e:  # noqa: BLE001 - surface DB errors to the agent
        msg = str(e)
        if "timed out" in msg.lower() or "timeout" in msg.lower():
            return [], float(timeout), True
        raise
    header = [h[1] if isinstance(h, (list, tuple)) else h for h in (res.header or [])]
    header = [h.decode() if isinstance(h, bytes) else str(h) for h in header]
    rows = [dict(zip(header, [_jsonable(c) for c in r])) for r in res.result_set]
    return rows, float(res.run_time_ms or 0.0), False


def envelope(tool: str, cypher: str, params: Dict, rows: List[Dict], ms: float,
             data: Any = None, provenance: str = "GRAPH", metrics: Optional[Dict] = None,
             timed_out: bool = False, note: str = "") -> Dict:
    env = {"tool": tool, "data": rows if data is None else data, "cypher": _clean(cypher),
           "params": params, "rows": len(rows), "ms": round(ms, 2), "provenance": provenance,
           "metrics": metrics or {}}
    if timed_out:
        env["timed_out"] = True
        env["note"] = (note + " " if note else "") + "Query hit the timeout; narrow it (fewer hops / higher min_amount)."
    elif note:
        env["note"] = note
    return env


# -- schema / discovery --------------------------------------------------------

SCHEMA_DOC = {
    "evidence_layer": {
        "(:Account)": "id, name, type (individual|business|shell_company), branch, risk_score, risk_level, pr (algo.pageRank), community (algo.WCC id), lp_community (algo.labelPropagation id), source (ibm|identity), is_mule",
        "(:Account)-[:TXN]->(:Account)": "one edge per transaction: tid (int), ts (epoch s), amount, rail, currency, is_fraud (IBM label), ml_score (pair-level stacked-ensemble fraud score 0-1)",
        "(:Alert)-[:FLAGS]->(:Account)": "alert_id, pattern_type, severity, confidence, tier (1=ML+rule agree, 2=ML only, 3=rule), ml_score, total_flow, description",
        "(:Incident)-[:CONTAINS]->(:Alert)": "incident_id, primary_pattern, severity, total_flow, alert_count",
        "(:Account)-[:USES|FROM_IP|HAS_KYC]->(:Device|:IP|:KYC)": "identity lane (synthetic identity dataset, ACC##### accounts)",
    },
    "memory_layer": {
        "(:Investigation)-[:STEP]->(:ToolCall)": "every tool the agent ran, with the Cypher",
        "(:Investigation)-[:FOUND]->(:Finding)-[:SUPPORTED_BY]->(:Account)": "claims with provenance + cited tids/alert_ids",
        "(:Decision)-[:CAUSED_BY]->(:Finding), (:Decision)-[:IN]->(:Investigation)": "policy-gated actions; human approvals are Decision{actor:'human'}-[:APPROVES|REJECTS]->Decision",
        "(:Playbook)": "procedural memory: tool_sequence per FATF typology",
        "(:Account)-[:ON_WATCHLIST]->(:Watchlist)": "actions the agent executed itself (reversible); Account.review_status = what a supervisor decided",
    },
}


def get_graph_schema(graph) -> Dict:
    cypher = "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC"
    rows, ms, _ = _run(graph, cypher)
    rel_cypher = "MATCH ()-[r]->() RETURN type(r) AS rel, count(r) AS count ORDER BY count DESC"
    rels, ms2, _ = _run(graph, rel_cypher)
    return envelope("get_graph_schema", cypher + ";\n" + rel_cypher, {}, rows + rels, ms + ms2,
                    data={"labels": rows, "relationships": rels, "semantics": SCHEMA_DOC})


# -- evidence reads ------------------------------------------------------------

def list_incidents(graph, severity: Optional[str] = None, limit: int = 10) -> Dict:
    limit = _clamp(limit, 1, 50, 10)
    where = "WHERE i.severity = $severity" if severity else ""
    cypher = f"""
MATCH (i:Incident)
{where}
RETURN i.incident_id AS incident_id, i.primary_pattern AS pattern, i.severity AS severity,
       i.total_flow AS total_flow, i.alert_count AS alerts, i.n_entities AS accounts
ORDER BY i.total_flow DESC LIMIT {limit}"""
    params = {"severity": severity.upper()} if severity else {}
    rows, ms, to = _run(graph, cypher, params)
    return envelope("list_incidents", cypher, params, rows, ms, timed_out=to)


def get_incident(graph, incident_id: str) -> Dict:
    cypher = """
MATCH (i:Incident {incident_id: $id})-[:CONTAINS]->(al:Alert)
OPTIONAL MATCH (al)-[:FLAGS]->(a:Account)
WITH i, al, collect(DISTINCT a.id) AS accts
RETURN i.incident_id AS incident_id, i.primary_pattern AS pattern, i.severity AS severity,
       i.total_flow AS total_flow,
       collect({alert_id: al.alert_id, pattern: al.pattern_type, tier: al.tier, severity: al.severity,
                ml_score: al.ml_score, total_flow: al.total_flow, accounts: accts}) AS alerts"""
    params = {"id": incident_id}
    rows, ms, to = _run(graph, cypher, params)
    metrics = {}
    if rows:
        al = rows[0]["alerts"]
        tiers = [a["tier"] for a in al if a.get("tier")]
        metrics = {"min_tier": min(tiers) if tiers else None,
                   "max_ml_score": max([a.get("ml_score") or 0 for a in al] or [0]),
                   "severity": rows[0]["severity"]}
        if len(al) > 25:
            rows[0]["alerts"] = sorted(al, key=lambda a: -(a.get("ml_score") or 0))[:25]
            rows[0]["alerts_truncated"] = len(al)
    return envelope("get_incident", cypher, params, rows, ms, provenance="RULE", metrics=metrics, timed_out=to)


def account_profile(graph, account_id: str) -> Dict:
    cypher = """
MATCH (a:Account {id: $id})
OPTIONAL MATCH (a)-[o:TXN]->()
WITH a, count(o) AS out_n, sum(o.amount) AS out_amt, max(o.ml_score) AS max_out_ml,
     sum(CASE WHEN o.is_fraud THEN 1 ELSE 0 END) AS out_fraud
OPTIONAL MATCH ()-[i:TXN]->(a)
WITH a, out_n, out_amt, max_out_ml, out_fraud, count(i) AS in_n, sum(i.amount) AS in_amt,
     max(i.ml_score) AS max_in_ml, sum(CASE WHEN i.is_fraud THEN 1 ELSE 0 END) AS in_fraud
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(a)
OPTIONAL MATCH (a)-[wr:ON_WATCHLIST]->(wl:Watchlist)
RETURN a.id AS id, a.name AS name, a.type AS type, a.branch AS branch, a.source AS source,
       a.review_status AS review_status, collect(DISTINCT wl.name) AS watchlists,
       a.risk_score AS risk_score, a.risk_level AS risk_level, a.pr AS pagerank, a.community AS community,
       out_n, out_amt, in_n, in_amt, out_fraud + in_fraud AS labelled_fraud_txns,
       CASE WHEN max_out_ml > max_in_ml THEN max_out_ml ELSE max_in_ml END AS max_ml_score,
       collect(DISTINCT {alert_id: al.alert_id, pattern: al.pattern_type, tier: al.tier,
                         severity: al.severity, ml_score: al.ml_score})[0..10] AS alerts"""
    params = {"id": account_id}
    rows, ms, to = _run(graph, cypher, params)
    metrics = {}
    if rows:
        r = rows[0]
        r["alerts"] = [a for a in r["alerts"] if a.get("alert_id")]
        tiers = [a["tier"] for a in r["alerts"] if a.get("tier")]
        sev = max([SEV_RANK.get(a.get("severity") or "", 0) for a in r["alerts"]] or [0])
        metrics = {"max_ml_score": r.get("max_ml_score") or 0, "min_tier": min(tiers) if tiers else None,
                   "severity": [k for k, v in SEV_RANK.items() if v == sev][0] if r["alerts"] else None}
    note = "" if rows else f"No account with id {account_id!r}. Ids look like '011-800ABC123' (IBM) or 'ACC00010' (identity)."
    return envelope("account_profile", cypher, params, rows, ms, metrics=metrics, timed_out=to, note=note)


def k_hop_neighbourhood(graph, account_id: str, k: int = 2, min_amount: float = 0.0, limit: int = 60) -> Dict:
    k = _clamp(k, 1, 3, 2)
    limit = _clamp(limit, 1, 200, 60)
    cypher = f"""
MATCH p = (a:Account {{id: $id}})-[:TXN*1..{k}]-(b:Account)
WHERE all(r IN relationships(p) WHERE r.amount >= $min_amount)
WITH b, min(length(p)) AS hops
MATCH (b)
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(b)
RETURN b.id AS account, b.type AS type, hops, b.risk_score AS risk_score, b.pr AS pagerank,
       count(DISTINCT al) AS alerts
ORDER BY hops, alerts DESC, risk_score DESC LIMIT {limit}"""
    params = {"id": account_id, "min_amount": float(min_amount or 0)}
    rows, ms, to = _run(graph, cypher, params)
    flagged = sum(1 for r in rows if r["alerts"])
    return envelope("k_hop_neighbourhood", cypher, params, rows, ms,
                    metrics={"neighbours": len(rows), "flagged_neighbours": flagged, "k": k}, timed_out=to)


def trace_funds(graph, account_id: str, direction: str = "forward", max_hops: int = 4,
                window_hours: float = 72.0, keep_lo: float = 0.5, keep_hi: float = 1.1,
                min_amount: float = 0.0, limit: int = 10) -> Dict:
    """Temporal-causal money-following: each hop happens after the previous one
    (within `window_hours`) and carries forward keep_lo..keep_hi of its amount."""
    h = _clamp(max_hops, 1, 5, 4)
    limit = _clamp(limit, 1, 30, 10)
    back = str(direction).lower().startswith("b")
    pat = f"(a:Account {{id: $id}})<-[:TXN*1..{h}]-(x:Account)" if back else f"(a:Account {{id: $id}})-[:TXN*1..{h}]->(x:Account)"
    order = "rs[i+1].ts < rs[i].ts AND rs[i].ts - rs[i+1].ts <= $window_s" if back else \
            "rs[i+1].ts > rs[i].ts AND rs[i+1].ts - rs[i].ts <= $window_s"
    cypher = f"""
MATCH p = {pat}
WHERE x <> a AND all(r IN relationships(p) WHERE r.amount >= $min_amount)
WITH p, relationships(p) AS rs, nodes(p) AS ns
WHERE all(i IN range(0, size(rs) - 2) WHERE {order}
        AND rs[i+1].amount >= rs[i].amount * $keep_lo AND rs[i+1].amount <= rs[i].amount * $keep_hi)
UNWIND ns AS n
WITH p, rs, ns, count(DISTINCT n) AS uniq
WHERE uniq = size(ns)
RETURN [n IN ns | n.id] AS path,
       [r IN rs | {{tid: r.tid, from: startNode(r).id, to: endNode(r).id, ts: r.ts, amount: r.amount,
                   rail: r.rail, ml: r.ml_score, fraud: r.is_fraud}}] AS hops,
       size(rs) AS length
ORDER BY length DESC, hops[size(hops) - 1].amount DESC LIMIT {limit}"""
    params = {"id": account_id, "window_s": int(float(window_hours) * 3600),
              "keep_lo": float(keep_lo), "keep_hi": float(keep_hi), "min_amount": float(min_amount or 0)}
    rows, ms, to = _run(graph, cypher, params)
    longest = max([r["length"] for r in rows] or [0])
    fraud_hops = sum(1 for r in rows for hp in r["hops"] if hp.get("fraud"))
    return envelope("trace_funds", cypher, params, rows, ms,
                    metrics={"trace_hops": longest, "chains": len(rows), "labelled_fraud_hops": fraud_hops,
                             "direction": "backward" if back else "forward"}, timed_out=to)


def find_cycles(graph, account_id: str, max_len: int = 6, min_amount: float = 0.0,
                temporal: bool = True, limit: int = 10) -> Dict:
    n = _clamp(max_len, 2, 7, 6) - 1   # (a)-[*1..n]->(x)-[last]->(a)  => length 2..max_len
    limit = _clamp(limit, 1, 25, 10)
    # Temporal: SOME rotation of the loop is time-ordered, i.e. walking round the
    # cycle steps back in time at most once. Rotation-invariant, so a round-trip is
    # found whichever account the investigation enters it from.
    tclause = ("AND size([i IN range(0, size(rs) - 2) WHERE rs[i+1].ts < rs[i].ts]) "
               "+ (CASE WHEN rs[0].ts < rs[size(rs) - 1].ts THEN 1 ELSE 0 END) <= 1") if temporal else ""
    cypher = f"""
MATCH p = (a:Account {{id: $id}})-[:TXN*1..{n}]->(x:Account)-[:TXN]->(a)
WITH p, relationships(p) AS rs, nodes(p) AS ns
WHERE all(r IN rs WHERE r.amount >= $min_amount) {tclause}
UNWIND ns[0..size(ns) - 1] AS m
WITH p, rs, ns, count(DISTINCT m) AS uniq
WHERE uniq = size(ns) - 1
RETURN [m IN ns | m.id] AS cycle, size(rs) AS length,
       reduce(s = 0.0, r IN rs | s + r.amount) AS total_flow,
       [r IN rs | r.tid] AS tids, [r IN rs | r.amount] AS amounts,
       (reduce(mx = rs[0].ts, r IN rs | CASE WHEN r.ts > mx THEN r.ts ELSE mx END)
        - reduce(mn = rs[0].ts, r IN rs | CASE WHEN r.ts < mn THEN r.ts ELSE mn END)) / 3600.0 AS span_hours
ORDER BY total_flow DESC LIMIT {limit}"""
    params = {"id": account_id, "min_amount": float(min_amount or 0)}
    rows, ms, to = _run(graph, cypher, params, timeout=4000)
    return envelope("find_cycles", cypher, params, rows, ms,
                    metrics={"cycle_found": bool(rows), "cycles": len(rows),
                             "max_cycle_flow": max([r["total_flow"] for r in rows] or [0.0])},
                    timed_out=to)


def shortest_path(graph, source_id: str, target_id: str, max_hops: int = 6) -> Dict:
    h = _clamp(max_hops, 1, 8, 6)
    cypher = f"""
MATCH (a:Account {{id: $source}}), (b:Account {{id: $target}})
WITH a, b, shortestPath((a)-[:TXN*1..{h}]->(b)) AS p
WHERE p IS NOT NULL
RETURN [n IN nodes(p) | n.id] AS path,
       [r IN relationships(p) | {{tid: r.tid, amount: r.amount, ts: r.ts, ml: r.ml_score}}] AS hops,
       length(p) AS length"""
    params = {"source": source_id, "target": target_id}
    rows, ms, to = _run(graph, cypher, params)
    note = "" if rows else f"No directed money path within {h} hops - absence of a path is itself evidence."
    return envelope("shortest_path", cypher, params, rows, ms,
                    metrics={"connected": bool(rows), "length": rows[0]["length"] if rows else None},
                    timed_out=to, note=note)


def pagerank_hubs(graph, limit: int = 10, around_account: Optional[str] = None) -> Dict:
    """Live PageRank over the TXN graph (algo.pageRank); optionally restricted
    to the account's 2-hop neighbourhood to find the local coordinator."""
    limit = _clamp(limit, 1, 30, 10)
    if around_account:
        cypher = f"""
MATCH (a:Account {{id: $id}})-[:TXN*1..2]-(b:Account)
WITH DISTINCT b
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(b)
RETURN b.id AS account, b.type AS type, b.pr AS pagerank, count(DISTINCT al) AS alerts
ORDER BY pagerank DESC LIMIT {limit}"""
        params = {"id": around_account}
        rows, ms, to = _run(graph, cypher, params)
        return envelope("pagerank_hubs", cypher, params, rows, ms, timed_out=to,
                        note="Scores are global PageRank (algo.pageRank snapshot stored on Account.pr).")
    cypher = f"""
CALL algo.pageRank('Account', 'TXN') YIELD node, score
WITH node, score ORDER BY score DESC LIMIT {limit}
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(node)
RETURN node.id AS account, node.type AS type, score AS pagerank, count(DISTINCT al) AS alerts
ORDER BY pagerank DESC"""
    try:
        rows, ms, to = _run(graph, cypher, {}, timeout=15000)
    except Exception:
        cypher = f"MATCH (n:Account) RETURN n.id AS account, n.type AS type, n.pr AS pagerank ORDER BY n.pr DESC LIMIT {limit}"
        rows, ms, to = _run(graph, cypher, {})
    return envelope("pagerank_hubs", cypher, {}, rows, ms, timed_out=to)


ANALYTICS = (
    ("pagerank", "CALL algo.pageRank('Account', 'TXN') YIELD node, score SET node.pr = score RETURN count(node) AS n"),
    ("wcc", "CALL algo.WCC({nodeLabels: ['Account'], relationshipTypes: ['TXN']}) YIELD node, componentId "
            "SET node.community = componentId RETURN count(node) AS n"),
    ("label_propagation", "CALL algo.labelPropagation({nodeLabels: ['Account'], relationshipTypes: ['TXN'], "
                          "maxIterations: 10}) YIELD node, communityId SET node.lp_community = communityId "
                          "RETURN count(node) AS n"),
)


def refresh_graph_analytics(graph) -> Dict:
    """Run PageRank, WCC and label propagation INSIDE FalkorDB and write the
    results onto every Account (pr, community, lp_community)."""
    rows, total, cyphers = [], 0.0, []
    for name, cypher in ANALYTICS:
        r, ms, _ = _run(graph, cypher, write=True, timeout=180000)
        rows.append({"algorithm": name, "accounts": r[0]["n"] if r else 0, "ms": round(ms, 1)})
        total += ms
        cyphers.append(cypher)
    return envelope("refresh_graph_analytics", ";\n".join(cyphers), {}, rows, total)


def community_of(graph, account_id: str, limit: int = 15) -> Dict:
    """The account's community from label propagation (algo.labelPropagation run
    in FalkorDB), its flagged density, and the size of the wider WCC component -
    'is this a tight ring or the open economy?'."""
    limit = _clamp(limit, 1, 40, 15)
    cypher = f"""
MATCH (a:Account {{id: $id}})
MATCH (m:Account {{lp_community: a.lp_community}})
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(m)
WITH a, m, count(DISTINCT al) AS alerts
WITH a, count(m) AS size, sum(CASE WHEN alerts > 0 THEN 1 ELSE 0 END) AS flagged,
     collect({{account: m.id, pagerank: m.pr, alerts: alerts}}) AS members
MATCH (w:Account {{community: a.community}})
RETURN a.lp_community AS community, size, flagged, toFloat(flagged) / size AS flagged_ratio,
       count(w) AS wcc_component_size,
       [x IN members WHERE x.alerts > 0][0..{limit}] AS flagged_members"""
    params = {"id": account_id}
    rows, ms, to = _run(graph, cypher, params)
    note = ""
    if rows and rows[0]["size"] > 5000:
        note = "Very large community - closer to the open economy than a closed ring; use trace_funds/find_cycles for structure."
    return envelope("community_of", cypher, params, rows, ms,
                    metrics={"community_size": rows[0]["size"] if rows else 0,
                             "flagged_ratio": rows[0]["flagged_ratio"] if rows else 0},
                    timed_out=to, note=note)


def shared_identifier_ring(graph, account_id: str) -> Dict:
    """Accounts linked to this one through shared devices / IPs / KYC documents,
    transitively across identifier types (synthetic-identity lane)."""
    cypher = """
MATCH (a:Account {id: $id})-[:USES|FROM_IP|HAS_KYC*1..6]-(b:Account)
WHERE b <> a
WITH a, collect(DISTINCT b) AS ring
UNWIND ring + [a] AS m
MATCH (m)-[:USES|FROM_IP|HAS_KYC]->(ident)<-[:USES|FROM_IP|HAS_KYC]-(o:Account)
WHERE o IN ring + [a] AND o <> m
WITH ring, collect(DISTINCT {type: labels(ident)[0], value: ident.id}) AS shared
RETURN size(ring) + 1 AS ring_size, [b IN ring | {account: b.id, name: b.name, is_mule: b.is_mule}] AS members,
       shared AS shared_identifiers"""
    params = {"id": account_id}
    rows, ms, to = _run(graph, cypher, params)
    size = rows[0]["ring_size"] if rows else 1
    return envelope("shared_identifier_ring", cypher, params, rows, ms,
                    metrics={"ring_size": size if rows else 0}, timed_out=to,
                    note="" if rows else "No other account shares a device, IP or KYC document with this one.")


def search_alerts(graph, query: str, limit: int = 10) -> Dict:
    limit = _clamp(limit, 1, 30, 10)
    cypher = f"""
CALL db.idx.fulltext.queryNodes('Alert', $q) YIELD node, score
OPTIONAL MATCH (node)-[:FLAGS]->(a:Account)
RETURN node.alert_id AS alert_id, node.pattern_type AS pattern, node.tier AS tier,
       node.severity AS severity, node.ml_score AS ml_score, collect(a.id) AS accounts, score
ORDER BY score DESC LIMIT {limit}"""
    params = {"q": query}
    try:
        rows, ms, to = _run(graph, cypher, params)
    except Exception:
        cypher = f"""
MATCH (node:Alert) WHERE toLower(node.description) CONTAINS toLower($q) OR toLower(node.pattern_type) CONTAINS toLower($q)
OPTIONAL MATCH (node)-[:FLAGS]->(a:Account)
RETURN node.alert_id AS alert_id, node.pattern_type AS pattern, node.tier AS tier,
       node.severity AS severity, node.ml_score AS ml_score, collect(a.id) AS accounts
LIMIT {limit}"""
        rows, ms, to = _run(graph, cypher, params)
    return envelope("search_alerts", cypher, params, rows, ms, provenance="RULE", timed_out=to)


def get_playbook(graph, typology: str) -> Dict:
    cypher = """
MATCH (p:Playbook) WHERE p.typology = $t OR toLower(p.typology) CONTAINS toLower($t)
RETURN p.typology AS typology, p.fatf_code AS fatf_code, p.fatf_typology AS fatf_typology,
       p.tool_sequence AS tool_sequence, p.legal_basis AS legal_basis,
       p.control_gap AS control_gap, p.remediation AS remediation
LIMIT 1"""
    params = {"t": typology}
    rows, ms, to = _run(graph, cypher, params)
    for r in rows:
        try:
            r["tool_sequence"] = json.loads(r["tool_sequence"])
        except Exception:
            pass
    if not rows:
        params = {"t": "ML-Detected Anomaly"}
        rows, ms2, _ = _run(graph, cypher, params)
        ms += ms2
        for r in rows:
            r["tool_sequence"] = json.loads(r["tool_sequence"])
    return envelope("get_playbook", cypher, params, rows, ms, provenance="PRECEDENT", timed_out=to)


def find_precedents(graph, account_id: Optional[str] = None, typology: Optional[str] = None,
                    limit: int = 10) -> Dict:
    """Earlier investigations/decisions touching this account (or its 2-hop
    money neighbourhood), or of the same typology - the agent's long-term memory."""
    limit = _clamp(limit, 1, 25, 10)
    if account_id:
        cypher = f"""
MATCH (a:Account {{id: $id}})
MATCH (a)-[:TXN*0..2]-(n:Account)<-[:SUPPORTED_BY]-(f:Finding)<-[:FOUND]-(inv:Investigation)
WHERE inv.status = 'complete'
OPTIONAL MATCH (d:Decision)-[:IN]->(inv)
OPTIONAL MATCH (h:Decision {{actor: 'human'}})-[rv:APPROVES|REJECTS]->(d)
WITH inv, d, h, rv, collect(DISTINCT n.id) AS via, collect(DISTINCT f.claim) AS claims
RETURN inv.id AS investigation, inv.question AS question, inv.verdict AS verdict,
       inv.confidence AS confidence, inv.started_at AS started_at, via[0] AS via_account,
       size(via) AS linking_accounts, claims[0] AS claim, d.id AS decision_id, d.action_final AS action,
       d.status AS status, h.role AS reviewer, type(rv) AS review, h.note AS review_note, h.ts AS reviewed_at
ORDER BY CASE WHEN review IS NULL THEN 1 ELSE 0 END, started_at DESC LIMIT {limit}"""
        params = {"id": account_id}
    else:
        cypher = f"""
MATCH (inv:Investigation)
WHERE inv.typology = $t AND inv.status = 'complete'
OPTIONAL MATCH (d:Decision)-[:IN]->(inv)
RETURN inv.id AS investigation, inv.question AS question, inv.verdict AS verdict,
       inv.confidence AS confidence, inv.started_at AS started_at, d.action_final AS action, d.status AS status
ORDER BY started_at DESC LIMIT {limit}"""
        params = {"t": typology or ""}
    rows, ms, to = _run(graph, cypher, params)
    now = time.time()
    for r in rows:
        if r.get("reviewed_at"):
            r["review_age_days"] = round((now - float(r["reviewed_at"])) / 86400, 1)
    return envelope("find_precedents", cypher, params, rows, ms, provenance="PRECEDENT",
                    metrics={"precedents": len(rows)}, timed_out=to,
                    note="" if rows else "No prior investigations touch this account's neighbourhood.")


_WRITE_RE = re.compile(r"\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV)\b", re.I)


def run_cypher_readonly(graph, cypher: str) -> Dict:
    """Guarded escape hatch for questions the fixed tools can't express."""
    q = re.sub(r"//.*?$|/\*.*?\*/", "", cypher or "", flags=re.S | re.M).strip().rstrip(";")
    if not re.match(r"^(OPTIONAL\s+MATCH|MATCH|CALL|WITH|UNWIND|RETURN)\b", q, re.I):
        return envelope("run_cypher_readonly", q, {}, [], 0.0, data={"error": "Only read queries (MATCH/CALL/WITH/UNWIND/RETURN) are allowed."})
    if _WRITE_RE.search(q) or re.search(r"db\.idx\.\w+\.create|algo\.\w+\.(write|mutate)", q, re.I):
        return envelope("run_cypher_readonly", q, {}, [], 0.0, data={"error": "Write clauses are not allowed in read-only mode."})
    if not re.search(r"\bLIMIT\s+\d+\s*$", q, re.I):
        q += " LIMIT 50"
    try:
        rows, ms, to = _run(graph, q, {})
    except Exception as e:  # noqa: BLE001
        return envelope("run_cypher_readonly", q, {}, [], 0.0, data={"error": str(e)})
    return envelope("run_cypher_readonly", q, {}, rows[:50], ms, timed_out=to)


# -- memory writes (agent decision trace) --------------------------------------

def _now() -> float:
    return round(time.time(), 3)


def create_investigation(graph, question: str, mode: str = "graph", account_ids: Sequence[str] = (),
                         typology: str = "", investigation_id: Optional[str] = None) -> str:
    iid = investigation_id or f"INV-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4].upper()}"
    graph.query("""
MERGE (inv:Investigation {id: $id})
SET inv.question = $q, inv.mode = $mode, inv.started_at = $ts, inv.status = 'running', inv.typology = $typ
WITH inv
UNWIND $accts AS aid
MATCH (a:Account {id: aid})
MERGE (inv)-[:ABOUT]->(a)""", {"id": iid, "q": question, "mode": mode, "ts": _now(),
                               "accts": list(account_ids), "typ": typology})
    return iid


def link_about(graph, investigation_id: str, account_ids: Sequence[str] = (), typology: str = "") -> None:
    graph.query("""
MATCH (inv:Investigation {id: $id})
SET inv.typology = CASE WHEN $typ <> '' THEN $typ ELSE inv.typology END
WITH inv
UNWIND $accts AS aid
MATCH (a:Account {id: aid})
MERGE (inv)-[:ABOUT]->(a)""", {"id": investigation_id, "accts": list(account_ids), "typ": typology or ""})


def write_tool_call(graph, investigation_id: str, n: int, env: Dict, args: Dict) -> None:
    graph.query("""
MATCH (inv:Investigation {id: $id})
CREATE (inv)-[:STEP {n: $n}]->(t:ToolCall {tool: $tool, cypher: $cypher, params_json: $params,
        rows: $rows, ms: $ms, provenance: $prov, metrics_json: $metrics, ts: $ts})""",
                {"id": investigation_id, "n": int(n), "tool": env.get("tool", ""),
                 "cypher": env.get("cypher", "")[:4000], "params": json.dumps(args, default=str)[:2000],
                 "rows": int(env.get("rows") or 0), "ms": float(env.get("ms") or 0),
                 "prov": env.get("provenance", ""), "metrics": json.dumps(env.get("metrics") or {}, default=str),
                 "ts": _now()})


def write_finding(graph, investigation_id: str, claim: str, provenance: str,
                  account_ids: Sequence[str] = (), tids: Sequence[int] = (),
                  alert_ids: Sequence[str] = (), confidence: float = 0.0) -> Dict:
    prov = str(provenance or "INFERRED").upper()
    if prov not in PROVENANCE:
        prov = "INFERRED"
    fid = f"F-{uuid.uuid4().hex[:8].upper()}"
    tids = [int(t) for t in (tids or []) if str(t).lstrip("-").isdigit()]
    cypher = """
MATCH (inv:Investigation {id: $iid})
CREATE (inv)-[:FOUND]->(f:Finding {id: $fid, claim: $claim, provenance: $prov,
        evidence_tids: $tids, alert_ids: $alerts, confidence: $conf, ts: $ts})
WITH f
UNWIND $accts AS aid
MATCH (a:Account {id: aid})
MERGE (f)-[:SUPPORTED_BY]->(a)
RETURN count(a) AS linked"""
    params = {"iid": investigation_id, "fid": fid, "claim": claim[:1000], "prov": prov, "tids": tids,
              "alerts": list(alert_ids or []), "conf": float(confidence or 0), "ts": _now(),
              "accts": list(account_ids or [])}
    rows, ms, _ = _run(graph, cypher, params, write=True)
    # Verify cited tids actually exist - provenance has to be checkable.
    valid = []
    if tids:
        vrows, _, _ = _run(graph, "MATCH ()-[t:TXN]->() WHERE t.tid IN $tids RETURN t.tid AS tid", {"tids": tids})
        valid = [r["tid"] for r in vrows]
    data = {"finding_id": fid, "provenance": prov, "accounts_linked": rows[0]["linked"] if rows else 0,
            "tids_cited": len(tids), "tids_verified": len(valid),
            "unverified_tids": sorted(set(tids) - set(valid))}
    return envelope("record_finding", cypher, {k: v for k, v in params.items() if k != "claim"},
                    rows, ms, data=data, provenance="INFERRED")


def gather_policy_evidence(graph, investigation_id: str) -> Dict:
    """Everything the policy engine needs, read back from the decision trace."""
    rows, _, _ = _run(graph, """
MATCH (inv:Investigation {id: $id})
OPTIONAL MATCH (inv)-[:ABOUT|FOUND*1..2]-(a:Account)
WITH inv, collect(DISTINCT a) AS accts
UNWIND (CASE WHEN size(accts) = 0 THEN [null] ELSE accts END) AS a
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(a)
RETURN collect(DISTINCT a.id) AS accounts, min(CASE WHEN al.tier > 0 THEN al.tier END) AS min_tier,
       max(al.ml_score) AS max_alert_ml, max(al.confidence) AS confidence,
       collect(DISTINCT al.severity) AS severities""", {"id": investigation_id})
    ev = {"accounts": [], "min_tier": None, "max_ml_score": 0.0, "confidence": 0.0, "severity": None}
    if rows:
        r = rows[0]
        sev = max([SEV_RANK.get(s or "", -1) for s in r["severities"]] or [-1])
        ev.update({"accounts": [x for x in r["accounts"] if x], "min_tier": r["min_tier"],
                   "max_ml_score": float(r["max_alert_ml"] or 0), "confidence": float(r["confidence"] or 0),
                   "severity": [k for k, v in SEV_RANK.items() if v == sev][0] if sev >= 0 else None})
    steps, _, _ = _run(graph, """
MATCH (:Investigation {id: $id})-[:STEP]->(t:ToolCall) RETURN t.tool AS tool, t.metrics_json AS m""",
                       {"id": investigation_id})
    cycle_found, ring, hops, flow = False, 0, 0, 0.0
    for s in steps:
        m = json.loads(s["m"] or "{}")
        cycle_found |= bool(m.get("cycle_found"))
        ring = max(ring, int(m.get("ring_size") or 0))
        hops = max(hops, int(m.get("trace_hops") or 0))
        flow = max(flow, float(m.get("max_cycle_flow") or 0))
        ev["max_ml_score"] = max(ev["max_ml_score"], float(m.get("max_ml_score") or 0))
        if m.get("min_tier") and (ev["min_tier"] is None or m["min_tier"] < ev["min_tier"]):
            ev["min_tier"] = m["min_tier"]
    fr, _, _ = _run(graph, """
MATCH (:Investigation {id: $id})-[:FOUND]->(f:Finding) RETURN f.provenance AS p, count(f) AS c""",
                    {"id": investigation_id})
    cr, _, _ = _run(graph, "UNWIND $accts AS aid MATCH (a:Account {id: aid}) "
                           "WHERE a.review_status = 'confirmed_suspicious' RETURN count(a) AS n", {"accts": ev["accounts"]})
    ev["confirmed_accounts"] = cr[0]["n"] if cr else 0
    ev.update({"cycle_found": cycle_found, "ring_size": ring, "trace_hops": hops, "total_flow": flow,
               "has_graph_finding": any(r["p"] == "GRAPH" and r["c"] > 0 for r in fr)})
    # Human precedents on these accounts (P4 precedent guard).
    pr, _, _ = _run(graph, """
UNWIND $accts AS aid
MATCH (a:Account {id: aid})<-[:SUPPORTED_BY]-(:Finding)<-[:CAUSED_BY]-(d:Decision)<-[rv:APPROVES|REJECTS]-(h:Decision {actor: 'human'})
RETURN DISTINCT h.id AS id, type(rv) AS review, h.ts AS ts""", {"accts": ev["accounts"]})
    now = time.time()
    ev["precedents"] = [{"actor": "human", "status": "rejected" if r["review"] == "REJECTS" else "approved",
                         "age_days": (now - float(r["ts"] or now)) / 86400} for r in pr]
    return ev


def write_decision(graph, investigation_id: str, action_requested: str, decision: Dict,
                   rationale: str, finding_ids: Sequence[str] = (), actor: str = "agent",
                   evidence: Optional[Dict] = None, draft: str = "") -> Dict:
    did = f"D-{uuid.uuid4().hex[:8].upper()}"
    cypher = """
MATCH (inv:Investigation {id: $iid})
CREATE (d:Decision {id: $did, action_requested: $req, action_final: $final, status: $status,
        policy_rule: $rule, policy_rationale: $prat, rationale: $rat, actor: $actor, ts: $ts,
        evidence_json: $ev, draft: $draft})-[:IN]->(inv)
WITH d
OPTIONAL MATCH (inv2:Investigation {id: $iid})-[:FOUND]->(f:Finding)
WHERE size($fids) = 0 OR f.id IN $fids
WITH d, collect(f) AS fs
FOREACH (f IN fs | MERGE (d)-[:CAUSED_BY]->(f))
RETURN d.id AS decision_id, size(fs) AS caused_by"""
    params = {"iid": investigation_id, "did": did, "req": action_requested,
              "final": decision.get("action_final") or "", "status": decision["status"],
              "rule": decision["policy_rule"], "prat": decision["rationale"], "rat": (rationale or "")[:1000],
              "actor": actor, "ts": _now(), "ev": json.dumps(evidence or {}, default=str)[:3000],
              "draft": draft[:20000], "fids": list(finding_ids or [])}
    rows, ms, _ = _run(graph, cypher, params, write=True)
    data = {"decision_id": did, **decision, "caused_by_findings": rows[0]["caused_by"] if rows else 0,
            "requires_human_approval": decision["status"] == "proposed"}
    return envelope("propose_action", cypher, {k: params[k] for k in ("iid", "req", "fids")}, rows, ms,
                    data=data, provenance="INFERRED")


WATCHLISTS = {"monitor": "enhanced-monitoring", "request_edd": "enhanced-due-diligence"}


def execute_watchlist(graph, action: str, account_ids: Sequence[str], investigation_id: str,
                      decision_id: str, reason: str) -> Dict:
    """Carry out an autonomously-executed (reversible) action: put accounts on a
    watchlist. The edge records who, why and from which decision - undoable by
    deleting the edge."""
    name = WATCHLISTS[action]
    rows, ms, _ = _run(graph, """
MERGE (w:Watchlist {name: $name})
WITH w
UNWIND $accts AS aid
MATCH (a:Account {id: aid})
MERGE (a)-[r:ON_WATCHLIST]->(w)
SET r.since = $ts, r.by = 'agent', r.investigation = $iid, r.decision = $did, r.reason = $reason
WITH a
MATCH (d:Decision {id: $did})
MERGE (d)-[:TARGETS]->(a)
RETURN count(a) AS placed""", {"name": name, "accts": list(dict.fromkeys(account_ids or []))[:25], "ts": _now(),
                               "iid": investigation_id, "did": decision_id, "reason": (reason or "")[:300]},
                      write=True)
    return {"watchlist": name, "accounts_placed": rows[0]["placed"] if rows else 0}


def finish_investigation(graph, investigation_id: str, verdict: Dict) -> None:
    graph.query("""
MATCH (inv:Investigation {id: $id})
SET inv.status = 'complete', inv.verdict = $v, inv.confidence = $c, inv.summary = $s,
    inv.verdict_json = $j, inv.finished_at = $ts""",
                {"id": investigation_id, "v": verdict.get("verdict", "UNCERTAIN"),
                 "c": float(verdict.get("confidence") or 0), "s": str(verdict.get("summary", ""))[:4000],
                 "j": json.dumps(verdict, default=str)[:20000], "ts": _now()})
    # Link this investigation as precedent-bearing for any earlier investigation it consulted.
    graph.query("""
MATCH (inv:Investigation {id: $id})-[:STEP]->(t:ToolCall {tool: 'find_precedents'})
WITH inv, t WHERE t.rows > 0
MATCH (inv)-[:ABOUT]->(a:Account)-[:TXN*0..2]-(n:Account)<-[:SUPPORTED_BY]-(:Finding)<-[:CAUSED_BY]-(d:Decision)
MATCH (d)-[:IN]->(prev:Investigation) WHERE prev <> inv
MERGE (d)-[:PRECEDENT_FOR]->(inv)""", {"id": investigation_id})


def review_decision(graph, decision_id: str, approve: bool, reviewer_role: str, note: str = "") -> Dict:
    rel = "APPROVES" if approve else "REJECTS"
    hid = f"H-{uuid.uuid4().hex[:8].upper()}"
    rows, _, _ = _run(graph, f"""
MATCH (d:Decision {{id: $did}})
WHERE d.status = 'proposed'
SET d.status = $status, d.reviewed_by = $role, d.reviewed_at = $ts
CREATE (h:Decision {{id: $hid, actor: 'human', role: $role, note: $note, ts: $ts,
        action_final: d.action_final, status: $status}})-[:{rel}]->(d)
WITH d
MATCH (d)-[:IN]->(inv:Investigation)
OPTIONAL MATCH (d)-[:CAUSED_BY]->(:Finding)-[:SUPPORTED_BY]->(a:Account)
FOREACH (x IN CASE WHEN a IS NULL OR NOT d.action_final IN ['escalate', 'draft_str'] THEN [] ELSE [a] END |
  SET x.review_status = $verdict, x.reviewed_at = $ts, x.reviewed_decision = d.id)
WITH d, inv, a
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(a)
RETURN d.id AS decision_id, d.action_final AS action, d.status AS status, inv.id AS investigation,
       d.draft AS draft, collect(DISTINCT a.id) AS accounts, collect(DISTINCT al.alert_id) AS alert_ids""",
                      {"did": decision_id, "status": "approved" if approve else "rejected", "role": reviewer_role,
                       "note": note[:500], "ts": _now(), "hid": hid,
                       "verdict": "confirmed_suspicious" if approve else "cleared_by_supervisor"}, write=True)
    return rows[0] if rows else {}


# -- UI reads ------------------------------------------------------------------

def subgraph_for(graph, account_ids: Sequence[str] = (), tids: Sequence[int] = (), limit: int = 300) -> Dict:
    """Nodes + links for the evidence panel: cited transactions, money edges
    among cited accounts, and identity hubs (device/IP/KYC) they share."""
    accts = list(dict.fromkeys(account_ids or []))[:100]
    tids = [int(t) for t in (tids or [])][:400]
    cols = ("RETURN s.id AS source, d.id AS target, t.tid AS tid, t.amount AS amount, t.ts AS ts, "
            "t.is_fraud AS is_fraud, t.ml_score AS ml_score")
    links: Dict[int, Dict] = {}
    ms = 0.0
    if tids:
        # Unlabelled endpoints -> Edge By Index Scan on TXN.tid (labelling them forces a 119k label scan).
        rows, m, _ = _run(graph, "MATCH ()-[t:TXN]->() WHERE t.tid IN $tids WITH t, startNode(t) AS s, endNode(t) AS d "
                                 f"{cols} LIMIT {int(limit)}", {"tids": tids})
        ms += m
        for r in rows:
            links[r["tid"]] = {**r, "cited": True}
    if accts:
        rows, m, _ = _run(graph, f"MATCH (s:Account) WHERE s.id IN $accts MATCH (s)-[t:TXN]->(d:Account) "
                                 f"WHERE d.id IN $accts {cols} LIMIT {int(limit)}", {"accts": accts})
        ms += m
        for r in rows:
            links.setdefault(r["tid"], {**r, "cited": False})
    ident, m, _ = _run(graph, """
MATCH (a:Account) WHERE a.id IN $accts
MATCH (a)-[r:USES|FROM_IP|HAS_KYC]->(i)
WITH i, collect(a.id) AS owners WHERE size(owners) >= 2
UNWIND owners AS o
RETURN o AS source, i.id AS target, labels(i)[0] AS kind""", {"accts": accts}) if accts else ([], 0.0, False)
    ms += m
    link_list = list(links.values())
    ids = set(accts) | {r["source"] for r in link_list} | {r["target"] for r in link_list}
    nrows, m, _ = _run(graph, """
MATCH (a:Account) WHERE a.id IN $ids
OPTIONAL MATCH (al:Alert)-[:FLAGS]->(a)
RETURN a.id AS id, a.type AS type, a.risk_score AS risk_score, a.source AS source,
       a.is_mule AS is_mule, count(DISTINCT al) AS alerts""", {"ids": list(ids)})
    ms += m
    cited = set(accts)
    nodes = [{**n, "cited": n["id"] in cited} for n in nrows]
    hubs = {(r["target"], r["kind"]) for r in ident}
    nodes += [{"id": h, "type": kind, "identifier": True, "cited": False} for h, kind in hubs]
    link_list += [{"source": r["source"], "target": r["target"], "identity": True, "kind": r["kind"]} for r in ident]
    return {"nodes": nodes, "links": link_list, "ms": round(ms, 2)}


def investigation_trace(graph, investigation_id: str) -> Optional[Dict]:
    inv, _, _ = _run(graph, """
MATCH (inv:Investigation {id: $id})
OPTIONAL MATCH (inv)-[:ABOUT]->(a:Account)
RETURN inv.id AS id, inv.question AS question, inv.mode AS mode, inv.status AS status,
       inv.verdict AS verdict, inv.confidence AS confidence, inv.summary AS summary,
       inv.verdict_json AS verdict_json, inv.started_at AS started_at, inv.finished_at AS finished_at,
       inv.typology AS typology, collect(a.id) AS about""", {"id": investigation_id})
    if not inv:
        return None
    out = inv[0]
    try:
        out["verdict_detail"] = json.loads(out.pop("verdict_json") or "null")
    except Exception:
        out["verdict_detail"] = None
    steps, _, _ = _run(graph, """
MATCH (:Investigation {id: $id})-[s:STEP]->(t:ToolCall)
RETURN s.n AS n, t.tool AS tool, t.cypher AS cypher, t.params_json AS args, t.rows AS rows,
       t.ms AS ms, t.provenance AS provenance ORDER BY n""", {"id": investigation_id})
    findings, _, _ = _run(graph, """
MATCH (:Investigation {id: $id})-[:FOUND]->(f:Finding)
OPTIONAL MATCH (f)-[:SUPPORTED_BY]->(a:Account)
RETURN f.id AS id, f.claim AS claim, f.provenance AS provenance, f.evidence_tids AS tids,
       f.alert_ids AS alert_ids, f.confidence AS confidence, collect(a.id) AS accounts, f.ts AS ts
ORDER BY ts""", {"id": investigation_id})
    decisions, _, _ = _run(graph, """
MATCH (d:Decision)-[:IN]->(:Investigation {id: $id})
OPTIONAL MATCH (d)-[:CAUSED_BY]->(f:Finding)
OPTIONAL MATCH (h:Decision {actor: 'human'})-[rv]->(d)
RETURN d.id AS id, d.action_requested AS requested, d.action_final AS action, d.status AS status,
       d.policy_rule AS rule, d.policy_rationale AS policy_rationale, d.rationale AS rationale,
       d.ts AS ts, d.draft AS draft, collect(DISTINCT f.id) AS findings,
       h.role AS reviewer_role, type(rv) AS review
ORDER BY ts""", {"id": investigation_id})
    prec, _, _ = _run(graph, """
MATCH (d:Decision)-[:PRECEDENT_FOR]->(:Investigation {id: $id})
MATCH (d)-[:IN]->(prev:Investigation)
RETURN DISTINCT prev.id AS investigation, prev.verdict AS verdict, d.action_final AS action, d.status AS status""",
                      {"id": investigation_id})
    for s in steps:
        try:
            s["args"] = json.loads(s["args"] or "{}")
        except Exception:
            pass
    out.update({"steps": steps, "findings": findings, "decisions": decisions, "precedents": prec})
    return out


def decision_trail(graph, investigation_id: str) -> Dict:
    """The agent's reasoning as a graph: investigation -> findings -> accounts,
    decisions -> the findings that caused them, human reviews, watchlist targets,
    and earlier investigations used as precedent."""
    rows, ms, _ = _run(graph, """
MATCH (inv:Investigation {id: $id})
OPTIONAL MATCH (inv)-[:FOUND]->(f:Finding)
OPTIONAL MATCH (f)-[:SUPPORTED_BY]->(a:Account)
WITH inv, collect(DISTINCT {f: f.id, claim: f.claim, prov: f.provenance}) AS fs,
     collect(DISTINCT {f: f.id, a: a.id}) AS fa
OPTIONAL MATCH (d:Decision)-[:IN]->(inv)
OPTIONAL MATCH (d)-[:CAUSED_BY]->(cf:Finding)
OPTIONAL MATCH (d)-[:TARGETS]->(ta:Account)
OPTIONAL MATCH (h:Decision {actor: 'human'})-[rv]->(d)
WITH inv, fs, fa, collect(DISTINCT {d: d.id, req: d.action_requested, act: d.action_final, status: d.status,
                                    rule: d.policy_rule}) AS ds,
     collect(DISTINCT {d: d.id, f: cf.id}) AS df, collect(DISTINCT {d: d.id, a: ta.id}) AS dt,
     collect(DISTINCT {d: d.id, h: h.id, role: h.role, rel: type(rv)}) AS hv
OPTIONAL MATCH (pd:Decision)-[:PRECEDENT_FOR]->(inv)
OPTIONAL MATCH (pd)-[:IN]->(pinv:Investigation)
RETURN inv.id AS id, inv.question AS question, inv.verdict AS verdict, fs, fa, ds, df, dt, hv,
       collect(DISTINCT {pd: pd.id, pinv: pinv.id, pverdict: pinv.verdict, pact: pd.action_final, pstatus: pd.status}) AS pv""",
                      {"id": investigation_id})
    if not rows:
        return {"nodes": [], "links": [], "ms": ms}
    r = rows[0]
    nodes, links, seen = [], [], set()

    def node(nid, kind, label, **kw):
        if nid and nid not in seen:
            seen.add(nid)
            nodes.append({"id": nid, "kind": kind, "label": label, **kw})

    node(r["id"], "investigation", r["question"], verdict=r["verdict"])
    for x in r["fs"]:
        if x["f"]:
            node(x["f"], "finding", x["claim"], provenance=x["prov"])
            links.append({"source": r["id"], "target": x["f"], "rel": "FOUND"})
    for x in r["fa"]:
        if x["f"] and x["a"]:
            node(x["a"], "account", x["a"])
            links.append({"source": x["f"], "target": x["a"], "rel": "SUPPORTED_BY"})
    for x in r["ds"]:
        if x["d"]:
            node(x["d"], "decision", f"{x['req']} -> {x['act'] or x['status']}", status=x["status"], rule=x["rule"])
            links.append({"source": x["d"], "target": r["id"], "rel": "IN"})
    for x in r["df"]:
        if x["d"] and x["f"]:
            links.append({"source": x["d"], "target": x["f"], "rel": "CAUSED_BY"})
    for x in r["dt"]:
        if x["d"] and x["a"]:
            node(x["a"], "account", x["a"])
            links.append({"source": x["d"], "target": x["a"], "rel": "TARGETS"})
    for x in r["hv"]:
        if x["h"]:
            node(x["h"], "review", f"{x['role']} {'approved' if x['rel'] == 'APPROVES' else 'rejected'}", rel=x["rel"])
            links.append({"source": x["h"], "target": x["d"], "rel": x["rel"]})
    for x in r["pv"]:
        if x["pd"]:
            node(x["pinv"], "prior", f"Earlier investigation ({x['pverdict']})")
            node(x["pd"], "decision", f"{x['pact']} ({x['pstatus']})", status=x["pstatus"], prior=True)
            links.append({"source": x["pd"], "target": x["pinv"], "rel": "IN"})
            links.append({"source": x["pd"], "target": r["id"], "rel": "PRECEDENT_FOR"})
    return {"nodes": nodes, "links": links, "ms": round(ms, 2)}


def list_investigations(graph, limit: int = 30) -> List[Dict]:
    rows, _, _ = _run(graph, f"""
MATCH (inv:Investigation)
OPTIONAL MATCH (inv)-[:STEP]->(t:ToolCall)
WITH inv, count(t) AS steps
OPTIONAL MATCH (d:Decision)-[:IN]->(inv)
RETURN inv.id AS id, inv.question AS question, inv.mode AS mode, inv.status AS status,
       inv.verdict AS verdict, inv.confidence AS confidence, inv.started_at AS started_at, steps,
       sum(CASE WHEN d.status = 'proposed' THEN 1 ELSE 0 END) AS pending_decisions
ORDER BY started_at DESC LIMIT {_clamp(limit, 1, 200, 30)}""")
    return rows


def status(graph) -> Dict:
    """Per-label / per-type counts (label + relation matrices - no full scan)."""
    t0 = time.time()
    labels, rels, ms = {}, {}, 0.0
    for (lbl,) in graph.ro_query("CALL db.labels() YIELD label RETURN label").result_set:
        r, m, _ = _run(graph, f"MATCH (n:`{lbl}`) RETURN count(n) AS c")
        labels[lbl], ms = r[0]["c"], ms + m
    for (rt,) in graph.ro_query("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType").result_set:
        r, m, _ = _run(graph, f"MATCH ()-[e:`{rt}`]->() RETURN count(e) AS c")
        rels[rt], ms = r[0]["c"], ms + m
    return {"labels": labels, "relationships": rels, "query_ms": round(ms, 2),
            "roundtrip_ms": round((time.time() - t0) * 1000, 1)}
