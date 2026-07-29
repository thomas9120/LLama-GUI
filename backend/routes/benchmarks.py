"""Benchmark dataset helper routes."""

import shutil
import sys
import tempfile
import threading
import zipfile
from pathlib import Path
from urllib.request import Request as UrlRequest

from backend.http import sanitize_error


_WIKITEXT2_LOCK = threading.Lock()

WIKITEXT2_URL = "https://huggingface.co/datasets/ggml-org/ci/resolve/main/wikitext-2-raw-v1.zip"
WIKITEXT2_DIR = "wikitext-2-raw-v1"
WIKITEXT2_TEST_FILE = "wiki.test.raw"


def _find_zip_member(archive):
    expected_suffix = f"/{WIKITEXT2_TEST_FILE}"
    for member in archive.infolist():
        name = member.filename.replace("\\", "/")
        if member.is_dir():
            continue
        if name == WIKITEXT2_TEST_FILE or name.endswith(expected_suffix):
            return member
    return None


def ensure_wikitext2(request, response, ctx):
    dataset_dir = ctx.paths.models / WIKITEXT2_DIR
    target = dataset_dir / WIKITEXT2_TEST_FILE

    # Serialized because the only readiness signal is target.exists(); two
    # concurrent callers would otherwise extract into the same path at once.
    with _WIKITEXT2_LOCK:
        if target.exists():
            response.json({"ready": True, "downloaded": False, "path": str(target)})
            return

        dataset_dir.mkdir(parents=True, exist_ok=True)

        try:
            req = UrlRequest(WIKITEXT2_URL, headers={"User-Agent": "Llama-GUI"})
            with ctx.services.urlopen_with_ssl(req, timeout=60) as upstream:
                with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
                    tmp_path = Path(tmp.name)
                    shutil.copyfileobj(upstream, tmp)

            try:
                with zipfile.ZipFile(tmp_path) as archive:
                    member = _find_zip_member(archive)
                    if member is None:
                        response.error("WikiText-2 test file was not found in the downloaded archive.", 500)
                        return
                    # Extract to a sibling .part first: writing straight to target
                    # meant an interrupted extraction left a truncated file that
                    # satisfied the exists() check above forever after, silently
                    # feeding corrupt data to every later perplexity benchmark.
                    part_path = target.with_name(target.name + ".part")
                    try:
                        with archive.open(member) as src, open(part_path, "wb") as dest:
                            shutil.copyfileobj(src, dest)
                            extracted = dest.tell()
                        if extracted != member.file_size:
                            raise OSError(
                                f"WikiText-2 extraction was short: got {extracted} bytes, "
                                f"expected {member.file_size}."
                            )
                        part_path.replace(target)
                    finally:
                        part_path.unlink(missing_ok=True)
            finally:
                tmp_path.unlink(missing_ok=True)

            response.json({"ready": True, "downloaded": True, "path": str(target)})
        except Exception as exc:
            print(f"WikiText-2 download failed: {exc}", file=sys.stderr, flush=True)
            response.error(sanitize_error(exc, 500), 500)
