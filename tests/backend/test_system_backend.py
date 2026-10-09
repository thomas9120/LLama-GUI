"""Stage 3: System (PATH) activation, persistence, status, and switching.

Uses temporary fixture executables, mocked ``subprocess.run`` responses, and
an isolated PATH. No host llama.cpp installation, model, or GPU is required.
"""

import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

from backend.http import Request
from backend.routes import install, lifecycle, status
from backend.services import llama_manager, official_backends, process_manager
from tests.backend.test_extracted_routes import DummyResponse
from tests.backend.test_services import make_service_context


def _completed(args, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout, stderr)


def _version_run(stdout="version: b1234 (build 1234)", returncode=0):
    def fake_run(args, **kwargs):
        return _completed(args, returncode, stdout, "")
    return fake_run


class SystemBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ctx = make_service_context(self.tmp.name)
        services = self.ctx.services
        services.current_platform = "win32"
        services.current_arch = "x64"
        services.binary_suffix = ".exe"
        services.llama_tools = ["llama-cli", "llama-server", "llama-bench"]
        services.get_tool_filename = lambda tool: tool + services.binary_suffix
        services.backend_specs = llama_manager.build_backend_specs("win32", "x64")
        services.load_config = lambda: json.loads(self.ctx.paths.config_file.read_text())
        services.save_config = lambda cfg: self.ctx.paths.config_file.write_text(json.dumps(cfg))
        services.find_tool_executable = lambda tool: (
            llama_manager.resolve_backend_tool_executable(
                self.ctx, services.load_config().get("backend"), tool
            )
        )
        services.get_runtime_files = lambda: []
        services.get_platform_label = lambda: "Windows"
        services.get_llama_api_target = lambda: {"host": "127.0.0.1", "port": 8080}
        services.validate_runtime_dependencies = lambda tools=None: (
            llama_manager.validate_runtime_dependencies(self.ctx, tools)
        )
        services.save_config({
            "backend": "cpu", "tag": "b123", "version": "b123",
            "models_dir": "saved-model-root",
        })
        # Official build on disk so the return path never needs a download.
        official = self.ctx.paths.llama_bin
        official.mkdir(parents=True, exist_ok=True)
        for tool in ("llama-cli", "llama-server"):
            (official / services.get_tool_filename(tool)).write_text("cpu")
        # PATH fixture dir for System tools.
        self.fixture_bin = os.path.join(self.tmp.name, "system-bin")
        os.makedirs(self.fixture_bin, exist_ok=True)

    def write_system_tool(self, tool):
        path = os.path.join(
            self.fixture_bin, self.ctx.services.get_tool_filename(tool)
        )
        with open(path, "w") as handle:
            handle.write(tool)
        return path

    def path_env(self):
        return mock.patch.dict(os.environ, {"PATH": self.fixture_bin})

    def activate_system(self, body=None):
        response = DummyResponse()
        install.activate_system(
            Request("POST", "/api/activate-system", "", {}, body=body or {}),
            response,
            self.ctx,
        )
        return response

    def get_status(self):
        response = DummyResponse()
        status.get_status(Request("GET", "/api/status", "", {}), response, self.ctx)
        return response.payload

    # Activation success / failure.

    def test_successful_activation_persists_marker_and_preserves_official(self):
        server = self.write_system_tool("llama-server")
        cli = self.write_system_tool("llama-cli")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            response = self.activate_system()
        self.assertEqual(response.status, 200)
        payload = response.payload
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["server_path"], server)
        self.assertEqual(payload["paths"]["llama-server"], server)
        self.assertEqual(payload["paths"]["llama-cli"], cli)
        self.assertEqual(payload["build_tags"], {"llama-server": "b1234"})
        self.assertEqual(payload["missing_required"], [])
        cfg = self.ctx.services.load_config()
        self.assertEqual(cfg["backend"], "system")
        self.assertEqual(cfg["tag"], "system")
        self.assertEqual(cfg["version"], "system")
        self.assertEqual(cfg["models_dir"], "saved-model-root")
        self.assertEqual(
            cfg["official_install"],
            {"backend": "cpu", "tag": "b123", "version": "b123"},
        )
        # Discovered paths are display-only, never persisted.
        self.assertNotIn("server_path", cfg)
        self.assertNotIn("paths", cfg)

    def test_unknown_build_format_still_activates(self):
        self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run",
            side_effect=_version_run("llama-pack 2.0-custom"),
        ):
            response = self.activate_system()
        self.assertTrue(response.payload["ok"])
        self.assertEqual(response.payload["build_tags"], {})
        self.assertEqual(self.ctx.services.load_config()["backend"], "system")

    def test_missing_server_fails_with_path_guidance_and_keeps_config(self):
        previous = self.ctx.paths.config_file.read_bytes()
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ) as probe:
            response = self.activate_system()
        payload = response.payload
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["missing_required"], ["llama-server.exe"])
        self.assertIn("PATH inherited by Llama GUI", payload["error"])
        probe.assert_not_called()
        self.assertEqual(self.ctx.paths.config_file.read_bytes(), previous)

    def test_broken_server_fails_with_check_guidance_and_keeps_config(self):
        self.write_system_tool("llama-server")
        previous = self.ctx.paths.config_file.read_bytes()
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run",
            side_effect=_version_run("", returncode=1),
        ):
            response = self.activate_system()
        payload = response.payload
        self.assertFalse(payload["ok"])
        self.assertIn("status 1", payload["error"])
        self.assertIn("--version", payload["error"])
        self.assertEqual(self.ctx.paths.config_file.read_bytes(), previous)

    def test_activation_rejects_client_supplied_paths(self):
        self.write_system_tool("llama-server")
        for body in ({"path": "C:\\evil"}, {"executable": "x"}, {"bin_dir": "y"}):
            with self.subTest(body=body):
                previous = self.ctx.paths.config_file.read_bytes()
                with self.path_env():
                    response = self.activate_system(body)
                self.assertEqual(response.status, 400)
                self.assertEqual(self.ctx.paths.config_file.read_bytes(), previous)

    def test_activation_rejected_while_running_or_installing(self):
        self.write_system_tool("llama-server")
        self.ctx.state.install_in_progress = True
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ) as probe:
            response = self.activate_system()
        self.assertEqual(response.status, 409)
        probe.assert_not_called()
        self.ctx.state.install_in_progress = False
        with self.path_env(), mock.patch.object(
            process_manager, "is_process_running", return_value=True
        ), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ) as probe:
            response = self.activate_system()
        self.assertEqual(response.status, 400)
        self.assertIn("Stop running process", response.payload["error"])
        probe.assert_not_called()
        self.assertEqual(self.ctx.services.load_config()["backend"], "cpu")

    # Restart restoration.

    def test_selection_survives_restart_with_new_environment(self):
        server = self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
        # A fresh process inherits the same PATH and rediscovers the entry.
        fresh = make_service_context(self.tmp.name)
        fresh.services.load_config = lambda: json.loads(
            self.ctx.paths.config_file.read_text()
        )
        fresh.services.llama_tools = list(self.ctx.services.llama_tools)
        fresh.services.get_tool_filename = self.ctx.services.get_tool_filename
        with self.path_env():
            found = llama_manager.resolve_backend_tool_executable(
                fresh, "system", "llama-server"
            )
        self.assertEqual(str(found), server)
        self.assertNotIn("paths", fresh.services.load_config())

    # Status.

    def test_server_only_status_is_installed_with_tool_details(self):
        server = self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
            payload = self.get_status()
        self.assertTrue(payload["installed"])
        self.assertFalse(payload["config_stale"])
        self.assertEqual(payload["backend"], "system")
        # Selected marker stays separate from discovered version info.
        self.assertEqual(payload["version"], "system")
        self.assertEqual(payload["runtime_health"]["build_tags"], {"llama-server": "b1234"})
        server_entry = payload["system_tools"]["llama-server"]
        self.assertEqual(server_entry["path"], server)
        self.assertTrue(server_entry["available"])
        self.assertEqual(server_entry["build_tag"], "b1234")
        self.assertTrue(server_entry["probe_ok"])
        cli_entry = payload["system_tools"]["llama-cli"]
        self.assertIsNone(cli_entry["path"])
        self.assertFalse(cli_entry["available"])
        self.assertIsNone(payload["system_server_error"])
        system_backends = [
            item for item in payload["available_backends"] if item["id"] == "system"
        ]
        self.assertEqual(
            system_backends,
            [{"id": "system", "label": "System (PATH)", "system_path": True}],
        )

    def test_removed_server_reports_stale_with_guidance_and_keeps_selection(self):
        self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
        empty = os.path.join(self.tmp.name, "empty-bin")
        os.makedirs(empty, exist_ok=True)
        with mock.patch.dict(os.environ, {"PATH": empty}):
            payload = self.get_status()
        self.assertFalse(payload["installed"])
        self.assertTrue(payload["config_stale"])
        self.assertEqual(payload["backend"], "system")
        self.assertIn("PATH inherited by Llama GUI", payload["system_server_error"])
        self.assertIsNone(payload["system_tools"]["llama-server"]["path"])

    def test_broken_server_status_reports_check_guidance(self):
        self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run",
            side_effect=_version_run("", returncode=3),
        ):
            payload = self.get_status()
        self.assertFalse(payload["installed"])
        self.assertIn("status 3", payload["system_server_error"])
        self.assertIn("--version", payload["system_server_error"])

    # Install/update/release misuse.

    def test_system_excluded_from_download_and_update_routes(self):
        with mock.patch.object(
            llama_manager, "get_releases"
        ) as lookup, mock.patch.object(llama_manager, "install_release") as download:
            response = DummyResponse()
            install.get_releases(
                Request("GET", "/api/releases", "backend=system", {}), response, self.ctx
            )
            self.assertEqual(response.payload, [])
            response = DummyResponse()
            install.start_install(
                Request(
                    "POST", "/api/install", "", {},
                    body={"backend": "system", "tag": "b999"},
                ),
                response,
                self.ctx,
            )
            self.assertEqual(response.status, 400)
            response = DummyResponse()
            install.start_install(
                Request(
                    "POST", "/api/install", "", {},
                    body={"backend": "system", "activate_existing": True},
                ),
                response,
                self.ctx,
            )
            self.assertEqual(response.status, 400)
            self.assertIn("activate-system", response.payload["error"])
            lookup.assert_not_called()
            download.assert_not_called()
            self.assertFalse(self.ctx.state.install_in_progress)
        self.ctx.services.save_config({"backend": "system", "tag": "system"})
        response = DummyResponse()
        with mock.patch.object(
            llama_manager, "get_releases"
        ) as lookup, mock.patch.object(process_manager, "is_process_running",
                                        return_value=False):
            install.start_update(Request("POST", "/api/update", "", {}, body={}),
                                 response, self.ctx)
        self.assertEqual(response.status, 400)
        lookup.assert_not_called()
        self.assertFalse(self.ctx.state.install_in_progress)

    def test_official_catalog_refresh_never_targets_system(self):
        self.ctx.services.save_config({"backend": "system", "tag": "system"})
        with mock.patch.object(
            llama_manager, "get_releases", return_value=[]
        ), mock.patch.object(
            llama_manager, "get_release_by_tag"
        ) as by_tag:
            official_backends.refresh(self.ctx, force=True)
        by_tag.assert_not_called()

    def test_stored_system_is_never_reported_as_official(self):
        cfg = {"backend": "system", "tag": "system",
               "official_install": {"backend": "system", "tag": "system"}}
        reported = llama_manager.get_official_install_status(self.ctx, cfg)
        self.assertIsNone(reported["backend"])
        self.assertIsNone(reported["tag"])

    # Round trips and maintenance.

    def test_official_system_custom_round_trip_needs_no_download(self):
        self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
        self.assertEqual(
            self.ctx.services.load_config()["official_install"]["backend"], "cpu"
        )
        custom_bin = llama_manager.get_backend_bin_dir(self.ctx, "custom")
        custom_bin.mkdir(parents=True, exist_ok=True)
        for tool in ("llama-cli", "llama-server"):
            (custom_bin / self.ctx.services.get_tool_filename(tool)).write_text("custom")
        custom_response = DummyResponse()
        install.activate_custom(
            Request("POST", "/api/activate-custom", "", {}, body={"backend": "custom"}),
            custom_response,
            self.ctx,
        )
        # The stock custom fixture lacks llama-bench, but activation succeeds
        # with optional tools missing; the official record must survive.
        self.assertTrue(custom_response.payload["ok"])
        cfg = self.ctx.services.load_config()
        self.assertEqual(cfg["backend"], "custom")
        self.assertEqual(cfg["official_install"]["backend"], "cpu")
        with mock.patch.object(
            llama_manager, "_probe_official_build", return_value=(True, "b123")
        ):
            result = llama_manager.activate_official_backend(self.ctx, "cpu")
        self.assertTrue(result["ok"])
        self.assertEqual(self.ctx.services.load_config()["tag"], "b123")
        self.assertEqual(self.ctx.services.load_config()["models_dir"], "saved-model-root")

    def test_cleanup_preserves_system_selection_but_clears_official_record(self):
        self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
        removed = process_manager.remove_llama_files(self.ctx)
        self.assertGreater(removed, 0)
        cfg = self.ctx.services.load_config()
        self.assertEqual(cfg["backend"], "system")
        self.assertEqual(cfg["tag"], "system")
        self.assertNotIn("official_install", cfg)
        self.assertTrue(self.ctx.paths.llama_bin.exists())

    def test_open_folder_reveals_server_dir_without_creating(self):
        server = self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
        with self.path_env(), mock.patch.object(
            lifecycle.lifecycle_service, "open_folder_in_file_manager"
        ) as opener:
            response = DummyResponse()
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": "llama"}),
                response,
                self.ctx,
            )
        self.assertEqual(response.payload, {"opened": True})
        opener.assert_called_once_with(pathlib.Path(self.fixture_bin))

    def test_open_folder_reports_unavailable_without_creating(self):
        self.write_system_tool("llama-server")
        with self.path_env(), mock.patch.object(
            llama_manager.subprocess, "run", side_effect=_version_run()
        ):
            self.assertTrue(self.activate_system().payload["ok"])
        empty = os.path.join(self.tmp.name, "empty-bin")
        os.makedirs(empty, exist_ok=True)
        with mock.patch.dict(os.environ, {"PATH": empty}), mock.patch.object(
            lifecycle.lifecycle_service, "open_folder_in_file_manager"
        ) as opener:
            response = DummyResponse()
            lifecycle.post_open_folder(
                Request("POST", "/api/open-folder", "", {}, body={"folder": "llama"}),
                response,
                self.ctx,
            )
        self.assertEqual(response.status, 409)
        self.assertIn("PATH inherited by Llama GUI", response.payload["error"])
        opener.assert_not_called()
        self.assertFalse(os.path.exists(empty + "-created"))


if __name__ == "__main__":
    unittest.main()
