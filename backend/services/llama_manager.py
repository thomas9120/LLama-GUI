"""llama.cpp release management, download, and install helpers."""

import copy
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from typing import Any, Callable, Iterable, Mapping, Optional

from ..context import AppContext
from ..http import sanitize_error


RPATH_LIBRARY_RE = re.compile(r"^\s*@rpath/([^\s(]+)")
LDD_NOT_FOUND_RE = re.compile(r"^\s*([^\s]+)\s+=>\s+not found\s*$")
SHA256_DIGEST_RE = re.compile(r"^sha256:([0-9a-fA-F]{64})$")

# Runtime dependency validation shells out to otool on macOS and ldd on Linux,
# so results are cached briefly. Config-changing operations (install, cleanup,
# backend activation) clear the cache to keep /api/status fresh.
RUNTIME_HEALTH_CACHE_TTL_SECONDS = 5.0

# Optional llamacpp-rocm backend (https://github.com/lemonade-sdk/llamacpp-rocm).
# Publishes nightly ROCm 7 llama.cpp archives for Windows and Ubuntu, one asset
# per AMD GPU target. Users must choose the target matching their GPU arch.
LEMONADE_ROCM_REPO_API = (
    "https://api.github.com/repos/lemonade-sdk/llamacpp-rocm/releases"
)
CUSTOM_BACKEND_SPEC = {"label": "Custom (User-Provided)"}

# (gpu_target, family label) for every target upstream publishes.
LEMONADE_ROCM_TARGETS = [
    ("gfx103X", "AMD RDNA2"),
    ("gfx110X", "AMD RDNA3"),
    ("gfx1150", "Ryzen AI 300"),
    ("gfx1151", "Ryzen AI"),
    ("gfx120X", "AMD RDNA4"),
    ("gfx90a", "AMD CDNA2"),
    ("gfx908", "AMD CDNA1"),
]


def _lemonade_rocm_backend(platform_token: str, gpu_target: str, family: str) -> dict[str, Any]:
    return {
        "label": f"ROCm 7 {gpu_target} ({family}, Lemonade)",
        "asset": f"llama-{{tag}}-{platform_token}-rocm-{gpu_target}-x64.zip",
        "provider": "lemonade-rocm",
        "repo_api": LEMONADE_ROCM_REPO_API,
        "preserve_paths": True,
        "gpu_target": gpu_target,
    }


def _lemonade_rocm_specs(platform_token: str) -> dict[str, dict[str, Any]]:
    return {
        f"lemonade-rocm-{gpu_target}": _lemonade_rocm_backend(platform_token, gpu_target, family)
        for gpu_target, family in LEMONADE_ROCM_TARGETS
    }


def resolve_repo_api(spec: Mapping[str, Any], ctx: AppContext) -> str:
    """Return the GitHub releases API for a backend spec.

    Lemonade ROCm specs carry their own ``repo_api``. Official llama.cpp specs
    omit it and fall back to the configured official API.
    """
    return spec.get("repo_api") or ctx.config.github_api


def build_backend_specs(current_platform: str, current_arch: str) -> dict[str, Any]:
    def with_custom(specs: dict[str, Any]) -> dict[str, Any]:
        return {**specs, "custom": dict(CUSTOM_BACKEND_SPEC)}

    if current_platform == "win32":
        if current_arch == "arm64":
            return with_custom({
                "cpu": {
                    "label": "CPU",
                    "asset": "llama-{tag}-bin-win-cpu-arm64.zip",
                },
                "opencl-adreno": {
                    "label": "OpenCL (Adreno)",
                    "asset": "llama-{tag}-bin-win-opencl-adreno-arm64.zip",
                },
            })
        specs = {
            "cpu": {"label": "CPU", "asset": "llama-{tag}-bin-win-cpu-x64.zip"},
            "cuda-12.4": {
                "label": "CUDA 12.4 (NVIDIA)",
                "asset": "llama-{tag}-bin-win-cuda-12.4-x64.zip",
                "extra_assets": ["cudart-llama-bin-win-cuda-12.4-x64.zip"],
            },
            "cuda-13.3": {
                "label": "CUDA 13.3 (NVIDIA)",
                "asset": "llama-{tag}-bin-win-cuda-13.3-x64.zip",
                "extra_assets": ["cudart-llama-bin-win-cuda-13.3-x64.zip"],
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
                "label": "ROCm 7.14 (AMD, Official)",
                "asset": "llama-{tag}-bin-win-rocm-7.14-x64.zip",
            },
            "openvino": {
                "label": "OpenVINO",
                "asset": "llama-{tag}-bin-win-openvino-2026.2.1-x64.zip",
            },
        }
        specs.update(_lemonade_rocm_specs("windows"))
        return with_custom(specs)

    if current_platform == "darwin":
        if current_arch == "arm64":
            return with_custom({
                "metal": {
                    "label": "Metal (Apple Silicon)",
                    "asset": "llama-{tag}-bin-macos-arm64.tar.gz",
                },
            })
        if current_arch == "x64":
            return with_custom({
                "cpu": {
                    "label": "CPU (Intel Mac)",
                    "asset": "llama-{tag}-bin-macos-x64.tar.gz",
                },
            })
        return with_custom({})

    if current_platform.startswith("linux"):
        if current_arch == "x64":
            specs = {
                "cpu": {"label": "CPU", "asset": "llama-{tag}-bin-ubuntu-x64.tar.gz"},
                "vulkan": {
                    "label": "Vulkan",
                    "asset": "llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz",
                },
                "rocm": {
                    "label": "ROCm 7.14 (AMD, Official)",
                    "asset": "llama-{tag}-bin-ubuntu-rocm-7.14-x64.tar.gz",
                },
                "openvino": {
                    "label": "OpenVINO",
                    "asset": "llama-{tag}-bin-ubuntu-openvino-2026.2.1-x64.tar.gz",
                },
            }
            specs.update(_lemonade_rocm_specs("ubuntu"))
            return with_custom(specs)
        if current_arch == "arm64":
            return with_custom({
                "cpu": {
                    "label": "CPU",
                    "asset": "llama-{tag}-bin-ubuntu-arm64.tar.gz",
                },
                "vulkan": {
                    "label": "Vulkan",
                    "asset": "llama-{tag}-bin-ubuntu-vulkan-arm64.tar.gz",
                },
            })
        if current_arch == "s390x":
            return with_custom({
                "cpu": {
                    "label": "CPU",
                    "asset": "llama-{tag}-bin-ubuntu-s390x.tar.gz",
                },
            })
        return with_custom({})
    return with_custom({})


def get_releases(
    ctx: AppContext,
    repo_api: Optional[str] = None,
    *,
    page: Optional[int] = None,
    per_page: Optional[int] = None,
) -> list[dict[str, Any]]:
    api_url = repo_api or ctx.config.github_api
    pagination = {
        key: value
        for key, value in (("page", page), ("per_page", per_page))
        if value is not None
    }
    if pagination:
        separator = "&" if "?" in api_url else "?"
        api_url = f"{api_url}{separator}{urllib.parse.urlencode(pagination)}"
    req = urllib.request.Request(
        api_url,
        headers={"Accept": "application/vnd.github+json"},
    )
    with ctx.services.urlopen_with_ssl(req, timeout=30) as resp:
        return json.loads(resp.read())


def get_release_by_tag(
    ctx: AppContext, tag: str, repo_api: Optional[str] = None
) -> dict[str, Any]:
    api_url = repo_api or ctx.config.github_api
    req = urllib.request.Request(
        f"{api_url}/tags/{tag}",
        headers={"Accept": "application/vnd.github+json"},
    )
    with ctx.services.urlopen_with_ssl(req, timeout=30) as resp:
        return json.loads(resp.read())


def sha256_file(filepath: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def get_release_asset_sha256(asset: Mapping[str, Any], filename: str) -> Optional[str]:
    """Return GitHub's SHA256 asset digest, or allow legacy metadata to proceed.

    GitHub publishes release asset hashes as ``digest: sha256:<hex>``. Older
    releases and non-GitHub providers may omit that field, so an unavailable or
    unsupported digest stays warning-only instead of blocking installation.
    """
    digest = asset.get("digest")
    match = SHA256_DIGEST_RE.fullmatch(digest.strip()) if isinstance(digest, str) else None
    if match:
        return match.group(1).lower()

    detail = "missing" if digest in (None, "") else "unsupported or malformed"
    print(
        f"WARNING: SHA256 digest metadata is {detail} for release asset {filename}; "
        "checksum verification is unavailable.",
        file=sys.stderr,
    )
    return None


def set_download_progress(ctx: AppContext, **updates: Any) -> dict[str, Any]:
    return ctx.state.download_progress.update(**updates)


def reset_download_progress(
    ctx: AppContext,
    status: str = "idle",
    message: str = "",
    total: int = 0,
    downloaded: int = 0,
) -> dict[str, Any]:
    return ctx.state.download_progress.replace(
        {
            "total": total,
            "downloaded": downloaded,
            "status": status,
            "message": message,
        }
    )


def get_download_progress_snapshot(ctx: AppContext) -> dict[str, Any]:
    return ctx.state.download_progress.snapshot()


def parse_otool_rpath_libraries(output: str) -> list[str]:
    libraries: list[str] = []
    seen = set()
    for line in (output or "").splitlines():
        match = RPATH_LIBRARY_RE.match(line)
        if not match:
            continue
        name = pathlib.PurePosixPath(match.group(1)).name
        if name and name not in seen:
            seen.add(name)
            libraries.append(name)
    return libraries


def get_macos_rpath_libraries(executable: pathlib.Path) -> list[str]:
    result = subprocess.run(
        ["otool", "-L", str(executable)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return parse_otool_rpath_libraries(result.stdout)


def parse_ldd_missing_libraries(output: str) -> list[str]:
    """Return unresolved shared-library names from Linux ``ldd`` output."""
    libraries: list[str] = []
    seen: set[str] = set()
    for line in (output or "").splitlines():
        match = LDD_NOT_FOUND_RE.match(line)
        if not match:
            continue
        name = pathlib.PurePosixPath(match.group(1)).name
        if name and name not in seen:
            seen.add(name)
            libraries.append(name)
    return libraries


def get_linux_missing_libraries(
    executable: pathlib.Path, runtime_dir: pathlib.Path
) -> list[str]:
    """Inspect a Linux executable using the same local library path as launch."""
    env = os.environ.copy()
    existing_path = env.get("PATH", "")
    existing_ld = env.get("LD_LIBRARY_PATH", "")
    env["PATH"] = os.pathsep.join(
        [str(runtime_dir), *([existing_path] if existing_path else [])]
    )
    env["LD_LIBRARY_PATH"] = os.pathsep.join(
        [str(runtime_dir), *([existing_ld] if existing_ld else [])]
    )
    result = subprocess.run(
        ["ldd", str(executable)],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )
    output = "\n".join(part for part in (result.stdout, result.stderr) if part)
    missing = parse_ldd_missing_libraries(output)
    if result.returncode != 0 and not missing:
        raise subprocess.CalledProcessError(
            result.returncode,
            result.args,
            output=result.stdout,
            stderr=result.stderr,
        )
    return missing


def get_linux_runtime_probe_files(runtime_dir: pathlib.Path) -> list[pathlib.Path]:
    """Return packaged ggml backend libraries whose transitive deps matter."""
    return sorted(
        path
        for path in runtime_dir.glob("libggml*.so*")
        if path.is_file()
    )


def validate_runtime_dependencies(
    ctx: AppContext, tools: Optional[Iterable[str]] = None
) -> dict[str, Any]:
    current_platform = ctx.services.current_platform or sys.platform
    if current_platform == "unknown":
        current_platform = sys.platform
    if current_platform != "darwin" and not current_platform.startswith("linux"):
        return {
            "ok": True,
            "checked": False,
            "required_runtime_files": [],
            "missing_runtime_files": [],
        }

    tool_names = tuple(tools) if tools is not None else ()
    if not tool_names:
        tool_names = ("llama-cli", "llama-server")

    try:
        cfg = dict(ctx.services.load_config())
    except Exception as e:
        print(f"[llama_manager] load_config failed during runtime validation: {e}", file=sys.stderr)
        cfg = {}

    cache_key = (cfg.get("backend"), tool_names)
    now = time.monotonic()
    with ctx.state.runtime_health_lock:
        cached = ctx.state.runtime_health_cache.get(cache_key)
        if cached is not None and now - cached[0] < RUNTIME_HEALTH_CACHE_TTL_SECONDS:
            return copy.deepcopy(cached[1])

    result = _validate_runtime_dependencies_uncached(ctx, tool_names, cfg)
    with ctx.state.runtime_health_lock:
        ctx.state.runtime_health_cache[cache_key] = (time.monotonic(), result)
    return copy.deepcopy(result)


def _validate_runtime_dependencies_uncached(
    ctx: AppContext, tool_names: tuple[str, ...], cfg: Mapping[str, Any]
) -> dict[str, Any]:
    required: set[str] = set()
    checked_tools: list[str] = []
    unchecked_tools: list[str] = []
    missing_executables: list[str] = []
    checked_runtime_files: list[str] = []
    unchecked_runtime_files: list[str] = []
    current_platform = ctx.services.current_platform or sys.platform
    if current_platform == "unknown":
        current_platform = sys.platform
    runtime_dir = (
        ctx.paths.llama_custom_bin
        if cfg.get("backend") == "custom"
        else ctx.paths.llama_bin
    )

    for tool in tool_names:
        exe_path = ctx.services.find_tool_executable(tool)
        if not exe_path.exists():
            missing_executables.append(ctx.services.get_tool_filename(tool))
            continue
        try:
            if current_platform == "darwin":
                required.update(get_macos_rpath_libraries(exe_path))
            else:
                required.update(get_linux_missing_libraries(exe_path, runtime_dir))
            checked_tools.append(tool)
        except (
            FileNotFoundError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            OSError,
        ):
            unchecked_tools.append(tool)

    if current_platform.startswith("linux"):
        for library_path in get_linux_runtime_probe_files(runtime_dir):
            try:
                required.update(
                    get_linux_missing_libraries(library_path, runtime_dir)
                )
                checked_runtime_files.append(library_path.name)
            except (
                FileNotFoundError,
                subprocess.CalledProcessError,
                subprocess.TimeoutExpired,
                OSError,
            ):
                unchecked_runtime_files.append(library_path.name)

    missing_runtime_files = (
        sorted(name for name in required if not (runtime_dir / name).exists())
        if current_platform == "darwin"
        else sorted(required)
    )
    return {
        "ok": not missing_runtime_files,
        "checked": bool(checked_tools),
        "checked_tools": checked_tools,
        "unchecked_tools": unchecked_tools,
        "checked_runtime_files": checked_runtime_files,
        "unchecked_runtime_files": unchecked_runtime_files,
        "required_runtime_files": sorted(required),
        "missing_runtime_files": missing_runtime_files,
        "missing_executables": missing_executables,
    }


def activate_custom_backend(ctx: AppContext) -> dict[str, Any]:
    try:
        ctx.paths.llama_custom_bin.mkdir(parents=True, exist_ok=True)
        ctx.paths.llama_custom_grammars.mkdir(parents=True, exist_ok=True)

        required = {
            ctx.services.get_tool_filename("llama-cli"),
            ctx.services.get_tool_filename("llama-server"),
        }
        current_platform = ctx.services.current_platform or sys.platform
        require_executable = current_platform != "win32"
        found: list[str] = []
        missing: list[str] = []
        not_executable: list[str] = []
        for tool in ctx.services.llama_tools:
            exe_name = ctx.services.get_tool_filename(tool)
            exe_path = ctx.paths.llama_custom_bin / exe_name
            if exe_path.exists():
                found.append(exe_name)
                if exe_name in required and require_executable and not os.access(exe_path, os.X_OK):
                    not_executable.append(exe_name)
            else:
                missing.append(exe_name)

        missing_required = sorted(name for name in required if name not in found)
        if missing_required or not_executable:
            return {
                "ok": False,
                "found": found,
                "missing": missing,
                "missing_required": missing_required,
                "not_executable": sorted(not_executable),
            }

        runtime_health = _validate_custom_runtime_dependencies(ctx, required)
        if not runtime_health.get("ok", True):
            return {
                "ok": False,
                "found": found,
                "missing": missing,
                "missing_required": [],
                "not_executable": [],
                "runtime_health": runtime_health,
                "missing_runtime_files": runtime_health.get("missing_runtime_files", []),
            }

        with ctx.state.config_lock:
            cfg = dict(ctx.services.load_config())
            if cfg.get("backend") and cfg.get("backend") != "custom" and cfg.get("tag"):
                cfg["official_install"] = {
                    "backend": cfg["backend"],
                    "tag": cfg["tag"],
                    "version": cfg.get("version") or cfg["tag"],
                }
            cfg["version"] = "custom"
            cfg["backend"] = "custom"
            cfg["tag"] = "custom"
            ctx.services.save_config(cfg)
        ctx.state.clear_runtime_health_cache()
        return {
            "ok": True,
            "found": found,
            "missing": missing,
            "missing_required": [],
            "not_executable": [],
            "runtime_health": runtime_health,
        }
    except Exception as e:
        print(f"[llama_manager] activate_custom_backend failed: {e}", file=sys.stderr)
        return {"ok": False, "error": sanitize_error(e, 500)}


def get_official_install_status(
    ctx: AppContext, cfg: Optional[Mapping[str, Any]] = None
) -> dict[str, Any]:
    cfg = cfg or ctx.services.load_config()
    stored = cfg.get("official_install")
    stored = stored if isinstance(stored, Mapping) else {}

    backend = stored.get("backend")
    tag = stored.get("tag")
    version = stored.get("version")
    if cfg.get("backend") and cfg.get("backend") != "custom" and cfg.get("tag"):
        backend = cfg.get("backend")
        tag = cfg.get("tag")
        version = cfg.get("version") or tag

    current_platform = ctx.services.current_platform or sys.platform
    if current_platform == "unknown":
        current_platform = sys.platform
    files_present = all(
        (ctx.paths.llama_bin / ctx.services.get_tool_filename(tool)).is_file()
        and (
            current_platform == "win32"
            or os.access(
                ctx.paths.llama_bin / ctx.services.get_tool_filename(tool), os.X_OK
            )
        )
        for tool in ("llama-cli", "llama-server")
    )
    return {
        "backend": str(backend).strip() if backend else None,
        "tag": str(tag).strip() if tag else None,
        "version": str(version).strip() if version else None,
        "files_present": files_present,
    }


def _probe_official_build(ctx: AppContext) -> tuple[bool, Optional[str]]:
    executable = ctx.paths.llama_bin / ctx.services.get_tool_filename("llama-cli")
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            cwd=ctx.paths.llama_bin,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, None
    if result.returncode != 0:
        return False, None
    match = re.search(r"\bbuild\s+(\d+)\b", result.stdout + "\n" + result.stderr, re.I)
    return True, f"b{match.group(1)}" if match else None


def activate_official_backend(ctx: AppContext, backend: str) -> dict[str, Any]:
    cfg = dict(ctx.services.load_config())
    official = get_official_install_status(ctx, cfg)
    if not official["files_present"]:
        return {
            "ok": False,
            "error": "Existing official llama.cpp files were not found.",
        }
    if official["backend"] and official["backend"] != backend:
        return {
            "ok": False,
            "error": f"The existing official installation is {official['backend']}, not {backend}.",
        }

    runtime_ok, detected_tag = _probe_official_build(ctx)
    if not runtime_ok:
        return {
            "ok": False,
            "error": "The existing official llama.cpp runtime could not be started.",
        }

    tag = official["tag"] or detected_tag
    if not tag:
        return {
            "ok": False,
            "error": "Could not determine the version of the existing official installation.",
        }

    version = official["version"] or tag
    record = {"backend": backend, "tag": tag, "version": version}
    with ctx.state.config_lock:
        cfg = dict(ctx.services.load_config())
        cfg.update({"backend": backend, "tag": tag, "version": version})
        cfg["official_install"] = record
        ctx.services.save_config(cfg)
    ctx.state.clear_runtime_health_cache()
    return {"ok": True, **record}


def _validate_custom_runtime_dependencies(
    ctx: AppContext, executable_names: Iterable[str]
) -> dict[str, Any]:
    current_platform = ctx.services.current_platform or sys.platform
    if current_platform == "unknown":
        current_platform = sys.platform
    if current_platform != "darwin" and not current_platform.startswith("linux"):
        return {
            "ok": True,
            "checked": False,
            "required_runtime_files": [],
            "missing_runtime_files": [],
        }

    required: set[str] = set()
    checked_tools: list[str] = []
    unchecked_tools: list[str] = []
    checked_runtime_files: list[str] = []
    unchecked_runtime_files: list[str] = []

    for exe_name in executable_names:
        exe_path = ctx.paths.llama_custom_bin / exe_name
        try:
            if current_platform == "darwin":
                required.update(get_macos_rpath_libraries(exe_path))
            else:
                required.update(
                    get_linux_missing_libraries(exe_path, ctx.paths.llama_custom_bin)
                )
            checked_tools.append(exe_name)
        except (
            FileNotFoundError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            OSError,
        ):
            unchecked_tools.append(exe_name)

    if current_platform.startswith("linux"):
        for library_path in get_linux_runtime_probe_files(ctx.paths.llama_custom_bin):
            try:
                required.update(
                    get_linux_missing_libraries(
                        library_path, ctx.paths.llama_custom_bin
                    )
                )
                checked_runtime_files.append(library_path.name)
            except (
                FileNotFoundError,
                subprocess.CalledProcessError,
                subprocess.TimeoutExpired,
                OSError,
            ):
                unchecked_runtime_files.append(library_path.name)

    missing_runtime_files = (
        sorted(
            name
            for name in required
            if not (ctx.paths.llama_custom_bin / name).exists()
        )
        if current_platform == "darwin"
        else sorted(required)
    )
    return {
        "ok": not missing_runtime_files,
        "checked": bool(checked_tools),
        "checked_tools": checked_tools,
        "unchecked_tools": unchecked_tools,
        "checked_runtime_files": checked_runtime_files,
        "unchecked_runtime_files": unchecked_runtime_files,
        "required_runtime_files": sorted(required),
        "missing_runtime_files": missing_runtime_files,
    }


def download_file(
    ctx: AppContext,
    url: str,
    dest: pathlib.Path,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> int:
    req = urllib.request.Request(url)
    with ctx.services.urlopen_with_ssl(req, timeout=60) as resp:
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


def extract_zip_file_flat(
    zf: zipfile.ZipFile, info: zipfile.ZipInfo, dest_dir: pathlib.Path
) -> None:
    if info.is_dir():
        return

    fname = pathlib.Path(info.filename).name
    if not fname:
        return

    out_path = dest_dir / fname
    with zf.open(info, "r") as src, open(out_path, "wb") as dst:
        shutil.copyfileobj(src, dst)


def extract_tar_member_flat(
    tf: tarfile.TarFile, member: tarfile.TarInfo, dest_dir: pathlib.Path
) -> None:
    fname = pathlib.Path(member.name).name
    if not fname:
        return

    out_path = dest_dir / fname

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
        target_path = dest_dir / target_name
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


def extract_archive_flat(
    archive_path: pathlib.Path,
    llama_bin_dir: pathlib.Path,
    llama_grammars_dir: pathlib.Path,
) -> None:
    lower_name = archive_path.name.lower()
    if lower_name.endswith(".zip"):
        with zipfile.ZipFile(archive_path, "r") as zf:
            for info in zf.infolist():
                fname = pathlib.Path(info.filename).name
                if not fname:
                    continue
                lower = fname.lower()
                if lower.endswith((".gbnf", ".json")):
                    extract_zip_file_flat(zf, info, llama_grammars_dir)
                else:
                    extract_zip_file_flat(zf, info, llama_bin_dir)
        return

    if lower_name.endswith((".tar.gz", ".tgz")):
        with tarfile.open(archive_path, "r:gz") as tf:
            for member in tf.getmembers():
                fname = pathlib.Path(member.name).name
                if not fname:
                    continue
                lower = fname.lower()
                if lower.endswith((".gbnf", ".json")):
                    extract_tar_member_flat(tf, member, llama_grammars_dir)
                else:
                    extract_tar_member_flat(tf, member, llama_bin_dir)
        return

    raise ValueError(f"Unsupported archive format: {archive_path.name}")


def _safe_preserve_target(dest_root: pathlib.Path, member_name: str) -> Optional[pathlib.Path]:
    """Resolve an archive member to a path under dest_root, or None if unsafe.

    Rejects absolute paths and ``..`` traversal so a malicious/crafted archive
    cannot escape the destination directory. Member names use POSIX
    separators; backslashes are normalized defensively.
    """
    raw = (member_name or "").replace("\\", "/")
    rel = pathlib.PurePosixPath(raw)
    parts = [p for p in rel.parts if p not in (".", "")]
    if not parts:
        return None
    if rel.is_absolute() or ".." in parts:
        return None
    return dest_root.joinpath(*parts)


def extract_archive_preserve_paths(
    archive_path: pathlib.Path,
    dest_root: pathlib.Path,
) -> None:
    """Extract an archive preserving its nested directory layout under dest_root.

    Used for Lemonade ROCm packages, which bundle ROCm runtime data in nested
    directories (e.g. ``hipblaslt/``, ``rocblas/``) that the flat extractor
    would destroy. Absolute and path-traversal entries are skipped. Archive
    links are skipped for safety.
    """
    lower_name = archive_path.name.lower()
    if lower_name.endswith(".zip"):
        with zipfile.ZipFile(archive_path, "r") as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                target = _safe_preserve_target(dest_root, info.filename)
                if target is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    os.chmod(target, mode)
        return

    if lower_name.endswith((".tar.gz", ".tgz")):
        with tarfile.open(archive_path, "r:gz") as tf:
            for member in tf.getmembers():
                if member.issym() or member.islnk():
                    continue
                if not member.isfile():
                    continue
                target = _safe_preserve_target(dest_root, member.name)
                if target is None:
                    continue
                src = tf.extractfile(member)
                if src is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                if member.mode:
                    os.chmod(target, member.mode)
        return

    raise ValueError(f"Unsupported archive format: {archive_path.name}")


def _swap_directory_into_place(staged: pathlib.Path, target: pathlib.Path) -> None:
    """Move ``staged`` onto ``target``, keeping the previous copy until it lands.

    Both paths are siblings so this is a rename rather than a copy, which matters
    for multi-gigabyte backends. If the move fails the old directory is put back,
    so a failed install never leaves the tool directory missing.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    previous = target.with_name(target.name + ".old")
    shutil.rmtree(previous, ignore_errors=True)

    had_previous = target.exists()
    if had_previous:
        os.replace(target, previous)
    try:
        os.replace(staged, target)
    except Exception:
        if had_previous and not target.exists():
            os.replace(previous, target)
        raise
    shutil.rmtree(previous, ignore_errors=True)


def ensure_installed_tool_executables(ctx: AppContext) -> list[str]:
    """Add executable bits to downloaded llama.cpp tools on Unix platforms."""
    current_platform = ctx.services.current_platform
    if current_platform == "unknown":
        current_platform = sys.platform
    if current_platform == "win32":
        return []

    repaired: list[str] = []
    for tool in ctx.services.llama_tools:
        filename = ctx.services.get_tool_filename(tool)
        tool_path = ctx.paths.llama_bin / filename
        if not tool_path.is_file():
            continue

        current_mode = stat.S_IMODE(tool_path.stat().st_mode)
        executable_mode = current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        if executable_mode != current_mode:
            os.chmod(tool_path, executable_mode)
            repaired.append(filename)
        if not os.access(tool_path, os.X_OK):
            raise PermissionError(
                f"Could not make {filename} executable. Check filesystem permissions or mount options."
            )

    return repaired


def install_release(
    ctx: AppContext,
    tag: str,
    backend: str,
    backend_specs: Mapping[str, Any],
) -> bool:
    reset_download_progress(
        ctx, status="downloading", message=f"Fetching release {tag}..."
    )

    backend_spec = backend_specs[backend]
    repo_api = resolve_repo_api(backend_spec, ctx)

    try:
        try:
            release = get_release_by_tag(ctx, tag, repo_api)
        except Exception:
            releases = get_releases(ctx, repo_api)
            release = next((r for r in releases if r["tag_name"] == tag), None)
            if not release:
                set_download_progress(
                    ctx, status="error", message=f"Release {tag} not found"
                )
                return False
    except Exception as exc:
        print(f"[llama_manager] release lookup failed: {exc}", file=sys.stderr)
        set_download_progress(ctx, status="error", message="Download failed while locating the release.")
        return False

    asset_map = {a["name"]: a for a in release["assets"]}

    def progress_cb(downloaded: int, total: int) -> None:
        set_download_progress(ctx, downloaded=downloaded, total=total)

    bin_filename = backend_spec["asset"].format(tag=tag)
    if bin_filename not in asset_map:
        set_download_progress(
            ctx,
            status="error",
            message=f"Asset {bin_filename} not found in release {tag}",
        )
        return False

    bin_url = asset_map[bin_filename]["browser_download_url"]

    def verify_archive(filename: str, archive_path: pathlib.Path) -> bool:
        expected_sha = get_release_asset_sha256(asset_map[filename], filename)
        if expected_sha is None:
            return True
        if sha256_file(archive_path).lower() == expected_sha:
            return True
        set_download_progress(
            ctx,
            status="error",
            message=f"SHA256 mismatch for {filename}",
        )
        return False

    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="llama_install_"))
    staged_bin = ctx.paths.llama_bin.with_name(ctx.paths.llama_bin.name + ".new")
    staged_grammars = ctx.paths.llama_grammars.with_name(
        ctx.paths.llama_grammars.name + ".new"
    )
    try:
        bin_archive = tmpdir / bin_filename
        set_download_progress(ctx, message=f"Downloading {bin_filename}...")
        download_file(ctx, bin_url, bin_archive, progress_cb)

        if not verify_archive(bin_filename, bin_archive):
            return False

        extra_archives: list[pathlib.Path] = []
        for extra_filename in backend_spec.get("extra_assets", []):
            if extra_filename not in asset_map:
                continue
            extra_url = asset_map[extra_filename]["browser_download_url"]
            extra_archive = tmpdir / extra_filename
            set_download_progress(ctx, message=f"Downloading {extra_filename}...")
            download_file(ctx, extra_url, extra_archive, progress_cb)
            if not verify_archive(extra_filename, extra_archive):
                return False
            extra_archives.append(extra_archive)

        set_download_progress(
            ctx, status="extracting", message="Extracting binaries..."
        )

        # Extract into staging directories and swap them in only once extraction
        # has fully succeeded. Deleting the live install first meant any failure
        # from here on — truncated archive, disk full, killed process — left
        # llama/bin empty while config still named the previous version: an
        # "installed" build with no binaries behind it and no way back.
        # Staged as siblings of the targets so the swap is a rename on the same
        # filesystem, not a multi-gigabyte copy out of the system temp dir.
        for staged in (staged_bin, staged_grammars):
            shutil.rmtree(staged, ignore_errors=True)
            staged.mkdir(parents=True, exist_ok=True)

        preserve_paths = bool(backend_spec.get("preserve_paths"))
        if preserve_paths:
            extract_archive_preserve_paths(bin_archive, staged_bin)
            for extra_archive in extra_archives:
                extract_archive_preserve_paths(extra_archive, staged_bin)
        else:
            extract_archive_flat(bin_archive, staged_bin, staged_grammars)
            for extra_archive in extra_archives:
                extract_archive_flat(extra_archive, staged_bin, staged_grammars)

        _swap_directory_into_place(staged_bin, ctx.paths.llama_bin)
        _swap_directory_into_place(staged_grammars, ctx.paths.llama_grammars)

        ensure_installed_tool_executables(ctx)

        with ctx.state.config_lock:
            config_data = dict(ctx.services.load_config())
            version = release.get("name", tag)
            config_data.update(
                {
                    "version": version,
                    "backend": backend,
                    "tag": tag,
                    "official_install": {
                        "backend": backend,
                        "tag": tag,
                        "version": version,
                    },
                }
            )
            ctx.services.save_config(config_data)
        ctx.state.clear_runtime_health_cache()
        set_download_progress(
            ctx, status="done", message=f"Installed {tag} ({backend})"
        )
        return True

    except Exception as e:
        print(f"[llama_manager] install_release failed: {e}", file=sys.stderr)
        set_download_progress(ctx, status="error", message="Download failed unexpectedly.")
        return False
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        # Leftovers only exist if extraction or the swap failed; the live
        # directories are untouched in that case.
        shutil.rmtree(staged_bin, ignore_errors=True)
        shutil.rmtree(staged_grammars, ignore_errors=True)
