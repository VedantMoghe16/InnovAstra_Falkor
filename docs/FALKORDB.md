# RUDRA Investigator — FalkorDB as the agent's context graph

Built for **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB, Oct 2026), Track 01 — *Agents That Act on Connected Data*.

RUDRA already detected money-laundering patterns (rule detectors + XGBoost/GraphSAGE/GAT ensemble on the IBM AML benchmark). What it lacked was an investigator: something that takes an alert, *follows the money*, decides what to do, and can show its working to a regulator. The Investigator agent is that layer, and **FalkorDB is where its context lives** — the evidence it reasons over and the memory of everything it has done.

## Why a graph, concretely

| Question an AML investigator asks | Why it is a graph query | Tool |
|---|---|---|
| Where did this money go next — the *same* money? | multi-hop path where each hop is later in time and preserves the amount | `trace_funds` |
| Does the money come back to where it started? | directed cycle through the account | `find_cycles` |
| Who else shares a phone / IP / PAN with this account? | transitive closure over identity edges | `shared_identifier_ring` |
| Who coordinates this neighbourhood? | PageRank over transfers | `pagerank_hubs` |
| Is this a closed ring or part of the open economy? | weakly-connected component + flagged density | `community_of` |
| Have we (or a human) already decided something about these people? | memory traversal from account → finding → decision → review | `find_precedents` |
| What is the procedure for this typology? | procedural memory node | `get_playbook` |

None of these is a lookup. Each is a traversal whose *shape* is the evidence, and each result names the exact transactions (`tid`) the agent then has to cite.

## Graph model (graph `rudra`)

```
EVIDENCE                                              MEMORY (written by the agent)
(:Account)-[:TXN {tid, ts, amount, rail,              (:Investigation)-[:ABOUT]->(:Account)
          is_fraud, ml_score}]->(:Account)            (:Investigation)-[:STEP {n}]->(:ToolCall {tool, cypher, rows, ms})
(:Alert {tier, ml_score, pattern_type})-[:FLAGS]->(:Account)
(:Incident)-[:CONTAINS]->(:Alert)                     (:Investigation)-[:FOUND]->(:Finding {claim, provenance, evidence_tids})
(:Account)-[:USES]->(:Device)                                                  -[:SUPPORTED_BY]->(:Account)
(:Account)-[:FROM_IP]->(:IP)                          (:Decision {action_final, status, policy_rule})-[:CAUSED_BY]->(:Finding)
(:Account)-[:HAS_KYC]->(:KYC)                         (:Decision)-[:IN]->(:Investigation)
                                                      (:Decision {actor:'human'})-[:APPROVES|REJECTS]->(:Decision)
PROCEDURE                                             (:Decision)-[:PRECEDENT_FOR]->(:Investigation)
(:Playbook {typology, tool_sequence, legal_basis})
```

* **One `TXN` edge per transaction.** RUDRA's NetworkX graph aggregates each sender→receiver pair; the agent needs per-transaction timestamps for temporal-causal tracing, so FalkorDB holds the multigraph.
* `ml_score` on `TXN` is the stacked-ensemble fraud score for that sender→receiver pair; `is_fraud` is the IBM ground-truth label (shown as evidence, never fed to the policy).
* The identity lane is RUDRA's synthetic identity dataset (IBM AML has no device/IP/KYC fields) and is labelled as such.

Loaded by `src/graphdb/falkor_loader.py` (idempotent `UNWIND … MERGE`, 5k rows per batch):

| | IBM AML 100k sample (local) |
|---|---|
| Accounts | 119,061 (incl. 150 identity-lane accounts) |
| TXN edges | 100,000 |
| Load time | ~16 s |
| `GRAPH.MEMORY USAGE` | 76 MB (Redis total ~110 MB) |

For the FalkorDB Cloud free tier (100 MB) load with `--limit 60000`: the sampler keeps every IBM-labelled laundering transaction and every transaction touching an alerted account first, then fills randomly.

## Tools (MCP server `rudra-graph`, 19 tools)

Every read tool returns an **envelope** — `{tool, data, cypher, params, rows, ms, provenance, metrics}` — so the exact Cypher and FalkorDB's own timing travel with the evidence. Measured on the full 100k graph, local Docker:

| Tool | What it runs | Typical DB time |
|---|---|---|
| `account_profile` | node + in/out aggregates + alerts | ~6 ms |
| `k_hop_neighbourhood` | `-[:TXN*1..k]-` with per-hop amount floor | ~45 ms (k=2) |
| `trace_funds` | `-[:TXN*1..4]->` + `all()` over consecutive hops: later in time, within window, amount kept 50–110% | ~47 ms |
| `find_cycles` | `(a)-[:TXN*1..n]->(x)-[:TXN]->(a)`, node-unique, time-ordered under rotation (found from any entry point) | ~33 ms |
| `community_of` | label-propagation community (computed by `algo.labelPropagation`) + flagged ratio + WCC component size | ~60 ms |
| `refresh_graph_analytics` | runs `algo.pageRank`, `algo.WCC`, `algo.labelPropagation` in FalkorDB and writes them onto accounts | ~4.5 s for 119k accounts |
| `pagerank_hubs` | live `CALL algo.pageRank('Account','TXN')` | ~59 ms |
| `shared_identifier_ring` | `-[:USES\|FROM_IP\|HAS_KYC*1..6]-` transitive | ~4 ms |
| `shortest_path` | `shortestPath(-[:TXN*1..6]->)` | ms |
| `find_precedents` | account → 2-hop → Finding → Decision → human review | ms |
| `get_playbook`, `get_incident`, `list_incidents`, `search_alerts` (full-text index), `get_graph_schema` | lookups | ms |
| `run_cypher_readonly` | guarded escape hatch (`GRAPH.RO_QUERY`, writes rejected, `LIMIT` enforced) | — |
| `record_finding` | writes a Finding, **verifies every cited tid exists** | — |
| `propose_action` | policy-gated Decision | — |
| `draft_str` | policy-gated STR draft filled from the decision trace | — |

Use it from any MCP client:

```bash
claude mcp add rudra-graph -- "$(pwd)/scripts/run_mcp_server.sh"
```

## The agent loop

```
question ─▶ create (:Investigation)
         ─▶ spawn MCP server, tools/list           (tools are discovered, not hard-coded)
         ─▶ get_incident / account_profile
         ─▶ get_playbook(typology)                 (procedural memory shapes the plan)
         ─▶ traversals + algorithms                (each call persisted as (:ToolCall) with its Cypher)
         ─▶ find_precedents                        (earlier human decisions constrain this one)
         ─▶ record_finding ×N                      (claims + provenance + cited tids, tids verified)
         ─▶ propose_action / draft_str             (policy.decide reads evidence back FROM THE GRAPH)
         ─▶ submit_verdict                         (ESCALATE | REVIEW | CLEAR_RECOMMENDED | UNCERTAIN)
SUPERVISOR ─▶ approve/reject (:Decision)          ─▶ case ESCALATED in the hash-chained case log
```

Two interchangeable brains drive the same tools and write the same trace:

* **Claude** (`ANTHROPIC_API_KEY` set; `RUDRA_AGENT_MODEL`, default `claude-sonnet-5-5`) chooses tools itself and must end with a structured `submit_verdict`.
* **Graph-driven autopilot** (no key). The `(:Playbook)` for the typology sets the opening moves; after that every step comes from what the graph returned. Results nominate further accounts (cycle partners, where traced money lands, the most central account nearby, flagged neighbours); each nominee is profiled and must pass a relevance gate (alerts, ML >= 0.5 or IBM-labelled laundering) before budget is spent; up to 4 accounts per investigation. On INC-2749 it follows the money across four accounts and narrates each choice.

### Where the graph decides, not the model

1. **Policy evidence comes from the graph.** `propose_action` does not trust the model's description of the evidence; `gather_policy_evidence` re-reads the investigation's own ToolCalls, Findings and the alerts flagging the cited accounts.
2. **Floor safety.** The agent can never close, clear, dismiss or de-escalate (rule P0). Escalation needs a tier-1 alert, ML ≥ 0.80, a cycle moving ≥ ₹2 lakh, or an identity ring of ≥ 3 (P1). An STR draft needs a GRAPH-provenance finding plus CRITICAL severity or confidence ≥ 85 (P2), mirroring the PMLA §12 bar already used in `fatf_typology`.
3. **Human precedent wins.** If a supervisor rejected a decision on these accounts in the last 30 days, a new escalation is held at `monitor` (P4). That rejection was written to the graph; the next investigation finds it by traversal.
4. **Provenance is checkable.** Findings must cite tids; `record_finding` reports which cited tids actually exist.
5. **Tiered autonomy.** Reversible, low-impact actions (`monitor`, `request_edd`) are executed by the agent itself: the accounts get an `ON_WATCHLIST` edge recording the investigation, decision and reason. `open_case`, `escalate` and `draft_str` wait for a supervisor.
6. **It learns.** A supervisor's review stamps `review_status` (`confirmed_suspicious` / `cleared_by_supervisor`) onto the accounts; `account_profile` shows it, a prior confirmation is an escalation basis, and a rejection holds future escalations at `monitor`.

### Decision trail

`GET /api/agent/investigations/{id}/trail` returns the reasoning as a graph - investigation -> findings -> accounts, decisions -> the findings that caused them, human reviews, watchlist targets and earlier investigations used as precedent. The UI shows it as a left-to-right layered graph next to the money evidence.

### Removal test

Run the same question with **graph tools off** (UI toggle, or `{"graph_tools": false}`): only flat lookups remain (incident, profile, alert search). The agent cannot trace, cannot find cycles or rings, has no playbook or memory, records no GRAPH findings — and the policy therefore refuses to let it draft an STR.

## Run it

```bash
docker run -d -p 6379:6379 -p 3000:3000 falkordb/falkordb:latest   # or: docker compose up falkordb
python src/run_pipeline.py                                          # RUDRA artefacts (once)
scripts/load_falkor.sh                                              # context graph
cd backend && uvicorn main:app --port 8000                          # API
cd frontend && npm run dev                                          # UI → Act › Investigator Agent
```

Tests: `pytest tests/test_policy.py tests/test_mcp_tools.py tests/test_agent_contract.py` (graph tests skip if FalkorDB is unreachable; the agent contract test uses a scripted LLM, so no API key is needed).

## FalkorDB specifics we hit (and how the code handles them)

* Variable-length bounds must be literals → hop counts are clamped integers formatted into the query; user text never is.
* A pattern that closes on its own start node (`(a)-[*]->(a)`) returned `nodes(p)` reversed relative to `relationships(p)` in our tests → cycles are matched as `(a)-[*1..n]->(x)-[:TXN]->(a)`, which keeps both lists in traversal order.
* Edge-index lookups must leave the endpoints unlabelled: `MATCH ()-[t:TXN]->() WHERE t.tid IN $tids` plans an *Edge By Index Scan* (~4 ms), while `MATCH (s:Account)-[t:TXN]->(d:Account) WHERE t.tid IN $tids` first label-scans all 119k accounts and timed out. Endpoints are read with `startNode(t)` / `endNode(t)`.
* `GRAPH.RO_QUERY` + per-query `timeout` for every read tool; a timeout comes back to the agent as `timed_out: true` with advice to narrow the query, rather than an exception.
* `algo.pageRank`, `algo.WCC`, `algo.labelPropagation` run inside FalkorDB at load (and on demand via `refresh_graph_analytics`), writing `pr`, `community`, `lp_community` onto every account - no graph analytics are computed outside the database.
