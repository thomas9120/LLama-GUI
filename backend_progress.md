# Backend Refactor Progress Plan

Execution plan for implementing `backend_architecture_plan.md`.

Status legend:

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[!]` Blocked or needs decision

---

## Phase 0: Baseline and Guardrails

Goal: establish the current behavior before moving code.

- [x] Record current backend entrypoint behavior: `server.py` starts the UI server on port `5240` and serves existing UI/API routes.
- [x] Add a minimal backend test harness, preferably under `tests/backend/`.
- [x] Add tests for CORS origin allow/deny behavior.
- [x] Add tests for current JSON response/error behavior; expand these when standardized helpers are introduced.
- [x] Add tests for filename/path sanitization used by presets and downloads.
- [x] Add tests for state snapshot/update/reset helpers once introduced.
- [x] Add a smoke test that imports backend modules without requiring optional dependencies such as `huggingface_hub`, `ddgs`, or `tkinter`.

Exit criteria:

- [x] Tests can be run locally with one command: `python -m unittest discover -s tests`.
- [x] Current backend can still start from the existing entrypoint.
- [x] No route behavior has been intentionally changed yet.

---

## Phase 1: Constants, Paths, and State Containers

Goal: remove the most fragile global-state coupling before route extraction.

- [x] Create a backend package with a non-conflicting name, such as `backend/`.
- [x] Add `backend/config.py` for constants like `GUI_PORT`, `LLAMA_PORT`, restart delays, retry counts, and `BYTES_PER_MB`.
- [x] Add `backend/context.py` with `AppPaths`, `ServerConfig`, and `AppContext`.
- [x] Add `backend/state.py` with `AtomicDict` and typed state containers.
- [x] Move install/update state into `ServerState`.
- [x] Move HF download state, in-progress flag, and cancel event into `ServerState`.
- [x] Move remote tunnel state/process/lock into `ServerState`.
- [x] Move llama process state and output buffer ownership into `ServerState`.
- [x] Move local llama API target host/port into `ServerState`.

Exit criteria:

- [x] `server.py` still runs as the entrypoint.
- [x] Existing APIs still read/write the same state through context/state objects.
- [x] State tests cover snapshots, updates, resets, and lock behavior.
- [x] No extracted route module imports mutable process/download/tunnel globals from `server.py`.

---

## Phase 2: HTTP Response, Error, CORS, and SSE Adapters

Goal: make route logic portable before splitting route files.

- [x] Add `backend/http.py` with request and response wrapper classes.
- [x] Add `response.json(...)`, `response.error(...)`, `response.text(...)`, and `response.bytes(...)`.
- [x] Standardize API error bodies to include `error` and numeric `status`.
- [x] Preserve machine-readable `code` for compatibility cases such as HF duplicate downloads.
- [x] Centralize CORS allowed-origin logic.
- [x] Define explicit CORS handling for `/api/*`, `/v1/*`, static UI assets, and `/assets/app-logo.png`.
- [x] Add `SseWriter` and migrate chat streaming writes to it while keeping behavior unchanged.

Exit criteria:

- [x] API errors use the shared helper.
- [x] Existing frontend flows still receive compatible errors.
- [x] Chat streaming and web-search status SSE messages still work.
- [x] CORS tests cover API routes, `/v1/*`, allowed origins, denied origins, and no-origin local requests.

---

## Phase 3: Dispatch Routing Inside the Existing Entrypoint

Goal: replace long handler branches before moving code across files.

- [x] Add `backend/routing.py` with route registration and dispatch lookup.
- [x] Keep route handler functions in `server.py` initially, but register them through the dispatch table.
- [x] Convert GET API routes to dispatch handlers.
- [x] Convert POST API routes to dispatch handlers.
- [x] Convert DELETE preset route to dispatch handling.
- [x] Keep static file serving and `/v1/*` proxy handling separate from API dispatch.
- [x] Add route-dispatch tests for known paths and unknown paths.

Exit criteria:

- [x] `Handler.do_GET`, `Handler.do_POST`, and `Handler.do_DELETE` are thin wrappers around parsing, CORS, and dispatch.
- [x] Unknown API routes return the same effective 404 behavior as before.
- [x] All existing UI workflows still reach their API endpoints.

---

## Phase 4: Extract Low-Risk Routes

Goal: prove the extraction pattern on routes with little subprocess or threaded state.

- [x] Create `backend/routes/status.py`.
- [x] Create `backend/routes/models.py`.
- [x] Create `backend/routes/presets.py`.
- [x] Create `backend/routes/metrics.py`.
- [x] Move helper logic needed only by these routes into small service/helper modules where useful.
- [x] Keep route signatures consistent: `handler(request, response, ctx)`.

Exit criteria:

- [x] Status, models, presets, and metrics APIs work from the UI.
- [x] Route modules do not import `server.py`.
- [x] Tests can exercise route handlers without launching a real HTTP server where practical.

---

## Phase 5: Extract Medium-Risk Routes and Services

Goal: extract feature modules that depend on optional packages, network calls, or streaming.

- [x] Create `backend/services/hf_download.py` and `backend/routes/hf_download.py`.
- [x] Preserve lazy imports for `huggingface_hub`.
- [x] Create `backend/services/web_search.py` and `backend/routes/search.py`.
- [x] Preserve lazy imports for `ddgs`.
- [x] Create `backend/routes/chat.py` using `SseWriter`.
- [x] Keep web-search context injection behavior unchanged.
- [x] Keep `/api/chat/completions` streaming OpenAI-compatible SSE unchanged.
- [x] Create `backend/services/file_picker.py`.
- [x] Preserve lazy imports for `tkinter`.

Exit criteria:

- [x] HF repo listing, download, status polling, duplicate-file handling, and cancellation still work.
- [x] Web search still returns results and page text.
- [x] Chat streaming still works with and without web search.
- [x] Backend startup still succeeds without optional dependencies installed.

---

## Phase 6: Extract High-Risk Process, Install, Tunnel, and Lifecycle Code

Goal: move subprocess/threaded code after state ownership and adapters are stable.

- [x] Create `backend/services/process_manager.py` and `backend/routes/process.py`.
- [x] Move launch, stop, send-input, output polling, and process-running checks.
- [x] Create `backend/services/llama_manager.py`.
- [x] Move release selection, download, SHA256 verification, extraction, backend specs, and install/update operations.
- [x] Create `backend/routes/install.py`.
- [x] Create `backend/services/tunnel.py` and `backend/routes/tunnel.py`.
- [x] Move Cloudflare download/start/stop/status logic.
- [x] Create `backend/services/git_update.py` and `backend/routes/git_update.py`.
- [x] Create `backend/services/lifecycle.py` for coordinated shutdown/restart cleanup.
- [x] Make `main()`, `/api/shutdown`, `/api/restart`, and app-update restart logic call lifecycle helpers.

Exit criteria:

- [x] Launch/stop/send-input/output polling work for both `llama-server` and `llama-cli`.
- [x] Install and update still manage progress state and prevent concurrent installs.
- [x] Tunnel status and idle stop flow work locally; public tunnel start was intentionally skipped during Phase 8 to avoid opening a temporary Cloudflare URL.
- [x] Shutdown and restart preserve cleanup order.
- [x] No high-risk service imports `server.py`.

---

## Phase 7: Entrypoint Cleanup and Compatibility Pass

Goal: leave `server.py` as a small entrypoint or rename it safely.

- [x] Reduce `server.py` to entrypoint/bootstrap duties.
- [x] Decide whether to keep `server.py` as the compatibility entrypoint or move startup to `backend/app.py` with a wrapper.
- [x] Ensure any launchers, scripts, docs, or shortcuts still start the backend correctly.
- [x] Remove dead helper functions from `server.py`.
- [x] Remove obsolete globals once all state has moved into `AppContext`.
- [x] Review imports for circular dependencies and optional dependency startup failures.

Exit criteria:

- [x] `server.py` is small and mostly delegates to backend package modules.
- [x] Existing user startup flow still works.
- [x] No circular imports are required for normal startup.
- [x] Optional dependency failures remain feature-scoped.

---

## Phase 8: Full Regression Verification

Goal: verify the refactor from the user's point of view.

- [x] Start the backend and open the UI.
- [x] Confirm Install tab status and release fetching.
- [x] Confirm Configure command preview still generates expected launch arguments.
- [x] Confirm Quick Launch can select a model and launch.
- [x] Confirm server output polling works.
- [x] Confirm Chat streams responses from llama-server.
- [x] Confirm Chat with web search streams status, sources, and final response.
- [x] Confirm API metrics proxy works for local llama-server metrics.
- [x] Confirm Presets list/save/load/delete work.
- [x] Confirm HF model finder/download/cancel flow works.
- [x] Confirm Cloudflare tunnel status and idle stop flow locally; public tunnel start/stop was skipped by design.
- [x] Confirm app update status still reports dirty-path classification fields without running a real update.

Exit criteria:

- [x] All automated tests pass.
- [x] Manual smoke checks pass for the major tabs.
- [x] Any intentionally changed API behavior is documented.
- [x] `backend_architecture_plan.md` and this progress file reflect the final structure.

---

## Current Notes

- Phase 0 completed with `tests/backend/test_server_baseline.py`; latest run: `python -m unittest discover -s tests` passed 19 tests.
- Phase 1 completed. Runtime process, install/update, HF download, tunnel, output buffer, GUI server, and llama API target state now live under `APP_CONTEXT.state`. Follow-up review fixes documented the `AtomicDict` snapshot-return contract and added explicit state helper annotations; latest run: `python -m unittest discover -s tests` passed 54 tests.
- Phase 2 completed. `backend/http.py` now owns response helpers, standardized API errors, CORS helpers, and SSE writing. Follow-up review fixes tightened `Request` header/body typing and added baseline test state isolation around singleton mutations; latest run: `python -m unittest discover -s tests` passed 54 tests.
- Phase 3 completed. `backend/routing.py` now owns route registration/lookup, API routes dispatch through `API_ROUTER`, and `/v1/*` proxy plus static UI handling remain outside API dispatch. Follow-up review fixes added typed prefix storage, documented prefix matching semantics, and tests for router prefix contracts plus string/callable dispatch paths; latest run: `python -m unittest discover -s tests` passed 54 tests.
- Phase 4 completed. Status, models, presets, and metrics route handlers now live under `backend/routes/` with `handler(request, response, ctx)` signatures; `APP_CONTEXT.services` now uses a typed `BackendServices` bridge for server-owned helpers until later service extraction. Latest run: `python -m unittest discover -s tests` passed 54 tests.
- Phase 5 completed. Hugging Face validation, repo file listing, background model download, duplicate-file handling, status polling, and cancellation now live under `backend/services/hf_download.py` and `backend/routes/hf_download.py`. Web search/page fetching now live under `backend/services/web_search.py` and `backend/routes/search.py`; chat request shaping and streaming dispatch now live under `backend/services/chat.py` and `backend/routes/chat.py`. Native file selection now lives under `backend/services/file_picker.py` and `backend/routes/file_picker.py`. `server.py` keeps thin compatibility delegates for baseline tests and older internal references. Latest run: `python -m unittest discover -s tests` passed 63 tests.
- Phase 6A completed. Process/runtime routes now dispatch through `backend/routes/process.py`, with implementation in `backend/services/process_manager.py`; dead process Handler methods were removed and compatibility delegates retained in `server.py` for old helper names and remaining internal callers. Latest run: `python -m unittest discover -s tests` passed 77 tests.
- Phase 6 completed. Install/update, Cloudflare tunnel, git app update, and lifecycle/open-folder routes now dispatch through extracted route modules backed by service modules. `main()` now uses lifecycle cleanup, high-risk services do not import `server.py`, and the temporary `backend_phase6_log.md` was removed after its useful notes were folded into this progress file. Latest run: `python -m unittest discover -s tests` passed 146 tests.
- Phase 7 started. `server.py` is now a compatibility wrapper that re-exports `backend.app` and calls `main()` when executed; launch scripts continue to invoke `server.py`, while the real app startup and HTTP handler live in `backend/app.py`. The wrapper forwards app-level assignments such as `server.API_ROUTER = ...` for compatibility with older tests/callers. Latest run: `python -m unittest discover -s tests` passed 148 tests.
- Phase 7 completed. `backend/app.py` now owns service wiring through `configure_services(APP_CONTEXT)` and uses `APP_CONTEXT.state` internally; `STATE` remains only as a compatibility alias for older imports/tests. Latest run: `python -m unittest discover -s tests` passed 148 tests.
- Phase 8 completed. `python -m py_compile server.py backend\app.py` passed, and `python -m unittest discover -s tests` passed 236 tests. Runtime smoke used `models/Qwen3-0.6B-Q4_K_M.gguf`: backend startup through `server.py`, UI load, model selection and command preview sync, `llama-server` launch/stop/output, metrics proxy, chat streaming, web-search streaming with sources, presets save/list/delete, HF repo finder plus duplicate-download/cancel path, app-update status, and local-only tunnel status/idle stop all passed. Public Cloudflare tunnel start was intentionally skipped.
- The safest first implementation milestone is Phase 0 plus the non-invasive parts of Phase 1.
- Keep route extraction incremental. One route group per commit is preferred.
- Do not convert lazy optional imports to module-level imports unless the startup behavior is intentionally changed.
