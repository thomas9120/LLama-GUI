"""Chat proxy helpers."""

import functools
import ipaddress
import re
import socket
import urllib.parse
from typing import Any, Mapping, Sequence

from backend import config


def get_latest_user_message(messages: Sequence[Mapping[str, Any]]) -> str:
    for msg in reversed(messages or []):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return content.strip()
    return ""


def build_search_queries(user_text: Any) -> list[str]:
    query = re.sub(r"\s+", " ", str(user_text or "").strip())
    if len(query) > 180:
        query = query[:180].rsplit(" ", 1)[0]
    return [query] if query else []


def build_search_context(search_results: Sequence[Mapping[str, Any]], fetched_pages: Mapping[str, Mapping[str, Any]]):
    sources = []
    context_parts = []
    for idx, result in enumerate(search_results, 1):
        url = result.get("url", "")
        title = result.get("title") or url
        snippet = result.get("snippet", "")
        fetched = fetched_pages.get(url, {})
        text = fetched.get("text") if fetched.get("ok") else ""
        if not text:
            text = snippet
        text = (text or "").strip()
        if len(text) > 3500:
            text = text[:3500].rstrip() + "\n... (source excerpt truncated)"
        sources.append({"index": idx, "title": title, "url": url, "snippet": snippet})
        context_parts.append(
            f"[{idx}] {title}\nURL: {url}\nSnippet: {snippet}\nContent excerpt:\n{text}"
        )

    if not context_parts:
        return "", sources

    context = (
        "You have fresh web search context below. Answer the user's question using these sources. "
        "Cite source numbers like [1] or [2] for factual claims. If the sources are insufficient, say so.\n\n"
        + "\n\n---\n\n".join(context_parts)
    )
    return context, sources


@functools.lru_cache(maxsize=1)
def get_local_interface_addresses() -> frozenset[str]:
    addresses = {config.LLAMA_HOST, "::1"}
    hostnames = {socket.gethostname(), socket.getfqdn()}
    for name in hostnames:
        try:
            for info in socket.getaddrinfo(name, None):
                addresses.add(info[4][0])
        except OSError:
            pass
    return frozenset(addresses)


def get_local_proxy_host(host: Any) -> tuple[str, str]:
    value = str(host or config.LLAMA_HOST).strip() or config.LLAMA_HOST
    if value.lower() == "localhost" or value in {"0.0.0.0", "::", "*"}:
        return config.LLAMA_HOST, ""
    try:
        infos = socket.getaddrinfo(value, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        return "", f"Invalid llama-server metrics host: {exc}"
    local_addresses = get_local_interface_addresses()
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback or info[4][0] in local_addresses:
            return value, ""
    return "", "Blocked: metrics proxy can only target this machine."


def get_local_chat_api_url(body: Mapping[str, Any]) -> str:
    host = str(body.get("host") or config.LLAMA_HOST).strip() or config.LLAMA_HOST
    try:
        port = int(body.get("port") or config.LLAMA_PORT)
    except (TypeError, ValueError):
        raise ValueError("Invalid llama-server chat port.")
    if port < 1 or port > 65535:
        raise ValueError("Invalid llama-server chat port.")
    chat_host, host_error = get_local_proxy_host(host)
    if not chat_host:
        raise ValueError(host_error)
    return f"http://{chat_host}:{port}/v1/chat/completions"
