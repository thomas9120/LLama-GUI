"""HTTP adapter helpers for the stdlib server backend."""

from dataclasses import dataclass, field
from email.message import Message
import ipaddress
import json
import sys
from typing import Any, Mapping, Optional, Sequence
import urllib.parse

from . import config

GENERIC_SERVER_ERROR = "Internal server error"

WILDCARD_BIND_HOSTS = {"0.0.0.0", "::", "*"}
LOCAL_BROWSER_HOSTS = ("127.0.0.1", "localhost", "::1")


@dataclass(frozen=True)
class Request:
    method: str
    path: str
    query: str
    headers: Message
    body: Optional[Mapping[str, Any]] = None
    params: Mapping[str, str] = field(default_factory=dict)


def is_v1_proxy_path(path: str) -> bool:
    return path == "/v1" or path.startswith("/v1/")


def is_safe_v1_proxy_path(path: str) -> bool:
    decoded = str(path or "")
    for _ in range(3):
        next_decoded = urllib.parse.unquote(decoded)
        if next_decoded == decoded:
            break
        decoded = next_decoded
    segments = decoded.replace("\\", "/").split("/")
    return is_v1_proxy_path(decoded) and all(segment not in {".", ".."} for segment in segments)


def get_allowed_request_origins(
    tunnel_url: str = "",
    gui_host: str = config.GUI_HOST,
    gui_port: int = config.GUI_PORT,
    request_host: str = "",
    allow_request_host_origin: bool = False,
    trusted_hosts: Sequence[str] = config.GUI_ALLOWED_HOSTS,
) -> tuple[str, ...]:
    allowed = []
    for host in LOCAL_BROWSER_HOSTS:
        origin = build_http_origin(host, gui_port)
        if origin not in allowed:
            allowed.append(origin)

    if gui_host and gui_host not in WILDCARD_BIND_HOSTS:
        origin = build_http_origin(gui_host, gui_port)
        if origin not in allowed:
            allowed.append(origin)

    if allow_request_host_origin:
        request_origin = get_request_host_origin(request_host, gui_port, trusted_hosts)
        if request_origin and request_origin not in allowed:
            allowed.append(request_origin)

    if tunnel_url:
        allowed.append(tunnel_url)
    return tuple(allowed)


def format_origin_host(host: str) -> str:
    value = str(host or "").strip().strip("[]")
    if ":" in value and value not in {"localhost"}:
        return f"[{value}]"
    return value


def build_http_origin(host: str, port: int) -> str:
    return f"http://{format_origin_host(host)}:{port}"


def is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def is_trusted_request_host(host: str, trusted_hosts: Sequence[str]) -> bool:
    if host in LOCAL_BROWSER_HOSTS or is_ip_literal(host):
        return True
    return host.lower() in trusted_hosts


def get_request_host_origin(
    host_header: str,
    gui_port: int,
    trusted_hosts: Sequence[str] = config.GUI_ALLOWED_HOSTS,
) -> str:
    value = str(host_header or "").strip()
    if not value:
        return ""
    try:
        parsed = urllib.parse.urlparse(f"//{value}")
        host = parsed.hostname
        port = parsed.port or gui_port
    except ValueError:
        return ""
    if not host or host in WILDCARD_BIND_HOSTS or port != gui_port:
        return ""
    if not is_trusted_request_host(host, trusted_hosts):
        return ""
    return build_http_origin(host, gui_port)


def is_safe_request_origin(headers: Any, allowed_origins: Sequence[str]) -> bool:
    origin = headers.get("Origin", "")
    referer = headers.get("Referer", "")
    if origin:
        return origin in allowed_origins
    if referer:
        parsed = urllib.parse.urlparse(referer)
        if not parsed.scheme or not parsed.netloc:
            return False
        referer_origin = f"{parsed.scheme}://{parsed.netloc}"
        return referer_origin in allowed_origins
    return True


def get_access_control_origin(
    headers: Any,
    allowed_origins: Sequence[str],
    default_origin: str = build_http_origin(config.GUI_HOST, config.GUI_PORT),
) -> str:
    origin = headers.get("Origin", "")
    if origin and origin in allowed_origins:
        return origin
    return default_origin


def get_cors_methods(path: str) -> str:
    if is_v1_proxy_path(path):
        return "GET, POST, OPTIONS"
    return "GET, POST, PUT, DELETE, OPTIONS"


def is_static_ui_path(path: str) -> bool:
    return path in {"/", "/index.html"} or path.startswith("/js/") or path.startswith("/css/")


def sanitize_error(exc: BaseException, status: int = 500) -> str:
    """Return a client-safe error message, logging the original exception.

    For 5xx errors the client receives a generic placeholder so filesystem
    paths, Python tracebacks, and host details are never leaked through the
    tunnel.  For 4xx errors the message is preserved because those are
    intentional validation/business-logic responses.
    """
    detail = str(exc)
    if status >= 500:
        print(f"[sanitize_error] {type(exc).__name__}: {detail}", file=sys.stderr)
        return GENERIC_SERVER_ERROR
    return detail


def sanitize_sse_error(exc: BaseException, tunnel_active: bool) -> str:
    """Return a client-safe SSE error message.

    When the tunnel is active, internal details are hidden.  When the
    request is local the raw detail is kept so users can debug connection
    issues.
    """
    detail = str(exc)
    print(f"[sanitize_sse_error] {type(exc).__name__}: {detail}", file=sys.stderr)
    if tunnel_active:
        return "Chat request failed."
    return detail


class Response:
    def __init__(self, handler: Any):
        self.handler = handler
        # True once a status line has gone out. Callers that want to turn a late
        # failure into an error response must check this first: writing a second
        # response into a reply already on the wire corrupts the first one.
        self.started = False

    def _send_cors_origin(self) -> None:
        """Add the CORS origin header via the handler's once-per-response guard.

        On static UI paths the handler's end_headers() adds this too, and two
        Access-Control-Allow-Origin headers are rejected outright by browsers.
        Falls back to a direct send_header for handlers without the guard.
        """
        sender = getattr(self.handler, "send_cors_origin_header", None)
        if callable(sender):
            sender()
            return
        self.handler.send_header(
            "Access-Control-Allow-Origin", self.handler.get_access_control_origin()
        )

    def json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.started = True
        self.handler.send_response(status)
        self.handler.send_header("Content-Type", "application/json")
        self.handler.send_header("Content-Length", str(len(body)))
        self.handler.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.handler.send_header("Pragma", "no-cache")
        self.handler.send_header("Expires", "0")
        self._send_cors_origin()
        self.handler.end_headers()
        self.handler.wfile.write(body)

    def error(
        self,
        message: str,
        status: int = 500,
        code: Optional[str] = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> None:
        data = {"error": message, "status": status}
        if code:
            data["code"] = code
        if extra:
            for key, value in extra.items():
                if key not in data:
                    data[key] = value
        self.json(data, status)

    def text(
        self,
        text: str,
        status: int = 200,
        content_type: str = "text/plain; charset=utf-8",
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        body = text.encode("utf-8")
        self.bytes(body, status=status, content_type=content_type, headers=headers)

    def bytes(
        self,
        body: bytes,
        status: int = 200,
        content_type: str = "application/octet-stream",
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.started = True
        self.handler.send_response(status)
        self.handler.send_header("Content-Type", content_type)
        self.handler.send_header("Content-Length", str(len(body)))
        self._send_cors_origin()
        for name, value in (headers or {}).items():
            self.handler.send_header(name, value)
        self.handler.end_headers()
        self.handler.wfile.write(body)

    def sse_headers(self, status: int = 200) -> None:
        self.started = True
        self.handler.send_response(status)
        self.handler.send_header("Content-Type", "text/event-stream")
        self.handler.send_header("Cache-Control", "no-cache")
        self.handler.send_header("Connection", "keep-alive")
        self._send_cors_origin()
        self.handler.end_headers()


class SseWriter:
    def __init__(self, wfile: Any):
        self.wfile = wfile

    def write(self, data: Any) -> None:
        if isinstance(data, str):
            payload = data
        else:
            payload = json.dumps(data)
        self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
        self.wfile.flush()
