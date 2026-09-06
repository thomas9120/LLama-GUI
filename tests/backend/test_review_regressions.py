"""Regression cases from the September 2026 application review."""

import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend import app
from backend.http import Request
from backend.routes import benchmarks, presets
from backend.services import external_server, hf_download, llama_manager, process_manager
from tests.backend.test_extracted_routes import DummyResponse
from tests.backend.test_services import make_service_context


class ReviewRegressions(unittest.TestCase):
    def test_credentials_are_removed_from_presets_metadata_and_commands(self):
        data = {"hf_token": "hf_secret", "flags": {"hf_token": "hf_secret", "api_key": "api_secret", "temperature": 0.7}}
        clean, changed = presets.sanitize_preset_data(data)
        self.assertTrue(changed)
        self.assertEqual(clean, {"flags": {"temperature": 0.7}})
        self.assertIn("hf_token", data["flags"], "sanitization must not mutate its caller")
        snapshot = process_manager.normalize_launch_settings({
            "model": "model.gguf", "flags": data["flags"], "has_custom_args": False,
        })
        self.assertEqual(snapshot["flags"], {"temperature": 0.7})
        args = ["-hft", "hf_secret", "--hf-token=other_secret", "--api-key", "api_secret"]
        self.assertEqual(process_manager.redact_sensitive_args(args),
                         ["-hft", "<redacted>", "--hf-token=<redacted>", "--api-key", "<redacted>"])
        self.assertEqual(process_manager.redact_sensitive_text("hf_secret other_secret api_secret", args),
                         "<redacted> <redacted> <redacted>")

    def test_quoted_credentials_are_rejected_and_legacy_presets_scrubbed(self):
        for raw in ('"--api-key" secret', "'--api-key'=secret", '--api-"key" secret',
                    '"-hft" secret', "'--hf-token=secret'", '--hf-"token"=secret',
                    '--metrics\u00a0"--api-key"\ufeffsecret'):
            with self.subTest(raw=raw):
                data = {"flags": {"custom_args": raw}}
                self.assertTrue(presets.has_sensitive_custom_args(data))
                self.assertEqual(presets.sanitize_preset_data(data), ({"flags": {}}, True))
                with self.assertRaises(ValueError):
                    process_manager.compute_preset_fingerprint(data)
        for key in ("api_key", "hf_token"):
            with self.assertRaises(ValueError):
                process_manager.compute_preset_fingerprint({"flags": {key: "secret"}})
        self.assertFalse(presets.has_sensitive_custom_args({"flags": {"custom_args": '--alias "my model"'}}))
        self.assertFalse(presets.has_sensitive_custom_args({"flags": {"custom_args": "--path C:\\models\\"}}))
        self.assertTrue(presets.has_sensitive_custom_args({"flags": {"custom_args": "--api-key secret --path C:\\models\\"}}))
        # Ordinary model names and Windows paths need not be shell expressions.
        process_manager.compute_preset_fingerprint({"model": "Bob's model.gguf", "flags": {"path": "C:\\models\\"}})

    def test_v1_target_falls_back_after_local_exit_and_external_reconnect_advances_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.load_config = dict
            ctx.services.save_config = mock.Mock()
            ctx.services.set_llama_api_target = lambda host, port: ctx.state.llama_api_target.update(host=host, port=port)
            first = external_server.connect(ctx, "127.0.0.1", 9001, probe_target=False)
            second = external_server.connect(ctx, "127.0.0.1", 9001, probe_target=False)
            self.assertGreater(second["generation"], first["generation"])
            child = mock.Mock()
            child.poll.return_value = None
            ctx.state.process = child
            ctx.state.active_process_tool = "llama-server"
            ctx.state.active_runtime = {"tool": "llama-server", "host": "127.0.0.1", "port": 9002, "generation": 1}
            ctx.state.llama_api_target.update(host="127.0.0.1", port=9002)
            with mock.patch.object(app, "APP_CONTEXT", ctx):
                self.assertEqual(app.get_llama_api_target()["port"], 9002)
                child.poll.return_value = 0
                self.assertEqual(app.get_llama_api_target()["port"], 9001)

    def test_install_rolls_back_each_late_failure(self):
        for failure in ("grammar", "executable", "config"):
            for existing in (True, False):
                with self.subTest(failure=failure, existing=existing), tempfile.TemporaryDirectory() as tmp:
                    ctx = make_service_context(tmp)
                    ctx.services.load_config = lambda: {"tag": "old"}
                    ctx.services.save_config = mock.Mock(side_effect=OSError("config locked") if failure == "config" else None)
                    targets = (ctx.paths.llama_bin, ctx.paths.llama_grammars)
                    if existing:
                        for target in targets:
                            target.mkdir(parents=True)
                            (target / "old").write_text("previous installation")
                    release = {"tag_name": "new", "assets": [{"name": "llama-new.zip", "browser_download_url": "https://example.test/release"}]}

                    def extract(_archive, bins, grammars):
                        (bins / "new").write_text("new binary")
                        (grammars / "new").write_text("new grammar")

                    real_swap = llama_manager._swap_directory_into_place

                    def swap(staged, target):
                        if failure == "grammar" and target == ctx.paths.llama_grammars:
                            raise PermissionError("grammar directory locked")
                        return real_swap(staged, target)

                    with (mock.patch.object(llama_manager, "get_release_by_tag", return_value=release),
                          mock.patch.object(llama_manager, "download_file"),
                          mock.patch.object(llama_manager, "extract_archive_flat", side_effect=extract),
                          mock.patch.object(llama_manager, "_swap_directory_into_place", side_effect=swap),
                          mock.patch.object(llama_manager, "ensure_installed_tool_executables", side_effect=PermissionError("chmod failed") if failure == "executable" else None)):
                        self.assertFalse(llama_manager.install_release(ctx, "new", "cpu", {"cpu": {"asset": "llama-{tag}.zip"}}))
                    for target in targets:
                        self.assertEqual(target.exists(), existing)
                        if existing:
                            self.assertEqual([p.name for p in target.iterdir()], ["old"])
                            self.assertEqual((target / "old").read_text(), "previous installation")
                        self.assertFalse(target.with_name(target.name + ".old").exists())
                        self.assertFalse(target.with_name(target.name + ".new").exists())
                    if failure != "config":
                        ctx.services.save_config.assert_not_called()

    def test_interrupted_wikitext_download_removes_temporary_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            ctx.services.urlopen_with_ssl = lambda *args, **kwargs: io.BytesIO(b"partial zip")
            response = DummyResponse()
            make_temp = tempfile.NamedTemporaryFile
            with (mock.patch.object(benchmarks.tempfile, "NamedTemporaryFile", side_effect=lambda **kw: make_temp(dir=tmp, **kw)),
                  mock.patch.object(benchmarks.shutil, "copyfileobj", side_effect=OSError("connection interrupted"))):
                benchmarks.ensure_wikitext2(Request("POST", "/api/benchmark/wikitext2", "", {}), response, ctx)
            self.assertEqual(response.status, 500)
            self.assertEqual(list(Path(tmp).glob("*.zip")), [])

    def test_hf_listing_groups_complete_shard_sets_and_sums_sizes(self):
        names = ["q4/model-00001-of-00002.gguf", "q4/model-00002-of-00002.gguf", "incomplete-00001-of-00002.gguf", "single.gguf"]
        api = SimpleNamespace(model_info=lambda **kwargs: SimpleNamespace(siblings=[SimpleNamespace(rfilename=name, size=3) for name in names]))
        with mock.patch.dict("sys.modules", {"huggingface_hub": SimpleNamespace(HfApi=lambda **kwargs: api)}):
            result = hf_download.get_hf_gguf_files("owner/model")
        self.assertEqual([item["name"] for item in result["models"]], [names[0], "single.gguf"])
        self.assertEqual(result["models"][0]["size"], 6)
        self.assertEqual(result["models"][0]["shard_count"], 2)

    def test_hf_split_download_success_failure_and_cancellation(self):
        for outcome in ("done", "error", "cancelled"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as tmp:
                ctx = make_service_context(tmp)
                files = ["q4/model-00001-of-00002.gguf", "q4/model-00002-of-00002.gguf"]
                calls = []

                def download(_ctx, _repo, filename, _revision, _token, dest, completed, total, *_args):
                    calls.append(filename)
                    self.assertEqual(total, 6)
                    self.assertEqual(completed, (len(calls) - 1) * 3)
                    dest.with_suffix(".gguf.part").write_bytes(b"new")
                    if outcome == "error" and filename == files[1]:
                        raise OSError("interrupted shard")
                    dest.with_suffix(".gguf.part").replace(dest)
                    if outcome == "cancelled":
                        ctx.state.model_download_cancel.set()
                    return 3

                with (mock.patch.object(hf_download.threading, "Thread", side_effect=lambda **kw: SimpleNamespace(start=kw["target"])),
                      mock.patch.object(hf_download, "get_hf_download_metadata", return_value=SimpleNamespace(size=3)),
                      mock.patch.object(hf_download, "download_hf_file", side_effect=download)):
                    result = hf_download.start_hf_model_download(ctx, "owner/model", "main", files[1], "", None)
                self.assertEqual(result["status"], outcome)
                self.assertFalse(ctx.state.model_download_in_progress)
                self.assertEqual(list(ctx.paths.models.rglob("*.part")), [])
                self.assertEqual(calls, files[:1] if outcome == "cancelled" else files)
                if outcome == "done":
                    self.assertEqual(result["model_name"], "owner_model/model-00001-of-00002.gguf")
                    self.assertEqual(result["downloaded"], 6)
                    self.assertEqual(len(list(ctx.paths.models.rglob("*.gguf"))), 2)

    def test_existing_later_shard_blocks_download_without_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = make_service_context(tmp)
            dest = ctx.paths.models / "owner_model" / "model-00002-of-00002.gguf"
            dest.parent.mkdir(parents=True)
            dest.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):
                hf_download.start_hf_model_download(ctx, "owner/model", "main", "model-00001-of-00002.gguf", "", None)
            self.assertFalse(ctx.state.model_download_in_progress)
            self.assertEqual(dest.read_bytes(), b"existing")


if __name__ == "__main__":
    unittest.main()
