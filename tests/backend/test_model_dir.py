import pathlib
import tempfile
import unittest
from unittest import mock

from backend.context import AppContext, AppPaths
from backend.services import model_dir


def make_context(root):
    root = pathlib.Path(root)
    ctx = AppContext(
        paths=AppPaths(
            root=root,
            models=root / "models",
            config_file=root / "config.json",
        )
    )
    store = {"version": "2026.08", "backend": "cpu", "tag": "b1"}

    def save_config(config_data):
        store.clear()
        store.update(config_data)

    ctx.services.load_config = lambda: dict(store)
    ctx.services.save_config = save_config
    return ctx, store


class ModelDirServiceTests(unittest.TestCase):
    def test_default_root_is_available_and_created_on_first_use(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _store = make_context(tmp)

            info = model_dir.get_models_dir_info(ctx)

            self.assertEqual(info["models_dir"], str(ctx.paths.models))
            self.assertEqual(info["models_arg_root"], "models")
            self.assertTrue(info["models_dir_is_default"])
            self.assertTrue(info["models_dir_available"])
            self.assertEqual(model_dir.get_models_dir(ctx), ctx.paths.models)
            self.assertTrue(ctx.paths.models.is_dir())

    def test_custom_root_is_resolved_and_preserves_unrelated_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, store = make_context(tmp)
            library = pathlib.Path(tmp) / "library"
            library.mkdir()
            custom = library / ".." / "library"

            info = model_dir.set_models_dir(ctx, str(custom))

            resolved = custom.resolve()
            self.assertEqual(store["models_dir"], str(resolved))
            self.assertEqual(store["version"], "2026.08")
            self.assertEqual(store["backend"], "cpu")
            self.assertEqual(store["tag"], "b1")
            self.assertEqual(info["models_arg_root"], str(resolved))
            self.assertFalse(info["models_dir_is_default"])
            self.assertTrue(info["models_dir_available"])
            self.assertEqual(model_dir.get_models_dir(ctx), resolved)

    def test_empty_or_null_resets_to_default_without_rewriting_other_keys(self):
        for reset_value in (None, "", "   "):
            with self.subTest(reset_value=reset_value), tempfile.TemporaryDirectory() as tmp:
                ctx, store = make_context(tmp)
                custom = pathlib.Path(tmp) / "custom"
                custom.mkdir()
                store["models_dir"] = str(custom)

                info = model_dir.set_models_dir(ctx, reset_value)

                self.assertNotIn("models_dir", store)
                self.assertEqual(store["tag"], "b1")
                self.assertTrue(info["models_dir_is_default"])

    def test_rejects_invalid_custom_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, _store = make_context(tmp)
            file_path = pathlib.Path(tmp) / "model.gguf"
            file_path.write_bytes(b"x")
            missing = pathlib.Path(tmp) / "missing"
            invalid = (123, True, [], "relative/models", str(file_path), str(missing))

            for value in invalid:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    model_dir.set_models_dir(ctx, value)

    def test_configured_folder_that_disappears_never_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, store = make_context(tmp)
            custom = pathlib.Path(tmp) / "custom"
            custom.mkdir()
            store["models_dir"] = str(custom)
            custom.rmdir()

            info = model_dir.get_models_dir_info(ctx)

            self.assertFalse(info["models_dir_available"])
            self.assertFalse(info["models_dir_is_default"])
            self.assertEqual(info["models_arg_root"], "")
            with self.assertRaises(ValueError):
                model_dir.get_models_dir(ctx)
            self.assertFalse(ctx.paths.models.exists())

    def test_unreadable_custom_folder_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, store = make_context(tmp)
            custom = pathlib.Path(tmp) / "custom"
            custom.mkdir()
            store["models_dir"] = str(custom)

            with mock.patch.object(model_dir.os, "scandir", side_effect=PermissionError("denied")):
                info = model_dir.get_models_dir_info(ctx)

            self.assertFalse(info["models_dir_available"])
            self.assertIn("unavailable or unreadable", info["models_dir_error"])

    def test_change_is_rejected_while_download_is_active(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, store = make_context(tmp)
            custom = pathlib.Path(tmp) / "custom"
            custom.mkdir()
            ctx.state.model_download_in_progress = True

            with self.assertRaises(model_dir.ModelsDirBusyError):
                model_dir.set_models_dir(ctx, str(custom))

            self.assertNotIn("models_dir", store)


if __name__ == "__main__":
    unittest.main()
