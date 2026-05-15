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
    output_buffer: list[str] = field(default_factory=list)
    output_buffer_lock: threading.Lock = field(default_factory=threading.Lock)
    active_process_tool: Optional[str] = None

    download_progress: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_download_progress())
    )
    install_in_progress: bool = False
    install_lock: threading.Lock = field(default_factory=threading.Lock)

    model_download: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_model_download_state())
    )
    model_download_in_progress: bool = False
    model_download_lock: threading.Lock = field(default_factory=threading.Lock)
    model_download_cancel: threading.Event = field(default_factory=threading.Event)

    gui_server: Any = None
    remote_tunnel_process: Any = None
    remote_tunnel: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_remote_tunnel_state())
    )
    remote_tunnel_lock: threading.Lock = field(default_factory=threading.Lock)

    llama_api_target: AtomicDict = field(
        default_factory=lambda: AtomicDict(default_llama_api_target())
    )
    llama_api_target_lock: threading.Lock = field(default_factory=threading.Lock)
