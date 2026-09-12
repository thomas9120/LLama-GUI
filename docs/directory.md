# Llama GUI — Project Reference

> **Companion to `AGENTS.md`.** This file is the reference manual for the codebase: architecture, data flow, feature details, and API contracts. `AGENTS.md` contains agent workflow rules, pitfalls, and task recipes.

> **New here?** For clone-to-green-tests setup, start with [`CONTRIBUTING.md`](../CONTRIBUTING.md).
> To learn the codebase, read in this order:
>
> 1. [`AGENTS.md`](../AGENTS.md) — the rulebook: ownership, pitfalls, and the change-type → required-test table
> 2. This file's [Architecture](#architecture) and [Frontend](#frontend) sections
> 3. [`docs/tests.md`](tests.md) — [Common Commands](tests.md#common-commands)
>
> Everything else in this file is reference material, read on demand.

---

## Architecture

- **Backend:** Python stdlib `http.server` (no framework). Serves static `ui/` and provides JSON/SSE API endpoints.
- **Frontend:** Vanilla HTML/CSS/JS loaded as ordered global `<script>` tags (no bundler, no ES modules). Each module attaches to `window.LlamaGui`.
- **Entry point:** `python server.py` → 26-line compat wrapper → delegates to `backend/app.py`.
- **GUI server:** `127.0.0.1:5240` by default; `LLAMA_GUI_HOST` and `LLAMA_GUI_PORT` can override the bind address for headless/LAN access.
- **llama-server:** Runs separately (default port 8080) as a subprocess.
- **Dependencies:** `certifi` (SSL cert bundle), `ddgs` (DuckDuckGo web search), `huggingface_hub` (HF model downloads), `hf-xet` (Xet-accelerated HF transfers).
- **State persistence:** `config.json` (installed version, active backend, tag).
- **Thread safety:** All stateful operations (process, download, tunnel, install) use threading locks.
- **Request bodies:** JSON only via `read_body()` — capped at 10 MB (`MAX_REQUEST_BODY_SIZE`, HTTP 413), `Transfer-Encoding` refused (501), read timeouts answered with 408.
- **Live updates:** No WebSocket — one SSE stream (chat completions) plus polling loops that reconcile against authoritative server state; the `runtime_generation` carried by `/api/output` responses lets stale tabs discard superseded output.

### Companion Repositories

- **Pinokio launcher:** `https://github.com/thomas9120/llama-gui-pinokio`
- Clones this repo into its `app/` directory, installs `requirements.txt`, starts `python server.py`, and may apply launcher-specific patches.
- For large changes to startup/shutdown behavior, `server.py`, backend lifecycle routes, static asset loading, dependency installation, ports, cache busting, or frontend script loading, check the Pinokio launcher for compatibility.
- Frontend-only internal refactors (e.g., changes inside `ui/js/flag-core.js` or `ui/js/config-flags-ui.js`) are usually compatible as long as `ui/index.html` script loading and the `python server.py` entrypoint still work.

---

## Top-Level Directory Map

| Dir / File | Role |
|---|---|
| `server.py` | Thin compatibility entrypoint — delegates to `backend.app` |
| `backend/` | Python package: HTTP server, routes, services, state |
| `ui/` | Static frontend: `index.html`, `js/`, `css/`, `templates/` |
| `ui/js/flags/` | Ordered pure-data modules for flag definitions |
| `ui/templates/` | 14 bundled Jinja chat template files |
| `tests/` | Frontend (Node/Playwright) + backend (unittest) tests |
| `.github/workflows/` | Continuous integration and the manual stable-release workflow |
| `docs/` | Documentation — cataloged in the [Documentation Index](#documentation-index) at the end of this file |
| `llama/` | Downloaded `llama.cpp` binaries; empty in a fresh clone |
| `models/` | User model files (.gguf), in any subfolder; downloaded projectors live beside their models |
| `presets/` | Saved launcher preset JSON files |
| `tools/` | Auto-downloaded `cloudflared` binary — runtime-created, absent until a tunnel is first used |
| `scripts/` | Windows shortcut helper (`create_windows_shortcuts.ps1`) and Linux/macOS launcher helper (`create_unix_shortcuts.py`, called by `install.sh`) |
| `install.sh`, `windows_install.bat` | One-command installers: create the venv, install dependencies, add shortcuts |
| `windows_start.bat`, `windows_startsilent.bat`, `mac_linux_start.sh`, `mac_linux_silent_start.sh` | User-facing launchers (silent variants hide the console window) |
| `online_installers/` | Remote one-command installers behind the README Quick Start (`install-online.ps1` / `install-online.sh`) |
| `Linux_compile_toolkit/` | `build_llama_cpp_cuda.sh`: builds a portable CUDA `llama.cpp` tarball from source (see `description.md`) |
| `.launcher/` | Pinokio launcher integration (`launch-llama-gui.ps1`) |
| `assets/` | App icon in Windows `.ico`, Linux `.png`, and macOS `.icns` formats (PNG/ICNS reuse the ICO's embedded 256px artwork) |
| `requirements.txt` | Python runtime dependencies (annotated list in [Architecture](#architecture)) |
| `package.json` | Playwright devDependency + test scripts |
| `ruff.toml` | Ruff lint policy (py39 floor; deliberate ignores documented inline) |
| `release.ps1`, `release.bat` | Local release-packaging helpers — build a versioned release zip (`.bat` wraps `.ps1`) |
| `stash-updates.bat` | One-shot `git stash -u` helper: stash local changes before an app update |

---

## Backend

### Core Modules

| Module | Role |
|--------|------|
| `backend/app.py` | HTTP handler, CORS, proxy, route registry, main() |
| `backend/config.py` | Path constants, env var parsing, web search limits; deliberately free of optional third-party imports so startup diagnostics work on a minimal Python environment |
| `backend/context.py` | `AppContext`, `AppPaths`, `ServerConfig`, `BackendServices` dataclasses |
| `backend/state.py` | `ServerState` dataclass, `AtomicDict` (lock-protected dict) |
| `backend/http.py` | `Request`/`Response`/`SseWriter`, CORS validation, `sanitize_error()` |
| `backend/routing.py` | `Router` class: exact + prefix route matching |

### Backend Capabilities

- Downloads `llama.cpp` releases from GitHub with SHA256 verification.
- Validates packaged runtime libraries with `otool` on macOS and `ldd` on Linux before launch, while preserving the local runtime-library search path.
- Runs `llama-server`, `llama-cli`, `llama-bench`, or `llama-perplexity` as a subprocess and streams stdout/stderr.
- Downloads the official WikiText-2 raw test file for Benchmarking clean perplexity runs.
- Handles preset, model file, and Hugging Face download APIs.
- Selects binary based on platform (`win32`/`darwin`/`linux`) and backend type (e.g., `cuda-12.4`, `cuda-13.3`, `vulkan`, `hip`, `sycl`, `openvino`, `metal`).
- Proxies OpenAI-compatible chat completions (`/v1/chat/completions`) to `llama-server` with streaming SSE support.
- Built-in web search via DuckDuckGo (`ddgs` + page fetching with HTML-to-text parsing), with an optional self-hosted SearXNG backend (`LLAMA_GUI_SEARXNG_URL`) that is preferred when set and falls back to `ddgs`.
- Cloudflare tunnel management (auto-downloads `cloudflared`, starts/stops tunnel, returns public URL).
- Git-based app auto-updating (checks status, pulls, reinstalls dependencies, restarts server).
- Native file/directory pickers (tkinter on Windows/Linux, `osascript` on macOS) for selecting model files, paths, and the active model root.
- CORS origin validation restricts API access to loopback origins for the configured GUI port, trusted `LLAMA_GUI_ALLOWED_HOSTS` entries when wildcard-bound, and the active tunnel URL.
- Graceful shutdown/restart with port availability polling.

### Route Modules (`backend/routes/`)

`API_ROUTER` at the bottom of `backend/app.py` is the authoritative registry: 48 exact routes plus one prefix route, 49 endpoints total. Keep this table in sync with it — a route that is registered but undocumented here is the drift that is hardest to notice.

| Route | Endpoints |
|-------|-----------|
| `chat.py` | `POST /api/chat/completions` — SSE proxy with web search and final context check; `POST /api/chat/context` — context preview before web-search injection |
| `external_server.py` | `GET /api/chat/target` (read the live and remembered target), `POST /api/chat/target` (register an externally started llama-server as the proxy target; `POST {"restore": true}` re-registers the address saved by an earlier session), `DELETE /api/chat/target` (clear it) |
| `benchmarks.py` | `POST /api/benchmark/wikitext2` — ensure WikiText-2 raw test file exists |
| `process.py` | `POST /api/launch`, `POST /api/launch/preflight`, `POST /api/presets/fingerprint`, `POST /api/estimate-memory`, generation-bound `POST /api/stop`, `POST /api/send-input`, `POST /api/cleanup-llama`, `GET /api/output`, `GET /api/llama/health`, `GET /api/llama/buffer-types` |
| `install.py` | `GET /api/releases`, `GET /api/download-progress`, `POST /api/install`, `POST /api/update`, `POST /api/activate-custom` (optional `backend`: `custom` or `custom-02`; omitted defaults to `custom`) |
| `metrics.py` | `GET /api/llama/metrics`, `GET /api/llama/slots`, `GET /api/llama/props` — Prometheus proxy and template-capability props |
| `models.py` | `GET /api/models` — list GGUF files recursively as names relative to the active model root |
| `model_dir.py` | `POST /api/models-dir` — set or reset the active model root |
| `presets.py` | `GET /api/presets`, `POST /api/presets` (save), `POST /api/presets/rename`, `POST /api/presets/archive` (bulk archive/restore), `POST /api/presets/shortcut` (Windows shortcut export), `DELETE /api/presets/<name>` (prefix route) |
| `hf_download.py` | `POST /api/hf/repo-files`, `POST /api/hf/download`, `POST /api/hf/download-cancel`, `GET /api/hf/download-status` |
| `tunnel.py` | `POST /api/remote-tunnel/start`, `POST /api/remote-tunnel/stop`, `GET /api/remote-tunnel/status` |
| `git_update.py` | `GET /api/app-update-status`, `POST /api/app-update` |
| `search.py` | `POST /api/web-search` |
| `status.py` | `GET /api/status` |
| `system_stats.py` | `GET /api/system-stats` — read-only CPU/RAM/disk + GPU telemetry for the Monitor tab (`?refresh=1` bypasses the short-lived cache) |
| `lifecycle.py` | `POST /api/shutdown`, `POST /api/restart`, `POST /api/open-folder` |
| `file_picker.py` | `POST /api/select-file` — native file dialog, `POST /api/select-folder` — native directory dialog |

Note that `/api/presets/fingerprint` and `/api/estimate-memory` live in `process.py`, not `presets.py` or a memory module — both answer questions about the *running or prospective process*, not about stored preset files.

### Service Modules (`backend/services/`)

| Service | Role |
|---------|------|
| `llama_manager.py` | GitHub release fetch, install, SHA256 verify, binary extraction |
| `process_manager.py` | Process launch/stop, output streaming, arg flattening, API target parsing |
| `hf_download.py` | HF repo listing, file download with cancel, path validation |
| `model_dir.py` | Active model-root validation, metadata, and merged atomic config persistence |
| `web_search.py` | DuckDuckGo (`ddgs`) and optional SearXNG search, HTML-to-text, page fetching |
| `tunnel.py` | Cloudflare tunnel lifecycle, binary download, status polling |
| `git_update.py` | Git fetch/pull/status, safe dirty path classification |
| `lifecycle.py` | Server shutdown, restart, cleanup |
| `chat.py` | Chat proxy helpers (search queries, context building, local addresses) |
| `chat_context.py` | Running-server context capacity, native input-token counting with text template/tokenizer fallback, output reserve and overflow checks |
| `external_server.py` | Registration of an externally started llama-server, llama.cpp-aware health probing, remembered-address persistence and unattended restore, and the shared chat/metrics target + authorization resolver |
| `local_llama_http.py` | Shared local llama-server metrics, slots, and props HTTP fetching |
| `system_stats.py` | Monitor telemetry: stdlib/ctypes CPU/RAM/disk collectors, optional local all-smi API/CLI adapter with nvidia-smi/amd-smi fallbacks, coalesced sample cache |
| `file_picker.py` | Native file and directory dialogs |

### State Pattern

- `ServerState` dataclass in `backend/state.py` — all mutable server state.
- `AtomicDict` — lock-protected dict with `update()`, `replace()`, `snapshot()`.
- `AppContext` in `backend/context.py` — frozen `AppPaths`, `ServerConfig`, mutable `ServerState`, `BackendServices`.
- `DEFAULT_CONTEXT` singleton used by all routes via `ctx` parameter.
- Services are injected into `ctx.services` by `configure_services()`.

### API Router

Routes use a declarative dispatch table. Routes receive `(request, response, ctx)` — `Request`/`Response` wrappers from `http.py`.

---

## Frontend

### Script Loading Order

The frontend loads scripts in a strict dependency order via `ui/index.html`:

1. `ui/js/flags/*.js` — ordered pure data modules for categories, options, chat templates, definitions, and helpers
2. `theme-ui.js` — theme registry, persisted selection, and the sidebar theme menu (`window.LlamaGui.themeUi`)
3. `flag-core.js` — shared state singleton (`window.LlamaGui.flagCore`)
4. `chat-tools.js` — browser date/time preference, tool execution, and saved tool exchanges (`window.LlamaGui.chatTools`)
5. `config-flags-ui.js` — Configure tab rendering
6. `manager.js` — GitHub releases, install, update, shared `fetchJson()`
7. `presets/*` package, loaded in order: `presets-internal.js` (state, configure, sensitive-arg scrubbing, fetch/normalize), `presets-apply.js` (apply/compare, context bar), `presets-models.js` (model matching/warnings), `presets-local.js` (favorites, last-used, sort modes), `presets-library.js` (grouping, search text, flag labels, icons), `presets-detail.js` (summary, detail/bulk panels, entry rendering), `presets-roving.js` (roving focus), `presets-groups.js` (list rendering, status toasts, `loadPresets`), `presets-crud.js` (save/load/rename/delete/export/import), `presets-main.js` (`window.LlamaGui.presets` assembly)
8. `searchable-select.js` — searchable combobox wrapper for native selects (`window.LlamaGui.searchableSelect`)
9. `model-switch-ui.js` — versioned two-slot preset-reference storage and Model Switcher namespace (`window.LlamaGui.modelSwitchUi`)
10. `app-data.js` — shared Quick Launch, context, sampler, and chat slider data
11. `output-cursor.js` — shared process-output cursor consumer (`window.LlamaGui.outputCursor`)
12. `process-lifecycle.js` — guarded launch, stop, switch, restore, and health-readiness orchestration (`window.LlamaGui.processLifecycle`)
13. `sampler-presets.js` — sampler preset storage, import/export, apply behavior, and Configure controls (`window.LlamaGui.samplerPresets`)
14. `chat-rendering.js` — markdown and low-level chat DOM rendering helpers (`window.LlamaGui.chatRendering`)
15. `api-tab.js` — API endpoint/snippet rendering helpers (`window.LlamaGui.apiTab`)
16. `hf-download-ui.js` — Quick Launch Hugging Face downloader UI (`window.LlamaGui.hfDownloadUi`)
17. `remote-tunnel-ui.js` — API tab Cloudflare tunnel UI (`window.LlamaGui.remoteTunnelUi`)
18. `external-server-ui.js` — API tab controls for connecting to an externally started llama-server (`window.LlamaGui.externalServerUi`)
19. `quick-launch-ui.js` — Quick Launch controls and shared-state UI sync (`window.LlamaGui.quickLaunchUi`)
20. `chat-compaction.js` — reversible working-context summaries, chunk budgeting, and summary stream validation (`window.LlamaGui.chatCompaction`)
21. `character-cards.js` — local JSON/PNG character-card decoding and prompt construction (`window.LlamaGui.characterCards`)
22. `chat/*` package, loaded in order: `chat-internal.js` (shared state, constants, storage helpers, `configure()`), `chat-workspace.js` (ownership, transfer snapshots), `chat-sidebar.js` (sidebar controls, samplers, status badge), `chat-request.js` (request building), `chat-context.js` (compaction controls, context preview), `chat-stream.js` (send/stream, edit, undo), `chat-history.js` (conversation persistence, history), `chat-main.js` (`init()` and the `window.LlamaGui.chatUi` assembly)
23. `chat-window.js` — verified Chat window, ownership/recovery coordination, and dedicated display bootstrap (`window.LlamaGui.chatWindow`)
24. `benchmark-ui.js` — Benchmarking tab controls, argument adapter, output polling, and session-only summaries (`window.LlamaGui.benchmarkUi`)
25. `monitor-ui.js` — Monitor tab system/GPU polling, process-output terminal, shared inference snapshot engine and rendering, card visibility preferences (`window.LlamaGui.monitorUi`)
26. `shell-ui.js` — grouped navigation, responsive navigation drawer, and the shared sidebar runtime summary (`window.LlamaGui.shellUi`)
27. `app.js` — main orchestration (wires everything together)

**Do not change this order.** Each file depends on the ones above it. If you add a new module, place it after its dependencies and before its consumers. A copy-paste walkthrough with the `configure()`-injection skeleton lives in [`CONTRIBUTING.md`](../CONTRIBUTING.md#adding-a-new-frontend-module).

`flag-core.js` exposes its API via `window.LlamaGui.flagCore`. Other modules access shared state through this namespace, not by importing or referencing private closure variables.

### Frontend Module Reference

| Module | Namespace | Role |
|--------|-----------|------|
| `ui/js/flags/definitions.js` | (data) | `FLAGS` array — single source of truth for all exposed `llama.cpp` flags |
| `ui/js/flags/categories.js` | (data) | `FLAG_CATEGORIES` array |
| `ui/js/flags/options.js` | (data) | Shared enum option lists (`CACHE_TYPE_OPTIONS`, etc.) |
| `ui/js/flags/chat-templates.js` | (data) | `BUILTIN_CHAT_TEMPLATES`, `CHAT_TEMPLATE_PRESETS`, preset helpers |
| `ui/js/flags/helpers.js` | (data) | `getFlagsForTool()`, `getFlagsByCategory()`, speculative helpers |
| `ui/js/theme-ui.js` | `window.LlamaGui.themeUi` | `THEMES` registry (the single source of truth for shipped themes), preference persistence, root theme attribute application, color-scheme hints, and the sidebar theme menu — rendered from the registry, with roving arrow-key focus |
| `ui/js/flag-core.js` | `window.LlamaGui.flagCore` | Shared frontend flag state and launch-argument core. Owns `currentTool`, selected model, `flagValues`, shared setters, custom launch args parsing, preset apply/collect helpers, `getLaunchArgs()`, and command preview generation |
| `ui/js/chat-tools.js` | `window.LlamaGui.chatTools` | Opt-in browser date/time tool preference, schema, bounded streamed-call assembly, local execution, and tool-exchange request/display helpers |
| `ui/js/config-flags-ui.js` | `window.LlamaGui.configFlagsUi` | Configure tab flag rendering, search/filtering, expand/collapse state, type-specific flag input builders, input restoration, and high-risk `multi_enum` warnings |
| `ui/js/manager.js` | `window.LlamaGui.manager` | GitHub release fetching, backend selection, installation progress UI, app update (git status/pull/restart), the shared `fetchJson()` utility, accepted-status observer wiring for runtime reconciliation, and the shared known-model-name cache (`getKnownModelNames()`) populated by `refreshModels()` |
| `ui/js/presets/presets-internal.js` | script globals (private) | Package foundation, loaded before its siblings: module state, `configure()`, sensitive-argument scrubbing (`--api-key`/`--hf-token`), preset API fetch helpers, normalization, and import-name validation. Declarations stay top-level script globals exactly like the former single file |
| `ui/js/presets/presets-apply.js` | script globals (private) | Preset apply/compare flow, saved-settings change rows, loaded-preset reconciliation, and the saved-settings context bar |
| `ui/js/presets/presets-models.js` | script globals (private) | Model-name matching, known-model presence checks, and missing-model warnings |
| `ui/js/presets/presets-local.js` | script globals (private) | Storage-backed favorites, last-used timestamps, sort/favorites modes, local renames/deletes, and duplicate-name generation |
| `ui/js/presets/presets-library.js` | script globals (private) | Group-by-model keying, search text, flag-label cache, icons, preset buttons, and shared render helpers |
| `ui/js/presets/presets-detail.js` | script globals (private) | Library summary, health message, detail panel, bulk/archive controls, selection state, and per-entry row rendering |
| `ui/js/presets/presets-roving.js` | script globals (private) | Roving arrow-key focus across group headers and rows |
| `ui/js/presets/presets-groups.js` | script globals (private) | Group/list rendering, status toasts, model-presence refresh, `loadPresets`, and library control wiring |
| `ui/js/presets/presets-crud.js` | script globals (private) | Save, update, duplicate, rename, load, delete, archive, favorite, export, and import operations |
| `ui/js/presets/presets-main.js` | `window.LlamaGui.presets` | Public `presets` namespace assembly; loaded last in the package |
| `ui/js/searchable-select.js` | `window.LlamaGui.searchableSelect` | Searchable combobox wrapper that visually replaces a native `<select>` (button + popup with search) while keeping the select in the DOM as the source of truth for options, value, and change events |
| `ui/js/model-switch-ui.js` | `window.LlamaGui.modelSwitchUi` | Versioned two-slot saved-preset references, strict storage normalization, duplicate detection, session-only fallback, accessible Quick Launch card state/rendering, and the drag-to-confirm sidebar shortcut wired through injected preset/runtime dependencies |
| `ui/js/app-data.js` | (data) | `QUICK_PROFILES`, `BUILTIN_SAMPLER_PRESETS`, `CHAT_SAMPLER_SLIDER_MAP` |
| `ui/js/output-cursor.js` | `window.LlamaGui.outputCursor` | Shared monotonic cursor consumer for main and benchmark process-output polling; `invalidate()` advances the epoch while preserving the cursor so clearing the terminal does not replay the backlog |
| `ui/js/process-lifecycle.js` | `window.LlamaGui.processLifecycle` | Race-resistant launch, stop, switch, restore, authoritative-status reconciliation, generation-keyed readiness, and one-shot prolonged-load diagnostics with injectable UI hooks |
| `ui/js/sampler-presets.js` | `window.LlamaGui.samplerPresets` | Sampler preset storage, normalization, apply behavior, import/export, and Configure-tab controls; writes sampler values through injected `flagCore` |
| `ui/js/chat-rendering.js` | `window.LlamaGui.chatRendering` | Markdown and low-level chat DOM rendering helpers |
| `ui/js/api-tab.js` | `window.LlamaGui.apiTab` | API tab endpoint/snippet data, base URL and authorization helpers, and rendering; reads shared state through injected `flagCore` |
| `ui/js/hf-download-ui.js` | `window.LlamaGui.hfDownloadUi` | Quick Launch Hugging Face downloader controls, status rendering, progress polling, cancel handling, and completion flow; receives shared utilities and `flagCore` from `app.js` |
| `ui/js/remote-tunnel-ui.js` | `window.LlamaGui.remoteTunnelUi` | API tab Cloudflare tunnel controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling; receives shared utilities and endpoint helpers from `app.js` |
| `ui/js/external-server-ui.js` | `window.LlamaGui.externalServerUi` | API tab controls for registering a llama-server started outside this GUI: connect/disconnect actions, target rendering, and the status refresh that unlocks Chat; receives `fetchJson` and status helpers from `app.js` |
| `ui/js/quick-launch-ui.js` | `window.LlamaGui.quickLaunchUi` | Quick Launch profile, context, GPU, template, sampler, metrics, command preview mirror, action buttons, and event wiring; reads and writes launch state through injected `flagCore` |
| `ui/js/chat-compaction.js` | `window.LlamaGui.chatCompaction` | Manual summary generation with counted chunks, selected context, and preserved recent turns |
| `ui/js/character-cards.js` | `window.LlamaGui.characterCards` | Bounded local JSON/PNG character-card parsing, field validation, basic name macros, and conversion to an editable prompt and greeting |
| `ui/js/chat/chat-internal.js` | `window.LlamaGui._chatInternal` (private) | Chat package foundation, loaded before its siblings: the shared state object (`I.state`), package constants (`I.consts`), tolerant localStorage helpers, and `configure()` |
| `ui/js/chat/chat-workspace.js` | `window.LlamaGui._chatInternal` (private) | Chat workspace ownership epochs, transfer snapshot capture/validate/restore, and sampler value plumbing |
| `ui/js/chat/chat-sidebar.js` | `window.LlamaGui._chatInternal` (private) | Chat sidebar rendering, sampler inputs, web-search and thinking-effort controls, status badge, template-capability hint, focus mode, and panel layout |
| `ui/js/chat/chat-request.js` | `window.LlamaGui._chatInternal` (private) | Chat request construction: thinking params, message shaping, delta text, and body assembly |
| `ui/js/chat/chat-context.js` | `window.LlamaGui._chatInternal` (private) | Chat compaction controls, chat tools menu, context budget preview, and pre-send auto-compaction |
| `ui/js/chat/chat-stream.js` | `window.LlamaGui._chatInternal` (private) | Chat send/stream pipeline, scroll handling, edit flow, assistant rendering, and undo/regenerate |
| `ui/js/chat/chat-history.js` | `window.LlamaGui._chatInternal` (private) | Chat conversation persistence, history list rendering, clearChat, and character-card import |
| `ui/js/chat/chat-main.js` | `window.LlamaGui.chatUi` | Chat `init()`, the public `chatUi` namespace assembly, and test-only hooks; loaded last in the package. The package reads and writes launch-relevant sampler state through the `flagCore` injected via `configure()` |
| `ui/js/chat-window.js` | `window.LlamaGui.chatWindow` | Dedicated Chat display, verified main/popup bridge, exclusive workspace ownership, handoff, and recovery checkpoints |
| `ui/js/benchmark-ui.js` | `window.LlamaGui.benchmarkUi` | Benchmarking tab source selection, benchmark-specific controls, compatible argument building for `llama-bench`/`llama-perplexity`, readiness/status badges, process actions, output polling, and session-only summaries |
| `ui/js/monitor-ui.js` | `window.LlamaGui.monitorUi` | Monitor tab: system-stats polling with visibility gating and truthful status badge, process-output terminal (always-follow output, trim, cursor-preserving clear), dynamically reconciled GPU cards in the shared metrics grid, setup/state rendering with backend-supplied platform guidance, hidden-card preferences with tolerant persistence, and the target-keyed inference snapshot engine (`createInferenceStats`) shared by the fixed stats bar and the Inference card |
| `ui/js/app.js` | `window.LlamaGui` (global) | Main UI orchestration. Manages tab switching, server launch/stop, output polling, the single inference poll cycle that feeds one shared snapshot to the fixed bar and Monitor, shared template helpers, toasts, module initialization, and cache-busting reload |
| `ui/css/style.css` | — | Shared page headings/action bars, controls, surfaces, and responsive layout. Contains no color literals and no `[data-theme=…]` selectors — all color lives in `ui/css/tokens.css` |
| `ui/js/shell-ui.js` | `window.LlamaGui.shellUi` | Workspace/maintenance navigation, current-page semantics, mobile drawer focus and dismissal, and the shared sidebar summary of the authoritative local runtime or registered external server |
| `ui/css/tokens.css` | — | Design tokens. One `:root` block of structural tokens (radius, spacing, control heights, fonts, easing) followed by one block per theme holding that theme's entire palette. Adding a theme is this file plus one `THEMES` entry in `ui/js/theme-ui.js` — nothing else |
| `ui/templates/` | — | Bundled Jinja chat template files for Kobold-style presets |

---

## Tabs

1. **Quick Launch**: First navigation entry and default page. One-click model launch with preset configuration, quick profiles, integrated HF model downloader.
2. **Configure** (Tune): Full CLI flag configuration for `llama-server`/`llama-cli` with readable names beside CLI switches, aligned controls, search, keyboard-operable categories/submenus, optional detailed help, command preview, and Custom Launch Args.
3. **Monitor** (Tune): Live process output, CPU/RAM usage, disk read/write activity, per-GPU NVIDIA/AMD telemetry with evidence-gated setup guidance, and an optional Inference card fed by the shared llama-server snapshot.
4. **Benchmarking** (Tune): Run `llama-bench` throughput tests and `llama-perplexity` checks from current Configure state, saved presets, or a manual model.
5. **Chat** (Interact): Streaming OpenAI-compatible chat interface with web search, conversation history, sampler sliders.
6. **API** (Interact): View and interact with the `llama.cpp` API endpoints, connect to a llama-server started outside this GUI, start/stop Cloudflare tunnel.
7. **Presets** (Library): Browse, search, and manage saved launch configurations grouped by model, with favorites, warnings, bulk actions, duplicate/rename, and a library summary. See [Presets Tab](#presets-tab).
8. **Install & Update** (lower maintenance area): Download and install `llama.cpp` releases, select backend, update app from git.

The sidebar runtime disclosure shows lifecycle state and active model, with launch-time build/endpoint details and a Monitor shortcut (API for external servers). Launch/stop actions reuse Quick Launch's shared readiness and lifecycle wiring. Memory estimates are labeled **Next launch**; the installed build lives with maintenance. **Quit Llama GUI** is separate from stopping the local process. Short viewports scroll the sidebar; the mobile drawer supports Close, Escape, backdrop dismissal, focus containment, and an inert hidden sidebar.

---

### Secondary-screen presentation

- Inference speeds in Monitor and the fixed bar show explicitly labeled live rates from `/slots` samples of the same active tasks. Prompt rates use `n_prompt_tokens_processed` (excluding cached tokens) only while both samples have zero generated tokens. They average progress since the first observed nonzero prompt count, include intervening unchanged polls in elapsed time, and retain the last rate between batches; two distinct nonzero counts are needed for the first reading. This is an observed average, not the server's full-request processing-time average. Generation rates use adjacent `next_token.n_decoded` samples after generation has started. Missing samples, target/task changes, counter rollback, resets, and gaps over 15 seconds break live sampling. Without a live rate, session averages divide token deltas by matching cumulative processing-time deltas from `/metrics` (`prompt_seconds_total` and `tokens_predicted_seconds_total`), excluding idle wall time. Restored targets and manual resets establish paired token/time baselines; a token or time counter rollback rebases the affected average. Missing counters or zero elapsed processing time display `--`; rolling gauges are not substituted for session averages.

- Monitor's active-runtime summary reads lifecycle identity and `flagCore.compareLaunchSettings()`, with Open Configure and focused launch-change review. System telemetry is explicitly scoped to this machine and kept separate from inference activity. Vendor probe setup/state cards sit in a native disclosure with Recheck; hardware/inference card visibility and order preferences remain intact. Inference availability notes distinguish loading, non-server tools, and independently unavailable metrics/slots. Empty idle output is hidden, while retained logs are labeled **Last run output**. Changing an inference target invalidates the previous polling epoch before setting the new baseline, including external reconnects to the same address.

- Chat opens Conversations and Settings from its header. The Chat package stores explicit choices under `llama_gui_chat_history_collapsed` and `llama_gui_chat_settings_collapsed`; absent preferences default to collapsed. At wide widths, expanded panels participate in the normal layout beside Chat; at narrow widths they stack without covering the transcript or composer, and the panel contents retain their own scrolling. At or below 1320px, panels collapse temporarily; widening restores the user's choice. Hidden panels are inert, and focus transfers between the open/close controls. Focus mode remains temporary: entering collapses both panels but keeps their header buttons available, opening panels keeps focus mode active, and exiting restores the normal panel preferences. Routine sampler descriptions live under **Sampler reference** and all controls continue to use shared flag state.
- Chat's **Context** button opens an inline panel above the composer for usage and compaction controls. The panel scrolls internally, leaves Send accessible, and closes through the button, Escape, or focus/click outside. Narrow layouts can grow vertically to keep the panel and composer reachable.
- Chat uses the shared confirmation dialog before deleting one conversation, deleting all saved conversations, or clearing the current chat (including its saved entry and system prompt). Delete All and Clear each ask once. Cancel leaves the active chat and any generation running; deleting an inactive conversation also leaves the current generation running. Confirmed deletions remove entries directly from saved history, with no restore-deleted control or new trash copies. Legacy deleted-history storage is left unused. History still keeps at most 50 conversations and removes overflow entries. Storage failures retain the active chat. The shared dialog treats Enter on Cancel as cancellation.
- **Load character card**, below Chat's System Prompt, reads local JSON or PNG files without uploading the file. Supports legacy Tavern fields and the core fields in [V2](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md) and [V3](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md) cards. PNG decoding reads base64 UTF-8 `tEXt` metadata (`ccv3` preferred over `chara`), checks chunk bounds and metadata checksums, and limits files to 20 MB and card data to 1 MB. Import saves the current conversation before opening a saved character chat, including cards without a greeting; storage or parse failure keeps the current chat open. Description, personality, scenario, and example dialogue become an editable System Prompt; `first_mes` becomes the initial assistant message. Card system prompts replace the helpful-assistant fallback, with `{{original}}` expanding to that fallback. `{{char}}`/`{{user}}` and legacy name markers expand to the character name (V3 nickname if supplied) and `User`. Post-history instructions are included in System Prompt and reported as such. Import notices identify omitted lorebooks, alternate greetings, assets, extensions, and remaining unsupported macros. Creator metadata is excluded from the prompt. This is a core-field importer, not a SillyTavern prompt/lorebook engine or character-card editor. The resulting prompt and transcript use normal conversation persistence and request/context-preview paths; importing does not generate a reply.
- Character-card names and nicknames are limited to 256 UTF-16 code units. The combined expanded System Prompt and greeting are limited to 1,048,576 UTF-16 code units; name and `{{original}}` substitutions measure the resulting length before allocation. Unsupported-macro detection excludes braces from the macro body so unmatched opening braces are scanned in linear time.
- API endpoints render as responsive list rows with full URLs and individually labeled Copy buttons. Client examples are native disclosures; cURL starts open and `updateEndpoints()` preserves expanded examples when their content changes. External-server and tunnel controls are separate disclosures whose status badges remain visible while closed. Tunnel warnings remain beside the actions. Endpoint/auth resolution and connection behavior are unchanged.
- Install & Update keeps required launch tools visible and groups optional tools under an installed-count disclosure. Missing optional tools use neutral status text; missing required binaries/runtime libraries retain repair guidance. `updateStatusUI()` skips rebuilding installation details when only runtime status changes, preserving disclosure focus. **Restart Llama GUI** uses the existing restart/confirmation path.

---

## Data Flow

- Launch-relevant UI changes route through `window.LlamaGui.flagCore` shared setters (`setFlagValue`/`setMultipleFlagValues`) to update state.
- All mirrored controls read from the same underlying `flagCore` state object (`flagValues`, selected model, and current tool).
- Configure compares those pending GUI inputs with `active_runtime.launch_settings` for the active local process. `flagCore.captureLaunchSettings()` snapshots the exact state used to build manual/Model Switcher requests; `compareLaunchSettings()` normalizes known recorded values without substituting current defaults. API keys and Custom Launch Args text are excluded. Oversized values are omitted from optional comparison metadata without restricting launch arguments. Model/root differences are separate from the setting count. Unknown fields, missing snapshots, and a different selected tool have no inferred baseline.
- `POST /api/launch` accepts optional `launch_settings` metadata (`model`, `flags`, `has_custom_args`, and optional `model_root`). The backend validates size/types, removes sensitive/inert fields, and retains the snapshot only after successful process creation under the process lock. `active_runtime` also includes launch-time `version` and `backend`. Launch/status responses deep-copy the snapshot; it is cleared with the process. The metadata describes GUI inputs, never effective values resolved by Auto Fit, model defaults, or custom arguments, and never controls process execution.
- Configure's **Changed since launch** filter combines with search; category counts and **Review changes** use the same launch baseline. Per-setting and bulk reverts use shared setters, preserving API keys, Custom Launch Args, model selection, and the models folder. The review includes changes outside the search, and focused rows stay visible while edits temporarily equal their baseline. The runtime summary currently belongs to Configure; its lifecycle state comes from `processLifecycle`.
- Configure flag rendering lives in `window.LlamaGui.configFlagsUi`, but rendered controls still read from `flagCore` and write through the shared setter path.
- Configure's **Restart with changes** captures the manual launch request from shared state, validates it through `/api/launch/preflight`, and uses `processLifecycle.switchRuntime()` with the original process generation. It confirms stop before launching and waiting for readiness; validation failures preserve the current process, while edits made during the operation remain pending. This action is available for the local `llama-server` and includes all launch arguments, even fields excluded from comparison.
- Configure's Custom Launch Args textarea stores its raw value in shared `flagCore.flagValues.custom_args` through `setFlagValue("custom_args", ...)`.
- Quick Launch groups shared model, memory, and sampling controls in one panel, with direct Temperature/Top P inputs alongside the sliders and port/API/template controls behind a disclosure. Its model-folder controls use the same manager handlers and error/busy state as Configure. The runtime strip reads lifecycle/status data; the launch bar and command describe pending settings.
- Quick Launch refreshes three full-preset shortcuts on entry, ordered by existing favorites and last-used metadata, then name; archived and partial presets are excluded. `presets.matchesCurrentPreset()` compares current savable inputs with the normalized saved configuration, excluding API keys and inert draft context. `loadPreset()` returns its result and loaded data for inline feedback; shortcut selection never launches a process. All sampler-management controls, starter profiles, downloads, and Model Switcher remain accessible through disclosures.
- Command preview and launch args are generated from shared state (`flagCore.getLaunchArgs()`), never per-tab copies.
- Custom launch args are parsed and appended only by `flagCore.getLaunchArgs()`, after UI-managed flags and before the selected model arg.
- Benchmarking reads Configure state or saved preset JSON without mutating them, builds tool-compatible benchmark args, can prepare the official WikiText-2 raw test file through `/api/benchmark/wikitext2`, and uses `/api/launch`, `/api/stop`, `/api/output`, and `/api/status` through the existing single process slot.
- Server output is polled incrementally through the monotonic cursor contract on `/api/output`; each response includes the authoritative runtime generation so stale tabs can invalidate old output and reconcile to a replacement process.
- Chat completions are streamed via SSE from `/api/chat/completions` (backend proxies to `llama-server`).
- Stats are polled from `llama-server`'s Prometheus `/metrics` endpoint, with most-filled-slot context occupancy read independently through the local `/slots` proxy.
- Remote tunnel status is polled from `/api/remote-tunnel/status`.
- Model download progress is polled from `/api/hf/download-status`.
- After app update, the page reloads with a cache-busting `appReload` timestamp parameter.

---

## Flag System

### Single Source of Truth

`ui/js/flags/definitions.js` defines the `FLAGS` array. Each flag has:
- `id`, `flag` (CLI name), `category`, `type`, `label`, `desc`, `tool`, `default`
- `tool` field: `"both"`, `"server"`, `"cli"` — controls visibility
- Types: `bool`, `int`, `float`, `text`, `text_list`, `path`, `enum`, `multi_enum`
- Categories: model, context, cpu, gpu, auto_fit, sampling, rope, conversation, lora, kv, speculative, server, mcp, grammar, logging, advanced
- `false_flag` for boolean negation (e.g., `--mmap` / `--no-mmap`)

### Flag Types

- **`bool`**: Checkbox. Supports `false_flag` for negation (e.g., `--no-mmap`).
- **`int`**: Numeric input with min/max/step constraints.
- **`float`**: Decimal input with min/max/step constraints.
- **`text`**: Free-form text input.
- **`text_list`**: One value per line; emits the same CLI flag once for each value.
- **`path`**: Text input with native file picker "Browse" button (tkinter).
- **`enum`**: Dropdown select from a predefined options list.
- **`multi_enum`**: Multiple checkboxes for selecting zero or more values. Supports an `all` shortcut and `risk: "high"` badges with warnings for dangerous options (e.g., shell command execution).

Any flag can declare `submenu: "<name>"` to render inside a collapsible sub-accordion within its category instead of at the category's top level. Flags without `submenu` render first, in definition order; submenu blocks follow.

A category may declare `submenuOrder: [...]` (`ui/js/flags/categories.js`) to control the order those blocks appear in. It is presentation-only and deliberately independent of the `FLAGS` array order, which determines CLI argument order in `buildLaunchArgs()` and must never be reordered for display purposes. Submenu names not listed in `submenuOrder` keep their definition order and sort after every listed name. `tests/frontend/flag_definitions_unit.cjs` fails the build if the two lists drift apart.

### Launch Args Generation (`flagCore.getLaunchArgs()`)

1. Iterate `FLAGS`, filter by tool.
2. Skip inert defaults (explicit allowlist in `shouldOmitFlagValue`).
3. Skip speculative flags when not enabled.
4. Build `[flag, value]` pairs.
5. Parse + append custom args.
6. Build the local model argument from accepted active-root metadata plus the root-relative model ID. The default remains exactly `-m models/<name>`; `mmproj/` is excluded from discovery.
7. Return `{ args, error, warnings }`.

`<name>` is checked by `flagCore.normalizeModelRelPath()`, which rejects absolute paths, `.`/`..` segments, empty segments, and anything not ending in `.gguf`. It is exported on the `flagCore` API and reused by `benchmark-ui.js` rather than restated, so the launch and benchmark `-m` values cannot drift apart; `benchmark-ui` fails closed if the export is missing. It stays in `flag-core.js` rather than being injected through `configure()`, so a missing `configure()` call can never disable the check.

### llama.cpp Compatibility

**Curated subset, not a mirror.** Upstream exposes far more flags than a
usable UI can show, so `FLAGS` deliberately surfaces only the most common
and useful ones; everything else stays reachable through Custom Launch
Args. The model below keeps that curated list honest as upstream moves.

**Where truth lives.** Upstream defines the CLI surface in `common/arg.cpp`
(plus `server.cpp`); `ui/js/flags/definitions.js` mirrors the curated
subset. Enum values must match upstream exactly, and a boolean whose
"off" state is a separate flag declares `false_flag` (unchecked `--mmap`
emits `--no-mmap`). The step-by-step checklist for adding or changing a
flag lives in [AGENTS.md](../AGENTS.md#feature-pitfalls) — follow that,
not this prose.

**Lifecycle markers.** Three mechanisms keep definitions compatible with
binaries that drift in different directions:

| Marker | Meaning | Effect |
|---|---|---|
| `fork_only: true` | Flag exists only in a llama.cpp fork (e.g. `--spec-draft-adaptive`), not upstream | Default-off boolean with a `docs/upstream-changes.md` entry; binary compatibility checks skip it |
| `removed_in: "bNNNNN"` | Upstream removed the flag in that build (e.g. legacy `--mmap` / `--mlock` / direct-IO, removed in b10875) | Definition stays for older builds; the installed-binary check exempts it at or above the tag |
| Build-tag gates | Behavior must differ by installed build | `manager.js` feeds `/api/status`'s `version` (config.json's installed release tag; custom slots report `"custom"`) into `flagCore.setBinaryTag()`; helpers like `supportsLoadModeOnly()` and `supportsNativeReasoningEffort()` match `/^b(\d+)/` against a threshold. Unrecognized tags fall back to legacy behavior, so older and custom builds keep working |

**The ledger.** `docs/upstream-changes.md` tracks every announced upstream
change that may need a coordinated GUI update — fork-only flags, removals,
pending PRs — each with upstream reference, status, and remaining work.
Entries are deleted once handled or deliberately declined.

**Mechanical enforcement.** `tests/frontend/llama_flags_supported_unit.cjs`
compares every non-`fork_only` definition against an installed binary's
`--help`, parsing the build from `--version` to honor `removed_in`
exemptions. Locally (`npm run test:flags`) it runs without a binary;
setting `LLAMA_GUI_LLAMA_BIN_DIR` — or passing `--require-binaries` —
makes it fail loudly instead. CI does exactly that:
`.github/workflows/tests.yml` downloads the release pinned in
`tests/llama-cpp-pin.json` (tag, asset, sha256 — bump all three fields
together to pin a newer release), exports `LLAMA_GUI_LLAMA_BIN_DIR`, and
runs `npm test` under it, so every PR proves the flag list against one
known binary.

After any flag change, also confirm the command preview emits arguments
`llama-server` accepts, and that chat-template names in
`ui/js/flags/chat-templates.js` still match the installed release (see
[Chat Template Presets](#chat-template-presets) below).

---

## Chat Template Presets

### Current Approach

Llama GUI treats the template dropdown as a curated preset list rather than a raw dump of every `llama.cpp` built-in template name.

The preset list is aligned to the user-facing `Instruct Tag Preset` names from Kobold Lite, while still keeping:
- `Auto (from model)`
- the manual `Custom Template File` field

This trims the dropdown without removing low-level backward compatibility for older saved presets that may still reference hidden built-in `llama.cpp` template names directly.

### Shared Source of Truth

The named dropdown presets live in `ui/js/flags/chat-templates.js`:
- `CHAT_TEMPLATE_PRESETS`
- `CHAT_TEMPLATE_PRESET_OPTIONS`

Each preset entry has:
- `value`, `label`, `mode`
- and, when needed, either `builtin` or `path`

**Modes:**
- `auto`: clears both `chat_template` and `chat_template_custom`
- `builtin`: maps the preset to a real `llama.cpp` built-in template name
- `bundled`: maps the preset to an app-owned Jinja file under `ui/templates/`

Quick Launch does not maintain its own template list. It clones the shared options source from the `chat_template` flag, which keeps Configure and Quick Launch linked.

### State Mapping

Template dropdown mapping helpers live in `ui/js/app.js`, while launch-relevant template values are stored in `window.LlamaGui.flagCore`.

Important helpers:
- `getChatTemplatePresetByValue(...)`
- `getChatTemplatePresetByBuiltinName(...)`
- `getChatTemplatePresetByPath(...)`
- `getSelectedChatTemplateDropdownValue()`
- `getQuickTemplateSummaryText()`
- `setChatTemplateValue(...)`

**Behavior:**
- **Built-in preset**: sets `chat_template`, clears `chat_template_custom`
- **Bundled preset**: clears `chat_template`, sets `chat_template_custom` to a bundled file path
- **Auto (from model)**: clears both
- **Manual custom file**: clears `chat_template`, keeps the path in `chat_template_custom`; only shows a named preset if the chosen path exactly matches one of the bundled preset files

### Bundled Templates

Files under `ui/templates/`:

- `alpaca.jinja`
- `chatml-nonthinking.jinja`
- `deepseek-v31-nonthinking.jinja`
- `deepseek-v4.jinja`
- `gemma4-e2b-e4b.jinja`
- `gemma4-e2b-e4b-nothink.jinja`
- `gemma4-26b-31b.jinja`
- `gemma4-26b-31b-nothink.jinja`
- `glm45-nonthinking.jinja`
- `glm47-nonthinking.jinja`
- `metharme.jinja`
- `mistral-non-tekken.jinja`
- `seed-oss-nonthinking.jinja`
- `openai-harmony-nonthinking.jinja`

Most use a small generic Jinja message loop with preset-specific start/end tokens. Used for non-thinking variants, renamed presets that don't map cleanly to a single built-in, and special tag formats not represented by built-ins.

`deepseek-v4.jinja` is the exception: it is a verbatim copy of upstream `models/templates/deepseek-ai-DeepSeek-V4.jinja` (llama.cpp PR `ggml-org/llama.cpp#24162`, build `b9840`). There is no `deepseek4` built-in template name; `llama.cpp` detects V4 from the template body and routes it through its DeepSeek V3.2/V4 parser. Thinking is off unless `enable_thinking` is set at runtime. Re-sync this file from upstream rather than hand-editing it.

### Built-In Mappings

Some Kobold Lite preset names are intentionally mapped to existing `llama.cpp` built-ins:

| Preset | Built-in |
|--------|----------|
| `ChatML` | `chatml` |
| `CommandR` | `command-r` |
| `Gemma 2 & 3` | `gemma` |
| `GLM-4 & 4.5` | `chatglm4` |
| `Granite 3.x` | `granite` |
| `Granite 4.0` | `granite-4.0` |
| `Granite 4.1` | `granite-4.1` |
| `Hunyuan VL` | `hunyuan-vl` |
| `Kimi ChatML` | `kimi-k2` |
| `Llama 2 Chat` | `llama2` |
| `Llama 3 Chat` | `llama3` |
| `Llama 4 Chat` | `llama4` |
| `Mistral Tekken` | `mistral-v3-tekken` |
| `Phi-3 Mini` | `phi3` |
| `Seed OSS` | `seed_oss` |
| `Vicuna` | `vicuna` |
| `OpenAI Harmony` | `gpt-oss` |

### Backward Compatibility

- The dropdown is curated; the old built-in allowlist is still present for launch/preset compatibility.
- Older saved presets using previously exposed built-in names can still launch, but the main dropdown is no longer cluttered with legacy options.

### Reuse Pattern for Future Templates

1. Decide: `builtin`, `bundled`, or `auto`.
2. Add one entry to `CHAT_TEMPLATE_PRESETS`.
3. If bundled, add the Jinja file under `ui/templates/`.
4. `CHAT_TEMPLATE_PRESET_OPTIONS` populates the dropdown automatically.
5. Verify reverse mapping: builtin name → dropdown preset, bundled file path → dropdown preset.
6. Verify both Configure and Quick Launch update immediately.

### Validation Checklist

For any new preset:
- Appears in Configure and Quick Launch
- Both tabs stay linked
- Built-in presets use `--chat-template`
- Bundled presets use `--chat-template-file`
- Manual custom files clear named preset selection unless they match a bundled preset path

---

## Quick Launch Tab

The Quick Launch tab (`section-quick-launch`) provides a simplified launch interface for quick model testing.

### Profiles

`QUICK_PROFILES` in `ui/js/app-data.js` provides preconfigured setups consumed by `ui/js/quick-launch-ui.js`:
- `safe-defaults`: 32K context, auto GPU, auto-fit, Balanced sampler preset
- `balanced`: 64K context, auto GPU, auto-fit, Balanced sampler preset
- `long-context`: 128K context, auto-fit, Balanced sampler preset
- `creative-chat`: 32K context, Creative sampler preset

Each profile applies a tool setting, flag values, fit linking, and sampler preset in one action.

### Controls

Quick Launch renders simplified controls for:
- Model selection (synced with Configure's model dropdown)
- Compact tool mode toggle (Web / API server = llama-server, Terminal = llama-cli)
- Context size (K-formatted preset dropdown + custom input, linked to fit_ctx by default)
- GPU layers (auto/0/all/custom, synced with Configure)
- Auto Fit toggle; fit target/context inputs live behind an "Advanced fit options" disclosure
- Chat template (reuses shared `chat_template` options from `ui/js/flags/chat-templates.js`)
- Sampler preset selection (load/save/delete from shared sampler preset store)
- Quick sampler sliders (temperature, top-k, top-p, min-p, repeat-penalty, presence-penalty), plus direct temperature/Top P numeric inputs; additional samplers and management controls are collapsed initially
- Metrics toggle
- Optional session-only API key with masked entry, generation, copy, a "Protected" badge, and shared Configure synchronization
- Starter profile selector and summary in a disclosure below the launch bar
- Compact pending model/context/GPU/API summary alongside launch readiness
- Collapsible launch-command preview and a launch/stop bar in normal document flow with a busy ("Starting…") state
- The Model Switcher card is collapsed by default; slots are assigned via inline per-slot preset selects (no manage mode) and detail values are ellipsis-truncated filenames

All controls write through `window.LlamaGui.flagCore` setters (`setFlagValue()` / `setMultipleFlagValues()`), keeping Configure and Quick Launch in sync.

### Model Switcher

The Model Switcher card stores references to two saved full `llama-server`
presets. It owns assignment, missing/invalid/drift/failure presentation while
`process-lifecycle.js` owns preflight, stop, launch, readiness, and recovery.
Standby means configuration is ready to preflight, not that a second model is
resident in RAM or VRAM.

The card is collapsed by default. Each slot card carries its own inline preset
select (`model-switch-select-a/b`), shared-list refresh button, and clear button —
there is no separate manage mode. Both slots render identical detail rows (Model, GGUF, both
filename-only via `basename()`), with the select row and a footer holding the
status message and the switch action.

The compact slider above the sidebar theme selector is a shortcut for an
already-active Model Switcher runtime. Its position comes from authoritative
active-runtime identity, pointer activation requires dragging the thumb across
the far-side threshold, and keyboard activation requires selecting with an
arrow/Home/End key followed by Enter or Space. It is disabled until a switcher
slot is active; initial launch and slot assignment remain in Quick Launch.

### Optional llama-server Authentication

- A blank `api_key` keeps llama-server open exactly as before. A non-empty value emits `--api-key`; comma-separated and quoted values use the same CSV semantics as upstream llama.cpp.
- Configure and Quick Launch use the same shared `flagCore` value. At successful launch, the backend snapshots the parsed keys in memory. Built-in Chat, metrics, and slots requests use that launch-time snapshot, so editing pending configuration cannot break the running server.
- API keys are sensitive session state: they are masked in controls, redacted from command previews and launch output, omitted from presets/imports/exports, and preserved in memory when applying a preset.
- Loading the preset library removes legacy `api_key` fields and any Custom Launch Args containing `--api-key` from stored preset JSON. New preset saves and imports reject sensitive Custom Launch Args instead of persisting them.
- Reloading the browser clears the editable key field, but the backend snapshot continues authenticating a running server. A re-entered key is used only as a fallback when the backend has no tracked launch-time snapshot. Stopping or reaping the process clears the snapshot.
- This setting protects llama-server, not the Python management UI. Because llama-server receives `--api-key`, same-user OS process inspection may still reveal the real argument.

### Hugging Face Download Integration

The Quick Launch tab includes a full HF model downloader section initialized by `ui/js/quick-launch-ui.js` and implemented in `ui/js/hf-download-ui.js`:
- Repo ID + revision + token inputs
- "Find Files" button fetches GGUF file listing from `/api/hf/repo-files`
- Model and mmproj file selectors
- Download progress bar with cancel support
- Auto-selects downloaded model on completion

Frontend downloader controls, status rendering, progress polling, cancel handling, and completion flow live in `ui/js/hf-download-ui.js`. `app.js` injects `fetchJson`, confirmation/model callbacks, and `flagCore`; the module must not mutate `flagValues` directly.

---

## Monitor Disk Activity

The `system:disk` card shows read/write throughput instead of capacity, preserving its layout and visibility preference. The `/api/system-stats` disk object retains capacity fields for compatibility and adds `io_available` (counter availability, independent of capacity) and `io_label` (the measured scope). Rates stay null during warmup, long sampling gaps, counter rollback, or a source change; a valid zero is Idle.

Windows collects raw `PhysicalDisk(_Total)` byte counters through [language-neutral PDH APIs](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhaddenglishcounterw). macOS reads the built-in `ioreg` property-list output using the [IOBlockStorageDriver byte statistics](https://github.com/apple-oss-distributions/IOStorageFamily/blob/main/IOBlockStorageDriver.h). Both aggregate physical disks. Linux retains `/proc/diskstats` selection for the application filesystem device, with its existing whole-disk fallback. The card labels the scope; readings include other applications and do not depend on GPU vendor probes.

## Presets Tab

The Presets tab (`section-presets`) is the library browser for saved launch configurations. All logic lives in the `ui/js/presets/` package; styling is under `.presets-browser` in `ui/css/style.css`.

The tab is built for libraries of scale. The reference case is 58 presets across 33 model groups, and several design decisions below only make sense at that size.

### Layout

Two columns inside `.presets-workspace`, which takes a definite `height: max(460px, calc(100vh - 216px))` so both columns end level and each scrolls internally rather than scrolling the page:
- **Browser** (`#presets-list`): toolbar, filters, bulk bar pinned; the list is the only flexible child.
- **Detail panel** (`#preset-detail-panel`): the selected preset, or a library summary when nothing is selected.

### Grouping And Sorting

Presets group by their saved `model` value. Groups are keyed by model path, sorted by label, and **collapsed by default** — `isPresetGroupCollapsed()` returns `true` unless a group was explicitly expanded. Presets with no model land in a `__no_model__` group pinned last.

Sort modes are name, recently used, and date added. Group order follows the active sort, except name mode which always sorts by label.

Note for tests and fixtures: groups render in **label order**, not the order a fixture declares them.

### Search

`getPresetSearchText()` covers preset name, model path and label, tool, and — for non-default flags only — each overridden flag's id, its de-underscored id, and its human label from `getPresetFlagLabel()`. So `ctx` finds presets that changed `ctx_size`, while a preset holding that flag at its default does not match.

Search text is precomputed onto `entry.searchText` in `buildPresetGroups()`, not rebuilt per keystroke. `getPresetFlagLabel()` is backed by a `Map` cached on the `FLAGS` array identity.

### Filters

- **Favorites** is tri-state: `All` → `★ First` (sort only) → `★ Only` (filters).
- **`⚠ Warnings`** shows only presets with at least one warning.
- Search and filters force groups open so matches stay visible.

### Bulk Actions

Select All, Clear, `★ Favorite`, `☆ Unfavorite`, Export, Delete. Favorite/unfavorite do one storage read and at most one write for the whole selection, and report a no-op rather than triggering a pointless refetch.

### Warnings

`getPresetWarnings()` flags three things:
- The saved model file is not in the models folder (see below).
- An outdated or unsupported chat template.
- Custom launch args, which may override UI controls.

Missing-model detection matches each preset's model against the shared cache in `manager.js`, populated by `refreshModels()` from `/api/models`. `matchKnownModelName()` tries the full active-root-relative path first (case-insensitive), then falls back to the file name only for legacy bare names and absolute paths. A bare name held by two subfolders is reported as `ambiguous` rather than resolved, and warns — guessing a folder would launch the wrong weights. An explicit relative path never falls back to another folder's file.

`resolvePresetModelName()` is shared by normal preset loads, Model Switcher launch preparation, and saved-preset benchmarks so every path uses the same nested filename. It matches against live model options or the benchmark model list because those carry the exact spelling the launch needs; an unresolved value is selected as-is and marked `(missing)` in the dropdown, matching what the preset warns about. When these drifted apart, a preset could report healthy while its launch emitted a path that did not exist.

Detection is deliberately conservative: an unknown list, an empty models folder, and a preset with no model all stay silent, because a preset for a model kept on another machine is legitimate.

`null` from that cache means "not known yet" and must stay distinct from a known-empty folder. The summary surfaces this as `modelsChecked`; when false, the Missing Models stat renders `—` and the health line says the check did not run rather than giving a false all-clear.

Because warnings are computed at build time, `refreshModels()` calls `refreshModelPresence()` on both its success and failure paths so an open Presets tab rebuilds. That guard keys on `#section-presets` visibility, since `#presets-list` is static markup and always present.

### Detail Panel

With a preset selected: model and warnings, followed by **Load into Configure**, Favorite, and a keyboard-operable **More actions** disclosure containing a named Update action, Duplicate, Rename, Export, Windows Shortcut, Archive/Restore, and Delete. The launch-input summary shows tool, context, GPU offload, and K/V cache settings from shared flag definitions. Missing values are explicitly labeled as GUI defaults; Auto is not presented as a resolved runtime value. All saved settings are available in a separate disclosure, with API keys and the retired draft-context flag excluded, and HF tokens, sensitive flags, and Custom Launch Args masked.

The saved-settings table has **Setting**, **Saved value**, and **GUI default** columns. Defaults come from the current shared flag definitions and appear only for non-default values; blank cells mean the saved value matches, and unavailable defaults are labeled explicitly. It reuses the override IDs used by the count and search, treating nonempty numeric strings as equal to numeric defaults without coercing blanks or booleans to zero. API keys, HF tokens, and retired draft context do not contribute to the override count.

With nothing selected: a library summary — preset count, model groups, favorites, warnings, missing models, most recently used, and a health line. The summary describes the **visible** presets, not everything on disk, so its numbers always agree with the list and the count line. Any absolute claim about library health is suppressed while a filter is active or while the model list is unchecked.

### Editing And Saving

Configure and Quick Launch share a preset context bar. Before loading or saving a preset it offers **Save as new preset** for the unsaved configuration. Afterwards it shows **Based on** the last loaded/saved preset and whether the current edits match it. Selecting a row in the library never changes that source. The source name opens its library detail and clears conflicting filters. This session-only source is independent of the active runtime and Configure's **Changed since launch** comparison.

`comparePresetToCurrent()` uses the same default/speculative-flag normalization and model-name resolution as loading. API keys and `ctx_size_draft` do not participate; sensitive/custom-argument values are masked in rendered differences. `refreshContext()` runs from the shared command-preview broadcast; accepted library fetches reconcile the saved source, including renamed, archived, and missing presets.

New saves use `overwrite: false`. Updating fetches the saved target, captures current savable inputs, and opens a native dialog with saved/current differences. On confirmation it rechecks that the target still exists and matches the reviewed saved data, then posts the captured snapshot. Edits made while the dialog is open remain pending. Duplicate submissions are guarded; failures preserve edits for retry. These operations do not launch, stop, or restart a process.

### Keyboard Navigation

The list is one composite widget rather than a few hundred tab stops. At the reference size it was 33 header buttons plus 58 rows x 4 stops each = 265 stops to cross; it is now one stop to enter.

- The focus sequence is group headers plus the rows of expanded groups, in document order. Rows in a collapsed group are `display: none` and are skipped.
- Only the current item carries `tabindex="0"`. Its checkbox, favorite toggle, and Load button are restored to the tab order with it, so Tab reaches them and then leaves the list.
- Up/Down move, clamped at both ends; Home/End jump. Enter/Space still select.
- `presetRovingKey` identifies position by preset name or group key, so the full re-render that selecting or favoriting triggers restores focus to the same preset. A `focusin` listener syncs the key when focus arrives by click, Tab, or programmatic `focus()`.

### Duplicate And Rename

`duplicatePreset()` copies the *saved* preset data straight to `POST /api/presets`, so live Configure and Quick Launch values are never touched. Rename uses `POST /api/presets/rename`, which carries the `.preset-created-times` entry so "Date added" sorting survives. Case-only renames (`my preset` → `My Preset`) are supported: Windows `Path` equality and `resolve()` are case-insensitive and would collapse the rename onto its source, so the route renames against the requested spelling and uses `samefile()` to tell a case-only rename from a genuine collision with a different preset.

### Local Storage Keys

| Key | Purpose |
|-----|---------|
| `llama_gui_preset_group_state_v1` | Per-model-path group collapse state |
| `llama_gui_preset_favorites_v1` | Favorited preset names |
| `llama_gui_preset_last_used_v1` | Last-used timestamps for recency sort |
| `llama_gui_preset_sort_v1` | Active sort mode |
| `llama_gui_preset_favorites_first_v1` | Favorites tri-state (migrated from an older boolean) |

All reads and writes go through helpers that tolerate blocked storage; failures log rather than breaking preset actions.

---

## Chat Tab

### Window ownership and transfer boundaries

`chat-workspace.js` owns the versioned workspace snapshot and guards conversation mutations with an ownership epoch. Its transfer interface suspends idle Chat, saves the existing conversation, captures/restores supported transcript and draft state without creating a second history entry, and keeps main-window layout separate. Shared sampler settings remain authoritative in the host and are never restored from a conversation transfer.

`chat-window.js` provides the host adapter and a feature-specific coordinator for an exclusive origin-scoped Web Lock, verified peers, and one separate versioned recovery record. Recovery invalidation precedes destructive history writes. A timer or missed message never grants ownership. The module has no startup side effects until explicitly initialized.

The detached display mode uses the same `index.html` and Chat modules. It bypasses normal application initialization and receives settings, runtime status, and inference snapshots through the original main window. The main window must remain open; it continues to own launch settings and process lifecycle actions. Only the current Chat owner may mutate conversation history. Main-window layout is retained separately, and popup panel choices do not overwrite it.

Chat initializes its controls while inert before restoring a recovery snapshot. Losing the host session pauses the detached view, aborts active work, checkpoints recoverable output, and releases ownership. Explicit recovery reads the latest durable state under the lock; a deletion tombstone clears stale in-memory state instead of restoring deleted history. The user-facing workflow and browser limitations are in [Chat in a separate window](chat-popout.md).

The Chat tab (`section-chat`) is a streaming OpenAI-compatible chat interface that proxies through the Python backend.

### Architecture

The backend proxies `/api/chat/completions` to `llama-server`'s `/v1/chat/completions` endpoint:
1. Frontend sends POST with messages, sampler params, and optional web_search flag.
2. Backend resolves the destination from its own state — see [Chat Proxy Target](#chat-proxy-target) — and refuses the request when there is none.
3. Backend optionally performs web search (SearXNG when configured, otherwise DuckDuckGo), fetches result pages, injects context into the system prompt.
4. Backend proxies the request to the resolved target and streams the SSE response back to the frontend.
5. Frontend renders markdown and tracks source citations.

### Chat Proxy Target

`external_server.resolve_llama_target()` picks the destination for the chat proxy and the metrics/slots/props proxies, in order:

1. A `llama-server` this GUI launched (`ctx.state.active_runtime`).
2. A `llama-server` the operator registered through `POST /api/chat/target` (API tab → "Connect to a Running Server").

The destination is never read from the chat request body, so a `/api/chat/completions` caller cannot redirect their own request. Changing the target requires the separate `POST /api/chat/target`, which — like every other `/api/` route — is gated only by the origin check, so anyone who can reach the GUI (including over the remote tunnel) can re-register it. The enforced boundary is the address policy, not the caller: registration runs through the same local-address check as the metrics proxy (`chat.get_local_proxy_host`), so only loopback and this machine's own interfaces are accepted, and it is probed with a `GET /health` before being accepted.

The live registration is session-scoped. Its API key is held in `ctx.state.external_chat_api_key`, deliberately outside the `external_chat_target` dict that `/api/status` publishes, so the key is never serialized to a client. A launched server's key still takes precedence for a launched runtime.

#### Remembering a target

`connect()` saves the *address* — host, port, label, and an `api_key_required` flag — under `external_chat_target` in `config.json`. The key itself is never written to disk. `disconnect()` removes the entry, because disconnecting is the operator saying they do not want this target.

On load, `externalServerUi.restore()` reads `GET /api/chat/target`, which returns both the live target and the remembered one:

- Already registered → adopt it and prefill the form.
- Remembered, no key needed → `POST {"restore": true}`, which calls `reconnect_remembered()`.
- Remembered, key needed → prefill the address and ask for the key. Never auto-connects, since the key was never stored and the attempt could only produce a target that cannot authenticate.

An unattended restore passes `require_identified=True`, so the `/health` response must actually look like llama.cpp's (`{"status": ...}` or `{"error": {...}}`). If another local service has taken the port since the last session, the restore is refused instead of silently proxying chat to it. A hand-driven connect stays permissive — there the user chose the address, and an unusual status is useful feedback rather than a reason to refuse.

### Web Search

When the web search toggle is enabled:
- The backend extracts the latest user message and queries the search backend: a self-hosted SearXNG instance when `LLAMA_GUI_SEARXNG_URL` is set (its `settings.yml` must enable `json` under `search.formats`), otherwise DuckDuckGo (`ddgs`). SearXNG is preferred when configured and falls back to `ddgs` whenever it is unset, unreachable, or returns no usable results.
- The Chat sidebar's "Result Count" setting controls both how many search results are requested and how many result pages are read for full text.
- Result Count defaults to 5, is persisted in `localStorage` under `llama_gui_chat_web_search_max_results`, and is clamped to 1-10 by both frontend UI constraints and the backend chat route.
- Search context is injected into the system prompt with source citations.
- Sources are rendered as clickable chips below the assistant's response.
- Web search status messages (e.g., "Searching: ...", "Reading: ...") are streamed during processing.

### Conversation History

- Conversations are stored in `localStorage` under `llama_gui_conversations`.
- Each conversation has an id, title (initially derived from the first user message and preserved after a manual rename), messages array, compaction stack, system prompt, reasoning setting, and timestamp.
- The collapsed-by-default history panel shows recent conversations with search, preview text, relative timestamps, rename, JSON export, and visible 50-conversation retention status.
- Features include new chat, undo last message, regenerate/retry with answer versions, Edit and resend with a saved recoverable tail, and recoverable individual/bulk deletion. Restoring into a full history moves the oldest saved conversation into the recoverable store instead of silently dropping it.
- User turns are saved before requests start. Completed, stopped, failed, and output-limited answers retain their status; interrupted content and saved source chips are restored when reopening history.
- Regeneration sends the existing user turn without its previous answer. The previous answer stays selected until a completed replacement arrives; failed/stopped attempts are retained as answer versions. The latest assistant turn offers previous/next answer navigation and Retry after an unsuccessful or limited attempt. Only the selected answer content/reasoning is sent to the model; version and error metadata remain local.

### Markdown Rendering

`renderMarkdown()` in `ui/js/chat-rendering.js` converts chat output to HTML:
- Fenced code blocks with optional language attribute
- Inline code
- Bold, italic, strikethrough
- Paragraphs, line breaks

### Sampler Sliders

The collapsed-by-default Chat settings panel has sliders plus exact numeric inputs for temperature, top-p, top-k, min-p, repeat-penalty, and max-tokens. Advanced samplers start collapsed. Numeric values write through `window.LlamaGui.flagCore.setFlagValue()` and stay exact in shared state and requests even when the visual slider is clamped; Configure, Quick Launch, and command preview receive the same state.

---

## Custom Model Folder

The Configure tab can select one model-library folder without restarting Llama GUI. `config.json` stores an optional absolute `models_dir`; a missing or empty value means the application-managed default `models/` directory. Presets and both model selectors continue storing only model-root-relative IDs such as `Qwen/model.gguf`.

`backend/services/model_dir.py` is the only interpreter of this setting. It publishes `models_dir`, the backend-authoritative `models_arg_root`, default/available booleans, and a safe error through `GET /api/status`; `POST /api/models-dir` validates and atomically merges a set/reset under `config_lock`. A configured custom directory that disappears is reported unavailable and never falls back to `models/`. Changes are rejected while an HF model download owns `model_download_lock`.

`flagCore.setModelDirInfo()` holds the accepted status, and `buildLocalModelPath()` is the single builder used by normal launches, command previews, Model Switcher preset launches, benchmarks, and perplexity. Default installs still emit exactly `models/<relative-id>`; custom installs emit the backend-provided absolute root plus that relative ID. Unknown or unavailable root state blocks command generation.

Model discovery, Open Models, model-related file pickers, and HF model/projector downloads use the active root. WikiText-2 deliberately remains under the immutable default `ctx.paths.models`, because it is application-managed benchmark data rather than part of the user's model library. `GET /api/models` remains the original array of `{name, size_mb}` objects.

`POST /api/select-folder` only opens the native picker. Cancellation changes nothing; persistence and validation still go through `POST /api/models-dir`. After a successful change/reset, the frontend accepts fresh status before refreshing the model list, preserves the selected relative ID only when it exists in the new list, refreshes preset warnings and both model controls, and rebuilds command previews.

---

## Hugging Face Model Downloader

### Backend API

- `POST /api/hf/repo-files`: Takes `repo_id`, `revision`, `token`. Uses `huggingface_hub.HfApi.model_info()` to list GGUF files. Returns separated model and mmproj file lists.
- `POST /api/hf/download`: Takes `repo_id`, `revision`, `model_file`, `mmproj_file`, `token`, `overwrite`. Downloads in a background thread with cancellation support. Xet-backed files use concurrent range transfers with scoped group cancellation; unsupported or non-Xet files retain the streaming HTTP fallback. Validates filenames and repo IDs.
- `GET /api/hf/download-status`: Returns current download progress (total, downloaded, status, current_file, model_name, model_path, mmproj_path).
- `POST /api/hf/download-cancel`: Sets cancellation event to abort in-progress download.

### Frontend Flow

1. User enters a HF repo ID (e.g., `ggml-org/gemma-3-1b-it-GGUF`).
2. "Find Files" fetches available GGUF files.
3. User selects a model file and optional mmproj file.
4. "Download" starts the download with progress bar.
5. On completion, the model is auto-selected in the model dropdown and command preview updates.

### Download Layout

- Models and their projectors land together in `<active-model-root>/<slug>/`, where `<slug>` is `slugify_repo_id(repo_id)`. The legacy top-level `models/mmproj/` folder remains excluded from model discovery.
- `model_name` in the status payload is the active-root-relative path (`<slug>/<file>.gguf`), so it matches `/api/models` and `applyPresetModel()` can select it directly.
- The slug is not injective: only `/` is substituted, so `owner/my_model` and `owner_my/model` share a folder. Accepted deliberately — an injective scheme would rename every existing download folder, and a shared folder is harmless because files keep their own names and a same-name clash hits the overwrite prompt below.

### Safety

- Repo IDs, revisions, and filenames are validated with strict regex and path traversal checks.
- Only `.gguf` files can be downloaded. The path-flag file picker offers the same GGUF-only filter (plus "All files"); llama.cpp dropped the legacy ggml `.bin` formats.
- mmproj files must contain `mmproj`, `clip`, or `projector` in the stem.
- Duplicate downloads detect existing files and prompt for overwrite confirmation.
- Partial downloads are cleaned up on error/cancellation.

---

## Remote Tunnel (Cloudflare)

### Backend

- `cloudflared` binary is auto-downloaded on first use to `tools/cloudflared/`.
- Platform-specific assets: Windows `.exe`, macOS `.tgz`, Linux binary.
- Tunnel process runs `cloudflared tunnel --url` against the configured GUI port, using loopback when the GUI is wildcard-bound.
- Status polling detects the `trycloudflare.com` URL from stderr.
- Thread-safe state management with start/stop lifecycle.
- CORS origin is updated to include the active tunnel URL.

### Frontend

Frontend tunnel controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling live in `ui/js/remote-tunnel-ui.js`.
- Start/stop buttons with disabled states during transitions.
- Polls tunnel status every 2 seconds while running/starting.
- Displays tunnel URL as a clickable link with copy button.
- Status badge with running/working/error styling.
- Tunnel URL is added to allowed CORS origins for API requests.

---

## Custom llama.cpp Slots

Install & Update offers two fixed user-provided builds: **Custom** uses `llama/custom/bin/`, and **Custom 02** uses `llama/custom-02/bin/`. Each has a sibling `grammars/` folder. Installers, release packaging, and app startup create both layouts. Existing `backend: "custom"` configurations remain compatible.

`CUSTOM_BACKEND_SPECS` and the path helpers in `backend/services/llama_manager.py` own slot identity and directory routing. `GET /api/status` supplies each slot's `id`, `label`, `custom: true`, and `bin_dir` in `available_backends`; the frontend reads this metadata for controls, paths, and update restrictions. Models and presets remain shared; selecting or loading a preset never activates a different build, and explicit grammar-file paths remain unchanged.

Selecting a dropdown entry is a pending choice. **Activate Custom** sends `POST /api/activate-custom` with `{ "backend": "custom-02" }` (or `custom`). The route validates the slot, holds the existing install/launch interlock, and checks its required `llama-cli` / `llama-server` files and applicable runtime dependencies before saving config. Benchmark tools are optional. Failed validation leaves the active backend unchanged. Runtime inspection retains its existing platform limits, including no Windows dependency inspection; activation is not an inference test.

Both slots retain `tag` / `version: "custom"` for existing flag-compatibility behavior; `backend` records the actual slot and survives restarts. Switching does not copy/delete files or borrow tools from another slot. Executable lookup, memory estimation, runtime library search paths, and validation use the selected directory. Activation clears runtime-health caches and preserves the remembered official installation so **Activate Existing** can switch back without downloading.

**Open llama.cpp** opens the active Custom slot's root (containing `bin` and `grammars`), or the main `llama/` directory for official builds. Official update and repair paths exclude both slots. **Remove llama.cpp Files** only removes official runtime directories and metadata; it preserves both custom directories and an active custom selection. The GitHub release importer remains deferred.

## Auto-Update System

### How It Works

1. The Install tab offers **Stable releases** and **Nightly** update channels. `GET /api/app-update-status` runs `git fetch origin --prune --prune-tags --tags`, then selects the newest release tag reachable from `origin/<release branch>` for Stable or the current `origin/<release branch>` head for Nightly.
2. Dirty git paths are classified as "safe" (ignored directories, cache dirs, data suffixes) or "blocking" (source file changes).
3. If the local branch is behind the selected target and has no blocking changes, auto-update is available. Untagged commits trigger an update only on the Nightly channel.
4. `POST /api/app-update` fast-forwards the current branch to the selected target, then reinstalls `requirements.txt` via pip.
5. After success, the server restarts and the frontend reloads with cache busting.

### Release Tag Selection

The release branch is `APP_RELEASE_BRANCH` in `backend/config.py` (default `main`), exposed as `ServerConfig.app_release_branch`. Tags are always looked up on `origin/<release branch>`, never on the checked-out branch, so a user sitting on a development branch is still offered the newest published release.

The Stable channel targets the newest qualifying tag. The Nightly channel skips tag selection and targets `origin/<release branch>` directly, so a fast-forward includes every unreleased commit currently on that branch. The API accepts `channel=nightly` on `GET /api/app-update-status` and `{ "channel": "nightly" }` on `POST /api/app-update`; omitted channels default to Stable.

`find_latest_release_tag()` runs `git for-each-ref --merged=origin/<release branch> --sort=-v:refname 'refs/tags/v[0-9]*'` and keeps the first tag matching `RELEASE_TAG_RE` (`^v\d+\.\d+\.\d+[a-z]?$`).

- Version sort, not date sort. The tags are lightweight, so `--sort=-creatordate` would compare commit dates and misplace a hotfix tagged onto an older commit. Version sort orders `v1.6.3 < v1.6.3b < v1.6.4 < v1.6.10`.
- The glob drops non-version tags such as `Summer-2026`; the regex drops prerelease tags such as `v1.6.3-rc1` and `v1.6.3-beta`. A single-letter revision suffix (`v1.6.3b`) is a normal release and is kept.
- `--prune-tags` is required alongside `--prune`; without it a tag deleted upstream stays local and can still be picked as newest.

### Publishing a Stable Release

`.github/workflows/release.yml` provides the manual **Create stable release** action. It can run only from `main`, executes the backend and frontend suites, confirms that the tested commit is still the current `origin/main` tip, calculates the next UTC `YY.MM.Micro` version with `scripts/next_calver.py`, builds the existing `release.ps1` archive, and publishes it with generated GitHub release notes. Workflow concurrency prevents two release runs from publishing the same Micro version.

Nightly remains the bake-in channel for untagged `main` commits. Publishing the tag promotes that exact commit to Stable; it does not create a separate nightly artifact.

### Status States

`state` is one of:

| State | Meaning | Auto-update |
| --- | --- | --- |
| `up_to_date` | HEAD already contains the selected tag or branch head (including local commits made after it) | No |
| `behind` | The selected target is a strict descendant of HEAD, so `merge --ff-only` can succeed | Yes, unless blocking changes exist |
| `diverged` | HEAD and the selected target have both moved; manual merge/rebase required | No |
| `no_release` | No tag on the release branch matched the release pattern | No |
| `error` | A git command failed or the upstream branch is missing; `reason` holds the detail | No |

Every failure path sets `state: "error"` and a human-readable `reason`. The frontend keys off `state`, so a path without it would fall through to a generic message and the git error would be lost. `update_channel` identifies the selected channel; successful comparisons also include `release_branch`, `target_ref`, and the Stable channel's `release_tag`.

When `LLAMA_GUI_SUPERVISED=1`, restart requests exit cleanly with status `75` instead of spawning a detached replacement process. An external launcher or service manager can use that status to relaunch `python server.py`; ordinary shutdowns still exit with status `0`. Standalone launches retain the existing self-restart behavior.

### Dependency Installation

`install_python_dependencies()` runs `pip install -r requirements.txt` and reports success/failure. It is an internal step of `POST /api/app-update`, called after the fast-forward to the selected update target and before Windows shortcut creation — there is no standalone endpoint for it. A dependency failure does not fail the update: the response returns `updated: true` with `dependencies_installed: false` and a `dependency_error`.

### Safe Dirty Path Classification

Paths matching these patterns are considered "safe" (not blocking updates):
- **Prefixes:** `llama/`, `models/`, `presets/`, `releases/`, `__pycache__/`, `.ruff_cache/`, `.pytest_cache/`, `.mypy_cache/`, `.venv/`, `venv/`, `env/`, `logs/`, `tmp/`, `temp/`
- **Exact names:** `config.json`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.env*`
- **Suffixes:** `.pyc`, `.pyo`, `.log`, `.tmp`, `.temp`, `.bak`, `.orig`, `.swp`, `.swo`, `.zip`, `.tar.gz`, `.tgz`

---

## Sampler Presets

Sampler presets allow saving and loading groups of sampling flags.

### Built-In Presets

Defined in `BUILTIN_SAMPLER_PRESETS` in `ui/js/app-data.js` and managed by `ui/js/sampler-presets.js`:

| Preset | Temperature | top_k | top_p | min_p | repeat_penalty | repeat_last_n |
|--------|-------------|-------|-------|-------|----------------|---------------|
| **Neutral** | 1.0 | 0 | 1.0 | 0 | 1.0 | 64 |
| **Balanced** | 1.0 | 0 | 0.95 | 0.1 | 1.03 | 64 |
| **Creative** | 1.0 | 100 | 0.98 | 0 | 1.1 | 64 |
| **Precise** | 0.3 | 25 | 0.6 | 0 | 1.02 | 64 |

### Custom Presets

- Stored in `localStorage` under `llama_gui_sampler_presets_v1`.
- Saved from current sampler values with user-defined names.
- Unique name generation handles collisions (e.g., "Creative (2)") on import.
- Load, save, rename, delete, export (single JSON file), and import (single or batch JSON) operations.

### Rename

- `window.LlamaGui.samplerPresets.renameSamplerPreset(oldName, newName)` owns all validation and returns `{ ok: true, name }` or `{ ok: false, reason }` where `reason` is `empty`, `builtin`, `missing`, or `taken`. Callers render text via `getSamplerRenameMessage(reason)`.
- Built-in presets cannot be renamed, matching delete behavior.
- Collisions are rejected rather than auto-uniquified, mirroring the 409 from the backend launch-preset rename. Comparison is case-insensitive, except that a preset may re-case its own name (`my preset` → `My Preset`).
- Stored values move verbatim, so a rename never drops a flag the current build does not recognize.
- Both tabs call the same function; the Configure panel refreshes the mirrored Quick Launch dropdown through `refreshSamplerPresetSelect(preferredValue)` so the selection follows the new name instead of resetting to the placeholder. A rename made from Quick Launch instead updates the Configure panel's remembered selection (`selectedConfigPresetValue`) inside `renameSamplerPreset` itself, so the next `renderFlags()` rebuild keeps it on the new name.

### Integration

- Configure tab: Sampler Preset controls appear at the top of the Sampling accordion (Load / Save / Rename / Delete / Export / Import).
- The Configure dropdown selection is remembered in module state (`selectedConfigPresetValue`) because `renderFlags()` destroys and rebuilds the panel on every Configure search keystroke and on Expand/Collapse All. It falls back to the first preset only when the remembered value no longer matches an option.
- `refreshOptions(preferredValue)` is the only place that changes the selection. Handlers that just wrote to the store (save, rename, import) pass the name they want selected rather than assigning `select.value` afterward — the option does not exist until the rebuild runs, and assigning a missing value silently resolves to the placeholder.
- Quick Launch tab: Sampler Preset controls in the sampler section (Load, then Save / Rename / Delete).
- Quick profiles reference preset names (e.g., `samplerPresetName: "Balanced"`).
- Loading a preset calls `window.LlamaGui.samplerPresets.applySamplerPresetValues()` which writes through `window.LlamaGui.flagCore.setMultipleFlagValues()`.
- Configure keeps six sampling flags at the top level — `--temp`, `--top-k`, `--top-p`, `--min-p`, `--repeat-penalty`, `--presence-penalty` — and groups the remaining 20 into eight collapsible submenus, displayed in this order: **Repetition Penalties**, **DRY Sampling**, **XTC Sampling**, **Advanced Truncation**, **Dynamic Temperature**, **Mirostat**, **Sampler Order**, **Generation Control**. All submenus start collapsed.
- Grouping is presentation-only. Sampler presets still read and write every sampling flag (`sampler-presets.js` selects by `category === "sampling"`), and rows inside a collapsed submenu are still present in the DOM, so preset apply/save works without expanding anything.
- `dry_sequence_breakers` uses a repeatable text list because llama.cpp requires one `--dry-sequence-breaker` argument per breaker.

### Ngram Simple

Configure's Speculative Decoding category includes an opt-in **Ngram Simple** submenu with `--spec-ngram-simple-size-n` (match tokens, upstream default 12) and `--spec-ngram-simple-size-m` (maximum draft tokens, upstream default 48). Blank tuning values use the binary's defaults; disabled tuning values remain saved but are not emitted. There are no Ngram Simple controls in Quick Launch.

The shared `ngram_simple` boolean joins existing speculative methods in one `--spec-type` argument. Presets importing `ngram-simple` inside `spec_type` normalize to the independent toggle. Both Simple and Mod describe upstream's fallback behavior: Simple is tried first, and Mod can be used when Simple produces no draft, not when a proposed draft is rejected. Other enabled methods follow upstream priority; CLI list order does not set priority. Compare each method individually before combining them.

Upstream's `--spec-ngram-simple-min-hits` is deliberately not exposed: the current simple draft implementation consumes only the lookup and draft sizes. Sources checked 2026-09-07: [ngram-map.cpp](https://github.com/ggml-org/llama.cpp/blob/master/common/ngram-map.cpp) and [speculative.cpp](https://github.com/ggml-org/llama.cpp/blob/master/common/speculative.cpp).

### Model Load Mode

The Context & Memory category exposes `--load-mode` with llama.cpp's `none`, `mmap`, `mlock`, and `dio` modes. The legacy mmap (`--mmap` / `--no-mmap`), mlock, and Direct I/O (`-dio` / `-ndio` / `--direct-io` / `--no-direct-io`) controls remain available for builds at or below b10874; they were removed from `llama-server` / `llama-cli` in b10875 (PR #28334), and b10917 help output confirms `llama-bench` / `llama-perplexity` only advertise `--load-mode` as well. When an explicit load mode is selected, command generation suppresses those overlapping legacy arguments so only `--load-mode` is emitted. On b10875+ (detected via the installed build tag), emitting a removed flag via Legacy controls or custom args adds a warn-only hint to select a `--load-mode` instead, and benchmark commands translate the legacy toggles: perplexity Memory Mapping off emits `--load-mode none` instead of `--no-mmap`; llama-bench mmap on/off emits `--load-mode mmap` / `none` instead of `-mmp 1/0`; Direct I/O on emits `--load-mode dio` instead of `-dio 1`, and off emits nothing. The legacy definitions carry `removed_in: "b10875"` so the installed-binary compatibility check exempts them on newer builds.

---

## Server Stats & Metrics

Live performance metrics are polled from `llama-server`'s Prometheus endpoint.

### How It Works

1. `startStatsPolling()` begins polling ~2 seconds after server launch.
2. Every 3 seconds, `pollStats()` fetches `/api/llama/metrics?host=...&port=...`.
3. The backend proxies to `llama-server`'s `/metrics` endpoint.
4. Metrics are parsed from Prometheus text format.

### Displayed Metrics

- **Prompt tokens processed**: Total tokens processed in prompts (delta since baseline)
- **Prompt speed**: Session-average tokens per second during prompt ingestion (idle time excluded)
- **Tokens generated**: Total tokens generated (delta since baseline)
- **Generation speed**: Session-average tokens per second during generation (idle time excluded)
- **Context usage**: Tokens and percentage currently retained by the fullest server slot

The `snapshotStatsBaseline()` function resets the session token and speed baselines (called on conversation load and new chat).

Metrics host validation restricts proxying to local addresses only for security.

---

## MCP / Agent Tools

The Configure tab's "MCP Settings" category (separate from "Server Settings") contains:
- **UI MCP Proxy**: Enables CORS proxy support for MCP requests in the Web UI via `--ui-mcp-proxy`.
- **Built-in Tools** (`multi_enum` type): Select from available agent tools exposed to the model:
  - `all`: Enable all tools (high risk)
  - `read_file`, `file_glob_search`, `grep_search`: Read-only tools
  - `exec_shell_command`: Execute shell commands (high risk)
  - `write_file`, `edit_file`: File modification tools (high risk)

When a high-risk tool is selected, a warning message appears.

### Chat tools

**Current Date & Time**, in Chat → Settings → Tools, is an opt-in browser tool, independent of server `--tools` and launch presets. Its preference is stored under `llama_gui_chat_datetime_enabled`; blocked storage falls back to the current session. It takes effect on the next Chat request without restarting the server. Turning it off also prevents any pending call from executing.

`chat-tools.js` owns the preference and advertises `get_datetime` only when enabled. It adds request-only system instructions to check the clock for date-dependent questions (including today's news) rather than infer dates from training or search results; the editable system prompt is preserved. It reads the browser clock on invocation and returns ISO 8601 local time with its UTC offset plus the IANA timezone. The model must support and choose tool calls. No date/time CLI flag is emitted: upstream moved this functionality from server tools to the browser in [llama.cpp PR #27255](https://github.com/ggml-org/llama.cpp/pull/27255), merged 2026-08-17.

Chat assembles fragmented tool-call deltas and permits one batch (up to four date/time calls sharing one clock snapshot), followed by a final request with `tool_choice: "none"`. Unknown tools, malformed/incomplete calls, repeated tool rounds and revoked permission produce recoverable reply errors. Both requests use the normal authenticated, cancellable chat proxy and context checks; when web search is enabled, each request receives search context. Conversation changes await the outgoing stream, which checks for cancellation between tool rounds before executing the clock. The completed exchange is stored as `toolMessages` on the assistant answer, alongside each answer version, and displayed under **Used Current Date & Time**. Requests and context/compaction counts expand these into assistant/tool messages without changing transcript indices. Summary generation receives older tool results as data and never advertises tools.

---

## Reasoning / Thinking Support

Flags for reasoning/thinking models:
- `-rea` (enum: auto/on/off): Enable or disable reasoning/thinking mode.
- `--reasoning-budget` (int): Token budget for thinking (-1 = unlimited, 0 = off).
- Preserve Reasoning (enum): Auto omits both flags and inherits the binary default; current llama.cpp enables preservation for templates with `supports_preserve_reasoning` capability. Enabled emits `--reasoning-preserve`; Disabled emits `--no-reasoning-preserve`. Preservation requires a compatible template and can increase context and token usage. Older binaries retain their own default in Auto.
- **Default Reasoning Effort** (enum: Auto/Low/Medium/High/XHigh): Server-wide template default for Chat, API clients, and external harnesses. Auto omits the flag; other values emit the native `--reasoning-effort` flag on llama.cpp b10434+ (gated by the installed build tag from `/api/status`; the custom backend and older installs stay on the legacy path). Per-request `reasoning_effort` overrides the launch default.
- `--chat-template-kwargs` (bool, flag: `preserve_thinking`): Legacy compatibility path. When enabled, passes `{"preserve_thinking":true}` to the chat template engine.

Legacy `reasoning_preserve` preset values migrate without changing launch behavior: `true` becomes `enabled`; `false` or a missing value becomes `auto`, never an explicit disable. New presets store `auto`, `enabled`, or `disabled`. The positive/negative flags and default were verified against upstream [common/arg.cpp](https://github.com/ggml-org/llama.cpp/blob/master/common/arg.cpp) on 2026-09-07.

On pre-b10434 binaries (and the custom backend), legacy `preserve_thinking` and Default Reasoning Effort share one merged `--chat-template-kwargs` JSON object when both are enabled, because those builds reject the native flag; on b10434+ each emits its own flag.

The Chat settings sidebar also provides a per-conversation **Reasoning Effort** selector: Auto, Off, Low, Medium, High, or XHigh. Auto omits request overrides. Off sends top-level `reasoning_effort=none` plus matching `enable_thinking=false` / `reasoning_effort=none` template kwargs; the effort levels send top-level `reasoning_effort` (native since llama.cpp b10434, where it takes final precedence over the server default) together with the `enable_thinking=true` / `reasoning_effort` `chat_template_kwargs` fallback for older builds, allowing compatible model-provided Jinja templates to apply their native reasoning controls without mapping them to llama.cpp token budgets. When the running server reports `chat_template_caps.supports_reasoning_effort: false` on `/props` (proxied as `GET /api/llama/props`), the selector shows an explanatory hint; the control stays enabled because the capability is boolean-only and cannot say which levels a given model accepts. Stored assistant reasoning is returned as `reasoning_content` on later turns, including when web-search context is injected, so templates with preserved-thinking support receive the complete trace.

---

## Custom Launch Args

The Configure tab includes an advanced `Custom Launch Args` textarea near the command preview.

### Behavior

- The raw value is stored in shared launch state as `custom_args`; do not keep a separate per-tab copy.
- `flagCore.parseCustomLaunchArgs()` tokenizes shell-like input with whitespace splitting, single/double quotes, escaped whitespace, escaped quotes, and escaped backslashes.
- Ordinary backslashes before non-special characters are preserved so Windows paths such as `C:\temp\llama.log` remain intact.
- Parsed custom tokens are appended after UI-managed flags. If a custom token duplicates a known UI-managed flag, show a warning but still allow launch.
- `--api-key` may be used for a one-off launch through Custom Launch Args, but presets containing it cannot be saved, updated, imported, or exported. Legacy preset files have the entire sensitive `custom_args` value removed when loaded.
- Parser errors (unmatched quotes, unfinished double-quoted escapes) must show near the textarea, mark the command preview as blocked, and prevent `/api/launch`.
- Presets store the raw textarea value under `flags.custom_args` and should preserve it through save, update, load, import, and export.

### Validation

- Run `node tests/frontend/custom_launch_args_unit.cjs` after parser changes.
- Run `npm run test:frontend` after mirrored-control, custom-args, flag-state, or command-preview changes when Playwright is available.

---

## Configuration Search

The Configure tab has a search input that filters visible flags in real-time.

- Searches across: flag name (`--flag`), label, id, description, short description, beginner tip, submenu name, and all option labels/values.
- When a search query is active, `openMatchingSearchSections()` expands all accordion categories, plus every submenu holding at least one matching flag — so a match is never hidden behind a collapsed submenu header.
- The user's own submenu state is snapshotted into `savedOpenSubmenus` when a search begins and restored when the query is cleared, so searching does not destroy it. `resetOpenCategories()` (called on tool change) discards the snapshot, because submenu keys from the previous tool may no longer exist.
- Partial matches are highlighted; unmatched flags within a category are hidden.
- Empty results show "No configuration options match your search."
- Escape key or clear button resets the search and restores the pre-search submenu state. Categories opened by the search stay open.
- "Expand All" opens all categories and submenus. "Collapse All" closes them.
- "Reset to defaults…" opens a confirmation dialog and replaces shared flag values with the app defaults, clearing Custom Launch Args. It keeps the selected model/tool, saved presets, chats, and active runtime; Cancel or Escape leaves settings intact.
- Individual categories remember their open/closed state via `openCategories` Set; submenus via `openSubmenus`, keyed `"<categoryId>::<submenuName>"`.

---

## Chat context budgeting

The composer previews the selected conversation, current system instructions and draft through `POST /api/chat/context`, debounced by 500 ms. The same body builder supplies completions. Pending previews are discarded on conversation/settings/runtime changes and while sending. The meter and detailed counts are tucked into Context usage in the composer’s ⋯ tools menu. Only near-full/overflow warnings appear inline, with a Details action. Escape, outside click, and leaving the popup close it; Escape returns focus to the trigger. This meter is separate from shared slot-occupancy statistics.

`backend/services/chat_context.py` reads the running server's `/props` (`default_generation_settings.n_ctx`, already per slot), then uses `/v1/chat/completions/input_tokens`. When that endpoint is absent, text requests fall back to `/apply-template` and `/tokenize` with `add_special` and `parse_special` enabled. The template receives the same reasoning and request options. Media requests require native counting. No Configure context value or character estimate substitutes for server data.

An explicit output limit reserves the requested tokens, including reasoning. Otherwise a finite running-server default is reserved; unlimited/unknown output uses advisory headroom of one quarter of context, capped at 1,024 tokens. That headroom does not change generation limits or block an otherwise fitting prompt. A prompt at or above capacity, or a prompt plus finite reserve above capacity, is refused before inference with recovery instructions.

The preview does not run web searches. Completions count again after injecting fetched source material, emitting a `context_budget` SSE event before generation. Missing/failed counting endpoints produce an unavailable state in Context usage and leave final validation to llama-server. Optional automatic compaction is off by default; when enabled, Send obtains a fresh count for the exact pending request, summarizes at most once when near or over capacity, remeasures, and pauses safely if summary generation or the follow-up count fails. Server builds with incompatible templates or tokenizer behavior can still reject a request; those failures remain recoverable.

Upstream behavior checked against [server-context.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp) and [server API documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) on 2026-09-04.

---

## Manual chat compaction

`Compact conversation` lives in the composer’s ⋯ tools menu and is enabled when older messages exist beyond the last two user turns. It becomes Cancel during summarization, with progress and recovery details inside the popup. After compaction, the menu offers View summary (opens the transcript marker) and Undo compaction. The collapsed marker also retains its Undo action.

The same menu contains the opt-in automatic-compaction toggle. Manual and automatic compaction share the same reversible summary records and transcript-preservation rules.

`chat-compaction.js` counts each summary request, including its instructions and a fixed output reserve (up to 1,024 tokens, at most a quarter of capacity). Oversized history is processed in progressively smaller message chunks, merging the previous summary each time. A single message that cannot fit causes an actionable failure; no text is silently truncated. Search is off for summaries, and reasoning is requested off without changing the user's settings. Only complete, nonempty summaries that reduce tokens and fit the recent history, draft, and reply reserve are applied.

The existing `/api/chat/completions` route strips `gui_require_context` and refuses summary generation when counting is unavailable. Ordinary chat retains its existing unavailable-count fallback. Web results are still checked at send time.

Stored conversations retain their complete `messages` array (including reasoning, sources, and answer versions) and a separate `compactions` stack of `{end, summary, savedTokens}` records. Requests use the newest summary as a synthetic user/assistant pair followed by messages from `end` onward, keeping the current system prompt separate. Undo pops a summary record without deleting later turns; undoing messages across its boundary also invalidates it. Failed/cancelled summaries never change working context. Conversation switches await cancellation, and changed drafts/settings/runtime invalidate pending results. Reopening a conversation restores its summary and marker.

---

## Frontend Smoke Tests

`tests/frontend/flag_sync_smoke.cjs` serves the static `ui/` directory, stubs backend API calls with Playwright routes, and verifies the shared-state contract:
- Quick Launch context syncs to Configure and command preview.
- Configure GPU and metrics controls sync back to Quick Launch.
- Chat temperature accepts two-decimal values such as `0.31`.
- Quick Launch sampler edits sync to Chat, Configure, shared flag state, and launch args.
- Custom Launch Args update shared state, command preview, launch args, and launch blocking on parser errors.
- API-key controls sync across Configure and Quick Launch, generated/manual keys authenticate Chat and stats, and rendered commands never expose the secret.
- The Presets browser list is a single tab stop, arrow keys skip collapsed groups' rows, only the focused row's controls stay tabbable, and focus survives the re-render that selecting a preset triggers.

When running local browser smoke checks manually, serve `ui/` as the web root. Serving from the repo root will break root-relative assets such as `/js/app.js`.

Playwright is a dev/CI-only Node dependency:
- Use `npm ci`, `npx playwright install chromium`, and `npm run test:frontend` for frontend smoke checks.
- Do not add Playwright to `requirements.txt`, launch scripts, Pinokio setup, or app update dependency installation.
- Normal runtime installs should remain Python-only through `pip install -r requirements.txt`.

---

## Native File Picker

Path-type flags (model, mmproj, draft model, etc.) have a "Browse" button that opens a native OS file dialog. The models-folder Change button uses the matching native directory picker. Windows/Linux use tkinter; macOS uses `osascript`.

### Backend

`POST /api/select-file` accepts:
- `purpose`: Determines initial directory and file type filters.
- `title`: Dialog window title.

Returns `{"selected": bool, "path": string}`.

`POST /api/select-folder` accepts an optional `title` and returns the same shape. Cancellation returns an empty path and never changes `models_dir`; the caller must persist a selected folder through `POST /api/models-dir`.

### File Type Filters

- Model files (purpose: model, model_draft, mmproj): `*.gguf`, plus `*.*` as an escape hatch. Their initial directory is the active model root. `purpose` is the flag id; `model` has no path flag today (the main model is a dropdown) and is listed so a future one gets the right folder and filter.
- Other paths (grammar file, log file, etc.): `*.*`

---

## Local Search Notes

Prefer `rg` for local search. On Windows/PowerShell, use patterns like `rg -n "pattern" ui/js` or `rg -n -g "*.js" "pattern" ui/js`; avoid path globs like `rg "pattern" ui/js/*.js` because they can produce `os error 123`.

---

## Documentation Index

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent workflow rules, pitfalls, task recipes, file ownership |
| `CONTRIBUTING.md` | Developer quickstart: setup, run, dev loop, tests, and PR checklist |
| `docs/directory.md` | This file — project structure and feature reference |
| `docs/tests.md` | Test suite layout, commands, and what each test covers |
| `docs/gpu-monitoring.md` | User setup guide for NVIDIA SMI, AMD SMI, and the optional cross-vendor all-smi collector |
| `docs/maintenance.md` | Release, dependency, compatibility, and repository maintenance guidance |
| `docs/security.md` | Security model, trust boundaries, and reporting guidance |
| `docs/troubleshooting.md` | Common installation, launch, model, GPU, and connectivity problems |
| `docs/frontend-module-split-plan.md` | Completed Tier-1 frontend module-split recipe and implementation record |
| `docs/frontend-maintainability-tier-2-plan.md` | Proposed Tier-2 frontend maintainability scope, module boundaries, implementation order, and verification gates |
| `docs/images/` | Screenshots used by README.md |
