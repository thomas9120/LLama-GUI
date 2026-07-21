"""Backend status API route."""

import os

from ..http import sanitize_error
from ..config import LLAMA_HOST, LLAMA_PORT
from ..services import process_manager


def get_status(request, response, ctx):
    try:
        services = ctx.services
        cfg = services.load_config()
        exes = {}
        for tool in services.llama_tools:
            name = services.get_tool_filename(tool)
            executable = services.find_tool_executable(tool)
            exes[name] = executable.is_file() and (
                services.current_platform == "win32" or os.access(executable, os.X_OK)
            )

        runtime_files = services.get_runtime_files()
        runtime_health = dict(services.validate_runtime_dependencies())
        has_config = bool(cfg.get("tag"))
        core_tools_present = all(
            exes.get(services.get_tool_filename(tool), False)
            for tool in ("llama-cli", "llama-server")
        )
        installed = has_config and core_tools_present and runtime_health.get("ok", True)
        config_stale = has_config and not installed
        process_status = process_manager.get_process_status_snapshot(ctx)
        backend_specs = services.backend_specs
        try:
            api_target = dict(services.get_llama_api_target())
        except Exception:
            api_target = {"host": LLAMA_HOST, "port": LLAMA_PORT}

        response.json(
            {
                "installed": installed,
                "config_stale": config_stale,
                "version": cfg.get("tag"),
                "backend": cfg.get("backend"),
                "executables": exes,
                "runtime_files": [path.name for path in runtime_files],
                "runtime_files_label": "Runtime libraries",
                "runtime_health": runtime_health,
                "missing_runtime_files": runtime_health.get("missing_runtime_files", []),
                "models_dir": str(ctx.paths.models),
                "running": process_status["running"],
                "active_process_tool": process_status["active_process_tool"],
                "active_runtime": process_status["active_runtime"],
                "runtime_generation": process_status["runtime_generation"],
                "api_auth_configured": process_status["api_auth_configured"],
                "last_exit_code": process_status["last_exit_code"],
                "api_target": api_target,
                "platform": services.current_platform,
                "platform_label": services.get_platform_label(),
                "arch": services.current_arch,
                "executable_suffix": services.binary_suffix,
                "available_backends": [
                    {"id": key, "label": spec["label"]}
                    for key, spec in backend_specs.items()
                ],
            }
        )
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
