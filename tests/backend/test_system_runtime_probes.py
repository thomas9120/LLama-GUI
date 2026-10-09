"""Stage 2: System (PATH) runtime probes, environment, and process integration.

Uses temporary fixture executables, mocked ``subprocess.run`` responses, and
an isolated PATH. No host llama.cpp installation, model, or GPU is required.
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from backend.services import llama_manager, process_manager
from backend.services.subprocess_utils import get_no_window_creationflags
from tests.backend.test_system_path_discovery import (
    _exact_which_fixture,
    _make_ctx,
    _write_executable,
)


def _completed(args, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout, stderr)


def _probe_ok(tool, exe_path, tag="b1234"):
    return {
        "ok": True,
        "build_tag": tag,
        "error": None,
        "executable": str(exe_path),
    }


def _health_with_probes(probed, missing=(), ok=True):
    """Canned ``validate_runtime_dependencies`` result for integration tests."""
    build_tags = {
        tool: probe["build_tag"]
        for tool, probe in probed.items()
        if probe.get("build_tag")
    }
    return {
        "ok": ok,
        "checked": bool(probed),
        "checked_tools": sorted(probed),
        "unchecked_tools": [],
        "checked_runtime_files": [],
        "unchecked_runtime_files": [],
        "required_runtime_files": [],
        "missing_runtime_files": [],
        "missing_executables": list(missing),
        "build_tags": build_tags,
        "system_probes": dict(probed),
    }


class SystemVersionProbeTests(unittest.TestCase):
    def test_known_build_tag_parsed_from_stdout_and_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="linux")
            exe = pathlib.Path(tmp) / "llama-server"
            with mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed(
                    [str(exe), "--version"], stdout="version: b1234 (build 1234)"
                ),
            ) as run:
                probe = llama_manager.probe_system_tool_executable(
                    ctx, "llama-server", exe
                )
            self.assertTrue(probe["ok"])
            self.assertEqual(probe["build_tag"], "b1234")
            self.assertIsNone(probe["error"])
            self.assertEqual(probe["executable"], str(exe))
            run.assert_called_once()
            with mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed(
                    [str(exe), "--version"], stdout="noise", stderr="Build 99"
                ),
            ):
                probe = llama_manager.probe_system_tool_executable(
                    ctx, "llama-server", exe
                )
            self.assertTrue(probe["ok"])
            self.assertEqual(probe["build_tag"], "b99")

    def test_unknown_build_format_is_successful_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="linux")
            exe = pathlib.Path(tmp) / "llama-server"
            with mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed(
                    [str(exe), "--version"], stdout="llama-pack 2.0-custom"
                ),
            ):
                probe = llama_manager.probe_system_tool_executable(
                    ctx, "llama-server", exe
                )
            self.assertTrue(probe["ok"])
            self.assertIsNone(probe["build_tag"])

    def test_nonzero_exit_timeout_and_spawn_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="linux")
            exe = pathlib.Path(tmp) / "llama-server"
            with mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed([str(exe), "--version"], returncode=1),
            ):
                probe = llama_manager.probe_system_tool_executable(
                    ctx, "llama-server", exe
                )
            self.assertFalse(probe["ok"])
            self.assertIn("status 1", probe["error"])
            with mock.patch.object(
                llama_manager.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired([str(exe)], 5),
            ):
                probe = llama_manager.probe_system_tool_executable(
                    ctx, "llama-server", exe
                )
            self.assertFalse(probe["ok"])
            self.assertIn("timed out", probe["error"])
            with mock.patch.object(
                llama_manager.subprocess,
                "run",
                side_effect=OSError("loader missing"),
            ):
                probe = llama_manager.probe_system_tool_executable(
                    ctx, "llama-server", exe
                )
            self.assertFalse(probe["ok"])
            self.assertIn("could not start", probe["error"])

    def test_probe_uses_entry_point_inherited_env_and_hiding(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="linux")
            exe = pathlib.Path(tmp) / "llama-server"
            with mock.patch.dict(os.environ, {"PATH": "probe-path"}), mock.patch.object(
                llama_manager.subprocess, "run", return_value=_completed([], stdout="b7")
            ) as run:
                llama_manager.probe_system_tool_executable(ctx, "llama-server", exe)
            kwargs = run.call_args
            self.assertEqual(kwargs.args[0], [str(exe), "--version"])
            self.assertNotIn("shell", kwargs.kwargs)
            self.assertEqual(kwargs.kwargs["timeout"], 5)
            self.assertEqual(kwargs.kwargs["cwd"], str(ctx.paths.root))
            self.assertEqual(
                kwargs.kwargs["creationflags"], get_no_window_creationflags()
            )
            # Inherited environment: PATH preserved, not rewritten.
            self.assertEqual(kwargs.kwargs["env"]["PATH"], "probe-path")
            self.assertIsNot(kwargs.kwargs["env"], os.environ)

    def test_real_execution_reports_unknown_build(self):
        # The host Python always exists; `--version` exits 0 with an
        # unrecognized format, proving the execution path runs entry points
        # (including wrappers) without a shell.
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="linux")
            probe = llama_manager.probe_system_tool_executable(
                ctx, "llama-server", pathlib.Path(sys.executable)
            )
        self.assertTrue(probe["ok"])
        self.assertIsNone(probe["build_tag"])

    def test_symlinked_entry_point_executes(self):
        with tempfile.TemporaryDirectory() as tmp:
            link = pathlib.Path(tmp) / "llama-server"
            try:
                link.symlink_to(pathlib.Path(sys.executable))
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlinks unavailable: {exc}")
            ctx = _make_ctx(tmp, platform="linux")
            probe = llama_manager.probe_system_tool_executable(
                ctx, "llama-server", link
            )
        self.assertTrue(probe["ok"])
        self.assertEqual(probe["executable"], str(link))


class SystemRuntimeHealthTests(unittest.TestCase):
    def _win_ctx(self, tmp):
        ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
        ctx.services.save_config({"backend": "system", "tag": "system"})
        return ctx

    def test_broken_tool_marks_not_ok_and_missing_is_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _write_executable(pathlib.Path(tmp) / "bin" / "llama-server.exe")
            ctx = self._win_ctx(tmp)
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                if str(server) in args[0]:
                    return _completed(args, returncode=3)
                raise AssertionError(f"unexpected probe: {args}")

            with mock.patch.dict(os.environ, {"PATH": str(server.parent)}), mock.patch.object(
                llama_manager.subprocess, "run", side_effect=fake_run
            ):
                health = llama_manager.validate_runtime_dependencies(ctx)
            self.assertFalse(health["ok"])
            self.assertIn("llama-server", health["unchecked_tools"])
            self.assertIn(
                "llama-cli.exe", health["missing_executables"]
            )
            probe = health["system_probes"]["llama-server"]
            self.assertFalse(probe["ok"])
            self.assertEqual(probe["executable"], str(server))

    def test_server_only_reports_build_tag_and_stays_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _write_executable(pathlib.Path(tmp) / "bin" / "llama-server.exe")
            ctx = self._win_ctx(tmp)
            with mock.patch.dict(os.environ, {"PATH": str(server.parent)}), mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed([], stdout="version: 5678 (build 5678)"),
            ):
                health = llama_manager.validate_runtime_dependencies(ctx)
            self.assertTrue(health["ok"])
            self.assertTrue(health["checked"])
            self.assertEqual(health["checked_tools"], ["llama-server"])
            self.assertEqual(health["build_tags"], {"llama-server": "b5678"})
            self.assertIn("llama-cli.exe", health["missing_executables"])

    def test_probes_cached_and_invalidated_by_identity_or_clear(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _write_executable(
                pathlib.Path(tmp) / "bin" / "llama-server.exe", "v1"
            )
            ctx = self._win_ctx(tmp)
            with mock.patch.dict(os.environ, {"PATH": str(server.parent)}), mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed([], stdout="build 100"),
            ) as run:
                first = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
                second = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
            self.assertEqual(first, second)
            run.assert_called_once()
            # A package update replacing the file changes its identity.
            server.write_text("v1 with more content so size and mtime change")
            with mock.patch.dict(os.environ, {"PATH": str(server.parent)}), mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed([], stdout="build 101"),
            ) as run:
                third = llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
            self.assertEqual(run.call_count, 1)
            self.assertEqual(third["build_tags"], {"llama-server": "b101"})
            ctx.state.clear_runtime_health_cache()
            with mock.patch.dict(os.environ, {"PATH": str(server.parent)}), mock.patch.object(
                llama_manager.subprocess,
                "run",
                return_value=_completed([], stdout="build 101"),
            ) as run:
                llama_manager.validate_runtime_dependencies(ctx, ["llama-server"])
            self.assertEqual(run.call_count, 1)


class SystemLaunchIntegrationTests(unittest.TestCase):
    def _ctx_with_server(self, tmp):
        ctx = _make_ctx(tmp, platform="linux")
        ctx.services.save_config({"backend": "system", "tag": "system"})
        server = _write_executable(pathlib.Path(tmp) / "bin" / "llama-server")
        ctx.services.find_tool_executable = lambda tool: (
            server if tool == "llama-server" else None
        )
        model = pathlib.Path(tmp) / "model.gguf"
        model.write_text("model")
        return ctx, server, model

    def test_preflight_uses_system_entry_point(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, server, model = self._ctx_with_server(tmp)
            health = _health_with_probes(
                {"llama-server": _probe_ok(server, server, "b200")}
            )
            with mock.patch.object(
                ctx.services,
                "validate_runtime_dependencies",
                return_value=health,
            ):
                result = process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", str(model)], {}
                )
            self.assertTrue(result["ok"])
            self.assertEqual(result["executable"], "llama-server")

    def test_unknown_build_probe_still_passes_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, server, model = self._ctx_with_server(tmp)
            health = _health_with_probes(
                {"llama-server": _probe_ok(server, server, None)}
            )
            with mock.patch.object(
                ctx.services,
                "validate_runtime_dependencies",
                return_value=health,
            ):
                result = process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", str(model)], {}
                )
            self.assertTrue(result["ok"])

    def test_broken_server_fails_preflight_and_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, server, model = self._ctx_with_server(tmp)
            health = _health_with_probes(
                {},
                ok=False,
            )
            health["system_probes"] = {
                "llama-server": {
                    "ok": False,
                    "build_tag": None,
                    "error": "exited with status 1",
                    "executable": str(server),
                }
            }
            with mock.patch.object(
                ctx.services,
                "validate_runtime_dependencies",
                return_value=health,
            ):
                preflight = process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", str(model)], {}
                )
                self.assertIn("error", preflight)
                self.assertIn("status 1", preflight["error"])
                launched = process_manager.launch_process(
                    ctx, "llama-server", ["-m", str(model)]
                )
                self.assertIn("error", launched)
                self.assertIn("status 1", launched["error"])

    def test_missing_server_reports_path_guidance(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _make_ctx(tmp, platform="linux")
            ctx.services.save_config({"backend": "system", "tag": "system"})
            ctx.services.find_tool_executable = lambda tool: None
            exe_path, error = process_manager._validate_launch_environment(
                ctx, "llama-server"
            )
            self.assertIsNone(exe_path)
            self.assertIn("PATH", error)
            self.assertNotIn("Repair Install", error)

    def test_launch_passes_entry_point_and_inherited_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, server, model = self._ctx_with_server(tmp)
            ctx.services.normalize_llama_api_target = (
                lambda host, port: {"host": host, "port": int(port)}
            )
            health = _health_with_probes(
                {"llama-server": _probe_ok(server, server, "b200")}
            )
            fake_process = mock.Mock(pid=1234)
            fake_process.poll.return_value = None
            with mock.patch.dict(
                os.environ,
                {"PATH": "inherited-path", "LD_LIBRARY_PATH": "inherited-libs"},
            ), mock.patch.object(
                ctx.services, "validate_runtime_dependencies", return_value=health
            ), mock.patch.object(
                process_manager.subprocess, "Popen", return_value=fake_process
            ) as popen, mock.patch.object(
                process_manager.threading, "Thread"
            ):
                result = process_manager.launch_process(
                    ctx,
                    "llama-server",
                    ["-m", str(model)],
                    env={"LLAMA_TEST_VAR": "override"},
                )
            self.assertEqual(result["pid"], 1234)
            child_argv = popen.call_args.args[0]
            self.assertEqual(child_argv[0], str(server))
            self.assertIn(str(model), child_argv)
            child_env = popen.call_args.kwargs["env"]
            self.assertEqual(child_env["PATH"], "inherited-path")
            self.assertEqual(child_env["LD_LIBRARY_PATH"], "inherited-libs")
            self.assertEqual(child_env["LLAMA_TEST_VAR"], "override")
            self.assertNotIn(str(ctx.paths.llama_bin), child_env["PATH"])

    def test_launch_reports_sanitized_error_when_binary_disappears(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, server, model = self._ctx_with_server(tmp)
            health = _health_with_probes(
                {"llama-server": _probe_ok(server, server, "b200")}
            )
            with mock.patch.object(
                ctx.services, "validate_runtime_dependencies", return_value=health
            ), mock.patch.object(
                process_manager.subprocess,
                "Popen",
                side_effect=FileNotFoundError(str(server)),
            ):
                result = process_manager.launch_process(
                    ctx, "llama-server", ["-m", str(model)]
                )
            self.assertIn("error", result)
            self.assertIsNone(ctx.state.process)


class SystemBufferTypesTests(unittest.TestCase):
    def _ctx(self, tmp, found):
        ctx = _make_ctx(tmp, platform="linux")
        ctx.services.save_config({"backend": "system", "tag": "system"})
        ctx.services.find_tool_executable = lambda tool: found.get(tool)
        return ctx

    def _buffer_run(self, exe, test_case):
        def fake_run(args, **kwargs):
            test_case.assertEqual(args[0], str(exe))
            return _completed(
                args,
                stdout="Available buffer types:\nCUDA\n",
                stderr="",
            )

        return fake_run

    def test_server_used_when_cli_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _write_executable(pathlib.Path(tmp) / "llama-server")
            ctx = self._ctx(tmp, {"llama-server": server})
            health = _health_with_probes({"llama-server": _probe_ok(server, server)})
            with mock.patch.object(
                ctx.services, "validate_runtime_dependencies", return_value=health
            ), mock.patch.object(
                process_manager.subprocess, "run", side_effect=self._buffer_run(server, self)
            ):
                result = process_manager.get_buffer_types(ctx)
            self.assertEqual(result["buffers"], ["CPU", "CUDA"])
            self.assertEqual(result["default"], "CUDA")

    def test_cli_preferred_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli = _write_executable(pathlib.Path(tmp) / "llama-cli")
            server = _write_executable(pathlib.Path(tmp) / "llama-server")
            ctx = self._ctx(tmp, {"llama-cli": cli, "llama-server": server})
            health = _health_with_probes(
                {
                    "llama-cli": _probe_ok(cli, cli),
                    "llama-server": _probe_ok(server, server),
                }
            )
            with mock.patch.object(
                ctx.services, "validate_runtime_dependencies", return_value=health
            ), mock.patch.object(
                process_manager.subprocess, "run", side_effect=self._buffer_run(cli, self)
            ):
                result = process_manager.get_buffer_types(ctx)
            self.assertIn("CUDA", result["buffers"])

    def test_neither_available_returns_not_found_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self._ctx(tmp, {})
            result = process_manager.get_buffer_types(ctx)
            self.assertEqual(result["buffers"], ["CPU"])
            self.assertIn("not found", result["error"])


class SystemEstimateTests(unittest.TestCase):
    def _ctx(self, tmp):
        ctx = _make_ctx(tmp, platform="win32", suffix=".exe")
        ctx.services.save_config({"backend": "system", "tag": "system"})
        return ctx

    def test_missing_estimator_reports_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self._ctx(tmp)
            empty = pathlib.Path(tmp) / "empty"
            empty.mkdir()
            with mock.patch.dict(os.environ, {"PATH": str(empty)}), mock.patch.object(
                process_manager.subprocess, "run"
            ) as run:
                result = process_manager.estimate_memory(ctx, "llama-server", [])
            self.assertIn("llama-fit-params", result["error"])
            self.assertIn("unavailable", result["error"])
            run.assert_not_called()

    def test_broken_estimator_blocks_estimate_but_not_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            estimator = _write_executable(
                pathlib.Path(tmp) / "bin" / "llama-fit-params.exe"
            )
            server = _write_executable(
                pathlib.Path(tmp) / "bin" / "llama-server.exe"
            )
            ctx = self._ctx(tmp)
            bad_probe = {
                "ok": False,
                "build_tag": None,
                "error": "exited with status 1",
                "executable": str(estimator),
            }
            health = _health_with_probes({"llama-fit-params": bad_probe}, ok=False)
            model = pathlib.Path(tmp) / "model.gguf"
            model.write_text("model")
            with mock.patch.dict(os.environ, {"PATH": str(estimator.parent)}), mock.patch.object(
                ctx.services, "validate_runtime_dependencies", return_value=health
            ), mock.patch.object(process_manager.subprocess, "run") as run:
                estimated = process_manager.estimate_memory(
                    ctx, "llama-server", ["-m", str(model)]
                )
                self.assertIn("error", estimated)
                self.assertIn("unavailable", estimated["error"])
                run.assert_not_called()
                # Server launches do not require the estimator.
                server_health = _health_with_probes(
                    {"llama-server": _probe_ok(server, server)}
                )
            ctx.services.find_tool_executable = lambda tool: (
                server if tool == "llama-server" else None
            )
            with mock.patch.object(
                ctx.services, "validate_runtime_dependencies", return_value=server_health
            ):
                exe_path, error = process_manager._validate_launch_environment(
                    ctx, "llama-server"
                )
            self.assertIsNone(error)
            self.assertEqual(exe_path, server)

    def test_working_estimator_runs_through_shared_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            estimator = _write_executable(
                pathlib.Path(tmp) / "bin" / "llama-fit-params.exe"
            )
            ctx = self._ctx(tmp)
            health = _health_with_probes(
                {"llama-fit-params": _probe_ok(estimator, estimator)}
            )
            with mock.patch.dict(os.environ, {"PATH": str(estimator.parent)}), mock.patch.object(
                ctx.services, "validate_runtime_dependencies", return_value=health
            ), mock.patch.object(
                process_manager.subprocess,
                "run",
                return_value=_completed([], stdout="host 100 200 300\n"),
            ) as run:
                result = process_manager.estimate_memory(
                    ctx, "llama-server", ["-m", "model.gguf"]
                )
            self.assertEqual(result["rows"][0]["total_mib"], 600)
            self.assertEqual(run.call_args.args[0][0], str(estimator))
            self.assertIn("-fitp", run.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
