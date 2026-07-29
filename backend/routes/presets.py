"""Preset API routes."""

import json
import re
import sys
import time
import urllib.parse


_PRESET_CREATED_TIMES_FILE = ".preset-created-times"
_SENSITIVE_PRESET_KEYS = {"api_key"}
_SENSITIVE_CUSTOM_ARG_RE = re.compile(r"(?<![A-Za-z0-9_-])--api-key(?=$|[=\s])")


def has_sensitive_custom_args(data):
    if not isinstance(data, dict):
        return False
    candidates = [data]
    flags = data.get("flags")
    if isinstance(flags, dict):
        candidates.append(flags)
    return any(
        isinstance(candidate.get("custom_args"), str)
        and bool(_SENSITIVE_CUSTOM_ARG_RE.search(candidate["custom_args"]))
        for candidate in candidates
    )


def sanitize_preset_data(data):
    if not isinstance(data, dict):
        return data, False
    sanitized = dict(data)
    changed = False
    flags = sanitized.get("flags")
    if isinstance(flags, dict):
        clean_flags = dict(flags)
        for key in _SENSITIVE_PRESET_KEYS:
            if key in clean_flags:
                del clean_flags[key]
                changed = True
        if has_sensitive_custom_args({"flags": clean_flags}):
            del clean_flags["custom_args"]
            changed = True
        sanitized["flags"] = clean_flags
    for key in _SENSITIVE_PRESET_KEYS:
        if key in sanitized:
            del sanitized[key]
            changed = True
    if has_sensitive_custom_args(sanitized):
        del sanitized["custom_args"]
        changed = True
    return sanitized, changed


def _write_preset_json(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(temporary, "w", encoding="utf-8") as preset_handle:
            json.dump(data, preset_handle, indent=2)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


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


def _is_valid_timestamp(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and value > 0


def _load_preset_created_times(presets_dir):
    metadata_file = presets_dir / _PRESET_CREATED_TIMES_FILE
    try:
        data = json.loads(metadata_file.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        return {
            str(name): float(created)
            for name, created in data.items()
            if _is_valid_timestamp(created)
        }
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        print(
            f"[presets] failed to read creation metadata: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return {}


def _save_preset_created_times(presets_dir, created_times):
    metadata_file = presets_dir / _PRESET_CREATED_TIMES_FILE
    try:
        metadata_file.write_text(
            json.dumps(created_times, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    except OSError as exc:
        print(
            f"[presets] failed to save creation metadata: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )


def _initial_preset_created_time(stat_result):
    birth_time = getattr(stat_result, "st_birthtime", None)
    if _is_valid_timestamp(birth_time):
        return float(birth_time)
    if sys.platform == "win32" and _is_valid_timestamp(stat_result.st_ctime):
        return float(stat_result.st_ctime)
    return float(stat_result.st_mtime)


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
        created_times = _load_preset_created_times(presets_dir)
        existing_names = set()
        metadata_changed = False
        for path in sorted(presets_dir.glob("*.json")):
            try:
                with open(path, "r", encoding="utf-8") as preset_file:
                    data = json.load(preset_file)
                if is_preset_bundle(data):
                    continue
                stat_result = path.stat()
                data, removed_sensitive_values = sanitize_preset_data(data)
                if removed_sensitive_values:
                    _write_preset_json(path, data)
                existing_names.add(path.name)
                created = created_times.get(path.name)
                if not _is_valid_timestamp(created):
                    created = _initial_preset_created_time(stat_result)
                    created_times[path.name] = created
                    metadata_changed = True
                presets.append({
                    "name": path.stem,
                    "data": data,
                    "created": created,
                    "modified": path.stat().st_mtime,
                })
            except (json.JSONDecodeError, OSError) as exc:
                print(
                    f"[presets] skipping unreadable preset {path.name}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
        stale_names = set(created_times) - existing_names
        if stale_names:
            for name in stale_names:
                del created_times[name]
            metadata_changed = True
        if metadata_changed:
            _save_preset_created_times(presets_dir, created_times)
    response.json(presets)


def save_preset(request, response, ctx):
    body = request.body or {}
    name = body.get("name")
    data = body.get("data")
    if not name or data is None:
        response.error("name and data required", 400)
        return
    if has_sensitive_custom_args(data):
        response.error(
            "Presets cannot include --api-key in Custom Launch Args. Use the API Key field instead.",
            400,
        )
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
    if body.get("overwrite", True) is False and preset_file.exists():
        response.error("A preset with that name already exists", 409)
        return

    created_times = _load_preset_created_times(presets_dir)
    if not _is_valid_timestamp(created_times.get(preset_file.name)):
        if preset_file.exists():
            created_times[preset_file.name] = _initial_preset_created_time(preset_file.stat())
        else:
            created_times[preset_file.name] = time.time()

    data, _ = sanitize_preset_data(data)
    _write_preset_json(preset_file, data)
    _save_preset_created_times(presets_dir, created_times)
    response.json({"saved": True, "name": safe_name})


def _is_same_file(left, right):
    """True when two paths are the same file on disk.

    Distinguishes a case-only rename on a case-insensitive filesystem (same file,
    safe to rename) from a genuine collision with a different preset. Errors are
    treated as a collision so a rename never overwrites an unreadable file.
    """
    try:
        return left.samefile(right)
    except OSError:
        return False


def rename_preset(request, response, ctx):
    body = request.body or {}
    safe_name = sanitize_preset_name(body.get("name"))
    safe_new_name = sanitize_preset_name(body.get("new_name"))
    if not safe_name or not safe_new_name:
        response.error("Invalid preset name", 400)
        return

    presets_dir = ctx.paths.presets
    preset_file = get_preset_file_path(presets_dir, safe_name)
    # validation only: the resolved path is unusable as a rename target because
    # Windows collapses its casing onto any existing file
    validated_target = get_preset_file_path(presets_dir, safe_new_name)
    if preset_file is None or validated_target is None:
        response.error("Invalid preset name", 400)
        return
    if not preset_file.exists():
        response.error("Preset not found", 404)
        return
    if safe_name == safe_new_name:
        response.json({"renamed": True, "name": safe_new_name})
        return

    # On Windows both Path equality and resolve() are case-insensitive, so a case-only
    # rename would collapse onto the source and silently do nothing. Rename against the
    # requested spelling instead, inside the parent get_preset_file_path already validated.
    renamed_file = preset_file.parent / f"{safe_new_name}.json"
    if renamed_file.exists() and not _is_same_file(renamed_file, preset_file):
        response.error("A preset with that name already exists", 409)
        return

    preset_file.rename(renamed_file)
    created_times = _load_preset_created_times(presets_dir)
    if preset_file.name in created_times:
        # carry the original creation time so "Date added" sorting survives a rename
        created_times[renamed_file.name] = created_times.pop(preset_file.name)
        _save_preset_created_times(presets_dir, created_times)
    response.json({"renamed": True, "name": safe_new_name})


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
        created_times = _load_preset_created_times(ctx.paths.presets)
        if preset_file.name in created_times:
            del created_times[preset_file.name]
            _save_preset_created_times(ctx.paths.presets, created_times)
        response.json({"deleted": True})
    else:
        response.error("Preset not found", 404)
