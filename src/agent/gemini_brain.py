"""Gemini as the investigation agent's brain (google-genai SDK).

Same contract as the Claude loop in investigator.py: tools come from MCP
tools/list (schemas passed through as raw JSON Schema), the investigation id is
injected by the session for action tools, and the model must finish with a
structured `submit_verdict` call (forced on the final round).

    GEMINI_API_KEY (or GOOGLE_API_KEY)   required
    RUDRA_GEMINI_MODEL                   optional; otherwise the best available model is picked
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, AsyncIterator, Dict, List, Optional

# Google's "-latest" aliases track the newest GA model; fall back to pinned families.
PREFERRED = ("gemini-pro-latest", "gemini-flash-latest", "gemini-3.1-pro", "gemini-2.5-pro", "gemini-2.5-flash")
_MODEL_CACHE: Dict[str, Any] = {"model": None, "at": 0.0, "ok": None, "reason": ""}


def api_key() -> Optional[str]:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")


def _client():
    from google import genai
    return genai.Client(api_key=api_key())


def resolve_model(ttl: float = 600.0) -> Dict[str, Any]:
    """Validate the key (models.list, no tokens) and pick a model. Cached."""
    if not api_key():
        return {"ok": False, "model": None, "reason": "GEMINI_API_KEY not set"}
    if _MODEL_CACHE["ok"] is not None and time.time() - _MODEL_CACHE["at"] < ttl:
        return {k: _MODEL_CACHE[k] for k in ("ok", "model", "reason")}
    forced = os.environ.get("RUDRA_GEMINI_MODEL")
    try:
        names = []
        client = _client()  # keep a reference: the SDK closes the client when it is garbage-collected
        for m in client.models.list():
            actions = getattr(m, "supported_actions", None) or []
            if not actions or "generateContent" in actions:
                names.append(m.name.split("/")[-1])
        pick = forced
        if not pick:
            skip = ("image", "tts", "audio", "live", "embedding", "vision")
            for pref in PREFERRED:
                cands = sorted(n for n in names if n.startswith(pref) and not any(x in n for x in skip))
                if not cands:
                    continue
                stable = [n for n in cands if "preview" not in n and "exp" not in n]
                pick = pref if pref in cands else (stable or cands)[-1]
                break
        ok, reason = bool(pick), "" if pick else "no Gemini text model available to this key"
    except Exception as e:  # noqa: BLE001
        ok, pick, reason = False, None, f"{type(e).__name__}: {str(e)[:160]}"
    _MODEL_CACHE.update(ok=ok, model=pick, reason=reason, at=time.time())
    return {"ok": ok, "model": pick, "reason": reason}


def _clean_schema(schema: Dict) -> Dict:
    """Gemini's JSON-Schema support is a subset: collapse Optional anyOf[X, null]."""
    def walk(node):
        if isinstance(node, dict):
            if "anyOf" in node:
                opts = [o for o in node["anyOf"] if o.get("type") != "null"]
                if len(opts) == 1:
                    rest = {k: v for k, v in node.items() if k != "anyOf"}
                    node = {**opts[0], **rest}
            return {k: walk(v) for k, v in node.items() if k not in ("title",)}
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node
    return walk(schema)


async def gemini_loop(sess, question: str, graph_tools: bool, model: Optional[str], max_rounds: int,
                      system_text: str, submit_verdict: Dict, step_event, truncate,
                      client=None) -> AsyncIterator[Dict]:
    from google.genai import types
    from agent.runners import to_anthropic_tools

    model = model or (resolve_model()["model"] if client is None else "fake-gemini")
    client = client or _client()
    tool_defs = to_anthropic_tools(sess.runner.tools, sorted(sess.allowed) if sess.allowed is not None else None)
    tool_defs = tool_defs + [{"name": submit_verdict["name"], "description": submit_verdict["description"],
                              "input_schema": submit_verdict["input_schema"]}]
    decls = [types.FunctionDeclaration(name=t["name"], description=t["description"][:1000],
                                       parameters_json_schema=_clean_schema(t["input_schema"]))
             for t in tool_defs]
    tools = [types.Tool(function_declarations=decls)]
    contents: List[Any] = [types.Content(role="user", parts=[types.Part.from_text(text=question)])]
    usage = {"input": 0, "output": 0, "cache_read": 0}
    verdict = None

    for rnd in range(max_rounds):
        force = rnd == max_rounds - 1
        cfg = types.GenerateContentConfig(
            system_instruction=system_text,
            tools=tools,
            temperature=0.2,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            tool_config=types.ToolConfig(function_calling_config=types.FunctionCallingConfig(
                mode="ANY" if force else "AUTO",
                allowed_function_names=[submit_verdict["name"]] if force else None)),
        )
        resp = await client.aio.models.generate_content(model=model, contents=contents, config=cfg)
        um = getattr(resp, "usage_metadata", None)
        if um is not None:
            usage["input"] += getattr(um, "prompt_token_count", 0) or 0
            usage["output"] += getattr(um, "candidates_token_count", 0) or 0
            usage["cache_read"] += getattr(um, "cached_content_token_count", 0) or 0
        cand = (resp.candidates or [None])[0]
        content = getattr(cand, "content", None)
        parts = list(getattr(content, "parts", None) or [])
        if not parts:
            contents.append(types.Content(role="user", parts=[types.Part.from_text(
                text="Continue the investigation; call submit_verdict when done.")]))
            continue
        contents.append(content)  # keep thought signatures intact
        replies = []
        for part in parts:
            if getattr(part, "thought", False):
                continue
            if getattr(part, "text", None) and part.text.strip():
                yield {"type": "thinking", "text": part.text.strip()}
            fc = getattr(part, "function_call", None)
            if not fc:
                continue
            name, args = fc.name, dict(fc.args or {})
            if name == submit_verdict["name"]:
                verdict = args
                replies.append(types.Part.from_function_response(name=name, response={"result": "recorded"}))
                continue
            env = await sess.call(name, args)
            yield step_event(sess.n, name, args, env)
            replies.append(types.Part.from_function_response(name=name, response={"result": truncate(env)}))
        if verdict is not None:
            break
        if replies:
            contents.append(types.Content(role="user", parts=replies))
        else:
            contents.append(types.Content(role="user", parts=[types.Part.from_text(
                text="Use the graph tools, then call submit_verdict.")]))
    yield {"type": "_verdict", "verdict": verdict or {"verdict": "UNCERTAIN", "confidence": 0.2,
                                                       "summary": "Round budget exhausted before a verdict."},
           "usage": usage}
