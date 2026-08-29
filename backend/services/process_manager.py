"""llama.cpp process management helpers."""

import hashlib
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from .. import config
from ..context import AppContext
from ..http import open_pinned_local_request
from .subprocess_utils import get_no_window_creationflags


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
_SENSITIVE_VALUE_FLAGS = {"--api-key"}
_LAUNCH_CONTEXT_KEYS = {"source", "slot", "preset", "preset_fingerprint"}
_MODEL_VALUE_FLAGS = ("-m", "--model", "-hf", "--hf-repo", "-mu", "--model-url")
_LOCAL_MODEL_VALUE_FLAGS = ("-m", "--model")
_REMOTE_MODEL_VALUE_FLAGS = ("-hf", "--hf-repo", "-mu", "--model-url")
_ALIAS_VALUE_FLAGS = ("-a", "--alias")
_FINGERPRINT_RE = re.compile(r"[0-9a-f]{64}\Z")
_SENSITIVE_CUSTOM_ARG_RE = re.compile(r"(?<![A-Za-z0-9_-])--api-key(?=$|[=\s])")
_HEALTH_TIMEOUT_SECONDS = 2
# How long to wait on a stdin write before giving up on it (see send_input).
SEND_INPUT_TIMEOUT_SECONDS = 5.0
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


def _clear_active_process_state(ctx: AppContext) -> None:
    ctx.state.active_process_tool = None
    ctx.state.active_llama_api_keys = ()
    ctx.state.active_runtime = None


def _reap_finished_process(ctx: AppContext) -> None:
    """Clear state left behind by a process that exited on its own.

    Caller must hold ctx.state.process_lock.
    """
    process = ctx.state.process
    if process is None:
        _clear_active_process_state(ctx)
    elif process.poll() is not None:
        ctx.state.last_exit_code = process.poll()
        ctx.state.process = None
        _clear_active_process_state(ctx)


def is_process_running(ctx: AppContext) -> bool:
    with ctx.state.process_lock:
        _reap_finished_process(ctx)
        return ctx.state.process is not None


def claim_install_slot(ctx: AppContext) -> Optional[tuple[str, int]]:
    """Atomically reserve exclusive use of the llama.cpp install directories.

    Lives here rather than in a route module because launch_process() is the
    other side of the same interlock. Every operation that writes or deletes
    under llama/bin must hold this slot — an install extracting into a tree that
    a concurrent cleanup is deleting corrupts both.

    Returns ``None`` on success, or an ``(message, status)`` pair to hand
    straight to ``response.error``.
    """
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            return "Installation already in progress", 409
        if is_process_running(ctx):
            return "Stop running process first", 400
        ctx.state.install_in_progress = True
    return None


def release_install_slot(ctx: AppContext) -> None:
    with ctx.state.install_lock:
        ctx.state.install_in_progress = False


def get_active_runtime_snapshot(ctx: AppContext) -> Optional[dict[str, Any]]:
    return get_process_status_snapshot(ctx)["active_runtime"]


def get_process_status_snapshot(ctx: AppContext) -> dict[str, Any]:
    with ctx.state.process_lock:
        _reap_finished_process(ctx)
        active_runtime = (
            dict(ctx.state.active_runtime) if ctx.state.active_runtime is not None else None
        )
        return {
            "running": ctx.state.process is not None,
            "active_process_tool": ctx.state.active_process_tool,
            "active_runtime": active_runtime,
            "runtime_generation": ctx.state.runtime_generation,
            "api_auth_configured": bool(
                ctx.state.process is not None
                and ctx.state.active_process_tool == "llama-server"
                and ctx.state.active_llama_api_keys
            ),
            "last_exit_code": ctx.state.last_exit_code,
        }


def _parse_expected_generation(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("expected_generation must be a positive integer")
    try:
        generation = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("expected_generation must be a positive integer") from exc
    if generation < 1 or str(value).strip() != str(generation):
        raise ValueError("expected_generation must be a positive integer")
    return generation


def _health_result(
    state: str,
    generation: Optional[int],
    expected_generation: Optional[int],
    message: str,
) -> dict[str, Any]:
    return {
        "state": state,
        "ready": state == "ready",
        "generation": generation,
        "expected_generation": expected_generation,
        "message": message,
    }


def _superseded_health_result(
    snapshot: Mapping[str, Any], expected_generation: Optional[int]
) -> dict[str, Any]:
    runtime = snapshot.get("active_runtime")
    generation = (
        runtime.get("generation")
        if isinstance(runtime, Mapping)
        else snapshot.get("runtime_generation")
    )
    return _health_result(
        "superseded",
        generation,
        expected_generation,
        "The observed runtime generation has been superseded.",
    )


def get_llama_health(ctx: AppContext, expected_generation: Any = None) -> dict[str, Any]:
    try:
        expected = _parse_expected_generation(expected_generation)
    except ValueError as exc:
        return _health_result("error", None, None, str(exc))

    initial = get_process_status_snapshot(ctx)
    runtime = initial.get("active_runtime")
    if not initial.get("running") or not isinstance(runtime, Mapping):
        return _health_result(
            "stopped",
            initial.get("runtime_generation"),
            expected,
            "No llama-server process is running.",
        )

    generation = runtime.get("generation")
    if expected is not None and generation != expected:
        return _superseded_health_result(initial, expected)
    if runtime.get("tool") != "llama-server":
        return _health_result(
            "error",
            generation,
            expected,
            "The active process is not llama-server.",
        )

    host = str(runtime.get("host") or "").strip()
    try:
        port = int(runtime.get("port"))
    except (TypeError, ValueError):
        port = 0
    if not host or port < 1 or port > 65535:
        return _health_result(
            "error",
            generation,
            expected,
            "The active llama-server target is invalid.",
        )

    response = None
    try:
        try:
            response = open_pinned_local_request(
                host,
                port,
                "/health",
                headers={"Accept": "application/json"},
                timeout=_HEALTH_TIMEOUT_SECONDS,
            )
            status = getattr(response, "status", None)
            if status is None:
                status = response.getcode()
        except ValueError as exc:
            return _health_result("error", generation, expected, str(exc))
        if status == 200:
            observed = _health_result(
                "ready", generation, expected, "llama-server is ready."
            )
        elif status == 503:
            observed = _health_result(
                "loading", generation, expected, "llama-server is loading the model."
            )
        else:
            observed = _health_result(
                "error",
                generation,
                expected,
                f"llama-server health returned HTTP {status}.",
            )
    except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, OSError):
        observed = _health_result(
            "starting", generation, expected, "llama-server is starting."
        )
    except Exception as exc:
        print(f"[process] llama-server health probe failed: {exc}", file=sys.stderr)
        observed = _health_result(
            "error", generation, expected, "The llama-server health check failed."
        )
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
    current = get_process_status_snapshot(ctx)
    current_runtime = current.get("active_runtime")
    if isinstance(current_runtime, Mapping):
        if current_runtime.get("generation") != generation:
            return _superseded_health_result(current, expected)
    elif current.get("runtime_generation") != generation:
        return _superseded_health_result(current, expected)
    else:
        state = "failed" if current.get("last_exit_code") not in (None, 0) else "stopped"
        message = (
            "llama-server exited before becoming ready."
            if state == "failed"
            else "llama-server stopped before the health check completed."
        )
        return _health_result(state, generation, expected, message)
    return observed


def get_output_snapshot(ctx: AppContext, since: Optional[int] = None) -> dict[str, Any]:
    with ctx.state.output_buffer_lock:
        start_cursor = ctx.state.output_buffer_start
        next_cursor = ctx.state.output_buffer_next
        if since is None:
            offset = 0
            dropped = False
        else:
            dropped = since < start_cursor
            cursor = max(start_cursor, min(since, next_cursor))
            offset = cursor - start_cursor
        lines = list(ctx.state.output_buffer[offset:])
        readers_active = ctx.state.output_reader_count > 0
    process_status = get_process_status_snapshot(ctx)
    snapshot = {
        "lines": lines,
        "next_cursor": next_cursor,
        "dropped": dropped,
        "running": bool(process_status["running"] or readers_active),
        "runtime_generation": process_status["runtime_generation"],
        "active_process_tool": process_status["active_process_tool"],
    }
    if since is None:
        # Deprecated alias for consumers that poll without a cursor and still
        # read the pre-cursor "output" key.
        snapshot["output"] = lines
    return snapshot


def stream_output(
    ctx: AppContext,
    pipe: Any,
    is_stderr: bool = False,
    generation: Optional[int] = None,
) -> None:
    try:
        for line in iter(pipe.readline, ""):
            if line:
                decoded = line.rstrip("\n\r")
                with ctx.state.output_buffer_lock:
                    if generation is not None and generation != ctx.state.output_generation:
                        continue
                    ctx.state.output_buffer.append(decoded)
                    ctx.state.output_buffer_next += 1
                    if len(ctx.state.output_buffer) > config.PROCESS_OUTPUT_LIMIT:
                        trim_count = min(config.PROCESS_OUTPUT_TRIM, len(ctx.state.output_buffer))
                        del ctx.state.output_buffer[:trim_count]
                        ctx.state.output_buffer_start += trim_count
    except Exception as exc:
        print(f"[process] output stream reader stopped: {exc}", file=sys.stderr)
    finally:
        if generation is not None:
            with ctx.state.output_buffer_lock:
                if generation == ctx.state.output_generation:
                    ctx.state.output_reader_count = max(0, ctx.state.output_reader_count - 1)


def flatten_launch_args(args_list: Optional[Iterable[Any]]) -> list[str]:
    flat_args: list[str] = []
    for entry in args_list or []:
        if isinstance(entry, list):
            flat_args.extend(str(v) for v in entry)
        else:
            flat_args.append(str(entry))
    return flat_args


def _load_config_safe(ctx: AppContext) -> dict[str, Any]:
    try:
        return dict(ctx.services.load_config())
    except Exception as e:
        print(f"[process] load_config failed: {e}", file=sys.stderr)
        return {}


def _fit_params_executable(ctx: AppContext) -> Any:
    suffix = getattr(ctx.services, "binary_suffix", "") or ""
    cfg = _load_config_safe(ctx)
    bin_dir = ctx.paths.llama_custom_bin if cfg.get("backend") == "custom" else ctx.paths.llama_bin
    return bin_dir / f"llama-fit-params{suffix}"


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
            creationflags=get_no_window_creationflags(),
        )
    except subprocess.TimeoutExpired:
        return {"buffers": ["CPU"], "default": "CPU", "error": "Buffer discovery timed out."}
    except Exception as e:
        print(f"[process] buffer discovery failed: {e}", file=sys.stderr)
        return {"buffers": ["CPU"], "default": "CPU", "error": "Buffer discovery failed."}

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
                creationflags=get_no_window_creationflags(),
            )
            devices_output = "\n".join(
                part for part in [devices_completed.stdout, devices_completed.stderr] if part
            )
            buffers = parse_list_devices_output(devices_output)
        except Exception as e:
            print(f"[process] device discovery fallback failed: {e}", file=sys.stderr)
            detail = "Device discovery failed."

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


def _is_int_token(token: str) -> bool:
    try:
        int(token)
    except (TypeError, ValueError):
        return False
    return True


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
            if "=" in arg:
                raw_value = arg.split("=", 1)[1]
                consumed = 1
            else:
                # Only treat the next token as this flag's value if it actually
                # parses as one. Consuming it unconditionally meant a valueless
                # "-np" swallowed the *following flag* ("-np --verbose" dropped
                # both). Checked with int() rather than a leading-dash test so a
                # negative value like "-np -1" is still recognised as the value.
                candidate = args[i + 1] if i + 1 < len(args) else ""
                raw_value = candidate if _is_int_token(candidate) else ""
                consumed = 2 if raw_value else 1
            try:
                parallel = int(raw_value)
            except ValueError:
                parallel = 0
            if 1 <= parallel <= 256:
                filtered_args.extend(args[i:i + consumed])
            i += consumed
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
            creationflags=get_no_window_creationflags(),
        )
    except subprocess.TimeoutExpired:
        return {"error": "Memory estimate timed out."}
    except Exception as e:
        print(f"[process] memory estimate failed: {e}", file=sys.stderr)
        return {"error": "Memory estimate failed."}

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


def _normalize_context_text(value: Any, field: str, max_length: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"launch_context.{field} must be a string")
    normalized = value.strip()
    if not normalized or len(normalized) > max_length:
        raise ValueError(f"launch_context.{field} is invalid")
    if any(unicodedata.category(char).startswith("C") for char in normalized):
        raise ValueError(f"launch_context.{field} is invalid")
    return normalized


def normalize_launch_context(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError("launch_context must be an object")
    if set(value) != _LAUNCH_CONTEXT_KEYS:
        raise ValueError("launch_context fields are invalid")

    source = _normalize_context_text(value.get("source"), "source", 32)
    if source != "model-switcher":
        raise ValueError("launch_context.source is invalid")
    slot = _normalize_context_text(value.get("slot"), "slot", 1)
    if slot not in {"a", "b"}:
        raise ValueError("launch_context.slot is invalid")
    preset = _normalize_context_text(value.get("preset"), "preset", 128)
    fingerprint = _normalize_context_text(
        value.get("preset_fingerprint"), "preset_fingerprint", 128
    )
    if not _FINGERPRINT_RE.fullmatch(fingerprint):
        raise ValueError("launch_context.preset_fingerprint is invalid")
    return {
        "source": source,
        "slot": slot,
        "preset": preset,
        "preset_fingerprint": fingerprint,
    }


def _last_launch_flag_entry(
    flat_args: list[str], flags: tuple[str, ...]
) -> tuple[Optional[str], Optional[str]]:
    result: tuple[Optional[str], Optional[str]] = (None, None)
    index = 0
    while index < len(flat_args):
        item = flat_args[index]
        if item in flags and index + 1 < len(flat_args):
            result = (item, flat_args[index + 1])
            index += 2
            continue
        matched = next((flag for flag in flags if item.startswith(f"{flag}=")), None)
        if matched is not None:
            result = (matched, item.split("=", 1)[1])
        index += 1
    return result


def _last_launch_flag_value(flat_args: list[str], flags: tuple[str, ...]) -> Optional[str]:
    return _last_launch_flag_entry(flat_args, flags)[1]


def _safe_runtime_text(value: Any, max_length: int) -> Optional[str]:
    if value is None:
        return None
    text = "".join(
        char
        for char in str(value).strip()
        if not unicodedata.category(char).startswith("C")
    )
    return text[:max_length] or None


def _safe_runtime_model_identity(flat_args: list[str]) -> Optional[str]:
    model_flag, model_value = _last_launch_flag_entry(flat_args, _MODEL_VALUE_FLAGS)
    if model_flag in ("-mu", "--model-url"):
        # Model URLs commonly contain signed query strings or userinfo. Runtime
        # status is public management metadata, so expose only a non-secret label.
        return "Remote model URL"
    return _safe_runtime_text(model_value, 1024)


def _build_active_runtime(
    ctx: AppContext,
    tool: str,
    flat_args: list[str],
    launch_context: Mapping[str, str],
    api_target: Optional[Mapping[str, Any]],
) -> dict[str, Any]:
    model = _safe_runtime_model_identity(flat_args)
    raw_alias = _last_launch_flag_value(flat_args, _ALIAS_VALUE_FLAGS)
    aliases = parse_csv_row(raw_alias) if raw_alias is not None else []
    alias = next((_safe_runtime_text(item, 128) for item in aliases if str(item).strip()), None)
    runtime = {
        "generation": ctx.state.runtime_generation + 1,
        "tool": tool,
        "model": model,
        "alias": alias,
        "host": None,
        "port": None,
        "source": launch_context.get("source", "manual"),
        "slot": launch_context.get("slot"),
        "preset": launch_context.get("preset"),
        "preset_fingerprint": launch_context.get("preset_fingerprint"),
    }
    if api_target is not None:
        runtime["host"] = _safe_runtime_text(api_target.get("host"), 255)
        runtime["port"] = int(api_target.get("port"))
    return runtime


def parse_csv_row(value: Any) -> list[str]:
    """Match llama.cpp's CSV parsing for --api-key values."""
    text = str(value)
    fields = []
    current = []
    in_quotes = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_quotes:
            if char == '"':
                if index + 1 < len(text) and text[index + 1] == '"':
                    current.append('"')
                    index += 1
                else:
                    in_quotes = False
            else:
                current.append(char)
        elif char == '"' and not current:
            in_quotes = True
        elif char == ",":
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
        index += 1
    fields.append("".join(current))
    return fields


def parse_launch_api_keys(args_list: Optional[Iterable[Any]]) -> tuple[str, ...]:
    """Return the keys from the last --api-key occurrence, as llama.cpp sees them."""
    flat_args = flatten_launch_args(args_list)
    parsed_keys: tuple[str, ...] = ()
    index = 0
    while index < len(flat_args):
        item = flat_args[index]
        if item == "--api-key" and index + 1 < len(flat_args):
            parsed_keys = tuple(parse_csv_row(flat_args[index + 1]))
            index += 2
            continue
        if item.startswith("--api-key="):
            parsed_keys = tuple(parse_csv_row(item.split("=", 1)[1]))
        index += 1
    return parsed_keys


def get_active_llama_authorization(ctx: AppContext, fallback: str = "") -> str:
    """Use the running server's launch-time key; fall back only without one."""
    with ctx.state.process_lock:
        _reap_finished_process(ctx)
        if ctx.state.process is not None and ctx.state.active_process_tool == "llama-server":
            keys = ctx.state.active_llama_api_keys
            if not keys:
                return ""
            selected_key = next((key for key in keys if key != ""), keys[0])
            return f"Bearer {selected_key}"
    return str(fallback or "")


def is_active_llama_api_auth_configured(ctx: AppContext) -> bool:
    with ctx.state.process_lock:
        _reap_finished_process(ctx)
        return bool(
            ctx.state.process is not None
            and ctx.state.active_process_tool == "llama-server"
            and ctx.state.active_llama_api_keys
        )


def _build_process_env(ctx: AppContext) -> dict[str, str]:
    env = os.environ.copy()
    cfg = _load_config_safe(ctx)
    bin_dir = ctx.paths.llama_custom_bin if cfg.get("backend") == "custom" else ctx.paths.llama_bin
    runtime_paths = [str(bin_dir)]
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


def redact_sensitive_args(args: Iterable[Any]) -> list[str]:
    redacted = []
    redact_next = False
    for raw_arg in args or []:
        arg = str(raw_arg)
        if redact_next:
            redacted.append("<redacted>")
            redact_next = False
            continue
        matched_flag = next(
            (flag for flag in _SENSITIVE_VALUE_FLAGS if arg.startswith(f"{flag}=")),
            None,
        )
        if matched_flag:
            redacted.append(f"{matched_flag}=<redacted>")
            continue
        redacted.append(arg)
        if arg in _SENSITIVE_VALUE_FLAGS:
            redact_next = True
    return redacted


def redact_sensitive_text(text: Any, args: Iterable[Any]) -> str:
    result = str(text)
    flat_args = [str(arg) for arg in (args or [])]
    for index, arg in enumerate(flat_args):
        if arg in _SENSITIVE_VALUE_FLAGS and index + 1 < len(flat_args):
            secret = flat_args[index + 1]
            if secret:
                result = result.replace(secret, "<redacted>")
            continue
        for flag in _SENSITIVE_VALUE_FLAGS:
            prefix = f"{flag}="
            if arg.startswith(prefix):
                secret = arg[len(prefix):]
                if secret:
                    result = result.replace(secret, "<redacted>")
    return result


def _validate_launch_environment(
    ctx: AppContext, tool: str
) -> tuple[Optional[Path], Optional[str]]:
    exe_name = ctx.services.get_tool_filename(tool)
    exe_path = ctx.services.find_tool_executable(tool)
    if not exe_path.is_file():
        return None, f"{exe_name} not found. Install llama.cpp first."

    current_platform = ctx.services.current_platform
    if current_platform == "unknown":
        current_platform = sys.platform
    if current_platform != "win32" and not os.access(exe_path, os.X_OK):
        cfg = _load_config_safe(ctx)
        recovery = (
            f"Run chmod +x on llama/custom/bin/{exe_name}."
            if cfg.get("backend") == "custom"
            else "Use Repair Install to restore executable permissions."
        )
        return None, f"{exe_name} is not executable. {recovery}"

    runtime_health = dict(ctx.services.validate_runtime_dependencies([tool]))
    missing_runtime_files = runtime_health.get("missing_runtime_files") or []
    if not missing_runtime_files:
        return exe_path, None

    missing = ", ".join(str(name) for name in missing_runtime_files)
    plural = "libraries" if len(missing_runtime_files) != 1 else "library"
    cfg = _load_config_safe(ctx)
    recovery = (
        "Add the missing files to llama/custom/bin/."
        if cfg.get("backend") == "custom"
        else (
            "Use Repair Install, then verify the matching Vulkan/ROCm driver runtime is installed."
            if current_platform.startswith("linux")
            else "Use Repair Install to reinstall binaries."
        )
    )
    return None, f"Missing llama.cpp runtime {plural}: {missing}. {recovery}"


def _canonical_fingerprint_json(value: Any) -> str:
    if not isinstance(value, Mapping):
        raise ValueError("fingerprint_data must be an object")

    def validate(candidate: Any) -> None:
        if isinstance(candidate, Mapping):
            for key, nested in candidate.items():
                if not isinstance(key, str):
                    raise ValueError("fingerprint_data contains an invalid key")
                if key.casefold() == "api_key":
                    raise ValueError("fingerprint_data must not contain api_key")
                validate(nested)
            return
        if isinstance(candidate, list):
            for nested in candidate:
                validate(nested)
            return
        if isinstance(candidate, str) and _SENSITIVE_CUSTOM_ARG_RE.search(candidate):
            raise ValueError("fingerprint_data must not contain --api-key")
        if candidate is None or isinstance(candidate, (str, int, float, bool)):
            return
        raise ValueError("fingerprint_data contains an unsupported value")

    validate(value)
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("fingerprint_data is not valid canonical JSON") from exc


def compute_preset_fingerprint(value: Any) -> str:
    canonical = _canonical_fingerprint_json(value)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _normalize_preflight_args(args_list: Any) -> list[str]:
    if not isinstance(args_list, list):
        raise ValueError("args must be an array")
    for entry in args_list:
        values = entry if isinstance(entry, list) else [entry]
        if any(
            isinstance(value, bool)
            or not isinstance(value, (str, int, float))
            or (isinstance(value, float) and not math.isfinite(value))
            for value in values
        ):
            raise ValueError("args contains an invalid value")
    return flatten_launch_args(args_list)


def preflight_launch(
    ctx: AppContext,
    tool: Any,
    args_list: Any,
    fingerprint_data: Any,
) -> dict[str, Any]:
    allowed_tools = tuple(ctx.services.llama_tools or ())
    if not isinstance(tool, str):
        return {"error": "tool must be a string"}
    if tool not in allowed_tools:
        return {"error": f"Unknown tool: {tool!r}"}
    if tool != "llama-server":
        return {"error": "Model switching requires llama-server."}

    try:
        flat_args = _normalize_preflight_args(args_list)
        preset_fingerprint = compute_preset_fingerprint(fingerprint_data)
    except ValueError as exc:
        return {"error": str(exc)}

    exe_path, environment_error = _validate_launch_environment(ctx, tool)
    if environment_error is not None:
        return {"error": environment_error}

    model_flag, model_value = _last_launch_flag_entry(
        flat_args, _LOCAL_MODEL_VALUE_FLAGS + _REMOTE_MODEL_VALUE_FLAGS
    )
    model_value = str(model_value or "").strip()
    if model_flag is None or not model_value:
        return {"error": "Launch args must contain a model source."}

    if model_flag in _LOCAL_MODEL_VALUE_FLAGS:
        model_path = Path(model_value)
        if not model_path.is_absolute():
            model_path = ctx.paths.root / model_path
        if not model_path.is_file():
            return {"error": "Local model file does not exist."}
        model_source = "local"
        safe_model = _safe_runtime_text(model_value, 1024)
    elif model_flag in ("-hf", "--hf-repo"):
        model_source = "hugging-face"
        safe_model = _safe_runtime_text(model_value, 1024)
    else:
        model_source = "url"
        safe_model = None

    return {
        "ok": True,
        "tool": tool,
        "model": safe_model,
        "model_source": model_source,
        "preset_fingerprint": preset_fingerprint,
        "executable": exe_path.name if exe_path is not None else None,
    }


def launch_process(
    ctx: AppContext,
    tool: str,
    args_list: Optional[Iterable[Any]],
    launch_context: Any = None,
) -> dict[str, Any]:
    try:
        normalized_launch_context = normalize_launch_context(launch_context)
    except ValueError as exc:
        return {"error": str(exc)}

    # Cheap preconditions first, so an obviously doomed launch (double-click on
    # Launch, or during an install) does not pay for the validation below.
    with ctx.state.install_lock:
        if ctx.state.install_in_progress:
            return {"error": "Installation in progress. Wait for it to finish before launching."}
    if is_process_running(ctx):
        return {"error": "A process is already running"}

    # Deliberately outside both locks. On Linux/macOS this shells out to ldd or
    # otool once per packaged ggml library and can take tens of seconds cold;
    # holding install_lock + process_lock across it stalled every other process
    # endpoint — status, stop, output — for the whole run. The authoritative
    # re-checks below close the window this opens: an install that starts
    # meanwhile is caught there, and a binary that disappears meanwhile fails at
    # Popen, which the except clause already handles.
    exe_path, environment_error = _validate_launch_environment(ctx, tool)
    if environment_error is not None:
        return {"error": environment_error}

    # Lock order is install -> process everywhere that transitions between
    # these mutually exclusive operations.
    with ctx.state.install_lock, ctx.state.process_lock:
        if ctx.state.install_in_progress:
            return {"error": "Installation in progress. Wait for it to finish before launching."}
        _reap_finished_process(ctx)
        if ctx.state.process is not None:
            return {"error": "A process is already running"}

        flat_launch_args = flatten_launch_args(args_list)
        args = [str(exe_path), *flat_launch_args]
        launch_api_keys = parse_launch_api_keys(flat_launch_args) if tool == "llama-server" else ()
        env = _build_process_env(ctx)

        process = None
        generation = None
        try:
            startupinfo = None
            creationflags = 0
            if sys.platform == "win32":
                # Hide the runtime's console window via STARTUPINFO (SW_HIDE)
                # rather than CREATE_NO_WINDOW. CREATE_NO_WINDOW severs the
                # console entirely, which would stop CTRL_BREAK_EVENT from
                # reaching a console-attached parent's child and break the
                # graceful stop path. CREATE_NEW_PROCESS_GROUP is kept for that
                # signalling; a console-less parent (pythonw/detached) relies on
                # the OSError-to-kill() fallback in _request_graceful_stop.
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = subprocess.SW_HIDE
                creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
            process = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                cwd=str(ctx.paths.root),
                creationflags=creationflags,
                startupinfo=startupinfo,
            )
            ctx.state.process = process
            with ctx.state.output_buffer_lock:
                ctx.state.output_buffer.clear()
                ctx.state.output_buffer_start = ctx.state.output_buffer_next
                ctx.state.output_generation += 1
                generation = ctx.state.output_generation
                ctx.state.output_reader_count = 2
                output_cursor = ctx.state.output_buffer_next
            threading.Thread(
                target=stream_output,
                args=(ctx, process.stdout, False, generation),
                daemon=True,
            ).start()
            threading.Thread(
                target=stream_output,
                args=(ctx, process.stderr, True, generation),
                daemon=True,
            ).start()
            api_target = None
            if tool == "llama-server":
                api_target = parse_launch_api_target(ctx, flat_launch_args)
            active_runtime = _build_active_runtime(
                ctx,
                tool,
                flat_launch_args,
                normalized_launch_context,
                api_target,
            )
            ctx.state.active_process_tool = tool
            ctx.state.active_llama_api_keys = launch_api_keys
            ctx.state.runtime_generation = active_runtime["generation"]
            ctx.state.active_runtime = active_runtime
            ctx.state.last_exit_code = None
            return {
                "pid": ctx.state.process.pid,
                "command": " ".join(redact_sensitive_args(args)),
                "output_cursor": output_cursor,
                "active_runtime": dict(active_runtime),
            }
        except Exception as e:
            if process is not None:
                # Popen succeeded but wiring up state failed; don't leave an
                # untracked process running.
                try:
                    process.kill()
                    process.wait(timeout=5)
                except Exception as cleanup_exc:
                    print(
                        f"[process] failed to clean up partially launched process: {cleanup_exc}",
                        file=sys.stderr,
                    )
            ctx.state.process = None
            _clear_active_process_state(ctx)
            if generation is not None:
                with ctx.state.output_buffer_lock:
                    ctx.state.output_reader_count = 0
            return {"error": redact_sensitive_text(e, args)}


def _request_graceful_stop(process) -> bool:
    """Ask the process to shut down gracefully.

    Returns False when the signal could not be delivered. On Windows the GUI
    often runs under pythonw.exe (or a detached restart handoff) with no
    console, so ``CTRL_BREAK_EVENT`` raises ``OSError`` ("The handle is
    invalid"); the caller must then fall back to killing the process instead of
    leaving it running.
    """
    try:
        if sys.platform == "win32":
            process.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            process.terminate()
        return True
    except Exception as exc:
        print(f"[process] graceful stop signal failed: {exc}", file=sys.stderr)
        return False


def _stop_process_locked(ctx: AppContext) -> bool:
    process = ctx.state.process
    if process is not None and process.poll() is None:
        if not _request_graceful_stop(process):
            try:
                process.kill()
            except Exception as exc:
                print(
                    f"[process] force kill after failed stop signal errored: {exc}",
                    file=sys.stderr,
                )
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if process.poll() is None:
            # Keep tracking the process so a new launch can't run
            # alongside one that refused to die.
            print(
                f"[process] PID {process.pid} survived kill; still tracking it",
                file=sys.stderr,
            )
            return False
        ctx.state.last_exit_code = process.poll()
        ctx.state.process = None
        _clear_active_process_state(ctx)
        return True
    _reap_finished_process(ctx)
    return False


def stop_process(ctx: AppContext) -> bool:
    with ctx.state.process_lock:
        return _stop_process_locked(ctx)


def stop_process_for_generation(ctx: AppContext, expected_generation: Any) -> dict[str, Any]:
    try:
        expected = _parse_expected_generation(expected_generation)
        if expected is None:
            raise ValueError("expected_generation must be a positive integer")
    except ValueError as exc:
        return {
            "stopped": False,
            "state": "error",
            "generation": None,
            "message": str(exc),
        }

    with ctx.state.process_lock:
        _reap_finished_process(ctx)
        runtime = ctx.state.active_runtime
        current_generation = (
            runtime.get("generation")
            if isinstance(runtime, Mapping)
            else ctx.state.runtime_generation
        )
        if not isinstance(runtime, Mapping) or current_generation != expected:
            return {
                "stopped": False,
                "state": "superseded",
                "generation": current_generation,
                "message": "The requested runtime generation is no longer active.",
            }
        stopped = _stop_process_locked(ctx)
        return {
            "stopped": stopped,
            "state": "stopped" if stopped else "error",
            "generation": expected,
            "message": (
                "The runtime was stopped."
                if stopped
                else "The runtime could not be stopped."
            ),
        }


def send_input(ctx: AppContext, text: str) -> bool:
    # Only the handle lookup belongs under process_lock. The write must not: a
    # child that never drains stdin (llama-server ignores it) fills the ~64 KB OS
    # pipe buffer, after which write/flush block forever — and holding the lock
    # while that happened froze launch, stop, status and reaping for the whole
    # process layer, unrecoverably.
    with ctx.state.process_lock:
        _reap_finished_process(ctx)
        process = ctx.state.process
        stdin = process.stdin if process is not None else None
    if not stdin:
        return False

    outcome: list[bool] = []

    def _write() -> None:
        try:
            stdin.write(text + "\n")
            stdin.flush()
            outcome.append(True)
        except Exception as exc:
            print(f"[process] failed to send input: {exc}", file=sys.stderr)
            outcome.append(False)

    # Dropping the lock stops one stuck pipe from taking the app down with it,
    # but the write can still block indefinitely. Bound it so the cost is a
    # single detached daemon thread rather than a wedged HTTP request thread.
    # There is no portable non-blocking pipe write to use instead on Windows.
    worker = threading.Thread(target=_write, daemon=True)
    worker.start()
    worker.join(SEND_INPUT_TIMEOUT_SECONDS)
    if worker.is_alive():
        print(
            "[process] send input timed out; the runtime is not reading stdin",
            file=sys.stderr,
        )
        return False
    return bool(outcome) and outcome[0]


def remove_llama_files(ctx: AppContext) -> int:
    removed_files = 0

    for directory in [ctx.paths.llama_bin, ctx.paths.llama_grammars]:
        if directory.exists():
            for path in directory.rglob("*"):
                if path.is_file():
                    removed_files += 1
            shutil.rmtree(directory)
        directory.mkdir(parents=True, exist_ok=True)

    llama_dll_dir = ctx.paths.llama / "dll"
    if llama_dll_dir.exists():
        for path in llama_dll_dir.rglob("*"):
            if path.is_file():
                removed_files += 1
        shutil.rmtree(llama_dll_dir)

    with ctx.state.config_lock:
        config_data = _load_config_safe(ctx)
        config_data.update({"version": None, "backend": None, "tag": None})
        config_data.pop("official_install", None)
        ctx.services.save_config(config_data)
    ctx.state.clear_runtime_health_cache()

    return removed_files
