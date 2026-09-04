"""Thread-safe state containers for backend runtime state."""

from dataclasses import dataclass, field
import threading
from typing import Any, Mapping, Optional

from . import config


def default_download_progress() -> dict[str, Any]:
    return {"total": 0, "downloaded": 0, "status": "idle", "message": ""}


def default_model_download_state() -> dict[str, Any]:
    return {
        "status": "idle",
        "message": "",
        "total": 0,
        "downloaded": 0,
        "current_file": "",
        "model_name": "",
        "model_path": "",
        "mmproj_path": "",
    }


def default_remote_tunnel_state() -> dict[str, Any]:
    return {
        "status": "idle",
        "url": "",
        "message": "Remote tunnel is not running.",
        "log": "",
    }


def default_llama_api_target() -> dict[str, Any]:
    return {"host": config.LLAMA_HOST, "port": config.LLAMA_PORT}


def default_external_chat_target() -> dict[str, Any]:
    """Public description of an externally started llama-server.

    Deliberately free of credentials: this dict is handed out through
    ``/api/status``, so the registered API key lives in its own state field.
    """
    return {
        "connected": False,
        "host": "",
        "port": 0,
        "label": "",
        "api_key_configured": False,
    }


class AtomicDict:
    """Small lock-protected dict wrapper used for status snapshots.

    Mutating methods return a copied post-mutation snapshot so callers can use
    the new state without holding the internal lock.
    """

    def __init__(self, initial: Optional[Mapping[str, Any]] = None) -> None:
        self._lock = threading.Lock()
        self._data = dict(initial or {})

    def update(self, **updates: Any) -> dict[str, Any]:
        with self._lock:
            self._data.update(updates)
            return dict(self._data)

    def replace(self, values: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._data.clear()
            self._data.update(values)
            return dict(self._data)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._data)


@dataclass
class ServerState:
    process: Any = None
    process_lock: threading.Lock = field(default_factory=threading.Lock)
    preset_lock: threading.Lock = field(default_factory=threading.Lock)
    output_buffer: list[str] = field(default_factory=list)
    output_buffer_lock: threading.Lock = field(default_factory=threading.Lock)
    output_buffer_start: int = 0
    output_buffer_next: int = 0
    output_generation: int = 0
    output_reader_count: int = 0
    active_process_tool: Optional[str] = None
    active_llama_api_keys: tuple[str, ...] = field(default_factory=tuple)
    active_runtime: Optional[dict[str, Any]] = None
    runtime_generation: int = 0
    last_exit_code: Optional[int] = None
    restart_requested: threading.Event = field(default_factory=threading.Event)

    runtime_health_cache: dict[Any, tuple[float, dict[str, Any]]] = field(default_factory=dict)
    runtime_health_lock: threading.Lock = field(default_factory=threading.Lock)

    # Monitor tab system/GPU telemetry. `system_stats_lock` guards the previous
    # counter sample, the response cache, the cache generation, and the
    # all-smi/AMD probe caches; it is never held across a GPU subprocess. The
    # separate `system_stats_collection_lock` serialises cold/forced
    # collections, and waiters compare `system_stats_generation` around it so
    # concurrent polls share one collection and repeated Recheck clicks coalesce.
    system_stats_lock: threading.Lock = field(default_factory=threading.Lock)
    system_stats_collection_lock: threading.Lock = field(default_factory=threading.Lock)
    system_stats_previous: Optional[dict[str, Any]] = None
    system_stats_cache: Optional[dict[str, Any]] = None
    system_stats_generation: int = 0
    system_stats_probe_cache: dict[str, Any] = field(default_factory=dict)

    download_progress: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_download_progress())
    )
    install_in_progress: bool = False
    install_lock: threading.Lock = field(default_factory=threading.Lock)

    # Git-based app update. Its own lock and slot on purpose: an update runs
    # git fetch/merge plus pip and PowerShell on the handler thread and must
    # not queue behind — or block — the install/process lock order.
    app_update_in_progress: bool = False
    app_update_lock: threading.Lock = field(default_factory=threading.Lock)

    model_download: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_model_download_state())
    )
    model_download_in_progress: bool = False
    model_download_lock: threading.Lock = field(default_factory=threading.Lock)
    model_download_cancel: threading.Event = field(default_factory=threading.Event)
    model_download_xet_group: Any = None

    gui_server: Any = None
    remote_tunnel_process: Any = None
    remote_tunnel_generation: int = 0
    remote_tunnel: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_remote_tunnel_state())
    )
    remote_tunnel_lock: threading.Lock = field(default_factory=threading.Lock)

    llama_api_target: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_llama_api_target())
    )
    llama_api_target_lock: threading.Lock = field(default_factory=threading.Lock)

    # A llama-server the operator started outside this GUI. Session-scoped: the
    # key never reaches disk, so it cannot outlive the process. Only the address
    # is remembered (in `config.json`), and an unattended restore re-probes it
    # first so a port taken over by another local service is refused rather than
    # silently proxied to -- see `services/external_server.reconnect_remembered`.
    # The key is kept out of `external_chat_target` because that dict is
    # published through the status API.
    external_chat_target: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_external_chat_target())
    )
    external_chat_api_key: str = ""
    external_chat_target_lock: threading.Lock = field(default_factory=threading.Lock)
    config_lock: threading.Lock = field(default_factory=threading.Lock)

    def clear_runtime_health_cache(self) -> None:
        with self.runtime_health_lock:
            self.runtime_health_cache.clear()
