"""Deterministic policy gate for agent actions (src/agent/policy.py).

Pure - no DB, no LLM. The agent may only *propose*; the policy decides what
the proposal becomes, and nothing is ever auto-approved. Floor-safety: the
agent can never close, clear, dismiss or de-escalate.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest

from agent.policy import decide, ACTIONS


def _ev(**kw):
    base = {
        "max_ml_score": 0.0, "min_tier": None, "cycle_found": False,
        "trace_hops": 0, "ring_size": 0, "total_flow": 0.0,
        "severity": "MEDIUM", "confidence": 0.0, "has_graph_finding": False,
    }
    base.update(kw)
    return base


@pytest.mark.parametrize("action", ["close", "clear", "dismiss", "de_escalate"])
def test_floor_safety_denies_downward_actions(action):
    d = decide(action, _ev(max_ml_score=0.99, min_tier=1, has_graph_finding=True))
    assert d["status"] == "denied"
    assert d["policy_rule"] == "P0_floor_safety"
    assert d["action_final"] is None


def test_unknown_action_is_denied():
    d = decide("wire_money_out", _ev())
    assert d["status"] == "denied"
    assert d["policy_rule"] == "P_unknown_action"


def test_escalate_allowed_on_tier1():
    d = decide("escalate", _ev(min_tier=1))
    assert d == {**d, "action_final": "escalate", "status": "proposed", "policy_rule": "P1_escalate"}


@pytest.mark.parametrize("ev", [
    {"max_ml_score": 0.80},
    {"cycle_found": True, "total_flow": 250_000},
    {"ring_size": 3},
])
def test_escalate_allowed_on_graph_or_ml_evidence(ev):
    assert decide("escalate", _ev(**ev))["action_final"] == "escalate"


def test_escalate_downgraded_without_evidence():
    d = decide("escalate", _ev(max_ml_score=0.5, cycle_found=True, total_flow=5_000))
    assert d["action_final"] == "open_case"
    assert d["policy_rule"] == "P1_escalate_downgraded"
    assert d["status"] == "proposed"


def test_draft_str_needs_graph_finding():
    d = decide("draft_str", _ev(severity="CRITICAL", min_tier=1))
    # no graph finding -> downgraded to escalate, which tier-1 permits
    assert d["action_final"] == "escalate"
    assert d["policy_rule"] == "P2_str_downgraded"


def test_draft_str_allowed_with_graph_finding_and_critical():
    d = decide("draft_str", _ev(severity="CRITICAL", has_graph_finding=True))
    assert d["action_final"] == "draft_str"
    assert d["policy_rule"] == "P2_draft_str"


def test_draft_str_allowed_with_high_confidence():
    d = decide("draft_str", _ev(confidence=90, has_graph_finding=True))
    assert d["action_final"] == "draft_str"


def test_draft_str_double_downgrade_to_open_case():
    d = decide("draft_str", _ev(severity="LOW"))
    assert d["action_final"] == "open_case"


@pytest.mark.parametrize("action", ["monitor", "request_edd"])
def test_reversible_actions_execute_autonomously(action):
    """Tiered autonomy: watchlisting and EDD requests are reversible and
    low-impact, so the agent may take them itself (logged, not approved)."""
    d = decide(action, _ev())
    assert d["action_final"] == action
    assert d["status"] == "executed"
    assert d["policy_rule"] == "P3_autonomous_low_impact"


def test_open_case_still_needs_a_human():
    d = decide("open_case", _ev())
    assert d["status"] == "proposed" and d["policy_rule"] == "P3_low_impact"


def test_supervisor_confirmation_is_escalation_basis():
    d = decide("escalate", _ev(confirmed_accounts=1))
    assert d["action_final"] == "escalate"
    assert "confirmed" in d["rationale"]


def test_precedent_conflict_forces_monitor():
    precedents = [{"actor": "human", "status": "rejected", "age_days": 5}]
    d = decide("escalate", _ev(min_tier=1), precedents=precedents)
    assert d["action_final"] == "monitor"
    assert d["policy_rule"] == "P4_precedent_conflict"


def test_old_precedent_does_not_block():
    precedents = [{"actor": "human", "status": "rejected", "age_days": 45}]
    assert decide("escalate", _ev(min_tier=1), precedents=precedents)["action_final"] == "escalate"


def test_agent_precedent_does_not_block():
    precedents = [{"actor": "agent", "status": "rejected", "age_days": 1}]
    assert decide("escalate", _ev(min_tier=1), precedents=precedents)["action_final"] == "escalate"


def test_never_auto_approves_high_impact():
    for a in ("escalate", "draft_str", "open_case") + ("close", "clear", "dismiss", "de_escalate"):
        st = decide(a, _ev(min_tier=1, max_ml_score=1, has_graph_finding=True, severity="CRITICAL"))["status"]
        assert st not in ("approved", "executed"), a


def test_rationale_is_human_readable():
    d = decide("escalate", _ev(min_tier=1))
    assert isinstance(d["rationale"], str) and len(d["rationale"]) > 10


def test_missing_evidence_keys_are_tolerated():
    d = decide("escalate", {})
    assert d["action_final"] == "open_case"
