# Llama GUI - Project Overview

**What it is:** A lightweight browser-based launcher and control panel for `llama.cpp`, supporting Windows, macOS, and Linux.

## Architecture

- **Backend:** Single Python file (`server.py`) using `http.server` — no external frameworks
- **Frontend:** Vanilla HTML/CSS/JS, served statically from `ui/`
- **Single dependency:** `certifi` for SSL verification
- **Server port:** `127.0.0.1:5240`

## Key Components

| File | Role |
|------|------|
| `server.py` | HTTP server, llama.cpp installer/updater, process manager, config |
| `ui/js/app.js` | Main UI logic, shared state (`flagValues`), Quick Launch, sampler presets |
| `ui/js/flags.js` | All llama.cpp flag definitions (15 categories, ~100 flags), command builder |
| `ui/js/manager.js` | Install flow, status polling, release fetching, confirmation modal |
| `ui/js/presets.js` | Full launcher preset save/load/export/import |
| `ui/index.html` | Tabbed UI: Install, Quick Launch, Configure, API, Presets |

## Tabs

1. **Install** — Download/install llama.cpp binaries by backend (CPU/CUDA/Vulkan/SYCL/HIP/Metal/ROCm)
2. **Quick Launch** — Beginner-friendly mode with profiles, shared state with Configure
3. **Configure** — Full flag-by-flag control with search, expand/collapse, command preview
4. **API** — OpenAI-compatible endpoint docs and copy-ready snippets
5. **Presets** — Save/load full launcher configurations as JSON

## Shared State Pattern

All settings flow through a single `flagValues` object in `app.js`. Both Quick Launch and Configure read/write from this shared state via `setFlagValue()` / `setMultipleFlagValues()`, ensuring synchronization across tabs.

## AGENTS.md Rule

The `AGENTS.md` file enforces that any setting appearing in multiple UI locations must use the same shared state object, setter, and options source — no per-tab copies.
