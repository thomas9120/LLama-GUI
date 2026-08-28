"""ModelScope (魔搭) download service tests.

Mirrors the HF download tests in test_services.py: same context builder, same
FakeDownloadResponse plumbing, same worker/threading patterns.
"""

import contextlib
import io
import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

from backend.services import modelscope_download as ms_service
from tests.backend.test_services import FakeDownloadResponse, make_service_context


def _wait_for_status(ctx, attempts=150):
    for _ in range(attempts):
        snap = ms_service.get_model_download_snapshot(ctx)
        if snap["status"] in {"done", "error", "cancelled"}:
            return snap
        time.sleep(0.02)
    return snap


class ImmediateThread:
    def __init__(self, *, target, daemon):
        self.target = target

    def start(self):
        self.target()

    def join(self, timeout=None):
        pass


class FakeRangeServer:
    """Serves HEAD metadata plus Range/whole-body GETs from one bytes body."""

    def __init__(self, body, accept_ranges=True):
        self.body = body
        self.accept_ranges = accept_ranges
        self.requests = []

    def __call__(self, req, timeout=60):
        self.requests.append(req)
        if req.get_method() == "HEAD":
            resp = FakeDownloadResponse([], content_length=len(self.body))
            if self.accept_ranges:
                resp.headers["Accept-Ranges"] = "bytes"
            return resp
        range_header = req.headers.get("Range")
        if range_header and self.accept_ranges:
            span = range_header.split("=", 1)[1]
            start_s, end_s = span.split("-", 1)
            start, end = int(start_s), int(end_s)
            chunk = self.body[start : end + 1]
            resp = FakeDownloadResponse([chunk], content_length=len(chunk))
            resp.status = 206
            resp.headers["Content-Range"] = f"bytes {start}-{end}/{len(self.body)}"
            return resp
        resp = FakeDownloadResponse([self.body], content_length=len(self.body))
        resp.status = 200
        return resp


class GetMsModelFilesTests(unittest.TestCase):
    def test_lists_gguf_files_split_by_mmproj(self):
        payload = {
            "Data": {
                "Files": [
                    {"Type": "blob", "Path": "model.Q4.gguf", "Size": 10},
                    {"Type": "blob", "Path": "mmproj-model.gguf", "Size": 5},
                    {"Type": "blob", "Path": "README.md", "Size": 2},
                    {"Type": "tree", "Path": "sub", "Size": 0},
                ]
            }
        }
        seen_urls = []

        def fake_urlopen(req, timeout=30):
            seen_urls.append(req.full_url)
            return FakeDownloadResponse([json.dumps(payload).encode("utf-8")])

        result = ms_service.get_ms_model_files("owner/model", urlopen=fake_urlopen)

        self.assertEqual([f["name"] for f in result["models"]], ["model.Q4.gguf"])
        self.assertEqual([f["name"] for f in result["mmproj"]], ["mmproj-model.gguf"])
        self.assertEqual(result["models"][0]["size_mb"], round(10 / 1048576, 2))
        self.assertIn(
            "https://www.modelscope.cn/api/v1/models/owner/model/repo/files", seen_urls[0]
        )

    def test_size_header_without_accept_ranges_is_ignored_for_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            body = b"0123456789"
            server = FakeRangeServer(body, accept_ranges=False)
            dest = pathlib.Path(tmp) / "model.gguf"

            with mock.patch.object(ms_service, "get_ms_file_size", return_value=len(body)):
                downloaded = ms_service.download_ms_file(
                    ctx, "owner/model", "model.gguf", dest, 0, len(body), server
                )

            self.assertEqual(downloaded, len(body))
            self.assertEqual(dest.read_bytes(), body)


class StartMsModelDownloadTests(unittest.TestCase):
    def test_single_stream_download_into_repo_subfolder(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            payload = b"gguf-bytes"
            server = FakeRangeServer(payload, accept_ranges=False)

            with (
                mock.patch.object(ms_service, "get_ms_file_size", return_value=len(payload)),
                mock.patch.object(ms_service.threading, "Thread", ImmediateThread),
            ):
                ms_service.start_ms_model_download(
                    ctx,
                    repo_id="owner/model",
                    model_file="Q4/model.gguf",
                    mmproj_file="mmproj-model.gguf",
                    overwrite=False,
                    urlopen=server,
                )
                snap = _wait_for_status(ctx)

            self.assertEqual(snap["status"], "done", snap)
            self.assertEqual(snap["model_name"], "owner_model/model.gguf")
            model_path = pathlib.Path(snap["model_path"])
            self.assertEqual(model_path, ctx.paths.models / "owner_model" / "model.gguf")
            self.assertEqual(model_path.read_bytes(), payload)
            mmproj_path = pathlib.Path(snap["mmproj_path"])
            self.assertEqual(
                mmproj_path, ctx.paths.models / "owner_model" / "mmproj-model.gguf"
            )
            self.assertTrue(mmproj_path.is_file())

    def test_chunked_download_assembles_exact_bytes_and_uses_range_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            payload = bytes(range(256)) * 64  # 16 KiB, forced into 3+ chunks
            server = FakeRangeServer(payload, accept_ranges=True)

            with (
                mock.patch.object(ms_service, "get_ms_file_size", return_value=len(payload)),
                mock.patch.object(ms_service, "CHUNK_SIZE", 4096),
            ):
                ms_service.start_ms_model_download(
                    ctx,
                    repo_id="owner/model",
                    model_file="model.gguf",
                    mmproj_file="",
                    overwrite=False,
                    urlopen=server,
                )
                snap = _wait_for_status(ctx)

            self.assertEqual(snap["status"], "done", snap)
            dest = pathlib.Path(snap["model_path"])
            self.assertEqual(dest.read_bytes(), payload)
            self.assertFalse(list(dest.parent.glob("*.part*")), "chunk temp files must be cleaned")
            self.assertFalse(list(dest.parent.glob("*.assembling")))
            get_requests = [r for r in server.requests if r.get_method() == "GET"]
            self.assertTrue(any(r.headers.get("Range") for r in get_requests))
            self.assertTrue(
                all(
                    r.full_url.startswith(
                        "https://www.modelscope.cn/models/owner/model/resolve/master/"
                    )
                    for r in server.requests
                )
            )

    def test_exists_check_uses_repo_relative_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            dest = ctx.paths.models / "owner_model" / "model.gguf"
            dest.parent.mkdir(parents=True)
            dest.write_bytes(b"existing")

            def fail_urlopen(*_args, **_kwargs):
                raise AssertionError("no network access expected")

            with self.assertRaises(FileExistsError) as raised:
                ms_service.start_ms_model_download(
                    ctx,
                    repo_id="owner/model",
                    model_file="model.gguf",
                    mmproj_file="",
                    overwrite=False,
                    urlopen=fail_urlopen,
                )

            self.assertIn("owner_model/model.gguf", str(raised.exception))

    def test_worker_logs_and_sanitizes_unexpected_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            stderr = io.StringIO()

            with contextlib.redirect_stderr(stderr), mock.patch.object(
                ms_service, "get_ms_file_size", side_effect=RuntimeError("private download failure")
            ), mock.patch.object(ms_service.threading, "Thread", ImmediateThread):
                snap = ms_service.start_ms_model_download(
                    ctx,
                    repo_id="owner/model",
                    model_file="model.gguf",
                    mmproj_file="",
                    overwrite=False,
                )

            self.assertEqual(snap["status"], "error")
            self.assertEqual(snap["message"], "Internal server error")
            self.assertIn("private download failure", stderr.getvalue())

    def test_refuses_mmproj_as_main_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)

            with self.assertRaises(ValueError):
                ms_service.start_ms_model_download(
                    ctx,
                    repo_id="owner/model",
                    model_file="mmproj-model.gguf",
                    mmproj_file="",
                    overwrite=False,
                )


if __name__ == "__main__":
    unittest.main()
