"""llama.cpp release management, download, and install helpers."""

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from typing import Any, Callable, Iterable, Mapping, Optional

from ..context import AppContext


RPATH_LIBRARY_RE = re.compile(r"^\s*@rpath/([^\s(]+)")

# Optional llamacpp-rocm backend (https://github.com/lemonade-sdk/llamacpp-rocm).
# Publishes nightly ROCm 7 llama.cpp archives for Windows and Ubuntu, one asset
# per AMD GPU target. Users must choose the target matching their GPU arch.
LEMONADE_ROCM_REPO_API = (
    "https://api.github.com/repos/lemonade-sdk/llamacpp-rocm/releases"
)

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
    if current_platform == "win32":
        if current_arch == "arm64":
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
                "label": "HIP (AMD Radeon)",
                "asset": "llama-{tag}-bin-win-hip-radeon-x64.zip",
            },
        }
        specs.update(_lemonade_rocm_specs("windows"))
        return specs

    if current_platform == "darwin":
        if current_arch == "arm64":
            return {
                "metal": {
                    "label": "Metal (Apple Silicon)",
                    "asset": "llama-{tag}-bin-macos-arm64.tar.gz",
                },
            }
        if current_arch == "x64":
            return {
                "cpu": {
                    "label": "CPU (Intel Mac)",
                    "asset": "llama-{tag}-bin-macos-x64.tar.gz",
                }
            }
        return {}

    if current_platform.startswith("linux"):
        if current_arch == "x64":
            specs = {
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
                    "asset": "llama-{tag}-bin-ubuntu-openvino-2026.2-x64.tar.gz",
                },
            }
            specs.update(_lemonade_rocm_specs("ubuntu"))
            return specs
        if current_arch == "arm64":
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
        if current_arch == "s390x":
            return {
                "cpu": {
                    "label": "CPU",
                    "asset": "llama-{tag}-bin-ubuntu-s390x.tar.gz",
                }
            }
    return {}


def get_releases(ctx: AppContext, repo_api: Optional[str] = None) -> list[dict[str, Any]]:
    api_url = repo_api or ctx.config.github_api
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


def validate_runtime_dependencies(
    ctx: AppContext, tools: Optional[Iterable[str]] = None
) -> dict[str, Any]:
    current_platform = ctx.services.current_platform
    if current_platform != "darwin":
        return {
            "ok": True,
            "checked": False,
            "required_runtime_files": [],
            "missing_runtime_files": [],
        }

    required: set[str] = set()
    checked_tools: list[str] = []
    unchecked_tools: list[str] = []
    missing_executables: list[str] = []

    for tool in tools or ("llama-cli", "llama-server"):
        exe_path = ctx.services.find_tool_executable(tool)
        if not exe_path.exists():
            missing_executables.append(ctx.services.get_tool_filename(tool))
            continue
        try:
            required.update(get_macos_rpath_libraries(exe_path))
            checked_tools.append(tool)
        except (
            FileNotFoundError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            OSError,
        ):
            unchecked_tools.append(tool)

    missing_runtime_files = sorted(
        name for name in required if not (ctx.paths.llama_bin / name).exists()
    )
    return {
        "ok": not missing_runtime_files,
        "checked": bool(checked_tools),
        "checked_tools": checked_tools,
        "unchecked_tools": unchecked_tools,
        "required_runtime_files": sorted(required),
        "missing_runtime_files": missing_runtime_files,
        "missing_executables": missing_executables,
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
        release = get_release_by_tag(ctx, tag, repo_api)
    except Exception:
        releases = get_releases(ctx, repo_api)
        release = next((r for r in releases if r["tag_name"] == tag), None)
        if not release:
            set_download_progress(
                ctx, status="error", message=f"Release {tag} not found"
            )
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
    expected_sha = asset_map[bin_filename].get("sha256", None)
    if not expected_sha:
        print(
            f"WARNING: No SHA256 metadata for release asset {bin_filename}; skipping checksum verification.",
            file=sys.stderr,
        )

    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="llama_install_"))
    try:
        bin_archive = tmpdir / bin_filename
        set_download_progress(ctx, message=f"Downloading {bin_filename}...")
        download_file(ctx, bin_url, bin_archive, progress_cb)

        if expected_sha:
            actual_sha = sha256_file(bin_archive)
            if actual_sha != expected_sha:
                set_download_progress(
                    ctx,
                    status="error",
                    message=f"SHA256 mismatch for {bin_filename}",
                )
                return False

        extra_archives: list[pathlib.Path] = []
        for extra_filename in backend_spec.get("extra_assets", []):
            if extra_filename not in asset_map:
                continue
            extra_url = asset_map[extra_filename]["browser_download_url"]
            extra_archive = tmpdir / extra_filename
            set_download_progress(ctx, message=f"Downloading {extra_filename}...")
            download_file(ctx, extra_url, extra_archive, progress_cb)
            extra_archives.append(extra_archive)

        set_download_progress(
            ctx, status="extracting", message="Extracting binaries..."
        )

        for d in [ctx.paths.llama_bin, ctx.paths.llama_grammars]:
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)

        preserve_paths = bool(backend_spec.get("preserve_paths"))
        if preserve_paths:
            extract_archive_preserve_paths(bin_archive, ctx.paths.llama_bin)
            for extra_archive in extra_archives:
                extract_archive_preserve_paths(extra_archive, ctx.paths.llama_bin)
        else:
            extract_archive_flat(bin_archive, ctx.paths.llama_bin, ctx.paths.llama_grammars)
            for extra_archive in extra_archives:
                extract_archive_flat(
                    extra_archive, ctx.paths.llama_bin, ctx.paths.llama_grammars
                )

        ctx.services.save_config(
            {"version": release.get("name", tag), "backend": backend, "tag": tag}
        )
        set_download_progress(
            ctx, status="done", message=f"Installed {tag} ({backend})"
        )
        return True

    except Exception as e:
        set_download_progress(ctx, status="error", message=str(e))
        return False
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
