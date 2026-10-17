"""Graph-driven autopilot: the no-LLM investigation brain.

Not a fixed script. Every step is chosen from what the previous graph query
returned:

  * the (:Playbook) for the typology sets the opening moves (procedural memory);
  * each result can NOMINATE further accounts - cycle partners, where traced
    money lands, the most central account nearby, flagged neighbours - with a
    reason and a priority;
  * a nominee is profiled first and only investigated if the graph shows it is
    relevant (alerts, ML >= 0.5 or IBM-labelled laundering) - a relevance gate
    in the spirit of RiskTagger's bounded expansion;
  * a budget caps accounts and tool calls.

Each decision is narrated as a `thinking` event, so the trace explains why the
next step happened.
"""
from __future__ import annotations

import heapq
import re
from typing import AsyncIterator, Callable, Dict, List, Optional, Tuple

INC_RE = re.compile(r"\bINC-[A-Z0-9]{1,8}\b", re.I)
ACCT_RE = re.compile(r"\b(?:\d{3,6}-[0-9A-F]{8,10}|ACC\d{5})\b", re.I)

MAX_ACCOUNTS = 4          # primary + 3 followed
MAX_STEPS = 34
FOLLOW_UP_TOOLS = ("trace_funds", "find_cycles")   # cheap, high-signal moves for followed accounts


def _fmt(x) -> str:
    return f"{float(x or 0):,.0f}"


def _short(a: str) -> str:
    return a if len(a) <= 14 else a[-12:]


class Frontier:
    """Max-priority queue of (account, reason, via_tids) nominations."""

    def __init__(self):
        self._h: List[Tuple[float, int, str, str, List[int]]] = []
        self._n = 0
        self.seen = set()

    def push(self, acct: str, score: float, reason: str, tids: Optional[List[int]] = None):
        if not acct or acct in self.seen:
            return
        self._n += 1
        heapq.heappush(self._h, (-score, self._n, acct, reason, tids or []))

    def pop(self):
        while self._h:
            s, _, a, r, t = heapq.heappop(self._h)
            if a not in self.seen:
                return a, -s, r, t
        return None

    def __len__(self):
        return len(self._h)


def _relevant(profile: Dict) -> Tuple[bool, str]:
    if not profile:
        return False, "not in the graph"
    alerts = len(profile.get("alerts") or [])
    ml = float(profile.get("max_ml_score") or 0)
    lab = int(profile.get("labelled_fraud_txns") or 0)
    if alerts or ml >= 0.5 or lab:
        bits = []
        if alerts:
            bits.append(f"{alerts} alert(s)")
        if ml >= 0.5:
            bits.append(f"ML {ml:.2f}")
        if lab:
            bits.append(f"{lab} IBM-labelled laundering txn(s)")
        return True, ", ".join(bits)
    return False, f"no alerts, ML {ml:.2f}, no labelled laundering"


def interpret(tool: str, env: Dict, acct: str, frontier: Frontier) -> Optional[Tuple[str, str, List[int], List[str]]]:
    """Turn a tool result into (claim, provenance, tids, accounts) and nominate next accounts."""
    m, data = env.get("metrics", {}) or {}, env.get("data")
    rows = env.get("rows") or 0
    if tool == "find_cycles":
        if not m.get("cycle_found"):
            return f"No closed fund cycle through {acct} within 6 hops.", "GRAPH", [], [acct]
        c = data[0]
        for member in c["cycle"][1:-1]:
            frontier.push(member, 3.0, f"on the same {c['length']}-hop cycle as {_short(acct)}", c["tids"])
        cur = sorted(set(c.get("currencies") or []))
        return (f"{acct} sits on a {c['length']}-hop round-trip {' -> '.join(c['cycle'])} moving "
                f"USD {_fmt(c['total_flow_usd'])} (USD-equivalent{', mixed ' + '/'.join(cur) if len(cur) > 1 else ''}) "
                f"over {c['span_hours']:.1f}h.", "GRAPH", c["tids"], c["cycle"])
    if tool == "trace_funds":
        if not rows:
            return (f"No time-ordered, amount-preserving onward chain leaves {acct} - funds do not appear to be "
                    f"layered onward.", "GRAPH", [], [acct])
        c = data[0]
        tids = [h["tid"] for h in c["hops"]]
        landing = c["path"][-1]
        fraud = sum(1 for h in c["hops"] if h.get("fraud"))
        frontier.push(landing, 2.5 + 0.3 * fraud, f"where money traced from {_short(acct)} lands", tids)
        first, last = c["hops"][0], c["hops"][-1]
        return (f"Money leaving {acct} moves {c['length']} hops onward in time order with USD-equivalent amounts "
                f"preserved (USD {_fmt(first.get('amount_usd'))} -> USD {_fmt(last.get('amount_usd'))}): "
                f"{' -> '.join(c['path'])}.", "GRAPH", tids, c["path"])
    if tool == "k_hop_neighbourhood" and rows:
        fl = sorted([r for r in data if r.get("alerts")], key=lambda r: -(r.get("alerts") or 0))
        if fl:
            frontier.push(fl[0]["account"], 1.0 + 0.3 * min(fl[0]["alerts"], 3),
                          f"most-flagged counterparty near {_short(acct)} ({fl[0]['alerts']} alerts)")
        return (f"{len(fl)} of {len(data)} counterparties within {m.get('k')} hops of {acct} are themselves flagged.",
                "GRAPH", [], [acct] + [r["account"] for r in fl[:10]])
    if tool == "pagerank_hubs" and rows:
        hubs = [r for r in data if r["account"] != acct]
        if hubs:
            h = hubs[0]
            frontier.push(h["account"], 1.5 + (0.5 if h.get("alerts") else 0),
                          f"most central account around {_short(acct)} (possible coordinator)")
            return (f"The most central account within 2 hops of {acct} is {h['account']} "
                    f"(PageRank {float(h.get('pagerank') or 0):.2e}, {h.get('alerts', 0)} alerts).",
                    "GRAPH", [], [acct, h["account"]])
        return None
    if tool == "community_of" and rows:
        d0 = data[0]
        return (f"{acct} belongs to community {d0['community']} of {d0['size']} accounts, "
                f"{d0['flagged_ratio'] * 100:.1f}% flagged.", "GRAPH", [], [acct])
    if tool == "shared_identifier_ring" and m.get("ring_size", 0) >= 2:
        d0 = data[0]
        return (f"{acct} shares devices/IP/KYC with {d0['ring_size'] - 1} accounts: "
                f"{', '.join(x['type'] + ' ' + x['value'] for x in d0['shared_identifiers'][:4])}.",
                "GRAPH", [], [acct] + [x["account"] for x in d0["members"]])
    if tool == "find_precedents" and rows:
        reviewed = [r for r in data if r.get("review")]
        if not reviewed:
            return None   # unreviewed agent proposals are not evidence (narrated by the caller)
        p0 = reviewed[0]
        review = {"APPROVES": "approved", "REJECTS": "rejected"}.get(p0.get("review") or "", "not yet reviewed")
        note = f' ("{p0["review_note"]}")' if p0.get("review_note") else ""
        return (f"Earlier investigation {p0['investigation']} (verdict {p0.get('verdict')}) touched this "
                f"neighbourhood via {p0.get('linking_accounts', 1)} shared account(s); its proposed "
                f"{p0.get('action') or 'action'} was {review} by {p0.get('reviewer') or 'nobody yet'}{note}.",
                "PRECEDENT", [], [acct])
    return None


async def graph_driven_loop(sess, question: str, graph_tools: bool, step_event: Callable,
                            gather_evidence: Callable, _depth: int = 0) -> AsyncIterator[Dict]:
    inc = INC_RE.search(question)
    acct_m = ACCT_RE.search(question)
    findings: List[str] = []
    key_account, typology = None, "ML-Detected Anomaly"

    async def call(tool, args):
        env = await sess.call(tool, args)
        return env, step_event(sess.n, tool, args, env)

    async def record(claim, prov, tids, accts, conf):
        env, ev = await call("record_finding", {"claim": claim, "provenance": prov, "account_ids": accts,
                                                "tids": tids, "confidence": conf})
        findings.append(env["data"]["finding_id"])
        return ev

    # ── 1. orient ─────────────────────────────────────────────────────────────
    if inc:
        inc_id = inc.group(0).upper()
        yield {"type": "thinking", "text": f"Orienting on incident {inc_id}."}
        env, ev = await call("get_incident", {"incident_id": inc_id})
        yield ev
        if env.get("rows"):
            d = env["data"][0]
            typology = d.get("pattern") or typology
            alerts = sorted(d["alerts"], key=lambda a: -(a.get("ml_score") or 0))
            weight: Dict[str, float] = {}
            for al in alerts:  # anchor on the account most implicated by corroborated (tier-1) alerts
                w = 3.0 if al.get("tier") == 1 else 1.0
                for a in al.get("accounts", []):
                    weight[a] = weight.get(a, 0) + w + float(al.get("ml_score") or 0)
            key_account = max(weight, key=lambda a: weight[a]) if weight else None
            top = alerts[0]
            yield await record(
                f"Incident {inc_id} ({d['severity']}, {typology}) groups {len(d['alerts'])} alerts moving "
                f"USD {_fmt(d.get('total_flow_usd'))} (USD-equivalent); strongest alert {top['alert_id']} tier {top.get('tier')} "
                f"ML {float(top.get('ml_score') or 0):.2f}.",
                "RULE" if top.get("tier") in (1, 3) else "ML", [], top.get("accounts", []), float(top.get("ml_score") or 0.5))
            if key_account:
                yield {"type": "thinking", "text": f"Anchoring on {key_account}: it is named by the most tier-1 / high-ML alerts in the incident."}
    elif acct_m:
        key_account = acct_m.group(0)
        if key_account.upper().startswith("ACC"):
            key_account = key_account.upper()
    elif _depth == 0:
        yield {"type": "thinking", "text": "No incident or account named - picking the largest open incident."}
        env, ev = await call("list_incidents", {"limit": 1})
        yield ev
        if env.get("rows"):
            async for e in graph_driven_loop(sess, f"Investigate {env['data'][0]['incident_id']}", graph_tools,
                                             step_event, gather_evidence, 1):
                yield e
            return

    if not key_account:
        yield {"type": "_verdict", "verdict": {"verdict": "UNCERTAIN", "confidence": 0.1,
                                               "summary": "Nothing to anchor the investigation on."}}
        return

    env, ev = await call("account_profile", {"account_id": key_account})
    yield ev
    prof = (env.get("data") or [{}])[0] or {}
    if prof.get("review_status"):
        yield {"type": "thinking", "text": f"The graph remembers: a supervisor marked {key_account} as {prof['review_status'].replace('_', ' ')}."}
    if prof.get("watchlists"):
        yield {"type": "thinking", "text": f"{key_account} is already on: {', '.join(prof['watchlists'])}."}
    if key_account.startswith("ACC"):
        typology = "Collusion Ring"

    # ── 2. plan from procedural memory ────────────────────────────────────────
    seq: List[str] = []
    if graph_tools:
        env, ev = await call("get_playbook", {"typology": typology})
        yield ev
        if env.get("rows"):
            pb = env["data"][0]
            seq = [t for t in pb["tool_sequence"] if t not in ("account_profile", "find_precedents")]
            yield {"type": "thinking", "text": f"Playbook '{pb['typology']}' ({pb.get('fatf_code')}) opens with: {', '.join(seq)}."}
    else:
        yield {"type": "thinking", "text": "Graph tools disabled - only flat lookups available; cannot trace money or follow accounts."}

    # ── 3. investigate the anchor, then follow what the graph nominates ───────
    frontier = Frontier()
    investigated: List[str] = []

    async def investigate(account: str, tools):
        frontier.seen.add(account)
        investigated.append(account)
        for tool in tools:
            if sess.n >= MAX_STEPS:
                return
            args = {"account_id": account}
            if tool == "trace_funds":
                args.update({"direction": "forward", "max_hops": 4, "window_hours": 168})
            elif tool == "pagerank_hubs":
                args = {"around_account": account, "limit": 5}
            env, ev = await call(tool, args)
            yield ev
            out = interpret(tool, env, account, frontier)
            if out:
                claim, prov, tids, accts = out
                yield await record(claim, prov, tids, accts, 0.8 if prov == "GRAPH" else 0.6)

    if graph_tools:
        async for e in investigate(key_account, seq):
            yield e
        while len(investigated) < MAX_ACCOUNTS and sess.n < MAX_STEPS:
            nxt = frontier.pop()
            if not nxt:
                break
            acct, score, reason, via = nxt
            frontier.seen.add(acct)
            yield {"type": "thinking", "text": f"Next lead: {acct} - {reason}. Profiling it before spending budget."}
            env, ev = await call("account_profile", {"account_id": acct})
            yield ev
            ok, why = _relevant((env.get("data") or [None])[0])
            if not ok:
                yield {"type": "thinking", "text": f"Dropping {acct}: {why}. The relevance gate keeps the investigation focused."}
                continue
            yield {"type": "thinking", "text": f"Following {acct} ({why})."}
            yield await record(f"Followed the money to {acct}: {reason}; it carries {why}.", "GRAPH", via[:20],
                               [key_account, acct], 0.7)
            async for e in investigate(acct, FOLLOW_UP_TOOLS):
                yield e
        if len(frontier):
            yield {"type": "thinking", "text": f"Budget reached ({len(investigated)} accounts); {len(frontier)} further leads left unexplored."}
        env, ev = await call("find_precedents", {"account_id": key_account})
        yield ev
        unrev = (env.get("metrics") or {}).get("unreviewed", 0)
        if unrev and not (env.get("metrics") or {}).get("reviewed"):
            yield {"type": "thinking", "text": f"{unrev} earlier agent proposal(s) touch this neighbourhood, but no human reviewed them - not used as evidence."}
        out = interpret("find_precedents", env, key_account, frontier)
        if out:
            yield await record(out[0], out[1], out[2], out[3], 0.6)

    # ── 4. act through the policy gate ────────────────────────────────────────
    ev_ = gather_evidence(sess.graph, sess.iid)
    strong = ev_["cycle_found"] or ev_["ring_size"] >= 3 or ev_["min_tier"] == 1 or ev_["max_ml_score"] >= 0.8
    action = "draft_str" if (strong and ev_.get("severity") == "CRITICAL") else ("escalate" if strong else "open_case")
    yield {"type": "thinking", "text": f"Requesting '{action}' - the policy gate decides what it becomes."}
    if action == "draft_str":
        env, ev = await call("draft_str", {"narrative": f"Graph-driven autopilot: {typology} evidence across "
                                                        f"{len(investigated)} account(s) starting at {key_account}.",
                                           "finding_ids": findings})
    else:
        env, ev = await call("propose_action", {"action": action, "rationale": f"{typology} evidence on {key_account}",
                                                "finding_ids": findings})
    yield ev
    dec = env.get("data", {})
    followed = investigated[1:]
    if followed and graph_tools:
        yield {"type": "thinking", "text": f"Acting directly on the {len(followed)} followed account(s): watchlisting is reversible, so the policy lets the agent do it without waiting."}
        env2, ev2 = await call("propose_action", {"action": "monitor", "account_ids": followed,
                                                  "rationale": f"Funds from {key_account} reach these accounts ({typology})."})
        yield ev2
    verdict = "ESCALATE" if dec.get("action_final") in ("escalate", "draft_str") else ("UNCERTAIN" if not graph_tools else "REVIEW")
    yield {"type": "_verdict", "verdict": {
        "verdict": verdict, "confidence": 0.8 if strong and graph_tools else 0.4, "typology": typology,
        "key_accounts": investigated or [key_account],
        "summary": (f"Graph-driven autopilot: {sess.n} graph tool calls across {len(investigated) or 1} account(s) "
                    f"({', '.join(investigated or [key_account])}), {typology}. "
                    f"Policy outcome: {dec.get('action_final') or dec.get('status')} ({dec.get('policy_rule')})."),
    }}
