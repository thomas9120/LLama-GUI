"""llama.cpp process management helpers."""

import os
import shutil
import signal
import subprocess
import sys
import threading
import re
from typing import Any, Iterable, Optional

from .. import config
from ..context import AppContext


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
_ESTIMATE_VALUE_FLAGS = {
    "-t",
    "--threads",
    "-tb",
    "--threads-batch",
    "-C",
    "--cpu-mask",
    "-Cr",
    "--cpu-range",
    "--cpu-strict",
    "--prio",
    "--poll",
    "-Cb",
    "--cpu-mask-batch",
    "-Crb",
    "--cpu-range-batch",
    "--cpu-strict-batch",
    "--prio-batch",
    "--poll-batch",
    "-c",
    "--ctx-size",
    "-n",
    "--predict",
    "--n-predict",
    "-b",
    "--batch-size",
    "-ub",
    "--ubatch-size",
    "--keep",
    "-fa",
    "--flash-attn",
    "-p",
    "--prompt",
    "-f",
    "--file",
    "-bf",
    "--binary-file",
    "--rope-scaling",
    "--rope-scale",
    "--rope-freq-base",
    "--rope-freq-scale",
    "--yarn-orig-ctx",
    "--yarn-ext-factor",
    "--yarn-attn-factor",
    "--yarn-beta-slow",
    "--yarn-beta-fast",
    "-ctk",
    "--cache-type-k",
    "-ctv",
    "--cache-type-v",
    "-dt",
    "--defrag-thold",
    "-np",
    "--parallel",
    "--rpc",
    "--numa",
    "-dev",
    "--device",
    "-ot",
    "--override-tensor",
    "-ncmoe",
    "--n-cpu-moe",
    "-ngl",
    "--gpu-layers",
    "--n-gpu-layers",
    "-sm",
    "--split-mode",
    "-ts",
    "--tensor-split",
    "-mg",
    "--main-gpu",
    "-fit",
    "--fit",
    "-fitt",
    "--fit-target",
    "-fitc",
    "--fit-ctx",
    "--override-kv",
    "--lora",
    "--lora-scaled",
    "--control-vector",
    "--control-vector-scaled",
    "--control-vector-layer-range",
    "-m",
    "--model",
    "-mu",
    "--model-url",
    "-dr",
    "--docker-repo",
    "-hf",
    "-hfr",
    "--hf-repo",
    "-hff",
    "--hf-file",
    "-hfv",
    "-hfrv",
    "--hf-repo-v",
    "-hffv",
    "--hf-file-v",
    "-hft",
    "--hf-token",
    "--log-file",
    "--log-colors",
    "-lv",
    "--verbosity",
    "--log-verbosity",
    "--spec-draft-type-k",
    "-ctkd",
    "--cache-type-k-draft",
    "--spec-draft-type-v",
    "-ctvd",
    "--cache-type-v-draft",
}
_ESTIMATE_BOOL_FLAGS = {
    "--swa-full",
    "--perf",
    "--no-perf",
    "-e",
    "--escape",
    "--no-escape",
    "-kvo",
    "--kv-offload",
    "-nkvo",
    "--no-kv-offload",
    "--repack",
    "-nr",
    "--no-repack",
    "--no-host",
    "--mlock",
    "--mmap",
    "--no-mmap",
    "-dio",
    "--direct-io",
    "-ndio",
    "--no-direct-io",
    "--list-devices",
    "-cmoe",
    "--cpu-moe",
    "--check-tensors",
    "--op-offload",
    "--no-op-offload",
    "--log-disable",
    "-v",
    "--verbose",
    "--log-verbose",
    "--offline",
    "--log-prefix",
    "--no-log-prefix",
    "--log-timestamps",
    "--no-log-timestamps",
}


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
    except Exception as exc:
        print(f"[process] output stream reader stopped: {exc}", file=sys.stderr)


def flatten_launch_args(args_list: Optional[Iterable[Any]]) -> list[str]:
    flat_args: list[str] = []
    for entry in args_list or []:
        if isinstance(entry, list):
            flat_args.extend(str(v) for v in entry)
        else:
            flat_args.append(str(entry))
    return flat_args


def _fit_params_executable(ctx: AppContext) -> Any:
    suffix = getattr(ctx.services, "binary_suffix", "") or ""
    return ctx.paths.llama_bin / f"llama-fit-params{suffix}"


def parse_memory_estimate_output(output: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in output.splitlines():
        parts = line.strip().split()
        if len(parts) != 4:
            continue
        device, model, context, compute = parts
        if not re.match(r"^[A-Za-z][A-Za-z0-9_.:-]*$", device):
            continue
        try:
            model_mib = int(model)
            context_mib = int(context)
            compute_mib = int(compute)
        except ValueError:
            continue
        total_mib = model_mib + context_mib + compute_mib
        rows.append(
            {
                "device": device,
                "kind": "ram" if device.lower() == "host" else "accelerator",
                "model_mib": model_mib,
                "context_mib": context_mib,
                "compute_mib": compute_mib,
                "total_mib": total_mib,
            }
        )
    return rows


def _short_estimate_error(output: str) -> str:
    cleaned = _ANSI_RE.sub("", output or "")
    for line in cleaned.splitlines():
        text = line.strip()
        if not text:
            continue
        if "error:" in text.lower() or "failed" in text.lower() or "invalid" in text.lower():
            return text[-220:]
    return cleaned.strip()[-220:]


def parse_buffer_types_output(output: str) -> list[str]:
    cleaned = _ANSI_RE.sub("", output or "")
    buffer_types: list[str] = []
    in_section = False
    for line in cleaned.splitlines():
        text = line.strip()
        if not text:
            if in_section and buffer_types:
                break
            continue
        if text.lower().startswith("available buffer types:"):
            in_section = True
            continue
        if not in_section:
            continue
        if re.match(r"^[A-Za-z][A-Za-z0-9_.:-]*$", text):
            buffer_types.append(text)
            continue
        if buffer_types:
            break
    return buffer_types


def parse_list_devices_output(output: str) -> list[str]:
    cleaned = _ANSI_RE.sub("", output or "")
    devices: list[str] = []
    for line in cleaned.splitlines():
        match = re.match(r"^\s*([A-Za-z][A-Za-z0-9_.:-]*)\s*:", line)
        if match:
            devices.append(match.group(1))
    return devices


def get_buffer_types(ctx: AppContext) -> dict[str, Any]:
    allowed_tools = list(ctx.services.llama_tools or [])
    tool = "llama-cli" if "llama-cli" in allowed_tools else (allowed_tools[0] if allowed_tools else "llama-cli")
    exe_name = ctx.services.get_tool_filename(tool)
    exe_path = ctx.services.find_tool_executable(tool)
    if not exe_path.exists():
        return {
            "buffers": ["CPU"],
            "default": "CPU",
            "error": f"{exe_name} not found. Install llama.cpp first.",
        }

    runtime_health = dict(ctx.services.validate_runtime_dependencies([tool]))
    missing_runtime_files = runtime_health.get("missing_runtime_files") or []
    if missing_runtime_files:
        missing = ", ".join(str(name) for name in missing_runtime_files)
        plural = "libraries" if len(missing_runtime_files) != 1 else "library"
        return {
            "buffers": ["CPU"],
            "default": "CPU",
            "error": f"Missing llama.cpp runtime {plural}: {missing}.",
        }

    env = _build_process_env(ctx)
    try:
        completed = subprocess.run(
            [str(exe_path), "-ot", "__llama_gui_probe__=__INVALID_BUFFER__", "--list-devices"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=str(ctx.paths.root),
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"buffers": ["CPU"], "default": "CPU", "error": "Buffer discovery timed out."}
    except Exception as e:
        return {"buffers": ["CPU"], "default": "CPU", "error": str(e)}

    combined_output = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
    buffers = parse_buffer_types_output(combined_output)
    detail = ""
    if not buffers:
        try:
            devices_completed = subprocess.run(
                [str(exe_path), "--list-devices"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
                cwd=str(ctx.paths.root),
                timeout=10,
                check=False,
            )
            devices_output = "\n".join(
                part for part in [devices_completed.stdout, devices_completed.stderr] if part
            )
            buffers = parse_list_devices_output(devices_output)
        except Exception as e:
            detail = str(e)

    unique_buffers = []
    for buffer_type in ["CPU", *buffers]:
        if buffer_type and buffer_type not in unique_buffers:
            unique_buffers.append(buffer_type)
    default_buffer = next((buffer_type for buffer_type in unique_buffers if buffer_type != "CPU"), "CPU")
    result: dict[str, Any] = {"buffers": unique_buffers, "default": default_buffer}
    if detail:
        result["detail"] = detail
    elif not parse_buffer_types_output(combined_output):
        result["detail"] = _short_estimate_error(combined_output)
    return result


def _memory_estimate_args(args: list[str]) -> list[str]:
    filtered_args: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        name = arg.split("=", 1)[0]
        if name in ("-fitp", "--fit-print"):
            if "=" not in arg and i + 1 < len(args) and not args[i + 1].startswith("-"):
                i += 2
                continue
            i += 1
            continue
        if name == "-np" or name == "--parallel":
            raw_value = arg.split("=", 1)[1] if "=" in arg else (args[i + 1] if i + 1 < len(args) else "")
            try:
                parallel = int(raw_value)
            except ValueError:
                parallel = 0
            if 1 <= parallel <= 256:
                filtered_args.append(arg)
                if "=" not in arg and i + 1 < len(args):
                    filtered_args.append(args[i + 1])
                    i += 2
                    continue
            i += 1 if "=" in arg else 2
            continue
        if name in _ESTIMATE_VALUE_FLAGS:
            filtered_args.append(arg)
            if "=" not in arg and i + 1 < len(args):
                filtered_args.append(args[i + 1])
                i += 2
                continue
            i += 1
            continue
        if name in _ESTIMATE_BOOL_FLAGS:
            filtered_args.append(arg)
            i += 1
            continue
        if "=" in arg or i + 1 >= len(args) or args[i + 1].startswith("-"):
            i += 1
        else:
            i += 2
    return filtered_args


def estimate_memory(ctx: AppContext, tool: str, args_list: Optional[Iterable[Any]]) -> dict[str, Any]:
    allowed_tools = ctx.services.llama_tools or []
    if tool not in allowed_tools:
        return {"error": f"Unknown tool: {tool!r}"}

    exe_path = _fit_params_executable(ctx)
    if not exe_path.exists():
        return {"error": "llama-fit-params not found. Install or repair llama.cpp first."}

    runtime_health = dict(ctx.services.validate_runtime_dependencies([tool]))
    missing_runtime_files = runtime_health.get("missing_runtime_files") or []
    if missing_runtime_files:
        missing = ", ".join(str(name) for name in missing_runtime_files)
        plural = "libraries" if len(missing_runtime_files) != 1 else "library"
        return {"error": f"Missing llama.cpp runtime {plural}: {missing}."}

    args = flatten_launch_args(args_list)
    filtered_args = _memory_estimate_args(args)

    command = [str(exe_path), *filtered_args, "-fitp", "on"]
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_build_process_env(ctx),
            cwd=str(ctx.paths.root),
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"error": "Memory estimate timed out."}
    except Exception as e:
        return {"error": str(e)}

    combined_output = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
    rows = parse_memory_estimate_output(combined_output)
    if not rows:
        detail = _short_estimate_error(combined_output)
        if completed.returncode != 0:
            message = "Memory estimate failed."
            if detail:
                message = f"{message} {detail}"
            return {"error": message, "detail": detail}
        message = "Memory estimate output was not recognized."
        if detail:
            message = f"{message} {detail}"
        return {"error": message, "detail": detail}

    accelerator_mib = sum(row["total_mib"] for row in rows if row["kind"] == "accelerator")
    ram_mib = sum(row["total_mib"] for row in rows if row["kind"] == "ram")
    return {
        "rows": rows,
        "accelerator_mib": accelerator_mib,
        "ram_mib": ram_mib,
    }


def parse_launch_api_target(ctx: AppContext, args_list: Optional[Iterable[Any]]) -> dict[str, Any]:
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
        elif item.startswith("--host="):
            host = item.split("=", 1)[1]
            i += 1
            continue
        elif item == "--port" and i + 1 < len(flat_args):
            port = flat_args[i + 1]
            i += 2
            continue
        elif item.startswith("--port="):
            port = item.split("=", 1)[1]
            i += 1
            continue
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


def launch_process(ctx: AppContext, tool: str, args_list: Optional[Iterable[Any]]) -> dict[str, Any]:
    with ctx.state.process_lock:
        if ctx.state.process and ctx.state.process.poll() is None:
            return {"error": "A process is already running"}

        exe_name = ctx.services.get_tool_filename(tool)
        exe_path = ctx.services.find_tool_executable(tool)
        if not exe_path.exists():
            return {"error": f"{exe_name} not found. Install llama.cpp first."}

        runtime_health = dict(ctx.services.validate_runtime_dependencies([tool]))
        missing_runtime_files = runtime_health.get("missing_runtime_files") or []
        if missing_runtime_files:
            missing = ", ".join(str(name) for name in missing_runtime_files)
            plural = "libraries" if len(missing_runtime_files) != 1 else "library"
            return {
                "error": (
                    f"Missing llama.cpp runtime {plural}: {missing}. "
                    "Use Repair Install to reinstall binaries."
                )
            }

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
            except Exception as exc:
                print(f"[process] failed to send input: {exc}", file=sys.stderr)
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
