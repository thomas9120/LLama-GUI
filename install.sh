#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

PY_CMD=""
if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
fi

if [ -z "$PY_CMD" ]; then
    echo "[ERROR] Python 3 was not found on this system."
    echo "Install Python 3.9+ and ensure it is available in PATH."
    exit 1
fi

if ! "$PY_CMD" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'; then
    echo "[ERROR] Python 3.9 or newer is required."
    echo "Install Python 3.9+ and rerun ./install.sh."
    exit 1
fi

if [ ! -d ".venv" ]; then
    echo "Creating local virtual environment..."
    "$PY_CMD" -m venv .venv
fi

VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$VENV_PYTHON" ]; then
    echo "[ERROR] Virtual environment is missing its Python executable."
    echo "Delete .venv and rerun ./install.sh."
    exit 1
fi

if [ "$(uname -s)" = "Linux" ] && ! "$VENV_PYTHON" -c 'import tkinter' >/dev/null 2>&1; then
    echo
    echo "[WARNING] Native file pickers need the optional Tk system package."
    echo "  Arch/CachyOS: sudo pacman -S tk"
    echo "  Debian/Ubuntu: sudo apt install python3-tk"
    echo "Llama GUI will still install; add Tk and restart it to enable Browse/Change dialogs."
fi

echo "Upgrading pip..."
"$VENV_PYTHON" -m pip install --upgrade pip

echo "Installing Python dependencies from requirements.txt..."
"$VENV_PYTHON" -m pip install -r requirements.txt

mkdir -p llama/custom/bin llama/custom/grammars

echo
echo "Install complete."
echo "Start the app with ./mac_linux_start.sh or ./mac_linux_silent_start.sh"
