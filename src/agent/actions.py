"""Action tools: the only way the agent changes anything.

Every action is evaluated by `policy.decide` against evidence read back from
the investigation's own decision trace in FalkorDB, then persisted as a
(:Decision) node. Nothing here executes a case transition - approval is a
human step (backend POST /api/agent/decisions/{id}/approve).
"""
from __future__ import annotations

import time
from typing import Dict, List, Optional, Sequence

from agent.policy import decide
from graphdb import queries as Q


def record_finding(graph, investigation_id: str, claim: str, provenance: str,
                   account_ids: Sequence[str] = (), tids: Sequence[int] = (),
                   alert_ids: Sequence[str] = (), confidence: float = 0.0) -> Dict:
    return Q.write_finding(graph, investigation_id, claim, provenance, account_ids, tids, alert_ids, confidence)


def propose_action(graph, investigation_id: str, action: str, rationale: str,
                   finding_ids: Sequence[str] = (), draft: str = "",
                   account_ids: Sequence[str] = ()) -> Dict:
    ev = Q.gather_policy_evidence(graph, investigation_id)
    precedents = ev.pop("precedents", [])
    decision = decide(action, ev, actor="agent", precedents=precedents)
    env = Q.write_decision(graph, investigation_id, action, decision, rationale, finding_ids,
                           evidence={**ev, "precedents": precedents},
                           draft=draft if decision.get("action_final") == "draft_str" else "")
    if decision["status"] == "executed":
        targets = list(account_ids) or ev["accounts"]
        env["data"]["executed"] = Q.execute_watchlist(graph, decision["action_final"], targets, investigation_id,
                                                      env["data"]["decision_id"], rationale)
    env["data"]["evidence_used"] = {k: ev[k] for k in ("min_tier", "max_ml_score", "cycle_found", "ring_size",
                                                       "trace_hops", "total_flow", "severity", "confidence",
                                                       "has_graph_finding", "confirmed_accounts")}
    return env


def _trace_bits(graph, investigation_id: str) -> Dict:
    t = Q.investigation_trace(graph, investigation_id) or {}
    return t


def build_str_text(graph, investigation_id: str, narrative: str = "") -> str:
    """Fill the existing SAR/STR template from the investigation's graph trace."""
    from fatf_typology import TYPOLOGY, _GENERIC, _legal_basis
    from sar_generator import SAR_TEMPLATE, DEFAULT_BANK_NAME, DEFAULT_COMPLIANCE_OFFICER

    t = _trace_bits(graph, investigation_id)
    ev = Q.gather_policy_evidence(graph, investigation_id)
    findings: List[Dict] = t.get("findings", [])
    accts = sorted({a for f in findings for a in (f.get("accounts") or [])} | set(t.get("about") or []))
    typ = t.get("typology") or "ML-Detected Anomaly"
    entry = TYPOLOGY.get(typ, _GENERIC)
    tids = sorted({x for f in findings for x in (f.get("tids") or [])})
    txn_lines = []
    if tids:
        rows, _, _ = Q._run(graph, """
MATCH ()-[t:TXN]->() WHERE t.tid IN $tids
RETURN t.tid AS tid, startNode(t).id AS s, endNode(t).id AS d, t.amount AS amount, t.ts AS ts, t.rail AS rail
ORDER BY ts LIMIT 40""",
                            {"tids": tids})
        txn_lines = [f"  TXN {r['tid']}: {r['s']} -> {r['d']}  {r['amount']:,.2f}  "
                     f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(r['ts']))}  {r['rail']}" for r in rows]
    by_prov: Dict[str, List[str]] = {}
    for f in findings:
        by_prov.setdefault(f["provenance"], []).append(f"  [{f['provenance']}] {f['claim']}")
    return SAR_TEMPLATE.format(
        report_id=f"STR-{investigation_id}",
        generated_date=time.strftime("%Y-%m-%d %H:%M:%S"),
        bank_name=DEFAULT_BANK_NAME, priority=(ev.get("severity") or "HIGH"),
        branch="(per account records)", compliance_officer=DEFAULT_COMPLIANCE_OFFICER,
        detection_date=time.strftime("%Y-%m-%d"),
        suspect_information="\n".join(f"  Account {a}" for a in accts) or "  (none cited)",
        activity_description=(narrative or t.get("summary") or "").strip() or "  See findings below.",
        transaction_details="\n".join(txn_lines) or "  (no transactions cited)",
        fund_flow_analysis="\n".join(by_prov.get("GRAPH", [])) or "  (no graph findings)",
        pattern_analysis="\n".join(by_prov.get("ML", []) + by_prov.get("RULE", []) + by_prov.get("INFERRED", []))
                         or f"  Typology: {entry['fatf_typology']}",
        regulatory_citations=f"  {entry['pmla_section']}\n  {entry['rbi_ref']}\n  {entry['fiu_advisory']}\n"
                             f"  Legal basis: {_legal_basis(ev.get('severity') or '', ev.get('confidence') or 0)}",
        recommendations=f"  {entry['remediation']}",
        supporting_documents=f"  FalkorDB decision trace: Investigation {investigation_id} "
                             f"({len(t.get('steps', []))} graph tool calls, {len(findings)} findings, "
                             f"{len(tids)} cited transactions).",
    )


def draft_str(graph, investigation_id: str, narrative: str = "", finding_ids: Sequence[str] = ()) -> Dict:
    """Propose filing an STR. The policy gate decides; if it allows a draft, the
    filled template is attached to the Decision for SUPERVISOR sign-off."""
    text = build_str_text(graph, investigation_id, narrative)
    env = propose_action(graph, investigation_id, "draft_str",
                         narrative or "Agent proposes STR filing", finding_ids, draft=text)
    if env["data"].get("action_final") == "draft_str":
        env["data"]["draft_preview"] = text[:1500]
    env["tool"] = "draft_str"
    return env
