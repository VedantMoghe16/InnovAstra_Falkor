"""Load RUDRA pipeline artefacts into the FalkorDB context graph.

    python src/graphdb/falkor_loader.py --reset                 # full 100k IBM AML sample
    python src/graphdb/falkor_loader.py --reset --limit 60000   # FalkorDB Cloud free tier (100 MB)

Idempotent: every write is UNWIND $rows ... MERGE on a stable key (Account.id,
TXN.tid, Alert.alert_id, Incident.incident_id), so re-running yields identical
counts. One TXN edge per transaction (the NetworkX graph collapses pairs; the
agent needs per-transaction timestamps for temporal-causal tracing).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, Iterable, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.dirname(_HERE)
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

import pandas as pd  # noqa: E402

from graphdb.client import connect_from_env, memory_used  # noqa: E402
from graphdb.schema import ensure_schema, playbooks  # noqa: E402
from text_ascii import asciify  # noqa: E402

REPO = os.path.dirname(_SRC)
DATA_DIR = os.path.join(REPO, "data")

Q_ACCOUNTS = """
UNWIND $rows AS r
MERGE (a:Account {id: r.id})
SET a.name = r.name, a.type = r.type, a.branch = r.branch, a.source = r.source,
    a.risk_score = r.risk_score, a.risk_level = r.risk_level,
    a.pr = r.pr, a.community = r.community, a.is_mule = r.is_mule
"""
Q_TXNS = """
UNWIND $rows AS r
MATCH (s:Account {id: r.s}), (d:Account {id: r.d})
MERGE (s)-[t:TXN {tid: r.tid}]->(d)
SET t.ts = r.ts, t.amount = r.amount, t.rail = r.rail, t.currency = r.currency,
    t.is_fraud = r.is_fraud, t.ml_score = r.ml_score
"""
Q_ALERTS = """
UNWIND $rows AS r
MERGE (al:Alert {alert_id: r.alert_id})
SET al.pattern_type = r.pattern_type, al.severity = r.severity, al.confidence = r.confidence,
    al.tier = r.tier, al.source = r.source, al.ml_score = r.ml_score,
    al.total_flow = r.total_flow, al.description = r.description,
    al.corroborated_by = r.corroborated_by
WITH al, r
UNWIND r.entities AS eid
MATCH (a:Account {id: eid})
MERGE (al)-[:FLAGS]->(a)
"""
Q_INCIDENTS = """
UNWIND $rows AS r
MERGE (i:Incident {incident_id: r.incident_id})
SET i.primary_pattern = r.primary_pattern, i.severity = r.severity,
    i.total_flow = r.total_flow, i.alert_count = r.alert_count,
    i.n_entities = r.n_entities, i.description = r.description
WITH i, r
UNWIND r.alert_ids AS aid
MATCH (al:Alert {alert_id: aid})
MERGE (i)-[:CONTAINS]->(al)
"""
Q_IDENTITY = """
UNWIND $rows AS r
MERGE (a:Account {id: r.id})
SET a.name = r.name, a.source = 'identity', a.is_mule = r.is_mule, a.type = 'individual'
MERGE (d:Device {id: r.device})
MERGE (ip:IP {id: r.ip})
MERGE (k:KYC {id: r.kyc})
MERGE (a)-[:USES]->(d)
MERGE (a)-[:FROM_IP]->(ip)
MERGE (a)-[:HAS_KYC]->(k)
"""
Q_PLAYBOOKS = """
UNWIND $rows AS r
MERGE (p:Playbook {typology: r.typology})
SET p.fatf_code = r.fatf_code, p.fatf_typology = r.fatf_typology,
    p.legal_basis = r.legal_basis, p.control_gap = r.control_gap,
    p.remediation = r.remediation, p.tool_sequence = r.tool_sequence
"""


def _batches(rows: List[Dict], n: int) -> Iterable[List[Dict]]:
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


def _write(graph, q: str, rows: List[Dict], batch: int, label: str) -> None:
    t0 = time.time()
    for chunk in _batches(rows, batch):
        graph.query(q, {"rows": chunk})
    print(f"  {label:<10} {len(rows):>7,} rows in {time.time() - t0:5.1f}s")


def _load_json(path: str, default):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def _edge_scores(variant: str) -> Dict[str, float]:
    for p in (os.path.join(DATA_DIR, "ml", variant, "ensemble", "edge_scores.json"),
              os.path.join(DATA_DIR, "ml", variant, "edge_scores.json")):
        raw = _load_json(p, None)
        if raw:
            out = {}
            for k, v in raw.items():
                out[k] = float(v.get("ensemble", v.get("xgb", 0.0))) if isinstance(v, dict) else float(v)
            print(f"  ml scores  from {os.path.relpath(p, REPO)} ({len(out):,} pairs)")
            return out
    return {}


def select_transactions(df: pd.DataFrame, limit: Optional[int], alerted: set, seed: int = 42) -> pd.DataFrame:
    """Evidence-preserving down-sample: all fraud + all txns touching alerted
    entities first, then a seeded random fill up to `limit`."""
    if not limit or len(df) <= limit:
        return df
    must = df["is_fraud"].astype(bool) | df["sender_id"].isin(alerted) | df["receiver_id"].isin(alerted)
    keep = df[must]
    if len(keep) >= limit:
        keep = keep.sample(limit, random_state=seed)
        return keep
    rest = df[~must].sample(limit - len(keep), random_state=seed)
    return pd.concat([keep, rest])


def build_rows(variant: str, limit: Optional[int]) -> Dict[str, List[Dict]]:
    vdir = os.path.join(DATA_DIR, variant)
    df = pd.read_csv(os.path.join(vdir, "transactions.csv"))
    alerts = _load_json(os.path.join(vdir, "fraud_alerts.json"), [])
    incidents = _load_json(os.path.join(vdir, "incidents.json"), [])
    risk = {r["entity_id"]: r for r in _load_json(os.path.join(vdir, "risk_scores.json"), [])
            if isinstance(r, dict) and "entity_id" in r}
    scores = _edge_scores(variant)

    alerted = {e for a in alerts for e in a.get("entities", [])}
    df = select_transactions(df, limit, alerted)

    acc: Dict[str, Dict] = {}
    for side in ("receiver", "sender"):  # sender last -> sender-side attrs win (matches graph_engine)
        sub = df[[f"{side}_id", f"{side}_name", f"{side}_type", f"{side}_branch"]].drop_duplicates(f"{side}_id")
        for i, name, typ, br in sub.itertuples(index=False, name=None):
            r = risk.get(i, {})
            acc[i] = {"id": i, "name": None if str(name) == str(i) else str(name),  # IBM names == ids; skip dup
                      "type": str(typ), "branch": str(br), "source": "ibm",
                      "risk_score": float(r.get("risk_score", 0.0) or 0.0),
                      "risk_level": str(r.get("risk_level", "LOW")),
                      "pr": 0.0, "community": -1, "is_mule": False}  # set by FalkorDB algos after load

    ts = pd.to_datetime(df["timestamp"], errors="coerce").fillna(pd.Timestamp("2022-01-01"))
    tx = pd.DataFrame({
        "s": df["sender_id"].astype(str), "d": df["receiver_id"].astype(str),
        "tid": df["transaction_id"].astype(str).str.replace(r"\D", "", regex=True).astype("int64"),
        "ts": (ts.astype("int64") // 10**9).astype("int64"),
        "amount": df["amount"].astype(float).round(2),
        "rail": df["transaction_type"].astype(str),
        "currency": df.get("currency", pd.Series(["USD"] * len(df), index=df.index)).astype(str),
        "is_fraud": df["is_fraud"].astype(bool),
    })
    tx["ml_score"] = [round(scores.get(f"{s}->{d}", 0.0), 4) for s, d in zip(tx["s"], tx["d"])]
    txn_rows = tx.to_dict("records")

    alert_rows = []
    for a in alerts:
        alert_rows.append({
            "alert_id": a["alert_id"], "pattern_type": a.get("pattern_type", ""),
            "severity": a.get("severity", ""), "confidence": float(a.get("confidence", 0) or 0),
            "tier": int(a.get("tier") or 0), "source": a.get("source", "rule"),
            "ml_score": float(a.get("ml_score", 0) or 0), "total_flow": float(a.get("total_flow", 0) or 0),
            "description": asciify(str(a.get("description", "")))[:500],
            "corroborated_by": ",".join(a.get("corroborated_by", []) or []),
            "entities": [e for e in a.get("entities", []) if e in acc],
        })
    inc_rows = [{
        "incident_id": i["incident_id"], "primary_pattern": i.get("primary_pattern", ""),
        "severity": i.get("severity", ""), "total_flow": float(i.get("total_flow", 0) or 0),
        "alert_count": int(i.get("alert_count", 0)), "n_entities": int(i.get("n_entities", 0)),
        "description": asciify(str(i.get("primary_alert_description", "")))[:500],
        "alert_ids": list(i.get("alert_ids", [])),
    } for i in incidents]

    ident_path = os.path.join(DATA_DIR, "collusion", "identity.json")
    if not os.path.exists(ident_path):
        from identity_generator import write_identity_dataset
        write_identity_dataset(ident_path)
    ident_rows = [{"id": a["account_id"], "name": a["name"], "is_mule": bool(a.get("is_mule")),
                   "device": a["device_id"], "ip": a["ip"], "kyc": a["kyc_doc_hash"]}
                  for a in _load_json(ident_path, [])]

    return {"accounts": list(acc.values()), "txns": txn_rows, "alerts": alert_rows,
            "incidents": inc_rows, "identity": ident_rows, "playbooks": playbooks()}


def verify(graph) -> Dict:
    out = {}
    for row in graph.ro_query("MATCH (n) RETURN labels(n)[0] AS l, count(n) ORDER BY l").result_set:
        out[row[0]] = row[1]
    for row in graph.ro_query("MATCH ()-[r]->() RETURN type(r) AS t, count(r) ORDER BY t").result_set:
        out[f"[:{row[0]}]"] = row[1]
    return out


def load(variant: str = "ibm_aml", limit: Optional[int] = None, reset: bool = False,
         batch: int = 5000, graph_name: Optional[str] = None, fulltext: bool = True) -> Dict:
    db, graph = connect_from_env(graph_name, socket_timeout=120)
    if reset:
        try:
            graph.delete()
            print(f"  reset      dropped graph '{graph.name}'")
        except Exception:
            pass
        graph = db.select_graph(graph.name)
    t0 = time.time()
    rows = build_rows(variant, limit)
    print(f"  built rows in {time.time() - t0:.1f}s")
    graph.query("RETURN 1")  # materialise the key so index DDL has a graph
    ensure_schema(graph, fulltext=fulltext)
    _write(graph, Q_ACCOUNTS, rows["accounts"], batch, "accounts")
    _write(graph, Q_TXNS, rows["txns"], batch, "txns")
    _write(graph, Q_ALERTS, rows["alerts"], 2000, "alerts")
    _write(graph, Q_INCIDENTS, rows["incidents"], 2000, "incidents")
    _write(graph, Q_IDENTITY, rows["identity"], 500, "identity")
    _write(graph, Q_PLAYBOOKS, rows["playbooks"], 100, "playbooks")
    from graphdb.queries import refresh_graph_analytics, apply_fx
    fx = apply_fx(graph)
    print(f"  fx         amount_usd on every TXN + USD flows on alerts/incidents in {fx['seconds']}s ({fx['label']})")
    for r in refresh_graph_analytics(graph)["data"]:
        print(f"  algo.{r['algorithm']:<18} {r['accounts']:>7,} accounts in {r['ms'] / 1000:5.1f}s (in FalkorDB)")
    counts = verify(graph)
    counts["memory"] = memory_used(db)
    counts["seconds"] = round(time.time() - t0, 1)
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variant", default=os.environ.get("RUDRA_DATASET", "ibm_aml"))
    ap.add_argument("--limit", type=int, default=None, help="max transactions (evidence-preserving sample)")
    ap.add_argument("--reset", action="store_true", help="drop the graph first")
    ap.add_argument("--batch", type=int, default=5000)
    ap.add_argument("--graph", default=None, help="graph name (default FALKORDB_GRAPH or 'rudra')")
    ap.add_argument("--no-fulltext", action="store_true")
    a = ap.parse_args()
    counts = load(a.variant, a.limit, a.reset, a.batch, a.graph, fulltext=not a.no_fulltext)
    print(json.dumps(counts, indent=2))


if __name__ == "__main__":
    main()
