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

**Backend**

- **`save_config` read-modify-write races — Confirmed (Low-Med).** `save_config`
  (`app.py:151`) does an atomic `tmp.replace`, but the *load → mutate → save* cycle is
  unserialized. Four callers share no config lock: `llama_manager` activate (`:498`) and
  install (`:945`), `process_manager` uninstall (`:1488`), `external_server` register
  (`:147`). A live install thread (writing version/tag) can race an external-server
  register (writing its key) — last writer wins and silently loses the other's fields.
- **`activate_custom_backend` bypasses the install lock — Confirmed (Low).** Route
  `activate_custom` (`install.py:128`) only checks `is_process_running`, never
  `_claim_install_slot()`, unlike the three install/update/uninstall paths.
  `process_manager.claim_install_slot()` / `release_install_slot()` already exist and are
  the natural fix. (Related to the race above.)
- **`hf_download` — Confirmed (four sub-items, all Low).**
  - *Cancel cleared outside lock.* The worker `finally` (`:369-371`) sets
    `model_download_in_progress = False` under `model_download_lock`, then clears
    `model_download_cancel` (`:371`) *outside* it — a stale clear can race a fresh
    `cancel.set()` from a later download. Fix: clear inside the lock.
  - *Windows reserved names.* `validate_hf_filename` (`:42`) has no
    `CON/PRN/AUX/NUL/COMx/LPTx` check, so `con.gguf` validates but fails to save on
    Windows.
  - *Bare `pass`.* `remove_partial_downloads` `except OSError: pass` (`:263`) violates
    the "no silent empty catch" invariant.
  - *Zero-size files.* `hf_file_to_dict` (`:92`): `round(size/...) if size else None`
    reports a real 0-byte file as `size:0, size_mb:None` (None usually means "unknown").
- **`external_server.py:204` silent empty catch — Confirmed (Low, justifiable).** Inner
  `except Exception: body = b""` reading an `HTTPError` body. Best-effort; the status is
  captured regardless. Borderline "expected optional" — a `print(..., stderr)` would
  satisfy the invariant.
- **`chat.py:113` unguarded `ipaddress.ip_address` — Confirmed (Low).** Actually
  `services/chat.py:113` (`get_local_proxy_host`): the loop parse is outside any try; an
  IPv6 scope-id sockaddr raises `ValueError` → caught by `app.py:817` as a generic 500
  instead of the intended "Blocked" message.
- **`file_picker.py:59` macOS English cancel match — Confirmed (Low).**
  `"User canceled" in result.stderr` is locale-dependent; on a non-English macOS a cancel
  falls through to `raise RuntimeError(<localized msg>)`.
- **`routes/lifecycle.py:21` unhashable folder / mkdir outside try — Confirmed (Low).**
  `folder_map.get(folder, ...)` raises `TypeError` for a list/dict `folder`, and
  `target.mkdir(...)` runs before the `try`. Both are caught by `app.py:817` — no crash,
  just a generic 500 instead of a 400 validation message.
- **`http.py:169` chat exception not logged when tunnel inactive — Confirmed (Low).**
  `sanitize_sse_error` only `print(..., stderr)` inside `if tunnel_active`. A local
  failure returns raw detail to the client but leaves no server-side log — violates
  "real error always to stderr".
- **`mac_linux_start.sh` — Confirmed (Low/marginal).** Port is not validated as numeric;
  `open_browser` does `>/dev/null 2>&1 || true`, discarding all diagnostics. These are
  operator-set env vars (quoted in the calls), so there's no injection — the
  "unsanitized" framing is weak; the discarded-diagnostics part is the real nit.

**Frontend**

- **`app.js` model-arg duplication — Confirmed (Low-Med).** `updateMemoryEstimate`
  (`app.js:945`) hand-rolls the check with only `-m/-hf/--model/--hf-repo`; the canonical
  `flag-core.js:358 hasLaunchModelArg` also has `-mu`/`--model-url`. A `--model-url`
  launch shows "Idle — Select a model". Classic duplication drift — call the shared
  helper.
- **`app.js` `getExecutableSuffix` sniffs `navigator.userAgent` — Confirmed (Low).**
  `app.js:706`: fallback when `latestStatus.executable_suffix` is absent. Minor
  "platform decision in frontend" invariant bend; the primary path uses backend status.
- **`manager.js` empty `catch` in `waitForServerReady` — Confirmed (Low, invariant).**
  `manager.js:670` `catch {}` — should be `console.debug` per the expected-optional rule.
- **`manager.js` `refreshModels` no stale-response guard — Confirmed (Low).** No
  request-id token (unlike `memoryEstimateRequestId` in `app.js`); two overlapping calls
  can apply the older list last.
- **`quick-launch-ui.js:458` dead no-op branch — Confirmed (Low).** Now at `:472-474`:
  `} else if (!quickLaunchGpuCustomSelected) { quickLaunchGpuCustomSelected = false; }`
  assigns the value the condition already guarantees.
- **`presets.js` `__proto__` breaks favorites maps — Confirmed (Low).**
  `loadPresetJsonMap` (`:376`) returns a plain object, so `favorites["__proto__"]` hits
  the prototype — a preset named `__proto__`/`constructor` can't be favorited and
  serializes as `{}`. Fix: `Object.create(null)` or a `Map`.
- **`presets.js` partial import leaves stale UI — Confirmed (Low).** `handlePresetImport`
  (`:2021`) POSTs in a loop; if one fails mid-loop the `catch` shows "Failed to import
  preset" but never calls `loadPresets()`, so already-created presets don't appear until a
  manual refresh.
- **`presets.js` failed load renders stale summary — Confirmed (Low).** `loadPresets`
  catch (`:1538`) still calls `renderPresetAuxiliaryPanels()`, which renders detail from
  the prior `currentPresetGroups` / `selectedPresetName` next to the error.
- **`searchable-select.js:216` popup/observer never torn down — Confirmed (Low, benign
  today).** Popup reparented to `body` in `open()`; the `MutationObserver` (`:288`) and
  the `select.value` override are never disconnected/restored; no `destroy()`. Benign for
  today's static selects, a leak if ever applied to a dynamic `<select>`.
- **`hf-download-ui.js:225` silent empty catch — Confirmed (Low, invariant).**
  `refreshStatus` `catch (e) { /* comment */ }` — should `console.debug`.
- **`external-server-ui.js` `refresh()` overwrites in-progress edits — Confirmed
  (Low-Med).** `refresh()` (`:209`) always passes `syncInputs:true`; `render` then sets
  `hostInput.value = target.host` with no `setInputValueUnlessEditing` / focus guard.
  Fires on every switch to the API tab, clobbering any in-progress host/port edit.
- **`external-server-ui.js` disconnect badge reads "Connecting" — Confirmed (Low,
  cosmetic).** `disconnect()` calls `render(getTarget(), {busy:true})`; `render` maps
  `busy → "Connecting"` regardless of operation, so a disconnect briefly shows
  "Connecting".
- **`api-tab.js` "Server ready" for any running process — Confirmed (Low-Med).**
  `runningText` (`:312`) keys off `latestStatus.running` (true for
  llama-bench/perplexity/cli), not `active_process_tool === "llama-server"` — a
  benchmark run misleadingly says endpoints are "ready".
- **`api-tab.js` empty parsed key sends blank `Bearer` — Confirmed (Low-Med).**
  `getApiAuthorizationHeaders` (`:278`) guards only on the raw `api_key`;
  `parseApiKeyCsv(",") → ["",""]`, then `selectedKey = undefined ?? keys[0]` = `""`, and
  `"" !== undefined` yields `Authorization: "Bearer "`.
- **`process-lifecycle.js:52` subscribe initial emit not isolated — Confirmed (Low).**
  `subscribe` calls `listener(getSnapshot())` directly, while `notify()` wraps each
  listener in try/catch — a throwing subscriber breaks the subscribe call.
- **`benchmark-ui.js:96` `statusTimer` dead — Confirmed (Low).** Declared `:100`, only
  referenced by the `beforeunload` `clearInterval` (`:978`); never assigned.
- **`flag-core.js` dup detection misses `-m`/`--model` — Confirmed (Low).**
  `getKnownCliFlags` derives from `FLAGS`; model flags aren't in `FLAGS`, so a user-typed
  `-m` in custom args isn't flagged though the app emits its own `-m`.
- **`flag-core.js` spurious duplicate warnings — Confirmed (Low, edge).** The parser is
  token-naive (no flag/value distinction); a value that exactly equals a known flag
  string is mis-flagged. Requires an unusual value.
- **`flag-core.js` unsupported `chat_template` silently dropped — Confirmed (Low-Med).**
  `:411` `continue` on an unsupported template emits no `warnings.push`, so a launch
  silently runs with no `--chat-template`.

**Tests**

- **`test_services.py` thread-poll flake — Confirmed (Low, latent).**
  `test_downloads_into_repo_subfolder` (`:2960`) spawns a **real** `threading.Thread`
  and polls up to 50×20 ms (~1 s) for terminal status — timing-dependent under CI load.
  (A sibling test patches `threading.Thread` with `ImmediateThread`; this one doesn't.)
- **`remote_tunnel_ui_unit.cjs` `classList.toggle` inverted — Confirmed (Low, test
  fidelity).** Stub (`:18-21`): `if (force) add else delete` — the omitted-`force` case
  always deletes instead of toggling, so `toggle("x")` never adds. Masks any SUT path
  relying on no-force toggle to add.
