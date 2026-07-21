# Llama.cpp Router Mode Implementation Plan

**Status:** Planned  
**Created:** 2026-07-21  
**Primary use case:** Launch a llama.cpp model router from Llama GUI for use by the Pi coding agent, while preserving the existing single-model workflow.

## Background

`llama-server` enters router mode when it is launched without a target model argument such as `-m`, `--model`, or `-hf`. The router exposes one HTTP endpoint, discovers multiple GGUF models, and starts or stops child model-server processes on demand.

The router can discover models from:

1. llama.cpp's model cache.
2. A directory supplied with `--models-dir`.
3. An INI preset supplied with `--models-preset`.

Requests are routed by the `model` value in POST request bodies or the `model` query parameter on model-specific GET endpoints. Router management uses `/models`, `/models/load`, `/models/unload`, and `/models/sse`.

Pi's native llama.cpp integration requires this mode. Pi connects directly to the router, uses `/llama` to load or unload models, and uses `/model` to select a loaded model. A normal Llama GUI single-model launch is not compatible because it always supplies a target model.

Upstream references:

- [llama.cpp: Using multiple models](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#using-multiple-models)
- [Pi: llama.cpp](https://pi.dev/docs/latest/llama-cpp)
- [llama.cpp security policy](https://github.com/ggml-org/llama.cpp/blob/master/SECURITY.md)

## Current Constraints

The backend process launcher can already start `llama-server` without a model. The current blockers are frontend and state assumptions:

- `flag-core.js` appends `-m models/<selected model>` whenever a model is selected.
- Manual and Quick Launch readiness reject any launch without a model source.
- Router flags are not present in `FLAGS`.
- Configure and Quick Launch have no shared single-model/router mode control.
- Presets have no server-mode field.
- The native picker supports files but not directories.
- Active runtime metadata assumes a single model or alias.
- Chat, API examples, metrics, and slots do not track a router model ID.
- The two-slot Model Switcher is designed to stop and replace whole single-model server processes.
- The HF downloader's multimodal layout does not match router mode's expected model-plus-mmproj subdirectory layout.

Custom Launch Args are not a safe workaround. With no selected model, the frontend blocks launch. With a selected model, the generated `-m` switches llama.cpp back to single-model mode.

## Goals

- Add an explicit `Single Model` / `Model Router` choice for `llama-server`.
- Keep the mode synchronized between Configure, Quick Launch, presets, command preview, and runtime status.
- Generate a valid model-less router command.
- Provide a Pi-oriented starter profile that works with the repository's `models/` directory.
- Preserve all existing single-model behavior and preset compatibility.
- Reuse the existing host, port, API-key, process lifecycle, output, and health-check paths.
- Add native router discovery and load/unload management in a later phase without making it a prerequisite for Pi.

## Non-Goals for the Initial Release

- Replacing Pi's `/llama` model manager.
- Automatically converting all existing single-model presets into router INI presets.
- Keeping an arbitrary number of models resident without explicit resource limits.
- Making router mode safe for untrusted or multi-tenant networks.
- Supporting router mode for `llama-cli`, `llama-bench`, or `llama-perplexity`.
- Treating router mode as a replacement for the existing two-slot process switcher.

## Core Design Decisions

### First-Class Shared Mode State

Add `serverMode` to `flag-core.js` with exactly two normalized values:

- `single` (default)
- `router`

Do not infer router mode from an empty model selection or from the presence of `--models-dir`. An explicit value keeps accidental empty selections invalid in single-model mode and gives every mirrored control a single source of truth.

Expose shared getters and setters following the existing tool/model pattern:

- `getServerMode()`
- `setServerModeValue(mode)` for state restoration without callbacks
- `setServerMode(mode)` for user-facing changes and synchronized refresh

Switching to router mode should not erase the selected single model. The model controls should become disabled while the router is selected, and the retained selection should become active again if the user switches back to single mode.

### Preset Schema

Extend full presets with an optional top-level field:

```json
{
  "tool": "llama-server",
  "server_mode": "router",
  "model": "",
  "flags": {
    "models_dir": "models",
    "models_max": 1,
    "models_autoload": false,
    "jinja": true
  }
}
```

Compatibility rules:

- Missing `server_mode` normalizes to `single`.
- `router` is valid only with `tool: "llama-server"`.
- Existing presets retain their current behavior.
- Router presets may have an empty `model` field.
- Unknown server-mode values are rejected during import.
- Sensitive Custom Launch Args rules remain unchanged.

### Router Flag Definitions

Add these upstream flags to `ui/js/flags/definitions.js`:

| ID | CLI | Type | Initial default | Notes |
|---|---|---|---|---|
| `models_dir` | `--models-dir` | directory path | `models` | Llama GUI's normal model directory |
| `models_preset` | `--models-preset` | file path | unset | Advanced per-model INI configuration |
| `models_max` | `--models-max` | int | `1` | Consumer-safe initial limit; `0` means unlimited upstream |
| `models_autoload` | `--models-autoload` / `--no-models-autoload` | bool | `false` | Pi manages loading explicitly |

Mark these definitions with a new `router_only: true` property. `flag-core` must omit router-only flags unless the tool is `llama-server` and `serverMode === "router"`.

Keep `--jinja` as the existing shared server flag because it also applies to single-model mode. The Pi Quick Launch profile will enable it; changing modes alone should not silently overwrite a user's existing Jinja choice.

### Launch Argument Rules

Single-model mode retains the current behavior.

Router mode must:

1. Emit eligible shared server/model-instance flags.
2. Emit router-only flags.
3. Parse Custom Launch Args.
4. Reject target-model flags in Custom Launch Args.
5. Omit the selected model's generated `-m` argument.

Target-model conflicts include at least:

- `-m`, `--model`
- `-hf`, `-hfr`, `--hf-repo`
- `-mu`, `--model-url`
- `-dr`, `--docker-repo`

Draft/speculative model flags are not target-model conflicts, but their router behavior must be verified before they are advertised as supported globally. Per-model router presets are the preferred place for draft model configuration.

Single-model mode should reject router-only flags supplied through Custom Launch Args and direct users to select Model Router. This avoids commands whose visible mode disagrees with their actual llama.cpp behavior.

### Runtime Metadata

Derive server mode in the backend from the launched command:

- A `llama-server` command with a target-model source is `single`.
- A `llama-server` command without one is `router`.

Add `server_mode` to `active_runtime`. Do not depend only on pending frontend state because status must remain authoritative after reload or reconnection.

For a router runtime, `active_runtime.model` and `alias` may remain null until a later phase adds a selected router model. Status labels should say `Model router` rather than `Unknown model`.

## Recommended Pi Quick Profile

Add a `Pi / Coding Agent Router` Quick Launch profile:

```text
tool: llama-server
server mode: router
models directory: models
models max: 1
models autoload: off
Jinja: on
host: 127.0.0.1
port: 8080
GPU layers: all or the existing Auto value
context: 32768
```

Expected command shape:

```text
llama-server --models-dir models --models-max 1 --no-models-autoload --jinja --host 127.0.0.1 --port 8080 -ngl all -c 32768
```

The exact argument order follows the existing `FLAGS` order. The profile must use shared setters and definitions; it must not maintain its own router option list or state.

After launch, Pi setup is:

```text
/login llama.cpp
```

Use `http://127.0.0.1:8080` and enter the same API key if Llama GUI configured one. Then use `/llama` to load a model and `/model` to select it.

## Phase 0: Upstream and Baseline Verification

### Work

- Install or select a current llama.cpp build through Llama GUI.
- Confirm `llama-server --help` advertises:
  - `--models-dir`
  - `--models-preset`
  - `--models-max`
  - `--models-autoload` and `--no-models-autoload`
- Launch a router manually outside the GUI and verify:
  - `GET /health`
  - `GET /models`
  - `POST /models/load`
  - `POST /models/unload`
  - `GET /models/sse`
  - Auth behavior with `--api-key`
- Record the tested llama.cpp build in the implementation PR and update `docs/llama_cpp_compat_report.md` if the normal compatibility audit is rerun.
- Confirm current Pi setup against its official documentation and record the tested Pi version.

### Acceptance Criteria

- A current installed binary demonstrably supports all required router flags and endpoints.
- One text-only GGUF in `models/` can be discovered, loaded, queried, and unloaded.
- The router `/health` response is compatible with the existing lifecycle readiness probe.
- No source code behavior changes occur in this phase.

## Phase 1: Pi-Compatible Router Launcher (MVP)

This phase is sufficient for the original feature request. Pi connects directly to `llama-server` and manages models itself.

### Shared State and Arguments

- Add normalized `serverMode` state and its shared setter/getter API to `flag-core.js`.
- Extend `buildLaunchArgs()` input and output behavior for router mode.
- Add router-only flag filtering.
- Add target-model conflict detection for Custom Launch Args.
- Add a helper such as `isRouterLaunchArgs()` or `hasRouterModelSourceArg()` only if it is used by multiple consumers; do not duplicate token parsing.
- Preserve selected model state while omitting `-m` in router mode.

### Configure and Quick Launch UI

- Add matching `Single Model` / `Model Router` controls to Configure and Quick Launch.
- Route both controls through the same `flagCore.setServerMode()` setter.
- Disable, but do not clear, model selectors in router mode.
- Change readiness from `Model: none` to `Router: ready` when the explicit router state is valid.
- Add short explanatory text: models are loaded through Pi or the router API, not by selecting one in the normal model dropdown.
- Add the Pi router Quick Launch profile.
- Display a persistent experimental/local-only warning when router mode is selected.
- Warn more strongly when the host is wildcard/LAN-bound; recommend an API key.

### File and Directory Picking

- Add a directory-selection variant to `backend/services/file_picker.py` for `models_dir`.
- Support directory selection on Windows/Linux through tkinter and on macOS through AppleScript.
- Keep `models_preset` on the normal file-selection path with an INI-oriented filter.
- Preserve typed paths when the native picker is unavailable.

### Presets and Lifecycle

- Normalize, validate, save, load, import, and export `server_mode`.
- Ensure router presets do not require `model`.
- Add `server_mode` to backend active runtime metadata and frontend reconciliation.
- Keep process start, stop, output polling, auth snapshots, endpoint previews, and `/health` readiness on the existing lifecycle path.
- Prevent router presets from appearing in the two-slot Model Switcher, or label them unsupported and make them unselectable.
- Treat memory estimation as unavailable for the router process and explain that memory depends on the model loaded later.

### Feature Gating for the MVP

Until Phase 2 supplies a selected router model:

- Do not present Llama GUI Chat as ready for a router runtime.
- Do not start model-specific metrics/slot polling.
- Keep the API endpoint address and copy controls available.
- Direct users to Pi's `/llama` and `/model`, the upstream Web UI, or direct router API calls.

This avoids sending placeholder or stale single-model IDs and avoids noisy metrics errors.

### Likely Files

- `ui/js/flag-core.js`
- `ui/js/flags/definitions.js`
- `ui/js/config-flags-ui.js`
- `ui/js/quick-launch-ui.js`
- `ui/js/app-data.js`
- `ui/js/app.js`
- `ui/js/presets.js`
- `ui/js/model-switch-ui.js`
- `ui/js/chat-ui.js`
- `ui/js/api-tab.js`
- `ui/index.html`
- `ui/css/style.css`
- `backend/services/file_picker.py`
- `backend/routes/file_picker.py`
- `backend/services/process_manager.py`
- Relevant frontend and backend tests

### Acceptance Criteria

- Both mode controls always reflect the same shared value.
- Switching either control immediately updates the other and the command preview.
- Single-model commands are byte-for-byte equivalent to current output for unchanged state.
- Router commands contain no target-model argument.
- Router-only flags never leak into single-model or `llama-cli` commands.
- Target-model Custom Launch Args block router launch with a clear inline error.
- Router readiness permits launch without a selected model.
- A saved router preset round-trips through save, reload, export, and import.
- Existing presets without `server_mode` load as single-model presets.
- Reloading the browser while a router is running restores authoritative router status.
- Pi can connect using `/login llama.cpp`, list router models, load one, and complete a tool-calling coding-agent request.
- Existing single-model, CLI, benchmarking, Chat, API-key, and Model Switcher tests remain green.

## Phase 2: Native Router Discovery and Model Management

This phase makes Llama GUI a router client in addition to a router launcher.

### Backend Router Client

- Add a focused service for authenticated calls to the active local router.
- Add management routes for:
  - Listing and refreshing models.
  - Loading a model.
  - Unloading a model.
  - Relaying model status/download progress events.
- Always derive the host, port, and authorization from the authoritative active runtime and launch-time auth snapshot.
- Reuse local-host validation; never accept an arbitrary upstream URL from the browser.
- Validate request body shape, model ID length, and control characters.
- Serialize load/unload state changes with a dedicated lock if concurrent operations can conflict.
- Log real upstream failures to stderr and return sanitized errors when tunnel exposure requires it.
- Bound response sizes and timeouts. Ensure cancelled SSE clients release upstream connections.

Suggested Llama GUI endpoints:

```text
GET  /api/llama/models
POST /api/llama/models/load
POST /api/llama/models/unload
GET  /api/llama/models/events
```

Do not overload the existing `/api/models`, which lists local top-level GGUF files for the single-model dropdown.

### Shared Router Model State

- Add one shared selected router model ID owned by a focused module or `flagCore`.
- Populate all router model selectors from the same `/api/llama/models` response.
- Do not derive router IDs from local filenames; use the IDs returned by the router.
- Refresh state after every load/unload event and after reconnect.
- Distinguish `unloaded`, `downloading`, `loading`, `loaded`, `sleeping`, and failed states.

### UI

- Add a router model panel to Quick Launch or API rather than mixing loaded/unloaded router entries into the single-model file selector.
- Show status, load/unload actions, and progress.
- Disable conflicting actions while a request is in flight.
- Require confirmation before unloading a model that is selected by Llama GUI Chat.
- Treat router state as shared with other clients; refresh before destructive actions and do not assume Llama GUI owns loaded models.

### Chat, API, and Metrics

- Send the selected router model ID in Chat request bodies.
- Update API snippets to use that same model ID.
- Add the URL-encoded model query to router `/metrics`, `/slots`, and other model-specific GET calls.
- Reset stats baselines when the selected router model changes.
- Insert the existing model-transition divider when Chat changes between router models.
- Do not change the launch configuration when selecting a runtime router model.

### Acceptance Criteria

- Llama GUI lists the same router models and statuses as `GET /models`.
- Load and unload operations update without a page refresh.
- Progress survives normal polling/render cycles and cancellation closes cleanly.
- Chat requests use exactly the selected router model ID.
- Metrics and slots are fetched for the selected model and stop cleanly when none is selected.
- A model loaded or unloaded by Pi is reflected in Llama GUI after refresh/events.
- API-key-protected routers work without exposing the key in browser-visible status or commands.
- Single-model behavior and `/api/models` remain unchanged.

## Phase 3: Model Storage, Downloads, and Per-Model Presets

### Router-Compatible Local Layout

- Document the supported directory layout:
  - Single-file text models may live directly in `models/`.
  - Multimodal model plus mmproj files must share a dedicated subdirectory.
  - Multi-shard models must share a dedicated subdirectory.
- Update the HF downloader so a router-targeted multimodal download places the main model and mmproj together.
- Add multi-shard discovery/download only as a separately tested change; do not infer a complete shard set from one filename without repository metadata.
- Preserve existing paths or migrate only with explicit user confirmation. Never silently move user model files.

### Model Preset INI Support

- Initially support selecting an existing `--models-preset` file.
- Later consider a validated editor/generator for:
  - Global `[*]` defaults.
  - Per-model context, GPU, cache, template, and speculative settings.
  - `load-on-startup` and `stop-timeout`.
- Prefer absolute generated paths across platforms.
- Do not assume every normal Llama GUI flag is valid in a router preset; verify router-controlled and child-instance behavior upstream.
- Keep raw INI import/export available so advanced upstream options are not lost.

### Acceptance Criteria

- Router-targeted text, multimodal, and supported multi-shard downloads produce the upstream-documented layout.
- Existing single-model downloads retain their current behavior.
- No model file is moved, overwritten, or deleted without confirmation.
- Generated INI files start successfully on Windows, macOS, and Linux.
- Per-model settings override global settings according to upstream precedence.

## Phase 4: Hardening, Documentation, and Release Validation

### Security and UX

- Clearly label router mode experimental.
- Keep loopback as the default host.
- Require an explicit acknowledgment before wildcard/LAN binding without an API key.
- Do not advertise the existing Cloudflare GUI tunnel as a safe way to expose the router.
- Explain that loaded models share host/GPU resources and that `models_max = 0` is unlimited.
- Explain that changing global inherited flags requires restarting the router.

### Documentation

- Update `README.md` with a short router/Pi quick start.
- Update `docs/directory.md` with state, flags, routes, modules, and data flow.
- Update `docs/tests.md` with focused router test commands.
- Update `docs/llama_cpp_compat_report.md` when the upstream audit is rerun.
- Add troubleshooting for no models, load failure/OOM, old llama.cpp builds, API keys, incorrect multimodal layout, and stale directory contents requiring router restart/refresh.

### Cross-Platform and Integration Matrix

Verify at least:

| Area | Windows | macOS | Linux |
|---|---:|---:|---:|
| Directory picker | Required | Required | Required |
| Relative `models/` path | Required | Required | Required |
| Router launch/stop | Required | Required | Required |
| API-key auth | Required | Required | Required |
| Pi discovery/load/chat | Required | Recommended | Required |
| NVIDIA/AMD/Metal-specific loading | As available | Metal | As available |

### Acceptance Criteria

- User-facing documentation matches the shipped behavior.
- A clean install can launch a Pi-compatible router without Custom Launch Args.
- Unsupported/old binaries fail with an actionable message rather than a generic process exit.
- No API key appears in command previews, status payloads, logs returned to the browser, presets, or exports.
- Router mode is not enabled by default for existing users.

## Test Plan

### Frontend Unit Tests

Add or extend coverage for:

- `serverMode` normalization and setters.
- Single/router launch argument generation.
- Router-only flag filtering.
- Model omission in router mode.
- Custom target-model conflict errors.
- Preset normalization, migration, import, export, and application.
- Quick profile application.
- Model Switcher filtering.
- Router runtime labels and feature gating.
- Router model response/status normalization in Phase 2.

Likely focused commands:

```text
node tests/frontend/launch_args_unit.cjs
node tests/frontend/flag_definitions_unit.cjs
node tests/frontend/presets_unit.cjs
node tests/frontend/model_switch_ui_unit.cjs
node tests/frontend/api_tab_unit.cjs
```

Run `node --check` on every touched JavaScript file. If Custom Launch Args parsing itself changes, also run:

```text
node tests/frontend/custom_launch_args_unit.cjs
```

### Frontend Smoke Tests

Extend the Playwright smoke suite to verify:

- Configure and Quick Launch mode synchronization in both directions.
- Model controls disable/restore without losing selected state.
- Command preview removes/restores `-m` when changing modes.
- Router settings alter the preview through shared state.
- Invalid Custom Launch Args block every launch button consistently.
- Router presets restore after reload.
- Single-model controls and launch behavior remain unchanged.

Run:

```text
npm run test:frontend
```

### Backend Tests

Add coverage for:

- Directory picker option routing and cancellation.
- Active runtime mode derivation.
- Router proxy target restrictions and authentication.
- Model ID validation and upstream errors.
- Load/unload concurrency and SSE cleanup in Phase 2.
- Router model query propagation for metrics/slots.

Run:

```text
python -m unittest discover tests -v
```

### Manual End-to-End Checks

1. Launch a normal single model and verify Chat, metrics, presets, and Model Switcher.
2. Stop it and select the Pi router profile.
3. Verify the preview contains no target-model argument.
4. Launch and confirm `/health` and `/models` respond.
5. Configure Pi with `/login llama.cpp`.
6. Load a model through `/llama`.
7. Select it through `/model`.
8. Complete a coding request that invokes at least one tool.
9. Unload the model and verify the router process remains running.
10. Restart Llama GUI and verify router runtime reconciliation.
11. Repeat with an API key.
12. Verify stopping Llama GUI's managed process terminates router child instances.

## Risks and Mitigations

### Upstream Experimental Behavior

Router endpoints and status payloads may change. Keep router response parsing isolated, tolerate unknown fields/statuses, and verify against an installed build rather than assuming the compatibility report's older snapshot.

### Resource Exhaustion

Multiple loaded models can exhaust RAM/VRAM. Use a starter default of one model, show current loaded states, and make unlimited mode explicit.

### Shared Ownership

Pi or another client can change router state at any time. Treat router responses as authoritative and refresh before load/unload decisions.

### Ambiguous Model Names

Local filenames, aliases, HF cache IDs, and preset names are not interchangeable. Always route with the exact ID returned by `/models`.

### Feature Regression

Router mode touches launch readiness, presets, lifecycle reconciliation, Chat, metrics, and mirrored controls. Keep Phase 1 focused, preserve single-mode defaults, and add bidirectional sync coverage before native management work.

### Model Layout

Existing multimodal downloads split model and mmproj storage. Do not claim router compatibility for those downloads until Phase 3 changes and tests the layout.

## Definition of Done

The feature is complete when:

- A user can select Model Router in either Configure or Quick Launch.
- The other control and command preview update immediately from shared state.
- Llama GUI launches and monitors a model-less `llama-server` router.
- Pi can authenticate, discover, load, select, and use a GGUF model through that router.
- Router presets are portable and backward-compatible with existing presets.
- Llama GUI can optionally discover and manage router models itself without conflicting with Pi.
- Chat, API examples, metrics, and slots use one shared authoritative router model ID.
- Model downloads use router-compatible layouts where advertised.
- Security warnings, documentation, focused tests, full frontend smoke tests, and backend tests are complete.

