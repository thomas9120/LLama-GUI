"""Registration of an externally started llama-server as a proxy target.

The chat and metrics proxies normally talk to the llama-server this GUI
launched. This module lets the local operator register a llama-server they
started themselves so those proxies have a destination again -- without ever
taking that destination from request data. A visitor arriving over the remote
tunnel can use the target the operator registered, but cannot choose a new one.

The live registration is session-scoped: it lives in memory and disappears when
the backend restarts. Only the *address* is remembered across sessions, under
``external_chat_target`` in ``config.json``; the API key is never written to
disk. A remembered address is re-registered on the next start only when no key
was needed and the port still identifies itself as llama-server -- see
``reconnect_remembered``.
"""

import json
import sys
import urllib.error
import urllib.request
from typing import Any, Mapping, Optional

from backend.services import chat as chat_service
from backend.services import process_manager
from backend.state import default_external_chat_target

MAX_API_KEY_LENGTH = 1024
MAX_LABEL_LENGTH = 120
MAX_PROBE_BODY_BYTES = 4096
PROBE_TIMEOUT_SECONDS = 5
CONFIG_KEY = "external_chat_target"


class ExternalServerUnreachable(RuntimeError):
    """Raised when nothing answers an HTTP probe at the registered address."""


class _NoProbeRedirects(urllib.request.HTTPRedirectHandler):
    """Keep probe credentials on the operator-selected local origin."""

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def _open_probe_request(request: urllib.request.Request, timeout: float):
    opener = urllib.request.build_opener(_NoProbeRedirects())
    return opener.open(request, timeout=timeout)


def _normalize_host(value: Any) -> str:
    """Resolve a host through the same local-only policy the proxies enforce."""
    host, error = chat_service.get_local_proxy_host(value)
    if not host:
        raise ValueError(error or "Invalid llama-server host.")
    return host


def _normalize_port(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("Invalid llama-server port.")
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError("Invalid llama-server port.") from None
    if port < 1 or port > 65535:
        raise ValueError("Invalid llama-server port.")
    return port


def _normalize_api_key(value: Any) -> str:
    """Reject anything that cannot be a well-formed HTTP header value."""
    key = str(value or "").strip()
    if not key:
        return ""
    if len(key) > MAX_API_KEY_LENGTH:
        raise ValueError("API key is too long.")
    if any(ord(char) < 32 or ord(char) == 127 for char in key):
        raise ValueError("API key contains unsupported control characters.")
    try:
        key.encode("latin-1")
    except UnicodeEncodeError:
        raise ValueError("API key contains characters that cannot be sent in a header.") from None
    return key


def _sync_v1_proxy_target(ctx) -> None:
    """Point this GUI's own /v1 proxy at whatever the proxies now resolve to.

    Derived from ``resolve_llama_target`` rather than from the address that was
    just registered, so /v1, chat, and metrics never disagree: registering while
    a launched llama-server is still winning must not steal /v1 away from it.

    Best effort on purpose: the registration is what chat depends on, and the
    proxy target is re-derived from the command line on the next launch.
    """
    target = resolve_llama_target(ctx)
    try:
        ctx.services.set_llama_api_target(
            target.get("host") if target else None,
            target.get("port") if target else None,
        )
    except Exception as exc:
        print(f"[external-server] could not update the /v1 proxy target: {exc}", file=sys.stderr)


def get_remembered_target(ctx) -> Optional[dict[str, Any]]:
    """The address registered in an earlier session, if one was saved.

    Only the address is ever stored -- ``api_key_required`` records that a key
    was needed so the UI can ask for it again, not what the key was. A
    hand-edited or stale entry that no longer validates is treated as absent.
    """
    try:
        entry = dict(ctx.services.load_config()).get(CONFIG_KEY)
    except Exception as exc:
        print(f"[external-server] could not read the saved target: {exc}", file=sys.stderr)
        return None
    if not isinstance(entry, Mapping):
        return None
    try:
        host = _normalize_host(entry.get("host"))
        port = _normalize_port(entry.get("port"))
    except ValueError:
        return None
    return {
        "host": host,
        "port": port,
        "label": str(entry.get("label") or "").strip()[:MAX_LABEL_LENGTH],
        "api_key_required": bool(entry.get("api_key_required")),
    }


def _write_remembered_target(ctx, entry: Optional[Mapping[str, Any]]) -> None:
    """Save or clear the remembered address. Best effort: losing the
    convenience of a prefilled form must never fail a connect or disconnect."""
    try:
        config_data = dict(ctx.services.load_config())
        if entry is None:
            if config_data.pop(CONFIG_KEY, None) is None:
                return
        else:
            if config_data.get(CONFIG_KEY) == dict(entry):
                return
            config_data[CONFIG_KEY] = dict(entry)
        ctx.services.save_config(config_data)
    except Exception as exc:
        print(f"[external-server] could not save the target: {exc}", file=sys.stderr)


def get_target(ctx) -> Optional[dict[str, Any]]:
    """Public snapshot of the registered server, or ``None`` when there is none.

    Never contains the API key -- callers publish this through ``/api/status``.
    """
    with ctx.state.external_chat_target_lock:
        snapshot = ctx.state.external_chat_target.snapshot()
    return snapshot if snapshot.get("connected") else None


def get_authorization(ctx) -> str:
    with ctx.state.external_chat_target_lock:
        connected = ctx.state.external_chat_target.snapshot().get("connected")
        key = ctx.state.external_chat_api_key
    if not connected or not key:
        return ""
    return f"Bearer {key}"


def _looks_like_llama_server(body: bytes) -> bool:
    """Is this ``/health`` body llama.cpp's?

    llama-server answers ``{"status": "ok"}`` when it is ready and a 503 with
    ``{"error": {...}}`` while a model loads. Anything that is not a JSON object
    with one of those keys is some other service holding the port.
    """
    try:
        payload = json.loads(body.decode("utf-8", errors="replace") or "null")
    except ValueError:
        return False
    return isinstance(payload, dict) and ("status" in payload or "error" in payload)


def probe(host: str, port: int, authorization: str = "") -> dict[str, Any]:
    """Probe ``/health`` and report what answered.

    Returns the HTTP status plus whether the response identifies llama-server.
    Any HTTP response means *something* is listening, so 401 (wrong key) and 503
    (still loading a model) are reported back rather than treated as failures;
    only a transport-level error means there is nothing there.
    """
    headers = {"Accept": "*/*"}
    if authorization:
        headers["Authorization"] = authorization
    request = urllib.request.Request(f"http://{host}:{port}/health", headers=headers)
    try:
        with _open_probe_request(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
            status = int(getattr(response, "status", None) or response.getcode() or 0)
            body = response.read(MAX_PROBE_BODY_BYTES)
    except urllib.error.HTTPError as exc:
        try:
            try:
                body = exc.read(MAX_PROBE_BODY_BYTES)
            except Exception:
                body = b""
            status = int(exc.code)
        finally:
            exc.close()
    except (urllib.error.URLError, OSError) as exc:
        raise ExternalServerUnreachable(
            f"No server answered at {host}:{port}. Check that llama-server is running there."
        ) from exc
    return {"status": status, "identified": _looks_like_llama_server(body)}


def describe_probe_status(status: int) -> str:
    """Warning to show alongside a successful registration, if any."""
    if status in (401, 403):
        return "Connected, but the server rejected the API key. Chat requests will fail until it matches."
    if status == 503:
        return "Connected. The server is still loading a model."
    if status >= 400:
        return f"Connected, but the server answered its health check with HTTP {status}."
    return ""


def connect(
    ctx,
    host: Any,
    port: Any,
    api_key: Any = "",
    label: Any = "",
    probe_target: bool = True,
    require_identified: bool = False,
) -> dict[str, Any]:
    """Register an externally started llama-server as the proxy target.

    ``require_identified`` is for unattended reconnects: the operator is not
    watching, so the address is only accepted when the health response actually
    looks like llama-server. A hand-driven connect stays permissive, because
    there the user chose the address and a surprising status is useful feedback.
    """
    normalized_host = _normalize_host(host)
    normalized_port = _normalize_port(port)
    normalized_key = _normalize_api_key(api_key)
    normalized_label = str(label or "").strip()[:MAX_LABEL_LENGTH]

    probe_result = {"status": 0, "identified": False}
    if probe_target:
        probe_result = probe(
            normalized_host,
            normalized_port,
            f"Bearer {normalized_key}" if normalized_key else "",
        )
        if require_identified and not probe_result["identified"]:
            raise ExternalServerUnreachable(
                f"Something is listening on {normalized_host}:{normalized_port}, "
                "but it does not look like llama-server."
            )

    with ctx.state.external_chat_target_lock:
        ctx.state.external_chat_api_key = normalized_key
        ctx.state.external_chat_target.replace(
            {
                "connected": True,
                "host": normalized_host,
                "port": normalized_port,
                "label": normalized_label,
                "api_key_configured": bool(normalized_key),
            }
        )

    _sync_v1_proxy_target(ctx)
    _write_remembered_target(
        ctx,
        {
            "host": normalized_host,
            "port": normalized_port,
            "label": normalized_label,
            "api_key_required": bool(normalized_key),
        },
    )
    return {
        **(get_target(ctx) or {}),
        "probe_status": probe_result["status"],
        "identified": probe_result["identified"],
        "warning": describe_probe_status(probe_result["status"]),
    }


def reconnect_remembered(ctx) -> Optional[dict[str, Any]]:
    """Re-register the saved address at startup, when that is unambiguous.

    Skipped when a key was needed -- the key was never stored, so reconnecting
    would only produce a target that cannot authenticate.
    """
    remembered = get_remembered_target(ctx)
    if not remembered or remembered["api_key_required"]:
        return None
    return connect(
        ctx,
        remembered["host"],
        remembered["port"],
        label=remembered["label"],
        require_identified=True,
    )


def disconnect(ctx) -> None:
    """Forget the registered server and hand the /v1 proxy back to the runtime.

    Also drops the saved address: disconnecting is the operator saying they do
    not want this target, so it must not come back on the next start.
    """
    with ctx.state.external_chat_target_lock:
        ctx.state.external_chat_api_key = ""
        ctx.state.external_chat_target.replace(default_external_chat_target())

    _write_remembered_target(ctx, None)
    _sync_v1_proxy_target(ctx)


def resolve_llama_target(ctx) -> Optional[dict[str, Any]]:
    """Pick the llama-server the chat and metrics proxies should talk to.

    A llama-server this GUI launched always wins; the registered external
    server is the fallback. ``None`` means there is nothing to talk to.
    """
    runtime = process_manager.get_active_runtime_snapshot(ctx)
    if runtime and runtime.get("tool") == "llama-server":
        return {
            "host": runtime.get("host"),
            "port": runtime.get("port"),
            "source": "runtime",
        }

    external = get_target(ctx)
    if external:
        return {
            "host": external.get("host"),
            "port": external.get("port"),
            "source": "external",
        }
    return None


def resolve_llama_authorization(
    ctx,
    target: Optional[Mapping[str, Any]],
    fallback: str = "",
) -> str:
    """Credentials for ``target``.

    A registered server uses the key stored with it; anything else falls back to
    the launched process's key (and, failing that, the caller's own header).
    """
    if target is not None and target.get("source") == "external":
        authorization = get_authorization(ctx)
        if authorization:
            return authorization
    return process_manager.get_active_llama_authorization(ctx, fallback)
