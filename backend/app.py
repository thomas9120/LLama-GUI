import http.server
import json
import platform
import re
import socket
import ssl
import sys
import urllib.request
import urllib.parse
import urllib.error
import ipaddress

from backend.config import (
    APP_LOGO_FILE,
    CONFIG_FILE,
    GUI_HOST,
    GUI_PORT,
    LLAMA_BIN_DIR,
    LLAMA_GRAMMARS_DIR,
    LLAMA_HOST,
    LLAMA_PORT,
    MODELS_DIR,
    PRESETS_DIR,
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
    WILDCARD_BIND_HOSTS,
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
from backend.routes import install as install_routes
from backend.routes import process as process_routes
from backend.routes import search as search_routes
from backend.routes import status as status_routes
from backend.routes import tunnel as tunnel_routes
from backend.routes import git_update as git_update_routes
from backend.routes import lifecycle as lifecycle_routes
from backend.services import chat as chat_service
from backend.services import file_picker as file_picker_service
from backend.services import hf_download as hf_download_service
from backend.services import llama_manager as llama_manager_service
from backend.services import lifecycle as lifecycle_service
from backend.services import process_manager as process_service
from backend.services import tunnel as tunnel_service
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
    return llama_manager_service.build_backend_specs(CURRENT_PLATFORM, CURRENT_ARCH)


BACKEND_SPECS = build_backend_specs()

APP_CONTEXT = DEFAULT_CONTEXT
# Compatibility alias for older imports/tests. New backend code should read
# mutable server state through APP_CONTEXT.state.
STATE = APP_CONTEXT.state


def is_process_running():
    return process_service.is_process_running(APP_CONTEXT)


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
    return llama_manager_service.get_releases(APP_CONTEXT)


def get_release_by_tag(tag):
    return llama_manager_service.get_release_by_tag(APP_CONTEXT, tag)


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


def validate_runtime_dependencies(tools=None):
    return llama_manager_service.validate_runtime_dependencies(APP_CONTEXT, tools)


def configure_services(ctx=APP_CONTEXT):
    ctx.services.backend_specs = BACKEND_SPECS
    ctx.services.binary_suffix = BINARY_SUFFIX
    ctx.services.current_arch = CURRENT_ARCH
    ctx.services.current_platform = CURRENT_PLATFORM
    ctx.services.find_tool_executable = find_tool_executable
    ctx.services.get_platform_label = get_platform_label
    ctx.services.get_runtime_files = get_runtime_files
    ctx.services.get_tool_filename = get_tool_filename
    ctx.services.is_process_running = is_process_running
    ctx.services.llama_tools = LLAMA_TOOLS
    ctx.services.load_config = load_config
    ctx.services.save_config = save_config
    ctx.services.ssl_context = SSL_CONTEXT
    ctx.services.urlopen_with_ssl = urlopen_with_ssl
    ctx.services.get_llama_api_target = get_llama_api_target
    ctx.services.set_llama_api_target = set_llama_api_target
    ctx.services.get_local_llama_metrics = get_local_llama_metrics
    ctx.services.validate_runtime_dependencies = validate_runtime_dependencies


def download_file(url, dest, progress_cb=None):
    return llama_manager_service.download_file(APP_CONTEXT, url, dest, progress_cb)


def set_remote_tunnel_state(status=None, url=None, message=None, log=None):
    return tunnel_service.set_remote_tunnel_state(APP_CONTEXT, status, url, message, log)


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
    state = APP_CONTEXT.state
    with state.llama_api_target_lock:
        return state.llama_api_target.update(host=proxy_host, port=proxy_port)


def get_llama_api_target():
    state = APP_CONTEXT.state
    with state.llama_api_target_lock:
        return state.llama_api_target.snapshot()


def parse_launch_api_target(args_list):
    return process_service.parse_launch_api_target(APP_CONTEXT, args_list)


def get_remote_tunnel_snapshot():
    return tunnel_service.get_remote_tunnel_snapshot(APP_CONTEXT)


def stop_remote_tunnel():
    return tunnel_service.stop_remote_tunnel(APP_CONTEXT)


def sha256_file(filepath):
    return llama_manager_service.sha256_file(filepath)


def set_download_progress(**updates):
    llama_manager_service.set_download_progress(APP_CONTEXT, **updates)


def reset_download_progress(status="idle", message="", total=0, downloaded=0):
    llama_manager_service.reset_download_progress(APP_CONTEXT, status, message, total, downloaded)


def get_download_progress_snapshot():
    return llama_manager_service.get_download_progress_snapshot(APP_CONTEXT)


def reset_model_download_state(status="idle", message="", total=0, downloaded=0):
    APP_CONTEXT.state.model_download.replace(
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
    APP_CONTEXT.state.model_download.update(**updates)


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
    return llama_manager_service.extract_zip_file_flat(zf, info, dest_dir)


def extract_tar_member_flat(tf, member, dest_dir):
    return llama_manager_service.extract_tar_member_flat(tf, member, dest_dir)


def extract_archive_flat(archive_path):
    return llama_manager_service.extract_archive_flat(
        archive_path, LLAMA_BIN_DIR, LLAMA_GRAMMARS_DIR
    )


def install_release(tag, backend):
    return llama_manager_service.install_release(APP_CONTEXT, tag, backend, BACKEND_SPECS)


def stream_output(pipe, is_stderr=False):
    process_service.stream_output(APP_CONTEXT, pipe, is_stderr)


def launch_process(tool, args_list):
    return process_service.launch_process(APP_CONTEXT, tool, args_list)


def stop_process():
    return process_service.stop_process(APP_CONTEXT)


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


def write_sse(wfile, data):
    SseWriter(wfile).write(data)


def get_ui_asset_version():
    latest_mtime = 0
    for path in (
        UI_DIR / "index.html",
        UI_DIR / "css" / "tokens.css",
        UI_DIR / "css" / "style.css",
        UI_DIR / "js" / "flags.js",
        UI_DIR / "js" / "flag-validation.js",
        UI_DIR / "js" / "flag-core.js",
        UI_DIR / "js" / "config-flags-ui.js",
        UI_DIR / "js" / "manager.js",
        UI_DIR / "js" / "presets.js",
        UI_DIR / "js" / "app.js",
        APP_LOGO_FILE,
    ):
        try:
            latest_mtime = max(latest_mtime, int(path.stat().st_mtime))
        except OSError:
            pass
    return str(latest_mtime)


def version_ui_asset_urls(html):
    version = get_ui_asset_version()

    def replace_asset_url(match):
        attr = match.group(1)
        asset_path = match.group(2).split("?", 1)[0]
        return f'{attr}="{asset_path}?v={version}"'

    return re.sub(r'(href|src)="(/(?:css|js|assets)/[^"?#]+(?:\?[^"#]*)?)"', replace_asset_url, html)


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

    def send_versioned_index(self):
        index_path = UI_DIR / "index.html"
        try:
            html = index_path.read_text(encoding="utf-8")
        except OSError:
            self.send_error(404, "index.html not found")
            return
        body = version_ui_asset_urls(html).encode("utf-8")
        Response(self).bytes(body, content_type="text/html; charset=utf-8")

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
        return get_allowed_request_origins(
            tunnel_url,
            GUI_HOST,
            GUI_PORT,
            request_host=self.headers.get("Host", ""),
            allow_request_host_origin=GUI_HOST in WILDCARD_BIND_HOSTS,
        )

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
            self.send_versioned_index()
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
    .add("GET", "/api/releases", install_routes.get_releases)
    .add("GET", "/api/output", process_routes.get_output)
    .add("GET", "/api/download-progress", install_routes.get_download_progress)
    .add("GET", "/api/hf/download-status", hf_download_routes.get_download_status)
    .add("GET", "/api/remote-tunnel/status", tunnel_routes.get_status)
    .add("GET", "/api/llama/metrics", metrics_routes.get_metrics)
    .add("GET", "/api/models", models_routes.list_models)
    .add("GET", "/api/app-update-status", git_update_routes.get_status)
    .add("GET", "/api/presets", presets_routes.list_presets)
    .add("POST", "/api/web-search", search_routes.search)
    .add("POST", "/api/chat/completions", chat_routes.completions)
    .add("POST", "/api/remote-tunnel/start", tunnel_routes.start)
    .add("POST", "/api/remote-tunnel/stop", tunnel_routes.stop)
    .add("POST", "/api/hf/repo-files", hf_download_routes.list_repo_files)
    .add("POST", "/api/hf/download", hf_download_routes.start_download)
    .add("POST", "/api/hf/download-cancel", hf_download_routes.cancel_download)
    .add("POST", "/api/install", install_routes.start_install)
    .add("POST", "/api/update", install_routes.start_update)
    .add("POST", "/api/launch", process_routes.launch)
    .add("POST", "/api/stop", process_routes.stop)
    .add("POST", "/api/shutdown", lifecycle_routes.post_shutdown)
    .add("POST", "/api/restart", lifecycle_routes.post_restart)
    .add("POST", "/api/cleanup-llama", process_routes.cleanup_llama)
    .add("POST", "/api/app-update", git_update_routes.start_update)
    .add("POST", "/api/send-input", process_routes.send_input)
    .add("POST", "/api/presets", presets_routes.save_preset)
    .add("POST", "/api/open-folder", lifecycle_routes.post_open_folder)
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
        server_class = http.server.ThreadingHTTPServer
        if ":" in GUI_HOST:
            server_class = type(
                "ThreadingHTTPServerIPv6",
                (http.server.ThreadingHTTPServer,),
                {"address_family": socket.AF_INET6},
            )
        APP_CONTEXT.state.gui_server = server_class((GUI_HOST, port), Handler)
    except OSError as e:
        if "address already in use" in str(e).lower() or e.errno == 10048:
            print(f"ERROR: Port {port} is already in use.")
            print(f"Another instance of Llama GUI may be running at http://{GUI_HOST}:{port}")
            print("Stop the other instance first, or close the browser tab and try again.")
        else:
            print(f"ERROR: Could not start server on port {port}: {e}")
        sys.exit(1)

    print(f"Llama GUI running at http://{GUI_HOST}:{port}")
    if GUI_HOST in WILDCARD_BIND_HOSTS:
        print(f"Remote access enabled. Open http://<this-server-lan-ip>:{port} from a trusted machine.")
    print("Press Ctrl+C to stop the server.")
    try:
        APP_CONTEXT.state.gui_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        lifecycle_service.cleanup_gui_server(APP_CONTEXT)


configure_services(APP_CONTEXT)


if __name__ == "__main__":
    main()
