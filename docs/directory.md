# Llama GUI - Directory Overview

**What it is:** A lightweight browser-based launcher and control panel for `llama.cpp`, supporting Windows, macOS, and Linux.

## Architecture

- **Backend:** `backend/` package using stdlib `http.server`; `server.py` is a 26-line compatibility wrapper that re-exports `backend.app`

- **Frontend:** Vanilla HTML/CSS/JS, served statically from `ui/`
- **Dependencies:** `certifi` (SSL verification), `ddgs` (DuckDuckGo web search), `huggingface_hub` (model downloads)
- **GUI server port:** `127.0.0.1:5240`
- **llama-server port:** `127.0.0.1:8080` (default, configurable)

## Key Components

| File / Dir | Role |
|------------|------|
| `server.py` | Thin compatibility entrypoint — delegates to `backend.app` |
| `backend/app.py` | HTTP handler, app context wiring, route registry, CORS/proxy helpers, and GUI server startup |
| `backend/config.py` | Constants and platform detection (GUI port, defaults) |
| `backend/context.py` | `AppContext`, `AppPaths`, `ServerConfig` — shared state containers |
| `backend/state.py` | `AtomicDict` and typed shared state classes with locks |
| `backend/http.py` | Request/response adapters, standardized API errors, CORS helpers, and SSE writer |
| `backend/routing.py` | Dispatch-table route matching for API routes |
| `backend/routes/` | 14 route handler modules grouped by feature (status, models, presets, metrics, chat, search, hf_download, file_picker, process, install, tunnel, git_update, lifecycle) |
| `backend/services/` | 10 service modules (llama_manager, process_manager, hf_download, web_search, tunnel, git_update, lifecycle, file_picker, chat) |
| `ui/js/app-data.js` | Shared Quick Launch profile, context preset, sampler preset, and chat sampler slider data consumed by `app.js` |
| `ui/js/chat-rendering.js` | Markdown and low-level chat DOM rendering helpers exposed as `window.LlamaGui.chatRendering` |
| `ui/js/api-tab.js` | API tab endpoint/snippet data, base URL helpers, and rendering exposed as `window.LlamaGui.apiTab` |
| `ui/js/hf-download-ui.js` | Quick Launch Hugging Face downloader controls, status rendering, progress polling, cancel handling, and completion flow exposed as `window.LlamaGui.hfDownloadUi` |
| `ui/js/remote-tunnel-ui.js` | API tab Cloudflare tunnel controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling exposed as `window.LlamaGui.remoteTunnelUi` |
| `ui/js/app.js` | Main UI orchestration: tab switching, launch/stop flow, chat state/controller (streaming, web search, history), Quick Launch/sampler preset behavior, stats polling, toasts |
| `ui/js/flags/` | Ordered flag modules for exposed llama.cpp flag categories, option lists, chat template presets, flag definitions, and flag helpers |
| `ui/js/flag-core.js` | Shared frontend flag state and launch-argument core (`currentTool`, selected model, `flagValues`, setters, preset apply/collect helpers, command preview generation) |
| `ui/js/config-flags-ui.js` | Configure tab flag rendering, search/filtering, expand/collapse state, type-specific flag input builders, input restoration, and high-risk `multi_enum` warnings |
| `ui/js/flag-validation.js` | Non-blocking startup validation for loaded flag definitions (duplicate ids, invalid categories/tools/types, enum options, default value shape, duplicate CLI flags) |
| `ui/js/manager.js` | Install flow, GitHub release fetch, backend selection, status polling, app auto-update (git), confirmation modal |
| `ui/js/presets.js` | Launcher preset save/load/update/delete with group-by-model rendering, collapsible groups, search/filter, warnings, import/export |
| `ui/index.html` | Tabbed UI: Install, Quick Launch, Configure, Chat, API, Presets |
| `ui/css/style.css` | Dark theme (Tokyo Night) stylesheet, responsive layout |
| `ui/templates/` | 14 bundled Jinja chat template files for Kobold-style presets |
| `config.json` | Persists installed version, backend type, and release tag |
| `tools/cloudflared/` | Auto-downloaded Cloudflare tunnel binary |
| `requirements.txt` | Python dependencies (certifi, ddgs, huggingface_hub) |
| `tests/backend/` | Backend pytest coverage for baseline behavior, HTTP adapters, routing, services, and extracted routes |
| `tests/frontend/flag_sync_smoke.cjs` | Playwright smoke test for shared flag state sync across Quick Launch, Configure, Chat sampler controls, launch args, and command preview |

## Tabs

1. **Install** — Download/install llama.cpp binaries by backend (CPU/CUDA/Vulkan/SYCL/HIP/Metal/ROCm), app auto-update from git
2. **Quick Launch** — Beginner-friendly launch with profiles, integrated HF model downloader, sampler presets, shared state with Configure
3. **Configure** — Full flag-by-flag control with search, expand/collapse, beginner tips, submenus, command preview, path picker, multi-select with risk badges
4. **Chat** — Streaming OpenAI-compatible chat with web search, conversation history (localStorage), markdown rendering, sampler sliders, system prompt, suggestion chips
5. **API** — OpenAI-compatible endpoint docs, copy-ready code snippets (cURL/Python/JS), Cloudflare tunnel start/stop
6. **Presets** — Save/load full launcher configurations as JSON, grouped by model with search, expand/collapse, warnings, import/export

## Shared State Pattern

All launch-relevant settings flow through the shared flag core in `ui/js/flag-core.js`. Quick Launch, Configure, Chat, Presets, launch/stop, API helpers, and metrics helpers read/write through `window.LlamaGui.flagCore`, which owns `currentTool`, selected model, and the single `flagValues` object.

Configure flag rendering lives in `ui/js/config-flags-ui.js`, but rendered controls still read from `flagCore` and write through the shared setter path. Command preview and launch args are generated from `flagCore.getLaunchArgs()`, never from per-tab copies.

Frontend modules are still loaded as ordered global scripts rather than ES modules. New focused modules should attach their public API under `window.LlamaGui`, load after their dependencies, and load before `ui/js/app.js` if `app.js` consumes them.

## Chat

- Backend proxies `/v1/chat/completions` to `llama-server` with SSE streaming
- Chat markdown and low-level message rendering live in `ui/js/chat-rendering.js`
- Optional DuckDuckGo web search injects source citations into the system prompt
- Conversations stored in `localStorage` with title, messages, system prompt, timestamp
- Sampler sliders in the sidebar write through `setFlagValue()` and sync with Configure/Quick Launch

## API Tab

- API endpoint cards and copy-ready snippets live in `ui/js/api-tab.js`
- The module reads host, port, alias, selected model, API key, and current tool from shared `flagCore` state
- `app.js` injects shared utilities/status access and initializes the remote tunnel module

## Hugging Face Download

Integrated model downloader in the Quick Launch tab:
- Frontend controls, status rendering, progress polling, cancel handling, and completion flow live in `ui/js/hf-download-ui.js`
- Browse HF repos for GGUF files via `/api/hf/repo-files`
- Download models + optional mmproj files with progress bar and cancel support
- Path/filename validation prevents traversal attacks
- Auto-selects downloaded model on completion

## Cloudflare Tunnel

Remote tunnel in the API tab:
- Frontend controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling live in `ui/js/remote-tunnel-ui.js`
- Auto-downloads `cloudflared` binary on first use
- Tunnel URL is added to allowed CORS origins
- Status polling every 2 seconds while running/starting

## Auto-Update

Git-based app updating in the Install tab:
- `git fetch --prune`, checks `HEAD...origin/<branch>`
- Classifies dirty paths as safe (data/cache) or blocking (source changes)
- Pulls, reinstalls dependencies, restarts server

## Sampler Presets

Built-in (Neutral/Balanced/Creative/Precise) + custom presets:
- Stored in `localStorage` under `llama_gui_sampler_presets_v1`
- Save/load/delete/export/import with deduplication
- Shared across Configure and Quick Launch tabs
- Built-ins are tuned as KoboldCpp-style simple equivalents while preserving the existing preset names

## Server Metrics

Live Prometheus stats polled from `llama-server`:
- Prompt/gen token counts and speeds, KV cache usage
- Polling starts ~2s after launch, every 3s

## Frontend Smoke Tests

`tests/frontend/flag_sync_smoke.cjs` serves the static `ui/` directory, stubs backend API calls with Playwright routes, and verifies the shared-state contract:
- Quick Launch context syncs to Configure and command preview
- Configure GPU and metrics controls sync back to Quick Launch
- Chat temperature accepts two-decimal values such as `0.31`
- Quick Launch sampler edits sync to Chat, Configure, shared flag state, and launch args

## MCP / Agent Tools

Configure tab > Server category > MCP Settings submenu:
- WebUI MCP Proxy toggle
- Built-in Tools (`multi_enum`): read-only and file/shell tools with high-risk warnings

## Reasoning Support

Flags in Configure tab > Conversation category:
- `-rea` (auto/on/off), `--reasoning-budget`, `--chat-template-kwargs {"preserve_thinking":true}`

## Configuration Search

Configure tab search bar:
- Matches flag name, label, description, options
- Auto-expands categories, partial match highlighting, clear button + Escape to reset
- The Configure tab includes an advanced Custom Launch Args textarea near the command preview.

## AGENTS.md Rule

The `AGENTS.md` file enforces that any setting appearing in multiple UI locations must use the same shared state object, setter, and options source — no per-tab copies.

## Documentation

| File | Purpose |
|------|---------|
| `docs/agent-workflows.md` | Agent reference for flag audits and chat template updates |
| `docs/directory.md` | This file — project structure overview |
| `docs/archive/backend_architecture_plan.md` | Plan for the completed backend refactor |
| `docs/archive/backend_progress.md` | Progress tracker for the completed backend refactor |
| `docs/flag_report.md` | One-time flag audit report (May 2026) |
| `docs/frontend_flag_core_plan.md` | Completed phased plan for extracting flag state, launch args, Configure rendering, caller migration, and smoke coverage |
| `docs/frontend_modularization.md` | Plan for future frontend modularization |
| `docs/images/` | 6 screenshots used by README.md |
