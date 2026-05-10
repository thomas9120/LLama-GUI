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
import html
import ipaddress
from html.parser import HTMLParser

try:
    import certifi
except ImportError:
    certifi = None

BASE_DIR = pathlib.Path(__file__).resolve().parent
LLAMA_DIR = BASE_DIR / "llama"
LLAMA_BIN_DIR = LLAMA_DIR / "bin"
LLAMA_GRAMMARS_DIR = LLAMA_DIR / "grammars"
MODELS_DIR = BASE_DIR / "models"
PRESETS_DIR = BASE_DIR / "presets"
CONFIG_FILE = BASE_DIR / "config.json"
UI_DIR = BASE_DIR / "ui"
APP_LOGO_FILE = BASE_DIR / "Llama-GUI Logo.png"
TOOLS_DIR = BASE_DIR / "tools"
CLOUDFLARED_DIR = TOOLS_DIR / "cloudflared"

GITHUB_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
APP_REPO_URL = "https://github.com/thomas9120/LLama-GUI.git"
WEB_SEARCH_MAX_RESULTS = 5
WEB_SEARCH_FETCH_RESULTS = 3
WEB_SEARCH_FETCH_BYTES = 512 * 1024
WEB_SEARCH_PAGE_CHARS = 12000
WEB_SEARCH_TIMEOUT = 20
WEB_SEARCH_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)


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

process = None
process_lock = threading.Lock()
output_buffer = []
output_buffer_lock = threading.Lock()
download_progress = {"total": 0, "downloaded": 0, "status": "idle", "message": ""}
download_progress_lock = threading.Lock()
install_in_progress = False
install_lock = threading.Lock()
model_download_state = {
    "status": "idle",
    "message": "",
    "total": 0,
    "downloaded": 0,
    "current_file": "",
    "model_name": "",
    "model_path": "",
    "mmproj_path": "",
}
model_download_lock = threading.Lock()
model_download_in_progress = False
model_download_cancel = threading.Event()
gui_server = None
remote_tunnel_process = None
remote_tunnel_lock = threading.Lock()
remote_tunnel_state = {
    "status": "idle",
    "url": "",
    "message": "Remote tunnel is not running.",
    "log": "",
}


def is_process_running():
    with process_lock:
        return process is not None and process.poll() is None


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
    with remote_tunnel_lock:
        if status is not None:
            remote_tunnel_state["status"] = status
        if url is not None:
            remote_tunnel_state["url"] = url
        if message is not None:
            remote_tunnel_state["message"] = message
        if log is not None:
            remote_tunnel_state["log"] = log[-6000:]
        return dict(remote_tunnel_state)


def get_remote_tunnel_snapshot():
    with remote_tunnel_lock:
        proc = remote_tunnel_process
        snapshot = dict(remote_tunnel_state)
        if proc is not None and proc.poll() is not None and snapshot["status"] in {
            "downloading",
            "starting",
            "running",
        }:
            snapshot["status"] = "error"
            snapshot["message"] = "Remote tunnel process exited."
            remote_tunnel_state.update(snapshot)
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
    global remote_tunnel_process
    log = ""
    try:
        set_remote_tunnel_state(
            status="downloading",
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
            "http://127.0.0.1:5240",
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
        with remote_tunnel_lock:
            remote_tunnel_process = proc

        pattern = re.compile(r"https://[\w.-]+\.trycloudflare\.com")
        while True:
            line = proc.stderr.readline() if proc.stderr else ""
            if not line:
                break
            log = (log + line)[-6000:]
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
        with remote_tunnel_lock:
            if remote_tunnel_process is proc:
                remote_tunnel_process = None
            current_status = remote_tunnel_state["status"]
        if current_status != "stopped":
            set_remote_tunnel_state(
                status="error",
                url="",
                message=f"Cloudflare tunnel exited with code {exit_code}.",
                log=log,
            )
    except Exception as exc:
        with remote_tunnel_lock:
            remote_tunnel_process = None
        set_remote_tunnel_state(status="error", url="", message=str(exc), log=log)


def start_remote_tunnel():
    with remote_tunnel_lock:
        proc = remote_tunnel_process
        if proc is not None and proc.poll() is None:
            return dict(remote_tunnel_state)
        if remote_tunnel_state["status"] in {"downloading", "starting"}:
            return dict(remote_tunnel_state)
        remote_tunnel_state.update(
            {
                "status": "downloading",
                "url": "",
                "message": "Preparing Cloudflare tunnel...",
                "log": "",
            }
        )
    threading.Thread(target=_start_remote_tunnel_worker, daemon=True).start()
    return get_remote_tunnel_snapshot()


def stop_remote_tunnel():
    global remote_tunnel_process
    with remote_tunnel_lock:
        proc = remote_tunnel_process
        remote_tunnel_process = None
        remote_tunnel_state.update(
            {
                "status": "stopped",
                "url": "",
                "message": "Remote tunnel stopped.",
            }
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
    with download_progress_lock:
        download_progress.update(updates)


def reset_download_progress(status="idle", message="", total=0, downloaded=0):
    with download_progress_lock:
        download_progress.clear()
        download_progress.update(
            {
                "total": total,
                "downloaded": downloaded,
                "status": status,
                "message": message,
            }
        )


def get_download_progress_snapshot():
    with download_progress_lock:
        return dict(download_progress)


def reset_model_download_state(status="idle", message="", total=0, downloaded=0):
    with model_download_lock:
        model_download_state.clear()
        model_download_state.update(
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
    with model_download_lock:
        model_download_state.update(updates)


def get_model_download_snapshot():
    with model_download_lock:
        return dict(model_download_state)


def normalize_hf_token(token):
    value = str(token or "").strip()
    return value or None


def validate_hf_repo_id(repo_id):
    value = str(repo_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise ValueError("Enter a Hugging Face repo ID like owner/model.")
    if ".." in value or value.endswith("."):
        raise ValueError("Invalid Hugging Face repo ID.")
    return value


def validate_hf_revision(revision):
    value = str(revision or "main").strip() or "main"
    if value.startswith("/") or "\\" in value or "\x00" in value or ".." in pathlib.PurePosixPath(value).parts:
        raise ValueError("Invalid Hugging Face revision.")
    return value


def validate_hf_filename(filename):
    value = str(filename or "").strip().replace("\\", "/")
    pure = pathlib.PurePosixPath(value)
    if not value or pure.is_absolute() or "\x00" in value or ".." in pure.parts:
        raise ValueError("Invalid Hugging Face filename.")
    if pure.name != pathlib.PureWindowsPath(pure.name).name:
        raise ValueError("Invalid Hugging Face filename.")
    if re.search(r'[<>:"/\\|?*]', pure.name):
        raise ValueError("Hugging Face filename is not safe to save locally.")
    if not pure.name.lower().endswith(".gguf"):
        raise ValueError("Only .gguf files can be downloaded.")
    return value


def is_mmproj_filename(filename):
    name = pathlib.PurePosixPath(str(filename or "").replace("\\", "/")).name.lower()
    stem = pathlib.Path(name).stem
    return "mmproj" in stem or stem.startswith("clip") or "projector" in stem


def slugify_repo_id(repo_id):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", repo_id).strip("._-") or "repo"


def hf_file_to_dict(file_obj):
    filename = (
        getattr(file_obj, "rfilename", None)
        or getattr(file_obj, "path", None)
        or getattr(file_obj, "name", None)
        or ""
    )
    size = getattr(file_obj, "size", None)
    if size is None:
        lfs = getattr(file_obj, "lfs", None)
        if isinstance(lfs, dict):
            size = lfs.get("size")
    try:
        size = int(size) if size is not None else None
    except (TypeError, ValueError):
        size = None
    return {"name": str(filename), "size": size, "size_mb": round(size / 1048576, 2) if size else None}


def get_hf_gguf_files(repo_id, revision="main", token=None):
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise RuntimeError("Hugging Face downloads require the huggingface_hub package. Re-run the install script.") from exc

    auth_token = token or False
    api = HfApi(token=auth_token)
    info = api.model_info(
        repo_id=repo_id,
        revision=revision,
        files_metadata=True,
        token=auth_token,
        timeout=30,
    )
    files = []
    for sibling in info.siblings or []:
        item = hf_file_to_dict(sibling)
        if item["name"].lower().endswith(".gguf"):
            files.append(item)
    files.sort(key=lambda item: item["name"].lower())
    main_files = [item for item in files if not is_mmproj_filename(item["name"])]
    mmproj_files = [item for item in files if is_mmproj_filename(item["name"])]
    return {"repo_id": repo_id, "revision": revision, "models": main_files, "mmproj": mmproj_files}


def get_hf_file_size(repo_id, filename, revision, token=None):
    try:
        from huggingface_hub import get_hf_file_metadata, hf_hub_url
    except ImportError:
        return 0

    try:
        url = hf_hub_url(repo_id=repo_id, filename=filename, revision=revision)
        metadata = get_hf_file_metadata(url, token=token or False, timeout=20)
        return int(metadata.size or 0)
    except Exception:
        return 0


def build_hf_download_url(repo_id, filename, revision):
    try:
        from huggingface_hub import hf_hub_url
    except ImportError as exc:
        raise RuntimeError("Hugging Face downloads require the huggingface_hub package. Re-run the install script.") from exc
    return hf_hub_url(repo_id=repo_id, filename=filename, revision=revision)


def download_hf_file(repo_id, filename, revision, token, dest, completed_bytes, total_bytes):
    url = build_hf_download_url(repo_id, filename, revision)
    headers = {"User-Agent": "Llama-GUI"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    tmp_path = dest.with_suffix(dest.suffix + ".part")
    downloaded = 0
    with urlopen_with_ssl(req, timeout=60) as resp, open(tmp_path, "wb") as f:
        while True:
            if model_download_cancel.is_set():
                raise InterruptedError("Download cancelled.")
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            set_model_download_state(
                downloaded=completed_bytes + downloaded,
                total=total_bytes,
                current_file=pathlib.PurePosixPath(filename).name,
            )
    tmp_path.replace(dest)
    return downloaded


def remove_partial_downloads(paths):
    for path in paths:
        tmp_path = path.with_suffix(path.suffix + ".part")
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass


def start_hf_model_download(repo_id, revision, model_file, mmproj_file, token, overwrite=False):
    global model_download_in_progress
    repo_id = validate_hf_repo_id(repo_id)
    revision = validate_hf_revision(revision)
    model_file = validate_hf_filename(model_file)
    mmproj_file = validate_hf_filename(mmproj_file) if mmproj_file else ""

    if is_mmproj_filename(model_file):
        raise ValueError("Choose a main model file, not an mmproj file.")
    if mmproj_file and not is_mmproj_filename(mmproj_file):
        raise ValueError("Choose an mmproj/projector file for the companion mmproj download.")

    model_name = pathlib.PurePosixPath(model_file).name
    model_dest = MODELS_DIR / model_name
    mmproj_dest = None
    if mmproj_file:
        mmproj_dest = MODELS_DIR / "mmproj" / slugify_repo_id(repo_id) / pathlib.PurePosixPath(mmproj_file).name

    existing = [path.name for path in [model_dest, mmproj_dest] if path and path.exists()]
    if existing and not overwrite:
        raise FileExistsError(f"Already exists: {', '.join(existing)}")

    with model_download_lock:
        if model_download_in_progress:
            raise RuntimeError("A model download is already in progress.")
        model_download_in_progress = True
    model_download_cancel.clear()

    def _worker():
        global model_download_in_progress
        destinations = [model_dest]
        if mmproj_dest:
            destinations.append(mmproj_dest)
        try:
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            if mmproj_dest:
                mmproj_dest.parent.mkdir(parents=True, exist_ok=True)
            total = get_hf_file_size(repo_id, model_file, revision, token)
            if mmproj_file:
                total += get_hf_file_size(repo_id, mmproj_file, revision, token)
            reset_model_download_state(
                status="downloading",
                message=f"Downloading {model_name}...",
                total=total,
                downloaded=0,
            )
            completed = download_hf_file(repo_id, model_file, revision, token, model_dest, 0, total)
            mmproj_path = ""
            if mmproj_file and mmproj_dest:
                set_model_download_state(message=f"Downloading {mmproj_dest.name}...")
                completed += download_hf_file(repo_id, mmproj_file, revision, token, mmproj_dest, completed, total)
                mmproj_path = str(mmproj_dest)
            set_model_download_state(
                status="done",
                message=f"Downloaded {model_name}.",
                downloaded=total or completed,
                total=total or completed,
                current_file="",
                model_name=model_name,
                model_path=str(model_dest),
                mmproj_path=mmproj_path,
            )
        except InterruptedError as exc:
            remove_partial_downloads(destinations)
            set_model_download_state(status="cancelled", message=str(exc), current_file="")
        except Exception as exc:
            remove_partial_downloads(destinations)
            set_model_download_state(status="error", message=str(exc), current_file="")
        finally:
            with model_download_lock:
                model_download_in_progress = False
            model_download_cancel.clear()

    reset_model_download_state(status="starting", message="Preparing Hugging Face download...")
    threading.Thread(target=_worker, daemon=True).start()
    return get_model_download_snapshot()


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
                with output_buffer_lock:
                    output_buffer.append(decoded)
                    if len(output_buffer) > 5000:
                        del output_buffer[:1000]
    except Exception:
        pass


def launch_process(tool, args_list):
    global process
    with process_lock:
        if process and process.poll() is None:
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

        with output_buffer_lock:
            output_buffer.clear()

        try:
            process = subprocess.Popen(
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
                target=stream_output, args=(process.stdout,), daemon=True
            ).start()
            threading.Thread(
                target=stream_output, args=(process.stderr, True), daemon=True
            ).start()
            return {"pid": process.pid, "command": " ".join(args)}
        except Exception as e:
            return {"error": str(e)}


def stop_process():
    global process
    with process_lock:
        if process and process.poll() is None:
            if sys.platform == "win32":
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            return True
        return False


def shutdown_gui_server():
    server = gui_server
    if server is None:
        return False
    stop_remote_tunnel()
    stop_process()
    threading.Thread(target=server.shutdown, daemon=True).start()
    return True


def restart_gui_server():
    server = gui_server
    if server is None:
        return False
    stop_remote_tunnel()
    stop_process()
    restart_script = str(BASE_DIR / "server.py")

    def _restart():
        try:
            time.sleep(2.5)
            for i in range(10):
                try:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.bind(("127.0.0.1", 5240))
                    sock.close()
                    break
                except OSError:
                    if i < 9:
                        time.sleep(0.5)
                    else:
                        print("WARNING: Port 5240 still in use after waiting, attempting restart anyway")
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
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise RuntimeError(f"Native file picker unavailable: {exc}") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    dialog_options = {"title": title, "parent": root}
    if initial_dir:
        dialog_options["initialdir"] = str(initial_dir)
    if filetypes:
        dialog_options["filetypes"] = filetypes

    try:
        root.update()
        selected = filedialog.askopenfilename(**dialog_options)
        return selected or ""
    finally:
        root.destroy()


class ReadableHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0
        self.block_tags = {
            "article",
            "blockquote",
            "br",
            "dd",
            "div",
            "dl",
            "dt",
            "figcaption",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "header",
            "li",
            "main",
            "nav",
            "ol",
            "p",
            "pre",
            "section",
            "table",
            "td",
            "th",
            "tr",
            "ul",
        }

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"}:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in self.block_tags:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"} and self.skip_depth:
            self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in self.block_tags:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip_depth:
            return
        text = data.strip()
        if text:
            self.parts.append(text)

    def text(self):
        raw = html.unescape(" ".join(self.parts))
        raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
        raw = re.sub(r"\n\s+", "\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def html_to_readable_text(raw_html):
    parser = ReadableHTMLParser()
    try:
        parser.feed(raw_html)
        parser.close()
        return parser.text()
    except Exception:
        text = re.sub(r"(?is)<(script|style|noscript|svg).*?</\1>", " ", raw_html)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
        text = html.unescape(text)
        return re.sub(r"\s+", " ", text).strip()


def validate_public_hostname(hostname, port):
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        return False, f"Failed to resolve host: {exc}"
    if not infos:
        return False, f"Failed to resolve host: no addresses for {hostname!r}"
    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False, f"Blocked: refusing to fetch non-public address {ip}."
    return True, ""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_page_text(url, max_chars=WEB_SEARCH_PAGE_CHARS, timeout=WEB_SEARCH_TIMEOUT):
    parsed = urllib.parse.urlparse(str(url or "").strip())
    if parsed.scheme not in {"http", "https"}:
        return {"ok": False, "error": f"Blocked: only http/https URLs are allowed (got {parsed.scheme!r})."}
    if not parsed.hostname:
        return {"ok": False, "error": "Blocked: URL is missing a hostname."}

    current_url = urllib.parse.urlunparse(parsed)
    opener = urllib.request.build_opener(
        NoRedirect,
        urllib.request.HTTPSHandler(context=SSL_CONTEXT),
    )
    for _ in range(5):
        parsed = urllib.parse.urlparse(current_url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        ok, reason = validate_public_hostname(parsed.hostname, port)
        if not ok:
            return {"ok": False, "error": reason}

        req = urllib.request.Request(
            current_url,
            headers={
                "User-Agent": WEB_SEARCH_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
            },
        )
        try:
            resp = opener.open(req, timeout=timeout)
            raw = resp.read(WEB_SEARCH_FETCH_BYTES)
            charset = resp.headers.get_content_charset() or "utf-8"
            text = html_to_readable_text(raw.decode(charset, errors="replace"))
            if len(text) > max_chars:
                text = text[:max_chars].rstrip() + f"\n\n... (truncated, {len(text)} chars total)"
            return {"ok": True, "url": current_url, "text": text or "(page returned no readable text)"}
        except urllib.error.HTTPError as exc:
            if exc.code not in {301, 302, 303, 307, 308}:
                return {"ok": False, "error": f"Failed to fetch URL: HTTP {exc.code} {getattr(exc, 'reason', '')}"}
            location = exc.headers.get("Location")
            if not location:
                return {"ok": False, "error": "Failed to fetch URL: redirect missing Location header."}
            next_url = urllib.parse.urljoin(current_url, location)
            next_parsed = urllib.parse.urlparse(next_url)
            if next_parsed.scheme not in {"http", "https"} or not next_parsed.hostname:
                return {"ok": False, "error": "Blocked: redirect target is not a valid http/https URL."}
            current_url = next_url
        except Exception as exc:
            return {"ok": False, "error": f"Failed to fetch URL: {exc}"}

    return {"ok": False, "error": "Failed to fetch URL: too many redirects."}


def web_search(query, max_results=WEB_SEARCH_MAX_RESULTS):
    query = str(query or "").strip()
    if not query:
        return {"ok": False, "error": "No query provided.", "results": []}
    try:
        from ddgs import DDGS
    except ImportError:
        return {
            "ok": False,
            "error": "Search unavailable: install dependencies again so the ddgs package is available.",
            "results": [],
        }

    try:
        rows = DDGS(timeout=WEB_SEARCH_TIMEOUT).text(query, max_results=max_results)
    except Exception as exc:
        return {"ok": False, "error": f"Search failed: {exc}", "results": []}

    results = []
    for row in rows or []:
        url = row.get("href") or row.get("url") or ""
        if not url:
            continue
        results.append(
            {
                "title": row.get("title") or url,
                "url": url,
                "snippet": row.get("body") or row.get("snippet") or "",
            }
        )
    return {"ok": True, "query": query, "results": results}


def get_latest_user_message(messages):
    for msg in reversed(messages or []):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return content.strip()
    return ""


def build_search_queries(user_text):
    query = re.sub(r"\s+", " ", str(user_text or "").strip())
    if len(query) > 180:
        query = query[:180].rsplit(" ", 1)[0]
    return [query] if query else []


def build_search_context(search_results, fetched_pages):
    sources = []
    context_parts = []
    for idx, result in enumerate(search_results, 1):
        url = result.get("url", "")
        title = result.get("title") or url
        snippet = result.get("snippet", "")
        fetched = fetched_pages.get(url, {})
        text = fetched.get("text") if fetched.get("ok") else ""
        if not text:
            text = snippet
        text = (text or "").strip()
        if len(text) > 3500:
            text = text[:3500].rstrip() + "\n... (source excerpt truncated)"
        sources.append({"index": idx, "title": title, "url": url, "snippet": snippet})
        context_parts.append(
            f"[{idx}] {title}\nURL: {url}\nSnippet: {snippet}\nContent excerpt:\n{text}"
        )

    if not context_parts:
        return "", sources

    context = (
        "You have fresh web search context below. Answer the user's question using these sources. "
        "Cite source numbers like [1] or [2] for factual claims. If the sources are insufficient, say so.\n\n"
        + "\n\n---\n\n".join(context_parts)
    )
    return context, sources


def get_local_chat_api_url(body):
    host = str(body.get("host") or "127.0.0.1").strip() or "127.0.0.1"
    try:
        port = int(body.get("port") or 8080)
    except (TypeError, ValueError):
        raise ValueError("Invalid llama-server chat port.")
    if port < 1 or port > 65535:
        raise ValueError("Invalid llama-server chat port.")
    chat_host, host_error = get_metrics_host(host)
    if not chat_host:
        raise ValueError(host_error)
    return f"http://{chat_host}:{port}/v1/chat/completions"


def get_local_interface_addresses():
    addresses = {"127.0.0.1", "::1"}
    hostnames = {socket.gethostname(), socket.getfqdn()}
    for name in hostnames:
        try:
            for info in socket.getaddrinfo(name, None):
                addresses.add(info[4][0])
        except OSError:
            pass
    return addresses


def get_metrics_host(host):
    value = str(host or "127.0.0.1").strip() or "127.0.0.1"
    if value.lower() == "localhost" or value in {"0.0.0.0", "::", "*"}:
        return "127.0.0.1", ""
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
        parsed_port = int(port or 8080)
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
            raw = resp.read(512 * 1024)
            charset = resp.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, errors="replace"), ""
    except urllib.error.HTTPError as exc:
        return None, f"llama-server metrics returned HTTP {exc.code}."
    except Exception as exc:
        return None, f"Failed to fetch llama-server metrics: {exc}"


def write_sse(wfile, data):
    if isinstance(data, str):
        payload = data
    else:
        payload = json.dumps(data)
    wfile.write(f"data: {payload}\n\n".encode("utf-8"))
    wfile.flush()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI_DIR), **kw)

    def log_message(self, format, *args):
        pass

    def end_headers(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in {"/", "/index.html"} or path.startswith("/js/") or path.startswith("/css/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"
        )
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
        self.end_headers()
        self.wfile.write(body)

    def send_sse_headers(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
        self.end_headers()

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def is_safe_request_origin(self):
        origin = self.headers.get("Origin", "")
        referer = self.headers.get("Referer", "")
        allowed = self.get_allowed_request_origins()
        if origin:
            return origin in allowed
        if referer:
            return referer.startswith(allowed)
        return True

    def get_allowed_request_origins(self):
        allowed = ["http://127.0.0.1:5240", "http://localhost:5240"]
        tunnel_url = get_remote_tunnel_snapshot().get("url")
        if tunnel_url:
            allowed.append(tunnel_url)
        return tuple(allowed)

    def get_access_control_origin(self):
        origin = self.headers.get("Origin", "")
        if origin and origin in self.get_allowed_request_origins():
            return origin
        return "http://127.0.0.1:5240"

    def handle_web_search_request(self, body):
        query = body.get("query", "")
        url = body.get("url", "")
        if url:
            self.send_json(fetch_page_text(url))
            return
        try:
            max_results = int(body.get("max_results") or WEB_SEARCH_MAX_RESULTS)
        except (TypeError, ValueError):
            max_results = WEB_SEARCH_MAX_RESULTS
        self.send_json(web_search(query, max_results=max(1, min(max_results, 10))))

    def handle_chat_completions(self, body):
        self.send_sse_headers()
        try:
            messages = list(body.get("messages") or [])
            proxied_messages = messages

            if body.get("web_search"):
                latest_user = get_latest_user_message(messages)
                queries = build_search_queries(latest_user)
                all_results = []
                fetched_pages = {}

                for query in queries:
                    write_sse(self.wfile, {"type": "web_status", "content": f"Searching: {query}"})
                    search_response = web_search(query)
                    if not search_response.get("ok"):
                        write_sse(self.wfile, {"error": {"message": search_response.get("error", "Search unavailable")}})
                        write_sse(self.wfile, "[DONE]")
                        return
                    for result in search_response.get("results", []):
                        if result.get("url") and all(r.get("url") != result.get("url") for r in all_results):
                            all_results.append(result)
                        if len(all_results) >= WEB_SEARCH_MAX_RESULTS:
                            break

                for result in all_results[:WEB_SEARCH_FETCH_RESULTS]:
                    url = result.get("url", "")
                    host = urllib.parse.urlparse(url).hostname or url
                    if host.startswith("www."):
                        host = host[4:]
                    write_sse(self.wfile, {"type": "web_status", "content": f"Reading: {host}"})
                    fetched_pages[url] = fetch_page_text(url)

                context, sources = build_search_context(all_results, fetched_pages)
                if not context:
                    write_sse(self.wfile, {"error": {"message": "Search returned no usable sources."}})
                    write_sse(self.wfile, "[DONE]")
                    return

                write_sse(self.wfile, {"type": "web_sources", "sources": sources})
                write_sse(self.wfile, {"type": "web_status", "content": "Answering..."})

                proxied_messages = []
                inserted_context = False
                for msg in messages:
                    if msg.get("role") == "system" and not inserted_context:
                        proxied_messages.append(
                            {
                                "role": "system",
                                "content": f"{msg.get('content', '').rstrip()}\n\n{context}".strip(),
                            }
                        )
                        inserted_context = True
                    else:
                        proxied_messages.append(
                            {
                                "role": msg.get("role", "user"),
                                "content": msg.get("content", ""),
                            }
                        )
                if not inserted_context:
                    proxied_messages.insert(0, {"role": "system", "content": context})

            proxy_body = dict(body)
            proxy_body["messages"] = proxied_messages
            proxy_body["stream"] = True
            proxy_body.pop("web_search", None)
            proxy_body.pop("api_url", None)
            proxy_body.pop("host", None)
            proxy_body.pop("port", None)

            api_url = get_local_chat_api_url(body)
            req = urllib.request.Request(
                api_url,
                data=json.dumps(proxy_body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                while True:
                    line = resp.readline()
                    if not line:
                        break
                    self.wfile.write(line)
                    self.wfile.flush()
                    if line.strip() == b"data: [DONE]":
                        break
        except BrokenPipeError:
            return
        except urllib.error.HTTPError as exc:
            try:
                err = exc.read().decode("utf-8", errors="replace")
            except Exception:
                err = str(exc)
            write_sse(self.wfile, {"error": {"message": f"llama-server returned HTTP {exc.code}: {err}"}})
            write_sse(self.wfile, "[DONE]")
        except Exception as exc:
            write_sse(self.wfile, {"error": {"message": str(exc)}})
            write_sse(self.wfile, "[DONE]")
        finally:
            self.close_connection = True

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/assets/app-logo.png":
            if not APP_LOGO_FILE.exists():
                self.send_error(404, "Logo not found")
                return
            body = APP_LOGO_FILE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/" or path == "/index.html":
            super().do_GET()
            return

        if path.startswith("/api/") and not self.is_safe_request_origin():
            self.send_json({"error": "Forbidden"}, 403)
            return

        if path == "/api/status":
            cfg = load_config()
            exes = {}
            for tool in LLAMA_TOOLS:
                name = get_tool_filename(tool)
                exes[name] = find_tool_executable(tool).exists()
            runtime_files = get_runtime_files()
            has_config = bool(cfg.get("tag"))
            installed = has_config and exes.get(get_tool_filename("llama-cli"), False)
            config_stale = has_config and not installed
            running = is_process_running()
            self.send_json(
                {
                    "installed": installed,
                    "config_stale": config_stale,
                    "version": cfg.get("tag"),
                    "backend": cfg.get("backend"),
                    "executables": exes,
                    "runtime_files": [d.name for d in runtime_files],
                    "runtime_files_label": "Runtime libraries",
                    "models_dir": str(MODELS_DIR),
                    "running": running,
                    "platform": CURRENT_PLATFORM,
                    "platform_label": get_platform_label(),
                    "arch": CURRENT_ARCH,
                    "executable_suffix": BINARY_SUFFIX,
                    "available_backends": [
                        {"id": key, "label": spec["label"]}
                        for key, spec in BACKEND_SPECS.items()
                    ],
                }
            )
            return

        if path == "/api/releases":
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
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/output":
            with output_buffer_lock:
                lines = list(output_buffer)
            running = is_process_running()
            self.send_json({"output": lines, "running": running})
            return

        if path == "/api/download-progress":
            self.send_json(get_download_progress_snapshot())
            return

        if path == "/api/hf/download-status":
            self.send_json(get_model_download_snapshot())
            return

        if path == "/api/remote-tunnel/status":
            self.send_json(get_remote_tunnel_snapshot())
            return

        if path == "/api/llama/metrics":
            query = urllib.parse.parse_qs(parsed.query)
            metrics_text, error = get_local_llama_metrics(
                (query.get("host") or ["127.0.0.1"])[0],
                (query.get("port") or ["8080"])[0],
            )
            if metrics_text is None:
                self.send_json({"error": error}, 502)
                return
            body = metrics_text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", self.get_access_control_origin())
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/models":
            models = []
            if MODELS_DIR.exists():
                for f in sorted(MODELS_DIR.iterdir()):
                    if f.is_file() and f.suffix.lower() == ".gguf":
                        size_mb = f.stat().st_size / (1024 * 1024)
                        models.append({"name": f.name, "size_mb": round(size_mb, 2)})
            self.send_json(models)
            return

        if path == "/api/app-update-status":
            try:
                self.send_json(get_app_update_status(fetch=True))
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/presets":
            presets = []
            if PRESETS_DIR.exists():
                for f in sorted(PRESETS_DIR.glob("*.json")):
                    try:
                        with open(f, "r") as pf:
                            presets.append({"name": f.stem, "data": json.load(pf)})
                    except Exception:
                        pass
            self.send_json(presets)
            return

        super().do_GET()

    def do_POST(self):
        global process
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        if body is None:
            self.send_json({"error": "Invalid or malformed JSON body"}, 400)
            return

        if not self.is_safe_request_origin():
            self.send_json({"error": "Request origin not allowed"}, 403)
            return

        if path == "/api/web-search":
            self.handle_web_search_request(body)
            return

        if path == "/api/chat/completions":
            self.handle_chat_completions(body)
            return

        if path == "/api/remote-tunnel/start":
            self.send_json(start_remote_tunnel())
            return

        if path == "/api/remote-tunnel/stop":
            self.send_json(stop_remote_tunnel())
            return

        if path == "/api/hf/repo-files":
            try:
                repo_id = validate_hf_repo_id(body.get("repo_id"))
                revision = validate_hf_revision(body.get("revision"))
                token = normalize_hf_token(body.get("token"))
                self.send_json(get_hf_gguf_files(repo_id, revision, token))
            except Exception as e:
                self.send_json({"error": str(e)}, 400)
            return

        if path == "/api/hf/download":
            try:
                result = start_hf_model_download(
                    repo_id=body.get("repo_id"),
                    revision=body.get("revision"),
                    model_file=body.get("model_file"),
                    mmproj_file=body.get("mmproj_file"),
                    token=normalize_hf_token(body.get("token")),
                    overwrite=bool(body.get("overwrite")),
                )
                self.send_json(result)
            except FileExistsError as e:
                self.send_json({"error": str(e), "code": "exists"}, 409)
            except Exception as e:
                self.send_json({"error": str(e)}, 400)
            return

        if path == "/api/hf/download-cancel":
            model_download_cancel.set()
            set_model_download_state(status="cancelling", message="Cancelling download...")
            self.send_json(get_model_download_snapshot())
            return

        if path == "/api/install":
            tag = body.get("tag")
            backend = body.get("backend")
            if not tag or not backend:
                self.send_json({"error": "tag and backend required"}, 400)
                return
            if backend not in BACKEND_SPECS:
                self.send_json({"error": f"Unsupported backend: {backend}"}, 400)
                return
            if is_process_running():
                self.send_json({"error": "Stop running process first"}, 400)
                return
            global install_in_progress
            with install_lock:
                if install_in_progress:
                    self.send_json({"error": "Installation already in progress"}, 409)
                    return
                install_in_progress = True

            def _install(tag, backend):
                global install_in_progress
                try:
                    install_release(tag, backend)
                finally:
                    with install_lock:
                        install_in_progress = False

            threading.Thread(
                target=_install, args=(tag, backend), daemon=True
            ).start()
            self.send_json({"status": "started"})
            return

        if path == "/api/update":
            cfg = load_config()
            tag = cfg.get("tag")
            backend = cfg.get("backend")
            if not tag or not backend:
                self.send_json({"error": "Nothing installed to update"}, 400)
                return
            if backend not in BACKEND_SPECS:
                self.send_json(
                    {"error": f"Unsupported configured backend: {backend}"}, 400
                )
                return
            if is_process_running():
                self.send_json({"error": "Stop running process first"}, 400)
                return
            with install_lock:
                if install_in_progress:
                    self.send_json({"error": "Installation already in progress"}, 409)
                    return
                install_in_progress = True
            try:
                releases = get_releases()
                latest = releases[0]["tag_name"] if releases else None
                if latest and latest != tag:

                    def _update(latest_tag, backend_name):
                        global install_in_progress
                        try:
                            install_release(latest_tag, backend_name)
                        finally:
                            with install_lock:
                                install_in_progress = False

                    threading.Thread(
                        target=_update, args=(latest, backend), daemon=True
                    ).start()
                    self.send_json({"status": "started", "from": tag, "to": latest})
                else:
                    with install_lock:
                        install_in_progress = False
                    self.send_json({"status": "already_latest"})
            except Exception as e:
                with install_lock:
                    install_in_progress = False
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/launch":
            tool = body.get("tool", "llama-cli")
            args = body.get("args", [])
            result = launch_process(tool, args)
            if "error" in result:
                self.send_json(result, 400)
            else:
                self.send_json(result)
            return

        if path == "/api/stop":
            stopped = stop_process()
            self.send_json({"stopped": stopped})
            return

        if path == "/api/shutdown":
            shutting_down = shutdown_gui_server()
            self.send_json({"shutting_down": shutting_down})
            return

        if path == "/api/restart":
            restarting = restart_gui_server()
            self.send_json({"restarting": restarting})
            return

        if path == "/api/cleanup-llama":
            if is_process_running():
                self.send_json({"error": "Stop running process first"}, 400)
                return
            try:
                removed_files = remove_llama_files()
                self.send_json({"removed_files": removed_files})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/app-update":
            try:
                result = update_app_from_git()
                if result.get("error"):
                    self.send_json(result, 400)
                else:
                    self.send_json(result)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/send-input":
            text = body.get("text", "")
            with process_lock:
                if process and process.poll() is None:
                    try:
                        if process.stdin:
                            process.stdin.write(text + "\n")
                            process.stdin.flush()
                            self.send_json({"sent": True})
                        else:
                            self.send_json({"sent": False})
                    except Exception:
                        self.send_json({"sent": False})
                else:
                    self.send_json({"sent": False})
            return

        if path == "/api/presets":
            name = body.get("name")
            data = body.get("data")
            if not name or data is None:
                self.send_json({"error": "name and data required"}, 400)
                return
            PRESETS_DIR.mkdir(parents=True, exist_ok=True)
            safe_name = re.sub(r'[<>:"/\\|?*]', "_", name)
            safe_name = safe_name.replace("..", "_").strip(". ")
            if not safe_name:
                self.send_json({"error": "Invalid preset name"}, 400)
                return
            with open(PRESETS_DIR / f"{safe_name}.json", "w") as f:
                json.dump(data, f, indent=2)
            self.send_json({"saved": True, "name": safe_name})
            return

        if path == "/api/open-folder":
            folder = body.get("folder", "models")
            folder_map = {"models": MODELS_DIR, "llama": LLAMA_DIR}
            target = folder_map.get(folder, MODELS_DIR)
            target.mkdir(parents=True, exist_ok=True)
            try:
                open_folder_in_file_manager(target)
                self.send_json({"opened": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/select-file":
            purpose = str(body.get("purpose") or "").strip().lower()
            title = str(body.get("title") or "Select File").strip() or "Select File"

            initial_dir = MODELS_DIR if purpose in {
                "model",
                "model_draft",
                "mmproj",
                "model_vocoder",
            } else BASE_DIR
            initial_dir.mkdir(parents=True, exist_ok=True)

            filetypes = [("All files", "*.*")]
            if purpose in {"model", "model_draft", "mmproj", "model_vocoder"}:
                filetypes = [
                    ("Model files", "*.gguf *.bin"),
                    ("GGUF files", "*.gguf"),
                    ("BIN files", "*.bin"),
                    ("All files", "*.*"),
                ]

            try:
                selected_path = select_file_in_native_dialog(
                    title=title,
                    initial_dir=initial_dir,
                    filetypes=filetypes,
                )
                self.send_json(
                    {
                        "selected": bool(selected_path),
                        "path": selected_path,
                    }
                )
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        self.send_error(404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        if not self.is_safe_request_origin():
            self.send_json({"error": "Request origin not allowed"}, 403)
            return

        if path.startswith("/api/presets/"):
            name = path[len("/api/presets/") :]
            safe_name = re.sub(r'[<>:"/\\|?*]', "_", urllib.parse.unquote(name))
            preset_file = PRESETS_DIR / f"{safe_name}.json"
            if preset_file.exists():
                preset_file.unlink()
                self.send_json({"deleted": True})
            else:
                self.send_json({"error": "Preset not found"}, 404)
            return

        self.send_error(404)


def main():
    global gui_server
    port = 5240
    for d in [
        MODELS_DIR,
        PRESETS_DIR,
        LLAMA_BIN_DIR,
        LLAMA_GRAMMARS_DIR,
    ]:
        d.mkdir(parents=True, exist_ok=True)

    try:
        gui_server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        if "address already in use" in str(e).lower() or e.errno == 10048:
            print(f"ERROR: Port {port} is already in use.")
            print(f"Another instance of Llama GUI may be running at http://127.0.0.1:{port}")
            print("Stop the other instance first, or close the browser tab and try again.")
        else:
            print(f"ERROR: Could not start server on port {port}: {e}")
        sys.exit(1)

    print(f"Llama GUI running at http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop the server.")
    try:
        gui_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_remote_tunnel()
        stop_process()
        if gui_server is not None:
            gui_server.server_close()
            gui_server = None


if __name__ == "__main__":
    main()
