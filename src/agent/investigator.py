"""RUDRA Investigator - an AML investigation agent whose context is a FalkorDB graph.

    async for event in run_investigation("Investigate incident INC-0001"):
        ...  # {"type": "mcp" | "thinking" | "step" | "verdict" | "token" | "done" | "error", ...}

Two brains, same tools, same decision trace:
  * LLM mode (ANTHROPIC_API_KEY set): Claude chooses graph tools discovered over
    MCP, records evidence-cited findings, proposes actions through the policy
    gate, and must finish with a structured `submit_verdict`.
  * Playbook autopilot (no key / RUDRA_AGENT_MODE=playbook): deterministic -
    reads the (:Playbook) for the incident's typology from the graph and runs
    its tool_sequence. Procedural memory literally drives the agent.

`graph_tools=False` is the removal test: only flat lookups (no traversals, no
algorithms, no memory) are exposed.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, AsyncIterator, Dict, List, Optional

from graphdb import queries as Q
from agent.grounding import check_verdict_quality

try:  # keys may live in .env files (gitignored); never override real env vars
    from dotenv import load_dotenv
    _ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    load_dotenv(os.path.join(_ROOT, ".env"))
    load_dotenv(os.path.join(_ROOT, "backend", ".env"))
except ImportError:
    pass

DEFAULT_MODEL = os.environ.get("RUDRA_AGENT_MODEL", "claude-sonnet-5-5")
MAX_RESULT_CHARS = 6000
VERDICTS = ("ESCALATE", "REVIEW", "CLEAR_RECOMMENDED", "UNCERTAIN")
ACTION_TOOLS = ("record_finding", "propose_action", "draft_str")
FLAT_TOOLS = ("get_incident", "account_profile", "search_alerts", "list_incidents") + ACTION_TOOLS

INC_RE = re.compile(r"\bINC-[A-Z0-9]{1,8}\b", re.I)
ACCT_RE = re.compile(r"\b(?:\d{3,6}-[0-9A-F]{8,10}|ACC\d{5})\b", re.I)

SUBMIT_VERDICT = {
    "name": "submit_verdict",
    "description": "Finish the investigation. Call exactly once, after recording findings and proposing actions.",
    "input_schema": {
        "type": "object",
        "properties": {
            "verdict": {"type": "string", "enum": list(VERDICTS)},
            "confidence": {"type": "number", "description": "0-1"},
            "summary": {"type": "string", "description": "3-6 sentence investigator summary citing tids/accounts."},
            "typology": {"type": "string", "description": "FATF typology / pattern name"},
            "key_accounts": {"type": "array", "items": {"type": "string"}},
            "contradicting_evidence": {"type": "array", "items": {"type": "string"},
                                       "description": "Evidence that cuts against the verdict (or what was checked and absent)."},
        },
        "required": ["verdict", "confidence", "summary"],
    },
}

SYSTEM_PROMPT = """You are RUDRA Investigator, an AML investigation agent for an Indian public-sector bank.
Your context is a FalkorDB graph: accounts, every transaction (TXN edges with tid, ts, amount, ml_score),
alerts, incidents, identity links - and your own memory of past investigations, findings and human decisions.

Method (follow it):
1. Orient: get_incident / account_profile for what the question names. If nothing is named, list_incidents.
2. get_playbook(<incident pattern>) and follow its tool_sequence - it is the bank's procedure for that typology.
3. Do multi-hop work with the graph tools (trace_funds, find_cycles, k_hop_neighbourhood, shortest_path,
   pagerank_hubs, community_of, shared_identifier_ring). Prefer them over run_cypher_readonly.
4. find_precedents for the key account - respect earlier human decisions.
5. record_finding for each claim, citing the exact tids / alert_ids / account ids from tool output.
   provenance: GRAPH (traversal/algorithm result), ML (model score), RULE (detector alert),
   PRECEDENT (earlier decision), INFERRED (your reasoning). Record contradicting evidence too.
6. Act. monitor / request_edd are reversible: they EXECUTE immediately and put the account_ids you pass on a
   watchlist - use them for accounts you followed that look involved. escalate / open_case / draft_str are
   proposals a supervisor must approve. A deterministic policy decides every action from graph evidence;
   if it downgrades or denies, accept that and say so. account_profile shows review_status - what a
   supervisor decided earlier - and watchlists; respect them.
7. submit_verdict.

Rules: never invent ids - only cite tids/accounts that appeared in tool output. An empty result is evidence
(e.g. "no cycle within 6 hops"). Amounts are in the transaction currency. Be concise between tool calls;
one short sentence on why you are calling the next tool. You may only recommend CLEAR - you cannot close cases.
The current investigation id is {iid}; action tools receive it automatically."""

FLAT_NOTE = """
NOTE: In this session graph traversal, graph algorithms and memory tools are DISABLED. You only have flat
lookups (incident, account profile, alert search). Do not pretend to have traced money; say what you cannot see."""


# -- helpers -------------------------------------------------------------------

_LLM_CHECK: Dict[str, Any] = {"ok": None, "at": 0.0, "reason": ""}


def llm_available(ttl: float = 600.0) -> Dict[str, Any]:
    """Is the Anthropic key present AND accepted? Cached; costs a models.list call, no tokens."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "reason": "ANTHROPIC_API_KEY not set"}
    if _LLM_CHECK["ok"] is not None and time.time() - _LLM_CHECK["at"] < ttl:
        return {"ok": _LLM_CHECK["ok"], "reason": _LLM_CHECK["reason"]}
    try:
        import anthropic
        anthropic.Anthropic(max_retries=0, timeout=5).models.list(limit=1)
        ok, reason = True, ""
    except Exception as e:  # noqa: BLE001
        name = type(e).__name__
        ok = name not in ("AuthenticationError", "PermissionDeniedError")
        reason = "" if ok else f"{name}: Anthropic rejected the API key"
    _LLM_CHECK.update(ok=ok, at=time.time(), reason=reason)
    return {"ok": ok, "reason": reason}


def pick_brain() -> Dict[str, Any]:
    """Which brain auto mode uses: Claude if its key works, else Gemini, else the autopilot."""
    c = llm_available()
    if c["ok"]:
        return {"mode": "llm", "model": DEFAULT_MODEL, "reasons": {}}
    from agent.gemini_brain import resolve_model
    gm = resolve_model()
    if gm["ok"]:
        return {"mode": "gemini", "model": gm["model"], "reasons": {"claude": c["reason"]}}
    return {"mode": "playbook", "model": None, "reasons": {"claude": c["reason"], "gemini": gm["reason"]}}


def _truncate_for_model(env: Dict) -> str:
    slim = {k: env.get(k) for k in ("tool", "data", "rows", "ms", "metrics", "note", "timed_out") if k in env}
    s = json.dumps(slim, default=str)
    if len(s) <= MAX_RESULT_CHARS:
        return s
    data = env.get("data")
    if isinstance(data, list):
        while data and len(s) > MAX_RESULT_CHARS:
            data = data[: max(1, len(data) // 2)] if len(data) > 1 else []
            slim["data"] = data
            slim["truncated"] = f"showing {len(data)} of {env.get('rows')} rows"
            s = json.dumps(slim, default=str)
    return s[:MAX_RESULT_CHARS]


def evidence_ids(obj: Any, accts: Optional[set] = None, tids: Optional[set] = None):
    """Pull account ids and transaction tids out of any envelope payload."""
    accts = set() if accts is None else accts
    tids = set() if tids is None else tids
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("tid",) and isinstance(v, int):
                tids.add(v)
            elif k in ("tids", "evidence_tids") and isinstance(v, list):
                tids.update(x for x in v if isinstance(x, int))
            elif k in ("account", "id", "from", "to", "via_account", "source", "target") and isinstance(v, str) and ACCT_RE.fullmatch(v):
                accts.add(v)
            elif k in ("accounts", "path", "cycle", "key_accounts", "account_ids") and isinstance(v, list):
                accts.update(x for x in v if isinstance(x, str) and ACCT_RE.fullmatch(x))
            else:
                evidence_ids(v, accts, tids)
    elif isinstance(obj, list):
        for x in obj:
            evidence_ids(x, accts, tids)
    return accts, tids


def _step_event(n: int, name: str, args: Dict, env: Dict) -> Dict:
    accts, tids = evidence_ids(env.get("data"))
    preview = env.get("data")
    if isinstance(preview, list):
        preview = preview[:3]
    return {"type": "step", "n": n, "tool": name, "args": args, "cypher": env.get("cypher", ""),
            "rows": env.get("rows", 0), "ms": env.get("ms", 0), "provenance": env.get("provenance"),
            "metrics": env.get("metrics", {}), "note": env.get("note"), "timed_out": env.get("timed_out", False),
            "error": (env.get("data") or {}).get("error") if isinstance(env.get("data"), dict) else None,
            "preview": preview, "accounts": sorted(accts)[:60], "tids": sorted(tids)[:200]}


class _Session:
    """Shared bookkeeping for both brains: runs a tool, persists the ToolCall,
    links accounts/typology, and builds the step event."""

    def __init__(self, graph, runner, iid: str, allowed: Optional[set]):
        self.graph, self.runner, self.iid, self.allowed = graph, runner, iid, allowed
        self.n = 0
        self.typology = ""
        self.findings_recorded = 0
        self.verdict_rejections = 0

    async def call(self, name: str, args: Dict) -> Dict:
        if self.allowed is not None and name not in self.allowed:
            env = {"tool": name, "data": {"error": f"tool '{name}' is disabled in this session"},
                   "rows": 0, "ms": 0, "cypher": "", "is_error": True}
        else:
            call_args = dict(args)
            if name in ACTION_TOOLS:
                call_args["investigation_id"] = self.iid
            env = await self.runner.call(name, call_args)
        env.setdefault("tool", name)
        self.n += 1
        if name == "record_finding" and not env.get("is_error") and isinstance(env.get("data"), dict) \
                and env["data"].get("finding_id"):
            self.findings_recorded += 1
        try:
            Q.write_tool_call(self.graph, self.iid, self.n, env, args)
        except Exception:
            pass
        if name in ("get_incident", "account_profile") and env.get("rows"):
            d = env["data"][0]
            accts = [d["id"]] if name == "account_profile" else \
                sorted({a for al in d.get("alerts", []) for a in al.get("accounts", [])})[:25]
            if name == "get_incident":
                self.typology = d.get("pattern") or self.typology
            try:
                Q.link_about(self.graph, self.iid, accts, self.typology)
            except Exception:
                pass
        return env


# -- LLM brain -----------------------------------------------------------------

async def _llm_loop(sess: _Session, question: str, graph_tools: bool, model: str, max_rounds: int,
                    client=None) -> AsyncIterator[Dict]:
    import anthropic
    client = client or anthropic.AsyncAnthropic()
    tools = __import__("agent.runners", fromlist=["to_anthropic_tools"]).to_anthropic_tools(
        sess.runner.tools, sorted(sess.allowed) if sess.allowed is not None else None)
    tools = tools + [SUBMIT_VERDICT]
    tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
    system = [{"type": "text", "text": SYSTEM_PROMPT.format(iid=sess.iid) + ("" if graph_tools else FLAT_NOTE),
               "cache_control": {"type": "ephemeral"}}]
    messages: List[Dict] = [{"role": "user", "content": question}]
    verdict = None
    usage = {"input": 0, "output": 0, "cache_read": 0}
    rnd = 0
    while rnd < max_rounds + sess.verdict_rejections * 2:
        force = rnd >= max_rounds - 1 + sess.verdict_rejections * 2
        rnd += 1
        resp = await client.messages.create(
            model=model, max_tokens=2048, system=system, tools=tools, messages=messages,
            tool_choice={"type": "tool", "name": "submit_verdict"} if force else {"type": "auto"})
        u = getattr(resp, "usage", None)
        if u is not None:
            usage["input"] += getattr(u, "input_tokens", 0) or 0
            usage["output"] += getattr(u, "output_tokens", 0) or 0
            usage["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0
        results = []
        for block in resp.content:
            if block.type == "text" and block.text.strip():
                yield {"type": "thinking", "text": block.text.strip()}
            elif block.type == "tool_use":
                if block.name == "submit_verdict":
                    cand = dict(block.input or {})
                    ok, why = check_verdict_quality(cand, sess.findings_recorded)
                    if ok or sess.verdict_rejections >= 1:
                        verdict = cand
                        results.append({"type": "tool_result", "tool_use_id": block.id, "content": "recorded"})
                    else:
                        sess.verdict_rejections += 1
                        yield {"type": "thinking", "text": f"Verdict sent back to the model: {why}"}
                        results.append({"type": "tool_result", "tool_use_id": block.id, "content": why, "is_error": True})
                    continue
                args = dict(block.input or {})
                env = await sess.call(block.name, args)
                yield _step_event(sess.n, block.name, args, env)
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": _truncate_for_model(env), "is_error": bool(env.get("is_error"))})
        if verdict is not None:
            break
        if not results:  # model stopped without a verdict -> force one next round
            messages.append({"role": "assistant", "content": resp.content})
            messages.append({"role": "user", "content": "Call submit_verdict now."})
            continue
        messages.append({"role": "assistant", "content": resp.content})
        messages.append({"role": "user", "content": results})
    yield {"type": "_verdict", "verdict": verdict or {"verdict": "UNCERTAIN", "confidence": 0.2,
                                                       "summary": "Round budget exhausted before a verdict."},
           "usage": usage}


# -- Graph-driven autopilot (no LLM) lives in agent/autopilot.py --------------

def _playbook_loop(sess, question, graph_tools):
    from agent.autopilot import graph_driven_loop
    return graph_driven_loop(sess, question, graph_tools, _step_event, Q.gather_policy_evidence)


# -- public entry point --------------------------------------------------------

async def run_investigation(question: str, *, graph=None, graph_tools: bool = True, runner=None,
                            mode: Optional[str] = None, model: Optional[str] = None, max_rounds: int = 12,
                            client=None, investigation_id: Optional[str] = None) -> AsyncIterator[Dict]:
    from agent.runners import make_runner
    from graphdb.client import connect_from_env

    if graph is None:
        _, graph = connect_from_env()
    auto = not (mode or os.environ.get("RUDRA_AGENT_MODE"))
    mode = mode or os.environ.get("RUDRA_AGENT_MODE") or pick_brain()["mode"]
    model = model or DEFAULT_MODEL
    t0 = time.time()
    accts = [m.group(0) for m in ACCT_RE.finditer(question)]
    iid = Q.create_investigation(graph, question, mode=("graph" if graph_tools else "flat") + "/" + mode,
                                 account_ids=accts, investigation_id=investigation_id)
    runner = runner or make_runner()
    allowed = None if graph_tools else set(FLAT_TOOLS)
    final: Dict = {}
    usage = None
    try:
        async with runner:
            visible = [t.name for t in runner.tools if allowed is None or t.name in allowed]
            shown_model = model if mode == "llm" else (pick_brain()["model"] if mode == "gemini" else None)
            yield {"type": "mcp", "investigation_id": iid, "transport": runner.transport,
                   "tools": visible, "tools_total": len(runner.tools), "mode": mode,
                   "model": shown_model, "graph_tools": graph_tools}
            sess = _Session(graph, runner, iid, allowed)
            if mode == "llm":
                loop = _llm_loop(sess, question, graph_tools, model, max_rounds, client)
            elif mode == "gemini":
                from agent.gemini_brain import gemini_loop
                loop = gemini_loop(sess, question, graph_tools, None if model == DEFAULT_MODEL else model,
                                   max_rounds, SYSTEM_PROMPT.format(iid=iid) + ("" if graph_tools else FLAT_NOTE),
                                   SUBMIT_VERDICT, _step_event, _truncate_for_model)
            else:
                loop = _playbook_loop(sess, question, graph_tools)
            try:
                async for ev in loop:
                    if ev["type"] == "_verdict":
                        final, usage = ev["verdict"], ev.get("usage")
                    else:
                        yield ev
            except Exception as e:  # noqa: BLE001
                auth = type(e).__name__ in ("AuthenticationError", "PermissionDeniedError") or "API_KEY" in str(e)
                if not (auto and mode in ("llm", "gemini") and auth):
                    raise
                if mode == "llm":
                    _LLM_CHECK.update(ok=False, at=time.time(), reason=f"{type(e).__name__}: key rejected")
                yield {"type": "thinking", "text": f"The {'Claude' if mode == 'llm' else 'Gemini'} API key was rejected - continuing with the graph-driven autopilot."}
                async for ev in _playbook_loop(sess, question, graph_tools):
                    if ev["type"] == "_verdict":
                        final = ev["verdict"]
                    else:
                        yield ev
            final["verdict"] = final.get("verdict") if final.get("verdict") in VERDICTS else "UNCERTAIN"
            if sess.typology and not final.get("typology"):
                final["typology"] = sess.typology
    except Exception as e:  # noqa: BLE001
        final = {"verdict": "UNCERTAIN", "confidence": 0.0, "summary": f"Investigation aborted: {e}"}
        yield {"type": "error", "message": str(e)}
    from agent.grounding import ground_verdict
    final = ground_verdict(final, Q.investigation_trace(graph, iid) or {})
    Q.finish_investigation(graph, iid, final)
    trace = Q.investigation_trace(graph, iid) or {}
    yield {"type": "verdict", "investigation_id": iid, **final,
           "findings": trace.get("findings", []), "decisions": trace.get("decisions", []),
           "precedents": trace.get("precedents", []), "steps": len(trace.get("steps", [])),
           "seconds": round(time.time() - t0, 1), "usage": usage}
    summary = final.get("summary", "")
    for i in range(0, len(summary), 48):
        yield {"type": "token", "text": summary[i:i + 48]}
    yield {"type": "done", "investigation_id": iid}
