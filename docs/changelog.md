--Changelog--

Please give a brief summary of changes made to the program (excluding documentation changes), include the date the changes were made.

## 2026-09-04

- Fixed the collapsed Chat settings panel retaining its width at intermediate window sizes; the responsive width now applies only to expanded desktop panels, and mobile settings retain full width.

- Conversations now starts collapsed in Chat to leave more room for messages; Show conversations still opens the history panel.

- Moved routine context counts and compaction actions into a compact composer tools menu. Only brief near-full/overflow warnings remain inline; context details, summary navigation, and Undo are available on demand with keyboard and outside-click dismissal.

- Chat improvements, batch 4: added manual compaction beside the context meter, counted summary chunks with reply headroom, and a collapsed View summary / Undo marker. Original transcripts and answer versions remain saved; failed, cancelled, stale, or unhelpful summaries leave the prior context intact.

- Fixed empty and system-instructions-only context previews triggering llama-server's Jinja “No messages provided” errors; counting now waits for a chat message and the backend also skips these invalid previews.
- Chat improvements, batch 3: added a context meter with running-server token counts and reply reserve, refreshes for drafts/settings/model changes, and a final backend budget check including web results. Oversized requests receive actionable recovery feedback; unsupported counting remains visibly unavailable without blocking chat.
- Chat improvements, batch 2: regeneration retains the original answer until a replacement completes, failed/stopped attempts remain saved with answer navigation and Retry, interrupted streams are marked incomplete, and retries reuse the existing user turn without clearing the draft.
- Chat improvements, batch 1: Max Tokens now shows the actual shared request limit or Server default without silently clamping its display, and reopened conversations restore saved web-source links.
- Polished the Monitor experience with responsive, reorderable mixed resource/GPU cards; stable polling states and focus; session-average prompt/generation speeds; improved accessibility; and more accurate lifecycle reporting.
- Expanded GPU telemetry with optional cross-vendor `all-smi` support, broader AMD/NVIDIA detection and parsing, resilient probe decoding/fallbacks, and platform-specific setup guidance linked from unavailable GPU states.
- Enlarged Configure's command preview for long launch commands and strengthened Monitor frontend/backend tests, polling diagnostics, and deterministic concurrency coverage.

## 2026-09-03

- Added the Monitor tab with live process output, hideable/reorderable CPU, memory, disk, inference, and NVIDIA/AMD GPU cards, plus a shared fixed stats bar and target-isolated inference counters.
- Added the cached, coalesced `GET /api/system-stats` backend and improved telemetry accuracy, recovery, diagnostics, accessibility, setup guidance, output following, and server-ready navigation.
- Preserved preset favorites and usage history across incomplete refreshes, and added actionable Linux guidance when native file picking is unavailable because Tk is missing.

## 2026-09-02
- Added the official llama.cpp ROCm 10.0 binaries as a platform-aware Windows x64/Linux x64 install option, labeled to note that a separate ROCm runtime is required.

## 2026-09-01
- Added an optional server-only Per-Slot Context Limit control for unified KV cache deployments. It emits `--kv-unified-per-slot` while preserving the configured total context window, giving concurrent slots a predictable maximum without enabling upstream automatic pool sizing.

## 2026-08-31
- Removed llama-cli's obsolete `-cnv` Conversation Mode control; the existing supported `-st` Single Turn control remains available, and current llama-cli stays conversational by default.
- Updated llama-server's built-in tool choices by removing the retired `get_datetime`, adding `get_info`, and preventing stale multi-select values from being emitted in launch commands.
- Aligned Model Load Mode with current llama.cpp: Auto is now the default, `mmap+mlock` is selectable, and `mlock` is correctly labeled as lock-only without mmap.

## 2026-08-30
- Corrected the Xet downloader dependency bounds to versions published on PyPI with Python 3.9 wheels, keeping Linux CI and older supported Python installs resolvable.
- Accelerated Hugging Face model and projector downloads with the standard Xet concurrent range-transfer backend when available, while preserving progress, scoped cancellation, atomic partial-file handling, and the existing HTTP fallback on unsupported systems.
- Updated the Advanced Configure lazy tensor-reading control for llama.cpp PR #27969: it now emits `--lazy-mode` instead of the removed `--tensor-read-lazy` name while preserving existing saved preset values.
- Renamed the architecture-specific Lemonade install options from ROCm 7 to ROCm Nightly so their labels remain accurate as the bundled TheRock runtime advances.
- Added Lemonade's stable-fork ROCm 10.0 binaries as one install option on Windows x64 and Linux x64, separate from the architecture-specific Lemonade nightlies; its label warns that a separate ROCm runtime is required.
- Marked the official llama.cpp ROCm 7.14 install options as legacy and clarified that they require a separately installed ROCm runtime.

## 2026-08-29
- Moved Llama GUI's in-app update controls beside the llama.cpp installer at the top of Install and Update, tightened both cards into a responsive two-column layout, and removed the backend dropdown's ROCm description.
- **Batch 1 low-severity follow-up (L6, L1, L3, M3 health):** fresh `cloudflared` helper downloads now fail closed unless GitHub's release metadata supplies the expected asset and a valid SHA256 digest, and mismatches are rejected before `chmod`/execution; a wedged `Thread.start()` can no longer leave install, model-download, or tunnel state stuck, with HF failures returned only through their sanitized status snapshot; launch-target DNS validation now runs before acquiring the install/process locks or starting the child; and the pinned runtime health probe preserves its generation recheck even when target validation fails.

## 2026-08-28
- Completed the medium-severity review follow-up: local pinned-proxy DNS failures now keep raw resolver details in backend logs, observability response-read failures return their established sanitized errors, and unrelated flag edits no longer rebuild Quick Launch model/sampler options or Model Switcher preset options.
- Hardened the git-based app update: `pip install` and the PowerShell desktop-shortcut helper now run with timeouts (a wedged one used to pin the HTTP handler thread forever), failures and timeouts are logged, and concurrent update requests are serialized through a dedicated update slot — the second request gets a 409 instead of racing the first on git index operations.
- Cut needless UI re-rendering: the API tab's endpoint and snippet cards now rebuild only when one of their inputs actually changes (base URL, model, auth, tool mode, active process tool, loading state, or the external-server target), and the process lifecycle no longer notifies subscribers when a health poll produces the same snapshot as before, which used to re-render the UI twice per second for the entire model load.
- Closed a DNS-rebinding gap in the local proxies: the chat proxy, metrics/slots/props proxy, external-server health probe, and the generic `/v1` proxy previously validated a hostname once and then let the OS resolve it again at connect time, so a hostname could swing to an off-machine address in between. All four now share one pinned-connection primitive (`backend/http.py`) that re-resolves at connect time, refuses anything that no longer points at this machine, and never follows redirects; the web-search fetcher reuses the same pinned connection classes.
- The Chat tab now tolerates blocked browser storage (e.g. "block all cookies"): its settings reads/writes go through the same tolerant helpers as the rest of the UI, so Chat initialization and its controls keep working with session defaults instead of dying on the first storage access.
- Several error paths no longer send raw exception text (OS error strings, local paths) to the UI: buffer/device discovery, memory estimates, custom backend activation, install download progress, and the local metrics fetch now show fixed messages and keep the full detail in the backend log.
- Child process output streams now decode as UTF-8 with replacement: a non-UTF-8 byte in llama-server output no longer kills the output reader for that pipe, which previously left the pipe undrained so the child could block on a full pipe and appear hung.
- Turning Auto Fit off now omits its inactive `-fitt` target-margin and `-fitc` context-floor helpers from generated launch commands while preserving their configured values for later reuse.
- Added an Advanced Configure control for llama.cpp b10653+'s `--tensor-read-lazy` mode, with inert Auto-by-default behavior plus explicit lower-RAM On and keep-resident Off choices.

## 2026-08-27
- Added the new llama.cpp `-ncffn` / `--n-cpu-ffn` control for keeping dense FFN weights from the first N model layers on CPU.

## 2026-08-25
- Preserved one downloaded official backend alongside a custom backend, allowing the Install tab to reactivate its existing `llama/bin` files without downloading them again; activation verifies that `llama-cli` can start, and legacy custom configurations recover its installed build tag from `--version`.
- Fresh installs now create `llama/custom/bin` and `llama/custom/grammars` automatically.
- Added an Experimental Configure accordion below Advanced with an off-by-default Adaptive Draft Size checkbox that emits the fork-only `--spec-draft-adaptive` flag.
- Added a Multimodal Projector Device control directly below `-mm` in Model; it emits the new `--mmproj-device DEVICE` argument introduced in llama.cpp b10541 and included in v0.2.0.

## 2026-08-22

- Added an independent Ngram Map K4V speculative-decoding submenu with lookup size, draft size, and minimum-hit controls; it stacks with draft and Ngram Mod modes through one shared `--spec-type`, shows llama.cpp defaults in each description, and migrates legacy presets.
- Renamed the left sidebar's Install navigation item to Install and Update.
- Fixed backend-filtered llama.cpp release discovery stopping at GitHub's first page: the Install version list now checks up to three 100-release pages until it finds compatible assets, so Linux ROCm builds remain selectable after gaps in upstream publishing without exhausting GitHub's API quota when an asset is discontinued.

## 2026-08-19

- Migrated reasoning effort to llama.cpp's native support (upstream PR #26941, first release b10434). The server-wide Default Reasoning Effort control now emits the native `--reasoning-effort LEVEL` launch flag on builds b10434+, gated by the installed build tag from `/api/status`; the custom backend and older installs keep the previous merged `--chat-template-kwargs` path, and Preserve Thinking returns to its own kwargs object on native builds. Chat requests now send the effort level as top-level `reasoning_effort` (final precedence over the server default on new builds) while keeping the `chat_template_kwargs` fallback for older servers. Added a `GET /api/llama/props` proxy (mirroring the slots proxy) and a Chat sidebar hint when the loaded template reports `chat_template_caps.supports_reasoning_effort: false` — the control stays enabled because the capability is boolean-only. Capability probes retry after transient failures and ignore stale model generations.

- Added the llama.cpp defaults to the three ngram-mod tuning descriptions in Configure.

## 2026-08-18

- Documented upstream llama.cpp PR #27210 (adaptive MTP draft depth) in `docs/upstream-changes.md`: the new `--spec-type draft-mtp-adaptive` enum value, the new `--spec-draft-n-min-adaptive N` flag (default 3, env `LLAMA_ARG_SPEC_DRAFT_N_MIN_ADAPTIVE`), the changed roles of `--spec-draft-n-max` (adaptive ceiling) and `--spec-draft-n-min` (ignored by the adaptive type), the controller algorithm, and the planned definitions.js implementation steps. No feature code was implemented.
- Split ngram-mod out of the Speculative Type selector so it can stack with draft methods, added the three ngram-mod tuning controls, and preserved legacy `spec_type: "ngram-mod"` presets through shared launch-state migration.

## 2026-08-16

- Reworked `docs/custom_forks.md` around the intended flag-pack product: one fixed pack beside the custom backend, an immutable official/runtime registry split, namespaced pack IDs, safe preset and unknown-enum round-tripping, fail-closed validation, and explicit activation lifecycle and acceptance criteria. Custom-argument overrides and `--help` discovery remain optional follow-ups. No feature code was implemented.
- The Quick Launch Hugging Face progress bar now shows a finished state once a download completes: the bar fills solid green, the animated shimmer stops, and the label switches from "Downloading 100%" to "Download complete". The finished state also renders correctly when the page is reloaded after a completed download.

## 2026-08-15

- Updated the Speculative Decoding "Draft GPU Layers" control to emit llama.cpp's canonical `--spec-draft-ngl` argument and clarified that it accepts an exact layer count, `auto`, or `all`.
- Fixed preset round-trip losing the `--load-mode` "Legacy controls" choice: the Configure dropdown's change handler collapsed the empty-string option to unset, so a saved preset omitted the key and loading resurrected the new "mmap" default, silently suppressing the preset's legacy `--mlock`/`--mmap`/`-dio` switches in the launch command. The option is now stored as a real value and survives save/load (regression-tested in `launch_args_unit.cjs`; re-save any preset currently showing the wrong mode).

## 2026-08-14

- Documented llama.cpp's newly merged native `--reasoning-effort`, top-level API handling, template capability reporting, override precedence, compatibility constraints, and the planned Llama-GUI migration in `docs/upstream-changes.md`.
- Added a server-wide Default Reasoning Effort launch control with Auto, Low, Medium, High, and XHigh. Non-Auto choices emit `reasoning_effort` through `--chat-template-kwargs` for API clients and external harnesses, with request-level kwargs able to override the default; legacy Preserve Thinking now shares the same JSON argument.
- Added per-conversation Chat thinking controls for Auto, Off, Low, Medium, High, and XHigh. Compatible templates receive native `enable_thinking` / `reasoning_effort` kwargs per request, Off also sends the standardized top-level `reasoning_effort=none`, and Auto remains inert; assistant reasoning history now returns to llama-server as `reasoning_content` and survives web-search context injection so preserved-thinking templates can use the full trace.
- Made `--load-mode mmap` the default model-load setting and disabled the redundant deprecated `--mmap` control by default.
- Synced `docs/architecture.html` with the source tree: corrected the `app.py` (1011) and `state.py` (145) line counts, the `definitions.js` (1,816) and `index.html` (1.5k) figures, the backend test count (9 files, adding `test_docs_sync.py`, `test_model_dir.py`, `test_release_version.py`), the frontend test count (24 `.cjs` files, adding `test:flags` and `test:frontend:modules` commands), the service module count (13, documenting `backend/services/subprocess_utils.py`), and completed the localStorage key table with the six missing keys.

## 2026-08-13

- Made the custom model-folder path-resolution test POSIX-portable by creating its normalized directory before checking an equivalent path containing `..`.
- Fixed custom-model-folder follow-up issues found in diff review: successful saves retain authoritative launch state through status/model refresh races, stale model refreshes await the winning request, restart readiness uses status instead of model discovery, benchmark model-load errors are visible, status polls preserve operation errors, and Open llama.cpp recreates its missing directory.
- Added one user-configurable models folder with native Change/Reset controls and no restart required. The active root is validated and atomically persisted without overwriting unrelated config, published through status, and used consistently by model discovery, Open Models, model file pickers, Hugging Face model/projector downloads, normal launches, Model Switcher, command previews, and benchmarks. Presets remain root-relative, the default still emits `-m models/<id>`, unavailable custom folders fail closed, and folder changes cannot race active model downloads. Added focused backend/frontend tests and browser smoke coverage while preserving the `/api/models` array contract and keeping WikiText-2 in the default application data location.

## 2026-08-12

- Added `docs/custom-model-plan-final.md`, a deferred implementation plan for a single user-configurable model folder that preserves relative preset IDs and the `/api/models` contract, blocks unsafe fallback and active-download races, centralizes launch-path generation, and documents validation, synchronization, testing, and implementation pitfalls. No feature code was implemented.
- Shortened the Nightly app-update channel label while retaining its instability warning.
- Added preset archiving to the Presets tab: per-row, detail-panel, and bulk Archive/Restore controls move presets out of the main list into a 📦 Archived view without touching their files, so rename, delete, export, and `?preset=` shortcuts keep working. Archive state lives in an atomically written `.preset-archived` metadata file beside the presets, stays linked through renames, serializes concurrent changes, and is exposed via a validated `POST /api/presets/archive` route and an `archived` flag on `GET /api/presets`.
- Added a manual GitHub Actions stable-release workflow that tests the current `main` tip, calculates the next UTC CalVer version, packages the app, generates release notes, and publishes the tagged archive while Nightly commits continue to bake untagged.
- Removed the stale `-mv` / Vocoder Model server control and its unused file-picker purpose because current llama.cpp builds no longer accept that flag.
- Added a Stable/Nightly selector for Llama GUI app updates. Stable keeps targeting the newest tagged release; Nightly safely fast-forwards to the latest commit on the configured release branch while retaining dirty-tree, divergence, dependency-install, and restart protections.
- Corrected the README backend list: removed the non-existent macOS `KleidiAI` option and added Lemonade ROCm to the Linux list.
- Reworked the left sidebar into a compact persistent runtime dock: Launch/Stop and the danger-styled Python shutdown control remain reachable without scrolling, memory usage is an expandable stacked GPU/RAM estimate, the Model Switcher remains intact in a shorter panel, and a narrow icon-only theme control leaves more room for the adjacent build version.
- Added `ruff.toml` pinning Ruff's target to Python 3.9 (the CI floor) so modernization rules can never produce 3.9-incompatible rewrites, and documenting intentional ignores for the sanitizing broad-except policy (BLE001), ValueError validation helpers (TRY004), and deferred future-annotations (FA100). No lint fixes were applied; the 89 remaining findings stay as the documented baseline.

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
