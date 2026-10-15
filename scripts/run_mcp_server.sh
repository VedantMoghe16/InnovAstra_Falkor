#!/usr/bin/env bash
# Run the RUDRA graph MCP server over stdio (for Claude Desktop / Claude Code / MCP Inspector).
#   claude mcp add rudra-graph -- "$(pwd)/scripts/run_mcp_server.sh"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-$( [ -x "$ROOT/.venv/bin/python" ] && echo "$ROOT/.venv/bin/python" || echo python )}"
cd "$ROOT/src"
exec "$PY" -m mcp_server.server
