import io
import json
import tempfile
import unittest
import urllib.error
from unittest import mock
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

from backend.context import AppContext, AppPaths, BackendServices, ServerConfig
from backend.http import Request
from backend.routes import chat, file_picker, git_update, hf_download, install, lifecycle, metrics, models, presets, process, search, status, tunnel
from backend.services import chat as chat_service
from backend.services import lifecycle as lifecycle_service
from backend.services import llama_manager
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


def make_context(root):
    root = Path(root)
    return AppContext(
        paths=AppPaths(
            root=root,
            llama=root / "llama",
            llama_bin=root / "llama" / "bin",
            llama_grammars=root / "llama" / "grammars",
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


class ExtractedRouteTests(unittest.TestCase):
    def test_models_route_lists_only_gguf_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.models.mkdir(parents=True)
            (ctx.paths.models / "model.gguf").write_bytes(b"x" * 1024)
            (ctx.paths.models / "notes.txt").write_text("ignore")
            response = DummyResponse()

            models.list_models(Request("GET", "/api/models", "", {}), response, ctx)

            self.assertEqual(response.payload, [{"name": "model.gguf", "size_mb": 0.0}])

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
            self.assertEqual(list_response.payload, [{"name": "My_Preset", "data": {"temperature": 0.7}}])

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

            self.assertEqual(
                response.payload,
                [{"name": "single", "data": {"model": "model.gguf", "flags": {"ctx_size": 4096}}}],
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

            def get_local_llama_metrics(host, port):
                calls.append((host, port))
                return "llama metrics", ""

            ctx.services.get_local_llama_metrics = get_local_llama_metrics
            response = DummyResponse()

            metrics.get_metrics(
                Request("GET", "/api/llama/metrics", "host=localhost&port=9090", {}),
                response,
                ctx,
            )

            self.assertEqual(calls, [("localhost", "9090")])
            self.assertEqual(response.text_payload, "llama metrics")

    def test_slots_route_uses_context_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            calls = []

            def get_local_llama_slots(host, port):
                calls.append((host, port))
                return '[{"id":0,"n_ctx":4096}]', ""

            ctx.services.get_local_llama_slots = get_local_llama_slots
            response = DummyResponse()

            metrics.get_slots(
                Request("GET", "/api/llama/slots", "host=localhost&port=9090", {}),
                response,
                ctx,
            )

            self.assertEqual(calls, [("localhost", "9090")])
            self.assertEqual(response.text_payload, '[{"id":0,"n_ctx":4096}]')

    def test_slots_route_returns_proxy_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)

            def get_local_llama_slots(host, port):
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

    def test_status_route_uses_context_services(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            cli_path = ctx.paths.llama_bin / "llama-cli.exe"
            cli_path.parent.mkdir(parents=True)
            cli_path.write_text("")
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
                llama_tools=["llama-cli"],
                load_config=lambda: {"tag": "b1", "backend": "cpu"},
            )
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertTrue(response.payload["installed"])
            self.assertEqual(response.payload["models_dir"], str(ctx.paths.models))
            self.assertEqual(response.payload["available_backends"], [{"id": "cpu", "label": "CPU"}])

    def test_status_route_marks_install_stale_when_runtime_library_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            cli_path = ctx.paths.llama_bin / "llama-cli"
            cli_path.parent.mkdir(parents=True)
            cli_path.write_text("")
            ctx.services = BackendServices(
                backend_specs={"metal": {"label": "Metal"}},
                current_arch="arm64",
                current_platform="darwin",
                find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
                get_platform_label=lambda: "macOS",
                get_runtime_files=lambda: [],
                get_tool_filename=lambda tool: tool,
                is_process_running=lambda: False,
                llama_tools=["llama-cli"],
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

    def test_status_route_returns_error_when_service_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services.load_config = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertEqual(response.status, 500)
            self.assertEqual(response.payload["error"], "Internal server error")

    def test_process_output_route_reads_buffer_and_running_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.state.output_buffer.extend(["one", "two"])
            response = DummyResponse()

            process.get_output(Request("GET", "/api/output", "", {}), response, ctx)

            self.assertEqual(response.payload, {"output": ["one", "two"], "running": False})

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

    def test_process_cleanup_removes_llama_files_and_resets_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-cli.exe").write_text("binary")
            saved = []
            ctx.services.save_config = saved.append
            response = DummyResponse()

            process.cleanup_llama(Request("POST", "/api/cleanup-llama", "", {}, body={}), response, ctx)

            self.assertEqual(response.payload, {"removed_files": 1})
            self.assertTrue(ctx.paths.llama_bin.exists())
            self.assertTrue(ctx.paths.llama_grammars.exists())
            self.assertEqual(saved, [{"version": None, "backend": None, "tag": None}])

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

    def test_process_manager_launch_reports_missing_runtime_before_popen(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")
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

    def test_process_launch_route_returns_missing_runtime_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")
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

            hf_download.list_repo_files(
                Request("POST", "/api/hf/repo-files", "", {}, body={"repo_id": "owner/model."}),
                response,
                ctx,
            )

            self.assertEqual(response.status, 400)
            self.assertEqual(response.payload["error"], "Invalid Hugging Face repo ID.")

    def test_hf_download_route_reports_duplicate_with_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.paths.models.mkdir(parents=True)
            (ctx.paths.models / "model.gguf").write_bytes(b"existing")
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

    def test_hf_download_cancel_sets_cancelling_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            response = DummyResponse()

            hf_download.cancel_download(
                Request("POST", "/api/hf/download-cancel", "", {}, body={}),
                response,
                ctx,
            )

            self.assertTrue(ctx.state.model_download_cancel.is_set())
            self.assertEqual(response.payload["status"], "cancelling")
            self.assertEqual(response.payload["message"], "Cancelling download...")

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

    def test_fetch_page_text_revalidates_redirect_targets(self):
        headers = Message()
        headers["Location"] = "http://127.0.0.1/private"
        redirect = urllib.error.HTTPError("https://example.com", 302, "Found", headers, None)
        opener = SimpleNamespace(open=mock.Mock(side_effect=redirect))

        with mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener), mock.patch.object(
            web_search,
            "validate_public_hostname",
            side_effect=[(True, ""), (False, "Blocked: refusing to fetch non-public address 127.0.0.1.")],
        ):
            result = web_search.fetch_page_text("https://example.com")

        self.assertFalse(result["ok"])
        self.assertIn("non-public address 127.0.0.1", result["error"])

    def test_fetch_page_text_limits_redirect_chains(self):
        headers = Message()
        headers["Location"] = "/next"
        redirect = urllib.error.HTTPError("https://example.com", 302, "Found", headers, None)
        opener = SimpleNamespace(open=mock.Mock(side_effect=redirect))

        with mock.patch.object(web_search.urllib.request, "build_opener", return_value=opener), mock.patch.object(
            web_search,
            "validate_public_hostname",
            return_value=(True, ""),
        ):
            result = web_search.fetch_page_text("https://example.com")

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Failed to fetch URL: too many redirects.")
        self.assertEqual(opener.open.call_count, 5)

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
            response = DummySseResponse()

            chat.completions(
                Request("POST", "/api/chat/completions", "", {}, body={"messages": [], "port": 70000}),
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

            with mock.patch.object(
                chat.chat_service,
                "get_local_chat_api_url",
                return_value="http://127.0.0.1:8080/v1/chat/completions",
            ), mock.patch.object(chat.urllib.request, "urlopen", return_value=upstream):
                chat.completions(
                    Request(
                        "POST",
                        "/api/chat/completions",
                        "",
                        {},
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

    def test_chat_route_injects_web_search_context_into_system_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
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
                                {"role": "user", "content": "What changed?"},
                            ],
                        },
                    ),
                    response,
                    ctx,
                )

            system_message = captured["body"]["messages"][0]
            self.assertEqual(system_message["role"], "system")
            self.assertIn("Original system.", system_message["content"])
            self.assertIn("Fresh page text", system_message["content"])
            self.assertNotIn("web_search", captured["body"])
            self.assertNotIn("web_search_max_results", captured["body"])

    def test_chat_route_uses_configured_web_search_result_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
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
            self.assertEqual(kwargs["filetypes"][0], ("Model files", "*.gguf *.bin"))
            self.assertEqual(response.payload, {"selected": True, "path": str(ctx.paths.models / "model.gguf")})


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


class GitUpdateRouteTests(unittest.TestCase):
    """Tests for backend/services/git_update.py and backend/routes/git_update.py."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = make_context(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    # --- Pure function tests ---

    def test_normalize_git_path_normalizes_backslashes(self):
        from backend.services import git_update as srv
        self.assertEqual(srv.normalize_git_path("foo\\bar"), "foo/bar")
        self.assertEqual(srv.normalize_git_path("  foo/bar  "), "foo/bar")
        self.assertEqual(srv.normalize_git_path(""), "")
        self.assertEqual(srv.normalize_git_path(None), "")

    def test_parse_git_status_porcelain_z_basic(self):
        from backend.services import git_update as srv
        output = "M  src/main.py\x00 M modified.txt\x00"
        entries = srv.parse_git_status_porcelain_z(output)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0], {"status": "M ", "path": "src/main.py"})
        self.assertEqual(entries[1], {"status": " M", "path": "modified.txt"})

    def test_parse_git_status_porcelain_z_rename_detection(self):
        from backend.services import git_update as srv
        output = "R  new.py\x00old.py\x00"
        entries = srv.parse_git_status_porcelain_z(output)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["status"], "R ")
        self.assertEqual(entries[0]["path"], "new.py")
        self.assertEqual(entries[0]["source_path"], "old.py")

    def test_is_safe_dirty_path_known_prefixes(self):
        from backend.services import git_update as srv
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
        from backend.services import git_update as srv
        self.assertTrue(srv.is_safe_dirty_path("config.json"))
        self.assertTrue(srv.is_safe_dirty_path(".env"))
        self.assertTrue(srv.is_safe_dirty_path(".env.local"))

    def test_is_safe_dirty_path_known_suffixes(self):
        from backend.services import git_update as srv
        for ext in [".pyc", ".log", ".zip", ".tar.gz", ".tgz", ".bak", ".swp"]:
            self.assertTrue(srv.is_safe_dirty_path(f"file{ext}"), f"Expected safe: file{ext}")

    def test_is_safe_dirty_path_blocking(self):
        from backend.services import git_update as srv
        blocking = [
            "src/lib/helper.py",
            "server.py",
            "ui/js/app.js",
            "README.md",
            ".github/workflows/ci.yml",
        ]
        for path in blocking:
            self.assertFalse(srv.is_safe_dirty_path(path), f"Expected blocking: {path}")

    def test_classify_git_dirty_paths(self):
        from backend.services import git_update as srv
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
        from backend.services import git_update as srv
        entries = [
            {"status": "R ", "path": "models/server.py", "source_path": "server.py"},
            {"status": "R ", "path": "models/new.gguf", "source_path": "models/old.gguf"},
        ]
        result = srv.classify_git_dirty_paths(entries)
        self.assertEqual(result["safe_dirty_paths"], ["models/new.gguf"])
        self.assertEqual(result["blocking_dirty_paths"], ["models/server.py"])

    # --- install_python_dependencies tests ---

    def test_install_deps_no_requirements(self):
        from backend.services import git_update as srv
        result = srv.install_python_dependencies(self.ctx)
        self.assertFalse(result["installed"])
        self.assertIn("not found", result["message"])

    def test_install_deps_subprocess_called(self):
        from backend.services import git_update as srv
        (self.ctx.paths.root / "requirements.txt").write_text("requests\n")
        with mock.patch.object(srv.subprocess, "run") as mock_run:
            mock_run.return_value = type("R", (), {
                "returncode": 0, "stdout": "Successfully installed", "stderr": ""
            })()
            result = srv.install_python_dependencies(self.ctx)
        self.assertTrue(result["installed"])
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        self.assertIn("pip", args)
        self.assertIn("install", args)

    def test_install_deps_subprocess_fails(self):
        from backend.services import git_update as srv
        (self.ctx.paths.root / "requirements.txt").write_text("bad_package\n")
        with mock.patch.object(srv.subprocess, "run") as mock_run:
            mock_run.return_value = type("R", (), {
                "returncode": 1, "stdout": "", "stderr": "ERROR: No matching distribution"
            })()
            result = srv.install_python_dependencies(self.ctx)
        self.assertFalse(result["installed"])
        self.assertIn("ERROR", result["error"])

    def test_create_windows_shortcuts_skips_non_windows(self):
        from backend.services import git_update as srv
        with mock.patch.object(srv.sys, "platform", "linux"):
            result = srv.create_windows_shortcuts(self.ctx)
        self.assertFalse(result["created"])
        self.assertTrue(result["skipped"])

    def test_create_windows_shortcuts_runs_helper_on_windows(self):
        from backend.services import git_update as srv
        shortcut_script = self.ctx.paths.root / "scripts" / "create_windows_shortcuts.ps1"
        shortcut_script.parent.mkdir()
        shortcut_script.write_text("# helper\n")
        with mock.patch.object(srv.sys, "platform", "win32"), mock.patch.object(srv.subprocess, "run") as mock_run:
            mock_run.return_value = type("R", (), {
                "returncode": 0, "stdout": "Shortcut ready", "stderr": ""
            })()
            result = srv.create_windows_shortcuts(self.ctx)
        self.assertTrue(result["created"])
        args = mock_run.call_args[0][0]
        self.assertIn("-ShortcutsOnly", args)
        self.assertIn(str(shortcut_script), args)

    def test_create_windows_shortcuts_reports_nonfatal_error(self):
        from backend.services import git_update as srv
        shortcut_script = self.ctx.paths.root / "scripts" / "create_windows_shortcuts.ps1"
        shortcut_script.parent.mkdir()
        shortcut_script.write_text("# helper\n")
        with mock.patch.object(srv.sys, "platform", "win32"), mock.patch.object(srv.subprocess, "run") as mock_run:
            mock_run.return_value = type("R", (), {
                "returncode": 1, "stdout": "", "stderr": "desktop denied"
            })()
            result = srv.create_windows_shortcuts(self.ctx)
        self.assertFalse(result["created"])
        self.assertIn("desktop denied", result["error"])

    # --- get_app_update_status tests ---

    def test_get_status_no_git_repo(self):
        from backend.services import git_update as srv
        status = srv.get_app_update_status(self.ctx)
        self.assertFalse(status["available"])
        self.assertFalse(status["can_update"])
        self.assertEqual(status["repo_url"], self.ctx.config.app_repo_url)

    def test_get_status_git_unavailable(self):
        from backend.services import git_update as srv
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git") as mock_run_git:
            mock_run_git.return_value = type("R", (), {
                "returncode": 1, "stdout": "", "stderr": "git not found"
            })()
            status = srv.get_app_update_status(self.ctx)
        self.assertFalse(status["available"])
        self.assertFalse(status["can_update"])

    def test_get_status_branch_error(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 128, "stdout": "", "stderr": "not a git repository"})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            status = srv.get_app_update_status(self.ctx)
        self.assertTrue(status["available"])
        self.assertFalse(status["can_update"])
        self.assertIn("not a git repository", status["reason"])

    def test_get_status_up_to_date(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t0", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            status = srv.get_app_update_status(self.ctx)
        self.assertTrue(status["available"])
        self.assertEqual(status["state"], "up_to_date")
        self.assertFalse(status["can_update"])

    def test_get_status_behind_no_blocking(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t3", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            status = srv.get_app_update_status(self.ctx, fetch=True)
        self.assertEqual(status["state"], "behind")
        self.assertTrue(status["can_update"])
        self.assertEqual(status["behind"], 3)

    def test_get_status_with_blocking_changes(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": " M server.py\x00", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t3", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            status = srv.get_app_update_status(self.ctx, fetch=True)
        self.assertEqual(status["state"], "behind")
        self.assertFalse(status["can_update"])
        self.assertIn("server.py", status["blocking_dirty_paths"])

    def test_get_status_ahead(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "2\t0", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "ahead")
        self.assertFalse(status["can_update"])
        self.assertEqual(status["ahead"], 2)

    def test_get_status_diverged(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "1\t1", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            status = srv.get_app_update_status(self.ctx)
        self.assertEqual(status["state"], "diverged")
        self.assertFalse(status["can_update"])

    # --- update_app_from_git tests ---

    def test_update_unavailable(self):
        from backend.services import git_update as srv
        result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("git repository", result["error"])

    def test_update_already_up_to_date(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t0", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertEqual(result["message"], "Already up to date")

    def test_update_blocking_changes(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": " M server.py\x00", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t2", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("Commit or stash first", result["error"])

    def test_update_ahead(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "1\t0", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("ahead", result["error"])

    def test_update_diverged(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "1\t1", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("diverged", result["error"])

    def test_update_pull_success(self):
        from backend.services import git_update as srv
        call_log = []
        def mock_run(args, cwd):
            call_log.append(args)
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["fetch", "origin"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t3", "stderr": ""})()
            if args[:2] == ["pull", "--ff-only"]:
                return type("R", (), {"returncode": 0, "stdout": "Updating abc..def\nFast-forward", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        (self.ctx.paths.root / "requirements.txt").write_text("requests\n")
        with (
            mock.patch.object(srv, "run_git", mock_run),
            mock.patch.object(srv.subprocess, "run") as mock_pip,
            mock.patch.object(srv, "create_windows_shortcuts", return_value={"created": True, "message": "Shortcut ready"}) as mock_shortcuts,
        ):
            mock_pip.return_value = type("R", (), {
                "returncode": 0, "stdout": "Successfully installed", "stderr": ""
            })()
            result = srv.update_app_from_git(self.ctx)
        self.assertTrue(result["updated"])
        self.assertTrue(result["dependencies_installed"])
        self.assertTrue(result["shortcuts_created"])
        mock_shortcuts.assert_called_once_with(self.ctx)
        self.assertIn("Fast-forward", result["message"])

    def test_update_pull_success_keeps_shortcut_failure_nonfatal(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["fetch", "origin"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t3", "stderr": ""})()
            if args[:2] == ["pull", "--ff-only"]:
                return type("R", (), {"returncode": 0, "stdout": "Updating abc..def", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        (self.ctx.paths.root / "requirements.txt").write_text("requests\n")
        with (
            mock.patch.object(srv, "run_git", mock_run),
            mock.patch.object(srv.subprocess, "run") as mock_pip,
            mock.patch.object(srv, "create_windows_shortcuts", return_value={"created": False, "error": "desktop denied"}),
        ):
            mock_pip.return_value = type("R", (), {
                "returncode": 0, "stdout": "Successfully installed", "stderr": ""
            })()
            result = srv.update_app_from_git(self.ctx)
        self.assertTrue(result["updated"])
        self.assertTrue(result["dependencies_installed"])
        self.assertFalse(result["shortcuts_created"])
        self.assertIn("desktop denied", result["shortcuts_error"])

    def test_update_pull_failure(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["fetch", "origin"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t3", "stderr": ""})()
            if args[:2] == ["pull", "--ff-only"]:
                return type("R", (), {"returncode": 128, "stdout": "", "stderr": "fatal: Not possible to fast-forward"})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        with mock.patch.object(srv, "run_git", mock_run):
            result = srv.update_app_from_git(self.ctx)
        self.assertFalse(result["updated"])
        self.assertIn("Not possible", result["error"])

    def test_update_deps_failure(self):
        from backend.services import git_update as srv
        def mock_run(args, cwd):
            if args == ["--version"]:
                return type("R", (), {"returncode": 0, "stdout": "git 2.40", "stderr": ""})()
            if args == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return type("R", (), {"returncode": 0, "stdout": "main", "stderr": ""})()
            if args == ["config", "--get", "remote.origin.url"]:
                return type("R", (), {"returncode": 0, "stdout": "https://github.com/user/repo.git", "stderr": ""})()
            if args == ["status", "--porcelain=v1", "-z"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["fetch", "origin"]:
                return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            if args[:2] == ["rev-list", "--left-right"]:
                return type("R", (), {"returncode": 0, "stdout": "0\t3", "stderr": ""})()
            if args[:2] == ["pull", "--ff-only"]:
                return type("R", (), {"returncode": 0, "stdout": "Updating abc..def", "stderr": ""})()
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        (self.ctx.paths.root / ".git").mkdir()
        (self.ctx.paths.root / "requirements.txt").write_text("bad_package\n")
        with (
            mock.patch.object(srv, "run_git", mock_run),
            mock.patch.object(srv.subprocess, "run") as mock_pip,
            mock.patch.object(srv, "create_windows_shortcuts", return_value={"created": True, "message": "Shortcut ready"}) as mock_shortcuts,
        ):
            mock_pip.return_value = type("R", (), {
                "returncode": 1, "stdout": "", "stderr": "ERROR: No matching distribution"
            })()
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

    def test_app_update_status_route_handles_error(self):
        from backend.services import git_update as srv
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
        from backend.services import git_update as srv
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
        from backend.services import git_update as srv
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
        mock_run.assert_called_once_with(["open", str(self.ctx.paths.root / "test")], check=False)

    def test_open_folder_linux(self):
        with mock.patch("backend.services.lifecycle.sys.platform", "linux"), \
             mock.patch("backend.services.lifecycle.subprocess.run") as mock_run:
            lifecycle_service.open_folder_in_file_manager(self.ctx.paths.root / "test")
        mock_run.assert_called_once_with(["xdg-open", str(self.ctx.paths.root / "test")], check=False)

    # --- Service: _wait_for_port_release ---

    def test_wait_for_port_release_success(self):
        mock_sock = mock.Mock()
        with mock.patch("backend.services.lifecycle.socket.socket", return_value=mock_sock), \
             mock.patch("backend.services.lifecycle.time.sleep"):
            result = lifecycle_service._wait_for_port_release("127.0.0.1", 9999, 0, 3, 0)
        self.assertTrue(result)
        mock_sock.bind.assert_called_once_with(("127.0.0.1", 9999))
        mock_sock.close.assert_called_once()

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
        with mock.patch.object(lifecycle_service, "open_folder_in_file_manager") as mock_of:
            target = self.ctx.paths.llama / "subdir"
            self.ctx.paths.llama.mkdir(parents=True, exist_ok=True)
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": "llama"}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"opened": True})
        mock_of.assert_called_once_with(self.ctx.paths.llama)

    def test_post_open_folder_route_invalid_falls_back(self):
        with mock.patch.object(lifecycle_service, "open_folder_in_file_manager") as mock_of:
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": "nonexistent"}),
                self.response,
                self.ctx,
            )
        self.assertEqual(self.response.payload, {"opened": True})
        mock_of.assert_called_once_with(self.ctx.paths.models)


if __name__ == "__main__":
    unittest.main()
