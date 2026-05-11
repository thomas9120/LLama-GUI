# Long-Term Plans

Maintainability and architectural improvement roadmap for LLama-GUI, derived from a thorough codebase analysis (May 2026).

---

## Scope

This document covers **structural/technical debt items** that improve long-term maintainability. For **user-facing feature ideas**, see `docs/potential_improvements.md`.

---

## 1. Backend Architecture (`server.py`)

### 1.1 Split the Monolithic Backend into Modules

**Problem:** `server.py` is 2,472 lines of single-file Python containing every subsystem — HTTP routing, llama.cpp install/management, process lifecycle, HF downloader, Cloudflare tunnel, web search, git auto-update, metrics proxy, and file picker.

**Goal:** Extract each subsystem into its own file under a `server/` package:

```
server/
  __init__.py          # imports, constants, SSL context, platform detection
  handler.py           # HTTP request handler, route dispatch table
  routes/
    status.py          # /api/status
    install.py         # /api/install, /api/update, /api/releases
    process.py         # /api/launch, /api/stop, /api/send-input, /api/output
    models.py          # /api/models, /api/select-file, /api/open-folder
    hf_download.py     # /api/hf/*
    tunnel.py          # /api/remote-tunnel/*
    search.py          # /api/web-search, page fetching, HTML-to-text
    chat.py            # /api/chat/completions proxy
    presets.py         # /api/presets (GET/POST/DELETE)
    metrics.py         # /api/llama/metrics proxy
    git_update.py      # /api/app-update-status, /api/app-update
  llama_manager.py     # install_release, download/verify/extract, BACKEND_SPECS
  state.py             # AtomicDict wrapper, shared state objects with locks
  web_search.py        # DDGS integration, page fetching, HTML parsing
```

### 1.1a Pitfalls of Splitting `server.py` (Read Before Attempting)

Splitting a 2,472-line monolithic file carries risks that must be addressed first. Here are the specific coupling patterns to watch for.

**1. Global State Entanglement**

Eight global variables with locks are accessed across ~50+ sites in the file:

| Global | Accessed In | Count |
|--------|-------------|-------|
| `remote_tunnel_process` / `remote_tunnel_lock` / `remote_tunnel_state` | `set_remote_tunnel_state`, `get_remote_tunnel_snapshot`, `ensure_cloudflared`, `_start_remote_tunnel_worker`, `start_remote_tunnel`, `stop_remote_tunnel`, `Handler.do_GET`, `Handler.do_POST`, `main` | 20+ sites |
| `process` / `process_lock` | `is_process_running`, `launch_process`, `stop_process`, `remove_llama_files` | 10+ sites |
| `model_download_state` / `model_download_lock` / `model_download_in_progress` / `model_download_cancel` | 7 functions across the file | 15+ sites |
| `install_in_progress` / `install_lock` | POST handlers, `install_release` | 10+ sites |
| `gui_server` | `shutdown_gui_server`, `restart_gui_server`, `main` | 8 sites |

Extracting any module means deciding which state lives where. If state stays in a shared `state.py` module, every extracted file imports it — you've gained file-splitting but lost any encapsulation of state.

**2. Circular Import Risk**

The `Handler` class (line 1804) directly calls 15+ module-level functions:
- `get_remote_tunnel_snapshot()` — tunnel state
- `fetch_page_text()`, `web_search()` — web search
- `get_local_chat_api_url()` — chat proxy
- `write_sse()` — SSE utility
- `stop_remote_tunnel()`, `stop_process()` — lifecycle
- `shutdown_gui_server()`, `restart_gui_server()` — lifecycle
- `remove_llama_files()` — cleanup
- `select_file_in_native_dialog()` — file picker

If these move to `routes/*.py` files and the route handlers also need `Handler.send_json()` or `Handler.read_body()`, you get: `handler.py` → `routes/chat.py` → `handler.py`. Python can resolve some cycles at runtime if imports are inside functions, but this is fragile and confusing.

**3. The Cleanup Chain Creates Hidden Coupling**

`main()` calls `stop_remote_tunnel()` then `stop_process()` on shutdown. `shutdown_gui_server()` and `restart_gui_server()` do the same. This means:
- The entry point must import tunnel and process modules
- Adding a new subsystem (e.g., a second process slot) means touching `main()` and both `shutdown`/`restart` functions
- There's no single `lifecycle.py` orchestrator — cleanup logic is scattered

**4. SSE Streaming Ties Chat Logic to the HTTP Handler**

`handle_chat_completions()` (lines 1890–1990) writes directly to `self.wfile` for SSE streaming. Extracting it into `routes/chat.py` requires passing the `wfile` handle and the `send_sse_headers()` / `close_connection` logic. Without an abstraction, the route handler can never be fully separated from the Handler class.

**5. Late Imports Become Package-Level Imports**

Currently these imports are lazy (inside functions):
- `from huggingface_hub import HfApi` — inside `get_hf_gguf_files`
- `from huggingface_hub import get_hf_file_metadata, hf_hub_url` — inside `get_hf_file_size`
- `from huggingface_hub import hf_hub_url` — inside `build_hf_download_url`
- `import tkinter as tk; from tkinter import filedialog` — inside `select_file_in_native_dialog`
- `from ddgs import DDGS` — inside `web_search`

Extracted to module-level imports in separate files, a missing dependency crashes the whole server at startup instead of only when that feature is used. Preserve the lazy pattern or handle `ImportError` gracefully.

**6. Path Configuration Is Frozen at Import Time**

All path constants (`BASE_DIR`, `LLAMA_DIR`, `MODELS_DIR`, etc., lines 31–41) are module-level globals computed once when `server.py` runs. Extracted modules would either:
- Import these from a config module (same problem — frozen at import time, untestable)
- Receive them as constructor/function parameters (requires rewriting every function signature)

**7. Testability Paradox**

Even after splitting, each extracted module still references the same global mutable state (`process`, `remote_tunnel_process`, etc.) unless you also refactor state into injectable objects. Without that, you've just moved the monolithic problem into smaller files — they aren't independently testable.

**Mitigation Strategy (Order Matters)**

1. **First**: Extract global state into an `AtomicDict` / `ServerState` class with injectable references — this breaks the implicit global coupling
2. **Second**: Build the route dispatch table (so each route handler becomes a standalone function accepting `(handler, state)`)
3. **Third**: Extract individual route handlers into `routes/*.py` — now each receives state and handler references as parameters
4. **Fourth**: Extract non-route subsystems (tunnel, search, llama_manager) into their own files

Without step 1, the split just makes tracking harder (10 files × inter-file imports instead of 1 file × line numbers).

---

### 1.2 Replace Routing If-Else Chain With a Dispatch Table

**Problem:** `Handler.do_GET` (144 lines) and `Handler.do_POST` (273 lines) are long if-elif chains. Adding a new route means appending another branch to an already-long method. Routes cannot be tested in isolation.

**Goal:** Use a dispatch dict:

```python
ROUTES = {
    "GET": {
        "/api/status": handle_status,
        "/api/releases": handle_releases,
        ...
    },
    "POST": {
        "/api/launch": handle_launch,
        ...
    }
}
```

Each handler is a standalone function accepting `(handler, **params)`, making them individually testable.

### 1.3 Unify Duplicated Download-State Management

**Problem:** Two parallel sets of functions (`set_download_progress` / `reset_download_progress` / `get_download_progress_snapshot` and `set_model_download_state` / `reset_model_download_state` / `get_model_download_snapshot`) share identical dict+lock patterns.

**Goal:** Create a generic `AtomicDict` wrapper class:

```python
class AtomicDict:
    def __init__(self, **defaults):
        self._dict = dict(defaults)
        self._lock = threading.Lock()
    def update(self, **kwargs): ...
    def reset(self, **kwargs): ...
    def snapshot(self): ...
```

Both subsystems instantiate their own `AtomicDict`.

### 1.4 Unify Install/Update Thread Boilerplate

**Problem:** `_install` and `_update` inner functions inside the POST handlers have identical `try/finally` patterns for managing `install_in_progress`.

**Goal:** Extract a shared `_run_install_thread(tag, backend)` helper.

### 1.5 Standardize Error Response Format

**Problem:** API endpoints return errors with inconsistent status codes (400/409/500/502) and response shapes — some use `{"error": str(e)}`, others use `self.send_error()`. This forces the frontend to handle ad hoc error shapes.

**Goal:** Every API error returns:

```json
{"error": "human-readable message", "code": 400}
```

With consistent HTTP status codes:
- 400 for validation errors
- 409 for conflicts (already in progress)
- 500 for unexpected server errors
- 502 for upstream (llama-server) failures

### 1.6 Eliminate Magic Numbers and Strings

**Problem:** Ports `5240` and `8080` appear as raw integers in 10+ locations. Timeout values (2.5s, 0.5s), byte sizes (1048576), and retry counts (10) are hardcoded inline.

**Goal:** Define all as named constants at module level or in a `constants.py`:
- `GUI_PORT = 5240`, `LLAMA_PORT = 8080`
- `RESTART_INITIAL_DELAY = 2.5`, `RESTART_RETRY_INTERVAL = 0.5`, `RESTART_MAX_RETRIES = 10`
- `BYTES_PER_MB = 1024 * 1024`

### 1.7 Fix CORS Check Inconsistency

**Problem:** `do_GET` applies CORS origin checking only for `/api/*` paths, while `do_POST` and `do_DELETE` check it for all paths. This inconsistency could be a security gap if non-API GET handlers ever process user data.

**Goal:** Apply CORS checking uniformly across all methods, or document why GET non-API paths are intentionally exempt.

---

## 2. Frontend Architecture (`ui/js/`)

### 2.1 Split Monolithic `app.js` Into Modules

**Problem:** `app.js` is 3,171 lines containing every UI subsystem: chat, Quick Launch, Configure, output panel, stats, tunnel UI, sampler presets, conversation history, markdown rendering, and more.

**Goal:** Split into focused files:

```
ui/js/
  app.js              # bootstrap, shared state (flagValues), tab switching,
                      #   setFlagValue, setMultipleFlagValues, syncUiAfterSharedStateChange
  flags.js            # (keep as-is — already well-scoped)
  manager.js          # (keep as-is — install/update flow)
  presets.js          # (keep as-is — preset library)
  state.js            # flagValues, getDefaultValues, mutators, sync logic
  config-ui.js        # renderFlags, createFlagRow, createSubmenuBlock, search,
                      #   expand/collapse, category rendering
  quick-launch.js     # initQuickLaunch, refreshQuickLaunchUI, profiles,
                      #   Quick Launch controls, HF downloader UI
  chat.js             # sendChatMessage, streaming SSE parsing, markdown rendering,
                      #   conversation history, chat sidebar, sampler sliders
  chat-web-search.js  # web search toggle, source chip rendering
  output-panel.js     # pollOutput, appendOutput, clearOutput, sendInput
  stats.js            # pollStats, snapshotStatsBaseline, stats bar rendering
  tunnel-ui.js        # start/stop remote tunnel, status polling, URL rendering
  sampler-presets.js  # sampler preset save/load/delete/import/export,
                      #   dropdown builders, applySamplerPresetValues
  utils.js            # debounce, escapeHtml, formatBytes, showToast, copyText
```

### 2.2 Extract Type-Specific Flag Row Builders

**Problem:** `createFlagRow()` (261 lines) is the largest function in `app.js`. A single if-else chain handles 7+ flag types.

**Goal:** Extract per-type builders:

```js
function createBoolFlagRow(f, row) { ... }
function createEnumFlagRow(f, row) { ... }
function createMultiEnumFlagRow(f, row) { ... }
function createPathFlagRow(f, row) { ... }
function createNumericFlagRow(f, row) { ... }  // handles int + float
function createTextFlagRow(f, row) { ... }
```

### 2.3 Consolidate Host/Port Resolution

**Problem:** Host and port extraction from `flagValues` is duplicated inline in at least 5 callers (`getChatApiUrl`, `sendChatMessage`, `pollStats`, `updateServerAddressPreview`, `updateQuickServerAddressPreview`).

**Goal:** All callers use `getServerBaseUrl()` or a dedicated `getServerHost()` / `getServerPort()` helper.

### 2.4 Merge Duplicated Sampler Preset Dropdown Builders

**Problem:** `createSamplerPresetControls()` and `refreshQuickSamplerPresetSelect()` have near-identical logic for populating `<select>` elements with builtin/custom sampler presets.

**Goal:** Extract a shared `renderSamplerPresetDropdown(selectEl)` function called by both.

### 2.5 Merge Duplicated `showStatus` Variants

**Problem:** Three near-identical status display functions exist:
- `showStatus(type, message)` in `manager.js` (element: `#install-status`)
- `showAppUpdateStatus(type, message)` in `manager.js` (element: `#app-update-status`)
- `showPresetStatus(message, type, durationMs)` in `presets.js` (element: `#preset-status`, with auto-dismiss)

**Goal:** Single `showStatus(el, type, message, options?)` with optional auto-dismiss.

### 2.6 Add Debouncing to Preset Search

**Problem:** `loadPresets()` fires an API call on every keystroke with no debounce.

**Goal:** Apply 200ms debounce to the preset search input, consistent with the Configure tab search.

### 2.7 Standardize Async Patterns

**Problem:** The codebase inconsistently mixes `async/await` and `.then()/.catch()` across all JS files. `manager.js` and `presets.js` each have a few legacy `.then()` call sites.

**Goal:** Convert all remaining `.then()/.catch()` to `async/await`.

### 2.8 Fix `javascript:` URI XSS Risk in Source Chips

**Problem:** `renderChatSources()` sets `chip.href = source.url` directly. If DuckDuckGo returns a search result with `javascript:alert(1)` as the URL, clicking the chip executes JS.

**Goal:** Validate URL scheme before assigning to `href` — allow only `http:` and `https:`.

### 2.9 Define CSS Class Name Constants

**Problem:** Class names like `"status-box"`, `"badge-green"`, `"btn-sm"` appear as raw string literals in DOM-building code. A typo is silently ignored.

**Goal:** Define constants at file top (or in a shared config):

```js
const CSS = {
  STATUS_BOX: "status-box",
  STATUS_SUCCESS: "status-box success",
  STATUS_ERROR: "status-box error",
  BADGE_GREEN: "badge badge-green",
  ...
};
```

---

## 3. Global / Cross-Cutting

### 3.1 Add Module System or Namespace Isolation

**Problem:** ~35+ functions and ~10+ data constants are defined in the global scope across 4 JS files. There are no imports, no bundler, no namespace isolation. Cross-file dependencies are implicit and unenforced — `presets.js` references 9 globals from 3 other files with no validation.

**Goal (near-term):** Group each file's exports under a namespace:

```js
// flags.js
window.Flags = { FLAGS, FLAG_CATEGORIES, getFlagsForTool, getDefaultValues, ... };

// manager.js
window.Manager = { fetchJson, confirmAction, checkStatus, ... };
```

**Goal (long-term):** Migrate to ES modules with a bundler (e.g., Rollup or esbuild) for tree-shaking, type checking, and explicit dependency graphs.

### 3.2 Add Unit Test Infrastructure

**Problem:** No test infrastructure exists. Several pure functions in `flags.js` and `presets.js` are ideal candidates for unit tests.

**Goal:** Add a test runner (Vitest or Jest) and start with the highest-value targets:

- `flags.js`: All 7 helper functions
- `manager.js`: `describeAppUpdateStatus()`, `normalize_git_path()`
- `presets.js`: `normalizePresetData()`, `getPresetGroupKey()`, `buildPresetGroups()`, `getPresetSearchText()`
- `server.py`: `normalize_arch()`, `validate_hf_repo_id()`, `validate_hf_filename()`, `is_mmproj_filename()`, `classify_git_dirty_paths()`, `get_platform_label()`

### 3.3 Fix Threading / State Safety Issues

**Problem:** Several threading edge cases exist in `server.py`:
- `remove_llama_files()` does not check `install_in_progress` before deleting files
- Global `process` variable is read without the lock in some callers
- Non-daemon restart thread depends on `os._exit(0)` for cleanup

**Goal:** Audit all lock acquisitions in `server.py`, add missing checks, and document the restart thread's safety model.

---

## 4. Documentation

### 4.1 Fix Existing Inaccuracies

| File | Inaccuracy | Fix |
|------|------------|-----|
| `AGENTS.md` | Claims `POST /api/install-deps` exists | Remove or add the endpoint |
| `docs/directory.md` | Says "15 categories, ~120 flags" | Update to 14 categories, 134 flags |
| `docs/potential_improvements.md` | Model download, Pinokio not marked done | Add strikethrough / checkmark |

### 4.2 Document Gaps

| Gap | Suggested Location |
|-----|-------------------|
| Full API reference (all 29 routes, request/response schemas) | `docs/api.md` (new) |
| Development / contributing guide | `CONTRIBUTING.md` (new) |
| Changelog / version history | `CHANGELOG.md` (new) |
| Preset JSON file format specification | In AGENTS.md or `docs/presets.md` |
| Security model (CORS, IP blocking, regex validation) | In AGENTS.md or `docs/security.md` |
| Bundled Jinja template inventory | In AGENTS.md (already partially covered) |

### 4.3 Mark Completed Items in `potential_improvements.md`

Items implemented but not yet marked as done:
- **Model download from UI** — HF downloader in Quick Launch
- **Pinokio integration** — documented in README.md

---

## 5. Effort Estimates

| Item | Effort | Impact |
|------|--------|--------|
| 1.2 Route dispatch table | Medium | High — enables route testing |
| 1.3 AtomicDict wrapper | Small | Low — reduces duplication |
| 1.5 Standard error format | Small | Medium — consistent client error handling |
| 1.6 Named constants | Small | Low — code hygiene |
| 2.1 Split app.js | Large | High — biggest single improvement |
| 2.2 Type-specific flag rows | Medium | Medium — tames largest function |
| 2.3 Consolidate host/port | Small | Low — eliminates a bug vector |
| 2.4 Merge sampler dropdowns | Small | Low — eliminates duplication |
| 2.5 Merge showStatus variants | Small | Low — eliminates duplication |
| 2.6 Preset search debounce | Trivial | Low — reduces API calls |
| 2.7 Standardize async patterns | Small | Low — code consistency |
| 2.8 Fix javascript: URI risk | Trivial | Medium — security fix |
| 2.9 CSS class constants | Small | Low — code hygiene |
| 3.1 Namespace isolation | Medium | Medium — prevents name collisions |
| 3.2 Unit test infra | Large | High — enables safe refactoring |
| 3.3 Thread safety audit | Medium | Medium — prevents race conditions |
| 4.1 Fix doc inaccuracies | Small | Low — accuracy |
| 4.2 Document gaps | Medium | Medium — API reference is high value |

---

## Recommended Ordering

### Phase 1 — Quick Wins (do first)
1.3 (AtomicDict), 1.5 (error format), 1.6 (named constants), 2.3 (host/port), 2.5 (showStatus), 2.6 (preset debounce), 2.7 (async patterns), 2.8 (XSS fix), 2.9 (CSS constants), 4.1 (doc fixes)

### Phase 2 — Unblocking Refactors (prerequisites for splitting)
1.2 (route dispatch table), 1.3 (AtomicDict — if not done in phase 1), 1.4 (install thread helper), 3.3 (thread safety audit)

**Do NOT attempt 1.1 (split server.py) or 2.1 (split app.js) until these are complete.** The dispatch table lets you extract route handlers as standalone functions first, and AtomicDict gives you a clean state abstraction to pass around.

### Phase 3 — Major Refactors
1.1 (split server.py), 2.1 (split app.js), 2.2 (type-specific flag rows), 2.4 (sampler dropdown merge), 3.1 (namespace isolation)

### Phase 4 — Infrastructure
3.2 (unit test infra), 1.7 (CORS consistency)

### Ongoing
4.2 (document gaps), 4.3 (mark completed features)
