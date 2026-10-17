"""Ground the agent's verdict in the decision trace, not in the model's say-so.

Whatever brain runs (Claude, Gemini, autopilot), the final verdict and
confidence are capped by what the graph trace actually contains:

  * no GRAPH-provenance finding          -> at most REVIEW, confidence <= 0.5
  * ESCALATE                             -> needs graph evidence AND a policy-endorsed
                                            escalate / draft_str decision
  * CLEAR_RECOMMENDED                    -> needs graph evidence (absence checks count)
  * confidence                           -> min(model's claim, evidence-derived cap);
                                            cited ids that do not exist in the graph cut it

This is what makes the removal test hold for an LLM brain: without graph
tools a model can claim "ESCALATE 0.95", but the grounded verdict cannot.
"""
from __future__ import annotations

import re
from typing import Dict, List, Tuple

RANK = {"UNCERTAIN": 0, "REVIEW": 1, "ESCALATE": 2}
JUNK = {"test", "n/a", "na", "none", "todo", "tbd", "done", "ok", "verdict", "summary"}


def _evidence(trace: Dict) -> Dict:
    findings: List[Dict] = trace.get("findings") or []
    decisions: List[Dict] = trace.get("decisions") or []
    graph = [f for f in findings if f.get("provenance") == "GRAPH"]
    verified = sum(len(f.get("tids") or []) for f in findings)
    unverified = sum(len(f.get("unverified_tids") or []) for f in findings)
    endorsed = [d for d in decisions
                if d.get("action") in ("escalate", "draft_str") and d.get("status") in ("proposed", "approved")]
    return {"graph_findings": len(graph), "graph_with_tids": sum(1 for f in graph if f.get("tids")),
            "other_findings": len(findings) - len(graph), "verified_tids": verified,
            "unverified_tids": unverified, "policy_endorsed_escalation": bool(endorsed)}


def ground_verdict(model_verdict: Dict, trace: Dict) -> Dict:
    v = dict(model_verdict or {})
    claimed = v.get("verdict") if v.get("verdict") in (*RANK, "CLEAR_RECOMMENDED") else "UNCERTAIN"
    try:
        claimed_conf = max(0.0, min(1.0, float(v.get("confidence", 0.5))))
    except (TypeError, ValueError):
        claimed_conf = 0.5
    ev = _evidence(trace)
    reasons = []

    if ev["graph_findings"] == 0:
        ceiling, cap = "REVIEW", 0.5
        reasons.append("no graph-derived finding (traversal or algorithm) supports it")
    else:
        cap = min(0.95, 0.55 + 0.1 * ev["graph_with_tids"] + 0.04 * min(ev["graph_findings"], 3))
        if ev["policy_endorsed_escalation"]:
            ceiling = "ESCALATE"
        else:
            ceiling, cap = "REVIEW", min(cap, 0.75)
            if claimed == "ESCALATE":
                reasons.append("the policy did not endorse an escalation or STR")
    if ev["unverified_tids"]:
        cap = max(0.1, cap - 0.1 * min(ev["unverified_tids"], 3))
        reasons.append(f"{ev['unverified_tids']} cited transaction id(s) do not exist in the graph")

    if claimed == "CLEAR_RECOMMENDED":
        final = "CLEAR_RECOMMENDED" if ev["graph_findings"] else "UNCERTAIN"
        if final != claimed:
            reasons.append("clearing needs graph evidence of absence")
        cap = min(cap, 0.7)
    elif RANK[claimed] > RANK[ceiling]:
        final = ceiling
    else:
        final = claimed
    conf = round(min(claimed_conf, cap), 2)

    adjusted = final != claimed                       # verdict changed
    capped = conf < round(claimed_conf, 2)            # confidence lowered to what the evidence supports
    v.update({"verdict": final, "confidence": conf})
    v["grounding"] = {**ev, "claimed_verdict": claimed, "claimed_confidence": round(claimed_conf, 2),
                      "ceiling": ceiling, "confidence_cap": round(cap, 2), "adjusted": adjusted,
                      "confidence_capped": capped,
                      "reason": ("; ".join(reasons) if reasons else
                                 ("confidence capped to what the trace supports" if capped else "consistent with the trace"))}
    return v


def check_verdict_quality(verdict: Dict, findings_recorded: int) -> Tuple[bool, str]:
    """Reject a verdict the model should be sent back to fix (used once per run)."""
    summary = str((verdict or {}).get("summary") or "").strip()
    words = re.findall(r"[A-Za-z0-9-]+", summary)
    if findings_recorded == 0:
        return False, ("Rejected: no findings recorded. Call record_finding for each claim (cite the tids/accounts "
                       "from tool output), then submit_verdict again.")
    if len(words) < 8 or summary.lower() in JUNK:
        return False, ("Rejected: the summary must be 3-6 sentences that name the accounts and cite transaction "
                       "ids from your findings. Call submit_verdict again.")
    return True, ""
