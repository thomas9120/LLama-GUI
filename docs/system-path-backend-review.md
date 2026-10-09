# PR #401: System (PATH) backend review

Reviewed on 2026-10-09.

- PR: [#401 — T3/system path backend](https://github.com/thomas9120/LLama-GUI/pull/401)
- Request: [#399 — use system PATH llama-server](https://github.com/thomas9120/LLama-GUI/issues/399)
- Branch: `t3/system-path-backend-stage-one`
- Reviewed head: `9aabd14d7fb4b5f9bf5cba3eca95b84f9f769ecb`
- Reviewed base: `25a5619ad6f8a5880a23f554592c655f84805396` (`main`)
- Decision: the maintainer intends to shelve the PR and revisit it if demand changes.
- Findings below remain unfixed. This document records the review, not an implementation plan already in progress.

## What the change does

The PR adds a System (PATH) backend for externally installed llama.cpp tools. It adds discovery, activation, per-tool compatibility checks, and frontend controls while leaving installation and updates to the user's package manager.

The review assumed normal single-user desktop use, including multiple browser tabs. It traced the changed production code and its connected consumers, including discovery, activation, status, launch validation, environment construction, switching, cleanup, argument generation, and frontend readiness.

## Must fix

All four findings are P2: functional bugs affecting supported configurations. Numbering matches the review delivered in the conversation.

### 1. Benchmark compatibility checks never receive build tags

Location: [backend/services/llama_manager.py, lines 754–768 at the reviewed commit](https://github.com/thomas9120/LLama-GUI/blob/9aabd14d7fb4b5f9bf5cba3eca95b84f9f769ecb/backend/services/llama_manager.py#L754-L768).

**What this is:** Benchmark argument generation uses the detected build of each executable to translate legacy memory-loading flags into `--load-mode` on b10875 and newer.

**Problem:** `GET /api/status` calls runtime validation without an explicit tool list, which defaults to `llama-cli` and `llama-server`. The returned `runtime_health.build_tags` therefore omits `llama-bench` and `llama-perplexity`. Separate on-demand probes use separate cache entries; their tags do not appear in subsequent default status responses. `manager-status.js` feeds only that status map into flag-core, so the benchmark gates never receive the required tags.

**Concrete reproduction and evidence:**

- A complete System toolset reporting build 11000 produced status tags only for CLI/server. The benchmark entry was available but had `build_tag: null` and `probe_ok: null`.
- Probing bench/perplexity separately and then fetching status still returned only CLI/server tags.
- Feeding that actual backend payload into the production frontend builder emitted `-mmp 1` for throughput with legacy mmap enabled, and `--no-mmap` for perplexity with mmap disabled.
- Supplying the missing benchmark tags changed those arguments to `--load-mode mmap` and `--load-mode none`, respectively.
- Real Windows PATH activation against the existing b11096 binaries succeeded, but status again omitted both benchmark tags. Model-free parser checks against those real binaries rejected `-mmp 1` and `--no-mmap` with exit code 1.

**Smallest fix direction:** Make benchmark/perplexity build tags available to the frontend before their arguments are generated. Preserve caching and per-tool compatibility; do not substitute the server's tag for independently discovered tools.

**Regression check needed:** Feed a real status response from a complete System fixture into the benchmark builder and assert the correct flags for old, new, and mixed builds. The current frontend test injects benchmark tags directly, bypassing the missing backend-to-frontend connection.

**If skipped:** Benchmarks using these settings fail on newer System installations.

### 2. A broken optional CLI blocks a healthy server

Location: [backend/services/llama_manager.py, lines 349–358 at the reviewed commit](https://github.com/thomas9120/LLama-GUI/blob/9aabd14d7fb4b5f9bf5cba3eca95b84f9f769ecb/backend/services/llama_manager.py#L349-L358).

**What this is:** System activation and installation readiness should require only `llama-server`; other tools are independent features.

**Problem:** `_validate_system_runtime_dependencies()` sets aggregate `ok` to false when any requested tool fails its execution probe. Default status probes CLI and server, and `get_status()` uses that aggregate health to calculate `installed`. A present but broken CLI therefore invalidates a healthy server installation.

**Concrete reproduction and evidence:** With a server whose version probe exits 0 and a CLI whose probe exits 1:

```text
System activation:      ok = true
Status:                 installed = false, config_stale = true
Server error:           null
Server launch preflight: ok = true
CLI status:             available = true, probe_ok = false
```

Quick Launch checks `installed` first and disables server launch with an installation prompt. The stale System view also falls back to a missing-server warning although the server is present and healthy.

**Smallest fix direction:** Base System installation readiness on the required server probe. Preserve optional probe failures as per-tool information rather than allowing them to invalidate the entire installation.

**Regression check needed:** A working server plus a failing optional CLI must leave System installed and server launch enabled, while accurately reporting the CLI failure.

**If skipped:** An unrelated CLI failure prevents normal server use.

### 3. Device discovery can describe the wrong executable

Location: [backend/services/process_manager.py, lines 577–587 at the reviewed commit](https://github.com/thomas9120/LLama-GUI/blob/9aabd14d7fb4b5f9bf5cba3eca95b84f9f769ecb/backend/services/process_manager.py#L577-L587).

**What this is:** Configure discovers valid tensor-buffer destinations for the MoE expert helper through `GET /api/llama/buffer-types`.

**Problem:** The System branch always prefers a discovered CLI and uses the server only when CLI is absent. Independently installed tools can have different accelerator capabilities. The endpoint does not identify the tool being configured, and the frontend keeps one buffer-discovery promise.

**Concrete reproduction and evidence:** A fixture with a CUDA-capable CLI and CPU-only server returned:

```text
buffers = [CPU, CUDA0]
default = CUDA0
```

Both discovery commands targeted the CLI; the server was never queried. In server Configure, choosing `CUDA0` and applying the MoE helper generates a tensor override the CPU-only server cannot accept. The reverse layout hides GPU destinations supported by the server.

**Smallest fix direction:** Probe the tool being configured and keep cached discovery results separate by tool. Account for tool changes in the frontend instead of reusing one permanent result.

**Regression check needed:** Mixed CPU/GPU CLI/server fixtures must return the selected tool's buffer types and update the helper when the selected tool changes.

**If skipped:** Mixed System builds offer unsupported destinations or hide available GPU destinations.

### 4. System setup displays paths from the active backend

Location: [backend/routes/status.py, lines 61–74 at the reviewed commit](https://github.com/thomas9120/LLama-GUI/blob/9aabd14d7fb4b5f9bf5cba3eca95b84f9f769ecb/backend/routes/status.py#L61-L74).

**What this is:** The System setup panel previews PATH discoveries before activation, while the current backend remains active.

**Problem:** `system_tools` is populated using `services.find_tool_executable()` and the active backend's `exes` map. That resolver follows the configured backend. While an official or Custom backend is active, the System preview therefore describes that installation instead of PATH.

**Concrete reproduction and evidence:** With CPU active, official files under `llama/bin`, and separate System files on PATH, the reported System server path was the official `llama/bin/llama-server`. Direct System resolution correctly returned the separate PATH entry. With no matching PATH entry, the preview can still show an application-managed path before System activation fails.

**Smallest fix direction:** Populate System preview paths and availability through `resolve_system_tool_executable()`, independently of active-backend executable checks.

**Regression check needed:** Test the pre-activation System preview while official and Custom backends are active, both with and without PATH tools. Keep the active backend's normal executable status unchanged.

**If skipped:** Setup can show tools as present even when System activation cannot find them.

## Validation performed

The following passed against the reviewed head:

- Backend: `python -m unittest discover tests -v` using the project's venv — 914 tests run, 7 skipped.
- Frontend: `npm test`, including the unit suites and all 49 browser scenarios.
- Syntax: `node --check` on all 11 changed JS/CJS files.
- Real-binary compatibility: `llama_flags_supported_unit.cjs --require-binaries` checked 169 GUI flags against the existing b11096 CLI/server binaries and passed, with the documented fork-only and upstream-removed flag exemptions.
- Native Windows, model-free System activation and status against b11096 in an isolated application context with temporary configuration.

The worktree did not contain its own venv or `node_modules`. Tests reused the main project checkout's venv; frontend dependencies were resolved through `NODE_PATH` pointing to that checkout's `node_modules`. System Python was not used for backend tests.

The initial `npm test` run skipped optional real-binary compatibility because this worktree had no local binaries. That check was subsequently run explicitly against the main checkout's existing binaries:

```powershell
$env:LLAMA_GUI_LLAMA_BIN_DIR = '<existing-b11096-bin-directory>'
node tests/frontend/llama_flags_supported_unit.cjs --require-binaries
```

The functional findings were reproduced through existing isolated fixture helpers and production functions. The benchmark flag rejection was additionally confirmed with real binaries using these model-free parser checks:

```text
llama-bench -mmp 1 --help          -> exit 1
llama-perplexity --no-mmap --help  -> exit 1, invalid argument: --no-mmap
```

No implementation fixes or tracked-file changes were made during the review. Temporary reproduction outputs are not needed to understand or resume these findings.

## Not checked

- Real model loading, Chat, GPU execution, and process stop/restart through System.
- Native NixOS packages/wrappers and package/profile replacement with a loaded model.
- Native macOS package-manager or desktop-launcher behavior.

Fixtures establish the tested control flow, not full native package-manager/GPU compatibility.

## Maintenance and scope discussion

The maintainer decided to defer fixes and shelve the PR after discussing its ongoing maintenance cost. This is a scope decision, separate from the four confirmed bugs above.

The PR adds 4,080 lines across 30 files. Approximately 2,450 added lines are tests and 450 are documentation; production code grows by 1,075 net lines across 15 files. The lasting burden comes from independently versioned tools and accelerator capabilities, launcher/environment differences that are hard to reproduce, and System-specific rules spread across shared workflows.

The feature adds no runtime dependency, package installation machinery, or separate process lifecycle. The assessment was a meaningful, moderate maintenance burden, with occasional compatibility and support work expected. Actual adoption and future support volume are unknown.

If the feature is revisited, decide its scope before fixing or expanding this implementation. One possible smaller first release is System server launch with Chat, API, and Monitor, leaving Terminal, Benchmarking, and memory estimation unsupported initially. That would reduce the supported combinations, but still needs reliable discovery and native validation. The issue requester reports an existing Custom symlink workaround, so deferring native support does not leave them without their current approach.

## Resuming the work

1. Confirm the target branch/head and compare it with the reviewed commit; source links above are pinned to the exact reviewed code.
2. Reconsider the supported scope and whether demand justifies the ongoing maintenance cost.
3. Reproduce the applicable findings and add regression checks at the backend/frontend boundaries before applying fixes.
4. Run the repository's current required checks and record native validation separately from fixture coverage.

Review verdict for the implementation as submitted: **fix findings 1–4 before shipping**.
