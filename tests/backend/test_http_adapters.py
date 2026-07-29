import io
import json
import unittest
from email.message import Message

from backend.http import (
    Response,
    SseWriter,
    get_access_control_origin,
    get_allowed_request_origins,
    get_cors_methods,
    get_request_host_origin,
    is_safe_request_origin,
    is_safe_v1_proxy_path,
    is_static_ui_path,
    is_v1_proxy_path,
)


class HttpCorsAdapterTests(unittest.TestCase):
    def make_headers(self, origin="", referer="", host=""):
        headers = Message()
        if origin:
            headers["Origin"] = origin
        if referer:
            headers["Referer"] = referer
        if host:
            headers["Host"] = host
        return headers

    def test_allowed_origins_include_local_and_active_tunnel(self):
        origins = get_allowed_request_origins("https://example.trycloudflare.com")

        self.assertIn("http://127.0.0.1:5240", origins)
        self.assertIn("http://localhost:5240", origins)
        self.assertIn("https://example.trycloudflare.com", origins)

    def test_allowed_origins_include_explicit_gui_host(self):
        origins = get_allowed_request_origins(gui_host="192.168.1.10", gui_port=5250)

        self.assertIn("http://127.0.0.1:5250", origins)
        self.assertIn("http://localhost:5250", origins)
        self.assertIn("http://192.168.1.10:5250", origins)

    def test_wildcard_bind_uses_ip_request_host_origin_without_allowing_wildcard_origin(self):
        origins = get_allowed_request_origins(
            gui_host="0.0.0.0",
            gui_port=5250,
            request_host="192.168.1.20:5250",
            allow_request_host_origin=True,
        )

        self.assertIn("http://192.168.1.20:5250", origins)
        self.assertNotIn("http://0.0.0.0:5250", origins)
        self.assertTrue(is_safe_request_origin(self.make_headers(origin="http://192.168.1.20:5250"), origins))
        self.assertFalse(is_safe_request_origin(self.make_headers(origin="http://0.0.0.0:5250"), origins))

    def test_wildcard_bind_rejects_untrusted_hostnames(self):
        origins = get_allowed_request_origins(
            gui_host="0.0.0.0",
            gui_port=5250,
            request_host="attacker.example:5250",
            allow_request_host_origin=True,
        )

        self.assertNotIn("http://attacker.example:5250", origins)
        self.assertFalse(is_safe_request_origin(self.make_headers(origin="http://attacker.example:5250"), origins))

    def test_wildcard_bind_allows_explicitly_trusted_hostnames(self):
        origins = get_allowed_request_origins(
            gui_host="0.0.0.0",
            gui_port=5250,
            request_host="llama-box.local:5250",
            allow_request_host_origin=True,
            trusted_hosts=("llama-box.local",),
        )

        self.assertIn("http://llama-box.local:5250", origins)
        self.assertTrue(is_safe_request_origin(self.make_headers(origin="http://llama-box.local:5250"), origins))

    def test_request_host_origin_rejects_malformed_ports(self):
        for host_header in (
            "192.168.1.20:not-a-port",
            "192.168.1.20:99999",
            "[::1",
        ):
            with self.subTest(host_header=host_header):
                self.assertEqual(get_request_host_origin(host_header, 5240), "")

    def test_origin_and_referer_validation(self):
        allowed = get_allowed_request_origins()

        self.assertTrue(is_safe_request_origin(self.make_headers(origin="http://localhost:5240"), allowed))
        self.assertTrue(is_safe_request_origin(self.make_headers(referer="http://127.0.0.1:5240/index.html"), allowed))
        self.assertTrue(is_safe_request_origin(self.make_headers(), allowed))
        self.assertFalse(is_safe_request_origin(self.make_headers(origin="https://evil.example"), allowed))
        self.assertFalse(is_safe_request_origin(self.make_headers(referer="http://127.0.0.1.evil.example/"), allowed))
        self.assertFalse(is_safe_request_origin(self.make_headers(referer="http://localhost:5240@evil.example/"), allowed))
        self.assertFalse(is_safe_request_origin(self.make_headers(referer="http://localhost:5240.evil.example/"), allowed))

    def test_access_control_origin_reflects_allowed_origin_or_default(self):
        allowed = get_allowed_request_origins()

        self.assertEqual(
            get_access_control_origin(self.make_headers(origin="http://localhost:5240"), allowed),
            "http://localhost:5240",
        )
        self.assertEqual(
            get_access_control_origin(self.make_headers(origin="https://evil.example"), allowed),
            "http://127.0.0.1:5240",
        )

    def test_path_classification(self):
        self.assertTrue(is_v1_proxy_path("/v1/chat/completions"))
        self.assertFalse(is_v1_proxy_path("/api/status"))
        self.assertTrue(is_safe_v1_proxy_path("/v1/chat/completions"))
        self.assertFalse(is_safe_v1_proxy_path("/v1/../api/status"))
        self.assertFalse(is_safe_v1_proxy_path("/v1/%2e%2e/api/status"))
        self.assertFalse(is_safe_v1_proxy_path("/v1/%252e%252e/api/status"))
        self.assertFalse(is_safe_v1_proxy_path(r"/v1\..\api\status"))
        self.assertEqual(get_cors_methods("/v1/models"), "GET, POST, OPTIONS")
        self.assertEqual(get_cors_methods("/api/status"), "GET, POST, PUT, DELETE, OPTIONS")
        self.assertTrue(is_static_ui_path("/js/app.js"))
        self.assertFalse(is_static_ui_path("/assets/app-logo.png"))


class HttpResponseAdapterTests(unittest.TestCase):
    def make_handler(self, origin=""):
        handler = type("DummyHandler", (), {})()
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

        def get_access_control_origin_for_handler():
            allowed = get_allowed_request_origins()
            return get_access_control_origin(handler.headers, allowed)

        handler.send_response = send_response
        handler.send_header = send_header
        handler.end_headers = end_headers
        handler.get_access_control_origin = get_access_control_origin_for_handler
        return handler

    def test_json_and_error_responses_include_cors_and_status_body(self):
        handler = self.make_handler(origin="http://localhost:5240")

        Response(handler).error("upstream failed", status=502, code="upstream_unavailable")

        self.assertEqual(handler.sent_response, 502)
        self.assertIn(("Access-Control-Allow-Origin", "http://localhost:5240"), handler.sent_headers)
        self.assertIn(("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"), handler.sent_headers)
        self.assertIn(("Pragma", "no-cache"), handler.sent_headers)
        self.assertIn(("Expires", "0"), handler.sent_headers)
        self.assertEqual(
            json.loads(handler.wfile.getvalue().decode("utf-8")),
            {"error": "upstream failed", "status": 502, "code": "upstream_unavailable"},
        )

    def test_text_and_bytes_responses(self):
        text_handler = self.make_handler()
        Response(text_handler).text("hello")
        self.assertEqual(text_handler.wfile.getvalue(), b"hello")
        self.assertIn(("Content-Type", "text/plain; charset=utf-8"), text_handler.sent_headers)

        bytes_handler = self.make_handler()
        Response(bytes_handler).bytes(b"abc", content_type="image/png", headers={"Cache-Control": "public"})
        self.assertEqual(bytes_handler.wfile.getvalue(), b"abc")
        self.assertIn(("Content-Type", "image/png"), bytes_handler.sent_headers)
        self.assertIn(("Cache-Control", "public"), bytes_handler.sent_headers)

    def test_sse_writer_matches_existing_wire_format(self):
        output = io.BytesIO()

        writer = SseWriter(output)
        writer.write({"type": "status", "content": "hello"})
        writer.write("[DONE]")

        self.assertEqual(
            output.getvalue().decode("utf-8"),
            'data: {"type": "status", "content": "hello"}\n\n'
            "data: [DONE]\n\n",
        )


if __name__ == "__main__":
    unittest.main()
