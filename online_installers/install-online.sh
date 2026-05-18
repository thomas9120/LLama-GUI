#!/usr/bin/env sh
set -eu

REPO_URL="${LLAMA_GUI_REPO_URL:-https://github.com/thomas9120/LLama-GUI.git}"
REPO_BRANCH="${LLAMA_GUI_BRANCH:-main}"
INSTALL_DIR="${LLAMA_GUI_INSTALL_DIR:-$HOME/LLama-GUI}"

need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "[ERROR] Required command not found: $1"
        exit 1
    fi
}

find_python() {
    if command -v python3 >/dev/null 2>&1; then
        echo "python3"
    elif command -v python >/dev/null 2>&1; then
        echo "python"
    else
        echo ""
    fi
}

need_cmd git

PY_CMD=$(find_python)
if [ -z "$PY_CMD" ]; then
    echo "[ERROR] Python 3 was not found on this system."
    echo "Install Python 3.9+ and ensure it is available in PATH."
    exit 1
fi

if [ -e "$INSTALL_DIR" ]; then
    if [ ! -d "$INSTALL_DIR/.git" ]; then
        echo "[ERROR] Install path already exists but is not a git checkout:"
        echo "        $INSTALL_DIR"
        echo "Set LLAMA_GUI_INSTALL_DIR to a different folder and rerun this installer."
        exit 1
    fi
    echo "Updating existing Llama GUI checkout at $INSTALL_DIR..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    echo "Cloning Llama GUI into $INSTALL_DIR..."
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
chmod +x install.sh mac_linux_start.sh mac_linux_silent_start.sh 2>/dev/null || true

echo "Installing Python dependencies..."
./install.sh

if [ "${LLAMA_GUI_NO_START:-0}" = "1" ]; then
    echo
    echo "Install complete. Start Llama GUI later with:"
    echo "  cd \"$INSTALL_DIR\" && ./mac_linux_start.sh"
    exit 0
fi

echo
echo "Starting Llama GUI..."
exec ./mac_linux_start.sh
