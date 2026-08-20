"""HTTP helpers for local llama-server observability endpoints."""

import urllib.error
import urllib.request

from backend import config
from backend.http import build_http_origin
from backend.services import chat as chat_service


def get_metrics_host(host):
    return chat_service.get_local_proxy_host(host)


def _fetch_local_llama_endpoint(
    host,
    port,
    path,
    accept,
    label,
    authorization="",
):
    try:
        parsed_port = int(port or config.LLAMA_PORT)
    except (TypeError, ValueError):
        return None, f"Invalid llama-server {label} port."
    if parsed_port < 1 or parsed_port > 65535:
        return None, f"Invalid llama-server {label} port."

    proxy_host, host_error = get_metrics_host(host)
    if not proxy_host:
        return None, host_error

    headers = {"Accept": accept}
    if authorization:
        headers["Authorization"] = authorization
    request = urllib.request.Request(
        f"{build_http_origin(proxy_host, parsed_port)}{path}",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            raw = response.read(config.WEB_SEARCH_FETCH_BYTES)
            charset = response.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, errors="replace"), ""
    except urllib.error.HTTPError as exc:
        try:
            return None, f"llama-server {label} returned HTTP {exc.code}."
        finally:
            if exc.fp is not None:
                exc.close()
    except Exception as exc:
        return None, f"Failed to fetch llama-server {label}: {exc}"


def get_local_llama_metrics(host, port, authorization=""):
    return _fetch_local_llama_endpoint(
        host,
        port,
        "/metrics",
        "text/plain",
        "metrics",
        authorization,
    )


def get_local_llama_slots(host, port, authorization=""):
    return _fetch_local_llama_endpoint(
        host,
        port,
        "/slots",
        "application/json",
        "slots",
        authorization,
    )


def get_local_llama_props(host, port, authorization=""):
    return _fetch_local_llama_endpoint(
        host,
        port,
        "/props",
        "application/json",
        "props",
        authorization,
    )
