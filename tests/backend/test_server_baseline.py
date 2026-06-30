import io
import json
import subprocess
import sys
import unittest
from email.message import Message
from pathlib import Path

import server


def reset_shared_server_state():
    server.reset_download_progress()
    server.reset_model_download_state()
    server.set_remote_tunnel_state(
        status="idle",
        url="",
        message="Remote tunnel is not running.",
        log="",
    )
    server.set_llama_api_target(server.LLAMA_HOST, server.LLAMA_PORT)
    with server.STATE.install_lock:
        server.STATE.install_in_progress = False
    with server.STATE.model_download_lock:
        server.STATE.model_download_in_progress = False
    server.STATE.model_download_cancel.clear()


class ServerStateIsolationMixin:
    def setUp(self):
        reset_shared_server_state()

    def tearDown(self):
        reset_shared_server_state()


class HandlerCorsTests(ServerStateIsolationMixin, unittest.TestCase):
    def make_handler(self, origin="", referer="", host=""):
        handler = object.__new__(server.Handler)
        headers = Message()
        if origin:
            headers["Origin"] = origin
        if referer:
            headers["Referer"] = referer
        if host:
            headers["Host"] = host
        handler.headers = headers
        return handler

    def test_allows_localhost_origins(self):
        for origin in ("http://127.0.0.1:5240", "http://localhost:5240"):
            with self.subTest(origin=origin):
                self.assertTrue(self.make_handler(origin=origin).is_safe_request_origin())

    def test_allows_active_tunnel_origin(self):
        server.set_remote_tunnel_state(
            status="running",
            url="https://example.trycloudflare.com",
            message="running",
            log="",
        )

        handler = self.make_handler(origin="https://example.trycloudflare.com")

        self.assertTrue(handler.is_safe_request_origin())
        self.assertIn("https://example.trycloudflare.com", handler.get_allowed_request_origins())

    def test_wildcard_bind_allows_same_port_ip_request_host_origin(self):
        original_host = server.GUI_HOST
        try:
            server.GUI_HOST = "0.0.0.0"
            handler = self.make_handler(
                origin="http://192.168.1.20:5240",
                host="192.168.1.20:5240",
            )
            wildcard = self.make_handler(origin="http://0.0.0.0:5240", host="0.0.0.0:5240")
            untrusted = self.make_handler(
                origin="http://attacker.example:5240",
                host="attacker.example:5240",
            )

            self.assertTrue(handler.is_safe_request_origin())
            self.assertIn("http://192.168.1.20:5240", handler.get_allowed_request_origins())
            self.assertFalse(wildcard.is_safe_request_origin())
            self.assertFalse(untrusted.is_safe_request_origin())
        finally:
            server.GUI_HOST = original_host

    def test_rejects_unknown_origin(self):
        handler = self.make_handler(origin="https://evil.example")

        self.assertFalse(handler.is_safe_request_origin())

    def test_allows_requests_without_origin_or_referer(self):
        self.assertTrue(self.make_handler().is_safe_request_origin())

    def test_referer_must_start_with_allowed_origin(self):
        allowed = self.make_handler(referer="http://127.0.0.1:5240/index.html")
        denied = self.make_handler(referer="http://127.0.0.1.evil.example:5240/")
        prefix_bypass = self.make_handler(referer="http://localhost:5240@evil.example/")

        self.assertTrue(allowed.is_safe_request_origin())
        self.assertFalse(denied.is_safe_request_origin())
        self.assertFalse(prefix_bypass.is_safe_request_origin())


class HandlerResponseTests(ServerStateIsolationMixin, unittest.TestCase):
    def make_handler(self, origin=""):
        handler = object.__new__(server.Handler)
        headers = Message()
        if origin:
            headers["Origin"] = origin
        handler.headers = headers
        handler.wfile = io.BytesIO()
        handler.sent_response = None
        handler.sent_headers = []

        def send_response(status):
            handler.sent_response = status

        def send_header(name, value):
            handler.sent_headers.append((name, value))

        def end_headers():
            handler.headers_ended = True

        def send_error(status, *args, **kwargs):
            handler.sent_error = (status, args, kwargs)
            handler.sent_response = status

        handler.send_response = send_response
        handler.send_header = send_header
        handler.end_headers = end_headers
        handler.send_error = send_error
        return handler

    def test_options_uses_v1_cors_methods(self):
        handler = self.make_handler(origin="http://localhost:5240")
        handler.path = "/v1/chat/completions"

        handler.do_OPTIONS()

        self.assertEqual(handler.sent_response, 200)
        self.assertIn(("Access-Control-Allow-Origin", "http://localhost:5240"), handler.sent_headers)
        self.assertIn(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"), handler.sent_headers)
        self.assertIn(("Access-Control-Max-Age", "86400"), handler.sent_headers)

    def test_options_uses_api_cors_methods(self):
        handler = self.make_handler(origin="http://localhost:5240")
        handler.path = "/api/status"

        handler.do_OPTIONS()

        self.assertEqual(handler.sent_response, 200)
        self.assertIn(("Access-Control-Allow-Origin", "http://localhost:5240"), handler.sent_headers)
        self.assertIn(("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"), handler.sent_headers)

    def test_send_json_writes_body_and_cors_header(self):
        handler = self.make_handler(origin="http://localhost:5240")

        handler.send_json({"ok": True}, status=201)

        self.assertEqual(handler.sent_response, 201)
        self.assertIn(("Content-Type", "application/json"), handler.sent_headers)
        self.assertIn(("Access-Control-Allow-Origin", "http://localhost:5240"), handler.sent_headers)
        self.assertEqual(json.loads(handler.wfile.getvalue().decode("utf-8")), {"ok": True})

    def test_send_proxy_error_uses_current_error_shape(self):
        handler = self.make_handler()

        handler.send_proxy_error("upstream failed", status=502)

        self.assertEqual(handler.sent_response, 502)
        self.assertEqual(
            json.loads(handler.wfile.getvalue().decode("utf-8")),
            {"error": "upstream failed", "status": 502},
        )

    def test_proxy_rejects_path_traversal_before_forwarding(self):
        handler = self.make_handler()
        parsed = server.urllib.parse.urlparse("/v1/%2e%2e/api/status")

        handler.proxy_v1_request("GET", parsed)

        self.assertEqual(handler.sent_response, 400)
        self.assertEqual(
            json.loads(handler.wfile.getvalue().decode("utf-8")),
            {"error": "Invalid proxy path", "status": 400},
        )

    def test_read_body_returns_408_when_body_read_times_out(self):
        handler = self.make_handler()
        handler.headers["Content-Length"] = "10"
        handler.read_request_bytes = lambda length: (_ for _ in ()).throw(TimeoutError())

        result = handler.read_body()

        self.assertIsNotNone(result)
        self.assertEqual(handler.sent_response, 408)

    def test_version_ui_asset_urls_rewrites_local_assets(self):
        html = (
            '<link rel="stylesheet" href="/css/style.css?v=revamp-1">'
            '<script src="/js/app.js?v=revamp-1"></script>'
            '<img src="/assets/app-logo.png" alt="logo">'
            '<link rel="preconnect" href="https://fonts.googleapis.com">'
        )

        versioned = server.version_ui_asset_urls(html)

        self.assertNotIn("revamp-1", versioned)
        self.assertRegex(versioned, r'href="/css/style\.css\?v=\d+"')
        self.assertRegex(versioned, r'src="/js/app\.js\?v=\d+"')
        self.assertRegex(versioned, r'src="/assets/app-logo\.png\?v=\d+"')
        self.assertIn('href="https://fonts.googleapis.com"', versioned)

    def test_api_router_knows_existing_endpoint(self):
        match = server.API_ROUTER.match("GET", "/api/status")

        self.assertIsNotNone(match)
        self.assertEqual(match.handler_name, "get_status")

    def test_unknown_api_route_returns_json_404(self):
        handler = self.make_handler(origin="http://localhost:5240")
        handler.path = "/api/missing"

        handler.do_GET()

        self.assertEqual(handler.sent_response, 404)
        self.assertEqual(
            json.loads(handler.wfile.getvalue().decode("utf-8")),
            {"error": "Not found", "status": 404},
        )

    def test_dispatch_calls_extracted_callable_route(self):
        handler = self.make_handler(origin="http://localhost:5240")
        parsed = server.urllib.parse.urlparse("/api/test-callable?value=1")
        calls = {}

        def route(request, response, ctx):
            calls["method"] = request.method
            calls["path"] = request.path
            calls["query"] = request.query
            calls["ctx"] = ctx
            response.json({"handled": True}, status=202)

        original_router = server.API_ROUTER
        server.API_ROUTER = server.Router().add("GET", "/api/test-callable", route)
        try:
            handler.dispatch_api_request("GET", parsed)
        finally:
            server.API_ROUTER = original_router

        self.assertEqual(
            calls,
            {
                "method": "GET",
                "path": "/api/test-callable",
                "query": "value=1",
                "ctx": server.APP_CONTEXT,
            },
        )
        self.assertEqual(handler.sent_response, 202)
        self.assertEqual(json.loads(handler.wfile.getvalue().decode("utf-8")), {"handled": True})

    def test_dispatch_calls_legacy_string_handler_route(self):
        handler = self.make_handler(origin="http://localhost:5240")
        parsed = server.urllib.parse.urlparse("/api/test-legacy/abc?value=1")
        body = {"ok": True}
        calls = {}

        def handle_test_legacy(self, parsed_arg, body_arg=None, params_arg=None):
            calls["path"] = parsed_arg.path
            calls["query"] = parsed_arg.query
            calls["body"] = body_arg
            calls["params"] = params_arg
            self.send_json({"legacy": True}, status=203)

        original_router = server.API_ROUTER
        server.API_ROUTER = server.Router().add_prefix(
            "POST",
            "/api/test-legacy/",
            "handle_test_legacy",
            "name",
        )
        server.Handler.handle_test_legacy = handle_test_legacy
        try:
            handler.dispatch_api_request("POST", parsed, body)
        finally:
            server.API_ROUTER = original_router
            del server.Handler.handle_test_legacy

        self.assertEqual(
            calls,
            {
                "path": "/api/test-legacy/abc",
                "query": "value=1",
                "body": {"ok": True},
                "params": {"name": "abc"},
            },
        )
        self.assertEqual(handler.sent_response, 203)
        self.assertEqual(json.loads(handler.wfile.getvalue().decode("utf-8")), {"legacy": True})

    def test_dispatch_unknown_api_route_returns_json_404(self):
        handler = self.make_handler(origin="http://localhost:5240")
        parsed = server.urllib.parse.urlparse("/api/test-missing")

        original_router = server.API_ROUTER
        server.API_ROUTER = server.Router()
        try:
            handler.dispatch_api_request("GET", parsed)
        finally:
            server.API_ROUTER = original_router

        self.assertEqual(handler.sent_response, 404)
        self.assertEqual(
            json.loads(handler.wfile.getvalue().decode("utf-8")),
            {"error": "Not found", "status": 404},
        )

    def test_dispatch_unknown_non_api_route_uses_plain_404(self):
        handler = self.make_handler(origin="http://localhost:5240")
        parsed = server.urllib.parse.urlparse("/missing")

        original_router = server.API_ROUTER
        server.API_ROUTER = server.Router()
        try:
            handler.dispatch_api_request("GET", parsed)
        finally:
            server.API_ROUTER = original_router

        self.assertEqual(handler.sent_error[0], 404)


class StateSnapshotTests(ServerStateIsolationMixin, unittest.TestCase):
    def test_server_helpers_use_shared_server_state(self):
        self.assertIs(server.APP_CONTEXT.state, server.STATE)

    def test_download_progress_reset_and_snapshot_are_copied(self):
        server.reset_download_progress(status="downloading", message="Working", total=100, downloaded=25)
        snapshot = server.get_download_progress_snapshot()
        snapshot["downloaded"] = 99

        self.assertEqual(snapshot["status"], "downloading")
        self.assertEqual(server.get_download_progress_snapshot()["downloaded"], 25)
        self.assertEqual(server.STATE.download_progress.snapshot()["downloaded"], 25)

    def test_model_download_state_reset_update_and_snapshot_are_copied(self):
        server.reset_model_download_state(status="idle", message="", total=0, downloaded=0)
        server.set_model_download_state(status="downloading", model_name="model.gguf", downloaded=128)
        snapshot = server.get_model_download_snapshot()
        snapshot["downloaded"] = 999

        self.assertEqual(snapshot["status"], "downloading")
        self.assertEqual(snapshot["model_name"], "model.gguf")
        self.assertEqual(server.get_model_download_snapshot()["downloaded"], 128)
        self.assertEqual(server.STATE.model_download.snapshot()["downloaded"], 128)

    def test_remote_tunnel_log_is_truncated_in_state(self):
        server.set_remote_tunnel_state(status="running", url="https://example.trycloudflare.com", log="x" * 7000)

        snapshot = server.get_remote_tunnel_snapshot()

        self.assertEqual(snapshot["status"], "running")
        self.assertEqual(snapshot["url"], "https://example.trycloudflare.com")
        self.assertEqual(len(snapshot["log"]), 6000)
        self.assertEqual(len(server.STATE.remote_tunnel.snapshot()["log"]), 6000)


class ValidationTests(ServerStateIsolationMixin, unittest.TestCase):
    def test_hf_repo_id_validation(self):
        self.assertEqual(server.validate_hf_repo_id("owner/model"), "owner/model")

        for value in ("", "owner", "../model", "owner/model.", "owner//model"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    server.validate_hf_repo_id(value)

    def test_hf_revision_validation_defaults_and_rejects_traversal(self):
        self.assertEqual(server.validate_hf_revision(""), "main")
        self.assertEqual(server.validate_hf_revision("refs/pr/1"), "refs/pr/1")

        for value in ("/main", r"main\bad", "refs/../main", "bad\x00name"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    server.validate_hf_revision(value)

    def test_hf_filename_validation_accepts_safe_gguf_paths(self):
        self.assertEqual(server.validate_hf_filename("Q4/model.gguf"), "Q4/model.gguf")

    def test_hf_filename_validation_rejects_unsafe_names(self):
        for value in ("", "/model.gguf", "../model.gguf", "model.bin", "bad:name.gguf", "bad\x00name.gguf"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    server.validate_hf_filename(value)

    def test_parse_port_defaults_for_invalid_values(self):
        self.assertEqual(server.parse_port("1234"), 1234)
        self.assertEqual(server.parse_port("0"), 8080)
        self.assertEqual(server.parse_port("70000"), 8080)
        self.assertEqual(server.parse_port("not-a-port"), 8080)

    def test_local_proxy_target_normalizes_wildcard_hosts(self):
        target = server.set_llama_api_target("0.0.0.0", "9090")

        self.assertEqual(target, {"host": "127.0.0.1", "port": 9090})
        self.assertEqual(server.get_llama_api_target(), target)
        self.assertEqual(server.STATE.llama_api_target.snapshot(), target)

    def test_local_chat_api_url_validation(self):
        self.assertEqual(
            server.get_local_chat_api_url({"host": "localhost", "port": 8080}),
            "http://127.0.0.1:8080/v1/chat/completions",
        )

        with self.assertRaises(ValueError):
            server.get_local_chat_api_url({"host": "localhost", "port": 70000})


class ImportSmokeTests(unittest.TestCase):
    def test_server_py_is_compatibility_entrypoint(self):
        import backend.app

        self.assertIs(server.main, backend.app.main)
        self.assertEqual(Path(server.__file__).name, "server.py")

    def test_server_wrapper_forwards_app_assignments(self):
        import backend.app

        original_router = server.API_ROUTER
        try:
            sentinel = object()
            server.API_ROUTER = sentinel
            self.assertIs(backend.app.API_ROUTER, sentinel)
        finally:
            server.API_ROUTER = original_router

    def test_server_import_does_not_load_feature_optional_dependencies(self):
        script = (
            "import json, sys; "
            "import server; "
            "print(json.dumps({name: name in sys.modules for name in "
            "['huggingface_hub', 'ddgs', 'tkinter']}))"
        )

        server_dir = str(Path(server.__file__).parent)
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=server_dir,
            text=True,
            capture_output=True,
            check=True,
        )

        self.assertEqual(
            json.loads(result.stdout),
            {"huggingface_hub": False, "ddgs": False, "tkinter": False},
        )


if __name__ == "__main__":
    unittest.main()
