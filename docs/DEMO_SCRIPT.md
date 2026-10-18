# Demo script — RUDRA Investigator (3 minutes)

Setup before recording: sign out first (user menu, top right) so the recording starts at the sign-in page. Also: FalkorDB loaded (`scripts/load_falkor.sh`), backend + frontend running, the
FalkorDB Browser open in a second tab (http://localhost:3000, graph `rudra`). Run one investigation beforehand so the
memory table is not empty, and **reject** one escalation as SUPERVISOR so a human precedent exists.

| Time | Show | Say |
|---|---|---|
| 0:00 | Sign-in page -> click **Asha Rao (Investigator)** -> welcome tour -> **My work** (her investigations, what happened to her proposals, incidents to pick up) | "RUDRA is an AML desk for Indian banks with three people on it. Asha investigates, Vikram signs off, Neha runs the platform. Each sees a different home." |
| 0:00 | Investigator page, status bar (119k accounts · 100k transactions · investigations in memory) | "AML alerts are the start of an investigation, not the end. RUDRA Investigator is an agent whose context is a FalkorDB graph: every account and transaction, the alerts — and its own memory of past investigations and human decisions." |
| 0:20 | Click the quick prompt **Investigate incident INC-…** | "It discovers 19 graph tools over MCP — that's the badge at the top of the trace." |
| 0:30 | Trace fills: `get_incident` → `get_playbook` → `trace_funds` / `find_cycles` / `k_hop` … Expand one step to show its Cypher and the ms timing. | "The bank's playbook for this typology is a node in the graph; it sets the plan. Each step is a real traversal — here the temporal-causal trace: each hop later in time, same money carried forward. Tens of milliseconds on 100k transactions." |
| 1:05 | Evidence subgraph lights up with cited transactions (indigo, particles) | "Everything the agent claims is pinned to transaction ids. Those are checked against the graph when it records a finding." |
| 1:20 | Verdict card: provenance chips (GRAPH / ML / RULE / PRECEDENT), Decision with policy rule | "Findings carry provenance. The action is a proposal. A deterministic policy reads the evidence back out of the graph and decides what the agent may do — it can escalate, it can never close a case." |
| 1:45 | Click **run with graph tools off** → Removal-test table | "Same question, graph tools removed. Fewer steps, zero GRAPH findings, and the policy refuses the STR. The graph isn't decoration — it's what lets the agent act." |
| 2:10 | User menu -> switch to **Vikram Mehta** -> **Approvals**: Asha's STR draft is at the top, "from Asha Rao", with its age. **Reject** with a note ("Need the beneficiary KYC first"), **Approve** the escalation -> Cases shows it ESCALATED, verify the hash chain | "Approval is human, and it is a different person's screen. The decision goes into the case system with a tamper-evident audit trail." |
| 2:25 | Switch back to **Asha** -> My work: "Rejected by Vikram Mehta" with his note. Then switch to **Neha Iyer** -> **System**: health, active brain, 19 MCP tools, model table, policy rules and the log of every time the policy held the agent back | "The investigator sees the outcome and why. The admin sees the guardrails working." |
| 2:30 | Run an investigation on an account whose escalation was rejected earlier → decision held at `monitor` (P4_precedent_conflict) | "And it remembers. A supervisor rejected this before; that decision lives in the graph, the agent traverses into it, and the policy holds. Memory that changes behaviour." |
| 2:50 | FalkorDB Browser: `MATCH (i:Investigation)-[r]->(x) RETURN i,r,x LIMIT 50` | "Every step, finding and decision is a node you can query. That's the decision trace a regulator asks for." |

Backup: the investigation-memory table replays any stored investigation without calling the model.
