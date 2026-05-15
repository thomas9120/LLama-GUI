"""Backend status API route."""

from ..config import LLAMA_HOST, LLAMA_PORT


def get_status(request, response, ctx):
    try:
        services = ctx.services
        cfg = services.load_config()
        exes = {}
        for tool in services.llama_tools:
            name = services.get_tool_filename(tool)
            exes[name] = services.find_tool_executable(tool).exists()

        runtime_files = services.get_runtime_files()
        runtime_health = dict(services.validate_runtime_dependencies())
        has_config = bool(cfg.get("tag"))
        installed = (
            has_config
            and exes.get(services.get_tool_filename("llama-cli"), False)
            and runtime_health.get("ok", True)
        )
        config_stale = has_config and not installed
        running = services.is_process_running()
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
                "running": running,
                "active_process_tool": ctx.state.active_process_tool,
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
        response.error(f"Failed to read backend status: {exc}", 500)
