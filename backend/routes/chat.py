"""Routes for streaming chat completions through llama-server."""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from backend import config
from backend.http import SseWriter, sanitize_sse_error
from backend.services import chat as chat_service
from backend.services import process_manager
from backend.services import web_search


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
        active_runtime = process_manager.get_active_runtime_snapshot(ctx)
        if not active_runtime or active_runtime.get("tool") != "llama-server":
            writer.write({"error": {"message": "Start llama-server first, then send chat requests."}})
            writer.write("[DONE]")
            return

        messages = list(body.get("messages") or [])
        proxied_messages = messages

        if body.get("web_search"):
            max_results = get_web_search_result_count(body)
            latest_user = chat_service.get_latest_user_message(messages)
            queries = chat_service.build_search_queries(latest_user)
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
                if msg.get("role") == "system" and not inserted_context:
                    proxied_messages.append(
                        {
                            "role": "system",
                            "content": f"{chat_service.get_message_text(msg.get('content', '')).rstrip()}\n\n{context}".strip(),
                        }
                    )
                    inserted_context = True
                else:
                    proxied_messages.append(
                        {
                            "role": msg.get("role", "user"),
                            "content": msg.get("content", ""),
                        }
                    )
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

        api_url = chat_service.get_local_chat_api_url(active_runtime)
        headers = {"Content-Type": "application/json"}
        authorization = process_manager.get_active_llama_authorization(
            ctx,
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
    except BrokenPipeError:
        return
    except urllib.error.HTTPError as exc:
        try:
            err = exc.read().decode("utf-8", errors="replace")
        except Exception:
            err = str(exc)
        tunnel_active = bool(ctx.state.remote_tunnel.snapshot().get("url"))
        if tunnel_active:
            print(f"[sanitize_sse_error] HTTPError {exc.code}: {err}", file=sys.stderr)
            writer.write({"error": {"message": "Chat request failed."}})
        else:
            writer.write({"error": {"message": f"llama-server returned HTTP {exc.code}: {err}"}})
        writer.write("[DONE]")
    except Exception as exc:
        tunnel_active = bool(ctx.state.remote_tunnel.snapshot().get("url"))
        writer.write({"error": {"message": sanitize_sse_error(exc, tunnel_active)}})
        writer.write("[DONE]")
    finally:
        response.handler.close_connection = True
