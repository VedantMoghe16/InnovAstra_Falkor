# Live deployment

## What is live (free tiers, no card)

| Part | Where | Notes |
|---|---|---|
| UI | Vercel: https://rudra-investigator.vercel.app | `frontend/`, `VITE_API_BASE` = the Render URL |
| API | Render free web service (Singapore): https://rudra-api-xnbf.onrender.com | `render.yaml`, built from `Dockerfile.deploy`; prebuilt artefacts come from the `data-v1` GitHub release; `RUDRA_LITE=1` keeps it under 512 MB (~330 MB peak); `RUDRA_LLM_RUNS_PER_HOUR=20` caps paid LLM runs |
| Graph | FalkorDB Cloud free tier (AWS ap-south-1) | 35,000-transaction evidence-preserving sample, 57 of 100 MB; PageRank/WCC/label propagation run in FalkorDB |
| Keep-alive | `.github/workflows/keepalive.yml` | pings `/api/health` and `/api/graphdb/status` every 10 min (repo variable `LIVE_API_URL`) |

Why these limits: the full API needs ~900 MB (the in-memory NetworkX graph alone is ~500 MB), and every no-card host caps at 512 MB; the 100 MB FalkorDB Cloud tier ran out of memory computing graph algorithms on a 60,000-transaction load.

The sections below are the original Railway-style recipe.

Topology: **FalkorDB** (Railway service from the `falkordb/falkordb` image, or FalkorDB Cloud) ← **API** (Railway, `Dockerfile.deploy`, ships the prebuilt pipeline artefacts and self-loads the graph on first boot) ← **UI** (Vercel, static Vite build pointing at the API).

## 0. Build artefacts locally (once)

```bash
python src/run_pipeline.py      # writes data/ibm_aml, data/ml/ibm_aml, data/collusion
```

## 1. FalkorDB

Option A — inside the Railway project (no size cap):

```bash
railway init --name rudra-investigator           # creates the project
railway add --image falkordb/falkordb:latest --service falkordb
```

The API reaches it at `falkordb.railway.internal:6379` over Railway's private network.

Option B — FalkorDB Cloud free tier (100 MB, stops after a day idle): create an instance, then set
`FALKORDB_HOST/PORT/USERNAME/PASSWORD` on the API and `FALKORDB_LOAD_LIMIT=60000`.

## 2. API on Railway

```bash
railway add --service api
railway variables --service api \
  --set FALKORDB_HOST=falkordb.railway.internal --set FALKORDB_PORT=6379 \
  --set ANTHROPIC_API_KEY=sk-ant-...            # optional: without it the agent runs the playbook autopilot
railway up --service api --no-gitignore --detach  # uploads data/ artefacts; .railwayignore excludes raw CSVs/venv
railway domain --service api                       # prints the public API URL
```

Give the API service 2 GB RAM (measured ~1 GB steady state in the deploy image; startup ~2 min). First boot loads the context
graph (~15 s), then `GET /api/health` reports `"falkordb": true`.

## 3. UI on Vercel

```bash
cd frontend
vercel link --yes
vercel env add VITE_API_BASE production    # paste the Railway API URL, e.g. https://api-production-xxxx.up.railway.app
vercel deploy --prod
```

`frontend/vercel.json` adds the SPA rewrite. CORS is open on the API, and SSE goes straight to the API host.

## Checks

```bash
curl $API/api/health                 # falkordb: true
curl $API/api/graphdb/status         # 119k accounts, 100k TXN
curl -N -X POST $API/api/agent/investigate -H 'Content-Type: application/json' \
     -d '{"question":"Investigate incident INC-2749"}'
```
