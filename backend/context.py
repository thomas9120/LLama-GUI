"""Application context objects shared by backend modules."""

from dataclasses import dataclass, field
from pathlib import Path

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


@dataclass
class AppContext:
    paths: AppPaths = field(default_factory=AppPaths)
    config: ServerConfig = field(default_factory=ServerConfig)
    state: ServerState = field(default_factory=ServerState)


DEFAULT_CONTEXT = AppContext()

