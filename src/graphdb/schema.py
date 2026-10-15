"""Graph schema for the `rudra` context graph: indexes, constraints, playbooks.

Evidence layer   (:Account)-[:TXN]->(:Account), (:Alert)-[:FLAGS]->(:Account),
                 (:Incident)-[:CONTAINS]->(:Alert), identity lane
                 (:Account)-[:USES|FROM_IP|HAS_KYC]->(:Device|:IP|:KYC)
Memory layer     (:Investigation)-[:STEP]->(:ToolCall), -[:FOUND]->(:Finding)
                 -[:SUPPORTED_BY]->(:Account), (:Decision)-[:CAUSED_BY]->(:Finding),
                 (:Decision)-[:IN]->(:Investigation), (:Decision)-[:PRECEDENT_FOR]->(:Investigation)
Procedural       (:Playbook {typology, tool_sequence, ...})
"""
from __future__ import annotations

import json
import time
from typing import Dict, List

NODE_INDEXES = [
    ("Account", "id"), ("Account", "source"),
    ("Alert", "alert_id"), ("Incident", "incident_id"),
    ("Investigation", "id"), ("Finding", "id"), ("Decision", "id"),
    ("Playbook", "typology"), ("Device", "id"), ("IP", "id"), ("KYC", "id"),
]
EDGE_INDEXES = [("TXN", "ts"), ("TXN", "tid")]

# Tool order the agent is told to follow per typology (procedural memory).
_SEQUENCES: Dict[str, List[str]] = {
    "Circular Transaction": ["account_profile", "find_cycles", "trace_funds", "find_precedents"],
    "Rapid Layering": ["account_profile", "trace_funds", "k_hop_neighbourhood", "find_precedents"],
    "Smurfing / Structuring": ["account_profile", "k_hop_neighbourhood", "trace_funds", "find_precedents"],
    "Shell Company Funnel": ["account_profile", "k_hop_neighbourhood", "trace_funds", "find_cycles", "pagerank_hubs", "find_precedents"],
    "Dormant Activation": ["account_profile", "trace_funds", "find_precedents"],
    "Profile Mismatch": ["account_profile", "k_hop_neighbourhood", "find_precedents"],
    "Recruiter / Coordinator": ["account_profile", "k_hop_neighbourhood", "community_of", "trace_funds", "find_precedents"],
    "ML-Detected Anomaly": ["account_profile", "trace_funds", "find_cycles", "k_hop_neighbourhood", "community_of", "find_precedents"],
    "Collusion Ring": ["shared_identifier_ring", "account_profile", "find_precedents"],
}


def playbooks() -> List[Dict]:
    """Seed rows built from fatf_typology.TYPOLOGY (lazy import keeps this pure)."""
    from fatf_typology import TYPOLOGY, _GENERIC  # noqa: WPS450 - internal reuse
    rows = []
    for typ, seq in _SEQUENCES.items():
        entry = TYPOLOGY.get(typ, _GENERIC)
        rows.append({
            "typology": typ,
            "fatf_code": entry["fatf_code"],
            "fatf_typology": entry["fatf_typology"],
            "legal_basis": entry["pmla_section"],
            "control_gap": entry["control_gap"],
            "remediation": entry["remediation"],
            "tool_sequence": json.dumps(seq),
        })
    return rows


def _existing_indexes(graph) -> set:
    try:
        res = graph.ro_query("CALL db.indexes() YIELD label, properties RETURN label, properties")
        out = set()
        for label, props in res.result_set:
            for p in props or []:
                out.add((label, p))
        return out
    except Exception:
        return set()


def ensure_schema(graph, fulltext: bool = True) -> Dict:
    """Create indexes idempotently. Returns what was created."""
    have = _existing_indexes(graph)
    created = []
    for label, prop in NODE_INDEXES:
        if (label, prop) not in have:
            try:
                graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
                created.append(f":{label}({prop})")
            except Exception as e:  # already exists / race
                if "already" not in str(e).lower():
                    raise
    for rel, prop in EDGE_INDEXES:
        if (rel, prop) not in have:
            try:
                graph.query(f"CREATE INDEX FOR ()-[r:{rel}]-() ON (r.{prop})")
                created.append(f"[:{rel}]({prop})")
            except Exception as e:
                if "already" not in str(e).lower():
                    raise
    if fulltext:
        try:
            graph.query("CALL db.idx.fulltext.createNodeIndex('Alert', 'description', 'pattern_type')")
            created.append("fulltext :Alert(description, pattern_type)")
        except Exception:
            pass  # exists
    wait_for_indexes(graph)
    return {"created": created}


def wait_for_indexes(graph, timeout_s: float = 60.0) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        try:
            res = graph.ro_query("CALL db.indexes() YIELD status RETURN status")
            if all(str(r[0]).upper() == "OPERATIONAL" for r in res.result_set):
                return
        except Exception:
            return
        time.sleep(0.5)
