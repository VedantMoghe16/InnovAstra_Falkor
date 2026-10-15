"""FalkorDB context layer for the RUDRA investigation agent.

`client`  - connection from env vars.
`schema`  - indexes, constraints, playbook seed.
`queries` - the single Cypher catalogue shared by the MCP server and backend.
`falkor_loader` - idempotent loader from pipeline artefacts.

Import hygiene: nothing in this package may import torch / xgboost / shap /
ml_model / gnn_model (see CLAUDE.md, torch-before-xgboost segfault).
"""
