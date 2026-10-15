"""FalkorDB connection helpers (env-driven, lazy, never raises at import)."""
from __future__ import annotations

import os
from typing import Optional, Tuple

DEFAULT_GRAPH = "rudra"


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def graph_name() -> str:
    return _env("FALKORDB_GRAPH", DEFAULT_GRAPH)


def connect_from_env(graph: Optional[str] = None, socket_timeout: float = 10.0):
    """Return (db, graph) using FALKORDB_HOST/PORT/USERNAME/PASSWORD/TLS/GRAPH.

    FALKORDB_URL (falkor://user:pass@host:port or falkors:// for TLS) wins if set.
    """
    from falkordb import FalkorDB

    url = _env("FALKORDB_URL")
    if url:
        db = FalkorDB.from_url(url)
    else:
        db = FalkorDB(
            host=_env("FALKORDB_HOST", "localhost"),
            port=int(_env("FALKORDB_PORT", "6379")),
            username=_env("FALKORDB_USERNAME"),
            password=_env("FALKORDB_PASSWORD"),
            ssl=_env("FALKORDB_TLS", "false").lower() in ("1", "true", "yes"),
            socket_timeout=socket_timeout,
            socket_connect_timeout=3,
        )
    return db, db.select_graph(graph or graph_name())


def is_reachable(timeout: float = 2.0) -> bool:
    try:
        db, _ = connect_from_env(socket_timeout=timeout)
        return bool(db.connection.ping())
    except Exception:
        return False


def memory_used(db) -> Optional[str]:
    try:
        return db.connection.info("memory").get("used_memory_human")
    except Exception:
        return None
