"""Shared backend configuration constants.

Keep this module free of optional third-party imports so the server can import it
during startup on a minimal Python environment.
"""

from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]

LLAMA_DIR = ROOT_DIR / "llama"
LLAMA_BIN_DIR = LLAMA_DIR / "bin"
LLAMA_GRAMMARS_DIR = LLAMA_DIR / "grammars"
MODELS_DIR = ROOT_DIR / "models"
PRESETS_DIR = ROOT_DIR / "presets"
CONFIG_FILE = ROOT_DIR / "config.json"
UI_DIR = ROOT_DIR / "ui"
APP_LOGO_FILE = ROOT_DIR / "Llama-GUI Logo.png"
TOOLS_DIR = ROOT_DIR / "tools"
CLOUDFLARED_DIR = TOOLS_DIR / "cloudflared"

GUI_HOST = "127.0.0.1"
GUI_PORT = 5240
LLAMA_HOST = "127.0.0.1"
LLAMA_PORT = 8080

BYTES_PER_MB = 1024 * 1024
WEB_SEARCH_MAX_RESULTS = 5
WEB_SEARCH_FETCH_RESULTS = 3
WEB_SEARCH_FETCH_BYTES = 512 * 1024
WEB_SEARCH_PAGE_CHARS = 12000
WEB_SEARCH_TIMEOUT = 20
WEB_SEARCH_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

GITHUB_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
APP_REPO_URL = "https://github.com/thomas9120/LLama-GUI.git"

TUNNEL_LOG_LIMIT = 6000
PROCESS_OUTPUT_LIMIT = 5000
PROCESS_OUTPUT_TRIM = 1000

RESTART_STARTUP_DELAY_SECONDS = 2.5
RESTART_PORT_WAIT_ATTEMPTS = 10
RESTART_PORT_WAIT_SECONDS = 0.5

