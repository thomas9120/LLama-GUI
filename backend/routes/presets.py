"""Preset API routes."""

import json
import re
import urllib.parse


def sanitize_preset_name(name):
    safe_name = re.sub(r"[^A-Za-z0-9 ._-]+", "_", str(name or ""))
    safe_name = re.sub(r"_+", "_", safe_name)
    return safe_name.strip(". _")


def get_preset_file_path(presets_dir, safe_name):
    preset_file = (presets_dir / f"{safe_name}.json").resolve()
    presets_root = presets_dir.resolve()
    if preset_file.parent != presets_root:
        return None
    return preset_file


def is_preset_bundle(data):
    return isinstance(data, dict) and isinstance(data.get("presets"), list)


def get_shortcut_filename(safe_name):
    filename = re.sub(r"[^A-Za-z0-9 ._-]+", "_", str(safe_name or "Llama GUI"))
    filename = filename.strip(". _") or "Llama GUI"
    return f"{filename}.cmd"


def escape_batch_value(value):
    return str(value or "").replace("%", "%%")


def build_preset_shortcut_script(root_dir, preset_name, gui_host="127.0.0.1", gui_port=5240):
    browser_host = str(gui_host or "127.0.0.1")
    if browser_host in {"0.0.0.0", "::", "*"}:
        browser_host = "127.0.0.1"
    if browser_host.startswith("[") and browser_host.endswith("]"):
        browser_host = browser_host[1:-1]
    url_host = f"[{browser_host}]" if ":" in browser_host and browser_host != "localhost" else browser_host
    preset_query = urllib.parse.quote(str(preset_name or ""), safe="")
    return "\r\n".join([
        "@echo off",
        "setlocal EnableExtensions EnableDelayedExpansion",
        f'set "APP_DIR={escape_batch_value(root_dir)}"',
        f'set "APP_HOST={escape_batch_value(browser_host)}"',
        f'set "APP_PORT={escape_batch_value(gui_port)}"',
        f'set "APP_URL=http://{escape_batch_value(url_host)}:{escape_batch_value(gui_port)}/?preset={escape_batch_value(preset_query)}"',
        'cd /d "%APP_DIR%"',
        'set "PY_CMD="',
        'if exist ".venv\\Scripts\\python.exe" (',
        '    set "PY_CMD=.venv\\Scripts\\python.exe"',
        ") else (",
        "    where python >nul 2>&1",
        "    if !ERRORLEVEL! EQU 0 (",
        '        set "PY_CMD=python"',
        "    ) else (",
        "        where py >nul 2>&1",
        '        if !ERRORLEVEL! EQU 0 set "PY_CMD=py -3"',
        "    )",
        ")",
        "if not defined PY_CMD (",
        "    echo [ERROR] Python was not found on this system.",
        "    echo.",
        "    echo Run windows_install.bat first, or install Python 3 and ensure it is available in PATH.",
        "    echo Download: https://www.python.org/downloads/",
        "    echo.",
        "    pause",
        "    exit /b 1",
        ")",
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $client = [Net.Sockets.TcpClient]::new(); $connect = $client.BeginConnect($env:APP_HOST, [int]$env:APP_PORT, $null, $null); if ($connect.AsyncWaitHandle.WaitOne(300)) { $client.EndConnect($connect); $client.Close(); exit 0 }; $client.Close(); exit 1 } catch { exit 1 }" >nul 2>&1',
        "if !ERRORLEVEL! EQU 0 (",
        '    start "" "%APP_URL%" >nul 2>&1',
        "    exit /b 0",
        ")",
        'start "Llama GUI Server" /min cmd /c "%PY_CMD% server.py"',
        "timeout /t 2 /nobreak >nul",
        'start "" "%APP_URL%" >nul 2>&1',
        "exit /b 0",
        "",
    ])


def list_presets(request, response, ctx):
    presets = []
    presets_dir = ctx.paths.presets
    if presets_dir.exists():
        for path in sorted(presets_dir.glob("*.json")):
            try:
                with open(path, "r") as preset_file:
                    data = json.load(preset_file)
                if is_preset_bundle(data):
                    continue
                presets.append({"name": path.stem, "data": data})
            except (json.JSONDecodeError, OSError):
                pass
    response.json(presets)


def save_preset(request, response, ctx):
    body = request.body or {}
    name = body.get("name")
    data = body.get("data")
    if not name or data is None:
        response.error("name and data required", 400)
        return

    presets_dir = ctx.paths.presets
    presets_dir.mkdir(parents=True, exist_ok=True)
    safe_name = sanitize_preset_name(name)
    if not safe_name:
        response.error("Invalid preset name", 400)
        return
    preset_file = get_preset_file_path(presets_dir, safe_name)
    if preset_file is None:
        response.error("Invalid preset name", 400)
        return

    with open(preset_file, "w") as preset_handle:
        json.dump(data, preset_handle, indent=2)
    response.json({"saved": True, "name": safe_name})


def export_preset_shortcut(request, response, ctx):
    body = request.body or {}
    safe_name = sanitize_preset_name(body.get("name"))
    if not safe_name:
        response.error("Invalid preset name", 400)
        return

    preset_file = get_preset_file_path(ctx.paths.presets, safe_name)
    if preset_file is None:
        response.error("Invalid preset name", 400)
        return
    if not preset_file.exists():
        response.error("Preset not found", 404)
        return

    script = build_preset_shortcut_script(
        ctx.paths.root,
        safe_name,
        getattr(ctx.config, "gui_host", "127.0.0.1"),
        getattr(ctx.config, "gui_port", 5240),
    )
    filename = get_shortcut_filename(safe_name)
    response.text(
        script,
        content_type="application/x-msdownload; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(filename)}",
        },
    )


def delete_preset(request, response, ctx):
    name = request.params.get("name", "")
    safe_name = sanitize_preset_name(urllib.parse.unquote(name))
    if not safe_name:
        response.error("Invalid preset name", 400)
        return
    preset_file = get_preset_file_path(ctx.paths.presets, safe_name)
    if preset_file is None:
        response.error("Invalid preset name", 400)
        return
    if preset_file.exists():
        preset_file.unlink()
        response.json({"deleted": True})
    else:
        response.error("Preset not found", 404)
