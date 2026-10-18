<p align="center"><img src="docs/assets/rudra-logo.png" alt="RUDRA - Fund-flow intelligence" width="520"></p>

# RUDRA Investigator

**An anti-money-laundering agent that follows the money through a FalkorDB graph, cites the exact transactions behind every claim, and can escalate but never close.**

Built for **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB, Oct 15–18 2026).

## Submission at a glance

| Requirement | Where |
|---|---|
| **Track** | **Track 01: Agents That Act on Connected Data** |
| Source code | https://github.com/VedantMoghe16/InnovAstra_Falkor (public) |
| Demo video | `VIDEO_URL` |
| Live deployment | **https://rudra-investigator.vercel.app** (sign in with any demo account; API on Render free tier, graph on FalkorDB Cloud free tier). If the API was asleep, the first request takes about a minute. The live graph is a 35,000-transaction sample that keeps every flagged transaction (the free tier is 100 MB), and the API runs a lean profile, so the in-memory analytics pages (network graph, fund journey) are local-only. Full local setup is [below](#run-it-locally). |
| Graph data model | [Graph data model](#graph-data-model) |
| Cypher queries and graph algorithms | [The Cypher the product depends on](#the-cypher-the-product-depends-on); full catalogue in [`src/graphdb/queries.py`](src/graphdb/queries.py) |
| Setup instructions | [Run it locally](#run-it-locally) |
| AI coding assistant disclosure | [Use of AI coding assistants](#use-of-ai-coding-assistants) |
| Data used | Public and synthetic only. See [Data](#data) |
| Write-up | [`docs/BLOG.md`](docs/BLOG.md) |

---

## What it does, in 30 seconds

A bank's fraud system raises thousands of alerts. Each one costs an analyst hours: where did the money go next, did it come back, who shares a phone or KYC document with this account, has anyone already decided about these people. Every one of those questions is a hop across connected data.

RUDRA Investigator does that work:

1. **Investigates over the graph.** Given an incident or account, the agent discovers 19 graph tools over **MCP** and runs multi-hop traversals in FalkorDB: temporal-causal money traces, cycles, shared-identity rings, PageRank hubs, communities.
2. **Cites evidence.** Every finding carries a provenance tag (`GRAPH` / `ML` / `RULE` / `PRECEDENT` / `INFERRED`) and the transaction ids it relies on. Cited ids are checked against the graph.
3. **Acts, within rules.** It proposes actions (watchlist, request EDD, open case, escalate, draft a Suspicious Transaction Report). A deterministic policy decides what each proposal becomes, using evidence it **reads back from the graph**, not from the model's description. Reversible actions run immediately; the rest wait for a supervisor. The agent can never close or clear a case.
4. **Remembers.** Every tool call, finding, decision and human review is written into the same graph. The next investigation reaches earlier decisions by traversal, and a supervisor's rejection holds back future escalations on the same accounts.

## Why FalkorDB is load-bearing (the removal test)

The rules say the product must stop working without the graph. We built that test into the product: a **"graph tools off"** toggle (`{"graph_tools": false}` on the API).

| | Graph on | Graph off |
|---|---|---|
| Tools available | 19 (traversals, algorithms, memory, actions) | 3 flat lookups |
| Money traces, cycles, identity rings | yes | none |
| `GRAPH` findings with cited transaction ids | 6 findings, 14 verified tids (same model, same question) | 0 |
| Verdict | ESCALATE, confidence grounded to what the trace supports | capped at REVIEW / 0.5 |
| Can draft an STR | yes, if policy bar met | **refused by policy** (needs a GRAPH finding) |

FalkorDB holds three things the agent cannot work without: the **evidence** (every transaction as an edge), the **procedure** (playbooks per typology), and the **memory** (investigations, findings, decisions, human reviews). Policy evidence is read from FalkorDB; there is no second copy anywhere else.

---

## Graph data model

Graph name: `rudra`. 119,061 accounts, 100,000 `TXN` edges, loads in ~16 s, 76 MB.

```
EVIDENCE                                          MEMORY (written by the agent and by humans)
(:Account)-[:TXN {tid, ts, amount, currency,      (:Investigation)-[:ABOUT]->(:Account)
   amount_usd, rail, is_fraud, ml_score}]->       (:Investigation)-[:STEP {n}]->(:ToolCall {tool, cypher, rows, ms})
   (:Account)                                     (:Investigation)-[:FOUND]->(:Finding {claim, provenance, evidence_tids})
(:Alert {tier, ml_score, pattern_type})           (:Finding)-[:SUPPORTED_BY]->(:Account)
   -[:FLAGS]->(:Account)                          (:Decision {action_final, status, policy_rule})-[:CAUSED_BY]->(:Finding)
(:Incident)-[:CONTAINS]->(:Alert)                 (:Decision)-[:IN]->(:Investigation)
(:Account)-[:USES]->(:Device)                     (:Decision {actor:'human'})-[:APPROVES|REJECTS]->(:Decision)
(:Account)-[:FROM_IP]->(:IP)                      (:Decision)-[:PRECEDENT_FOR]->(:Investigation)
(:Account)-[:HAS_KYC]->(:KYC)                     (:Account)-[:ON_WATCHLIST]->(:Watchlist)

PROCEDURE
(:Playbook {typology, fatf_code, tool_sequence, legal_basis})
```

Design choices:

* **One `TXN` edge per transaction, not one per account pair.** Following "the same money" needs per-transaction timestamps and amounts, so FalkorDB holds the full multigraph.
* **Evidence and memory in one graph.** "Has anyone looked at this before?" becomes a longer path, not a join across two systems.
* **`amount_usd` on every edge.** The data mixes 15 currencies; a fixed FX table ([`src/graphdb/fx.py`](src/graphdb/fx.py)) normalises them so thresholds and totals are comparable.
* **Graph analytics live in the database.** PageRank, WCC and label-propagation community ids are computed by FalkorDB and written onto each account.

Schema and indexes: [`src/graphdb/schema.py`](src/graphdb/schema.py). Loader: [`src/graphdb/falkor_loader.py`](src/graphdb/falkor_loader.py) (idempotent `UNWIND … MERGE`, 5k rows per batch).

---

## The Cypher the product depends on

All Cypher lives in one file, [`src/graphdb/queries.py`](src/graphdb/queries.py), shared by the MCP server and the backend. Every read tool returns an envelope `{data, cypher, params, rows, ms, provenance, metrics}`, so the exact query and FalkorDB's timing travel with the evidence. Timings below are on the full graph, local Docker.

**1. Temporal-causal money trace** (`trace_funds`, ~47 ms). Not just "a path exists": each hop must be later than the previous one, inside a time window, and carry forward 50–110% of the amount.

```cypher
MATCH p = (a:Account {id: $id})-[:TXN*1..4]->(x:Account)
WHERE x <> a AND all(r IN relationships(p) WHERE r.amount_usd >= $min_amount)
WITH p, relationships(p) AS rs, nodes(p) AS ns
WHERE all(i IN range(0, size(rs) - 2) WHERE
        rs[i+1].ts > rs[i].ts AND rs[i+1].ts - rs[i].ts <= $window_s
        AND rs[i+1].amount_usd >= rs[i].amount_usd * $keep_lo
        AND rs[i+1].amount_usd <= rs[i].amount_usd * $keep_hi)
```

**2. Round-tripping cycles** (`find_cycles`, ~33 ms). The closing hop is written separately so `nodes(p)` and `relationships(p)` stay in traversal order. A temporal clause accepts any time-ordered rotation, so the loop is found from whichever account you enter it.

```cypher
MATCH p = (a:Account {id: $id})-[:TXN*1..5]->(x:Account)-[:TXN]->(a)
```

**3. Shared-identity rings** (`shared_identifier_ring`, ~4 ms). Transitive across devices, IPs and KYC documents: catches mules with no money link.

```cypher
MATCH (a:Account {id: $id})-[:USES|FROM_IP|HAS_KYC*1..6]-(b:Account)
WHERE b <> a
```

**4. Precedent from memory** (`find_precedents`). Earlier investigations touching this account or its 2-hop money neighbourhood, with any human review.

```cypher
MATCH (a:Account {id: $id})
MATCH (a)-[:TXN*0..2]-(n:Account)<-[:SUPPORTED_BY]-(f:Finding)<-[:FOUND]-(inv:Investigation)
WHERE inv.status = 'complete'
OPTIONAL MATCH (d:Decision)-[:IN]->(inv)
OPTIONAL MATCH (h:Decision {actor: 'human'})-[rv:APPROVES|REJECTS]->(d)
```

**5. Policy evidence read back from the graph** (`gather_policy_evidence`). The policy never trusts the model; it re-reads the investigation's own trace, and human rejections on these accounts.

```cypher
UNWIND $accts AS aid
MATCH (a:Account {id: aid})<-[:SUPPORTED_BY]-(:Finding)<-[:CAUSED_BY]-(d:Decision)
      <-[rv:APPROVES|REJECTS]-(h:Decision {actor: 'human'})
RETURN DISTINCT h.id AS id, type(rv) AS review, h.ts AS ts
```

**6. Graph algorithms run inside FalkorDB** (`refresh_graph_analytics`, ~4.5 s for 119k accounts; live `pagerank_hubs` ~59 ms).

```cypher
CALL algo.pageRank('Account', 'TXN') YIELD node, score SET node.pr = score
CALL algo.WCC({nodeLabels: ['Account'], relationshipTypes: ['TXN']}) YIELD node, componentId SET node.community = componentId
CALL algo.labelPropagation({nodeLabels: ['Account'], relationshipTypes: ['TXN'], ...}) YIELD node, communityId SET node.lp_community = communityId
```

<details>
<summary><b>All 19 MCP tools</b></summary>

| Tool | What it runs |
|---|---|
| `account_profile` | node + in/out aggregates + alerts + watchlist (~6 ms) |
| `k_hop_neighbourhood` | `-[:TXN*1..k]-` with per-hop amount floor (~45 ms, k=2) |
| `trace_funds` | temporal-causal trace, forward or backward |
| `find_cycles` | time-ordered directed cycles |
| `shortest_path` | `shortestPath(-[:TXN*1..6]->)` |
| `pagerank_hubs` | live `algo.pageRank`, or stored `pr` around an account |
| `community_of` | label-propagation community + flagged ratio + WCC size |
| `refresh_graph_analytics` | recompute PageRank / WCC / label propagation in FalkorDB |
| `shared_identifier_ring` | transitive identity ring |
| `find_precedents` | memory traversal to earlier findings, decisions, reviews |
| `get_playbook` | procedural memory per FATF typology |
| `get_incident`, `list_incidents`, `search_alerts`, `get_graph_schema` | lookups (full-text index on alerts) |
| `run_cypher_readonly` | guarded escape hatch: `GRAPH.RO_QUERY`, writes rejected, `LIMIT` enforced, unknown labels reported |
| `record_finding` | writes a Finding, verifies every cited tid exists |
| `propose_action` | policy-gated Decision |
| `draft_str` | policy-gated STR draft built from the decision trace |

Use them from any MCP client: `claude mcp add rudra-graph -- "$(pwd)/scripts/run_mcp_server.sh"`

</details>

---

## How the agent decides

```
question ─▶ (:Investigation) created in FalkorDB
         ─▶ MCP tools/list                      tools are discovered, not hard-coded
         ─▶ get_incident / account_profile
         ─▶ get_playbook(typology)              procedural memory sets the opening
         ─▶ traversals + algorithms             each call stored as (:ToolCall) with its Cypher
         ─▶ find_precedents                     earlier human decisions constrain this one
         ─▶ record_finding ×N                   claims + provenance + verified tids
         ─▶ propose_action / draft_str          policy reads its evidence FROM THE GRAPH
         ─▶ submit_verdict                      capped by what the trace actually contains
SUPERVISOR ─▶ approve / reject                  written back as precedent + hash-chained case log
```

**Policy** ([`src/agent/policy.py`](src/agent/policy.py), pure, no LLM):

| Rule | What it enforces |
|---|---|
| P0 floor safety | close / clear / dismiss / de-escalate are always denied to the agent |
| P1 escalate basis | needs a tier-1 alert, ML ≥ 0.80, a cycle moving ≥ USD 10,000, an identity ring ≥ 3, or a supervisor-confirmed account; otherwise downgraded to `open_case` |
| P2 STR bar | needs a `GRAPH` finding plus CRITICAL severity or confidence ≥ 85 |
| P3 tiered autonomy | `monitor` and `request_edd` execute immediately (`ON_WATCHLIST` edge); everything else waits for a supervisor |
| P4 human precedent | a supervisor rejection on these accounts in the last 30 days holds new escalations at `monitor` |

**Grounding** ([`src/agent/grounding.py`](src/agent/grounding.py)) caps the final verdict by the trace: no `GRAPH` finding means at most REVIEW at 0.5 confidence, and non-existent cited tids cut confidence further.

**Three interchangeable brains** drive the same tools and write the same trace: Claude (`ANTHROPIC_API_KEY`), Gemini (`GEMINI_API_KEY`), or a **no-LLM graph-driven autopilot** where the playbook opens and graph results nominate the next accounts to follow. No API key is needed to run the demo.

**Three roles, three screens:** Investigator (*My work*), Supervisor (*Approvals*), Admin (*System*: health, active brain, tools, policy log).

---

## Run it locally

### Fast path (about 5 minutes, no training)

Uses the prebuilt pipeline artefacts from the [`data-v1` release](https://github.com/VedantMoghe16/InnovAstra_Falkor/releases/tag/data-v1) (19 MB).

Requires Python 3.10+, Node 20+, Docker.

```bash
git clone https://github.com/VedantMoghe16/InnovAstra_Falkor.git
cd InnovAstra_Falkor
pip install -r requirements.txt

# 1. Prebuilt artefacts (alerts, incidents, ML scores for the IBM AML 100k sample)
curl -L https://github.com/VedantMoghe16/InnovAstra_Falkor/releases/download/data-v1/rudra-data-ibm_aml.tar.gz | tar -xz

# 2. FalkorDB (browser UI on http://localhost:3000)
docker run -d --name falkordb -p 6379:6379 -p 3000:3000 falkordb/falkordb:latest

# 3. Load the context graph (~16 s)
scripts/load_falkor.sh

# 4. API (terminal 1)
cd backend && RUDRA_DATASET=ibm_aml uvicorn main:app --port 8000

# 5. UI (terminal 2)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173, sign in as the **Investigator**, open **Investigator Agent**, and run `Investigate incident INC-2749`. Then sign in as the **Supervisor** to approve or reject.

Optional: `export ANTHROPIC_API_KEY=...` or `GEMINI_API_KEY=...` before step 4 to use an LLM brain. Without one, the graph-driven autopilot runs.

See the decision trace as a graph in the FalkorDB Browser (http://localhost:3000):

```cypher
MATCH (i:Investigation)-[r]->(x) RETURN i, r, x LIMIT 50
```

### Full rebuild from the raw dataset (optional, ~15 minutes)

Download the IBM AML CSV (see [Data](#data)) into `data/real/ibm_aml/`, then replace step 1 with:

```bash
python src/run_pipeline.py      # detectors + XGBoost/GraphSAGE/ensemble + tiered alerts + incidents
```

### Docker Compose

`docker compose up` starts FalkorDB, Kafka, the API and the UI together (needs the artefacts from step 1 under `data/`). Then run `scripts/load_falkor.sh`.

### Checks

```bash
curl localhost:8000/api/health              # "falkordb": true
curl localhost:8000/api/graphdb/status      # account and TXN counts
pytest tests/test_policy.py tests/test_mcp_tools.py tests/test_agent_contract.py
```

Graph tests use separate graphs (`rudra_test`, `rudra_agent_test`) and skip if FalkorDB is unreachable. The agent contract test uses a scripted LLM, so no API key is needed. Deployment notes: [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Architecture

```
React UI (3 roles) ──▶ FastAPI  ──▶ Agent (Claude | Gemini | autopilot)
                         │              │  MCP tools/list, tools/call
                         │              ▼
                         │         MCP server rudra-graph (19 tools)
                         │              │  Cypher (GRAPH.RO_QUERY for reads)
                         ▼              ▼
              Case system (SQLite,   FalkorDB graph `rudra`
              SHA-256 hash chain) ◀── evidence + playbooks + memory
                         ▲
              policy.decide ── supervisor approval bridges into the case log
```

| Path | Role |
|---|---|
| [`src/graphdb/`](src/graphdb/) | FalkorDB client, schema, loader, Cypher catalogue, FX table |
| [`src/mcp_server/server.py`](src/mcp_server/server.py) | MCP server exposing the 19 tools |
| [`src/agent/`](src/agent/) | investigator loop, autopilot, policy, grounding, action tools, MCP runners |
| [`backend/agent_routes.py`](backend/agent_routes.py) | agent API: investigate (SSE), decisions, review, trail |
| `frontend/src/pages/` | `Investigator.jsx`, `MyWork.jsx`, `SupervisorHome.jsx` (Approvals), `AdminHome.jsx` (System) |

FalkorDB specifics we hit and how the code handles them: [`docs/FALKORDB.md`](docs/FALKORDB.md#falkordb-specifics-we-hit-and-how-the-code-handles-them).

---

## What is new for this hackathon vs. reused

| Built during Graph Hacks (Oct 15–18 2026) | Reused from the earlier RUDRA build |
|---|---|
| FalkorDB graph model, loader, schema, FX normalisation (`src/graphdb/`) | Rule detectors, XGBoost / GraphSAGE / ensemble models |
| Cypher tool catalogue (`src/graphdb/queries.py`) | Alert tiering and incident clustering |
| MCP server (`src/mcp_server/`) | Hash-chained case manager |
| Agent, autopilot, policy, grounding, decision-trace memory (`src/agent/`) | Base UI shell and pre-existing pages |
| Agent API (`backend/agent_routes.py`) | |
| Investigator, Approvals, My work, System pages; role-based homes | |

The reused platform produces the alerts and ML scores that the graph is loaded from. It is documented separately in [`docs/RUDRA_PLATFORM.md`](docs/RUDRA_PLATFORM.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Use of AI coding assistants

We used AI coding assistants heavily, and we are disclosing it plainly.

| | |
|---|---|
| **Tool** | Claude Code (Anthropic), running Claude Opus models |
| **Scope** | Used throughout the hackathon build. Every commit in this repository carries a `Co-Authored-By: Claude` trailer. |
| **What the AI did** | Wrote and refactored code on request (Cypher queries, loader, MCP server, agent loop, API routes, React pages), wrote tests, debugged failures, drafted documentation and the blog. |
| **What the team did** | Chose the problem and the track; designed the graph model (evidence + procedure + memory in one graph) and the policy rules P0–P4; decided what the agent may and may not do; ran and inspected every query against FalkorDB; reviewed every change before committing; ran the removal test and the live investigations reported here. |
| **How we verified AI output** | Automated tests (policy, MCP tools, agent contract with a scripted LLM); every Cypher query run against the real graph with timings recorded; query plans checked when queries were slow (this is how the edge-index and cycle-ordering issues in [`docs/FALKORDB.md`](docs/FALKORDB.md) were found); bugs such as summing 15 currencies and the agent citing its own unreviewed proposals were caught by us reading results, then fixed. |

**AI inside the product** is separate from the above: the Investigator can use Claude or Gemini as its reasoning brain at runtime. That is optional and gated: the model only proposes; a deterministic policy and a human decide.

---

## Data

Only public and synthetic data. No private, personal or restricted information is loaded.

| Data | Source | Notes |
|---|---|---|
| Transactions | [IBM Transactions for Anti Money Laundering (AML)](https://www.kaggle.com/datasets/ealtman2019/ibm-transactions-for-anti-money-laundering-aml), public Kaggle dataset | Itself **synthetic** (generated by IBM's simulator). 100k-transaction stratified sample. |
| Device / IP / KYC identity lane | Generated by [`src/identity_generator.py`](src/identity_generator.py) | IBM AML has no identity fields; this lane is synthetic and labelled so in the API and UI. |
| Alerts, incidents, ML scores | Produced by the pipeline from the above | |

---

## Known limitations

* Free-tier live deployment sleeps when idle and may use a smaller graph sample (`FALKORDB_LOAD_LIMIT`) to fit FalkorDB Cloud's 100 MB tier. Local setup loads the full 100k sample.
* FX rates are a fixed, approximate September 2022 table (reproducible by design, not live).
* The identity lane is synthetic (see [Data](#data)).
* One graph for one institution; multi-tenancy (a graph per bank) is future work.

## Team

| Member |
|---|
| Anant Asati |
| Vedant Moghe |
| KanakMurthy Hawale |
| Kartikya Saini |

## License

MIT. See [`LICENSE`](LICENSE).
