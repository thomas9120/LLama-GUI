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

echo "Upgrading pip..."
"$VENV_PYTHON" -m pip install --upgrade pip

echo "Installing Python dependencies from requirements.txt..."
"$VENV_PYTHON" -m pip install -r requirements.txt

echo
echo "Install complete."
echo "Start the app with ./mac_linux_start.sh or ./mac_linux_silent_start.sh"
