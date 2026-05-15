import unittest

from backend.routing import Router


class RouterTests(unittest.TestCase):
    def test_exact_route_match(self):
        router = Router().add("GET", "/api/status", "handle_status")

        match = router.match("GET", "/api/status")

        self.assertIsNotNone(match)
        self.assertEqual(match.handler_name, "handle_status")
        self.assertEqual(match.params, {})

    def test_method_must_match(self):
        router = Router().add("GET", "/api/status", "handle_status")

        self.assertIsNone(router.match("POST", "/api/status"))

    def test_prefix_route_params(self):
        router = Router().add_prefix("DELETE", "/api/presets/", "delete_preset", "name")

        match = router.match("DELETE", "/api/presets/My%20Preset")

        self.assertIsNotNone(match)
        self.assertEqual(match.handler_name, "delete_preset")
        self.assertEqual(match.params, {"name": "My%20Preset"})

    def test_prefix_route_param_keeps_raw_encoded_suffix(self):
        router = Router().add_prefix("DELETE", "/api/presets/", "delete_preset", "name")

        match = router.match("DELETE", "/api/presets/My%20Preset%2FBackup")

        self.assertIsNotNone(match)
        self.assertEqual(match.params, {"name": "My%20Preset%2FBackup"})

    def test_prefix_route_param_captures_full_suffix(self):
        router = Router().add_prefix("DELETE", "/api/presets/", "delete_preset", "name")

        match = router.match("DELETE", "/api/presets/folder/preset")

        self.assertIsNotNone(match)
        self.assertEqual(match.params, {"name": "folder/preset"})

    def test_first_registered_overlapping_prefix_wins(self):
        router = (
            Router()
            .add_prefix("GET", "/api/", "handle_api", "path")
            .add_prefix("GET", "/api/presets/", "handle_preset", "name")
        )

        match = router.match("GET", "/api/presets/example")

        self.assertIsNotNone(match)
        self.assertEqual(match.handler_name, "handle_api")
        self.assertEqual(match.params, {"path": "presets/example"})

    def test_unknown_route(self):
        router = Router().add("GET", "/api/status", "handle_status")

        self.assertIsNone(router.match("GET", "/api/missing"))


if __name__ == "__main__":
    unittest.main()
