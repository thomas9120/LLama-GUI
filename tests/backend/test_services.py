import hashlib
import io
import pathlib
import tarfile
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
from unittest import mock

from backend.context import AppContext, AppPaths, ServerConfig
from backend.services import chat as chat_service
from backend.services import file_picker as file_picker_service
from backend.services import hf_download as hf_service
from backend.services import llama_manager
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


def make_service_context(root):
    root = pathlib.Path(root)
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
            app_logo=root / "Llama-GUI Logo.png",
            tools=root / "tools",
            cloudflared=root / "tools" / "cloudflared",
        ),
        config=ServerConfig(llama_host="127.0.0.1", llama_port=8080),
    )


class BuildBackendSpecsTests(unittest.TestCase):
    def test_win32_x64_returns_cuda_vulkan_sycl_hip_backends(self):
        specs = llama_manager.build_backend_specs("win32", "x64")

        self.assertIn("cpu", specs)
        self.assertIn("cuda-12.4", specs)
        self.assertIn("cuda-13.1", specs)
        self.assertIn("vulkan", specs)
        self.assertIn("sycl", specs)
        self.assertIn("hip", specs)
        self.assertEqual(specs["cpu"]["label"], "CPU")
        self.assertIn("win-cpu-x64", specs["cpu"]["asset"])

    def test_win32_arm64_returns_cpu_and_opencl_adreno(self):
        specs = llama_manager.build_backend_specs("win32", "arm64")

        self.assertIn("cpu", specs)
        self.assertIn("opencl-adreno", specs)
        self.assertNotIn("cuda-12.4", specs)
        self.assertIn("win-cpu-arm64", specs["cpu"]["asset"])

    def test_darwin_arm64_returns_metal_backends(self):
        specs = llama_manager.build_backend_specs("darwin", "arm64")

        self.assertIn("metal", specs)
        self.assertIn("metal-kleidiai", specs)
        self.assertNotIn("cpu", specs)

    def test_darwin_x64_returns_cpu_only(self):
        specs = llama_manager.build_backend_specs("darwin", "x64")

        self.assertEqual(list(specs.keys()), ["cpu"])
        self.assertIn("macos-x64", specs["cpu"]["asset"])

    def test_darwin_unknown_arch_returns_empty(self):
        specs = llama_manager.build_backend_specs("darwin", "ppc64")

        self.assertEqual(specs, {})

    def test_linux_x64_returns_cpu_vulkan_rocm_openvino(self):
        specs = llama_manager.build_backend_specs("linux", "x64")

        self.assertIn("cpu", specs)
        self.assertIn("vulkan", specs)
        self.assertIn("rocm", specs)
        self.assertIn("openvino", specs)

    def test_linux_arm64_returns_cpu_and_vulkan(self):
        specs = llama_manager.build_backend_specs("linux", "arm64")

        self.assertIn("cpu", specs)
        self.assertIn("vulkan", specs)
        self.assertNotIn("rocm", specs)

    def test_linux_s390x_returns_cpu_only(self):
        specs = llama_manager.build_backend_specs("linux", "s390x")

        self.assertEqual(list(specs.keys()), ["cpu"])
        self.assertIn("s390x", specs["cpu"]["asset"])

    def test_linux_unknown_arch_returns_empty(self):
        specs = llama_manager.build_backend_specs("linux", "riscv64")

        self.assertEqual(specs, {})

    def test_unknown_platform_returns_empty(self):
        specs = llama_manager.build_backend_specs("freebsd", "x64")

        self.assertEqual(specs, {})

    def test_asset_patterns_contain_tag_placeholder(self):
        for platform_name, arch in [("win32", "x64"), ("darwin", "arm64"), ("linux", "x64")]:
            with self.subTest(platform=platform_name, arch=arch):
                specs = llama_manager.build_backend_specs(platform_name, arch)
                for backend_id, spec in specs.items():
                    self.assertIn("{tag}", spec["asset"], f"{backend_id} missing {{tag}}")

    def test_cuda_backends_have_extra_assets(self):
        specs = llama_manager.build_backend_specs("win32", "x64")

        self.assertIn("extra_assets", specs["cuda-12.4"])
        self.assertIn("extra_assets", specs["cuda-13.1"])
        self.assertEqual(len(specs["cuda-12.4"]["extra_assets"]), 1)


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
            self.assertEqual(saved_configs, [{"version": "Build 1234", "backend": "cpu", "tag": "b1234"}])
            self.assertEqual(ctx.state.download_progress.snapshot()["status"], "done")
            self.assertTrue(tmpdirs)
            self.assertFalse(tmpdirs[0].exists())
            self.assertIn("No SHA256 metadata", stderr.getvalue())

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
                        "sha256": "0" * 64,
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
        completed = SimpleNamespace(returncode=1, stdout="", stderr="User canceled.")
        with mock.patch.object(file_picker_service.subprocess, "run", return_value=completed):
            selected = file_picker_service.select_file_with_osascript(
                title="Pick Model",
                initial_dir=pathlib.Path("/Users/test/models"),
            )

        self.assertEqual(selected, "")


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

    def test_skips_non_string_content(self):
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "image question"}]},
            {"role": "user", "content": "text question"},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "text question")

    def test_only_non_string_content_returns_empty(self):
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "only images"}]},
        ]

        self.assertEqual(chat_service.get_latest_user_message(messages), "")

    def test_missing_content_key_returns_empty(self):
        messages = [{"role": "user"}]

        self.assertEqual(chat_service.get_latest_user_message(messages), "")


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

        self.assertEqual(result["size_mb"], None)


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

        with mock.patch.dict("sys.modules", {"ddgs": fake_module}):
            result = web_search_service.web_search("llama gui")

        self.assertFalse(result["ok"])
        self.assertEqual(result["results"], [])
        self.assertIn("network down", result["error"])


if __name__ == "__main__":
    unittest.main()
