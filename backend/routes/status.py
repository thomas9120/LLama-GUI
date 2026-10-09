"""Backend status API route."""

import os
import sys

from ..http import sanitize_error
from ..config import LLAMA_HOST, LLAMA_PORT
from ..services import external_server
from ..services import llama_manager
from ..services import model_dir
from ..services import process_manager
from ..services import official_backends


def get_status(request, response, ctx):
    try:
        services = ctx.services
        cfg = services.load_config()
        exes = {}
        for tool in services.llama_tools:
            name = services.get_tool_filename(tool)
            executable = services.find_tool_executable(tool)
            exes[name] = executable is not None and executable.is_file() and (
                services.current_platform == "win32" or os.access(executable, os.X_OK)
            )

        runtime_files = services.get_runtime_files()
        runtime_health = dict(services.validate_runtime_dependencies())
        has_config = bool(cfg.get("tag"))
        is_system = llama_manager.is_system_backend(cfg.get("backend"))
        if is_system:
            # System readiness needs the required server entry point, not the
            # optional CLI. A missing estimator or benchmark tool never blocks it.
            core_tools_present = bool(
                exes.get(services.get_tool_filename("llama-server"), False)
            )
        else:
            core_tools_present = all(
                exes.get(services.get_tool_filename(tool), False)
                for tool in ("llama-cli", "llama-server")
            )
        installed = has_config and core_tools_present and runtime_health.get("ok", True)
        config_stale = has_config and not installed
        process_status = process_manager.get_process_status_snapshot(ctx)
        model_dir_info = model_dir.get_models_dir_info(ctx)
        backend_specs = official_backends.get_backend_specs(ctx)
        official_install = llama_manager.get_official_install_status(ctx, cfg)
        try:
            api_target = dict(services.get_llama_api_target())
        except Exception as exc:
            print(f"[status] failed to read llama API target: {exc}", file=sys.stderr)
            api_target = {"host": LLAMA_HOST, "port": LLAMA_PORT}

        # PATH discovery for display: per-tool entry points, availability, and
        # probe state. Paths resolve regardless of the active backend so the
        # GUI can preview System before activation; build/probe details come
        # from runtime health and are only present while System is active.
        system_probes = runtime_health.get("system_probes") or {}
        system_build_tags = runtime_health.get("build_tags") or {}
        system_tools = {}
        for tool in services.llama_tools:
            try:
                discovered = services.find_tool_executable(tool)
            except Exception:
                discovered = None
            probe = system_probes.get(tool) or {}
            system_tools[tool] = {
                "path": str(discovered) if discovered is not None else None,
                "available": bool(
                    exes.get(services.get_tool_filename(tool), False)
                ),
                "build_tag": system_build_tags.get(tool),
                "probe_ok": probe.get("ok"),
                "probe_error": probe.get("error"),
            }

        system_server_error = None
        if is_system:
            server_probe = system_probes.get("llama-server") or {}
            if not system_tools.get("llama-server", {}).get("available"):
                system_server_error = llama_manager.SYSTEM_PATH_GUIDANCE
            elif server_probe.get("ok") is False:
                detail = server_probe.get("error") or "could not be started"
                server_name = services.get_tool_filename("llama-server")
                system_server_error = (
                    f"{server_name} {detail}. "
                    f"Check that it runs with `{server_name} --version`."
                )

        response.json(
            {
                "installed": installed,
                "config_stale": config_stale,
                "version": cfg.get("tag"),
                "backend": cfg.get("backend"),
                "official_install": official_install,
                "executables": exes,
                "runtime_files": [path.name for path in runtime_files],
                "runtime_files_label": "Runtime libraries",
                "runtime_health": runtime_health,
                "missing_runtime_files": runtime_health.get("missing_runtime_files", []),
                "system_tools": system_tools,
                "system_server_error": system_server_error,
                **model_dir_info,
                "running": process_status["running"],
                "active_process_tool": process_status["active_process_tool"],
                "active_runtime": process_status["active_runtime"],
                "runtime_generation": process_status["runtime_generation"],
                "api_auth_configured": process_status["api_auth_configured"],
                "last_exit_code": process_status["last_exit_code"],
                "api_target": api_target,
                "external_chat_target": external_server.get_target(ctx),
                "platform": services.current_platform,
                "platform_label": services.get_platform_label(),
                "arch": services.current_arch,
                "executable_suffix": services.binary_suffix,
                "available_backends": [
                    {
                        "id": key, "label": spec["label"],
                        **({"custom": True, "bin_dir": llama_manager.custom_backend_bin_label(key)}
                           if llama_manager.is_custom_backend(key) else {}),
                        **({"system_path": True}
                           if llama_manager.is_system_backend(key) else {}),
                    }
                    for key, spec in backend_specs.items()
                ],
            }
        )
    except Exception as exc:
        response.error(sanitize_error(exc, 500), 500)
