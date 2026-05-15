"""Application context objects shared by backend modules."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence, Tuple

from . import config
from .state import ServerState


@dataclass(frozen=True)
class AppPaths:
    root: Path = config.ROOT_DIR
    llama: Path = config.LLAMA_DIR
    llama_bin: Path = config.LLAMA_BIN_DIR
    llama_grammars: Path = config.LLAMA_GRAMMARS_DIR
    models: Path = config.MODELS_DIR
    presets: Path = config.PRESETS_DIR
    config_file: Path = config.CONFIG_FILE
    ui: Path = config.UI_DIR
    app_logo: Path = config.APP_LOGO_FILE
    tools: Path = config.TOOLS_DIR
    cloudflared: Path = config.CLOUDFLARED_DIR


@dataclass(frozen=True)
class ServerConfig:
    gui_host: str = config.GUI_HOST
    gui_port: int = config.GUI_PORT
    llama_host: str = config.LLAMA_HOST
    llama_port: int = config.LLAMA_PORT
    github_api: str = config.GITHUB_API
    app_repo_url: str = config.APP_REPO_URL


def _missing_service(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("Backend service has not been configured.")


@dataclass
class BackendServices:
    backend_specs: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    binary_suffix: str = ""
    current_arch: str = "unknown"
    current_platform: str = "unknown"
    find_tool_executable: Callable[[str], Path] = _missing_service
    get_local_llama_metrics: Callable[[str, str], Tuple[Optional[str], str]] = _missing_service
    get_platform_label: Callable[[], str] = _missing_service
    get_runtime_files: Callable[[], Sequence[Path]] = _missing_service
    get_tool_filename: Callable[[str], str] = _missing_service
    is_process_running: Callable[[], bool] = _missing_service
    llama_tools: Sequence[str] = field(default_factory=tuple)
    load_config: Callable[[], Mapping[str, Any]] = _missing_service
    ssl_context: Any = None
    urlopen_with_ssl: Callable[..., Any] = _missing_service


@dataclass
class AppContext:
    paths: AppPaths = field(default_factory=AppPaths)
    config: ServerConfig = field(default_factory=ServerConfig)
    state: ServerState = field(default_factory=ServerState)
    services: BackendServices = field(default_factory=BackendServices)


DEFAULT_CONTEXT = AppContext()
