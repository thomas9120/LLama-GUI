"""Count the actual chat request using the running llama-server, without inference."""

import json
import sys
import urllib.parse

from backend.http import open_pinned_local_request
from backend.services.chat import get_local_chat_api_url


def _integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _read_json(target, authorization, path, body=None):
    origin = urllib.parse.urlparse(get_local_chat_api_url(target))
    headers = {"Content-Type": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    with open_pinned_local_request(
        origin.hostname, origin.port, path,
        method="GET" if body is None else "POST",
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers=headers, timeout=5,
    ) as upstream:
        if upstream.status in (404, 405, 501):
            return None
        if upstream.status >= 400:
            raise ValueError(f"Context endpoint {path} returned HTTP {upstream.status}")
        return json.loads(upstream.read())


def measure(body, target, authorization=""):
    """Unknown counts never block chat; no character-count guess is labelled as tokens.

    Prefer the shared chat-parser count endpoint. Older text-only servers can
    apply their own template then tokenize with the same special-token options
    as completions. Media requires the native count endpoint.
    """
    result = {"status": "unavailable", "capacity": None, "prompt_tokens": None,
              "reply_reserve": None, "reserve_source": "unknown", "remaining": None}
    if not target:
        return {**result, "message": "Start or connect to a server to measure context."}
    try:
        # Templates may remove system instructions before checking for chat turns.
        # Empty and instructions-only previews are not valid generation prompts.
        if not any(msg.get("role") not in ("system", "developer") for msg in (body.get("messages") or [])):
            return {**result, "status": "empty", "message": "Type a message to measure context."}
        props_path = "/props"
        if body.get("model"):
            props_path += "?" + urllib.parse.urlencode({"model": body["model"]})
        props = _read_json(target, authorization, props_path)
        defaults = (props or {}).get("default_generation_settings") or {}
        capacity = _integer(defaults.get("n_ctx"))
        if capacity is None or capacity <= 0:
            return {**result, "message": "The server did not report its usable context capacity."}
        result["capacity"] = capacity
        requested = _integer(body.get("max_completion_tokens", body.get("max_tokens")))
        server_limit = _integer((defaults.get("params") or {}).get("n_predict"))
        if requested is not None and requested >= 0:
            reserve, source = requested, "request"
        elif server_limit is not None and server_limit >= 0:
            reserve, source = server_limit, "server"
        else:
            reserve, source = min(1024, max(1, capacity // 4)), "planning"
        result.update(reply_reserve=reserve, reserve_source=source)

        # Strip GUI-only routing/search fields, keeping every actual request option.
        count_body = {key: value for key, value in body.items() if key not in (
            "web_search", "web_search_max_results", "api_url", "host", "port")}
        counted = _read_json(target, authorization, "/v1/chat/completions/input_tokens", count_body)
        if counted is not None:
            tokens = _integer(counted.get("input_tokens"))
        else:
            if any(not isinstance(msg.get("content", ""), str) for msg in body.get("messages", [])):
                return {**result, "message": "This server cannot count media requests before sending."}
            formatted = _read_json(target, authorization, "/apply-template", count_body)
            if not formatted or not isinstance(formatted.get("prompt"), str):
                return {**result, "message": "This server does not support chat context counting."}
            tokenized = _read_json(target, authorization, "/tokenize", {
                "content": formatted["prompt"], "add_special": True, "parse_special": True,
                "model": body.get("model", ""),
            })
            token_list = (tokenized or {}).get("tokens")
            tokens = len(token_list) if isinstance(token_list, list) else None
        if tokens is None or tokens < 0:
            return {**result, "message": "The server did not return a valid token count."}
        remaining = capacity - tokens - reserve
        # A planning reserve for unlimited generation is advisory, not a hidden cap.
        overflow = tokens >= capacity or (source != "planning" and remaining < 0)
        result.update(prompt_tokens=tokens, remaining=remaining,
                      status="overflow" if overflow else "warning" if remaining < capacity * .1 else "ok")
        if overflow:
            result["message"] = ("Context limit exceeded. Shorten the message or system prompt, "
                                 "undo older turns, start a new chat, or lower Max Tokens. "
                                 "With web search, try fewer sources or turn search off.")
        elif source == "planning":
            result["message"] = "Reply headroom is a planning reserve; generation has no fixed output limit."
        else:
            result["message"] = "Reply reserve includes reasoning tokens."
        return result
    except Exception as exc:
        print(f"[chat context] count unavailable: {exc}", file=sys.stderr)
        return {**result, "message": "Context count unavailable; the server will validate the request."}
