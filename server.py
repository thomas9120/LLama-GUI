import http.server
import json
import os
import platform
import socket
import ssl
import subprocess
import sys
import signal
import threading
import zipfile
import tarfile
import hashlib
import shutil
import urllib.request
import urllib.parse
import urllib.error
import re
import time
import pathlib
import tempfile
import ipaddress

from backend.config import (
    APP_LOGO_FILE,
    APP_REPO_URL,
    CLOUDFLARED_DIR,
    CONFIG_FILE,
    GITHUB_API,
    GUI_HOST,
    GUI_PORT,
    LLAMA_BIN_DIR,
    LLAMA_DIR,
    LLAMA_GRAMMARS_DIR,
    LLAMA_HOST,
    LLAMA_PORT,
    MODELS_DIR,
    PRESETS_DIR,
    PROCESS_OUTPUT_LIMIT,
    PROCESS_OUTPUT_TRIM,
    RESTART_PORT_WAIT_ATTEMPTS,
    RESTART_PORT_WAIT_SECONDS,
    RESTART_STARTUP_DELAY_SECONDS,
    ROOT_DIR as BASE_DIR,
    TOOLS_DIR,
    TUNNEL_LOG_LIMIT,
    UI_DIR,
    WEB_SEARCH_FETCH_BYTES,
    WEB_SEARCH_MAX_RESULTS,
    WEB_SEARCH_PAGE_CHARS,
    WEB_SEARCH_TIMEOUT,
)
from backend.context import DEFAULT_CONTEXT
from backend.http import (
    Request,
    Response,
    SseWriter,
    get_access_control_origin,
    get_allowed_request_origins,
    get_cors_methods,
    is_safe_request_origin,
    is_static_ui_path,
    is_v1_proxy_path,
)
from backend.routing import Router
from backend.routes import chat as chat_routes
from backend.routes import file_picker as file_picker_routes
from backend.routes import hf_download as hf_download_routes
from backend.routes import metrics as metrics_routes
from backend.routes import models as models_routes
from backend.routes import presets as presets_routes
from backend.routes import search as search_routes
from backend.routes import status as status_routes
from backend.services import chat as chat_service
from backend.services import file_picker as file_picker_service
from backend.services import hf_download as hf_download_service
from backend.services import web_search as web_search_service

try:
    import certifi
except ImportError:
    certifi = None


def create_ssl_context():
    cafile = certifi.where() if certifi else None
    if cafile:
        return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


SSL_CONTEXT = create_ssl_context()


def urlopen_with_ssl(request, timeout):
    return urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT)


def normalize_arch(machine):
    value = (machine or "").strip().lower()
    mapping = {
        "amd64": "x64",
        "x86_64": "x64",
        "arm64": "arm64",
        "aarch64": "arm64",
        "armv8l": "arm64",
    }
    return mapping.get(value, value or "unknown")


CURRENT_ARCH = normalize_arch(platform.machine())
CURRENT_PLATFORM = sys.platform
BINARY_SUFFIX = ".exe" if CURRENT_PLATFORM == "win32" else ""
SHARED_LIBRARY_SUFFIXES = (".dll", ".so", ".dylib")


def get_platform_label():
    if CURRENT_PLATFORM == "win32":
        return "Windows"
    if CURRENT_PLATFORM == "darwin":
        return "macOS"
    if CURRENT_PLATFORM.startswith("linux"):
        return "Linux"
    return CURRENT_PLATFORM


def build_backend_specs():
    if CURRENT_PLATFORM == "win32":
        if CURRENT_ARCH == "arm64":
            return {
                "cpu": {
                    "label": "CPU",
                    "asset": "llama-{tag}-bin-win-cpu-arm64.zip",
                },
                "opencl-adreno": {
                    "label": "OpenCL (Adreno)",
                    "asset": "llama-{tag}-bin-win-opencl-adreno-arm64.zip",
                },
            }
        return {
            "cpu": {"label": "CPU", "asset": "llama-{tag}-bin-win-cpu-x64.zip"},
            "cuda-12.4": {
                "label": "CUDA 12.4 (NVIDIA)",
                "asset": "llama-{tag}-bin-win-cuda-12.4-x64.zip",
                "extra_assets": ["cudart-llama-bin-win-cuda-12.4-x64.zip"],
            },
            "cuda-13.1": {
                "label": "CUDA 13.1 (NVIDIA)",
                "asset": "llama-{tag}-bin-win-cuda-13.1-x64.zip",
                "extra_assets": ["cudart-llama-bin-win-cuda-13.1-x64.zip"],
            },
            "vulkan": {
                "label": "Vulkan",
                "asset": "llama-{tag}-bin-win-vulkan-x64.zip",
            },
            "sycl": {
                "label": "SYCL (Intel)",
                "asset": "llama-{tag}-bin-win-sycl-x64.zip",
            },
            "hip": {
                "label": "HIP (AMD Radeon)",
                "asset": "llama-{tag}-bin-win-hip-radeon-x64.zip",
            },
        }

    if CURRENT_PLATFORM == "darwin":
        if CURRENT_ARCH == "arm64":
            return {
                "metal": {
                    "label": "Metal (Apple Silicon)",
                    "asset": "llama-{tag}-bin-macos-arm64.tar.gz",
                },
                "metal-kleidiai": {
                    "label": "Metal + KleidiAI (Apple Silicon)",
                    "asset": "llama-{tag}-bin-macos-arm64-kleidiai.tar.gz",
                },
            }
        if CURRENT_ARCH == "x64":
            return {
                "cpu": {
                    "label": "CPU (Intel Mac)",
                    "asset": "llama-{tag}-bin-macos-x64.tar.gz",
                }
            }
        return {}

    if CURRENT_PLATFORM.startswith("linux"):
        if CURRENT_ARCH == "x64":
            return {
                "cpu": {"label": "CPU", "asset": "llama-{tag}-bin-ubuntu-x64.tar.gz"},
                "vulkan": {
                    "label": "Vulkan",
                    "asset": "llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz",
                },
                "rocm": {
                    "label": "ROCm 7.2 (AMD)",
                    "asset": "llama-{tag}-bin-ubuntu-rocm-7.2-x64.tar.gz",
                },
                "openvino": {
                    "label": "OpenVINO",
                    "asset": "llama-{tag}-bin-ubuntu-openvino-2026.0-x64.tar.gz",
                },
            }
        if CURRENT_ARCH == "arm64":
            return {
                "cpu": {
                    "label": "CPU",
                    "asset": "llama-{tag}-bin-ubuntu-arm64.tar.gz",
                },
                "vulkan": {
                    "label": "Vulkan",
                    "asset": "llama-{tag}-bin-ubuntu-vulkan-arm64.tar.gz",
                },
            }
        if CURRENT_ARCH == "s390x":
            return {
                "cpu": {
                    "label": "CPU",
                    "asset": "llama-{tag}-bin-ubuntu-s390x.tar.gz",
                }
            }
    return {}


BACKEND_SPECS = build_backend_specs()

APP_CONTEXT = DEFAULT_CONTEXT
STATE = APP_CONTEXT.state


def is_process_running():
    with STATE.process_lock:
        return STATE.process is not None and STATE.process.poll() is None


def load_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {"version": None, "backend": None, "tag": None}
    return {"version": None, "backend": None, "tag": None}


def save_config(cfg):
    tmp = CONFIG_FILE.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    tmp.replace(CONFIG_FILE)


def get_releases():
    req = urllib.request.Request(
        GITHUB_API, headers={"Accept": "application/vnd.github+json"}
    )
    with urlopen_with_ssl(req, timeout=30) as resp:
        return json.loads(resp.read())


def get_release_by_tag(tag):
    req = urllib.request.Request(
        f"{GITHUB_API}/tags/{tag}", headers={"Accept": "application/vnd.github+json"}
    )
    with urlopen_with_ssl(req, timeout=30) as resp:
        return json.loads(resp.read())


LLAMA_TOOLS = [
    "llama-cli",
    "llama-server",
    "llama-bench",
    "llama-perplexity",
    "llama-quantize",
    "llama-simple",
]


def get_tool_filename(tool):
    return f"{tool}{BINARY_SUFFIX}"


def find_tool_executable(tool):
    return LLAMA_BIN_DIR / get_tool_filename(tool)


def get_runtime_files():
    runtime_files = []
    if not LLAMA_BIN_DIR.exists():
        return runtime_files
    for path in sorted(LLAMA_BIN_DIR.iterdir()):
        if path.is_file() and path.suffix.lower() in SHARED_LIBRARY_SUFFIXES:
            runtime_files.append(path)
    return runtime_files


APP_CONTEXT.services.backend_specs = BACKEND_SPECS
APP_CONTEXT.services.binary_suffix = BINARY_SUFFIX
APP_CONTEXT.services.current_arch = CURRENT_ARCH
APP_CONTEXT.services.current_platform = CURRENT_PLATFORM
APP_CONTEXT.services.find_tool_executable = find_tool_executable
APP_CONTEXT.services.get_platform_label = get_platform_label
APP_CONTEXT.services.get_runtime_files = get_runtime_files
APP_CONTEXT.services.get_tool_filename = get_tool_filename
APP_CONTEXT.services.is_process_running = is_process_running
APP_CONTEXT.services.llama_tools = LLAMA_TOOLS
APP_CONTEXT.services.load_config = load_config
APP_CONTEXT.services.ssl_context = SSL_CONTEXT
APP_CONTEXT.services.urlopen_with_ssl = urlopen_with_ssl


def download_file(url, dest, progress_cb=None):
    req = urllib.request.Request(url)
    with urlopen_with_ssl(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if progress_cb:
                    progress_cb(downloaded, total)
    return downloaded


def get_cloudflared_asset():
    if CURRENT_PLATFORM == "win32":
        return {
            "url": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
            "archive": False,
            "filename": "cloudflared.exe",
        }
    if CURRENT_PLATFORM == "darwin":
        arch = "arm64" if CURRENT_ARCH == "arm64" else "amd64"
        return {
            "url": f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-{arch}.tgz",
            "archive": True,
            "filename": "cloudflared",
        }
    if CURRENT_PLATFORM.startswith("linux"):
        arch = "arm64" if CURRENT_ARCH == "arm64" else "amd64"
        return {
            "url": f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}",
            "archive": False,
            "filename": f"cloudflared-linux-{arch}",
        }
    return None


def set_remote_tunnel_state(status=None, url=None, message=None, log=None):
    updates = {}
    if status is not None:
        updates["status"] = status
    if url is not None:
        updates["url"] = url
    if message is not None:
        updates["message"] = message
    if log is not None:
        updates["log"] = log[-TUNNEL_LOG_LIMIT:]
    with STATE.remote_tunnel_lock:
        return STATE.remote_tunnel.update(**updates)


def parse_port(value, default=LLAMA_PORT):
    try:
        port = int(value or default)
    except (TypeError, ValueError):
        port = default
    if port < 1 or port > 65535:
        port = default
    return port


def normalize_local_proxy_host(host):
    value = str(host or LLAMA_HOST).strip() or LLAMA_HOST
    if value.lower() == "localhost" or value in {"0.0.0.0", "::", "*"}:
        return LLAMA_HOST
    proxy_host, host_error = get_metrics_host(value)
    if not proxy_host:
        raise ValueError(host_error)
    return proxy_host


def set_llama_api_target(host=None, port=None):
    proxy_host = normalize_local_proxy_host(host)
    proxy_port = parse_port(port)
    with STATE.llama_api_target_lock:
        return STATE.llama_api_target.update(host=proxy_host, port=proxy_port)


def get_llama_api_target():
    with STATE.llama_api_target_lock:
        return STATE.llama_api_target.snapshot()


def parse_launch_api_target(args_list):
    flat_args = []
    for entry in args_list or []:
        if isinstance(entry, list):
            flat_args.extend(str(v) for v in entry)
        else:
            flat_args.append(str(entry))

    host = LLAMA_HOST
    port = LLAMA_PORT
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
        return set_llama_api_target(host, port)
    except ValueError:
        return get_llama_api_target()


def get_remote_tunnel_snapshot():
    with STATE.remote_tunnel_lock:
        proc = STATE.remote_tunnel_process
        snapshot = STATE.remote_tunnel.snapshot()
        if proc is not None and proc.poll() is not None and snapshot["status"] in {
            "preparing",
            "downloading",
            "starting",
            "running",
        }:
            snapshot["status"] = "error"
            snapshot["message"] = "Remote tunnel process exited."
            STATE.remote_tunnel.replace(snapshot)
        snapshot["running"] = proc is not None and proc.poll() is None
        return snapshot


def ensure_cloudflared():
    spec = get_cloudflared_asset()
    if not spec:
        raise RuntimeError(f"Cloudflare tunnel is not supported on {CURRENT_PLATFORM}/{CURRENT_ARCH}.")

    CLOUDFLARED_DIR.mkdir(parents=True, exist_ok=True)
    binary_path = CLOUDFLARED_DIR / spec["filename"]
    if binary_path.exists():
        if CURRENT_PLATFORM != "win32":
            os.chmod(binary_path, 0o755)
        return binary_path

    set_remote_tunnel_state(status="downloading", message="Downloading Cloudflare tunnel helper...")
    if spec["archive"]:
        archive_path = CLOUDFLARED_DIR / pathlib.Path(spec["url"]).name
        download_file(spec["url"], archive_path)
        with tarfile.open(archive_path, "r:gz") as tf:
            member = next(
                (
                    m
                    for m in tf.getmembers()
                    if pathlib.PurePosixPath(m.name).name == spec["filename"] and m.isfile()
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
        download_file(spec["url"], binary_path)

    if CURRENT_PLATFORM != "win32":
        os.chmod(binary_path, 0o755)
    return binary_path


def _start_remote_tunnel_worker():
    log = ""
    try:
        set_remote_tunnel_state(
            status="preparing",
            url="",
            message="Preparing Cloudflare tunnel...",
            log="",
        )
        binary_path = ensure_cloudflared()
        set_remote_tunnel_state(status="starting", message="Starting Cloudflare tunnel...")

        env = os.environ.copy()
        if CURRENT_PLATFORM.startswith("linux"):
            env.pop("LD_LIBRARY_PATH", None)

        args = [
            str(binary_path),
            "tunnel",
            "--url",
            f"http://{GUI_HOST}:{GUI_PORT}",
        ]
        proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(CLOUDFLARED_DIR),
            env=env,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
            if sys.platform == "win32"
            else 0,
        )
        with STATE.remote_tunnel_lock:
            STATE.remote_tunnel_process = proc

        pattern = re.compile(r"https://[\w.-]+\.trycloudflare\.com")
        while True:
            line = proc.stderr.readline() if proc.stderr else ""
            if not line:
                break
            log = (log + line)[-TUNNEL_LOG_LIMIT:]
            found = pattern.search(line)
            if found:
                set_remote_tunnel_state(
                    status="running",
                    url=found.group(0),
                    message="Remote tunnel is running.",
                    log=log,
                )
            else:
                set_remote_tunnel_state(log=log)

        exit_code = proc.wait()
        with STATE.remote_tunnel_lock:
            if STATE.remote_tunnel_process is proc:
                STATE.remote_tunnel_process = None
            current_status = STATE.remote_tunnel.snapshot()["status"]
        if current_status != "stopped":
            set_remote_tunnel_state(
                status="error",
                url="",
                message=f"Cloudflare tunnel exited with code {exit_code}.",
                log=log,
            )
    except Exception as exc:
        with STATE.remote_tunnel_lock:
            STATE.remote_tunnel_process = None
        set_remote_tunnel_state(status="error", url="", message=str(exc), log=log)


def start_remote_tunnel():
    with STATE.remote_tunnel_lock:
        proc = STATE.remote_tunnel_process
        snapshot = STATE.remote_tunnel.snapshot()
        if proc is not None and proc.poll() is None:
            return snapshot
        if snapshot["status"] in {"preparing", "downloading", "starting"}:
            return snapshot
        STATE.remote_tunnel.update(
            status="preparing",
            url="",
            message="Preparing Cloudflare tunnel...",
            log="",
        )
    threading.Thread(target=_start_remote_tunnel_worker, daemon=True).start()
    return get_remote_tunnel_snapshot()


def stop_remote_tunnel():
    with STATE.remote_tunnel_lock:
        proc = STATE.remote_tunnel_process
        STATE.remote_tunnel_process = None
        STATE.remote_tunnel.update(
            status="stopped",
            url="",
            message="Remote tunnel stopped.",
        )

    if proc is not None and proc.poll() is None:
        try:
            if CURRENT_PLATFORM == "win32":
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    return get_remote_tunnel_snapshot()


def sha256_file(filepath):
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def set_download_progress(**updates):
    STATE.download_progress.update(**updates)


def reset_download_progress(status="idle", message="", total=0, downloaded=0):
    STATE.download_progress.replace(
        {
            "total": total,
            "downloaded": downloaded,
            "status": status,
            "message": message,
        }
    )


def get_download_progress_snapshot():
    return STATE.download_progress.snapshot()


def reset_model_download_state(status="idle", message="", total=0, downloaded=0):
    STATE.model_download.replace(
        {
            "status": status,
            "message": message,
            "total": total,
            "downloaded": downloaded,
            "current_file": "",
            "model_name": "",
            "model_path": "",
            "mmproj_path": "",
        }
    )


def set_model_download_state(**updates):
    STATE.model_download.update(**updates)


def get_model_download_snapshot():
    return hf_download_service.get_model_download_snapshot(APP_CONTEXT)


def normalize_hf_token(token):
    return hf_download_service.normalize_hf_token(token)


def validate_hf_repo_id(repo_id):
    return hf_download_service.validate_hf_repo_id(repo_id)


def validate_hf_revision(revision):
    return hf_download_service.validate_hf_revision(revision)


def validate_hf_filename(filename):
    return hf_download_service.validate_hf_filename(filename)


def is_mmproj_filename(filename):
    return hf_download_service.is_mmproj_filename(filename)


def slugify_repo_id(repo_id):
    return hf_download_service.slugify_repo_id(repo_id)


def hf_file_to_dict(file_obj):
    return hf_download_service.hf_file_to_dict(file_obj)


def get_hf_gguf_files(repo_id, revision="main", token=None):
    return hf_download_service.get_hf_gguf_files(repo_id, revision, token)


def get_hf_file_size(repo_id, filename, revision, token=None):
    return hf_download_service.get_hf_file_size(repo_id, filename, revision, token)


def build_hf_download_url(repo_id, filename, revision):
    return hf_download_service.build_hf_download_url(repo_id, filename, revision)


def download_hf_file(repo_id, filename, revision, token, dest, completed_bytes, total_bytes):
    return hf_download_service.download_hf_file(
        APP_CONTEXT,
        repo_id,
        filename,
        revision,
        token,
        dest,
        completed_bytes,
        total_bytes,
        urlopen_with_ssl,
    )


def remove_partial_downloads(paths):
    return hf_download_service.remove_partial_downloads(paths)


def start_hf_model_download(repo_id, revision, model_file, mmproj_file, token, overwrite=False):
    return hf_download_service.start_hf_model_download(
        APP_CONTEXT,
        repo_id,
        revision,
        model_file,
        mmproj_file,
        token,
        overwrite,
        urlopen_with_ssl,
    )


def extract_zip_file_flat(zf, info, dest_dir):
    if info.is_dir():
        return

    fname = pathlib.Path(info.filename).name
    if not fname:
        return

    out_path = pathlib.Path(dest_dir) / fname
    with zf.open(info, "r") as src, open(out_path, "wb") as dst:
        shutil.copyfileobj(src, dst)


def extract_tar_member_flat(tf, member, dest_dir):
    fname = pathlib.Path(member.name).name
    if not fname:
        return

    out_path = pathlib.Path(dest_dir) / fname

    if member.issym():
        target_name = pathlib.Path(member.linkname).name
        if not target_name:
            return
        try:
            if out_path.exists() or out_path.is_symlink():
                out_path.unlink()
            out_path.symlink_to(target_name)
        except OSError:
            pass
        return

    if member.islnk():
        target_name = pathlib.Path(member.linkname).name
        if not target_name:
            return
        target_path = pathlib.Path(dest_dir) / target_name
        if not target_path.exists():
            return
        try:
            if out_path.exists() or out_path.is_symlink():
                out_path.unlink()
            os.link(target_path, out_path)
        except OSError:
            pass
        return

    if not member.isfile():
        return

    src = tf.extractfile(member)
    if src is None:
        return
    with src, open(out_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
    if member.mode:
        os.chmod(out_path, member.mode)


def extract_archive_flat(archive_path):
    lower_name = archive_path.name.lower()
    if lower_name.endswith(".zip"):
        with zipfile.ZipFile(archive_path, "r") as zf:
            for info in zf.infolist():
                fname = pathlib.Path(info.filename).name
                if not fname:
                    continue
                lower = fname.lower()
                if lower.endswith((".gbnf", ".json")):
                    extract_zip_file_flat(zf, info, LLAMA_GRAMMARS_DIR)
                else:
                    extract_zip_file_flat(zf, info, LLAMA_BIN_DIR)
        return

    if lower_name.endswith((".tar.gz", ".tgz")):
        with tarfile.open(archive_path, "r:gz") as tf:
            for member in tf.getmembers():
                fname = pathlib.Path(member.name).name
                if not fname:
                    continue
                lower = fname.lower()
                if lower.endswith((".gbnf", ".json")):
                    extract_tar_member_flat(tf, member, LLAMA_GRAMMARS_DIR)
                else:
                    extract_tar_member_flat(tf, member, LLAMA_BIN_DIR)
        return

    raise ValueError(f"Unsupported archive format: {archive_path.name}")


def install_release(tag, backend):
    reset_download_progress(status="downloading", message=f"Fetching release {tag}...")

    try:
        release = get_release_by_tag(tag)
    except Exception:
        releases = get_releases()
        release = next((r for r in releases if r["tag_name"] == tag), None)
        if not release:
            set_download_progress(status="error", message=f"Release {tag} not found")
            return False

    asset_map = {a["name"]: a for a in release["assets"]}

    def progress_cb(downloaded, total):
        set_download_progress(downloaded=downloaded, total=total)

    backend_spec = BACKEND_SPECS[backend]
    bin_filename = backend_spec["asset"].format(tag=tag)
    if bin_filename not in asset_map:
        set_download_progress(
            status="error", message=f"Asset {bin_filename} not found in release {tag}"
        )
        return False

    bin_url = asset_map[bin_filename]["browser_download_url"]
    expected_sha = asset_map[bin_filename].get("sha256", None)

    tmpdir = tempfile.mkdtemp(prefix="llama_install_")
    try:
        bin_archive = pathlib.Path(tmpdir) / bin_filename
        set_download_progress(message=f"Downloading {bin_filename}...")
        download_file(bin_url, bin_archive, progress_cb)

        if expected_sha:
            actual_sha = sha256_file(bin_archive)
            if actual_sha != expected_sha:
                set_download_progress(
                    status="error", message=f"SHA256 mismatch for {bin_filename}"
                )
                return False

        extra_archives = []
        for extra_filename in backend_spec.get("extra_assets", []):
            if extra_filename not in asset_map:
                continue
            extra_url = asset_map[extra_filename]["browser_download_url"]
            extra_archive = pathlib.Path(tmpdir) / extra_filename
            set_download_progress(message=f"Downloading {extra_filename}...")
            download_file(extra_url, extra_archive, progress_cb)
            extra_archives.append(extra_archive)

        set_download_progress(status="extracting", message="Extracting binaries...")

        for d in [LLAMA_BIN_DIR, LLAMA_GRAMMARS_DIR]:
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)

        extract_archive_flat(bin_archive)
        for extra_archive in extra_archives:
            extract_archive_flat(extra_archive)

        save_config(
            {"version": release.get("name", tag), "backend": backend, "tag": tag}
        )
        set_download_progress(status="done", message=f"Installed {tag} ({backend})")
        return True

    except Exception as e:
        set_download_progress(status="error", message=str(e))
        return False
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def stream_output(pipe, is_stderr=False):
    try:
        for line in iter(pipe.readline, ""):
            if line:
                decoded = line.rstrip("\n\r")
                with STATE.output_buffer_lock:
                    STATE.output_buffer.append(decoded)
                    if len(STATE.output_buffer) > PROCESS_OUTPUT_LIMIT:
                        del STATE.output_buffer[:PROCESS_OUTPUT_TRIM]
    except Exception:
        pass


def launch_process(tool, args_list):
    with STATE.process_lock:
        if STATE.process and STATE.process.poll() is None:
            return {"error": "A process is already running"}

        exe_name = get_tool_filename(tool)
        exe_path = find_tool_executable(tool)
        if not exe_path.exists():
            return {"error": f"{exe_name} not found. Install llama.cpp first."}

        args = [str(exe_path)]
        for entry in args_list:
            if isinstance(entry, list):
                args.extend(str(v) for v in entry)
            else:
                args.append(str(entry))

        env = os.environ.copy()
        runtime_paths = [str(LLAMA_BIN_DIR)]
        existing_path = env.get("PATH", "")
        env["PATH"] = os.pathsep.join(runtime_paths + ([existing_path] if existing_path else []))

        if CURRENT_PLATFORM.startswith("linux"):
            existing_ld = env.get("LD_LIBRARY_PATH", "")
            env["LD_LIBRARY_PATH"] = os.pathsep.join(
                runtime_paths + ([existing_ld] if existing_ld else [])
            )
        elif CURRENT_PLATFORM == "darwin":
            existing_dyld = env.get("DYLD_LIBRARY_PATH", "")
            env["DYLD_LIBRARY_PATH"] = os.pathsep.join(
                runtime_paths + ([existing_dyld] if existing_dyld else [])
            )

        with STATE.output_buffer_lock:
            STATE.output_buffer.clear()

        try:
            STATE.process = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                env=env,
                cwd=str(BASE_DIR),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
                if sys.platform == "win32"
                else 0,
            )
            threading.Thread(
                target=stream_output, args=(STATE.process.stdout,), daemon=True
            ).start()
            threading.Thread(
                target=stream_output, args=(STATE.process.stderr, True), daemon=True
            ).start()
            STATE.active_process_tool = tool
            if tool == "llama-server":
                parse_launch_api_target(args_list)
            return {"pid": STATE.process.pid, "command": " ".join(args)}
        except Exception as e:
            return {"error": str(e)}


def stop_process():
    with STATE.process_lock:
        if STATE.process and STATE.process.poll() is None:
            if sys.platform == "win32":
                STATE.process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                STATE.process.terminate()
            try:
                STATE.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                STATE.process.kill()
            STATE.active_process_tool = None
            return True
        return False


def shutdown_gui_server():
    server = STATE.gui_server
    if server is None:
        return False
    stop_remote_tunnel()
    stop_process()
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def restart_gui_server():
    server = STATE.gui_server
    if server is None:
        return False
    stop_remote_tunnel()
    stop_process()
    restart_script = str(BASE_DIR / "server.py")

    def _restart():
        try:
            time.sleep(RESTART_STARTUP_DELAY_SECONDS)
            for i in range(RESTART_PORT_WAIT_ATTEMPTS):
                try:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.bind((GUI_HOST, GUI_PORT))
                    sock.close()
                    break
                except OSError:
                    if i < RESTART_PORT_WAIT_ATTEMPTS - 1:
                        time.sleep(RESTART_PORT_WAIT_SECONDS)
                    else:
                        print(f"WARNING: Port {GUI_PORT} still in use after waiting, attempting restart anyway")
            subprocess.Popen(
                [sys.executable, restart_script],
                cwd=str(BASE_DIR),
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                if sys.platform == "win32"
                else 0,
            )
            print("Restarting Llama GUI...")
        except Exception as e:
            print(f"ERROR: Failed to restart server: {e}")
            import traceback
            traceback.print_exc()
            return
        os._exit(0)

    threading.Thread(target=_restart, daemon=False).start()
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def remove_llama_files():
    removed_files = 0

    if LLAMA_DIR.exists():
        for path in LLAMA_DIR.rglob("*"):
            if path.is_file():
                removed_files += 1

    if LLAMA_DIR.exists():
        shutil.rmtree(LLAMA_DIR)

    for d in [LLAMA_BIN_DIR, LLAMA_GRAMMARS_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    save_config({"version": None, "backend": None, "tag": None})

    return removed_files


def run_git(args):
    return subprocess.run(
        ["git", *args],
        cwd=str(BASE_DIR),
        capture_output=True,
        text=True,
        check=False,
    )


def install_python_dependencies():
    requirements_path = BASE_DIR / "requirements.txt"
    if not requirements_path.exists():
        return {"installed": False, "message": "requirements.txt was not found."}

    res = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(requirements_path)],
        cwd=str(BASE_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    output = (res.stdout or res.stderr or "").strip()
    if res.returncode != 0:
        return {
            "installed": False,
            "error": (res.stderr or res.stdout or "Dependency installation failed.").strip(),
        }
    return {
        "installed": True,
        "message": output.splitlines()[-1] if output else "Dependencies are up to date.",
    }


SAFE_DIRTY_PATH_PREFIXES = (
    "llama/",
    "models/",
    "presets/",
    "releases/",
    "__pycache__/",
    ".ruff_cache/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".venv/",
    "venv/",
    "env/",
    "logs/",
    "tmp/",
    "temp/",
)

SAFE_DIRTY_PATHS = {
    "config.json",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
}

SAFE_DIRTY_SUFFIXES = (
    ".pyc",
    ".pyo",
    ".log",
    ".tmp",
    ".temp",
    ".bak",
    ".orig",
    ".swp",
    ".swo",
    ".zip",
    ".tar.gz",
    ".tgz",
)


def normalize_git_path(path):
    return str(path or "").replace("\\", "/").strip()


def parse_git_status_porcelain_z(output):
    entries = []
    parts = output.split("\0")
    i = 0
    while i < len(parts):
        raw = parts[i]
        i += 1
        if not raw:
            continue

        status = raw[:2]
        path = normalize_git_path(raw[3:])
        if not path:
            continue

        entries.append({"status": status, "path": path})

        if status[0] in {"R", "C"} or status[1] in {"R", "C"}:
            # Rename/copy records include the source path as the next NUL item.
            if i < len(parts) and parts[i]:
                entries[-1]["source_path"] = normalize_git_path(parts[i])
                i += 1

    return entries


def is_safe_dirty_path(path):
    path = normalize_git_path(path)
    if not path:
        return False
    if path in SAFE_DIRTY_PATHS:
        return True
    if path.startswith(".env"):
        return True
    if any(path.startswith(prefix) for prefix in SAFE_DIRTY_PATH_PREFIXES):
        return True
    return any(path.endswith(suffix) for suffix in SAFE_DIRTY_SUFFIXES)


def classify_git_dirty_paths(entries):
    safe = []
    blocking = []

    for entry in entries:
        path = entry.get("path", "")
        target = safe if is_safe_dirty_path(path) else blocking
        target.append(entry)

    return {
        "dirty_paths": [entry["path"] for entry in entries],
        "safe_dirty_paths": [entry["path"] for entry in safe],
        "blocking_dirty_paths": [entry["path"] for entry in blocking],
        "dirty_entries": entries,
    }


def get_app_update_status(fetch=False):
    if not (BASE_DIR / ".git").exists():
        return {
            "available": False,
            "can_update": False,
            "reason": "This folder is not a git repository.",
            "repo_url": APP_REPO_URL,
        }

    git_version = run_git(["--version"])
    if git_version.returncode != 0:
        return {
            "available": False,
            "can_update": False,
            "reason": "Git is not available on this system.",
            "repo_url": APP_REPO_URL,
        }

    branch_res = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    if branch_res.returncode != 0:
        return {
            "available": True,
            "can_update": False,
            "reason": (
                branch_res.stderr or "Unable to read current git branch"
            ).strip(),
            "repo_url": APP_REPO_URL,
        }
    branch = branch_res.stdout.strip()

    remote_res = run_git(["config", "--get", "remote.origin.url"])
    origin_url = remote_res.stdout.strip() if remote_res.returncode == 0 else ""

    dirty_res = run_git(["status", "--porcelain=v1", "-z"])
    if dirty_res.returncode != 0:
        return {
            "available": True,
            "can_update": False,
            "reason": (dirty_res.stderr or "Unable to inspect git status").strip(),
            "repo_url": APP_REPO_URL,
            "origin_url": origin_url,
            "branch": branch,
        }
    dirty_entries = parse_git_status_porcelain_z(dirty_res.stdout)
    dirty_info = classify_git_dirty_paths(dirty_entries)
    has_local_changes = bool(dirty_info["dirty_paths"])
    has_blocking_changes = bool(dirty_info["blocking_dirty_paths"])

    if fetch:
        fetch_res = run_git(["fetch", "origin", "--prune"])
        if fetch_res.returncode != 0:
            return {
                "available": True,
                "can_update": False,
                "reason": (fetch_res.stderr or "Failed to fetch from origin").strip(),
                "repo_url": APP_REPO_URL,
                "origin_url": origin_url,
                "branch": branch,
                "dirty": has_local_changes,
                "has_blocking_changes": has_blocking_changes,
                **dirty_info,
            }

    upstream_ref = f"origin/{branch}"
    behind_ahead_res = run_git(
        ["rev-list", "--left-right", "--count", f"HEAD...{upstream_ref}"]
    )
    if behind_ahead_res.returncode != 0:
        return {
            "available": True,
            "can_update": False,
            "reason": f"No upstream branch found at {upstream_ref}.",
            "repo_url": APP_REPO_URL,
            "origin_url": origin_url,
            "branch": branch,
            "dirty": has_local_changes,
            "has_blocking_changes": has_blocking_changes,
            **dirty_info,
        }

    parts = behind_ahead_res.stdout.strip().split()
    ahead = int(parts[0]) if len(parts) > 0 else 0
    behind = int(parts[1]) if len(parts) > 1 else 0

    if ahead > 0 and behind > 0:
        state = "diverged"
    elif ahead > 0:
        state = "ahead"
    elif behind > 0:
        state = "behind"
    else:
        state = "up_to_date"

    can_update = state == "behind" and not has_blocking_changes

    return {
        "available": True,
        "can_update": can_update,
        "repo_url": APP_REPO_URL,
        "origin_url": origin_url,
        "branch": branch,
        "dirty": has_local_changes,
        "has_blocking_changes": has_blocking_changes,
        **dirty_info,
        "ahead": ahead,
        "behind": behind,
        "state": state,
    }


def update_app_from_git():
    status = get_app_update_status(fetch=True)
    if not status.get("available"):
        return {
            "updated": False,
            "error": status.get("reason", "App update is unavailable"),
            "status": status,
        }

    if not status.get("can_update"):
        state = status.get("state")
        if state == "up_to_date":
            return {"updated": False, "status": status, "message": "Already up to date"}
        if status.get("has_blocking_changes"):
            paths = status.get("blocking_dirty_paths") or []
            detail = f" Blocking paths: {', '.join(paths[:8])}" if paths else ""
            return {
                "updated": False,
                "error": "Cannot auto-update with source changes. Commit or stash first." + detail,
                "status": status,
            }
        if state == "ahead":
            return {
                "updated": False,
                "error": "Local branch is ahead of origin; not pulling automatically.",
                "status": status,
            }
        if state == "diverged":
            return {
                "updated": False,
                "error": "Branch has diverged from origin; manual merge/rebase required.",
                "status": status,
            }
        return {
            "updated": False,
            "error": status.get("reason", "App cannot be updated automatically."),
            "status": status,
        }

    pull_res = run_git(["pull", "--ff-only", "origin", status["branch"]])
    if pull_res.returncode != 0:
        return {
            "updated": False,
            "error": (pull_res.stderr or pull_res.stdout or "git pull failed").strip(),
            "status": get_app_update_status(fetch=False),
        }

    deps_res = install_python_dependencies()
    if deps_res.get("error"):
        return {
            "updated": True,
            "dependencies_installed": False,
            "dependency_error": deps_res["error"],
            "message": (pull_res.stdout or "Updated successfully").strip(),
            "status": get_app_update_status(fetch=False),
        }

    return {
        "updated": True,
        "dependencies_installed": deps_res.get("installed", False),
        "dependency_message": deps_res.get("message", ""),
        "message": (pull_res.stdout or "Updated successfully").strip(),
        "status": get_app_update_status(fetch=False),
    }


def open_folder_in_file_manager(target):
    if CURRENT_PLATFORM == "win32":
        os.startfile(str(target))
        return
    if CURRENT_PLATFORM == "darwin":
        subprocess.run(["open", str(target)], check=False)
        return
    subprocess.run(["xdg-open", str(target)], check=False)


def select_file_in_native_dialog(title="Select File", initial_dir=None, filetypes=None):
    return file_picker_service.select_file_in_native_dialog(title, initial_dir, filetypes)


def html_to_readable_text(raw_html):
    return web_search_service.html_to_readable_text(raw_html)


def validate_public_hostname(hostname, port):
    return web_search_service.validate_public_hostname(hostname, port)


NoRedirect = web_search_service.NoRedirect


def fetch_page_text(url, max_chars=WEB_SEARCH_PAGE_CHARS, timeout=WEB_SEARCH_TIMEOUT):
    return web_search_service.fetch_page_text(url, max_chars=max_chars, timeout=timeout, ssl_context=SSL_CONTEXT)


def web_search(query, max_results=WEB_SEARCH_MAX_RESULTS):
    return web_search_service.web_search(query, max_results)


def get_latest_user_message(messages):
    return chat_service.get_latest_user_message(messages)


def build_search_queries(user_text):
    return chat_service.build_search_queries(user_text)


def build_search_context(search_results, fetched_pages):
    return chat_service.build_search_context(search_results, fetched_pages)


def get_local_chat_api_url(body):
    return chat_service.get_local_chat_api_url(body)


def get_local_interface_addresses():
    addresses = {LLAMA_HOST, "::1"}
    hostnames = {socket.gethostname(), socket.getfqdn()}
    for name in hostnames:
        try:
            for info in socket.getaddrinfo(name, None):
                addresses.add(info[4][0])
        except OSError:
            pass
    return addresses


def get_metrics_host(host):
    value = str(host or LLAMA_HOST).strip() or LLAMA_HOST
    if value.lower() == "localhost" or value in {"0.0.0.0", "::", "*"}:
        return LLAMA_HOST, ""
    try:
        infos = socket.getaddrinfo(value, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        return "", f"Invalid llama-server metrics host: {exc}"
    local_addresses = get_local_interface_addresses()
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback or info[4][0] in local_addresses:
            return value, ""
    return "", "Blocked: metrics proxy can only target this machine."


def get_local_llama_metrics(host, port):
    try:
        parsed_port = int(port or LLAMA_PORT)
    except (TypeError, ValueError):
        return None, "Invalid llama-server metrics port."
    if parsed_port < 1 or parsed_port > 65535:
        return None, "Invalid llama-server metrics port."

    metrics_host, host_error = get_metrics_host(host)
    if not metrics_host:
        return None, host_error

    url = f"http://{metrics_host}:{parsed_port}/metrics"
    req = urllib.request.Request(url, headers={"Accept": "text/plain"})
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            raw = resp.read(WEB_SEARCH_FETCH_BYTES)
            charset = resp.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, errors="replace"), ""
    except urllib.error.HTTPError as exc:
        return None, f"llama-server metrics returned HTTP {exc.code}."
    except Exception as exc:
        return None, f"Failed to fetch llama-server metrics: {exc}"


APP_CONTEXT.services.get_local_llama_metrics = get_local_llama_metrics


def write_sse(wfile, data):
    SseWriter(wfile).write(data)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI_DIR), **kw)

    def log_message(self, format, *args):
        pass

    def end_headers(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if is_static_ui_path(path):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
        super().end_headers()

    def do_OPTIONS(self):
        parsed = urllib.parse.urlparse(self.path)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
        self.send_header("Access-Control-Allow-Methods", get_cors_methods(parsed.path))
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        if self.is_v1_proxy_path(parsed.path):
            self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def send_json(self, data, status=200):
        Response(self).json(data, status)

    def send_error_json(self, message, status=500, code=None, extra=None):
        Response(self).error(message, status=status, code=code, extra=extra)

    def send_sse_headers(self, status=200):
        Response(self).sse_headers(status)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def is_safe_request_origin(self):
        return is_safe_request_origin(self.headers, self.get_allowed_request_origins())

    def is_v1_proxy_path(self, path):
        return is_v1_proxy_path(path)

    def get_allowed_request_origins(self):
        tunnel_url = get_remote_tunnel_snapshot().get("url")
        return get_allowed_request_origins(tunnel_url, GUI_HOST, GUI_PORT)

    def get_access_control_origin(self):
        return get_access_control_origin(self.headers, self.get_allowed_request_origins())

    def get_proxy_request_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return None
        return self.rfile.read(length)

    def send_proxy_error(self, message, status=502):
        self.send_error_json(message, status)

    def handle_v1_index(self):
        target = get_llama_api_target()
        text = (
            "Llama-GUI OpenAI-compatible proxy is running.\n"
            f"Local llama-server target: http://{target['host']}:{target['port']}\n"
            "Use /v1/models or /v1/chat/completions with an OpenAI-compatible client.\n"
        )
        Response(self).text(text)

    def proxy_v1_request(self, method, parsed):
        if not self.is_safe_request_origin():
            self.send_error_json("Request origin not allowed", 403)
            return

        if parsed.path == "/v1":
            self.handle_v1_index()
            return

        target = get_llama_api_target()
        path = parsed.path
        query = f"?{parsed.query}" if parsed.query else ""
        url = f"http://{target['host']}:{target['port']}{path}{query}"
        data = self.get_proxy_request_body() if method in {"POST", "PUT", "PATCH"} else None

        headers = {}
        for name in ("Content-Type", "Accept", "Authorization"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        if "Accept" not in headers:
            headers["Accept"] = "*/*"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                self.send_response(resp.status)
                excluded = {
                    "connection",
                    "content-length",
                    "date",
                    "server",
                    "transfer-encoding",
                    "content-encoding",
                }
                for key, value in resp.headers.items():
                    if key.lower() not in excluded:
                        self.send_header(key, value)
                self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
                self.end_headers()
                content_type = resp.headers.get("Content-Type", "")
                if content_type.startswith("text/event-stream"):
                    while True:
                        line = resp.readline()
                        if not line:
                            break
                        self.wfile.write(line)
                        self.wfile.flush()
                else:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except urllib.error.HTTPError as exc:
            body = exc.read()
            self.send_response(exc.code)
            content_type = exc.headers.get("Content-Type", "application/json")
            self.send_header("Content-Type", content_type)
            self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            self.send_proxy_error(
                f"Failed to reach llama-server at {target['host']}:{target['port']}. "
                "Start llama-server or check the API host/port before using the /v1 proxy. "
                f"Details: {exc}"
            )

    def dispatch_api_request(self, method, parsed, body=None):
        path = parsed.path
        match = API_ROUTER.match(method, path)
        if not match:
            if path.startswith("/api/"):
                self.send_error_json("Not found", 404)
            else:
                self.send_error(404)
            return
        if isinstance(match.handler, str):
            handler = getattr(self, match.handler)
            handler(parsed, body, dict(match.params))
            return

        request = Request(
            method=method,
            path=path,
            query=parsed.query,
            headers=self.headers,
            body=body,
            params=dict(match.params),
        )
        match.handler(request, Response(self), APP_CONTEXT)

    def handle_get_releases(self, parsed, body=None, params=None):
        try:
            releases = get_releases()
            result = []
            for r in releases[:20]:
                result.append(
                    {
                        "tag": r["tag_name"],
                        "name": r.get("name", r["tag_name"]),
                        "published": r["published_at"],
                        "assets": [a["name"] for a in r["assets"]],
                    }
                )
            self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_get_output(self, parsed, body=None, params=None):
        with STATE.output_buffer_lock:
            lines = list(STATE.output_buffer)
        running = is_process_running()
        self.send_json({"output": lines, "running": running})

    def handle_get_download_progress(self, parsed, body=None, params=None):
        self.send_json(get_download_progress_snapshot())

    def handle_get_remote_tunnel_status(self, parsed, body=None, params=None):
        self.send_json(get_remote_tunnel_snapshot())

    def handle_get_app_update_status(self, parsed, body=None, params=None):
        try:
            self.send_json(get_app_update_status(fetch=True))
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_post_remote_tunnel_start(self, parsed, body=None, params=None):
        try:
            set_llama_api_target(body.get("host"), body.get("port"))
        except Exception as e:
            self.send_error_json(str(e), 400)
            return
        self.send_json(start_remote_tunnel())

    def handle_post_remote_tunnel_stop(self, parsed, body=None, params=None):
        self.send_json(stop_remote_tunnel())

    def handle_post_install(self, parsed, body=None, params=None):
        tag = body.get("tag")
        backend = body.get("backend")
        if not tag or not backend:
            self.send_error_json("tag and backend required", 400)
            return
        if backend not in BACKEND_SPECS:
            self.send_error_json(f"Unsupported backend: {backend}", 400)
            return
        if is_process_running():
            self.send_error_json("Stop running process first", 400)
            return
        with STATE.install_lock:
            if STATE.install_in_progress:
                self.send_error_json("Installation already in progress", 409)
                return
            STATE.install_in_progress = True

        def _install(tag, backend):
            try:
                install_release(tag, backend)
            finally:
                with STATE.install_lock:
                    STATE.install_in_progress = False

        threading.Thread(
            target=_install, args=(tag, backend), daemon=True
        ).start()
        self.send_json({"status": "started"})

    def handle_post_update(self, parsed, body=None, params=None):
        cfg = load_config()
        tag = cfg.get("tag")
        backend = cfg.get("backend")
        if not tag or not backend:
            self.send_error_json("Nothing installed to update", 400)
            return
        if backend not in BACKEND_SPECS:
            self.send_error_json(f"Unsupported configured backend: {backend}", 400)
            return
        if is_process_running():
            self.send_error_json("Stop running process first", 400)
            return
        with STATE.install_lock:
            if STATE.install_in_progress:
                self.send_error_json("Installation already in progress", 409)
                return
            STATE.install_in_progress = True
        try:
            releases = get_releases()
            latest = releases[0]["tag_name"] if releases else None
            if latest and latest != tag:

                def _update(latest_tag, backend_name):
                    try:
                        install_release(latest_tag, backend_name)
                    finally:
                        with STATE.install_lock:
                            STATE.install_in_progress = False

                threading.Thread(
                    target=_update, args=(latest, backend), daemon=True
                ).start()
                self.send_json({"status": "started", "from": tag, "to": latest})
            else:
                with STATE.install_lock:
                    STATE.install_in_progress = False
                self.send_json({"status": "already_latest"})
        except Exception as e:
            with STATE.install_lock:
                STATE.install_in_progress = False
            self.send_error_json(str(e), 500)

    def handle_post_launch(self, parsed, body=None, params=None):
        tool = body.get("tool", "llama-cli")
        args = body.get("args", [])
        result = launch_process(tool, args)
        if "error" in result:
            self.send_error_json(result.get("error", "Launch failed"), 400)
        else:
            self.send_json(result)

    def handle_post_stop(self, parsed, body=None, params=None):
        stopped = stop_process()
        self.send_json({"stopped": stopped})

    def handle_post_shutdown(self, parsed, body=None, params=None):
        shutting_down = shutdown_gui_server()
        self.send_json({"shutting_down": shutting_down})

    def handle_post_restart(self, parsed, body=None, params=None):
        restarting = restart_gui_server()
        self.send_json({"restarting": restarting})

    def handle_post_cleanup_llama(self, parsed, body=None, params=None):
        if is_process_running():
            self.send_error_json("Stop running process first", 400)
            return
        try:
            removed_files = remove_llama_files()
            self.send_json({"removed_files": removed_files})
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_post_app_update(self, parsed, body=None, params=None):
        try:
            result = update_app_from_git()
            if result.get("error"):
                self.send_error_json(
                    result.get("error", "App update failed"),
                    400,
                    extra={key: value for key, value in result.items() if key != "error"},
                )
            else:
                self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_post_send_input(self, parsed, body=None, params=None):
        text = body.get("text", "")
        with STATE.process_lock:
            if STATE.process and STATE.process.poll() is None:
                try:
                    if STATE.process.stdin:
                        STATE.process.stdin.write(text + "\n")
                        STATE.process.stdin.flush()
                        self.send_json({"sent": True})
                    else:
                        self.send_json({"sent": False})
                except Exception:
                    self.send_json({"sent": False})
            else:
                self.send_json({"sent": False})

    def handle_post_open_folder(self, parsed, body=None, params=None):
        folder = body.get("folder", "models")
        folder_map = {"models": MODELS_DIR, "llama": LLAMA_DIR}
        target = folder_map.get(folder, MODELS_DIR)
        target.mkdir(parents=True, exist_ok=True)
        try:
            open_folder_in_file_manager(target)
            self.send_json({"opened": True})
        except Exception as e:
            self.send_error_json(str(e), 500)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if self.is_v1_proxy_path(path):
            self.proxy_v1_request("GET", parsed)
            return

        if path == "/assets/app-logo.png":
            if not APP_LOGO_FILE.exists():
                self.send_error(404, "Logo not found")
                return
            body = APP_LOGO_FILE.read_bytes()
            Response(self).bytes(
                body,
                content_type="image/png",
                headers={"Cache-Control": "public, max-age=3600"},
            )
            return

        if path == "/" or path == "/index.html":
            super().do_GET()
            return

        if path.startswith("/api/") and not self.is_safe_request_origin():
            self.send_error_json("Forbidden", 403)
            return

        if path.startswith("/api/"):
            self.dispatch_api_request("GET", parsed)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if self.is_v1_proxy_path(path):
            self.proxy_v1_request("POST", parsed)
            return

        body = self.read_body()

        if body is None:
            self.send_error_json("Invalid or malformed JSON body", 400)
            return

        if not self.is_safe_request_origin():
            self.send_error_json("Request origin not allowed", 403)
            return

        self.dispatch_api_request("POST", parsed, body)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        body = self.read_body()

        if not self.is_safe_request_origin():
            self.send_error_json("Request origin not allowed", 403)
            return

        self.dispatch_api_request("DELETE", parsed, body)


API_ROUTER = (
    Router()
    .add("GET", "/api/status", status_routes.get_status)
    .add("GET", "/api/releases", "handle_get_releases")
    .add("GET", "/api/output", "handle_get_output")
    .add("GET", "/api/download-progress", "handle_get_download_progress")
    .add("GET", "/api/hf/download-status", hf_download_routes.get_download_status)
    .add("GET", "/api/remote-tunnel/status", "handle_get_remote_tunnel_status")
    .add("GET", "/api/llama/metrics", metrics_routes.get_metrics)
    .add("GET", "/api/models", models_routes.list_models)
    .add("GET", "/api/app-update-status", "handle_get_app_update_status")
    .add("GET", "/api/presets", presets_routes.list_presets)
    .add("POST", "/api/web-search", search_routes.search)
    .add("POST", "/api/chat/completions", chat_routes.completions)
    .add("POST", "/api/remote-tunnel/start", "handle_post_remote_tunnel_start")
    .add("POST", "/api/remote-tunnel/stop", "handle_post_remote_tunnel_stop")
    .add("POST", "/api/hf/repo-files", hf_download_routes.list_repo_files)
    .add("POST", "/api/hf/download", hf_download_routes.start_download)
    .add("POST", "/api/hf/download-cancel", hf_download_routes.cancel_download)
    .add("POST", "/api/install", "handle_post_install")
    .add("POST", "/api/update", "handle_post_update")
    .add("POST", "/api/launch", "handle_post_launch")
    .add("POST", "/api/stop", "handle_post_stop")
    .add("POST", "/api/shutdown", "handle_post_shutdown")
    .add("POST", "/api/restart", "handle_post_restart")
    .add("POST", "/api/cleanup-llama", "handle_post_cleanup_llama")
    .add("POST", "/api/app-update", "handle_post_app_update")
    .add("POST", "/api/send-input", "handle_post_send_input")
    .add("POST", "/api/presets", presets_routes.save_preset)
    .add("POST", "/api/open-folder", "handle_post_open_folder")
    .add("POST", "/api/select-file", file_picker_routes.select_file)
    .add_prefix("DELETE", "/api/presets/", presets_routes.delete_preset, "name")
)


def main():
    port = GUI_PORT
    for d in [
        MODELS_DIR,
        PRESETS_DIR,
        LLAMA_BIN_DIR,
        LLAMA_GRAMMARS_DIR,
    ]:
        d.mkdir(parents=True, exist_ok=True)

    try:
        STATE.gui_server = http.server.ThreadingHTTPServer((GUI_HOST, port), Handler)
    except OSError as e:
        if "address already in use" in str(e).lower() or e.errno == 10048:
            print(f"ERROR: Port {port} is already in use.")
            print(f"Another instance of Llama GUI may be running at http://{GUI_HOST}:{port}")
            print("Stop the other instance first, or close the browser tab and try again.")
        else:
            print(f"ERROR: Could not start server on port {port}: {e}")
        sys.exit(1)

    print(f"Llama GUI running at http://{GUI_HOST}:{port}")
    print("Press Ctrl+C to stop the server.")
    try:
        STATE.gui_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_remote_tunnel()
        stop_process()
        if STATE.gui_server is not None:
            STATE.gui_server.server_close()
            STATE.gui_server = None


if __name__ == "__main__":
    main()
