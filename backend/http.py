"""HTTP adapter helpers for the stdlib server backend."""

from dataclasses import dataclass, field
from email.message import Message
import json
from typing import Any, Mapping, Optional, Sequence
import urllib.parse

from . import config


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


def get_allowed_request_origins(
    tunnel_url: str = "",
    gui_host: str = config.GUI_HOST,
    gui_port: int = config.GUI_PORT,
) -> tuple[str, ...]:
    allowed = [f"http://{gui_host}:{gui_port}", f"http://localhost:{gui_port}"]
    if tunnel_url:
        allowed.append(tunnel_url)
    return tuple(allowed)


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
    default_origin: str = f"http://{config.GUI_HOST}:{config.GUI_PORT}",
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


class Response:
    def __init__(self, handler: Any):
        self.handler = handler

    def json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.handler.send_response(status)
        self.handler.send_header("Content-Type", "application/json")
        self.handler.send_header("Content-Length", str(len(body)))
        self.handler.send_header("Access-Control-Allow-Origin", self.handler.get_access_control_origin())
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
        self.handler.send_response(status)
        self.handler.send_header("Content-Type", content_type)
        self.handler.send_header("Content-Length", str(len(body)))
        self.handler.send_header("Access-Control-Allow-Origin", self.handler.get_access_control_origin())
        for name, value in (headers or {}).items():
            self.handler.send_header(name, value)
        self.handler.end_headers()
        self.handler.wfile.write(body)

    def sse_headers(self, status: int = 200) -> None:
        self.handler.send_response(status)
        self.handler.send_header("Content-Type", "text/event-stream")
        self.handler.send_header("Cache-Control", "no-cache")
        self.handler.send_header("Connection", "keep-alive")
        self.handler.send_header("Access-Control-Allow-Origin", self.handler.get_access_control_origin())
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
