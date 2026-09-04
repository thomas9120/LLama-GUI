# Tests

This repo has two main test groups:

- Frontend tests under `tests/frontend/`
- Backend tests under `tests/backend/`

The goal is not exhaustive coverage. Tests should make common regressions easier to diagnose, especially around shared launch state, command generation, route/service behavior, and UI helper logic.

## Common Commands

```powershell
npm test
```

Runs the full frontend suite: JavaScript syntax checks, fast Node unit tests, structural flag-definition validation, flag compatibility checks, module loading checks, and the Playwright smoke test.

```powershell
npm run test:syntax
```

Checks every frontend JavaScript file with `node --check`.

```powershell
npm run test:frontend:modules
```

Loads scripts in the same order as `ui/index.html` inside a Node VM and verifies expected `window.LlamaGui.*` namespaces exist.

```powershell
npm run test:flag-definitions
```

Validates structural invariants in `FLAGS` and `FLAG_CATEGORIES`, including ids, categories, types, defaults, and enum options.

```powershell
npm run test:flags
```

Compares exposed GUI flags against installed `llama-server` and `llama-cli` help output when those binaries are available.

```powershell
npm run test:frontend
```

Runs the Playwright smoke test for browser-level shared-state sync. This is also the only suite that can cover the Configure sampler preset panel, because `renderFlags()` destroys and rebuilds it — the `<select>` an assertion reads is a different element than the one that was clicked, which a `node:vm` harness cannot reproduce.

```powershell
.venv\Scripts\python.exe -m unittest discover tests -v
```

Runs the backend unittest suite. Use the project venv, not the system Python: HF download tests need runtime deps like `huggingface_hub`, and a system interpreter errors with misleading "require the huggingface_hub package" failures.

```powershell
.venv\Scripts\python.exe -m pytest tests/backend -q
```

Optional alternative runner (`pip install pytest`). It collects the same
`unittest` classes and reports the same pass count, but adds `-k` filtering,
`-x` fail-fast, and surfaces subtests individually — useful when iterating on
one failure. Not required by CI or by any test.

## Frontend Tests

Fast Node tests:

- `custom_launch_args_unit.cjs`: custom launch arg tokenization, quote handling, duplicate flag warnings, and preset preservation.
- `launch_args_unit.cjs`: launch argument generation for inert defaults, default/custom/unavailable model roots, traversal rejection, sampler-related flag behavior, server-wide reasoning-effort template kwargs, model-source recognition, and sensitive-value redaction.
- `output_cursor_unit.cjs`: generation-aware process output cursor consumption, stale-response rejection, and `invalidate()` semantics that preserve the cursor while rejecting in-flight responses.
- `monitor_ui_unit.cjs`: hermetic Monitor tests for polling and badge stability, card visibility/reordering and focus preservation, inference baselines and telemetry normalization, and safe rendering of hostile telemetry text.
- `process_lifecycle_unit.cjs`: guarded launch/stop/switch ordering, readiness progression, generation conflicts, out-of-band replacement reconciliation, refused-stop recovery, stop-during-load, and stale transition handling.
- `model_switch_ui_unit.cjs`: two-slot persistence, assignment validation, recoverable slot states, cancellation/failure cleanup, active-runtime display precedence, sidebar slider availability/drag thresholds/markup, safe rendering helpers, and storage fallback.
- `benchmark_args_unit.cjs`: benchmark/perplexity argument adaptation through the shared local-model path builder without mutating source presets, plus visible model-folder load failures in the manual-model selector.
- `chat_rendering_unit.cjs`: markdown escaping, fenced code safety, and safe source-link rendering.
- `chat_ui_unit.cjs`: abort-mid-stream ordering for `loadConversation` / `startNewChat` / `clearChat` — the aborted reply must not be finalized into the conversation being switched to (pins the `await abortActiveStream()` fix), plus stream completion persistence. The fetch stub rejects on a real microtask; reverting the three `await`s makes these tests fail. Also covers chat payload hygiene (empty-string sampler values omitted, no dead `host`/`port` fields), native thinking-effort kwargs and preserved reasoning history, non-destructive regeneration, recoverable answer versions, retry payloads without duplicate user turns, HTTP/network/SSE failures, premature EOF and final events without a newline, reasoning-only interruptions, and switching conversations during regeneration, and sidebar slider fallbacks for empty/non-numeric flag values, truthful output-limit display/request values, and restoration of safe saved source links.
- `sampler_presets_unit.cjs`: sampler preset storage fallback, normalization, applying defaults, and built-in/custom preset shape.
- `hf_download_ui_unit.cjs`: Hugging Face downloader UI helper behavior, request payloads, duplicate overwrite retry, and completion handling.
- `remote_tunnel_ui_unit.cjs`: remote-tunnel status rendering and retry behavior after transient polling failures.
- `api_tab_unit.cjs`: API endpoint host/port fallback, active-runtime endpoint/model preference, API-key snippet rendering, llama.cpp-compatible CSV parsing, active-auth status, and bearer-header selection.
- `external_server_ui_unit.cjs`: the API tab's external-server panel — connect/disconnect request payloads, the blank-port guard that never reaches the network, backend warning and error rendering, clearing the key field on disconnect, prefilling the form from a registered target, the status refresh that unlocks Chat, and load-time restore of a remembered address (auto-reconnect when keyless, prefill-and-explain when a key is needed, adopting an already-live target, and reporting a failed reconnect).
- `presets_unit.cjs`: preset storage failure fallback, non-default override calculation, imported preset normalization, stale flag filtering, sensitive Custom Launch Args rejection, bulk favorite write batching, missing-model detection, library summary scoping, health copy under filters and an unchecked model list, and search across overridden flag names and labels.
- `preset_roving_focus_unit.cjs`: the preset list focus sequence, skipping rows in collapsed groups, roving `tabindex` bookkeeping including each row's inner controls, clamped Up/Down and Home/End movement, restoring position across a re-render, and syncing the roving position when focus arrives by click or programmatic `focus()`.
- `manager_model_cache_unit.cjs`: the shared known-model-name cache — lowercased `.gguf` names only, an empty Set for an empty models folder versus `null` for an unknown one, cache clearing on a failed refresh, stale callers adopting the winning refresh result, and the presets-tab notification firing on both the success and failure paths.
- `manager_model_dir_unit.cjs`: native-picker cancellation, set/status/model-refresh sequencing and races, retained launch state after partial save failures, persistent operation errors, status-based restart readiness, stale-selection clearing, shared root-state updates, command-preview rebuilding, and safe folder/error rendering.
- `manager_releases_unit.cjs`: backend selection, backend-aware release fetching, `fetchJson` cache bypass, and installed-backend summary rendering.
- `theme_ui_unit.cjs`: theme preference storage, `data-theme` root attribute application, unknown-theme normalization, and registry-driven color-scheme hints (asserted for every entry in `THEMES`, so a new theme with the wrong `scheme` fails here). Also covers the sidebar theme menu against a DOM stub: rendering one row per registry entry, `aria-checked`/roving `tabindex`, arrow-key wrapping, Home/End, Escape returning focus to the trigger, and outside-click dismissal. Asserts every `THEMES` entry has a matching palette block in `tokens.css`, so a theme cannot be offered in the menu while rendering as the fallback. Also enforces contrast floors for every theme, which is what makes adding a theme safe rather than merely cheap:

  - AA (4.5:1) for `--fg`, `--fg-muted`, the six semantic text colors (`--accent-text`, `--green`, `--red`, `--yellow`, `--favorite`, `--cyan`) and `--red-fg`.
  - 3:1 for `--fg-faint` (non-essential text, deliberately below AA so it stays a distinct tier from `--fg-muted`) and for the fill-only `-solid` tokens.
  - Measured against `--bg-surface`, `--bg-raised` and `--bg-elevated` — text lands on all three — plus each semantic color's own `-subtle` chip and the composited favourite-row rest/hover washes.
  - Two usage invariants that keep the lower floors honest: `--yellow-solid`/`--favorite-solid` must never appear as a `color:`, and placeholder text must never use `--fg-faint`.
- `module_namespace_unit.cjs`: frontend script load order and exported namespaces.
- `flag_definitions_unit.cjs`: structural validation of flag/category definitions and representative invalid cases.
- `llama_flags_supported_unit.cjs`: compares exposed GUI flags against the installed `llama-server` / `llama-cli` help output. Skips with a message when neither binary is present, so a pass here does not imply the check ran.
- `js_syntax_check.cjs`: syntax-only check for frontend JavaScript.

Browser smoke test:

Chat context coverage also checks preview payload parity (selected answer/reasoning, system prompt, draft, sampler settings), stale-result rejection after runtime changes, the visible meter, post-search overflow feedback and recoverable Retry, and unavailable counting that leaves Send enabled.

- `flag_sync_smoke.cjs`: serves `ui/`, stubs backend APIs, and verifies shared state across Quick Launch, Configure, Chat, command preview, custom model-folder change/reset sequencing, API authentication, API snippets, remote tunnel UI, sampler presets (including rename and the Configure panel's selection surviving a rebuild), custom launch args, the sidebar Model Switcher's rendered drag/keyboard guards, Monitor polling/output/card flows and responsive layout, the Presets browser's roving keyboard focus, and pixel-level clipping of the card hover gradient at rounded corners.

When asserting against the Presets list, read the rendered order and visibility out of the DOM rather than assuming them. Groups sort by label, so they do not appear in the order a fixture declares them, and rows inside a collapsed group are in the DOM but `display: none`. Both have already caused false failures that looked like navigation bugs.

Use fast Node tests for focused debugging. Use the Playwright smoke test when a change affects real DOM wiring, mirrored controls, tab sync, command preview rendering, or launch blocking behavior.

## Backend Tests

Backend tests use Python `unittest` and mostly exercise route/service logic without starting the real app server.

- `test_backend_foundation.py`: config parsing, path setup, shared state containers, and context shape.
- `test_chat_context.py`: per-slot context capacity, fixed/server/unlimited output reserves, overflow boundaries, template/tokenizer fallback, preserved reasoning/options, unsupported media and unavailable counts, pinned target/auth, and final post-search overflow prevention.
- `test_system_stats.py`: system collectors, GPU probe parsing and failure isolation, cache/coalescing behavior, and the `/api/system-stats` route contract.
- `test_model_dir.py`: default/custom/unavailable active model-root resolution, validation, reset semantics, config merge preservation, unreadable-folder handling, and download-race rejection.
- `test_routing.py`: router matching for exact and prefix routes.
- `test_http_adapters.py`: request/response helpers and CORS origin handling.
- `test_server_baseline.py`: compatibility wrapper behavior, API dispatch, CORS, static asset versioning, and baseline server helpers.
- `test_services.py`: service-level helpers for install specs, runtime validation, process/auth and active-runtime lifecycle, generation-bound health/stop behavior, downloads, file picker behavior, chat/search helpers, external-server registration (local-only validation, header-safe API keys, key never published or persisted, llama.cpp-aware probe identification, remembered-address round-tripping, unattended restore rules, runtime precedence), and HF validation.
- `test_extracted_routes.py`: extracted route handlers and larger service flows, including preset secret scrubbing, launch preflight, active-runtime status, health/readiness, process launch/auth parsing, authoritative metrics/slots/chat targets, external chat-target registration and restore, HF download, tunnel, app update, and lifecycle routes.
- `test_docs_sync.py`: documentation drift. Reads the live `API_ROUTER` and asserts the Route Modules table in `docs/directory.md` and the API surface table in `docs/architecture.html` list exactly the registered endpoints, in both directions, plus the stated endpoint count. Adding a route without documenting it fails here.
- `test_release_version.py`: deterministic CalVer calculation for the first release of a month, later Micro increments, and ignored noncanonical tags.

Run backend tests after changes under `backend/`, route behavior changes, service helper changes, process management changes, install/update changes, or security-sensitive validation changes.

**If `test_docs_sync.py` fails**, the fix is normally to add the missing row rather than to loosen the test. It names the exact offending method and path. When the route table or the HTML markup moves, update the section-locating helpers in that file — they raise a clear error rather than silently matching nothing, because a docs check that finds zero routes would pass vacuously.

## When Adding Tests

- Prefer a small unit test when a helper has clear inputs and outputs.
- Prefer Playwright only when browser DOM wiring or cross-tab shared state is the thing being protected.
- Prefer backend unit tests with mocked services over starting real external processes.
- Keep tests specific enough that a failure points to the broken behavior, not just "the app changed."
