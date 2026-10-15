"""Deterministic policy gate for investigation-agent actions.

The LLM agent may only *propose* an action. This module - pure, no DB, no
LLM - decides what that proposal becomes. It is the single authority on
actions, which is what lets the agent act on what the graph shows without
the model itself holding the pen.

Rules, evaluated in order:

  P0 floor-safety   close / clear / dismiss / de_escalate are always denied.
                    The agent may *recommend* CLEAR in its verdict, but a
                    downward move stays with a SUPERVISOR via the case flow.
                    (Governed-routing "floor safety": the executed action can
                    never under-escalate below the policy minimum.)
  P4 precedent      a human rejection/clear on the same account within 30 days
                    forces `monitor` - the graph's memory overrides the model.
  P2 draft_str      needs a GRAPH-provenance finding AND (CRITICAL severity or
                    confidence >= 85, mirroring fatf_typology._legal_basis);
                    otherwise downgraded to `escalate` and re-checked by P1.
  P1 escalate       needs tier-1 corroboration, ML >= 0.80, a cycle moving
                    >= 2 lakh, or a shared-identifier ring of >= 3; otherwise
                    downgraded to `open_case`.
  P3 low impact     monitor / request_edd are reversible: EXECUTED autonomously
                    (account goes on a watchlist in the graph, fully logged).
                    open_case is proposed for an analyst.

Tiered autonomy: only reversible, low-impact actions are ever `executed` by
the agent. Nothing high-impact is returned as `approved`: approval only happens
through the human endpoint (POST /api/agent/decisions/{id}/review).
"""
from __future__ import annotations

from typing import Dict, Iterable, Optional

DOWNWARD = ("close", "clear", "dismiss", "de_escalate")
LOW_IMPACT = ("open_case", "monitor", "request_edd")
AUTONOMOUS = ("monitor", "request_edd")   # reversible: agent may execute itself
ACTIONS = ("escalate", "draft_str") + LOW_IMPACT + DOWNWARD

ESCALATE_ML = 0.80
ESCALATE_CYCLE_FLOW = 200_000.0
ESCALATE_RING = 3
STR_CONFIDENCE = 85.0
PRECEDENT_WINDOW_DAYS = 30


def _out(action_final: Optional[str], status: str, rule: str, rationale: str) -> Dict:
    return {"action_final": action_final, "status": status,
            "policy_rule": rule, "rationale": rationale}


def _escalation_basis(ev: Dict) -> Optional[str]:
    if int(ev.get("confirmed_accounts") or 0) > 0:
        return f"{int(ev['confirmed_accounts'])} account(s) previously confirmed suspicious by a supervisor"
    if ev.get("min_tier") == 1:
        return "tier-1 alert (ML and rule engine agree)"
    if float(ev.get("max_ml_score") or 0) >= ESCALATE_ML:
        return f"ensemble ML score {float(ev['max_ml_score']):.2f} >= {ESCALATE_ML}"
    if ev.get("cycle_found") and float(ev.get("total_flow") or 0) >= ESCALATE_CYCLE_FLOW:
        return f"closed fund cycle moving {float(ev['total_flow']):,.0f} (>= {ESCALATE_CYCLE_FLOW:,.0f})"
    if int(ev.get("ring_size") or 0) >= ESCALATE_RING:
        return f"shared-identifier ring of {int(ev['ring_size'])} accounts"
    return None


def _blocking_precedent(precedents: Iterable[Dict]) -> Optional[Dict]:
    for p in precedents or ():
        if (p.get("actor") == "human"
                and p.get("status") in ("rejected", "cleared")
                and float(p.get("age_days", 1e9)) <= PRECEDENT_WINDOW_DAYS):
            return p
    return None


def decide(action_requested: str, evidence: Dict, actor: str = "agent",
           precedents: Iterable[Dict] = ()) -> Dict:
    action = (action_requested or "").strip().lower()
    ev = evidence or {}

    if action in DOWNWARD:
        return _out(None, "denied", "P0_floor_safety",
                    f"'{action}' would lower the case's escalation level; the agent may only "
                    "recommend this - a SUPERVISOR must decide it in the case workbench.")
    if action not in ACTIONS:
        return _out(None, "denied", "P_unknown_action",
                    f"'{action}' is not an action the investigation agent is permitted to take.")

    if action in ("escalate", "draft_str"):
        p = _blocking_precedent(precedents)
        if p:
            return _out("monitor", "proposed", "P4_precedent_conflict",
                        f"A human reviewer {p.get('status')} a prior decision on this account "
                        f"{float(p.get('age_days', 0)):.0f} days ago; holding at monitor until a "
                        "SUPERVISOR revisits that precedent.")

    if action == "draft_str":
        sev = str(ev.get("severity") or "").upper()
        conf = float(ev.get("confidence") or 0)
        if ev.get("has_graph_finding") and (sev == "CRITICAL" or conf >= STR_CONFIDENCE):
            return _out("draft_str", "proposed", "P2_draft_str",
                        "Graph-evidenced finding with "
                        + ("CRITICAL severity" if sev == "CRITICAL" else f"confidence {conf:.0f}")
                        + " meets the PMLA Sec. 12 STR bar; draft proposed for SUPERVISOR sign-off.")
        basis = _escalation_basis(ev)
        if basis:
            return _out("escalate", "proposed", "P2_str_downgraded",
                        "STR bar not met (needs a GRAPH finding and CRITICAL severity or "
                        f"confidence >= {STR_CONFIDENCE:.0f}); escalating instead on {basis}.")
        return _out("open_case", "proposed", "P2_str_downgraded",
                    "STR bar not met and no escalation basis; opening a case for analyst review.")

    if action == "escalate":
        basis = _escalation_basis(ev)
        if basis:
            return _out("escalate", "proposed", "P1_escalate", f"Escalation justified by {basis}.")
        return _out("open_case", "proposed", "P1_escalate_downgraded",
                    "No tier-1 corroboration, ML >= 0.80, large cycle or identity ring; "
                    "opening a case for analyst review instead of escalating.")

    if action in AUTONOMOUS:
        return _out(action, "executed", "P3_autonomous_low_impact",
                    f"'{action}' is reversible and low-impact; executed by the agent and logged "
                    "(the accounts are placed on a watchlist in the graph).")
    return _out(action, "proposed", "P3_low_impact",
                f"'{action}' is a low-impact action; proposed for analyst confirmation.")
