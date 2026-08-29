import contextlib
import hashlib
import io
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import zipfile
from unittest import mock
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

from backend.context import AppContext, AppPaths, BackendServices, ServerConfig
from backend.http import Request
from backend.routes import benchmarks, chat, external_server, file_picker, git_update, hf_download, install, lifecycle, metrics, model_dir as model_dir_route, models, presets, process, search, status, tunnel
from backend.services import chat as chat_service
from backend.services import external_server as external_server_service
# The service layer; `git_update` imported from backend.routes above is the HTTP layer.
from backend.services import git_update as srv
from backend.services import lifecycle as lifecycle_service
from backend.services import llama_manager
from backend.services import model_dir as model_dir_service
from backend.services import process_manager
from backend.services import web_search


class DummyResponse:
    def __init__(self):
        self.payload = None
        self.status = None
        self.text_payload = None

    def json(self, data, status=200):
        self.payload = data
        self.status = status

    def error(self, message, status=500, code=None, extra=None):
        self.payload = {"error": message, "status": status}
        if code:
            self.payload["code"] = code
        if extra:
            self.payload.update(extra)
        self.status = status

    def text(self, text, status=200, content_type="text/plain; charset=utf-8", headers=None):
        self.text_payload = text
        self.status = status


class DummySseResponse:
    def __init__(self):
        self.handler = SimpleNamespace(wfile=io.BytesIO(), close_connection=False)
        self.status = None

    def sse_headers(self, status=200):
        self.status = status


class FakeSseUpstream:
    def __init__(self, lines):
        self.lines = list(lines)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def readline(self):
        if not self.lines:
            return b""
        return self.lines.pop(0)


class FakeBinaryUpstream:
    def __init__(self, payload):
        self.stream = io.BytesIO(payload)

    def __enter__(self):
        return self.stream

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeHealthUpstream:
    def __init__(self, status, body=b'{"status":"ok"}'):
        self.status = status
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def getcode(self):
        return self.status

    def read(self, amount=None):
        return self.body


def make_context(root):
    root = Path(root)
    ctx = AppContext(
        paths=AppPaths(
            root=root,
            llama=root / "llama",
            llama_bin=root / "llama" / "bin",
            llama_grammars=root / "llama" / "grammars",
            llama_custom_bin=root / "llama" / "custom" / "bin",
            llama_custom_grammars=root / "llama" / "custom" / "grammars",
            models=root / "models",
            presets=root / "presets",
            config_file=root / "config.json",
            ui=root / "ui",
            app_logo=root / "ui" / "assets" / "app-logo.png",
            tools=root / "tools",
            cloudflared=root / "tools" / "cloudflared",
        ),
        config=ServerConfig(llama_host="127.0.0.1", llama_port=8080),
    )
    config_store = {}

    def save_config(config_data):
        config_store.clear()
        config_store.update(config_data)

    ctx.services.load_config = lambda: dict(config_store)
    ctx.services.save_config = save_config
    return ctx


def configure_status_services(ctx):
    """Minimum service wiring for /api/status to render without errors."""
    ctx.services = BackendServices(
        backend_specs={"cpu": {"label": "CPU"}},
        binary_suffix=".exe",
        current_arch="x64",
        current_platform="win32",
        find_tool_executable=lambda tool: ctx.paths.llama_bin / f"{tool}.exe",
        get_platform_label=lambda: "Windows",
        get_runtime_files=lambda: [],
        get_tool_filename=lambda tool: f"{tool}.exe",
        is_process_running=lambda: False,
        llama_tools=["llama-cli", "llama-server"],
        load_config=lambda: {"tag": "b1", "backend": "cpu"},
    )
    return ctx.services


def register_external_server(ctx, host="127.0.0.1", port=9001, api_key=""):
    ctx.services.set_llama_api_target = mock.Mock(return_value={})
    return external_server_service.connect(ctx, host, port, api_key, probe_target=False)


def activate_llama_runtime(ctx, host="127.0.0.1", port=8080, tool="llama-server"):
    ctx.state.process = mock.Mock()
    ctx.state.process.poll.return_value = None
    ctx.state.active_process_tool = tool
    ctx.state.active_llama_api_keys = ("launch-secret",)
    ctx.state.active_runtime = {
        "generation": 4,
        "tool": tool,
        "host": host,
        "port": port,
    }


class ExtractedRouteTests(unittest.TestCase):
    def test_models_route_lists_only_gguf_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.models.mkdir(parents=True)
            (ctx.paths.models / "model.gguf").write_bytes(b"x" * 1024)
            (ctx.paths.models / "notes.txt").write_text("ignore")
            nested = ctx.paths.models / "vendor" / "nested.gguf"
            nested.parent.mkdir(parents=True)
            nested.write_bytes(b"x" * 2048)
            mmproj = ctx.paths.models / "mmproj" / "proj.gguf"
            mmproj.parent.mkdir(parents=True)
            mmproj.write_bytes(b"x" * 512)
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            self.assertEqual(
                response.payload,
                [
                    {"name": "model.gguf", "size_mb": 0.0},
                    {"name": "vendor/nested.gguf", "size_mb": 0.0},
                ],
            )

    def test_models_route_lists_symlinked_models(self):
        # Symlinking a large .gguf into models/ from another disk is a common way
        # to avoid copying it. Resolving the path before building the name would
        # place it outside models/ and silently drop it from the list.
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.models.mkdir(parents=True)
            external = Path(tmp) / "elsewhere"
            external.mkdir()
            (external / "external.gguf").write_bytes(b"x" * 1024)
            try:
                (ctx.paths.models / "linked.gguf").symlink_to(external / "external.gguf")
                (ctx.paths.models / "vendor").symlink_to(external, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks are not available on this platform")
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            names = [item["name"] for item in response.payload]
            # Each link is listed under the name it has in models/, which is what
            # `-m models/<name>` needs; the OS follows it at launch.
            self.assertIn("linked.gguf", names)
            self.assertIn("vendor/external.gguf", names)
            self.assertNotIn("external.gguf", names)

    def test_models_route_survives_symlink_cycle(self):
        # Following directory links means a cycle would otherwise recurse forever.
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            nested = ctx.paths.models / "vendor"
            nested.mkdir(parents=True)
            (nested / "nested.gguf").write_bytes(b"x" * 1024)
            try:
                (nested / "loop").symlink_to(ctx.paths.models, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks are not available on this platform")
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            self.assertEqual(
                [item["name"] for item in response.payload],
                ["vendor/nested.gguf"],
            )

    def test_models_route_skips_projectors_and_legacy_mmproj_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.models.mkdir(parents=True)
            for rel in (
                "mmproj/proj.gguf",
                "vendor/mmproj-model.gguf",
                "vendor/mmproj/nested.gguf",
                "mmproj-extra/other.gguf",
            ):
                path = ctx.paths.models / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x" * 16)
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            self.assertEqual(
                [item["name"] for item in response.payload],
                ["mmproj-extra/other.gguf", "vendor/mmproj/nested.gguf"],
            )

    def test_models_route_returns_empty_list_without_models_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            self.assertEqual(response.payload, [])

    def test_models_route_lists_names_relative_to_custom_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            custom = Path(tmp) / "custom-library"
            nested = custom / "vendor" / "model.gguf"
            nested.parent.mkdir(parents=True)
            nested.write_bytes(b"x" * 1024)
            model_dir_service.set_models_dir(ctx, str(custom))
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            self.assertEqual(response.status, 200)
            self.assertIsInstance(response.payload, list)
            self.assertEqual(response.payload[0]["name"], "vendor/model.gguf")

    def test_models_route_blocks_when_custom_root_disappears(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            custom = Path(tmp) / "custom-library"
            custom.mkdir()
            model_dir_service.set_models_dir(ctx, str(custom))
            custom.rmdir()
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            self.assertEqual(response.status, 409)
            self.assertIn("does not exist", response.payload["error"])

    def test_benchmark_wikitext2_route_reuses_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            dataset_dir = ctx.paths.models / "wikitext-2-raw-v1"
            dataset_dir.mkdir(parents=True)
            target = dataset_dir / "wiki.test.raw"
            target.write_text("already here", encoding="utf-8")
            response = DummyResponse()

            benchmarks.ensure_wikitext2(Request("POST", "/api/benchmark/wikitext2", "", {}), response, ctx)

            self.assertEqual(response.payload, {"ready": True, "downloaded": False, "path": str(target)})

    def test_benchmark_wikitext2_route_downloads_and_extracts_test_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            zip_payload = io.BytesIO()
            with zipfile.ZipFile(zip_payload, "w") as archive:
                archive.writestr("wikitext-2-raw/wiki.train.raw", "train")
                archive.writestr("wikitext-2-raw/wiki.test.raw", "test data")
            ctx.services.urlopen_with_ssl = mock.Mock(return_value=FakeBinaryUpstream(zip_payload.getvalue()))
            response = DummyResponse()

            benchmarks.ensure_wikitext2(Request("POST", "/api/benchmark/wikitext2", "", {}), response, ctx)

            target = ctx.paths.models / "wikitext-2-raw-v1" / "wiki.test.raw"
            self.assertEqual(response.payload, {"ready": True, "downloaded": True, "path": str(target)})
            self.assertEqual(target.read_text(encoding="utf-8"), "test data")

    def test_benchmark_wikitext2_route_leaves_no_file_when_extraction_fails(self):
        """A failed extraction must not leave a truncated file that exists() accepts."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            zip_payload = io.BytesIO()
            with zipfile.ZipFile(zip_payload, "w") as archive:
                archive.writestr("wikitext-2-raw/wiki.test.raw", "test data")
            ctx.services.urlopen_with_ssl = mock.Mock(return_value=FakeBinaryUpstream(zip_payload.getvalue()))
            response = DummyResponse()
            target = ctx.paths.models / "wikitext-2-raw-v1" / "wiki.test.raw"

            real_copyfileobj = benchmarks.shutil.copyfileobj

            def fail_extraction_only(src, dest, *args, **kwargs):
                # Let the zip download through; blow up only on the extraction
                # write, which is the step that used to leave a stub behind.
                if str(getattr(dest, "name", "")).endswith(".zip"):
                    return real_copyfileobj(src, dest, *args, **kwargs)
                raise OSError("disk full")

            with mock.patch.object(
                benchmarks.shutil, "copyfileobj", side_effect=fail_extraction_only
            ):
                benchmarks.ensure_wikitext2(
                    Request("POST", "/api/benchmark/wikitext2", "", {}), response, ctx
                )

            self.assertEqual(response.status, 500)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_name(target.name + ".part").exists())

    def test_benchmark_wikitext2_route_rejects_short_extraction(self):
        """A short write is caught rather than promoted to the final path."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            zip_payload = io.BytesIO()
            with zipfile.ZipFile(zip_payload, "w") as archive:
                archive.writestr("wikitext-2-raw/wiki.test.raw", "test data")
            ctx.services.urlopen_with_ssl = mock.Mock(return_value=FakeBinaryUpstream(zip_payload.getvalue()))
            response = DummyResponse()
            target = ctx.paths.models / "wikitext-2-raw-v1" / "wiki.test.raw"

            real_copyfileobj = benchmarks.shutil.copyfileobj

            def short_copy(src, dest, *args, **kwargs):
                # Only truncate the extraction step; the zip download above uses
                # copyfileobj too and must complete or this tests the wrong path.
                if str(getattr(dest, "name", "")).endswith(".part"):
                    dest.write(b"test")  # 4 of the 9 expected bytes
                    return None
                return real_copyfileobj(src, dest, *args, **kwargs)

            with mock.patch.object(benchmarks.shutil, "copyfileobj", side_effect=short_copy):
                benchmarks.ensure_wikitext2(
                    Request("POST", "/api/benchmark/wikitext2", "", {}), response, ctx
                )

            self.assertEqual(response.status, 500)
            self.assertFalse(target.exists())

    def test_presets_routes_list_save_and_delete(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()
            save_request = Request(
                "POST",
                "/api/presets",
                "",
                {},
                body={"name": "My/Preset", "data": {"temperature": 0.7}},
            )

            presets.save_preset(save_request, response, ctx)

            self.assertEqual(response.payload, {"saved": True, "name": "My_Preset"})
            self.assertTrue((ctx.paths.presets / "My_Preset.json").exists())

            list_response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), list_response, ctx)
            self.assertEqual(len(list_response.payload), 1)
            listed = list_response.payload[0]
            self.assertEqual(listed["name"], "My_Preset")
            self.assertEqual(listed["data"], {"temperature": 0.7})
            self.assertIsInstance(listed["created"], float)
            self.assertIsInstance(listed["modified"], float)

            created = listed["created"]
            update_response = DummyResponse()
            with mock.patch("backend.routes.presets.time.time", return_value=created + 1000):
                presets.save_preset(
                    Request(
                        "POST",
                        "/api/presets",
                        "",
                        {},
                        body={"name": "My/Preset", "data": {"temperature": 0.8}},
                    ),
                    update_response,
                    ctx,
                )
            updated_list_response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), updated_list_response, ctx)
            self.assertEqual(updated_list_response.payload[0]["created"], created)
            self.assertEqual(updated_list_response.payload[0]["data"], {"temperature": 0.8})

            delete_response = DummyResponse()
            delete_request = Request(
                "DELETE",
                "/api/presets/My_Preset",
                "",
                {},
                params={"name": "My_Preset"},
            )
            presets.delete_preset(delete_request, delete_response, ctx)
            self.assertEqual(delete_response.payload, {"deleted": True})
            self.assertFalse((ctx.paths.presets / "My_Preset.json").exists())
            self.assertEqual(
                json.loads((ctx.paths.presets / ".preset-created-times").read_text(encoding="utf-8")),
                {},
            )

    def test_presets_archive_route_flags_restores_and_validates(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            for name in ("Keep", "Shelve"):
                presets.save_preset(
                    Request("POST", "/api/presets", "", {}, body={"name": name, "data": {"temperature": 0.5}}),
                    DummyResponse(),
                    ctx,
                )

            archive_response = DummyResponse()
            presets.archive_presets(
                Request("POST", "/api/presets/archive", "", {}, body={"names": ["Shelve"], "archived": True}),
                archive_response,
                ctx,
            )
            self.assertEqual(archive_response.payload, {"archived": True, "count": 1})

            list_response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), list_response, ctx)
            flags = {entry["name"]: entry["archived"] for entry in list_response.payload}
            self.assertEqual(flags, {"Keep": False, "Shelve": True})

            restore_response = DummyResponse()
            presets.archive_presets(
                Request("POST", "/api/presets/archive", "", {}, body={"names": ["Shelve"], "archived": False}),
                restore_response,
                ctx,
            )
            self.assertEqual(restore_response.payload, {"archived": False, "count": 1})
            list_response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), list_response, ctx)
            self.assertFalse(any(entry["archived"] for entry in list_response.payload))

            missing_response = DummyResponse()
            presets.archive_presets(
                Request("POST", "/api/presets/archive", "", {}, body={"names": ["Missing"], "archived": True}),
                missing_response,
                ctx,
            )
            self.assertEqual(missing_response.status, 404)

            empty_response = DummyResponse()
            presets.archive_presets(
                Request("POST", "/api/presets/archive", "", {}, body={"names": [], "archived": True}),
                empty_response,
                ctx,
            )
            self.assertEqual(empty_response.status, 400)

            for archived in (None, 0, 1, "false"):
                with self.subTest(archived=archived):
                    invalid_response = DummyResponse()
                    presets.archive_presets(
                        Request(
                            "POST",
                            "/api/presets/archive",
                            "",
                            {},
                            body={"names": ["Shelve"], "archived": archived},
                        ),
                        invalid_response,
                        ctx,
                    )
                    self.assertEqual(invalid_response.status, 400)

    def test_presets_archive_route_reports_metadata_write_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            presets.save_preset(
                Request("POST", "/api/presets", "", {}, body={"name": "Shelve", "data": {}}),
                DummyResponse(),
                ctx,
            )
            response = DummyResponse()
            stderr = io.StringIO()

            with mock.patch.object(
                presets, "_write_preset_json", side_effect=OSError("disk full")
            ), contextlib.redirect_stderr(stderr):
                presets.archive_presets(
                    Request(
                        "POST",
                        "/api/presets/archive",
                        "",
                        {},
                        body={"names": ["Shelve"], "archived": True},
                    ),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 500)
            self.assertEqual(response.payload["error"], "Internal server error")
            self.assertIn("disk full", stderr.getvalue())

    def test_presets_archive_route_serializes_concurrent_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            for name in ("First", "Second"):
                presets.save_preset(
                    Request("POST", "/api/presets", "", {}, body={"name": name, "data": {}}),
                    DummyResponse(),
                    ctx,
                )

            real_load = presets._load_preset_archived
            load_count = 0
            load_count_lock = threading.Lock()
            both_loaded = threading.Event()
            errors = []

            def slow_load(presets_dir):
                nonlocal load_count
                archived_names = real_load(presets_dir)
                with load_count_lock:
                    load_count += 1
                    if load_count == 2:
                        both_loaded.set()
                both_loaded.wait(0.15)
                return archived_names

            def archive(name):
                try:
                    presets.archive_presets(
                        Request(
                            "POST",
                            "/api/presets/archive",
                            "",
                            {},
                            body={"names": [name], "archived": True},
                        ),
                        DummyResponse(),
                        ctx,
                    )
                except Exception as exc:
                    errors.append(exc)

            with mock.patch.object(presets, "_load_preset_archived", side_effect=slow_load):
                threads = [threading.Thread(target=archive, args=(name,)) for name in ("First", "Second")]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(2)

            self.assertFalse(errors)
            self.assertFalse(any(thread.is_alive() for thread in threads))
            self.assertEqual(
                json.loads((ctx.paths.presets / ".preset-archived").read_text(encoding="utf-8")),
                ["First.json", "Second.json"],
            )

    def test_delete_preset_clears_archive_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            presets.save_preset(
                Request("POST", "/api/presets", "", {}, body={"name": "Shelve", "data": {"temperature": 0.5}}),
                DummyResponse(),
                ctx,
            )
            presets.archive_presets(
                Request("POST", "/api/presets/archive", "", {}, body={"names": ["Shelve"], "archived": True}),
                DummyResponse(),
                ctx,
            )

            presets.delete_preset(
                Request("DELETE", "/api/presets/Shelve", "", {}, params={"name": "Shelve"}),
                DummyResponse(),
                ctx,
            )

            self.assertEqual(
                json.loads((ctx.paths.presets / ".preset-archived").read_text(encoding="utf-8")),
                [],
            )

    def test_list_presets_reads_utf8_explicitly(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.presets.mkdir(parents=True)
            preset_path = ctx.paths.presets / "Unicode.json"
            preset_path.write_text(
                json.dumps({"notes": "café 漢字"}, ensure_ascii=False),
                encoding="utf-8",
            )
            response = DummyResponse()

            with mock.patch.object(
                presets, "open", wraps=open, create=True
            ) as open_file:
                presets.list_presets(
                    Request("GET", "/api/presets", "", {}), response, ctx
                )

            self.assertEqual(response.payload[0]["data"]["notes"], "café 漢字")
            self.assertEqual(open_file.call_args.kwargs["encoding"], "utf-8")

    def test_save_preset_can_reject_overwrite_for_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            presets.save_preset(
                Request(
                    "POST",
                    "/api/presets",
                    "",
                    {},
                    body={"name": "Existing", "data": {"temperature": 0.7}},
                ),
                DummyResponse(),
                ctx,
            )

            response = DummyResponse()
            presets.save_preset(
                Request(
                    "POST",
                    "/api/presets",
                    "",
                    {},
                    body={
                        "name": "Existing",
                        "data": {"temperature": 0.1},
                        "overwrite": False,
                    },
                ),
                response,
                ctx,
            )

            self.assertEqual(response.status, 409)
            self.assertEqual(
                json.loads((ctx.paths.presets / "Existing.json").read_text(encoding="utf-8")),
                {"temperature": 0.7},
            )

    def test_rename_preset_moves_file_and_keeps_created_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            presets.save_preset(
                Request("POST", "/api/presets", "", {}, body={"name": "Original", "data": {"temperature": 0.7}}),
                DummyResponse(),
                ctx,
            )
            list_response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), list_response, ctx)
            created = list_response.payload[0]["created"]
            presets.archive_presets(
                Request(
                    "POST",
                    "/api/presets/archive",
                    "",
                    {},
                    body={"names": ["Original"], "archived": True},
                ),
                DummyResponse(),
                ctx,
            )

            response = DummyResponse()
            presets.rename_preset(
                Request("POST", "/api/presets/rename", "", {}, body={"name": "Original", "new_name": "Renamed"}),
                response,
                ctx,
            )

            self.assertEqual(response.payload, {"renamed": True, "name": "Renamed"})
            self.assertFalse((ctx.paths.presets / "Original.json").exists())
            self.assertTrue((ctx.paths.presets / "Renamed.json").exists())

            renamed_list = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), renamed_list, ctx)
            self.assertEqual(len(renamed_list.payload), 1)
            self.assertEqual(renamed_list.payload[0]["name"], "Renamed")
            self.assertEqual(renamed_list.payload[0]["data"], {"temperature": 0.7})
            self.assertEqual(renamed_list.payload[0]["created"], created)
            self.assertTrue(renamed_list.payload[0]["archived"])
            self.assertEqual(
                json.loads((ctx.paths.presets / ".preset-created-times").read_text(encoding="utf-8")),
                {"Renamed.json": created},
            )
            self.assertEqual(
                json.loads((ctx.paths.presets / ".preset-archived").read_text(encoding="utf-8")),
                ["Renamed.json"],
            )

    def test_rename_preset_applies_a_case_only_change(self):
        """Windows resolve()/Path equality are case-insensitive; the rename must still land."""
        import os

        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            presets.save_preset(
                Request("POST", "/api/presets", "", {}, body={"name": "Base", "data": {"temperature": 0.7}}),
                DummyResponse(),
                ctx,
            )
            list_response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), list_response, ctx)
            created = list_response.payload[0]["created"]

            response = DummyResponse()
            presets.rename_preset(
                Request("POST", "/api/presets/rename", "", {}, body={"name": "Base", "new_name": "base"}),
                response,
                ctx,
            )

            self.assertEqual(response.payload, {"renamed": True, "name": "base"})
            on_disk = [name for name in os.listdir(ctx.paths.presets) if name.endswith(".json")]
            self.assertEqual(on_disk, ["base.json"], "the file must actually take the new casing")

            renamed_list = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), renamed_list, ctx)
            self.assertEqual(renamed_list.payload[0]["name"], "base")
            self.assertEqual(
                renamed_list.payload[0]["created"],
                created,
                "a case-only rename must still carry the creation time",
            )
            self.assertEqual(
                json.loads((ctx.paths.presets / ".preset-created-times").read_text(encoding="utf-8")),
                {"base.json": created},
                "stale metadata under the old casing would break Date-added sorting",
            )

    def test_rename_preset_treats_an_identical_name_as_a_no_op(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            presets.save_preset(
                Request("POST", "/api/presets", "", {}, body={"name": "Same", "data": {"temperature": 0.7}}),
                DummyResponse(),
                ctx,
            )
            response = DummyResponse()
            presets.rename_preset(
                Request("POST", "/api/presets/rename", "", {}, body={"name": "Same", "new_name": "Same"}),
                response,
                ctx,
            )
            self.assertEqual(response.payload, {"renamed": True, "name": "Same"})
            self.assertTrue((ctx.paths.presets / "Same.json").exists())

    def test_rename_preset_rejects_missing_source_and_existing_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            for name in ("First", "Second"):
                presets.save_preset(
                    Request("POST", "/api/presets", "", {}, body={"name": name, "data": {"temperature": 0.7}}),
                    DummyResponse(),
                    ctx,
                )

            missing = DummyResponse()
            presets.rename_preset(
                Request("POST", "/api/presets/rename", "", {}, body={"name": "Ghost", "new_name": "Whatever"}),
                missing,
                ctx,
            )
            self.assertEqual(missing.status, 404)

            collision = DummyResponse()
            presets.rename_preset(
                Request("POST", "/api/presets/rename", "", {}, body={"name": "First", "new_name": "Second"}),
                collision,
                ctx,
            )
            self.assertEqual(collision.status, 409)
            self.assertTrue((ctx.paths.presets / "First.json").exists())
            self.assertEqual(
                json.loads((ctx.paths.presets / "Second.json").read_text(encoding="utf-8")),
                {"temperature": 0.7},
            )

            invalid = DummyResponse()
            presets.rename_preset(
                Request("POST", "/api/presets/rename", "", {}, body={"name": "First", "new_name": "///"}),
                invalid,
                ctx,
            )
            self.assertEqual(invalid.status, 400)

            unchanged = DummyResponse()
            presets.rename_preset(
                Request("POST", "/api/presets/rename", "", {}, body={"name": "First", "new_name": "First"}),
                unchanged,
                ctx,
            )
            self.assertEqual(unchanged.payload, {"renamed": True, "name": "First"})
            self.assertTrue((ctx.paths.presets / "First.json").exists())

    def test_list_presets_skips_malformed_file_with_stderr_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.presets.mkdir(parents=True)
            (ctx.paths.presets / "Good.json").write_text(json.dumps({"temperature": 0.7}))
            (ctx.paths.presets / "Broken.json").write_text("{not valid json")
            response = DummyResponse()
            stderr = io.StringIO()

            with contextlib.redirect_stderr(stderr):
                presets.list_presets(Request("GET", "/api/presets", "", {}), response, ctx)

            self.assertEqual(len(response.payload), 1)
            self.assertEqual(response.payload[0]["name"], "Good")
            self.assertEqual(response.payload[0]["data"], {"temperature": 0.7})
            self.assertIn("Broken.json", stderr.getvalue())
            self.assertIn("JSONDecodeError", stderr.getvalue())

    def test_presets_never_store_or_return_api_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.presets.mkdir(parents=True)
            legacy_path = ctx.paths.presets / "Legacy.json"
            legacy_path.write_text(
                json.dumps({"tool": "llama-server", "flags": {"api_key": "legacy-secret", "temperature": 0.7}}),
                encoding="utf-8",
            )

            response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), response, ctx)
            self.assertEqual(response.payload[0]["data"]["flags"], {"temperature": 0.7})
            self.assertNotIn("legacy-secret", legacy_path.read_text(encoding="utf-8"))

            save_response = DummyResponse()
            presets.save_preset(
                Request(
                    "POST",
                    "/api/presets",
                    "",
                    {},
                    body={"name": "Protected", "data": {"api_key": "new-secret", "temperature": 0.8}},
                ),
                save_response,
                ctx,
            )
            saved = json.loads((ctx.paths.presets / "Protected.json").read_text(encoding="utf-8"))
            self.assertEqual(saved, {"temperature": 0.8})

            legacy_path.write_text(
                json.dumps({"flags": {"custom_args": "--metrics --api-key legacy-secret", "temperature": 0.7}}),
                encoding="utf-8",
            )
            list_response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), list_response, ctx)
            self.assertEqual(list_response.payload[0]["data"]["flags"], {"temperature": 0.7})
            self.assertNotIn("legacy-secret", legacy_path.read_text(encoding="utf-8"))

            rejected_response = DummyResponse()
            presets.save_preset(
                Request(
                    "POST",
                    "/api/presets",
                    "",
                    {},
                    body={
                        "name": "Rejected",
                        "data": {"flags": {"custom_args": "--api-key=must-not-save"}},
                    },
                ),
                rejected_response,
                ctx,
            )
            self.assertEqual(rejected_response.status, 400)
            self.assertIn("Custom Launch Args", rejected_response.payload["error"])
            self.assertFalse((ctx.paths.presets / "Rejected.json").exists())

    def test_preset_delete_uses_same_sanitizer_as_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()
            save_request = Request(
                "POST",
                "/api/presets",
                "",
                {},
                body={"name": "../Odd Name. ", "data": {"ok": True}},
            )
            presets.save_preset(save_request, response, ctx)

            self.assertEqual(response.payload, {"saved": True, "name": "Odd Name"})

            delete_response = DummyResponse()
            delete_request = Request(
                "DELETE",
                "/api/presets/..%2FOdd%20Name.%20",
                "",
                {},
                params={"name": "..%2FOdd%20Name.%20"},
            )
            presets.delete_preset(delete_request, delete_response, ctx)

            self.assertEqual(delete_response.payload, {"deleted": True})
            self.assertFalse((ctx.paths.presets / "Odd Name.json").exists())

    def test_preset_name_sanitizer_rejects_empty_and_stays_in_presets_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            self.assertEqual(presets.sanitize_preset_name("... /// ___"), "")
            self.assertEqual(presets.sanitize_preset_name("../../../etc/passwd"), "etc_passwd")
            self.assertIsNone(presets.get_preset_file_path(ctx.paths.presets, "../escape"))

            response = DummyResponse()
            save_request = Request(
                "POST",
                "/api/presets",
                "",
                {},
                body={"name": "... /// ___", "data": {"ok": True}},
            )

            presets.save_preset(save_request, response, ctx)

            self.assertEqual(response.payload, {"error": "Invalid preset name", "status": 400})

    def test_presets_route_skips_bulk_export_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.presets.mkdir(parents=True)
            (ctx.paths.presets / "single.json").write_text(
                json.dumps({"model": "model.gguf", "flags": {"ctx_size": 4096}})
            )
            (ctx.paths.presets / "llama-gui-presets.json").write_text(
                json.dumps({
                    "presets": [
                        {"name": "single", "data": {"model": "model.gguf", "flags": {}}}
                    ]
                })
            )

            response = DummyResponse()
            presets.list_presets(Request("GET", "/api/presets", "", {}), response, ctx)

            self.assertEqual(len(response.payload), 1)
            self.assertEqual(response.payload[0]["name"], "single")
            self.assertEqual(
                response.payload[0]["data"],
                {"model": "model.gguf", "flags": {"ctx_size": 4096}},
            )

    def test_preset_shortcut_exports_cmd_that_opens_preset_without_llama_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.presets.mkdir(parents=True)
            (ctx.paths.presets / "My Preset.json").write_text(json.dumps({"flags": {"ctx_size": 4096}}))
            response = DummyResponse()

            presets.export_preset_shortcut(
                Request("POST", "/api/presets/shortcut", "", {}, body={"name": "My Preset"}),
                response,
                ctx,
            )

            self.assertEqual(response.status, 200)
            self.assertIn("@echo off", response.text_payload)
            self.assertIn("server.py", response.text_payload)
            self.assertIn("/?preset=My%%20Preset", response.text_payload)
            self.assertNotIn("/api/launch", response.text_payload)
            self.assertNotIn("llama-server", response.text_payload)

    def test_preset_shortcut_requires_existing_preset(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()

            presets.export_preset_shortcut(
                Request("POST", "/api/presets/shortcut", "", {}, body={"name": "../Missing"}),
                response,
                ctx,
            )

            self.assertEqual(response.payload, {"error": "Preset not found", "status": 404})

    def test_metrics_route_uses_context_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            calls = []

            def get_local_llama_metrics(host, port, authorization):
                calls.append((host, port, authorization))
                return "llama metrics", ""

            ctx.services.get_local_llama_metrics = get_local_llama_metrics
            response = DummyResponse()

            metrics.get_metrics(
                Request("GET", "/api/llama/metrics", "host=localhost&port=9090", {"Authorization": "Bearer secret"}),
                response,
                ctx,
            )

            self.assertEqual(calls, [("localhost", "9090", "Bearer secret")])
            self.assertEqual(response.text_payload, "llama metrics")

    def test_metrics_route_prefers_running_server_api_key_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.process = mock.Mock()
            ctx.state.process.poll.return_value = None
            ctx.state.active_process_tool = "llama-server"
            ctx.state.active_llama_api_keys = ("launch-key",)
            calls = []

            def get_local_llama_metrics(host, port, authorization):
                calls.append(authorization)
                return "metrics", ""

            ctx.services.get_local_llama_metrics = get_local_llama_metrics
            response = DummyResponse()

            metrics.get_metrics(
                Request("GET", "/api/llama/metrics", "", {"Authorization": "Bearer pending-key"}),
                response,
                ctx,
            )

            self.assertEqual(calls, ["Bearer launch-key"])

    def test_metrics_and_slots_prefer_active_runtime_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.process = mock.Mock()
            ctx.state.process.poll.return_value = None
            ctx.state.active_process_tool = "llama-server"
            ctx.state.active_runtime = {
                "generation": 3,
                "tool": "llama-server",
                "host": "127.0.0.2",
                "port": 8123,
            }
            calls = []
            ctx.services.get_local_llama_metrics = lambda host, port, authorization: (
                calls.append(("metrics", host, port)) or "metrics",
                "",
            )
            ctx.services.get_local_llama_slots = lambda host, port, authorization: (
                calls.append(("slots", host, port)) or "[]",
                "",
            )

            metrics.get_metrics(
                Request("GET", "/api/llama/metrics", "host=pending&port=9999", {}),
                DummyResponse(),
                ctx,
            )
            metrics.get_slots(
                Request("GET", "/api/llama/slots", "host=pending&port=9999", {}),
                DummyResponse(),
                ctx,
            )

            self.assertEqual(
                calls,
                [("metrics", "127.0.0.2", 8123), ("slots", "127.0.0.2", 8123)],
            )

    def test_slots_route_uses_context_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            calls = []

            def get_local_llama_slots(host, port, authorization):
                calls.append((host, port, authorization))
                return '[{"id":0,"n_ctx":4096}]', ""

            ctx.services.get_local_llama_slots = get_local_llama_slots
            response = DummyResponse()

            metrics.get_slots(
                Request("GET", "/api/llama/slots", "host=localhost&port=9090", {"Authorization": "Bearer secret"}),
                response,
                ctx,
            )

            self.assertEqual(calls, [("localhost", "9090", "Bearer secret")])
            self.assertEqual(response.text_payload, '[{"id":0,"n_ctx":4096}]')

    def test_slots_route_returns_proxy_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            def get_local_llama_slots(host, port, authorization):
                return None, "llama-server slots returned HTTP 404."

            ctx.services.get_local_llama_slots = get_local_llama_slots
            response = DummyResponse()

            metrics.get_slots(
                Request("GET", "/api/llama/slots", "host=localhost&port=9090", {}),
                response,
                ctx,
            )

            self.assertEqual(response.status, 502)
            self.assertEqual(response.payload["error"], "llama-server slots returned HTTP 404.")

    def test_props_route_uses_context_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            calls = []

            def get_local_llama_props(host, port, authorization):
                calls.append((host, port, authorization))
                return '{"chat_template_caps":{"supports_reasoning_effort":true}}', ""

            ctx.services.get_local_llama_props = get_local_llama_props
            response = DummyResponse()

            metrics.get_props(
                Request("GET", "/api/llama/props", "host=localhost&port=9090", {"Authorization": "Bearer secret"}),
                response,
                ctx,
            )

            self.assertEqual(calls, [("localhost", "9090", "Bearer secret")])
            self.assertEqual(
                response.text_payload,
                '{"chat_template_caps":{"supports_reasoning_effort":true}}',
            )

    def test_props_route_returns_proxy_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            def get_local_llama_props(host, port, authorization):
                return None, "llama-server props returned HTTP 404."

            ctx.services.get_local_llama_props = get_local_llama_props
            response = DummyResponse()

            metrics.get_props(
                Request("GET", "/api/llama/props", "host=localhost&port=9090", {}),
                response,
                ctx,
            )

            self.assertEqual(response.status, 502)
            self.assertEqual(response.payload["error"], "llama-server props returned HTTP 404.")

    def test_status_route_uses_context_services(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            cli_path = ctx.paths.llama_bin / "llama-cli.exe"
            server_path = ctx.paths.llama_bin / "llama-server.exe"
            cli_path.parent.mkdir(parents=True)
            cli_path.write_text("")
            server_path.write_text("")
            ctx.services = BackendServices(
                backend_specs={"cpu": {"label": "CPU"}},
                binary_suffix=".exe",
                current_arch="x64",
                current_platform="win32",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / f"{tool}.exe",
                get_platform_label=lambda: "Windows",
                get_runtime_files=lambda: [SimpleNamespace(name="runtime.dll")],
                get_tool_filename=lambda tool: f"{tool}.exe",
                is_process_running=lambda: False,
                llama_tools=["llama-cli", "llama-server"],
                load_config=lambda: {"tag": "b1", "backend": "cpu"},
            )
            ctx.state.last_exit_code = 7
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertTrue(response.payload["installed"])
            self.assertEqual(response.payload["models_dir"], str(ctx.paths.models))
            self.assertEqual(response.payload["models_arg_root"], "models")
            self.assertTrue(response.payload["models_dir_is_default"])
            self.assertTrue(response.payload["models_dir_available"])
            self.assertEqual(response.payload["available_backends"], [{"id": "cpu", "label": "CPU"}])
            self.assertIsNone(response.payload["active_process_tool"])
            self.assertIsNone(response.payload["active_runtime"])
            self.assertEqual(response.payload["runtime_generation"], 0)
            self.assertFalse(response.payload["api_auth_configured"])
            self.assertEqual(response.payload["last_exit_code"], 7)

    def test_status_route_reports_unavailable_custom_models_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            custom = Path(tmp) / "custom-library"
            custom.mkdir()
            model_dir_service.set_models_dir(ctx, str(custom))
            custom.rmdir()
            configure_status_services(ctx)
            ctx.services.load_config = lambda: {
                "tag": "b1",
                "backend": "cpu",
                "models_dir": str(custom),
            }
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertEqual(response.status, 200)
            self.assertEqual(response.payload["models_dir"], str(custom))
            self.assertFalse(response.payload["models_dir_is_default"])
            self.assertFalse(response.payload["models_dir_available"])
            self.assertIn("does not exist", response.payload["models_dir_error"])

    def test_models_dir_route_sets_resets_and_rejects_busy_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            custom = Path(tmp) / "custom-library"
            custom.mkdir()
            response = DummyResponse()

            model_dir_route.set_models_dir(
                Request("POST", "/api/models-dir", "", {}, body={"path": str(custom)}),
                response,
                ctx,
            )
            self.assertEqual(response.status, 200)
            self.assertEqual(response.payload["models_dir"], str(custom.resolve()))

            response = DummyResponse()
            model_dir_route.set_models_dir(
                Request("POST", "/api/models-dir", "", {}, body={"path": None}),
                response,
                ctx,
            )
            self.assertEqual(response.status, 200)
            self.assertTrue(response.payload["models_dir_is_default"])

            ctx.state.model_download_in_progress = True
            response = DummyResponse()
            model_dir_route.set_models_dir(
                Request("POST", "/api/models-dir", "", {}, body={"path": str(custom)}),
                response,
                ctx,
            )
            self.assertEqual(response.status, 409)

            ctx.state.model_download_in_progress = False
            response = DummyResponse()
            model_dir_route.set_models_dir(
                Request("POST", "/api/models-dir", "", {}, body={}),
                response,
                ctx,
            )
            self.assertEqual(response.status, 400)

    def test_status_route_marks_non_executable_unix_tools_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            cli_path = ctx.paths.llama_bin / "llama-cli"
            server_path = ctx.paths.llama_bin / "llama-server"
            cli_path.parent.mkdir(parents=True)
            cli_path.write_text("binary")
            server_path.write_text("binary")
            ctx.services = BackendServices(
                backend_specs={"cpu": {"label": "CPU"}},
                current_arch="x64",
                current_platform="linux",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
                get_platform_label=lambda: "Linux",
                get_runtime_files=lambda: [],
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli", "llama-server"],
                load_config=lambda: {"tag": "b1", "backend": "cpu"},
            )
            response = DummyResponse()

            with mock.patch.object(status.os, "access", return_value=False):
                status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertEqual(
                response.payload["executables"],
                {"llama-cli": False, "llama-server": False},
            )
            self.assertFalse(response.payload["installed"])
            self.assertTrue(response.payload["config_stale"])

    def test_status_route_exposes_safe_active_runtime_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            runtime = {
                "generation": 4,
                "tool": "llama-server",
                "model": "models/qwen.gguf",
                "alias": "qwen-local",
                "host": "127.0.0.1",
                "port": 9090,
                "source": "model-switcher",
                "slot": "a",
                "preset": "Qwen Balanced",
                "preset_fingerprint": "abc123",
            }
            ctx.state.process = mock.Mock()
            ctx.state.process.poll.return_value = None
            ctx.state.active_process_tool = "llama-server"
            ctx.state.active_runtime = runtime
            ctx.state.runtime_generation = 4
            ctx.services = BackendServices(
                backend_specs={},
                current_arch="x64",
                current_platform="linux",
                get_platform_label=lambda: "Linux",
                get_runtime_files=lambda: [],
                get_tool_filename=lambda tool: tool,
                get_llama_api_target=lambda: {"host": "127.0.0.1", "port": 9090},
                is_process_running=lambda: True,
                llama_tools=[],
                load_config=lambda: {},
            )
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertTrue(response.payload["running"])
            self.assertEqual(response.payload["active_runtime"], runtime)
            self.assertEqual(response.payload["runtime_generation"], 4)
            self.assertIsNot(response.payload["active_runtime"], ctx.state.active_runtime)

    def test_status_route_marks_install_stale_when_runtime_library_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            cli_path = ctx.paths.llama_bin / "llama-cli"
            server_path = ctx.paths.llama_bin / "llama-server"
            cli_path.parent.mkdir(parents=True)
            cli_path.write_text("")
            server_path.write_text("")
            cli_path.chmod(0o755)
            server_path.chmod(0o755)
            ctx.services = BackendServices(
                backend_specs={"metal": {"label": "Metal"}},
                current_arch="arm64",
                current_platform="darwin",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
                get_platform_label=lambda: "macOS",
                get_runtime_files=lambda: [],
                get_tool_filename=lambda tool: tool,
                is_process_running=lambda: False,
                llama_tools=["llama-cli", "llama-server"],
                load_config=lambda: {"tag": "b1", "backend": "metal"},
                validate_runtime_dependencies=lambda: {
                    "ok": False,
                    "checked": True,
                    "required_runtime_files": ["libllama-common.0.dylib"],
                    "missing_runtime_files": ["libllama-common.0.dylib"],
                },
            )
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertFalse(response.payload["installed"])
            self.assertTrue(response.payload["config_stale"])
            self.assertEqual(response.payload["missing_runtime_files"], ["libllama-common.0.dylib"])

    def test_status_route_marks_custom_stale_when_core_tool_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            cli_path = ctx.paths.llama_custom_bin / "llama-cli"
            cli_path.parent.mkdir(parents=True)
            cli_path.write_text("")
            cli_path.chmod(0o755)
            ctx.services = BackendServices(
                backend_specs={"custom": {"label": "Custom (User-Provided)"}},
                current_arch="x64",
                current_platform="linux",
                find_tool_executable=lambda tool: ctx.paths.llama_custom_bin / tool,
                get_platform_label=lambda: "Linux",
                get_runtime_files=lambda: [],
                get_tool_filename=lambda tool: tool,
                is_process_running=lambda: False,
                llama_tools=["llama-cli", "llama-server"],
                load_config=lambda: {"tag": "custom", "backend": "custom"},
            )
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertFalse(response.payload["installed"])
            self.assertTrue(response.payload["config_stale"])

    def test_status_route_marks_custom_stale_when_runtime_library_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            (ctx.paths.llama_custom_bin / "llama-cli").write_text("")
            (ctx.paths.llama_custom_bin / "llama-server").write_text("")
            (ctx.paths.llama_custom_bin / "llama-cli").chmod(0o755)
            (ctx.paths.llama_custom_bin / "llama-server").chmod(0o755)
            ctx.services = BackendServices(
                backend_specs={"custom": {"label": "Custom (User-Provided)"}},
                current_arch="arm64",
                current_platform="darwin",
                find_tool_executable=lambda tool: ctx.paths.llama_custom_bin / tool,
                get_platform_label=lambda: "macOS",
                get_runtime_files=lambda: [],
                get_tool_filename=lambda tool: tool,
                is_process_running=lambda: False,
                llama_tools=["llama-cli", "llama-server"],
                load_config=lambda: {"tag": "custom", "backend": "custom"},
                validate_runtime_dependencies=lambda: {
                    "ok": False,
                    "checked": True,
                    "required_runtime_files": ["libllama-common.0.dylib"],
                    "missing_runtime_files": ["libllama-common.0.dylib"],
                },
            )
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertFalse(response.payload["installed"])
            self.assertTrue(response.payload["config_stale"])
            self.assertEqual(response.payload["missing_runtime_files"], ["libllama-common.0.dylib"])

    def test_status_route_returns_error_when_service_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services.load_config = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
            response = DummyResponse()

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertEqual(response.status, 500)
            self.assertEqual(response.payload["error"], "Internal server error")
            self.assertIn("boom", stderr.getvalue())

    def test_status_route_logs_api_target_failure_before_using_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            configure_status_services(ctx)
            ctx.services.get_llama_api_target = lambda: (_ for _ in ()).throw(
                RuntimeError("target state unavailable")
            )
            response = DummyResponse()

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertEqual(
                response.payload["api_target"],
                {"host": status.LLAMA_HOST, "port": status.LLAMA_PORT},
            )
            self.assertIn("target state unavailable", stderr.getvalue())

    def test_process_output_route_reads_buffer_and_running_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.output_buffer.extend(["one", "two"])
            ctx.state.output_buffer_next = 2
            response = DummyResponse()

            process.get_output(Request("GET", "/api/output", "", {}), response, ctx)

            self.assertEqual(
                response.payload,
                {
                    "lines": ["one", "two"],
                    "next_cursor": 2,
                    "dropped": False,
                    "running": False,
                    "runtime_generation": 0,
                    "active_process_tool": None,
                    "output": ["one", "two"],
                },
            )

    def test_process_output_cursor_recovers_after_buffer_trim(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            with mock.patch.object(process_manager.config, "PROCESS_OUTPUT_LIMIT", 3), mock.patch.object(
                process_manager.config, "PROCESS_OUTPUT_TRIM", 2
            ):
                process_manager.stream_output(ctx, io.StringIO("one\ntwo\nthree\nfour\nfive\n"))

            response = DummyResponse()
            process.get_output(Request("GET", "/api/output", "since=0", {}), response, ctx)

            self.assertEqual(response.payload["lines"], ["three", "four", "five"])
            self.assertEqual(response.payload["next_cursor"], 5)
            self.assertTrue(response.payload["dropped"])

            next_response = DummyResponse()
            process.get_output(Request("GET", "/api/output", "since=3", {}), next_response, ctx)
            self.assertEqual(next_response.payload["lines"], ["four", "five"])
            self.assertFalse(next_response.payload["dropped"])

    def test_process_output_route_rejects_invalid_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            for query in ("since=invalid", "since=-1"):
                with self.subTest(query=query):
                    response = DummyResponse()
                    process.get_output(Request("GET", "/api/output", query, {}), response, ctx)
                    self.assertEqual(response.payload, {"error": "Invalid output cursor", "status": 400})

    def test_process_output_stays_running_until_current_readers_finish(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.process = SimpleNamespace(poll=lambda: 0)
            ctx.state.output_generation = 2
            ctx.state.output_reader_count = 1

            before = process_manager.get_output_snapshot(ctx)
            process_manager.stream_output(ctx, io.StringIO("final line\n"), generation=2)
            after = process_manager.get_output_snapshot(ctx, since=0)

            self.assertTrue(before["running"])
            self.assertEqual(after["lines"], ["final line"])
            self.assertFalse(after["running"])

    def test_process_output_ignores_readers_from_an_old_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.output_generation = 2
            ctx.state.output_reader_count = 2

            process_manager.stream_output(ctx, io.StringIO("old line\n"), generation=1)

            self.assertEqual(ctx.state.output_buffer, [])
            self.assertEqual(ctx.state.output_buffer_next, 0)
            self.assertEqual(ctx.state.output_reader_count, 2)

    def test_process_send_input_writes_to_running_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            class FakeProcess:
                def __init__(self):
                    self.stdin = io.StringIO()

                def poll(self):
                    return None

            ctx.state.process = FakeProcess()
            response = DummyResponse()

            process.send_input(
                Request("POST", "/api/send-input", "", {}, body={"text": "hello"}),
                response,
                ctx,
            )

            self.assertEqual(response.payload, {"sent": True})
            self.assertEqual(ctx.state.process.stdin.getvalue(), "hello\n")

    def test_memory_estimate_args_only_consumes_a_real_np_value(self):
        """A valueless -np used to swallow the following flag: the next token was
        consumed as its value unconditionally, so both were dropped."""
        cases = [
            # (input, expected output, why)
            (["-np", "8", "--verbose"], ["-np", "8", "--verbose"], "a valid value is kept"),
            (["-np=8", "--verbose"], ["-np=8", "--verbose"], "inline form is kept"),
            (["-np", "--verbose"], ["--verbose"], "a valueless -np must not eat the next flag"),
            (["--parallel", "--verbose"], ["--verbose"], "long form behaves the same"),
            (["-np"], [], "a trailing -np is simply dropped"),
            (["-np", "-1", "--verbose"], ["--verbose"], "a negative value is still its value"),
            (["-np", "999", "--verbose"], ["--verbose"], "an out-of-range value drops both"),
        ]
        for args, expected, why in cases:
            with self.subTest(args=args):
                self.assertEqual(process_manager._memory_estimate_args(list(args)), expected, why)

    def test_launch_does_not_hold_locks_across_runtime_validation(self):
        """_validate_launch_environment shells out to ldd/otool per packaged ggml
        library on Linux/macOS. Held under install_lock + process_lock it stalled
        status, stop and output for the whole run."""
        entered = threading.Event()
        release = threading.Event()

        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            def slow_validation(_ctx, _tool):
                entered.set()
                release.wait(5)
                return None, "stopped after the slow part"

            with mock.patch.object(process_manager, "_validate_launch_environment", slow_validation):
                launcher = threading.Thread(
                    target=process_manager.launch_process,
                    args=(ctx, "llama-server", []),
                    daemon=True,
                )
                launcher.start()
                self.assertTrue(entered.wait(5), "validation never started")

                install_free = ctx.state.install_lock.acquire(timeout=2)
                if install_free:
                    ctx.state.install_lock.release()
                process_free = ctx.state.process_lock.acquire(timeout=2)
                if process_free:
                    ctx.state.process_lock.release()

                release.set()
                launcher.join(5)

        self.assertTrue(install_free, "install_lock was held across runtime validation")
        self.assertTrue(process_free, "process_lock was held across runtime validation")

    def test_launch_rechecks_install_state_after_validation(self):
        """Moving validation outside the locks opens a window; the authoritative
        re-check inside them is what closes it."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            def validation_starts_an_install(_ctx, _tool):
                ctx.state.install_in_progress = True
                return Path(tmp) / "llama-server", None

            with mock.patch.object(
                process_manager, "_validate_launch_environment", validation_starts_an_install
            ):
                result = process_manager.launch_process(ctx, "llama-server", [])

        self.assertIn("Installation in progress", result.get("error", ""))

    def test_process_send_input_does_not_hold_process_lock_while_writing(self):
        """llama-server never drains stdin, so a full pipe blocks write() forever.
        Holding process_lock across that froze launch/stop/status permanently."""
        started = threading.Event()
        release = threading.Event()

        class BlockingStdin:
            def write(self, text):
                started.set()
                release.wait(5)

            def flush(self):
                pass

        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            class FakeProcess:
                def __init__(self):
                    self.stdin = BlockingStdin()

                def poll(self):
                    return None

            ctx.state.process = FakeProcess()

            sender = threading.Thread(
                target=process_manager.send_input, args=(ctx, "hello"), daemon=True
            )
            sender.start()
            self.assertTrue(started.wait(5), "stdin write never began")

            # The lock must be free while the write is stuck, or every other
            # process endpoint would be wedged behind it.
            acquired = ctx.state.process_lock.acquire(timeout=2)
            if acquired:
                ctx.state.process_lock.release()
            release.set()
            sender.join(5)

            self.assertTrue(acquired, "process_lock was held across the stdin write")

    def test_process_send_input_reports_failure_when_write_blocks(self):
        release = threading.Event()
        self.addCleanup(release.set)

        class BlockingStdin:
            def write(self, text):
                release.wait(30)

            def flush(self):
                pass

        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            class FakeProcess:
                def __init__(self):
                    self.stdin = BlockingStdin()

                def poll(self):
                    return None

            ctx.state.process = FakeProcess()

            with mock.patch.object(process_manager, "SEND_INPUT_TIMEOUT_SECONDS", 0.2):
                with contextlib.redirect_stderr(io.StringIO()) as captured:
                    sent = process_manager.send_input(ctx, "hello")

            self.assertFalse(sent)
            self.assertIn("timed out", captured.getvalue())

    def test_process_launch_rejects_non_array_args(self):
        """flatten_launch_args iterates whatever it gets, so a bare string became
        one argument per character instead of an error."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services.llama_tools = ["llama-server"]
            for bad_args in ("--verbose", {"a": 1}, 7):
                with self.subTest(args=bad_args):
                    response = DummyResponse()
                    process.launch(
                        Request(
                            "POST", "/api/launch", "", {},
                            body={"tool": "llama-server", "args": bad_args},
                        ),
                        response,
                        ctx,
                    )
                    self.assertEqual(response.status, 400)
                    self.assertIn("array", response.payload["error"])

    def test_process_cleanup_blocks_when_process_is_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            class FakeProcess:
                def poll(self):
                    return None

            ctx.state.process = FakeProcess()
            response = DummyResponse()

            process.cleanup_llama(Request("POST", "/api/cleanup-llama", "", {}, body={}), response, ctx)

            self.assertEqual(response.status, 400)
            self.assertEqual(response.payload["error"], "Stop running process first")

    def test_process_cleanup_blocks_during_an_install(self):
        """Cleanup rmtree's the directories an install extracts into, so it must
        claim the same slot rather than deleting files out from under one."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.install_in_progress = True
            response = DummyResponse()

            process.cleanup_llama(Request("POST", "/api/cleanup-llama", "", {}, body={}), response, ctx)

            self.assertEqual(response.status, 409)
            self.assertEqual(response.payload["error"], "Installation already in progress")
            self.assertTrue(ctx.state.install_in_progress, "a refused claim must not clear the flag")

    def test_process_cleanup_releases_the_install_slot(self):
        """Including on failure — otherwise one error permanently blocks installs."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            ctx.services.load_config = dict
            ctx.services.save_config = lambda _cfg: None
            response = DummyResponse()

            process.cleanup_llama(Request("POST", "/api/cleanup-llama", "", {}, body={}), response, ctx)
            self.assertFalse(ctx.state.install_in_progress, "slot must be released after success")

            with mock.patch.object(
                process.process_manager, "remove_llama_files", side_effect=OSError("in use")
            ):
                failing = DummyResponse()
                process.cleanup_llama(
                    Request("POST", "/api/cleanup-llama", "", {}, body={}), failing, ctx
                )

            self.assertEqual(failing.status, 500)
            self.assertFalse(ctx.state.install_in_progress, "slot must be released after failure too")

    def test_process_cleanup_removes_llama_files_and_resets_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-cli.exe").write_text("binary")
            remembered_target = {
                "host": "127.0.0.1",
                "port": 9001,
                "label": "External llama-server",
                "api_key_required": False,
            }
            ctx.services.load_config = lambda: {
                "external_chat_target": remembered_target,
                "official_install": {
                    "backend": "cpu",
                    "tag": "b1",
                    "version": "b1",
                },
            }
            saved = []
            ctx.services.save_config = saved.append
            response = DummyResponse()

            process.cleanup_llama(Request("POST", "/api/cleanup-llama", "", {}, body={}), response, ctx)

            self.assertEqual(response.payload, {"removed_files": 1})
            self.assertTrue(ctx.paths.llama_bin.exists())
            self.assertTrue(ctx.paths.llama_grammars.exists())
            self.assertEqual(
                saved,
                [
                    {
                        "external_chat_target": remembered_target,
                        "version": None,
                        "backend": None,
                        "tag": None,
                    }
                ],
            )

    def test_process_manager_flattens_nested_launch_args(self):
        self.assertEqual(
            process_manager.flatten_launch_args(["--host", "127.0.0.1", ["--port", 9090], 7]),
            ["--host", "127.0.0.1", "--port", "9090", "7"],
        )

    def test_process_manager_parse_launch_api_target_updates_context_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            calls = []
            fallback = {"host": "127.0.0.1", "port": 8080}

            def set_target(host, port):
                calls.append((host, port))
                return {"host": host, "port": int(port)}

            ctx.services.set_llama_api_target = set_target
            ctx.services.get_llama_api_target = lambda: fallback

            result = process_manager.parse_launch_api_target(
                ctx,
                ["--ctx-size", 4096, "--host=localhost", ["--port", "9091"]],
            )

            self.assertEqual(calls, [("localhost", "9091")])
            self.assertEqual(result, {"host": "localhost", "port": 9091})

    def test_process_manager_parse_launch_api_target_falls_back_on_invalid_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            fallback = {"host": "127.0.0.1", "port": 8080}
            ctx.services.set_llama_api_target = lambda host, port: (_ for _ in ()).throw(ValueError("bad host"))
            ctx.services.get_llama_api_target = lambda: fallback

            result = process_manager.parse_launch_api_target(ctx, ["--host", "bad.example"])

            self.assertEqual(result, fallback)

    def test_process_manager_normalizes_strict_model_switch_launch_context(self):
        launch_context = {
            "source": "model-switcher",
            "slot": "a",
            "preset": "  Qwen Balanced  ",
            "preset_fingerprint": "a" * 64,
        }

        self.assertEqual(
            process_manager.normalize_launch_context(launch_context),
            {
                "source": "model-switcher",
                "slot": "a",
                "preset": "Qwen Balanced",
                "preset_fingerprint": "a" * 64,
            },
        )
        self.assertEqual(process_manager.normalize_launch_context(None), {})

        invalid_contexts = [
            "model-switcher",
            {},
            {**launch_context, "unknown": "value"},
            {**launch_context, "source": "manual"},
            {**launch_context, "slot": "c"},
            {**launch_context, "preset": "bad\nname"},
            {**launch_context, "preset": "bad\u202ename"},
            {**launch_context, "preset_fingerprint": "secret value"},
        ]
        for invalid in invalid_contexts:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    process_manager.normalize_launch_context(invalid)

    def test_process_manager_api_key_parser_matches_llama_cpp_csv_rules(self):
        self.assertEqual(
            process_manager.parse_csv_row('first ,"second,part","third""quoted"'),
            ["first ", "second,part", 'third"quoted'],
        )
        self.assertEqual(process_manager.parse_csv_row("   "), ["   "])
        self.assertEqual(
            process_manager.parse_launch_api_keys(
                ["--api-key", "old", "--metrics", '--api-key="first,part",second']
            ),
            ("first,part", "second"),
        )

    def test_process_manager_launch_reports_missing_runtime_before_popen(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")
            (ctx.paths.llama_bin / "llama-server").chmod(0o755)
            ctx.services = BackendServices(
                current_platform="darwin",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli", "llama-server"],
                validate_runtime_dependencies=lambda tools=None: {
                    "ok": False,
                    "checked": True,
                    "missing_runtime_files": ["libllama-common.0.dylib"],
                },
            )

            with mock.patch.object(process_manager.subprocess, "Popen") as mock_popen:
                result = process_manager.launch_process(ctx, "llama-server", [])

            self.assertIn("Missing llama.cpp runtime library", result["error"])
            self.assertIn("libllama-common.0.dylib", result["error"])
            mock_popen.assert_not_called()

    def test_process_manager_launch_rejects_non_executable_unix_tools(self):
        cases = [
            ("cpu", "Repair Install"),
            ("custom", "chmod +x on llama/custom/bin/llama-server"),
        ]
        for backend, expected_recovery in cases:
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                ctx = make_context(tmp)
                executable = ctx.paths.llama_bin / "llama-server"
                executable.parent.mkdir(parents=True)
                executable.write_text("binary")
                ctx.services = BackendServices(
                    current_platform="linux",
                    find_tool_executable=lambda tool: executable,
                    get_tool_filename=lambda tool: tool,
                    load_config=lambda backend=backend: {"backend": backend},
                )

                with mock.patch.object(
                    process_manager.os, "access", return_value=False
                ), mock.patch.object(process_manager.subprocess, "Popen") as mock_popen:
                    result = process_manager.launch_process(ctx, "llama-server", [])

                self.assertIn("llama-server is not executable", result["error"])
                self.assertIn(expected_recovery, result["error"])
                mock_popen.assert_not_called()

    def test_process_manager_redacts_api_keys_from_display_commands(self):
        self.assertEqual(
            process_manager.redact_sensitive_args(
                ["llama-server", "--api-key", "primary-secret", "--api-key=backup-secret", "--metrics"]
            ),
            ["llama-server", "--api-key", "<redacted>", "--api-key=<redacted>", "--metrics"],
        )
        self.assertEqual(
            process_manager.redact_sensitive_text(
                "launch failed for primary-secret and backup-secret",
                ["llama-server", "--api-key", "primary-secret", "--api-key=backup-secret"],
            ),
            "launch failed for <redacted> and <redacted>",
        )

    def test_process_manager_snapshots_api_keys_only_for_successful_server_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            executable = ctx.paths.llama_bin / "llama-server"
            executable.write_text("binary")
            executable.chmod(0o755)
            ctx.services = BackendServices(
                current_platform="linux",
                find_tool_executable=lambda tool: executable,
                get_tool_filename=lambda tool: tool,
                load_config=lambda: {},
                set_llama_api_target=lambda host, port: {"host": host, "port": int(port)},
                get_llama_api_target=lambda: {"host": "127.0.0.1", "port": 8080},
                validate_runtime_dependencies=lambda tools=None: {
                    "ok": True,
                    "checked": True,
                    "missing_runtime_files": [],
                },
            )
            fake_process = mock.Mock()
            fake_process.pid = 1234
            fake_process.stdout = io.StringIO()
            fake_process.stderr = io.StringIO()
            fake_process.stdin = io.StringIO()
            fake_process.poll.return_value = None
            ctx.state.runtime_generation = 7

            class FakeThread:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs

                def start(self):
                    pass

            with mock.patch.object(process_manager.subprocess, "Popen", return_value=fake_process), \
                 mock.patch.object(process_manager.threading, "Thread", FakeThread):
                result = process_manager.launch_process(
                    ctx,
                    "llama-server",
                    [
                        "--api-key",
                        '"launch,part",backup',
                        "--port",
                        "9090",
                        "-m",
                        "models/qwen.gguf",
                        "-a=qwen-local,backup",
                    ],
                )

            self.assertEqual(result["pid"], 1234)
            self.assertEqual(ctx.state.active_llama_api_keys, ("launch,part", "backup"))
            self.assertEqual(
                process_manager.get_active_llama_authorization(ctx, "Bearer pending"),
                "Bearer launch,part",
            )
            self.assertEqual(
                ctx.state.active_runtime,
                {
                    "generation": 8,
                    "tool": "llama-server",
                    "model": "models/qwen.gguf",
                    "alias": "qwen-local",
                    "host": "127.0.0.1",
                    "port": 9090,
                    "source": "manual",
                    "slot": None,
                    "preset": None,
                    "preset_fingerprint": None,
                },
            )
            self.assertEqual(result["active_runtime"], ctx.state.active_runtime)
            self.assertIsNot(result["active_runtime"], ctx.state.active_runtime)
            self.assertNotIn("launch,part", json.dumps(ctx.state.active_runtime))

    def test_process_manager_rejects_invalid_launch_context_before_popen(self):
        ctx = AppContext()
        invalid_context = {
            "source": "model-switcher",
            "slot": "a",
            "preset": "Model A",
            "preset_fingerprint": "contains spaces",
        }

        with mock.patch.object(process_manager.subprocess, "Popen") as mock_popen:
            result = process_manager.launch_process(ctx, "llama-server", [], invalid_context)

        self.assertIn("launch_context", result["error"])
        self.assertIsNone(ctx.state.active_runtime)
        mock_popen.assert_not_called()

    def test_launch_output_readers_survive_invalid_utf8(self):
        """Undecodable bytes in child output must not kill the output readers.

        The launch Popen used text=True with the default strict decoding, so a
        single non-UTF-8 byte (progress bars, localized crash text, driver
        output) raised UnicodeDecodeError in stream_output and the reader for
        that pipe died. The pipe then went undrained; once the OS buffer filled
        the child blocked on write and appeared hung. The child below emits
        invalid bytes on both pipes and then writes far more than the pipe
        buffer holds, so it only exits if both readers keep draining.
        """
        # 0x81/0x8D/0x8F/0x90 are invalid both as UTF-8 lead bytes and in
        # cp1252 (undefined), so the strict-decode failure reproduces on
        # Windows (locale code page) and POSIX (UTF-8) alike.
        script = "\n".join(
            [
                "import sys",
                "chunk = b'x' * 8192",
                "sys.stdout.buffer.write(b'stdout-before' + bytes([10]))",
                "sys.stdout.buffer.write(bytes([0x81, 0x8D]) + b' invalid utf8' + bytes([10]))",
                "for i in range(40):",
                "    sys.stdout.buffer.write(b'stdout-after-' + str(i).encode() + b'-' + chunk + bytes([10]))",
                "sys.stdout.buffer.flush()",
                "sys.stderr.buffer.write(b'stderr-before' + bytes([10]))",
                "sys.stderr.buffer.write(bytes([0x8F, 0x90]) + b' invalid utf8' + bytes([10]))",
                "for i in range(20):",
                "    sys.stderr.buffer.write(b'stderr-after-' + str(i).encode() + b'-' + chunk + bytes([10]))",
                "sys.stderr.buffer.flush()",
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services.set_llama_api_target = lambda host, port: {"host": host, "port": port}
            ctx.services.get_llama_api_target = lambda: {"host": "127.0.0.1", "port": 8080}
            script_path = Path(tmp) / "fake_llama_server.py"
            script_path.write_text(script)

            def fake_validation(_ctx, _tool):
                return Path(sys.executable), None

            with mock.patch.object(
                process_manager, "_validate_launch_environment", fake_validation
            ):
                result = process_manager.launch_process(
                    ctx, "llama-server", [str(script_path)]
                )
            self.assertIn("pid", result, result)

            process = ctx.state.process
            try:
                exit_code = process.wait(20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(5)
                self.fail("child blocked on a full pipe (dead output reader)")
            self.assertEqual(exit_code, 0)

            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with ctx.state.output_buffer_lock:
                    if ctx.state.output_reader_count == 0:
                        break
                time.sleep(0.05)
            with ctx.state.output_buffer_lock:
                lines = list(ctx.state.output_buffer)
            for marker in ("stdout-before", "stdout-after-39", "stderr-before", "stderr-after-19"):
                self.assertTrue(
                    any(line.startswith(marker) for line in lines),
                    f"missing {marker!r} output",
                )

    def test_process_manager_records_normalized_switch_context_after_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            executable = ctx.paths.llama_bin / "llama-server"
            executable.write_text("binary")
            executable.chmod(0o755)
            ctx.services = BackendServices(
                current_platform="linux",
                find_tool_executable=lambda tool: executable,
                get_tool_filename=lambda tool: tool,
                load_config=lambda: {},
                set_llama_api_target=lambda host, port: {"host": host, "port": int(port)},
                get_llama_api_target=lambda: {"host": "127.0.0.1", "port": 8080},
            )
            fake_process = mock.Mock()
            fake_process.pid = 2468
            fake_process.stdout = io.StringIO()
            fake_process.stderr = io.StringIO()
            fake_process.poll.return_value = None

            class FakeThread:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs

                def start(self):
                    pass

            launch_context = {
                "source": "model-switcher",
                "slot": "b",
                "preset": "  Gemma Creative  ",
                "preset_fingerprint": "b" * 64,
            }
            with mock.patch.object(process_manager.subprocess, "Popen", return_value=fake_process), \
                 mock.patch.object(process_manager.threading, "Thread", FakeThread):
                result = process_manager.launch_process(
                    ctx,
                    "llama-server",
                    ["-m=models/gemma.gguf", "--host=localhost", "--port=8181"],
                    launch_context,
                )

            self.assertEqual(result["active_runtime"], ctx.state.active_runtime)
            self.assertEqual(
                {
                    key: ctx.state.active_runtime[key]
                    for key in ("generation", "source", "slot", "preset", "preset_fingerprint")
                },
                {
                    "generation": 1,
                    "source": "model-switcher",
                    "slot": "b",
                    "preset": "Gemma Creative",
                    "preset_fingerprint": "b" * 64,
                },
            )
            self.assertEqual(ctx.state.active_runtime["model"], "models/gemma.gguf")
            self.assertEqual(ctx.state.active_runtime["host"], "localhost")
            self.assertEqual(ctx.state.active_runtime["port"], 8181)

    def test_active_runtime_sanitizes_model_url_identity(self):
        ctx = AppContext()
        runtime = process_manager._build_active_runtime(
            ctx,
            "llama-server",
            [
                "--model-url",
                "https://download-user:download-pass@models.example/model.gguf?token=signed-secret#private",
            ],
            {"source": "manual"},
            {"host": "127.0.0.1", "port": 8080},
        )
        self.assertEqual(runtime["model"], "Remote model URL")
        serialized = json.dumps(runtime)
        for secret in ("download-user", "download-pass", "signed-secret", "private"):
            self.assertNotIn(secret, serialized)

    def test_process_preflight_is_non_mutating_and_returns_canonical_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            executable = ctx.paths.llama_bin / "llama-server"
            executable.parent.mkdir(parents=True)
            executable.write_text("binary")
            executable.chmod(0o755)
            model = ctx.paths.models / "qwen.gguf"
            model.parent.mkdir(parents=True)
            model.write_text("model")
            set_target = mock.Mock(side_effect=AssertionError("preflight mutated API target"))
            ctx.services = BackendServices(
                find_tool_executable=lambda tool: executable,
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli", "llama-server"],
                set_llama_api_target=set_target,
            )
            running_process = mock.Mock()
            running_process.poll.return_value = None
            ctx.state.process = running_process
            ctx.state.active_runtime = {"generation": 9, "tool": "llama-server"}
            fingerprint_data = {
                "flags": {"temperature": 0.7, "custom_args": "--metrics"},
                "model": "models/qwen.gguf",
                "tool": "llama-server",
            }
            canonical = json.dumps(
                fingerprint_data,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
            expected_fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

            with mock.patch.object(process_manager.subprocess, "Popen") as mock_popen:
                result = process_manager.preflight_launch(
                    ctx,
                    "llama-server",
                    [
                        "--port",
                        "8080",
                        "--api-key",
                        "launch-only-secret",
                        "-m",
                        "models/qwen.gguf",
                    ],
                    fingerprint_data,
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["model_source"], "local")
            self.assertEqual(result["model"], "models/qwen.gguf")
            self.assertEqual(result["preset_fingerprint"], expected_fingerprint)
            self.assertEqual(
                process_manager.compute_preset_fingerprint(
                    {"tool": "llama-server", "model": "models/qwen.gguf", "flags": fingerprint_data["flags"]}
                ),
                expected_fingerprint,
            )
            self.assertRegex(result["preset_fingerprint"], r"^[0-9a-f]{64}$")
            self.assertNotIn("launch-only-secret", json.dumps(result))
            self.assertIs(ctx.state.process, running_process)
            self.assertEqual(ctx.state.active_runtime, {"generation": 9, "tool": "llama-server"})
            set_target.assert_not_called()
            mock_popen.assert_not_called()

    def test_process_preflight_rejects_sensitive_fingerprint_data(self):
        ctx = AppContext()
        ctx.services.llama_tools = ["llama-server"]
        sensitive_values = [
            {"api_key": "secret"},
            {"flags": {"API_KEY": "secret"}},
            {"flags": {"custom_args": "--metrics --api-key secret"}},
            {"flags": {"custom_args": "--api-key=secret"}},
        ]

        for fingerprint_data in sensitive_values:
            with self.subTest(fingerprint_data=fingerprint_data):
                result = process_manager.preflight_launch(
                    ctx,
                    "llama-server",
                    ["-hf", "org/model"],
                    fingerprint_data,
                )
                self.assertIn("must not contain", result["error"])
                self.assertNotIn("secret", result["error"])

    def test_process_preflight_validates_tool_args_environment_and_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            executable = ctx.paths.llama_bin / "llama-server"
            ctx.services = BackendServices(
                find_tool_executable=lambda tool: executable,
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli", "llama-server"],
            )
            fingerprint_data = {"tool": "llama-server", "flags": {}}

            self.assertIn(
                "Unknown tool",
                process_manager.preflight_launch(
                    ctx, "../../cmd", ["-hf", "org/model"], fingerprint_data
                )["error"],
            )
            self.assertIn(
                "requires llama-server",
                process_manager.preflight_launch(
                    ctx, "llama-cli", ["-hf", "org/model"], fingerprint_data
                )["error"],
            )
            self.assertIn(
                "args must be an array",
                process_manager.preflight_launch(
                    ctx, "llama-server", "-hf org/model", fingerprint_data
                )["error"],
            )
            self.assertIn(
                "tool must be a string",
                process_manager.preflight_launch(
                    ctx, {"secret": "value"}, ["-hf", "org/model"], fingerprint_data
                )["error"],
            )
            self.assertIn(
                "invalid value",
                process_manager.preflight_launch(
                    ctx, "llama-server", ["-hf", {"repo": "org/model"}], fingerprint_data
                )["error"],
            )
            self.assertIn(
                "not found",
                process_manager.preflight_launch(
                    ctx, "llama-server", ["-hf", "org/model"], fingerprint_data
                )["error"],
            )

            executable.parent.mkdir(parents=True)
            executable.write_text("binary")
            executable.chmod(0o755)
            ctx.services.validate_runtime_dependencies = lambda tools=None: {
                "missing_runtime_files": ["runtime.dll"]
            }
            self.assertIn(
                "runtime library",
                process_manager.preflight_launch(
                    ctx, "llama-server", ["-hf", "org/model"], fingerprint_data
                )["error"],
            )

            ctx.services.validate_runtime_dependencies = lambda tools=None: {
                "missing_runtime_files": []
            }
            self.assertIn(
                "model source",
                process_manager.preflight_launch(
                    ctx, "llama-server", ["--metrics"], fingerprint_data
                )["error"],
            )
            self.assertIn(
                "does not exist",
                process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", "models/missing.gguf"], fingerprint_data
                )["error"],
            )
            remote_result = process_manager.preflight_launch(
                ctx,
                "llama-server",
                ["--hf-repo=org/model"],
                fingerprint_data,
            )
            self.assertTrue(remote_result["ok"])
            self.assertEqual(remote_result["model_source"], "hugging-face")
            self.assertEqual(remote_result["model"], "org/model")

    def test_process_preflight_route_delegates_and_reports_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            body = {
                "tool": "llama-server",
                "args": ["-m", "models/qwen.gguf"],
                "fingerprint_data": {"tool": "llama-server"},
            }
            response = DummyResponse()
            with mock.patch.object(
                process_manager,
                "preflight_launch",
                return_value={"ok": True, "preset_fingerprint": "a" * 64},
            ) as mock_preflight:
                process.preflight_launch(
                    Request("POST", "/api/launch/preflight", "", {}, body=body),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 200)
            mock_preflight.assert_called_once_with(
                ctx, "llama-server", body["args"], body["fingerprint_data"]
            )

            error_response = DummyResponse()
            with mock.patch.object(
                process_manager,
                "preflight_launch",
                return_value={"error": "Local model file does not exist."},
            ):
                process.preflight_launch(
                    Request("POST", "/api/launch/preflight", "", {}, body=body),
                    error_response,
                    ctx,
                )
            self.assertEqual(error_response.status, 400)
            self.assertEqual(error_response.payload["error"], "Local model file does not exist.")

    def test_preset_fingerprint_route_is_backend_canonical_and_secret_safe(self):
        ctx = AppContext()
        fingerprint_data = {
            "tool": "llama-server",
            "model": "models/numeric.gguf",
            "flags": {"tiny": 1e-7, "large": 1e20},
        }
        canonical = json.dumps(
            fingerprint_data,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        response = DummyResponse()

        process.fingerprint_preset(
            Request(
                "POST",
                "/api/presets/fingerprint",
                "",
                {},
                body={"fingerprint_data": fingerprint_data},
            ),
            response,
            ctx,
        )

        self.assertEqual(response.payload, {"ok": True, "preset_fingerprint": expected})
        secret_response = DummyResponse()
        process.fingerprint_preset(
            Request(
                "POST",
                "/api/presets/fingerprint",
                "",
                {},
                body={"fingerprint_data": {"flags": {"api_key": "secret"}}},
            ),
            secret_response,
            ctx,
        )
        self.assertEqual(secret_response.status, 400)
        self.assertNotIn("secret", json.dumps(secret_response.payload))

    def _make_health_context(self, generation=4):
        ctx = AppContext()
        process_handle = mock.Mock()
        process_handle.poll.return_value = None
        ctx.state.process = process_handle
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_llama_api_keys = ("must-not-forward",)
        ctx.state.runtime_generation = generation
        ctx.state.active_runtime = {
            "generation": generation,
            "tool": "llama-server",
            "host": "127.0.0.1",
            "port": 8080,
        }
        return ctx, process_handle

    def test_llama_health_reports_ready_loading_starting_and_error_states(self):
        ctx, _ = self._make_health_context()

        with mock.patch.object(
            process_manager.urllib.request,
            "urlopen",
            return_value=FakeHealthUpstream(200),
        ) as mock_urlopen:
            ready = process_manager.get_llama_health(ctx, "4")

        self.assertEqual(ready["state"], "ready")
        self.assertTrue(ready["ready"])
        request = mock_urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8080/health")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(mock_urlopen.call_args.kwargs["timeout"], 2)

        http_503 = urllib.error.HTTPError(
            "http://127.0.0.1:8080/health", 503, "loading", {}, None
        )
        with mock.patch.object(
            process_manager.urllib.request, "urlopen", side_effect=http_503
        ):
            loading = process_manager.get_llama_health(ctx, 4)
        self.assertEqual(loading["state"], "loading")
        self.assertFalse(loading["ready"])

        with mock.patch.object(
            process_manager.urllib.request,
            "urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            starting = process_manager.get_llama_health(ctx, 4)
        self.assertEqual(starting["state"], "starting")
        self.assertNotIn("connection refused", starting["message"])

        error_body = io.BytesIO(b"failed")
        http_500 = urllib.error.HTTPError(
            "http://127.0.0.1:8080/health", 500, "failed", {}, error_body
        )
        with mock.patch.object(
            process_manager.urllib.request, "urlopen", side_effect=http_500
        ):
            error = process_manager.get_llama_health(ctx, 4)
        self.assertEqual(error["state"], "error")
        self.assertEqual(error["message"], "llama-server health returned HTTP 500.")
        self.assertTrue(error_body.closed)

    def test_llama_health_handles_stopped_failed_and_superseded_generations(self):
        stopped_ctx = AppContext()
        stopped = process_manager.get_llama_health(stopped_ctx, None)
        self.assertEqual(stopped["state"], "stopped")

        ctx, process_handle = self._make_health_context()
        with mock.patch.object(process_manager.urllib.request, "urlopen") as mock_urlopen:
            superseded_before_probe = process_manager.get_llama_health(ctx, 3)
        self.assertEqual(superseded_before_probe["state"], "superseded")
        mock_urlopen.assert_not_called()

        def replace_runtime(request, timeout):
            self.assertTrue(ctx.state.process_lock.acquire(blocking=False))
            try:
                next_process = mock.Mock()
                next_process.poll.return_value = None
                ctx.state.process = next_process
                ctx.state.runtime_generation = 5
                ctx.state.active_runtime = {
                    "generation": 5,
                    "tool": "llama-server",
                    "host": "127.0.0.1",
                    "port": 8081,
                }
            finally:
                ctx.state.process_lock.release()
            return FakeHealthUpstream(200)

        with mock.patch.object(
            process_manager.urllib.request, "urlopen", side_effect=replace_runtime
        ):
            superseded_after_probe = process_manager.get_llama_health(ctx, 4)
        self.assertEqual(superseded_after_probe["state"], "superseded")
        self.assertEqual(superseded_after_probe["generation"], 5)

        failed_ctx, failed_process = self._make_health_context(7)

        def exit_during_probe(request, timeout):
            failed_process.poll.return_value = 9
            return FakeHealthUpstream(200)

        with mock.patch.object(
            process_manager.urllib.request, "urlopen", side_effect=exit_during_probe
        ):
            failed = process_manager.get_llama_health(failed_ctx, 7)
        self.assertEqual(failed["state"], "failed")
        self.assertFalse(failed["ready"])
        self.assertNotIn("9", failed["message"])

        invalid = process_manager.get_llama_health(AppContext(), "not-a-generation")
        self.assertEqual(invalid["state"], "error")
        self.assertIn("positive integer", invalid["message"])

    def test_llama_health_unexpected_errors_are_sanitized(self):
        ctx, _ = self._make_health_context()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), mock.patch.object(
            process_manager.urllib.request,
            "urlopen",
            side_effect=RuntimeError("private upstream detail"),
        ):
            result = process_manager.get_llama_health(ctx, 4)

        self.assertEqual(result["state"], "error")
        self.assertNotIn("private upstream detail", result["message"])
        self.assertIn("private upstream detail", stderr.getvalue())

    def test_llama_health_and_generation_stop_routes_return_observation_json(self):
        ctx = AppContext()
        health_response = DummyResponse()
        with mock.patch.object(
            process_manager,
            "get_llama_health",
            return_value={"state": "starting", "ready": False, "generation": 4},
        ) as mock_health:
            process.get_health(
                Request(
                    "GET",
                    "/api/llama/health",
                    "expected_generation=4",
                    {},
                ),
                health_response,
                ctx,
            )
        self.assertEqual(health_response.status, 200)
        mock_health.assert_called_once_with(ctx, "4")

        sanitized_response = DummyResponse()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), mock.patch.object(
            process_manager,
            "get_llama_health",
            side_effect=RuntimeError("private route failure"),
        ):
            process.get_health(
                Request("GET", "/api/llama/health", "", {}),
                sanitized_response,
                ctx,
            )
        self.assertEqual(sanitized_response.status, 200)
        self.assertEqual(sanitized_response.payload["state"], "error")
        self.assertNotIn("private route failure", json.dumps(sanitized_response.payload))
        self.assertIn("private route failure", stderr.getvalue())

        stop_response = DummyResponse()
        with mock.patch.object(
            process_manager,
            "stop_process_for_generation",
            return_value={"stopped": False, "state": "superseded", "generation": 5},
        ) as mock_stop:
            process.stop(
                Request(
                    "POST",
                    "/api/stop",
                    "",
                    {},
                    body={"expected_generation": 4},
                ),
                stop_response,
                ctx,
            )
        self.assertEqual(stop_response.status, 200)
        mock_stop.assert_called_once_with(ctx, 4)

    def test_process_manager_cleans_runtime_after_partial_launch_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            executable = ctx.paths.llama_bin / "llama-server"
            executable.write_text("binary")
            executable.chmod(0o755)
            ctx.services.find_tool_executable = lambda tool: executable
            ctx.services.get_tool_filename = lambda tool: tool
            fake_process = mock.Mock()
            fake_process.stdout = io.StringIO()
            fake_process.stderr = io.StringIO()
            fake_process.poll.return_value = None

            with mock.patch.object(process_manager.subprocess, "Popen", return_value=fake_process), \
                 mock.patch.object(process_manager.threading, "Thread", side_effect=RuntimeError("thread failed")):
                result = process_manager.launch_process(ctx, "llama-server", ["-m", "model.gguf"])

            self.assertIn("thread failed", result["error"])
            fake_process.kill.assert_called_once()
            fake_process.wait.assert_called_once_with(timeout=5)
            self.assertIsNone(ctx.state.process)
            self.assertIsNone(ctx.state.active_runtime)
            self.assertEqual(ctx.state.runtime_generation, 0)
            self.assertEqual(ctx.state.output_reader_count, 0)

    def test_process_launch_route_forwards_optional_launch_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services.llama_tools = ["llama-server"]
            launch_context = {
                "source": "model-switcher",
                "slot": "b",
                "preset": "Gemma Creative",
                "preset_fingerprint": "c" * 64,
            }
            response = DummyResponse()

            with mock.patch.object(
                process_manager,
                "launch_process",
                return_value={"pid": 123, "command": "llama-server", "output_cursor": 0},
            ) as mock_launch_process:
                process.launch(
                    Request(
                        "POST",
                        "/api/launch",
                        "",
                        {},
                        body={"tool": "llama-server", "args": ["-m", "model.gguf"], "launch_context": launch_context},
                    ),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 200)
            mock_launch_process.assert_called_once_with(
                ctx, "llama-server", ["-m", "model.gguf"], launch_context
            )

    def test_process_launch_route_returns_missing_runtime_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")
            (ctx.paths.llama_bin / "llama-server").chmod(0o755)
            ctx.services = BackendServices(
                current_platform="darwin",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli", "llama-server"],
                validate_runtime_dependencies=lambda tools=None: {
                    "ok": False,
                    "checked": True,
                    "missing_runtime_files": ["libllama-common.0.dylib"],
                },
            )
            response = DummyResponse()

            with mock.patch.object(process_manager.subprocess, "Popen") as mock_popen:
                process.launch(
                    Request(
                        "POST",
                        "/api/launch",
                        "",
                        {},
                        body={"tool": "llama-server", "args": []},
                    ),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 400)
            self.assertIn("libllama-common.0.dylib", response.payload["error"])
            mock_popen.assert_not_called()

    def test_process_launch_route_rejects_unknown_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services = BackendServices(
                llama_tools=["llama-cli", "llama-server"],
            )
            response = DummyResponse()

            with mock.patch.object(process_manager, "launch_process") as mock_launch_process:
                process.launch(
                    Request(
                        "POST",
                        "/api/launch",
                        "",
                        {},
                        body={"tool": "../../cmd", "args": []},
                    ),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 400)
            self.assertEqual(response.payload["error"], "Unknown tool: '../../cmd'")
            mock_launch_process.assert_not_called()

    def test_process_manager_parses_memory_estimate_rows(self):
        rows = process_manager.parse_memory_estimate_output(
            "CUDA0 1814 106 569\nHost 2152 0 57\nignored line\n"
        )

        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["device"], "CUDA0")
        self.assertEqual(rows[0]["kind"], "accelerator")
        self.assertEqual(rows[0]["total_mib"], 2489)
        self.assertEqual(rows[1]["device"], "Host")
        self.assertEqual(rows[1]["kind"], "ram")
        self.assertEqual(rows[1]["total_mib"], 2209)

    def test_process_manager_parses_buffer_types_output(self):
        buffers = process_manager.parse_buffer_types_output(
            "\x1b[31merror while handling argument \"-ot\": unknown buffer type\x1b[0m\n"
            "Available buffer types:\n"
            "  CPU\n"
            "  CUDA0\n"
        )

        self.assertEqual(buffers, ["CPU", "CUDA0"])

    def test_process_manager_parses_list_devices_output(self):
        buffers = process_manager.parse_list_devices_output(
            "Available devices:\n"
            "  CUDA0: NVIDIA GeForce RTX 5070 Ti (16302 MiB, 15037 MiB free)\n"
            "  Vulkan0: Example Device\n"
        )

        self.assertEqual(buffers, ["CUDA0", "Vulkan0"])

    def test_process_buffer_types_route_returns_discovered_buffers(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            cli = ctx.paths.llama_bin / "llama-cli"
            cli.write_text("binary")
            ctx.services = BackendServices(
                current_platform="linux",
                find_tool_executable=lambda tool: cli,
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli"],
                validate_runtime_dependencies=lambda tools=None: {"missing_runtime_files": []},
            )
            completed = SimpleNamespace(
                stdout="",
                stderr="error while handling argument \"-ot\": unknown buffer type\n"
                "Available buffer types:\n"
                "  CPU\n"
                "  CUDA0\n",
                returncode=1,
            )
            response = DummyResponse()

            with mock.patch.object(process_manager.subprocess, "run", return_value=completed):
                process.get_buffer_types(Request("GET", "/api/llama/buffer-types", "", {}), response, ctx)

            self.assertEqual(response.status, 200)
            self.assertEqual(response.payload["buffers"], ["CPU", "CUDA0"])
            self.assertEqual(response.payload["default"], "CUDA0")

    def test_buffer_types_probe_exception_is_sanitized_for_clients(self):
        """Raw probe errors (WinError text, local paths) must not reach the
        client; the CPU fallback is still returned with a fixed message."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            cli = ctx.paths.llama_bin / "llama-cli"
            cli.write_text("binary")
            ctx.services = BackendServices(
                current_platform="win32",
                find_tool_executable=lambda tool: cli,
                get_tool_filename=lambda tool: f"{tool}.exe",
                llama_tools=["llama-cli"],
                validate_runtime_dependencies=lambda tools=None: {"missing_runtime_files": []},
            )

            with mock.patch.object(
                process_manager.subprocess,
                "run",
                side_effect=OSError("WinError 5: Access is denied: 'C:\\secret\\probe'"),
            ):
                result = process_manager.get_buffer_types(ctx)

            self.assertEqual(result["buffers"], ["CPU"])
            self.assertEqual(result["error"], "Buffer discovery failed.")
            self.assertNotIn("secret", json.dumps(result))

    def test_process_estimate_memory_route_rejects_unknown_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services = BackendServices(llama_tools=["llama-cli"])
            response = DummyResponse()

            process.estimate_memory(
                Request(
                    "POST",
                    "/api/estimate-memory",
                    "",
                    {},
                    body={"tool": "../../cmd", "args": []},
                ),
                response,
                ctx,
            )

            self.assertEqual(response.status, 400)
            self.assertEqual(response.payload["error"], "Unknown tool: '../../cmd'")

    def test_process_manager_estimate_memory_uses_fit_params_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            fit_params = ctx.paths.llama_bin / "llama-fit-params"
            fit_params.write_text("binary")
            ctx.services = BackendServices(
                current_platform="linux",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli"],
                validate_runtime_dependencies=lambda tools=None: {"missing_runtime_files": []},
            )
            completed = SimpleNamespace(
                stdout="CUDA0 100 20 30\nHost 200 0 10\n",
                stderr="",
                returncode=0,
            )

            with mock.patch.object(process_manager.subprocess, "run", return_value=completed) as mock_run:
                result = process_manager.estimate_memory(
                    ctx,
                    "llama-cli",
                    [["-m", "models/model.gguf"], ["-fitp", "off"]],
                )

            self.assertEqual(result["accelerator_mib"], 150)
            self.assertEqual(result["ram_mib"], 210)
            command = mock_run.call_args.args[0]
            self.assertEqual(command[-2:], ["-fitp", "on"])
            self.assertNotIn("off", command)

    def test_estimate_memory_probe_exception_is_sanitized_for_clients(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            fit_params = ctx.paths.llama_bin / "llama-fit-params"
            fit_params.write_text("binary")
            ctx.services = BackendServices(
                current_platform="win32",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
                get_tool_filename=lambda tool: tool,
                llama_tools=["llama-cli"],
                validate_runtime_dependencies=lambda tools=None: {"missing_runtime_files": []},
            )

            with mock.patch.object(
                process_manager.subprocess,
                "run",
                side_effect=OSError("WinError 5: Access is denied: 'C:\\secret\\probe'"),
            ):
                result = process_manager.estimate_memory(ctx, "llama-cli", [])

            self.assertEqual(result["error"], "Memory estimate failed.")
            self.assertNotIn("secret", json.dumps(result))

    def test_process_manager_estimate_memory_omits_server_only_args(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-fit-params").write_text("binary")
            ctx.services = BackendServices(
                current_platform="linux",
                llama_tools=["llama-server"],
                validate_runtime_dependencies=lambda tools=None: {"missing_runtime_files": []},
            )
            completed = SimpleNamespace(stdout="Host 200 0 10\n", stderr="", returncode=0)

            with mock.patch.object(process_manager.subprocess, "run", return_value=completed) as mock_run:
                result = process_manager.estimate_memory(
                    ctx,
                    "llama-server",
                    [
                        ["-m", "models/model.gguf"],
                        ["--host", "127.0.0.1"],
                        ["--port", "8080"],
                        ["--metrics"],
                        ["-cb"],
                        ["-cram", "8192"],
                        ["-cms", "1024"],
                        ["-np", "-1"],
                        ["-fitp", "off"],
                    ],
                )

            self.assertEqual(result["ram_mib"], 210)
            command = mock_run.call_args.args[0]
            self.assertNotIn("--host", command)
            self.assertNotIn("--port", command)
            self.assertNotIn("--metrics", command)
            self.assertNotIn("-cb", command)
            self.assertNotIn("-cram", command)
            self.assertNotIn("8192", command)
            self.assertNotIn("-cms", command)
            self.assertNotIn("1024", command)
            self.assertNotIn("-np", command)
            self.assertEqual(command[-2:], ["-fitp", "on"])

    def test_process_manager_estimate_memory_keeps_positive_parallel(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-fit-params").write_text("binary")
            ctx.services = BackendServices(
                current_platform="linux",
                llama_tools=["llama-server"],
                validate_runtime_dependencies=lambda tools=None: {"missing_runtime_files": []},
            )
            completed = SimpleNamespace(stdout="Host 200 0 10\n", stderr="", returncode=0)

            with mock.patch.object(process_manager.subprocess, "run", return_value=completed) as mock_run:
                process_manager.estimate_memory(
                    ctx,
                    "llama-server",
                    [["-m", "models/model.gguf"], ["-np", "4"]],
                )

            command = mock_run.call_args.args[0]
            self.assertIn("-np", command)
            self.assertIn("4", command)

    def test_process_manager_estimate_memory_keeps_fit_params_supported_args(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-fit-params").write_text("binary")
            ctx.services = BackendServices(
                current_platform="linux",
                llama_tools=["llama-server"],
                validate_runtime_dependencies=lambda tools=None: {"missing_runtime_files": []},
            )
            completed = SimpleNamespace(stdout="Host 200 0 10\n", stderr="", returncode=0)

            with mock.patch.object(process_manager.subprocess, "run", return_value=completed) as mock_run:
                process_manager.estimate_memory(
                    ctx,
                    "llama-server",
                    [
                        ["-m", "models/model.gguf"],
                        ["-c", "16000"],
                        ["-b", "2048"],
                        ["-ub", "512"],
                        ["-ngl", "auto"],
                        ["-ctk", "q8_0"],
                        ["-ctv", "q4_0"],
                        ["-kvo"],
                        ["--swa-full"],
                        ["--no-mmap"],
                        ["--host", "127.0.0.1"],
                    ],
                )

            command = mock_run.call_args.args[0]
            self.assertIn("-m", command)
            self.assertIn("-c", command)
            self.assertIn("-b", command)
            self.assertIn("-ub", command)
            self.assertIn("-ngl", command)
            self.assertIn("-ctk", command)
            self.assertIn("-ctv", command)
            self.assertIn("-kvo", command)
            self.assertIn("--swa-full", command)
            self.assertIn("--no-mmap", command)
            self.assertNotIn("--host", command)

    def test_hf_download_status_route_reads_context_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.model_download.update(status="downloading", model_name="model.gguf")
            response = DummyResponse()

            hf_download.get_download_status(
                Request("GET", "/api/hf/download-status", "", {}),
                response,
                ctx,
            )

            self.assertEqual(response.payload["status"], "downloading")
            self.assertEqual(response.payload["model_name"], "model.gguf")

    def test_hf_repo_files_route_validates_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                hf_download.list_repo_files(
                    Request("POST", "/api/hf/repo-files", "", {}, body={"repo_id": "owner/model."}),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 400)
            self.assertEqual(response.payload["error"], "Invalid Hugging Face repo ID.")
            self.assertIn("Invalid Hugging Face repo ID", stderr.getvalue())

    def test_hf_download_route_logs_unexpected_start_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()
            stderr = io.StringIO()

            with contextlib.redirect_stderr(stderr), mock.patch.object(
                hf_download.hf_download,
                "start_hf_model_download",
                side_effect=RuntimeError("download setup failed"),
            ):
                hf_download.start_download(
                    Request(
                        "POST",
                        "/api/hf/download",
                        "",
                        {},
                        body={"repo_id": "owner/model", "model_file": "model.gguf"},
                    ),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 400)
            self.assertEqual(response.payload["error"], "download setup failed")
            self.assertIn("download setup failed", stderr.getvalue())

    def test_hf_download_route_reports_duplicate_with_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            dest_dir = ctx.paths.models / "owner_model"
            dest_dir.mkdir(parents=True)
            (dest_dir / "model.gguf").write_bytes(b"existing")
            response = DummyResponse()

            hf_download.start_download(
                Request(
                    "POST",
                    "/api/hf/download",
                    "",
                    {},
                    body={
                        "repo_id": "owner/model",
                        "revision": "main",
                        "model_file": "model.gguf",
                    },
                ),
                response,
                ctx,
            )

            self.assertEqual(response.status, 409)
            self.assertEqual(response.payload["code"], "exists")
            self.assertIn("owner_model/model.gguf", response.payload["error"])

    def test_hf_download_cancel_sets_cancelling_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            with ctx.state.model_download_lock:
                ctx.state.model_download_in_progress = True
                ctx.state.model_download.update(status="downloading")
            response = DummyResponse()

            hf_download.cancel_download(
                Request("POST", "/api/hf/download-cancel", "", {}, body={}),
                response,
                ctx,
            )

            self.assertTrue(ctx.state.model_download_cancel.is_set())
            self.assertEqual(response.payload["status"], "cancelling")
            self.assertEqual(response.payload["message"], "Cancelling download...")

    def test_hf_download_cancel_is_a_no_op_while_idle(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()

            hf_download.cancel_download(
                Request("POST", "/api/hf/download-cancel", "", {}, body={}),
                response,
                ctx,
            )

            self.assertFalse(ctx.state.model_download_cancel.is_set())
            self.assertEqual(response.payload["status"], "idle")

    def test_web_search_html_to_readable_text_ignores_script(self):
        text = web_search.html_to_readable_text(
            "<html><body><h1>Title</h1><script>bad()</script><p>Hello <b>world</b>.</p></body></html>"
        )

        self.assertIn("Title", text)
        self.assertIn("Hello world", text)
        self.assertNotIn("bad", text)

    def test_web_search_html_to_readable_text_ignores_nested_skip_tags(self):
        text = web_search.html_to_readable_text(
            "<main>Keep<style>.x{color:red}<svg>hidden</svg></style><p>Visible</p></main>"
        )

        self.assertIn("Keep", text)
        self.assertIn("Visible", text)
        self.assertNotIn("hidden", text)

    def test_validate_public_hostname_blocks_private_addresses(self):
        with mock.patch.object(
            web_search.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("127.0.0.1", 80))],
        ):
            ok, reason = web_search.validate_public_hostname("example.com", 80)

        self.assertFalse(ok)
        self.assertIn("non-public address 127.0.0.1", reason)

    def test_fetch_page_text_rejects_an_invalid_port_instead_of_raising(self):
        """urlparse().port raises ValueError on an out-of-range port, and that call
        sat outside the try, so it propagated out of the route."""
        result = web_search.fetch_page_text("http://example.com:99999/page")

        self.assertFalse(result["ok"])
        self.assertIn("invalid port", result["error"])

    def test_fetch_page_text_does_not_leak_raw_exception_text(self):
        addresses = [(web_search.socket.AF_INET, web_search.socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        with mock.patch.object(
            web_search, "resolve_public_addresses", return_value=(addresses, "")
        ), mock.patch.object(
            web_search,
            "_open_validated_url",
            side_effect=OSError(r"C:\Users\someone\secret\path failed"),
        ):
            with contextlib.redirect_stderr(io.StringIO()) as captured:
                result = web_search.fetch_page_text("https://example.com/page")

        self.assertFalse(result["ok"])
        self.assertNotIn("secret", result["error"])
        self.assertIn("secret", captured.getvalue(), "the detail must still be logged")

    def test_ddgs_search_skips_non_mapping_rows(self):
        """ddgs is a third-party scraper; a non-dict row used to raise
        AttributeError straight out of the route."""
        fake_ddgs = mock.Mock()
        fake_ddgs.return_value.text.return_value = [
            "not-a-dict",
            None,
            {"href": "https://example.com/a", "title": "A", "body": "snippet"},
        ]
        module = types.ModuleType("ddgs")
        module.DDGS = fake_ddgs
        with mock.patch.dict("sys.modules", {"ddgs": module}):
            result = web_search.ddgs_search("query")

        self.assertTrue(result["ok"])
        self.assertEqual([row["url"] for row in result["results"]], ["https://example.com/a"])

    def test_validate_public_hostname_blocks_non_global_ranges(self):
        """Ranges that are not private/loopback/reserved but still must not be
        reachable. CGNAT (100.64.0.0/10) is what Tailscale hands out, and it is
        excluded only by is_global — the flag the filter used to omit."""
        blocked = [
            "100.64.0.1",        # CGNAT / Tailscale
            "100.127.255.254",   # CGNAT upper end
            "192.0.2.1",         # TEST-NET-1 documentation range
            "198.18.0.1",        # benchmarking range
            "169.254.169.254",   # cloud metadata endpoint
            "::1",               # IPv6 loopback
            "fd00::1",           # IPv6 unique local
        ]
        for address in blocked:
            with self.subTest(address=address):
                with mock.patch.object(
                    web_search.socket,
                    "getaddrinfo",
                    return_value=[(None, None, None, None, (address, 80))],
                ):
                    ok, reason = web_search.validate_public_hostname("example.com", 80)
                self.assertFalse(ok, f"{address} should be blocked")
                self.assertIn("non-public address", reason)

    def test_validate_public_hostname_allows_public_addresses(self):
        for address in ("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"):
            with self.subTest(address=address):
                with mock.patch.object(
                    web_search.socket,
                    "getaddrinfo",
                    return_value=[(None, None, None, None, (address, 443))],
                ):
                    ok, _ = web_search.validate_public_hostname("example.com", 443)
                self.assertTrue(ok, f"{address} should be allowed")

    def test_fetch_page_text_revalidates_redirect_targets(self):
        headers = Message()
        headers["Location"] = "http://127.0.0.1/private"
        public_addresses = [(web_search.socket.AF_INET, web_search.socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

        with mock.patch.object(
            web_search,
            "resolve_public_addresses",
            side_effect=[
                (public_addresses, ""),
                (None, "Blocked: refusing to fetch non-public address 127.0.0.1."),
            ],
        ), mock.patch.object(
            web_search,
            "_open_validated_url",
            return_value=(302, "Found", headers, b""),
        ) as open_url:
            result = web_search.fetch_page_text("https://example.com")

        self.assertFalse(result["ok"])
        self.assertIn("non-public address 127.0.0.1", result["error"])
        open_url.assert_called_once()

    def test_fetch_page_text_limits_redirect_chains(self):
        headers = Message()
        headers["Location"] = "/next"
        public_addresses = [(web_search.socket.AF_INET, web_search.socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

        with mock.patch.object(
            web_search,
            "resolve_public_addresses",
            return_value=(public_addresses, ""),
        ), mock.patch.object(
            web_search,
            "_open_validated_url",
            return_value=(302, "Found", headers, b""),
        ) as open_url:
            result = web_search.fetch_page_text("https://example.com")

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Failed to fetch URL: too many redirects.")
        self.assertEqual(open_url.call_count, 5)

    def test_web_fetch_connects_to_validated_address_without_resolving_again(self):
        address = ("93.184.216.34", 443)
        addresses = [(web_search.socket.AF_INET, web_search.socket.SOCK_STREAM, 6, "", address)]
        sock = mock.Mock()

        with mock.patch.object(web_search.socket, "socket", return_value=sock) as socket_factory:
            connected = web_search._connect_validated(addresses, timeout=7)

        self.assertIs(connected, sock)
        socket_factory.assert_called_once_with(web_search.socket.AF_INET, web_search.socket.SOCK_STREAM, 6)
        sock.settimeout.assert_called_once_with(7)
        sock.connect.assert_called_once_with(address)

    def test_https_pinned_connection_preserves_original_hostname_for_tls(self):
        addresses = [(web_search.socket.AF_INET, web_search.socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        raw_socket = object()
        wrapped_socket = object()
        ssl_context = mock.Mock()
        ssl_context.wrap_socket.return_value = wrapped_socket
        connection = web_search._PinnedHTTPSConnection(
            "example.com",
            443,
            addresses,
            timeout=7,
            ssl_context=ssl_context,
        )

        with mock.patch.object(web_search, "_connect_validated", return_value=raw_socket):
            connection.connect()

        ssl_context.wrap_socket.assert_called_once_with(raw_socket, server_hostname="example.com")
        self.assertIs(connection.sock, wrapped_socket)

    def test_search_route_fetches_url_through_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()

            with mock.patch.object(
                web_search,
                "fetch_page_text",
                return_value={"ok": True, "url": "https://example.com", "text": "Example"},
            ) as fetch_page_text:
                search.search(
                    Request("POST", "/api/web-search", "", {}, body={"url": "https://example.com"}),
                    response,
                    ctx,
                )

            fetch_page_text.assert_called_once_with("https://example.com", ssl_context=ctx.services.ssl_context)
            self.assertEqual(response.payload["text"], "Example")

    def test_chat_search_context_includes_sources(self):
        context, sources = chat_service.build_search_context(
            [{"title": "Example", "url": "https://example.com", "snippet": "Short"}],
            {"https://example.com": {"ok": True, "text": "Fresh source text"}},
        )

        self.assertIn("Fresh source text", context)
        self.assertEqual(sources[0]["index"], 1)
        self.assertEqual(sources[0]["url"], "https://example.com")

    def test_local_interface_addresses_are_cached(self):
        chat_service.get_local_interface_addresses.cache_clear()
        try:
            with mock.patch.object(chat_service.socket, "gethostname", return_value="host"), mock.patch.object(
                chat_service.socket,
                "getfqdn",
                return_value="host.local",
            ), mock.patch.object(
                chat_service.socket,
                "getaddrinfo",
                side_effect=[
                    [(None, None, None, None, ("192.168.1.10", 0))],
                    [(None, None, None, None, ("192.168.1.11", 0))],
                ],
            ) as getaddrinfo:
                first = chat_service.get_local_interface_addresses()
                second = chat_service.get_local_interface_addresses()
        finally:
            chat_service.get_local_interface_addresses.cache_clear()

        self.assertEqual(first, second)
        self.assertEqual(getaddrinfo.call_count, 2)
        self.assertIn("192.168.1.10", first)
        self.assertIn("192.168.1.11", first)

    def test_chat_route_streams_error_for_invalid_port(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            activate_llama_runtime(ctx, port=70000)
            response = DummySseResponse()

            chat.completions(
                Request("POST", "/api/chat/completions", "", {}, body={"messages": []}),
                response,
                ctx,
            )

            response.handler.wfile.seek(0)
            payload = response.handler.wfile.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("Invalid llama-server chat port.", payload)
            self.assertIn("data: [DONE]", payload)

    def test_chat_route_streams_llama_server_sse(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummySseResponse()
            upstream = FakeSseUpstream(
                [
                    b'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
                    b"data: [DONE]\n\n",
                ]
            )

            captured = {}
            activate_llama_runtime(ctx, host="127.0.0.2", port=8124)

            def fake_urlopen(req, timeout):
                captured["authorization"] = req.get_header("Authorization")
                return upstream

            with mock.patch.object(
                chat.chat_service,
                "get_local_chat_api_url",
                return_value="http://127.0.0.1:8080/v1/chat/completions",
            ) as get_chat_url, mock.patch.object(chat.urllib.request, "urlopen", side_effect=fake_urlopen):
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {"Authorization": "Bearer pending-secret"},
                        body={"messages": [{"role": "user", "content": "Hello"}]},
                    ),
                    response,
                    ctx,
                )

            response.handler.wfile.seek(0)
            payload = response.handler.wfile.read().decode("utf-8")
            self.assertIn('data: {"choices":[{"delta":{"content":"Hi"}}]}', payload)
            self.assertIn("data: [DONE]", payload)
            self.assertTrue(response.handler.close_connection)
            self.assertEqual(captured["authorization"], "Bearer launch-secret")
            get_chat_url.assert_called_once_with(
                {"host": "127.0.0.2", "port": 8124, "source": "runtime"}
            )

    def test_chat_route_injects_web_search_context_into_system_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            activate_llama_runtime(ctx)
            response = DummySseResponse()
            captured = {}

            def fake_urlopen(req, timeout):
                captured["body"] = json.loads(req.data.decode("utf-8"))
                return FakeSseUpstream([b"data: [DONE]\n\n"])

            with mock.patch.object(
                chat.web_search,
                "web_search",
                return_value={
                    "ok": True,
                    "results": [
                        {
                            "title": "Fresh Result",
                            "url": "https://example.com/fresh",
                            "snippet": "Fresh snippet",
                        }
                    ],
                },
            ), mock.patch.object(
                chat.web_search,
                "fetch_page_text",
                return_value={"ok": True, "text": "Fresh page text"},
            ), mock.patch.object(
                chat.chat_service,
                "get_local_chat_api_url",
                return_value="http://127.0.0.1:8080/v1/chat/completions",
            ), mock.patch.object(chat.urllib.request, "urlopen", side_effect=fake_urlopen):
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
                        body={
                            "web_search": True,
                            "messages": [
                                {"role": "system", "content": "Original system."},
                                {
                                    "role": "assistant",
                                    "content": "Earlier answer.",
                                    "reasoning_content": "Earlier reasoning.",
                                },
                                {"role": "user", "content": "What changed?"},
                            ],
                            "chat_template_kwargs": {
                                "enable_thinking": True,
                                "reasoning_effort": "medium",
                            },
                        },
                    ),
                    response,
                    ctx,
                )

            system_message = captured["body"]["messages"][0]
            self.assertEqual(system_message["role"], "system")
            self.assertIn("Original system.", system_message["content"])
            self.assertIn("Fresh page text", system_message["content"])
            self.assertEqual(
                captured["body"]["messages"][1]["reasoning_content"],
                "Earlier reasoning.",
            )
            self.assertEqual(
                captured["body"]["chat_template_kwargs"],
                {"enable_thinking": True, "reasoning_effort": "medium"},
            )
            self.assertNotIn("web_search", captured["body"])
            self.assertNotIn("web_search_max_results", captured["body"])

    def test_chat_route_uses_configured_web_search_result_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            activate_llama_runtime(ctx)
            response = DummySseResponse()
            captured = {}
            results = [
                {"title": f"Result {idx}", "url": f"https://example.com/{idx}", "snippet": f"Snippet {idx}"}
                for idx in range(1, 7)
            ]

            def fake_urlopen(req, timeout):
                captured["body"] = json.loads(req.data.decode("utf-8"))
                return FakeSseUpstream([b"data: [DONE]\n\n"])

            with mock.patch.object(
                chat.web_search,
                "web_search",
                return_value={"ok": True, "results": results},
            ) as search_mock, mock.patch.object(
                chat.web_search,
                "fetch_page_text",
                return_value={"ok": True, "text": "Fresh page text"},
            ) as fetch_mock, mock.patch.object(
                chat.chat_service,
                "get_local_chat_api_url",
                return_value="http://127.0.0.1:8080/v1/chat/completions",
            ), mock.patch.object(chat.urllib.request, "urlopen", side_effect=fake_urlopen):
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
                        body={
                            "web_search": True,
                            "web_search_max_results": 4,
                            "messages": [{"role": "user", "content": "What changed?"}],
                        },
                    ),
                    response,
                    ctx,
                )

            search_mock.assert_called_once_with("What changed?", max_results=4)
            self.assertEqual(fetch_mock.call_count, 4)
            fetched_urls = [call.args[0] for call in fetch_mock.call_args_list]
            self.assertEqual(fetched_urls, [f"https://example.com/{idx}" for idx in range(1, 5)])
            self.assertNotIn("web_search", captured["body"])
            self.assertNotIn("web_search_max_results", captured["body"])

    def test_chat_route_clamps_web_search_result_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            results = [
                {"title": f"Result {idx}", "url": f"https://example.com/{idx}", "snippet": f"Snippet {idx}"}
                for idx in range(1, 12)
            ]

            def run_with_count(value):
                activate_llama_runtime(ctx)
                response = DummySseResponse()
                with mock.patch.object(
                    chat.web_search,
                    "web_search",
                    return_value={"ok": True, "results": results},
                ) as search_mock, mock.patch.object(
                    chat.web_search,
                    "fetch_page_text",
                    return_value={"ok": True, "text": "Fresh page text"},
                ) as fetch_mock, mock.patch.object(
                    chat.chat_service,
                    "get_local_chat_api_url",
                    return_value="http://127.0.0.1:8080/v1/chat/completions",
                ), mock.patch.object(chat.urllib.request, "urlopen", return_value=FakeSseUpstream([b"data: [DONE]\n\n"])):
                    chat.completions(
                        Request(
                            "POST",
                            "/api/chat/completions",
                            "",
                            {},
                            body={
                                "web_search": True,
                                "web_search_max_results": value,
                                "messages": [{"role": "user", "content": "What changed?"}],
                            },
                        ),
                        response,
                        ctx,
                    )
                return search_mock.call_args.kwargs["max_results"], fetch_mock.call_count

            self.assertEqual(run_with_count(0), (1, 1))
            self.assertEqual(run_with_count(99), (10, 10))
            self.assertEqual(run_with_count("invalid"), (5, 5))

    def test_chat_route_refuses_before_web_search_without_active_llama_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummySseResponse()

            with mock.patch.object(chat.urllib.request, "urlopen") as urlopen, mock.patch.object(
                chat.web_search,
                "web_search",
            ) as search:
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
                        body={
                            "web_search": True,
                            "messages": [{"role": "user", "content": "Hello"}],
                            "host": "127.0.0.1",
                            "port": 9999,
                        },
                    ),
                    response,
                    ctx,
                )

            response.handler.wfile.seek(0)
            payload = response.handler.wfile.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("Start llama-server first", payload)
            self.assertIn("data: [DONE]", payload)
            search.assert_not_called()
            urlopen.assert_not_called()

    def test_chat_route_refuses_when_active_runtime_is_not_llama_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            activate_llama_runtime(ctx, tool="llama-cli")
            response = DummySseResponse()

            with mock.patch.object(chat.urllib.request, "urlopen") as urlopen:
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
                        body={
                            "messages": [{"role": "user", "content": "Hello"}],
                            "host": "127.0.0.1",
                            "port": 9999,
                        },
                    ),
                    response,
                    ctx,
                )

            response.handler.wfile.seek(0)
            payload = response.handler.wfile.read().decode("utf-8")
            self.assertIn("Start llama-server first", payload)
            self.assertIn("data: [DONE]", payload)
            urlopen.assert_not_called()

    def test_chat_route_web_search_preserves_array_system_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            activate_llama_runtime(ctx)
            response = DummySseResponse()
            captured = {}

            def fake_urlopen(req, timeout):
                captured["body"] = json.loads(req.data.decode("utf-8"))
                return FakeSseUpstream([b"data: [DONE]\n\n"])

            with mock.patch.object(
                chat.web_search,
                "web_search",
                return_value={
                    "ok": True,
                    "results": [
                        {
                            "title": "Fresh Result",
                            "url": "https://example.com/fresh",
                            "snippet": "Fresh snippet",
                        }
                    ],
                },
            ), mock.patch.object(
                chat.web_search,
                "fetch_page_text",
                return_value={"ok": True, "text": "Fresh page text"},
            ), mock.patch.object(chat.urllib.request, "urlopen", side_effect=fake_urlopen):
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
                        body={
                            "web_search": True,
                            "messages": [
                                {
                                    "role": "system",
                                    "content": [
                                        {"type": "text", "text": "Alpha instructions."},
                                        {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
                                        {"type": "text", "text": "Beta instructions."},
                                    ],
                                },
                                {"role": "user", "content": "What changed?"},
                            ],
                        },
                    ),
                    response,
                    ctx,
                )

            response.handler.wfile.seek(0)
            payload = response.handler.wfile.read().decode("utf-8")
            self.assertNotIn('"error"', payload)
            system_message = captured["body"]["messages"][0]
            self.assertEqual(system_message["role"], "system")
            self.assertIsInstance(system_message["content"], list)
            self.assertEqual(system_message["content"][:3], [
                {"type": "text", "text": "Alpha instructions."},
                {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
                {"type": "text", "text": "Beta instructions."},
            ])
            self.assertEqual(system_message["content"][-1]["type"], "text")
            self.assertIn("Fresh page text", system_message["content"][-1]["text"])

    def test_chat_route_web_search_keeps_unmergeable_system_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            activate_llama_runtime(ctx)
            response = DummySseResponse()
            captured = {}

            def fake_urlopen(req, timeout):
                captured["body"] = json.loads(req.data.decode("utf-8"))
                return FakeSseUpstream([b"data: [DONE]\n\n"])

            with mock.patch.object(
                chat.web_search,
                "web_search",
                return_value={
                    "ok": True,
                    "results": [
                        {
                            "title": "Fresh Result",
                            "url": "https://example.com/fresh",
                            "snippet": "Fresh snippet",
                        }
                    ],
                },
            ), mock.patch.object(
                chat.web_search,
                "fetch_page_text",
                return_value={"ok": True, "text": "Fresh page text"},
            ), mock.patch.object(chat.urllib.request, "urlopen", side_effect=fake_urlopen):
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
                        body={
                            "web_search": True,
                            "messages": [
                                {"role": "system", "content": {"unexpected": "shape"}},
                                {"role": "user", "content": "What changed?"},
                            ],
                        },
                    ),
                    response,
                    ctx,
                )

            proxied = captured["body"]["messages"]
            self.assertEqual(proxied[0]["role"], "system")
            self.assertIn("Fresh page text", proxied[0]["content"])
            self.assertEqual(proxied[1], {"role": "system", "content": {"unexpected": "shape"}})

    def test_chat_route_web_search_errors_when_latest_user_turn_has_no_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            activate_llama_runtime(ctx)
            response = DummySseResponse()

            with mock.patch.object(chat.urllib.request, "urlopen") as urlopen, mock.patch.object(
                chat.web_search,
                "web_search",
            ) as search:
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
                        body={
                            "web_search": True,
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
                                    ],
                                },
                            ],
                        },
                    ),
                    response,
                    ctx,
                )

            response.handler.wfile.seek(0)
            payload = response.handler.wfile.read().decode("utf-8")
            self.assertIn("Add a text question", payload)
            self.assertIn("data: [DONE]", payload)
            search.assert_not_called()
            urlopen.assert_not_called()

    def test_file_picker_route_uses_model_filters_for_model_purpose(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()

            with mock.patch(
                "backend.routes.file_picker.file_picker.select_file_in_native_dialog",
                return_value=str(ctx.paths.models / "model.gguf"),
            ) as select_file:
                file_picker.select_file(
                    Request(
                        "POST",
                        "/api/select-file",
                        "",
                        {},
                        body={"purpose": "model", "title": "Pick Model"},
                    ),
                    response,
                    ctx,
                )

            self.assertTrue(ctx.paths.models.exists())
            select_file.assert_called_once()
            _, kwargs = select_file.call_args
            self.assertEqual(kwargs["title"], "Pick Model")
            self.assertEqual(kwargs["initial_dir"], ctx.paths.models)
            # GGUF only: llama.cpp dropped the legacy ggml .bin formats, and the
            # HF download and launch-arg checks both reject .bin.
            self.assertEqual(kwargs["filetypes"][0], ("GGUF files", "*.gguf"))
            offered = " ".join(pattern for _, pattern in kwargs["filetypes"])
            self.assertNotIn(".bin", offered)
            self.assertIn(("All files", "*.*"), kwargs["filetypes"])
            self.assertEqual(response.payload, {"selected": True, "path": str(ctx.paths.models / "model.gguf")})

    def test_file_picker_route_uses_active_custom_model_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            custom = Path(tmp) / "custom-library"
            custom.mkdir()
            model_dir_service.set_models_dir(ctx, str(custom))
            response = DummyResponse()

            with mock.patch.object(
                file_picker.file_picker,
                "select_file_in_native_dialog",
                return_value="",
            ) as select_file:
                file_picker.select_file(
                    Request("POST", "/api/select-file", "", {}, body={"purpose": "model"}),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 200)
            self.assertEqual(select_file.call_args.kwargs["initial_dir"], custom.resolve())

    def test_folder_picker_route_reports_selection_and_cancellation(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            selected = str(Path(tmp) / "custom-library")
            for native_result, expected in ((selected, True), ("", False)):
                with self.subTest(native_result=native_result):
                    response = DummyResponse()
                    with mock.patch.object(
                        file_picker.file_picker,
                        "select_folder_in_native_dialog",
                        return_value=native_result,
                    ):
                        file_picker.select_folder(
                            Request("POST", "/api/select-folder", "", {}, body={}),
                            response,
                            ctx,
                        )
                    self.assertEqual(
                        response.payload,
                        {"selected": expected, "path": native_result},
                    )

    def test_folder_picker_route_sanitizes_native_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()
            stderr = io.StringIO()

            with contextlib.redirect_stderr(stderr), mock.patch.object(
                file_picker.file_picker,
                "select_folder_in_native_dialog",
                side_effect=RuntimeError("private picker failure"),
            ):
                file_picker.select_folder(
                    Request("POST", "/api/select-folder", "", {}, body={}),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 500)
            self.assertEqual(response.payload["error"], "Internal server error")
            self.assertIn("private picker failure", stderr.getvalue())

    def test_file_picker_route_handles_initial_directory_creation_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()
            stderr = io.StringIO()

            with contextlib.redirect_stderr(stderr), mock.patch.object(
                Path,
                "mkdir",
                side_effect=OSError("private path denied"),
            ), mock.patch.object(
                file_picker.file_picker, "select_file_in_native_dialog"
            ) as select_file:
                file_picker.select_file(
                    Request(
                        "POST",
                        "/api/select-file",
                        "",
                        {},
                        body={"purpose": "model"},
                    ),
                    response,
                    ctx,
                )

            self.assertEqual(response.status, 409)
            self.assertIn("Models folder is unavailable", response.payload["error"])
            select_file.assert_not_called()


class InstallRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = make_context(self.tmp.name)
        self.ctx.paths.models.mkdir(parents=True)
        self.ctx.services.backend_specs = {
            "cpu": {"label": "CPU", "asset": "llama-{tag}-bin-ubuntu-x64.tar.gz"},
        }
        self.ctx.services.load_config = lambda: {"tag": "b1", "backend": "cpu"}

    def tearDown(self):
        self.tmp.cleanup()

    def run_route_threads_immediately(self):
        class ImmediateThread:
            instances = []

            def __init__(self, target, args=(), daemon=None):
                self.target = target
                self.args = args
                self.daemon = daemon
                ImmediateThread.instances.append(self)

            def start(self):
                self.target(*self.args)

        return ImmediateThread

    def test_install_get_releases_returns_list(self):
        fake_releases = [
            {
                "tag_name": "b1",
                "name": "b1 release",
                "published_at": "2024-01-01T00:00:00Z",
                "assets": [{"name": "asset1.zip"}],
            }
        ]
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=fake_releases):
            install.get_releases(
                Request("GET", "/api/releases", "", {}), response, self.ctx
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(len(response.payload), 1)
        self.assertEqual(response.payload[0]["tag"], "b1")

    def test_install_can_activate_existing_backend_without_starting_download(self):
        response = DummyResponse()
        activated = {
            "ok": True,
            "backend": "cpu",
            "tag": "b1",
            "version": "b1",
        }
        with (
            mock.patch.object(
                llama_manager, "activate_official_backend", return_value=activated
            ) as activate,
            mock.patch.object(install.threading, "Thread") as thread,
            mock.patch.object(llama_manager, "install_release") as download,
        ):
            install.start_install(
                Request(
                    "POST",
                    "/api/install",
                    "",
                    {},
                    body={"backend": "cpu", "activate_existing": True},
                ),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload, activated)
        activate.assert_called_once_with(self.ctx, "cpu")
        thread.assert_not_called()
        download.assert_not_called()
        self.assertFalse(self.ctx.state.install_in_progress)

    def test_install_get_releases_caps_response_at_thirty(self):
        fake_releases = [
            {
                "tag_name": f"b{i}",
                "name": f"release {i}",
                "published_at": "2024-01-01T00:00:00Z",
                "assets": [],
            }
            for i in range(35)
        ]
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=fake_releases):
            install.get_releases(
                Request("GET", "/api/releases", "", {}), response, self.ctx
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(len(response.payload), 30)
        self.assertEqual(response.payload[-1]["tag"], "b29")

    def test_install_get_releases_filters_selected_backend_to_compatible_assets(self):
        self.ctx.services.backend_specs["rocm"] = {
            "label": "ROCm 7.14 (AMD, Official)",
            "asset": "llama-{tag}-bin-win-rocm-7.14-x64.zip",
        }
        fake_releases = [
            {
                "tag_name": tag,
                "name": tag,
                "published_at": "2026-08-11T00:00:00Z",
                "assets": [{"name": asset}],
            }
            for tag, asset in [
                ("b10356", "llama-b10356-bin-win-rocm-7.14-x64.zip"),
                ("b10355", "llama-b10355-bin-win-hip-radeon-x64.zip"),
            ]
        ]
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=fake_releases):
            install.get_releases(
                Request("GET", "/api/releases", "backend=rocm", {}), response, self.ctx
            )

        self.assertEqual([release["tag"] for release in response.payload], ["b10356"])

    def test_install_get_releases_pages_past_incompatible_release_window(self):
        self.ctx.services.backend_specs["rocm"] = {
            "label": "ROCm 7.14 (AMD, Official)",
            "asset": "llama-{tag}-bin-ubuntu-rocm-7.14-x64.tar.gz",
        }
        first_page = [
            {
                "tag_name": f"b{i}",
                "name": f"b{i}",
                "published_at": "2026-08-22T00:00:00Z",
                "assets": [{"name": f"llama-b{i}-bin-win-rocm-7.14-x64.zip"}],
            }
            for i in range(100)
        ]
        compatible = {
            "tag_name": "b10375",
            "name": "b10375",
            "published_at": "2026-08-12T12:18:24Z",
            "assets": [
                {"name": "llama-b10375-bin-ubuntu-rocm-7.14-x64.tar.gz"}
            ],
        }
        response = DummyResponse()
        with mock.patch.object(
            llama_manager, "get_releases", side_effect=[first_page, [compatible]]
        ) as get_releases:
            install.get_releases(
                Request("GET", "/api/releases", "backend=rocm", {}), response, self.ctx
            )

        self.assertEqual([release["tag"] for release in response.payload], ["b10375"])
        self.assertEqual(
            get_releases.call_args_list,
            [
                mock.call(self.ctx, self.ctx.config.github_api, page=1, per_page=100),
                mock.call(self.ctx, self.ctx.config.github_api, page=2, per_page=100),
            ],
        )

    def test_install_get_releases_error_returns_500(self):
        response = DummyResponse()
        with mock.patch.object(
            llama_manager, "get_releases", side_effect=RuntimeError("API down")
        ):
            install.get_releases(
                Request("GET", "/api/releases", "", {}), response, self.ctx
            )
        self.assertEqual(response.status, 500)
        self.assertEqual(response.payload["error"], "Internal server error")

    def test_install_get_download_progress_returns_snapshot(self):
        self.ctx.state.download_progress.update(status="downloading", downloaded=50, total=100)
        response = DummyResponse()
        install.get_download_progress(
            Request("GET", "/api/download-progress", "", {}), response, self.ctx
        )
        self.assertEqual(response.payload["status"], "downloading")
        self.assertEqual(response.payload["downloaded"], 50)
        self.assertEqual(response.payload["total"], 100)

    def test_install_validates_tag_and_backend_required(self):
        response = DummyResponse()
        for body in ({}, {"tag": "b1"}, {"backend": "cpu"}):
            with self.subTest(body=body):
                response = DummyResponse()
                install.start_install(
                    Request("POST", "/api/install", "", {}, body=body),
                    response,
                    self.ctx,
                )
                self.assertEqual(response.status, 400)
                self.assertIn("tag and backend required", response.payload["error"])

    def test_install_validates_backend(self):
        response = DummyResponse()
        install.start_install(
            Request(
                "POST",
                "/api/install",
                "",
                {},
                body={"tag": "b1", "backend": "nonexistent"},
            ),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 400)
        self.assertIn("Unsupported backend", response.payload["error"])

    def test_install_blocks_when_process_running(self):
        class FakeProcess:
            def poll(self):
                return None

        self.ctx.state.process = FakeProcess()
        response = DummyResponse()
        install.start_install(
            Request(
                "POST",
                "/api/install",
                "",
                {},
                body={"tag": "b1", "backend": "cpu"},
            ),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 400)
        self.assertIn("Stop running process first", response.payload["error"])

    def test_install_blocks_when_already_in_progress(self):
        with self.ctx.state.install_lock:
            self.ctx.state.install_in_progress = True
        response = DummyResponse()
        install.start_install(
            Request(
                "POST",
                "/api/install",
                "",
                {},
                body={"tag": "b1", "backend": "cpu"},
            ),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 409)
        self.assertIn("Installation already in progress", response.payload["error"])

    def test_install_starts_worker_and_clears_in_progress(self):
        response = DummyResponse()
        immediate_thread = self.run_route_threads_immediately()

        with (
            mock.patch.object(install.threading, "Thread", immediate_thread),
            mock.patch.object(
                llama_manager, "install_release", return_value=True
            ) as install_release,
        ):
            install.start_install(
                Request(
                    "POST",
                    "/api/install",
                    "",
                    {},
                    body={"tag": "b2", "backend": "cpu"},
                ),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload, {"status": "started"})
        self.assertFalse(self.ctx.state.install_in_progress)
        self.assertTrue(immediate_thread.instances[0].daemon)
        install_release.assert_called_once_with(
            self.ctx, "b2", "cpu", self.ctx.services.backend_specs
        )

    def test_install_claim_checks_process_while_holding_install_lock(self):
        lock_was_available = []

        def check_process(_ctx):
            acquired = self.ctx.state.install_lock.acquire(blocking=False)
            lock_was_available.append(acquired)
            if acquired:
                self.ctx.state.install_lock.release()
            return True

        response = DummyResponse()
        with mock.patch.object(
            process_manager, "is_process_running", side_effect=check_process
        ):
            install.start_install(
                Request(
                    "POST",
                    "/api/install",
                    "",
                    {},
                    body={"tag": "b1", "backend": "cpu"},
                ),
                response,
                self.ctx,
            )

        self.assertEqual(lock_was_available, [False])
        self.assertEqual(response.status, 400)

    def test_update_validates_nothing_installed(self):
        self.ctx.services.load_config = lambda: {}
        response = DummyResponse()
        install.start_update(
            Request("POST", "/api/update", "", {}, body={}),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 400)
        self.assertIn("Nothing installed", response.payload["error"])

    def test_update_blocks_when_process_running(self):
        class FakeProcess:
            def poll(self):
                return None

        self.ctx.state.process = FakeProcess()
        response = DummyResponse()
        install.start_update(
            Request("POST", "/api/update", "", {}, body={}),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 400)
        self.assertIn("Stop running process first", response.payload["error"])

    def test_update_returns_already_latest(self):
        fake_releases = [
            {
                "tag_name": "b1",
                "name": "b1 release",
                "published_at": "2024-01-01T00:00:00Z",
                "assets": [],
            }
        ]
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=fake_releases):
            install.start_update(
                Request("POST", "/api/update", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["status"], "already_latest")

    def test_update_starts_worker_for_newer_release_and_clears_in_progress(self):
        fake_releases = [
            {
                "tag_name": "b2",
                "name": "b2 release",
                "published_at": "2024-02-01T00:00:00Z",
                "assets": [],
            }
        ]
        response = DummyResponse()
        immediate_thread = self.run_route_threads_immediately()

        with (
            mock.patch.object(install.threading, "Thread", immediate_thread),
            mock.patch.object(llama_manager, "get_releases", return_value=fake_releases),
            mock.patch.object(
                llama_manager, "install_release", return_value=True
            ) as install_release,
        ):
            install.start_update(
                Request("POST", "/api/update", "", {}, body={}),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload, {"status": "started", "from": "b1", "to": "b2"})
        self.assertFalse(self.ctx.state.install_in_progress)
        self.assertTrue(immediate_thread.instances[0].daemon)
        install_release.assert_called_once_with(
            self.ctx, "b2", "cpu", self.ctx.services.backend_specs
        )

    def test_update_rechecks_for_a_process_after_release_lookup(self):
        fake_releases = [
            {
                "tag_name": "b2",
                "name": "b2 release",
                "published_at": "2024-02-01T00:00:00Z",
                "assets": [],
            }
        ]

        class FakeProcess:
            def poll(self):
                return None

        def lookup_then_launch(*_args, **_kwargs):
            self.ctx.state.process = FakeProcess()
            return fake_releases

        response = DummyResponse()
        with mock.patch.object(
            llama_manager, "get_releases", side_effect=lookup_then_launch
        ), mock.patch.object(install.threading, "Thread") as thread:
            install.start_update(
                Request("POST", "/api/update", "", {}, body={}),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 400)
        self.assertIn("Stop running process first", response.payload["error"])
        self.assertFalse(self.ctx.state.install_in_progress)
        thread.assert_not_called()

    def test_update_blocks_when_already_in_progress_without_calling_github(self):
        with self.ctx.state.install_lock:
            self.ctx.state.install_in_progress = True
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases") as gr:
            install.start_update(
                Request("POST", "/api/update", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 409)
        self.assertIn("Installation already in progress", response.payload["error"])
        # The early reject must happen before the release lookup so a duplicate
        # request costs no GitHub rate-limit quota.
        gr.assert_not_called()

    def test_update_reports_release_lookup_failure_without_claiming_slot(self):
        response = DummyResponse()
        immediate_thread = self.run_route_threads_immediately()
        with (
            mock.patch.object(install.threading, "Thread", immediate_thread),
            mock.patch.object(
                llama_manager, "get_releases", side_effect=RuntimeError("network down")
            ),
        ):
            install.start_update(
                Request("POST", "/api/update", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 500)
        self.assertFalse(self.ctx.state.install_in_progress)
        self.assertEqual(immediate_thread.instances, [])

    def test_update_leaves_slot_free_when_already_latest(self):
        fake_releases = [
            {
                "tag_name": "b1",
                "name": "b1 release",
                "published_at": "2024-01-01T00:00:00Z",
                "assets": [],
            }
        ]
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=fake_releases):
            install.start_update(
                Request("POST", "/api/update", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.payload["status"], "already_latest")
        self.assertFalse(self.ctx.state.install_in_progress)

    def test_get_releases_uses_backend_repo_api_for_lemonade(self):
        self.ctx.services.backend_specs["lemonade-rocm-gfx110X"] = {
            "label": "ROCm 7 gfx110X (Lemonade)",
            "repo_api": llama_manager.LEMONADE_ROCM_REPO_API,
        }
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=[]) as gr:
            install.get_releases(
                Request("GET", "/api/releases", "backend=lemonade-rocm-gfx110X", {}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        gr.assert_called_once_with(
            self.ctx,
            llama_manager.LEMONADE_ROCM_REPO_API,
            page=1,
            per_page=100,
        )

    def test_get_releases_without_backend_param_uses_default(self):
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=[]) as gr:
            install.get_releases(
                Request("GET", "/api/releases", "", {}),
                response,
                self.ctx,
            )
        gr.assert_called_once_with(self.ctx, None, page=1, per_page=100)

    def test_get_releases_ignores_unknown_backend(self):
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases", return_value=[]) as gr:
            install.get_releases(
                Request("GET", "/api/releases", "backend=does-not-exist", {}),
                response,
                self.ctx,
            )
        gr.assert_called_once_with(self.ctx, None, page=1, per_page=100)

    def test_get_releases_returns_empty_for_custom_backend(self):
        response = DummyResponse()
        with mock.patch.object(llama_manager, "get_releases") as gr:
            install.get_releases(
                Request("GET", "/api/releases", "backend=custom", {}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload, [])
        gr.assert_not_called()

    def test_update_uses_installed_backend_repo_api_for_lemonade(self):
        self.ctx.services.backend_specs["lemonade-rocm-gfx110X"] = {
            "label": "ROCm 7 gfx110X (Lemonade)",
            "repo_api": llama_manager.LEMONADE_ROCM_REPO_API,
        }
        self.ctx.services.load_config = lambda: {
            "tag": "b1294",
            "backend": "lemonade-rocm-gfx110X",
        }
        fake_releases = [
            {
                "tag_name": "b1295",
                "name": "b1295",
                "published_at": "2024-03-01T00:00:00Z",
                "assets": [],
            }
        ]
        response = DummyResponse()
        immediate_thread = self.run_route_threads_immediately()
        with (
            mock.patch.object(install.threading, "Thread", immediate_thread),
            mock.patch.object(llama_manager, "get_releases", return_value=fake_releases) as gr,
            mock.patch.object(llama_manager, "install_release", return_value=True),
        ):
            install.start_update(
                Request("POST", "/api/update", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["status"], "started")
        gr.assert_called_once_with(self.ctx, llama_manager.LEMONADE_ROCM_REPO_API)


    def test_activate_custom_blocks_when_install_in_progress(self):
        with self.ctx.state.install_lock:
            self.ctx.state.install_in_progress = True
        response = DummyResponse()
        with mock.patch.object(llama_manager, "activate_custom_backend") as activate:
            install.activate_custom(
                Request("POST", "/api/activate-custom", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 409)
        self.assertIn("Installation already in progress", response.payload["error"])
        activate.assert_not_called()
        self.assertTrue(self.ctx.state.install_in_progress)

    def test_activate_custom_releases_install_slot(self):
        response = DummyResponse()
        with mock.patch.object(
            llama_manager,
            "activate_custom_backend",
            return_value={"ok": True},
        ) as activate:
            install.activate_custom(
                Request("POST", "/api/activate-custom", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload, {"ok": True})
        activate.assert_called_once_with(self.ctx)
        self.assertFalse(self.ctx.state.install_in_progress)

    def test_activate_custom_releases_install_slot_on_failure(self):
        response = DummyResponse()
        with mock.patch.object(
            llama_manager,
            "activate_custom_backend",
            side_effect=RuntimeError("boom"),
        ):
            install.activate_custom(
                Request("POST", "/api/activate-custom", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 500)
        self.assertFalse(self.ctx.state.install_in_progress)


class ExternalServerRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = make_context(self.tmp.name)
        self.ctx.services.set_llama_api_target = mock.Mock(return_value={})
        self.config_store = {"tag": "b1"}

        def save_config(config_data):
            self.config_store.clear()
            self.config_store.update(config_data)

        self.ctx.services.load_config = lambda: dict(self.config_store)
        self.ctx.services.save_config = save_config

    def tearDown(self):
        self.tmp.cleanup()

    def post(self, body):
        response = DummyResponse()
        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            return_value=FakeHealthUpstream(200),
        ):
            external_server.connect(
                Request("POST", "/api/chat/target", "", {}, body=body), response, self.ctx
            )
        return response

    def test_get_returns_null_when_nothing_is_registered(self):
        response = DummyResponse()

        external_server.get_target(Request("GET", "/api/chat/target", "", {}), response, self.ctx)

        self.assertEqual(response.status, 200)
        self.assertIsNone(response.payload["external_chat_target"])

    def test_connect_registers_and_get_reports_the_target(self):
        connect_response = self.post({"host": "127.0.0.1", "port": 9001, "label": "Manual"})

        self.assertEqual(connect_response.status, 200)
        target = connect_response.payload["external_chat_target"]
        self.assertEqual(target["host"], "127.0.0.1")
        self.assertEqual(target["port"], 9001)
        self.assertEqual(target["label"], "Manual")
        self.assertEqual(target["probe_status"], 200)

        get_response = DummyResponse()
        external_server.get_target(
            Request("GET", "/api/chat/target", "", {}), get_response, self.ctx
        )
        self.assertEqual(get_response.payload["external_chat_target"]["port"], 9001)

    def test_connect_never_echoes_the_api_key(self):
        response = self.post({"host": "127.0.0.1", "port": 9001, "api_key": "top-secret"})

        self.assertNotIn("top-secret", json.dumps(response.payload))
        self.assertTrue(response.payload["external_chat_target"]["api_key_configured"])

    def test_connect_rejects_a_remote_host_with_400(self):
        response = self.post({"host": "203.0.113.10", "port": 9001})

        self.assertEqual(response.status, 400)
        self.assertIsNone(external_server_service.get_target(self.ctx))

    def test_connect_rejects_an_invalid_port_with_400(self):
        response = self.post({"host": "127.0.0.1", "port": 70000})

        self.assertEqual(response.status, 400)
        self.assertIn("port", response.payload["error"].lower())

    def test_connect_reports_an_unreachable_address_with_502(self):
        response = DummyResponse()

        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            external_server.connect(
                Request("POST", "/api/chat/target", "", {}, body={"host": "127.0.0.1", "port": 9001}),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 502)
        self.assertIn("No server answered", response.payload["error"])
        self.assertIsNone(external_server_service.get_target(self.ctx))

    def test_disconnect_clears_the_target(self):
        self.post({"host": "127.0.0.1", "port": 9001, "api_key": "top-secret"})
        response = DummyResponse()

        external_server.disconnect(
            Request("DELETE", "/api/chat/target", "", {}), response, self.ctx
        )

        self.assertEqual(response.status, 200)
        self.assertIsNone(response.payload["external_chat_target"])
        self.assertIsNone(external_server_service.get_target(self.ctx))
        self.assertEqual(self.ctx.state.external_chat_api_key, "")

    def test_get_reports_the_remembered_address_after_a_disconnect_free_restart(self):
        self.config_store["external_chat_target"] = {
            "host": "127.0.0.1",
            "port": 9001,
            "label": "Box",
            "api_key_required": True,
        }
        response = DummyResponse()

        external_server.get_target(Request("GET", "/api/chat/target", "", {}), response, self.ctx)

        self.assertIsNone(response.payload["external_chat_target"])
        self.assertEqual(response.payload["remembered_target"]["port"], 9001)
        self.assertTrue(response.payload["remembered_target"]["api_key_required"])

    def test_restore_reconnects_a_keyless_remembered_address(self):
        self.config_store["external_chat_target"] = {
            "host": "127.0.0.1",
            "port": 9001,
            "label": "Box",
            "api_key_required": False,
        }
        response = DummyResponse()

        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            return_value=FakeHealthUpstream(200),
        ):
            external_server.connect(
                Request("POST", "/api/chat/target", "", {}, body={"restore": True}),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["external_chat_target"]["port"], 9001)
        self.assertEqual(external_server_service.get_target(self.ctx)["port"], 9001)

    def test_restore_does_nothing_when_the_address_needed_a_key(self):
        self.config_store["external_chat_target"] = {
            "host": "127.0.0.1",
            "port": 9001,
            "api_key_required": True,
        }
        response = DummyResponse()

        with mock.patch.object(external_server_service, "_open_probe_request") as open_probe:
            external_server.connect(
                Request("POST", "/api/chat/target", "", {}, body={"restore": True}),
                response,
                self.ctx,
            )

        open_probe.assert_not_called()
        self.assertEqual(response.status, 200)
        self.assertIsNone(response.payload["external_chat_target"])
        self.assertEqual(response.payload["remembered_target"]["port"], 9001)

    def test_restore_reports_a_port_taken_by_something_else(self):
        self.config_store["external_chat_target"] = {
            "host": "127.0.0.1",
            "port": 9001,
            "api_key_required": False,
        }
        response = DummyResponse()

        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            return_value=FakeHealthUpstream(200, b"<html>some other dev server</html>"),
        ):
            external_server.connect(
                Request("POST", "/api/chat/target", "", {}, body={"restore": True}),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 502)
        self.assertIn("does not look like llama-server", response.payload["error"])
        self.assertIsNone(external_server_service.get_target(self.ctx))

    def test_disconnect_forgets_the_remembered_address(self):
        self.post({"host": "127.0.0.1", "port": 9001})
        self.assertIn("external_chat_target", self.config_store)
        response = DummyResponse()

        external_server.disconnect(
            Request("DELETE", "/api/chat/target", "", {}), response, self.ctx
        )

        self.assertNotIn("external_chat_target", self.config_store)
        self.assertIsNone(response.payload["remembered_target"])

    def test_chat_route_proxies_to_a_registered_external_server(self):
        register_external_server(self.ctx, host="127.0.0.1", port=9001, api_key="external-key")
        response = DummySseResponse()
        captured = {}

        def fake_urlopen(req, timeout):
            captured["url"] = req.full_url
            captured["authorization"] = req.get_header("Authorization")
            return FakeSseUpstream([b"data: [DONE]\n\n"])

        with mock.patch.object(chat.urllib.request, "urlopen", side_effect=fake_urlopen):
            chat.completions(
                Request(
                    "POST",
                    "/api/chat/completions",
                    "",
                    {"Authorization": "Bearer caller-key"},
                    body={"messages": [{"role": "user", "content": "Hello"}]},
                ),
                response,
                self.ctx,
            )

        self.assertEqual(captured["url"], "http://127.0.0.1:9001/v1/chat/completions")
        self.assertEqual(captured["authorization"], "Bearer external-key")

    def test_chat_route_prefers_a_launched_runtime_over_the_registered_target(self):
        register_external_server(self.ctx, host="127.0.0.1", port=9001)
        activate_llama_runtime(self.ctx, host="127.0.0.1", port=8124)
        response = DummySseResponse()
        captured = {}

        def fake_urlopen(req, timeout):
            captured["url"] = req.full_url
            return FakeSseUpstream([b"data: [DONE]\n\n"])

        with mock.patch.object(chat.urllib.request, "urlopen", side_effect=fake_urlopen):
            chat.completions(
                Request(
                    "POST",
                    "/api/chat/completions",
                    "",
                    {},
                    body={"messages": [{"role": "user", "content": "Hello"}]},
                ),
                response,
                self.ctx,
            )

        self.assertEqual(captured["url"], "http://127.0.0.1:8124/v1/chat/completions")

    def test_chat_route_still_ignores_a_target_supplied_in_the_body(self):
        response = DummySseResponse()

        with mock.patch.object(chat.urllib.request, "urlopen") as urlopen:
            chat.completions(
                Request(
                    "POST",
                    "/api/chat/completions",
                    "",
                    {},
                    body={
                        "messages": [{"role": "user", "content": "Hello"}],
                        "host": "127.0.0.1",
                        "port": 9001,
                    },
                ),
                response,
                self.ctx,
            )

        response.handler.wfile.seek(0)
        payload = response.handler.wfile.read().decode("utf-8")
        self.assertIn("Start llama-server first", payload)
        urlopen.assert_not_called()

    def test_metrics_route_uses_the_registered_target(self):
        register_external_server(self.ctx, host="127.0.0.1", port=9001, api_key="external-key")
        captured = {}

        def fake_metrics(host, port, authorization):
            captured["args"] = (host, port, authorization)
            return "llama_metric 1", ""

        self.ctx.services.get_local_llama_metrics = fake_metrics
        response = DummyResponse()

        metrics.get_metrics(
            Request("GET", "/api/llama/metrics", "", {"Authorization": "Bearer caller-key"}),
            response,
            self.ctx,
        )

        self.assertEqual(captured["args"], ("127.0.0.1", 9001, "Bearer external-key"))
        self.assertEqual(response.text_payload, "llama_metric 1")

    def test_status_route_publishes_the_target_without_the_key(self):
        register_external_server(self.ctx, host="127.0.0.1", port=9001, api_key="top-secret")
        configure_status_services(self.ctx)
        response = DummyResponse()

        status.get_status(Request("GET", "/api/status", "", {}), response, self.ctx)

        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["external_chat_target"]["port"], 9001)
        self.assertTrue(response.payload["external_chat_target"]["api_key_configured"])
        self.assertNotIn("top-secret", json.dumps(response.payload))


class TunnelRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = make_context(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_status_returns_idle_by_default(self):
        response = DummyResponse()
        tunnel.get_status(Request("GET", "/api/remote-tunnel/status", "", {}), response, self.ctx)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["status"], "idle")
        self.assertEqual(response.payload["url"], "")
        self.assertEqual(response.payload["message"], "Remote tunnel is not running.")
        self.assertFalse(response.payload["running"])

    def test_status_reflects_set_state(self):
        from backend.services import tunnel as tunnel_service
        tunnel_service.set_remote_tunnel_state(
            self.ctx, status="running", url="https://test.trycloudflare.com",
            message="Running", log="test log",
        )
        response = DummyResponse()
        tunnel.get_status(Request("GET", "/api/remote-tunnel/status", "", {}), response, self.ctx)
        self.assertEqual(response.payload["status"], "running")
        self.assertEqual(response.payload["url"], "https://test.trycloudflare.com")
        self.assertIn("test log", response.payload["log"])
        self.assertFalse(response.payload["running"])

    def test_status_detects_dead_process(self):
        from backend.services import tunnel as tunnel_service
        class DeadProcess:
            def poll(self):
                return -1
        self.ctx.state.remote_tunnel_process = DeadProcess()
        tunnel_service.set_remote_tunnel_state(
            self.ctx, status="running", url="https://test.trycloudflare.com",
        )
        response = DummyResponse()
        tunnel.get_status(Request("GET", "/api/remote-tunnel/status", "", {}), response, self.ctx)
        self.assertEqual(response.payload["status"], "error")
        self.assertEqual(response.payload["message"], "Remote tunnel process exited.")
        self.assertFalse(response.payload["running"])

    def test_start_rejects_invalid_host(self):
        calls = []

        def set_target(host, port):
            calls.append((host, port))
            raise ValueError("Invalid proxy host: bad!")

        self.ctx.services.set_llama_api_target = set_target
        response = DummyResponse()
        tunnel.start(
            Request("POST", "/api/remote-tunnel/start", "", {}, body={"host": "bad!"}),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 400)
        self.assertIn("Invalid proxy host", response.payload["error"])

    def test_start_spawns_worker_thread(self):
        self.ctx.services.set_llama_api_target = lambda host, port: {"host": host or "127.0.0.1", "port": port or 8080}
        threads = []

        class FakeThread:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.started = False
            def start(self):
                self.started = True
                threads.append(self)

        with mock.patch("backend.services.tunnel.threading.Thread", FakeThread):
            response = DummyResponse()
            tunnel.start(
                Request("POST", "/api/remote-tunnel/start", "", {}),
                response,
                self.ctx,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["status"], "preparing")
        self.assertEqual(response.payload["message"], "Preparing Cloudflare tunnel...")
        self.assertFalse(response.payload["running"])
        self.assertEqual(len(threads), 1)
        self.assertTrue(threads[0].kwargs.get("daemon"))

    def test_stop_returns_idle_when_no_process(self):
        response = DummyResponse()
        tunnel.stop(
            Request("POST", "/api/remote-tunnel/stop", "", {}),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["status"], "stopped")
        self.assertEqual(response.payload["message"], "Remote tunnel stopped.")
        self.assertFalse(response.payload["running"])

    def test_stop_clears_process(self):
        self.ctx.services.current_platform = "win32"
        ctrl_break_event = object()
        killed = []

        class FakeProcess:
            def poll(self):
                return None

            def send_signal(self, sig):
                killed.append(sig)

            def wait(self, timeout):
                return 0

        self.ctx.state.remote_tunnel_process = FakeProcess()
        response = DummyResponse()
        with mock.patch(
            "backend.services.tunnel.signal.CTRL_BREAK_EVENT",
            ctrl_break_event,
            create=True,
        ):
            tunnel.stop(
                Request("POST", "/api/remote-tunnel/stop", "", {}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["status"], "stopped")
        self.assertIsNone(self.ctx.state.remote_tunnel_process)
        self.assertEqual(killed, [ctrl_break_event])


class SubprocessWindowFlagTests(unittest.TestCase):
    """Helper subprocesses must not flash a console when the server runs detached."""

    # subprocess only defines CREATE_NO_WINDOW on Windows, so the value is spelled out
    # here and injected below to exercise the win32 branch on every platform
    CREATE_NO_WINDOW = 0x08000000

    def test_creationflags_are_windows_only(self):
        from backend.services import subprocess_utils

        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            # pins the literal above against the real constant wherever it exists
            self.assertEqual(subprocess.CREATE_NO_WINDOW, self.CREATE_NO_WINDOW)

        with mock.patch.object(
            subprocess_utils.subprocess, "CREATE_NO_WINDOW", self.CREATE_NO_WINDOW, create=True
        ):
            with mock.patch.object(subprocess_utils.sys, "platform", "win32"):
                self.assertEqual(
                    subprocess_utils.get_no_window_creationflags(),
                    self.CREATE_NO_WINDOW,
                )
            for platform_name in ("linux", "darwin"):
                with mock.patch.object(subprocess_utils.sys, "platform", platform_name):
                    self.assertEqual(subprocess_utils.get_no_window_creationflags(), 0)

    def test_run_git_hides_the_console_window(self):

        with mock.patch.object(srv.subprocess, "run") as runner:
            with mock.patch.object(srv, "get_no_window_creationflags", return_value=0x08000000):
                srv.run_git(["status"], ".")

        self.assertEqual(runner.call_args.kwargs["creationflags"], 0x08000000)

    def test_run_git_cannot_block_on_a_credential_prompt(self):
        """run_git executes on an HTTP handler thread. A network git command
        against a repo needing credentials would otherwise wait forever on a
        prompt nobody can see."""
        with mock.patch.object(srv.subprocess, "run") as runner:
            srv.run_git(["fetch", "origin"], ".")

        kwargs = runner.call_args.kwargs
        self.assertEqual(kwargs["stdin"], srv.subprocess.DEVNULL, "stdin must be closed")
        self.assertEqual(kwargs["timeout"], srv.GIT_COMMAND_TIMEOUT_SECONDS)
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(kwargs["env"]["GCM_INTERACTIVE"], "Never")
        self.assertIn("PATH", kwargs["env"], "the real environment must still be inherited")

    def test_run_git_timeout_becomes_a_failed_result(self):
        """Callers only check returncode, so a timeout must not surface as an
        exception escaping into the route layer."""
        timeout_error = srv.subprocess.TimeoutExpired(cmd=["git", "fetch"], timeout=1)
        with mock.patch.object(srv.subprocess, "run", side_effect=timeout_error):
            with contextlib.redirect_stderr(io.StringIO()) as captured:
                result = srv.run_git(["fetch", "origin"], ".", timeout=1)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("timed out", result.stderr)
        self.assertIn("timed out", captured.getvalue())

    def test_every_probe_subprocess_run_sets_creationflags(self):
        """Guards against a new probe reintroducing the console flash."""
        import ast
        import pathlib

        services = pathlib.Path(__file__).resolve().parents[2] / "backend" / "services"
        missing = []
        found = []
        for module_name in ("git_update.py", "process_manager.py"):
            module_path = services / module_name
            tree = ast.parse(module_path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                is_subprocess_run = (
                    isinstance(func, ast.Attribute)
                    and func.attr == "run"
                    and isinstance(func.value, ast.Name)
                    and func.value.id == "subprocess"
                )
                if not is_subprocess_run:
                    continue
                found.append(f"{module_name}:{node.lineno}")
                keywords = {kw.arg for kw in node.keywords}
                if "creationflags" not in keywords:
                    missing.append(f"{module_name}:{node.lineno}")

        # without this the scan could silently match nothing and pass vacuously
        self.assertGreaterEqual(len(found), 6, f"probe scan found too few call sites: {found}")
        self.assertEqual(missing, [], f"subprocess.run without creationflags: {missing}")

    def test_launch_process_hides_console_window(self):
        """The long-running llama.cpp runtime must not flash a console window.

        The window is hidden via STARTUPINFO (SW_HIDE) rather than
        CREATE_NO_WINDOW, so the child keeps its console association and a
        console-attached parent can still deliver CTRL_BREAK_EVENT. The only
        creation flag is CREATE_NEW_PROCESS_GROUP.
        """
        create_new_process_group = 0x00000200
        starf_useshowwindow = 0x00000001
        sw_hide = 0x00000000

        class FakeStartupinfo:
            def __init__(self):
                self.dwFlags = 0
                self.wShowWindow = None

        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            executable = ctx.paths.llama_bin / "llama-server"
            executable.write_text("binary")
            executable.chmod(0o755)
            ctx.services = BackendServices(
                current_platform="linux",
                find_tool_executable=lambda tool: executable,
                get_tool_filename=lambda tool: tool,
                load_config=lambda: {},
                set_llama_api_target=lambda host, port: {"host": host, "port": int(port)},
                get_llama_api_target=lambda: {"host": "127.0.0.1", "port": 8080},
            )
            fake_process = mock.Mock()
            fake_process.pid = 4242
            fake_process.stdout = io.StringIO()
            fake_process.stderr = io.StringIO()
            fake_process.poll.return_value = None

            class FakeThread:
                def __init__(self, **kwargs):
                    pass

                def start(self):
                    pass

            with mock.patch.object(
                process_manager.subprocess, "Popen", return_value=fake_process
            ) as mock_popen, mock.patch.object(
                process_manager.threading, "Thread", FakeThread
            ), mock.patch.object(
                process_manager.sys, "platform", "win32"
            ), mock.patch.object(
                process_manager.subprocess,
                "CREATE_NEW_PROCESS_GROUP",
                create_new_process_group,
                create=True,
            ), mock.patch.object(
                process_manager.subprocess, "STARTUPINFO", FakeStartupinfo, create=True
            ), mock.patch.object(
                process_manager.subprocess,
                "STARTF_USESHOWWINDOW",
                starf_useshowwindow,
                create=True,
            ), mock.patch.object(
                process_manager.subprocess, "SW_HIDE", sw_hide, create=True
            ):
                process_manager.launch_process(ctx, "llama-server", ["-m=models/gemma.gguf"])

            kwargs = mock_popen.call_args.kwargs
            # 1) startupinfo requests SW_HIDE
            startupinfo = kwargs["startupinfo"]
            self.assertIsInstance(startupinfo, FakeStartupinfo)
            self.assertTrue(
                startupinfo.dwFlags & starf_useshowwindow,
                "STARTF_USESHOWWINDOW not set",
            )
            self.assertEqual(startupinfo.wShowWindow, sw_hide, "window not hidden")
            # 2) creationflags is exactly CREATE_NEW_PROCESS_GROUP (no CREATE_NO_WINDOW)
            self.assertEqual(kwargs["creationflags"], create_new_process_group)

    def test_stop_process_falls_back_to_kill_when_signal_fails(self):
        """When the console-less parent cannot deliver CTRL_BREAK the process
        must still be killed rather than left running."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            process = mock.Mock()
            # alive on entry, dead once killed
            process.poll.side_effect = [None, 0, 0]
            process.send_signal.side_effect = OSError(6, "The handle is invalid")
            ctx.state.process = process

            with mock.patch.object(process_manager.sys, "platform", "win32"), \
                    mock.patch.object(
                        process_manager.signal, "CTRL_BREAK_EVENT", 1, create=True
                    ):
                stopped = process_manager._stop_process_locked(ctx)

            process.send_signal.assert_called_once()
            process.kill.assert_called_once()
            self.assertTrue(stopped)
            self.assertIsNone(ctx.state.process)


class GitUpdateRouteTests(unittest.TestCase):
    """Tests for backend/services/git_update.py and backend/routes/git_update.py."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = make_context(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    # --- Test helpers ---
    #
    # git_update shells out for everything, so nearly every test needs a stand-in
    # for run_git plus a fake .git directory. Keeping that in one place means a
    # change to how a git command is invoked is fixed here rather than in each of
    # the tests below.

    @staticmethod
    def proc_result(returncode=0, stdout="", stderr=""):
        """Stand in for the CompletedProcess that run_git and subprocess return."""
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

    @staticmethod
    def git_command_key(args):
        """Name the git command an argument list represents."""
        if args == ["--version"]:
            return "version"
        if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
            return "branch"
        if args[:3] == ["rev-parse", "--verify", "--quiet"]:
            return "upstream_exists"
        if args == ["config", "--get", "remote.origin.url"]:
            return "remote_url"
        if args == ["status", "--porcelain=v1", "-z"]:
            return "status"
        if args[:1] == ["for-each-ref"]:
            return "tags"
        if args[:1] == ["fetch"]:
            return "fetch"
        if args[:2] == ["rev-list", "--left-right"]:
            return "counts"
        if args[:2] == ["merge", "--ff-only"]:
            return "merge"
        return ""

    @classmethod
    def git_calls(cls, call_log, key):
        """Every logged invocation of one git command."""
        return [args for args in call_log if cls.git_command_key(args) == key]

    def git_mock(
        self,
        branch="main",
        tags="v1.2.3\n",
        dirty="",
        counts="0\t0",
        upstream_exists=True,
        merge_stdout="",
        overrides=None,
        call_log=None,
    ):
        """Build a run_git stand-in.

        ``counts`` is the raw `rev-list --left-right --count` output, so it reads
        "<ahead>\t<behind>". ``overrides`` maps a git_command_key name to a
        proc_result and wins over the defaults; unmatched commands succeed with
        empty output.
        """
        defaults = {
            "version": self.proc_result(stdout="git 2.40"),
            "branch": self.proc_result(stdout=branch),
            "remote_url": self.proc_result(stdout="https://github.com/user/repo.git"),
            "upstream_exists": self.proc_result(returncode=0 if upstream_exists else 1),
            "tags": self.proc_result(stdout=tags),
            "status": self.proc_result(stdout=dirty),
            "counts": self.proc_result(stdout=counts),
            "merge": self.proc_result(stdout=merge_stdout),
            **(overrides or {}),
        }

        def mock_run(args, cwd):
            if call_log is not None:
                call_log.append(args)
            return defaults.get(self.git_command_key(args), self.proc_result())

        return mock_run

    @contextlib.contextmanager
    def patched_git(self, **kwargs):
        """Make the context look like a git checkout and stub run_git.

        Keyword arguments are passed straight through to git_mock.
        """
        git_dir = self.ctx.paths.root / ".git"
        if not git_dir.exists():
            git_dir.mkdir()
        with mock.patch.object(srv, "run_git", self.git_mock(**kwargs)) as patched:
            yield patched

    @contextlib.contextmanager
    def patched_pip(self, returncode=0, stdout="Successfully installed", stderr=""):
        with mock.patch.object(srv.subprocess, "run") as mock_pip:
            mock_pip.return_value = self.proc_result(returncode, stdout, stderr)
            yield mock_pip

    @contextlib.contextmanager
    def patched_shortcuts(self, created=True, error=None, message="Shortcut ready"):
        result = {"created": created}
        if error is not None:
            result["error"] = error
        elif created:
            result["message"] = message
        else:
            result["skipped"] = True
        with mock.patch.object(
            srv, "create_windows_shortcuts", return_value=result
        ) as mock_shortcuts:
            yield mock_shortcuts

    def write_shortcut_helper(self):
        """Create the PowerShell helper create_windows_shortcuts() looks for."""
        shortcut_script = self.ctx.paths.root / "scripts" / "create_windows_shortcuts.ps1"
        shortcut_script.parent.mkdir(exist_ok=True)
        shortcut_script.write_text("# helper\n")
        return shortcut_script

    def find_release_tag_in(self, stdout, returncode=0, stderr=""):
        """Run find_latest_release_tag over a canned for-each-ref listing."""
        with mock.patch.object(srv, "run_git") as mock_run_git:
            mock_run_git.return_value = self.proc_result(returncode, stdout, stderr)
            return srv.find_latest_release_tag(self.ctx.paths.root, "origin/main")

    # --- Pure function tests ---

    def test_normalize_git_path_normalizes_backslashes(self):
        self.assertEqual(srv.normalize_git_path("foo\\bar"), "foo/bar")
        self.assertEqual(srv.normalize_git_path("  foo/bar  "), "foo/bar")
        self.assertEqual(srv.normalize_git_path(""), "")
        self.assertEqual(srv.normalize_git_path(None), "")

    def test_parse_git_status_porcelain_z_basic(self):
        output = "M  src/main.py\x00 M modified.txt\x00"
        entries = srv.parse_git_status_porcelain_z(output)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0], {"status": "M ", "path": "src/main.py"})
        self.assertEqual(entries[1], {"status": " M", "path": "modified.txt"})

    def test_parse_git_status_porcelain_z_rename_detection(self):
        output = "R  new.py\x00old.py\x00"
        entries = srv.parse_git_status_porcelain_z(output)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["status"], "R ")
        self.assertEqual(entries[0]["path"], "new.py")
        self.assertEqual(entries[0]["source_path"], "old.py")

    def test_is_safe_dirty_path_known_prefixes(self):
        safe_prefixes = [
            "llama/bin/server.exe",
            "models/model.gguf",
            "__pycache__/cache.py",
            ".venv/lib/site-packages/pkg",
            "logs/server.log",
            "tmp/scratch.txt",
        ]
        for path in safe_prefixes:
            self.assertTrue(srv.is_safe_dirty_path(path), f"Expected safe: {path}")
        self.assertFalse(srv.is_safe_dirty_path("src/main.py"))
        self.assertFalse(srv.is_safe_dirty_path("server.py"))

    def test_is_safe_dirty_path_known_exact(self):
        self.assertTrue(srv.is_safe_dirty_path("config.json"))
        self.assertTrue(srv.is_safe_dirty_path(".env"))
        self.assertTrue(srv.is_safe_dirty_path(".env.local"))

    def test_is_safe_dirty_path_known_suffixes(self):
        for ext in [".pyc", ".log", ".zip", ".tar.gz", ".tgz", ".bak", ".swp"]:
            self.assertTrue(srv.is_safe_dirty_path(f"file{ext}"), f"Expected safe: file{ext}")

    def test_is_safe_dirty_path_blocking(self):
        blocking = [
            "src/lib/helper.py",
            "server.py",
            "ui/js/app.js",
            "README.md",
            ".github/workflows/ci.yml",
            # Must NOT match the loose ".env" prefix: only ".env" / ".env.*" are safe.
            ".envrc",
            ".environment_notes.md",
        ]
        for path in blocking:
            self.assertFalse(srv.is_safe_dirty_path(path), f"Expected blocking: {path}")

    def test_classify_git_dirty_paths(self):
        entries = [
            {"status": " M", "path": "server.py"},
            {"status": " M", "path": "models/model.gguf"},
            {"status": "??", "path": "config.json"},
            {"status": " M", "path": "presets/custom.json"},
        ]
        result = srv.classify_git_dirty_paths(entries)
        self.assertEqual(result["dirty_paths"], ["server.py", "models/model.gguf", "config.json", "presets/custom.json"])
        self.assertEqual(result["safe_dirty_paths"], ["models/model.gguf", "config.json", "presets/custom.json"])
        self.assertEqual(result["blocking_dirty_paths"], ["server.py"])

    def test_classify_git_dirty_paths_blocks_unsafe_rename_source(self):
        entries = [
            {"status": "R ", "path": "models/server.py", "source_path": "server.py"},
            {"status": "R ", "path": "models/new.gguf", "source_path": "models/old.gguf"},
        ]
        result = srv.classify_git_dirty_paths(entries)
        self.assertEqual(result["safe_dirty_paths"], ["models/new.gguf"])
        self.assertEqual(result["blocking_dirty_paths"], ["models/server.py"])

    def test_normalize_update_channel_validates_allowlist(self):
        self.assertEqual(srv.normalize_update_channel(None), "stable")
        self.assertEqual(srv.normalize_update_channel(" NIGHTLY "), "nightly")
        with self.assertRaisesRegex(ValueError, "stable.*nightly"):
            srv.normalize_update_channel("preview")

    # --- install_python_dependencies tests ---

    def test_install_deps_no_requirements(self):
        result = srv.install_python_dependencies(self.ctx)
        self.assertFalse(result["installed"])
        self.assertIn("not found", result["message"])

    def test_install_deps_subprocess_called(self):
        (self.ctx.paths.root / "requirements.txt").write_text("requests\n")
        with mock.patch.object(srv.subprocess, "run") as mock_run:
            mock_run.return_value = self.proc_result(stdout="Successfully installed")
            result = srv.install_python_dependencies(self.ctx)
        self.assertTrue(result["installed"])
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        self.assertIn("pip", args)
        self.assertIn("install", args)

    def test_install_deps_subprocess_fails(self):
        (self.ctx.paths.root / "requirements.txt").write_text("bad_package\n")
        with mock.patch.object(srv.subprocess, "run") as mock_run:
            mock_run.return_value = self.proc_result(
                returncode=1, stderr="ERROR: No matching distribution"
            )
            result = srv.install_python_dependencies(self.ctx)
        self.assertFalse(result["installed"])
        self.assertIn("ERROR", result["error"])

    def test_create_windows_shortcuts_skips_non_windows(self):
        with mock.patch.object(srv.sys, "platform", "linux"):
            result = srv.create_windows_shortcuts(self.ctx)
        self.assertFalse(result["created"])
        self.assertTrue(result["skipped"])

    def test_create_windows_shortcuts_runs_helper_on_windows(self):
        shortcut_script = self.write_shortcut_helper()
        with (
            mock.patch.object(srv.sys, "platform", "win32"),
            mock.patch.object(srv.subprocess, "run") as mock_run,
        ):
            mock_run.return_value = self.proc_result(stdout="Shortcut ready")
            result = srv.create_windows_shortcuts(self.ctx)
        self.assertTrue(result["created"])
        args = mock_run.call_args[0][0]
        self.assertIn("-ShortcutsOnly", args)
        self.assertIn(str(shortcut_script), args)

    def test_create_windows_shortcuts_reports_nonfatal_error(self):
        self.write_shortcut_helper()
        with (
            mock.patch.object(srv.sys, "platform", "win32"),
            mock.patch.object(srv.subprocess, "run") as mock_run,
        ):
            mock_run.return_value = self.proc_result(returncode=1, stderr="desktop denied")
            result = srv.create_windows_shortcuts(self.ctx)
        self.assertFalse(result["created"])
        self.assertIn("desktop denied", result["error"])

    # --- find_latest_release_tag tests ---

    def test_find_latest_release_tag_uses_version_sort_and_release_glob(self):
        with mock.patch.object(srv, "run_git") as mock_run_git:
            mock_run_git.return_value = self.proc_result(stdout="v1.2.3\nv1.2.2\n")
            result = srv.find_latest_release_tag(self.ctx.paths.root, "origin/main")
        self.assertEqual(result, {"tag": "v1.2.3", "error": ""})
        mock_run_git.assert_called_once_with(
            [
                "for-each-ref",
                "--merged=origin/main",
                "--sort=-v:refname",
                "--format=%(refname:short)",
                "refs/tags/v[0-9]*",
            ],
            self.ctx.paths.root,
        )

    def test_find_latest_release_tag_skips_prereleases(self):
        # Version sort puts prerelease tags above the release they precede, so
        # they are the first candidates and must be rejected.
        result = self.find_release_tag_in("v1.6.4-rc1\nv1.6.4-beta\nv1.6.3b\nv1.6.3\n")
        self.assertEqual(result["tag"], "v1.6.3b")

    def test_find_latest_release_tag_ignores_non_release_names(self):
        result = self.find_release_tag_in("Summer-2026\nv1.2.3\n")
        self.assertEqual(result["tag"], "v1.2.3")

    def test_find_latest_release_tag_without_matches(self):
        result = self.find_release_tag_in("v1.6.3-rc1\n")
        self.assertEqual(result, {"tag": "", "error": ""})

    def test_find_latest_release_tag_reports_git_error(self):
        result = self.find_release_tag_in(
            "", returncode=128, stderr="fatal: malformed object name origin/main"
        )
        self.assertEqual(result["tag"], "")
        self.assertIn("malformed object name", result["error"])

    def test_is_release_tag_accepts_releases_and_rejects_prereleases(self):
        for tag in ("v1.6.3", "v1.6.3b", "v1.6.10", "v10.0.0", "v1.6.3z"):
            self.assertTrue(srv.is_release_tag(tag), tag)
        for tag in (
            "v1.6.3-rc1",
            "v1.6.3-beta",
            "v1.7.0-pre",
            "v1.6.3bb",
            "v1.6",
            "Summer-2026",
            "1.6.3",
            "",
            None,
        ):
            self.assertFalse(srv.is_release_tag(tag), tag)

    # --- get_app_update_status tests ---

    def test_get_status_no_git_repo(self):
        status = srv.get_app_update_status(self.ctx)
        self.assertFalse(status["available"])
        self.assertFalse(status["can_update"])
        self.assertEqual(status["repo_url"], self.ctx.config.app_repo_url)

    def test_get_status_git_unavailable(self):
        with self.patched_git(
            overrides={"version": self.proc_result(returncode=1, stderr="git not found")}
        ):
            status = srv.get_app_update_status(self.ctx)
        self.assertFalse(status["available"])
        self.assertFalse(status["can_update"])

    def test_get_status_branch_error(self):
        with self.patched_git(
            overrides={
                "branch": self.proc_result(returncode=128, stderr="not a git repository")
            }
        ):
            status = srv.get_app_update_status(self.ctx)
        self.assertTrue(status["available"])
        self.assertFalse(status["can_update"])
        self.assertEqual(status["state"], "error")
        self.assertIn("not a git repository", status["reason"])

    def test_get_status_uses_release_branch_not_checked_out_branch(self):
        call_log = []
        with self.patched_git(branch="V2", counts="31\t0", call_log=call_log):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["branch"], "V2")
        self.assertEqual(status["release_branch"], "main")
        tag_args = self.git_calls(call_log, "tags")
        self.assertEqual(len(tag_args), 1)
        self.assertIn("--merged=origin/main", tag_args[0])

    def test_get_status_missing_upstream_branch(self):
        call_log = []
        with self.patched_git(upstream_exists=False, call_log=call_log):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "error")
        self.assertFalse(status["can_update"])
        self.assertIn("No upstream branch found at origin/main", status["reason"])
        # The tag lookup must not run: it would fail with raw git jargon.
        self.assertEqual(self.git_calls(call_log, "tags"), [])

    def test_get_status_tag_lookup_failure_reports_error_state(self):
        with self.patched_git(
            overrides={
                "tags": self.proc_result(returncode=128, stderr="fatal: bad revision")
            }
        ):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "error")
        self.assertIn("bad revision", status["reason"])

    def test_get_status_fetch_failure_reports_error_state(self):
        with self.patched_git(
            overrides={
                "fetch": self.proc_result(returncode=128, stderr="fatal: unable to access")
            }
        ):
            status = srv.get_app_update_status(self.ctx, fetch=True)
        self.assertEqual(status["state"], "error")
        self.assertFalse(status["can_update"])
        self.assertIn("unable to access", status["reason"])

    def test_get_status_without_release_tag(self):
        with self.patched_git(tags=""):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "no_release")
        self.assertFalse(status["can_update"])
        self.assertEqual(status["release_tag"], "")
        self.assertIn("No tagged release", status["reason"])

    def test_get_status_up_to_date(self):
        with self.patched_git(counts="0\t0"):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "up_to_date")
        self.assertFalse(status["can_update"])
        self.assertFalse(status["dirty"])

    def test_get_status_behind_no_blocking(self):
        call_log = []
        with self.patched_git(counts="0\t3", call_log=call_log):
            status = srv.get_app_update_status(self.ctx, fetch=True)
        self.assertEqual(status["state"], "behind")
        self.assertTrue(status["can_update"])
        self.assertEqual(status["behind"], 3)
        self.assertEqual(status["release_tag"], "v1.2.3")
        # --prune-tags is what drops a release withdrawn upstream.
        self.assertIn(
            ["fetch", "origin", "--prune", "--prune-tags", "--tags"],
            call_log,
        )

    def test_get_nightly_status_targets_latest_release_branch_commit(self):
        call_log = []
        with self.patched_git(counts="0\t5", call_log=call_log):
            status = srv.get_app_update_status(self.ctx, channel="nightly")
        self.assertEqual(status["update_channel"], "nightly")
        self.assertEqual(status["target_ref"], "origin/main")
        self.assertEqual(status["release_tag"], "")
        self.assertEqual(status["behind"], 5)
        self.assertTrue(status["can_update"])
        self.assertEqual(self.git_calls(call_log, "tags"), [])
        self.assertIn(
            ["rev-list", "--left-right", "--count", "HEAD...origin/main"],
            call_log,
        )

    def test_get_status_with_blocking_changes(self):
        with self.patched_git(dirty=" M server.py\x00", counts="0\t2"):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "behind")
        self.assertTrue(status["has_blocking_changes"])
        self.assertFalse(status["can_update"])
        self.assertIn("server.py", status["blocking_dirty_paths"])

    def test_get_status_commits_after_release_are_up_to_date(self):
        with self.patched_git(counts="2\t0"):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "up_to_date")
        self.assertFalse(status["can_update"])
        self.assertEqual(status["ahead"], 2)
        self.assertEqual(status["release_tag"], "v1.2.3")

    def test_get_status_diverged(self):
        with self.patched_git(counts="1\t1"):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "diverged")
        self.assertFalse(status["can_update"])

    # --- update_app_from_git tests ---

    def test_update_unavailable(self):
        result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("git repository", result["error"])

    def test_update_already_up_to_date(self):
        with self.patched_git(counts="0\t0"):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertEqual(result["message"], "Already up to date")

    def test_update_blocking_changes(self):
        with self.patched_git(dirty=" M server.py\x00", counts="0\t2"):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("Commit or stash first", result["error"])

    def test_update_commits_after_release_is_already_up_to_date(self):
        with self.patched_git(counts="1\t0"):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertEqual(result["message"], "Already up to date")

    def test_update_diverged(self):
        with self.patched_git(counts="1\t1"):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("diverged", result["error"])

    def test_update_release_success(self):
        call_log = []
        with (
            self.patched_git(
                counts="0\t3",
                call_log=call_log,
                merge_stdout="Updating abc..def\nFast-forward",
            ),
            self.patched_pip() as mock_pip,
            self.patched_shortcuts() as mock_shortcuts,
        ):
            (self.ctx.paths.root / "requirements.txt").write_text("requests\n")
            result = srv.update_app_from_git(self.ctx)
        self.assertTrue(result["updated"])
        self.assertTrue(result["dependencies_installed"])
        self.assertTrue(result["shortcuts_created"])
        mock_pip.assert_called_once()
        mock_shortcuts.assert_called_once_with(self.ctx)
        self.assertIn("Fast-forward", result["message"])
        self.assertEqual(result["release_tag"], "v1.2.3")
        self.assertIn(["merge", "--ff-only", "refs/tags/v1.2.3"], call_log)

    def test_update_fast_forwards_release_branch_tag_from_other_branch(self):
        call_log = []
        with (
            self.patched_git(
                branch="V2",
                counts="0\t3",
                call_log=call_log,
                merge_stdout="Fast-forward",
            ),
            self.patched_shortcuts(created=False),
        ):
            result = srv.update_app_from_git(self.ctx)
        self.assertTrue(result["updated"])
        self.assertIn(["merge", "--ff-only", "refs/tags/v1.2.3"], call_log)

    def test_update_nightly_fast_forwards_to_release_branch_head(self):
        call_log = []
        with (
            self.patched_git(counts="0\t3", call_log=call_log),
            self.patched_shortcuts(created=False),
        ):
            result = srv.update_app_from_git(self.ctx, channel="nightly")
        self.assertTrue(result["updated"])
        self.assertEqual(result["update_channel"], "nightly")
        self.assertEqual(result["release_tag"], "")
        self.assertIn(["merge", "--ff-only", "origin/main"], call_log)

    def test_update_release_success_keeps_shortcut_failure_nonfatal(self):
        with (
            self.patched_git(counts="0\t3", merge_stdout="Updating abc..def"),
            self.patched_pip(),
            self.patched_shortcuts(created=False, error="desktop denied"),
        ):
            (self.ctx.paths.root / "requirements.txt").write_text("requests\n")
            result = srv.update_app_from_git(self.ctx)
        self.assertTrue(result["updated"])
        self.assertTrue(result["dependencies_installed"])
        self.assertFalse(result["shortcuts_created"])
        self.assertIn("desktop denied", result["shortcuts_error"])

    def test_update_release_failure(self):
        with self.patched_git(
            counts="0\t3",
            overrides={
                "merge": self.proc_result(
                    returncode=128, stderr="fatal: Not possible to fast-forward"
                )
            },
        ):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("Not possible", result["error"])

    def test_update_deps_failure(self):
        with (
            self.patched_git(counts="0\t3", merge_stdout="Updating abc..def"),
            self.patched_pip(returncode=1, stderr="ERROR: No matching distribution"),
            self.patched_shortcuts() as mock_shortcuts,
        ):
            (self.ctx.paths.root / "requirements.txt").write_text("bad_package\n")
            result = srv.update_app_from_git(self.ctx)
        self.assertTrue(result["updated"])
        self.assertFalse(result["dependencies_installed"])
        self.assertTrue(result["shortcuts_created"])
        mock_shortcuts.assert_called_once_with(self.ctx)
        self.assertIn("ERROR", result["dependency_error"])

    # --- Route tests ---

    def test_app_update_status_route_returns_json(self):
        response = DummyResponse()
        git_update.get_status(
            Request("GET", "/api/app-update-status", "", {}),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 200)
        self.assertFalse(response.payload["available"])
        self.assertEqual(response.payload["repo_url"], self.ctx.config.app_repo_url)

    def test_app_update_status_route_passes_nightly_channel(self):
        with mock.patch.object(
            srv,
            "get_app_update_status",
            return_value={"available": True, "update_channel": "nightly"},
        ) as mock_status:
            response = DummyResponse()
            git_update.get_status(
                Request("GET", "/api/app-update-status", "channel=nightly", {}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        mock_status.assert_called_once_with(self.ctx, fetch=True, channel="nightly")

    def test_app_update_status_route_rejects_unknown_channel(self):
        response = DummyResponse()
        git_update.get_status(
            Request("GET", "/api/app-update-status", "channel=preview", {}),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 400)
        self.assertIn("stable", response.payload["error"])

    def test_app_update_status_route_handles_error(self):
        with mock.patch.object(
            srv,
            "get_app_update_status",
            side_effect=RuntimeError("boom"),
        ):
            response = DummyResponse()
            git_update.get_status(
                Request("GET", "/api/app-update-status", "", {}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 500)
        self.assertEqual(response.payload["error"], "Internal server error")

    def test_app_update_route_returns_error_when_update_fails(self):
        with mock.patch.object(srv, "update_app_from_git", return_value={
            "updated": False,
            "error": "Something went wrong",
            "status": {"available": True},
        }):
            response = DummyResponse()
            git_update.start_update(
                Request("POST", "/api/app-update", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 400)
        self.assertIn("Something went wrong", response.payload["error"])
        self.assertIn("status", response.payload)

    def test_app_update_route_returns_success(self):
        with mock.patch.object(srv, "update_app_from_git", return_value={
            "updated": True,
            "message": "Updated successfully",
        }):
            response = DummyResponse()
            git_update.start_update(
                Request("POST", "/api/app-update", "", {}, body={}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        self.assertTrue(response.payload["updated"])

    def test_app_update_route_passes_nightly_channel(self):
        with mock.patch.object(srv, "update_app_from_git", return_value={
            "updated": True,
            "update_channel": "nightly",
        }) as mock_update:
            response = DummyResponse()
            git_update.start_update(
                Request(
                    "POST",
                    "/api/app-update",
                    "",
                    {},
                    body={"channel": "nightly"},
                ),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 200)
        mock_update.assert_called_once_with(self.ctx, channel="nightly")

    def test_app_update_route_rejects_unknown_channel(self):
        response = DummyResponse()
        git_update.start_update(
            Request(
                "POST",
                "/api/app-update",
                "",
                {},
                body={"channel": "preview"},
            ),
            response,
            self.ctx,
        )
        self.assertEqual(response.status, 400)
        self.assertIn("nightly", response.payload["error"])


class LifecycleTests(unittest.TestCase):
    """Tests for backend/services/lifecycle.py and backend/routes/lifecycle.py."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = make_context(self.tmp.name)
        self.response = DummyResponse()

    def tearDown(self):
        self.tmp.cleanup()

    # --- Service: shutdown_gui_server ---

    def test_shutdown_returns_false_when_no_server(self):
        self.ctx.state.gui_server = None
        result = lifecycle_service.shutdown_gui_server(self.ctx)
        self.assertFalse(result)

    def test_shutdown_stops_tunnel_and_process(self):
        self.ctx.state.gui_server = mock.Mock()
        with mock.patch("backend.services.tunnel.stop_remote_tunnel") as mock_tun, \
             mock.patch("backend.services.process_manager.stop_process") as mock_proc:
            result = lifecycle_service.shutdown_gui_server(self.ctx)
        self.assertTrue(result)
        mock_tun.assert_called_once_with(self.ctx)
        mock_proc.assert_called_once_with(self.ctx)
        self.ctx.state.gui_server.shutdown.assert_called_once()

    def test_cleanup_gui_server_stops_runtime_and_closes_server(self):
        server = mock.Mock()
        self.ctx.state.gui_server = server
        with mock.patch("backend.services.tunnel.stop_remote_tunnel") as mock_tun, \
             mock.patch("backend.services.process_manager.stop_process") as mock_proc:
            result = lifecycle_service.cleanup_gui_server(self.ctx)
        self.assertTrue(result)
        mock_tun.assert_called_once_with(self.ctx)
        mock_proc.assert_called_once_with(self.ctx)
        server.server_close.assert_called_once()
        self.assertIsNone(self.ctx.state.gui_server)

    # --- Service: restart_gui_server ---

    def test_restart_returns_false_when_no_server(self):
        self.ctx.state.gui_server = None
        result = lifecycle_service.restart_gui_server(self.ctx)
        self.assertFalse(result)

    def test_restart_spawns_new_process(self):
        self.ctx.state.gui_server = mock.Mock()

        class SyncThread:
            def __init__(self, **kw):
                self._target = kw.get("target")
                self.daemon = kw.get("daemon", False)

            def start(self):
                if self._target:
                    self._target()

        with mock.patch("backend.services.tunnel.stop_remote_tunnel") as mock_tun, \
             mock.patch("backend.services.process_manager.stop_process") as mock_proc, \
             mock.patch("backend.services.lifecycle._wait_for_port_release", return_value=True), \
             mock.patch("backend.services.lifecycle.subprocess.Popen") as mock_popen, \
             mock.patch("backend.services.lifecycle.os._exit", side_effect=SystemExit(0)), \
             mock.patch("backend.services.lifecycle.threading.Thread", SyncThread):
            with self.assertRaises(SystemExit):
                lifecycle_service.restart_gui_server(self.ctx)

        mock_tun.assert_called_once_with(self.ctx)
        mock_proc.assert_called_once_with(self.ctx)
        mock_popen.assert_called_once()

    def test_restart_detaches_the_replacement_on_every_platform(self):
        """The replacement outlives us by design. On POSIX, without
        start_new_session it stays in our process group and dies with the
        terminal or on the next Ctrl+C, so "restart" silently became "quit"."""

        class SyncThread:
            def __init__(self, **kw):
                self._target = kw.get("target")
                self.daemon = kw.get("daemon", False)

            def start(self):
                if self._target:
                    self._target()

        for platform_name in ("linux", "darwin", "win32"):
            with self.subTest(platform=platform_name):
                self.ctx.state.gui_server = mock.Mock()
                with mock.patch("backend.services.tunnel.stop_remote_tunnel"), \
                     mock.patch("backend.services.process_manager.stop_process"), \
                     mock.patch("backend.services.lifecycle._wait_for_port_release", return_value=True), \
                     mock.patch("backend.services.lifecycle.subprocess.Popen") as mock_popen, \
                     mock.patch("backend.services.lifecycle.sys.platform", platform_name), \
                     mock.patch(
                         "backend.services.lifecycle.subprocess.DETACHED_PROCESS",
                         0x00000008,
                         create=True,
                     ), \
                     mock.patch(
                         "backend.services.lifecycle.subprocess.CREATE_NEW_PROCESS_GROUP",
                         0x00000200,
                         create=True,
                     ), \
                     mock.patch("backend.services.lifecycle.os._exit", side_effect=SystemExit(0)), \
                     mock.patch("backend.services.lifecycle.threading.Thread", SyncThread):
                    with self.assertRaises(SystemExit):
                        lifecycle_service.restart_gui_server(self.ctx)

                kwargs = mock_popen.call_args.kwargs
                if platform_name == "win32":
                    self.assertTrue(
                        kwargs.get("creationflags"), "Windows needs DETACHED_PROCESS"
                    )
                    self.assertNotIn("start_new_session", kwargs)
                else:
                    self.assertTrue(
                        kwargs.get("start_new_session"),
                        f"{platform_name} needs start_new_session to survive terminal close",
                    )

    def test_restart_uses_context_host_and_port(self):
        self.ctx.config = ServerConfig(gui_host="127.0.0.2", gui_port=61234)
        self.ctx.state.gui_server = mock.Mock()

        class SyncThread:
            def __init__(self, **kw):
                self._target = kw.get("target")

            def start(self):
                if self._target:
                    self._target()

        with mock.patch("backend.services.tunnel.stop_remote_tunnel"), \
             mock.patch("backend.services.process_manager.stop_process"), \
             mock.patch("backend.services.lifecycle._wait_for_port_release", return_value=True) as mock_wait, \
             mock.patch("backend.services.lifecycle.subprocess.Popen"), \
             mock.patch("backend.services.lifecycle.os._exit", side_effect=SystemExit(0)), \
             mock.patch("backend.services.lifecycle.threading.Thread", SyncThread):
            with self.assertRaises(SystemExit):
                lifecycle_service.restart_gui_server(self.ctx)

        wait_args = mock_wait.call_args.args
        self.assertEqual(wait_args[:2], ("127.0.0.2", 61234))

    def test_supervised_restart_requests_clean_external_relaunch(self):
        self.ctx.config = ServerConfig(supervised=True)
        self.ctx.state.gui_server = mock.Mock()

        with mock.patch("backend.services.lifecycle.subprocess.Popen") as mock_popen:
            result = lifecycle_service.restart_gui_server(self.ctx)

        self.assertTrue(result)
        self.assertTrue(self.ctx.state.restart_requested.is_set())
        self.ctx.state.gui_server.shutdown.assert_called_once()
        mock_popen.assert_not_called()
        self.assertEqual(lifecycle_service.get_gui_exit_code(self.ctx), 75)

    def test_supervised_normal_shutdown_keeps_success_exit_code(self):
        self.ctx.config = ServerConfig(supervised=True)

        self.assertEqual(lifecycle_service.get_gui_exit_code(self.ctx), 0)

    # --- Service: open_folder_in_file_manager ---

    def test_open_folder_windows(self):
        with mock.patch("backend.services.lifecycle.sys.platform", "win32"), \
             mock.patch("backend.services.lifecycle.os.startfile", create=True) as mock_sf:
            lifecycle_service.open_folder_in_file_manager(self.ctx.paths.root / "test")
        mock_sf.assert_called_once()

    def test_open_folder_darwin(self):
        with mock.patch("backend.services.lifecycle.sys.platform", "darwin"), \
             mock.patch("backend.services.lifecycle.subprocess.run") as mock_run:
            lifecycle_service.open_folder_in_file_manager(self.ctx.paths.root / "test")
        mock_run.assert_called_once_with(
            ["open", str(self.ctx.paths.root / "test")],
            check=False,
            timeout=lifecycle_service.OPEN_FOLDER_TIMEOUT_SECONDS,
            stdin=subprocess.DEVNULL,
        )

    def test_open_folder_linux(self):
        with mock.patch("backend.services.lifecycle.sys.platform", "linux"), \
             mock.patch("backend.services.lifecycle.subprocess.run") as mock_run:
            lifecycle_service.open_folder_in_file_manager(self.ctx.paths.root / "test")
        mock_run.assert_called_once_with(
            ["xdg-open", str(self.ctx.paths.root / "test")],
            check=False,
            timeout=lifecycle_service.OPEN_FOLDER_TIMEOUT_SECONDS,
            stdin=subprocess.DEVNULL,
        )

    def test_open_folder_survives_a_hanging_helper(self):
        """Runs on a request thread: xdg-open can block indefinitely handing off
        to a desktop helper, and that must not wedge the handler."""
        timeout_error = subprocess.TimeoutExpired(cmd=["xdg-open"], timeout=1)
        with mock.patch("backend.services.lifecycle.sys.platform", "linux"), \
             mock.patch("backend.services.lifecycle.subprocess.run", side_effect=timeout_error):
            with contextlib.redirect_stderr(io.StringIO()) as captured:
                lifecycle_service.open_folder_in_file_manager(self.ctx.paths.root / "test")

        self.assertIn("did not exit", captured.getvalue())

    # --- Service: _wait_for_port_release ---

    def test_wait_for_port_release_success(self):
        mock_sock = mock.Mock()
        with mock.patch("backend.services.lifecycle.socket.socket", return_value=mock_sock), \
             mock.patch("backend.services.lifecycle.time.sleep"):
            result = lifecycle_service._wait_for_port_release("127.0.0.1", 9999, 0, 3, 0)
        self.assertTrue(result)
        mock_sock.bind.assert_called_once_with(("127.0.0.1", 9999))
        mock_sock.close.assert_called_once()

    def test_wait_for_port_release_supports_ipv6_hosts(self):
        """Hardcoding AF_INET made every bind fail for an IPv6 GUI host, so the
        wait was skipped and the restart raced the old process for the port."""
        bound = []

        class FakeSocket:
            def __init__(self, family, socktype, proto):
                self.family = family

            def bind(self, sockaddr):
                bound.append((self.family, sockaddr))

            def close(self):
                pass

        with mock.patch("backend.services.lifecycle.socket.socket", FakeSocket), \
             mock.patch("backend.services.lifecycle.time.sleep"):
            result = lifecycle_service._wait_for_port_release("::1", 9999, 0, 3, 0)

        self.assertTrue(result)
        self.assertTrue(bound, "no bind was attempted for an IPv6 host")
        self.assertEqual(bound[0][0], socket.AF_INET6)

    def test_wait_for_port_release_failure(self):
        mock_sock = mock.Mock()
        mock_sock.bind.side_effect = OSError("port in use")
        with mock.patch("backend.services.lifecycle.socket.socket", return_value=mock_sock), \
             mock.patch("backend.services.lifecycle.time.sleep"):
            result = lifecycle_service._wait_for_port_release("127.0.0.1", 9999, 0, 3, 0)
        self.assertFalse(result)
        self.assertEqual(mock_sock.close.call_count, 3)

    # --- Routes ---

    def test_post_shutdown_route(self):
        with mock.patch.object(lifecycle_service, "shutdown_gui_server", return_value=True):
            lifecycle.post_shutdown(
                Request("POST", "/api/shutdown", "", {}, body={}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"shutting_down": True})

    def test_post_shutdown_route_no_server(self):
        with mock.patch.object(lifecycle_service, "shutdown_gui_server", return_value=False):
            lifecycle.post_shutdown(
                Request("POST", "/api/shutdown", "", {}, body={}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"shutting_down": False})

    def test_post_restart_route(self):
        with mock.patch.object(lifecycle_service, "restart_gui_server", return_value=True):
            lifecycle.post_restart(
                Request("POST", "/api/restart", "", {}, body={}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"restarting": True})

    def test_post_restart_route_no_server(self):
        with mock.patch.object(lifecycle_service, "restart_gui_server", return_value=False):
            lifecycle.post_restart(
                Request("POST", "/api/restart", "", {}, body={}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"restarting": False})

    def test_post_open_folder_route_default(self):
        with mock.patch.object(lifecycle_service, "open_folder_in_file_manager") as mock_of:
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"opened": True})
        mock_of.assert_called_once_with(self.ctx.paths.models)

    def test_post_open_folder_route_llama(self):
        self.assertFalse(self.ctx.paths.llama.exists())
        with mock.patch.object(lifecycle_service, "open_folder_in_file_manager") as mock_of:
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": "llama"}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"opened": True})
        self.assertTrue(self.ctx.paths.llama.is_dir())
        mock_of.assert_called_once_with(self.ctx.paths.llama)

    def test_post_open_folder_route_uses_custom_models_root(self):
        custom = Path(self.tmp.name) / "custom-library"
        custom.mkdir()
        model_dir_service.set_models_dir(self.ctx, str(custom))
        with mock.patch.object(lifecycle_service, "open_folder_in_file_manager") as mock_of:
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": "models"}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"opened": True})
        mock_of.assert_called_once_with(custom.resolve())

    def test_post_open_folder_route_invalid_falls_back(self):
        with mock.patch.object(lifecycle_service, "open_folder_in_file_manager") as mock_of:
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": "nonexistent"}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"opened": True})
        mock_of.assert_called_once_with(self.ctx.paths.models)

    def test_post_open_folder_route_rejects_non_string_folder(self):
        with mock.patch.object(lifecycle_service, "open_folder_in_file_manager") as mock_of:
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": ["models"]}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.status, 400)
        self.assertEqual(self.response.payload["error"], "Invalid folder name.")
        mock_of.assert_not_called()


class SearxngSearchTests(unittest.TestCase):
    def _fake_opener(self, payload_bytes):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = payload_bytes
        opener = mock.MagicMock()
        opener.open.return_value = response
        return opener

    def test_searxng_search_parses_results(self):
        payload = json.dumps(
            {"results": [{"url": "https://a.com", "title": "A", "content": "snippet A"}]}
        ).encode()
        opener = self._fake_opener(payload)
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
            result = web_search.searxng_search("hello", max_results=5)
        self.assertTrue(result["ok"])
        self.assertEqual(result["results"], [{"title": "A", "url": "https://a.com", "snippet": "snippet A"}])

    def test_searxng_search_respects_max_results(self):
        rows = [{"url": f"https://a{i}.com", "title": f"t{i}", "content": "c"} for i in range(10)]
        opener = self._fake_opener(json.dumps({"results": rows}).encode())
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
            result = web_search.searxng_search("q", max_results=3)
        self.assertEqual(len(result["results"]), 3)

    def test_searxng_search_errors_when_not_configured(self):
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", ""):
            result = web_search.searxng_search("q")
        self.assertFalse(result["ok"])
        self.assertIn("not configured", result["error"])

    def test_searxng_search_handles_network_failure(self):
        opener = mock.MagicMock()
        opener.open.side_effect = OSError("boom")
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
            result = web_search.searxng_search("q")
        self.assertFalse(result["ok"])
        self.assertIn("SearXNG search failed", result["error"])

    def test_searxng_search_rejects_malformed_url(self):
        for bad in ("not-a-url", "ftp://example.com", "http://", "://nohost"):
            with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", bad), \
                    mock.patch.object(web_search.urllib.request, "build_opener") as build:
                result = web_search.searxng_search("q")
            self.assertFalse(result["ok"], bad)
            build.assert_not_called()  # never attempts a request for a bad URL

    def test_searxng_search_handles_non_object_json(self):
        for payload in (b"[]", b"null", b'"a string"', b"123"):
            opener = self._fake_opener(payload)
            with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                    mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
                result = web_search.searxng_search("q")
            self.assertFalse(result["ok"], payload)
            self.assertEqual(result["results"], [])

    def test_searxng_search_requires_results_list(self):
        opener = self._fake_opener(json.dumps({"results": {"not": "a list"}}).encode())
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
            result = web_search.searxng_search("q")
        self.assertFalse(result["ok"])

    def test_searxng_search_skips_malformed_rows(self):
        rows = [
            "not a dict",
            None,
            {"title": "no url"},
            {"url": "https://good.com", "title": "Good", "content": "c"},
        ]
        opener = self._fake_opener(json.dumps({"results": rows}).encode())
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
            result = web_search.searxng_search("q")
        self.assertTrue(result["ok"])
        self.assertEqual(result["results"], [{"title": "Good", "url": "https://good.com", "snippet": "c"}])

    def test_searxng_search_falls_back_on_invalid_bracketed_url(self):
        # urlparse("http://[bad") raises ValueError; it must be caught so the
        # caller falls back to ddgs rather than propagating the error.
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://[bad"), \
                mock.patch.object(web_search.urllib.request, "build_opener") as build:
            result = web_search.searxng_search("q")
        self.assertFalse(result["ok"])
        self.assertEqual(result["results"], [])
        build.assert_not_called()  # never reaches the request when the URL is invalid

    def test_searxng_search_rejects_wrong_typed_result_fields(self):
        rows = [
            {"url": 123, "title": "int url"},              # non-string url -> skipped
            {"url": "ftp://x.com", "title": "bad scheme"},  # non-http(s) -> skipped
            {"url": "http://", "title": "no host"},        # no hostname -> skipped
            {"url": "https://ok.com", "title": 999, "content": ["not", "text"]},  # bad title/snippet types
        ]
        opener = self._fake_opener(json.dumps({"results": rows}).encode())
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
            result = web_search.searxng_search("q")
        self.assertTrue(result["ok"])
        # Only the well-typed URL survives; its non-string title falls back to the
        # url and its non-string snippet becomes empty.
        self.assertEqual(
            result["results"],
            [{"title": "https://ok.com", "url": "https://ok.com", "snippet": ""}],
        )

    def test_searxng_search_rejects_invalid_port_result_urls(self):
        rows = [
            {"url": "http://example.com:bad", "title": "non-numeric port"},
            {"url": "http://example.com:99999", "title": "out-of-range port"},
            {"url": "https://ok.com:8443", "title": "Valid", "content": "c"},
        ]
        opener = self._fake_opener(json.dumps({"results": rows}).encode())
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener):
            result = web_search.searxng_search("q")
        self.assertTrue(result["ok"])
        # Only the valid-port URL survives; the bad-port rows are skipped.
        self.assertEqual(
            result["results"],
            [{"title": "Valid", "url": "https://ok.com:8443", "snippet": "c"}],
        )

    def test_searxng_search_falls_back_on_invalid_port_endpoint(self):
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:bad"), \
                mock.patch.object(web_search.urllib.request, "build_opener") as build:
            result = web_search.searxng_search("q")
        self.assertFalse(result["ok"])
        self.assertEqual(result["results"], [])
        build.assert_not_called()

    def test_web_search_falls_back_to_ddgs_on_invalid_bracketed_url(self):
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://[bad"), \
                mock.patch.object(web_search, "ddgs_search", return_value={"ok": True, "results": [{"url": "d"}]}) as dd:
            result = web_search.web_search("q")
        dd.assert_called_once()
        self.assertEqual(result["results"], [{"url": "d"}])

    def test_searxng_search_omits_safesearch_override(self):
        captured = {}

        def fake_build_opener(*args, **kwargs):
            opener = mock.MagicMock()

            def fake_open(request, timeout):
                captured["url"] = request.full_url
                response = mock.MagicMock()
                response.__enter__.return_value = response
                response.read.return_value = json.dumps({"results": []}).encode()
                return response

            opener.open.side_effect = fake_open
            return opener

        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", side_effect=fake_build_opener):
            web_search.searxng_search("q")
        self.assertIn("format=json", captured["url"])
        self.assertNotIn("safesearch", captured["url"])

    def test_web_search_falls_back_to_ddgs_on_malformed_searxng_response(self):
        opener = self._fake_opener(b"[]")  # non-object JSON would previously raise
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener), \
                mock.patch.object(web_search, "ddgs_search", return_value={"ok": True, "results": [{"url": "d"}]}) as dd:
            result = web_search.web_search("q")
        dd.assert_called_once()
        self.assertEqual(result["results"], [{"url": "d"}])

    def test_web_search_prefers_searxng_when_configured(self):
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search, "searxng_search", return_value={"ok": True, "results": [{"url": "x"}]}) as sx, \
                mock.patch.object(web_search, "ddgs_search") as dd:
            result = web_search.web_search("q")
        sx.assert_called_once()
        dd.assert_not_called()
        self.assertEqual(result["results"], [{"url": "x"}])

    def test_web_search_falls_back_to_ddgs_when_searxng_empty(self):
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search, "searxng_search", return_value={"ok": True, "results": []}) as sx, \
                mock.patch.object(web_search, "ddgs_search", return_value={"ok": True, "results": [{"url": "d"}]}) as dd:
            result = web_search.web_search("q")
        sx.assert_called_once()
        dd.assert_called_once()
        self.assertEqual(result["results"], [{"url": "d"}])

    def test_web_search_falls_back_to_ddgs_when_searxng_fails(self):
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", "http://127.0.0.1:8888"), \
                mock.patch.object(web_search, "searxng_search", return_value={"ok": False, "error": "down", "results": []}), \
                mock.patch.object(web_search, "ddgs_search", return_value={"ok": True, "results": [{"url": "d"}]}) as dd:
            result = web_search.web_search("q")
        dd.assert_called_once()
        self.assertEqual(result["results"], [{"url": "d"}])

    def test_web_search_skips_searxng_when_unset(self):
        with mock.patch.object(web_search.config, "WEB_SEARCH_SEARXNG_URL", ""), \
                mock.patch.object(web_search, "searxng_search") as sx, \
                mock.patch.object(web_search, "ddgs_search", return_value={"ok": True, "results": [{"url": "d"}]}) as dd:
            result = web_search.web_search("q")
        sx.assert_not_called()
        dd.assert_called_once()
        self.assertEqual(result["results"], [{"url": "d"}])


if __name__ == "__main__":
    unittest.main()
