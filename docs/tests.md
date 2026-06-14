# Tests

This repo has two main test groups:

- Frontend tests under `tests/frontend/`
- Backend tests under `tests/backend/`

The goal is not exhaustive coverage. Tests should make common regressions easier to diagnose, especially around shared launch state, command generation, route/service behavior, and UI helper logic.

## Common Commands

```powershell
npm test
```

Runs the full frontend suite: JavaScript syntax checks, fast Node unit tests, flag compatibility checks, module loading checks, and the Playwright smoke test.

```powershell
npm run test:syntax
```

Checks every frontend JavaScript file with `node --check`.

```powershell
npm run test:frontend:modules
```

Loads scripts in the same order as `ui/index.html` inside a Node VM and verifies expected `window.LlamaGui.*` namespaces exist.

```powershell
npm run test:flags
```

Compares exposed GUI flags against installed `llama-server` and `llama-cli` help output when those binaries are available.

```powershell
npm run test:frontend
```

Runs the Playwright smoke test for browser-level shared-state sync.

```powershell
python -m unittest discover tests -v
```

Runs the backend unittest suite.

## Frontend Tests

Fast Node tests:

- `custom_launch_args_unit.cjs`: custom launch arg tokenization, quote handling, duplicate flag warnings, and preset preservation.
- `launch_args_unit.cjs`: launch argument generation for inert defaults and sampler-related flag behavior.
- `benchmark_args_unit.cjs`: benchmark/perplexity argument adaptation without mutating source presets.
- `chat_rendering_unit.cjs`: markdown escaping, fenced code safety, and safe source-link rendering.
- `sampler_presets_unit.cjs`: sampler preset storage fallback, normalization, applying defaults, and built-in/custom preset shape.
- `hf_download_ui_unit.cjs`: Hugging Face downloader UI helper behavior, request payloads, duplicate overwrite retry, and completion handling.
- `api_tab_unit.cjs`: API endpoint host/port fallback, model alias selection, and API-key snippet rendering.
- `presets_unit.cjs`: imported preset normalization and stale flag filtering.
- `module_namespace_unit.cjs`: frontend script load order and exported namespaces.
- `js_syntax_check.cjs`: syntax-only check for frontend JavaScript.

Browser smoke test:

- `flag_sync_smoke.cjs`: serves `ui/`, stubs backend APIs, and verifies shared state across Quick Launch, Configure, Chat, command preview, API snippets, remote tunnel UI, sampler presets, and custom launch args.

Use fast Node tests for focused debugging. Use the Playwright smoke test when a change affects real DOM wiring, mirrored controls, tab sync, command preview rendering, or launch blocking behavior.

## Backend Tests

Backend tests use Python `unittest` and mostly exercise route/service logic without starting the real app server.

- `test_backend_foundation.py`: config parsing, path setup, shared state containers, and context shape.
- `test_routing.py`: router matching for exact and prefix routes.
- `test_http_adapters.py`: request/response helpers and CORS origin handling.
- `test_server_baseline.py`: compatibility wrapper behavior, API dispatch, CORS, static asset versioning, and baseline server helpers.
- `test_services.py`: service-level helpers for install specs, runtime validation, downloads, file picker behavior, chat/search helpers, and HF validation.
- `test_extracted_routes.py`: extracted route handlers and larger service flows, including presets, process launch, metrics/slots, chat web search, HF download, tunnel, app update, and lifecycle routes.

Run backend tests after changes under `backend/`, route behavior changes, service helper changes, process management changes, install/update changes, or security-sensitive validation changes.

## When Adding Tests

- Prefer a small unit test when a helper has clear inputs and outputs.
- Prefer Playwright only when browser DOM wiring or cross-tab shared state is the thing being protected.
- Prefer backend unit tests with mocked services over starting real external processes.
- Keep tests specific enough that a failure points to the broken behavior, not just "the app changed."
