"""Stage 5: System (PATH) representative layout matrix, end to end.

Exercises the three representative installations from the plan — server
only, a complete toolset, and wrapper/symlink entry points — plus a broken
server, different CLI/server builds, an unknown version format, and a
replaced package target. Each layout runs activation, status, preflight,
and (where meaningful) launch against temporary fixture directories with
an isolated PATH and mocked or fixture-only subprocess execution. No host
llama.cpp installation, model, or GPU is required.
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from backend.http import Request
from backend.routes import status as status_routes
from backend.services import llama_manager, process_manager
from tests.backend.test_extracted_routes import DummyResponse
from tests.backend.test_system_path_discovery import (
    _exact_which_fixture,
    _make_ctx,
    _write_executable,
)


def _completed(args, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout, stderr)


def _probe_dispatcher(mapping, calls):
    """Mock ``subprocess.run`` serving canned --version results per entry point."""

    def fake_run(args, **kwargs):
        calls.append(list(args))
        assert list(args[1:]) == ["--version"], f"probe must be model-free: {args!r}"
        entry = mapping.get(args[0])
        if entry is None:
            raise AssertionError(f"unexpected probe target: {args[0]!r}")
        returncode, stdout = entry
        return _completed(args, returncode, stdout)

    return fake_run


def _status_payload(ctx):
    response = DummyResponse()
    status_routes.get_status(Request("GET", "/api/status", "", {}), response, ctx)
    return response.payload


class SystemLayoutTests(unittest.TestCase):
    def _ctx(self, tmp):
        ctx = _make_ctx(tmp, platform="linux", suffix="")
        ctx.services.save_config({})
        ctx.services.normalize_llama_api_target = (
            lambda host, port: {"host": host, "port": int(port)}
        )
        return ctx

    def _model(self, tmp):
        model = pathlib.Path(tmp) / "model.gguf"
        model.write_text("model")
        return model

    # -- Layout A: server only ------------------------------------------------

    def test_server_only_layout_activates_with_optional_tools_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _write_executable(pathlib.Path(tmp) / "tools" / "llama-server")
            ctx = self._ctx(tmp)
            calls = []
            mapping = {str(server): (0, "version: b5000 (build 5000)")}
            with mock.patch.dict(os.environ, {"PATH": str(server.parent)}), \
                _exact_which_fixture(), \
                mock.patch.object(
                    llama_manager.subprocess, "run",
                    side_effect=_probe_dispatcher(mapping, calls),
                ):
                result = llama_manager.activate_system_backend(ctx)
                self.assertTrue(result["ok"])
                self.assertEqual(result["missing_required"], [])
                self.assertIn("llama-cli", result["missing"])
                payload = _status_payload(ctx)
            self.assertTrue(payload["installed"])
            self.assertEqual(payload["backend"], "system")
            self.assertEqual(
                payload["runtime_health"]["build_tags"], {"llama-server": "b5000"}
            )
            self.assertTrue(payload["system_tools"]["llama-server"]["available"])
            self.assertFalse(payload["system_tools"]["llama-cli"]["available"])
            self.assertIsNone(payload["system_server_error"])
            # Only the server probe ran during activation; status probed it again.
            self.assertTrue(all(call[0] == str(server) for call in calls))

    # -- Layout B: complete toolset -------------------------------------------

    def test_complete_toolset_reports_every_tool_and_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "pkg" / "bin"
            tools = {}
            for tool in ("llama-cli", "llama-server", "llama-bench", "llama-perplexity"):
                tools[tool] = _write_executable(bindir / tool)
            ctx = self._ctx(tmp)
            tags = {
                "llama-cli": "b5001",
                "llama-server": "b5002",
                "llama-bench": "b5003",
                "llama-perplexity": "b5004",
            }
            mapping = {
                str(exe): (0, f"version: {tag} (build {tag[1:]})")
                for tool, exe in tools.items()
                for tag in (tags[tool],)
            }
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}), \
                _exact_which_fixture(), \
                mock.patch.object(
                    llama_manager.subprocess, "run",
                    side_effect=_probe_dispatcher(mapping, []),
                ):
                result = llama_manager.activate_system_backend(ctx)
                self.assertTrue(result["ok"])
                self.assertEqual(result["missing"], [])
                payload = _status_payload(ctx)
                # Probing every tool on each status poll would spawn a
                # subprocess per tool; optional tools report tags on demand.
                extra = llama_manager.validate_runtime_dependencies(
                    ctx, ["llama-bench", "llama-perplexity"]
                )
            self.assertTrue(payload["installed"])
            self.assertEqual(
                payload["runtime_health"]["build_tags"],
                {"llama-cli": "b5001", "llama-server": "b5002"},
            )
            self.assertEqual(
                extra["build_tags"],
                {"llama-bench": "b5003", "llama-perplexity": "b5004"},
            )
            for tool, exe in tools.items():
                entry = payload["system_tools"][tool]
                self.assertTrue(entry["available"])
                self.assertEqual(entry["path"], str(exe))

    # -- Layout C: symlink entry point -----------------------------------------

    def test_symlink_entry_point_used_end_to_end_without_resolving(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = _write_executable(pathlib.Path(tmp) / "store" / "llama-server-real")
            link = pathlib.Path(tmp) / "bin" / "llama-server"
            link.parent.mkdir(parents=True, exist_ok=True)
            try:
                link.symlink_to(real)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlinks unavailable: {exc}")
            ctx = self._ctx(tmp)
            model = self._model(tmp)
            calls = []
            mapping = {str(link): (0, "version: b5100 (build 5100)")}
            fake_process = mock.Mock(pid=4321)
            fake_process.poll.return_value = None
            with mock.patch.dict(os.environ, {"PATH": str(link.parent)}), \
                _exact_which_fixture(), \
                mock.patch.object(
                    llama_manager.subprocess, "run",
                    side_effect=_probe_dispatcher(mapping, calls),
                ), \
                mock.patch.object(
                    process_manager.subprocess, "Popen", return_value=fake_process
                ) as popen, \
                mock.patch.object(process_manager.threading, "Thread"):
                self.assertTrue(llama_manager.activate_system_backend(ctx)["ok"])
                preflight = process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", str(model)], {}
                )
                self.assertTrue(preflight["ok"])
                launched = process_manager.launch_process(
                    ctx, "llama-server", ["-m", str(model)]
                )
                self.assertEqual(launched["pid"], 4321)
                # Discovery, probe, preflight, and exec all used the link itself.
                self.assertEqual(
                    llama_manager.resolve_backend_tool_executable(
                        ctx, "system", "llama-server"
                    ),
                    link,
                )
            # The version probes targeted the link, never its target.
            self.assertTrue(calls, "expected at least one version probe")
            self.assertTrue(all(call[0] == str(link) for call in calls))
            self.assertEqual(popen.call_args.args[0][0], str(link))

    # -- Layout C: POSIX wrapper script ------------------------------------------

    def test_posix_wrapper_script_activates_and_launches(self):
        if sys.platform == "win32":
            self.skipTest("POSIX shell wrappers need a native exec host")
        with tempfile.TemporaryDirectory() as tmp:
            wrapper = pathlib.Path(tmp) / "wrap" / "llama-server"
            wrapper.parent.mkdir(parents=True, exist_ok=True)
            wrapper.write_text(
                "#!/bin/sh\n"
                'if [ "$1" = "--version" ]; then echo "version: b5200 (build 5200)"; exit 0; fi\n'
                'echo "wrapper ran with: $@"\n'
            )
            wrapper.chmod(0o755)
            ctx = self._ctx(tmp)
            model = self._model(tmp)
            with mock.patch.dict(os.environ, {"PATH": str(wrapper.parent)}), \
                _exact_which_fixture():
                result = llama_manager.activate_system_backend(ctx)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["build_tags"], {"llama-server": "b5200"})
                payload = _status_payload(ctx)
            self.assertTrue(payload["installed"])
            self.assertEqual(
                payload["system_tools"]["llama-server"]["path"], str(wrapper)
            )
            with mock.patch.dict(os.environ, {"PATH": str(wrapper.parent)}), \
                _exact_which_fixture():
                preflight = process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", str(model)], {}
                )
                self.assertTrue(preflight["ok"], preflight)

    # -- Broken server in an otherwise complete layout --------------------------

    def test_broken_server_fails_activation_without_touching_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            server = _write_executable(bindir / "llama-server")
            _write_executable(bindir / "llama-cli")
            ctx = self._ctx(tmp)
            before = dict(ctx.services.load_config())
            calls = []
            mapping = {
                str(server): (1, ""),
                str(bindir / "llama-cli"): (0, "version: b5001 (build 5001)"),
            }
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}), \
                _exact_which_fixture(), \
                mock.patch.object(
                    llama_manager.subprocess, "run",
                    side_effect=_probe_dispatcher(mapping, calls),
                ):
                result = llama_manager.activate_system_backend(ctx)
            self.assertFalse(result["ok"])
            self.assertIn("status 1", result["error"])
            self.assertEqual(dict(ctx.services.load_config()), before)
            # The failing probe targeted the discovered entry point itself.
            self.assertEqual(calls, [[str(server), "--version"]])

    # -- Mixed builds and unknown version format -----------------------------------

    def test_mixed_builds_report_per_tool_tags_and_unknown_stays_conservative(self):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = pathlib.Path(tmp) / "bin"
            cli = _write_executable(bindir / "llama-cli")
            server = _write_executable(bindir / "llama-server")
            bench = _write_executable(bindir / "llama-bench")
            ctx = self._ctx(tmp)
            mapping = {
                str(cli): (0, "version: b6100 (build 6100)"),
                str(server): (0, "version: b6200 (build 6200)"),
                str(bench): (0, "llama-pack 2.0-custom"),
            }
            with mock.patch.dict(os.environ, {"PATH": str(bindir)}), \
                _exact_which_fixture(), \
                mock.patch.object(
                    llama_manager.subprocess, "run",
                    side_effect=_probe_dispatcher(mapping, []),
                ):
                self.assertTrue(llama_manager.activate_system_backend(ctx)["ok"])
                payload = _status_payload(ctx)
            self.assertTrue(payload["installed"])
            self.assertEqual(
                payload["runtime_health"]["build_tags"],
                {"llama-cli": "b6100", "llama-server": "b6200"},
            )
            bench_entry = payload["system_tools"]["llama-bench"]
            self.assertTrue(bench_entry["available"])
            self.assertIsNone(bench_entry["build_tag"])

    # -- Replaced package target ----------------------------------------------------

    def test_replaced_package_target_is_rediscovered_for_later_launches(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _write_executable(
                pathlib.Path(tmp) / "bin" / "llama-server", "v1"
            )
            ctx = self._ctx(tmp)
            model = self._model(tmp)
            outputs = {str(server): (0, "version: b7001 (build 7001)")}
            calls = []
            with mock.patch.dict(os.environ, {"PATH": str(server.parent)}), \
                _exact_which_fixture(), \
                mock.patch.object(
                    llama_manager.subprocess, "run",
                    side_effect=_probe_dispatcher(outputs, calls),
                ):
                self.assertTrue(llama_manager.activate_system_backend(ctx)["ok"])
                first = process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", str(model)], {}
                )
                self.assertTrue(first["ok"])
                calls_before = len(calls)
                # A package update replaces the binary while the GUI is open.
                server.write_text("v1 with more content so size and mtime change")
                outputs[str(server)] = (0, "version: b7002 (build 7002)")
                second = process_manager.preflight_launch(
                    ctx, "llama-server", ["-m", str(model)], {}
                )
                self.assertTrue(second["ok"])
                # The stale cached probe was not reused for the later launch.
                self.assertGreater(len(calls), calls_before)
                health = llama_manager.validate_runtime_dependencies(
                    ctx, ["llama-server"]
                )
                self.assertEqual(health["build_tags"], {"llama-server": "b7002"})


if __name__ == "__main__":
    unittest.main()
