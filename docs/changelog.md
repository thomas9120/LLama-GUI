--Changelog--

Please give a brief summary of changes made to the program, include the date the changes were made.

## 2026-08-11

- Updated the official Windows and Linux AMD install options to llama.cpp's ROCm 7.14 release assets, first available in `b10356`, while retaining the architecture-specific Lemonade ROCm options. Release choices are now filtered to builds that actually contain the selected backend asset.

## 2026-08-10

- Added `docs/editable-launch-command-plan.md`, a detailed deferred implementation plan for a shared-state-backed Command Editor tab with locked executable/model segments, atomic command-to-flag synchronization, custom backend argument pass-through, sensitive-value handling, launch guards, phased file changes, and acceptance tests. No feature code was implemented.

## 2026-08-07

- Hugging Face companion mmproj downloads now land beside their model in `models/<repo>/` instead of under `models/mmproj/<repo>/`. Projector filenames and the legacy top-level `models/mmproj/` folder stay out of the launch-model list.
- Aligned `backend/routes/models.py` with the module-import style used by the other route modules (behavior unchanged).

## 2026-08-06

- Fixed the server stats bar KV-usage cell, which was stuck at `--%` on current llama.cpp: upstream removed `llamacpp:kv_cache_usage_ratio` from `/metrics`, and the `/slots` fallback expected `next_token` as an array while current builds return it as an object. `getSlotStats()` (`ui/js/app.js`) now accepts both shapes and uses `n_prompt_tokens` (prompt + generated tokens, including accepted MTP draft tokens) as the numerator instead of generated-only `n_decoded`.
- Stats bar speeds no longer freeze mid-generation: `pollStats()` derives live rates from per-task `/slots` deltas (`n_prompt_tokens_processed` and `next_token.n_decoded`), while retaining llama-server's completed-request gauges as a compatibility fallback.
- Fresh launches keep a zero baseline so work completed before the first poll is counted; reconnects seed from their first successful counter sample, and chat resets cannot snapshot unsampled zeroes into lifetime totals.
- Expanded the frontend smoke check to cover current and legacy `next_token` shapes, fresh-launch and reconnect baselines, and live generation speed while the global completion counter remains unchanged.

## 2026-08-04

- Added `docs/architecture.html` — a self-contained visual architecture guide for users and developers, covering the system context, layer map, backend route/service pairing, request lifecycle, frontend script-order dependency ladder, the `flagCore` shared-state contract, key flows (launch, chat, install, app update), the full 43-endpoint API surface, persistence, security boundaries, and where to edit for common changes.
- Added `tests/backend/test_docs_sync.py`, which reads the live `API_ROUTER` and fails when the documented API surface drifts from it — in either direction, for both `docs/directory.md` and `docs/architecture.html`. Includes guards so a parse that finds nothing fails loudly instead of passing vacuously. Documented in `docs/tests.md` and added to the Verify table in `AGENTS.md`.
- Reconciled the Route Modules table in `docs/directory.md` against the `API_ROUTER` registry in `backend/app.py`. Five registered endpoints were undocumented (`POST /api/estimate-memory`, `GET /api/llama/buffer-types`, `POST /api/activate-custom`, `POST /api/presets/rename`, `POST /api/presets/shortcut`), and the `presets.py` row said only "CRUD + shortcut export". Every row now lists HTTP methods, and the table is verified complete in both directions — 43 endpoints, matching the registry exactly.
- Fixed two documentation inaccuracies found while mapping the architecture: `README.md` advertised four themes when `THEMES` in `ui/js/theme-ui.js` ships five (Nebula was missing), and `docs/directory.md` described `install_python_dependencies()` as exposed via `POST /api/install-deps`, which is not a registered route — it is an internal step of `POST /api/app-update`.
- Added `docs/upstream-changes.md` to track announced llama.cpp compatibility changes and any required Llama-GUI follow-up.
