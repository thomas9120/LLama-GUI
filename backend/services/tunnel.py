"""Cloudflare tunnel management."""

import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
from pathlib import Path
from typing import Optional

from .. import config
from ..context import AppContext
from ..http import build_http_origin
from ..services.llama_manager import download_file


def get_cloudflared_asset(platform: str, arch: str) -> Optional[dict]:
    if platform == "win32":
        return {
            "url": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
            "archive": False,
            "filename": "cloudflared.exe",
        }
    if platform == "darwin":
        a = "arm64" if arch == "arm64" else "amd64"
        return {
            "url": f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-{a}.tgz",
            "archive": True,
            "filename": "cloudflared",
        }
    if platform.startswith("linux"):
        a = "arm64" if arch == "arm64" else "amd64"
        return {
            "url": f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{a}",
            "archive": False,
            "filename": f"cloudflared-linux-{a}",
        }
    return None


def _remote_tunnel_updates(status=None, url=None, message=None, log=None) -> dict:
    updates = {}
    if status is not None:
        updates["status"] = status
    if url is not None:
        updates["url"] = url
    if message is not None:
        updates["message"] = message
    if log is not None:
        updates["log"] = log[-config.TUNNEL_LOG_LIMIT:]
    return updates


def set_remote_tunnel_state(ctx: AppContext, status=None, url=None, message=None, log=None) -> dict:
    updates = _remote_tunnel_updates(status, url, message, log)
    with ctx.state.remote_tunnel_lock:
        return ctx.state.remote_tunnel.update(**updates)


def _set_remote_tunnel_state_for_generation(
    ctx: AppContext,
    generation: int,
    status=None,
    url=None,
    message=None,
    log=None,
) -> bool:
    updates = _remote_tunnel_updates(status, url, message, log)
    with ctx.state.remote_tunnel_lock:
        if ctx.state.remote_tunnel_generation != generation:
            return False
        ctx.state.remote_tunnel.update(**updates)
        return True


def get_remote_tunnel_snapshot(ctx: AppContext) -> dict:
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        snapshot = ctx.state.remote_tunnel.snapshot()
        running = proc is not None and proc.poll() is None
        if proc is not None and not running and snapshot["status"] in {
            "preparing",
            "downloading",
            "starting",
            "running",
        }:
            ctx.state.remote_tunnel_process = None
            snapshot["status"] = "error"
            snapshot["message"] = "Remote tunnel process exited."
            ctx.state.remote_tunnel.replace(snapshot)
        snapshot["running"] = running
        return snapshot


def ensure_cloudflared(ctx: AppContext, generation: Optional[int] = None) -> Path:
    platform = ctx.services.current_platform
    arch = ctx.services.current_arch
    spec = get_cloudflared_asset(platform, arch)
    if not spec:
        raise RuntimeError(f"Cloudflare tunnel is not supported on {platform}/{arch}.")

    cloudflared_dir = ctx.paths.cloudflared
    cloudflared_dir.mkdir(parents=True, exist_ok=True)
    binary_path = cloudflared_dir / spec["filename"]
    if binary_path.exists():
        if platform != "win32":
            os.chmod(binary_path, 0o755)
        return binary_path

    if generation is None:
        set_remote_tunnel_state(
            ctx,
            status="downloading",
            message="Downloading Cloudflare tunnel helper...",
        )
    elif not _set_remote_tunnel_state_for_generation(
        ctx,
        generation,
        status="downloading",
        message="Downloading Cloudflare tunnel helper...",
    ):
        raise RuntimeError("Remote tunnel start was cancelled.")
    staging_dir = Path(tempfile.mkdtemp(prefix=".cloudflared-", dir=cloudflared_dir))
    try:
        staged_binary = staging_dir / spec["filename"]
        if spec["archive"]:
            archive_path = staging_dir / Path(spec["url"]).name
            download_file(ctx, spec["url"], archive_path)
            with tarfile.open(archive_path, "r:gz") as tf:
                member = next(
                    (
                        m
                        for m in tf.getmembers()
                        if Path(m.name).name == spec["filename"] and m.isfile()
                    ),
                    None,
                )
                if member is None:
                    raise RuntimeError("Downloaded cloudflared archive did not contain the expected binary.")
                src = tf.extractfile(member)
                if src is None:
                    raise RuntimeError("Could not extract cloudflared from archive.")
                with src, open(staged_binary, "wb") as out:
                    shutil.copyfileobj(src, out)
        else:
            download_file(ctx, spec["url"], staged_binary)

        if not staged_binary.is_file() or staged_binary.stat().st_size == 0:
            raise RuntimeError("Downloaded cloudflared helper was empty.")
        if platform != "win32":
            os.chmod(staged_binary, 0o755)
        staged_binary.replace(binary_path)
        return binary_path
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


def _terminate_remote_tunnel_process(ctx: AppContext, proc) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        if ctx.services.current_platform == "win32":
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
        proc.wait(timeout=5)
    except Exception as exc:
        print(f"[tunnel] graceful stop failed, killing process: {exc}", file=sys.stderr)
        try:
            proc.kill()
        except Exception as kill_exc:
            print(f"[tunnel] failed to kill process: {kill_exc}", file=sys.stderr)


def _start_remote_tunnel_worker(ctx: AppContext, generation: int) -> None:
    log = ""
    proc = None
    try:
        if not _set_remote_tunnel_state_for_generation(
            ctx,
            generation,
            status="preparing",
            url="",
            message="Preparing Cloudflare tunnel...",
            log="",
        ):
            return
        binary_path = ensure_cloudflared(ctx, generation)
        if not _set_remote_tunnel_state_for_generation(
            ctx,
            generation,
            status="starting",
            message="Starting Cloudflare tunnel...",
        ):
            return

        env = os.environ.copy()
        if ctx.services.current_platform.startswith("linux"):
            env.pop("LD_LIBRARY_PATH", None)

        tunnel_host = ctx.config.gui_host
        if tunnel_host in {"0.0.0.0", "::", "*"}:
            tunnel_host = config.DEFAULT_GUI_HOST

        args = [
            str(binary_path),
            "tunnel",
            "--url",
            build_http_origin(tunnel_host, ctx.config.gui_port),
        ]
        proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(ctx.paths.cloudflared),
            env=env,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
            if sys.platform == "win32"
            else 0,
        )
        with ctx.state.remote_tunnel_lock:
            superseded = ctx.state.remote_tunnel_generation != generation
            if not superseded:
                ctx.state.remote_tunnel_process = proc
        if superseded:
            _terminate_remote_tunnel_process(ctx, proc)
            return

        pattern = re.compile(r"https://[\w.-]+\.trycloudflare\.com")
        while True:
            line = proc.stderr.readline() if proc.stderr else ""
            if not line:
                break
            log = (log + line)[-config.TUNNEL_LOG_LIMIT:]
            found = pattern.search(line)
            if found:
                _set_remote_tunnel_state_for_generation(
                    ctx,
                    generation,
                    status="running",
                    url=found.group(0),
                    message="Remote tunnel is running.",
                    log=log,
                )
            else:
                _set_remote_tunnel_state_for_generation(ctx, generation, log=log)

        exit_code = proc.wait()
        with ctx.state.remote_tunnel_lock:
            if (
                ctx.state.remote_tunnel_generation != generation
                or ctx.state.remote_tunnel_process is not proc
            ):
                return
            ctx.state.remote_tunnel_process = None
            ctx.state.remote_tunnel.update(
                status="error",
                url="",
                message=f"Cloudflare tunnel exited with code {exit_code}.",
                log=log,
            )
    except Exception as exc:
        with ctx.state.remote_tunnel_lock:
            if ctx.state.remote_tunnel_generation != generation:
                return
            if ctx.state.remote_tunnel_process is proc:
                ctx.state.remote_tunnel_process = None
            ctx.state.remote_tunnel.update(
                status="error", url="", message=str(exc), log=log
            )
        _terminate_remote_tunnel_process(ctx, proc)


def start_remote_tunnel(ctx: AppContext) -> dict:
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        snapshot = ctx.state.remote_tunnel.snapshot()
        if proc is not None and proc.poll() is None:
            snapshot["running"] = True
            return snapshot
        if snapshot["status"] in {"preparing", "downloading", "starting"}:
            snapshot["running"] = False
            return snapshot
        ctx.state.remote_tunnel_generation += 1
        generation = ctx.state.remote_tunnel_generation
        ctx.state.remote_tunnel.update(
            status="preparing",
            url="",
            message="Preparing Cloudflare tunnel...",
            log="",
        )
    threading.Thread(
        target=_start_remote_tunnel_worker,
        args=(ctx, generation),
        daemon=True,
    ).start()
    return get_remote_tunnel_snapshot(ctx)


def stop_remote_tunnel(ctx: AppContext) -> dict:
    with ctx.state.remote_tunnel_lock:
        ctx.state.remote_tunnel_generation += 1
        proc = ctx.state.remote_tunnel_process
        ctx.state.remote_tunnel_process = None
        ctx.state.remote_tunnel.update(
            status="stopped",
            url="",
            message="Remote tunnel stopped.",
        )

    _terminate_remote_tunnel_process(ctx, proc)
    return get_remote_tunnel_snapshot(ctx)
