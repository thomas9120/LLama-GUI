# Benchmark Tab Plan

## What it does

Adds a new "Benchmark" tab (placed right after the "Configure" tab in the sidebar) that lets users run `llama-bench` with configurable parameters and displays the results in a readable table format.

## Current state

- `llama-bench` is already listed in `LLAMA_TOOLS` in `backend/app.py` (line 156), so the binary discovery path works.
- `find_tool_executable` (line 167) already resolves the binary path for any tool in `LLAMA_TOOLS`.
- The `launch_process` function in `backend/services/process_manager.py` can already run `llama-bench` with any tool/args combination, but it streams output and doesn't parse results.
- **However**, `launch_process` uses the shared `ctx.state.process` slot — only one process can run at a time. The benchmark must either reuse this slot (preventing `llama-server` from running simultaneously) or use its own. Since both would fight over GPU resources, the benchmark should reuse the existing process slot and require stopping any running process first.
- There are zero references to benchmark anywhere else in the codebase.

## Architecture: Background thread + polling

The benchmark runs as a background daemon thread (matching the `install.py` pattern at `backend/routes/install.py:50-58`), not a blocking `subprocess.run()` in the HTTP handler. This allows:
- The HTTP handler to return immediately with `{"status": "started"}`
- The frontend to poll for progress and results via a separate GET endpoint
- A stop endpoint to cancel the running benchmark

### Pattern (matches existing codebase conventions)

```
POST /api/benchmark/run   → validates, spawns background thread, returns {"status": "started"}
GET  /api/benchmark/status → returns {status, results, output, error} (polled by frontend)
POST /api/benchmark/stop   → terminates the running benchmark process
```

The background thread:
1. Builds the `llama-bench` command with `-o json` for structured output
2. Runs it via `subprocess.Popen` (reusing `_build_process_env` from `process_manager.py`)
3. Streams stdout/stderr into the benchmark-specific output buffer
4. On completion, parses the JSON results and stores them in state
5. On error, stores the error message in state

## Changes needed

### 1. Backend: Add benchmark state to `ServerState`

**File:** `backend/state.py`

Add a `benchmark` field using `AtomicDict` (same pattern as `model_download` and `remote_tunnel`):

```python
def default_benchmark_state() -> dict[str, Any]:
    return {
        "status": "idle",       # idle | running | completed | error | stopped
        "results": [],          # parsed JSON results from llama-bench
        "output": [],           # raw stdout/stderr lines
        "error": "",            # error message if status is "error"
        "command": "",          # the command that was run
    }
```

Also add:
- `benchmark_lock: threading.Lock` — guards start/stop to prevent double-starts
- `benchmark_process: Any = None` — holds the `subprocess.Popen` reference (separate from `ctx.state.process` so the benchmark has its own lifecycle, but the start guard still checks `is_process_running` to avoid GPU conflicts)

### 2. Backend: New benchmark service

**File:** `backend/services/benchmark.py` (new file)

Functions:
- `run_benchmark(ctx, model_path, params)` — the background thread target:
  1. Acquires `benchmark_lock`, sets state to `running`
  2. Checks `process_manager.is_process_running(ctx)` — returns error if a process is already running
  3. Validates binary exists via `ctx.services.find_tool_executable("llama-bench")`
  4. Builds args list: `["--model", path, "-o", "json", ...]` from params
  5. Launches `subprocess.Popen` with `_build_process_env(ctx)` (imported from `process_manager`)
  6. Streams output into `ctx.state.benchmark` output buffer
  7. Waits for completion, parses JSON stdout
  8. Updates state with `status: "completed"` and parsed results
  9. On error/exception, updates state with `status: "error"` and error message
  10. On cancellation (process terminated), sets `status: "stopped"`

- `stop_benchmark(ctx)` — terminates the benchmark process:
  1. Gets the process reference from state
  2. Sends `CTRL_BREAK_EVENT` (Windows) or `terminate()` (other platforms) — same as `process_manager.stop_process`
  3. Waits up to 5 seconds, then `kill()` if still alive
  4. Sets state to `stopped`

- `get_benchmark_status(ctx)` — returns `ctx.state.benchmark.snapshot()`

- `build_benchmark_args(model_path, params)` — builds the `llama-bench` CLI args from the UI parameters:
  - `--model <path>` (required)
  - `-o json` (always — for structured output parsing)
  - `-n <iterations>` (default: 5)
  - `-p <prompt_tokens>` (prompt size in tokens, default: 512)
  - `-b <batch_size>` (default: 2048)
  - `-t <threads>` (default: llama-bench's auto-detect)
  - `--flash-attn` / `--no-flash-attn` (if specified)
  - `-ngl <gpu_layers>` (if specified)
  - `-mmap <true/false>` (if specified)
  - Context size is NOT a direct `llama-bench` flag — `llama-bench` uses `-p` (prompt tokens) and `-n` (gen tokens) instead

### 3. Backend: New benchmark route

**File:** `backend/routes/benchmark.py` (new file)

Handlers:
- `start_benchmark(request, response, ctx)`:
  - Extracts `model_path` and params from `request.body`
  - Validates `model_path` is non-empty
  - Checks benchmark isn't already running (`ctx.state.benchmark.snapshot()["status"] == "running"`)
  - Checks no other process is running (`process_manager.is_process_running(ctx)`)
  - Spawns `threading.Thread(target=benchmark_service.run_benchmark, daemon=True).start()`
  - Returns `{"status": "started"}`

- `get_status(request, response, ctx)`:
  - Returns `benchmark_service.get_benchmark_status(ctx)`

- `stop_benchmark(request, response, ctx)`:
  - Calls `benchmark_service.stop_benchmark(ctx)`
  - Returns the updated status snapshot

### 4. Backend: Register the routes

**File:** `backend/app.py`

- Add `from .routes import benchmark as benchmark_routes` import (near line 28)
- Add to `API_ROUTER` (near line 765):
  ```python
  .add("POST", "/api/benchmark/run", benchmark_routes.start_benchmark)
  .add("GET", "/api/benchmark/status", benchmark_routes.get_status)
  .add("POST", "/api/benchmark/stop", benchmark_routes.stop_benchmark)
  ```

### 5. Frontend: Add the tab to the sidebar

**File:** `ui/index.html`

**Nav button** — insert after the Configure button (after line 49), before the "Interact" section label (line 51):
```html
<button class="nav-item" data-section="benchmark">
    <span class="icon">...</span>
    Benchmark
</button>
```
This keeps it in the "Setup" group since benchmarking is a setup/validation activity.

**Section panel** — insert after `section-configure` closing `</div>` (after line 503), before the Chat section (line 505):
```html
<div class="section-panel" id="section-benchmark" style="display:none;">
```

The benchmark tab HTML will contain:
- **Model display** — reads from the shared `#model-select` value (no separate dropdown; shows the currently selected model as text with a link to Configure to change it)
- **Benchmark parameters** section (benchmark-specific controls, not reusing the flag system):
  - Prompt size (`-p`): number input, default 512 tokens
  - Iterations (`-n`): number input, default 5
  - Batch size (`-b`): number input, default 2048
  - Threads (`-t`): number input, empty = auto-detect
  - GPU layers (`-ngl`): number input, empty = default
  - Flash attention: checkbox (tri-state: default/on/off)
  - mmap: checkbox (tri-state: default/on/off)
- **Run benchmark** button
- **Stop benchmark** button (visible only while running)
- **Status indicator** — shows idle/running/completed/error/stopped state
- **Command preview** — shows the exact `llama-bench` command that will be run
- **Results table** — renders the parsed JSON results. `llama-bench -o json` outputs an array of objects with these fields:
  - `model`: model filename
  - `size`: model size in bytes
  - `n_batch`: batch size
  - `n_threads`: thread count
  - `flash_attn`: boolean
  - `n_prompt`: prompt token count
  - `n_gen`: generation token count
  - `t_prompt_eval`: prompt eval time (ms)
  - `t_gen`: generation time (ms)
  - `t_total`: total time (ms)
  - `avg_ts`: average tokens/second (generation speed)
  - `stddev_ts`: stddev of tokens/second
- **Raw output** — collapsible `<pre>` showing `llama-bench` stdout/stderr (uses existing `.terminal` CSS class)
- **Progress text** — during run, shows "Running iteration X/Y..." parsed from stderr

### 6. Frontend: Update tab switching

**File:** `ui/js/app.js`

- Update `switchTab()` (line 1530) to add:
  ```javascript
  if (tabId === "benchmark") refreshBenchmarkUI();
  ```

- Add `initBenchmark()` function:
  - Binds Run button → `runBenchmark()`
  - Binds Stop button → `stopBenchmark()`
  - Binds parameter change events → `updateBenchmarkPreview()`
  - Called from `DOMContentLoaded` (line 1474)

- Add `runBenchmark()` function:
  - Reads model path from `document.getElementById("model-select").value`
  - Reads benchmark params from the UI controls
  - Sends `POST /api/benchmark/run` with `{model_path, params}`
  - Starts polling `GET /api/benchmark/status` every 1.5 seconds
  - Updates UI (status, output, results table) on each poll
  - Stops polling when status is not `"running"`

- Add `stopBenchmark()` function:
  - Sends `POST /api/benchmark/stop`
  - Polling handles the UI update

- Add `refreshBenchmarkUI()` function:
  - Reads current model from `#model-select` and displays it
  - Updates command preview from current param values

- Add `updateBenchmarkPreview()` function:
  - Builds the `llama-bench` command string from current UI values
  - Updates the command preview element

- Add `renderBenchmarkResults(results)` function:
  - Takes the JSON array from the status response
  - Renders an HTML table with columns matching the `llama-bench -o json` output fields
  - Formats numbers (ms values, tokens/sec) for readability
  - Handles empty results (shows "No results yet" placeholder)

- Add `renderBenchmarkOutput(output)` function:
  - Renders raw output lines into the collapsible pre element
  - Auto-scrolls to bottom during a run

### 7. Frontend: Model path from Configure

The benchmark tab does NOT maintain its own model dropdown. Instead:
- It reads `document.getElementById("model-select").value` when Run is clicked
- It displays the currently selected model name as static text in the benchmark header
- If no model is selected, the Run button is disabled with a tooltip "Select a model in Configure first"
- This avoids a third synced dropdown and follows the simplest path

### 8. Frontend: CSS for benchmark results

**File:** `ui/css/style.css`

Add styles for:
- `.benchmark-results-table` — a styled HTML table using the existing design tokens (`--bg-surface`, `--border-strong`, `--mono`, etc.)
- `.benchmark-status` — status badge (idle/running/completed/error) reusing the pattern from `.tunnel-status`
- `.benchmark-params` — grid layout for parameter controls (reuse `.quick-grid` or `.flag-row` pattern)
- `.benchmark-command-preview` — reuse existing `.command-preview` styles

## Files to modify/create

| File | Action | What |
|------|--------|------|
| `backend/state.py` | **Modify** | Add `default_benchmark_state()`, `benchmark_lock`, `benchmark_process` fields to `ServerState` |
| `backend/services/benchmark.py` | **New** | `run_benchmark()`, `stop_benchmark()`, `get_benchmark_status()`, `build_benchmark_args()` |
| `backend/routes/benchmark.py` | **New** | `start_benchmark()`, `get_status()`, `stop_benchmark()` |
| `backend/app.py` | **Modify** | Import benchmark routes, register 3 endpoints in `API_ROUTER` |
| `ui/index.html` | **Modify** | Add benchmark nav button in sidebar, add `section-benchmark` panel after Configure |
| `ui/js/app.js` | **Modify** | Add `initBenchmark()`, `runBenchmark()`, `stopBenchmark()`, `refreshBenchmarkUI()`, `updateBenchmarkPreview()`, `renderBenchmarkResults()`, `renderBenchmarkOutput()`. Update `switchTab()`. Add to `DOMContentLoaded`. |
| `ui/css/style.css` | **Modify** | Add `.benchmark-results-table`, `.benchmark-status`, `.benchmark-params` styles |

## What stays the same

- `backend/services/process_manager.py` is **not modified** — the benchmark service imports `_build_process_env` from it but manages its own process lifecycle
- `LLAMA_TOOLS` in `backend/app.py` is **not modified** — `llama-bench` is already listed
- `find_tool_executable` is **not modified** — it already resolves the binary
- The existing process launch/stop flow is **not modified**

## No changes to:

- `ui/js/flags.js` — benchmark uses its own simplified controls, not the flag system
- `ui/js/manager.js` — benchmark doesn't need GitHub release fetching
- `ui/js/presets.js` — benchmark doesn't use the preset system

## Risk assessment

**Overall: Low-to-moderate risk.** All changes are additive — no existing functions are modified, only new files and new code appended. If anything breaks, it's entirely self-contained in the new benchmark files. The existing app is untouched.

### Low risk

- All backend patterns (background thread + polling, `AtomicDict` state, route/service split) are copied directly from existing modules (`install.py`, `hf_download.py`, `tunnel.py`)
- `llama-bench` is already in `LLAMA_TOOLS` and binary discovery just works
- Frontend follows the same tab initialization pattern as all other tabs
- No changes to `flags.js`, `presets.js`, `manager.js`, or `process_manager.py`
- Daemon threads die automatically on server shutdown — no leak risk

### Moderate risk

- **Second process management path** — the benchmark spawns its own `subprocess.Popen` rather than reusing `launch_process`. This means a second process lifecycle, but it's isolated in its own service and uses the same env/lock patterns. Mitigated by the service layer separation.
- **`llama-bench` could fail or hang** on certain models/platforms. Mitigated by the stop mechanism (`CTRL_BREAK_EVENT`/`terminate()` with 5s timeout then `kill()`), matching `process_manager.stop_process` exactly.
- **Process conflict race condition** — rapid start/stop of benchmark vs `llama-server` could theoretically pass the `is_process_running` check concurrently. Mitigated by `benchmark_lock` which serializes start/stop operations.
- **`llama-bench -o json` output format could differ** across `llama.cpp` versions — fields may be added, removed, or renamed. The results parser should handle missing/extra fields gracefully rather than crashing.

### Not a risk

- **GPU resource conflicts** — prevented by checking `is_process_running()` before starting. The user gets a clear error if `llama-server` is running.
- **Server shutdown mid-benchmark** — daemon threads are killed automatically. No orphaned processes.

## Implementation order

1. **State** (`backend/state.py`) — add benchmark state fields to `ServerState`
2. **Service** (`backend/services/benchmark.py`) — background thread logic, arg building, process management
3. **Route** (`backend/routes/benchmark.py`) — HTTP handlers for run/status/stop
4. **Register routes** (`backend/app.py`) — import and wire up the 3 endpoints
5. **Frontend HTML** (`ui/index.html`) — add nav button and section panel
6. **Frontend JS** (`ui/js/app.js`) — add all benchmark functions, wire up `switchTab` and `DOMContentLoaded`
7. **CSS** (`ui/css/style.css`) — add benchmark table and status styles
8. **Test** — run backend, navigate to benchmark tab, select a model, run a benchmark, verify results table and raw output display correctly, verify stop works, verify conflict detection when `llama-server` is running
