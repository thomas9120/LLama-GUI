"""Shared backend configuration constants.

Keep this module free of optional third-party imports so the server can import it
during startup on a minimal Python environment.
"""

import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]

LLAMA_DIR = ROOT_DIR / "llama"
LLAMA_BIN_DIR = LLAMA_DIR / "bin"
LLAMA_GRAMMARS_DIR = LLAMA_DIR / "grammars"
LLAMA_CUSTOM_DIR = LLAMA_DIR / "custom"
LLAMA_CUSTOM_BIN_DIR = LLAMA_CUSTOM_DIR / "bin"
LLAMA_CUSTOM_GRAMMARS_DIR = LLAMA_CUSTOM_DIR / "grammars"
MODELS_DIR = ROOT_DIR / "models"
PRESETS_DIR = ROOT_DIR / "presets"
CONFIG_FILE = ROOT_DIR / "config.json"
UI_DIR = ROOT_DIR / "ui"
APP_LOGO_FILE = ROOT_DIR / "Llama-GUI Logo.png"
TOOLS_DIR = ROOT_DIR / "tools"
CLOUDFLARED_DIR = TOOLS_DIR / "cloudflared"

DEFAULT_GUI_HOST = "127.0.0.1"
DEFAULT_GUI_PORT = 5240
SUPERVISOR_RESTART_EXIT_CODE = 75
REQUEST_BODY_TIMEOUT_SECONDS = 30
MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024


def parse_gui_host(value: object, default: str = DEFAULT_GUI_HOST) -> str:
    host = str(value or "").strip()
    if not host or any(ord(ch) < 32 for ch in host) or "/" in host:
        return default
    if host == "*":
        return "0.0.0.0"
    if host.startswith("[") and host.endswith("]"):
        return host[1:-1]
    return host


def parse_gui_port(value: object, default: int = DEFAULT_GUI_PORT) -> int:
    try:
        port = int(str(value or "").strip())
    except (TypeError, ValueError):
        return default
    if port < 1 or port > 65535:
        return default
    return port


def parse_gui_allowed_hosts(value: object) -> tuple[str, ...]:
    hosts = []
    for raw_host in str(value or "").split(","):
        host = parse_gui_host(raw_host, default="")
        if host:
            host = host.lower()
        if host and host not in hosts:
            hosts.append(host)
    return tuple(hosts)


def parse_bool_env(value: object) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


GUI_HOST = parse_gui_host(os.environ.get("LLAMA_GUI_HOST"), DEFAULT_GUI_HOST)
GUI_PORT = parse_gui_port(os.environ.get("LLAMA_GUI_PORT"), DEFAULT_GUI_PORT)
GUI_ALLOWED_HOSTS = parse_gui_allowed_hosts(os.environ.get("LLAMA_GUI_ALLOWED_HOSTS"))
SUPERVISED = parse_bool_env(os.environ.get("LLAMA_GUI_SUPERVISED"))
LLAMA_HOST = "127.0.0.1"
LLAMA_PORT = 8080

WEB_SEARCH_MAX_RESULTS = 5
WEB_SEARCH_FETCH_BYTES = 512 * 1024
WEB_SEARCH_PAGE_CHARS = 12000
WEB_SEARCH_TIMEOUT = 20
WEB_SEARCH_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

# Local files whose text may be read into chat context, by extension. A file the
# user references by path in a chat message is read and added as context. PDF and
# DOCX need the optional pypdf / python-docx packages.
WEB_FILE_MAX_BYTES = 8 * 1024 * 1024
WEB_FILE_TEXT_SUFFIXES = (
    ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log",
    ".html", ".htm", ".xml", ".yaml", ".yml", ".rtf",
)
WEB_FILE_IMAGE_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff",
)

GITHUB_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
APP_REPO_URL = "https://github.com/thomas9120/LLama-GUI.git"
# Branch that release tags are cut from. Auto-update always compares against
# this branch's tags, so users sitting on a development branch still see (and
# can fast-forward to) the newest published release.
APP_RELEASE_BRANCH = "main"

TUNNEL_LOG_LIMIT = 6000
PROCESS_OUTPUT_LIMIT = 5000
PROCESS_OUTPUT_TRIM = 1000

RESTART_STARTUP_DELAY_SECONDS = 2.5
RESTART_PORT_WAIT_ATTEMPTS = 10
RESTART_PORT_WAIT_SECONDS = 0.5

