import io
import json
import re
import socket
import subprocess
import sys
import unittest
import urllib.parse
from contextlib import redirect_stderr
from email.message import Message
from pathlib import Path
from unittest import mock

import backend.app as backend_app
import server
from backend import http as backend_http


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

    def dispatch_with_handler(self, route_handler, method="GET", path="/api/probe"):
        handler = self.make_handler(origin="http://localhost:5240")
        handler.close_connection = False
        match = mock.Mock(handler=route_handler, params={})
        with mock.patch.object(backend_app.API_ROUTER, "match", return_value=match):
            with redirect_stderr(io.StringIO()) as captured:
                handler.dispatch_api_request(method, urllib.parse.urlparse(path))
        return handler, captured.getvalue()

    def test_dispatch_turns_handler_exception_into_sanitized_500(self):
        """A raising route must not drop the connection: the UI reports that as
        'server unreachable' rather than showing an error."""

        def boom(request, response, ctx):
            raise RuntimeError("secret filesystem path")

        handler, stderr = self.dispatch_with_handler(boom)

        self.assertEqual(handler.sent_response, 500)
        body = json.loads(handler.wfile.getvalue().decode("utf-8"))
        self.assertEqual(body["status"], 500)
        self.assertNotIn("secret filesystem path", body["error"])
        self.assertIn("secret filesystem path", stderr)

    def test_dispatch_does_not_write_second_response_after_stream_started(self):
        """Once a status line is out, an error response would corrupt it."""

        def half_written(request, response, ctx):
            response.json({"partial": True})
            raise RuntimeError("late failure")

        handler, stderr = self.dispatch_with_handler(half_written)

        self.assertEqual(handler.sent_response, 200)
        self.assertEqual(json.loads(handler.wfile.getvalue().decode("utf-8")), {"partial": True})
        self.assertTrue(handler.close_connection)
        self.assertIn("late failure", stderr)

    def test_dispatch_swallows_client_disconnect(self):
        def disconnected(request, response, ctx):
            raise BrokenPipeError("client hung up")

        handler, _ = self.dispatch_with_handler(disconnected)

        self.assertIsNone(handler.sent_response)
        self.assertTrue(handler.close_connection)

    def test_v1_proxy_does_not_write_second_response_after_stream_started(self):
        """Upstream dying mid-relay must truncate, not append a 502 to the reply
        the client is already parsing."""
        handler = self.make_handler(origin="http://localhost:5240")
        handler.close_connection = False

        class FailingUpstream:
            status = 200
            headers = Message()

            def __enter__(self):
                return self

            def __exit__(self, *exc_info):
                return False

            def read(self, _size=-1):
                raise OSError("upstream died mid-stream")

            def readline(self):
                raise OSError("upstream died mid-stream")

        with mock.patch.object(
            backend_app, "open_pinned_local_request", return_value=FailingUpstream()
        ):
            with redirect_stderr(io.StringIO()) as captured:
                handler.proxy_v1_request("GET", urllib.parse.urlparse("/v1/models"))

        self.assertEqual(
            handler.sent_response, 200,
            "a second send_response would overwrite this with the 502",
        )
        self.assertTrue(handler.close_connection)
        self.assertIn("upstream died mid-stream", captured.getvalue())

    def test_v1_proxy_reports_unreachable_upstream_before_streaming(self):
        handler = self.make_handler(origin="http://localhost:5240")
        handler.close_connection = False

        with mock.patch.object(
            backend_app, "open_pinned_local_request", side_effect=OSError("connection refused")
        ):
            with redirect_stderr(io.StringIO()):
                handler.proxy_v1_request("GET", urllib.parse.urlparse("/v1/models"))

        self.assertEqual(handler.sent_response, 502)
        body = json.loads(handler.wfile.getvalue().decode("utf-8"))
        self.assertIn("llama-server", body["error"])

    def test_v1_proxy_refuses_a_target_that_rebinds_off_machine(self):
        """The target host was validated when registered; if it re-resolves
        off-machine at request time the proxy must fail closed with the
        generic 502 instead of relaying the request (and any Authorization
        header) to the new address."""
        handler = self.make_handler()
        parsed = server.urllib.parse.urlparse("/v1/models")
        # Registration-time validation sees loopback; the proxy resolves the
        # host again at request time, and that answer is now public.
        loopback = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 8080))]
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 8080))]

        with mock.patch.object(
            backend_http.socket, "getaddrinfo", side_effect=[loopback, public]
        ), mock.patch.object(backend_http, "connect_pinned") as connect_pinned, redirect_stderr(
            io.StringIO()
        ):
            server.set_llama_api_target("rebind.test", 8080)
            handler.proxy_v1_request("GET", parsed)

        connect_pinned.assert_not_called()
        self.assertEqual(handler.sent_response, 502)
        body = json.loads(handler.wfile.getvalue().decode("utf-8"))
        self.assertIn("llama-server", body["error"])
        self.assertNotIn("rebind", body["error"])

    def acao_count(self, handler):
        return sum(1 for name, _ in handler.sent_headers if name == "Access-Control-Allow-Origin")

    def make_cors_handler(self, path, origin="http://localhost:5240"):
        """Handler that keeps the *real* end_headers.

        The duplicate Access-Control-Allow-Origin originates in
        Handler.end_headers, so a stub that replaces it cannot observe the bug at
        all — these tests pass with or without the fix if end_headers is faked.
        """
        handler = self.make_handler(origin=origin)
        handler.path = path
        handler.request_version = "HTTP/1.1"
        handler._headers_buffer = []
        handler.end_headers = lambda: server.Handler.end_headers(handler)
        return handler

    def test_index_sends_exactly_one_cors_origin_header(self):
        """`/` is a static UI path *and* goes out through Response.bytes(), so both
        end_headers() and Response added the header. Browsers reject a duplicated
        Access-Control-Allow-Origin outright, breaking the one case it exists for."""
        for path in ("/", "/index.html"):
            with self.subTest(path=path):
                handler = self.make_cors_handler(path)

                handler.send_versioned_index()

                self.assertEqual(self.acao_count(handler), 1, handler.sent_headers)
                self.assertIn(
                    ("Access-Control-Allow-Origin", "http://localhost:5240"),
                    handler.sent_headers,
                )

    def test_options_on_static_path_sends_exactly_one_cors_origin_header(self):
        """do_OPTIONS emits the header itself and then calls end_headers(), which
        emitted it again for a static UI path."""
        handler = self.make_cors_handler("/")

        handler.do_OPTIONS()

        self.assertEqual(self.acao_count(handler), 1, handler.sent_headers)

    def test_api_json_response_still_sends_the_cors_origin_header(self):
        """De-duplication must not drop the header on non-static paths, where
        end_headers() does not add one."""
        handler = self.make_cors_handler("/api/status")

        handler.send_json({"ok": True})

        self.assertEqual(self.acao_count(handler), 1, handler.sent_headers)

    def test_static_asset_still_sends_the_cors_origin_header(self):
        """/js/ and /css/ are served by SimpleHTTPRequestHandler, so end_headers is
        the only thing that adds the header there."""
        handler = self.make_cors_handler("/js/app.js")

        handler.send_response(200)
        handler.end_headers()

        self.assertEqual(self.acao_count(handler), 1, handler.sent_headers)

    def test_cors_origin_guard_resets_between_responses(self):
        """Handlers are reused across keep-alive requests, so the once-per-response
        latch has to clear."""
        handler = self.make_cors_handler("/api/status")

        handler.send_json({"first": True})
        handler.sent_headers.clear()
        handler.send_json({"second": True})

        self.assertEqual(self.acao_count(handler), 1, handler.sent_headers)

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

    def test_v1_proxy_forwards_authorization_header(self):
        handler = self.make_handler()
        handler.headers["Authorization"] = "Bearer secret"
        parsed = server.urllib.parse.urlparse("/v1/models")
        captured = {}
        server.set_llama_api_target("::1", 8080)

        class Upstream:
            status = 200

            def __init__(self):
                self.headers = Message()
                self.headers["Content-Type"] = "application/json"
                self._chunks = [b'{"data":[]}', b""]

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self, size=-1):
                return self._chunks.pop(0)

        def fake_open(host, port, path, *, method="GET", data=None, headers=None, timeout=300):
            captured["authorization"] = (headers or {}).get("Authorization")
            captured["target"] = (host, port, path)
            return Upstream()

        with mock.patch.object(backend_app, "open_pinned_local_request", side_effect=fake_open):
            handler.proxy_v1_request("GET", parsed)

        self.assertEqual(handler.sent_response, 200)
        self.assertEqual(captured["authorization"], "Bearer secret")
        self.assertEqual(captured["target"], ("::1", 8080, "/v1/models"))
        self.assertEqual(json.loads(handler.wfile.getvalue().decode("utf-8")), {"data": []})

    def test_read_body_rejects_valid_non_object_json(self):
        for payload in (b"[]", b'"text"', b"42", b"null"):
            with self.subTest(payload=payload):
                handler = self.make_handler()
                handler.headers["Content-Length"] = str(len(payload))
                handler.read_request_bytes = lambda _length, body=payload: body

                self.assertIsNone(handler.read_body())

    def test_request_body_rejects_transfer_encoding(self):
        for reader in ("read_body", "get_proxy_request_body"):
            with self.subTest(reader=reader):
                handler = self.make_handler()
                handler.headers["Transfer-Encoding"] = "chunked"

                result = getattr(handler, reader)()

                self.assertIs(result, backend_app._BODY_HANDLED)
                self.assertEqual(handler.sent_response, 501)
                payload = json.loads(handler.wfile.getvalue().decode("utf-8"))
                self.assertIn("Transfer-Encoding is not supported", payload["error"])

    def test_read_body_returns_408_when_body_read_times_out(self):
        handler = self.make_handler()
        handler.headers["Content-Length"] = "10"
        handler.read_request_bytes = lambda length: (_ for _ in ()).throw(TimeoutError())

        result = handler.read_body()

        self.assertIs(result, backend_app._BODY_HANDLED)
        self.assertEqual(handler.sent_response, 408)

    def test_content_length_allows_leading_zeros(self):
        handler = self.make_handler()
        handler.headers["Content-Length"] = "000000001"

        self.assertEqual(handler.get_request_content_length(), 1)
        self.assertIsNone(handler.sent_response)

    def test_read_body_rejects_invalid_negative_and_excessive_content_length(self):
        cases = [
            ("not-a-number", 400),
            ("-1", 400),
            ("١٢٣", 400),  # non-ASCII Unicode digits pass isdecimal()
            ("9" * 5000, 413),
            (str(backend_app.MAX_REQUEST_BODY_SIZE + 1), 413),
        ]
        for value, expected_status in cases:
            with self.subTest(value=value):
                handler = self.make_handler()
                handler.headers["Content-Length"] = value

                result = handler.read_body()

                self.assertIs(result, backend_app._BODY_HANDLED)
                self.assertEqual(handler.sent_response, expected_status)

    def test_proxy_body_rejects_invalid_and_excessive_content_length(self):
        for value, expected_status in (
            ("invalid", 400),
            ("-1", 400),
            ("9" * 5000, 413),
            (str(backend_app.MAX_REQUEST_BODY_SIZE + 1), 413),
        ):
            with self.subTest(value=value):
                handler = self.make_handler()
                handler.headers["Content-Length"] = value

                result = handler.get_proxy_request_body()

                self.assertIs(result, backend_app._BODY_HANDLED)
                self.assertEqual(handler.sent_response, expected_status)

    def test_proxy_failure_logs_detail_but_returns_generic_502(self):
        handler = self.make_handler()
        parsed = server.urllib.parse.urlparse("/v1/models")
        stderr = io.StringIO()

        with mock.patch.object(
            backend_app,
            "open_pinned_local_request",
            side_effect=OSError("secret local detail"),
        ), redirect_stderr(stderr):
            handler.proxy_v1_request("GET", parsed)

        payload = json.loads(handler.wfile.getvalue().decode("utf-8"))
        self.assertEqual(handler.sent_response, 502)
        self.assertEqual(
            payload,
            {
                "error": "Failed to reach llama-server. Start it or check the configured API host and port.",
                "status": 502,
            },
        )
        self.assertNotIn("secret local detail", payload["error"])
        self.assertIn("secret local detail", stderr.getvalue())

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

    def test_ui_asset_version_tracks_all_local_index_assets(self):
        index_html = (server.UI_DIR / "index.html").read_text(encoding="utf-8")
        tracked = {
            path.relative_to(server.UI_DIR).as_posix()
            for path in server.iter_versioned_ui_asset_paths(index_html)
            if server.UI_DIR in path.parents
        }
        local_assets = {
            match.group(1).split("?", 1)[0].lstrip("/")
            for match in server.re.finditer(
                r'(?:href|src)="(/(?:css|js|assets)/[^"?#]+(?:\?[^"#]*)?)"',
                index_html,
            )
        }

        self.assertGreater(len(local_assets), 0)
        self.assertTrue(local_assets.issubset(tracked))

    def test_api_router_knows_existing_endpoint(self):
        match = server.API_ROUTER.match("GET", "/api/status")

        self.assertIsNotNone(match)
        self.assertEqual(match.handler_name, "get_status")

        preflight_match = server.API_ROUTER.match("POST", "/api/launch/preflight")
        self.assertIsNotNone(preflight_match)
        self.assertEqual(preflight_match.handler_name, "preflight_launch")

        fingerprint_match = server.API_ROUTER.match("POST", "/api/presets/fingerprint")
        self.assertIsNotNone(fingerprint_match)
        self.assertEqual(fingerprint_match.handler_name, "fingerprint_preset")

        health_match = server.API_ROUTER.match("GET", "/api/llama/health")
        self.assertIsNotNone(health_match)
        self.assertEqual(health_match.handler_name, "get_health")

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


class ReleaseManifestTests(unittest.TestCase):
    """`release.ps1` copies a hand-written list into the zip, so anything the app
    needs at runtime but that nobody added to that list is simply missing from
    every release. These tie the list to the real runtime constants."""

    @staticmethod
    def _release_items():
        root = Path(server.__file__).parent
        text = (root / "release.ps1").read_text(encoding="utf-8")
        block = re.search(r"\$items\s*=\s*@\((.*?)\n\)", text, re.DOTALL)
        assert block, "could not find the $items array in release.ps1"
        return root, re.findall(r'"([^"]+)"', block.group(1))

    def test_every_listed_item_exists(self):
        # release.ps1 throws "Missing release item" and produces no zip otherwise.
        root, items = self._release_items()
        for item in items:
            with self.subTest(item=item):
                self.assertTrue((root / item).exists(), f"{item} is listed but not in the repo")

    def test_runtime_logo_is_packaged(self):
        from backend.config import APP_LOGO_FILE

        root, items = self._release_items()
        self.assertIn(
            APP_LOGO_FILE.name, items,
            "APP_LOGO_FILE is served at /assets/app-logo.png and used by ui/index.html, "
            "so it has to ship in the zip",
        )
        self.assertEqual(APP_LOGO_FILE.parent, root, "logo is expected at the repo root")

    def test_windows_installer_dependencies_are_packaged(self):
        root, items = self._release_items()
        installer = (root / "windows_install.bat").read_text(encoding="utf-8", errors="replace")
        self.assertIn("scripts\\create_windows_shortcuts.ps1", installer)
        self.assertIn("scripts", items, "windows_install.bat invokes scripts\\create_windows_shortcuts.ps1")

        shortcut_script = (root / "scripts" / "create_windows_shortcuts.ps1").read_text(
            encoding="utf-8", errors="replace"
        )
        self.assertIn("assets", shortcut_script)
        self.assertIn("assets", items, "create_windows_shortcuts.ps1 reads assets\\Llama-GUI.ico")

    def test_fresh_installs_create_custom_backend_directories(self):
        root, _items = self._release_items()
        windows_installer = (root / "windows_install.bat").read_text(
            encoding="utf-8", errors="replace"
        )
        unix_installer = (root / "install.sh").read_text(encoding="utf-8")
        release_script = (root / "release.ps1").read_text(encoding="utf-8")

        for directory in ("llama\\custom\\bin", "llama\\custom\\grammars"):
            self.assertIn(directory, windows_installer)
            self.assertIn(f'"{directory}"', release_script)
        self.assertIn("mkdir -p llama/custom/bin llama/custom/grammars", unix_installer)


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
