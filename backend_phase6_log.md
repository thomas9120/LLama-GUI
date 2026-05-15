# Phase 6 Backend Refactor Log

Focused working log for Phase 6 of the backend architecture refactor.

`backend_progress.md` remains the high-level roadmap. This file tracks the tricky details while extracting subprocess, install, tunnel, git-update, and lifecycle code from `server.py`.

---

## Phase 6 Scope

Goal: move high-risk backend code into service and route modules while preserving current behavior.

Primary route groups:

- Process/runtime: `/api/output`, `/api/launch`, `/api/stop`, `/api/send-input`, `/api/cleanup-llama`
- Install/update: `/api/releases`, `/api/install`, `/api/update`, `/api/download-progress`
- Remote tunnel: `/api/remote-tunnel/status`, `/api/remote-tunnel/start`, `/api/remote-tunnel/stop`
- App update: `/api/app-update-status`, `/api/app-update`
- Lifecycle: `/api/shutdown`, `/api/restart`, `main()` cleanup behavior

---

## Working Rules

- Keep `server.py` as the compatibility entrypoint until Phase 7.
- Preserve existing API response shapes unless a change is explicitly recorded here.
- Keep optional dependencies lazy and feature-scoped.
- Do not let new service modules import `server.py`.
- Prefer one route group per extraction checkpoint.
- Preserve thread locks and process cleanup order before improving structure.
- Add or update tests at each checkpoint before moving to the next route group.

---

## Risk Register

### Process/runtime

- Windows process-group behavior depends on `CREATE_NEW_PROCESS_GROUP` and `CTRL_BREAK_EVENT`.
- Output polling depends on bounded shared buffer behavior.
- `llama-server` target detection updates the `/v1/*` proxy target.
- `llama-cli` and `llama-server` must both keep working.

### Install/update

- Install progress must remain thread-safe and visible to the UI.
- SHA256 verification, archive extraction, and config writes must preserve current behavior.
- Install must be blocked while a llama process is running.

### Remote tunnel

- Tunnel status affects CORS allowed origins.
- Cloudflared startup parses stderr for the public URL.
- Stop logic must clear process state and tunnel URL consistently.

### App update/lifecycle

- Git dirty-path classification must remain conservative.
- Restart/shutdown order matters: stop llama process, stop tunnel, shut down GUI server.
- App update restart must not strand the frontend without the cache-busting reload signal.

---

## Milestone Plan

### 6A: Process/runtime extraction

- [x] Create `backend/services/process_manager.py`.
- [x] Create `backend/routes/process.py`.
- [x] Move process-running, output snapshot, launch, stop, send-input, and cleanup helpers.
- [x] Register process routes as callable handlers in `API_ROUTER`.
- [x] Keep thin compatibility delegates in `server.py` while tests still reference old names.
- [x] Remove dead process Handler route methods after callable routes are registered.
- [x] Verify with unit tests and full backend test suite.

### 6B: Install/update extraction

- [x] Create `backend/services/llama_manager.py`.
- [x] Create `backend/routes/install.py`.
- [x] Move release fetching, install progress, download, hash verification, extraction, and install/update route logic.
- [x] Verify install route error paths and progress snapshots.

### 6C: Remote tunnel extraction

- [x] Create `backend/services/tunnel.py`.
- [x] Create `backend/routes/tunnel.py`.
- [x] Move cloudflared download/start/stop/status behavior.
- [x] Verify status snapshots and start/stop state transitions.

### 6D: App update extraction

- [x] Create `backend/services/git_update.py`.
- [x] Create `backend/routes/git_update.py`.
- [x] Move git status, safe dirty path classification, dependency install, and app update execution.
- [x] Verify dirty-path classification and update status behavior.

### 6E: Lifecycle extraction

- [x] Create `backend/services/lifecycle.py`.
- [x] Create `backend/routes/lifecycle.py`.
- [x] Move shutdown/restart coordination, open-folder, and port-polling logic.
- [x] Verify shutdown, restart, and open-folder behavior.

---

## Checkpoint Log

### 2026-05-14

- Created this log before starting Phase 6 code movement.
- Initial implementation target: 6A process/runtime extraction.
- Created `backend/services/process_manager.py` and `backend/routes/process.py`.
- Moved process-running checks, output snapshotting, launch, stop, stdin send, launch API target parsing, and llama cleanup implementation behind the process service.
- Registered `/api/output`, `/api/launch`, `/api/stop`, `/api/send-input`, and `/api/cleanup-llama` as callable extracted routes.
- Kept `server.py` compatibility delegates for old helper names and remaining internal callers.
- Added route tests for output polling, stdin send, cleanup blocking, and cleanup config reset behavior.
- Verification: `python -m unittest discover -s tests` passed 74 tests.
- Removed dead process Handler methods that were no longer registered by `API_ROUTER`.
- Added direct service tests for launch-argument flattening and launch API target parsing/fallback behavior.
- 6A complete. Verification: `python -m unittest discover -s tests` passed 77 tests.

### 2026-05-14 (cont.)

- 6B install/update extraction.
- Created `backend/services/llama_manager.py` and `backend/routes/install.py`.
- Moved build_backend_specs, get_releases, get_release_by_tag, sha256_file, download_file, archive extraction (zip/tar), install_release, and download progress helpers behind the llama_manager service.
- Registered `/api/releases`, `/api/download-progress`, `/api/install`, and `/api/update` as callable extracted routes.
- Kept `server.py` compatibility delegates for all moved helpers.
- Removed dead Handler methods: `handle_get_releases`, `handle_get_download_progress`, `handle_post_install`, `handle_post_update`.
- Cleaned up unused imports (`zipfile`, `hashlib`, `tempfile`) from `server.py`.
- Added route tests for releases listing, download progress snapshot, install validation (missing tag/backend, unknown backend, process-running guard, in-progress guard), update validation (nothing-installed, process-running guard), and already-latest detection.
- Verification: `python -m unittest discover -s tests` passed 87 tests.

### 2026-05-14 (cont.)

- 6C remote tunnel extraction.
- Created `backend/services/tunnel.py` and `backend/routes/tunnel.py`.
- Moved `get_cloudflared_asset`, `set_remote_tunnel_state`, `get_remote_tunnel_snapshot`, `ensure_cloudflared`, `_start_remote_tunnel_worker`, `start_remote_tunnel`, and `stop_remote_tunnel` behind the tunnel service.
- Registered `/api/remote-tunnel/status`, `/api/remote-tunnel/start`, and `/api/remote-tunnel/stop` as callable extracted routes.
- Kept `server.py` compatibility delegates for `set_remote_tunnel_state`, `get_remote_tunnel_snapshot`, and `stop_remote_tunnel` (needed by lifecycle code and tests).
- Removed dead Handler methods: `handle_get_remote_tunnel_status`, `handle_post_remote_tunnel_start`, `handle_post_remote_tunnel_stop`.
- Cleaned up unused imports (`tarfile`, `shutil`, `signal`, `re`, `pathlib`) from `server.py`.
- Added route tests for idle status, reflected state, dead-process detection, invalid host rejection, worker thread spawning, stop with/witout process, and process cleanup.
- Verification: `python -m unittest discover -s tests` passed 96 tests.

### 2026-05-14 (cont.)

- 6D app update extraction.
- Created `backend/services/git_update.py` and `backend/routes/git_update.py`.
- Moved `run_git`, `install_python_dependencies`, `SAFE_DIRTY_PATH_PREFIXES`, `SAFE_DIRTY_PATHS`, `SAFE_DIRTY_SUFFIXES`, `normalize_git_path`, `parse_git_status_porcelain_z`, `is_safe_dirty_path`, `classify_git_dirty_paths`, `get_app_update_status`, and `update_app_from_git` behind the git_update service.
- Registered `/api/app-update-status` and `/api/app-update` as callable extracted routes.
- Removed all old function bodies and constants from `server.py` (no external callers existed — no compatibility delegates needed).
- Removed dead Handler methods: `handle_get_app_update_status`, `handle_post_app_update`.
- Added service tests for: git path normalization, porcelain parsing (basic + rename detection), safe/blocking dirty path classification, dependency installation (missing requirements, subprocess success/failure), app update status (no git repo, git unavailable, branch error, up-to-date, behind, blocking changes, ahead, diverged), and update_app_from_git (unavailable, up-to-date, blocking, ahead, diverged, pull success, pull failure, deps failure).
- Added route tests for status and update endpoints.
- Verification: `python -m unittest discover -s tests` passed 127 tests.

### 2026-05-14 (cont.)

- 6D app update extraction.
- Created `backend/services/git_update.py` and `backend/routes/git_update.py`.
- Moved `run_git`, `install_python_dependencies`, `SAFE_DIRTY_PATH_PREFIXES`, `SAFE_DIRTY_PATHS`, `SAFE_DIRTY_SUFFIXES`, `normalize_git_path`, `parse_git_status_porcelain_z`, `is_safe_dirty_path`, `classify_git_dirty_paths`, `get_app_update_status`, and `update_app_from_git` behind the git_update service.
- Registered `/api/app-update-status` and `/api/app-update` as callable extracted routes.
- Removed all old function bodies and constants from `server.py` (no external callers existed — no compatibility delegates needed).
- Removed dead Handler methods: `handle_get_app_update_status`, `handle_post_app_update`.
- Added service tests for: git path normalization, porcelain parsing (basic + rename detection), safe/blocking dirty path classification, dependency installation (missing requirements, subprocess success/failure), app update status (no git repo, git unavailable, branch error, up-to-date, behind, blocking changes, ahead, diverged), and update_app_from_git (unavailable, up-to-date, blocking, ahead, diverged, pull success, pull failure, deps failure).
- Added route tests for status and update endpoints.
- Verification: `python -m unittest discover -s tests` passed 127 tests.

### 2026-05-14 (cont.)

- 6E lifecycle extraction (final).
- Created `backend/services/lifecycle.py` with `shutdown_gui_server(ctx)`, `restart_gui_server(ctx)`, `cleanup_gui_server(ctx)`, `_wait_for_port_release(...)`, and `open_folder_in_file_manager(target)`.
- Created `backend/routes/lifecycle.py` with 3 callable route handlers: `post_shutdown`, `post_restart`, `post_open_folder`.
- Updated `server.py`: added `lifecycle_routes` import; replaced 3 string-based router entries; removed 3 functions (`shutdown_gui_server`, `restart_gui_server`, `open_folder_in_file_manager`); removed 3 Handler methods (`handle_post_shutdown`, `handle_post_restart`, `handle_post_open_folder`).
- Cleaned up unused imports from `server.py`: `os`, `subprocess`, `time`, `RESTART_PORT_WAIT_ATTEMPTS`, `RESTART_PORT_WAIT_SECONDS`, `RESTART_STARTUP_DELAY_SECONDS`, `ROOT_DIR as BASE_DIR`, `LLAMA_DIR`, `APP_REPO_URL`, `TOOLS_DIR`, `PROCESS_OUTPUT_LIMIT`, `PROCESS_OUTPUT_TRIM`.
- Fixed `test_server_baseline.py` reference to removed `server.BASE_DIR` (uses `Path(server.__file__).parent` instead).
- Added 18 lifecycle tests: shutdown (no-server + stop), cleanup, restart (no-server + spawn + context host/port), 3 platform open-folder tests, 2 `_wait_for_port_release` tests, and 6 route tests (shutdown 2, restart 2, open-folder 3).
- Phase 6 complete. Verification: `python -m unittest discover -s tests` passed 146 tests.
