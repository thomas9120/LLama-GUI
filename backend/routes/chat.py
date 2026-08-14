"""Routes for streaming chat completions through llama-server."""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from backend import config
from backend.http import SseWriter, sanitize_sse_error
from backend.services import chat as chat_service
from backend.services import external_server
from backend.services import web_search


def _write_stream_error(writer, message):
    """Report a failure on an in-flight SSE stream, best effort.

    The stream may already be dead — a client that disconnected is a common way
    to *get* here — and failing to deliver the bad news must not raise a second
    exception out of the route.
    """
    try:
        writer.write({"error": {"message": message}})
        writer.write("[DONE]")
    except OSError as exc:
        print(f"[chat] could not report stream error to client: {exc}", file=sys.stderr)


def get_web_search_result_count(body):
    try:
        raw_value = body.get("web_search_max_results", config.WEB_SEARCH_MAX_RESULTS)
        if raw_value in {None, ""}:
            raw_value = config.WEB_SEARCH_MAX_RESULTS
        max_results = int(raw_value)
    except (TypeError, ValueError):
        max_results = config.WEB_SEARCH_MAX_RESULTS
    return max(1, min(max_results, 10))


def completions(request, response, ctx):
    body = request.body or {}
    response.sse_headers()
    writer = SseWriter(response.handler.wfile)
    try:
        # The destination is server-side state -- a launched llama-server, or one
        # the operator registered on the API tab. It is never read from `body`,
        # so a caller cannot point this proxy somewhere of their choosing.
        target = external_server.resolve_llama_target(ctx)
        if not target:
            writer.write(
                {
                    "error": {
                        "message": "Start llama-server first, or connect to a running server "
                        "from the API tab, then send chat requests."
                    }
                }
            )
            writer.write("[DONE]")
            return

        messages = list(body.get("messages") or [])
        proxied_messages = messages

        if body.get("web_search"):
            max_results = get_web_search_result_count(body)
            latest_user = chat_service.get_latest_user_message(messages)
            queries = chat_service.build_search_queries(latest_user)
            if not queries:
                writer.write({"error": {"message": "Add a text question to search the web for."}})
                writer.write("[DONE]")
                return
            all_results = []
            fetched_pages = {}

            for query in queries:
                writer.write({"type": "web_status", "content": f"Searching: {query}"})
                search_response = web_search.web_search(query, max_results=max_results)
                if not search_response.get("ok"):
                    writer.write({"error": {"message": search_response.get("error", "Search unavailable")}})
                    writer.write("[DONE]")
                    return
                for result in search_response.get("results", []):
                    if result.get("url") and all(r.get("url") != result.get("url") for r in all_results):
                        all_results.append(result)
                    if len(all_results) >= max_results:
                        break

            for result in all_results[:max_results]:
                url = result.get("url", "")
                host = urllib.parse.urlparse(url).hostname or url
                if host.startswith("www."):
                    host = host[4:]
                writer.write({"type": "web_status", "content": f"Reading: {host}"})
                fetched_pages[url] = web_search.fetch_page_text(url, ssl_context=ctx.services.ssl_context)

            context, sources = chat_service.build_search_context(all_results, fetched_pages)
            if not context:
                writer.write({"error": {"message": "Search returned no usable sources."}})
                writer.write("[DONE]")
                return

            writer.write({"type": "web_sources", "sources": sources})
            writer.write({"type": "web_status", "content": "Answering..."})

            proxied_messages = []
            inserted_context = False
            for msg in messages:
                proxied_message = dict(msg)
                merged = (
                    chat_service.merge_system_context(msg.get("content", ""), context)
                    if msg.get("role") == "system" and not inserted_context
                    else None
                )
                if merged is not None:
                    proxied_message["content"] = merged
                    inserted_context = True
                proxied_messages.append(proxied_message)
            if not inserted_context:
                proxied_messages.insert(0, {"role": "system", "content": context})

        proxy_body = dict(body)
        proxy_body["messages"] = proxied_messages
        proxy_body["stream"] = True
        proxy_body.pop("web_search", None)
        proxy_body.pop("api_url", None)
        proxy_body.pop("host", None)
        proxy_body.pop("port", None)
        proxy_body.pop("web_search_max_results", None)

        api_url = chat_service.get_local_chat_api_url(target)
        headers = {"Content-Type": "application/json"}
        authorization = external_server.resolve_llama_authorization(
            ctx,
            target,
            request.headers.get("Authorization", ""),
        )
        if authorization:
            headers["Authorization"] = authorization
        req = urllib.request.Request(
            api_url,
            data=json.dumps(proxy_body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            while True:
                line = resp.readline()
                if not line:
                    break
                response.handler.wfile.write(line)
                response.handler.wfile.flush()
                if line.strip() == b"data: [DONE]":
                    break
    # ConnectionError, not BrokenPipeError: a client that goes away mid-stream
    # raises ConnectionAbortedError or ConnectionResetError on Windows, neither of
    # which is a subclass of BrokenPipeError. Those used to fall through to the
    # generic handler below, which then tried to write an error frame to the
    # socket that had just died.
    except ConnectionError:
        return
    except urllib.error.HTTPError as exc:
        try:
            err = exc.read().decode("utf-8", errors="replace")
        except Exception:
            err = str(exc)
        tunnel_active = bool(ctx.state.remote_tunnel.snapshot().get("url"))
        if tunnel_active:
            print(f"[sanitize_sse_error] HTTPError {exc.code}: {err}", file=sys.stderr)
            _write_stream_error(writer, "Chat request failed.")
        else:
            _write_stream_error(writer, f"llama-server returned HTTP {exc.code}: {err}")
    except Exception as exc:
        tunnel_active = bool(ctx.state.remote_tunnel.snapshot().get("url"))
        _write_stream_error(writer, sanitize_sse_error(exc, tunnel_active))
    finally:
        response.handler.close_connection = True
