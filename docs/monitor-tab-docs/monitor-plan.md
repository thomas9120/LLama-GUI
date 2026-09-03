# Monitor Tab — Implementation Plan

Status: **ready for implementation** (revised 2026-09-01).

Tracks [issue #325](https://github.com/thomas9120/LLama-GUI/issues/325).

## Goal

Add a first-class **Monitor** tab that:

1. Moves the existing live llama.cpp process log out of Configure.
2. Shows CPU, RAM, disk capacity, and best-effort disk I/O without adding a required runtime dependency.
3. Shows every NVIDIA or AMD GPU for which a supported vendor probe is already available.
4. Explains how to enable missing GPU monitoring without making the normal LLama-GUI install heavier or silently installing drivers.

The tab must remain useful when no GPU telemetry is available. Missing or unsupported metrics are normal capability states, not page-level errors.

## Decisions

- Call the tab **Monitor**. “Status” is already used throughout the app for runtime and installation state.
- Put Monitor after Configure in the Setup section of the sidebar.
- Move the single main process terminal; do not keep a mirrored Configure copy.
- Keep the existing cursor-based `GET /api/output` path and 5,000-line in-memory backlog.
- Add one read-only `GET /api/system-stats` endpoint.
- Keep `requirements.txt` unchanged. CPU, RAM, and disk collection use Python stdlib, OS files, and bounded native commands.
- Probe vendor tools already on the machine:
  - NVIDIA: `nvidia-smi`.
  - AMD: `amd-smi`.
- Do not install GPU drivers or invoke privileged OS package managers from LLama-GUI v1.
- The in-tab setup action is provider-specific:
  - NVIDIA: open official driver/setup documentation, then let the user recheck.
  - AMD on supported Linux: show and copy the allowlisted package-manager command for `amdrocm-amdsmi`, link the official instructions, then let the user recheck.
  - Unsupported platforms/providers: explain the limitation without offering a fake install action.
- Keep the existing fixed llama-server performance bar unchanged. Do not duplicate its token/KV metrics in Monitor v1.
- Use live values and CSS bars only. No history database, charts, alerts, or background monitoring while the tab is hidden.

## Non-goals

- Installing or upgrading NVIDIA/AMD drivers.
- Running `sudo`, `pkexec`, PowerShell elevation, or an OS package manager.
- Bundling `psutil`, NVML bindings, AMD SMI bindings, or a chart library.
- Apple Metal, Intel GPU, Vulkan-vendor, per-process, power, fan, or thermal telemetry in v1.
- Persisting monitoring history.
- Turning process output into a disk-backed log.
- Monitoring an externally registered llama-server process; LLama-GUI has no ownership of its stdout/stderr.

These can be added after the basic tab proves useful. The response schema leaves room for more providers and fields without requiring them now.

## User Experience

### Page layout

The Monitor tab contains:

1. **Process Output**
   - Current process/tool label and running state.
   - Existing real-time terminal and backlog.
   - Auto-scroll checkbox, enabled by default.
   - Clear button.
   - Existing llama-cli stdin row when applicable.

2. **System**
   - CPU usage.
   - RAM used/total and percentage.
   - Application-disk used/total and percentage.
   - Disk read/write throughput when the platform collector supports it.

3. **GPUs**
   - One card per returned GPU.
   - Stable identity/name, utilization, VRAM used/total, and temperature when supplied.
   - Unsupported fields render as “Not available,” never as zero.

4. **GPU Monitoring Setup**
   - Hidden when a provider probe works.
   - “Set up NVIDIA monitoring” opens official NVIDIA driver documentation.
   - “Set up AMD monitoring” on supported Linux shows the detected package-manager command and a Copy button, plus official AMD instructions.
   - Recheck button refreshes capabilities immediately.

### Auto-scroll behavior

- New output scrolls to the bottom only while Auto-scroll is enabled.
- Scrolling upward disables Auto-scroll so the backlog stays put.
- Checking Auto-scroll again jumps to the bottom and resumes following output.
- Clearing the visible terminal also resets the existing output cursor, preserving current behavior.

### Empty and degraded states

- No active LLama-GUI process: retain the most recent in-memory backlog and show “No process running.”
- External server connected: system/GPU stats still work, but the output card explains that external stdout is unavailable.
- No GPUs or tools: system cards still work; GPU area explains how to recheck or set up a supported provider.
- One failed metric: only that metric is unavailable. Other metrics and GPUs continue rendering.

## Existing Infrastructure to Reuse

### Process output

The current log path already has the required concurrency and backlog behavior:

- `ui/js/app.js`: `startOutputPolling()`, `pollOutput()`, `appendOutput()`, and `clearOutput()`.
- `ui/js/output-cursor.js`: generation-aware independent cursor consumer.
- `GET /api/output?since=<cursor>`: incremental output with `lines`, `next_cursor`, `dropped`, `running`, `runtime_generation`, and `active_process_tool`.
- `backend/services/process_manager.py`: locked output buffer and reader threads.
- `backend/config.py`: `PROCESS_OUTPUT_LIMIT = 5000` and `PROCESS_OUTPUT_TRIM = 1000`.

Moving the existing `#output-terminal`, clear button, and stdin row preserves their IDs, so process lifecycle code does not need a second poller or backend route.

### Tabs and modules

- `ui/index.html`: one `.nav-item[data-section]` button and one `#section-<name>` panel.
- `ui/js/app.js`: `switchTab(tabId)` toggles panels and invokes focused module hooks.
- New behavior belongs in `ui/js/monitor-ui.js` as `window.LlamaGui.monitorUi`.
- Add the script after its dependencies and before `app.js`; update the canonical order in `docs/directory.md`.

## Backend Design

### Files

- New: `backend/services/system_stats.py`
- New: `backend/routes/system_stats.py`
- Update: `backend/state.py`
- Update: `backend/app.py`
- Update route documentation in `docs/directory.md` and `docs/architecture.html`.

The route remains thin. Collection, parsing, timeout handling, and capability decisions live in the service.

### Endpoint

`GET /api/system-stats`

Illustrative response:

```json
{
  "sampled_at": 1788278400.0,
  "interval_seconds": 2.01,
  "system": {
    "cpu": {
      "available": true,
      "percent": 18.4
    },
    "memory": {
      "available": true,
      "used_bytes": 12884901888,
      "total_bytes": 34359738368,
      "percent": 37.5
    },
    "disk": {
      "available": true,
      "path_label": "Application disk",
      "used_bytes": 500000000000,
      "total_bytes": 1000000000000,
      "percent": 50.0,
      "read_bytes_per_second": 1200000,
      "write_bytes_per_second": 420000
    }
  },
  "gpus": [
    {
      "provider": "nvidia",
      "id": "GPU-...",
      "index": 0,
      "name": "NVIDIA GeForce ...",
      "utilization_percent": 72.0,
      "memory_used_bytes": 12000000000,
      "memory_total_bytes": 24000000000,
      "temperature_c": 63.0
    }
  ],
  "gpu_setup": [
    {
      "provider": "amd",
      "state": "setup_required",
      "action": "copy_command",
      "command": "sudo apt install amdrocm-amdsmi",
      "docs_url": "https://rocm.docs.amd.com/projects/amdsmi/en/develop/install/install.html"
    }
  ]
}
```

Contract rules:

- Optional numeric fields are `null` when unavailable; never invent zero.
- Each system metric includes `available`; a collector failure does not fail the whole endpoint.
- `gpus` is always an array and uses one entry per physical/logical device returned by the vendor.
- GPU `id` prefers UUID, then PCI/BDF identity, then a provider-scoped index fallback.
- Setup `state` is one of `available`, `setup_required`, `unsupported`, or `error`.
- Setup commands come from a backend allowlist, never user input or string concatenation.
- Client messages are fixed and sanitized. Full probe failures go to stderr.
- The endpoint returns HTTP 200 for partial availability. HTTP 500 is reserved for failure to construct any safe response.

### Sampling state and locks

CPU and disk throughput require deltas between cumulative samples.

Add to `ServerState`:

- `system_stats_lock`
- `system_stats_previous` containing only the previous timestamp/counters
- Optional short-lived `system_stats_cache` so concurrent UI polls do not launch duplicate vendor commands

All reads and writes of these fields occur under `system_stats_lock`. Do not hold the lock while a vendor subprocess runs:

1. Read the previous counters under the lock.
2. Collect current counters and vendor output without the lock.
3. Reacquire the lock, calculate/store the winning sample, and return a snapshot.

Use a monotonic timestamp for rates and wall-clock time only for display metadata.

### Default system collectors

Keep platform decisions in the backend:

- All platforms:
  - Disk capacity: `shutil.disk_usage(ctx.paths.root)`.
- Linux:
  - CPU: cumulative counters from `/proc/stat`.
  - RAM: `/proc/meminfo`.
  - Disk I/O: cumulative bytes from `/proc/diskstats`, limited to the device containing the application path when it can be resolved safely.
- Windows:
  - CPU: `GetSystemTimes` through `ctypes`.
  - RAM: `GlobalMemoryStatusEx` through `ctypes`.
  - Disk I/O: best effort through a small native collector; return unavailable if a reliable application-volume counter cannot be obtained without elevation.
- macOS:
  - CPU/RAM: bounded native commands (`hostinfo`/`vm_stat` or `sysctl`) parsed by small pure helpers.
  - Disk I/O: best effort; unavailable is acceptable in v1.

Every native command uses an argument array, hidden/no-window creation flags, a short timeout, and no shell.

### NVIDIA probe

Resolve `nvidia-smi` from PATH plus known driver locations. Run one bounded selective query for all GPUs:

```text
nvidia-smi --query-gpu=uuid,pci.bus_id,index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits
```

Parsing requirements:

- Use Python’s `csv` module.
- Preserve one row per GPU.
- Accept `N/A` per field.
- Reject malformed rows individually; do not discard good devices.
- Prefer UUID or PCI bus ID over enumeration order.

If the command is missing, offer official driver/setup documentation. Do not attempt to download `nvidia-smi` separately because it belongs to the NVIDIA driver environment.

Official reference: <https://docs.nvidia.com/deploy/nvidia-smi/index.html>

### AMD probe

Resolve `amd-smi` from PATH plus standard ROCm locations. Prefer its JSON output and request one snapshot for all devices. Keep the parser isolated because AMD SMI output has changed between releases.

Parsing requirements:

- Preserve one entry per GPU.
- Prefer UUID or BDF identity.
- Treat missing engine/temperature/VRAM fields independently.
- Bound the command timeout and cache the parsed result.

If `amd-smi` is missing:

- Only offer a package command on supported Linux distributions with a detected allowlisted manager:
  - Debian/Ubuntu: `sudo apt install amdrocm-amdsmi`
  - RHEL/Fedora family: `sudo dnf install amdrocm-amdsmi`
  - SUSE family: `sudo zypper install amdrocm-amdsmi`
- State that the AMD repository and compatible `amdgpu` driver must already be configured.
- Provide Copy and official-docs actions.
- Do not execute the command.
- On Windows/macOS, report unsupported for this adapter.

Official references:

- <https://rocm.docs.amd.com/projects/amdsmi/en/develop/install/install.html>
- <https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html>

### Capability hints

Do not add a separate hardware-discovery framework.

- If a vendor command works, show that provider.
- If it is missing, use the installed backend only as a setup hint (`cuda` → NVIDIA, `hip`/`rocm`/Lemonade → AMD).
- Vulkan and CPU backends do not imply a GPU vendor.
- Always provide a manual “Recheck GPU monitoring” action.

## Frontend Design

### `ui/js/monitor-ui.js`

Own:

- System-stats polling.
- Epoch/AbortController stale-response protection.
- Start on `onTabChanged("monitor")`; stop and abort when hidden.
- Immediate recheck action.
- Safe rendering with `textContent`.
- Byte/rate/percentage formatting.
- GPU card rendering.
- Capability/setup rendering.
- Auto-scroll state and output append/clear helpers.

Polling:

- Poll immediately when opened, then every 2 seconds.
- Never overlap requests.
- Stop while hidden.
- After a transient failure, keep the previous values visibly marked stale and retry.
- Do not toast every failed poll; render one inline status and log unexpected errors with `console.warn`.

### `ui/js/app.js`

Keep changes small:

- Configure `monitorUi` with the existing `fetchJson` helper.
- Notify it from `switchTab(tabId)`.
- Delegate the existing `appendOutput()` and `clearOutput()` rendering to monitor-ui while retaining the existing process cursor/lifecycle ownership.

Do not move process lifecycle, launch/stop, or cursor ownership into monitor-ui.

### `ui/index.html`

- Add Monitor navigation after Configure.
- Add `section-monitor`.
- Move the existing output section, terminal, clear button, and stdin row into it without changing IDs.
- Add semantic system/GPU containers and live-status text.
- Add an accessible Auto-scroll checkbox.
- Add `monitor-ui.js` before `app.js`.

### Styling

- Reuse existing card, terminal, badge, progress/bar, grid, and form-control styles.
- Add only layout selectors that are actually needed.
- Use existing tokens from `ui/css/tokens.css`; no color literals or provider-specific palette blocks.
- On narrow screens, stack cards and keep the terminal controls reachable without horizontal scrolling.

## Implementation Sequence

### Phase 1 — System endpoint

1. Add platform-neutral response builders and delta helpers.
2. Add Linux, Windows, and macOS CPU/RAM/disk collectors.
3. Add the locked previous-sample/cache state.
4. Add NVIDIA and AMD command resolvers/parsers.
5. Add setup-state generation.
6. Register `GET /api/system-stats`.
7. Add focused backend tests and route documentation.

Acceptance:

- Endpoint returns useful CPU/RAM/disk data without new packages.
- Missing vendor tools produce setup states, not errors.
- Mocked multi-GPU output returns separate stable entries.
- A hung/malformed probe cannot hang or fail the whole endpoint.

### Phase 2 — Monitor tab and log move

1. Add `monitor-ui.js` and its unit test.
2. Add the tab and system/GPU markup.
3. Move the existing process output DOM without duplicating it.
4. Add auto-scroll behavior.
5. Gate stats polling on tab visibility.
6. Add responsive styling and frontend smoke coverage.

Acceptance:

- Existing launches, stops, reconnects, output backlog, clear, and llama-cli input still work.
- Scrolling up preserves the user’s position.
- System and GPU cards update only while Monitor is visible.
- Partial/unavailable fields render clearly and safely.

### Phase 3 — Documentation and compatibility

1. Update `docs/directory.md` script order, module table, tabs, service/route tables, and endpoint count.
2. Update `docs/architecture.html` API surface.
3. Add Monitor to the AGENTS.md “Where to edit” table.
4. Update README tab descriptions and screenshots only after the UI is final.
5. Update `docs/changelog.md` with the implemented feature.
6. Check the Pinokio launcher only if script loading, requirements, or startup behavior changes beyond the planned additions.

## Tests

### Backend

Add focused coverage for:

- CPU and disk delta math, including first-sample `null` rates.
- Zero/negative/too-short intervals.
- Linux parser fixtures.
- Windows/macOS collector failures returning unavailable fields.
- NVIDIA CSV: multiple devices, quoted names, `N/A`, malformed row, timeout, and missing executable.
- AMD JSON: multiple devices, missing fields, malformed JSON, timeout, and missing executable.
- Stable identity precedence.
- Setup command allowlist and supported-platform gating.
- Concurrent samples updating cached state under the lock.
- Route partial success and sanitized total failure.

Retain the existing `/api/output` cursor/trim/generation/reader tests unchanged.

### Frontend

Add `tests/frontend/monitor_ui_unit.cjs` for:

- Byte/rate formatting.
- Partial metric rendering.
- Multiple GPU cards and stable labels.
- Safe text rendering.
- Setup-state actions.
- Auto-scroll enabled, disabled, and re-enabled.
- Poll start/stop, no overlap, abort, and stale-response rejection.

Extend:

- `module_namespace_unit.cjs` for `window.LlamaGui.monitorUi`.
- `flag_sync_smoke.cjs` for tab wiring, moved output, backlog, and auto-scroll.
- `test_docs_sync.py` expectations through the documented route tables, not by weakening drift checks.

### Commands

```powershell
node --check ui/js/monitor-ui.js
npm run test:frontend:modules
npm run test:frontend
.venv\Scripts\python.exe -m unittest discover tests -v
git diff --check
```

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Vendor CLI missing | Render setup guidance; system stats continue. |
| Driver missing/incompatible | Never install drivers; link official instructions. |
| Privileged package install hangs | Do not execute package-manager commands in v1. |
| GPU field unsupported | Return `null` per field and keep the device. |
| Multi-GPU order changes | Prefer UUID/PCI/BDF identity over index. |
| Probe subprocess hangs | Short timeout, no shell, cached result, sanitized failure. |
| CPU/disk delta races | Store previous counters under a dedicated lock. |
| Polling overhead | Poll only while visible; cache backend samples for concurrent requests. |
| Output regression after move | Preserve IDs and existing cursor/lifecycle ownership; smoke-test launch/reconnect/CLI input. |
| Theme/accessibility regression | Reuse tokens/components; label controls; keyboard-test setup actions. |

## Deferred Follow-ups

Only add these in response to real demand:

- A confirmed-safe, explicit AMD SMI installer using platform elevation.
- Optional `psutil` fallback if native collectors prove too brittle.
- Apple Metal and Intel GPU adapters.
- Per-process GPU attribution.
- Power, fan, clock, and thermal metrics.
- Historical charts, export, thresholds, and alerts.
- Persisted process logs.

The v1 ceiling is deliberate: one useful tab, one read-only stats endpoint, two optional vendor probes, and no new required packages.
