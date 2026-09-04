"""Focused tests for the Monitor tab's /api/system-stats backend.

Covers the plan's Phase 1 acceptance list: delta math and its edge cases, the
Linux parser fixtures, collector failure degradation, the NVIDIA/AMD probe
parsers and failure modes, provider-qualified identity, evidence-gated setup
states, cache/coalescing behavior, and the thin route contract.
"""

import contextlib
import io
import json
import threading
import time
import unittest
from email.message import Message
from types import SimpleNamespace
from unittest import mock

from backend.context import AppContext
from backend.http import Request
from backend.routes import system_stats as system_stats_route
from backend.services import system_stats as svc


class DummyResponse:
    def __init__(self):
        self.payload = None
        self.status = None

    def json(self, data, status=200):
        self.payload = data
        self.status = status

    def error(self, message, status=500, code=None, extra=None):
        self.payload = {"error": message, "status": status}
        self.status = status


def make_context(backend="cuda-12.4", platform="linux"):
    ctx = AppContext()
    ctx.services.current_platform = platform
    ctx.services.load_config = lambda: {
        "backend": backend,
        "tag": "b6015",
        "version": None,
    }
    return ctx


def make_counters(
    monotonic=100.0,
    wall=1_788_278_400.0,
    cpu_total=1000.0,
    cpu_idle=800.0,
    disk_read=1_000_000,
    disk_write=500_000,
    disk_source="dev:8:0",
    memory=(4.0 * 1024 ** 3, 16.0 * 1024 ** 3),
    disk_usage=(500.0 * 1024 ** 3, 1000.0 * 1024 ** 3),
):
    return {
        "monotonic": monotonic,
        "wall": wall,
        "cpu": {"source": "cpu:/proc/stat", "total": cpu_total, "idle": cpu_idle},
        "memory": memory,
        "disk": {
            "source": disk_source,
            "bytes_read": disk_read,
            "bytes_written": disk_write,
        },
        "disk_usage": disk_usage,
    }


def no_gpus_patch():
    """Patch both vendor probes to report no hardware, without subprocesses."""
    return (
        mock.patch.object(svc, "probe_nvidia", return_value=("missing", [], None)),
        mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)),
    )


class DeltaMathTests(unittest.TestCase):
    def _sample(self, previous, counters):
        ctx = make_context(backend="vulkan")
        with mock.patch.object(svc, "collect_system_counters", return_value=counters), \
                mock.patch.object(svc, "probe_nvidia", return_value=("missing", [], None)), \
                mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)), \
                mock.patch.object(svc, "is_wsl_environment", return_value=False):
            data, new_previous = svc.collect_sample(ctx, previous)
        return data, new_previous

    def test_first_sample_has_null_rates(self):
        data, _ = self._sample(None, make_counters())
        self.assertIsNone(data["interval_seconds"])
        self.assertTrue(data["system"]["cpu"]["available"])
        self.assertIsNone(data["system"]["cpu"]["percent"])
        disk = data["system"]["disk"]
        self.assertTrue(disk["available"])
        self.assertIsNone(disk["read_bytes_per_second"])
        self.assertIsNone(disk["write_bytes_per_second"])
        # Capacity is not a rate: it is available on the very first sample.
        self.assertIsNotNone(disk["percent"])

    def test_valid_interval_produces_rates(self):
        previous = {
            "monotonic": 98.0,
            "cpu": {"source": "cpu:/proc/stat", "total": 800.0, "idle": 700.0},
            "disk": {"source": "dev:8:0", "bytes_read": 600_000, "bytes_written": 300_000},
        }
        data, _ = self._sample(previous, make_counters(monotonic=100.0))
        self.assertAlmostEqual(data["interval_seconds"], 2.0)
        # Busy delta 100 of total delta 200 -> 50%.
        self.assertAlmostEqual(data["system"]["cpu"]["percent"], 50.0)
        disk = data["system"]["disk"]
        self.assertAlmostEqual(disk["read_bytes_per_second"], 200_000.0)
        self.assertAlmostEqual(disk["write_bytes_per_second"], 100_000.0)

    def test_too_short_and_too_long_intervals_null_rates(self):
        previous = {
            "monotonic": 99.98,  # 0.02 s < 0.1 s floor
            "cpu": {"source": "cpu:/proc/stat", "total": 800.0, "idle": 700.0},
            "disk": {"source": "dev:8:0", "bytes_read": 600_000, "bytes_written": 300_000},
        }
        data, _ = self._sample(previous, make_counters(monotonic=100.0))
        self.assertIsNone(data["interval_seconds"])
        self.assertIsNone(data["system"]["cpu"]["percent"])
        self.assertIsNone(data["system"]["disk"]["read_bytes_per_second"])

        previous["monotonic"] = 60.0  # 40 s > 30 s ceiling (sleep/gap)
        data, _ = self._sample(previous, make_counters(monotonic=100.0))
        self.assertIsNone(data["interval_seconds"])
        self.assertIsNone(data["system"]["cpu"]["percent"])

    def test_counter_rollback_nulls_rate_and_replaces_baseline(self):
        previous = {
            "monotonic": 98.0,
            "cpu": {"source": "cpu:/proc/stat", "total": 5000.0, "idle": 4000.0},
            "disk": {"source": "dev:8:0", "bytes_read": 9_000_000, "bytes_written": 300_000},
        }
        data, new_previous = self._sample(previous, make_counters(monotonic=100.0))
        self.assertIsNone(data["system"]["cpu"]["percent"])
        self.assertIsNone(data["system"]["disk"]["read_bytes_per_second"])
        # Baseline is replaced by the current sample, not clamped to zero.
        self.assertEqual(new_previous["cpu"]["total"], 1000.0)
        self.assertEqual(new_previous["disk"]["bytes_read"], 1_000_000)

    def test_invalid_cpu_idle_delta_nulls_rate_and_replaces_baseline(self):
        cases = (
            (800.0, 600.0, 700.0),  # idle counter rolled back
            (700.0, 950.0, 1050.0),  # idle delta exceeds total delta
        )
        for previous_idle, invalid_idle, next_idle in cases:
            with self.subTest(previous_idle=previous_idle, invalid_idle=invalid_idle):
                previous = {
                    "monotonic": 98.0,
                    "cpu": {"source": "cpu:/proc/stat", "total": 800.0, "idle": previous_idle},
                    "disk": None,
                }
                data, new_previous = self._sample(
                    previous,
                    make_counters(monotonic=100.0, cpu_total=1000.0, cpu_idle=invalid_idle),
                )
                self.assertIsNone(data["system"]["cpu"]["percent"])
                self.assertEqual(new_previous["cpu"]["idle"], invalid_idle)

                next_data, _ = self._sample(
                    new_previous,
                    make_counters(monotonic=102.0, cpu_total=1200.0, cpu_idle=next_idle),
                )
                self.assertAlmostEqual(next_data["system"]["cpu"]["percent"], 50.0)

    def test_disk_source_identity_change_nulls_only_disk_rates(self):
        previous = {
            "monotonic": 98.0,
            "cpu": {"source": "cpu:/proc/stat", "total": 800.0, "idle": 700.0},
            "disk": {"source": "dev:8:16", "bytes_read": 600_000, "bytes_written": 300_000},
        }
        data, _ = self._sample(previous, make_counters(monotonic=100.0))
        self.assertIsNotNone(data["system"]["cpu"]["percent"])
        self.assertIsNone(data["system"]["disk"]["read_bytes_per_second"])

    def test_zero_total_delta_nulls_cpu_percent(self):
        previous = {
            "monotonic": 98.0,
            "cpu": {"source": "cpu:/proc/stat", "total": 1000.0, "idle": 800.0},
            "disk": None,
        }
        data, _ = self._sample(previous, make_counters(monotonic=100.0))
        self.assertIsNone(data["system"]["cpu"]["percent"])

    def test_compute_helpers_edge_cases(self):
        self.assertIsNone(svc.compute_cpu_percent(100, 50, 100, 50))
        self.assertIsNone(svc.compute_cpu_percent(100, 50, 90, 40))
        self.assertIsNone(svc.compute_cpu_percent(0, 500, 1000, 0))
        self.assertIsNone(svc.compute_cpu_percent(0, 0, 1000, 1001))
        self.assertIsNone(svc.compute_bytes_per_second(10, 5, 1.0))
        self.assertIsNone(svc.compute_bytes_per_second(5, 10, 0.05))
        self.assertIsNone(svc.usage_percent(10, 0))
        self.assertIsNone(svc.usage_percent(None, 10))
        self.assertAlmostEqual(svc.usage_percent(1, 4), 25.0)
        self.assertIsNone(svc.finite_non_negative(float("nan")))
        self.assertIsNone(svc.finite_non_negative(-1))
        self.assertIsNone(svc.finite_non_negative("abc"))


class LinuxParserTests(unittest.TestCase):
    PROC_STAT = (
        "cpu  1000 20 300 5000 100 5 10 0 0 0\n"
        "cpu0 500 10 150 2500 50 2 5 0 0 0\n"
        "intr 123\n"
    )

    def test_parse_proc_stat(self):
        total, idle = svc.parse_proc_stat(self.PROC_STAT)
        self.assertAlmostEqual(total, 6435.0)
        # idle + iowait
        self.assertAlmostEqual(idle, 5100.0)

    def test_parse_proc_stat_rejects_garbage(self):
        self.assertIsNone(svc.parse_proc_stat("cpu 1 2\n"))
        self.assertIsNone(svc.parse_proc_stat("cpu a b c d\n"))
        self.assertIsNone(svc.parse_proc_stat("no cpu line"))

    def test_parse_proc_meminfo_prefers_memavailable(self):
        text = (
            "MemTotal:       16384000 kB\n"
            "MemFree:         2000000 kB\n"
            "MemAvailable:   12000000 kB\n"
            "Buffers:          500000 kB\n"
            "Cached:          3000000 kB\n"
        )
        used, total = svc.parse_proc_meminfo(text)
        self.assertEqual(total, 16384000 * 1024)
        self.assertEqual(used, (16384000 - 12000000) * 1024)

    def test_parse_proc_meminfo_fallback_without_memavailable(self):
        text = (
            "MemTotal:       16384000 kB\n"
            "MemFree:         2000000 kB\n"
            "Buffers:          500000 kB\n"
            "Cached:          3000000 kB\n"
        )
        used, total = svc.parse_proc_meminfo(text)
        self.assertEqual(used, total - 5500000 * 1024)

    def test_parse_proc_meminfo_rejects_invalid(self):
        self.assertIsNone(svc.parse_proc_meminfo(""))
        self.assertIsNone(svc.parse_proc_meminfo("MemFree: 100 kB"))

    DISKSTATS = (
        "   8       0 sda 1000 0 2000 0 500 0 1000 0 0 0 0 0 0 0\n"
        "   8       1 sda1 900 0 1800 0 400 0 800 0 0 0 0 0 0 0\n"
        " 259       0 nvme0n1 10 0 100 0 20 0 40 0 0 0 0 0 0 0\n"
        "   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0 0 0 0\n"
        "garbage line\n"
    )

    def test_parse_proc_diskstats(self):
        entries = svc.parse_proc_diskstats(self.DISKSTATS)
        self.assertEqual(len(entries), 4)
        sda = entries[0]
        # sectors * 512
        self.assertEqual(sda["bytes_read"], 2000 * 512)
        self.assertEqual(sda["bytes_written"], 1000 * 512)

    def test_select_disk_counters_preference_order(self):
        entries = svc.parse_proc_diskstats(self.DISKSTATS)
        # Exact partition match wins.
        source, read, write = svc.select_disk_counters(entries, (8, 1))
        self.assertEqual(source, "dev:8:1")
        self.assertEqual(read, 1800 * 512)
        # Unknown minor falls back to the whole disk of the same major.
        source, _, _ = svc.select_disk_counters(entries, (8, 99))
        self.assertEqual(source, "disk:8:0")
        # Unknown major falls back to the sum of whole-disk devices (loop
        # devices are excluded).
        source, read, write = svc.select_disk_counters(entries, (254, 1))
        self.assertEqual(source, "disk:all")
        self.assertEqual(read, (2000 + 100) * 512)
        # No device hint uses the same whole-disk sum.
        source, _, _ = svc.select_disk_counters(entries, None)
        self.assertEqual(source, "disk:all")

    def test_select_disk_counters_empty(self):
        self.assertIsNone(svc.select_disk_counters([], (8, 0)))


class CollectorFailureTests(unittest.TestCase):
    def test_one_collector_failing_keeps_siblings(self):
        ctx = make_context(backend="vulkan")

        def collect(state_ctx, platform_name):
            return {
                "monotonic": time.monotonic(),
                "wall": time.time(),
                "cpu": None,
                "memory": (1.0, 2.0),
                "disk": None,
                "disk_usage": (1.0, 4.0),
            }

        with mock.patch.object(svc, "collect_system_counters", side_effect=collect), \
                mock.patch.object(svc, "probe_nvidia", return_value=("missing", [], None)), \
                mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)):
            data, _ = svc.collect_sample(ctx, None)
        self.assertFalse(data["system"]["cpu"]["available"])
        self.assertTrue(data["system"]["memory"]["available"])
        self.assertAlmostEqual(data["system"]["memory"]["percent"], 50.0)
        self.assertTrue(data["system"]["disk"]["available"])

    def test_collect_system_counters_isolates_each_collector(self):
        ctx = make_context(platform="linux")
        with mock.patch.object(svc, "collect_linux_cpu", side_effect=OSError("boom")), \
                mock.patch.object(
                    svc, "collect_linux_memory", return_value=(1024.0, 2048.0)
                ), \
                mock.patch.object(svc, "collect_linux_disk_counters", return_value=None), \
                mock.patch("shutil.disk_usage") as disk_usage:
            disk_usage.return_value = SimpleNamespace(used=10, total=100, free=90)
            counters = svc.collect_system_counters(ctx, "linux")
        self.assertIsNone(counters["cpu"])
        self.assertEqual(counters["memory"], (1024.0, 2048.0))
        self.assertEqual(counters["disk_usage"], (10.0, 100.0))

    def test_windows_collector_failure_marks_metric_unavailable(self):
        ctx = make_context(platform="win32")
        with mock.patch.object(svc, "collect_windows_cpu", side_effect=OSError("boom")), \
                mock.patch.object(svc, "collect_windows_memory", return_value=None), \
                mock.patch("shutil.disk_usage", side_effect=OSError("no disk")):
            counters = svc.collect_system_counters(ctx, "win32")
        self.assertIsNone(counters["cpu"])
        self.assertIsNone(counters["memory"])
        self.assertIsNone(counters["disk_usage"])

        with mock.patch.object(svc, "collect_system_counters", return_value=counters), \
                mock.patch.object(svc, "probe_nvidia", return_value=("missing", [], None)), \
                mock.patch.object(svc, "probe_amd", return_value=("unsupported_platform", [], None)), \
                mock.patch.object(svc, "is_wsl_environment", return_value=False):
            data, _ = svc.collect_sample(ctx, None)
        self.assertFalse(data["system"]["cpu"]["available"])
        self.assertFalse(data["system"]["memory"]["available"])
        self.assertFalse(data["system"]["disk"]["available"])


class NvidiaParserTests(unittest.TestCase):
    MULTI_DEVICE_CSV = (
        'GPU-7f3e2a91-4c1d, 00000000:01:00.0, 0, "GeForce RTX 4090", 72, 18841, 24564, 63\n'
        'GPU-12ab34cd-5e6f, 00000000:0B:00.0, 1, "GeForce RTX 3060, 12GB", 4, 800, 12288, N/A\n'
    )

    def test_multiple_devices_and_quoted_names(self):
        devices = svc.parse_nvidia_smi_csv(self.MULTI_DEVICE_CSV)
        self.assertEqual(len(devices), 2)
        first, second = devices
        self.assertEqual(first["provider"], "nvidia")
        self.assertEqual(first["id"], "nvidia:uuid:GPU-7F3E2A91-4C1D")
        self.assertTrue(first["id_persistent"])
        self.assertEqual(first["index"], 0)
        self.assertEqual(first["name"], "GeForce RTX 4090")
        self.assertAlmostEqual(first["utilization_percent"], 72.0)
        self.assertEqual(first["memory_used_bytes"], 18841 * 1024 * 1024)
        self.assertAlmostEqual(first["temperature_c"], 63.0)
        # Comma inside the quoted name survives CSV parsing.
        self.assertEqual(second["name"], "GeForce RTX 3060, 12GB")
        self.assertIsNone(second["temperature_c"])

    def test_na_fields_stay_null_and_malformed_row_is_skipped(self):
        text = (
            "GPU-aaaa, 00000000:01:00.0, 0, RTX A, N/A, N/A, N/A, N/A\n"
            "this row is malformed, only three, fields\n"
            "GPU-bbbb, 00000000:02:00.0, 1, RTX B, 10, 100, 200, 40\n"
        )
        devices = svc.parse_nvidia_smi_csv(text)
        self.assertEqual(len(devices), 2)
        self.assertIsNone(devices[0]["utilization_percent"])
        self.assertIsNone(devices[0]["memory_used_bytes"])
        self.assertEqual(devices[1]["name"], "RTX B")

    def test_identity_precedence_and_index_fallback(self):
        # No UUID -> PCI identity.
        row = ["N/A", "00000000:0B:00.0", "1", "Card", "1", "1", "2", "N/A"]
        device = svc.parse_nvidia_smi_row(row, fallback_index=1)
        self.assertEqual(device["id"], "nvidia:pci:00000000:0b:00.0")
        self.assertTrue(device["id_persistent"])
        # No identity at all -> non-persistent index fallback.
        row = ["N/A", "N/A", "2", "Card", "1", "1", "2", "N/A"]
        device = svc.parse_nvidia_smi_row(row, fallback_index=2)
        self.assertEqual(device["id"], "nvidia:index:2")
        self.assertFalse(device["id_persistent"])
        # Nothing usable is rejected outright.
        row = ["N/A", "N/A", "x", "N/A", "N/A", "N/A", "N/A", "N/A"]
        self.assertIsNone(svc.parse_nvidia_smi_row(row, fallback_index=0))
        # Wrong column count is rejected individually.
        self.assertIsNone(svc.parse_nvidia_smi_row(["a", "b"], fallback_index=0))

    def test_probe_timeout_is_an_error_not_a_crash(self):
        with mock.patch.object(svc, "resolve_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                mock.patch(
                    "subprocess.run", side_effect=__import__("subprocess").TimeoutExpired("nvidia-smi", 2)
                ):
            status, devices, details = svc.probe_nvidia("linux")
        self.assertEqual(status, "error")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "timeout")
        self.assertEqual(details["executable"], "/usr/bin/nvidia-smi")
        self.assertNotIn("exit_code", details)

    def test_probe_launch_failure_is_not_exit_code(self):
        with mock.patch.object(svc, "resolve_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                mock.patch("subprocess.run", side_effect=OSError("permission denied")):
            status, devices, details = svc.probe_nvidia("linux")
        self.assertEqual(status, "error")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "launch_failed")
        self.assertNotIn("exit_code", details)


    def test_probe_missing_executable(self):
        with mock.patch.object(svc, "resolve_nvidia_smi", return_value=None):
            status, devices, details = svc.probe_nvidia("linux")
        self.assertEqual(status, "missing")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "not_found")
        self.assertEqual(details, {"reason": "not_found"})

    def test_probe_nonzero_exit_is_error(self):
        completed = SimpleNamespace(returncode=9, stdout="", stderr="driver problem")
        with mock.patch.object(svc, "resolve_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                mock.patch("subprocess.run", return_value=completed):
            status, devices, details = svc.probe_nvidia("linux")
        self.assertEqual(status, "error")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "exit_code")
        self.assertEqual(details["exit_code"], 9)
        self.assertEqual(details["stderr"], "driver problem")

    def test_probe_ok_without_devices_reports_no_devices(self):
        completed = SimpleNamespace(returncode=0, stdout="", stderr="")
        with mock.patch.object(svc, "resolve_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                mock.patch("subprocess.run", return_value=completed):
            status, devices, details = svc.probe_nvidia("linux")
        self.assertEqual(status, "ok")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "no_devices")
        self.assertEqual(details["executable"], "/usr/bin/nvidia-smi")

    def test_probe_ok_with_devices_has_no_details(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout="GPU-AAAA, 00000000:01:00.0, 0, RTX, 1, 1, 2, 40\n",
            stderr="",
        )
        with mock.patch.object(svc, "resolve_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                mock.patch("subprocess.run", return_value=completed):
            status, devices, details = svc.probe_nvidia("linux")
        self.assertEqual(status, "ok")
        self.assertEqual(len(devices), 1)
        self.assertIsNone(details)

    def test_probe_details_truncate_stderr_to_first_line(self):
        # >200 chars on the first line -> cut; second line is dropped.
        completed = SimpleNamespace(
            returncode=3, stdout="", stderr="x" * 300 + "\nsecond line"
        )
        with mock.patch.object(svc, "resolve_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                mock.patch("subprocess.run", return_value=completed):
            _, _, details = svc.probe_nvidia("linux")
        self.assertEqual(details["stderr"], "x" * 200)
        self.assertEqual(details["exit_code"], 3)


class AmdParserTests(unittest.TestCase):
    # Older flat summary shape: strings with units, cardN keys.
    FLAT_RELEASE = json.dumps(
        {
            "card0": {
                "bdf": "0000:03:00.0",
                "uuid": "1b8d5f3e-9c2a",
                "name": "AMD Radeon RX 7900 XTX",
                "gfx_activity": "12",
                "edge_temperature": "41",
                "vram_mem_usage": {"used": "512 MB", "total": "24 GB"},
            },
            "card1": {
                "bdf": "0000:07:00.0",
                "name": "AMD Radeon RX 7900 XTX",
                "gfx_activity": "N/A",
            },
        }
    )

    # Newer nested shape with unit-bearing value objects.
    NESTED_RELEASE = json.dumps(
        {
            "gpu": [
                {
                    "asic": {"board_name": "AMD Instinct MI300X"},
                    "pcie": {"bdf": "0000:19:00.0"},
                    "metric": {
                        "gfx_activity": {"value": 88, "unit": "%"},
                        "edge_temperature": {"value": 52.5, "unit": "C"},
                    },
                    "vram_mem_usage": {
                        "used": {"value": 4096, "unit": "MB"},
                        "total": {"value": 191, "unit": "GB"},
                    },
                }
            ]
        }
    )

    def test_flat_release(self):
        devices = svc.parse_amd_smi_json(self.FLAT_RELEASE)
        self.assertEqual(len(devices), 2)
        first, second = devices
        self.assertEqual(first["provider"], "amd")
        self.assertEqual(first["id"], "amd:uuid:1B8D5F3E-9C2A")
        self.assertEqual(first["name"], "AMD Radeon RX 7900 XTX")
        self.assertAlmostEqual(first["utilization_percent"], 12.0)
        self.assertAlmostEqual(first["temperature_c"], 41.0)
        self.assertEqual(first["memory_used_bytes"], 512 * 1024 ** 2)
        self.assertEqual(first["memory_total_bytes"], 24 * 1024 ** 3)
        # No UUID -> BDF identity; absent metrics stay null independently.
        self.assertEqual(second["id"], "amd:bdf:0000:07:00.0")
        self.assertIsNone(second["utilization_percent"])
        self.assertIsNone(second["temperature_c"])
        self.assertIsNone(second["memory_used_bytes"])

    def test_nested_release_with_unit_bearing_values(self):
        devices = svc.parse_amd_smi_json(self.NESTED_RELEASE)
        self.assertEqual(len(devices), 1)
        device = devices[0]
        self.assertEqual(device["id"], "amd:bdf:0000:19:00.0")
        self.assertEqual(device["name"], "AMD Instinct MI300X")
        self.assertAlmostEqual(device["utilization_percent"], 88.0)
        self.assertAlmostEqual(device["temperature_c"], 52.5)
        self.assertEqual(device["memory_used_bytes"], 4096 * 1024 ** 2)
        self.assertEqual(device["memory_total_bytes"], 191 * 1024 ** 3)

    def test_empty_and_malformed(self):
        self.assertEqual(svc.parse_amd_smi_json("{}"), [])
        self.assertEqual(svc.parse_amd_smi_json("[]"), [])
        self.assertEqual(svc.parse_amd_smi_json('{"version": "6.2"}'), [])
        with self.assertRaises(ValueError):
            svc.parse_amd_smi_json("not json at all")

    def test_amd_number_and_bytes_normalization(self):
        self.assertAlmostEqual(svc.amd_number("42"), 42.0)
        self.assertAlmostEqual(svc.amd_number("42C"), 42.0)
        self.assertAlmostEqual(svc.amd_number({"value": 7, "unit": "%"}), 7.0)
        self.assertIsNone(svc.amd_number("N/A"))
        self.assertIsNone(svc.amd_number(-5))
        self.assertIsNone(svc.amd_number(True))
        self.assertEqual(svc.amd_bytes("4.0 GB"), 4 * 1024 ** 3)
        self.assertEqual(svc.amd_bytes("512MB"), 512 * 1024 ** 2)
        self.assertEqual(svc.amd_bytes(1024), 1024)
        self.assertIsNone(svc.amd_bytes("12 lightyears"))

    def test_probe_platform_gating(self):
        # Native Windows/macOS must never execute an incidental amd-smi.
        with mock.patch("subprocess.run") as run:
            status, devices, details = svc.probe_amd("win32")
            self.assertEqual(status, "unsupported_platform")
            self.assertIsNone(details)
            status, devices, details = svc.probe_amd("darwin")
            self.assertEqual(status, "unsupported_platform")
            self.assertIsNone(details)
            run.assert_not_called()

    def test_probe_timeout_and_missing(self):
        with mock.patch.object(svc, "resolve_amd_smi", return_value=None):
            status, devices, details = svc.probe_amd("linux")
        self.assertEqual(status, "missing")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "not_found")

        import subprocess as _subprocess
        with mock.patch.object(svc, "resolve_amd_smi", return_value="/opt/rocm/bin/amd-smi"), \
                mock.patch("subprocess.run", side_effect=_subprocess.TimeoutExpired("amd-smi", 5)):
            status, devices, details = svc.probe_amd("linux")
        self.assertEqual(status, "error")
        self.assertEqual(details["reason"], "timeout")
        self.assertEqual(details["executable"], "/opt/rocm/bin/amd-smi")

    def test_probe_launch_failure_is_not_exit_code(self):
        with mock.patch.object(svc, "resolve_amd_smi", return_value="/opt/rocm/bin/amd-smi"), \
                mock.patch("subprocess.run", side_effect=OSError("permission denied")):
            status, devices, details = svc.probe_amd("linux")
        self.assertEqual(status, "error")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "launch_failed")
        self.assertNotIn("exit_code", details)

    def test_probe_launch_failure_logs_real_error_to_stderr(self):
        # Clients get sanitized `details`; the real error must still reach the
        # server log, so a launch failure is diagnosable offline.
        buffer = io.StringIO()
        with mock.patch.object(svc, "resolve_amd_smi", return_value="/opt/rocm/bin/amd-smi"), \
                mock.patch("subprocess.run", side_effect=OSError("permission denied")):
            with contextlib.redirect_stderr(buffer):
                svc.probe_amd("linux")
        logged = buffer.getvalue()
        self.assertIn("amd-smi probe failed", logged)
        self.assertIn("permission denied", logged)

    def test_probe_malformed_json_is_error(self):
        completed = SimpleNamespace(returncode=0, stdout="not json", stderr="")
        with mock.patch.object(svc, "resolve_amd_smi", return_value="/opt/rocm/bin/amd-smi"), \
                mock.patch("subprocess.run", return_value=completed):
            status, devices, details = svc.probe_amd("linux")
        self.assertEqual(status, "error")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "parse_error")
        self.assertEqual(details["executable"], "/opt/rocm/bin/amd-smi")

    def test_probe_ok_without_devices_reports_no_devices(self):
        completed = SimpleNamespace(returncode=0, stdout="{}", stderr="")
        with mock.patch.object(svc, "resolve_amd_smi", return_value="/opt/rocm/bin/amd-smi"), \
                mock.patch("subprocess.run", return_value=completed):
            status, devices, details = svc.probe_amd("linux")
        self.assertEqual(status, "ok")
        self.assertEqual(devices, [])
        self.assertEqual(details["reason"], "no_devices")


class ResolverTests(unittest.TestCase):
    def test_amd_smi_core_versions_sort_numerically(self):
        files = {
            "/opt/rocm/core-10.0.1/bin/amd-smi": True,
            "/opt/rocm/core-6.3.2/bin/amd-smi": True,
            "/opt/rocm/core-9.1/bin/amd-smi": True,
        }
        with mock.patch.object(svc.shutil, "which", return_value=None), \
                mock.patch.object(svc.glob, "glob", return_value=list(files)), \
                mock.patch.object(svc.os.path, "isfile", side_effect=lambda p: files.get(p, False)):
            self.assertEqual(
                svc.resolve_amd_smi(), "/opt/rocm/core-10.0.1/bin/amd-smi"
            )

    def test_amd_smi_fixed_path_fallback(self):
        with mock.patch.object(svc.shutil, "which", return_value=None), \
                mock.patch.object(svc.glob, "glob", return_value=[]), \
                mock.patch.object(svc.os.path, "isfile", side_effect=lambda p: p == "/opt/rocm/bin/amd-smi"):
            self.assertEqual(svc.resolve_amd_smi(), "/opt/rocm/bin/amd-smi")

    def test_wsl_detection_reads_kernel_release(self):
        with mock.patch.object(svc.sys, "platform", "linux"), \
                mock.patch.object(
                    svc.os, "uname", create=True,
                    return_value=SimpleNamespace(release="5.15.153.1-microsoft-standard-WSL2"),
                ):
            self.assertTrue(svc.is_wsl_environment())
        with mock.patch.object(svc.sys, "platform", "linux"), \
                mock.patch.object(
                    svc.os, "uname", create=True,
                    return_value=SimpleNamespace(release="6.8.0-generic"),
                ):
            self.assertFalse(svc.is_wsl_environment())


class SetupStateTests(unittest.TestCase):
    def test_provider_hints_from_backend_only(self):
        self.assertEqual(svc.provider_hints("cuda-12.4"), (True, False))
        self.assertEqual(svc.provider_hints("cuda-13.3"), (True, False))
        self.assertEqual(svc.provider_hints("hip"), (False, True))
        self.assertEqual(svc.provider_hints("rocm-10.0"), (False, True))
        self.assertEqual(svc.provider_hints("lemonade-rocm-10.0"), (False, True))
        self.assertEqual(svc.provider_hints("lemonade-rocm-gfx1151"), (False, True))
        # No speculative hints from Vulkan/CPU/Metal/custom backends.
        for backend in ("vulkan", "cpu", "metal", "custom", "sycl", "openvino", None):
            self.assertEqual(svc.provider_hints(backend), (False, False), backend)

    def test_nvidia_missing_with_cuda_evidence_is_setup_required(self):
        entries = svc.build_gpu_setup_entries(
            "linux", False, "cuda-12.4", "missing", 0, "missing", 0
        )
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["provider"], "nvidia")
        self.assertEqual(entry["state"], "setup_required")
        self.assertEqual(entry["action"], "open_docs")
        self.assertIsNone(entry["command"])
        self.assertEqual(entry["docs_url"], svc.NVIDIA_DOCS_URL)

    def test_no_evidence_means_no_setup_rows(self):
        entries = svc.build_gpu_setup_entries(
            "linux", False, "vulkan", "missing", 0, "missing", 0
        )
        self.assertEqual(entries, [])

    def test_working_provider_suppresses_only_its_own_row(self):
        entries = svc.build_gpu_setup_entries(
            "linux", False, "cuda-12.4", "ok", 2, "missing", 0
        )
        self.assertEqual(entries, [])

    def test_mixed_provider_success_and_failure_coexist(self):
        # AMD backend, working nvidia-smi, failed amd-smi: only AMD error row.
        entries = svc.build_gpu_setup_entries(
            "linux", False, "hip", "ok", 1, "error", 0
        )
        self.assertEqual([entry["provider"] for entry in entries], ["amd"])
        self.assertEqual(entries[0]["state"], "error")

    def test_successful_probe_without_devices_is_provider_error(self):
        entries = svc.build_gpu_setup_entries(
            "linux", False, "cuda-12.4", "ok", 0, "missing", 0
        )
        self.assertEqual(entries[0]["state"], "error")
        self.assertEqual(entries[0]["provider"], "nvidia")
        self.assertNotIn("details", entries[0])

    def test_setup_entry_carries_probe_details(self):
        nvidia_details = {
            "reason": "exit_code",
            "executable": "/usr/bin/nvidia-smi",
            "exit_code": 1,
            "stderr": "unknown option",
        }
        # Provider hints gate which details attach: CUDA hints NVIDIA only.
        entries = svc.build_gpu_setup_entries(
            "linux", False, "cuda-12.4", "error", 0, "missing", 0,
            nvidia_details=nvidia_details, amd_details={"reason": "not_found"},
        )
        self.assertEqual([entry["provider"] for entry in entries], ["nvidia"])
        self.assertEqual(entries[0]["details"], nvidia_details)

        amd_details = {"reason": "not_found"}
        entries = svc.build_gpu_setup_entries(
            "linux", False, "hip", "missing", 0, "missing", 0,
            nvidia_details=nvidia_details, amd_details=amd_details,
        )
        self.assertEqual([entry["provider"] for entry in entries], ["amd"])
        self.assertEqual(entries[0]["details"], amd_details)

    def test_ok_without_devices_carries_no_devices_details(self):
        nvidia_details = {"reason": "no_devices", "executable": "/usr/bin/nvidia-smi"}
        entries = svc.build_gpu_setup_entries(
            "linux", False, "cuda-12.4", "ok", 0, "missing", 0,
            nvidia_details=nvidia_details,
        )
        self.assertEqual(entries[0]["state"], "error")
        self.assertEqual(entries[0]["details"], nvidia_details)

    def test_working_probe_emits_no_details_anywhere(self):
        entries = svc.build_gpu_setup_entries(
            "linux", False, "cuda-12.4", "ok", 2, "missing", 0,
            nvidia_details=None,
        )
        self.assertEqual(entries, [])

    def test_unsupported_platform_entry_has_no_details(self):
        # No probe ran, so there is nothing factual to attach.
        entries = svc.build_gpu_setup_entries(
            "win32", False, "hip", "missing", 0, "unsupported_platform", 0
        )
        self.assertEqual(entries[0]["state"], "unsupported")
        self.assertNotIn("details", entries[0])

    def test_amd_missing_linux_uses_allowlisted_command(self):
        os_release = 'ID=ubuntu\nID_LIKE=debian\n'
        entries = svc.build_gpu_setup_entries(
            "linux", False, "hip", "missing", 0, "missing", 0, os_release
        )
        entry = entries[0]
        self.assertEqual(entry["state"], "setup_required")
        self.assertEqual(entry["action"], "copy_command")
        self.assertEqual(entry["command"], svc.AMD_SETUP_COMMANDS["apt"])
        self.assertIn(entry["command"], svc.AMD_SETUP_COMMANDS.values())

        os_release = 'ID="fedora"\n'
        entries = svc.build_gpu_setup_entries(
            "linux", False, "rocm-10.0", "missing", 0, "missing", 0, os_release
        )
        self.assertEqual(entries[0]["command"], svc.AMD_SETUP_COMMANDS["dnf"])

        os_release = "ID=opensuse-leap\nID_LIKE=suse\n"
        entries = svc.build_gpu_setup_entries(
            "linux", False, "hip", "missing", 0, "missing", 0, os_release
        )
        self.assertEqual(entries[0]["command"], svc.AMD_SETUP_COMMANDS["zypper"])

        # Unknown distribution: docs plus explicit manual package guidance,
        # never an invented command.
        entries = svc.build_gpu_setup_entries(
            "linux", False, "hip", "missing", 0, "missing", 0, "ID=gentoo\n"
        )
        self.assertEqual(entries[0]["action"], "open_docs")
        self.assertIsNone(entries[0]["command"])
        self.assertIn("using your distribution's package manager", entries[0]["message"])
        self.assertIn("amdrocm-amdsmi", entries[0]["message"])

    def test_wsl_is_excluded_before_distribution_detection(self):
        os_release = "ID=ubuntu\nID_LIKE=debian\n"
        entries = svc.build_gpu_setup_entries(
            "linux", True, "hip", "missing", 0, "missing", 0, os_release
        )
        entry = entries[0]
        self.assertEqual(entry["state"], "unsupported")
        self.assertIsNone(entry["command"])
        self.assertNotIn("apt", entry["message"])

    def test_amd_unsupported_native_platforms(self):
        for platform in ("win32", "darwin"):
            entries = svc.build_gpu_setup_entries(
                platform, False, "hip", "missing", 0, "unsupported_platform", 0
            )
            entry = entries[0]
            self.assertEqual(entry["state"], "unsupported", platform)
            self.assertIn("Linux bare metal", entry["message"])
            self.assertIn("Windows and WSL users can still run models normally", entry["message"])
            self.assertIn("cannot currently collect AMD GPU metrics", entry["message"])


class CollectSampleTests(unittest.TestCase):
    def test_counters_are_read_before_vendor_probes(self):
        call_order = []
        counters = make_counters(monotonic=100.0)

        def fake_collect(ctx, platform_name):
            call_order.append("counters")
            return counters

        def slow_probe(*args, **kwargs):
            call_order.append("probe")
            time.sleep(0.02)
            return "missing", [], None

        ctx = make_context(backend="vulkan")
        previous = {
            "monotonic": 98.0,
            "cpu": {"source": "cpu:/proc/stat", "total": 800.0, "idle": 700.0},
            "disk": {"source": "dev:8:0", "read_bytes": 0, "write_bytes": 0},
        }
        with mock.patch.object(svc, "collect_system_counters", side_effect=fake_collect), \
                mock.patch.object(svc, "probe_nvidia", side_effect=slow_probe), \
                mock.patch.object(svc, "probe_amd", side_effect=slow_probe), \
                mock.patch.object(svc, "is_wsl_environment", return_value=False):
            data, _ = svc.collect_sample(ctx, previous)

        self.assertEqual(call_order[0], "counters")
        # The slow probes did not distort the interval or sampled_at.
        self.assertAlmostEqual(data["interval_seconds"], 2.0)
        self.assertEqual(data["sampled_at"], counters["wall"])

    def test_gpu_lists_and_setup_gate_from_backend(self):
        nvidia_gpu = {
            "provider": "nvidia",
            "id": "nvidia:uuid:GPU-AAAA",
            "id_persistent": True,
            "index": 0,
            "name": "RTX A",
            "utilization_percent": 1.0,
            "memory_used_bytes": 1,
            "memory_total_bytes": 2,
            "temperature_c": None,
        }
        ctx = make_context(backend="cuda-12.4")
        with mock.patch.object(svc, "collect_system_counters", return_value=make_counters()), \
                mock.patch.object(svc, "probe_nvidia", return_value=("missing", [], None)), \
                mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)), \
                mock.patch.object(svc, "is_wsl_environment", return_value=False), \
                mock.patch.object(svc, "read_os_release", return_value="ID=ubuntu\n"):
            data, _ = svc.collect_sample(ctx, None)
        self.assertEqual(data["gpus"], [])
        self.assertEqual([entry["provider"] for entry in data["gpu_setup"]], ["nvidia"])

        with mock.patch.object(svc, "collect_system_counters", return_value=make_counters()), \
                mock.patch.object(svc, "probe_nvidia", return_value=("ok", [nvidia_gpu], None)), \
                mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)), \
                mock.patch.object(svc, "is_wsl_environment", return_value=False):
            data, _ = svc.collect_sample(ctx, None)
        self.assertEqual(len(data["gpus"]), 1)
        self.assertEqual(data["gpu_setup"], [])

    def test_probe_details_flow_into_setup_entries(self):
        ctx = make_context(backend="cuda-12.4")
        details = {
            "reason": "exit_code",
            "executable": "/usr/bin/nvidia-smi",
            "exit_code": 7,
            "stderr": "driver mismatch",
        }
        with mock.patch.object(svc, "collect_system_counters", return_value=make_counters()), \
                mock.patch.object(svc, "probe_nvidia", return_value=("error", [], details)), \
                mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)), \
                mock.patch.object(svc, "is_wsl_environment", return_value=False), \
                mock.patch.object(svc, "read_os_release", return_value="ID=ubuntu\n"):
            data, _ = svc.collect_sample(ctx, None)
        entry = data["gpu_setup"][0]
        self.assertEqual(entry["provider"], "nvidia")
        self.assertEqual(entry["details"], details)

    def test_amd_probe_cache_keeps_details(self):
        # The details ride the cached tuple; a cached re-use must not drop them.
        ctx = make_context(backend="hip")
        cached_details = {"reason": "parse_error", "executable": "/opt/rocm/bin/amd-smi"}
        with mock.patch.object(svc, "collect_system_counters", return_value=make_counters()), \
                mock.patch.object(svc, "probe_nvidia", return_value=("missing", [], None)), \
                mock.patch.object(svc, "probe_amd", return_value=("error", [], cached_details)), \
                mock.patch.object(svc, "is_wsl_environment", return_value=False):
            svc.get_system_stats(ctx)
            ctx.state.system_stats_cache["expires_at"] = time.monotonic() - 1
            data, _ = svc.collect_sample(ctx, None)
        self.assertEqual(data["gpu_setup"][0]["details"], cached_details)


class CachingTests(unittest.TestCase):
    def test_fresh_cache_is_reused(self):
        ctx = make_context(backend="vulkan")
        calls = {"calls": 0}
        patches = [
            mock.patch.object(svc, "collect_system_counters", return_value=make_counters()),
            mock.patch.object(svc, "probe_nvidia", side_effect=lambda *a, **k: (calls.__setitem__("calls", calls["calls"] + 1), ("missing", [], None))[1]),
            mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)),
            mock.patch.object(svc, "is_wsl_environment", return_value=False),
        ]
        for patch in patches:
            patch.start()
        try:
            first = svc.get_system_stats(ctx)
            second = svc.get_system_stats(ctx)
        finally:
            for patch in patches:
                patch.stop()
        self.assertIs(first, second)
        self.assertEqual(calls["calls"], 1)

    def test_force_refresh_bypasses_fresh_cache(self):
        ctx = make_context(backend="vulkan")
        calls = {"calls": 0}
        patches = [
            mock.patch.object(svc, "collect_system_counters", return_value=make_counters()),
            mock.patch.object(svc, "probe_nvidia", side_effect=lambda *a, **k: (calls.__setitem__("calls", calls["calls"] + 1), ("missing", [], None))[1]),
            mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)),
            mock.patch.object(svc, "is_wsl_environment", return_value=False),
        ]
        for patch in patches:
            patch.start()
        try:
            svc.get_system_stats(ctx)
            svc.get_system_stats(ctx, force_refresh=True)
        finally:
            for patch in patches:
                patch.stop()
        self.assertEqual(calls["calls"], 2)

    def test_expired_cache_recollects(self):
        ctx = make_context(backend="vulkan")
        calls = {"calls": 0}
        patches = [
            mock.patch.object(svc, "collect_system_counters", return_value=make_counters()),
            mock.patch.object(svc, "probe_nvidia", side_effect=lambda *a, **k: (calls.__setitem__("calls", calls["calls"] + 1), ("missing", [], None))[1]),
            mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)),
            mock.patch.object(svc, "is_wsl_environment", return_value=False),
        ]
        for patch in patches:
            patch.start()
        try:
            svc.get_system_stats(ctx)
            ctx.state.system_stats_cache["expires_at"] = time.monotonic() - 1
            svc.get_system_stats(ctx)
        finally:
            for patch in patches:
                patch.stop()
        self.assertEqual(calls["calls"], 2)

    def test_concurrent_cold_polls_share_one_collection(self):
        ctx = make_context(backend="vulkan")
        release = threading.Event()
        started = threading.Event()
        calls = {"probe": 0}

        def blocking_probe(*args, **kwargs):
            calls["probe"] += 1
            started.set()
            release.wait(timeout=5)
            return "missing", [], None

        patches = [
            mock.patch.object(svc, "collect_system_counters", return_value=make_counters()),
            mock.patch.object(svc, "probe_nvidia", side_effect=blocking_probe),
            mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)),
            mock.patch.object(svc, "is_wsl_environment", return_value=False),
        ]
        for patch in patches:
            patch.start()
        results = [None] * 5
        try:
            def worker(index):
                results[index] = svc.get_system_stats(ctx)
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(5)]
            for thread in threads:
                thread.start()
            started.wait(timeout=5)
            time.sleep(0.05)
            release.set()
            for thread in threads:
                thread.join(timeout=10)
        finally:
            for patch in patches:
                patch.stop()
        self.assertEqual(calls["probe"], 1)
        self.assertTrue(all(result is not None for result in results))
        for result in results[1:]:
            self.assertEqual(result, results[0])

    def test_recheck_joins_in_progress_collection_instead_of_queueing(self):
        ctx = make_context(backend="vulkan")
        release = threading.Event()
        started = threading.Event()
        calls = {"probe": 0}

        def blocking_probe(*args, **kwargs):
            calls["probe"] += 1
            started.set()
            release.wait(timeout=5)
            return "missing", [], None

        patches = [
            mock.patch.object(svc, "collect_system_counters", return_value=make_counters()),
            mock.patch.object(svc, "probe_nvidia", side_effect=blocking_probe),
            mock.patch.object(svc, "probe_amd", return_value=("missing", [], None)),
            mock.patch.object(svc, "is_wsl_environment", return_value=False),
        ]
        for patch in patches:
            patch.start()
        holder = {"first": None, "second": None, "third": None}
        try:
            # Thread A: normal cold collection, blocked in the vendor probe.
            thread_a = threading.Thread(
                target=lambda: holder.__setitem__("first", svc.get_system_stats(ctx))
            )
            thread_a.start()
            started.wait(timeout=5)

            # Thread B: forced Recheck arrives mid-collection. It must join the
            # in-progress collection, not start another probe.
            thread_b = threading.Thread(
                target=lambda: holder.__setitem__(
                    "second", svc.get_system_stats(ctx, force_refresh=True)
                )
            )
            thread_b.start()
            time.sleep(0.05)
            release.set()
            thread_a.join(timeout=10)
            thread_b.join(timeout=10)

            # Repeated Recheck clicks while a forced collection runs also
            # coalesce: C and D run together, one more collection total.
            holder["third"] = svc.get_system_stats(ctx, force_refresh=True)
        finally:
            for patch in patches:
                patch.stop()

        self.assertEqual(calls["probe"], 2)
        self.assertEqual(holder["first"], holder["second"])

    def test_forced_refresh_bypasses_amd_probe_cache(self):
        ctx = make_context(backend="hip")
        calls = {"amd": 0}

        def counting_amd(*args, **kwargs):
            calls["amd"] += 1
            return "ok", [], None

        patches = [
            mock.patch.object(svc, "collect_system_counters", return_value=make_counters()),
            mock.patch.object(svc, "probe_nvidia", return_value=("missing", [], None)),
            mock.patch.object(svc, "probe_amd", side_effect=counting_amd),
            mock.patch.object(svc, "is_wsl_environment", return_value=False),
            mock.patch.object(svc, "read_os_release", return_value="ID=ubuntu\n"),
        ]
        for patch in patches:
            patch.start()
        try:
            svc.get_system_stats(ctx)
            # Within the AMD probe cache window: a normal poll reuses it.
            ctx.state.system_stats_cache["expires_at"] = time.monotonic() - 1
            svc.get_system_stats(ctx)
            # A forced Recheck probes fresh.
            svc.get_system_stats(ctx, force_refresh=True)
        finally:
            for patch in patches:
                patch.stop()
        self.assertEqual(calls["amd"], 2)


class RouteTests(unittest.TestCase):
    def _request(self, query=""):
        return Request(
            method="GET",
            path="/api/system-stats",
            query=query,
            headers=Message(),
        )

    def test_success_payload(self):
        ctx = make_context()
        response = DummyResponse()
        payload = {"sampled_at": 1.0, "system": {}, "gpus": [], "gpu_setup": []}
        with mock.patch.object(
            svc, "get_system_stats", return_value=payload
        ) as get_stats:
            system_stats_route.get_system_stats(self._request(), response, ctx)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload, payload)
        self.assertFalse(get_stats.call_args.kwargs.get("force_refresh", False))

    def test_refresh_1_forces_collection(self):
        ctx = make_context()
        response = DummyResponse()
        with mock.patch.object(svc, "get_system_stats", return_value={}) as get_stats:
            system_stats_route.get_system_stats(self._request("refresh=1"), response, ctx)
        self.assertTrue(get_stats.call_args.kwargs.get("force_refresh"))

    def test_only_fixed_refresh_form_is_accepted(self):
        ctx = make_context()
        for query in ("refresh=2", "refresh=true", "refresh=", "provider=nvidia", "cmd=ls"):
            response = DummyResponse()
            with mock.patch.object(svc, "get_system_stats") as get_stats:
                system_stats_route.get_system_stats(self._request(query), response, ctx)
            self.assertEqual(response.status, 400, query)
            get_stats.assert_not_called()

    def test_total_failure_is_sanitized(self):
        ctx = make_context()
        response = DummyResponse()
        with mock.patch.object(
            svc, "get_system_stats", side_effect=ValueError("/secret/path exploded")
        ):
            system_stats_route.get_system_stats(self._request(), response, ctx)
        self.assertEqual(response.status, 500)
        self.assertNotIn("/secret/path", response.payload["error"])


class RegistryTests(unittest.TestCase):
    def test_route_is_registered(self):
        import backend.app as backend_app
        match = backend_app.API_ROUTER.match("GET", "/api/system-stats")
        self.assertIsNotNone(match)
        self.assertEqual(match.handler_name, "get_system_stats")


if __name__ == "__main__":
    unittest.main()
