import http.server
import json
import os
import subprocess
import sys
import signal
import threading
import zipfile
import hashlib
import shutil
import urllib.request
import urllib.parse
import re
import time
import pathlib
import tempfile

BASE_DIR = pathlib.Path(__file__).resolve().parent
LLAMA_DIR = BASE_DIR / "llama"
LLAMA_BIN_DIR = LLAMA_DIR / "bin"
LLAMA_DLL_DIR = LLAMA_DIR / "dll"
LLAMA_GRAMMARS_DIR = LLAMA_DIR / "grammars"
MODELS_DIR = BASE_DIR / "models"
PRESETS_DIR = BASE_DIR / "presets"
CONFIG_FILE = BASE_DIR / "config.json"
UI_DIR = BASE_DIR / "ui"

GITHUB_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
APP_REPO_URL = "https://github.com/thomas9120/LLama-GUI.git"

process = None
process_lock = threading.Lock()
output_buffer = []
output_buffer_lock = threading.Lock()
download_progress = {"total": 0, "downloaded": 0, "status": "idle", "message": ""}
download_progress_lock = threading.Lock()


def load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    return {"version": None, "backend": None, "tag": None}


def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


def get_releases():
    req = urllib.request.Request(
        GITHUB_API, headers={"Accept": "application/vnd.github+json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def get_release_by_tag(tag):
    req = urllib.request.Request(
        f"{GITHUB_API}/tags/{tag}", headers={"Accept": "application/vnd.github+json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


BACKEND_ASSETS = {
    "cpu": "llama-{tag}-bin-win-cpu-x64.zip",
    "cuda-12.4": "llama-{tag}-bin-win-cuda-12.4-x64.zip",
    "cuda-13.1": "llama-{tag}-bin-win-cuda-13.1-x64.zip",
    "vulkan": "llama-{tag}-bin-win-vulkan-x64.zip",
    "sycl": "llama-{tag}-bin-win-sycl-x64.zip",
    "hip": "llama-{tag}-bin-win-hip-radeon-x64.zip",
}

CUDA_DLL_ASSETS = {
    "cuda-12.4": "cudart-llama-bin-win-cuda-12.4-x64.zip",
    "cuda-13.1": "cudart-llama-bin-win-cuda-13.1-x64.zip",
}

LLAMA_EXES = [
    "llama-cli.exe",
    "llama-server.exe",
    "llama-bench.exe",
    "llama-perplexity.exe",
    "llama-quantize.exe",
    "llama-simple.exe",
]


def download_file(url, dest, progress_cb=None):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=60) as resp:
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


def extract_zip_file_flat(zf, info, dest_dir):
    if info.is_dir():
        return

    fname = pathlib.Path(info.filename).name
    if not fname:
        return

    out_path = pathlib.Path(dest_dir) / fname
    with zf.open(info, "r") as src, open(out_path, "wb") as dst:
        shutil.copyfileobj(src, dst)


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

    bin_filename = BACKEND_ASSETS[backend].format(tag=tag)
    if bin_filename not in asset_map:
        set_download_progress(
            status="error", message=f"Asset {bin_filename} not found in release {tag}"
        )
        return False

    bin_url = asset_map[bin_filename]["browser_download_url"]
    expected_sha = asset_map[bin_filename].get("sha256", None)

    tmpdir = tempfile.mkdtemp(prefix="llama_install_")
    try:
        bin_zip = os.path.join(tmpdir, bin_filename)
        set_download_progress(message=f"Downloading {bin_filename}...")
        download_file(bin_url, bin_zip, progress_cb)

        if expected_sha:
            actual_sha = sha256_file(bin_zip)
            if actual_sha != expected_sha:
                set_download_progress(
                    status="error", message=f"SHA256 mismatch for {bin_filename}"
                )
                return False

        if backend in CUDA_DLL_ASSETS:
            dll_filename = CUDA_DLL_ASSETS[backend]
            if dll_filename in asset_map:
                dll_url = asset_map[dll_filename]["browser_download_url"]
                dll_zip = os.path.join(tmpdir, dll_filename)
                set_download_progress(message=f"Downloading {dll_filename}...")
                download_file(dll_url, dll_zip, progress_cb)

        set_download_progress(status="extracting", message="Extracting binaries...")

        for d in [LLAMA_BIN_DIR, LLAMA_GRAMMARS_DIR]:
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)

        if LLAMA_DLL_DIR.exists():
            shutil.rmtree(LLAMA_DLL_DIR)
        LLAMA_DLL_DIR.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(bin_zip, "r") as zf:
            for info in zf.infolist():
                fname = pathlib.Path(info.filename).name
                if not fname:
                    continue
                lower = fname.lower()
                if lower.endswith((".exe", ".dll", ".so", ".dylib")):
                    extract_zip_file_flat(zf, info, LLAMA_BIN_DIR)
                elif lower.endswith((".gbnf", ".json")):
                    extract_zip_file_flat(zf, info, LLAMA_GRAMMARS_DIR)
                else:
                    extract_zip_file_flat(zf, info, LLAMA_BIN_DIR)

        if backend in CUDA_DLL_ASSETS:
            dll_filename = CUDA_DLL_ASSETS[backend]
            dll_zip_path = os.path.join(tmpdir, dll_filename)
            if os.path.exists(dll_zip_path):
                with zipfile.ZipFile(dll_zip_path, "r") as zf:
                    for info in zf.infolist():
                        extract_zip_file_flat(zf, info, LLAMA_BIN_DIR)

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
                    with output_buffer_lock:
                        del output_buffer[:1000]
    except Exception:
        pass


def launch_process(tool, args_list):
    global process
    with process_lock:
        if process and process.poll() is None:
            return {"error": "A process is already running"}

    exe_name = f"{tool}.exe"
    exe_path = LLAMA_BIN_DIR / exe_name
    if not exe_path.exists():
        return {"error": f"{exe_name} not found. Install llama.cpp first."}

    args = [str(exe_path)]
    for entry in args_list:
        if isinstance(entry, list):
            args.extend(str(v) for v in entry)
        else:
            args.append(str(entry))

    env = os.environ.copy()
    dll_path = str(LLAMA_DLL_DIR)
    if "PATH" in env:
        env["PATH"] = dll_path + ";" + env["PATH"]
    else:
        env["PATH"] = dll_path

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


def remove_llama_files():
    removed_files = 0

    if LLAMA_DIR.exists():
        for path in LLAMA_DIR.rglob("*"):
            if path.is_file():
                removed_files += 1

    if LLAMA_DIR.exists():
        shutil.rmtree(LLAMA_DIR)

    for d in [LLAMA_BIN_DIR, LLAMA_DLL_DIR, LLAMA_GRAMMARS_DIR]:
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

    dirty_res = run_git(["status", "--porcelain"])
    if dirty_res.returncode != 0:
        return {
            "available": True,
            "can_update": False,
            "reason": (dirty_res.stderr or "Unable to inspect git status").strip(),
            "repo_url": APP_REPO_URL,
            "origin_url": origin_url,
            "branch": branch,
        }
    has_local_changes = bool(dirty_res.stdout.strip())

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

    can_update = state == "behind" and not has_local_changes

    return {
        "available": True,
        "can_update": can_update,
        "repo_url": APP_REPO_URL,
        "origin_url": origin_url,
        "branch": branch,
        "dirty": has_local_changes,
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
        if status.get("dirty"):
            return {
                "updated": False,
                "error": "Cannot auto-update with local changes. Commit or stash first.",
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

    return {
        "updated": True,
        "message": (pull_res.stdout or "Updated successfully").strip(),
        "status": get_app_update_status(fetch=False),
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI_DIR), **kw)

    def log_message(self, format, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/" or path == "/index.html":
            super().do_GET()
            return

        if path == "/api/status":
            cfg = load_config()
            exes = {}
            for name in LLAMA_EXES:
                p = LLAMA_BIN_DIR / name
                exes[name] = p.exists()
            dlls = list(LLAMA_BIN_DIR.glob("*.dll")) if LLAMA_BIN_DIR.exists() else []
            has_config = bool(cfg.get("tag"))
            installed = has_config and exes.get("llama-cli.exe", False)
            config_stale = has_config and not installed
            running = process and process.poll() is None
            self.send_json(
                {
                    "installed": installed,
                    "config_stale": config_stale,
                    "version": cfg.get("tag"),
                    "backend": cfg.get("backend"),
                    "executables": exes,
                    "dlls": [d.name for d in dlls],
                    "models_dir": str(MODELS_DIR),
                    "running": running,
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
            running = process and process.poll() is None
            self.send_json({"output": lines, "running": running})
            return

        if path == "/api/download-progress":
            self.send_json(get_download_progress_snapshot())
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

        if path == "/api/install":
            tag = body.get("tag")
            backend = body.get("backend")
            if not tag or not backend:
                self.send_json({"error": "tag and backend required"}, 400)
                return
            if backend not in BACKEND_ASSETS:
                self.send_json({"error": f"Unsupported backend: {backend}"}, 400)
                return
            if process and process.poll() is None:
                self.send_json({"error": "Stop running process first"}, 400)
                return
            threading.Thread(
                target=install_release, args=(tag, backend), daemon=True
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
            if backend not in BACKEND_ASSETS:
                self.send_json(
                    {"error": f"Unsupported configured backend: {backend}"}, 400
                )
                return
            if process and process.poll() is None:
                self.send_json({"error": "Stop running process first"}, 400)
                return
            try:
                releases = get_releases()
                latest = releases[0]["tag_name"] if releases else None
                if latest and latest != tag:
                    threading.Thread(
                        target=install_release, args=(latest, backend), daemon=True
                    ).start()
                    self.send_json({"status": "started", "from": tag, "to": latest})
                else:
                    self.send_json({"status": "already_latest"})
            except Exception as e:
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

        if path == "/api/cleanup-llama":
            if process and process.poll() is None:
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
            with open(PRESETS_DIR / f"{safe_name}.json", "w") as f:
                json.dump(data, f, indent=2)
            self.send_json({"saved": True, "name": safe_name})
            return

        if path == "/api/open-folder":
            folder = body.get("folder", "models")
            folder_map = {"models": MODELS_DIR, "llama": LLAMA_DIR}
            target = folder_map.get(folder, MODELS_DIR)
            target.mkdir(parents=True, exist_ok=True)
            os.startfile(str(target))
            self.send_json({"opened": True})
            return

        self.send_error(404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.read_body()

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
    port = 5240
    for d in [
        MODELS_DIR,
        PRESETS_DIR,
        LLAMA_BIN_DIR,
        LLAMA_DLL_DIR,
        LLAMA_GRAMMARS_DIR,
    ]:
        d.mkdir(parents=True, exist_ok=True)

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    print(f"Llama GUI running at http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop the server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_process()
        server.server_close()


if __name__ == "__main__":
    main()
