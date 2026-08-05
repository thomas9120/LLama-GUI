--Changelog--

Please give a brief summary of changes made to the program, include the date the changes were made.

## 2026-08-04

- Added `docs/architecture.html` — a self-contained visual architecture guide for users and developers, covering the system context, layer map, backend route/service pairing, request lifecycle, frontend script-order dependency ladder, the `flagCore` shared-state contract, key flows (launch, chat, install, app update), the full 43-endpoint API surface, persistence, security boundaries, and where to edit for common changes.
- Added `tests/backend/test_docs_sync.py`, which reads the live `API_ROUTER` and fails when the documented API surface drifts from it — in either direction, for both `docs/directory.md` and `docs/architecture.html`. Includes guards so a parse that finds nothing fails loudly instead of passing vacuously. Documented in `docs/tests.md` and added to the Verify table in `AGENTS.md`.
- Reconciled the Route Modules table in `docs/directory.md` against the `API_ROUTER` registry in `backend/app.py`. Five registered endpoints were undocumented (`POST /api/estimate-memory`, `GET /api/llama/buffer-types`, `POST /api/activate-custom`, `POST /api/presets/rename`, `POST /api/presets/shortcut`), and the `presets.py` row said only "CRUD + shortcut export". Every row now lists HTTP methods, and the table is verified complete in both directions — 43 endpoints, matching the registry exactly.
- Fixed two documentation inaccuracies found while mapping the architecture: `README.md` advertised four themes when `THEMES` in `ui/js/theme-ui.js` ships five (Nebula was missing), and `docs/directory.md` described `install_python_dependencies()` as exposed via `POST /api/install-deps`, which is not a registered route — it is an internal step of `POST /api/app-update`.
- Added `docs/upstream-changes.md` to track announced llama.cpp compatibility changes and any required Llama-GUI follow-up.
