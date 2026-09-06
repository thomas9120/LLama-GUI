"""Exercise native CPU/memory collectors with OS API fixtures on every runner."""

import unittest
from types import SimpleNamespace
from unittest import mock

from backend.services import system_stats as svc


class WindowsCollectorTests(unittest.TestCase):
    def cpu(self, idle, kernel, user, success=True):
        def get_times(idle_ptr, kernel_ptr, user_ptr):
            for pointer, ticks in ((idle_ptr, idle), (kernel_ptr, kernel), (user_ptr, user)):
                pointer._obj.low = ticks & 0xFFFFFFFF
                pointer._obj.high = ticks >> 32
            return success

        kernel32 = SimpleNamespace(GetSystemTimes=get_times)
        with mock.patch.object(svc.ctypes, "WinDLL", return_value=kernel32, create=True):
            return svc.collect_windows_cpu()

    def test_cpu_64_bit_counters_include_idle_only_once(self):
        self.assertEqual(self.cpu(2 ** 32 + 7, 2 ** 33 + 11, 123), {
            "source": "cpu:GetSystemTimes", "total": float(2 ** 33 + 134),
            "idle": float(2 ** 32 + 7),
        })

    def test_cpu_failed_and_invalid_samples_are_unavailable(self):
        for values in ((10, 20, 30, False), (0, 0, 0), (100, 20, 30)):
            with self.subTest(values=values):
                self.assertIsNone(self.cpu(*values))

    def test_memory_uses_physical_bytes_and_initializes_structure(self):
        def get_memory(pointer):
            self.assertEqual(pointer._obj.dwLength, 64, "Windows MEMORYSTATUSEX ABI size")
            pointer._obj.ullTotalPhys = 32 * 1024 ** 3
            pointer._obj.ullAvailPhys = 7 * 1024 ** 3
            pointer._obj.ullTotalVirtual = 128 * 1024 ** 3
            pointer._obj.dwMemoryLoad = 99  # Rounded percentage is not the byte count.
            return True

        kernel32 = SimpleNamespace(GlobalMemoryStatusEx=get_memory)
        with mock.patch.object(svc.ctypes, "WinDLL", return_value=kernel32, create=True):
            self.assertEqual(svc.collect_windows_memory(), (25 * 1024 ** 3, 32 * 1024 ** 3))

    def test_memory_failed_and_invalid_samples_are_unavailable(self):
        for total, available, success in ((100, 20, False), (0, 0, True), (100, 101, True)):
            with self.subTest(total=total, available=available, success=success):
                def get_memory(pointer):
                    pointer._obj.ullTotalPhys = total
                    pointer._obj.ullAvailPhys = available
                    return success

                kernel32 = SimpleNamespace(GlobalMemoryStatusEx=get_memory)
                with mock.patch.object(svc.ctypes, "WinDLL", return_value=kernel32, create=True):
                    self.assertIsNone(svc.collect_windows_memory())


class MacOSCollectorTests(unittest.TestCase):
    def cpu(self, result=0, returned_count=4):
        def host_statistics(host, flavor, info, count):
            self.assertEqual((host, flavor, count._obj.value), (99, 3, 4))
            # Mach CPU states: user, system, idle, nice.
            info[:] = [100, 50, 800, 25]
            count._obj.value = returned_count
            return result

        libc = SimpleNamespace(mach_host_self=lambda: 99, host_statistics=host_statistics)
        with mock.patch.object(svc, "_macos_libc", return_value=libc):
            return svc.collect_macos_cpu()

    def test_cpu_sums_all_states_and_uses_idle_bucket(self):
        self.assertEqual(self.cpu(), {
            "source": "cpu:host_statistics", "total": 975.0, "idle": 800.0,
        })

    def test_cpu_failed_or_truncated_statistics_are_unavailable(self):
        self.assertIsNone(self.cpu(result=5))
        self.assertIsNone(self.cpu(returned_count=3))

    def memory(self, page_size=4096, total=16 * 1024 ** 3, fail_at=None):
        def sysctl(name, value, length, new_value, new_length):
            self.assertEqual((name, length._obj.value, new_value, new_length), (b"hw.memsize", 8, None, 0))
            value._obj.value = total
            return -1 if fail_at == "sysctl" else 0

        def host_page_size(host, value):
            self.assertEqual(host, 99)
            value._obj.value = page_size
            return 5 if fail_at == "page_size" else 0

        def host_statistics64(host, flavor, info, count):
            self.assertEqual((host, flavor), (99, 4))
            self.assertGreater(count._obj.value, 0)
            info._obj.active_count = 1000
            info._obj.wire_count = 200
            info._obj.compressor_page_count = 50
            info._obj.free_count = 900
            info._obj.inactive_count = 500
            info._obj.total_uncompressed_pages_in_compressor = 10000
            return 5 if fail_at == "statistics" else 0

        libc = SimpleNamespace(
            mach_host_self=lambda: 99, sysctlbyname=sysctl,
            host_page_size=host_page_size, host_statistics64=host_statistics64,
        )
        with mock.patch.object(svc, "_macos_libc", return_value=libc):
            return svc.collect_macos_memory()

    def test_memory_counts_active_wired_and_compressed_pages_at_native_page_size(self):
        for page_size in (4096, 16384):
            with self.subTest(page_size=page_size):
                self.assertEqual(self.memory(page_size=page_size), (1250 * page_size, 16 * 1024 ** 3))
        self.assertEqual(self.memory(total=1024), (1024.0, 1024.0), "used memory is capped at total")

    def test_memory_api_failures_and_zero_sizes_are_unavailable(self):
        for fail_at in ("sysctl", "page_size", "statistics"):
            with self.subTest(fail_at=fail_at):
                self.assertIsNone(self.memory(fail_at=fail_at))
        self.assertIsNone(self.memory(total=0))
        self.assertIsNone(self.memory(page_size=0))
