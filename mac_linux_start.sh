#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
APP_URL="http://127.0.0.1:5240"

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

open_browser() {
    (
        sleep 2
        if command -v open >/dev/null 2>&1; then
            open "$APP_URL" >/dev/null 2>&1 || true
        elif command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$APP_URL" >/dev/null 2>&1 || true
        fi
    ) &
}

echo "Starting Llama GUI server..."
open_browser
exec "$PY_CMD" server.py
