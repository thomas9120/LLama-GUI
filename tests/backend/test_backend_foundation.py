import unittest

from backend import config
from backend.context import AppContext, AppPaths, ServerConfig
from backend.state import AtomicDict, ServerState


class BackendConfigTests(unittest.TestCase):
    def test_paths_are_rooted_at_repository(self):
        paths = AppPaths()

        self.assertEqual(paths.root, config.ROOT_DIR)
        self.assertEqual(paths.models, config.ROOT_DIR / "models")
        self.assertEqual(paths.presets, config.ROOT_DIR / "presets")
        self.assertEqual(paths.config_file, config.ROOT_DIR / "config.json")

    def test_server_config_uses_shared_ports(self):
        server_config = ServerConfig()

        self.assertEqual(server_config.gui_port, 5240)
        self.assertEqual(server_config.llama_port, 8080)
        self.assertEqual(server_config.gui_host, "127.0.0.1")
        self.assertFalse(server_config.supervised)

    def test_gui_env_parsers_accept_valid_values(self):
        self.assertEqual(config.parse_gui_host("0.0.0.0"), "0.0.0.0")
        self.assertEqual(config.parse_gui_host("*"), "0.0.0.0")
        self.assertEqual(config.parse_gui_host("[::]"), "::")
        self.assertEqual(config.parse_gui_host("192.168.1.10"), "192.168.1.10")
        self.assertEqual(config.parse_gui_port("5250"), 5250)
        self.assertEqual(
            config.parse_gui_allowed_hosts("Llama-Box.local, 192.168.1.20, [::1]"),
            ("llama-box.local", "192.168.1.20", "::1"),
        )

    def test_gui_env_parsers_fall_back_for_invalid_values(self):
        self.assertEqual(config.parse_gui_host(""), "127.0.0.1")
        self.assertEqual(config.parse_gui_host("192.168.1.0/24"), "127.0.0.1")
        self.assertEqual(config.parse_gui_port("not-a-port"), 5240)
        self.assertEqual(config.parse_gui_port("70000"), 5240)
        self.assertEqual(config.parse_gui_allowed_hosts("192.168.1.0/24,,\n"), ())

    def test_bool_env_parser_accepts_explicit_true_values(self):
        for value in ("1", "true", "TRUE", "yes", "on"):
            self.assertTrue(config.parse_bool_env(value))
        for value in (None, "", "0", "false", "off", "unexpected"):
            self.assertFalse(config.parse_bool_env(value))


class AtomicDictTests(unittest.TestCase):
    def test_snapshot_is_a_copy(self):
        state = AtomicDict({"status": "idle", "count": 1})

        snapshot = state.snapshot()
        snapshot["count"] = 99

        self.assertEqual(state.snapshot(), {"status": "idle", "count": 1})

    def test_update_and_replace_return_copied_state(self):
        state = AtomicDict({"status": "idle"})

        updated = state.update(status="running")
        updated["status"] = "changed"

        self.assertEqual(state.snapshot(), {"status": "running"})
        self.assertEqual(state.replace({"status": "done"}), {"status": "done"})


class ServerStateTests(unittest.TestCase):
    def test_default_state_shapes_match_existing_backend_status(self):
        state = ServerState()

        self.assertEqual(
            state.download_progress.snapshot(),
            {"total": 0, "downloaded": 0, "status": "idle", "message": ""},
        )
        self.assertEqual(state.model_download.snapshot()["status"], "idle")
        self.assertEqual(state.remote_tunnel.snapshot()["message"], "Remote tunnel is not running.")
        self.assertEqual(state.llama_api_target.snapshot(), {"host": "127.0.0.1", "port": 8080})
        self.assertIsNone(state.active_runtime)
        self.assertEqual(state.runtime_generation, 0)
        self.assertEqual(state.remote_tunnel_generation, 0)
        self.assertFalse(state.restart_requested.is_set())

    def test_app_context_groups_paths_config_and_state(self):
        ctx = AppContext()

        self.assertIsInstance(ctx.paths, AppPaths)
        self.assertIsInstance(ctx.config, ServerConfig)
        self.assertIsInstance(ctx.state, ServerState)


if __name__ == "__main__":
    unittest.main()

