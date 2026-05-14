import io
import json
import subprocess
import sys
import unittest
from email.message import Message

import server


class HandlerCorsTests(unittest.TestCase):
    def make_handler(self, origin="", referer=""):
        handler = object.__new__(server.Handler)
        headers = Message()
        if origin:
            headers["Origin"] = origin
        if referer:
            headers["Referer"] = referer
        handler.headers = headers
        return handler

    def setUp(self):
        server.set_remote_tunnel_state(
            status="idle",
            url="",
            message="Remote tunnel is not running.",
            log="",
        )

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

    def test_rejects_unknown_origin(self):
        handler = self.make_handler(origin="https://evil.example")

        self.assertFalse(handler.is_safe_request_origin())

    def test_allows_requests_without_origin_or_referer(self):
        self.assertTrue(self.make_handler().is_safe_request_origin())

    def test_referer_must_start_with_allowed_origin(self):
        allowed = self.make_handler(referer="http://127.0.0.1:5240/index.html")
        denied = self.make_handler(referer="http://127.0.0.1.evil.example:5240/")

        self.assertTrue(allowed.is_safe_request_origin())
        self.assertFalse(denied.is_safe_request_origin())


class HandlerResponseTests(unittest.TestCase):
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

        handler.send_response = send_response
        handler.send_header = send_header
        handler.end_headers = end_headers
        return handler

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
            {"error": "upstream failed"},
        )


class StateSnapshotTests(unittest.TestCase):
    def test_download_progress_reset_and_snapshot_are_copied(self):
        server.reset_download_progress(status="downloading", message="Working", total=100, downloaded=25)
        snapshot = server.get_download_progress_snapshot()
        snapshot["downloaded"] = 99

        self.assertEqual(snapshot["status"], "downloading")
        self.assertEqual(server.get_download_progress_snapshot()["downloaded"], 25)

    def test_model_download_state_reset_update_and_snapshot_are_copied(self):
        server.reset_model_download_state(status="idle", message="", total=0, downloaded=0)
        server.set_model_download_state(status="downloading", model_name="model.gguf", downloaded=128)
        snapshot = server.get_model_download_snapshot()
        snapshot["downloaded"] = 999

        self.assertEqual(snapshot["status"], "downloading")
        self.assertEqual(snapshot["model_name"], "model.gguf")
        self.assertEqual(server.get_model_download_snapshot()["downloaded"], 128)

    def test_remote_tunnel_log_is_truncated_in_state(self):
        server.set_remote_tunnel_state(status="running", url="https://example.trycloudflare.com", log="x" * 7000)

        snapshot = server.get_remote_tunnel_snapshot()

        self.assertEqual(snapshot["status"], "running")
        self.assertEqual(snapshot["url"], "https://example.trycloudflare.com")
        self.assertEqual(len(snapshot["log"]), 6000)


class ValidationTests(unittest.TestCase):
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

    def test_local_chat_api_url_validation(self):
        self.assertEqual(
            server.get_local_chat_api_url({"host": "localhost", "port": 8080}),
            "http://127.0.0.1:8080/v1/chat/completions",
        )

        with self.assertRaises(ValueError):
            server.get_local_chat_api_url({"host": "localhost", "port": 70000})


class StreamingTests(unittest.TestCase):
    def test_write_sse_formats_json_and_done_messages(self):
        output = io.BytesIO()

        server.write_sse(output, {"type": "status", "content": "hello"})
        server.write_sse(output, "[DONE]")

        self.assertEqual(
            output.getvalue().decode("utf-8"),
            'data: {"type": "status", "content": "hello"}\n\n'
            "data: [DONE]\n\n",
        )


class ImportSmokeTests(unittest.TestCase):
    def test_server_import_does_not_load_feature_optional_dependencies(self):
        script = (
            "import json, sys; "
            "import server; "
            "print(json.dumps({name: name in sys.modules for name in "
            "['huggingface_hub', 'ddgs', 'tkinter']}))"
        )

        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(server.BASE_DIR),
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
