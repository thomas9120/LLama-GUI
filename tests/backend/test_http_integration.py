"""Exercise the real HTTP parser, method handlers, router, and response framing."""

import contextlib
import http.server
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from backend import app
from backend.context import AppContext, AppPaths


class HttpIntegrationTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        temporary = stack.enter_context(tempfile.TemporaryDirectory())
        self.presets = Path(temporary) / "presets"
        self.presets.mkdir()
        ctx = AppContext(paths=AppPaths(presets=self.presets))
        stack.enter_context(mock.patch.object(app, "APP_CONTEXT", ctx))
        stack.enter_context(mock.patch.object(app, "GUI_HOST", "127.0.0.1"))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_port
        stack.enter_context(mock.patch.object(app, "GUI_PORT", self.port))
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())

    def request(self, method, path, body=b"", headers=None, end_body=True):
        fields = {
            "Host": f"127.0.0.1:{self.port}",
            "Origin": f"http://127.0.0.1:{self.port}",
            "Content-Length": str(len(body)),
            "Connection": "close",
        }
        fields.update(headers or {})
        head = f"{method} {path} HTTP/1.1\r\n" + "".join(
            f"{name}: {value}\r\n" for name, value in fields.items()
        ) + "\r\n"
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
            connection.sendall(head.encode("ascii") + body)
            if end_body:
                connection.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        wire = b"".join(chunks)
        self.assertEqual(wire.count(b"HTTP/1."), 1, wire)
        response_head, response_body = wire.split(b"\r\n\r\n", 1)
        self.assertEqual(response_head.lower().count(b"access-control-allow-origin:"), 1)
        return int(response_head.split()[1]), json.loads(response_body)

    def test_post_saves_and_delete_removes_a_preset_through_the_real_router(self):
        # Cross the reader's 64 KiB boundary, including multibyte UTF-8 content.
        data = {"model": "model.gguf", "flags": {"prompt": "café " * 16000}}
        body = json.dumps({"name": "HTTP probe", "data": data}, ensure_ascii=False).encode("utf-8")
        status, payload = self.request("POST", "/api/presets", body)
        self.assertEqual((status, payload), (200, {"saved": True, "name": "HTTP probe"}))
        saved = self.presets / "HTTP probe.json"
        self.assertEqual(json.loads(saved.read_text(encoding="utf-8")), data)

        status, payload = self.request("DELETE", "/api/presets/HTTP%20probe", b"{}")
        self.assertEqual(status, 200)
        self.assertTrue(payload["deleted"])
        self.assertFalse(saved.exists())

    def test_rejected_origins_never_wait_for_or_dispatch_the_body(self):
        with mock.patch.object(app, "REQUEST_BODY_TIMEOUT_SECONDS", 0.05):
            for method in ("POST", "DELETE"):
                with self.subTest(method=method):
                    status, payload = self.request(method, "/api/presets/probe", headers={
                        "Origin": "https://untrusted.example", "Content-Length": "100",
                    }, end_body=False)
                    self.assertEqual(status, 403)
                    self.assertIn("origin", payload["error"])

    def test_invalid_json_never_reaches_the_route(self):
        for method in ("POST", "DELETE"):
            for body in (b"{", b"[]", b"null", b'"text"', b"\xff"):
                with self.subTest(method=method, body=body):
                    status, payload = self.request(method, "/api/missing", body)
                    self.assertEqual(status, 400)
                    self.assertIn("JSON", payload["error"])

    def test_body_errors_send_one_response_and_never_dispatch(self):
        for method in ("POST", "DELETE"):
            for headers, expected in (
                ({"Content-Length": "-1"}, 400),
                ({"Content-Length": str(app.MAX_REQUEST_BODY_SIZE + 1)}, 413),
                ({"Transfer-Encoding": "chunked"}, 501),
            ):
                with self.subTest(method=method, headers=headers):
                    status, _ = self.request(method, "/api/missing", headers=headers)
                    self.assertEqual(status, expected)

    def test_truncated_and_stalled_bodies_send_one_timeout_response(self):
        with mock.patch.object(app, "REQUEST_BODY_TIMEOUT_SECONDS", 0.05):
            for method in ("POST", "DELETE"):
                for end_body in (True, False):
                    with self.subTest(method=method, end_body=end_body):
                        status, payload = self.request(method, "/api/missing", b"{", {
                            "Content-Length": "10",
                        }, end_body=end_body)
                        self.assertEqual(status, 408)
                        self.assertIn("timed out", payload["error"])

    def test_valid_requests_to_unknown_routes_return_json_404(self):
        for method in ("POST", "DELETE"):
            with self.subTest(method=method):
                status, payload = self.request(method, "/api/missing", b"{}")
                self.assertEqual((status, payload["error"]), (404, "Not found"))
