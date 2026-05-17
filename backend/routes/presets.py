"""Preset API routes."""

import json
import re
import urllib.parse


def sanitize_preset_name(name):
    safe_name = re.sub(r'[<>:"/\\|?*]', "_", name)
    return safe_name.replace("..", "_").strip(". ")


def is_preset_bundle(data):
    return isinstance(data, dict) and isinstance(data.get("presets"), list)


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

    with open(presets_dir / f"{safe_name}.json", "w") as preset_file:
        json.dump(data, preset_file, indent=2)
    response.json({"saved": True, "name": safe_name})


def delete_preset(request, response, ctx):
    name = request.params.get("name", "")
    safe_name = sanitize_preset_name(urllib.parse.unquote(name))
    if not safe_name:
        response.error("Invalid preset name", 400)
        return
    preset_file = ctx.paths.presets / f"{safe_name}.json"
    if preset_file.exists():
        preset_file.unlink()
        response.json({"deleted": True})
    else:
        response.error("Preset not found", 404)
