# Demo script — RUDRA Investigator (3 minutes)

Setup before recording: FalkorDB loaded (`scripts/load_falkor.sh`), backend + frontend running, role = INVESTIGATOR, the
FalkorDB Browser open in a second tab (http://localhost:3000, graph `rudra`). Run one investigation beforehand so the
memory table is not empty, and **reject** one escalation as SUPERVISOR so a human precedent exists.

| Time | Show | Say |
|---|---|---|
| 0:00 | Investigator page, status bar (119k accounts · 100k transactions · investigations in memory) | "AML alerts are the start of an investigation, not the end. RUDRA Investigator is an agent whose context is a FalkorDB graph: every account and transaction, the alerts — and its own memory of past investigations and human decisions." |
| 0:20 | Click the quick prompt **Investigate incident INC-…** | "It discovers 18 graph tools over MCP — that's the badge at the top of the trace." |
| 0:30 | Trace fills: `get_incident` → `get_playbook` → `trace_funds` / `find_cycles` / `k_hop` … Expand one step to show its Cypher and the ms timing. | "The bank's playbook for this typology is a node in the graph; it sets the plan. Each step is a real traversal — here the temporal-causal trace: each hop later in time, same money carried forward. Tens of milliseconds on 100k transactions." |
| 1:05 | Evidence subgraph lights up with cited transactions (indigo, particles) | "Everything the agent claims is pinned to transaction ids. Those are checked against the graph when it records a finding." |
| 1:20 | Verdict card: provenance chips (GRAPH / ML / RULE / PRECEDENT), Decision with policy rule | "Findings carry provenance. The action is a proposal. A deterministic policy reads the evidence back out of the graph and decides what the agent may do — it can escalate, it can never close a case." |
| 1:45 | Click **run with graph tools off** → Removal-test table | "Same question, graph tools removed. Fewer steps, zero GRAPH findings, and the policy refuses the STR. The graph isn't decoration — it's what lets the agent act." |
| 2:10 | Switch role to SUPERVISOR → **Approve** the escalation → open Case Workbench, case is ESCALATED, verify hash chain | "Approval is human. It flows into the existing case system with a tamper-evident audit trail." |
| 2:30 | Run an investigation on an account whose escalation was rejected earlier → decision held at `monitor` (P4_precedent_conflict) | "And it remembers. A supervisor rejected this before; that decision lives in the graph, the agent traverses into it, and the policy holds. Memory that changes behaviour." |
| 2:50 | FalkorDB Browser: `MATCH (i:Investigation)-[r]->(x) RETURN i,r,x LIMIT 50` | "Every step, finding and decision is a node you can query. That's the decision trace a regulator asks for." |

Backup: the investigation-memory table replays any stored investigation without calling the model.
