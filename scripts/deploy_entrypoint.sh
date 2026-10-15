#!/bin/sh
# Container entrypoint for the live deployment (Dockerfile.deploy).
# Waits for FalkorDB, loads the context graph if it is empty, then serves the API.
set -e
cd /app
python - <<'PY'
import os, sys, time
sys.path.insert(0, "src")
from graphdb.client import connect_from_env, is_reachable
for i in range(60):
    if is_reachable(timeout=2):
        break
    print(f"[entrypoint] waiting for FalkorDB at {os.environ.get('FALKORDB_HOST')}:{os.environ.get('FALKORDB_PORT')} ...", flush=True)
    time.sleep(3)
else:
    print("[entrypoint] FalkorDB unreachable — starting API without the agent (routes return 503)", flush=True)
    sys.exit(0)
_, g = connect_from_env()
try:
    n = g.ro_query("MATCH (a:Account) RETURN count(a)").result_set[0][0]
except Exception:
    n = 0
if n == 0 or os.environ.get("FALKORDB_FORCE_RELOAD") == "1":
    from graphdb.falkor_loader import load
    limit = int(os.environ["FALKORDB_LOAD_LIMIT"]) if os.environ.get("FALKORDB_LOAD_LIMIT") else None
    print(f"[entrypoint] loading context graph (limit={limit}) ...", flush=True)
    print(load(limit=limit, reset=True), flush=True)
else:
    print(f"[entrypoint] context graph present ({n} accounts)", flush=True)
PY
exec uvicorn main:app --app-dir backend --host 0.0.0.0 --port "${PORT:-8000}"
