# TODO

This backlog is ordered by implementation value. Prefer finishing the early safety and shared-state items before large refactors; the app's most important invariant is that Configure, Quick Launch, Chat, presets, and command preview all read from the same `flagCore` state.

## Phase 1 - Safety and Correctness Fixes

- [x] **Fix toast HTML injection in `showToast()`**
  - Replace the `toast.innerHTML` message interpolation in `ui/js/app.js` with DOM construction.
  - Keep the icon markup static, then append the user-facing message with `textContent`.
  - Add or update a frontend test that calls `showToast("<img onerror=...>")` and verifies the text is displayed as text, not parsed as HTML.

- [x] **Validate search source chip URLs before assigning `href`**
  - Add a small helper such as `getSafeExternalUrl(url)` in `ui/js/app.js`.
  - Accept only `http:` and `https:` URLs.
  - For invalid, empty, or unsupported schemes, render a non-link source chip or use `"#"` without opening a new page.
  - Cover `javascript:`, `data:`, protocol-relative, invalid URL strings, and normal HTTPS URLs.

- [x] **Replace category-header `innerHTML` in `config-flags-ui.js`**
  - Build the arrow, heading, and count elements with `document.createElement()`.
  - Assign `group.name` and `countText` with `textContent`.
  - This is low-risk because category names are local today, but it removes a latent XSS pattern before more dynamic metadata is added.

- [x] **Harden `escapeHtml()`**
  - Add `'` -> `&#39;` escaping in `ui/js/app.js`.
  - Keep this as defense in depth; do not treat it as a substitute for avoiding unsafe `innerHTML`.

- [x] **Add direct SSRF-gate tests for `get_local_proxy_host()`**
  - Add focused tests for `backend/services/chat.py`.
  - Cover allowed local hosts, rejected public hosts, malformed hosts, IPv6 local forms if supported, and port parsing behavior where relevant.
  - Keep these tests direct, not only through route/proxy tests.

## Phase 2 - Shared State and Flag Correctness

- [ ] **Remove direct global `FLAGS` usage from `config-flags-ui.js`**
  - Route `restoreFlagInputs()` through the existing dependency/configuration pattern instead of referencing `FLAGS` directly.
  - Reuse the same `getFlags()` source used by rendering and filtering.
  - Verify Configure controls still restore correctly after preset load, Quick Launch edits, and tool switches.

- [ ] **Guard numeric flag parsing against `NaN`**
  - In numeric input handlers, check `Number.isNaN()` after `parseInt()` / `parseFloat()`.
  - Empty input should clear the flag with `undefined`.
  - Invalid non-empty input should not write `NaN` into `flagCore`; show the browser's normal invalid state or a small inline validation state.
  - Confirm command preview never receives `NaN`.

- [ ] **Validate custom `gpu_layers` values**
  - Keep `gpu_layers` text-compatible because Quick Launch supports `auto`, `all`, and custom values.
  - Accept `auto`, `all`, `0`, and integer strings.
  - Reject or block launch-preview update for values like `abc`, `1.5`, whitespace-only strings, and negative values unless upstream explicitly supports them.
  - Route Quick Launch and Configure edits through the same validation path so mirrored controls cannot disagree.

- [ ] **Share KV cache enum options in `flags.js`**
  - Define one constant for the cache type options.
  - Reuse it for `cache_type_k`, `cache_type_v`, `draft_cache_type_k`, and `draft_cache_type_v`.
  - Confirm option labels/values remain unchanged in the UI.

- [ ] **Warn on invalid tool values in `getFlagsForTool()`**
  - Keep the current safe behavior of returning `[]`.
  - Add a `console.warn()` for unexpected tool values, including `undefined`, to make integration mistakes visible during development.

- [ ] **Resolve category/flag ID collisions deliberately**
  - Audit the collisions for `conversation`, `lora`, and `grammar`.
  - Prefer renaming category IDs only if they are not persisted or externally referenced.
  - If renaming would break saved state or tests, leave the IDs and add validation warnings/documentation instead of forcing churn.

## Phase 3 - Test Foundations

- [ ] **Add `flag-core.js` unit tests first**
  - Cover `setFlagValue()`, `setMultipleFlagValues()`, `applyFlagValues()`, `collectFlagValues()`, and tool switching.
  - Cover `getLaunchArgs()` for `bool`, `false_flag`, `int`, `float`, `text`, `enum`, `multi_enum`, inert-default filtering, unsupported chat templates, speculative flag omission, and model path validation.
  - These tests should be pure JS and not require a browser when possible.

- [ ] **Add `flags.js` validation tests**
  - Verify unique flag IDs, valid categories/tools/types, enum option shape, default value shape, duplicate CLI flags, and chat-template preset structure.
  - Reuse or expose logic from `flag-validation.js` instead of duplicating validation rules in tests.

- [ ] **Split `tests/frontend/flag_sync_smoke.cjs` into named cases**
  - Preserve the current coverage, but split the single `main()` flow into named scenarios.
  - Keep serving `ui/` as the web root.
  - Make failures point to the broken mirrored-control contract: Quick Launch -> Configure, Configure -> Quick Launch, Chat -> shared sampler state, and launch args.

- [ ] **Add targeted frontend feature tests after the flag-core base exists**
  - `config-flags-ui.js`: search/filtering, expand/collapse state, type-specific input builders, input restoration.
  - `presets.js`: save, load, update, delete, export, import, group-by-model rendering, warnings, search.
  - `manager.js`: `fetchJson()`, release fetching, installation progress UI, app update status.
  - `app.js`: tab switching, conversation history CRUD, markdown rendering, Quick Launch profiles, toast lifecycle, source-chip URL safety.

- [ ] **Add backend service tests around side-effect-heavy paths**
  - `download_file()` and archive extraction: success, checksum failure, traversal attempts, flat extraction behavior.
  - `install_release()`: mocked download/hash/extract/config save, plus network vs disk error messages.
  - `stream_output()` and `_build_process_env()`: output trimming and platform-specific path environment.
  - `launch_process()` / `stop_process()`: happy path, already-running path, missing-runtime path, graceful termination.
  - Remote tunnel worker: URL regex, stderr parsing, stopped state, error state.
  - HF download: chunked progress, cancellation event, partial file cleanup, overwrite behavior.
  - Concurrent state mutation: install and model-download locks reject duplicate starts.

- [ ] **Split `test_extracted_routes.py` when touching those routes**
  - Do this opportunistically, not as a standalone churn task.
  - Group by route family or service boundary so failures are easier to navigate.

## Phase 4 - Custom Launch Args

Goal: add an advanced Configure-tab textarea for raw `llama.cpp` flags that are not yet represented in `ui/js/flags.js`. This lets Llama GUI temporarily support new or renamed upstream flags without waiting for a full typed UI update.

### Behavior

- [ ] Add a `Custom Launch Args` textarea near the Configure command preview.
- [ ] Treat the value as shared launch state in `flagCore`, not as a per-tab scratch field.
- [ ] Store the raw value in preset `flags` under reserved key `custom_args`.
- [ ] Preserve `custom_args` through preset save, update, load, import, and export without a schema version bump.
- [ ] Update command preview immediately as the textarea changes.
- [ ] Parse shell-like tokens, including quoted values such as `--chat-template-kwargs '{"preserve_thinking":true}'`.
- [ ] Show an advanced-use warning that custom args may conflict with UI controls and may enable risky `llama.cpp` features.
- [ ] If parsing fails, show the parser error near the textarea and block launch with a clear command-preview status.

### Implementation

1. **Extend `ui/js/flag-core.js`**
   - Keep `flagValues.custom_args` as the raw textarea string.
   - Let existing `setFlagValue()`, `collectFlagValues()`, and `applyFlagValues()` preserve it naturally.
   - Do not add `custom_args` to `FLAGS`; it is not a real upstream flag definition.
   - Update `getLaunchArgs()` to return `{ args, error, warnings }`, keeping `warnings` optional for existing callers.

2. **Add a frontend parser**
   - Implement a pure helper such as `parseCustomLaunchArgs(raw)`.
   - Support whitespace splitting, single quotes, double quotes, and escaped characters inside double quotes.
   - Return `{ tokens }` on success or `{ error }` for unmatched quotes / malformed escapes.
   - Keep the parser frontend-only unless backend launch handling later needs the same exact parser.

3. **Append custom args deterministically**
   - Generate known UI flags first.
   - Parse and append custom tokens second.
   - Append the model argument last: `-m models/<selected model>`.
   - This lets advanced users override or supplement UI flags while keeping model placement predictable.
   - If duplicate known flags are detected in custom args, allow them but add a warning in the command-preview UI.

4. **Render and sync the textarea**
   - Prefer a static block in `ui/index.html` near the command preview.
   - Wire `input` to `window.LlamaGui.flagCore.setFlagValue("custom_args", value || undefined)`.
   - Add a refresh hook so `applyFlagValues()` and preset loads update the textarea.
   - Keep this Configure-only for now; do not add a Quick Launch duplicate unless there is a strong reason.

5. **Preserve preset behavior**
   - Confirm `presets.js` already preserves unknown flag keys.
   - Add a preset warning when `custom_args` is present, similar to unsupported chat-template warnings.
   - Do not change the preset wire shape unless a test proves unknown keys are being dropped.

6. **Verify**
   - Add unit tests for parser success and failure cases.
   - Extend frontend smoke coverage to enter custom args and verify command preview, `flagCore.getLaunchArgs().args`, and `flagCore.collectFlagValues().custom_args`.
   - Add a smoke case where a preset-shaped `applyFlagValues({ custom_args: "..." })` restores the textarea.
   - Run `node --check` on touched frontend scripts.
   - Run `tests/frontend/flag_sync_smoke.cjs` when Playwright is available.

## Phase 5 - Refactors After Coverage

- [ ] **Extract sampler preset UI helpers**
  - Share the dropdown population logic used by Configure and Quick Launch.
  - Share save/delete/export/import handler pieces where the behavior is identical.
  - Keep both tabs writing through `applySamplerPresetValues()` and `flagCore.setMultipleFlagValues()`.

- [ ] **Consolidate host/port extraction in `app.js`**
  - Route repeated host/port parsing through `getServerBaseUrl()` or one helper that returns `{ host, port, baseUrl }`.
  - Keep local-host validation on the backend; frontend cleanup is for consistency and fewer parsing bugs.

- [ ] **Extract `resetServerUI()`**
  - Centralize the repeated server-not-running cleanup block.
  - Include terminal/status text, quick launch status, server URL visibility, stats state, and disabled/enabled button states.
  - Avoid changing behavior while extracting.

- [ ] **Reduce silent error swallowing**
  - Replace empty `catch` blocks with `console.debug()` for expected optional failures and `console.warn()` for unexpected failures.
  - Do not spam the console for polling races or clipboard permission denials.
  - Add comments only where an ignored failure is intentional.

- [ ] **Extract magic numbers into named constants**
  - Start with values that are repeated or user-visible: debounce delay, poll intervals, toast duration, animation delay.
  - Keep constants close to the module using them unless a value is shared across modules.

- [ ] **Wrap `flags.js` in a namespace**
  - Move exported data under `window.LlamaGui.flags`.
  - Maintain backward-compatible globals temporarily if needed for existing scripts/tests.
  - Update consumers gradually to avoid a broad, fragile change.

- [ ] **Decompose `app.js` feature-by-feature**
  - Start only after the relevant tests exist.
  - Suggested order: toast/utilities, sampler presets, HF download, remote tunnel, stats/output polling, conversation history, chat, Quick Launch.
  - Each extraction should preserve script loading from `ui/index.html` and avoid changing the `python server.py` entrypoint.

- [ ] **Re-check backend split target before acting**
  - The old note references `backend/app.py`, but the current repo has behavior split between `server.py` and `backend/services/*`.
  - Before planning a split, map current route registration, service modules, and compatibility with the Pinokio launcher.
  - Prefer incremental service extraction over moving the server entrypoint.

## Ongoing llama.cpp Compatibility Work

- [ ] **Before adding or changing any flag in `flags.js`, verify upstream**
  - Check official `llama.cpp` docs and/or `llama-server --help`.
  - Confirm flag names, short aliases, value types, defaults, enum values, and deprecations.
  - Update tests and `flag_report.md` when the local UI intentionally differs from upstream defaults.

- [ ] **Move common Custom Launch Args into typed controls**
  - If users repeatedly need the same raw custom arg, add it to `ui/js/flags.js` as a normal typed flag.
  - Remove or reduce any docs that recommend raw args once a typed control exists.
