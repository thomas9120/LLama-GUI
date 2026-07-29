# TODO

Outstanding work only. Anything fixed has been removed; the full record of what was
reviewed, fixed, and rejected lives in
[code-review-swarm-2026-07-29-verification.md](code-review-swarm-2026-07-29-verification.md).

All High and Medium findings from the 2026-07-29 whole-repo review are done. What
remains is the `chat-ui.js` test harness, the Low-severity findings, and a tail of
Low items that were never verified either way.

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

## 2. Low severity — confirmed, unfixed

Each of these was read and verified during the review.

### Backend

- **`app.py:526` + `http.py:235` — duplicate `Access-Control-Allow-Origin` on `/`.**
  `is_static_ui_path("/")` is true so `end_headers` emits the header, and
  `send_versioned_index` routes through `Response.bytes`, which emits it again. More
  than cosmetic: browsers reject a duplicated ACAO outright.
- **`lifecycle.py:46` — `_wait_for_port_release` hardcodes `AF_INET`.** Every bind
  attempt raises for an IPv6 GUI host, so it returns `False`, logs a warning, and
  restarts anyway. Spurious warning plus a lost wait, not a hard failure.
- **`lifecycle.py:122` — `xdg-open`/`open` with no timeout** can hang the handler thread.
- **`process_manager.py:637` — `_memory_estimate_args` mishandles a valueless `-np`.**
  Worse than reported: with `["-np", "--verbose"]`, `int("--verbose")` raises,
  `parallel = 0` fails the range test, and `i += 2` eats **both** tokens.
- **`routes/process.py:26` — `launch` never checks `args` is a list.**
  `flatten_launch_args` iterates it, so a string explodes into one arg per character.
- **`routes/chat.py:146` — only `BrokenPipeError` is caught** on client disconnect.
  Windows raises `ConnectionAbortedError`/`ConnectionResetError`, neither of which is a
  subclass of it.
- **`web_search.py:234,264,293`** — `parsed.port` sits outside the `try` and raises
  `ValueError` on an out-of-range port; `f"Failed to fetch URL: {exc}"` returns raw
  exception text to the client; the ddgs loop calls `row.get(...)` with no
  `isinstance(row, dict)` guard.
- **`external_server.py:211` — `http.client.HTTPException` escapes `probe()`.**
  `HTTPError` is caught at `:202` and `URLError`/`OSError` at `:211`, but
  `BadStatusLine`/`IncompleteRead` are a sibling of neither.

  *Note on the last two:* the `dispatch_api_request` guard added in `backend/app.py`
  now converts these into a sanitized 500 rather than a dropped connection, so the
  user-visible symptom is gone. The root causes remain and should still be fixed.

### Frontend / assets

- **`ui/index.html:6`** — `<meta name="color-scheme" content="dark">` is hardcoded and
  the pre-paint IIFE sets only `documentElement.dataset.theme`. Brief dark flash for
  stored light themes.
- **`ui/templates/gemma4.jinja` vs `gemma4-e2b-e4b.jinja`** — byte-identical (both md5
  `83b2e13500209bb24795d5e2db730fa6`). Two presets are backed by one file; whether one
  should differ is a call for whoever added them.

### Tests

- **`flag_sync_smoke.cjs` — `startStaticServer` has no `'error'` listener.** A spawn
  failure (e.g. `python` not on PATH) emits `'error'` on the ChildProcess with no
  listener, crashing the runner with an unhandled-error trace instead of the intended
  message.

---

## 3. Unresolved — needs verification before acting

- **`external_server.py:359`** — "bearer key can be sent to an external host it wasn't
  minted for." Opened but **could not confirm as written**: `get_authorization`
  (`:161-167`) returns `ctx.state.external_chat_api_key` only when the target's
  `connected` flag is set — i.e. the key stored *with* the registered server. The
  described leak would need host/port to change while `external_chat_api_key` and
  `connected` persist, which was not traced. Resolve this before deciding whether
  there is anything to fix.

---

## 4. Not checked — no verdict yet

Reported by the original review but never opened, so these are neither confirmed nor
dismissed. Verify before fixing; roughly a third of the items that *were* checked
turned out to be wrong or misattributed.

**Backend**

- unlocked `save_config` read-modify-write races across several callers
- `llama_manager.py:496` — `activate_custom_backend` mutates config without the install
  lock (`process_manager.claim_install_slot()` now exists and is the natural fix)
- `hf_download.py:347,42,236,92` — cancel-event cleared outside lock; Windows reserved
  names (`con.gguf`) not rejected; bare `pass` on partial cleanup; zero-size files
  report `size_mb: None`
- `external_server.py:204` — silent empty catch
- `chat.py:113` — unguarded `ipaddress.ip_address` parse
- `file_picker.py:59` — macOS cancel detection matches the English "User canceled"
- `routes/lifecycle.py:21` — `post_open_folder`: unhashable `folder` raises; `mkdir`
  outside the `try`
- `http.py:169` — generic chat exception not logged to stderr when the tunnel is inactive
- `mac_linux_start.sh` — browser URL uses unsanitized port/host env vars; silent start
  discards all diagnostics

**Frontend**

- `app.js:951,700` — `updateMemoryEstimate` duplicates model-arg detection and omits
  `-mu`/`--model-url`; `getExecutableSuffix` sniffs `navigator.userAgent`
- `manager.js:670,1119` — silent empty catch in `waitForServerReady`; `refreshModels`
  has no stale-response guard
- `quick-launch-ui.js:458` — dead no-op branch
- `presets.js:405,2002,1538` — `__proto__` preset name breaks favorites maps; partial
  import leaves stale UI; failed load renders stale summary next to error
- `searchable-select.js:216` — popup reparented to body with listeners/`MutationObserver`
  never torn down
- `hf-download-ui.js:225` — silent empty catch in `refreshStatus`
- `external-server-ui.js:209,53` — `refresh()` overwrites in-progress host/port edits;
  disconnect badge wrongly reads "Connecting"
- `api-tab.js:297,280` — "Server ready" shown for any running process, not just
  llama-server; empty parsed API key sends a blank `Authorization: Bearer`
- `process-lifecycle.js:52` — `subscribe()` initial emit not error-isolated
- `benchmark-ui.js:96` — `statusTimer` is dead code
- `flag-core.js:445,309,411` — custom-args duplicate detection misses `-m`/`--model`;
  flag-name-valued tokens cause spurious duplicate warnings; an unsupported
  `chat_template` value is silently dropped from launch args with no warning

**Tests**

- `test_services.py:2838` — latent thread-poll flake
- `remote_tunnel_ui_unit.cjs` — `classList.toggle` stub has inverted no-force semantics
