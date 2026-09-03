# Monitor Tab — Implementation Plan

Status: **ready for implementation** (revised 2026-09-03).

Tracks [issue #325](https://github.com/thomas9120/LLama-GUI/issues/325).

## Goal

Add a first-class **Monitor** tab that:

1. Moves the existing live llama.cpp process log out of Configure.
2. Shows CPU, RAM, disk capacity, and best-effort disk I/O without adding a required runtime dependency.
3. Shows every NVIDIA or AMD GPU for which a supported vendor probe is already available.
4. Offers optional inference, token, and context detail even when GPU telemetry is unavailable.
5. Explains how to enable missing GPU monitoring without making the normal LLama-GUI install heavier or silently installing drivers.

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
- Only show provider-specific setup when the installed backend gives evidence for that provider. Do not make every user dismiss irrelevant NVIDIA and AMD cards.
- Each provider's setup state is independent, so a working NVIDIA probe does not hide a relevant failed AMD probe, or vice versa.
- The in-tab setup action is provider-specific:
  - NVIDIA: open official driver/setup documentation, then let the user recheck.
  - AMD on supported Linux: show and copy the allowlisted package-manager command for `amdrocm-amdsmi`, link the official instructions, then let the user recheck.
  - Native Windows/macOS and WSL without an already-working `amd-smi`: explain that AMD SMI monitoring is unavailable in Monitor v1 without offering a fake install action.
- Keep the fixed llama-server performance bar as the compact always-visible summary. Offer an optional expanded **Inference** card in Monitor, fed from the same normalized server snapshot. Intentional visual overlap is acceptable; duplicate requests, baselines, and state are not.
- Inference-card visibility is part of the same persisted card-visibility preference as the other Monitor cards, not another llama-server telemetry switch and not a second copy of the shared `--metrics` flag.
- Fetch llama-server `/metrics` and `/slots` independently. A disabled or unavailable metrics endpoint must not prevent slot-based context information from rendering.
- Key inference state to the resolved llama-server target. A GUI-owned runtime generation and each external-server connection are distinct targets; changing targets aborts the old request and resets token baselines and slot-rate samples before polling resumes.
- Use actual most-filled-slot occupancy for “Context” (`n_prompt_tokens / n_ctx`). Rename the fixed bar's current cumulative prompt-plus-generated value to “Session tokens” rather than presenting it as context occupancy.
- Use live values and CSS bars only. No history database, charts, or alerts. System/GPU polling stops while the tab is hidden; the Inference card merely receives snapshots from the fixed bar's existing poller.
- Pause both polling flows while the browser document is hidden. Inference polling otherwise continues across app tabs because it also feeds the global stats bar; hiding the Inference card remains presentation-only.
- Accept and document the v1 limitation that llama-server may count `/metrics` and `/slots` requests as activity for `--sleep-idle-seconds`. Do not add a second polling toggle or attempt to infer upstream sleep policy in this feature.
- Let users hide every Monitor card except Process Output. Hiding is a frontend-only view preference persisted with tolerant localStorage helpers; it never changes telemetry collection or server state.

## Non-goals

- Installing or upgrading NVIDIA/AMD drivers.
- Running `sudo`, `pkexec`, PowerShell elevation, or an OS package manager.
- Bundling `psutil`, NVML bindings, AMD SMI bindings, or a chart library.
- Apple Metal, Intel GPU, Vulkan-vendor, per-process, power, fan, or thermal telemetry in v1.
- Persisting monitoring history.
- Turning process output into a disk-backed log.
- Capturing stdout/stderr from an externally registered llama-server process; LLama-GUI can monitor its proxied inference endpoints but does not own its process output.
- Adding a second inference poller, metrics endpoint, or independent token-counter baseline for Monitor.

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

3. **Inference** (optional)
   - Visible by default and hideable through the shared card-visibility controls, so users can keep the fixed bar as their compact view if preferred.
   - Current state and active request count.
   - Prompt, generated, and total tokens since the shared reset baseline.
   - Most-filled-slot context used, maximum, remaining, percentage, and progress bar. The selected slot may be idle while retaining cached context; label it as active or idle rather than implying that it is processing.
   - Prompt and generation throughput when supplied.
   - Active requests, queued requests, and busy/total slots when supplied.
   - A Reset action that updates the existing shared stats baseline, so the fixed bar and Monitor cannot disagree.

4. **GPUs**
   - One card per returned GPU.
   - Stable identity/name, utilization, VRAM used/total, and temperature when supplied.
   - Unsupported fields render as “Not available,” never as zero.

5. **GPU Monitoring Setup**
   - Rendered per relevant provider only when that provider's probe is missing, unsupported, or failing.
   - A working probe suppresses only its own provider's setup card.
   - “Set up NVIDIA monitoring” opens official NVIDIA driver documentation.
   - “Set up AMD monitoring” on supported Linux shows the detected package-manager command and a Copy button, plus official AMD instructions.
   - When no provider can be inferred, show one generic empty state rather than speculative vendor cards.
   - Recheck bypasses the short-lived backend cache and refreshes capabilities immediately.

### Auto-scroll behavior

- New output scrolls to the bottom only while Auto-scroll is enabled.
- Scrolling upward disables Auto-scroll so the backlog stays put.
- Checking Auto-scroll again jumps to the bottom and resumes following output.
- Clearing the visible terminal invalidates any in-flight output request but retains the current cursor. Resetting the cursor to `null` would make the next cursorless request replay the entire backend backlog.
- Keep at most 5,000 terminal line elements and trim the oldest 1,000 at a time, matching the backend buffer ceiling.

### Empty and degraded states

- No active LLama-GUI process: retain the most recent in-memory backlog and show “No process running.”
- No active llama-server: the Inference card keeps its preference but shows “Start or connect to a server to view inference metrics.”
- Metrics endpoint disabled or unavailable: keep rendering fields derivable from `/slots`; mark cumulative counters and queue fields unavailable rather than hiding or failing the card.
- External server connected: system/GPU stats still work and inference details work when its proxied endpoints respond, but the output card explains that external stdout is unavailable.
- External server connected, disconnected, restored, or displaced by a GUI-owned server: reconcile the inference poller from the newly resolved target, abort stale requests, and establish a new baseline. Never combine counters or slot-rate samples from two targets.
- No GPUs or tools with a provider hint: system cards still work; GPU area explains how to recheck or set up only that provider.
- No provider hint: show a generic “No supported GPU telemetry detected” state with Recheck, without NVIDIA/AMD setup cards.
- Mixed providers: render working GPU cards and the failed provider's setup/error card together.
- One failed metric: only that metric is unavailable. Other metrics and GPUs continue rendering.

### Hiding monitor cards

Every Monitor card except Process Output can be hidden. Hiding is a view preference, not telemetry state:

- Hideable items: CPU, memory, disk, Inference, every GPU card, and provider setup/unsupported/error cards. Process Output is the sole fixed card because it is the tab's runtime log and recovery surface.
- Keys are namespaced: `system:cpu`, `system:memory`, `system:disk`, `inference`, `gpu:<provider>:<typed-id>`, and `setup:<provider>` or `state:<provider-or-generic>`. GPU IDs encode their source, for example `nvidia:uuid:...`, `amd:bdf:...`, or `amd:index:0`.
- UUID/PCI/BDF hides persist. Index-fallback GPU hides last for the session only because enumeration order is not stable across boots.
- The hide action is a small ghost button in every hideable card header with an accessible name; compact cards may use an icon-only treatment.
- Hidden items keep being collected and probed; the backend response is unchanged.
- One native `<details>` / `<summary>` “N hidden · Show” control directly below Process Output opens a restore list with per-item restore and “Show all”. When every other card is hidden, Process Output and this control remain available.
- Persistence follows the existing tolerant localStorage helper pattern (try/catch reads/writes, `console.debug` on expected failures): one key holding a JSON array of `{ key, label }` entries. When storage is blocked, preferences last for the session only.
- Validate persisted entries as strings, limit keys to 256 characters and labels to 120, discard malformed/duplicate entries, and keep at most 100 so stale hardware identities cannot grow localStorage indefinitely.
- A hidden card stays hidden across telemetry-state changes. Entries irrelevant to the current response remain dormant and do not appear in the current restore list; “Show all” clears current and dormant entries so an old preference cannot surprise the user later.
- When hiding the focused card, move focus to the hidden-monitor summary. When restoring a card, move focus to its heading or hide button.
- No new endpoint fields, no backend state.

## Existing Infrastructure to Reuse

### Process output

The current log path already has the required concurrency and backlog behavior:

- `ui/js/app.js`: `startOutputPolling()`, `pollOutput()`, `appendOutput()`, and `clearOutput()`.
- `ui/js/output-cursor.js`: generation-aware independent cursor consumer; add a small `invalidate()` operation that advances its epoch without discarding the current cursor.
- `GET /api/output?since=<cursor>`: incremental output with `lines`, `next_cursor`, `dropped`, `running`, `runtime_generation`, and `active_process_tool`.
- `backend/services/process_manager.py`: locked output buffer and reader threads.
- `backend/config.py`: `PROCESS_OUTPUT_LIMIT = 5000` and `PROCESS_OUTPUT_TRIM = 1000`.

Moving the existing `#output-terminal`, clear button, and stdin row preserves their IDs, so process lifecycle code does not need a second poller or backend route. `clearOutput()` clears the DOM and calls the cursor's new `invalidate()` operation; it must not call the existing cursor reset with a `null` cursor.

### Inference metrics

The existing fixed stats bar already polls the proxied llama-server observability endpoints. Reuse that flow instead of adding Monitor-owned requests:

- `ui/js/app.js`: `startStatsPolling()`, `pollStats()`, `getSlotStats()`, and `snapshotStatsBaseline()`.
- `GET /api/llama/metrics`: cumulative prompt/generated counters and throughput, active requests, and queued requests (`llamacpp:requests_deferred`) when llama-server metrics are enabled.
- `GET /api/llama/slots`: per-slot context usage and useful request/slot detail when slots are enabled.

Refactor `pollStats()` to fetch `/metrics` and `/slots` concurrently and independently, then normalize the results into one immutable snapshot. Render both the fixed bar and the optional Inference card from that snapshot. The snapshot carries a target key, sequence number, and `ok` / `unavailable` state for each source so an old value cannot look current after one source fails. A failure marks only its dependent fields unavailable; do not silently carry those fields forward as live or discard the other successful response.

Derive the target key in the existing runtime/status reconciliation path so launches, restores, external connect/disconnect, and target-precedence changes all use one transition. Use the runtime generation for a GUI-owned server and a frontend session revision plus normalized address for an external server; increment the external revision after every successful connect or restore, even when reconnecting to the same address. Do not put an API key in the identity. A target-key change aborts any in-flight poll, clears slot-rate samples, clears rendered values, and establishes a fresh baseline. For a fresh GUI launch the baseline remains zero; for a restored or external server the first valid counter sample becomes the baseline.

This deliberately keeps the existing polling model small. llama-server may count observability requests as activity for `--sleep-idle-seconds`; v1 pauses them when the browser document is hidden but otherwise accepts that upstream behavior. See the [llama-server endpoint and sleeping documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) and [upstream issue #20227](https://github.com/ggml-org/llama.cpp/issues/20227).

The normalized snapshot should distinguish these concepts:

- **Session tokens**: cumulative prompt plus generated tokens since the shared reset baseline.
- **Context — most-filled slot**: the largest valid `n_prompt_tokens / n_ctx` ratio, with used, maximum, remaining, and active/idle state from that same slot.
- **Requests**: processing, deferred/queued, and busy/total slots when available.
- **Speed**: prompt and generation tokens per second when available.

Use warning and critical context presentation at 80% and 95%. These are visual states only; v1 adds no notifications or user-configurable thresholds. Do not infer a zero value from a missing metric. Accept only finite, non-negative normalized values and support llama-server version drift by treating every source field as optional. If a cumulative counter decreases without an observed target change, treat it as an upstream restart: reset the baseline and slot-rate samples rather than clamping a cross-restart delta to zero. Calculate slot-derived live speed only when both samples have the same stable slot/task identity; otherwise use the metrics gauge or mark speed unavailable.

`snapshotStatsBaseline()` remains the only reset operation. When valid raw counters have already been sampled, Reset updates and re-renders both views immediately as zero rather than waiting for the next poll. If counters are unavailable, Reset stays pending and the next valid sample establishes the baseline.

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

`GET /api/system-stats?refresh=1` has the same response contract but bypasses an existing cache entry for the manual Recheck action. The route accepts only the fixed `refresh=1` form; it does not accept commands, provider names, or paths.

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
      "id": "nvidia:uuid:GPU-...",
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
      "docs_url": "https://rocm.docs.amd.com/projects/amdsmi/en/latest/install/install.html"
    }
  ]
}
```

Contract rules:

- Optional numeric fields are `null` when unavailable; never invent zero.
- Accept only finite, non-negative byte/count values, require positive totals before calculating percentages, and constrain percentages to their documented range. An invalid field becomes `null` without discarding its device or sibling metrics.
- Each system metric includes `available`; a collector failure does not fail the whole endpoint.
- `gpus` is always an array and uses one entry per physical/logical device returned by the vendor.
- GPU `id` is provider-qualified and identifies its source: UUID first, then PCI/BDF identity, then an index fallback (for example `nvidia:uuid:...`, `amd:bdf:...`, or `amd:index:0`). Normalize UUID/PCI/BDF values to bounded canonical strings before using them as IDs; an invalid identity falls back to the provider index and is marked non-persistent.
- `gpu_setup` contains only relevant providers whose probes are not working. Its `state` is one of `setup_required`, `unsupported`, or `error`; working providers are represented by `gpus` instead of a redundant `available` setup row.
- Setup relevance comes only from existing backend evidence (`cuda` for NVIDIA; `hip`, `rocm`, or Lemonade for AMD). With no provider evidence, `gpu_setup` is empty and the frontend renders a generic state.
- Provider states are independent: a working probe for one vendor does not suppress a setup/error entry for another relevant vendor.
- If a provider probe exits successfully but yields no valid devices, emit a provider error when backend evidence exists; otherwise leave it to the generic no-hint state.
- Setup commands come from a backend allowlist, never user input or string concatenation.
- Client messages are fixed and sanitized. Full probe failures go to stderr.
- The endpoint returns HTTP 200 for partial availability. HTTP 500 is reserved for failure to construct any safe response.

### Sampling state and locks

CPU and disk throughput require deltas between cumulative samples.

Add to `ServerState`:

- `system_stats_lock`
- `system_stats_collection_lock` to serialize cold/forced collections without holding the state lock across subprocess work
- `system_stats_previous` containing only the previous counter timestamp, counter-source identity, and counters
- `system_stats_cache` plus an internal monotonically increasing cache generation so concurrent and forced UI polls do not launch duplicate vendor commands

All reads and writes of the previous sample, cache, and cache generation occur under `system_stats_lock`. A cache miss or forced refresh records the observed generation, claims `system_stats_collection_lock`, and checks again. If another request advanced the generation while this request waited, return that completed sample even for `refresh=1`; only a forced request that observed no intervening collection starts another probe. Do not hold `system_stats_lock` while a vendor subprocess runs:

1. Read the previous counters and cache generation under the lock.
2. Collect current system counters and capture their monotonic and wall-clock timestamps immediately beside those reads.
3. Collect vendor output without the lock. Slow vendor probes must not contribute to the CPU/disk delta interval or change `sampled_at`.
4. Reacquire the lock, validate deltas, store the sample, advance the generation, and return a snapshot.

Use a monotonic timestamp for rates and wall-clock time only for display metadata. Return a `null` rate and replace the baseline when the counter-source identity changes, a counter decreases, or the interval falls outside 0.1–30 seconds. The upper bound intentionally discards the first average after suspension or a long polling gap; the next normal sample restores the rate.

The short-lived cache TTL should be about the UI poll interval (2 s) so a cold probe is paid at most once per cycle. `refresh=1` bypasses a cache entry that was already complete when the request arrived, but joins any collection that was then in progress; repeated Recheck clicks must not queue serial forced probes.

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
  - Disk I/O: unavailable in v1. Do not add an elevation-sensitive or locale-dependent performance-counter parser merely to populate this optional field.
- macOS:
  - CPU/RAM: Mach host statistics through `ctypes`; return the individual metric unavailable if the native call or returned counters cannot be validated.
  - Disk I/O: unavailable in v1.

Every native command uses an argument array, hidden/no-window creation flags, a short timeout, and no shell.

### NVIDIA probe

Resolve `nvidia-smi` from PATH plus known driver locations. Run one bounded selective query for all GPUs:

```text
nvidia-smi --query-gpu=uuid,pci.bus_id,index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits
```

Timeout the query at about 2 seconds; `nvidia-smi` normally answers within a few hundred milliseconds.

Parsing requirements:

- Use Python’s `csv` module.
- Preserve one row per GPU.
- Accept `N/A` per field.
- Reject malformed rows individually; do not discard good devices.
- Prefer UUID or PCI bus ID over enumeration order.

If the command is missing, offer official driver/setup documentation. Do not attempt to download `nvidia-smi` separately because it belongs to the NVIDIA driver environment.

Official reference: <https://docs.nvidia.com/deploy/nvidia-smi/index.html>

### AMD probe

AMD officially supports AMD SMI on Linux bare metal and Linux VM guests. Its WSL backend is experimental and disabled in normal builds; native Windows and macOS are unsupported. Monitor v1 may use an already-working `amd-smi` under WSL, but it does not offer WSL installation instructions.

Detect WSL before applying normal Linux package/setup rules. Resolve `amd-smi` from PATH plus the standard ROCm locations `/opt/rocm/bin` and `/opt/rocm/core-*/bin` (bounded glob, parsed version order rather than lexical path order). The standalone `amdrocm-amdsmi` package does not put the binary on PATH by default. On native Windows/macOS, do not execute an incidental `amd-smi` found on PATH; on WSL, use it only if the probe actually succeeds.

Run exactly one bounded dynamic probe for all devices in v1:

```text
amd-smi --json
```

Normalize the default JSON summary fields that are actually supplied and return `null` for absent name, utilization, temperature, or VRAM values. Do not add separate `list`, `static`, or `metric` subprocesses unless captured output from supported releases proves the one-command response insufficient for the minimum useful card. Keep the parser isolated because AMD SMI field names and nesting have changed between releases.

Parsing requirements:

- Preserve one entry per GPU.
- Prefer UUID or BDF identity.
- Treat missing engine/temperature/VRAM fields independently, and normalize both plain numeric values and unit-bearing values used by newer JSON output.
- Test captured fixtures from more than one AMD SMI release instead of treating one JSON shape as canonical.
- Bound the command timeout at about 5 seconds — `amd-smi` launches a Python interpreter and is much slower than `nvidia-smi` — and cache the parsed result.

If `amd-smi` is missing:

- Only offer a package command on supported native Linux distributions with a detected allowlisted manager; WSL is excluded before distribution detection:
  - Debian/Ubuntu: `sudo apt install amdrocm-amdsmi`
  - RHEL/Fedora family: `sudo dnf install amdrocm-amdsmi`
  - SUSE family: `sudo zypper install amdrocm-amdsmi`
- State that the AMD repository and compatible `amdgpu` driver must already be configured.
- Provide Copy and official-docs actions.
- Do not execute the command.
- On native Windows/macOS, or on WSL without an already-working probe, report unsupported only when existing backend evidence indicates AMD. The message must explain the platform limitation rather than imply that reinstalling a normal graphics driver will provide `amd-smi`.

Official references:

- <https://rocm.docs.amd.com/projects/amdsmi/en/latest/install/install.html>
- <https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html>
- <https://rocm.docs.amd.com/projects/amdsmi/en/develop/how-to/amdsmi-wsl-mode.html>

### Capability hints

Do not add a separate hardware-discovery framework.

- If a vendor command works, show that provider.
- If it is missing or fails, use the installed backend only as a setup hint (`cuda` → NVIDIA, `hip`/`rocm`/Lemonade → AMD).
- Vulkan and CPU backends do not imply a GPU vendor.
- Do not emit speculative setup rows for providers without evidence. The frontend owns the generic no-hint state.
- Treat each provider independently so working telemetry and another provider's setup/error card can coexist.
- Always provide a manual “Recheck GPU monitoring” action.

## Frontend Design

### `ui/js/monitor-ui.js`

Own:

- System-stats polling.
- Epoch/AbortController stale-response protection.
- Start on `onTabChanged("monitor")`; stop and abort when either the Monitor panel or the browser document is hidden, and resume immediately when both are visible.
- Immediate recheck through `/api/system-stats?refresh=1`.
- Safe rendering with `textContent`.
- Byte/rate/percentage formatting.
- GPU card rendering.
- Capability/setup rendering.
- Auto-scroll state and output append/clear helpers.
- Shared card-visibility preferences: tolerant localStorage persistence, native details/summary restore rendering, session-only handling for index-fallback GPUs, and responsive grid reflow.
- Inference rendering from snapshots supplied by `app.js`; it does not fetch llama-server metrics itself.

Polling:

- Poll immediately when opened, then schedule the next poll 2 seconds after the previous request completes. Do not use a free-running async interval.
- Never overlap requests; a Recheck aborts or joins the current request before forcing a refresh.
- Stop while the Monitor panel or browser document is hidden.
- After a transient failure, keep the previous values visibly marked stale and retry.
- Make the header badge truthful: `Live`, `Refreshing`, `Stale`, `Unavailable`, or `Paused`. Use `Unavailable` before any successful sample and `Stale` only when displaying an older sample.
- Do not toast every failed poll; render one inline status and log unexpected errors with `console.warn`.

### `ui/js/app.js`

Keep changes small:

- Configure `monitorUi` with the existing `fetchJson` helper.
- Notify it from `switchTab(tabId)`.
- Delegate the existing `appendOutput()` and `clearOutput()` rendering to monitor-ui while retaining the existing process cursor/lifecycle ownership.
- Extend `output-cursor.js` with `invalidate()`, which advances its request epoch while preserving the current cursor; use it when clearing the terminal so the backlog does not immediately replay.
- Reconcile one target key from authoritative status inside `refreshRuntimeStatusPanels()` and use it to start, stop, or restart inference polling for both GUI-owned and external servers.
- Route successful external connect, restore, and disconnect actions through that same status refresh; a reconnect to the same address still increments the frontend external-target revision.
- Pause and abort inference polling on `document.visibilitychange` while the document is hidden, then poll immediately on resume. It remains active across app-tab changes because the fixed stats bar is global.
- Normalize each existing stats-poll cycle into one sequenced, target-keyed snapshot with per-source availability and pass it to both the fixed stats bar and `monitorUi`.
- Request `/metrics` and `/slots` independently so either source can produce a partial snapshot.
- Extend slot normalization with most-filled-slot used/maximum/remaining context, active/idle state, and busy/total slot counts.
- Add `requests_deferred` to metrics normalization and keep `snapshotStatsBaseline()` as the only reset baseline.
- Invalidate baselines and rate samples on target changes or counter rollback; render Reset immediately when a valid raw sample exists.
- Relabel the fixed bar's cumulative token value from “Context” to “Session tokens.”

Do not move process lifecycle, launch/stop, or cursor ownership into monitor-ui.

### `ui/index.html`

- Add Monitor navigation after Configure.
- Add `section-monitor`.
- Move the existing output section, terminal, clear button, and stdin row into it without changing IDs.
- Add semantic system/GPU containers and live-status text.
- Add the optional Inference card, its persisted visibility control, context progress bar, unavailable state, and shared Reset action.
- Add an accessible Auto-scroll checkbox.
- Use native `<details>` / `<summary>` markup for the hidden-monitor restore list.
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
3. Add the locked previous-sample/cache-generation state and coalesced forced-refresh rule.
4. Add NVIDIA and AMD command resolvers/parsers.
5. Add evidence-gated, per-provider setup-state generation.
6. Register `GET /api/system-stats`, including validated `refresh=1` cache bypass.
7. Add focused backend tests and route documentation.

Acceptance:

- Endpoint returns useful CPU/RAM/disk data without new packages.
- Missing vendor tools produce setup states, not errors.
- Irrelevant providers do not produce setup cards; mixed-provider success/failure states coexist.
- Mocked multi-GPU output returns separate stable entries.
- A hung/malformed probe cannot hang or fail the whole endpoint.
- Slow vendor probes do not distort CPU/disk intervals, and simultaneous Recheck requests cause at most one new collection.

### Phase 2 — Monitor tab and log move

1. Add `monitor-ui.js` and its unit test.
2. Add the tab and system/GPU markup.
3. Move the existing process output DOM without duplicating it.
4. Add auto-scroll, cursor-preserving clear, and bounded terminal DOM behavior.
5. Add the optional Inference card and refactor the existing llama-server polling into one shared, target-keyed partial snapshot.
6. Gate system/GPU polling on panel and document visibility; gate inference polling on document visibility while keeping its cross-tab fixed-bar cadence without adding another request.
7. Add shared hide/restore behavior to every card except Process Output.
8. Add responsive styling and frontend smoke coverage.

Acceptance:

- Existing launches, stops, reconnects, output backlog, clear, and llama-cli input still work.
- Clear does not repopulate old output on the next poll, and a long-running process does not grow the terminal DOM past 5,000 lines.
- Scrolling up preserves the user’s position.
- System and GPU cards update only while Monitor is visible.
- Showing inference details causes no additional `/metrics` or `/slots` requests, and hiding it removes only the expanded presentation.
- `/metrics` failure does not suppress valid `/slots` context, and `/slots` failure does not suppress valid cumulative metrics.
- The fixed bar and Inference card show the same session-token baseline; Reset updates both.
- Connecting, disconnecting, restoring, or superseding an external server cannot mix its counters or slot rates with another target.
- “Session tokens” and actual most-filled-slot context occupancy are not conflated; retained context identifies an idle slot honestly.
- Partial/unavailable fields render clearly and safely.
- Every card except Process Output can be hidden and restored; compact grids close gaps without leaving empty tracks.

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

- CPU and disk delta math, including first-sample `null` rates and timestamps captured before slow vendor probes.
- Zero/negative/too-short/too-long intervals, counter rollback, and disk-source identity changes.
- Linux parser fixtures.
- Windows/macOS collector failures returning unavailable fields.
- NVIDIA CSV: multiple devices, quoted names, `N/A`, malformed row, timeout, and missing executable.
- AMD default-summary JSON from multiple releases: multiple devices, changed nesting/field names, plain and unit-bearing numbers, empty device results, missing fields, malformed JSON, timeout, and missing executable.
- Provider-qualified stable identity precedence and index-fallback marking.
- Setup command allowlist, existing-backend evidence gating, mixed-provider states, native platform gating, and WSL-before-distro behavior.
- Concurrent samples sharing one cold collection, plus generation-based `refresh=1` coalescing that bypasses an already-complete cache entry without overlapping or queuing collections.
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
- Cursor-preserving clear, stale in-flight rejection, and 5,000-line DOM trimming.
- Poll start/stop for panel and document visibility, schedule-after-completion, no overlap, forced recheck, abort, truthful status badge, and stale-response rejection.
- Provider rendering: no speculative cards without evidence and mixed-provider success/failure states.
- Monitor hiding: every card except Process Output is eligible; system/inference/UUID/BDF hides persist; index-fallback GPU hides stay session-only; per-item and show-all restore work; Show all clears dormant entries; focus moves safely; malformed/oversized storage is normalized; state changes preserve deliberate hides; storage failure falls back to the session.
- Inference details: shared card visibility, no extra polling, shared Reset baseline, optional-field handling, and safe rendering.
- Shared snapshot normalization: independent `/metrics` and `/slots` success/failure without live-looking carryover, prompt/generated/total session tokens, `requests_deferred`, most-filled-slot context selection and active/idle state, remaining-token math, finite-value validation, counter rollback, stable-task-only rates, and 80%/95% visual states.
- Inference polling lifecycle: document visibility pause/resume, GUI runtime generation changes, external connect/disconnect/restore including same-address reconnect, target precedence changes, stale response rejection, and fresh baselines per target.

Extend:

- `output_cursor_unit.cjs` for invalidation that rejects an in-flight response without discarding the current cursor.
- `module_namespace_unit.cjs` for `window.LlamaGui.monitorUi`.
- `flag_sync_smoke.cjs` for tab wiring, moved output, cursor-preserving clear, backlog, and auto-scroll.
- Existing fixed-stats coverage for the “Session tokens” label and agreement with the Inference card after Reset.
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
| Multi-GPU order changes | Use provider-qualified UUID/PCI/BDF identity; do not persist index-fallback hides. |
| Probe subprocess hangs | Short timeout, no shell, cached result, sanitized failure. |
| Slow or changing `amd-smi` CLI | Use one default-summary JSON command, a longer timeout, cached output, and fixtures from multiple releases. |
| Irrelevant vendor setup noise | Emit setup states only for providers indicated by the installed backend. |
| Hidden card conceals changing telemetry | Keep the hidden-card count and restore list directly below Process Output, retain clear labels, and provide one-click per-card restore plus Show all. |
| CPU/disk delta races | Protect state with a dedicated lock and serialize cold collections separately. |
| Misleading rates after sleep, reset, or device change | Timestamp beside counter reads; key counters to their source; replace the baseline on invalid or implausibly long intervals. |
| Polling overhead | Poll system/GPU data only while the Monitor panel and document are visible; poll inference across app tabs only while the document is visible; schedule after completion and share state. |
| Inference polling prevents llama-server idle sleep | Pause while the document is hidden and document the known upstream `/metrics`/`/slots` limitation; do not add a second telemetry state machine in v1. |
| Duplicate inference requests/state | Build one normalized snapshot in the existing stats poller and fan it out to the fixed bar and Monitor; the visibility preference never starts polling. |
| Counters mixed across server targets or restarts | Key snapshots to the resolved target, abort on transitions, and reset baselines/rate samples on target change or counter rollback. |
| Misleading token/context labels | Reserve “Session tokens” for cumulative counters and calculate “Context” only from a valid slot's used/maximum values. |
| Partial llama-server observability | Fetch `/metrics` and `/slots` independently and render unavailable fields without discarding successful data. |
| Recheck returns stale cache or queues probes | Compare cache generations around the collection lock so a forced request joins intervening work and repeated clicks coalesce. |
| Output regression after move | Preserve IDs and cursor/lifecycle ownership; clear via cursor invalidation, bound DOM lines, and smoke-test launch/reconnect/CLI input. |
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

The v1 ceiling is deliberate: one useful tab, one read-only system-stats endpoint, one shared inference snapshot, two optional vendor probes, and no new required packages.
