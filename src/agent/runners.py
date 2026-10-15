"""Tool runners: how the agent reaches the graph tools.

MCPToolRunner (default)  spawns `python -m mcp_server.server` and talks MCP
                         over stdio - tools are *discovered* via tools/list,
                         not hard-coded into the agent.
DirectToolRunner         drives the same MCPServer object in-process
                         (identical schemas + handlers, no subprocess). Used by
                         tests and as the RUDRA_AGENT_TRANSPORT=direct escape hatch.
"""
from __future__ import annotations

import json
import os
import sys
from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional, Sequence

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HIDDEN_PARAMS = ("investigation_id",)  # injected by the runner, never chosen by the model


def _parse_result(result) -> Dict:
    text = "".join(getattr(c, "text", "") for c in (result.content or []))
    try:
        env = json.loads(text)
    except Exception:
        env = {"data": {"error": text or "empty tool result"}, "rows": 0, "ms": 0, "cypher": ""}
    if getattr(result, "is_error", False):
        env.setdefault("data", {})
        if isinstance(env["data"], dict):
            env["data"].setdefault("error", text)
        env["is_error"] = True
    return env


def to_anthropic_tools(tools: Sequence[Any], allowed: Optional[Sequence[str]] = None) -> List[Dict]:
    out = []
    for t in tools:
        if allowed is not None and t.name not in allowed:
            continue
        schema = json.loads(json.dumps(t.input_schema or {"type": "object", "properties": {}}))
        props = schema.get("properties", {})
        for h in HIDDEN_PARAMS:
            props.pop(h, None)
        if "required" in schema:
            schema["required"] = [r for r in schema["required"] if r not in HIDDEN_PARAMS]
        for p in props.values():
            p.pop("title", None)
        schema.pop("title", None)
        out.append({"name": t.name, "description": (t.description or "").strip(), "input_schema": schema})
    return out


class MCPToolRunner:
    transport = "mcp-stdio"

    def __init__(self, env: Optional[Dict[str, str]] = None):
        self._env = env or {}
        self._stack: Optional[AsyncExitStack] = None
        self.session = None
        self.tools: List[Any] = []

    async def __aenter__(self):
        from mcp import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        passthrough = {k: v for k, v in os.environ.items()
                       if k.startswith("FALKORDB_") or k in ("PATH", "HOME", "BANK_NAME", "COMPLIANCE_OFFICER")}
        params = StdioServerParameters(command=sys.executable, args=["-m", "mcp_server.server"], cwd=SRC,
                                       env={**passthrough, **self._env, "PYTHONPATH": SRC})
        self._stack = AsyncExitStack()
        read, write = await self._stack.enter_async_context(stdio_client(params, errlog=open(os.devnull, "w")))
        self.session = await self._stack.enter_async_context(ClientSession(read, write))
        await self.session.initialize()
        self.tools = (await self.session.list_tools()).tools
        return self

    async def __aexit__(self, *exc):
        if self._stack:
            await self._stack.aclose()

    async def call(self, name: str, args: Dict) -> Dict:
        res = await self.session.call_tool(name, args, read_timeout_seconds=60)
        return _parse_result(res)


class DirectToolRunner:
    transport = "in-process"

    def __init__(self, server_module=None):
        self._srv = server_module
        self.tools: List[Any] = []

    async def __aenter__(self):
        if self._srv is None:
            from mcp_server import server as srv
            self._srv = srv
        self.tools = await self._srv.mcp.list_tools()
        return self

    async def __aexit__(self, *exc):
        return None

    async def call(self, name: str, args: Dict) -> Dict:
        try:
            res = await self._srv.mcp.call_tool(name, args)
        except Exception as e:  # noqa: BLE001 - ToolError etc. go back to the model
            return {"data": {"error": str(e)}, "rows": 0, "ms": 0, "cypher": "", "is_error": True}
        return _parse_result(res)


def make_runner():
    if os.environ.get("RUDRA_AGENT_TRANSPORT", "mcp").lower() == "direct":
        return DirectToolRunner()
    return MCPToolRunner()
