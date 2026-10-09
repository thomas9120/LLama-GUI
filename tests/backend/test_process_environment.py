import os
import unittest
from pathlib import Path
from unittest import mock

from backend.context import AppContext
from backend.http import Request
from backend.routes import process
from backend.services import process_manager


class ProcessEnvironmentTests(unittest.TestCase):
    def test_rejects_invalid_overrides_before_launch(self):
        for env in ([], {"PATH": "x"}, {"LLAMA_GUI_PORT": "1"},
                    {"LLAMA_ARG_API_KEY": "secret"}, {"GGML_X": 1},
                    {"GGML_X": "a\0b"}, {"GGML_X": "a\nb"}, {"GGML_X": "x" * 16000}):
            with self.subTest(env_type=type(env).__name__), mock.patch.object(process_manager.subprocess, "Popen") as popen:
                result = process_manager.launch_process(AppContext(), "llama-cli", [], env=env)
                self.assertIn("error", result)
                popen.assert_not_called()

    def test_route_passes_overrides_to_child_only_and_next_launch_is_clean(self):
        ctx = AppContext()
        ctx.services.load_config = lambda: {}
        ctx.services.llama_tools = ["llama-cli"]
        response = mock.Mock()
        overrides = {"LLAMA_MMAP_RANDOM": "1", "GGML_OP_OFFLOAD_MIN_BATCH": "512", "GGML_EMPTY": ""}
        with (
            mock.patch.dict(os.environ, {"GGML_OP_OFFLOAD_MIN_BATCH": "32"}),
            mock.patch.object(process_manager, "_validate_launch_environment", return_value=(Path("llama-cli"), None)),
            mock.patch.object(process_manager, "_build_active_runtime", return_value={"generation": 1}),
            mock.patch.object(process_manager.threading, "Thread"),
            mock.patch.object(process_manager.subprocess, "Popen") as popen,
        ):
            before = dict(os.environ)
            process.launch(Request("POST", "/api/launch", "", {}, body={"tool": "llama-cli", "args": [], "env": overrides}), response, ctx)
            response.error.assert_not_called()
            child_env = popen.call_args.kwargs["env"]
            for name, value in overrides.items():
                self.assertEqual(child_env[name], value)
            self.assertEqual(dict(os.environ), before)
            self.assertIn(str(ctx.paths.llama_bin), child_env["PATH"])
            with ctx.state.process_lock:
                ctx.state.process = None
            result = process_manager.launch_process(ctx, "llama-cli", [])
            self.assertNotIn("error", result)
            self.assertEqual(popen.call_args.kwargs["env"]["GGML_OP_OFFLOAD_MIN_BATCH"], "32")
            self.assertEqual(overrides["GGML_OP_OFFLOAD_MIN_BATCH"], "512")

    def test_literal_values_and_empty_values_are_preserved(self):
        value = {"GGML_TEST": "a=b; $HOME 'quoted'", "GGML_EMPTY": ""}
        self.assertEqual(process_manager.normalize_process_env(value), value)


class SystemProcessEnvironmentTests(unittest.TestCase):
    def _system_ctx(self):
        ctx = AppContext()
        ctx.services.load_config = lambda: {"backend": "system", "tag": "system"}
        ctx.services.llama_tools = ["llama-cli", "llama-server"]
        ctx.services.get_tool_filename = lambda tool: tool
        ctx.services.current_platform = "linux"
        return ctx

    def test_system_env_preserves_inherited_paths_without_repo_prepend(self):
        ctx = self._system_ctx()
        with mock.patch.dict(
            os.environ,
            {
                "PATH": "inherited-path",
                "LD_LIBRARY_PATH": "inherited-libs",
                "DYLD_LIBRARY_PATH": "inherited-dyld",
            },
        ):
            env = process_manager._build_process_env(ctx)
        self.assertEqual(env["PATH"], "inherited-path")
        self.assertEqual(env["LD_LIBRARY_PATH"], "inherited-libs")
        self.assertEqual(env["DYLD_LIBRARY_PATH"], "inherited-dyld")
        self.assertNotIn(str(ctx.paths.llama_bin), env["PATH"])
        self.assertNotIn(str(ctx.paths.llama_bin), env["LD_LIBRARY_PATH"])

    def test_official_env_still_prepends_repo_bin_dir(self):
        ctx = self._system_ctx()
        ctx.services.load_config = lambda: {"backend": "cpu", "tag": "b1"}
        with mock.patch.dict(os.environ, {"PATH": "inherited-path"}):
            env = process_manager._build_process_env(ctx)
        self.assertTrue(
            env["PATH"].startswith(str(ctx.paths.llama_bin) + os.pathsep)
        )

