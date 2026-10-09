"""Stage 1: System (PATH) backend classification and executable discovery.

Covers the plan's verification list: PATH precedence, tools in different
directories, missing tools despite local official binaries, spaces in paths,
executable permissions, symlinks/wrappers, Windows .exe lookup, and existing
official/Custom resolution. All lookups use temporary fixture directories with
an isolated PATH, never the host's installed llama.cpp.

Host independence: Windows' ``shutil.which()`` only matches executable
extensions, so extensionless Unix tool names cannot be discovered with the
real lookup on a Windows host. Tests that need Unix semantics use an explicit
exact-match ``which`` fixture (the plan's "fixtures for platform-specific
lookup"); cross-platform precedence/directory/space cases use ``.exe`` names
with the real lookup so stdlib PATH ordering is exercised on every host.
"""

import contextlib
import os
import pathlib
import stat
import tempfile
import unittest
from unittest import mock

from backend import app
from backend.http import Request
from backend.routes import status as status_routes
from backend.services import llama_manager, process_manager
from tests.backend.test_extracted_routes import DummyResponse
from tests.backend.test_services import make_service_context


def _make_ctx(root, platform="linux", suffix=""):
    ctx = make_service_context(root)
    services = ctx.services
    services.current_platform = platform
    services.current_arch = "x64"
    services.binary_suffix = suffix
    services.llama_tools = [
        "llama-cli",
        "llama-server",
        "llama-bench",
        "llama-perplexity",
    ]
    services.get_tool_filename = lambda tool: tool + services.binary_suffix
    services.backend_specs = llama_manager.build_backend_specs(platform, "x64")
    store = {}

    def load_config():
        return dict(store)

    def save_config(cfg):
        store.clear()
        store.update(cfg)

    services.load_config = load_config
    services.save_config = save_config
    services.find_tool_executable = lambda tool: (
        llama_manager.resolve_backend_tool_executable(
            ctx, services.load_config().get("backend"), tool
        )
    )
    services.get_runtime_files = lambda: []
    services.get_platform_label = lambda: "Test"
    services.get_llama_api_target = lambda: {"host": "127.0.0.1", "port": 8080}
    services.validate_runtime_dependencies = lambda tools=None: (
        llama_manager.validate_runtime_dependencies(ctx, tools)
    )
    return ctx


@contextlib.contextmanager
def _exact_which_fixture():
    """Unix-style exact-name lookup over the current PATH, any host.

    Matches the first PATH entry containing the exact filename, without
    PATHEXT extension probing. Executability is left to the resolver under
    test so permission cases stay deterministic.
    """

    def fake_which(filename, *args, **kwargs):
        if not isinstance(filename, str) or not filename:
            return None
        if "/" in filename or "\\" in filename:
            return None
        for entry in os.environ.get("PATH", "").split(os.pathsep):
            if not entry:
                continue
            candidate = pathlib.Path(entry) / filename
            try:
                if candidate.is_file():
                    return str(candidate)
            except OSError:
                continue
        return None

    with mock.patch.object(llama_manager.shutil, "which", side_effect=fake_which):
        yield


def _write_executable(path, content="tool"):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    try:
        mode = path.stat().st_mode
        path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    return path


class SystemBackendSpecsTests(unittest.TestCase):
    def test_system_listed_with_path_label_and_no_download_asset(self):
        for platform, arch in [("win32", "x64"), ("darwin", "arm64"), ("linux", "x64")]:
            with self.subTest(platform=platform, arch=arch):
                specs = llama_manager.build_backend_specs(platform, arch)
                self.assertIn("system", specs)
                self.assertEqual(specs["system"]["label"], "System (PATH)")
                self.assertNotIn("asset", specs["system"])

    def test_custom_specs_unchanged_and_startup_creates_no_system_dirs(self):
        self.assertEqual(
            set(llama_manager.CUSTOM_BACKEND_SPECS),
            {"custom", "custom-02"},
        )
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp)
            # Startup creates official + custom directories only; there is no
            # System folder to create and none may appear.
            for backend in list(llama_manager.CUSTOM_BACKEND_SPECS) + ["cpu"]:
                llama_manager.get_backend_bin_dir(ctx, backend).mkdir(
                    parents=True, exist_ok=True
                )
            self.assertFalse((ctx.paths.llama / "system").exists())

    def test_helpers_classify_backends(self):
        self.assertTrue(llama_manager.is_system_backend("system"))
        self.assertFalse(llama_manager.is_system_backend("cpu"))
        self.assertFalse(llama_manager.is_system_backend("custom"))
        self.assertFalse(llama_manager.is_system_backend(None))
        self.assertTrue(llama_manager.is_externally_managed_backend("system"))
        self.assertFalse(llama_manager.is_externally_managed_backend("cpu"))
        self.assertTrue(llama_manager.is_official_backend("cpu"))
        self.assertFalse(llama_manager.is_official_backend("custom"))
        self.assertFalse(llama_manager.is_official_backend("custom-02"))
        self.assertFalse(llama_manager.is_official_backend("system"))
        self.assertFalse(llama_manager.is_official_backend(None))

    def test_folder_helpers_reject_system(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp)
            with self.assertRaises(ValueError):
                llama_manager.get_backend_bin_dir(ctx, "system")
            with self.assertRaises(ValueError):
                llama_manager.get_backend_grammars_dir(ctx, "system")

    def test_system_never_recorded_as_official_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp)
            ctx.services.save_config(
                {"backend": "system", "tag": "system", "version": "system"}
            )
            official = llama_manager.get_official_install_status(ctx)
            self.assertIsNone(official["backend"])
            self.assertIsNone(official["tag"])


class SystemPathDiscoveryTests(unittest.TestCase):
    def test_path_precedence_first_entry_wins(self):
        # .exe names use the real stdlib lookup on every host.
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            first = root / "first"
            second = root / "second"
            _write_executable(first / "llama-server.exe", "first")
            _write_executable(second / "llama-server.exe", "second")
            ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
            ctx.services.save_config({"backend": "system"})
            with mock.patch.dict(
                os.environ, {"PATH": os.pathsep.join([str(first), str(second)])}
            ):
                resolved = llama_manager.resolve_backend_tool_executable(
                    ctx, "system", "llama-server"
                )
            self.assertEqual(resolved, first / "llama-server.exe")
            with mock.patch.dict(
                os.environ, {"PATH": os.pathsep.join([str(second), str(first)])}
            ):
                resolved = llama_manager.resolve_backend_tool_executable(
                    ctx, "system", "llama-server"
                )
            self.assertEqual(resolved, second / "llama-server.exe")

    def test_tools_in_different_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            server_dir = root / "server-dir"
            cli_dir = root / "cli-dir"
            _write_executable(server_dir / "llama-server.exe", "server")
            _write_executable(cli_dir / "llama-cli.exe", "cli")
            ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
            with mock.patch.dict(
                os.environ,
                {"PATH": os.pathsep.join([str(server_dir), str(cli_dir)])},
            ):
                server = llama_manager.resolve_backend_tool_executable(
                    ctx, "system", "llama-server"
                )
                cli = llama_manager.resolve_backend_tool_executable(
                    ctx, "system", "llama-cli"
                )
            self.assertEqual(server, server_dir / "llama-server.exe")
            self.assertEqual(cli, cli_dir / "llama-cli.exe")

    def test_missing_tool_despite_official_binaries_has_no_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
            official = ctx.paths.llama_bin
            official.mkdir(parents=True, exist_ok=True)
            _write_executable(official / "llama-server.exe", "official")
            empty = pathlib.Path(tmp) / "empty-path"
            empty.mkdir()
            with mock.patch.dict(os.environ, {"PATH": str(empty)}):
                resolved = llama_manager.resolve_backend_tool_executable(
                    ctx, "system", "llama-server"
                )
            self.assertIsNone(resolved)

    def test_spaces_in_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            spaced = pathlib.Path(tmp) / "dir with spaces" / "tools"
            _write_executable(spaced / "llama-server.exe", "spaced")
            ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
            with mock.patch.dict(os.environ, {"PATH": str(spaced)}):
                resolved = llama_manager.resolve_backend_tool_executable(
                    ctx, "system", "llama-server"
                )
            self.assertEqual(resolved, spaced / "llama-server.exe")

    def test_executable_permission_required_on_unix_not_windows(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            bindir.mkdir(parents=True)
            candidate = bindir / "llama-server"
            candidate.write_text("not-executable")
            unix_ctx = _make_ctx(tmp, platform="linux")
            win_ctx = _make_ctx(tmp, platform="win32")
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}):
                with _exact_which_fixture(), mock.patch.object(
                    llama_manager.os, "access", return_value=False
                ):
                    self.assertIsNone(
                        llama_manager.resolve_backend_tool_executable(
                            unix_ctx, "system", "llama-server"
                        )
                    )
                    # Windows never requires the executable bit.
                    self.assertEqual(
                        llama_manager.resolve_backend_tool_executable(
                            win_ctx, "system", "llama-server"
                        ),
                        bindir / "llama-server",
                    )
                with _exact_which_fixture(), mock.patch.object(
                    llama_manager.os, "access", return_value=True
                ):
                    self.assertEqual(
                        llama_manager.resolve_backend_tool_executable(
                            unix_ctx, "system", "llama-server"
                        ),
                        bindir / "llama-server",
                    )

    def test_symlink_entry_point_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            store = root / "store"
            linkdir = root / "links"
            store.mkdir()
            linkdir.mkdir()
            target = _write_executable(store / "llama-server-v1", "real")
            link = linkdir / "llama-server"
            try:
                if link.exists() or link.is_symlink():
                    link.unlink()
                link.symlink_to(target)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlinks unavailable: {exc}")
            ctx = _make_ctx(tmp, platform="linux")
            with mock.patch.dict(os.environ, {"PATH": str(linkdir)}):
                with _exact_which_fixture(), mock.patch.object(
                    llama_manager.os, "access", return_value=True
                ):
                    resolved = llama_manager.resolve_backend_tool_executable(
                        ctx, "system", "llama-server"
                    )
            self.assertEqual(resolved, linkdir / "llama-server")
            # abspath() preserves the link; resolve() would collapse it.
            self.assertNotEqual(resolved, target)
            self.assertEqual(resolved.resolve(), target.resolve())

    def test_wrapper_script_resolves(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            wrapper = bindir / "llama-server"
            bindir.mkdir(parents=True)
            wrapper.write_text("#!/bin/sh\nexec /opt/llama/llama-server \"$@\"\n")
            ctx = _make_ctx(tmp, platform="linux")
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}):
                with _exact_which_fixture(), mock.patch.object(
                    llama_manager.os, "access", return_value=True
                ):
                    resolved = llama_manager.resolve_backend_tool_executable(
                        ctx, "system", "llama-server"
                    )
            self.assertEqual(resolved, wrapper)

    def test_entry_point_never_resolved_through_symlinks(self):
        # Proves the resolver uses abspath(), not resolve()/realpath(), so
        # Nix/store wrappers keep their entry point. No symlink privilege
        # needed: any resolve() call fails the test.
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            _write_executable(bindir / "llama-server", "entry")
            ctx = _make_ctx(tmp, platform="linux")
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}):
                with _exact_which_fixture(), mock.patch.object(
                    llama_manager.os, "access", return_value=True
                ), mock.patch.object(
                    pathlib.Path,
                    "resolve",
                    side_effect=AssertionError("must not resolve"),
                ):
                    resolved = llama_manager.resolve_backend_tool_executable(
                        ctx, "system", "llama-server"
                    )
            self.assertEqual(resolved, bindir / "llama-server")

    def test_windows_exe_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            _write_executable(bindir / "llama-server.exe", "windows")
            ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}):
                resolved = llama_manager.resolve_backend_tool_executable(
                    ctx, "system", "llama-server"
                )
            self.assertEqual(resolved, bindir / "llama-server.exe")
            # An extensionless file is not a fallback for the .exe name.
            (bindir / "llama-server.exe").unlink()
            _write_executable(bindir / "llama-server", "extensionless")
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}):
                self.assertIsNone(
                    llama_manager.resolve_backend_tool_executable(
                        ctx, "system", "llama-server"
                    )
                )

    def test_unknown_tools_rejected_and_fit_params_internal(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            _write_executable(bindir / "evil-tool", "evil")
            _write_executable(bindir / "llama-fit-params", "estimator")
            ctx = _make_ctx(tmp, platform="linux")
            self.assertNotIn("llama-fit-params", list(ctx.services.llama_tools))
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}):
                with _exact_which_fixture(), mock.patch.object(
                    llama_manager.os, "access", return_value=True
                ):
                    self.assertIsNone(
                        llama_manager.resolve_backend_tool_executable(
                            ctx, "system", "evil-tool"
                        )
                    )
                    self.assertIsNone(
                        llama_manager.resolve_backend_tool_executable(
                            ctx, "system", "../bin/llama-server"
                        )
                    )
                    fit_params = llama_manager.resolve_backend_tool_executable(
                        ctx, "system", "llama-fit-params"
                    )
            self.assertEqual(fit_params, bindir / "llama-fit-params")

    def test_official_and_custom_resolution_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp)
            official = _write_executable(ctx.paths.llama_bin / "llama-server", "cpu")
            custom_dir = llama_manager.get_backend_bin_dir(ctx, "custom")
            custom_tool = _write_executable(custom_dir / "llama-server", "custom")
            self.assertEqual(
                llama_manager.resolve_backend_tool_executable(
                    ctx, "cpu", "llama-server"
                ),
                official,
            )
            self.assertEqual(
                llama_manager.resolve_backend_tool_executable(
                    ctx, "custom", "llama-server"
                ),
                custom_tool,
            )
            # Folder backends keep their path result even when the file is
            # absent; only System reports None explicitly.
            (ctx.paths.llama_bin / "llama-cli").unlink(missing_ok=True)
            self.assertEqual(
                llama_manager.resolve_backend_tool_executable(ctx, "cpu", "llama-cli"),
                ctx.paths.llama_bin / "llama-cli",
            )


class SystemMissingToolConsumersTests(unittest.TestCase):
    def test_status_launch_and_runtime_handle_missing_system_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="linux")
            ctx.services.save_config({"backend": "system", "tag": "system"})
            empty = pathlib.Path(tmp) / "empty"
            empty.mkdir()
            with mock.patch.dict(os.environ, {"PATH": str(empty)}):
                self.assertIsNone(
                    llama_manager.resolve_backend_tool_executable(
                        ctx, "system", "llama-server"
                    )
                )
                response = DummyResponse()
                with mock.patch(
                    "backend.services.model_dir.get_models_dir_info",
                    return_value={"models_dir": str(ctx.paths.models)},
                ), mock.patch(
                    "backend.services.official_backends.get_backend_specs",
                    return_value=dict(ctx.services.backend_specs),
                ):
                    status_routes.get_status(
                        Request("GET", "/api/status", "", {}), response, ctx
                    )
                self.assertFalse(
                    response.payload["executables"][
                        ctx.services.get_tool_filename("llama-server")
                    ]
                )
                exe_path, error = process_manager._validate_launch_environment(
                    ctx, "llama-server"
                )
                self.assertIsNone(exe_path)
                self.assertIn("not found", error)
                buffers = process_manager.get_buffer_types(ctx)
                self.assertEqual(buffers["buffers"], ["CPU"])
                self.assertIn("not found", buffers["error"])
                health = llama_manager.validate_runtime_dependencies(ctx)
                self.assertTrue(health["ok"])
                self.assertFalse(health["checked"])

    def test_app_find_tool_delegates_and_runtime_files_empty_for_system(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            expected = _write_executable(bindir / "llama-server.exe", "system")
            ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
            ctx.services.save_config({"backend": "system"})
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}):
                with mock.patch.object(
                    app, "APP_CONTEXT", ctx
                ), mock.patch.object(
                    app, "load_config", ctx.services.load_config
                ), mock.patch.object(
                    app, "CONFIG_FILE", ctx.paths.config_file
                ):
                    self.assertEqual(
                        app.find_tool_executable("llama-server"), expected
                    )
                    self.assertEqual(app.get_runtime_files(), [])
            empty = pathlib.Path(tmp) / "empty"
            empty.mkdir()
            with mock.patch.dict(os.environ, {"PATH": str(empty)}):
                with mock.patch.object(
                    app, "APP_CONTEXT", ctx
                ), mock.patch.object(app, "load_config", ctx.services.load_config):
                    self.assertIsNone(app.find_tool_executable("llama-server"))


if __name__ == "__main__":
    unittest.main()
