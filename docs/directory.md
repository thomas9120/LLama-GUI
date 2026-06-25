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
| `ui/templates/` | 14 bundled Jinja chat template files |
| `tests/` | Frontend (Node/Playwright) + backend (unittest) tests |
| `docs/` | Documentation: todo, flag audit, architecture, bugtracker |
| `llama/` | Downloaded `llama.cpp` binaries at runtime |
| `models/` | User model files (.gguf) |
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
- Runs `llama-server`, `llama-cli`, `llama-bench`, or `llama-perplexity` as a subprocess and streams stdout/stderr.
- Downloads the official WikiText-2 raw test file for Benchmarking clean perplexity runs.
- Handles preset, model file, and Hugging Face download APIs.
- Selects binary based on platform (`win32`/`darwin`/`linux`) and backend type (e.g., `cuda-12.4`, `cuda-13.3`, `vulkan`, `hip`, `sycl`, `openvino`, `metal`).
- Proxies OpenAI-compatible chat completions (`/v1/chat/completions`) to `llama-server` with streaming SSE support.
- Built-in web search via DuckDuckGo (`ddgs` + page fetching with HTML-to-text parsing).
- Cloudflare tunnel management (auto-downloads `cloudflared`, starts/stops tunnel, returns public URL).
- Git-based app auto-updating (checks status, pulls, reinstalls dependencies, restarts server).
- Native file picker (tkinter) for selecting model files and paths.
- CORS origin validation restricts API access to loopback origins for the configured GUI port, trusted `LLAMA_GUI_ALLOWED_HOSTS` entries when wildcard-bound, and the active tunnel URL.
- Graceful shutdown/restart with port availability polling.

### Route Modules (`backend/routes/`)

| Route | Endpoints |
|-------|-----------|
| `chat.py` | `/api/chat/completions` — SSE proxy with web search |
| `benchmarks.py` | `/api/benchmark/wikitext2` — ensure WikiText-2 raw test file exists |
| `process.py` | `/api/launch`, `/api/stop`, `/api/output`, `/api/send-input`, `/api/cleanup-llama` |
| `install.py` | `/api/releases`, `/api/install`, `/api/update`, `/api/download-progress` |
| `metrics.py` | `/api/llama/metrics`, `/api/llama/slots` — Prometheus proxy |
| `models.py` | `/api/models` — list GGUF files |
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
| `web_search.py` | DuckDuckGo search, HTML-to-text, page fetching |
| `tunnel.py` | Cloudflare tunnel lifecycle, binary download, status polling |
| `git_update.py` | Git fetch/pull/status, safe dirty path classification |
| `lifecycle.py` | Server shutdown, restart, cleanup |
| `chat.py` | Chat proxy helpers (search queries, context building, local addresses) |
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
2. `flag-validation.js` — read-only validation of flag definitions
3. `flag-core.js` — shared state singleton (`window.LlamaGui.flagCore`)
4. `config-flags-ui.js` — Configure tab rendering
5. `manager.js` — GitHub releases, install, update, shared `fetchJson()`
6. `presets.js` — preset CRUD
7. `app-data.js` — shared Quick Launch, context, sampler, and chat slider data
8. `sampler-presets.js` — sampler preset storage, import/export, apply behavior, and Configure controls (`window.LlamaGui.samplerPresets`)
9. `chat-rendering.js` — markdown and low-level chat DOM rendering helpers (`window.LlamaGui.chatRendering`)
10. `api-tab.js` — API endpoint/snippet rendering helpers (`window.LlamaGui.apiTab`)
11. `hf-download-ui.js` — Quick Launch Hugging Face downloader UI (`window.LlamaGui.hfDownloadUi`)
12. `remote-tunnel-ui.js` — API tab Cloudflare tunnel UI (`window.LlamaGui.remoteTunnelUi`)
13. `quick-launch-ui.js` — Quick Launch controls and shared-state UI sync (`window.LlamaGui.quickLaunchUi`)
14. `chat-ui.js` — Chat tab state, streaming, history, web search, and sampler controls (`window.LlamaGui.chatUi`)
15. `benchmark-ui.js` — Benchmarking tab controls, argument adapter, output polling, and session-only summaries (`window.LlamaGui.benchmarkUi`)
16. `app.js` — main orchestration (wires everything together)

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
| `ui/js/flag-validation.js` | (data) | Non-blocking startup validation for flag definitions |
| `ui/js/flag-core.js` | `window.LlamaGui.flagCore` | Shared frontend flag state and launch-argument core. Owns `currentTool`, selected model, `flagValues`, shared setters, custom launch args parsing, preset apply/collect helpers, `getLaunchArgs()`, and command preview generation |
| `ui/js/config-flags-ui.js` | `window.LlamaGui.configFlagsUi` | Configure tab flag rendering, search/filtering, expand/collapse state, type-specific flag input builders, input restoration, and high-risk `multi_enum` warnings |
| `ui/js/manager.js` | `window.LlamaGui.manager` | GitHub release fetching, backend selection, installation progress UI, app update (git status/pull/restart), and the shared `fetchJson()` utility |
| `ui/js/presets.js` | `window.LlamaGui.presets` | Preset normalization, validation, saving, loading, updating, deleting, exporting, importing, and group-by-model rendering with search and collapsible groups |
| `ui/js/app-data.js` | (data) | `QUICK_PROFILES`, `BUILTIN_SAMPLER_PRESETS`, `CHAT_SAMPLER_SLIDER_MAP` |
| `ui/js/sampler-presets.js` | `window.LlamaGui.samplerPresets` | Sampler preset storage, normalization, apply behavior, import/export, and Configure-tab controls; writes sampler values through injected `flagCore` |
| `ui/js/chat-rendering.js` | `window.LlamaGui.chatRendering` | Markdown and low-level chat DOM rendering helpers |
| `ui/js/api-tab.js` | `window.LlamaGui.apiTab` | API tab endpoint/snippet data, base URL helpers, and rendering; reads shared state through injected `flagCore` |
| `ui/js/hf-download-ui.js` | `window.LlamaGui.hfDownloadUi` | Quick Launch Hugging Face downloader controls, status rendering, progress polling, cancel handling, and completion flow; receives shared utilities and `flagCore` from `app.js` |
| `ui/js/remote-tunnel-ui.js` | `window.LlamaGui.remoteTunnelUi` | API tab Cloudflare tunnel controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling; receives shared utilities and endpoint helpers from `app.js` |
| `ui/js/quick-launch-ui.js` | `window.LlamaGui.quickLaunchUi` | Quick Launch profile, context, GPU, template, sampler, metrics, command preview mirror, action buttons, and event wiring; reads and writes launch state through injected `flagCore` |
| `ui/js/chat-ui.js` | `window.LlamaGui.chatUi` | Chat tab state, streaming/abort flow, web search settings, conversation history, sidebar controls, sampler sliders, and status badge updates; reads and writes launch-relevant sampler state through injected `flagCore` |
| `ui/js/benchmark-ui.js` | `window.LlamaGui.benchmarkUi` | Benchmarking tab source selection, benchmark-specific controls, compatible argument building for `llama-bench`/`llama-perplexity`, readiness/status badges, process actions, output polling, and session-only summaries |
| `ui/js/app.js` | `window.LlamaGui` (global) | Main UI orchestration. Manages tab switching, server launch/stop, output polling, stats polling, shared template helpers, toasts, module initialization, and cache-busting reload |
| `ui/css/style.css` | — | Stylesheet implementing the dark theme (Tokyo Night) and responsive layout |
| `ui/templates/` | — | Bundled Jinja chat template files for Kobold-style presets |

---

## Tabs

1. **Install**: Download and install `llama.cpp` releases, select backend, update app from git.
2. **Quick Launch**: One-click model launch with preset configuration, quick profiles, integrated HF model downloader.
3. **Configure**: Full CLI flag configuration for `llama-server`/`llama-cli` with search, submenus, beginner tips, command preview, and Custom Launch Args.
4. **Benchmarking**: Run `llama-bench` throughput tests and `llama-perplexity` checks from current Configure state, saved presets, or a manual model.
5. **Chat**: Streaming OpenAI-compatible chat interface with web search, conversation history, sampler sliders.
6. **API**: View and interact with the `llama.cpp` API endpoints, start/stop Cloudflare tunnel.
7. **Presets**: Save, load, import, export, and manage preset configurations grouped by model.

---

## Data Flow

- Launch-relevant UI changes route through `window.LlamaGui.flagCore` shared setters (`setFlagValue`/`setMultipleFlagValues`) to update state.
- All mirrored controls read from the same underlying `flagCore` state object (`flagValues`, selected model, and current tool).
- Configure flag rendering lives in `window.LlamaGui.configFlagsUi`, but rendered controls still read from `flagCore` and write through the shared setter path.
- Configure's Custom Launch Args textarea stores its raw value in shared `flagCore.flagValues.custom_args` through `setFlagValue("custom_args", ...)`.
- Command preview and launch args are generated from shared state (`flagCore.getLaunchArgs()`), never per-tab copies.
- Custom launch args are parsed and appended only by `flagCore.getLaunchArgs()`, after UI-managed flags and before the selected model arg.
- Benchmarking reads Configure state or saved preset JSON without mutating them, builds tool-compatible benchmark args, can prepare the official WikiText-2 raw test file through `/api/benchmark/wikitext2`, and uses `/api/launch`, `/api/stop`, `/api/output`, and `/api/status` through the existing single process slot.
- Server output is polled via HTTP endpoint and streamed to the terminal panel.
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
- Types: `bool`, `int`, `float`, `text`, `path`, `enum`, `multi_enum`
- Categories: model, context, cpu, gpu, auto_fit, sampling, rope, conversation, lora, kv, speculative, server, mcp, grammar, logging, advanced
- `false_flag` for boolean negation (e.g., `--mmap` / `--no-mmap`)

### Flag Types

- **`bool`**: Checkbox. Supports `false_flag` for negation (e.g., `--no-mmap`).
- **`int`**: Numeric input with min/max/step constraints.
- **`float`**: Decimal input with min/max/step constraints.
- **`text`**: Free-form text input.
- **`path`**: Text input with native file picker "Browse" button (tkinter).
- **`enum`**: Dropdown select from a predefined options list.
- **`multi_enum`**: Multiple checkboxes for selecting zero or more values. Supports an `all` shortcut and `risk: "high"` badges with warnings for dangerous options (e.g., shell command execution).

Categories can also define `submenu` entries that render as collapsible sub-accordions within the main category.

### Launch Args Generation (`flagCore.getLaunchArgs()`)

1. Iterate `FLAGS`, filter by tool.
2. Skip inert defaults (explicit allowlist in `shouldOmitFlagValue`).
3. Skip speculative flags when not enabled.
4. Build `[flag, value]` pairs.
5. Parse + append custom args.
6. Append model path as `-m models/<name>`.
7. Return `{ args, error, warnings }`.

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
- `auto_alias`: also clears both, but exists as a named dropdown preset
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

These use a small generic Jinja message loop with preset-specific start/end tokens. Used for non-thinking variants, renamed presets that don't map cleanly to a single built-in, and special tag formats not represented by built-ins.

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

### KoboldCppAutomatic

`KoboldCppAutomatic` is a named preset that behaves like auto/template-from-model selection. It exists as a selectable label in the dropdown, but its launch behavior is: no `--chat-template`, no `--chat-template-file`. It is primarily a UI-facing alias rather than a distinct launch-format implementation.

### Backward Compatibility

- The dropdown is curated; the old built-in allowlist is still present for launch/preset compatibility.
- Older saved presets using previously exposed built-in names can still launch, but the main dropdown is no longer cluttered with legacy options.

### Reuse Pattern for Future Templates

1. Decide: `builtin`, `bundled`, or `auto`/`auto_alias`.
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
- `safe-defaults`: 16K context, auto GPU, auto-fit, Balanced sampler preset
- `balanced`: 32K context, auto GPU, auto-fit, Balanced sampler preset
- `long-context`: 128K context, auto-fit, Balanced sampler preset
- `creative-chat`: 32K context, Creative sampler preset

Each profile applies a tool setting, flag values, fit linking, and sampler preset in one action.

### Controls

Quick Launch renders simplified controls for:
- Model selection (synced with Configure's model dropdown)
- Tool mode toggle (llama-server / llama-cli)
- Context size (preset dropdown + custom input, linked to fit_ctx by default)
- GPU layers (auto/0/all/custom, synced with Configure)
- Auto Fit toggle + fit target/context inputs
- Chat template (reuses shared `chat_template` options from `ui/js/flags/chat-templates.js`)
- Sampler preset selection (load/save/delete from shared sampler preset store)
- Quick sampler fields (temperature, top-k, top-p, min-p, repeat-penalty)
- Metrics toggle
- Profile selector with summary text

All controls write through `window.LlamaGui.flagCore` setters (`setFlagValue()` / `setMultipleFlagValues()`), keeping Configure and Quick Launch in sync.

### Hugging Face Download Integration

The Quick Launch tab includes a full HF model downloader section initialized by `ui/js/quick-launch-ui.js` and implemented in `ui/js/hf-download-ui.js`:
- Repo ID + revision + token inputs
- "Find Files" button fetches GGUF file listing from `/api/hf/repo-files`
- Model and mmproj file selectors
- Download progress bar with cancel support
- Auto-selects downloaded model on completion

Frontend downloader controls, status rendering, progress polling, cancel handling, and completion flow live in `ui/js/hf-download-ui.js`. `app.js` injects `fetchJson`, confirmation/model callbacks, and `flagCore`; the module must not mutate `flagValues` directly.

---

## Chat Tab

The Chat tab (`section-chat`) is a streaming OpenAI-compatible chat interface that proxies through the Python backend.

### Architecture

The backend proxies `/api/chat/completions` to `llama-server`'s `/v1/chat/completions` endpoint:
1. Frontend sends POST with messages, sampler params, and optional web_search flag.
2. Backend optionally performs web search via DuckDuckGo, fetches result pages, injects context into the system prompt.
3. Backend proxies the request to `llama-server` and streams the SSE response back to the frontend.
4. Frontend renders markdown and tracks source citations.

### Web Search

When the web search toggle is enabled:
- The backend extracts the latest user message and queries DuckDuckGo.
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

### Safety

- Repo IDs, revisions, and filenames are validated with strict regex and path traversal checks.
- Only `.gguf` files can be downloaded.
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

1. `GET /api/app-update-status` (with `fetch=true`) runs `git fetch --prune origin`, then checks `git rev-list --left-right --count HEAD...origin/<branch>`.
2. Dirty git paths are classified as "safe" (ignored directories, cache dirs, data suffixes) or "blocking" (source file changes).
3. If the local branch is behind origin and has no blocking changes, auto-update is available.
4. `POST /api/app-update` runs `git pull --ff-only`, then reinstalls `requirements.txt` via pip.
5. After success, the server restarts and the frontend reloads with cache busting.

### Dependency Installation

`install_python_dependencies()` runs `pip install -r requirements.txt` and reports success/failure. Called after git pull and exposed as `POST /api/install-deps`.

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
| **Neutral** | 1.0 | 200 | 1.0 | 0 | 1.0 | 64 |
| **Balanced** | 1.0 | 0 | 0.95 | 0.1 | 1.03 | 64 |
| **Creative** | 1.0 | 100 | 0.98 | 0 | 1.1 | 64 |
| **Precise** | 0.3 | 25 | 0.6 | 0 | 1.02 | 64 |

### Custom Presets

- Stored in `localStorage` under `llama_gui_sampler_presets_v1`.
- Saved from current sampler values with user-defined names.
- Unique name generation handles collisions (e.g., "Creative (2)").
- Load, save, delete, export (single JSON file), and import (single or batch JSON) operations.

### Integration

- Configure tab: Sampler Preset controls appear at the top of the Sampling accordion.
- Quick Launch tab: Sampler Preset controls in the sampler section.
- Quick profiles reference preset names (e.g., `samplerPresetName: "Balanced"`).
- Loading a preset calls `window.LlamaGui.samplerPresets.applySamplerPresetValues()` which writes through `window.LlamaGui.flagCore.setMultipleFlagValues()`.

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
  - `write_file`, `edit_file`, `apply_diff`: File modification tools (high risk)

When a high-risk tool is selected, a warning message appears.

---

## Reasoning / Thinking Support

Flags for reasoning/thinking models:
- `-rea` (enum: auto/on/off): Enable or disable reasoning/thinking mode.
- `--reasoning-budget` (int): Token budget for thinking (-1 = unlimited, 0 = off).
- `--chat-template-kwargs` (bool, flag: `preserve_thinking`): When enabled, passes `{"preserve_thinking":true}` to the chat template engine. Required for models like Qwen3, DeepSeek-R1 to show chain-of-thought output.

If `preserve_thinking` is true and the flag passes the inert-default filter, the launch arg is `--chat-template-kwargs {"preserve_thinking":true}`.

---

## Custom Launch Args

The Configure tab includes an advanced `Custom Launch Args` textarea near the command preview.

### Behavior

- The raw value is stored in shared launch state as `custom_args`; do not keep a separate per-tab copy.
- `flagCore.parseCustomLaunchArgs()` tokenizes shell-like input with whitespace splitting, single/double quotes, escaped whitespace, escaped quotes, and escaped backslashes.
- Ordinary backslashes before non-special characters are preserved so Windows paths such as `C:\temp\llama.log` remain intact.
- Parsed custom tokens are appended after UI-managed flags. If a custom token duplicates a known UI-managed flag, show a warning but still allow launch.
- Parser errors (unmatched quotes, unfinished double-quoted escapes) must show near the textarea, mark the command preview as blocked, and prevent `/api/launch`.
- Presets store the raw textarea value under `flags.custom_args` and should preserve it through save, update, load, import, and export.

### Validation

- Run `node tests/frontend/custom_launch_args_unit.cjs` after parser changes.
- Run `npm run test:frontend` after mirrored-control, custom-args, flag-state, or command-preview changes when Playwright is available.

---

## Configuration Search

The Configure tab has a search input that filters visible flags in real-time.

- Searches across: flag name (`--flag`), label, id, description, short description, beginner tip, submenu name, and all option labels/values.
- When a search query is active, all accordion categories automatically expand to show matching flags.
- Partial matches are highlighted; unmatched flags within a category are hidden.
- Empty results show "No configuration options match your search."
- Escape key or clear button resets the search and collapses all categories.
- "Expand All" opens all categories and submenus. "Collapse All" closes them.
- Individual categories remember their open/closed state via `openCategories` Set.
- Individual submenus remember their state via `openSubmenus` Set.

---

## Frontend Smoke Tests

`tests/frontend/flag_sync_smoke.cjs` serves the static `ui/` directory, stubs backend API calls with Playwright routes, and verifies the shared-state contract:
- Quick Launch context syncs to Configure and command preview.
- Configure GPU and metrics controls sync back to Quick Launch.
- Chat temperature accepts two-decimal values such as `0.31`.
- Quick Launch sampler edits sync to Chat, Configure, shared flag state, and launch args.
- Custom Launch Args update shared state, command preview, launch args, and launch blocking on parser errors.

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

- Model files (purpose: model, model_draft, mmproj, model_vocoder): `*.gguf`, `*.bin`
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
| `docs/todo.md` | Known planned work |
| `docs/flag_report.md` | Archived one-time flag audit report (May 2026) |
| `docs/llama_cpp_compat_report.md` | Current llama.cpp compatibility report |
| `docs/frontend_flag_core_plan.md` | Completed phased plan for extracting flag state |
| `docs/archive/` | Archived plans (backend architecture, progress) |
| `docs/images/` | Screenshots used by README.md |
