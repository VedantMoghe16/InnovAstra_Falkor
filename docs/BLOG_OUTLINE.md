# Blog outline — "An AML agent that has to show its working: FalkorDB as the context graph"

1. **The gap.** Detection is solved-ish (RUDRA: rules + XGBoost/GNN on IBM AML). Investigation is not: an alert is the start
   of hours of following money, checking who else is involved, and writing an STR a regulator will accept.
2. **Why the context has to be a graph.** Five investigator questions, each a traversal (trace, cycle, ring, hub, precedent).
   Vector retrieval can't answer "where did the same money go next, in time order".
3. **The model.** Evidence layer (one TXN edge per transaction — why we un-aggregated NetworkX), memory layer
   (Investigation/ToolCall/Finding/Decision), procedural layer (Playbook). Diagram from docs/FALKORDB.md.
4. **Tools over MCP.** The envelope pattern (Cypher + timing travel with evidence). Measured latencies on 100k edges.
   The FalkorDB gotchas: literal hop bounds; reversed node order for self-closing paths and the `(a)-[*]->(x)-[]->(a)` fix;
   RO_QUERY + timeouts.
5. **Letting the graph decide.** Policy evidence re-read from the graph, floor safety, human precedents that hold future
   escalations. Removal test numbers.
6. **Two brains, one trace.** Claude vs. playbook autopilot; why a deterministic fallback matters in compliance.
7. **What we'd do next.** Per-bank multi-tenancy (one graph per institution), Graphiti-style temporal validity on findings,
   counterfactual checks ("which minimal edge removal flips this verdict").
