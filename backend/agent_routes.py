"""HTTP surface for the FalkorDB context graph + RUDRA Investigator agent.

Registered from main.py via `register(app, state, invalidate_caches)`. The
FalkorDB connection is lazy and optional: if FalkorDB is down, these routes
return 503 and the rest of RUDRA keeps working.
"""
from __future__ import annotations

import json
import os
from typing import Callable, Dict, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse

from rbac import get_role, require
from text_ascii import asciify


def register(app: FastAPI, state: Dict, invalidate_caches: Callable[[], None]) -> None:

    def falkor():
        g = state.get("falkor")
        if g is not None:
            return g
        try:
            from graphdb.client import connect_from_env
            _, g = connect_from_env()
            g.ro_query("RETURN 1")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(503, f"FalkorDB unavailable: {e}. Start it with "
                                     "`docker run -p 6379:6379 falkordb/falkordb` and load it with "
                                     "`python src/graphdb/falkor_loader.py --reset`.")
        state["falkor"] = g
        return g

    def _q():
        from graphdb import queries as Q
        return Q

    # -- graph status / evidence -----------------------------------------------

    @app.get("/api/graphdb/status")
    def graphdb_status():
        g = falkor()
        out = _q().status(g)
        from graphdb.client import graph_name
        from agent.investigator import pick_brain
        brain = pick_brain()
        out.update({"graph": graph_name(), "host": os.environ.get("FALKORDB_HOST", "localhost"),
                    "agent_mode": brain["mode"], "brain_unavailable": brain["reasons"],
                    "llm_unavailable_reason": brain["reasons"].get("claude", ""),
                    "agent_model": brain["model"],
                    "transport": os.environ.get("RUDRA_AGENT_TRANSPORT", "mcp")})
        return out

    @app.get("/api/graphdb/subgraph")
    def graphdb_subgraph(accounts: str = "", tids: str = "", limit: int = Query(300, le=1000)):
        accts = [a for a in accounts.split(",") if a.strip()]
        t = [int(x) for x in tids.split(",") if x.strip().lstrip("-").isdigit()]
        return _q().subgraph_for(falkor(), accts, t, limit)

    @app.get("/api/graphdb/tools")
    async def graphdb_tools():
        """The MCP tool catalogue as the agent sees it (via in-process tools/list)."""
        from mcp_server import server as srv
        tools = await srv.mcp.list_tools()
        return [{"name": t.name, "description": t.description,
                 "params": list((t.input_schema or {}).get("properties", {}).keys())} for t in tools]

    # -- agent -----------------------------------------------------------------

    @app.post("/api/agent/investigate")
    async def agent_investigate(body: dict, role: str = Depends(get_role)):
        require("agent.investigate", role)
        question = (body.get("question") or "").strip()
        if not question:
            raise HTTPException(400, "question required")
        g = falkor()
        graph_tools = bool(body.get("graph_tools", True))
        mode = body.get("mode") or None
        if mode not in (None, "llm", "gemini", "playbook"):
            raise HTTPException(400, "mode must be llm, gemini or playbook")
        if mode == "llm":
            from agent.investigator import llm_available
            llm = llm_available()
            if not llm["ok"]:
                raise HTTPException(400, f"Claude unavailable ({llm['reason']}); try gemini or the autopilot")
        if mode == "gemini":
            from agent.gemini_brain import resolve_model
            gm = resolve_model()
            if not gm["ok"]:
                raise HTTPException(400, f"Gemini unavailable ({gm['reason']}); use the autopilot")

        from agent.investigator import run_investigation

        async def sse():
            try:
                async for ev in run_investigation(question, graph=g, graph_tools=graph_tools, mode=mode):
                    yield f"data: {asciify(json.dumps(ev, default=str, ensure_ascii=False))}\n\n"
            except Exception as e:  # noqa: BLE001
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/agent/investigations")
    def agent_investigations(limit: int = Query(30, le=200)):
        return _q().list_investigations(falkor(), limit)

    @app.get("/api/agent/investigations/{investigation_id}")
    def agent_investigation(investigation_id: str):
        Q = _q()
        g = falkor()
        tr = Q.investigation_trace(g, investigation_id)
        if not tr:
            raise HTTPException(404, "investigation not found")
        accts = set(tr.get("about") or [])
        tids = set()
        for f in tr["findings"]:
            accts.update(f.get("accounts") or [])
            tids.update(f.get("tids") or [])
        tr["subgraph"] = Q.subgraph_for(g, sorted(accts), sorted(tids))
        return tr

    @app.get("/api/agent/investigations/{investigation_id}/trail")
    def agent_investigation_trail(investigation_id: str):
        """The decision trail as a graph (investigation, findings, decisions, reviews, accounts, precedents)."""
        trail = _q().decision_trail(falkor(), investigation_id)
        if not trail["nodes"]:
            raise HTTPException(404, "investigation not found")
        return trail

    @app.post("/api/agent/decisions/{decision_id}/review")
    def agent_review_decision(decision_id: str, body: dict, role: str = Depends(get_role)):
        """Human gate. SUPERVISOR/ADMIN approve or reject an agent-proposed decision.
        Approving escalate / draft_str moves the linked cases to ESCALATED through
        the normal case flow (hash-chained audit + taint seeding)."""
        require("agent.decision.approve", role)
        approve = bool(body.get("approve"))
        note = (body.get("note") or "").strip()
        rv = _q().review_decision(falkor(), decision_id, approve, role, note)
        if not rv:
            raise HTTPException(409, "decision not found or already reviewed")
        moved = []
        if approve and rv.get("action") in ("escalate", "draft_str") and state.get("cases") is not None:
            known = {a["alert_id"]: a for a in (state.get("alerts") or [])}
            ids = [a for a in rv.get("alert_ids") or [] if a in known][:10]
            for aid in ids:
                try:
                    if not state["cases"].get(aid):
                        state["cases"].open_case(known[aid])
                    state["cases"].dispose(
                        aid, "ESCALATED", author=role.lower(),
                        note=(f"Approved agent decision {decision_id} ({rv['action']}) from investigation "
                              f"{rv['investigation']}. {note}").strip())
                    if state.get("taint") and known[aid].get("entities"):
                        state["taint"].seed(state["graph"], known[aid]["entities"], source=f"AGENT:{decision_id}")
                    moved.append(aid)
                except Exception as e:  # noqa: BLE001 - a closed case can't be re-escalated; skip it
                    print(f"[agent] could not escalate {aid}: {e}")
            if moved:
                invalidate_caches()
        return {"decision_id": rv["decision_id"], "action": rv["action"], "status": rv["status"],
                "investigation": rv["investigation"], "accounts": len(rv.get("accounts") or []),
                "linked_alerts": len(rv.get("alert_ids") or []), "cases_escalated": moved,
                "has_str_draft": bool(rv.get("draft"))}
