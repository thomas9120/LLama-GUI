# Verification of `code-review-swarm-2026-07-29.md` — 2026-07-29

Independent re-check of the swarm review. Every High and Medium item was traced in
the source; the Low list was spot-checked (16 of ~35 items — the ones whose claims
were most falsifiable or most consequential). Items I did not open are listed at the
end as **not checked**, not as agreement.

Both suites were re-run on `beta` at commit `b470ef9`:

- Backend: `534 passed, 2 skipped, 117 subtests passed` (2.10s) — consistent with the
  review's "536 tests OK (2 platform-gated skips)".
- Frontend: all green. Notably `llama_flags_supported_unit.cjs` ran against the **real**
  binaries here (`llama/bin/llama-server.exe`, `llama-cli.exe`), validating 154 flags.

**Tally:** 5/5 High agreed. 13/17 Medium agreed, 3 partially, 1 disagreed.
Of 16 Low spot-checks: 13 agreed, 1 partial, 2 disagreed.

## Fix status (updated after remediation)

The seven items in "Suggested fix order" at the bottom of this document are **done**,
each with a regression test verified to fail against the pre-fix code:

| # | Item | Fix | Test |
|---|------|-----|------|
| 1 | H1 number inputs | `config-flags-ui.js` skips the focused input; `flag-core.js` passes `force` for wholesale applies. Same fix applied to `quick-launch-ui.js` (context / GPU / fit fields) | `flag_sync_smoke.cjs` — types `0.85` and `0.05` key by key |
| 2 | H5 CRLF launchers | `.gitattributes` pins `*.sh eol=lf` (plus `*.bat`/`*.ps1 eol=crlf`); working tree renormalized | verified by fresh `core.autocrlf=true` clone |
| 3 | H2 + `startNewChat` | all three paths `await abortActiveStream()` | `chat_ui_unit.cjs` — abort-mid-stream switch/load/clear ordering (verified by reverting the `await`s) |
| 4 | H4 + truncated GGUF | wikitext extracts via `.part` + size check under a lock; `download_hf_file` verifies `Content-Length` | 2 route tests + 3 `DownloadHfFileLengthTests` |
| 5 | `app.py` dispatch guard | sanitized 500; `Response.started` prevents a second response mid-stream | 3 `HandlerResponseTests` |
| 6 | H3 stdin deadlock | write moved out of `process_lock`, bounded by `SEND_INPUT_TIMEOUT_SECONDS` | 2 tests, one asserting the lock is free during a blocked write |
| 7 | `benchmark-ui.js:800` | tolerates `OUTPUT_POLL_MAX_FAILS` consecutive failures; no longer flips the UI to "not running" | — |

Suites after the fixes: backend **544 passed, 2 skipped** (was 534); frontend all green.

One correction to H1 below, found while testing: the failure is not only that the
decimal point is swallowed. Typing `0.85` into Temperature on the pre-fix code
produced **`850`** — the digits concatenate as each `.` is discarded, so the launch
silently used a temperature of 850 instead of 0.85. That is a wrong-value bug, not
just an input-annoyance bug.

Everything else in this document is unchanged and still outstanding.

---

## High severity

### H1 — `config-flags-ui.js:983` number inputs untypeable — **AGREE**

Chain traced end to end and it is worse than the write-up says:

`numField.addEventListener("input", …)` (`config-flags-ui.js:626` int / `:648` float)
→ `flagCore.setFlagValue` (`flag-core.js:134`) → `setMultipleFlagValues` (`:123`)
→ `postUpdate()` (`:128`) → `syncUiAfterSharedStateChange` (`app.js:154`)
→ `configFlagsUi.restoreFlagInputs()` (`app.js:155`) → `el.value = …` (`config-flags-ui.js:984`).

Synchronous, on every keystroke, with no `el.value !== nextValue` guard — unlike the
`text_list` branch at `:966` which has exactly that guard.

The float case is not merely "eats the decimal point", it makes the decimal point
**untypeable**. For `<input type="number">` the HTML value-sanitization algorithm blanks
any value that isn't a valid floating-point number, and `"0."` is not one. So typing `0.`
yields `numField.value === ""` → handler takes the `=== ""` branch (`:649`) → sets the flag
to `undefined` → `restoreFlagInputs` writes `el.value = ""` → the field is cleared. Same
mechanism wipes a leading `-`. Temperature, top-p, min-p, etc. cannot be typed at all;
only spinners/paste work.

Not covered by tests: `flag_sync_smoke.cjs:517` asserts `#flag-ctx_size` value but sets it
programmatically, never by keystroke.

### H2 — `chat-ui.js:488` aborted streams corrupt history — **AGREE**

Confirmed. `loadConversation` (`:644`) and `clearChat` (`:776`) both call bare
`stopStream()`. `abort()` rejects the pending `reader.read()` on a later microtask, so the
`catch` at `:486` runs *after* `loadConversation` has already reassigned
`currentConversationId` (`:646`) and `chatMessages` (`:647`). The old reply is then
finalized into the new conversation and saved under the new id.

`abortActiveStream()` (`:512`) is the correct pattern and is already wired into
`app.js:120` — these two call sites just don't use it. Fix is a one-line swap in each.

### H3 — `process_manager.py:1371` `send_input` deadlock — **AGREE** (reachability confirmed)

`stdin.write` + `flush` at `:1378-1379` are inside `with ctx.state.process_lock` (`:1372`).
`stdin=subprocess.PIPE` is set at launch (`:1204`). A child that never drains stdin fills
the pipe buffer and blocks in `flush()` **with `process_lock` held** — stop, status,
launch, and reap all freeze permanently.

I checked reachability since the write-up doesn't: this is not a hidden endpoint. There's a
visible **Send** button (`ui/index.html:768`, wired at `app.js:540`, posting to
`/api/send-input` at `app.js:1185`). A user repeatedly sending text to a running
llama-server hits it. It takes ~64 KB of accumulated input to fill the buffer, so it isn't
instant — but once hit it's unrecoverable without killing the GUI. High is defensible.

### H4 — `benchmarks.py:33,52` partial download cached as valid — **AGREE**

Confirmed exactly. `open(target, "wb")` at `:52` writes straight to the final path. Any
failure mid-`copyfileobj` (disk full, killed process) leaves a truncated file that
satisfies `target.exists()` at `:33` forever after. No `.part`-then-`replace` pattern, and
no lock — concurrent requests interleave writes into the same handle.

Worth noting the contrast: `hf_download.py:209/226` *does* use the `.part` + `replace`
pattern. The same fix applies here.

### H5 — `release.ps1:54-77` ships CRLF shell scripts — **AGREE** (verified empirically)

I reproduced it rather than reasoning about it. `.gitattributes` contains only
`* text=auto`, with no `*.sh text eol=lf` pin, and `core.autocrlf=true` locally.

A fresh clone with `core.autocrlf=true`:

```
i/lf    w/crlf  attr/text=auto    install.sh
i/lf    w/crlf  attr/text=auto    mac_linux_start.sh
```

and the first line of `install.sh` in that clone is literally:

```
#   !   /   u   s   r   /   b   i   n   /   e   n   v       s   h  \r  \n
```

`release.ps1` copies working-tree files verbatim (`Copy-Item` at `:76`), so the zip ships
`#!/usr/bin/env sh\r` and every launcher fails on Linux/macOS with a bad-interpreter error.
Adding `*.sh text eol=lf` to `.gitattributes` fixes it at the source.

---

## Medium severity

**`app.py:744` — no exception guard in `dispatch_api_request` — AGREE.** Confirmed: no
`try`/`except` anywhere in `do_GET` (`:768`) / `do_POST` (`:802`) / `do_DELETE` (`:827`)
→ `dispatch_api_request` → `match.handler(...)` at `:766`. An uncaught handler exception
reaches `socketserver.handle_error`, which drops the connection instead of returning a
sanitized 500. I confirmed the claimed `routes/search.py` path is genuinely live:
`web_search.py:235` does `parsed.port` **outside** the `try` that starts at `:240`, and
`urlparse(...).port` raises `ValueError` on an out-of-range port. A user-supplied
`http://host:99999/` drops the connection.

**`app.py:740` — mid-stream proxy error corruption — AGREE.** `end_headers()` at `:714`,
then streaming writes at `:721`/`:728`. An upstream failure after that point (not a
connection error — those are caught at `:730`) falls to `:740`, which calls
`send_proxy_error` → `send_error_json` → a second full HTTP response written into the
already-streaming body.

**`routes/process.py:117` — `cleanup_llama` unlocked — AGREE.** It checks
`is_process_running` (`:118`) but takes no lock and never consults
`ctx.state.install_in_progress`, then `remove_llama_files` rmtree's `llama_bin` /
`llama_grammars` (`process_manager.py:1390-1396`). A concurrent install is extracting into
those exact directories.

**`llama_manager.py:890` — install deletes before verify — PARTIALLY DISAGREE.** The stated
mechanism is wrong. `verify_archive` runs at `:871` (main archive) and `:882` (extras),
both **before** the `rmtree` at `:890`. SHA256 verification does precede deletion.

The conclusion still holds, via a different path: deletion precedes **extraction**
(`:897`/`:901`), and the config update is at `:909-913`, *after* extraction. So a failed
or interrupted extraction leaves `llama/bin` empty while config still names the old
version — a version that no longer exists on disk. Same user-visible outcome, different
cause, and the fix is different (extract to a temp dir and swap, rather than reordering
verification).

Separately, and not mentioned in the review: `verify_archive` returns `True` at `:855`
whenever `get_release_asset_sha256` yields `None`. A release that ships no checksum is
installed with no integrity check at all.

**`hf_download.py:211` — unverified byte count — AGREE, and it's genuinely silent.** I
checked why this doesn't surface as an error: CPython's `HTTPResponse.read(amt)` explicitly
declines to raise `IncompleteRead` on a short read (the source carries a comment saying
raising "might break compatibility") and just closes the connection. So a truncated
transfer returns `b""`, the loop at `:216` breaks normally, and `tmp_path.replace(dest)`
at `:226` installs the partial GGUF as complete. `downloaded` is returned but never
compared against `total_bytes`. Good catch.

**`git_update.py:131` — `git fetch` can hang — AGREE.** `run_git` passes no `timeout=` and
no `stdin=subprocess.DEVNULL`, and `GIT_TERMINAL_PROMPT=0` isn't set in the environment.
On Windows, Git Credential Manager can raise a GUI prompt that blocks the HTTP thread
indefinitely.

**`web_search.py:110` — SSRF filter misses `is_global` — AGREE.** Confirmed against
Python's `ipaddress`: `100.64.0.0/10` is **not** in `IPv4Address._constants._private_networks`,
and it's not loopback, link-local, multicast, reserved (`240.0.0.0/4`), or unspecified. It
is excluded only by `is_global`, which isn't checked. CGNAT and Tailscale ranges pass the
filter.

**`lifecycle.py:91` — restarted server not detached on POSIX — AGREE.** `creationflags=… if
sys.platform == "win32" else 0` with no `start_new_session=True` on the else branch, so on
POSIX the child stays in the parent's process group and dies with the terminal or on Ctrl+C.

**`process_manager.py:1163` — slow validation under two locks — AGREE, with mitigations the
write-up omits.** Both locks are held (`:1163`) across `_validate_launch_environment`
(`:1174`) → `validate_runtime_dependencies` → `ldd`/`otool`. But: it returns immediately on
Windows (`llama_manager.py:349-355` early-returns for non-darwin/non-linux); results are
cached for `RUNTIME_HEALTH_CACHE_TTL_SECONDS = 5.0`; and each subprocess is capped at
`timeout=10` (`:281`, `:319`). "Tens of seconds" is reachable only on Linux/macOS with a
cold cache and several `libggml*.so*` probe files. Real, but narrower than stated.

**`release.ps1` omissions — AGREE, all three confirmed with consumers.**
`Llama-GUI Logo.png` → `APP_LOGO_FILE` (`backend/config.py:23`), served at
`/assets/app-logo.png` (`app.py:776`) and referenced twice in `ui/index.html` (`:8` favicon,
`:49` header). `scripts/create_windows_shortcuts.ps1` → invoked by `windows_install.bat:53`.
`assets/Llama-GUI.ico` → used by that script at `:158`. None are in the `$items` array
(`release.ps1:54-69`).

**`chat-ui.js:691` — `startNewChat` never stops a stream — AGREE.** Confirmed: no
`stopStream`/`abortActiveStream` anywhere in the function. Same class as H2.

**`sampler-presets.js:327` — can't update a custom preset — AGREE, precisely right.**
`isSamplerPresetNameTaken(name, store, excludeCustomName = "")` exists at `:119`, and rename
correctly passes the exclusion at `:155` (`…(to, store, from)`). Save at `:336` omits it. So
with an empty name field and a custom preset selected, `name` falls back to
`selected.name` (`:330`), which is by definition already in the store → the "already taken"
alert fires and Save always aborts.

**`presets.js:1731` — case-sensitive duplicate check — AGREE.** `buildDuplicatePresetName`
(`:459`) tests `taken.has(base)` against a `Set` of exact names — case-sensitive. The
backend's `sanitize_preset_name` (`routes/presets.py:67`) does not case-fold, and
`save_preset` defaults `overwrite` to `True` (`:260`). So with an existing `foo copy.json`,
duplicating `Foo` produces `Foo copy`, which the Set check misses, and on
Windows/macOS the write silently clobbers `foo copy.json`. Data loss confirmed.

**`hf-download-ui.js:244` — 30-min poll timeout — AGREE, severity lower than stated.** The
timeout path (`:244-249`) does clear the timer and `setBusy(false)` while the backend
download continues. But it is not permanent: `refreshStatus()` (`:201`) calls `pollProgress()`
when the download is still active (`:222-224`), so a page reload recovers. "Permanently
desyncs" overstates it; "desyncs until reload" is accurate.

**`model-switch-ui.js:448` — ~~DISAGREE~~ AGREE. My verdict was wrong; corrected during
remediation.**

I read only `loadPresetEntries` and concluded a failed load caches nothing. It does cache —
one level up. `refresh()` catches the error and runs `if (!presetEntries) presetEntries = [];`
(`:634`). An empty array is **truthy**, so the cache guard at `:449`
(`if (presetEntries && !force)`) hands it back on every later unforced refresh. The original
finding was right: one failed fetch leaves the slots reading "Missing" with no retry.

What I got right, but for the wrong reason: `fetchPresetEntries` does throw rather than
return `[]` (`presets.js:68-70`), and `loadPresetEntries` itself assigns only on success.
That made the loader look clean in isolation — the defect was in its caller, which I never
opened. Verifying a cache claim means following *every* write to the cached variable, not
just the one inside the loader.

Fixed by dropping the `presetEntries = []` assignment so a failure leaves it `null`
("not loaded"), and rendering from `presetEntries || []`. A successful load is still cached;
a warm cache now survives a failed reload instead of blanking slots the user is looking at.

**`benchmark-ui.js:855, 800` — HALF AGREE.**

`:800` — **agree, and this is the real bug.** The `catch` in `pollOutput` calls
`stopOutputPolling()` and `setRunningState(false)` (`:803-804`) on a *single* transient
`/api/output` failure. The UI then shows Run instead of Stop while the benchmark process is
still alive, and clicking Run gets rejected by the backend with "A process is already
running". Unlike the sibling `hf-download-ui.js` poller, there's no failure-count tolerance.

`:855` — **disagree.** `stopBenchmark`'s `onFailed` handler (`:861-865`) explicitly calls
`setRunningState(true)` and `startOutputPolling()`, which is exactly the recovery the
finding says is missing. A refused stop leaves the Stop button visible and polling running.

**`flag-core.js:484` — unquoted command preview — AGREE.** `parts.join(" ")` at `:485` with
no re-quoting. Confirmed the copy buttons are real and user-facing:
`ui/index.html:749` (`btn-copy-command`), `:654`, `:1257`, wired at `app.js:544`. Any model
path containing a space yields a command that is broken when pasted.

---

## Low severity — spot checks

**Agreed (13):**

- **Duplicate `Access-Control-Allow-Origin` on `/`** — confirmed. `is_static_ui_path("/")`
  is `True` (`http.py:151`) so `end_headers` emits the header (`app.py:526`), and
  `send_versioned_index` (`app.py:556`) routes through `Response.bytes`, which emits it
  again at `http.py:235`. Worth noting this is more than cosmetic: browsers reject a
  duplicated ACAO header outright.
- `lifecycle.py:46` `_wait_for_port_release` hardcodes `AF_INET` — confirmed. Consequence is
  bounded: every bind attempt raises, the function returns `False`, and `:88-89` logs a
  warning and restarts anyway. Spurious warning plus a lost wait, not a hard failure.
- `process_manager.py:637` `-np` handling — confirmed, and slightly worse than stated. With
  `["-np", "--verbose"]`, `int("--verbose")` raises, `parallel = 0` fails the `1 <= p <= 256`
  test, and `i += 2` at `:649` skips **both** tokens — the following flag is eaten too.
- `lifecycle.py:122` `xdg-open`/`open` with no timeout — confirmed (`:123`, `:125`).
- `web_search.py:234,264,293` — all three confirmed: `parsed.port` outside the `try`;
  `f"Failed to fetch URL: {exc}"` returning raw exception text to the client; and
  `row.get(...)` with no `isinstance(row, dict)` guard in the ddgs loop.
- `external_server.py:211` — agreed in substance, loose in naming. There's no
  `HTTPException` handler; `urllib.error.HTTPError` is caught at `:202` and
  `URLError`/`OSError` at `:211`, but `http.client.HTTPException` (`BadStatusLine`,
  `IncompleteRead`) is a sibling of neither and escapes `probe()`. Combined with the
  `app.py:744` gap, that's a dropped connection.
- `routes/process.py:26` — confirmed, `args` is never checked to be a list.
  `flatten_launch_args` (`process_manager.py:452`) iterates it, so a string explodes into
  one arg per character.
- `routes/chat.py:146` — confirmed, only `BrokenPipeError` is caught. Windows raises
  `ConnectionAbortedError`/`ConnectionResetError` on client disconnect, neither of which is
  a `BrokenPipeError`.
- `index.html:6` — confirmed. `<meta name="color-scheme" content="dark">` is hardcoded and
  the pre-paint IIFE (`:22-31`) sets only `documentElement.dataset.theme`, never the meta.
  Brief dark flash for stored light themes.
- `gemma4.jinja` vs `gemma4-e2b-e4b.jinja` — confirmed byte-identical (both md5
  `83b2e13500209bb24795d5e2db730fa6`). Whether one *should* differ is a call for whoever
  added them, but two presets are definitely backed by one file.
- `quick-launch-ui.js:477` — confirmed, and it's the same class of bug as H1:
  `fitTarget.value = String(values.fit_target ?? "1024")` forces `1024` back into a cleared
  field, while the adjacent `fitCtx` at `:478` correctly uses `?? ""` and stays clearable.
- Test: `flag_sync_smoke.cjs` missing `'error'` listener — confirmed. `startStaticServer`
  attaches only `server.stderr.on("data", …)` (`:54`); a spawn failure (e.g. `python` not on
  PATH) emits `'error'` on the ChildProcess with no listener, crashing the runner with an
  unhandled-error trace instead of the intended message.
- `hf_download.py` `.part` staging — noted here only as the correct counter-example to H4.

**Partially disagree (1):**

- Test: `llama_flags_supported_unit.cjs` "vacuously green without binaries". It does exit 0
  without binaries (`:132`), but not silently — `:129` prints
  `"llama flag compatibility check skipped: no llama-server or llama-cli executable found."`
  That's an announced skip, which is a reasonable design for a test requiring real binaries,
  not a defect. In this run it executed against the real binaries and validated 154 flags.

**Disagree (2):**

- **`app.js:390` `getChatTemplatePresetByBuiltinName()` is unreachable dead code — no.** It's
  called at `app.js:417`, inside `getSelectedChatTemplateDropdownValue()`, as the third
  resolution step after the bundled-path and direct-value lookups. Live code on the chat
  template selection path.
- **`docs/flag_report.md:89` stale count — no.** The document already corrects itself. Line
  85 reads "upstream exposes 54 built-in template names and local `BUILTIN_CHAT_TEMPLATES`
  contains the same 54", and the 53/51 numbers sit under an explicit heading: *"Original
  (incorrect) finding, retained for the record."* Deliberately preserved history, not rot.

**Not checked** (no verdict — these were not opened): the `save_config` read-modify-write
races; `llama_manager.py:496`; `hf_download.py:347,42,236,92`; `file_picker.py:59`;
`routes/lifecycle.py:21`; `http.py:169`; `mac_linux_start.sh`; `external_server.py:204`;
`chat.py:113`; `app.js:951,700`; `manager.js:670,1119`; `quick-launch-ui.js:458`;
`chat-ui.js:285,381,556,63`; `presets.js:405,2002,1538`; `searchable-select.js:216`;
`hf-download-ui.js:225`; `external-server-ui.js:209,53`; `api-tab.js:297,280`;
`process-lifecycle.js:52`; `benchmark-ui.js:96`; `flag-core.js:445,309,411`;
`test_services.py:2838`; `remote_tunnel_ui_unit.cjs`.

One partial correction to the "Not checked" list: `external_server.py:359` ("bearer key sent
to a host it wasn't minted for") I did open, and **could not confirm** it as written.
`get_authorization` (`:161-167`) returns `ctx.state.external_chat_api_key` only when the
target's `connected` flag is set — i.e. the key stored *with* the registered server. The
described leak would require host/port to change while `external_chat_api_key` and
`connected` persist, which I didn't trace. Flagging it as unresolved rather than agreeing.

---

## Verified clean section

The claims I could cheaply re-test hold. Both suites pass at `b470ef9`; the flag-definition
test validates 154 flags; `llama_flags_supported_unit.cjs` ran against real binaries rather
than skipping. I did not independently re-derive the theme-invariant, XSS-surface, or
tunnel-service audits.

## Suggested fix order

1. **H1** — one-line guard (`if (el.value !== next) el.value = next`), mirroring `:966`.
   Highest user-visible impact for the smallest change; also fixes `quick-launch-ui.js:477`.
2. **H5** — add `*.sh text eol=lf` to `.gitattributes`. Every released Linux/macOS zip is
   currently broken.
3. **H2 / `chat-ui.js:691`** — swap three `stopStream()` calls for `await abortActiveStream()`.
4. **H4** and **`hf_download.py:211`** — both are "write to a temp path, verify, then
   `replace`"; `hf_download.py:209/226` already has the pattern to copy.
5. **`app.py:744`** — wrap `match.handler(...)` in a try/except returning a sanitized 500.
   Cheap, and it contains several of the Low findings at once.
6. **H3** — move the `stdin.write`/`flush` out from under `process_lock`, or drop the write
   when the pipe would block.
7. **`benchmark-ui.js:800`** — add a failure-count tolerance like the HF poller's.
