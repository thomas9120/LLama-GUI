# TODO

Outstanding work only. Anything fixed has been removed; the full record of what was
reviewed, fixed, and rejected lives in
[code-review-swarm-2026-07-29-verification.md](code-review-swarm-2026-07-29-verification.md).

All High and Medium findings from the 2026-07-29 whole-repo review are done, as are
every Low-severity finding that was actually verified. What remains is the
`chat-ui.js` test harness, one unresolved item, and a tail of Low items that are now
verified but still unfixed (see §3).

---

## 1. Build a `chat-ui.js` unit-test harness

**Status:** not started · **Est.:** ~150–200 lines of harness + tests

`ui/js/chat-ui.js` is the only frontend module with no unit test. That gap blocks
coverage for one already-fixed bug and four outstanding findings, so the harness is
worth building once rather than paying for it per item.

### Why it matters

The aborted-stream conversation-corruption fix (H2) shipped with **no automated
coverage**. `loadConversation`, `clearChat`, and `startNewChat` now
`await abortActiveStream()` instead of calling `stopStream()` and racing the
`AbortError` handler. It is three `await` keywords — exactly what a future refactor
drops silently, and nothing breaks visibly in normal use because the corruption only
appears when a conversation is switched mid-stream.

### What it unlocks

| Location | Finding |
|---|---|
| `chat-ui.js:285` | empty-string sampler values can be sent to the backend |
| `chat-ui.js:381` | dead `host`/`port` fields in the request payload |
| `chat-ui.js:556` | `regenerateResponse` early-return desyncs stored conversations |
| `chat-ui.js:63` | sidebar sliders show stale / `NaN` values |
| `chat-ui.js:691` | `startNewChat` stream handling (fixed, unpinned) |

### Scope

Follow the existing `node:vm` pattern — closest models are
`tests/frontend/hf_download_ui_unit.cjs` (333 lines) and `model_switch_ui_unit.cjs`
(404 lines). Name it `chat_ui_unit.cjs`, register it in the `test` script in
`package.json`, and add a line to the module list in [tests.md](tests.md).

Stubs required (`chat-ui.js` surface: 69 `document.*`, 12 `localStorage`, 7
`AbortController`, plus `fetch`/`getReader`/`TextDecoder`):

1. **`localStorage`** — conversation storage round-trip.
2. **`document`** — `getElementById` + `querySelectorAll`; unlike the existing
   `createElement` stub in `hf_download_ui_unit.cjs`, `addEventListener` must actually
   record callbacks if any test drives handlers rather than calling functions directly.
3. **`fetch`** — returns a body whose `getReader()` yields SSE chunks and rejects with
   an `AbortError` when the signal fires. `AbortController` and `TextDecoder` are
   native in Node; use them rather than faking them.

`loadConversation`, `clearChat`, and `startNewChat` are not exported. Add `_test*`
seams to `window.LlamaGui.chatUi` — existing precedent, `benchmark-ui.js` already
exports `_testPollOutput` for the same reason.

### The one thing to get right

The H2 test is only meaningful if the stubbed reader rejects **asynchronously**, on a
real microtask. That reproduces the ordering the bug depended on: `abort()` →
synchronous reassignment of `currentConversationId` / `chatMessages` → `AbortError`
handler finalizes the old reply into the *new* conversation. A stub that rejects
synchronously passes with or without the `await` and proves nothing.

**Verify by reverting.** Patch the three `await abortActiveStream()` calls back to
`stopStream()`, confirm the test fails, then restore. Note that `git stash` is not
reliable for this once the fix is committed — it silently stashes nothing and the
"before" run passes with the fix still in place. Patch the file directly instead.

### Not the answer

A Playwright smoke test against a fake SSE endpoint costs nearly as much and covers
only H2, leaving the other four findings untestable. If the harness is not built, the
honest position is that H2 is covered by code review and nothing else.

---

## 2. Unresolved — needs verification before acting - defer for now

- **`external_server.py:359`** — "bearer key can be sent to an external host it wasn't
  minted for." Opened but **could not confirm as written**: `get_authorization`
  (`:161-167`) returns `ctx.state.external_chat_api_key` only when the target's
  `connected` flag is set — i.e. the key stored *with* the registered server. The
  described leak would need host/port to change while `external_chat_api_key` and
  `connected` persist, which was not traced. Resolve this before deciding whether
  there is anything to fix.

---

## 3. Verified — all confirmed (Low unless noted)

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
