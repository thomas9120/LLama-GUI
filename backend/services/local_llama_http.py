"""HTTP helpers for local llama-server observability endpoints."""

import sys

from backend import config
from backend.http import open_pinned_local_request
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
    try:
        # Resolves and pins the address here, at connect time, so a hostname
        # that passed validation cannot re-resolve somewhere off-machine.
        response = open_pinned_local_request(
            proxy_host, parsed_port, path, headers=headers, timeout=3
        )
    except ValueError as exc:
        return None, str(exc)
    except Exception as exc:
        # Raw exception text can carry WinError strings and host details; it
        # would surface verbatim as a 502 body, readable over the tunnel.
        print(f"[llama_http] failed to fetch llama-server {label}: {exc}", file=sys.stderr)
        return None, f"Failed to fetch llama-server {label}."
    try:
        if response.status >= 400:
            return None, f"llama-server {label} returned HTTP {response.status}."
        raw = response.read(config.WEB_SEARCH_FETCH_BYTES)
        charset = response.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace"), ""
    finally:
        response.close()


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
