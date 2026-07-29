# TODO

Outstanding work only. Anything fixed has been removed; the full record of what was
reviewed, fixed, and rejected lives in
[code-review-swarm-2026-07-29-verification.md](code-review-swarm-2026-07-29-verification.md).

All High and Medium findings from the 2026-07-29 whole-repo review are done, as are
every Low-severity finding that was actually verified. What remains is one unresolved
item and a tail of Low items that are now verified but still unfixed (see §2).

---

## Recently completed

### `chat-ui.js` unit-test harness — done 2026-07-30

- `tests/frontend/chat_ui_unit.cjs` (new, ~420 lines): `node:vm` harness modeled on
  `hf_download_ui_unit.cjs` / `chat_rendering_unit.cjs`. Loads the real
  `chat-rendering.js` into the same context, stubs `document` / `localStorage`, uses
  native `AbortController` / `TextDecoder`. The fetch stub's pending `read()` rejects
  with `AbortError` on a real microtask after `abort()` — the ordering the H2 bug
  depended on.
- `ui/js/chat-ui.js` (+9 lines, no behavior change): `_testSendMessage`,
  `_testLoadConversation`, `_testClearChat`, `_testStartNewChat`, `_testGetState`
  seams on `window.LlamaGui.chatUi` (same precedent as `_testPollOutput` in
  `benchmark-ui.js`). Both are now gated behind `window.__LLAMA_GUI_TEST_HOOKS__` —
  see the follow-up round below.
- Tests: happy-path stream (control) + the three H2 scenarios (`loadConversation`,
  `startNewChat`, `clearChat` mid-stream) asserting the aborted partial reply never
  lands in the conversation being switched to.
- Verify-by-reverting passed: patching all three `await abortActiveStream()` calls
  back to `stopStream()` makes the load-conversation test fail with exactly the H2
  corruption; restoring the `await`s is green.
- Registered in `package.json` `test` (after `chat_rendering_unit.cjs`) and
  `docs/tests.md`; full `npm test` chain green. Fix-status table row 3 in
  [code-review-swarm-2026-07-29-verification.md](code-review-swarm-2026-07-29-verification.md)
  updated.
- **Unlocked and fixed** the four deferred `chat-ui.js` findings — see below.

### Four `chat-ui.js` findings — done 2026-07-30

All four fixed in `ui/js/chat-ui.js`, each pinned by a test on the harness above and
verified by reverting (each revert fails its matching test):

- *Empty-string sampler values* (`getChatSamplerParams`): cleared Configure inputs (`""`)
  are now omitted from the chat payload for all five samplers plus `n_predict`.
- *Dead `host`/`port` payload fields*: removed (backend ignores and strips them,
  `backend/routes/chat.py:132-133`); the unused `getServerEndpointConfig` wiring in
  `chat-ui.js` went with them, and the dead `app.js` option was dropped in the
  follow-up round below.
- *`regenerateResponse` early-return desync*: the pop is now persisted before the early
  return, mirroring `undoMessage` (delete-when-empty, save otherwise).
- *Stale/`NaN` sidebar sliders*: `CHAT_SAMPLER_SLIDER_MAP` entries carry a `fallback`
  (`app-data.js`) matching the `index.html` slider defaults; `refreshSidebarUI` always
  sets slider + display, falling back on `""`/non-finite values. Display-only — flag
  state is not written back.

### Follow-up review of the above — done 2026-07-29

`/code-review` on the working tree found seven issues in the round above; all fixed.

- *`loadConversation` read-before-await* (`chat-ui.js`): the storage snapshot was taken
  *before* `await abortActiveStream()`, so reloading the conversation that was itself
  streaming restored a pre-abort message list and the next `saveCurrentConversation()`
  wrote it back, dropping the finalized turn. The read now happens after the await.
  Pinned by a new case in `chat_ui_unit.cjs`; verified by reverting (memory keeps
  `[B question]` while storage holds all three messages).
- *Sampler values not normalized* (`getChatSamplerParams`): the `!== ""` guards only
  covered empty strings, so numeric strings, `NaN`, and the string forms of the
  `0`/`1.0`/`-1` disable sentinels reached the wire — llama-server 400s on a string
  temperature, `NaN` serialized to `null`, and "disabled" samplers shipped as active.
  New `normalizeSamplerNumber` (`Number()` + `Number.isFinite()`) now feeds both the
  payload and `refreshSidebarUI`. Two new test cases; verified by reverting.
- *`n_predict` sentinel* (`refreshSidebarUI`): compared the raw value against `-1`, so
  `"-1"` rendered as `-1` while the slider clamped to its `min`. Now compares the
  parsed number. Covered by two new sidebar assertions.
- *`repeat_penalty` fallback*: was `1.1` in `app-data.js` against a flag default of
  `1.0` (`flags/definitions.js:701`), so the panel asserted a penalty that was never
  sent. Fallback and the `index.html` markup defaults are now both `1.00`.
- *Unbounded spin in the harness*: `while (!streamPending) await flush();` would hang
  `npm test` instead of failing it. Replaced with `flushUntil()` (1000-tick cap that
  throws).
- *Test hooks on the shipped namespace*: the five `_test*` mutators plus `_testGetState`
  are now attached only when `window.__LLAMA_GUI_TEST_HOOKS__` is set before
  `chat-ui.js` evaluates, so page/console callers can no longer invoke
  `_testClearChat()` and bypass the `confirmAction` flows. Verified in both directions.
  The pre-existing `_testPollOutput` export in `benchmark-ui.js` (which drives the live
  benchmark output watcher) is gated behind the same flag, with
  `benchmark_args_unit.cjs` opting in. Also verified in both directions.
- *Dead wiring*: `chatUi.configure({ getServerEndpointConfig })` removed from `app.js`
  and the test harness.

Full `npm test` chain green after all seven.

---

## 1. Unresolved — needs verification before acting - defer for now

- **`external_server.py:359`** — "bearer key can be sent to an external host it wasn't
  minted for." Opened but **could not confirm as written**: `get_authorization`
  (`:161-167`) returns `ctx.state.external_chat_api_key` only when the target's
  `connected` flag is set — i.e. the key stored *with* the registered server. The
  described leak would need host/port to change while `external_chat_api_key` and
  `connected` persist, which was not traced. Resolve this before deciding whether
  there is anything to fix.

---

## 2. Verified — all confirmed (Low unless noted)

Reported by the original review but never opened. Verified against the current tree
(2026-07-30): **every item is real.** Line references below are current, not the
original review's (those had drifted). Severity is Low across the board; a few reach
Low-Med. A fix plan is deferred.

One cross-cutting fact that caps two of the items: `app.py` dispatch wraps every route
handler in `try/except → sanitize_error(..., 500)` (`app.py:817`), so the "unguarded,
raises" findings below never leak a traceback — they degrade to a sanitized 500
instead of the intended specific message.

**Backend** *(all fixed 2026-07-30)*

- ~~**`save_config` read-modify-write races — Confirmed (Low-Med).**~~ Fixed: added `config_lock` to `ServerState`; all four callers now hold it across the load→mutate→save cycle.
- ~~**`activate_custom_backend` bypasses the install lock — Confirmed (Low).**~~ Fixed: `activate_custom` now claims/releases the install slot via `_claim_install_slot` / `release_install_slot`.
- ~~**`hf_download` — Confirmed (four sub-items, all Low).**~~
  - ~~*Cancel cleared outside lock.*~~ Fixed: `model_download_cancel.clear()` moved inside `model_download_lock`.
  - ~~*Windows reserved names.*~~ Fixed: `validate_hf_filename` now rejects `CON/PRN/AUX/NUL/COM1-9/LPT1-9` (case-insensitive, stem-only).
  - ~~*Bare `pass`.*~~ Fixed: `remove_partial_downloads` now prints to stderr on `OSError`.
  - ~~*Zero-size files.*~~ Fixed: `hf_file_to_dict` uses `if size is not None` so real 0-byte files report `size_mb: 0.0`.
- ~~**`external_server.py:204` silent empty catch — Confirmed (Low).**~~ Fixed: inner `except Exception` now prints to stderr.
- ~~**`chat.py:113` unguarded `ipaddress.ip_address` — Confirmed (Low).**~~ Fixed: wrapped in `try/except ValueError`; non-parseable addresses are skipped.
- ~~**`file_picker.py:59` macOS English cancel match — Confirmed (Low).**~~ Fixed: AppleScript now catches `error number -128` and returns `__CANCEL__`; Python checks for that sentinel instead of matching English stderr.
- ~~**`routes/lifecycle.py:21` unhashable folder / mkdir outside try — Confirmed (Low).**~~ Fixed: `folder` validated as `str` before map lookup; `mkdir` moved inside `try`.
- ~~**`http.py:169` chat exception not logged when tunnel inactive — Confirmed (Low).**~~ Fixed: `print(..., stderr)` now runs unconditionally before the `tunnel_active` branch.
- ~~**`mac_linux_start.sh` — Confirmed (Low/marginal).**~~ Fixed: port validated as numeric; `open_browser` stderr redirected to stderr instead of `/dev/null`.

**Frontend** *(all fixed 2026-07-30)*

- ~~`app.js` model-arg duplication — Confirmed (Low-Med).~~ Fixed: `updateMemoryEstimate` now calls `flagCore.hasLaunchModelArg`.
- ~~`app.js` `getExecutableSuffix` sniffs UA — Confirmed (Low).~~ Added `ponytail:` comment; no code change needed.
- ~~`manager.js` empty `catch` in `waitForServerReady` — Confirmed (Low).~~ Fixed: `catch (e) { console.debug(...) }`.
- ~~`manager.js` `refreshModels` no stale-response guard — Confirmed (Low).~~ Fixed: added `refreshModelsRequestId` counter.
- ~~`quick-launch-ui.js` dead no-op branch — Confirmed (Low).~~ Fixed: removed the `else if` branch.
- ~~`presets.js` `__proto__` breaks favorites maps — Confirmed (Low).~~ Fixed: `loadPresetJsonMap` returns `Object.create(null)`.
- ~~`presets.js` partial import leaves stale UI — Confirmed (Low).~~ Fixed: try/catch around loop; `loadPresets()` called on partial failure.
- ~~`presets.js` failed load renders stale summary — Confirmed (Low).~~ Fixed: removed `renderPresetAuxiliaryPanels()` from catch.
- ~~`searchable-select.js` popup/observer never torn down — Confirmed (Low).~~ Fixed: added `destroy()` method.
- ~~`hf-download-ui.js` silent empty catch — Confirmed (Low).~~ Fixed: `console.debug(...)`.
- ~~`external-server-ui.js` `refresh()` overwrites in-progress edits — Confirmed (Low-Med).~~ Fixed: activeElement guard on syncInputs.
- ~~`external-server-ui.js` disconnect badge reads "Connecting" — Confirmed (Low).~~ Fixed: `render()` accepts `options.label`; disconnect passes `"Disconnecting..."`.
- ~~`api-tab.js` "Server ready" for any running process — Confirmed (Low-Med).~~ Fixed: checks `active_process_tool === "llama-server"`.
- ~~`api-tab.js` empty parsed key sends blank `Bearer` — Confirmed (Low-Med).~~ Fixed: guards `selectedKey` by truthiness.
- ~~`process-lifecycle.js` subscribe initial emit not isolated — Confirmed (Low).~~ Fixed: try/catch around initial `listener(getSnapshot())`.
- ~~`benchmark-ui.js` `statusTimer` dead — Confirmed (Low).~~ Fixed: removed `statusTimer` declaration and `beforeunload` clearInterval.
- ~~`flag-core.js` dup detection misses model flags — Confirmed (Low).~~ Fixed: `getKnownCliFlags` includes model flags.
- ~~`flag-core.js` spurious duplicate warnings — Confirmed (Low, edge).~~ Added `ponytail:` comment; no code change.
- ~~`flag-core.js` unsupported `chat_template` silently dropped — Confirmed (Low-Med).~~ Fixed: `warnings.push(...)` before `continue`.

**Tests** *(1 fixed, 1 deferred)*

- **`test_services.py` thread-poll flake — Confirmed (Low, latent).** (Deferred — backend test, not in scope.)
- ~~`remote_tunnel_ui_unit.cjs` `classList.toggle` inverted — Confirmed (Low).~~ Fixed: stub now handles missing `force` argument correctly.
