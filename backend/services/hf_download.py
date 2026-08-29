"""Hugging Face model discovery and download helpers."""

import pathlib
import re
import sys
import threading
import urllib.request
from typing import Any, Callable, Mapping, Optional

from backend.context import AppContext
from backend.http import sanitize_error
from backend.services import model_dir

UrlOpen = Callable[..., Any]


def normalize_hf_token(token: Any) -> Optional[str]:
    value = str(token or "").strip()
    return value or None


def validate_hf_repo_id(repo_id: Any) -> str:
    value = str(repo_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise ValueError("Enter a Hugging Face repo ID like owner/model.")
    if ".." in value or value.endswith("."):
        raise ValueError("Invalid Hugging Face repo ID.")
    return value


def validate_hf_revision(revision: Any) -> str:
    value = str(revision or "main").strip() or "main"
    if (
        value.startswith("/")
        or "\\" in value
        or "\x00" in value
        or ".." in pathlib.PurePosixPath(value).parts
    ):
        raise ValueError("Invalid Hugging Face revision.")
    return value


def _is_windows_device_name(stem: str) -> bool:
    """True when *stem* is COM1-COM9 or LPT1-LPT9 (case-insensitive)."""
    return (
        (stem.startswith("COM") or stem.startswith("LPT"))
        and len(stem) == 4
        and stem[3].isdigit()
        and stem[3] != "0"
    )


def validate_hf_filename(filename: Any) -> str:
    value = str(filename or "").strip().replace("\\", "/")
    pure = pathlib.PurePosixPath(value)
    if not value or pure.is_absolute() or "\x00" in value or ".." in pure.parts:
        raise ValueError("Invalid Hugging Face filename.")
    # Reject names that Windows would interpret as path-like after POSIX path normalization.
    if pure.name != pathlib.PureWindowsPath(pure.name).name:
        raise ValueError("Invalid Hugging Face filename.")
    if re.search(r'[<>:"/\\|?*]', pure.name):
        raise ValueError("Hugging Face filename is not safe to save locally.")
    if not pure.name.lower().endswith(".gguf"):
        raise ValueError("Only .gguf files can be downloaded.")
    # Windows reserved names: device is the segment before the first dot
    # (CON.txt, COM1.foo.gguf), not Path.stem (before the last suffix only).
    device = pure.name.split(".", 1)[0].upper()
    if device in {"CON", "PRN", "AUX", "NUL"} or _is_windows_device_name(device):
        raise ValueError("Invalid Hugging Face filename.")
    return value


def is_mmproj_filename(filename: Any) -> bool:
    name = pathlib.PurePosixPath(str(filename or "").replace("\\", "/")).name.lower()
    stem = pathlib.Path(name).stem
    return "mmproj" in stem or stem.startswith("clip") or "projector" in stem


def slugify_repo_id(repo_id: str) -> str:
    """Folder name for a repo's downloads under models/.

    Not injective: only "/" is substituted, so "owner/my_model" and
    "owner_my/model" both slugify to "owner_my_model" and share a folder. Left
    as-is deliberately - an injective scheme would rename every existing download
    folder, and sharing one is benign: files keep their own names, and a same-name
    clash is caught by the exists check in start_hf_model_download(), which
    prompts before overwriting.
    """
    return re.sub(r"[^A-Za-z0-9._-]+", "_", repo_id).strip("._-") or "repo"


def hf_file_to_dict(file_obj: Any) -> dict[str, Any]:
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
    return {"name": str(filename), "size": size, "size_mb": round(size / 1048576, 2) if size is not None else None}


def get_hf_gguf_files(repo_id: str, revision: str = "main", token: Optional[str] = None) -> dict[str, Any]:
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise RuntimeError(
            "Hugging Face downloads require the huggingface_hub package. Re-run the install script."
        ) from exc

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


def get_hf_file_size(repo_id: str, filename: str, revision: str, token: Optional[str] = None) -> int:
    try:
        from huggingface_hub import get_hf_file_metadata, hf_hub_url
    except ImportError:
        return 0

    try:
        url = hf_hub_url(repo_id=repo_id, filename=filename, revision=revision)
        metadata = get_hf_file_metadata(url, token=token or False, timeout=20)
        return int(metadata.size or 0)
    except Exception as exc:
        print(f"[hf_download] failed to read file size for {repo_id}/{filename}: {exc}", file=sys.stderr)
        return 0


def build_hf_download_url(repo_id: str, filename: str, revision: str) -> str:
    try:
        from huggingface_hub import hf_hub_url
    except ImportError as exc:
        raise RuntimeError(
            "Hugging Face downloads require the huggingface_hub package. Re-run the install script."
        ) from exc
    return hf_hub_url(repo_id=repo_id, filename=filename, revision=revision)


def reset_model_download_state(
    ctx: AppContext,
    status: str = "idle",
    message: str = "",
    total: int = 0,
    downloaded: int = 0,
) -> None:
    ctx.state.model_download.replace(
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


def set_model_download_state(ctx: AppContext, **updates: Any) -> None:
    ctx.state.model_download.update(**updates)


def get_model_download_snapshot(ctx: AppContext) -> Mapping[str, Any]:
    return ctx.state.model_download.snapshot()


def cancel_hf_model_download(ctx: AppContext) -> Mapping[str, Any]:
    """Request cancellation only while a worker still owns the download slot."""
    with ctx.state.model_download_lock:
        snapshot = ctx.state.model_download.snapshot()
        if not ctx.state.model_download_in_progress or snapshot.get("status") in {
            "done",
            "error",
            "cancelled",
        }:
            return snapshot
        ctx.state.model_download_cancel.set()
        return ctx.state.model_download.update(
            status="cancelling", message="Cancelling download..."
        )


def _content_length(resp: Any) -> Optional[int]:
    """Declared body size, or None when the server didn't say (or said nonsense)."""
    headers = getattr(resp, "headers", None)
    raw = headers.get("Content-Length") if hasattr(headers, "get") else None
    try:
        size = int(raw)
    except (TypeError, ValueError):
        return None
    return size if size >= 0 else None


def download_hf_file(
    ctx: AppContext,
    repo_id: str,
    filename: str,
    revision: str,
    token: Optional[str],
    dest: pathlib.Path,
    completed_bytes: int,
    total_bytes: int,
    urlopen: UrlOpen = urllib.request.urlopen,
) -> int:
    url = build_hf_download_url(repo_id, filename, revision)
    headers = {"User-Agent": "Llama-GUI"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    tmp_path = dest.with_suffix(dest.suffix + ".part")
    downloaded = 0
    with urlopen(req, timeout=60) as resp, open(tmp_path, "wb") as f:
        expected_bytes = _content_length(resp)
        while True:
            if ctx.state.model_download_cancel.is_set():
                raise InterruptedError("Download cancelled.")
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            set_model_download_state(
                ctx,
                downloaded=completed_bytes + downloaded,
                total=total_bytes,
                current_file=pathlib.PurePosixPath(filename).name,
            )
    # http.client deliberately does not raise IncompleteRead from read(amt) — it
    # just closes the connection and returns b"" — so a connection dropped
    # mid-transfer looks exactly like a clean EOF here. Without this check the
    # truncated .part was promoted to a "done" GGUF that fails at load time.
    if expected_bytes is not None and downloaded != expected_bytes:
        raise OSError(
            f"Download of {filename} was incomplete: got {downloaded} bytes, "
            f"expected {expected_bytes}."
        )
    tmp_path.replace(dest)
    return downloaded


def remove_partial_downloads(paths: list[pathlib.Path]) -> None:
    for path in paths:
        tmp_path = path.with_suffix(path.suffix + ".part")
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError as exc:
            print(f"[hf_download] failed to remove partial download: {exc}", file=sys.stderr)


def start_hf_model_download(
    ctx: AppContext,
    repo_id: Any,
    revision: Any,
    model_file: Any,
    mmproj_file: Any,
    token: Optional[str],
    overwrite: bool = False,
    urlopen: UrlOpen = urllib.request.urlopen,
) -> Mapping[str, Any]:
    repo_id = validate_hf_repo_id(repo_id)
    revision = validate_hf_revision(revision)
    model_file = validate_hf_filename(model_file)
    mmproj_file = validate_hf_filename(mmproj_file) if mmproj_file else ""

    if is_mmproj_filename(model_file):
        raise ValueError("Choose a main model file, not an mmproj file.")
    if mmproj_file and not is_mmproj_filename(mmproj_file):
        raise ValueError("Choose an mmproj/projector file for the companion mmproj download.")

    with ctx.state.model_download_lock:
        if ctx.state.model_download_in_progress:
            raise RuntimeError("A model download is already in progress.")
        models_dir = model_dir.get_models_dir(ctx)
        repo_folder = slugify_repo_id(repo_id)
        model_basename = pathlib.PurePosixPath(model_file).name
        # Relative id under the active model root so discovery and presets select it.
        model_name = f"{repo_folder}/{model_basename}"
        model_dest = models_dir / repo_folder / model_basename
        mmproj_dest = None
        if mmproj_file:
            mmproj_dest = model_dest.parent / pathlib.PurePosixPath(mmproj_file).name

        existing = []
        if model_dest.exists():
            existing.append(model_name)
        if mmproj_dest and mmproj_dest.exists():
            existing.append(f"{repo_folder}/{mmproj_dest.name}")
        if existing and not overwrite:
            raise FileExistsError(f"Already exists: {', '.join(existing)}")

        ctx.state.model_download_in_progress = True
        ctx.state.model_download_cancel.clear()
        reset_model_download_state(
            ctx, status="starting", message="Preparing Hugging Face download..."
        )

    def _worker() -> None:
        destinations = [model_dest]
        if mmproj_dest:
            destinations.append(mmproj_dest)
        try:
            model_dest.parent.mkdir(parents=True, exist_ok=True)
            total = get_hf_file_size(repo_id, model_file, revision, token)
            if mmproj_file:
                total += get_hf_file_size(repo_id, mmproj_file, revision, token)
            reset_model_download_state(
                ctx,
                status="downloading",
                message=f"Downloading {model_name}...",
                total=total,
                downloaded=0,
            )
            completed = download_hf_file(ctx, repo_id, model_file, revision, token, model_dest, 0, total, urlopen)
            mmproj_path = ""
            if mmproj_file and mmproj_dest:
                set_model_download_state(ctx, message=f"Downloading {mmproj_dest.name}...")
                completed += download_hf_file(
                    ctx,
                    repo_id,
                    mmproj_file,
                    revision,
                    token,
                    mmproj_dest,
                    completed,
                    total,
                    urlopen,
                )
                mmproj_path = str(mmproj_dest)
            set_model_download_state(
                ctx,
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
            set_model_download_state(ctx, status="cancelled", message=str(exc), current_file="")
        except Exception as exc:
            remove_partial_downloads(destinations)
            set_model_download_state(
                ctx,
                status="error",
                message=sanitize_error(exc, 500),
                current_file="",
            )
        finally:
            with ctx.state.model_download_lock:
                ctx.state.model_download_in_progress = False
                ctx.state.model_download_cancel.clear()

    try:
        threading.Thread(target=_worker, daemon=True).start()
    except Exception as exc:
        with ctx.state.model_download_lock:
            ctx.state.model_download_in_progress = False
            ctx.state.model_download_cancel.clear()
        set_model_download_state(
            ctx, status="error", message=sanitize_error(exc, 500), current_file=""
        )
        print(f"[hf_download] failed to start download thread: {exc}", file=sys.stderr)
        raise
    return get_model_download_snapshot(ctx)
