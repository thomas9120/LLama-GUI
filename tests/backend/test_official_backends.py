"""Official asset discovery, offline snapshots and install selection regressions."""

import hashlib
import io
import json
import tempfile
import threading
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from unittest import mock

from backend.context import AppContext, AppPaths
from backend.http import GENERIC_SERVER_ERROR, Request
from backend.routes import install
from backend.services import llama_manager, official_backends as catalog


def release(tag="b12345", platform="win", arch="x64", version="14.0", family="cuda", runtime=True, tagged=False):
    extension = "zip" if platform == "win" else "tar.gz"
    names = [f"llama-{tag}-bin-{platform}-{family}-{version}-{arch}.{extension}"]
    if family == "cuda" and runtime:
        prefix = f"cudart-llama-{tag}" if tagged else "cudart-llama"
        names.append(f"{prefix}-bin-{platform}-cuda-{version}-{arch}.{extension}")
    return {"tag_name": tag, "published_at": "2026-09-22T12:00:00Z",
            "assets": [{"name": name, "browser_download_url": f"https://example.test/{name}"} for name in names]}


class Response:
    def json(self, value, status=200):
        self.value, self.status = value, status

    def error(self, message, status=500):
        self.value, self.status = {"error": message}, status


class OfficialBackendsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.ctx = AppContext(paths=AppPaths(root=root, llama=root / "llama",
            llama_bin=root / "llama/bin", llama_grammars=root / "llama/grammars"))
        self.ctx.services.current_platform = "win32"
        self.ctx.services.current_arch = "x64"
        self.ctx.services.backend_specs = llama_manager.build_backend_specs("win32", "x64")
        self.ctx.services.load_config = lambda: {}
        self.ctx.services.save_config = mock.Mock()

    def refresh(self, releases, **kwargs):
        with mock.patch.object(llama_manager, "get_releases", return_value=releases) as fetch:
            result = catalog.refresh(self.ctx, **kwargs)
        return result, fetch

    def test_discovers_future_versions_and_filters_platform_arch_and_complete_pairs(self):
        releases = [release(), release(version="11.2", family="rocm"),
                    release(version="15.0", runtime=False), release(version="16.0", arch="arm64"),
                    release(version="17.0", platform="ubuntu", tagged=True)]
        result, fetch = self.refresh(releases)
        self.assertFalse(result["warning"])
        fetch.assert_called_once_with(self.ctx, self.ctx.config.github_api, page=1, per_page=100)
        specs = catalog.get_backend_specs(self.ctx)
        self.assertIn("cuda-14.0", specs)
        self.assertIn("rocm-11.2", specs)
        self.assertNotIn("cuda-15.0", specs)
        self.assertNotIn("cuda-16.0", specs)
        self.assertNotIn("cuda-17.0", specs)
        self.assertEqual(specs["lemonade-rocm-10.0"], self.ctx.services.backend_specs["lemonade-rocm-10.0"])
        self.assertIn("separate runtime required", specs["rocm-11.2"]["label"])
        self.assertNotIn("cuda-14.0", self.ctx.services.backend_specs)

    def test_linux_and_windows_arm64_and_runtime_tag_conventions(self):
        for platform, system, arch in [("linux", "ubuntu", "x64"), ("linux", "ubuntu", "arm64"), ("win32", "win", "arm64")]:
            with self.subTest(platform=platform, arch=arch):
                older = release(platform=system, arch=arch, tagged=True)
                spec = catalog.release_specs(older, platform, arch)["cuda-14.0"]
                self.assertEqual(spec["asset"], f"llama-{{tag}}-bin-{system}-cuda-14.0-{arch}." + ("zip" if system == "win" else "tar.gz"))
                self.assertIn("{tag}", spec["extra_assets"][0])
                self.assertNotIn(older["tag_name"], spec["extra_assets"][0])
                self.assertEqual(llama_manager.missing_release_assets(older, spec), [])
                newer = release(tag="b12346", platform=system, arch=arch, tagged=False)
                self.assertEqual(llama_manager.missing_release_assets(newer, spec), [])
                incomplete = release(platform=system, arch=arch, runtime=False)
                self.assertTrue(llama_manager.missing_release_assets(incomplete, spec))
                self.assertEqual(catalog.release_specs(older, "darwin", arch), {})

    def test_unrecognized_filenames_cannot_create_backends(self):
        payload = release()
        payload["assets"] = [{"name": name} for name in [
            "../llama-b12345-bin-win-rocm-11.2-x64.zip", "llama-bOTHER-bin-win-rocm-11.2-x64.zip",
            "llama-b12345-bin-win-rocm-latest-x64.zip", "llama-b12345-bin-win-rocm-11.2-x64.tar.gz",
            "llama-b12345-windows-rocm-gfx110X-x64.zip", "llama-b12345-bin-win-rocm-11.2-x64.zip.exe",
        ]]
        self.assertEqual(catalog.release_specs(payload, "win32", "x64"), {})
        self.assertEqual(catalog.release_specs({"tag_name": "../bad", "assets": []}, "win32", "x64"), {})

    def test_catalog_survives_restart_offline_and_retains_older_versions(self):
        self.refresh([release()])
        with mock.patch.object(catalog.time, "monotonic", return_value=10**12):
            self.refresh([release(version="15.0")], force=True)
        self.ctx.state.official_backend_catalog = {}
        with mock.patch.object(llama_manager, "get_releases", side_effect=OSError("offline")) as fetch:
            specs = catalog.get_backend_specs(self.ctx)
            fetch.assert_not_called()
            result = catalog.refresh(self.ctx)
        self.assertIn("cuda-14.0", specs)
        self.assertIn("cuda-15.0", specs)
        self.assertIn("Keeping saved", result["warning"])
        self.assertIn("cuda-14.0", catalog.get_backend_specs(self.ctx))
        specs["cuda-14.0"]["extra_assets"].clear()
        self.assertTrue(catalog.get_backend_specs(self.ctx)["cuda-14.0"]["extra_assets"])

    def test_corrupt_or_foreign_platform_cache_uses_builtins(self):
        path = self.ctx.paths.llama / "official-backends.json"
        path.parent.mkdir()
        for contents in ["broken json", json.dumps({"platform": "linux", "arch": "arm64", "releases": [release()]})]:
            with self.subTest(contents=contents):
                path.write_text(contents)
                self.ctx.state.official_backend_catalog = {}
                self.assertEqual(catalog.get_backend_specs(self.ctx), self.ctx.services.backend_specs)

    def test_configured_api_is_used_for_discovery_recovery_and_cached_specs(self):
        mirror = "https://mirror.example.test/llama.cpp/releases"
        self.ctx.config = replace(self.ctx.config, github_api=mirror)
        self.ctx.services.load_config = lambda: {"backend": "cuda-14.0", "tag": "b99"}
        with mock.patch.object(llama_manager, "get_release_by_tag", return_value=release("b99")) as by_tag:
            _, fetch = self.refresh([release(version="15.0")])
        fetch.assert_called_once_with(self.ctx, mirror, page=1, per_page=100)
        by_tag.assert_called_once_with(self.ctx, "b99", mirror)
        self.ctx.state.official_backend_catalog = {}
        specs = catalog.get_backend_specs(self.ctx)
        for key in ("cuda-14.0", "cuda-15.0"):
            self.assertEqual(llama_manager.resolve_repo_api(specs[key], self.ctx), mirror)
        self.assertEqual(specs["lemonade-rocm-10.0"], self.ctx.services.backend_specs["lemonade-rocm-10.0"])
        response = Response()
        with mock.patch.object(llama_manager, "get_releases", return_value=[release()]) as fetch:
            install.get_releases(Request("GET", "/api/releases", "backend=cuda-14.0", {}), response, self.ctx)
        fetch.assert_called_once_with(self.ctx, mirror, page=1, per_page=100)
        self.assertEqual(response.status, 200)

    def test_discovery_route_sanitizes_unexpected_errors(self):
        response = Response()
        with mock.patch.object(catalog, "refresh", side_effect=RuntimeError("private host path")) as refresh, \
                mock.patch("sys.stderr", new_callable=io.StringIO) as log:
            install.get_backends(Request("GET", "/api/backends", "refresh=1", {}), response, self.ctx)
        refresh.assert_called_once_with(self.ctx, force=True)
        self.assertEqual(response.status, 500)
        self.assertEqual(response.value, {"error": GENERIC_SERVER_ERROR})
        self.assertIn("private host path", log.getvalue())

    def test_refresh_ttl_manual_refresh_and_failure_backoff(self):
        with mock.patch.object(catalog.time, "monotonic", return_value=100):
            self.refresh([release()])
        with mock.patch.object(catalog.time, "monotonic", return_value=140):
            _, fetch = self.refresh([release(version="15.0")])
            fetch.assert_not_called()
            self.refresh([release(version="15.0")], force=True)
        with mock.patch.object(catalog.time, "monotonic", return_value=141):
            _, fetch = self.refresh([], force=True)
            fetch.assert_not_called()
        with mock.patch.object(catalog.time, "monotonic", return_value=180), \
                mock.patch.object(llama_manager, "get_releases", side_effect=OSError("offline")):
            self.assertTrue(catalog.refresh(self.ctx, force=True)["warning"])
        with mock.patch.object(catalog.time, "monotonic", return_value=181):
            _, fetch = self.refresh([])
            fetch.assert_not_called()

    def test_scan_is_bounded_and_recovers_installed_release_by_tag(self):
        self.ctx.services.load_config = lambda: {"backend": "cuda-14.0", "tag": "b99"}
        with mock.patch.object(llama_manager, "get_releases", return_value=[release(f"b{i}", family="rocm") for i in range(100)]) as fetch, \
                mock.patch.object(llama_manager, "get_release_by_tag", return_value=release("b99")) as by_tag:
            catalog.refresh(self.ctx)
            by_tag.assert_not_called()
            self.assertEqual(fetch.call_count, catalog.PAGE_LIMIT)
        self.ctx.state.official_backend_catalog = {}
        with mock.patch.object(llama_manager, "get_releases", return_value=[]), \
                mock.patch.object(llama_manager, "get_release_by_tag", return_value=release("b99")) as by_tag:
            catalog.refresh(self.ctx)
            by_tag.assert_called_once_with(self.ctx, "b99", self.ctx.config.github_api)
        self.assertIn("cuda-14.0", catalog.get_backend_specs(self.ctx))

    def test_legacy_rocm_alias_is_preserved_and_lemonade_is_not_queried(self):
        self.ctx.services.load_config = lambda: {"backend": "lemonade-rocm-10.0", "tag": "b1"}
        with mock.patch.object(llama_manager, "get_release_by_tag") as by_tag:
            self.refresh([release(family="rocm", version="7.14")])
            by_tag.assert_not_called()
        specs = catalog.get_backend_specs(self.ctx)
        self.assertIn("hip", specs)
        self.assertNotIn("rocm-7.14", specs)
        self.assertEqual(specs["hip"]["official_package"]["id"], "rocm-7.14")

    def test_status_snapshot_remains_available_while_refresh_is_in_progress(self):
        entered, proceed = threading.Event(), threading.Event()
        def fetch(*args, **kwargs):
            entered.set()
            self.assertTrue(proceed.wait(5))
            return [release()]
        with mock.patch.object(llama_manager, "get_releases", side_effect=fetch) as lookup:
            threads = [threading.Thread(target=catalog.refresh, args=(self.ctx,), kwargs={"force": True}) for _ in range(2)]
            try:
                threads[0].start()
                self.assertTrue(entered.wait(5))
                threads[1].start()
                self.assertIn("cpu", catalog.get_backend_specs(self.ctx))
            finally:
                proceed.set()
                for thread in threads:
                    thread.join(5)
            self.assertEqual(lookup.call_count, 1)

    def test_discovered_backend_works_in_release_and_install_routes(self):
        payload = release()
        self.refresh([payload])
        response = Response()
        with mock.patch.object(llama_manager, "get_releases", return_value=[payload]):
            install.get_releases(Request("GET", "/api/releases", "backend=cuda-14.0", {}), response, self.ctx)
        self.assertEqual(response.value[0]["tag"], "b12345")
        class ImmediateThread:
            def __init__(self, target, args, daemon):
                self.target, self.args = target, args
            def start(self):
                self.target(*self.args)
        with mock.patch.object(install.threading, "Thread", ImmediateThread), \
                mock.patch.object(llama_manager, "install_release", return_value=True) as run_install:
            install.start_install(Request("POST", "/api/install", "", {}, body={"tag": "b12345", "backend": "cuda-14.0"}), response, self.ctx)
        self.assertEqual(response.status, 200)
        self.assertIn("cuda-14.0", run_install.call_args.args[3])
        self.assertFalse(self.ctx.state.install_in_progress)

    def test_install_resolves_exact_runtime_from_selected_release_and_checks_digests(self):
        self.ctx.config = replace(self.ctx.config, github_api="https://mirror.example.test/releases")
        self.refresh([release(tagged=False)])
        payload = release(tag="b12346", tagged=True)
        archives = {}
        for asset in payload["assets"]:
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("cudart64_14.dll" if asset["name"].startswith("cudart") else "llama-server.exe", "fixture")
            archives[asset["name"]] = buffer.getvalue()
            asset["digest"] = "sha256:" + hashlib.sha256(buffer.getvalue()).hexdigest()
        with mock.patch.object(llama_manager, "get_release_by_tag", return_value=payload) as by_tag, \
                mock.patch.object(llama_manager, "download_file", side_effect=lambda ctx, url, dest, cb: dest.write_bytes(archives[dest.name])):
            self.assertTrue(llama_manager.install_release(self.ctx, "b12346", "cuda-14.0", catalog.get_backend_specs(self.ctx)))
        by_tag.assert_called_once_with(self.ctx, "b12346", self.ctx.config.github_api)
        self.assertTrue((self.ctx.paths.llama_bin / "cudart64_14.dll").is_file())
        self.assertEqual(self.ctx.services.save_config.call_args.args[0]["backend"], "cuda-14.0")

    def test_discovered_backend_update_stays_on_installed_toolkit(self):
        self.refresh([release(), release(tag="b12346", version="15.0")])
        self.ctx.services.load_config = lambda: {"backend": "cuda-14.0", "tag": "b12344"}
        response = Response()
        with mock.patch.object(llama_manager, "get_releases", return_value=[
            release(tag="b12346", version="15.0"), release()
        ]), mock.patch.object(install.threading, "Thread") as worker:
            install.start_update(Request("POST", "/api/update", "", {}, body={}), response, self.ctx)
        self.assertEqual(response.value, {"status": "started", "from": "b12344", "to": "b12345"})
        self.assertEqual(worker.call_args.kwargs["args"], ("b12345", "cuda-14.0"))

    def test_remembered_official_release_is_recovered_while_custom_is_active(self):
        self.ctx.services.load_config = lambda: {
            "backend": "custom", "tag": "b99",
            "official_install": {"backend": "cuda-14.0", "tag": "b99"},
        }
        with mock.patch.object(llama_manager, "get_releases", return_value=[]), \
                mock.patch.object(llama_manager, "get_release_by_tag", return_value=release("b99")) as lookup:
            catalog.refresh(self.ctx)
        lookup.assert_called_once_with(self.ctx, "b99", self.ctx.config.github_api)
        self.assertIn("cuda-14.0", catalog.get_backend_specs(self.ctx))


if __name__ == "__main__":
    unittest.main()
