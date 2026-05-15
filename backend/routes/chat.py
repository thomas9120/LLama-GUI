"""Routes for streaming chat completions through llama-server."""

import json
import urllib.error
import urllib.parse
import urllib.request

from backend import config
from backend.http import SseWriter
from backend.services import chat as chat_service
from backend.services import web_search


def completions(request, response, ctx):
    body = request.body or {}
    response.sse_headers()
    writer = SseWriter(response.handler.wfile)
    try:
        messages = list(body.get("messages") or [])
        proxied_messages = messages

        if body.get("web_search"):
            latest_user = chat_service.get_latest_user_message(messages)
            queries = chat_service.build_search_queries(latest_user)
            all_results = []
            fetched_pages = {}

            for query in queries:
                writer.write({"type": "web_status", "content": f"Searching: {query}"})
                search_response = web_search.web_search(query)
                if not search_response.get("ok"):
                    writer.write({"error": {"message": search_response.get("error", "Search unavailable")}})
                    writer.write("[DONE]")
                    return
                for result in search_response.get("results", []):
                    if result.get("url") and all(r.get("url") != result.get("url") for r in all_results):
                        all_results.append(result)
                    if len(all_results) >= config.WEB_SEARCH_MAX_RESULTS:
                        break

            for result in all_results[: config.WEB_SEARCH_FETCH_RESULTS]:
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
                            "content": f"{msg.get('content', '').rstrip()}\n\n{context}".strip(),
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

        api_url = chat_service.get_local_chat_api_url(body)
        req = urllib.request.Request(
            api_url,
            data=json.dumps(proxy_body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
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
        writer.write({"error": {"message": f"llama-server returned HTTP {exc.code}: {err}"}})
        writer.write("[DONE]")
    except Exception as exc:
        writer.write({"error": {"message": str(exc)}})
        writer.write("[DONE]")
    finally:
        response.handler.close_connection = True
