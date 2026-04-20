#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

PY_CMD=""
if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    PY_CMD="$SCRIPT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
fi

if [ -z "$PY_CMD" ]; then
    echo "[ERROR] Python 3 was not found on this system."
    echo "Run ./install.sh first, or install Python 3.9+ and ensure it is available in PATH."
    exit 1
fi

echo "Starting Llama GUI server..."
exec "$PY_CMD" server.py
