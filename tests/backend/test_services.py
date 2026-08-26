import contextlib
import hashlib
import io
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
import zipfile
from email.message import Message
from types import SimpleNamespace
from unittest import mock

from backend import config
from backend.context import AppContext, AppPaths, ServerConfig
from backend.services import chat as chat_service
from backend.services import external_server as external_server_service
from backend.services import file_picker as file_picker_service
from backend.services import hf_download as hf_service
from backend.services import llama_manager
from backend.services import local_llama_http
from backend.services import process_manager
from backend.services import tunnel as tunnel_service
from backend.services import web_search as web_search_service


class FakeDownloadResponse:
    def __init__(self, chunks, content_length=None):
        self._body = b"".join(chunks)
        self._offset = 0
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, size=-1):
        if self._offset >= len(self._body):
            return b""
        if size is None or size < 0:
            size = len(self._body) - self._offset
        end = min(self._offset + size, len(self._body))
        chunk = self._body[self._offset:end]
        self._offset = end
        return chunk


class FakeDownloadResponseTests(unittest.TestCase):
    def test_read_respects_requested_size(self):
        resp = FakeDownloadResponse([b"abc", b"def"])

        self.assertEqual(resp.read(2), b"ab")
        self.assertEqual(resp.read(3), b"cde")
        self.assertEqual(resp.read(10), b"f")
        self.assertEqual(resp.read(10), b"")


class LocalLlamaHttpTests(unittest.TestCase):
    @staticmethod
    def make_response(body, content_type=""):
        response = mock.MagicMock()
        response.read.return_value = body
        response.headers = Message()
        if content_type:
            response.headers["Content-Type"] = content_type
        response.__enter__.return_value = response
        return response

    def test_metrics_forwards_authorization_and_decodes_response_charset(self):
        response = self.make_response(
            "café".encode("iso-8859-1"),
            "text/plain; charset=iso-8859-1",
        )
        with (
            mock.patch.object(
                local_llama_http,
                "get_metrics_host",
                return_value=("127.0.0.1", ""),
            ),
            mock.patch.object(
                local_llama_http.urllib.request,
                "urlopen",
                return_value=response,
            ) as urlopen,
        ):
            text, error = local_llama_http.get_local_llama_metrics(
                "localhost", "9090", "Bearer secret"
            )

        self.assertEqual((text, error), ("café", ""))
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:9090/metrics")
        self.assertEqual(request.get_header("Accept"), "text/plain")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertEqual(urlopen.call_args.kwargs, {"timeout": 3})
        response.read.assert_called_once_with(config.WEB_SEARCH_FETCH_BYTES)

    def test_metrics_brackets_an_ipv6_host(self):
        response = self.make_response(b"metric 1")
        with (
            mock.patch.object(
                local_llama_http,
                "get_metrics_host",
                return_value=("::1", ""),
            ),
            mock.patch.object(
                local_llama_http.urllib.request,
                "urlopen",
                return_value=response,
            ) as urlopen,
        ):
            text, error = local_llama_http.get_local_llama_metrics("::1", 9090)

        self.assertEqual((text, error), ("metric 1", ""))
        self.assertEqual(
            urlopen.call_args.args[0].full_url,
            "http://[::1]:9090/metrics",
        )

    def test_chat_url_brackets_an_ipv6_host(self):
        with mock.patch.object(
            chat_service, "get_local_proxy_host", return_value=("::1", "")
        ):
            url = chat_service.get_local_chat_api_url({"host": "::1", "port": 8080})

        self.assertEqual(url, "http://[::1]:8080/v1/chat/completions")

    def test_slots_uses_json_accept_header_and_utf8_fallback(self):
        response = self.make_response('[{"id":0}]'.encode("utf-8"))
        with (
            mock.patch.object(
                local_llama_http,
                "get_metrics_host",
                return_value=("127.0.0.1", ""),
            ),
            mock.patch.object(
                local_llama_http.urllib.request,
                "urlopen",
                return_value=response,
            ) as urlopen,
        ):
            text, error = local_llama_http.get_local_llama_slots(
                "127.0.0.1", 8080
            )

        self.assertEqual((text, error), ('[{"id":0}]', ""))
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8080/slots")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertIsNone(request.get_header("Authorization"))

    def test_app_delegates_and_default_service_wiring_are_preserved(self):
        from backend import app

        self.assertTrue(callable(AppContext().services.get_local_llama_props))
        self.assertIs(
            app.APP_CONTEXT.services.get_local_llama_metrics,
            app.get_local_llama_metrics,
        )
        self.assertIs(
            app.APP_CONTEXT.services.get_local_llama_props,
            app.get_local_llama_props,
        )
        self.assertIs(
            app.APP_CONTEXT.services.get_local_llama_slots,
            app.get_local_llama_slots,
        )
        with (
            mock.patch.object(
                local_llama_http,
                "get_local_llama_metrics",
                return_value=("metrics", ""),
            ) as get_metrics,
            mock.patch.object(
                local_llama_http,
                "get_local_llama_slots",
                return_value=("slots", ""),
            ) as get_slots,
            mock.patch.object(
                local_llama_http,
                "get_local_llama_props",
                return_value=("props", ""),
            ) as get_props,
        ):
            self.assertEqual(
                app.get_local_llama_metrics("localhost", 8080, "Bearer key"),
                ("metrics", ""),
            )
            self.assertEqual(
                app.get_local_llama_slots("localhost", 8080, "Bearer key"),
                ("slots", ""),
            )
            self.assertEqual(
                app.get_local_llama_props("localhost", 8080, "Bearer key"),
                ("props", ""),
            )

        get_metrics.assert_called_once_with("localhost", 8080, "Bearer key")
        get_slots.assert_called_once_with("localhost", 8080, "Bearer key")
        get_props.assert_called_once_with("localhost", 8080, "Bearer key")

    def test_endpoint_specific_port_errors_are_preserved(self):
        cases = (
            (local_llama_http.get_local_llama_metrics, "metrics"),
            (local_llama_http.get_local_llama_slots, "slots"),
        )
        for fetch, label in cases:
            for port in ("invalid", "0", "65536"):
                with self.subTest(label=label, port=port):
                    self.assertEqual(
                        fetch("localhost", port),
                        (None, f"Invalid llama-server {label} port."),
                    )

    def test_host_validation_error_is_returned_without_fetching(self):
        with (
            mock.patch.object(
                local_llama_http,
                "get_metrics_host",
                return_value=("", "Blocked local host."),
            ),
            mock.patch.object(
                local_llama_http.urllib.request,
                "urlopen",
            ) as urlopen,
        ):
            result = local_llama_http.get_local_llama_slots("remote", 8080)

        self.assertEqual(result, (None, "Blocked local host."))
        urlopen.assert_not_called()

    def test_endpoint_specific_http_errors_are_preserved(self):
        cases = (
            (local_llama_http.get_local_llama_metrics, "metrics"),
            (local_llama_http.get_local_llama_slots, "slots"),
        )
        for fetch, label in cases:
            with self.subTest(label=label):
                error_body = io.BytesIO(b"unavailable")
                error = urllib.error.HTTPError(
                    "http://127.0.0.1:8080/endpoint",
                    503,
                    "Unavailable",
                    None,
                    error_body,
                )
                with (
                    mock.patch.object(
                        local_llama_http,
                        "get_metrics_host",
                        return_value=("127.0.0.1", ""),
                    ),
                    mock.patch.object(
                        local_llama_http.urllib.request,
                        "urlopen",
                        side_effect=error,
                    ),
                ):
                    result = fetch("localhost", 8080)

                self.assertEqual(
                    result,
                    (None, f"llama-server {label} returned HTTP 503."),
                )
                self.assertTrue(error_body.closed)

    def test_endpoint_specific_network_errors_are_preserved(self):
        cases = (
            (local_llama_http.get_local_llama_metrics, "metrics"),
            (local_llama_http.get_local_llama_slots, "slots"),
        )
        for fetch, label in cases:
            with self.subTest(label=label):
                with (
                    mock.patch.object(
                        local_llama_http,
                        "get_metrics_host",
                        return_value=("127.0.0.1", ""),
                    ),
                    mock.patch.object(
                        local_llama_http.urllib.request,
                        "urlopen",
                        side_effect=OSError("offline"),
                    ),
                ):
                    result = fetch("localhost", 8080)

                self.assertEqual(
                    result,
                    (None, f"Failed to fetch llama-server {label}: offline"),
                )


def make_service_context(root):
    root = pathlib.Path(root)
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
            app_logo=root / "Llama-GUI Logo.png",
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


class BuildBackendSpecsTests(unittest.TestCase):
    def test_win32_x64_returns_cuda_vulkan_sycl_rocm_backends(self):
        specs = llama_manager.build_backend_specs("win32", "x64")

        self.assertIn("cpu", specs)
        self.assertIn("cuda-12.4", specs)
        self.assertIn("cuda-13.3", specs)
        self.assertNotIn("cuda-13.1", specs)
        self.assertIn("vulkan", specs)
        self.assertIn("sycl", specs)
        self.assertIn("hip", specs)
        self.assertIn("openvino", specs)
        self.assertEqual(specs["cpu"]["label"], "CPU")
        self.assertIn("win-cpu-x64", specs["cpu"]["asset"])
        self.assertEqual(specs["hip"]["label"], "ROCm 7.14 (AMD, Official)")
        self.assertEqual(
            specs["hip"]["asset"],
            "llama-{tag}-bin-win-rocm-7.14-x64.zip",
        )
        self.assertIn("openvino-2026.2.1", specs["openvino"]["asset"])

    def test_win32_arm64_returns_cpu_and_opencl_adreno(self):
        specs = llama_manager.build_backend_specs("win32", "arm64")

        self.assertIn("cpu", specs)
        self.assertIn("opencl-adreno", specs)
        self.assertNotIn("cuda-12.4", specs)
        self.assertIn("win-cpu-arm64", specs["cpu"]["asset"])

    def test_darwin_arm64_returns_metal_backends(self):
        specs = llama_manager.build_backend_specs("darwin", "arm64")

        self.assertIn("metal", specs)
        self.assertNotIn("metal-kleidiai", specs)
        self.assertNotIn("cpu", specs)

    def test_darwin_x64_returns_cpu_only(self):
        specs = llama_manager.build_backend_specs("darwin", "x64")

        self.assertEqual(list(specs.keys()), ["cpu", "custom"])
        self.assertIn("macos-x64", specs["cpu"]["asset"])

    def test_darwin_unknown_arch_returns_empty(self):
        specs = llama_manager.build_backend_specs("darwin", "ppc64")

        self.assertEqual(specs, {"custom": {"label": "Custom (User-Provided)"}})

    def test_linux_x64_returns_cpu_vulkan_rocm_openvino(self):
        specs = llama_manager.build_backend_specs("linux", "x64")

        self.assertIn("cpu", specs)
        self.assertIn("vulkan", specs)
        self.assertIn("rocm", specs)
        self.assertIn("openvino", specs)
        self.assertEqual(specs["rocm"]["label"], "ROCm 7.14 (AMD, Official)")
        self.assertEqual(
            specs["rocm"]["asset"],
            "llama-{tag}-bin-ubuntu-rocm-7.14-x64.tar.gz",
        )
        self.assertIn("openvino-2026.2.1", specs["openvino"]["asset"])

    def test_linux_arm64_returns_cpu_and_vulkan(self):
        specs = llama_manager.build_backend_specs("linux", "arm64")

        self.assertIn("cpu", specs)
        self.assertIn("vulkan", specs)
        self.assertNotIn("rocm", specs)

    def test_linux_s390x_returns_cpu_only(self):
        specs = llama_manager.build_backend_specs("linux", "s390x")

        self.assertEqual(list(specs.keys()), ["cpu", "custom"])
        self.assertIn("s390x", specs["cpu"]["asset"])

    def test_linux_unknown_arch_returns_empty(self):
        specs = llama_manager.build_backend_specs("linux", "riscv64")

        self.assertEqual(specs, {"custom": {"label": "Custom (User-Provided)"}})

    def test_unknown_platform_returns_empty(self):
        specs = llama_manager.build_backend_specs("freebsd", "x64")

        self.assertEqual(specs, {"custom": {"label": "Custom (User-Provided)"}})

    def test_custom_backend_available_without_prebuilt_backend(self):
        specs = llama_manager.build_backend_specs("plan9", "weird64")

        self.assertEqual(list(specs.keys()), ["custom"])

    def test_asset_patterns_contain_tag_placeholder(self):
        for platform_name, arch in [("win32", "x64"), ("darwin", "arm64"), ("linux", "x64")]:
            with self.subTest(platform=platform_name, arch=arch):
                specs = llama_manager.build_backend_specs(platform_name, arch)
                for backend_id, spec in specs.items():
                    if "asset" not in spec:
                        continue
                    self.assertIn("{tag}", spec["asset"], f"{backend_id} missing {{tag}}")

    def test_cuda_backends_have_extra_assets(self):
        specs = llama_manager.build_backend_specs("win32", "x64")

        self.assertIn("extra_assets", specs["cuda-12.4"])
        self.assertIn("extra_assets", specs["cuda-13.3"])
        self.assertEqual(len(specs["cuda-12.4"]["extra_assets"]), 1)
        self.assertEqual(len(specs["cuda-13.3"]["extra_assets"]), 1)
        self.assertIn("cuda-13.3", specs["cuda-13.3"]["asset"])
        self.assertIn("cuda-13.3", specs["cuda-13.3"]["extra_assets"][0])

    def test_win32_x64_includes_all_lemonade_rocm_targets(self):
        specs = llama_manager.build_backend_specs("win32", "x64")

        for gpu in ["gfx103X", "gfx110X", "gfx1150", "gfx1151", "gfx120X", "gfx90a", "gfx908"]:
            with self.subTest(gpu=gpu):
                self.assertIn(f"lemonade-rocm-{gpu}", specs)

    def test_linux_x64_includes_all_lemonade_rocm_targets(self):
        specs = llama_manager.build_backend_specs("linux", "x64")

        for gpu in ["gfx103X", "gfx110X", "gfx1150", "gfx1151", "gfx120X", "gfx90a", "gfx908"]:
            with self.subTest(gpu=gpu):
                self.assertIn(f"lemonade-rocm-{gpu}", specs)

    def test_lemonade_rocm_absent_on_unsupported_platforms(self):
        for platform_name, arch in [
            ("win32", "arm64"),
            ("darwin", "arm64"),
            ("darwin", "x64"),
            ("linux", "arm64"),
            ("linux", "s390x"),
        ]:
            with self.subTest(platform=platform_name, arch=arch):
                specs = llama_manager.build_backend_specs(platform_name, arch)
                self.assertFalse(
                    any(key.startswith("lemonade-rocm-") for key in specs),
                    f"unexpected lemonade backend on {platform_name}/{arch}",
                )

    def test_lemonade_specs_carry_provider_repo_api_preserve_paths_and_gpu_target(self):
        specs = llama_manager.build_backend_specs("win32", "x64")

        spec = specs["lemonade-rocm-gfx110X"]
        self.assertEqual(spec["provider"], "lemonade-rocm")
        self.assertEqual(spec["repo_api"], llama_manager.LEMONADE_ROCM_REPO_API)
        self.assertIs(spec["preserve_paths"], True)
        self.assertEqual(spec["gpu_target"], "gfx110X")
        self.assertIn("{tag}", spec["asset"])

    def test_lemonade_windows_and_linux_asset_patterns_match_upstream(self):
        win = llama_manager.build_backend_specs("win32", "x64")
        lin = llama_manager.build_backend_specs("linux", "x64")

        self.assertEqual(
            win["lemonade-rocm-gfx110X"]["asset"],
            "llama-{tag}-windows-rocm-gfx110X-x64.zip",
        )
        self.assertEqual(
            lin["lemonade-rocm-gfx110X"]["asset"],
            "llama-{tag}-ubuntu-rocm-gfx110X-x64.zip",
        )
        self.assertEqual(
            win["lemonade-rocm-gfx110X"]["asset"].format(tag="b1294"),
            "llama-b1294-windows-rocm-gfx110X-x64.zip",
        )

    def test_official_specs_do_not_carry_repo_api_or_preserve_paths(self):
        specs = llama_manager.build_backend_specs("win32", "x64")

        self.assertNotIn("repo_api", specs["cpu"])
        self.assertNotIn("preserve_paths", specs["cpu"])
        self.assertNotIn("asset", specs["custom"])


class ActivateCustomBackendTests(unittest.TestCase):
    def test_requires_cli_and_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.llama_tools = ["llama-cli", "llama-server", "llama-bench"]
            ctx.services.current_platform = "win32"
            ctx.services.get_tool_filename = lambda tool: f"{tool}.exe"
            ctx.services.load_config = lambda: {"tag": None, "backend": None}
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            (ctx.paths.llama_custom_bin / "llama-cli.exe").write_text("")

            result = llama_manager.activate_custom_backend(ctx)

            self.assertFalse(result["ok"])
            self.assertEqual(result["missing_required"], ["llama-server.exe"])
            ctx.services.save_config.assert_not_called()

    def test_saves_config_when_core_tools_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.llama_tools = ["llama-cli", "llama-server", "llama-bench"]
            ctx.services.current_platform = "win32"
            ctx.services.get_tool_filename = lambda tool: f"{tool}.exe"
            ctx.services.load_config = lambda: {"tag": None, "backend": None}
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            (ctx.paths.llama_custom_bin / "llama-cli.exe").write_text("")
            (ctx.paths.llama_custom_bin / "llama-server.exe").write_text("")

            result = llama_manager.activate_custom_backend(ctx)

            self.assertTrue(result["ok"])
            self.assertEqual(result["missing_required"], [])
            ctx.services.save_config.assert_called_once_with(
                {"tag": "custom", "backend": "custom", "version": "custom"}
            )

    def test_preserves_official_install_when_custom_is_activated(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.llama_tools = ["llama-cli", "llama-server"]
            ctx.services.current_platform = "win32"
            ctx.services.get_tool_filename = lambda tool: f"{tool}.exe"
            ctx.services.load_config = lambda: {
                "tag": "b10502",
                "backend": "vulkan",
                "version": "Build 10502",
            }
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            for tool in ("llama-cli", "llama-server"):
                (ctx.paths.llama_custom_bin / f"{tool}.exe").write_text("")

            result = llama_manager.activate_custom_backend(ctx)

            self.assertTrue(result["ok"])
            ctx.services.save_config.assert_called_once_with(
                {
                    "tag": "custom",
                    "backend": "custom",
                    "version": "custom",
                    "official_install": {
                        "backend": "vulkan",
                        "tag": "b10502",
                        "version": "Build 10502",
                    },
                }
            )

    def test_activates_preserved_official_install_without_downloading(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "win32"
            ctx.services.get_tool_filename = lambda tool: f"{tool}.exe"
            store = {
                "backend": "custom",
                "tag": "custom",
                "version": "custom",
                "official_install": {
                    "backend": "vulkan",
                    "tag": "b10502",
                    "version": "Build 10502",
                },
            }
            ctx.services.load_config = lambda: dict(store)
            ctx.services.save_config = lambda cfg: (store.clear(), store.update(cfg))
            ctx.paths.llama_bin.mkdir(parents=True)
            for tool in ("llama-cli", "llama-server"):
                (ctx.paths.llama_bin / f"{tool}.exe").write_text("")

            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="version: 0.1.2-dev (build 10502, commit abc)",
                stderr="",
            )
            with mock.patch.object(llama_manager.subprocess, "run", return_value=completed):
                result = llama_manager.activate_official_backend(ctx, "vulkan")

            self.assertEqual(
                result,
                {
                    "ok": True,
                    "backend": "vulkan",
                    "tag": "b10502",
                    "version": "Build 10502",
                },
            )
            self.assertEqual(store["backend"], "vulkan")
            self.assertEqual(store["tag"], "b10502")

    def test_rejects_preserved_official_install_when_binary_cannot_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "win32"
            ctx.services.get_tool_filename = lambda tool: f"{tool}.exe"
            store = {
                "backend": "custom",
                "tag": "custom",
                "version": "custom",
                "official_install": {
                    "backend": "vulkan",
                    "tag": "b10502",
                    "version": "Build 10502",
                },
            }
            ctx.services.load_config = lambda: dict(store)
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_bin.mkdir(parents=True)
            for tool in ("llama-cli", "llama-server"):
                (ctx.paths.llama_bin / f"{tool}.exe").write_text("")

            completed = subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="missing runtime library"
            )
            with mock.patch.object(llama_manager.subprocess, "run", return_value=completed):
                result = llama_manager.activate_official_backend(ctx, "vulkan")

            self.assertFalse(result["ok"])
            self.assertIn("could not be started", result["error"])
            ctx.services.save_config.assert_not_called()
            self.assertEqual(store["backend"], "custom")

    def test_legacy_official_install_recovers_tag_from_binary_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "win32"
            ctx.services.get_tool_filename = lambda tool: f"{tool}.exe"
            store = {"backend": "custom", "tag": "custom", "version": "custom"}
            ctx.services.load_config = lambda: dict(store)
            ctx.services.save_config = lambda cfg: (store.clear(), store.update(cfg))
            ctx.paths.llama_bin.mkdir(parents=True)
            for tool in ("llama-cli", "llama-server"):
                (ctx.paths.llama_bin / f"{tool}.exe").write_text("")

            completed = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="version: 0.1.2-dev (build 10502, commit abc)",
                stderr="",
            )
            with mock.patch.object(llama_manager.subprocess, "run", return_value=completed):
                result = llama_manager.activate_official_backend(ctx, "vulkan")

            self.assertTrue(result["ok"])
            self.assertEqual(result["tag"], "b10502")
            self.assertEqual(store["official_install"]["backend"], "vulkan")

    def test_rejects_non_executable_core_tools_on_unix(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.llama_tools = ["llama-cli", "llama-server"]
            ctx.services.current_platform = "linux"
            ctx.services.get_tool_filename = lambda tool: tool
            ctx.services.load_config = lambda: {"tag": None, "backend": None}
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            (ctx.paths.llama_custom_bin / "llama-cli").write_text("")
            (ctx.paths.llama_custom_bin / "llama-server").write_text("")

            with mock.patch.object(llama_manager.os, "access", return_value=False):
                result = llama_manager.activate_custom_backend(ctx)

            self.assertFalse(result["ok"])
            self.assertEqual(result["missing_required"], [])
            self.assertEqual(result["not_executable"], ["llama-cli", "llama-server"])
            ctx.services.save_config.assert_not_called()

    def test_rejects_custom_backend_when_runtime_library_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.llama_tools = ["llama-cli", "llama-server"]
            ctx.services.current_platform = "darwin"
            ctx.services.get_tool_filename = lambda tool: tool
            ctx.services.load_config = lambda: {"tag": None, "backend": None}
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            for tool in ("llama-cli", "llama-server"):
                tool_path = ctx.paths.llama_custom_bin / tool
                tool_path.write_text("")
                tool_path.chmod(0o755)

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=["libllama-common.0.dylib"],
            ):
                result = llama_manager.activate_custom_backend(ctx)

            self.assertFalse(result["ok"])
            self.assertEqual(result["missing_required"], [])
            self.assertEqual(result["not_executable"], [])
            self.assertEqual(result["missing_runtime_files"], ["libllama-common.0.dylib"])
            ctx.services.save_config.assert_not_called()

    def test_rejects_linux_custom_backend_when_shared_library_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.llama_tools = ["llama-cli", "llama-server"]
            ctx.services.current_platform = "linux"
            ctx.services.get_tool_filename = lambda tool: tool
            ctx.services.load_config = lambda: {"tag": None, "backend": None}
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            for tool in ("llama-cli", "llama-server"):
                tool_path = ctx.paths.llama_custom_bin / tool
                tool_path.write_text("binary")
                tool_path.chmod(0o755)

            with mock.patch.object(
                llama_manager,
                "get_linux_missing_libraries",
                return_value=["libamdhip64.so.7"],
            ):
                result = llama_manager.activate_custom_backend(ctx)

            self.assertFalse(result["ok"])
            self.assertEqual(result["missing_required"], [])
            self.assertEqual(result["not_executable"], [])
            self.assertEqual(result["missing_runtime_files"], ["libamdhip64.so.7"])
            ctx.services.save_config.assert_not_called()


class ResolveRepoApiTests(unittest.TestCase):
    def test_returns_spec_repo_api_for_lemonade(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            spec = {"repo_api": llama_manager.LEMONADE_ROCM_REPO_API}

            self.assertEqual(
                llama_manager.resolve_repo_api(spec, ctx),
                llama_manager.LEMONADE_ROCM_REPO_API,
            )

    def test_falls_back_to_config_github_api_for_official(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            spec = {"label": "CPU"}

            self.assertEqual(
                llama_manager.resolve_repo_api(spec, ctx), ctx.config.github_api
            )

class NormalizeArchTests(unittest.TestCase):
    def test_amd64_maps_to_x64(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("amd64"), "x64")

    def test_x86_64_maps_to_x64(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("x86_64"), "x64")

    def test_arm64_maps_to_arm64(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("arm64"), "arm64")

    def test_aarch64_maps_to_arm64(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("aarch64"), "arm64")

    def test_armv8l_maps_to_arm64(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("armv8l"), "arm64")

    def test_unknown_arch_preserved_lowercase(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("riscv64"), "riscv64")

    def test_empty_string_returns_unknown(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch(""), "unknown")
        self.assertEqual(normalize_arch(None), "unknown")

    def test_case_insensitive(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("AMD64"), "x64")
        self.assertEqual(normalize_arch("AARCH64"), "arm64")

    def test_whitespace_stripped(self):
        from backend.app import normalize_arch

        self.assertEqual(normalize_arch("  amd64  "), "x64")


class GetToolFilenameTests(unittest.TestCase):
    def test_appends_exe_suffix_on_windows(self):
        with mock.patch("backend.app.BINARY_SUFFIX", ".exe"):
            from backend.app import get_tool_filename

            self.assertEqual(get_tool_filename("llama-server"), "llama-server.exe")

    def test_no_suffix_on_unix(self):
        with mock.patch("backend.app.BINARY_SUFFIX", ""):
            from backend.app import get_tool_filename

            self.assertEqual(get_tool_filename("llama-server"), "llama-server")


class FindToolExecutableTests(unittest.TestCase):
    def test_returns_path_in_llama_bin_dir(self):
        from backend.app import find_tool_executable, LLAMA_BIN_DIR, BINARY_SUFFIX

        result = find_tool_executable("llama-server")

        self.assertEqual(result, LLAMA_BIN_DIR / f"llama-server{BINARY_SUFFIX}")


class Sha256FileTests(unittest.TestCase):
    def test_returns_correct_hash(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as f:
            f.write(b"hello world")
            tmppath = pathlib.Path(f.name)

        try:
            expected = hashlib.sha256(b"hello world").hexdigest()
            self.assertEqual(llama_manager.sha256_file(tmppath), expected)
        finally:
            tmppath.unlink()

    def test_handles_large_files(self):
        data = b"x" * 200_000
        with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as f:
            f.write(data)
            tmppath = pathlib.Path(f.name)

        try:
            expected = hashlib.sha256(data).hexdigest()
            self.assertEqual(llama_manager.sha256_file(tmppath), expected)
        finally:
            tmppath.unlink()


class RuntimeDependencyValidationTests(unittest.TestCase):
    def make_runtime_context(self, tmpdir, platform_name="darwin"):
        from backend.context import AppContext, AppPaths, BackendServices

        root = pathlib.Path(tmpdir)
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
            )
        )
        ctx.paths.llama_bin.mkdir(parents=True)
        ctx.services = BackendServices(
            current_platform=platform_name,
            find_tool_executable=lambda tool: ctx.paths.llama_bin / tool,
            get_tool_filename=lambda tool: tool,
            load_config=lambda: {"backend": "cpu"},
        )
        return ctx

    def test_parse_otool_rpath_libraries_ignores_system_libraries(self):
        output = """
/tmp/llama/bin/llama-server:
    @rpath/libllama-common.0.dylib (compatibility version 0.0.0, current version 0.0.0)
    /usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1336.0.0)
    @rpath/libllama-common.0.dylib (compatibility version 0.0.0, current version 0.0.0)
"""

        self.assertEqual(
            llama_manager.parse_otool_rpath_libraries(output),
            ["libllama-common.0.dylib"],
        )

    def test_parse_ldd_missing_libraries_returns_unique_basenames(self):
        output = """
        libggml-vulkan.so => /tmp/llama/bin/libggml-vulkan.so (0x00007f00)
        libvulkan.so.1 => not found
        /opt/rocm/lib/libamdhip64.so.7 => not found
        libvulkan.so.1 => not found
        libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f01)
"""

        self.assertEqual(
            llama_manager.parse_ldd_missing_libraries(output),
            ["libvulkan.so.1", "libamdhip64.so.7"],
        )

    def test_get_linux_missing_libraries_uses_local_runtime_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            executable = root / "llama-server"
            completed = subprocess.CompletedProcess(
                ["ldd", str(executable)],
                0,
                stdout="libvulkan.so.1 => not found\n",
                stderr="",
            )

            with mock.patch.object(
                llama_manager.subprocess, "run", return_value=completed
            ) as run:
                missing = llama_manager.get_linux_missing_libraries(executable, root)

        self.assertEqual(missing, ["libvulkan.so.1"])
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["LD_LIBRARY_PATH"].split(os.pathsep)[0], str(root))
        self.assertEqual(env["PATH"].split(os.pathsep)[0], str(root))

    def test_validate_macos_runtime_dependencies_passes_when_dylib_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")
            (ctx.paths.llama_bin / "libllama-common.0.dylib").write_text("lib")

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=["libllama-common.0.dylib"],
            ):
                result = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertTrue(result["ok"])
        self.assertEqual(result["missing_runtime_files"], [])
        self.assertEqual(result["required_runtime_files"], ["libllama-common.0.dylib"])

    def test_validate_macos_runtime_dependencies_reports_missing_dylib(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=["libllama-common.0.dylib"],
            ):
                result = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing_runtime_files"], ["libllama-common.0.dylib"])

    def test_validate_linux_runtime_dependencies_reports_missing_so(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp, "linux")
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager,
                "get_linux_missing_libraries",
                return_value=["libvulkan.so.1"],
            ) as probe:
                result = llama_manager.validate_runtime_dependencies(
                    ctx, ["llama-server"]
                )

        self.assertFalse(result["ok"])
        self.assertTrue(result["checked"])
        self.assertEqual(result["missing_runtime_files"], ["libvulkan.so.1"])
        probe.assert_called_once_with(
            ctx.paths.llama_bin / "llama-server", ctx.paths.llama_bin
        )

    def test_validate_linux_runtime_dependencies_checks_backend_plugins(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp, "linux")
            executable = ctx.paths.llama_bin / "llama-server"
            plugin = ctx.paths.llama_bin / "libggml-vulkan.so"
            executable.write_text("binary")
            plugin.write_text("library")

            def inspect(path, _runtime_dir):
                return ["libvulkan.so.1"] if path == plugin else []

            with mock.patch.object(
                llama_manager,
                "get_linux_missing_libraries",
                side_effect=inspect,
            ) as probe:
                result = llama_manager.validate_runtime_dependencies(
                    ctx, ["llama-server"]
                )

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing_runtime_files"], ["libvulkan.so.1"])
        self.assertEqual(result["checked_runtime_files"], ["libggml-vulkan.so"])
        self.assertEqual(
            probe.call_args_list,
            [
                mock.call(executable, ctx.paths.llama_bin),
                mock.call(plugin, ctx.paths.llama_bin),
            ],
        )

    def test_validate_linux_runtime_dependencies_degrades_without_ldd(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp, "linux")
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager,
                "get_linux_missing_libraries",
                side_effect=FileNotFoundError(),
            ):
                result = llama_manager.validate_runtime_dependencies(
                    ctx, ["llama-server"]
                )

        self.assertTrue(result["ok"])
        self.assertFalse(result["checked"])
        self.assertEqual(result["unchecked_tools"], ["llama-server"])

    def test_validate_macos_custom_runtime_checks_custom_bin_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            ctx.paths.llama_custom_bin.mkdir(parents=True)
            ctx.services.find_tool_executable = lambda tool: ctx.paths.llama_custom_bin / tool
            ctx.services.load_config = lambda: {"backend": "custom"}
            (ctx.paths.llama_custom_bin / "llama-server").write_text("binary")
            (ctx.paths.llama_bin / "libllama-common.0.dylib").write_text("official lib")

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=["libllama-common.0.dylib"],
            ):
                result = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing_runtime_files"], ["libllama-common.0.dylib"])

    def test_validate_macos_runtime_dependencies_degrades_when_otool_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                side_effect=FileNotFoundError(),
            ):
                result = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertTrue(result["ok"])
        self.assertFalse(result["checked"])
        self.assertEqual(result["unchecked_tools"], ["llama-server"])

    def test_validate_macos_runtime_dependencies_caches_repeat_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")
            (ctx.paths.llama_bin / "libllama-common.0.dylib").write_text("lib")

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=["libllama-common.0.dylib"],
            ) as probe:
                first = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
                second = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertEqual(probe.call_count, 1)
        self.assertEqual(first, second)

    def test_validate_macos_runtime_cache_expires_after_ttl(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager, "RUNTIME_HEALTH_CACHE_TTL_SECONDS", 0.0
            ), mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=[],
            ) as probe:
                llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
                llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertEqual(probe.call_count, 2)

    def test_validate_macos_runtime_cache_cleared_by_invalidation(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=[],
            ) as probe:
                llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
                ctx.state.clear_runtime_health_cache()
                llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertEqual(probe.call_count, 2)

    def test_validate_macos_runtime_cache_keyed_by_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager,
                "get_macos_rpath_libraries",
                return_value=[],
            ) as probe:
                llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
                ctx.services.load_config = lambda: {"backend": "custom"}
                llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])

        self.assertEqual(probe.call_count, 2)

    def test_remove_llama_files_clears_runtime_health_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.make_runtime_context(tmp)
            ctx.services.save_config = lambda cfg: None
            ctx.state.runtime_health_cache[("cpu", ("llama-server",))] = (0.0, {"ok": True})

            process_manager.remove_llama_files(ctx)

        self.assertEqual(ctx.state.runtime_health_cache, {})


class FakeLaunchedProcess:
    def __init__(self, returncode=None):
        self.returncode = returncode
        self.signals = []
        self.killed = False
        self.stdin = None

    def poll(self):
        return self.returncode

    def send_signal(self, sig):
        self.signals.append(sig)
        if self.returncode is None:
            self.returncode = 0

    def terminate(self):
        self.send_signal("terminate")

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


class ProcessStateReapTests(unittest.TestCase):
    def make_exited_context(self, exit_code):
        ctx = AppContext()
        ctx.state.process = FakeLaunchedProcess(returncode=exit_code)
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_llama_api_keys = ("launch-secret",)
        ctx.state.active_runtime = {"generation": 1, "tool": "llama-server"}
        ctx.state.runtime_generation = 1
        return ctx

    def test_is_process_running_reaps_naturally_exited_process(self):
        ctx = self.make_exited_context(3)

        self.assertFalse(process_manager.is_process_running(ctx))

        self.assertIsNone(ctx.state.process)
        self.assertIsNone(ctx.state.active_process_tool)
        self.assertEqual(ctx.state.active_llama_api_keys, ())
        self.assertIsNone(ctx.state.active_runtime)
        self.assertEqual(ctx.state.last_exit_code, 3)

    def test_stop_process_reaps_naturally_exited_process(self):
        ctx = self.make_exited_context(1)

        self.assertFalse(process_manager.stop_process(ctx))

        self.assertIsNone(ctx.state.process)
        self.assertIsNone(ctx.state.active_process_tool)
        self.assertEqual(ctx.state.active_llama_api_keys, ())
        self.assertIsNone(ctx.state.active_runtime)
        self.assertEqual(ctx.state.last_exit_code, 1)

    def test_stop_process_clears_state_for_running_process(self):
        ctx = AppContext()
        process = FakeLaunchedProcess(returncode=None)
        ctx.state.process = process
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_llama_api_keys = ("launch-secret",)
        ctx.state.active_runtime = {"generation": 1, "tool": "llama-server"}

        self.assertTrue(process_manager.stop_process(ctx))

        self.assertEqual(len(process.signals), 1)
        self.assertIsNone(ctx.state.process)
        self.assertIsNone(ctx.state.active_process_tool)
        self.assertEqual(ctx.state.active_llama_api_keys, ())
        self.assertIsNone(ctx.state.active_runtime)
        self.assertEqual(ctx.state.last_exit_code, 0)

    def test_stop_process_keeps_state_when_process_survives_kill(self):
        class UnkillableProcess(FakeLaunchedProcess):
            pid = 4242

            def send_signal(self, sig):
                self.signals.append(sig)

            def terminate(self):
                self.send_signal("terminate")

            def wait(self, timeout=None):
                raise subprocess.TimeoutExpired(cmd="llama-server", timeout=timeout)

        ctx = AppContext()
        process = UnkillableProcess(returncode=None)
        process.kill = lambda: None
        ctx.state.process = process
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_runtime = {"generation": 1, "tool": "llama-server"}
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            stopped = process_manager.stop_process(ctx)

        self.assertFalse(stopped)
        self.assertIs(ctx.state.process, process)
        self.assertEqual(ctx.state.active_process_tool, "llama-server")
        self.assertEqual(ctx.state.active_runtime, {"generation": 1, "tool": "llama-server"})
        self.assertIn("survived kill", stderr.getvalue())

    def test_generation_bound_stop_refuses_stale_request_before_signaling(self):
        ctx = AppContext()
        process = FakeLaunchedProcess(returncode=None)
        ctx.state.process = process
        ctx.state.active_process_tool = "llama-server"
        ctx.state.runtime_generation = 2
        ctx.state.active_runtime = {"generation": 2, "tool": "llama-server"}

        result = process_manager.stop_process_for_generation(ctx, 1)

        self.assertFalse(result["stopped"])
        self.assertEqual(result["state"], "superseded")
        self.assertEqual(result["generation"], 2)
        self.assertEqual(process.signals, [])
        self.assertIs(ctx.state.process, process)

    def test_generation_bound_stop_signals_matching_runtime_atomically(self):
        ctx = AppContext()
        process = FakeLaunchedProcess(returncode=None)
        ctx.state.process = process
        ctx.state.active_process_tool = "llama-server"
        ctx.state.runtime_generation = 3
        ctx.state.active_runtime = {"generation": 3, "tool": "llama-server"}

        result = process_manager.stop_process_for_generation(ctx, "3")

        self.assertTrue(result["stopped"])
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["generation"], 3)
        self.assertEqual(len(process.signals), 1)
        self.assertIsNone(ctx.state.process)
        self.assertIsNone(ctx.state.active_runtime)

    def test_generation_bound_stop_rejects_invalid_generation_without_signaling(self):
        ctx = AppContext()
        process = FakeLaunchedProcess(returncode=None)
        ctx.state.process = process
        ctx.state.active_process_tool = "llama-server"
        ctx.state.runtime_generation = 1
        ctx.state.active_runtime = {"generation": 1, "tool": "llama-server"}

        for invalid in (None, True, 0, -1, "1.0", "not-a-generation"):
            with self.subTest(invalid=invalid):
                result = process_manager.stop_process_for_generation(ctx, invalid)
                self.assertFalse(result["stopped"])
                self.assertEqual(result["state"], "error")
                self.assertEqual(process.signals, [])
                self.assertIs(ctx.state.process, process)

    def test_send_input_reaps_naturally_exited_process(self):
        ctx = self.make_exited_context(0)

        self.assertFalse(process_manager.send_input(ctx, "hello"))

        self.assertIsNone(ctx.state.process)
        self.assertIsNone(ctx.state.active_process_tool)
        self.assertEqual(ctx.state.last_exit_code, 0)

    def test_is_process_running_true_for_live_process(self):
        ctx = AppContext()
        ctx.state.process = FakeLaunchedProcess(returncode=None)
        ctx.state.active_process_tool = "llama-cli"

        self.assertTrue(process_manager.is_process_running(ctx))

        self.assertIsNotNone(ctx.state.process)
        self.assertEqual(ctx.state.active_process_tool, "llama-cli")

    def test_launch_process_refuses_while_install_owns_the_runtime_files(self):
        ctx = AppContext()
        with ctx.state.install_lock:
            ctx.state.install_in_progress = True

        with mock.patch.object(process_manager.subprocess, "Popen") as popen:
            result = process_manager.launch_process(ctx, "llama-server", [])

        self.assertIn("Installation in progress", result["error"])
        popen.assert_not_called()

    def test_active_llama_authorization_uses_launch_snapshot_and_safe_fallback(self):
        ctx = AppContext()
        ctx.state.process = FakeLaunchedProcess(returncode=None)
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_llama_api_keys = ("launch-key", "backup-key")

        self.assertEqual(
            process_manager.get_active_llama_authorization(ctx, "Bearer pending-key"),
            "Bearer launch-key",
        )
        self.assertTrue(process_manager.is_active_llama_api_auth_configured(ctx))

        ctx.state.active_llama_api_keys = ()
        self.assertEqual(
            process_manager.get_active_llama_authorization(ctx, "Bearer pending-key"),
            "",
        )

        ctx.state.process = None
        ctx.state.active_process_tool = None
        self.assertEqual(
            process_manager.get_active_llama_authorization(ctx, "Bearer re-entered-key"),
            "Bearer re-entered-key",
        )


class LlamaManagerDownloadTests(unittest.TestCase):
    def test_download_file_writes_chunks_and_reports_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            chunks = [b"abc", b"defg", b"h"]
            progress = []
            ctx.services.urlopen_with_ssl = mock.Mock(
                return_value=FakeDownloadResponse(chunks, content_length=8)
            )
            dest = pathlib.Path(tmp) / "download.bin"

            downloaded = llama_manager.download_file(
                ctx,
                "https://example.test/file.bin",
                dest,
                lambda current, total: progress.append((current, total)),
            )

            self.assertEqual(downloaded, 8)
            self.assertEqual(dest.read_bytes(), b"abcdefgh")
            self.assertEqual(progress, [(8, 8)])
            request = ctx.services.urlopen_with_ssl.call_args.args[0]
            self.assertEqual(request.full_url, "https://example.test/file.bin")

    def test_extract_archive_flat_routes_grammar_files_and_blocks_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "release.zip"
            bin_dir = root / "bin"
            grammar_dir = root / "grammars"
            bin_dir.mkdir()
            grammar_dir.mkdir()

            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("build/bin/llama-server", "server")
                zf.writestr("build/grammars/json.gbnf", "grammar")
                zf.writestr("../outside.exe", "flat only")

            llama_manager.extract_archive_flat(archive, bin_dir, grammar_dir)

            self.assertEqual((bin_dir / "llama-server").read_text(), "server")
            self.assertEqual((grammar_dir / "json.gbnf").read_text(), "grammar")
            self.assertEqual((bin_dir / "outside.exe").read_text(), "flat only")
            self.assertFalse((root / "outside.exe").exists())

    def test_extract_tar_archive_flat_copies_regular_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "release.tar.gz"
            bin_dir = root / "bin"
            grammar_dir = root / "grammars"
            bin_dir.mkdir()
            grammar_dir.mkdir()

            with tarfile.open(archive, "w:gz") as tf:
                binary = b"server"
                binary_info = tarfile.TarInfo("pkg/bin/llama-server")
                binary_info.size = len(binary)
                tf.addfile(binary_info, io.BytesIO(binary))

                grammar = b"root ::= object"
                grammar_info = tarfile.TarInfo("pkg/grammars/json.gbnf")
                grammar_info.size = len(grammar)
                tf.addfile(grammar_info, io.BytesIO(grammar))

            llama_manager.extract_archive_flat(archive, bin_dir, grammar_dir)

            self.assertEqual((bin_dir / "llama-server").read_bytes(), b"server")
            self.assertEqual((grammar_dir / "json.gbnf").read_bytes(), b"root ::= object")

    def test_install_release_downloads_extracts_saves_config_and_cleans_tmpdir(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            saved_configs = []
            remembered_target = {
                "host": "127.0.0.1",
                "port": 9001,
                "label": "External llama-server",
                "api_key_required": False,
            }
            ctx.services.load_config = lambda: {
                "external_chat_target": remembered_target
            }
            ctx.services.save_config = lambda cfg: saved_configs.append(dict(cfg))
            release = {
                "tag_name": "b1234",
                "name": "Build 1234",
                "assets": [
                    {
                        "name": "llama-b1234.zip",
                        "browser_download_url": "https://example.test/llama.zip",
                    }
                ],
            }
            backend_specs = {"cpu": {"asset": "llama-{tag}.zip"}}
            tmpdirs = []

            def fake_mkdtemp(prefix):
                path = pathlib.Path(tmp) / f"{prefix}abc"
                path.mkdir()
                tmpdirs.append(path)
                return str(path)

            def fake_download(_ctx, _url, dest, progress_cb=None):
                with zipfile.ZipFile(dest, "w") as zf:
                    zf.writestr("pkg/bin/llama-server", "server")
                    zf.writestr("pkg/grammars/json.gbnf", "grammar")
                if progress_cb:
                    progress_cb(10, 10)
                return 10

            stderr = io.StringIO()
            with mock.patch.object(llama_manager, "get_release_by_tag", return_value=release), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(llama_manager.tempfile, "mkdtemp", side_effect=fake_mkdtemp), mock.patch(
                "sys.stderr", stderr
            ):
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertTrue(ok)
            self.assertEqual((ctx.paths.llama_bin / "llama-server").read_text(), "server")
            self.assertEqual((ctx.paths.llama_grammars / "json.gbnf").read_text(), "grammar")
            self.assertEqual(
                saved_configs,
                [
                    {
                        "external_chat_target": remembered_target,
                        "version": "Build 1234",
                        "backend": "cpu",
                        "tag": "b1234",
                        "official_install": {
                            "backend": "cpu",
                            "tag": "b1234",
                            "version": "Build 1234",
                        },
                    }
                ],
            )
            self.assertEqual(ctx.state.download_progress.snapshot()["status"], "done")
            self.assertTrue(tmpdirs)
            self.assertFalse(tmpdirs[0].exists())
            self.assertIn("SHA256 digest metadata is missing", stderr.getvalue())

    def test_release_asset_sha256_parses_github_digest_and_allows_unusable_metadata(self):
        digest = "A1" * 32
        self.assertEqual(
            llama_manager.get_release_asset_sha256(
                {"digest": f"sha256:{digest}"}, "release.zip"
            ),
            digest.lower(),
        )

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertIsNone(
                llama_manager.get_release_asset_sha256(
                    {"digest": "sha512:not-supported"}, "release.zip"
                )
            )
            self.assertIsNone(
                llama_manager.get_release_asset_sha256({}, "legacy.zip")
            )

        warning = stderr.getvalue()
        self.assertIn("unsupported or malformed", warning)
        self.assertIn("metadata is missing", warning)

    def test_install_release_accepts_valid_github_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.load_config = lambda: {}
            ctx.services.save_config = mock.Mock()
            payload = b"verified archive bytes"
            release = {
                "tag_name": "b1234",
                "assets": [
                    {
                        "name": "llama-b1234.zip",
                        "browser_download_url": "https://example.test/llama.zip",
                        "digest": f"sha256:{hashlib.sha256(payload).hexdigest()}",
                    }
                ],
            }
            backend_specs = {"cpu": {"asset": "llama-{tag}.zip"}}

            def fake_download(_ctx, _url, dest, progress_cb=None):
                dest.write_bytes(payload)
                return len(payload)

            with mock.patch.object(
                llama_manager, "get_release_by_tag", return_value=release
            ), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(
                llama_manager, "extract_archive_flat"
            ) as extract_archive:
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertTrue(ok)
            extract_archive.assert_called_once()
            ctx.services.save_config.assert_called_once()

    def test_install_release_reports_release_lookup_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            backend_specs = {"cpu": {"asset": "llama-{tag}.zip"}}
            stderr = io.StringIO()

            with contextlib.redirect_stderr(stderr), mock.patch.object(
                llama_manager,
                "get_release_by_tag",
                side_effect=RuntimeError("tag lookup failed"),
            ), mock.patch.object(
                llama_manager,
                "get_releases",
                side_effect=RuntimeError("release API offline"),
            ):
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertFalse(ok)
            progress = ctx.state.download_progress.snapshot()
            self.assertEqual(progress["status"], "error")
            self.assertEqual(progress["message"], "release API offline")
            self.assertIn("release lookup failed: release API offline", stderr.getvalue())

    def test_install_release_does_not_save_config_when_executable_repair_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.save_config = mock.Mock()
            release = {
                "tag_name": "b1234",
                "assets": [
                    {
                        "name": "llama-b1234.zip",
                        "browser_download_url": "https://example.test/llama.zip",
                    }
                ],
            }
            backend_specs = {"cpu": {"asset": "llama-{tag}.zip"}}

            def fake_download(_ctx, _url, dest, progress_cb=None):
                with zipfile.ZipFile(dest, "w") as zf:
                    zf.writestr("llama-server", "server")
                return 6

            with mock.patch.object(
                llama_manager, "get_release_by_tag", return_value=release
            ), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(
                llama_manager,
                "ensure_installed_tool_executables",
                side_effect=PermissionError("permission repair failed"),
            ):
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertFalse(ok)
            self.assertEqual(
                ctx.state.download_progress.snapshot()["message"],
                "permission repair failed",
            )
            ctx.services.save_config.assert_not_called()

    def test_install_release_rejects_sha_mismatch_and_cleans_tmpdir(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.save_config = mock.Mock()
            release = {
                "tag_name": "b1234",
                "assets": [
                    {
                        "name": "llama-b1234.zip",
                        "browser_download_url": "https://example.test/llama.zip",
                        "digest": "sha256:" + "0" * 64,
                    }
                ],
            }
            backend_specs = {"cpu": {"asset": "llama-{tag}.zip"}}
            tmpdir = pathlib.Path(tmp) / "llama_install_abc"

            def fake_download(_ctx, _url, dest, progress_cb=None):
                dest.write_bytes(b"not the expected bytes")
                return dest.stat().st_size

            def fake_mkdtemp(prefix):
                tmpdir.mkdir()
                return str(tmpdir)

            with mock.patch.object(llama_manager, "get_release_by_tag", return_value=release), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(llama_manager.tempfile, "mkdtemp", side_effect=fake_mkdtemp):
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertFalse(ok)
            self.assertIn("SHA256 mismatch", ctx.state.download_progress.snapshot()["message"])
            ctx.services.save_config.assert_not_called()
            self.assertFalse(tmpdir.exists())

    def test_install_release_rejects_extra_asset_digest_mismatch_before_replacing_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_bin.mkdir(parents=True)
            ctx.paths.llama_grammars.mkdir(parents=True)
            old_binary = ctx.paths.llama_bin / "llama-server"
            old_grammar = ctx.paths.llama_grammars / "json.gbnf"
            old_binary.write_text("old server")
            old_grammar.write_text("old grammar")
            primary_payload = b"primary archive"
            extra_payload = b"extra archive"
            release = {
                "tag_name": "b1234",
                "assets": [
                    {
                        "name": "llama-b1234.zip",
                        "browser_download_url": "https://example.test/llama.zip",
                        "digest": f"sha256:{hashlib.sha256(primary_payload).hexdigest()}",
                    },
                    {
                        "name": "runtime.zip",
                        "browser_download_url": "https://example.test/runtime.zip",
                        "digest": "sha256:" + "0" * 64,
                    },
                ],
            }
            backend_specs = {
                "cpu": {
                    "asset": "llama-{tag}.zip",
                    "extra_assets": ["runtime.zip"],
                }
            }

            def fake_download(_ctx, url, dest, progress_cb=None):
                payload = extra_payload if url.endswith("runtime.zip") else primary_payload
                dest.write_bytes(payload)
                return len(payload)

            with mock.patch.object(
                llama_manager, "get_release_by_tag", return_value=release
            ), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(
                llama_manager, "extract_archive_flat"
            ) as extract_archive:
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertFalse(ok)
            self.assertEqual(old_binary.read_text(), "old server")
            self.assertEqual(old_grammar.read_text(), "old grammar")
            self.assertIn(
                "SHA256 mismatch for runtime.zip",
                ctx.state.download_progress.snapshot()["message"],
            )
            extract_archive.assert_not_called()
            ctx.services.save_config.assert_not_called()

    def test_install_release_keeps_the_old_install_when_extraction_fails(self):
        """Extraction used to run straight into llama/bin after deleting it, so a
        truncated archive or a full disk left no binaries at all while config
        still named the previous version."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_bin.mkdir(parents=True)
            ctx.paths.llama_grammars.mkdir(parents=True)
            old_binary = ctx.paths.llama_bin / "llama-server"
            old_grammar = ctx.paths.llama_grammars / "json.gbnf"
            old_binary.write_text("old server")
            old_grammar.write_text("old grammar")
            payload = b"primary archive"
            release = {
                "tag_name": "b1234",
                "assets": [
                    {
                        "name": "llama-b1234.zip",
                        "browser_download_url": "https://example.test/llama.zip",
                        "digest": f"sha256:{hashlib.sha256(payload).hexdigest()}",
                    }
                ],
            }
            backend_specs = {"cpu": {"asset": "llama-{tag}.zip"}}

            def fake_download(_ctx, _url, dest, progress_cb=None):
                dest.write_bytes(payload)
                return len(payload)

            with mock.patch.object(
                llama_manager, "get_release_by_tag", return_value=release
            ), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(
                llama_manager, "extract_archive_flat", side_effect=OSError("disk full")
            ):
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertFalse(ok)
            self.assertEqual(old_binary.read_text(), "old server", "old binaries must survive")
            self.assertEqual(old_grammar.read_text(), "old grammar")
            ctx.services.save_config.assert_not_called()
            # Staging leftovers must not linger next to the live directories.
            self.assertFalse(ctx.paths.llama_bin.with_name(ctx.paths.llama_bin.name + ".new").exists())
            self.assertFalse(
                ctx.paths.llama_grammars.with_name(ctx.paths.llama_grammars.name + ".new").exists()
            )

    def test_install_release_replaces_the_old_install_on_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.load_config = dict
            ctx.services.save_config = mock.Mock()
            ctx.paths.llama_bin.mkdir(parents=True)
            ctx.paths.llama_grammars.mkdir(parents=True)
            (ctx.paths.llama_bin / "stale-binary").write_text("stale")
            payload = b"primary archive"
            release = {
                "tag_name": "b1234",
                "assets": [
                    {
                        "name": "llama-b1234.zip",
                        "browser_download_url": "https://example.test/llama.zip",
                        "digest": f"sha256:{hashlib.sha256(payload).hexdigest()}",
                    }
                ],
            }
            backend_specs = {"cpu": {"asset": "llama-{tag}.zip"}}

            def fake_download(_ctx, _url, dest, progress_cb=None):
                dest.write_bytes(payload)
                return len(payload)

            def fake_extract(_archive, bin_dir, grammars_dir):
                (bin_dir / "llama-server").write_text("new server")
                (grammars_dir / "json.gbnf").write_text("new grammar")

            with mock.patch.object(
                llama_manager, "get_release_by_tag", return_value=release
            ), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(
                llama_manager, "extract_archive_flat", side_effect=fake_extract
            ):
                ok = llama_manager.install_release(ctx, "b1234", "cpu", backend_specs)

            self.assertTrue(ok)
            self.assertEqual((ctx.paths.llama_bin / "llama-server").read_text(), "new server")
            self.assertEqual((ctx.paths.llama_grammars / "json.gbnf").read_text(), "new grammar")
            self.assertFalse(
                (ctx.paths.llama_bin / "stale-binary").exists(),
                "the swap must replace the directory, not merge into it",
            )
            ctx.services.save_config.assert_called_once()

    def test_get_releases_uses_repo_api_and_pagination_when_provided(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            payload = json.dumps([{"tag_name": "b1294", "assets": []}]).encode()
            ctx.services.urlopen_with_ssl = mock.Mock(
                return_value=FakeDownloadResponse([payload], content_length=len(payload))
            )

            result = llama_manager.get_releases(
                ctx,
                llama_manager.LEMONADE_ROCM_REPO_API + "?channel=nightly",
                page=2,
                per_page=100,
            )

            request = ctx.services.urlopen_with_ssl.call_args.args[0]
            self.assertEqual(
                request.full_url,
                llama_manager.LEMONADE_ROCM_REPO_API
                + "?channel=nightly&page=2&per_page=100",
            )
            self.assertEqual(result[0]["tag_name"], "b1294")

    def test_get_releases_defaults_to_config_github_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            payload = json.dumps([]).encode()
            ctx.services.urlopen_with_ssl = mock.Mock(
                return_value=FakeDownloadResponse([payload])
            )

            llama_manager.get_releases(ctx)

            request = ctx.services.urlopen_with_ssl.call_args.args[0]
            self.assertEqual(request.full_url, ctx.config.github_api)

    def test_get_release_by_tag_uses_repo_api_tags_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            payload = json.dumps({"tag_name": "b1294", "assets": []}).encode()
            ctx.services.urlopen_with_ssl = mock.Mock(
                return_value=FakeDownloadResponse([payload])
            )

            llama_manager.get_release_by_tag(
                ctx, "b1294", llama_manager.LEMONADE_ROCM_REPO_API
            )

            request = ctx.services.urlopen_with_ssl.call_args.args[0]
            self.assertEqual(
                request.full_url,
                f"{llama_manager.LEMONADE_ROCM_REPO_API}/tags/b1294",
            )

    def test_extract_archive_preserve_paths_keeps_nested_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "release.zip"
            dest = root / "bin"
            dest.mkdir()

            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("llama-server.exe", "exe")
                zf.writestr("rocblas/library/tensile.dat", "data")
                zf.writestr("hipblaslt/kernel.dll", "dll")

            llama_manager.extract_archive_preserve_paths(archive, dest)

            self.assertEqual((dest / "llama-server.exe").read_text(), "exe")
            self.assertEqual(
                (dest / "rocblas" / "library" / "tensile.dat").read_text(), "data"
            )
            self.assertEqual((dest / "hipblaslt" / "kernel.dll").read_text(), "dll")

    def test_extract_archive_preserve_paths_restores_zip_file_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "release.zip"
            dest = root / "bin"
            dest.mkdir()
            info = zipfile.ZipInfo("llama-server")
            info.external_attr = 0o755 << 16

            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr(info, "exe")

            with mock.patch.object(llama_manager.os, "chmod") as chmod:
                llama_manager.extract_archive_preserve_paths(archive, dest)

            chmod.assert_called_once_with(dest / "llama-server", 0o755)
            self.assertEqual((dest / "llama-server").read_text(), "exe")

    def test_lemonade_style_zip_mode_is_repaired_after_extraction(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "linux"
            ctx.services.llama_tools = ["llama-server"]
            ctx.services.get_tool_filename = lambda tool: tool
            ctx.paths.llama_bin.mkdir(parents=True)
            archive = pathlib.Path(tmp) / "lemonade.zip"
            info = zipfile.ZipInfo("llama-server")
            info.external_attr = 0o100644 << 16
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr(info, "server")

            with mock.patch.object(
                llama_manager.stat, "S_IMODE", return_value=0o644
            ), mock.patch.object(
                llama_manager.os, "chmod"
            ) as chmod, mock.patch.object(
                llama_manager.os, "access", return_value=True
            ):
                llama_manager.extract_archive_preserve_paths(archive, ctx.paths.llama_bin)
                repaired = llama_manager.ensure_installed_tool_executables(ctx)

            self.assertEqual(repaired, ["llama-server"])
            self.assertEqual(
                chmod.call_args_list,
                [
                    mock.call(ctx.paths.llama_bin / "llama-server", 0o644),
                    mock.call(ctx.paths.llama_bin / "llama-server", 0o755),
                ],
            )

    def test_ensure_installed_tool_executables_repairs_only_known_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "linux"
            ctx.services.llama_tools = ["llama-cli", "llama-server"]
            ctx.services.get_tool_filename = lambda tool: tool
            ctx.paths.llama_bin.mkdir(parents=True)
            cli_path = ctx.paths.llama_bin / "llama-cli"
            server_path = ctx.paths.llama_bin / "llama-server"
            library_path = ctx.paths.llama_bin / "libggml.so"
            for path in (cli_path, server_path, library_path):
                path.write_text("binary")

            with mock.patch.object(
                llama_manager.stat, "S_IMODE", return_value=0o644
            ), mock.patch.object(
                llama_manager.os, "chmod"
            ) as chmod, mock.patch.object(
                llama_manager.os, "access", return_value=True
            ) as access:
                repaired = llama_manager.ensure_installed_tool_executables(ctx)

            self.assertEqual(repaired, ["llama-cli", "llama-server"])
            self.assertEqual(
                chmod.call_args_list,
                [mock.call(cli_path, 0o755), mock.call(server_path, 0o755)],
            )
            self.assertEqual(
                access.call_args_list,
                [
                    mock.call(cli_path, llama_manager.os.X_OK),
                    mock.call(server_path, llama_manager.os.X_OK),
                ],
            )
            self.assertNotIn(library_path, [call.args[0] for call in chmod.call_args_list])

    def test_ensure_installed_tool_executables_skips_windows(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "win32"
            ctx.services.llama_tools = ["llama-server"]
            ctx.services.get_tool_filename = lambda tool: f"{tool}.exe"
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-server.exe").write_text("binary")

            with mock.patch.object(llama_manager.os, "chmod") as chmod, mock.patch.object(
                llama_manager.os, "access"
            ) as access:
                repaired = llama_manager.ensure_installed_tool_executables(ctx)

            self.assertEqual(repaired, [])
            chmod.assert_not_called()
            access.assert_not_called()

    def test_ensure_installed_tool_executables_rejects_unusable_filesystem(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "linux"
            ctx.services.llama_tools = ["llama-server"]
            ctx.services.get_tool_filename = lambda tool: tool
            ctx.paths.llama_bin.mkdir(parents=True)
            (ctx.paths.llama_bin / "llama-server").write_text("binary")

            with mock.patch.object(
                llama_manager.stat, "S_IMODE", return_value=0o644
            ), mock.patch.object(llama_manager.os, "chmod"), mock.patch.object(
                llama_manager.os, "access", return_value=False
            ):
                with self.assertRaisesRegex(PermissionError, "mount options"):
                    llama_manager.ensure_installed_tool_executables(ctx)

    def test_extract_archive_preserve_paths_blocks_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "release.zip"
            dest = root / "bin"
            dest.mkdir()

            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("../escape.exe", "evil")
                zf.writestr("sub/../../escape2.exe", "evil2")
                zf.writestr("ok/keep.exe", "ok")

            llama_manager.extract_archive_preserve_paths(archive, dest)

            self.assertEqual((dest / "ok" / "keep.exe").read_text(), "ok")
            self.assertFalse((root / "escape.exe").exists())
            self.assertFalse((root / "escape2.exe").exists())

    def test_extract_archive_preserve_paths_blocks_absolute_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "release.zip"
            dest = root / "bin"
            dest.mkdir()

            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("/evil.exe", "evil")
                zf.writestr("keep.exe", "ok")

            llama_manager.extract_archive_preserve_paths(archive, dest)

            self.assertEqual((dest / "keep.exe").read_text(), "ok")
            self.assertFalse((root / "evil.exe").exists())
            self.assertFalse((dest / "evil.exe").exists())

    def test_extract_tar_preserve_paths_keeps_nested_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = root / "release.tar.gz"
            dest = root / "bin"
            dest.mkdir()

            with tarfile.open(archive, "w:gz") as tf:
                payload = b"server"
                info = tarfile.TarInfo("bin/llama-server")
                info.size = len(payload)
                tf.addfile(info, io.BytesIO(payload))

                nested = b"data"
                nested_info = tarfile.TarInfo("rocblas/library/tensile.dat")
                nested_info.size = len(nested)
                tf.addfile(nested_info, io.BytesIO(nested))

            llama_manager.extract_archive_preserve_paths(archive, dest)

            self.assertEqual((dest / "bin" / "llama-server").read_bytes(), b"server")
            self.assertEqual(
                (dest / "rocblas" / "library" / "tensile.dat").read_bytes(), b"data"
            )

    def test_install_release_preserve_paths_keeps_nested_rocm_layout_and_threads_repo_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.load_config = lambda: {}
            saved_configs = []
            ctx.services.save_config = lambda cfg: saved_configs.append(dict(cfg))
            asset_name = "llama-b1294-windows-rocm-gfx110X-x64.zip"
            release = {
                "tag_name": "b1294",
                "name": "b1294",
                "assets": [
                    {
                        "name": asset_name,
                        "browser_download_url": "https://example.test/pkg.zip",
                    }
                ],
            }
            backend_specs = {
                "lemonade-rocm-gfx110X": {
                    "label": "ROCm 7 gfx110X (AMD RDNA3, Lemonade)",
                    "asset": "llama-{tag}-windows-rocm-gfx110X-x64.zip",
                    "provider": "lemonade-rocm",
                    "repo_api": llama_manager.LEMONADE_ROCM_REPO_API,
                    "preserve_paths": True,
                    "gpu_target": "gfx110X",
                }
            }
            captured = {}

            def fake_get_release_by_tag(_ctx, tag, repo_api=None):
                captured["repo_api"] = repo_api
                return release

            def fake_download(_ctx, _url, dest, progress_cb=None):
                with zipfile.ZipFile(dest, "w") as zf:
                    zf.writestr("llama-server.exe", "server")
                    zf.writestr("rocblas/library/tensile.dat", "data")
                    zf.writestr("hipblaslt/kernel.dll", "dll")
                if progress_cb:
                    progress_cb(10, 10)
                return 10

            def fake_mkdtemp(prefix):
                path = pathlib.Path(tmp) / f"{prefix}abc"
                path.mkdir()
                return str(path)

            stderr = io.StringIO()
            with mock.patch.object(
                llama_manager, "get_release_by_tag", side_effect=fake_get_release_by_tag
            ), mock.patch.object(
                llama_manager, "download_file", side_effect=fake_download
            ), mock.patch.object(
                llama_manager.tempfile, "mkdtemp", side_effect=fake_mkdtemp
            ), mock.patch("sys.stderr", stderr):
                ok = llama_manager.install_release(
                    ctx, "b1294", "lemonade-rocm-gfx110X", backend_specs
                )

            self.assertTrue(ok)
            self.assertEqual(captured["repo_api"], llama_manager.LEMONADE_ROCM_REPO_API)
            self.assertEqual(
                (ctx.paths.llama_bin / "llama-server.exe").read_text(), "server"
            )
            self.assertEqual(
                (ctx.paths.llama_bin / "rocblas" / "library" / "tensile.dat").read_text(),
                "data",
            )
            self.assertEqual(
                (ctx.paths.llama_bin / "hipblaslt" / "kernel.dll").read_text(), "dll"
            )
            self.assertEqual(
                saved_configs,
                [
                    {
                        "version": "b1294",
                        "backend": "lemonade-rocm-gfx110X",
                        "tag": "b1294",
                        "official_install": {
                            "backend": "lemonade-rocm-gfx110X",
                            "tag": "b1294",
                            "version": "b1294",
                        },
                    }
                ],
            )
            self.assertEqual(ctx.state.download_progress.snapshot()["status"], "done")
            self.assertIn("SHA256 digest metadata is missing", stderr.getvalue())


class FilePickerServiceTests(unittest.TestCase):
    def test_extensions_from_filetypes_extracts_unique_extensions(self):
        self.assertEqual(
            file_picker_service._extensions_from_filetypes(
                [
                    ("Model files", "*.gguf *.bin"),
                    ("GGUF files", "*.gguf"),
                    ("All files", "*.*"),
                ]
            ),
            ["gguf", "bin"],
        )

    def test_macos_file_picker_uses_osascript_and_returns_stdout_path(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout="/Users/test/model.gguf\n",
            stderr="",
        )
        with mock.patch.object(file_picker_service.subprocess, "run", return_value=completed) as run:
            selected = file_picker_service.select_file_with_osascript(
                title="Pick Model",
                initial_dir=pathlib.Path("/Users/test/models"),
                filetypes=[("Model files", "*.gguf *.bin")],
            )

        self.assertEqual(selected, "/Users/test/model.gguf")
        args = run.call_args.args[0]
        self.assertEqual(args[0], "osascript")
        self.assertIn('of type {"gguf", "bin"}', args[2])

    def test_macos_file_picker_returns_empty_on_cancel(self):
        completed = SimpleNamespace(returncode=0, stdout="__CANCEL__", stderr="")
        with mock.patch.object(file_picker_service.subprocess, "run", return_value=completed):
            selected = file_picker_service.select_file_with_osascript(
                title="Pick Model",
                initial_dir=pathlib.Path("/Users/test/models"),
            )

        self.assertEqual(selected, "")

    def test_macos_folder_picker_uses_osascript_and_returns_folder(self):
        completed = SimpleNamespace(returncode=0, stdout="/Users/test/Models/\n", stderr="")
        with mock.patch.object(file_picker_service.subprocess, "run", return_value=completed) as run:
            selected = file_picker_service.select_folder_with_osascript(
                title="Pick Folder",
                initial_dir=pathlib.Path("/Users/test"),
            )

        self.assertEqual(selected, "/Users/test/Models")
        self.assertIn("choose folder", run.call_args.args[0][2])

    def test_macos_folder_picker_returns_empty_on_cancel(self):
        completed = SimpleNamespace(returncode=0, stdout="__CANCEL__", stderr="")
        with mock.patch.object(file_picker_service.subprocess, "run", return_value=completed):
            self.assertEqual(file_picker_service.select_folder_with_osascript(), "")


class GetLatestUserMessageTests(unittest.TestCase):
    def test_returns_last_user_message(self):
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
            {"role": "user", "content": "What is 2+2?"},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "What is 2+2?")

    def test_strips_whitespace(self):
        messages = [{"role": "user", "content": "  hello  "}]

        self.assertEqual(chat_service.get_latest_user_message(messages), "hello")

    def test_empty_messages_returns_empty(self):
        self.assertEqual(chat_service.get_latest_user_message([]), "")

    def test_none_messages_returns_empty(self):
        self.assertEqual(chat_service.get_latest_user_message(None), "")

    def test_no_user_messages_returns_empty(self):
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "assistant", "content": "Hi"},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "")

    def test_joins_text_parts_of_array_content(self):
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "image question"}]},
            {"role": "user", "content": "text question"},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "text question")

    def test_latest_array_content_beats_older_string_content(self):
        messages = [
            {"role": "user", "content": "text question"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "first part"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
                    {"type": "text", "text": "second part"},
                ],
            },
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "first part\nsecond part")

    def test_array_content_without_text_parts_returns_empty(self):
        messages = [
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/x.png"}}]},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "")

    def test_falls_back_to_older_text_when_latest_turn_has_no_text(self):
        messages = [
            {"role": "user", "content": "text question"},
            {"role": "assistant", "content": "Sure."},
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/x.png"}}]},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "text question")

    def test_falls_back_past_blank_string_content(self):
        messages = [
            {"role": "user", "content": "text question"},
            {"role": "user", "content": "   "},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "text question")

    def test_missing_content_key_returns_empty(self):
        messages = [{"role": "user"}]

        self.assertEqual(chat_service.get_latest_user_message(messages), "")


class GetMessageTextTests(unittest.TestCase):
    def test_string_content_passes_through(self):
        self.assertEqual(chat_service.get_message_text("  hello  "), "  hello  ")

    def test_joins_text_parts_and_ignores_other_parts(self):
        content = [
            {"type": "text", "text": "alpha"},
            {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
            {"type": "text", "text": "beta"},
        ]

        self.assertEqual(chat_service.get_message_text(content), "alpha\nbeta")

    def test_non_string_non_list_content_returns_empty(self):
        self.assertEqual(chat_service.get_message_text(None), "")
        self.assertEqual(chat_service.get_message_text({"type": "text", "text": "x"}), "")
        self.assertEqual(chat_service.get_message_text(42), "")


class MergeSystemContextTests(unittest.TestCase):
    def test_string_content_is_appended_to(self):
        self.assertEqual(
            chat_service.merge_system_context("Be brief.  ", "CONTEXT"),
            "Be brief.\n\nCONTEXT",
        )

    def test_blank_string_content_yields_context_only(self):
        self.assertEqual(chat_service.merge_system_context("", "CONTEXT"), "CONTEXT")

    def test_array_content_keeps_non_text_parts(self):
        content = [
            {"type": "text", "text": "Alpha"},
            {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}},
        ]

        merged = chat_service.merge_system_context(content, "CONTEXT")

        self.assertEqual(merged, [*content, {"type": "text", "text": "CONTEXT"}])
        self.assertEqual(len(content), 2, "source content must not be mutated")

    def test_unmergeable_content_returns_none(self):
        self.assertIsNone(chat_service.merge_system_context(None, "CONTEXT"))
        self.assertIsNone(chat_service.merge_system_context({"a": 1}, "CONTEXT"))
        self.assertIsNone(chat_service.merge_system_context(42, "CONTEXT"))


class FakeHealthResponse:
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


class TunnelDownloadTests(unittest.TestCase):
    def test_partial_direct_download_never_becomes_the_final_binary_and_retry_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "linux"
            ctx.services.current_arch = "x64"
            binary_path = ctx.paths.cloudflared / "cloudflared-linux-amd64"

            def partial_download(_ctx, _url, dest, progress_cb=None):
                dest.write_bytes(b"partial")
                raise OSError("connection lost")

            with mock.patch.object(
                tunnel_service, "download_file", side_effect=partial_download
            ), self.assertRaisesRegex(OSError, "connection lost"):
                tunnel_service.ensure_cloudflared(ctx)

            self.assertFalse(binary_path.exists())
            self.assertEqual(list(ctx.paths.cloudflared.iterdir()), [])

            def complete_download(_ctx, _url, dest, progress_cb=None):
                dest.write_bytes(b"complete cloudflared")
                return dest.stat().st_size

            with mock.patch.object(
                tunnel_service, "download_file", side_effect=complete_download
            ):
                installed = tunnel_service.ensure_cloudflared(ctx)

            self.assertEqual(installed, binary_path)
            self.assertEqual(binary_path.read_bytes(), b"complete cloudflared")
            self.assertFalse(any(path.is_dir() for path in ctx.paths.cloudflared.iterdir()))

    def test_partial_archive_extraction_never_becomes_the_final_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "darwin"
            ctx.services.current_arch = "arm64"
            binary_path = ctx.paths.cloudflared / "cloudflared"

            def fake_download(_ctx, _url, dest, progress_cb=None):
                with tarfile.open(dest, "w:gz") as tf:
                    payload = b"complete cloudflared"
                    info = tarfile.TarInfo("pkg/cloudflared")
                    info.size = len(payload)
                    tf.addfile(info, io.BytesIO(payload))
                return dest.stat().st_size

            def partial_extract(_src, out):
                out.write(b"partial")
                raise OSError("disk full")

            with mock.patch.object(
                tunnel_service, "download_file", side_effect=fake_download
            ), mock.patch.object(
                tunnel_service.shutil, "copyfileobj", side_effect=partial_extract
            ), self.assertRaisesRegex(OSError, "disk full"):
                tunnel_service.ensure_cloudflared(ctx)

            self.assertFalse(binary_path.exists())
            self.assertEqual(list(ctx.paths.cloudflared.iterdir()), [])

    def test_worker_spawned_after_stop_is_terminated_before_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.current_platform = "linux"
            ctx.state.remote_tunnel_generation = 1
            ctx.state.remote_tunnel.update(status="preparing")

            class FakeProcess:
                def __init__(self):
                    self.returncode = None
                    self.stderr = io.StringIO("")
                    self.terminated = False

                def poll(self):
                    return self.returncode

                def terminate(self):
                    self.terminated = True
                    self.returncode = 0

                def wait(self, timeout=None):
                    return self.returncode

                def kill(self):
                    self.returncode = -9

            process = FakeProcess()

            def spawn_after_stop(*_args, **_kwargs):
                tunnel_service.stop_remote_tunnel(ctx)
                return process

            with mock.patch.object(
                tunnel_service, "ensure_cloudflared", return_value=ctx.paths.cloudflared / "cloudflared"
            ), mock.patch.object(
                tunnel_service.subprocess, "Popen", side_effect=spawn_after_stop
            ):
                tunnel_service._start_remote_tunnel_worker(ctx, 1)

            self.assertTrue(process.terminated)
            self.assertIsNone(ctx.state.remote_tunnel_process)
            self.assertEqual(ctx.state.remote_tunnel.snapshot()["status"], "stopped")

    def test_superseded_worker_error_does_not_clobber_newer_tunnel_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.state.remote_tunnel_generation = 3
            ctx.state.remote_tunnel.update(status="preparing", message="Old worker")

            def supersede_then_fail(*_args, **_kwargs):
                with ctx.state.remote_tunnel_lock:
                    ctx.state.remote_tunnel_generation = 4
                    ctx.state.remote_tunnel.update(
                        status="preparing", message="New worker"
                    )
                raise RuntimeError("old worker failed")

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), mock.patch.object(
                tunnel_service,
                "ensure_cloudflared",
                side_effect=supersede_then_fail,
            ):
                tunnel_service._start_remote_tunnel_worker(ctx, 3)

            snapshot = ctx.state.remote_tunnel.snapshot()
            self.assertEqual(snapshot["status"], "preparing")
            self.assertEqual(snapshot["message"], "New worker")
            self.assertIn("old worker failed", stderr.getvalue())

    def test_worker_logs_and_sanitizes_unexpected_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.state.remote_tunnel_generation = 1
            ctx.state.remote_tunnel.update(status="preparing")
            stderr = io.StringIO()

            with contextlib.redirect_stderr(stderr), mock.patch.object(
                tunnel_service,
                "ensure_cloudflared",
                side_effect=RuntimeError("private tunnel failure"),
            ):
                tunnel_service._start_remote_tunnel_worker(ctx, 1)

            snapshot = ctx.state.remote_tunnel.snapshot()
            self.assertEqual(snapshot["status"], "error")
            self.assertEqual(snapshot["message"], "Internal server error")
            self.assertIn("private tunnel failure", stderr.getvalue())


class ExternalServerServiceTests(unittest.TestCase):
    def make_context(self, saved=None):
        ctx = AppContext()
        ctx.services.set_llama_api_target = mock.Mock(return_value={})
        store = {"tag": "b1", "backend": "cpu"}
        if saved is not None:
            store["external_chat_target"] = saved

        def save_config(config_data):
            store.clear()
            store.update(config_data)

        ctx.services.load_config = lambda: dict(store)
        ctx.services.save_config = save_config
        self.config_store = store
        return ctx

    def connect(self, ctx, host="127.0.0.1", port=8080, api_key="", label=""):
        return external_server_service.connect(
            ctx, host, port, api_key, label, probe_target=False
        )

    def test_no_target_registered_by_default(self):
        ctx = self.make_context()

        self.assertIsNone(external_server_service.get_target(ctx))
        self.assertEqual(external_server_service.get_authorization(ctx), "")
        self.assertIsNone(external_server_service.resolve_llama_target(ctx))

    def test_connect_registers_target_and_aligns_v1_proxy(self):
        ctx = self.make_context()

        target = self.connect(ctx, host="127.0.0.1", port=9001, label="  Workstation  ")

        self.assertEqual(target["host"], "127.0.0.1")
        self.assertEqual(target["port"], 9001)
        self.assertEqual(target["label"], "Workstation")
        self.assertFalse(target["api_key_configured"])
        self.assertEqual(
            external_server_service.resolve_llama_target(ctx),
            {"host": "127.0.0.1", "port": 9001, "source": "external"},
        )
        ctx.services.set_llama_api_target.assert_called_once_with("127.0.0.1", 9001)

    def test_published_target_never_contains_the_api_key(self):
        ctx = self.make_context()

        target = self.connect(ctx, api_key="secret-key")

        self.assertTrue(target["api_key_configured"])
        self.assertNotIn("secret-key", json.dumps(target))
        self.assertNotIn("secret-key", json.dumps(external_server_service.get_target(ctx)))
        self.assertEqual(external_server_service.get_authorization(ctx), "Bearer secret-key")

    def test_connect_rejects_non_local_host(self):
        ctx = self.make_context()

        with self.assertRaises(ValueError):
            self.connect(ctx, host="203.0.113.10")

        self.assertIsNone(external_server_service.get_target(ctx))

    def test_connect_rejects_invalid_ports(self):
        ctx = self.make_context()

        for port in (0, 70000, -1, "not-a-port", None, True):
            with self.subTest(port=port), self.assertRaises(ValueError):
                self.connect(ctx, port=port)

    def test_connect_rejects_header_breaking_api_keys(self):
        ctx = self.make_context()

        # "ünicode" is intentionally absent: latin-1 encodes it, so http.client
        # can send it and there is no reason to reject it.
        for api_key in ("bad\r\nX-Injected: 1", "bad\nkey", "tab\tkey", "key-键"):
            with self.subTest(api_key=api_key), self.assertRaises(ValueError):
                self.connect(ctx, api_key=api_key)

        with self.assertRaises(ValueError):
            self.connect(ctx, api_key="k" * (external_server_service.MAX_API_KEY_LENGTH + 1))

    def test_connect_normalizes_wildcard_host_to_the_loopback_address(self):
        ctx = self.make_context()

        target = self.connect(ctx, host="0.0.0.0")

        self.assertEqual(target["host"], config.LLAMA_HOST)

    def test_disconnect_clears_target_and_key(self):
        ctx = self.make_context()
        self.connect(ctx, api_key="secret-key")

        external_server_service.disconnect(ctx)

        self.assertIsNone(external_server_service.get_target(ctx))
        self.assertEqual(external_server_service.get_authorization(ctx), "")
        self.assertEqual(ctx.state.external_chat_api_key, "")
        ctx.services.set_llama_api_target.assert_called_with(None, None)

    def test_connect_leaves_the_v1_proxy_on_a_winning_runtime(self):
        # A launched llama-server still wins in `resolve_llama_target`, so
        # registering must not point /v1 somewhere chat and metrics won't go.
        ctx = self.make_context()
        ctx.state.process = FakeLaunchedProcess(returncode=None)
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_runtime = {"tool": "llama-server", "host": "127.0.0.1", "port": 8080}

        self.connect(ctx, port=9001)

        ctx.services.set_llama_api_target.assert_called_once_with("127.0.0.1", 8080)

    def test_disconnect_hands_the_v1_proxy_back_to_a_running_runtime(self):
        ctx = self.make_context()
        ctx.state.process = FakeLaunchedProcess(returncode=None)
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_runtime = {"tool": "llama-server", "host": "127.0.0.1", "port": 8080}
        self.connect(ctx, port=9001)

        external_server_service.disconnect(ctx)

        ctx.services.set_llama_api_target.assert_called_with("127.0.0.1", 8080)

    def test_launched_runtime_wins_over_a_registered_target(self):
        ctx = self.make_context()
        self.connect(ctx, port=9001)
        ctx.state.process = FakeLaunchedProcess(returncode=None)
        ctx.state.active_process_tool = "llama-server"
        ctx.state.active_llama_api_keys = ("launch-secret",)
        ctx.state.active_runtime = {"tool": "llama-server", "host": "127.0.0.1", "port": 8080}

        target = external_server_service.resolve_llama_target(ctx)

        self.assertEqual(target, {"host": "127.0.0.1", "port": 8080, "source": "runtime"})
        self.assertEqual(
            external_server_service.resolve_llama_authorization(ctx, target),
            "Bearer launch-secret",
        )

    def test_non_server_runtime_falls_through_to_the_registered_target(self):
        ctx = self.make_context()
        self.connect(ctx, port=9001)
        ctx.state.process = FakeLaunchedProcess(returncode=None)
        ctx.state.active_process_tool = "llama-cli"
        ctx.state.active_runtime = {"tool": "llama-cli", "host": "127.0.0.1", "port": 8080}

        self.assertEqual(
            external_server_service.resolve_llama_target(ctx),
            {"host": "127.0.0.1", "port": 9001, "source": "external"},
        )

    def test_external_authorization_uses_the_stored_key_over_the_caller_header(self):
        ctx = self.make_context()
        self.connect(ctx, api_key="stored-key")
        target = external_server_service.resolve_llama_target(ctx)

        self.assertEqual(
            external_server_service.resolve_llama_authorization(ctx, target, "Bearer caller-key"),
            "Bearer stored-key",
        )

    def test_external_authorization_falls_back_when_no_key_was_stored(self):
        ctx = self.make_context()
        self.connect(ctx)
        target = external_server_service.resolve_llama_target(ctx)

        self.assertEqual(
            external_server_service.resolve_llama_authorization(ctx, target, "Bearer caller-key"),
            "Bearer caller-key",
        )

    def test_connect_probes_the_target_and_reports_a_rejected_key(self):
        ctx = self.make_context()
        error_body = io.BytesIO(b"")
        error = urllib.error.HTTPError(
            "http://127.0.0.1:9001/health",
            401,
            "Unauthorized",
            Message(),
            error_body,
        )

        with mock.patch.object(
            external_server_service, "_open_probe_request", side_effect=error
        ):
            target = external_server_service.connect(ctx, "127.0.0.1", 9001, "wrong-key")

        self.assertEqual(target["probe_status"], 401)
        self.assertIn("rejected the API key", target["warning"])
        self.assertIsNotNone(external_server_service.get_target(ctx))
        self.assertTrue(error_body.closed)

    def test_connect_sends_the_api_key_with_the_probe(self):
        ctx = self.make_context()
        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["authorization"] = request.get_header("Authorization")
            return FakeHealthResponse(200)

        with mock.patch.object(
            external_server_service, "_open_probe_request", side_effect=fake_urlopen
        ):
            target = external_server_service.connect(ctx, "127.0.0.1", 9001, "probe-key")

        self.assertEqual(captured["url"], "http://127.0.0.1:9001/health")
        self.assertEqual(captured["authorization"], "Bearer probe-key")
        self.assertEqual(target["probe_status"], 200)
        self.assertEqual(target["warning"], "")

    def test_connect_refuses_an_address_that_does_not_answer(self):
        ctx = self.make_context()

        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            side_effect=urllib.error.URLError("connection refused"),
        ), self.assertRaises(external_server_service.ExternalServerUnreachable):
            external_server_service.connect(ctx, "127.0.0.1", 9001)

        self.assertIsNone(external_server_service.get_target(ctx))

    def test_connect_survives_an_unconfigured_v1_proxy_service(self):
        ctx = AppContext()

        target = self.connect(ctx, port=9001)

        self.assertEqual(target["port"], 9001)
        self.assertIsNotNone(external_server_service.get_target(ctx))

    def test_connect_remembers_the_address_but_never_the_key(self):
        ctx = self.make_context()

        self.connect(ctx, host="127.0.0.1", port=9001, api_key="secret-key", label="Workstation")

        saved = self.config_store["external_chat_target"]
        self.assertEqual(
            saved,
            {"host": "127.0.0.1", "port": 9001, "label": "Workstation", "api_key_required": True},
        )
        self.assertNotIn("secret-key", json.dumps(self.config_store))
        self.assertEqual(self.config_store["tag"], "b1", "unrelated config must survive the write")

    def test_connect_without_a_key_records_that_none_is_required(self):
        ctx = self.make_context()

        self.connect(ctx, port=9001)

        self.assertFalse(self.config_store["external_chat_target"]["api_key_required"])

    def test_disconnect_forgets_the_saved_address(self):
        ctx = self.make_context()
        self.connect(ctx, port=9001)

        external_server_service.disconnect(ctx)

        self.assertNotIn("external_chat_target", self.config_store)
        self.assertIsNone(external_server_service.get_remembered_target(ctx))

    def test_remembered_target_reads_back_a_saved_entry(self):
        ctx = self.make_context(
            saved={"host": "127.0.0.1", "port": 9001, "label": "Box", "api_key_required": True}
        )

        self.assertEqual(
            external_server_service.get_remembered_target(ctx),
            {"host": "127.0.0.1", "port": 9001, "label": "Box", "api_key_required": True},
        )

    def test_remembered_target_ignores_unusable_entries(self):
        for saved in (
            {"host": "203.0.113.10", "port": 9001},
            {"host": "127.0.0.1", "port": 70000},
            {"host": "127.0.0.1"},
            "not-a-mapping",
            None,
        ):
            with self.subTest(saved=saved):
                ctx = self.make_context(saved=saved)
                self.assertIsNone(external_server_service.get_remembered_target(ctx))

    def test_remembered_target_survives_an_unconfigured_config_service(self):
        self.assertIsNone(external_server_service.get_remembered_target(AppContext()))

    def test_reconnect_restores_a_keyless_address(self):
        ctx = self.make_context(
            saved={"host": "127.0.0.1", "port": 9001, "label": "Box", "api_key_required": False}
        )

        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            return_value=FakeHealthResponse(200),
        ):
            target = external_server_service.reconnect_remembered(ctx)

        self.assertEqual(target["host"], "127.0.0.1")
        self.assertEqual(target["port"], 9001)
        self.assertEqual(target["label"], "Box")
        self.assertIsNotNone(external_server_service.get_target(ctx))

    def test_reconnect_skips_an_address_that_needed_a_key(self):
        ctx = self.make_context(
            saved={"host": "127.0.0.1", "port": 9001, "api_key_required": True}
        )

        with mock.patch.object(
            external_server_service, "_open_probe_request"
        ) as open_probe:
            self.assertIsNone(external_server_service.reconnect_remembered(ctx))

        open_probe.assert_not_called()
        self.assertIsNone(external_server_service.get_target(ctx))

    def test_reconnect_returns_none_when_nothing_was_saved(self):
        ctx = self.make_context()

        self.assertIsNone(external_server_service.reconnect_remembered(ctx))

    def test_reconnect_refuses_a_port_taken_by_something_else(self):
        ctx = self.make_context(
            saved={"host": "127.0.0.1", "port": 9001, "api_key_required": False}
        )

        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            return_value=FakeHealthResponse(200, b"<html>some other dev server</html>"),
        ), self.assertRaises(external_server_service.ExternalServerUnreachable):
            external_server_service.reconnect_remembered(ctx)

        self.assertIsNone(external_server_service.get_target(ctx))

    def test_manual_connect_stays_permissive_about_an_unrecognized_body(self):
        ctx = self.make_context()

        with mock.patch.object(
            external_server_service,
            "_open_probe_request",
            return_value=FakeHealthResponse(200, b"<html>some other dev server</html>"),
        ):
            target = external_server_service.connect(ctx, "127.0.0.1", 9001)

        self.assertFalse(target["identified"])
        self.assertIsNotNone(external_server_service.get_target(ctx))

    def test_probe_identifies_llama_server_health_responses(self):
        cases = {
            b'{"status":"ok"}': True,
            b'{"error":{"code":503,"message":"Loading model"}}': True,
            b'{"ok":true}': False,
            b"<html></html>": False,
            b"": False,
            b"[]": False,
        }
        for body, expected in cases.items():
            with self.subTest(body=body):
                with mock.patch.object(
                    external_server_service,
                    "_open_probe_request",
                    return_value=FakeHealthResponse(200, body),
                ):
                    result = external_server_service.probe("127.0.0.1", 9001)
                self.assertEqual(result["identified"], expected)
                self.assertEqual(result["status"], 200)

    def test_probe_uses_a_no_redirect_opener_for_authorized_requests(self):
        opener = mock.Mock()
        opener.open.return_value = FakeHealthResponse(200)

        with mock.patch.object(
            external_server_service.urllib.request,
            "build_opener",
            return_value=opener,
        ) as build_opener:
            result = external_server_service.probe(
                "::1", 9001, "Bearer secret-key"
            )

        redirect_handler = build_opener.call_args.args[0]
        self.assertIsInstance(
            redirect_handler, external_server_service._NoProbeRedirects
        )
        original_request = opener.open.call_args.args[0]
        self.assertEqual(original_request.full_url, "http://[::1]:9001/health")
        self.assertEqual(
            original_request.get_header("Authorization"), "Bearer secret-key"
        )
        self.assertIsNone(
            redirect_handler.redirect_request(
                original_request,
                None,
                302,
                "Found",
                Message(),
                "https://example.test/collect",
            )
        )
        self.assertEqual(result["status"], 200)


class GetLocalProxyHostTests(unittest.TestCase):
    def test_defaults_empty_host_to_configured_llama_host(self):
        result, error = chat_service.get_local_proxy_host("")

        self.assertEqual(result, "127.0.0.1")
        self.assertEqual(error, "")

    def test_maps_wildcard_hosts_to_configured_llama_host(self):
        for host in ["localhost", "0.0.0.0", "::", "*"]:
            with self.subTest(host=host):
                result, error = chat_service.get_local_proxy_host(host)

                self.assertEqual(result, "127.0.0.1")
                self.assertEqual(error, "")

    def test_allows_loopback_address(self):
        with mock.patch.object(
            chat_service.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("127.0.0.1", 0))],
        ):
            result, error = chat_service.get_local_proxy_host("127.0.0.1")

        self.assertEqual(result, "127.0.0.1")
        self.assertEqual(error, "")

    def test_allows_known_local_interface_address(self):
        with mock.patch.object(
            chat_service.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("192.168.1.25", 0))],
        ), mock.patch.object(
            chat_service,
            "get_local_interface_addresses",
            return_value=frozenset({"192.168.1.25"}),
        ):
            result, error = chat_service.get_local_proxy_host("my-hostname")

        self.assertEqual(result, "my-hostname")
        self.assertEqual(error, "")

    def test_rejects_public_address(self):
        with mock.patch.object(
            chat_service.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("93.184.216.34", 0))],
        ), mock.patch.object(
            chat_service,
            "get_local_interface_addresses",
            return_value=frozenset({"127.0.0.1"}),
        ):
            result, error = chat_service.get_local_proxy_host("example.com")

        self.assertEqual(result, "")
        self.assertEqual(error, "Blocked: metrics proxy can only target this machine.")

    def test_rejects_malformed_host(self):
        with mock.patch.object(
            chat_service.socket,
            "getaddrinfo",
            side_effect=OSError("bad host"),
        ):
            result, error = chat_service.get_local_proxy_host("not a host")

        self.assertEqual(result, "")
        self.assertIn("Invalid llama-server metrics host:", error)


class BuildSearchQueriesTests(unittest.TestCase):
    def test_normal_text_returns_single_query(self):
        result = chat_service.build_search_queries("What is Python?")

        self.assertEqual(result, ["What is Python?"])

    def test_empty_string_returns_empty_list(self):
        self.assertEqual(chat_service.build_search_queries(""), [])

    def test_none_returns_empty_list(self):
        self.assertEqual(chat_service.build_search_queries(None), [])

    def test_whitespace_only_returns_empty_list(self):
        self.assertEqual(chat_service.build_search_queries("   "), [])

    def test_collapses_multiple_spaces(self):
        result = chat_service.build_search_queries("hello    world   test")

        self.assertEqual(result, ["hello world test"])

    def test_truncates_long_query_at_word_boundary(self):
        long_text = "word " * 100  # 500 chars

        result = chat_service.build_search_queries(long_text)

        self.assertEqual(len(result), 1)
        self.assertLessEqual(len(result[0]), 180)

    def test_long_query_without_spaces_truncates_hard(self):
        long_text = "a" * 200

        result = chat_service.build_search_queries(long_text)

        self.assertEqual(result, ["a" * 180])


class NormalizeHfTokenTests(unittest.TestCase):
    def test_valid_token_strips_whitespace(self):
        self.assertEqual(hf_service.normalize_hf_token("  hf_abc123  "), "hf_abc123")

    def test_empty_string_returns_none(self):
        self.assertIsNone(hf_service.normalize_hf_token(""))

    def test_none_returns_none(self):
        self.assertIsNone(hf_service.normalize_hf_token(None))

    def test_whitespace_only_returns_none(self):
        self.assertIsNone(hf_service.normalize_hf_token("   "))

    def test_false_returns_none(self):
        self.assertIsNone(hf_service.normalize_hf_token(False))


class IsMmprojFilenameTests(unittest.TestCase):
    def test_mmproj_in_stem(self):
        self.assertTrue(hf_service.is_mmproj_filename("mmproj-model.gguf"))

    def test_clip_prefix_in_stem(self):
        self.assertTrue(hf_service.is_mmproj_filename("clip-vision.gguf"))

    def test_projector_in_stem(self):
        self.assertTrue(hf_service.is_mmproj_filename("model-projector.gguf"))

    def test_regular_model_file(self):
        self.assertFalse(hf_service.is_mmproj_filename("model-Q4_K_M.gguf"))

    def test_case_insensitive(self):
        self.assertTrue(hf_service.is_mmproj_filename("MMPROJ-model.gguf"))
        self.assertTrue(hf_service.is_mmproj_filename("CLIP-vision.gguf"))

    def test_empty_string_returns_false(self):
        self.assertFalse(hf_service.is_mmproj_filename(""))

    def test_none_returns_false(self):
        self.assertFalse(hf_service.is_mmproj_filename(None))

    def test_backslash_path(self):
        self.assertTrue(hf_service.is_mmproj_filename("subdir\\mmproj-model.gguf"))

    def test_full_path(self):
        self.assertTrue(hf_service.is_mmproj_filename("Q4/mmproj-model.gguf"))
        self.assertFalse(hf_service.is_mmproj_filename("Q4/model-Q4_K_M.gguf"))


class SlugifyRepoIdTests(unittest.TestCase):
    def test_normal_repo_id(self):
        self.assertEqual(hf_service.slugify_repo_id("owner/model"), "owner_model")

    def test_multiple_slashes(self):
        self.assertEqual(hf_service.slugify_repo_id("org/sub/model"), "org_sub_model")

    def test_preserves_dots_and_hyphens(self):
        self.assertEqual(hf_service.slugify_repo_id("owner/my-model.v2"), "owner_my-model.v2")

    def test_strips_leading_trailing_separators(self):
        self.assertEqual(hf_service.slugify_repo_id("/owner/model/"), "owner_model")

    def test_empty_string_returns_repo(self):
        self.assertEqual(hf_service.slugify_repo_id(""), "repo")

    def test_only_separators_returns_repo(self):
        self.assertEqual(hf_service.slugify_repo_id("///"), "repo")

    def test_spaces_replaced(self):
        self.assertEqual(hf_service.slugify_repo_id("my model"), "my_model")

    def test_slug_is_not_injective(self):
        # Documents an accepted limitation rather than asserting desired output.
        # Only "/" is substituted, so a repo whose name contains "_" can collide
        # with one whose owner does. Both of these are valid repo ids and land in
        # the same download folder. Kept deliberately: an injective scheme would
        # rename every existing folder, files keep their own names, and a
        # same-name clash still hits the exists/overwrite prompt. If this ever
        # stops being acceptable, this test is the thing to change first.
        for repo_id in ("owner/my_model", "owner_my/model"):
            hf_service.validate_hf_repo_id(repo_id)
        self.assertEqual(
            hf_service.slugify_repo_id("owner/my_model"),
            hf_service.slugify_repo_id("owner_my/model"),
        )


class DownloadHfFileLengthTests(unittest.TestCase):
    @staticmethod
    def _download(ctx, dest, resp):
        return hf_service.download_hf_file(
            ctx,
            repo_id="owner/model",
            filename="model.gguf",
            revision="main",
            token=None,
            dest=dest,
            completed_bytes=0,
            total_bytes=10,
            urlopen=lambda req, timeout=60: resp,
        )

    def test_rejects_truncated_response(self):
        """A connection dropped mid-transfer looks like a clean EOF to
        http.client, so only the Content-Length check catches it."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            dest = pathlib.Path(tmp) / "model.gguf"
            resp = FakeDownloadResponse([b"trun"], content_length=10)

            with self.assertRaises(OSError) as caught:
                self._download(ctx, dest, resp)

            self.assertIn("incomplete", str(caught.exception))
            self.assertFalse(dest.exists())

    def test_accepts_complete_response(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            dest = pathlib.Path(tmp) / "model.gguf"
            resp = FakeDownloadResponse([b"0123456789"], content_length=10)

            self.assertEqual(self._download(ctx, dest, resp), 10)
            self.assertEqual(dest.read_bytes(), b"0123456789")

    def test_accepts_response_without_content_length(self):
        """Servers that omit the header must still work; there is nothing to check."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            dest = pathlib.Path(tmp) / "model.gguf"
            resp = FakeDownloadResponse([b"abc"])

            self.assertEqual(self._download(ctx, dest, resp), 3)
            self.assertEqual(dest.read_bytes(), b"abc")


class StartHfModelDownloadPathTests(unittest.TestCase):
    def test_downloads_into_repo_subfolder(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            payload = b"gguf-bytes"

            def fake_urlopen(req, timeout=60):
                return FakeDownloadResponse([payload], content_length=len(payload))

            with (
                mock.patch.object(hf_service, "get_hf_file_size", return_value=len(payload)),
                mock.patch.object(
                    hf_service,
                    "build_hf_download_url",
                    side_effect=lambda repo_id, filename, revision: f"https://example.test/{filename}",
                ),
            ):
                hf_service.start_hf_model_download(
                    ctx,
                    repo_id="owner/model",
                    revision="main",
                    model_file="Q4/model.gguf",
                    mmproj_file="mmproj-model.gguf",
                    token=None,
                    urlopen=fake_urlopen,
                )
                for _ in range(50):
                    snap = hf_service.get_model_download_snapshot(ctx)
                    if snap["status"] in {"done", "error", "cancelled"}:
                        break
                    import time

                    time.sleep(0.02)

            snap = hf_service.get_model_download_snapshot(ctx)
            self.assertEqual(snap["status"], "done", snap)
            self.assertEqual(snap["model_name"], "owner_model/model.gguf")
            model_path = pathlib.Path(snap["model_path"])
            self.assertEqual(model_path, ctx.paths.models / "owner_model" / "model.gguf")
            self.assertTrue(model_path.is_file())
            self.assertEqual(model_path.read_bytes(), payload)
            mmproj_path = pathlib.Path(snap["mmproj_path"])
            self.assertEqual(
                mmproj_path,
                ctx.paths.models / "owner_model" / "mmproj-model.gguf",
            )
            self.assertTrue(mmproj_path.is_file())

    def test_exists_check_uses_repo_relative_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            dest = ctx.paths.models / "owner_model" / "model.gguf"
            dest.parent.mkdir(parents=True)
            dest.write_bytes(b"existing")

            with self.assertRaises(FileExistsError) as raised:
                hf_service.start_hf_model_download(
                    ctx,
                    repo_id="owner/model",
                    revision="main",
                    model_file="model.gguf",
                    mmproj_file="",
                    token=None,
                )

            self.assertIn("owner_model/model.gguf", str(raised.exception))

    def test_download_uses_active_custom_model_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            custom = pathlib.Path(tmp) / "custom-library"
            custom.mkdir()
            store = {"models_dir": str(custom)}
            ctx.services.load_config = lambda: dict(store)
            payload = b"gguf-bytes"

            class ImmediateThread:
                def __init__(self, *, target, daemon):
                    self.target = target

                def start(self):
                    self.target()

            with mock.patch.object(hf_service.threading, "Thread", ImmediateThread), mock.patch.object(
                hf_service, "get_hf_file_size", return_value=len(payload)
            ), mock.patch.object(
                hf_service,
                "build_hf_download_url",
                return_value="https://example.test/model.gguf",
            ):
                hf_service.start_hf_model_download(
                    ctx,
                    repo_id="owner/model",
                    revision="main",
                    model_file="model.gguf",
                    mmproj_file="",
                    token=None,
                    urlopen=lambda *_args, **_kwargs: FakeDownloadResponse(
                        [payload], content_length=len(payload)
                    ),
                )

            snapshot = hf_service.get_model_download_snapshot(ctx)
            self.assertEqual(
                pathlib.Path(snapshot["model_path"]),
                custom / "owner_model" / "model.gguf",
            )
            self.assertEqual(snapshot["model_name"], "owner_model/model.gguf")

    def test_worker_logs_and_sanitizes_unexpected_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)

            class ImmediateThread:
                def __init__(self, *, target, daemon):
                    self.target = target

                def start(self):
                    self.target()

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), mock.patch.object(
                hf_service.threading, "Thread", ImmediateThread
            ), mock.patch.object(
                hf_service,
                "get_hf_file_size",
                side_effect=RuntimeError("private download failure"),
            ):
                snapshot = hf_service.start_hf_model_download(
                    ctx,
                    repo_id="owner/model",
                    revision="main",
                    model_file="model.gguf",
                    mmproj_file="",
                    token=None,
                )

            self.assertEqual(snapshot["status"], "error")
            self.assertEqual(snapshot["message"], "Internal server error")
            self.assertIn("private download failure", stderr.getvalue())


class HfFileToDictTests(unittest.TestCase):
    def test_extracts_rfilename(self):
        file_obj = SimpleNamespace(rfilename="Q4/model.gguf", size=1048576)

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertEqual(result["name"], "Q4/model.gguf")
        self.assertEqual(result["size"], 1048576)
        self.assertEqual(result["size_mb"], 1.0)

    def test_falls_back_to_path(self):
        file_obj = SimpleNamespace(path="Q4/model.gguf", size=524288)

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertEqual(result["name"], "Q4/model.gguf")
        self.assertEqual(result["size_mb"], 0.5)

    def test_falls_back_to_name(self):
        file_obj = SimpleNamespace(name="model.gguf", size=2097152)

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertEqual(result["name"], "model.gguf")
        self.assertEqual(result["size_mb"], 2.0)

    def test_no_filename_returns_empty_string(self):
        file_obj = SimpleNamespace(size=1024)

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertEqual(result["name"], "")

    def test_no_size_returns_none(self):
        file_obj = SimpleNamespace(rfilename="model.gguf")

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertIsNone(result["size"])
        self.assertIsNone(result["size_mb"])

    def test_lfs_dict_size_fallback(self):
        file_obj = SimpleNamespace(rfilename="model.gguf", size=None, lfs={"size": 1048576})

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertEqual(result["size"], 1048576)
        self.assertEqual(result["size_mb"], 1.0)

    def test_non_numeric_size_returns_none(self):
        file_obj = SimpleNamespace(rfilename="model.gguf", size="unknown")

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertIsNone(result["size"])

    def test_zero_size_mb_rounds_correctly(self):
        file_obj = SimpleNamespace(rfilename="model.gguf", size=0)

        result = hf_service.hf_file_to_dict(file_obj)

        self.assertEqual(result["size_mb"], 0.0)


class ValidateHfRepoIdDirectTests(unittest.TestCase):
    def test_valid_repo_id(self):
        self.assertEqual(hf_service.validate_hf_repo_id("owner/model"), "owner/model")

    def test_dots_in_name(self):
        self.assertEqual(hf_service.validate_hf_repo_id("owner/my.model-v1"), "owner/my.model-v1")

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_repo_id("")

    def test_rejects_no_slash(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_repo_id("ownermodel")

    def test_rejects_double_dots(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_repo_id("owner/..model")

    def test_rejects_trailing_dot(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_repo_id("owner/model.")

    def test_rejects_double_slash(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_repo_id("owner//model")


class ValidateHfFilenameDirectTests(unittest.TestCase):
    def test_valid_nested_path(self):
        self.assertEqual(hf_service.validate_hf_filename("Q4/model.gguf"), "Q4/model.gguf")

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_filename("")

    def test_rejects_absolute(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_filename("/model.gguf")

    def test_rejects_traversal(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_filename("../model.gguf")

    def test_rejects_non_gguf(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_filename("model.bin")

    def test_rejects_null_byte(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_filename("mod\x00el.gguf")

    def test_rejects_windows_reserved_device_names(self):
        for name in (
            "con.gguf",
            "PRN.gguf",
            "aux.gguf",
            "NuL.gguf",
            "COM1.gguf",
            "lpt9.gguf",
            "Q4/con.gguf",
            "con.txt.gguf",
            "COM1.foo.gguf",
        ):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    hf_service.validate_hf_filename(name)

    def test_allows_near_miss_windows_device_names(self):
        self.assertEqual(hf_service.validate_hf_filename("COM0.gguf"), "COM0.gguf")
        self.assertEqual(hf_service.validate_hf_filename("COM10.gguf"), "COM10.gguf")
        self.assertEqual(hf_service.validate_hf_filename("console.gguf"), "console.gguf")


class ValidateHfRevisionDirectTests(unittest.TestCase):
    def test_defaults_to_main(self):
        self.assertEqual(hf_service.validate_hf_revision(""), "main")
        self.assertEqual(hf_service.validate_hf_revision(None), "main")

    def test_valid_revision(self):
        self.assertEqual(hf_service.validate_hf_revision("refs/pr/1"), "refs/pr/1")

    def test_rejects_leading_slash(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_revision("/main")

    def test_rejects_backslash(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_revision("main\\bad")

    def test_rejects_traversal(self):
        with self.assertRaises(ValueError):
            hf_service.validate_hf_revision("refs/../main")


class WebSearchDirectTests(unittest.TestCase):
    def test_web_search_rejects_empty_query_without_importing_ddgs(self):
        result = web_search_service.web_search("   ")

        self.assertFalse(result["ok"])
        self.assertEqual(result["results"], [])
        self.assertIn("No query", result["error"])

    def test_web_search_reports_missing_ddgs_dependency(self):
        real_import = __import__

        def fake_import(name, *args, **kwargs):
            if name == "ddgs":
                raise ImportError("missing")
            return real_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=fake_import):
            result = web_search_service.web_search("llama gui")

        self.assertFalse(result["ok"])
        self.assertEqual(result["results"], [])
        self.assertIn("ddgs", result["error"])

    def test_web_search_normalizes_ddgs_rows(self):
        class FakeDDGS:
            def __init__(self, timeout):
                self.timeout = timeout

            def text(self, query, max_results):
                self.query = query
                self.max_results = max_results
                return [
                    {"title": "One", "href": "https://example.test/one", "body": "Body one"},
                    {"url": "https://example.test/two", "snippet": "Snippet two"},
                    {"title": "No URL"},
                ]

        fake_module = SimpleNamespace(DDGS=FakeDDGS)

        with mock.patch.dict("sys.modules", {"ddgs": fake_module}):
            result = web_search_service.web_search(" llama gui ", max_results=2)

        self.assertTrue(result["ok"])
        self.assertEqual(result["query"], "llama gui")
        self.assertEqual(
            result["results"],
            [
                {"title": "One", "url": "https://example.test/one", "snippet": "Body one"},
                {
                    "title": "https://example.test/two",
                    "url": "https://example.test/two",
                    "snippet": "Snippet two",
                },
            ],
        )

    def test_web_search_reports_ddgs_runtime_failure(self):
        class FailingDDGS:
            def __init__(self, timeout):
                pass

            def text(self, query, max_results):
                raise RuntimeError("network down")

        fake_module = SimpleNamespace(DDGS=FailingDDGS)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), mock.patch.dict(
            "sys.modules", {"ddgs": fake_module}
        ):
            result = web_search_service.web_search("llama gui")

        self.assertFalse(result["ok"])
        self.assertEqual(result["results"], [])
        self.assertEqual(result["error"], "Search failed: Internal server error")
        self.assertIn("network down", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
