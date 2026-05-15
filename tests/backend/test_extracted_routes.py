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
from backend.routes import chat, file_picker, hf_download, install, metrics, models, presets, process, search, status
from backend.services import chat as chat_service
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

            self.assertEqual(response.payload, {"saved": True, "name": "__Odd Name"})

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
            self.assertFalse((ctx.paths.presets / "__Odd Name.json").exists())

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

    def test_status_route_returns_error_when_service_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_context(tmp)
            ctx.services.load_config = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
            response = DummyResponse()

            status.get_status(Request("GET", "/api/status", "", {}), response, ctx)

            self.assertEqual(response.status, 500)
            self.assertEqual(response.payload["error"], "Failed to read backend status: boom")

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

    def test_install_get_releases_error_returns_500(self):
        response = DummyResponse()
        with mock.patch.object(
            llama_manager, "get_releases", side_effect=RuntimeError("API down")
        ):
            install.get_releases(
                Request("GET", "/api/releases", "", {}), response, self.ctx
            )
        self.assertEqual(response.status, 500)
        self.assertIn("API down", response.payload["error"])

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


if __name__ == "__main__":
    unittest.main()
