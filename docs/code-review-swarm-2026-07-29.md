# Full-Repo Code Review — 2026-07-29 (swarm)

Whole-repo review by 18 parallel reviewers (no diff). Backend suite: 536 tests OK (2 platform-gated skips). Frontend suite: all 22 files green.

## High severity

- [ ] **H1 — `ui/js/config-flags-ui.js:983` — Configure-tab number inputs are nearly untypeable.** `restoreFlagInputs()` rewrites `el.value` on every keystroke: typing `0.8` eats the decimal point (`0.` parses to `0`), a leading `-` is wiped, mid-text edits lose the caret. The `text_list` branch above already has the `el.value !== nextValue` guard this branch lacks. Affects all int/float/text fields in Configure.
- [ ] **H2 — `ui/js/chat-ui.js:488` — aborted streams corrupt conversation history.** `loadConversation()`/`clearChat()` call `stopStream()` but don't await the pending stream; the `AbortError` catch then finalizes the old conversation's partial reply into the *new* conversation and saves it under the wrong id. `app.js:120` already has the correct await pattern (`abortActiveStream()` awaits `chatStreamPromise`) — these paths don't use it.
- [ ] **H3 — `backend/services/process_manager.py:1371` — `send_input` can deadlock the whole process layer.** `stdin.write`/`flush` runs under `process_lock`; a child that never drains stdin (llama-server ignores it) fills the OS pipe buffer (~64 KB) and blocks forever *with the lock held* — stop/status/launch all freeze.
- [ ] **H4 — `backend/routes/benchmarks.py:33,52` — partial WikiText-2 download cached as valid.** Extraction writes directly to the target; a mid-write failure leaves a truncated file that passes the `target.exists()` check forever after, silently feeding corrupt data to perplexity benchmarks. No lock either, so concurrent requests interleave writes to the same file.
- [ ] **H5 — `release.ps1:54-77` — release zips ship shell scripts with CRLF line endings.** The git blobs are clean LF, but `release.ps1` copies working-tree files verbatim; on a Windows checkout with `core.autocrlf=true` the staged `.sh` files keep CRLF, so the shebang becomes `#!/usr/bin/env sh\r` and every launcher fails on Linux/macOS. `.gitattributes` has no `*.sh text eol=lf` pin.

## Medium severity

- `backend/app.py:744` — no exception guard in `dispatch_api_request`; any route handler that raises drops the connection instead of a sanitized 500. Reachable via `routes/metrics.py`, `routes/search.py` (invalid-port URL → uncaught `ValueError` from `web_search.py:235`), unguarded `unlink`/`mkdir`/`rename` in `routes/presets.py`.
- `backend/app.py:740` — mid-stream proxy error corruption: `send_proxy_error()` writes a second HTTP response into an already-streaming `/v1` response if upstream fails after headers are sent.
- `backend/routes/process.py:117` — `cleanup_llama` rmtree's `llama/bin` with no lock and no `install_in_progress` check; races launch/install.
- `backend/services/llama_manager.py:890` — install deletes old binaries *before* the new archive is verified; failure leaves config claiming a version that no longer exists.
- `backend/services/hf_download.py:211` — downloaded byte count never verified against expected size; a clean short read installs a truncated GGUF and reports "done".
- `backend/services/git_update.py:131` — `git fetch` with no timeout/stdin redirect can hang the HTTP thread forever on a credential prompt.
- `backend/services/web_search.py:110` — SSRF filter misses `is_global`; CGNAT space (`100.64.0.0/10`, Tailscale) passes the private-IP check.
- `backend/services/lifecycle.py:91` — restarted server not detached on POSIX (unlike Windows); terminal close/Ctrl+C can kill the "restarted" GUI.
- `backend/services/process_manager.py:1163` — `launch_process` holds `install_lock`+`process_lock` across slow `ldd`/`otool` runtime validation; stalls all process endpoints for tens of seconds.
- `release.ps1` — also omits `Llama-GUI Logo.png` (served at runtime) and `scripts/`+`assets/` which the shipped `windows_install.bat` depends on.
- `ui/js/chat-ui.js:691` — `startNewChat()` never stops an in-flight stream; tokens strand into a fresh chat, input stays blocked.
- `ui/js/sampler-presets.js:327` — Save can never update an existing custom sampler preset (name fallback always hits "already taken"; missing `excludeCustomName`).
- `ui/js/presets.js:1731` — duplicate-preset name check is case-sensitive but the backend overwrites; on Windows/macOS `Foo` → `Foo copy` can clobber an existing `foo copy.json`.
- `ui/js/hf-download-ui.js:244` — 30-min poll timeout permanently desyncs UI from a still-running backend download (can't restart, can't resume polling).
- `ui/js/model-switch-ui.js:448` — failed preset load caches `[]` (truthy); slots render "Missing" indefinitely without retry.
- `ui/js/benchmark-ui.js:855, 800` — a refused stop or one transient `/api/output` error strands the benchmark UI with no way to stop/observe the still-running process.
- `ui/js/flag-core.js:484` — command preview joins tokens with spaces and never re-quotes; "Copy command" produces broken commands for values containing spaces.

## Low severity (selection)

- Duplicate `Access-Control-Allow-Origin` header on `/` (`app.py:519` + `http.py:235`); unlocked `save_config` read-modify-write races across several callers.
- `lifecycle.py:46` — `_wait_for_port_release` hardcodes `AF_INET`; always fails for IPv6 GUI hosts.
- `llama_manager.py:496` — `activate_custom_backend` mutates config without the install lock.
- `process_manager.py:637` — `_memory_estimate_args` drops the flag after a valueless `-np`.
- `lifecycle.py:122` — `xdg-open`/`open` with no timeout can hang the handler thread.
- `web_search.py:234,264,293` — uncaught `ValueError` on invalid ports; raw exception text returned to clients; missing dict guard on ddgs rows.
- `external_server.py:211,204,359` — `HTTPException` escapes `probe()`; silent empty catch; bearer key can be sent to an external host it wasn't minted for.
- `chat.py:113` — unguarded `ipaddress.ip_address` parse.
- `hf_download.py:347,42,236,92` — cancel-event cleared outside lock; Windows reserved names (`con.gguf`) not rejected; bare `pass` on partial cleanup; zero-size files report `size_mb: None`.
- `file_picker.py:59` — macOS cancel detection is locale-dependent (matches English "User canceled").
- `routes/lifecycle.py:21` — `post_open_folder`: unhashable `folder` raises; `mkdir` outside try.
- `routes/process.py:26` — `launch` doesn't validate `args` is an array (string explodes into per-char args).
- `routes/chat.py:146` — client disconnect mid-stream only catches `BrokenPipeError`; error paths re-raise on the dead socket (Windows: `ConnectionResetError`).
- `http.py:169` — generic chat exception not logged to stderr when the tunnel is inactive.
- `mac_linux_start.sh` — browser URL uses unsanitized port/host env vars; silent start discards all diagnostics.
- `ui/js/app.js:951,700` — `updateMemoryEstimate` duplicates model-arg detection and omits `-mu`/`--model-url`; `getExecutableSuffix` sniffs `navigator.userAgent` (platform decision in frontend).
- `ui/js/manager.js:670,1119` — silent empty catch in `waitForServerReady`; `refreshModels` has no stale-response guard.
- `ui/js/quick-launch-ui.js:477,458` — Auto-Fit target field can never be cleared; dead no-op branch.
- `ui/js/chat-ui.js:285,381,556,63` — empty-string sampler values can be sent; dead `host`/`port` payload; `regenerateResponse` early-return desyncs storage; sidebar sliders show stale/`NaN` values.
- `ui/js/presets.js:405,2002,1538` — `__proto__` preset name breaks favorites maps; partial import leaves stale UI; failed load renders stale summary next to error.
- `ui/js/searchable-select.js:216` — popup reparented to body with listeners/`MutationObserver` never torn down (leak if selects ever become dynamic).
- `ui/js/hf-download-ui.js:225` — silent empty catch in `refreshStatus`.
- `ui/js/external-server-ui.js:209,53` — `refresh()` overwrites in-progress host/port edits; disconnect badge wrongly reads "Connecting".
- `ui/js/api-tab.js:297,280` — "Server ready" shown for any running process, not just llama-server; empty parsed API key sends `Authorization: Bearer ` (blank).
- `ui/js/process-lifecycle.js:52` — `subscribe()` initial emit not error-isolated.
- `ui/js/benchmark-ui.js:96` — `statusTimer` is dead code.
- `ui/index.html:6` — pre-paint script doesn't update `meta[name="color-scheme"]`; brief dark flash for stored light themes.
- `ui/templates/gemma4.jinja` vs `gemma4-e2b-e4b.jinja` — byte-identical content backing two different presets; likely one ships wrong content.
- `ui/js/app.js:390` — `getChatTemplatePresetByBuiltinName()` is unreachable dead code.
- `ui/js/flag-core.js:445,309` — custom-args duplicate detection misses `-m`/`--model`; flag-name-valued tokens cause spurious duplicate warnings.
- `flag-core.js:411` — unsupported `chat_template` value silently dropped from launch args with no warning.
- `docs/flag_report.md:89` — stale count (says 53/51, actual 54/54).
- Tests: `test_services.py:2838` latent thread-poll flake; `llama_flags_supported_unit.cjs` vacuously green without binaries; `flag_sync_smoke.cjs` missing `'error'` listener; `remote_tunnel_ui_unit.cjs` `classList.toggle` stub has inverted no-force semantics.

## Verified clean

- Theme system: all invariants hold — no `[data-theme]` selectors or color literals in `style.css`; 5 THEMES entries ↔ 5 palette blocks, both directions; contrast tests pass.
- Flag definitions: 154 flags validated against the actual `llama-server`/`llama-cli` binaries; `-cd`/`ctx_size_draft` correctly absent and un-emittable; bool/`false_flag` logic correct.
- Chat XSS surface: all user content via `textContent`; `renderMarkdown` escapes before tag insertion; source URLs scheme-filtered.
- Tunnel service: generation-guarding, safe tar extraction, Windows CTRL_BREAK handling all correct.
- Custom launch-args parser, CORS/origin logic, `_BODY_HANDLED` sentinel usage (`is` comparisons), route registry integrity, npm scripts ↔ test files 1:1.
- Both test suites pass in full.
