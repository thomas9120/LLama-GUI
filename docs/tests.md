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

Tests binary selection and failure handling, then compares exposed GUI flags against `llama-server` and `llama-cli` help output. Without an explicit directory, local runs use the selected installed backend (including `llama/custom/bin`) or PATH and may skip if neither binary exists.

For a required check against a specific build:

```powershell
$env:LLAMA_GUI_LLAMA_BIN_DIR = 'C:\path\to\llama\bin'
node tests/frontend/llama_flags_supported_unit.cjs --require-binaries
```

An explicit `LLAMA_GUI_LLAMA_BIN_DIR` (or legacy `LLAMA_CPP_BIN_DIR`) requires both executables and disables fallback to other installations. Missing binaries, failed/timed-out `--help`, and unsupported flags fail the check. `--require-binaries` also requires an explicit directory. This checks advertised flag names, including negated booleans; it does not validate enum values or GPU execution. Fork-only flags are excluded.

The Ubuntu/Python 3.13 CI job installs the `libgomp1` OpenMP runtime, downloads the exact CPU release in `tests/llama-cpp-pin.json`, verifies its SHA256, and sets the explicit directory before `npm test`. Update the tag, asset, and checksum together from an official llama.cpp release, then run compatibility before accepting the new pin. No model or GPU is needed.

```powershell
npm run test:frontend
```

Runs the Playwright smoke test for browser-level shared-state sync. This is also the only suite that can cover the Configure sampler preset panel, because `renderFlags()` destroys and rebuilds it — the `<select>` an assertion reads is a different element than the one that was clicked, which a `node:vm` harness cannot reproduce.

The browser suite has nine named `node:test` scenarios, each with a fresh browser context and API fixtures. A scenario failure does not prevent the remaining scenarios from running. To run one scenario:

```powershell
node --test --test-name-pattern="benchmark actions" tests/frontend/flag_sync_smoke.cjs
```

The smoke test also covers grouped sidebar navigation, current-page semantics, active-versus-pending runtime identity, external server details, duplicate Stop protection during transitions, mobile focus and dismissal, and maintenance access in short windows.

Preset browser coverage includes loading into Configure, mirrored saved/modified identity, browsing without changing the edit source, masked comparisons, cancelling an update with focus restoration, saving the reviewed snapshot while newer edits remain pending, save-name collisions, rename/archive navigation, recoverable save failures, removal during a review, and containment at 390/900/1440px.

Saved-settings coverage checks conditional GUI defaults, numeric-string equality, boolean/enum/Auto labels, unavailable defaults, hidden credentials and custom arguments, count consistency, safe text rendering, and table containment at 390/900/1440px. Preset unit tests cover numeric default comparisons, blank/invalid values, legacy reasoning values, excluded fields, search behavior, and preservation of the saved input.

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
- `monitor_ui_unit.cjs`: hermetic Monitor tests for polling and badge stability, card visibility/reordering and focus preservation, inference baselines and telemetry normalization, and safe rendering of hostile telemetry text. Average-speed coverage checks processing-time weighting, idle periods, restored targets, token/time counter rollback, missing timings, and resets before or between valid samples. Live prompt/generation coverage checks updates before request completion, parallel slots, task changes, stalls, missing samples, long polling gaps, and returning to the completed-session average. Prompt cases also verify cache exclusion, null counter handling, excluding intervals that span prefill and generation, and batch updates spanning several polls without spikes or zero-rate flicker.
- `process_lifecycle_unit.cjs`: guarded launch/stop/switch ordering, readiness progression, generation conflicts, out-of-band replacement reconciliation, refused-stop recovery, stop-during-load, and stale transition handling.
- `model_switch_ui_unit.cjs`: two-slot persistence, assignment validation, recoverable slot states, cancellation/failure cleanup, active-runtime display precedence, sidebar slider availability/drag thresholds/markup, safe rendering helpers, and storage fallback. Browser interactions cover assignment changes, refresh, and drag/keyboard guards; exact CSS and source-text locks have been removed.
- `benchmark_args_unit.cjs`: benchmark/perplexity argument adaptation through the shared local-model path builder without mutating source presets, plus visible model-folder load failures in the manual-model selector.
- `chat_compaction_unit.cjs`: chunk budgets, complete summary validation, incremental summary merging, token savings, recent-turn preservation, cancellation, unsupported counting, and oversized-message recovery. `chat_ui_unit.cjs` additionally checks compaction persistence, request context, Undo, and cancellation when switching conversations.
- `chat_rendering_unit.cjs`: markdown escaping, fenced code safety, safe source-link rendering, whole-response Copy, near-bottom scroll following, and honest supplied/absent per-response metadata.
- `character_cards_unit.cjs`: legacy/V2/V3 JSON and PNG imports, Unicode/base64 decoding, V3 metadata precedence, PNG bounds/checksums, size/type limits, basic macros, prompt-field selection, and notices for unsupported card features. Run with `node tests/frontend/character_cards_unit.cjs`. The Chat unit suite also checks conversation preservation, greeting-free cards, storage failure, and switching chats during a file read. The `character card import` browser scenario covers the keyboard file picker, JSON/PNG input, safe greeting rendering, invalid-file recovery, request payloads, saved-chat restoration, focus mode, and narrow Settings layouts.
- `chat_ui_unit.cjs`: abort-mid-stream ordering for `loadConversation` / `startNewChat` / `clearChat` — the aborted reply must not be finalized into the conversation being switched to (pins the `await abortActiveStream()` fix), plus stream completion persistence. The fetch stub rejects on a real microtask; reverting the three `await`s makes these tests fail. Also covers chat payload hygiene, native thinking-effort kwargs and preserved reasoning history, non-destructive regeneration, recoverable answer versions, exact retry bodies, separate post-finish usage/timings events, HTTP/network/SSE failures, reasoning-only interruptions, automatic-compaction success/failure/cancellation, edit-tail recovery and storage failure, history search/rename/export/trash restoration/retention, custom-title preservation, exact numeric sampler state, and restored safe source links.
- `sampler_presets_unit.cjs`: sampler preset storage fallback, normalization, applying defaults, and built-in/custom preset shape.
- `hf_download_ui_unit.cjs`: Hugging Face downloader UI helper behavior, request payloads, duplicate overwrite retry, and completion handling.
- `remote_tunnel_ui_unit.cjs`: remote-tunnel status rendering and retry behavior after transient polling failures.
- `api_tab_unit.cjs`: API endpoint host/port fallback, active-runtime endpoint/model preference, API-key snippet rendering, llama.cpp-compatible CSV parsing, active-auth status, bearer-header selection, endpoint/snippet copy payloads, and expanded-example preservation across rerenders.
- `external_server_ui_unit.cjs`: the API tab's external-server panel — connect/disconnect request payloads, the blank-port guard that never reaches the network, backend warning and error rendering, clearing the key field on disconnect, prefilling the form from a registered target, the status refresh that unlocks Chat, and load-time restore of a remembered address (auto-reconnect when keyless, prefill-and-explain when a key is needed, adopting an already-live target, and reporting a failed reconnect).
- `presets_unit.cjs`: preset storage failure fallback, non-default override calculation, imported preset normalization, stale flag filtering, sensitive Custom Launch Args rejection, bulk favorite write batching, missing-model detection, library summary scoping, health copy under filters and an unchecked model list, and search across overridden flag names and labels. Also checks saved/current comparisons across defaults, numeric control strings and legacy model names, isolated save snapshots, excluded API/draft-context values, and masked sensitive values.
- `preset_roving_focus_unit.cjs`: the preset list focus sequence, skipping rows in collapsed groups, roving `tabindex` bookkeeping including each row's inner controls, clamped Up/Down and Home/End movement, restoring position across a re-render, and syncing the roving position when focus arrives by click or programmatic `focus()`.
- `manager_model_cache_unit.cjs`: the shared known-model-name cache — lowercased `.gguf` names only, an empty Set for an empty models folder versus `null` for an unknown one, cache clearing on a failed refresh, stale callers adopting the winning refresh result, and the presets-tab notification firing on both the success and failure paths.
- `manager_model_dir_unit.cjs`: native-picker cancellation, set/status/model-refresh sequencing and races, retained launch state after partial save failures, persistent operation errors, status-based restart readiness, stale-selection clearing, shared root-state updates, command-preview rebuilding, and safe folder/error rendering.
- `manager_releases_unit.cjs`: backend selection, backend-aware release fetching, `fetchJson` cache bypass, and installed-backend summary rendering. Custom slot cases cover backend-provided labels/paths, explicit activation payloads, duplicate/polling guards, failed activation retaining the current build, and update/repair restrictions. The browser suite also switches Custom → Custom 02 → official → Custom, including a missing-tool failure and unchanged shared flags.
- `theme_ui_unit.cjs`: theme preference storage, `data-theme` root attribute application, unknown-theme normalization, and registry-driven color-scheme hints (asserted for every entry in `THEMES`, so a new theme with the wrong `scheme` fails here). Also covers the sidebar theme menu against a DOM stub: rendering one row per registry entry, `aria-checked`/roving `tabindex`, arrow-key wrapping, Home/End, Escape returning focus to the trigger, and outside-click dismissal. Asserts every `THEMES` entry has a matching palette block in `tokens.css`, so a theme cannot be offered in the menu while rendering as the fallback. Also enforces contrast floors for every theme, which is what makes adding a theme safe rather than merely cheap:

  - AA (4.5:1) for `--fg`, `--fg-muted`, the six semantic text colors (`--accent-text`, `--green`, `--red`, `--yellow`, `--favorite`, `--cyan`) and `--red-fg`.
  - 3:1 for `--fg-faint` (non-essential text, deliberately below AA so it stays a distinct tier from `--fg-muted`) and for the fill-only `-solid` tokens.
  - Measured against `--bg-surface`, `--bg-raised` and `--bg-elevated` — text lands on all three — plus each semantic color's own `-subtle` chip and the composited favourite-row rest/hover washes.
  - Two usage invariants that keep the lower floors honest: `--yellow-solid`/`--favorite-solid` must never appear as a `color:`, and placeholder text must never use `--fg-faint`.
- `module_namespace_unit.cjs`: frontend script load order and exported namespaces.
- `flag_definitions_unit.cjs`: structural validation of flag/category definitions and representative invalid cases.
- `llama_flags_runner_unit.cjs`: deterministic binary-selection fixtures, required-build failures, no fallback from explicit paths, custom-backend discovery, failed/timed-out help, negated flags, and fork-only exclusions.
- `llama_flags_supported_unit.cjs`: compares GUI flags against real `llama-server` / `llama-cli` help output. CI requires the pinned CPU binaries; optional local discovery can skip with a message.
- `js_syntax_check.cjs`: syntax-only check for frontend JavaScript.

Browser smoke test:

Benchmark action coverage checks normal completion and parsed throughput summaries, safe output rendering, launch failure and retry, refused Stop with resumed polling and a successful retry, reconnecting to an existing benchmark, and WikiText preparation failure/retry before perplexity launch. It exercises the real app/lifecycle/benchmark wiring through API fixtures.

Monitor runtime coverage checks authoritative identity despite pending edits, safe long model names, focused Configure change review, external-server navigation, retained versus empty logs, and layout containment at 900/390px. A missing-vendor-probe fixture verifies useful system readings and an optional, keyboard-operable GPU setup disclosure whose focus/open state survive polling. A delayed-response fixture ignores AbortSignal to verify that epoch invalidation still rejects metrics/slots after reconnecting to the same external endpoint. `monitor_ui_unit.cjs` also covers partial inference guidance, model-only changes, failed actions with a still-active process, and vendor-independent readings.

Configure presentation coverage checks accessible setting labels and label-to-input focus, keyboard category/submenu and help disclosures, visible compatibility summaries, aligned numeric columns, and control containment at narrow widths. Launch comparison coverage checks immutable launch values, category counts and filtering, preservation of a focused row while typing through its baseline, per-setting/bulk revert synchronization, review across search filters, tool mismatch and stopped baselines, and comparison controls at 820px and 390px.

`launch_args_unit.cjs` also covers scrubbed launch-input capture, explicit unset fields, normalized comparison values, and unavailable/partial baselines. `process_lifecycle_unit.cjs` checks forwarding and isolation of nested launch snapshots. Backend launch tests verify metadata validation, secret removal, deep-copy isolation, and snapshot removal after process exit.

Configure restart coverage in `flag_sync_smoke.cjs` checks parser/preflight failures before stop, refused-stop handling, duplicate-click prevention, launch-before-readiness ordering, preservation of edits made during validation, and local-server-only visibility. `process_lifecycle_unit.cjs` verifies restart cancellation when the original process has exited or been replaced during preflight.

Configure reset coverage checks confirmation, Cancel/Enter/Escape dismissal and focus restoration, clearing invalid Custom Launch Args, defaults synchronized across Configure/Quick Launch/Chat, preservation of the selected model/tool, presets, chats and active runtime, and toolbar/dialog containment at 390/900/1440px.

Quick Launch layout coverage checks favorite/recent shortcut ordering and filtering, matching/modified preset states, safe long names, empty/error libraries, direct temperature/Top P/port synchronization, keyboard disclosures, runtime versus pending identity, tool-aware action labels, download access, desktop action visibility, and narrow-screen containment. Existing sampler-management and custom context/GPU tests continue to exercise the retained controls.

Chat context coverage also checks preview payload parity (selected answer/reasoning, system prompt, draft, sampler settings), stale-result rejection after runtime changes, the visible meter, context tools-menu visibility, keyboard dismissal and focus, warning Details, compact/summary/undo DOM wiring and narrow layout, post-search overflow feedback and recoverable Retry, and unavailable counting that leaves Send enabled. Staged browser streaming verifies that scrolling away preserves position through content and reasoning chunks, Jump to latest remains available through completion and resumes following, and a separate post-finish usage/timings event produces the per-response footer. The same scenario checks exact numeric sampler values beyond slider bounds and immediate Edit and resend availability.

Secondary-screen coverage checks Chat panel defaults and remembered choices across reloads, temporary responsive collapse/restoration with focus transfer, Focus mode, inert hidden panels, sampler help and associated labels. The responsive Chat layout scenario seeds a populated transcript, exercises closed/history/settings/both panel states at 1385x1232 and 390/900/1440px, checks panel and composer bounds plus internally scrollable messages, and verifies Send remains hit-testable when Jump to latest is visible at 1024/1100px. It also checks API connection/tunnel disclosures and visible warnings, specifically labeled endpoint copy buttons, expanded-example preservation, and control/URL containment at 390/900/1440px. Install coverage distinguishes required and optional missing tools, checks safe filename rendering and missing-library guidance, and verifies that status polling preserves the optional-tools disclosure's node, focus, and open state. The blocked-storage Chat unit case includes both panel controls.

- `flag_sync_smoke.cjs`: serves `ui/`, stubs backend APIs, and verifies shared state across Quick Launch, Configure, Chat, command preview, custom model-folder change/reset sequencing, API authentication, API snippets, remote tunnel UI, sampler presets (including rename and the Configure panel's selection surviving a rebuild), custom launch args, the sidebar Model Switcher's rendered drag/keyboard guards, Monitor polling/output/card flows and responsive layout, Chat panel bounds and composer hit testing, and the Presets browser's roving keyboard focus.

When asserting against the Presets list, read the rendered order and visibility out of the DOM rather than assuming them. Groups sort by label, so they do not appear in the order a fixture declares them, and rows inside a collapsed group are in the DOM but `display: none`. Both have already caused false failures that looked like navigation bugs.

The responsive Chat scenario also opens Context across focus modes and panel combinations, checking that it reserves space above the composer, keeps Send hit-testable, and toggles closed.

Use fast Node tests for focused debugging. Use the Playwright smoke test when a change affects real DOM wiring, mirrored controls, tab sync, command preview rendering, or launch blocking behavior.

## Backend Tests

Backend tests use Python `unittest` and mostly exercise route/service logic without starting the real app server.

- `test_backend_foundation.py`: config parsing, path setup, shared state containers, and context shape.
- `test_chat_context.py`: per-slot context capacity, fixed/server/unlimited output reserves, overflow boundaries, template/tokenizer fallback, preserved reasoning/options, unsupported media and unavailable counts, pinned target/auth, final post-search overflow prevention, and required-count summary requests with GUI-only metadata stripped.
- `test_system_stats.py`: system collectors, GPU probe parsing and failure isolation, cache/coalescing behavior, and the `/api/system-stats` route contract. Disk I/O coverage includes capacity-independent availability, Windows PDH raw counters and handle cleanup on failures, and macOS registry aggregation, device identity, and timeout isolation. `monitor_ui_unit.cjs` checks read/write activity, idle versus missing data, first-sample warmup and partial readings; the browser suite checks the capacity display has been replaced.
- `test_system_stats_native.py`: Windows CPU/memory and macOS Mach/sysctl CPU/memory API fixtures, including 64-bit counters, idle accounting, physical memory, 4/16 KiB pages, invalid samples, and native API failures. These run on both existing CI platforms; actual macOS ABI and desktop behavior still need native verification.
- `test_model_dir.py`: default/custom/unavailable active model-root resolution, validation, reset semantics, config merge preservation, unreadable-folder handling, and download-race rejection.
- `test_routing.py`: router matching for exact and prefix routes.
- `test_http_adapters.py`: request/response helpers and CORS origin handling.
- `test_http_integration.py`: a real loopback HTTP server on an ephemeral port with temporary presets. Exercises POST/DELETE dispatch, multibyte bodies crossing the read-chunk boundary, origin rejection, malformed JSON, invalid/oversized lengths, unsupported transfer encoding, truncated/stalled bodies, JSON 404s, and single-response framing.
- `test_web_fetch_transport.py`: real pinned HTTP/HTTPS connection and response parsing with only DNS/socket/TLS boundaries faked; covers destination pinning, Host/SNI, request targets, decoding, byte limits, redirect revalidation, cleanup, and sanitized transport failures.
- `test_server_baseline.py`: compatibility wrapper behavior, API dispatch, CORS, static asset versioning, and baseline server helpers.
- `test_services.py`: service-level helpers for install specs, runtime validation, process/auth and active-runtime lifecycle, generation-bound health/stop behavior, downloads, file picker behavior, chat/search helpers, external-server registration (local-only validation, header-safe API keys, key never published or persisted, llama.cpp-aware probe identification, remembered-address round-tripping, unattended restore rules, runtime precedence), and HF validation.
- `test_custom_slots.py`: both fixed custom slots, persisted activation and official-build round trips, missing-tool/permission/runtime failures, Linux/macOS dependency fixtures, slot-specific executable and library paths, invalid/busy/running activation guards, official-download exclusions, status metadata, folder opening, and cleanup preservation. macOS dependency behavior uses fixtures on existing Linux/Windows runners; native macOS library loading still needs a manual check.
- `test_review_regressions.py`: HF/API credential sanitization and quoted-argument rejection, live `/v1` fallback, external reconnect generations, installation rollback after grammar/permission/config failures, interrupted WikiText cleanup, and complete split-GGUF discovery/download/cancellation/overwrite handling. Frontend regression cases live in the existing launch-args, presets, Chat, and benchmark unit suites.
- `test_extracted_routes.py`: extracted route handlers and larger service flows, including preset secret scrubbing, launch preflight, active-runtime status, health/readiness, process launch/auth parsing, authoritative metrics/slots/chat targets, external chat-target registration and restore, HF download, tunnel, app update, and lifecycle routes.
- `test_docs_sync.py`: documentation drift. Reads the live `API_ROUTER` and asserts the Route Modules table in `docs/directory.md` and the API surface table in `docs/architecture.html` list exactly the registered endpoints, in both directions, plus the stated endpoint count. Adding a route without documenting it fails here.
- `test_release_version.py`: deterministic CalVer calculation for the first release of a month, later Micro increments, and ignored noncanonical tags.
- `test_unix_shortcuts.py`: Linux XDG locations, disabled desktops, command escaping, macOS bundle metadata and desktop links, repeat installation, conflicting app preservation, nonfatal errors, and matching icon artwork. The desktop symlink test runs on Unix; Finder/menu launch behavior needs a native desktop check.

Run backend tests after changes under `backend/`, route behavior changes, service helper changes, process management changes, install/update changes, or security-sensitive validation changes.

Config-default tests run in clean child-process environments; installed-tool and CORS fixtures do not depend on the developer's saved backend or GUI port. CI deliberately remains Linux/Windows: macOS runners, especially Intel, have taken hours for the maintainer. See the dated exception in `AGENTS.md` before changing the matrix.

**If `test_docs_sync.py` fails**, the fix is normally to add the missing row rather than to loosen the test. It names the exact offending method and path. When the route table or the HTML markup moves, update the section-locating helpers in that file — they raise a clear error rather than silently matching nothing, because a docs check that finds zero routes would pass vacuously.

## When Adding Tests

- Prefer a small unit test when a helper has clear inputs and outputs.
- Prefer Playwright only when browser DOM wiring or cross-tab shared state is the thing being protected.
- Prefer backend unit tests with mocked services over starting real external processes.
- Keep tests specific enough that a failure points to the broken behavior, not just "the app changed."
