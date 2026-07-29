# Llama GUI — Project Reference

> **Companion to `AGENTS.md`.** This file is the reference manual for the codebase: architecture, data flow, feature details, and API contracts. `AGENTS.md` contains agent workflow rules, pitfalls, and task recipes.

---

## Architecture

- **Backend:** Python stdlib `http.server` (no framework). Serves static `ui/` and provides JSON/SSE API endpoints.
- **Frontend:** Vanilla HTML/CSS/JS loaded as ordered global `<script>` tags (no bundler, no ES modules). Each module attaches to `window.LlamaGui`.
- **Entry point:** `python server.py` → 26-line compat wrapper → delegates to `backend/app.py`.
- **GUI server:** `127.0.0.1:5240` by default; `LLAMA_GUI_HOST` and `LLAMA_GUI_PORT` can override the bind address for headless/LAN access.
- **llama-server:** Runs separately (default port 8080) as a subprocess.
- **Dependencies:** `certifi` (SSL cert bundle), `ddgs` (DuckDuckGo web search), `huggingface_hub` (HF model downloads).
- **State persistence:** `config.json` (installed version, active backend, tag).
- **Thread safety:** All stateful operations (process, download, tunnel, install) use threading locks.

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
| `ui/templates/` | 15 bundled Jinja chat template files |
| `tests/` | Frontend (Node/Playwright) + backend (unittest) tests |
| `docs/` | Documentation: todo, flag audit, architecture, bugtracker |
| `llama/` | Downloaded `llama.cpp` binaries at runtime |
| `models/` | User model files (.gguf), in any subfolder; `models/mmproj/` is reserved for projectors |
| `presets/` | Saved launcher preset JSON files |
| `tools/` | Auto-downloaded `cloudflared` binary |
| `scripts/` | `create_windows_shortcuts.ps1` |
| `.launcher/` | Pinokio launcher integration (`launch-llama-gui.ps1`) |
| `assets/` | App icon (`Llama-GUI.ico`) |
| `requirements.txt` | `certifi`, `ddgs`, `huggingface_hub` |
| `package.json` | Playwright devDependency + test scripts |

---

## Backend

### Core Modules

| Module | Role |
|--------|------|
| `backend/app.py` | HTTP handler, CORS, proxy, route registry, main() |
| `backend/config.py` | Path constants, env var parsing, web search limits |
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
- Native file picker (tkinter) for selecting model files and paths.
- CORS origin validation restricts API access to loopback origins for the configured GUI port, trusted `LLAMA_GUI_ALLOWED_HOSTS` entries when wildcard-bound, and the active tunnel URL.
- Graceful shutdown/restart with port availability polling.

### Route Modules (`backend/routes/`)

| Route | Endpoints |
|-------|-----------|
| `chat.py` | `/api/chat/completions` — SSE proxy with web search |
| `external_server.py` | `/api/chat/target` — register (POST), read (GET), or clear (DELETE) an externally started llama-server as the proxy target; `POST {"restore": true}` re-registers the address saved by an earlier session |
| `benchmarks.py` | `/api/benchmark/wikitext2` — ensure WikiText-2 raw test file exists |
| `process.py` | `/api/launch`, `/api/launch/preflight`, `/api/presets/fingerprint`, `/api/llama/health`, generation-bound `/api/stop`, `/api/output`, `/api/send-input`, `/api/cleanup-llama` |
| `install.py` | `/api/releases`, `/api/install`, `/api/update`, `/api/download-progress` |
| `metrics.py` | `/api/llama/metrics`, `/api/llama/slots` — Prometheus proxy |
| `models.py` | `/api/models` — list GGUF files recursively as `models/`-relative names |
| `presets.py` | `/api/presets` CRUD + shortcut export |
| `hf_download.py` | `/api/hf/repo-files`, `/api/hf/download`, `/api/hf/download-status`, `/api/hf/download-cancel` |
| `tunnel.py` | `/api/remote-tunnel/start`, `/api/remote-tunnel/stop`, `/api/remote-tunnel/status` |
| `git_update.py` | `/api/app-update-status`, `/api/app-update` |
| `search.py` | `/api/web-search` |
| `status.py` | `/api/status` |
| `lifecycle.py` | `/api/shutdown`, `/api/restart`, `/api/open-folder` |
| `file_picker.py` | `/api/select-file` — native tkinter dialog |

### Service Modules (`backend/services/`)

| Service | Role |
|---------|------|
| `llama_manager.py` | GitHub release fetch, install, SHA256 verify, binary extraction |
| `process_manager.py` | Process launch/stop, output streaming, arg flattening, API target parsing |
| `hf_download.py` | HF repo listing, file download with cancel, path validation |
| `web_search.py` | DuckDuckGo (`ddgs`) and optional SearXNG search, HTML-to-text, page fetching |
| `tunnel.py` | Cloudflare tunnel lifecycle, binary download, status polling |
| `git_update.py` | Git fetch/pull/status, safe dirty path classification |
| `lifecycle.py` | Server shutdown, restart, cleanup |
| `chat.py` | Chat proxy helpers (search queries, context building, local addresses) |
| `external_server.py` | Registration of an externally started llama-server, llama.cpp-aware health probing, remembered-address persistence and unattended restore, and the shared chat/metrics target + authorization resolver |
| `local_llama_http.py` | Shared local llama-server metrics and slots HTTP fetching |
| `file_picker.py` | Native tkinter file dialog |

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
4. `config-flags-ui.js` — Configure tab rendering
5. `manager.js` — GitHub releases, install, update, shared `fetchJson()`
6. `presets.js` — preset CRUD
7. `searchable-select.js` — searchable combobox wrapper for native selects (`window.LlamaGui.searchableSelect`)
8. `model-switch-ui.js` — versioned two-slot preset-reference storage and Model Switcher namespace (`window.LlamaGui.modelSwitchUi`)
9. `app-data.js` — shared Quick Launch, context, sampler, and chat slider data
10. `output-cursor.js` — shared process-output cursor consumer (`window.LlamaGui.outputCursor`)
11. `process-lifecycle.js` — guarded launch, stop, switch, restore, and health-readiness orchestration (`window.LlamaGui.processLifecycle`)
12. `sampler-presets.js` — sampler preset storage, import/export, apply behavior, and Configure controls (`window.LlamaGui.samplerPresets`)
13. `chat-rendering.js` — markdown and low-level chat DOM rendering helpers (`window.LlamaGui.chatRendering`)
14. `api-tab.js` — API endpoint/snippet rendering helpers (`window.LlamaGui.apiTab`)
15. `hf-download-ui.js` — Quick Launch Hugging Face downloader UI (`window.LlamaGui.hfDownloadUi`)
16. `remote-tunnel-ui.js` — API tab Cloudflare tunnel UI (`window.LlamaGui.remoteTunnelUi`)
17. `external-server-ui.js` — API tab controls for connecting to an externally started llama-server (`window.LlamaGui.externalServerUi`)
18. `quick-launch-ui.js` — Quick Launch controls and shared-state UI sync (`window.LlamaGui.quickLaunchUi`)
19. `chat-ui.js` — Chat tab state, streaming, history, web search, and sampler controls (`window.LlamaGui.chatUi`)
20. `benchmark-ui.js` — Benchmarking tab controls, argument adapter, output polling, and session-only summaries (`window.LlamaGui.benchmarkUi`)
21. `app.js` — main orchestration (wires everything together)

**Do not change this order.** Each file depends on the ones above it. If you add a new module, place it after its dependencies and before its consumers.

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
| `ui/js/config-flags-ui.js` | `window.LlamaGui.configFlagsUi` | Configure tab flag rendering, search/filtering, expand/collapse state, type-specific flag input builders, input restoration, and high-risk `multi_enum` warnings |
| `ui/js/manager.js` | `window.LlamaGui.manager` | GitHub release fetching, backend selection, installation progress UI, app update (git status/pull/restart), the shared `fetchJson()` utility, accepted-status observer wiring for runtime reconciliation, and the shared known-model-name cache (`getKnownModelNames()`) populated by `refreshModels()` |
| `ui/js/presets.js` | `window.LlamaGui.presets` | Preset normalization, validation, saving, loading, updating, deleting, duplicating, renaming, exporting, and importing; group-by-model library rendering with search across names, models, tools and overridden flags; favorites, warning and bulk-selection filters; the detail panel and library summary; missing-model detection; and roving arrow-key focus |
| `ui/js/searchable-select.js` | `window.LlamaGui.searchableSelect` | Searchable combobox wrapper that visually replaces a native `<select>` (button + popup with search) while keeping the select in the DOM as the source of truth for options, value, and change events |
| `ui/js/model-switch-ui.js` | `window.LlamaGui.modelSwitchUi` | Versioned two-slot saved-preset references, strict storage normalization, duplicate detection, session-only fallback, accessible Quick Launch card state/rendering, and the drag-to-confirm sidebar shortcut wired through injected preset/runtime dependencies |
| `ui/js/app-data.js` | (data) | `QUICK_PROFILES`, `BUILTIN_SAMPLER_PRESETS`, `CHAT_SAMPLER_SLIDER_MAP` |
| `ui/js/output-cursor.js` | `window.LlamaGui.outputCursor` | Shared monotonic cursor consumer for main and benchmark process-output polling |
| `ui/js/process-lifecycle.js` | `window.LlamaGui.processLifecycle` | Race-resistant launch, stop, switch, restore, authoritative-status reconciliation, generation-keyed readiness, and one-shot prolonged-load diagnostics with injectable UI hooks |
| `ui/js/sampler-presets.js` | `window.LlamaGui.samplerPresets` | Sampler preset storage, normalization, apply behavior, import/export, and Configure-tab controls; writes sampler values through injected `flagCore` |
| `ui/js/chat-rendering.js` | `window.LlamaGui.chatRendering` | Markdown and low-level chat DOM rendering helpers |
| `ui/js/api-tab.js` | `window.LlamaGui.apiTab` | API tab endpoint/snippet data, base URL and authorization helpers, and rendering; reads shared state through injected `flagCore` |
| `ui/js/hf-download-ui.js` | `window.LlamaGui.hfDownloadUi` | Quick Launch Hugging Face downloader controls, status rendering, progress polling, cancel handling, and completion flow; receives shared utilities and `flagCore` from `app.js` |
| `ui/js/remote-tunnel-ui.js` | `window.LlamaGui.remoteTunnelUi` | API tab Cloudflare tunnel controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling; receives shared utilities and endpoint helpers from `app.js` |
| `ui/js/external-server-ui.js` | `window.LlamaGui.externalServerUi` | API tab controls for registering a llama-server started outside this GUI: connect/disconnect actions, target rendering, and the status refresh that unlocks Chat; receives `fetchJson` and status helpers from `app.js` |
| `ui/js/quick-launch-ui.js` | `window.LlamaGui.quickLaunchUi` | Quick Launch profile, context, GPU, template, sampler, metrics, command preview mirror, action buttons, and event wiring; reads and writes launch state through injected `flagCore` |
| `ui/js/chat-ui.js` | `window.LlamaGui.chatUi` | Chat tab state, streaming/abort flow, web search settings, conversation history, sidebar controls, sampler sliders, and status badge updates; reads and writes launch-relevant sampler state through injected `flagCore` |
| `ui/js/benchmark-ui.js` | `window.LlamaGui.benchmarkUi` | Benchmarking tab source selection, benchmark-specific controls, compatible argument building for `llama-bench`/`llama-perplexity`, readiness/status badges, process actions, output polling, and session-only summaries |
| `ui/js/app.js` | `window.LlamaGui` (global) | Main UI orchestration. Manages tab switching, server launch/stop, output polling, stats polling, shared template helpers, toasts, module initialization, and cache-busting reload |
| `ui/css/style.css` | — | Stylesheet and responsive layout. Contains no color literals and no `[data-theme=…]` selectors — all color lives in `ui/css/tokens.css` |
| `ui/css/tokens.css` | — | Design tokens. One `:root` block of structural tokens (radius, spacing, fonts, easing) followed by one block per theme holding that theme's entire palette. Adding a theme is this file plus one `THEMES` entry in `ui/js/theme-ui.js` — nothing else |
| `ui/templates/` | — | Bundled Jinja chat template files for Kobold-style presets |

---

## Tabs

1. **Install**: Download and install `llama.cpp` releases, select backend, update app from git.
2. **Quick Launch**: One-click model launch with preset configuration, quick profiles, integrated HF model downloader.
3. **Configure**: Full CLI flag configuration for `llama-server`/`llama-cli` with search, submenus, beginner tips, command preview, and Custom Launch Args.
4. **Benchmarking**: Run `llama-bench` throughput tests and `llama-perplexity` checks from current Configure state, saved presets, or a manual model.
5. **Chat**: Streaming OpenAI-compatible chat interface with web search, conversation history, sampler sliders.
6. **API**: View and interact with the `llama.cpp` API endpoints, connect to a llama-server started outside this GUI, start/stop Cloudflare tunnel.
7. **Presets**: Browse, search, and manage saved launch configurations grouped by model, with favorites, warnings, bulk actions, duplicate/rename, and a library summary. See [Presets Tab](#presets-tab).

---

## Data Flow

- Launch-relevant UI changes route through `window.LlamaGui.flagCore` shared setters (`setFlagValue`/`setMultipleFlagValues`) to update state.
- All mirrored controls read from the same underlying `flagCore` state object (`flagValues`, selected model, and current tool).
- Configure flag rendering lives in `window.LlamaGui.configFlagsUi`, but rendered controls still read from `flagCore` and write through the shared setter path.
- Configure's Custom Launch Args textarea stores its raw value in shared `flagCore.flagValues.custom_args` through `setFlagValue("custom_args", ...)`.
- Command preview and launch args are generated from shared state (`flagCore.getLaunchArgs()`), never per-tab copies.
- Custom launch args are parsed and appended only by `flagCore.getLaunchArgs()`, after UI-managed flags and before the selected model arg.
- Benchmarking reads Configure state or saved preset JSON without mutating them, builds tool-compatible benchmark args, can prepare the official WikiText-2 raw test file through `/api/benchmark/wikitext2`, and uses `/api/launch`, `/api/stop`, `/api/output`, and `/api/status` through the existing single process slot.
- Server output is polled incrementally through the monotonic cursor contract on `/api/output`; each response includes the authoritative runtime generation so stale tabs can invalidate old output and reconcile to a replacement process.
- Chat completions are streamed via SSE from `/api/chat/completions` (backend proxies to `llama-server`).
- Stats are polled from `llama-server`'s Prometheus `/metrics` endpoint, with KV/context usage falling back through the local `/slots` proxy when `llamacpp:kv_cache_usage_ratio` is unavailable.
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
6. Append model path as `-m models/<name>` (relative path under `models/`, including subfolders; `mmproj/` is excluded from discovery).
7. Return `{ args, error, warnings }`.

`<name>` is checked by `flagCore.normalizeModelRelPath()`, which rejects absolute paths, `.`/`..` segments, empty segments, and anything not ending in `.gguf`. It is exported on the `flagCore` API and reused by `benchmark-ui.js` rather than restated, so the launch and benchmark `-m` values cannot drift apart; `benchmark-ui` fails closed if the export is missing. It stays in `flag-core.js` rather than being injected through `configure()`, so a missing `configure()` call can never disable the check.

### llama.cpp Compatibility

- `ui/js/flags/definitions.js` is the single source of truth for all CLI flags exposed in the UI.
- Before adding, removing, or modifying any flag definition, verify the flag still exists and works as documented in the upstream `llama.cpp` repository at `https://github.com/ggerganov/llama.cpp`.
- Cross-reference every flag against upstream documentation: flag name and shorthand, expected value type, valid option values for enum types, default values, and whether the flag has been renamed, deprecated, or removed.
- After any flag-related changes, confirm the generated command preview produces valid arguments that `llama-server` will accept.
- Verify that enum dropdowns only contain values still recognized by the current `llama.cpp` version.
- Check that chat template names in `ui/js/flags/chat-templates.js` match templates bundled with the installed `llama.cpp` release.
- Run `tests/frontend/flag_sync_smoke.cjs` after mirrored-control, flag-state, or command-preview changes when Playwright is available.

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
- `gemma4.jinja`
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
- Tool mode toggle (Web / API Server = llama-server, Terminal Chat = llama-cli), shown as descriptive cards
- Context size (K-formatted preset dropdown with 64K recommended + custom input, linked to fit_ctx by default)
- GPU layers (auto/0/all/custom, synced with Configure)
- Auto Fit toggle; fit target/context inputs live behind an "Advanced fit options" disclosure
- Chat template (reuses shared `chat_template` options from `ui/js/flags/chat-templates.js`)
- Sampler preset selection (load/save/delete from shared sampler preset store)
- Quick sampler sliders (temperature, top-k, top-p, min-p, repeat-penalty, presence-penalty) with live value badges
- Metrics toggle
- Optional session-only API key with masked entry, generation, copy, a "Protected" badge, and shared Configure synchronization
- Profile selector with summary text
- Readiness chips (model required; profile/context/GPU/API are informational) above the launch actions
- Collapsible launch-command preview and a sticky launch/stop action bar with a busy ("Starting…") state
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

## Presets Tab

The Presets tab (`section-presets`) is the library browser for saved launch configurations. All logic lives in `ui/js/presets.js`; styling is under `.presets-browser` in `ui/css/style.css`.

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

Missing-model detection matches each preset's model against the shared cache in `manager.js`, populated by `refreshModels()` from `/api/models`. `matchKnownModelName()` tries the full `models/`-relative path first (case-insensitive), then falls back to the file name only for legacy bare names and absolute paths. A bare name held by two subfolders is reported as `ambiguous` rather than resolved, and warns — guessing a folder would launch the wrong weights. An explicit relative path never falls back to another folder's file.

`resolvePresetModelName()` is shared by normal preset loads, Model Switcher launch preparation, and saved-preset benchmarks so every path uses the same nested filename. It matches against live model options or the benchmark model list because those carry the exact spelling the launch needs; an unresolved value is selected as-is and marked `(missing)` in the dropdown, matching what the preset warns about. When these drifted apart, a preset could report healthy while its launch emitted a path that did not exist.

Detection is deliberately conservative: an unknown list, an empty models folder, and a preset with no model all stay silent, because a preset for a model kept on another machine is legitimate.

`null` from that cache means "not known yet" and must stay distinct from a known-empty folder. The summary surfaces this as `modelsChecked`; when false, the Missing Models stat renders `—` and the health line says the check did not run rather than giving a false all-clear.

Because warnings are computed at build time, `refreshModels()` calls `refreshModelPresence()` on both its success and failure paths so an open Presets tab rebuilds. That guard keys on `#section-presets` visibility, since `#presets-list` is static markup and always present.

### Detail Panel

With a preset selected: model, tool, override count, quant, warning count, notable settings chips, and the action row — Load Preset, Duplicate, Rename, Update from Current, Export, Windows Shortcut, Favorite, and Delete.

With nothing selected: a library summary — preset count, model groups, favorites, warnings, missing models, most recently used, and a health line. The summary describes the **visible** presets, not everything on disk, so its numbers always agree with the list and the count line. Any absolute claim about library health is suppressed while a filter is active or while the model list is unchecked.

### Keyboard Navigation

The list is one composite widget rather than a few hundred tab stops. At the reference size it was 33 header buttons plus 58 rows x 4 stops each = 265 stops to cross; it is now one stop to enter.

- The focus sequence is group headers plus the rows of expanded groups, in document order. Rows in a collapsed group are `display: none` and are skipped.
- Only the current item carries `tabindex="0"`. Its checkbox, favorite toggle, and Load button are restored to the tab order with it, so Tab reaches them and then leaves the list.
- Up/Down move, clamped at both ends; Home/End jump. Enter/Space still select.
- `presetRovingKey` identifies position by preset name or group key, so the full re-render that selecting or favoriting triggers restores focus to the same preset. A `focusin` listener syncs the key when focus arrives by click, Tab, or programmatic `focus()`.

### Duplicate And Rename

`duplicatePreset()` copies the *saved* preset data straight to `POST /api/presets`, so live Configure and Quick Launch values are never touched. Rename uses `POST /api/presets/rename`, which carries the `.preset-created-times` entry so "Date added" sorting survives. Case-only renames need care on Windows — see the notes in `docs/design-docs/preset-todo.md`.

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

The Chat tab (`section-chat`) is a streaming OpenAI-compatible chat interface that proxies through the Python backend.

### Architecture

The backend proxies `/api/chat/completions` to `llama-server`'s `/v1/chat/completions` endpoint:
1. Frontend sends POST with messages, sampler params, and optional web_search flag.
2. Backend resolves the destination from its own state — see [Chat Proxy Target](#chat-proxy-target) — and refuses the request when there is none.
3. Backend optionally performs web search (SearXNG when configured, otherwise DuckDuckGo), fetches result pages, injects context into the system prompt.
4. Backend proxies the request to the resolved target and streams the SSE response back to the frontend.
5. Frontend renders markdown and tracks source citations.

### Chat Proxy Target

`external_server.resolve_llama_target()` picks the destination for both the chat proxy and the metrics/slots proxies, in order:

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
- Each conversation has an id, title (derived from first user message), messages array, system prompt, and timestamp.
- Sidebar shows recent conversations with preview text and relative timestamps.
- Features: new chat, undo last message, regenerate last response, delete individual/all conversations, collapse sidebar.

### Markdown Rendering

`renderMarkdown()` in `ui/js/chat-rendering.js` converts chat output to HTML:
- Fenced code blocks with optional language attribute
- Inline code
- Bold, italic, strikethrough
- Paragraphs, line breaks

### Sampler Sliders

Chat sidebar has sliders for temperature, top-p, top-k, min-p, repeat-penalty, and max-tokens. Changes write through `window.LlamaGui.flagCore.setFlagValue()` and sync with Configure/Quick Launch.

---

## Hugging Face Model Downloader

### Backend API

- `POST /api/hf/repo-files`: Takes `repo_id`, `revision`, `token`. Uses `huggingface_hub.HfApi.model_info()` to list GGUF files. Returns separated model and mmproj file lists.
- `POST /api/hf/download`: Takes `repo_id`, `revision`, `model_file`, `mmproj_file`, `token`, `overwrite`. Downloads in a background thread with cancellation support. Validates filenames and repo IDs.
- `GET /api/hf/download-status`: Returns current download progress (total, downloaded, status, current_file, model_name, model_path, mmproj_path).
- `POST /api/hf/download-cancel`: Sets cancellation event to abort in-progress download.

### Frontend Flow

1. User enters a HF repo ID (e.g., `ggml-org/gemma-3-1b-it-GGUF`).
2. "Find Files" fetches available GGUF files.
3. User selects a model file and optional mmproj file.
4. "Download" starts the download with progress bar.
5. On completion, the model is auto-selected in the model dropdown and command preview updates.

### Download Layout

- Models land in `models/<slug>/<file>.gguf`, projectors in `models/mmproj/<slug>/<file>.gguf`, where `<slug>` is `slugify_repo_id(repo_id)`.
- `model_name` in the status payload is the `models/`-relative path (`<slug>/<file>.gguf`), so it matches `/api/models` and `applyPresetModel()` can select it directly.
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

## Auto-Update System

### How It Works

1. `GET /api/app-update-status` (with `fetch=true`) runs `git fetch origin --prune --prune-tags --tags`, then finds the newest release tag reachable from `origin/<release branch>`.
2. Dirty git paths are classified as "safe" (ignored directories, cache dirs, data suffixes) or "blocking" (source file changes).
3. If the local branch is behind that tagged release and has no blocking changes, auto-update is available. Untagged commits after the latest release do not trigger an update.
4. `POST /api/app-update` fast-forwards the current branch to the release tag, then reinstalls `requirements.txt` via pip.
5. After success, the server restarts and the frontend reloads with cache busting.

### Release Tag Selection

The release branch is `APP_RELEASE_BRANCH` in `backend/config.py` (default `main`), exposed as `ServerConfig.app_release_branch`. Tags are always looked up on `origin/<release branch>`, never on the checked-out branch, so a user sitting on a development branch is still offered the newest published release.

`find_latest_release_tag()` runs `git for-each-ref --merged=origin/<release branch> --sort=-v:refname 'refs/tags/v[0-9]*'` and keeps the first tag matching `RELEASE_TAG_RE` (`^v\d+\.\d+\.\d+[a-z]?$`).

- Version sort, not date sort. The tags are lightweight, so `--sort=-creatordate` would compare commit dates and misplace a hotfix tagged onto an older commit. Version sort orders `v1.6.3 < v1.6.3b < v1.6.4 < v1.6.10`.
- The glob drops non-version tags such as `Summer-2026`; the regex drops prerelease tags such as `v1.6.3-rc1` and `v1.6.3-beta`. A single-letter revision suffix (`v1.6.3b`) is a normal release and is kept.
- `--prune-tags` is required alongside `--prune`; without it a tag deleted upstream stays local and can still be picked as newest.

### Status States

`state` is one of:

| State | Meaning | Auto-update |
| --- | --- | --- |
| `up_to_date` | HEAD already contains the release tag (including local commits made after it) | No |
| `behind` | The release is a strict descendant of HEAD, so `merge --ff-only` can succeed | Yes, unless blocking changes exist |
| `diverged` | HEAD and the release have both moved; manual merge/rebase required | No |
| `no_release` | No tag on the release branch matched the release pattern | No |
| `error` | A git command failed or the upstream branch is missing; `reason` holds the detail | No |

Every failure path sets `state: "error"` and a human-readable `reason`. The frontend keys off `state`, so a path without it would fall through to a generic message and the git error would be lost. `release_tag` and `release_branch` are included on all states past the initial git checks.

When `LLAMA_GUI_SUPERVISED=1`, restart requests exit cleanly with status `75` instead of spawning a detached replacement process. An external launcher or service manager can use that status to relaunch `python server.py`; ordinary shutdowns still exit with status `0`. Standalone launches retain the existing self-restart behavior.

### Dependency Installation

`install_python_dependencies()` runs `pip install -r requirements.txt` and reports success/failure. Called after the fast-forward to the release tag and exposed as `POST /api/install-deps`.

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

### Model Load Mode

The Context & Memory category exposes `--load-mode` with llama.cpp's `none`, `mmap`, `mlock`, and `dio` modes. The deprecated mmap, mlock, and Direct I/O controls remain available for older builds. When an explicit load mode is selected, command generation suppresses those overlapping legacy arguments so only `--load-mode` is emitted.

---

## Server Stats & Metrics

Live performance metrics are polled from `llama-server`'s Prometheus endpoint.

### How It Works

1. `startStatsPolling()` begins polling ~2 seconds after server launch.
2. Every 3 seconds, `pollStats()` fetches `/api/llama/metrics?host=...&port=...`.
3. The backend proxies to `llama-server`'s `/metrics` endpoint.
4. Metrics are parsed from Prometheus text format.

### Displayed Metrics

- **Prompt tokens**: Total tokens processed in prompts (delta since baseline)
- **Prompt speed**: Tokens per second during prompt ingestion
- **Generated tokens**: Total tokens generated (delta since baseline)
- **Generation speed**: Tokens per second during generation
- **Context usage**: Total prompt + generated tokens
- **KV cache usage**: Percentage of KV cache filled

The `snapshotStatsBaseline()` function resets the delta counter (called on conversation load and new chat).

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

---

## Reasoning / Thinking Support

Flags for reasoning/thinking models:
- `-rea` (enum: auto/on/off): Enable or disable reasoning/thinking mode.
- `--reasoning-budget` (int): Token budget for thinking (-1 = unlimited, 0 = off).
- `--reasoning-preserve` (bool): Preserve reasoning traces across the full chat history when the selected template supports llama.cpp's preserve-reasoning capability.
- `--chat-template-kwargs` (bool, flag: `preserve_thinking`): Legacy compatibility path. When enabled, passes `{"preserve_thinking":true}` to the chat template engine.

If `reasoning_preserve` is true, the launch arg is `--reasoning-preserve`. If legacy `preserve_thinking` is true, the launch arg is `--chat-template-kwargs {"preserve_thinking":true}`.

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
- Individual categories remember their open/closed state via `openCategories` Set; submenus via `openSubmenus`, keyed `"<categoryId>::<submenuName>"`.

---

## Frontend Smoke Tests

`tests/frontend/flag_sync_smoke.cjs` serves the static `ui/` directory, stubs backend API calls with Playwright routes, and verifies the shared-state contract:
- Quick Launch context syncs to Configure and command preview.
- Configure GPU and metrics controls sync back to Quick Launch.
- Chat temperature accepts two-decimal values such as `0.31`.
- Quick Launch sampler edits sync to Chat, Configure, shared flag state, and launch args.
- Custom Launch Args update shared state, command preview, launch args, and launch blocking on parser errors.
- API-key controls sync across Configure and Quick Launch, generated/manual keys authenticate Chat and stats, and rendered commands never expose the secret.
- The card hover gradient reaches into the rounded top corner without filling outside the card outline.
- The Presets browser list is a single tab stop, arrow keys skip collapsed groups' rows, only the focused row's controls stay tabbable, and focus survives the re-render that selecting a preset triggers.

When running local browser smoke checks manually, serve `ui/` as the web root. Serving from the repo root will break root-relative assets such as `/js/app.js`.

Playwright is a dev/CI-only Node dependency:
- Use `npm ci`, `npx playwright install chromium`, and `npm run test:frontend` for frontend smoke checks.
- Do not add Playwright to `requirements.txt`, launch scripts, Pinokio setup, or app update dependency installation.
- Normal runtime installs should remain Python-only through `pip install -r requirements.txt`.

---

## Native File Picker

Path-type flags (model, mmproj, draft model, etc.) have a "Browse" button that opens a native OS file dialog via tkinter.

### Backend

`POST /api/select-file` accepts:
- `purpose`: Determines initial directory and file type filters.
- `title`: Dialog window title.

Returns `{"selected": bool, "path": string}`.

### File Type Filters

- Model files (purpose: model, model_draft, mmproj, model_vocoder): `*.gguf`, plus `*.*` as an escape hatch. `purpose` is the flag id; `model` has no path flag today (the main model is a dropdown over `models/`) and is listed so a future one gets the right folder and filter.
- Other paths (grammar file, log file, etc.): `*.*`

---

## Local Search Notes

Prefer `rg` for local search. On Windows/PowerShell, use patterns like `rg -n "pattern" ui/js` or `rg -n -g "*.js" "pattern" ui/js`; avoid path globs like `rg "pattern" ui/js/*.js` because they can produce `os error 123`.

---

## Documentation Index

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent workflow rules, pitfalls, task recipes, file ownership |
| `docs/directory.md` | This file — project structure and feature reference |
| `docs/tests.md` | Test suite layout, commands, and what each test covers |
| `docs/design-docs/todo.md` | Known planned work |
| `docs/design-docs/bugtracker.md` | Open and resolved defect notes |
| `docs/design-docs/preset-todo.md` | Presets tab UI/UX backlog — all items shipped, kept for the design reasoning |
| `docs/design-docs/router-mode.md` | Router mode design notes |
| `docs/design-docs/flag_report.md` | Archived one-time flag audit report (May 2026) |
| `docs/design-docs/llama_cpp_compat_report.md` | Current llama.cpp compatibility report |
| `docs/images/` | Screenshots used by README.md |
