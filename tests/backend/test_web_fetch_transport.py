"""Keep DNS policy, pinned connections, and HTTP parsing wired together."""

import contextlib
import io
import socket
import ssl
import unittest
from unittest import mock

from backend.services import web_search


class WebFetchTransportTests(unittest.TestCase):
    def response_socket(self, body, status="200 OK", headers=""):
        wire = (f"HTTP/1.1 {status}\r\nContent-Length: {len(body)}\r\n"
                f"{headers}\r\n").encode("ascii") + body
        sock = mock.Mock()
        sock.makefile.return_value = io.BytesIO(wire)
        return sock

    def test_http_and_https_fetch_use_validated_ip_and_original_request_target(self):
        for scheme, port in (("http", 8081), ("https", 443)):
            with self.subTest(scheme=scheme):
                address = ("93.184.216.34", port)
                addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", address)]
                sock = self.response_socket(
                    "<p>café</p><script>hidden</script>".encode("utf-8"),
                    headers="Content-Type: text/html; charset=utf-8\r\n",
                )
                tls = ssl.create_default_context()
                with mock.patch.object(web_search.socket, "getaddrinfo", side_effect=[addresses]) as dns, \
                        mock.patch.object(web_search.socket, "socket", return_value=sock), \
                        mock.patch.object(tls, "wrap_socket", return_value=sock) as wrap:
                    result = web_search.fetch_page_text(
                        f"{scheme}://example.com:{port}/page;params?q=hello#fragment",
                        timeout=7, ssl_context=tls,
                    )
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["text"], "café")
                dns.assert_called_once_with("example.com", port, type=socket.SOCK_STREAM)
                sock.connect.assert_called_once_with(address)
                sock.settimeout.assert_called_once_with(7)
                request = b"".join(call.args[0] for call in sock.sendall.call_args_list)
                self.assertIn(b"GET /page;params?q=hello HTTP/1.1\r\n", request)
                host = f"example.com:{port}" if scheme == "http" else "example.com"
                self.assertIn(f"Host: {host}\r\n".encode("ascii"), request)
                self.assertNotIn(b"fragment", request)
                sock.close.assert_called_once()
                if scheme == "https":
                    wrap.assert_called_once_with(sock, server_hostname="example.com")
                else:
                    wrap.assert_not_called()

    def test_transport_limits_response_bytes_and_closes_connection(self):
        sock = self.response_socket(b"abcdefghignored")
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))]
        with mock.patch.object(web_search.socket, "getaddrinfo", return_value=addresses), \
                mock.patch.object(web_search.socket, "socket", return_value=sock), \
                mock.patch.object(web_search.config, "WEB_SEARCH_FETCH_BYTES", 8):
            result = web_search.fetch_page_text("http://example.com")
        self.assertEqual(result["text"], "abcdefgh")
        sock.close.assert_called_once()

    def test_redirect_from_real_transport_is_revalidated_before_connecting(self):
        sock = self.response_socket(b"", status="302 Found", headers="Location: http://private.test/secret\r\n")
        addresses = [
            [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))],
            [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))],
        ]
        with mock.patch.object(web_search.socket, "getaddrinfo", side_effect=addresses) as dns, \
                mock.patch.object(web_search.socket, "socket", return_value=sock) as factory:
            result = web_search.fetch_page_text("http://example.com")
        self.assertFalse(result["ok"])
        self.assertIn("non-public", result["error"])
        self.assertEqual(dns.call_count, 2)
        factory.assert_called_once()
        sock.close.assert_called_once()

    def test_request_and_read_failures_close_connection_and_hide_transport_details(self):
        class InterruptedBody(io.BytesIO):
            def read(self, *args):
                raise OSError("private transport detail")

        for stage in ("request", "read"):
            with self.subTest(stage=stage):
                sock = self.response_socket(b"body")
                if stage == "request":
                    sock.sendall.side_effect = OSError("private transport detail")
                else:
                    sock.makefile.return_value = InterruptedBody(sock.makefile.return_value.getvalue())
                addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))]
                with mock.patch.object(web_search.socket, "getaddrinfo", return_value=addresses), \
                        mock.patch.object(web_search.socket, "socket", return_value=sock), \
                        contextlib.redirect_stderr(io.StringIO()) as errors:
                    result = web_search.fetch_page_text("http://example.com")
                self.assertFalse(result["ok"])
                self.assertNotIn("private transport detail", result["error"])
                self.assertIn("private transport detail", errors.getvalue())
                sock.close.assert_called_once()
