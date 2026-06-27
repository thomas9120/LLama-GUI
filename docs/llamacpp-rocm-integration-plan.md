# llamacpp-rocm Optional Backend Integration Plan

## Goal

Add [`lemonade-sdk/llamacpp-rocm`](https://github.com/lemonade-sdk/llamacpp-rocm) as an optional installable backend alongside official `ggml-org/llama.cpp` releases, reusing Llama GUI's existing Install tab, download progress, config, and process launch flow.

## Current Llama GUI Shape

- Official `llama.cpp` releases are fetched from `https://api.github.com/repos/ggml-org/llama.cpp/releases`.
- Backend options come from `build_backend_specs()` in `backend/services/llama_manager.py`.
- `/api/releases` currently returns releases for the single configured GitHub API.
- `/api/install` receives `{ tag, backend }`, downloads the matching asset, extracts it into `llama/bin` and `llama/grammars`, then saves `config.json` with `{ version, backend, tag }`.
- Launching is generic: `process_manager` runs `llama-server`, `llama-cli`, and other tools from `llama/bin`. A correctly installed `llamacpp-rocm` package should not need a separate launcher.

## Upstream Findings

- Repo: `https://github.com/lemonade-sdk/llamacpp-rocm`
- Publishes nightly/prebuilt ROCm 7 `llama.cpp` archives for Windows and Ubuntu.
- Latest checked release during investigation: `b1294`.
- Asset names follow patterns like:
  - `llama-b1294-windows-rocm-gfx103X-x64.zip`
  - `llama-b1294-windows-rocm-gfx110X-x64.zip`
  - `llama-b1294-windows-rocm-gfx1150-x64.zip`
  - `llama-b1294-windows-rocm-gfx1151-x64.zip`
  - `llama-b1294-windows-rocm-gfx120X-x64.zip`
  - `llama-b1294-windows-rocm-gfx908-x64.zip`
  - `llama-b1294-windows-rocm-gfx90a-x64.zip`
  - Equivalent `ubuntu-rocm` variants.
- Users must choose a GPU target, not just "ROCm".
- Supported targets listed upstream include `gfx1151`, `gfx1150`, `gfx120X`, `gfx110X`, `gfx103X`, `gfx90a`, and `gfx908`.
- Archives include normal `llama.cpp` executables plus bundled ROCm runtime files.
- Important: archives include nested runtime directories such as `hipblaslt/` and `rocblas/`. Llama GUI's current flat extraction would break these packages.

## Recommended Design

### 1. Extend Backend Specs With Provider Metadata

Add fields to backend specs such as:

- `label`
- `provider` or `source`, for example `official` or `lemonade-rocm`
- `repo_api`, for example `https://api.github.com/repos/lemonade-sdk/llamacpp-rocm/releases`
- `asset` pattern
- `preserve_paths` boolean
- Optional `gpu_target` metadata

Example backend IDs:

- `lemonade-rocm-gfx103X`
- `lemonade-rocm-gfx110X`
- `lemonade-rocm-gfx1150`
- `lemonade-rocm-gfx1151`
- `lemonade-rocm-gfx120X`
- `lemonade-rocm-gfx90a`
- `lemonade-rocm-gfx908`

Labels should be user-facing, for example:

- `ROCm 7 gfx110X (AMD RDNA3, Lemonade)`
- `ROCm 7 gfx103X (AMD RDNA2, Lemonade)`
- `ROCm 7 gfx1150 (Ryzen AI 300, Lemonade)`

### 2. Make Release Fetching Backend-Aware

Change release fetching so `/api/releases` can accept a `backend` query parameter or a `provider` query parameter.

The backend route should resolve the selected backend spec, then use that spec's `repo_api`. Keep default behavior unchanged for official backends.

`ui/js/manager.js` should refetch release options when backend selection changes, because official `llama.cpp` tags and Lemonade tags are independent.

### 3. Make Install And Update Provider-Aware

Install should still accept `{ tag, backend }`, but `llama_manager.install_release()` should fetch release data from the selected backend spec's `repo_api` instead of using `ctx.config.github_api` unconditionally.

Update should use the installed backend's provider. Backward-compatible config should keep `{ version, backend, tag }` and may add provider/source metadata.

### 4. Add Safe Path-Preserving Extraction

Keep the current flat extraction mode for official `llama.cpp` releases.

Add a `preserve_paths` mode for Lemonade ROCm archives:

- Preserve nested directories under `llama/bin`.
- Reject absolute paths and path traversal entries.
- Route `.gbnf` grammar files to `llama/grammars` only when they are known grammar assets.
- Leave provider archive layout intact when uncertain.
- Do not flatten `hipblaslt/` or `rocblas/`; those layouts are runtime data.

### 5. Launch Environment

The existing `process_manager._build_process_env()` already prepends `llama/bin` to `PATH` and `LD_LIBRARY_PATH` on Linux. Keep that behavior.

Consider provider-specific runtime environment handling only if smoke tests prove it is needed. Potential additions:

- `ROCBLAS_TENSILE_LIBPATH` pointing at `llama/bin/rocblas/library`
- `HIPBLASLT_TENSILE_LIBPATH` or equivalent only if upstream runtime requires it

Do not guess too much here. First preserve archive paths and test with:

- `llama-cli --version`
- `llama-cli --help`
- `llama-cli --list-devices`

### 6. UI Behavior

Keep this in the existing Install tab.

- Backend dropdown lists official and Lemonade ROCm options available for the host platform/arch.
- Add a short hint near the dropdown: ROCm builds require choosing the target matching your AMD GPU architecture.
- When a Lemonade backend is selected, the release dropdown should show Lemonade release tags.
- Status display can continue showing backend ID initially, but nicer labels would be better.

## Tests

### Backend Tests

- `build_backend_specs()` includes Lemonade ROCm choices on `win32` x64 and Linux x64 only.
- Release fetch uses the selected backend `repo_api`.
- Install uses the selected backend `repo_api`.
- Preserve-path extraction keeps nested `hipblaslt/` and `rocblas/` files.
- Preserve-path extraction blocks traversal entries.
- Official extraction still uses flat mode.
- Update uses the installed backend provider.

### Frontend Tests

- Backend selection rerenders the release list or triggers release refetch.
- Backend options include readable Lemonade ROCm labels from `/api/status`.
- Install payload remains `{ tag, backend }`.

### Manual Smoke Tests

- Install a Lemonade Windows ROCm target archive, ideally the user's actual GPU target.
- Confirm `llama/bin` contains:
  - `llama-server.exe`
  - `llama-cli.exe`
  - `hipblaslt/`
  - `rocblas/`
- Run `llama-cli.exe --version`.
- Run `llama-cli.exe --help`.
- Run `llama-cli.exe --list-devices` if supported.
- Launch `llama-server` from Llama GUI with `-ngl 99` and a known GGUF model.
- Verify `/metrics`, `/slots`, and the Chat tab still work.

## Potential Pitfalls

- Flat extraction will break Lemonade packages by destroying nested ROCm runtime directory layout.
- Official `llama.cpp` and Lemonade release tags are independent; one global release dropdown is misleading unless it refetches by backend/provider.
- Asset names use GPU target names, so users may choose the wrong target. The UI needs labels/help text.
- Upstream README badges currently mention `aigdat/llamacpp-rocm` in places, while the requested repo is `lemonade-sdk/llamacpp-rocm`. Use the requested repo API unless intentionally changed.
- Lemonade builds are nightly/cutting-edge, so flags may drift from the official `llama.cpp` release expected by Llama GUI.
- SHA256 metadata may be absent from GitHub API asset objects. The existing installer warns and skips verification when absent, but this should be explicitly accepted or improved.
- Downloads are large. Ubuntu archives can be hundreds of MB, up to around 800 MB in the checked release. Progress and cancellation should remain responsive.
- Runtime may require environment variables beyond `PATH` and `LD_LIBRARY_PATH`. Preserve paths first, then add env vars based on observed failures.
- Windows AMD driver/runtime behavior may vary. The package bundles ROCm runtime, but GPU driver compatibility still matters.
- Status currently validates Windows/Linux installs mostly by executable presence. That may say installed even if the wrong GPU target was selected.
- Update/repair must preserve provider metadata, or Repair Install may try to fetch a Lemonade backend from official `llama.cpp` releases and fail.
- Config migration must tolerate old `config.json` files without provider/source.
- Avoid adding per-tab state for backend/release selection; keep Install tab state routed through existing manager/status APIs.

## Suggested Implementation Order

1. Add provider-aware backend spec schema and Lemonade ROCm specs.
2. Add backend/provider-aware release fetch helpers with tests.
3. Add preserve-path extraction helper with traversal tests.
4. Wire install/update to use backend spec `repo_api` and extraction mode.
5. Update status payload labels if needed.
6. Update `manager.js` to refetch releases when backend changes.
7. Run backend unit tests and frontend smoke tests.
8. Do a manual install/probe of one Lemonade ROCm archive.

Keep changes focused. Do not add a separate launch path unless testing proves the normal `llama/bin` process launch cannot support the ROCm package.
