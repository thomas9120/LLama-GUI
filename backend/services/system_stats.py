"""Read-only system and GPU telemetry for the Monitor tab.

Design rules (see ``docs/monitor-tab-docs/monitor-plan.md``):

* Read-only. Never installs anything, never elevates, never runs a package
  manager. Vendor probes are bounded ``subprocess.run`` calls against tools
  already on the machine (``nvidia-smi``, ``amd-smi``).
* Missing vendor tools and unsupported fields are normal capability states:
  ``gpu_setup`` entries and per-field ``null`` values, never page-level errors.
  Optional numerics are ``null`` when unavailable; zero is never invented.
* CPU and disk throughput are deltas between cumulative counter samples. The
  monotonic and wall-clock timestamps are captured immediately beside the
  counter reads, and the (slow) vendor probes run afterwards, so probes can
  neither distort the sample interval nor change ``sampled_at``.
* ``state.system_stats_lock`` guards the previous sample, the response cache,
  the cache generation, and the AMD probe cache. The state lock is never held
  while a vendor subprocess runs. ``state.system_stats_collection_lock``
  serialises cold/forced collections; waiters compare the cache generation
  around the lock so concurrent polls share one collection and repeated
  Recheck clicks coalesce instead of queueing serial forced probes.
"""

import csv
import ctypes
import glob
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

from .subprocess_utils import get_no_window_creationflags


# --------------------------------------------------------------------------
# Tuning constants
# --------------------------------------------------------------------------

# Short-lived response cache, about the Monitor UI poll interval, so a cold
# probe (including the slow ``amd-smi`` launch) is paid at most once per cycle.
CACHE_TTL_SECONDS = 2.0

# Rate windows. The upper bound intentionally discards the first average after
# suspension or a long polling gap; the next normal sample restores the rate.
MIN_RATE_INTERVAL_SECONDS = 0.1
MAX_RATE_INTERVAL_SECONDS = 30.0

NVIDIA_PROBE_TIMEOUT_SECONDS = 2.0
AMD_PROBE_TIMEOUT_SECONDS = 5.0
# ``amd-smi`` starts a Python interpreter and is much slower than nvidia-smi;
# reuse its parsed result briefly instead of relaunching it on every sample.
AMD_PROBE_CACHE_TTL_SECONDS = 5.0

NVIDIA_QUERY_FIELDS = (
    "uuid,pci.bus_id,index,name,"
    "utilization.gpu,memory.used,memory.total,temperature.gpu"
)

NVIDIA_DOCS_URL = "https://docs.nvidia.com/deploy/nvidia-smi/index.html"
AMD_INSTALL_DOCS_URL = (
    "https://rocm.docs.amd.com/projects/amdsmi/en/latest/install/install.html"
)

# Fixed allowlist: setup commands are only ever displayed/copied, never
# executed, and never built from user input or string concatenation.
AMD_SETUP_COMMANDS = {
    "apt": "sudo apt install amdrocm-amdsmi",
    "dnf": "sudo dnf install amdrocm-amdsmi",
    "zypper": "sudo zypper install amdrocm-amdsmi",
}

_UNSET = ("", "N/A", "[N/A]", "n/a")


# --------------------------------------------------------------------------
# Validation helpers (shared by every collector and parser)
# --------------------------------------------------------------------------

def finite_non_negative(value):
    """Return ``float(value)`` when finite and non-negative, else ``None``."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return number


def finite_non_negative_int(value):
    number = finite_non_negative(value)
    if number is None:
        return None
    return int(number)


def clamp_percent(value):
    """Constrain a percentage to its documented 0-100 range."""
    number = finite_non_negative(value)
    if number is None:
        return None
    return max(0.0, min(100.0, number))


def usage_percent(used, total):
    """Used/total percentage; requires a positive total before dividing."""
    used = finite_non_negative(used)
    total = finite_non_negative(total)
    if used is None or total is None or total <= 0:
        return None
    return clamp_percent(used / total * 100.0)


def valid_rate_interval(seconds):
    if seconds is None or not math.isfinite(seconds):
        return False
    return MIN_RATE_INTERVAL_SECONDS <= seconds <= MAX_RATE_INTERVAL_SECONDS


def compute_cpu_percent(prev_total, prev_idle, curr_total, curr_idle):
    """CPU busy percentage from cumulative counter deltas.

    Returns ``None`` on counter rollback or a non-positive total delta; the
    caller replaces the baseline in that case by storing the current sample.
    """
    values = [finite_non_negative(v) for v in (prev_total, prev_idle, curr_total, curr_idle)]
    if any(value is None for value in values):
        return None
    prev_total, prev_idle, curr_total, curr_idle = values
    delta_total = curr_total - prev_total
    if delta_total <= 0:
        return None
    delta_idle = curr_idle - prev_idle
    if delta_idle < 0 or delta_idle > delta_total:
        return None
    busy = max(delta_total - delta_idle, 0.0)
    return clamp_percent(busy / delta_total * 100.0)


def compute_bytes_per_second(previous, current, interval_seconds):
    """Byte rate from cumulative counters; ``None`` on rollback."""
    previous = finite_non_negative(previous)
    current = finite_non_negative(current)
    if previous is None or current is None or not valid_rate_interval(interval_seconds):
        return None
    delta = current - previous
    if delta < 0:
        return None
    return delta / interval_seconds


def _normalize_uuid(raw):
    """Bounded canonical GPU UUID, or ``None``."""
    value = str(raw or "").strip()
    if value.upper() in _UNSET or len(value) > 80:
        return None
    if not re.fullmatch(r"[A-Za-z0-9-]+", value):
        return None
    return value.upper()


def _normalize_bdf(raw):
    """Bounded canonical PCI bus/BDF identity, or ``None``."""
    value = str(raw or "").strip()
    if value.upper() in _UNSET or len(value) > 32:
        return None
    value = value.lower()
    if not re.fullmatch(r"[0-9a-f:.-]+", value):
        return None
    return value


def _optional_number(raw):
    """Vendor-tool numeric field; N/A and invalid values become ``None``."""
    value = str(raw or "").strip()
    if value.upper() in _UNSET:
        return None
    return finite_non_negative(value)


def _optional_name(raw):
    value = str(raw or "").strip()
    if value.upper() in _UNSET:
        return None
    return value[:120]


# --------------------------------------------------------------------------
# Linux parsers (pure functions; exercised directly by the test suite)
# --------------------------------------------------------------------------

def parse_proc_stat(text):
    """Aggregate CPU counters from ``/proc/stat`` as ``(total, idle)``."""
    for line in str(text or "").splitlines():
        if not line.startswith("cpu "):
            continue
        parts = line.split()[1:]
        if len(parts) < 4:
            return None
        try:
            values = [float(part) for part in parts[:8]]
        except ValueError:
            return None
        if any(value < 0 for value in values):
            return None
        idle = values[3] + (values[4] if len(values) > 4 else 0.0)
        return (sum(values), idle)
    return None


def parse_proc_meminfo(text):
    """System RAM as ``(used_bytes, total_bytes)`` from ``/proc/meminfo``."""
    fields = {}
    for line in str(text or "").splitlines():
        key, sep, rest = line.partition(":")
        if not sep:
            continue
        parts = rest.split()
        if not parts:
            continue
        try:
            kib = float(parts[0])
        except ValueError:
            continue
        if kib < 0:
            continue
        fields[key.strip()] = kib * 1024.0
    total = fields.get("MemTotal")
    available = fields.get("MemAvailable")
    if available is None and "MemFree" in fields:
        available = fields["MemFree"] + fields.get("Buffers", 0.0) + fields.get("Cached", 0.0)
    if total is None or total <= 0 or available is None or available > total:
        return None
    return (max(total - available, 0.0), total)


_WHOLE_DISK_RE = re.compile(
    r"^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|dasd[a-z]+)$"
)


def parse_proc_diskstats(text):
    """Per-device cumulative I/O counters from ``/proc/diskstats``."""
    entries = []
    for line in str(text or "").splitlines():
        parts = line.split()
        # Modern kernels have 18+ fields; require the classic 14 minimum that
        # includes the sectors-read/sectors-written columns this code uses.
        if len(parts) < 14:
            continue
        try:
            major = int(parts[0])
            minor = int(parts[1])
            sectors_read = int(parts[5])
            sectors_written = int(parts[9])
        except ValueError:
            continue
        if min(major, minor, sectors_read, sectors_written) < 0:
            continue
        entries.append(
            {
                "major": major,
                "minor": minor,
                "name": parts[2],
                "bytes_read": sectors_read * 512,
                "bytes_written": sectors_written * 512,
            }
        )
    return entries


def select_disk_counters(entries, device):
    """Pick the I/O counters for the device holding the application root.

    Returns ``(source_identity, bytes_read, bytes_written)`` or ``None``.
    Preference: exact major:minor (a partition counts its own I/O), then the
    whole disk of that major, then the sum of all whole-disk devices. The
    source identity keys the delta baseline so a device change discards rates.
    """
    if device is not None:
        major, minor = device
        for entry in entries:
            if entry["major"] == major and entry["minor"] == minor:
                return (
                    f"dev:{major}:{minor}",
                    entry["bytes_read"],
                    entry["bytes_written"],
                )
        for entry in entries:
            if entry["major"] == major and entry["minor"] == 0:
                return (
                    f"disk:{major}:0",
                    entry["bytes_read"],
                    entry["bytes_written"],
                )
    whole = [entry for entry in entries if _WHOLE_DISK_RE.match(entry["name"])]
    if not whole:
        return None
    return (
        "disk:all",
        sum(entry["bytes_read"] for entry in whole),
        sum(entry["bytes_written"] for entry in whole),
    )


def resolve_root_device(root_path):
    """``(major, minor)`` of the filesystem holding *root_path*, or ``None``."""
    try:
        stat_result = os.stat(root_path)
    except OSError:
        return None
    try:
        return (os.major(stat_result.st_dev), os.minor(stat_result.st_dev))
    except (AttributeError, TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# Windows collectors (ctypes, no extra packages)
# --------------------------------------------------------------------------

class _FILETIME(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]


def _filetime_ticks(ft):
    return (ft.high << 32) | ft.low


def collect_windows_cpu():
    """Cumulative CPU counters via ``GetSystemTimes``.

    Kernel time already includes idle time, so total = kernel + user.
    """
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    idle = _FILETIME()
    kernel = _FILETIME()
    user = _FILETIME()
    if not kernel32.GetSystemTimes(
        ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)
    ):
        return None
    total = _filetime_ticks(kernel) + _filetime_ticks(user)
    idle_ticks = _filetime_ticks(idle)
    if total <= 0 or idle_ticks > total:
        return None
    return {"source": "cpu:GetSystemTimes", "total": float(total), "idle": float(idle_ticks)}


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_uint32),
        ("dwMemoryLoad", ctypes.c_uint32),
        ("ullTotalPhys", ctypes.c_uint64),
        ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64),
        ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64),
        ("ullAvailVirtual", ctypes.c_uint64),
        ("ullAvailExtendedVirtual", ctypes.c_uint64),
    ]


def collect_windows_memory():
    """``(used_bytes, total_bytes)`` via ``GlobalMemoryStatusEx``."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    status = _MEMORYSTATUSEX()
    status.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
    if not kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    total = int(status.ullTotalPhys)
    available = int(status.ullAvailPhys)
    if total <= 0 or available < 0 or available > total:
        return None
    return (float(total - available), float(total))


# --------------------------------------------------------------------------
# macOS collectors (Mach host statistics through ctypes)
# --------------------------------------------------------------------------

_HOST_CPU_LOAD_INFO = 3
_HOST_CPU_LOAD_INFO_COUNT = 4
_HOST_VM_INFO64 = 4
_CPU_STATE_USER = 0
_CPU_STATE_SYSTEM = 1
_CPU_STATE_IDLE = 2
_KERN_SUCCESS = 0


class _vm_statistics64(ctypes.Structure):
    _fields_ = [
        ("free_count", ctypes.c_uint32),
        ("active_count", ctypes.c_uint32),
        ("inactive_count", ctypes.c_uint32),
        ("wire_count", ctypes.c_uint32),
        ("zero_fill_count", ctypes.c_uint64),
        ("reactivations", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64),
        ("pageouts", ctypes.c_uint64),
        ("faults", ctypes.c_uint64),
        ("cow_faults", ctypes.c_uint64),
        ("lookups", ctypes.c_uint64),
        ("hits", ctypes.c_uint64),
        ("purges", ctypes.c_uint64),
        ("purgeable_count", ctypes.c_uint32),
        ("speculative_count", ctypes.c_uint32),
        ("decompressed_count", ctypes.c_uint64),
        ("compressions", ctypes.c_uint64),
        ("swapins", ctypes.c_uint64),
        ("swapouts", ctypes.c_uint64),
        ("compressor_page_count", ctypes.c_uint32),
        ("throttled_count", ctypes.c_uint32),
        ("external_page_count", ctypes.c_uint32),
        ("internal_page_count", ctypes.c_uint32),
        ("total_uncompressed_pages_in_compressor", ctypes.c_uint64),
    ]


def _macos_libc():
    return ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)


def collect_macos_cpu():
    libc = _macos_libc()
    host = libc.mach_host_self()
    info = (ctypes.c_uint32 * _HOST_CPU_LOAD_INFO_COUNT)()
    count = ctypes.c_uint32(_HOST_CPU_LOAD_INFO_COUNT)
    result = libc.host_statistics(host, _HOST_CPU_LOAD_INFO, info, ctypes.byref(count))
    if result != _KERN_SUCCESS or count.value < _HOST_CPU_LOAD_INFO_COUNT:
        return None
    ticks = [float(info[i]) for i in range(_HOST_CPU_LOAD_INFO_COUNT)]
    if any(tick < 0 for tick in ticks):
        return None
    return {
        "source": "cpu:host_statistics",
        "total": sum(ticks),
        "idle": ticks[_CPU_STATE_IDLE],
    }


def collect_macos_memory():
    """``(used_bytes, total_bytes)`` from hw.memsize + ``host_statistics64``.

    "Used" is active + wired + compressor pages — the same buckets Activity
    Monitor counts as app memory pressure.
    """
    libc = _macos_libc()
    total_size = ctypes.c_uint64(0)
    size_len = ctypes.c_size_t(ctypes.sizeof(total_size))
    if libc.sysctlbyname(b"hw.memsize", ctypes.byref(total_size), ctypes.byref(size_len), None, 0) != 0:
        return None
    total = int(total_size.value)
    if total <= 0:
        return None

    host = libc.mach_host_self()
    page_size = ctypes.c_uint64(0)
    if libc.host_page_size(host, ctypes.byref(page_size)) != _KERN_SUCCESS:
        return None
    page_bytes = int(page_size.value)
    if page_bytes <= 0:
        return None

    info = _vm_statistics64()
    count = ctypes.c_uint32(ctypes.sizeof(info) // ctypes.sizeof(ctypes.c_uint32))
    result = libc.host_statistics64(host, _HOST_VM_INFO64, ctypes.byref(info), ctypes.byref(count))
    if result != _KERN_SUCCESS:
        return None
    used_pages = int(info.active_count) + int(info.wire_count) + int(info.compressor_page_count)
    if used_pages < 0:
        return None
    used = min(used_pages * page_bytes, total)
    return (float(used), float(total))


# --------------------------------------------------------------------------
# Platform-neutral counter collection
# --------------------------------------------------------------------------

def _log_probe_failure(tool, exc):
    print(f"[system-stats] {tool} probe failed: {type(exc).__name__}: {exc}", file=sys.stderr)


def _probe_details(reason, executable=None, exit_code=None, stderr_text=None):
    """Serializable probe diagnostics for the Monitor UI.

    Only facts the probe actually observed are emitted, under a fixed key set:
    ``reason`` is one of ``not_found`` / ``timeout`` / ``exit_code`` /
    ``parse_error`` / ``no_devices`` / ``launch_failed``; ``exit_code`` and
    ``stderr`` are omitted
    when unknown; stderr is cut to its first line and 200 chars so a noisy
    vendor tool cannot bloat the payload.
    """
    details = {"reason": reason}
    if executable is not None:
        details["executable"] = executable
    if exit_code is not None:
        details["exit_code"] = int(exit_code)
    if stderr_text:
        first_line = str(stderr_text).splitlines()
        if first_line:
            details["stderr"] = first_line[0][:200]
    return details


def _read_text_file(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read()


def collect_linux_cpu():
    parsed = parse_proc_stat(_read_text_file("/proc/stat"))
    if parsed is None:
        return None
    return {"source": "cpu:/proc/stat", "total": parsed[0], "idle": parsed[1]}


def collect_linux_memory():
    parsed = parse_proc_meminfo(_read_text_file("/proc/meminfo"))
    if parsed is None:
        return None
    return parsed


def collect_linux_disk_counters(root_path):
    """``(source_identity, read_bytes, write_bytes)`` for this machine."""
    entries = parse_proc_diskstats(_read_text_file("/proc/diskstats"))
    if not entries:
        return None
    return select_disk_counters(entries, resolve_root_device(root_path))


def collect_system_counters(ctx, platform_name):
    """One snapshot of cumulative system counters plus its timestamps.

    The monotonic and wall-clock timestamps are captured *before* the reads so
    they sit immediately beside them; vendor probes run later and must not
    influence either value. Every collector failure degrades to ``None`` for
    that metric only.
    """
    counters = {
        "monotonic": time.monotonic(),
        "wall": time.time(),
        "cpu": None,
        "memory": None,
        "disk": None,
        "disk_usage": None,
    }

    if platform_name.startswith("linux"):
        collectors = {
            "cpu": collect_linux_cpu,
            "memory": collect_linux_memory,
            "disk": lambda: collect_linux_disk_counters(ctx.paths.root),
        }
    elif platform_name == "win32":
        collectors = {
            "cpu": collect_windows_cpu,
            "memory": collect_windows_memory,
        }
    elif platform_name == "darwin":
        collectors = {
            "cpu": collect_macos_cpu,
            "memory": collect_macos_memory,
        }
    else:
        collectors = {}

    # Each metric degrades independently: one collector failure must not fail
    # the whole endpoint or its sibling metrics.
    for key, collector in collectors.items():
        try:
            counters[key] = collector()
        except Exception as exc:
            print(
                f"[system-stats] {key} collector failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

    try:
        usage = shutil.disk_usage(str(ctx.paths.root))
        counters["disk_usage"] = (float(usage.used), float(usage.total))
    except OSError as exc:
        print(
            f"[system-stats] disk usage collection failed: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
    return counters


# --------------------------------------------------------------------------
# NVIDIA probe
# --------------------------------------------------------------------------

def resolve_nvidia_smi(platform_name):
    """Locate ``nvidia-smi`` on PATH plus known driver locations.

    It ships with the NVIDIA driver environment; never download it separately.
    """
    found = shutil.which("nvidia-smi")
    if found:
        return found
    candidates = []
    if platform_name == "win32":
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        candidates = [
            os.path.join(system_root, "System32", "nvidia-smi.exe"),
            r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
        ]
    else:
        candidates = ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def parse_nvidia_smi_row(row, fallback_index):
    """One ``nvidia-smi`` CSV row into a GPU dict; ``None`` when malformed.

    Individual rows are rejected on their own; a bad row never discards the
    good devices around it. ``N/A`` fields stay ``null`` per field.
    """
    if len(row) != 8:
        return None
    uuid_raw, pci_raw, index_raw, name_raw, util_raw, mem_used_raw, mem_total_raw, temp_raw = (
        field.strip() for field in row
    )

    try:
        index = int(index_raw)
    except ValueError:
        index = fallback_index
    if index < 0:
        index = fallback_index

    name = _optional_name(name_raw)
    uuid = _normalize_uuid(uuid_raw)
    bdf = _normalize_bdf(pci_raw)
    utilization = clamp_percent(_optional_number(util_raw))
    memory_used_mib = _optional_number(mem_used_raw)
    memory_total_mib = _optional_number(mem_total_raw)
    temperature = _optional_number(temp_raw)

    # A row with neither an identity nor a readable name carries nothing the
    # card could render; treat it as malformed.
    if uuid is None and bdf is None and name is None:
        return None

    if uuid is not None:
        gpu_id = f"nvidia:uuid:{uuid}"
        persistent = True
    elif bdf is not None:
        gpu_id = f"nvidia:pci:{bdf}"
        persistent = True
    else:
        gpu_id = f"nvidia:index:{index}"
        persistent = False

    return {
        "provider": "nvidia",
        "id": gpu_id,
        "id_persistent": persistent,
        "index": index,
        "name": name,
        "utilization_percent": utilization,
        "memory_used_bytes": (
            int(memory_used_mib * 1024 * 1024) if memory_used_mib is not None else None
        ),
        "memory_total_bytes": (
            int(memory_total_mib * 1024 * 1024) if memory_total_mib is not None else None
        ),
        "temperature_c": temperature,
    }


def parse_nvidia_smi_csv(text):
    """All GPUs from one bounded selective ``nvidia-smi`` CSV query."""
    devices = []
    # nvidia-smi separates fields with ", "; skipinitialspace lets quoted
    # names (which may contain commas) parse as single fields.
    for row in csv.reader(io.StringIO(str(text or "")), skipinitialspace=True):
        if not row or all(not field.strip() for field in row):
            continue
        device = parse_nvidia_smi_row(row, fallback_index=len(devices))
        if device is not None:
            devices.append(device)
    return devices


def probe_nvidia(platform_name):
    """Return ``(status, devices, details)`` with status ``ok`` / ``missing`` / ``error``.

    ``details`` is ``None`` when the probe produced usable devices; otherwise it
    carries the reason (``not_found`` / ``timeout`` / ``exit_code`` /
    ``no_devices``) plus any observed facts (tool path, exit code, first stderr
    line).
    """
    executable = resolve_nvidia_smi(platform_name)
    if executable is None:
        return "missing", [], _probe_details("not_found")
    argv = [
        executable,
        f"--query-gpu={NVIDIA_QUERY_FIELDS}",
        "--format=csv,noheader,nounits",
    ]
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=NVIDIA_PROBE_TIMEOUT_SECONDS,
            shell=False,
            creationflags=get_no_window_creationflags(),
        )
    except subprocess.TimeoutExpired as exc:
        _log_probe_failure("nvidia-smi", exc)
        return "error", [], _probe_details("timeout", executable=executable)
    except OSError as exc:
        _log_probe_failure("nvidia-smi", exc)
        return "error", [], _probe_details(
            "launch_failed", executable=executable, stderr_text=str(exc)
        )
    if result.returncode != 0:
        _log_probe_failure(
            "nvidia-smi", RuntimeError(f"exit code {result.returncode}")
        )
        return "error", [], _probe_details(
            "exit_code",
            executable=executable,
            exit_code=result.returncode,
            stderr_text=result.stderr,
        )
    devices = parse_nvidia_smi_csv(result.stdout)
    return "ok", devices, None if devices else _probe_details(
        "no_devices", executable=executable
    )


# --------------------------------------------------------------------------
# AMD probe
# --------------------------------------------------------------------------

def is_wsl_environment():
    if sys.platform != "linux":
        return False
    try:
        release = os.uname().release.lower()
    except (AttributeError, ValueError):
        return False
    return "microsoft" in release


def resolve_amd_smi():
    """Locate ``amd-smi`` on PATH plus the standard ROCm locations.

    ``/opt/rocm/core-*/bin`` entries are ordered by *parsed* version, not by
    lexical path order, so ``core-10.0`` wins over ``core-6.3``. The standalone
    ``amdrocm-amdsmi`` package does not put the binary on PATH by default.
    """
    found = shutil.which("amd-smi")
    if found:
        return found
    versioned = []
    for candidate in glob.glob("/opt/rocm/core-*/bin/amd-smi"):
        match = re.search(r"core-(\d+(?:\.\d+)*)", candidate)
        if not match:
            continue
        version = tuple(int(part) for part in match.group(1).split("."))
        versioned.append((version, candidate))
    versioned.sort(key=lambda item: item[0], reverse=True)
    for _, candidate in versioned:
        if os.path.isfile(candidate):
            return candidate
    fixed = "/opt/rocm/bin/amd-smi"
    if os.path.isfile(fixed):
        return fixed
    return None


_AMD_NAME_KEYS = ("name", "product_name", "model", "board_name", "market_name")
_AMD_UTIL_KEYS = (
    "gfx_activity",
    "gpu_activity",
    "gpu_busy_percent",
    "gfx",
    "gpu_utilization",
    "utilization",
)
_AMD_TEMP_KEYS = (
    "edge_temperature",
    "gpu_edge_temp",
    "temperature",
    "temp_edge",
)
_AMD_MEM_KEYS = (
    "vram_mem_usage",
    "gpu_mem_usage",
    "mem_usage",
    "vram_usage",
    "memory_usage",
)
_AMD_BDF_KEYS = ("bdf", "pci_bdf", "pci_bus_id", "pcie_bdf")
_AMD_UUID_KEYS = ("uuid",)
_AMD_USED_KEYS = ("used", "used_memory")
_AMD_TOTAL_KEYS = ("total", "total_memory")

_AMD_UNIT_MULTIPLIERS = {
    "": 1,
    "b": 1,
    "k": 1024,
    "kb": 1024,
    "kib": 1024,
    "m": 1024 ** 2,
    "mb": 1024 ** 2,
    "mib": 1024 ** 2,
    "g": 1024 ** 3,
    "gb": 1024 ** 3,
    "gib": 1024 ** 3,
    "t": 1024 ** 4,
    "tb": 1024 ** 4,
    "tib": 1024 ** 4,
}


def _amd_walk(node, depth):
    """Breadth-first ``(key, value)`` pairs so shallow matches win."""
    queue = [(node, depth)]
    while queue:
        current, remaining = queue.pop(0)
        if not isinstance(current, dict):
            continue
        for key, value in current.items():
            yield key, value
            if isinstance(value, dict) and remaining > 0:
                queue.append((value, remaining - 1))


def amd_number(value):
    """Normalize plain numerics and unit-bearing values from AMD SMI JSON."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else None
    if isinstance(value, dict):
        return amd_number(value.get("value"))
    if isinstance(value, str):
        match = re.match(r"\s*(-?[0-9]*\.?[0-9]+)", value)
        if match:
            number = float(match.group(1))
            return number if math.isfinite(number) and number >= 0 else None
    return None


def amd_bytes(value):
    """Bytes from a number or a unit-bearing string like ``"4.0 GB"``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number) or number < 0:
            return None
        return int(number)
    if isinstance(value, dict):
        inner = value.get("value")
        unit = value.get("unit")
        if isinstance(unit, str) and unit.strip():
            return amd_bytes(f"{inner} {unit}")
        return amd_bytes(inner)
    if isinstance(value, str):
        match = re.match(r"\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)", value)
        if not match:
            return None
        number = float(match.group(1))
        multiplier = _AMD_UNIT_MULTIPLIERS.get(match.group(2).lower())
        if multiplier is None:
            return None
        return int(number * multiplier)
    return None


def _amd_find_number(node, keys, depth=3):
    for key, value in _amd_walk(node, depth):
        if key in keys:
            number = amd_number(value)
            if number is not None:
                return number
    return None


def _amd_find_string(node, keys, depth=3):
    for key, value in _amd_walk(node, depth):
        if key in keys and isinstance(value, str) and value.strip():
            return value.strip()[:120]
    return None


def _amd_find_raw(node, keys, depth=3):
    for key, value in _amd_walk(node, depth):
        if key in keys and value is not None:
            return value
    return None


def _amd_memory_usage(node):
    """``(used_bytes, total_bytes)`` from whichever nesting a release uses."""
    usage = _amd_find_raw(node, _AMD_MEM_KEYS)
    if isinstance(usage, dict):
        used = usage.get(_AMD_USED_KEYS[0], usage.get(_AMD_USED_KEYS[1]))
        total = usage.get(_AMD_TOTAL_KEYS[0], usage.get(_AMD_TOTAL_KEYS[1]))
        return amd_bytes(used), amd_bytes(total)
    return None, None


def _amd_device_nodes(data):
    """Device dicts from AMD SMI metric output, across release shapes."""
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        nodes = [
            value
            for key, value in data.items()
            if isinstance(value, dict)
            and str(key).lower().startswith(("card", "gpu"))
        ]
        if nodes:
            return nodes
        for key in ("gpu_data", "gpu"):
            gpu = data.get(key)
            if isinstance(gpu, list):
                return [item for item in gpu if isinstance(item, dict)]
            if isinstance(gpu, dict):
                return [gpu]
    return []


def parse_amd_device(node, fallback_index):
    """Normalize one AMD device; every field is independent."""
    raw_index = node.get("gpu")
    has_reported_index = (
        isinstance(raw_index, int) and not isinstance(raw_index, bool) and raw_index >= 0
    )
    index = raw_index if has_reported_index else fallback_index
    name = _amd_find_string(node, _AMD_NAME_KEYS)
    utilization = clamp_percent(_amd_find_number(node, _AMD_UTIL_KEYS))
    temperature = _amd_find_number(node, _AMD_TEMP_KEYS)
    memory_used, memory_total = _amd_memory_usage(node)
    if memory_used is not None and memory_total is not None and memory_used > memory_total:
        memory_used = None
    uuid = _normalize_uuid(_amd_find_string(node, _AMD_UUID_KEYS) or "")
    bdf = _normalize_bdf(_amd_find_string(node, _AMD_BDF_KEYS) or "")

    if (uuid is None and bdf is None and name is None and utilization is None
            and temperature is None and memory_used is None and memory_total is None
            and not has_reported_index):
        return None

    if uuid is not None:
        gpu_id = f"amd:uuid:{uuid}"
        persistent = True
    elif bdf is not None:
        gpu_id = f"amd:bdf:{bdf}"
        persistent = True
    else:
        gpu_id = f"amd:index:{index}"
        persistent = False

    return {
        "provider": "amd",
        "id": gpu_id,
        "id_persistent": persistent,
        "index": index,
        "name": name,
        "utilization_percent": utilization,
        "memory_used_bytes": memory_used,
        "memory_total_bytes": memory_total,
        "temperature_c": temperature,
    }


def parse_amd_smi_json(text):
    """All GPUs from one bounded ``amd-smi metric --json`` probe.

    The parser is deliberately isolated and permissive: AMD SMI field names and
    nesting have changed between releases, so only actually supplied fields are
    normalized and absent values stay ``null``.
    """
    data = json.loads(text)
    devices = []
    for node in _amd_device_nodes(data):
        device = parse_amd_device(node, fallback_index=len(devices))
        if device is not None:
            devices.append(device)
    return devices


def probe_amd(platform_name):
    """Return ``(status, devices, details)``.

    Status is ``ok`` / ``missing`` / ``error`` / ``unsupported_platform``.
    Native Windows and macOS never execute an incidental ``amd-smi`` found on
    PATH; WSL may use an already-working one but gets no install guidance.
    ``details`` is ``None`` when the probe produced usable devices; otherwise
    it carries the reason plus any observed facts (tool path, exit code, first
    stderr line).
    """
    if platform_name == "win32" or platform_name == "darwin" or not platform_name.startswith("linux"):
        return "unsupported_platform", [], None
    executable = resolve_amd_smi()
    if executable is None:
        return "missing", [], _probe_details("not_found")
    try:
        result = subprocess.run(
            [executable, "metric", "--json"],
            capture_output=True,
            text=True,
            timeout=AMD_PROBE_TIMEOUT_SECONDS,
            shell=False,
            creationflags=get_no_window_creationflags(),
        )
    except subprocess.TimeoutExpired as exc:
        _log_probe_failure("amd-smi", exc)
        return "error", [], _probe_details("timeout", executable=executable)
    except OSError as exc:
        _log_probe_failure("amd-smi", exc)
        return "error", [], _probe_details(
            "launch_failed", executable=executable, stderr_text=str(exc)
        )
    if result.returncode != 0:
        _log_probe_failure("amd-smi", RuntimeError(f"exit code {result.returncode}"))
        return "error", [], _probe_details(
            "exit_code",
            executable=executable,
            exit_code=result.returncode,
            stderr_text=result.stderr,
        )
    try:
        devices = parse_amd_smi_json(result.stdout)
    except (json.JSONDecodeError, ValueError) as exc:
        _log_probe_failure("amd-smi", exc)
        return "error", [], _probe_details(
            "parse_error", executable=executable, stderr_text=str(exc)
        )
    return "ok", devices, None if devices else _probe_details(
        "no_devices", executable=executable
    )


# --------------------------------------------------------------------------
# Setup-state generation (evidence-gated, per provider)
# --------------------------------------------------------------------------

def provider_hints(backend_name):
    """``(nvidia, amd)`` hints from the installed backend only.

    ``cuda`` implies NVIDIA; ``hip``/``rocm``/Lemonade imply AMD. Vulkan and
    CPU backends imply no vendor, so no speculative setup rows are emitted.
    """
    backend = str(backend_name or "").strip().lower()
    if backend == "custom":
        return False, False
    nvidia = backend.startswith("cuda")
    amd = (
        backend == "hip"
        or backend.startswith("rocm")
        or backend.startswith("lemonade")
    )
    return nvidia, amd


def detect_package_manager(os_release_text):
    """Allowlisted package manager from ``/etc/os-release``, or ``None``."""
    if os_release_text is None:
        return None
    values = {}
    for line in str(os_release_text).splitlines():
        key, sep, rest = line.partition("=")
        if sep:
            values[key.strip().upper()] = rest.strip().strip('"').strip("'").lower()
    identities = [values.get("ID", "")] + values.get("ID_LIKE", "").split()
    for identity in identities:
        if identity in ("debian", "ubuntu"):
            return "apt"
        if identity in ("fedora", "rhel", "centos", "rocky", "almalinux"):
            return "dnf"
        if identity in ("suse", "opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles"):
            return "zypper"
    return None


def read_os_release():
    try:
        return _read_text_file("/etc/os-release")
    except OSError:
        return None


def _nvidia_setup_entry(nvidia_status, details=None):
    if nvidia_status == "missing":
        entry = {
            "provider": "nvidia",
            "state": "setup_required",
            "action": "open_docs",
            "command": None,
            "package_manager": None,
            "docs_url": NVIDIA_DOCS_URL,
            "message": (
                "nvidia-smi was not found. It ships with the NVIDIA driver "
                "environment - install or update the driver using the official "
                "documentation, then recheck."
            ),
        }
    else:
        # Probe failed or exited successfully without a usable device.
        entry = {
            "provider": "nvidia",
            "state": "error",
            "action": "open_docs",
            "command": None,
            "package_manager": None,
            "docs_url": NVIDIA_DOCS_URL,
            "message": (
                "nvidia-smi ran but returned no usable GPU data. Check the NVIDIA "
                "driver installation, then recheck."
            ),
        }
    if details is not None:
        entry["details"] = details
    return entry


def _amd_setup_entry(amd_status, is_wsl, os_release_text, details=None):
    if is_wsl or amd_status == "unsupported_platform":
        return {
            "provider": "amd",
            "state": "unsupported",
            "action": "open_docs",
            "command": None,
            "package_manager": None,
            "docs_url": AMD_INSTALL_DOCS_URL,
            "message": (
                "AMD GPU telemetry is currently available only on Linux bare "
                "metal. Windows and WSL users can still run models normally, "
                "but Monitor cannot currently collect AMD GPU metrics on this "
                "platform."
            ),
        }
    if amd_status == "missing":
        # WSL was already excluded above, so normal distribution rules apply.
        manager = detect_package_manager(os_release_text)
        command = AMD_SETUP_COMMANDS.get(manager)
        entry = {
            "provider": "amd",
            "state": "setup_required",
            "action": "copy_command" if command else "open_docs",
            "command": command,
            "package_manager": manager,
            "docs_url": AMD_INSTALL_DOCS_URL,
            "message": (
                "amd-smi was not found. The AMD repository and a compatible "
                "amdgpu driver must already be configured; "
                + (
                    "then install AMD SMI with the command shown. "
                    if command
                    else "then install the amdrocm-amdsmi package using your "
                    "distribution's package manager. "
                )
                + "Llama GUI shows installation guidance but never runs "
                "package-manager commands."
            ),
        }
        if details is not None:
            entry["details"] = details
        return entry
    entry = {
        "provider": "amd",
        "state": "error",
        "action": "open_docs",
        "command": None,
        "package_manager": None,
        "docs_url": AMD_INSTALL_DOCS_URL,
        "message": (
            "amd-smi ran but returned no usable GPU data. Check the ROCm "
            "installation, then recheck."
        ),
    }
    if details is not None:
        entry["details"] = details
    return entry


def build_gpu_setup_entries(
    platform_name,
    is_wsl,
    backend_name,
    nvidia_status,
    nvidia_device_count,
    amd_status,
    amd_device_count,
    os_release_text=None,
    nvidia_details=None,
    amd_details=None,
):
    """Relevant setup/error/unsupported rows only.

    A working probe suppresses only its own provider's row; provider states are
    independent, so mixed success/failure states coexist. Providers without
    backend evidence produce nothing here — the frontend owns the generic
    no-hint state. Probe diagnostics are attached as ``details`` when the probe
    observed a failure or found no usable devices.
    """
    nvidia_hint, amd_hint = provider_hints(backend_name)
    entries = []

    if nvidia_hint:
        if nvidia_status == "ok" and nvidia_device_count == 0:
            # Exited successfully but yielded no valid devices.
            entries.append(_nvidia_setup_entry("error", details=nvidia_details))
        elif nvidia_status != "ok":
            entries.append(_nvidia_setup_entry(nvidia_status, details=nvidia_details))

    if amd_hint:
        if amd_status == "unsupported_platform":
            entries.append(_amd_setup_entry(amd_status, is_wsl, os_release_text))
        elif amd_status == "ok" and amd_device_count == 0:
            if is_wsl:
                # WSL without an already-working probe gets the platform
                # limitation message, not Linux package guidance.
                entries.append(
                    _amd_setup_entry("unsupported_platform", is_wsl, os_release_text)
                )
            else:
                entries.append(
                    _amd_setup_entry("error", is_wsl, os_release_text, details=amd_details)
                )
        elif amd_status != "ok":
            entries.append(
                _amd_setup_entry(amd_status, is_wsl, os_release_text, details=amd_details)
            )
    return entries


# --------------------------------------------------------------------------
# Sample assembly and caching orchestration
# --------------------------------------------------------------------------

def _build_cpu_metric(previous, current_cpu, interval_ok):
    if current_cpu is None:
        return {"available": False, "percent": None}
    percent = None
    prev_cpu = previous.get("cpu") if previous else None
    if (
        prev_cpu is not None
        and interval_ok
        and prev_cpu.get("source") == current_cpu.get("source")
    ):
        percent = compute_cpu_percent(
            prev_cpu.get("total"),
            prev_cpu.get("idle"),
            current_cpu.get("total"),
            current_cpu.get("idle"),
        )
    return {"available": True, "percent": percent}


def _build_memory_metric(current_memory):
    if current_memory is None:
        return {
            "available": False,
            "used_bytes": None,
            "total_bytes": None,
            "percent": None,
        }
    used, total = current_memory
    used = finite_non_negative(used)
    total = finite_non_negative(total)
    if used is None or total is None:
        return {
            "available": False,
            "used_bytes": None,
            "total_bytes": None,
            "percent": None,
        }
    return {
        "available": True,
        "used_bytes": int(used),
        "total_bytes": int(total),
        "percent": usage_percent(used, total),
    }


def _build_disk_metric(previous, counters, interval_seconds, interval_ok):
    usage = counters.get("disk_usage")
    read_rate = None
    write_rate = None
    current_disk = counters.get("disk")
    prev_disk = previous.get("disk") if previous else None
    if (
        current_disk is not None
        and prev_disk is not None
        and interval_ok
        and prev_disk.get("source") == current_disk.get("source")
    ):
        read_rate = compute_bytes_per_second(
            prev_disk.get("bytes_read"),
            current_disk.get("bytes_read"),
            interval_seconds,
        )
        write_rate = compute_bytes_per_second(
            prev_disk.get("bytes_written"),
            current_disk.get("bytes_written"),
            interval_seconds,
        )

    if usage is None:
        return {
            "available": False,
            "path_label": "Application disk",
            "used_bytes": None,
            "total_bytes": None,
            "percent": None,
            "read_bytes_per_second": read_rate,
            "write_bytes_per_second": write_rate,
        }
    used, total = usage
    return {
        "available": True,
        "path_label": "Application disk",
        "used_bytes": int(used),
        "total_bytes": int(total),
        "percent": usage_percent(used, total),
        "read_bytes_per_second": read_rate,
        "write_bytes_per_second": write_rate,
    }


def get_backend_name(ctx):
    try:
        cfg = ctx.services.load_config()
    except Exception as exc:
        print(
            f"[system-stats] failed to read backend config: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return None
    return cfg.get("backend") if isinstance(cfg, dict) else None


def _cached_amd_probe(state, allow_cache):
    """Freshness-checked AMD probe result, or ``None`` when a probe is needed."""
    if not allow_cache:
        return None
    with state.system_stats_lock:
        cached = state.system_stats_probe_cache.get("amd")
    if cached is not None and cached[0] >= time.monotonic():
        return cached[1]
    return None


def _store_amd_probe(state, probe_result):
    with state.system_stats_lock:
        state.system_stats_probe_cache["amd"] = (
            time.monotonic() + AMD_PROBE_CACHE_TTL_SECONDS,
            probe_result,
        )


def collect_sample(ctx, previous, allow_probe_cache=True):
    """One full response payload plus the next ``previous`` record.

    Counter reads happen first with their timestamps; the slow vendor probes
    run afterwards and cannot influence ``sampled_at`` or ``interval_seconds``.
    """
    services = ctx.services
    platform_name = getattr(services, "current_platform", "") or sys.platform
    counters = collect_system_counters(ctx, platform_name)

    interval_seconds = None
    if previous is not None:
        previous_monotonic = previous.get("monotonic")
        if previous_monotonic is not None:
            interval_seconds = counters["monotonic"] - previous_monotonic
    interval_ok = valid_rate_interval(interval_seconds)

    nvidia_status, nvidia_devices, nvidia_details = probe_nvidia(platform_name)

    is_wsl = platform_name.startswith("linux") and is_wsl_environment()
    cached_amd = _cached_amd_probe(ctx.state, allow_probe_cache)
    if cached_amd is not None:
        amd_status, amd_devices, amd_details = cached_amd
    else:
        amd_status, amd_devices, amd_details = probe_amd(platform_name)
        if amd_status in ("ok", "error"):
            _store_amd_probe(ctx.state, (amd_status, amd_devices, amd_details))

    gpu_setup = build_gpu_setup_entries(
        platform_name,
        is_wsl,
        get_backend_name(ctx),
        nvidia_status,
        len(nvidia_devices),
        amd_status,
        len(amd_devices),
        os_release_text=read_os_release() if platform_name.startswith("linux") else None,
        nvidia_details=nvidia_details,
        amd_details=amd_details,
    )

    data = {
        "sampled_at": counters["wall"],
        "interval_seconds": interval_seconds if interval_ok else None,
        "system": {
            "cpu": _build_cpu_metric(previous, counters.get("cpu"), interval_ok),
            "memory": _build_memory_metric(counters.get("memory")),
            "disk": _build_disk_metric(previous, counters, interval_seconds, interval_ok),
        },
        "gpus": list(nvidia_devices) + list(amd_devices),
        "gpu_setup": gpu_setup,
    }
    new_previous = {
        "monotonic": counters["monotonic"],
        "cpu": counters.get("cpu"),
        "disk": counters.get("disk"),
    }
    return data, new_previous


def get_system_stats(ctx, force_refresh=False):
    """The Monitor payload, served from a short-lived cache when possible.

    Cache miss or forced refresh records the observed cache generation, claims
    the collection lock, and checks again: if another request advanced the
    generation while waiting, that completed sample is returned even for
    ``refresh=1``. Repeated Recheck clicks therefore coalesce instead of
    queueing serial forced probes.
    """
    state = ctx.state
    now = time.monotonic()
    with state.system_stats_lock:
        cache = state.system_stats_cache
        if cache is not None and not force_refresh and now < cache["expires_at"]:
            return cache["data"]
        observed_generation = state.system_stats_generation

    with state.system_stats_collection_lock:
        with state.system_stats_lock:
            if (
                state.system_stats_generation != observed_generation
                and state.system_stats_cache is not None
            ):
                return state.system_stats_cache["data"]
            previous = state.system_stats_previous

        data, new_previous = collect_sample(
            ctx, previous, allow_probe_cache=not force_refresh
        )

        with state.system_stats_lock:
            state.system_stats_previous = new_previous
            state.system_stats_cache = {
                "data": data,
                "expires_at": time.monotonic() + CACHE_TTL_SECONDS,
            }
            state.system_stats_generation += 1
            return data
