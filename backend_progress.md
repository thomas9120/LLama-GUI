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
- [ ] Move install/update state into `ServerState`.
- [ ] Move HF download state, in-progress flag, and cancel event into `ServerState`.
- [ ] Move remote tunnel state/process/lock into `ServerState`.
- [ ] Move llama process state and output buffer ownership into `ServerState`.
- [ ] Move local llama API target host/port into `ServerState`.

Exit criteria:

- [ ] `server.py` still runs as the entrypoint.
- [ ] Existing APIs still read/write the same state through context/state objects.
- [ ] State tests cover snapshots, updates, resets, and lock behavior.
- [ ] No extracted route module imports mutable process/download/tunnel globals from `server.py`.

---

## Phase 2: HTTP Response, Error, CORS, and SSE Adapters

Goal: make route logic portable before splitting route files.

- [ ] Add `backend/http.py` with request and response wrapper classes.
- [ ] Add `response.json(...)`, `response.error(...)`, `response.text(...)`, and `response.bytes(...)`.
- [ ] Standardize API error bodies to include `error` and numeric `status`.
- [ ] Preserve machine-readable `code` for compatibility cases such as HF duplicate downloads.
- [ ] Centralize CORS allowed-origin logic.
- [ ] Define explicit CORS handling for `/api/*`, `/v1/*`, static UI assets, and `/assets/app-logo.png`.
- [ ] Add `SseWriter` and migrate chat streaming writes to it while keeping behavior unchanged.

Exit criteria:

- [ ] API errors use the shared helper.
- [ ] Existing frontend flows still receive compatible errors.
- [ ] Chat streaming and web-search status SSE messages still work.
- [ ] CORS tests cover API routes, `/v1/*`, allowed origins, denied origins, and no-origin local requests.

---

## Phase 3: Dispatch Routing Inside the Existing Entrypoint

Goal: replace long handler branches before moving code across files.

- [ ] Add `backend/routing.py` with route registration and dispatch lookup.
- [ ] Keep route handler functions in `server.py` initially, but register them through the dispatch table.
- [ ] Convert GET API routes to dispatch handlers.
- [ ] Convert POST API routes to dispatch handlers.
- [ ] Convert DELETE preset route to dispatch handling.
- [ ] Keep static file serving and `/v1/*` proxy handling separate from API dispatch.
- [ ] Add route-dispatch tests for known paths and unknown paths.

Exit criteria:

- [ ] `Handler.do_GET`, `Handler.do_POST`, and `Handler.do_DELETE` are thin wrappers around parsing, CORS, and dispatch.
- [ ] Unknown API routes return the same effective 404 behavior as before.
- [ ] All existing UI workflows still reach their API endpoints.

---

## Phase 4: Extract Low-Risk Routes

Goal: prove the extraction pattern on routes with little subprocess or threaded state.

- [ ] Create `backend/routes/status.py`.
- [ ] Create `backend/routes/models.py`.
- [ ] Create `backend/routes/presets.py`.
- [ ] Create `backend/routes/metrics.py`.
- [ ] Move helper logic needed only by these routes into small service/helper modules where useful.
- [ ] Keep route signatures consistent: `handler(request, response, ctx)`.

Exit criteria:

- [ ] Status, models, presets, and metrics APIs work from the UI.
- [ ] Route modules do not import `server.py`.
- [ ] Tests can exercise route handlers without launching a real HTTP server where practical.

---

## Phase 5: Extract Medium-Risk Routes and Services

Goal: extract feature modules that depend on optional packages, network calls, or streaming.

- [ ] Create `backend/services/hf_download.py` and `backend/routes/hf_download.py`.
- [ ] Preserve lazy imports for `huggingface_hub`.
- [ ] Create `backend/services/web_search.py` and `backend/routes/search.py`.
- [ ] Preserve lazy imports for `ddgs`.
- [ ] Create `backend/routes/chat.py` using `SseWriter`.
- [ ] Keep web-search context injection behavior unchanged.
- [ ] Keep `/api/chat/completions` streaming OpenAI-compatible SSE unchanged.
- [ ] Create `backend/services/file_picker.py`.
- [ ] Preserve lazy imports for `tkinter`.

Exit criteria:

- [ ] HF repo listing, download, status polling, duplicate-file handling, and cancellation still work.
- [ ] Web search still returns results and page text.
- [ ] Chat streaming still works with and without web search.
- [ ] Backend startup still succeeds without optional dependencies installed.

---

## Phase 6: Extract High-Risk Process, Install, Tunnel, and Lifecycle Code

Goal: move subprocess/threaded code after state ownership and adapters are stable.

- [ ] Create `backend/services/process_manager.py` and `backend/routes/process.py`.
- [ ] Move launch, stop, send-input, output polling, and process-running checks.
- [ ] Create `backend/services/llama_manager.py`.
- [ ] Move release selection, download, SHA256 verification, extraction, backend specs, and install/update operations.
- [ ] Create `backend/routes/install.py`.
- [ ] Create `backend/services/tunnel.py` and `backend/routes/tunnel.py`.
- [ ] Move Cloudflare download/start/stop/status logic.
- [ ] Create `backend/services/git_update.py` and `backend/routes/git_update.py`.
- [ ] Create `backend/services/lifecycle.py` for coordinated shutdown/restart cleanup.
- [ ] Make `main()`, `/api/shutdown`, `/api/restart`, and app-update restart logic call lifecycle helpers.

Exit criteria:

- [ ] Launch/stop/send-input/output polling work for both `llama-server` and `llama-cli`.
- [ ] Install and update still manage progress state and prevent concurrent installs.
- [ ] Tunnel start/stop/status still works and updates allowed CORS origins.
- [ ] Shutdown and restart preserve cleanup order.
- [ ] No high-risk service imports `server.py`.

---

## Phase 7: Entrypoint Cleanup and Compatibility Pass

Goal: leave `server.py` as a small entrypoint or rename it safely.

- [ ] Reduce `server.py` to entrypoint/bootstrap duties.
- [ ] Decide whether to keep `server.py` as the compatibility entrypoint or move startup to `backend/app.py` with a wrapper.
- [ ] Ensure any launchers, scripts, docs, or shortcuts still start the backend correctly.
- [ ] Remove dead helper functions from `server.py`.
- [ ] Remove obsolete globals once all state has moved into `AppContext`.
- [ ] Review imports for circular dependencies and optional dependency startup failures.

Exit criteria:

- [ ] `server.py` is small and mostly delegates to backend package modules.
- [ ] Existing user startup flow still works.
- [ ] No circular imports are required for normal startup.
- [ ] Optional dependency failures remain feature-scoped.

---

## Phase 8: Full Regression Verification

Goal: verify the refactor from the user's point of view.

- [ ] Start the backend and open the UI.
- [ ] Confirm Install tab status and release fetching.
- [ ] Confirm Configure command preview still generates expected launch arguments.
- [ ] Confirm Quick Launch can select a model and launch.
- [ ] Confirm server output polling works.
- [ ] Confirm Chat streams responses from llama-server.
- [ ] Confirm Chat with web search streams status, sources, and final response.
- [ ] Confirm API metrics proxy works for local llama-server metrics.
- [ ] Confirm Presets list/save/load/delete work.
- [ ] Confirm HF model finder/download/cancel flow works.
- [ ] Confirm Cloudflare tunnel start/stop/status flow works.
- [ ] Confirm app update status still classifies safe vs blocking dirty paths.

Exit criteria:

- [ ] All automated tests pass.
- [ ] Manual smoke checks pass for the major tabs.
- [ ] Any intentionally changed API behavior is documented.
- [ ] `backend_architecture_plan.md` and this progress file reflect the final structure.

---

## Current Notes

- Phase 0 completed with `tests/backend/test_server_baseline.py`; latest run: `python -m unittest discover -s tests` passed 19 tests.
- Phase 1 foundation modules added in `backend/config.py`, `backend/context.py`, and `backend/state.py`; `server.py` now imports shared constants while keeping behavior unchanged. Latest run: `python -m unittest discover -s tests` passed 25 tests.
- The safest first implementation milestone is Phase 0 plus the non-invasive parts of Phase 1.
- Avoid extracting process, install, tunnel, shutdown, or restart logic until the shared state/context and lifecycle abstractions are in place.
- Keep route extraction incremental. One route group per commit is preferred.
- Do not convert lazy optional imports to module-level imports unless the startup behavior is intentionally changed.
