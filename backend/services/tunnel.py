"""Cloudflare tunnel management."""

import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
from pathlib import Path
from typing import Optional

from .. import config
from ..context import AppContext
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


def set_remote_tunnel_state(ctx: AppContext, status=None, url=None, message=None, log=None) -> dict:
    updates = {}
    if status is not None:
        updates["status"] = status
    if url is not None:
        updates["url"] = url
    if message is not None:
        updates["message"] = message
    if log is not None:
        updates["log"] = log[-config.TUNNEL_LOG_LIMIT:]
    with ctx.state.remote_tunnel_lock:
        return ctx.state.remote_tunnel.update(**updates)


def get_remote_tunnel_snapshot(ctx: AppContext) -> dict:
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        snapshot = ctx.state.remote_tunnel.snapshot()
        if proc is not None and proc.poll() is not None and snapshot["status"] in {
            "preparing",
            "downloading",
            "starting",
            "running",
        }:
            snapshot["status"] = "error"
            snapshot["message"] = "Remote tunnel process exited."
            ctx.state.remote_tunnel.replace(snapshot)
        snapshot["running"] = proc is not None and proc.poll() is None
        return snapshot


def ensure_cloudflared(ctx: AppContext) -> Path:
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

    set_remote_tunnel_state(ctx, status="downloading", message="Downloading Cloudflare tunnel helper...")
    if spec["archive"]:
        archive_path = cloudflared_dir / Path(spec["url"]).name
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
            with open(binary_path, "wb") as out:
                shutil.copyfileobj(src, out)
        try:
            archive_path.unlink()
        except OSError:
            pass
    else:
        download_file(ctx, spec["url"], binary_path)

    if platform != "win32":
        os.chmod(binary_path, 0o755)
    return binary_path


def _start_remote_tunnel_worker(ctx: AppContext) -> None:
    log = ""
    try:
        set_remote_tunnel_state(
            ctx,
            status="preparing",
            url="",
            message="Preparing Cloudflare tunnel...",
            log="",
        )
        binary_path = ensure_cloudflared(ctx)
        set_remote_tunnel_state(ctx, status="starting", message="Starting Cloudflare tunnel...")

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
            f"http://{tunnel_host}:{ctx.config.gui_port}",
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
            ctx.state.remote_tunnel_process = proc

        pattern = re.compile(r"https://[\w.-]+\.trycloudflare\.com")
        while True:
            line = proc.stderr.readline() if proc.stderr else ""
            if not line:
                break
            log = (log + line)[-config.TUNNEL_LOG_LIMIT:]
            found = pattern.search(line)
            if found:
                set_remote_tunnel_state(
                    ctx,
                    status="running",
                    url=found.group(0),
                    message="Remote tunnel is running.",
                    log=log,
                )
            else:
                set_remote_tunnel_state(ctx, log=log)

        exit_code = proc.wait()
        with ctx.state.remote_tunnel_lock:
            if ctx.state.remote_tunnel_process is proc:
                ctx.state.remote_tunnel_process = None
            current_status = ctx.state.remote_tunnel.snapshot()["status"]
        if current_status != "stopped":
            set_remote_tunnel_state(
                ctx,
                status="error",
                url="",
                message=f"Cloudflare tunnel exited with code {exit_code}.",
                log=log,
            )
    except Exception as exc:
        with ctx.state.remote_tunnel_lock:
            ctx.state.remote_tunnel_process = None
        set_remote_tunnel_state(ctx, status="error", url="", message=str(exc), log=log)


def start_remote_tunnel(ctx: AppContext) -> dict:
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        snapshot = ctx.state.remote_tunnel.snapshot()
        if proc is not None and proc.poll() is None:
            return get_remote_tunnel_snapshot(ctx)
        if snapshot["status"] in {"preparing", "downloading", "starting"}:
            return get_remote_tunnel_snapshot(ctx)
        ctx.state.remote_tunnel.update(
            status="preparing",
            url="",
            message="Preparing Cloudflare tunnel...",
            log="",
        )
    threading.Thread(target=_start_remote_tunnel_worker, args=(ctx,), daemon=True).start()
    return get_remote_tunnel_snapshot(ctx)


def stop_remote_tunnel(ctx: AppContext) -> dict:
    with ctx.state.remote_tunnel_lock:
        proc = ctx.state.remote_tunnel_process
        ctx.state.remote_tunnel_process = None
        ctx.state.remote_tunnel.update(
            status="stopped",
            url="",
            message="Remote tunnel stopped.",
        )

    if proc is not None and proc.poll() is None:
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
    return get_remote_tunnel_snapshot(ctx)
