"""ModelScope (魔搭) model discovery and multi-threaded chunked downloads.

Mirrors :mod:`backend.services.hf_download` but talks to the ModelScope REST
API directly (no vendor SDK) and fetches each file with parallel HTTP Range
chunks. Both services share the same ``ctx.state.model_download`` state, the
same lock/cancel contract, and the same frontend progress poller — only one
download can run at a time regardless of source.
"""

import json
import pathlib
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from backend.context import AppContext
from backend.http import sanitize_error
from backend.services import model_dir
from backend.services.hf_download import (
    get_model_download_snapshot,
    is_mmproj_filename,
    remove_partial_downloads,
    reset_model_download_state,
    set_model_download_state,
    slugify_repo_id,
    validate_hf_filename,
    validate_hf_repo_id,
)

UrlOpen = Callable[..., Any]

MS_API_BASE = "https://www.modelscope.cn"
MS_REPO_FILES_API = MS_API_BASE + "/api/v1/models/{repo_id}/repo/files?Recursive=true"
MS_FILE_URL = MS_API_BASE + "/models/{repo_id}/resolve/master/{path}"
USER_AGENT = "Llama-GUI"

CHUNK_SIZE = 32 * 1024 * 1024
READ_SIZE = 1024 * 1024
MAX_WORKERS = 8
CHUNK_RETRIES = 3


def get_ms_model_files(repo_id: str, urlopen: UrlOpen = urllib.request.urlopen) -> dict[str, Any]:
    """List the repo's GGUF files: {repo_id, revision, models, mmproj}."""
    url = MS_REPO_FILES_API.format(repo_id=repo_id)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    files = (payload.get("Data") or {}).get("Files") or []
    items = []
    for entry in files:
        if entry.get("Type") != "blob":
            continue
        name = str(entry.get("Path") or "")
        if not name.lower().endswith(".gguf"):
            continue
        try:
            size = int(entry.get("Size") or 0)
        except (TypeError, ValueError):
            size = 0
        items.append({"name": name, "size": size, "size_mb": round(size / 1048576, 2)})
    items.sort(key=lambda item: item["name"].lower())
    main_files = [item for item in items if not is_mmproj_filename(item["name"])]
    mmproj_files = [item for item in items if is_mmproj_filename(item["name"])]
    return {"repo_id": repo_id, "revision": "master", "models": main_files, "mmproj": mmproj_files}


def build_ms_download_url(repo_id: str, filename: str) -> str:
    return MS_FILE_URL.format(repo_id=repo_id, path=filename)


def get_ms_file_size(repo_id: str, filename: str, urlopen: UrlOpen = urllib.request.urlopen) -> int:
    """Declared file size via HEAD, 0 when the server won't say."""
    request = urllib.request.Request(
        build_ms_download_url(repo_id, filename),
        headers={"User-Agent": USER_AGENT},
        method="HEAD",
    )
    try:
        with urlopen(request, timeout=30) as resp:
            raw = resp.headers.get("Content-Length")
        return int(raw) if raw else 0
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(f"[ms_download] failed to read file size for {repo_id}/{filename}: {exc}", flush=True)
        return 0


class _ChunkCounter:
    """Thread-safe byte counter feeding the shared download state."""

    def __init__(self, ctx: AppContext, completed_bytes: int, total_bytes: int, filename: str) -> None:
        self._ctx = ctx
        self._lock = threading.Lock()
        self._completed = completed_bytes
        self._total = total_bytes
        self._filename = filename
        self._done = 0

    def add(self, count: int) -> None:
        with self._lock:
            self._done += count
            set_model_download_state(
                self._ctx,
                downloaded=self._completed + self._done,
                total=self._total,
                current_file=self._filename,
            )

    @property
    def done(self) -> int:
        with self._lock:
            return self._done


def _cancel_requested(ctx: AppContext) -> bool:
    return ctx.state.model_download_cancel.is_set()


def _download_chunk(
    ctx: AppContext,
    url: str,
    start: int,
    end: int,
    part_path: pathlib.Path,
    counter: _ChunkCounter,
    urlopen: UrlOpen,
) -> None:
    """Fetch one byte range into *part_path*, resuming from what's on disk."""
    got = part_path.stat().st_size if part_path.exists() else 0
    span = end - start + 1
    for attempt in range(CHUNK_RETRIES):
        if _cancel_requested(ctx):
            raise InterruptedError("Download cancelled.")
        if got >= span:
            return
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Range": f"bytes={start + got}-{end}"},
            )
            with urlopen(request, timeout=60) as resp:
                status = getattr(resp, "status", 200)
                if status not in (206, 200):
                    raise OSError(f"Unexpected HTTP status {status} for Range request.")
                with open(part_path, "ab" if status == 206 else "wb") as f:
                    if status == 200:
                        got = 0
                    while True:
                        if _cancel_requested(ctx):
                            raise InterruptedError("Download cancelled.")
                        chunk = resp.read(READ_SIZE)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        counter.add(len(chunk))
            if got >= span:
                return
            raise OSError(f"Chunk short read: {got}/{span} bytes.")
        except InterruptedError:
            raise
        except Exception as exc:  # noqa: BLE001 - retried below, then reported
            if attempt + 1 >= CHUNK_RETRIES:
                raise OSError(f"Chunk {start}-{end} failed after {CHUNK_RETRIES} attempts: {exc}") from exc
            time.sleep(1.5 * (attempt + 1))


def _single_stream(
    ctx: AppContext,
    url: str,
    dest: pathlib.Path,
    counter: _ChunkCounter,
    urlopen: UrlOpen,
) -> None:
    """Fallback when the server (or fake) does not honour Range requests."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp_path = dest.with_suffix(dest.suffix + ".part")
    with urlopen(request, timeout=60) as resp, open(tmp_path, "wb") as f:
        while True:
            if _cancel_requested(ctx):
                raise InterruptedError("Download cancelled.")
            chunk = resp.read(READ_SIZE)
            if not chunk:
                break
            f.write(chunk)
            counter.add(len(chunk))
    tmp_path.replace(dest)


def download_ms_file(
    ctx: AppContext,
    repo_id: str,
    filename: str,
    dest: pathlib.Path,
    completed_bytes: int,
    total_bytes: int,
    urlopen: UrlOpen = urllib.request.urlopen,
) -> int:
    """Download one file with parallel Range chunks; returns bytes written.

    On success the chunk temp files are removed. On failure the chunk files are
    removed too (a fresh attempt re-plans them), matching the partial-file
    cleanup contract in AGENTS.md.
    """
    url = build_ms_download_url(repo_id, filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = get_ms_file_size(repo_id, filename, urlopen)
    counter = _ChunkCounter(ctx, completed_bytes, total_bytes or total, filename)

    supports_ranges = False
    if total > 0:
        probe = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT}, method="HEAD"
        )
        try:
            with urlopen(probe, timeout=30) as resp:
                accepts = str(resp.headers.get("Accept-Ranges") or "")
            supports_ranges = accepts.lower() == "bytes"
        except (OSError, urllib.error.URLError):
            supports_ranges = False

    part_paths: list[pathlib.Path] = []
    try:
        if total <= 0 or not supports_ranges:
            _single_stream(ctx, url, dest, counter, urlopen)
        else:
            chunk_count = min(MAX_WORKERS, max(1, total // CHUNK_SIZE + (1 if total % CHUNK_SIZE else 0)))
            base = total // chunk_count
            spans = []
            start = 0
            for index in range(chunk_count):
                end = total - 1 if index == chunk_count - 1 else start + base - 1
                spans.append((start, end))
                start = end + 1
            part_paths = [
                dest.with_suffix(dest.suffix + f".part{index}")
                for index in range(len(spans))
            ]
            with ThreadPoolExecutor(max_workers=len(spans)) as pool:
                futures = [
                    pool.submit(
                        _download_chunk,
                        ctx,
                        url,
                        span_start,
                        span_end,
                        part_path,
                        counter,
                        urlopen,
                    )
                    for (span_start, span_end), part_path in zip(spans, part_paths)
                ]
                for future in futures:
                    future.result()

            assembled = dest.with_suffix(dest.suffix + ".assembling")
            with open(assembled, "wb") as out:
                for part_path in part_paths:
                    with open(part_path, "rb") as part_file:
                        while True:
                            buf = part_file.read(READ_SIZE)
                            if not buf:
                                break
                            out.write(buf)
            if assembled.stat().st_size != total:
                raise OSError(f"Assembled size mismatch for {filename}.")
            assembled.replace(dest)
        return counter.done
    finally:
        for part_path in part_paths:
            try:
                if part_path.exists():
                    part_path.unlink()
            except OSError as exc:
                print(f"[ms_download] failed to remove chunk file: {exc}", flush=True)


def start_ms_model_download(
    ctx: AppContext,
    repo_id: Any,
    model_file: Any,
    mmproj_file: Any,
    overwrite: bool = False,
    urlopen: UrlOpen = urllib.request.urlopen,
) -> dict[str, Any]:
    """Validate inputs and spawn the background download worker (HF twin)."""
    repo_id = validate_hf_repo_id(repo_id)
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
            ctx, status="starting", message="Preparing ModelScope download..."
        )

    def _worker() -> None:
        destinations = [model_dest]
        if mmproj_dest:
            destinations.append(mmproj_dest)
        try:
            model_dest.parent.mkdir(parents=True, exist_ok=True)
            total = get_ms_file_size(repo_id, model_file, urlopen)
            if mmproj_file:
                total += get_ms_file_size(repo_id, mmproj_file, urlopen)
            reset_model_download_state(
                ctx,
                status="downloading",
                message=f"Downloading {model_name}...",
                total=total,
                downloaded=0,
            )
            completed = download_ms_file(
                ctx, repo_id, model_file, model_dest, 0, total, urlopen
            )
            mmproj_path = ""
            if mmproj_file and mmproj_dest:
                set_model_download_state(ctx, message=f"Downloading {mmproj_dest.name}...")
                completed += download_ms_file(
                    ctx,
                    repo_id,
                    mmproj_file,
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

    threading.Thread(target=_worker, daemon=True).start()
    return get_model_download_snapshot(ctx)
