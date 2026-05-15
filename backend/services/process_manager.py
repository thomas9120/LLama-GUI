"""llama.cpp process management helpers."""

import os
import shutil
import signal
import subprocess
import sys
import threading
from typing import Any, Iterable

from .. import config
from ..context import AppContext


def is_process_running(ctx: AppContext) -> bool:
    with ctx.state.process_lock:
        return ctx.state.process is not None and ctx.state.process.poll() is None


def get_output_snapshot(ctx: AppContext) -> dict[str, Any]:
    with ctx.state.output_buffer_lock:
        lines = list(ctx.state.output_buffer)
    return {"output": lines, "running": is_process_running(ctx)}


def stream_output(ctx: AppContext, pipe: Any, is_stderr: bool = False) -> None:
    try:
        for line in iter(pipe.readline, ""):
            if line:
                decoded = line.rstrip("\n\r")
                with ctx.state.output_buffer_lock:
                    ctx.state.output_buffer.append(decoded)
                    if len(ctx.state.output_buffer) > config.PROCESS_OUTPUT_LIMIT:
                        del ctx.state.output_buffer[: config.PROCESS_OUTPUT_TRIM]
    except Exception:
        pass


def flatten_launch_args(args_list: Iterable[Any] | None) -> list[str]:
    flat_args: list[str] = []
    for entry in args_list or []:
        if isinstance(entry, list):
            flat_args.extend(str(v) for v in entry)
        else:
            flat_args.append(str(entry))
    return flat_args


def parse_launch_api_target(ctx: AppContext, args_list: Iterable[Any] | None) -> dict[str, Any]:
    flat_args = flatten_launch_args(args_list)

    host: Any = ctx.config.llama_host
    port: Any = ctx.config.llama_port
    i = 0
    while i < len(flat_args):
        item = flat_args[i]
        if item == "--host" and i + 1 < len(flat_args):
            host = flat_args[i + 1]
            i += 2
            continue
        if item.startswith("--host="):
            host = item.split("=", 1)[1]
        elif item == "--port" and i + 1 < len(flat_args):
            port = flat_args[i + 1]
            i += 2
            continue
        elif item.startswith("--port="):
            port = item.split("=", 1)[1]
        i += 1
    try:
        return dict(ctx.services.set_llama_api_target(host, port))
    except ValueError:
        return dict(ctx.services.get_llama_api_target())


def _build_process_env(ctx: AppContext) -> dict[str, str]:
    env = os.environ.copy()
    runtime_paths = [str(ctx.paths.llama_bin)]
    existing_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(runtime_paths + ([existing_path] if existing_path else []))

    current_platform = ctx.services.current_platform or sys.platform
    if current_platform.startswith("linux"):
        existing_ld = env.get("LD_LIBRARY_PATH", "")
        env["LD_LIBRARY_PATH"] = os.pathsep.join(
            runtime_paths + ([existing_ld] if existing_ld else [])
        )
    elif current_platform == "darwin":
        existing_dyld = env.get("DYLD_LIBRARY_PATH", "")
        env["DYLD_LIBRARY_PATH"] = os.pathsep.join(
            runtime_paths + ([existing_dyld] if existing_dyld else [])
        )
    return env


def launch_process(ctx: AppContext, tool: str, args_list: Iterable[Any] | None) -> dict[str, Any]:
    with ctx.state.process_lock:
        if ctx.state.process and ctx.state.process.poll() is None:
            return {"error": "A process is already running"}

        exe_name = ctx.services.get_tool_filename(tool)
        exe_path = ctx.services.find_tool_executable(tool)
        if not exe_path.exists():
            return {"error": f"{exe_name} not found. Install llama.cpp first."}

        args = [str(exe_path), *flatten_launch_args(args_list)]
        env = _build_process_env(ctx)

        with ctx.state.output_buffer_lock:
            ctx.state.output_buffer.clear()

        try:
            ctx.state.process = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                env=env,
                cwd=str(ctx.paths.root),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
                if sys.platform == "win32"
                else 0,
            )
            threading.Thread(
                target=stream_output, args=(ctx, ctx.state.process.stdout), daemon=True
            ).start()
            threading.Thread(
                target=stream_output, args=(ctx, ctx.state.process.stderr, True), daemon=True
            ).start()
            ctx.state.active_process_tool = tool
            if tool == "llama-server":
                parse_launch_api_target(ctx, args_list)
            return {"pid": ctx.state.process.pid, "command": " ".join(args)}
        except Exception as e:
            return {"error": str(e)}


def stop_process(ctx: AppContext) -> bool:
    with ctx.state.process_lock:
        if ctx.state.process and ctx.state.process.poll() is None:
            if sys.platform == "win32":
                ctx.state.process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                ctx.state.process.terminate()
            try:
                ctx.state.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ctx.state.process.kill()
            ctx.state.active_process_tool = None
            return True
        return False


def send_input(ctx: AppContext, text: str) -> bool:
    with ctx.state.process_lock:
        if ctx.state.process and ctx.state.process.poll() is None:
            try:
                if ctx.state.process.stdin:
                    ctx.state.process.stdin.write(text + "\n")
                    ctx.state.process.stdin.flush()
                    return True
            except Exception:
                return False
        return False


def remove_llama_files(ctx: AppContext) -> int:
    removed_files = 0

    if ctx.paths.llama.exists():
        for path in ctx.paths.llama.rglob("*"):
            if path.is_file():
                removed_files += 1

    if ctx.paths.llama.exists():
        shutil.rmtree(ctx.paths.llama)

    for directory in [ctx.paths.llama_bin, ctx.paths.llama_grammars]:
        directory.mkdir(parents=True, exist_ok=True)

    ctx.services.save_config({"version": None, "backend": None, "tag": None})

    return removed_files
