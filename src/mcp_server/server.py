"""RUDRA graph-investigation MCP server.

Exposes the FalkorDB context graph as MCP tools: multi-hop reads, graph
algorithms, agent memory (precedents/playbooks), and three policy-gated
action tools. Every tool returns a JSON envelope including the exact Cypher
that ran and FalkorDB's own timing, so the agent's evidence is checkable.

    cd src && python -m mcp_server.server            # stdio (Claude Desktop / Claude Code / our agent)

Claude Code:  claude mcp add rudra-graph -- python -m mcp_server.server
The DB connection is lazy, so `tools/list` works even when FalkorDB is down.
"""
from __future__ import annotations

import json
import os
import sys
from typing import List, Optional

_SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

from mcp.server.mcpserver import MCPServer  # noqa: E402

from graphdb import queries as Q  # noqa: E402

mcp = MCPServer(
    name="rudra-graph",
    instructions=(
        "FalkorDB context graph for AML investigations. Evidence: Account, TXN (one edge per "
        "transaction, with tid/ts/amount/ml_score), Alert, Incident, identity links. Memory: "
        "Investigation, ToolCall, Finding, Decision, Playbook. Read tools return the Cypher they ran. "
        "Action tools (record_finding, propose_action, draft_str) are gated by a deterministic policy: "
        "the agent can only propose; a human approves."
    ),
)

_graph = None


def graph():
    global _graph
    if _graph is None:
        from graphdb.client import connect_from_env
        _, _graph = connect_from_env()
    return _graph


def _out(env) -> str:
    return json.dumps(env, default=str)


# -- reads: discovery ----------------------------------------------------------

@mcp.tool()
def get_graph_schema() -> str:
    """Labels, relationship types, counts and the meaning of every property in the context graph."""
    return _out(Q.get_graph_schema(graph()))


@mcp.tool()
def list_incidents(severity: Optional[str] = None, limit: int = 10) -> str:
    """Largest clustered incidents by total flow; optional severity filter (CRITICAL|HIGH|MEDIUM|LOW)."""
    return _out(Q.list_incidents(graph(), severity, limit))


@mcp.tool()
def get_incident(incident_id: str) -> str:
    """An incident's alerts (pattern, tier, ML score, flow) and the accounts each alert flags. Start here for 'investigate INC-xxxx'."""
    return _out(Q.get_incident(graph(), incident_id))


@mcp.tool()
def account_profile(account_id: str) -> str:
    """One account: type, risk score, PageRank, community, in/out volume, labelled fraud txns, max ML score, alerts flagging it."""
    return _out(Q.account_profile(graph(), account_id))


@mcp.tool()
def search_alerts(query: str, limit: int = 10) -> str:
    """Full-text search over alert descriptions and pattern types (e.g. 'cycle', 'structuring')."""
    return _out(Q.search_alerts(graph(), query, limit))


# -- reads: multi-hop + algorithms ---------------------------------------------

@mcp.tool()
def k_hop_neighbourhood(account_id: str, k: int = 2, min_amount: float = 0.0, limit: int = 60) -> str:
    """Counterparties within k (1-3) money hops in either direction, with hop distance and alert counts."""
    return _out(Q.k_hop_neighbourhood(graph(), account_id, k, min_amount, limit))


@mcp.tool()
def trace_funds(account_id: str, direction: str = "forward", max_hops: int = 4, window_hours: float = 72.0,
                keep_lo: float = 0.5, keep_hi: float = 1.1, min_amount: float = 0.0, limit: int = 10) -> str:
    """Temporal-causal money trail: chains where each hop happens AFTER the previous one (within window_hours)
    and carries forward keep_lo..keep_hi of its amount - i.e. the same money moving. direction: forward|backward."""
    return _out(Q.trace_funds(graph(), account_id, direction, max_hops, window_hours, keep_lo, keep_hi, min_amount, limit))


@mcp.tool()
def find_cycles(account_id: str, max_len: int = 6, min_amount: float = 0.0, temporal: bool = True, limit: int = 10) -> str:
    """Simple directed cycles through the account (round-tripping), 2..max_len hops; temporal=True requires hops in time order."""
    return _out(Q.find_cycles(graph(), account_id, max_len, min_amount, temporal, limit))


@mcp.tool()
def shortest_path(source_id: str, target_id: str, max_hops: int = 6) -> str:
    """Shortest directed money path between two accounts. No path within max_hops is evidence of separation."""
    return _out(Q.shortest_path(graph(), source_id, target_id, max_hops))


@mcp.tool()
def pagerank_hubs(limit: int = 10, around_account: Optional[str] = None) -> str:
    """Most central accounts by PageRank over all transactions (live algo.pageRank), or within 2 hops of around_account - finds coordinators / collection hubs."""
    return _out(Q.pagerank_hubs(graph(), limit, around_account))


@mcp.tool()
def community_of(account_id: str, limit: int = 15) -> str:
    """The account's weakly-connected community (WCC): size, share of flagged members, and the flagged members."""
    return _out(Q.community_of(graph(), account_id, limit))


@mcp.tool()
def refresh_graph_analytics() -> str:
    """Re-run PageRank, WCC and label propagation inside FalkorDB and write pr / community / lp_community onto every account (a few seconds). Use if the graph changed."""
    return _out(Q.refresh_graph_analytics(graph()))


@mcp.tool()
def shared_identifier_ring(account_id: str) -> str:
    """Accounts sharing a device, IP or KYC document with this one, transitively (mule-farm / synthetic-identity ring)."""
    return _out(Q.shared_identifier_ring(graph(), account_id))


@mcp.tool()
def run_cypher_readonly(cypher: str) -> str:
    """Escape hatch: run one READ-ONLY Cypher query (MATCH/CALL/RETURN; writes rejected; LIMIT 50 enforced). Use only when no other tool fits."""
    return _out(Q.run_cypher_readonly(graph(), cypher))


# -- reads: memory -------------------------------------------------------------

@mcp.tool()
def get_playbook(typology: str) -> str:
    """Procedural memory: the recommended tool sequence, FATF typology and legal basis for a pattern (e.g. 'Circular Transaction', 'ML-Detected Anomaly')."""
    return _out(Q.get_playbook(graph(), typology))


@mcp.tool()
def find_precedents(account_id: Optional[str] = None, typology: Optional[str] = None, limit: int = 10) -> str:
    """Long-term memory: earlier investigations, findings and human-reviewed decisions touching this account's 2-hop neighbourhood (or the same typology)."""
    return _out(Q.find_precedents(graph(), account_id, typology, limit))


# -- actions (policy-gated) ----------------------------------------------------

@mcp.tool()
def record_finding(investigation_id: str, claim: str, provenance: str, account_ids: List[str] = [],
                   tids: List[int] = [], alert_ids: List[str] = [], confidence: float = 0.5) -> str:
    """Write one evidence-backed claim to the decision trace. provenance: GRAPH (from a traversal/algorithm),
    ML (model score), RULE (detector alert), PRECEDENT (prior decision), INFERRED (your reasoning).
    Cite the transaction tids / alert ids / accounts the claim rests on; tids are verified against the graph."""
    from agent.actions import record_finding as _rf
    return _out(_rf(graph(), investigation_id, claim, provenance, account_ids, tids, alert_ids, confidence))


@mcp.tool()
def propose_action(investigation_id: str, action: str, rationale: str, finding_ids: List[str] = [],
                   account_ids: List[str] = []) -> str:
    """Take or propose an action: monitor | request_edd | open_case | escalate (STRs via draft_str).
    A deterministic policy decides from the graph evidence. monitor / request_edd are reversible and
    EXECUTE immediately (account_ids go on a watchlist in the graph); open_case / escalate wait for a
    SUPERVISOR. Closing/clearing is never permitted to the agent."""
    from agent.actions import propose_action as _pa
    return _out(_pa(graph(), investigation_id, action, rationale, finding_ids, account_ids=account_ids))


@mcp.tool()
def draft_str(investigation_id: str, narrative: str, finding_ids: List[str] = []) -> str:
    """Propose a Suspicious Transaction Report (PMLA Sec. 12). Policy requires a GRAPH finding and CRITICAL severity
    or confidence >= 85; otherwise it is downgraded. The draft is filled from the decision trace."""
    from agent.actions import draft_str as _ds
    return _out(_ds(graph(), investigation_id, narrative, finding_ids))


ACTION_TOOLS = ("record_finding", "propose_action", "draft_str")
# Flat lookups only - the 'graph tools off' removal test.
FLAT_TOOLS = ("get_incident", "account_profile", "search_alerts", "list_incidents") + ACTION_TOOLS


if __name__ == "__main__":
    mcp.run("stdio")
