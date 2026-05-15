# Llama GUI - Directory Overview

**What it is:** A lightweight browser-based launcher and control panel for `llama.cpp`, supporting Windows, macOS, and Linux.

## Architecture

- **Backend:** `backend/` package using stdlib `http.server`; `server.py` remains the compatibility entrypoint

- **Frontend:** Vanilla HTML/CSS/JS, served statically from `ui/`
- **Dependencies:** `certifi` (SSL verification), `ddgs` (DuckDuckGo web search), `huggingface_hub` (model downloads)
- **GUI server port:** `127.0.0.1:5240`
- **llama-server port:** `127.0.0.1:8080` (default, configurable)

## Key Components

| File / Dir | Role |
|------------|------|
| `server.py` | Small compatibility wrapper that re-exports `backend.app` and starts `main()` when executed |
| `backend/app.py` | HTTP handler, app context wiring, route registry, CORS/proxy helpers, and GUI server startup |
| `backend/routes/` | API route handlers grouped by feature |
| `backend/services/` | Feature services for llama.cpp install/processes, HF downloads, web search, tunnels, git updates, lifecycle, and file picking |
| `backend/http.py` | Request/response adapters, standardized API errors, CORS helpers, and SSE writer |
| `backend/routing.py` | Dispatch-table route matching for API routes |
| `ui/js/app.js` | Main UI logic (~3600 lines): shared state, tab switching, flags, launch, chat (streaming, web search, history), Quick Launch (profiles, HF download, sampler presets), remote tunnel, stats polling, toasts |
| `ui/js/flags.js` | All llama.cpp flag definitions (15 categories, ~120 flags), flag types (`bool`/`int`/`float`/`text`/`path`/`enum`/`multi_enum`), chat template presets, command builder |
| `ui/js/manager.js` | Install flow, GitHub release fetch, backend selection, status polling, app auto-update (git), confirmation modal |
| `ui/js/presets.js` | Launcher preset save/load/update/delete with group-by-model rendering, collapsible groups, search/filter, warnings, import/export |
| `ui/index.html` | Tabbed UI: Install, Quick Launch, Configure, Chat, API, Presets |
| `ui/css/style.css` | Dark theme (Tokyo Night) stylesheet, responsive layout |
| `ui/templates/` | 14 bundled Jinja chat template files for Kobold-style presets |
| `config.json` | Persists installed version, backend type, and release tag |
| `tools/cloudflared/` | Auto-downloaded Cloudflare tunnel binary |
| `requirements.txt` | Python dependencies (certifi, ddgs, huggingface_hub) |

## Tabs

1. **Install** — Download/install llama.cpp binaries by backend (CPU/CUDA/Vulkan/SYCL/HIP/Metal/ROCm), app auto-update from git
2. **Quick Launch** — Beginner-friendly launch with profiles, integrated HF model downloader, sampler presets, shared state with Configure
3. **Configure** — Full flag-by-flag control with search, expand/collapse, beginner tips, submenus, command preview, path picker, multi-select with risk badges
4. **Chat** — Streaming OpenAI-compatible chat with web search, conversation history (localStorage), markdown rendering, sampler sliders, system prompt, suggestion chips
5. **API** — OpenAI-compatible endpoint docs, copy-ready code snippets (cURL/Python/JS), Cloudflare tunnel start/stop
6. **Presets** — Save/load full launcher configurations as JSON, grouped by model with search, expand/collapse, warnings, import/export

## Shared State Pattern

All settings flow through a single `flagValues` object in `app.js`. Quick Launch, Configure, Chat, and the command preview all read/write from this shared state via `setFlagValue()` / `setMultipleFlagValues()`, ensuring synchronization across tabs.

## Chat

- Backend proxies `/v1/chat/completions` to `llama-server` with SSE streaming
- Optional DuckDuckGo web search injects source citations into the system prompt
- Conversations stored in `localStorage` with title, messages, system prompt, timestamp
- Sampler sliders in the sidebar write through `setFlagValue()` and sync with Configure/Quick Launch

## Hugging Face Download

Integrated model downloader in the Quick Launch tab:
- Browse HF repos for GGUF files via `/api/hf/repo-files`
- Download models + optional mmproj files with progress bar and cancel support
- Path/filename validation prevents traversal attacks
- Auto-selects downloaded model on completion

## Cloudflare Tunnel

Remote tunnel in the API tab:
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

## AGENTS.md Rule

The `AGENTS.md` file enforces that any setting appearing in multiple UI locations must use the same shared state object, setter, and options source — no per-tab copies.
