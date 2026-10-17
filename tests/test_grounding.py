"""Verdicts are grounded in the graph trace, not in what the model claims.

Pure - no DB, no LLM.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from agent.grounding import ground_verdict, check_verdict_quality


def _f(prov, tids=(), unverified=()):
    return {"provenance": prov, "tids": list(tids), "unverified_tids": list(unverified), "claim": "x"}


def _d(action, status="proposed"):
    return {"action": action, "requested": action, "status": status}


def test_no_graph_evidence_caps_escalate_to_review():
    v = ground_verdict({"verdict": "ESCALATE", "confidence": 0.95},
                       {"findings": [_f("RULE"), _f("ML")], "decisions": [_d("escalate")]})
    assert v["verdict"] == "REVIEW"
    assert v["confidence"] <= 0.5
    assert v["grounding"]["adjusted"] and v["grounding"]["confidence_capped"]
    assert "graph" in v["grounding"]["reason"].lower()


def test_escalate_kept_with_verified_graph_evidence_and_policy_endorsement():
    v = ground_verdict({"verdict": "ESCALATE", "confidence": 0.9},
                       {"findings": [_f("GRAPH", [1, 2, 3]), _f("GRAPH", [4])], "decisions": [_d("draft_str")]})
    assert v["verdict"] == "ESCALATE" and v["confidence"] >= 0.7
    assert v["grounding"]["verified_tids"] == 4 and not v["grounding"]["adjusted"]
    assert v["confidence"] <= v["grounding"]["confidence_cap"]


def test_escalate_needs_policy_endorsement():
    v = ground_verdict({"verdict": "ESCALATE", "confidence": 0.9},
                       {"findings": [_f("GRAPH", [1])], "decisions": [_d("monitor", "executed")]})
    assert v["verdict"] == "REVIEW"


def test_unverified_ids_cut_confidence():
    clean = ground_verdict({"verdict": "ESCALATE", "confidence": 0.95},
                           {"findings": [_f("GRAPH", [1, 2])], "decisions": [_d("escalate")]})
    dirty = ground_verdict({"verdict": "ESCALATE", "confidence": 0.95},
                           {"findings": [_f("GRAPH", [1, 2], unverified=[999])], "decisions": [_d("escalate")]})
    assert dirty["confidence"] < clean["confidence"]
    assert dirty["grounding"]["unverified_tids"] == 1


def test_model_confidence_never_raised():
    v = ground_verdict({"verdict": "REVIEW", "confidence": 0.3},
                       {"findings": [_f("GRAPH", [1, 2, 3])], "decisions": [_d("escalate")]})
    assert v["verdict"] == "REVIEW" and v["confidence"] == 0.3


def test_clear_needs_graph_evidence():
    v = ground_verdict({"verdict": "CLEAR_RECOMMENDED", "confidence": 0.9}, {"findings": [_f("RULE")], "decisions": []})
    assert v["verdict"] == "UNCERTAIN"


def test_verdict_quality_checks():
    ok, _ = check_verdict_quality({"verdict": "ESCALATE", "summary": "A sends 5 lakh to B which returns it via C within 6 hours (tids 1, 2, 3)."}, findings_recorded=2)
    assert ok
    bad, why = check_verdict_quality({"verdict": "ESCALATE", "summary": "test"}, findings_recorded=2)
    assert not bad and "summary" in why
    bad2, why2 = check_verdict_quality({"verdict": "ESCALATE", "summary": "A long enough summary that names accounts and tids 1 2 3 here."}, findings_recorded=0)
    assert not bad2 and "record_finding" in why2
