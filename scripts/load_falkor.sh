#!/usr/bin/env bash
# Load (or reload) the FalkorDB context graph from the pipeline artefacts.
#   scripts/load_falkor.sh                 # local FalkorDB, full IBM AML sample
#   FALKORDB_HOST=... FALKORDB_PASSWORD=... scripts/load_falkor.sh --limit 60000   # FalkorDB Cloud free tier
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-$( [ -x .venv/bin/python ] && echo .venv/bin/python || echo python )}"
exec "$PY" src/graphdb/falkor_loader.py --reset "$@"
