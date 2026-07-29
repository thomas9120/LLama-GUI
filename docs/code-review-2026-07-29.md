# Code Review — 2026-07-29

Repo-wide review for concrete errors/defects (not style or cleanup). Reviewed by 13 parallel reviewers covering: backend core, backend routes, process-lifecycle services, remaining backend services, flag definitions, shared flag state, Configure/Quick Launch UI, chat UI, presets/samplers, manager/model UIs, remaining UI modules, HTML/CSS shell, and tests/root plumbing. Priorities: **P0** release-blocking, **P1** high-impact, **P2** ordinary correctness issue, **P3** low-impact but actionable.

No P0 findings.

## Independent verification — 2026-07-29

Audited against the current `beta` working tree and the bundled llama.cpp binaries. Result: **30 findings verified**, **4 verified with corrections**, and **0 rejected**. “Verified with correction” means the underlying defect is real, but one trigger or explanatory detail was overstated.

Disagreements / qualifications:

- The `apply_diff` failure is verified, but there is no equivalent Built-in Tools control in Quick Launch; the direct UI trigger is Configure (with imported/shared state as another path).
- The preset encoding mismatch is verified, but the Windows failure is locale-dependent: it occurs when Python uses a non-UTF-8 locale encoding such as cp1252, not on every Windows configuration.
- The backend logging finding is verified as an invariant violation, but `backend/routes/status.py:36-37` silently substitutes a fallback rather than exposing `str(exc)`; the other cited paths expose/store exception text.
- The sampler collision finding is verified, but exact-case import of `Creative` is already renamed to `Creative (2)`. Import still misses case-insensitive collisions such as `creative`, while Save can create the exact duplicate `Creative`.

Independent checks repeated during verification:

- All fast frontend tests passed; the Playwright smoke test passed separately after Chromium launch permission was granted.
- `python -m unittest discover tests -v` passed: 511 tests, 2 skipped.
- Direct probes reproduced the unsupported `apply_diff` failure, the dual chat-template emission, malformed-port `ValueError`s, unbracketed IPv6 URL failure, and `Authorization` propagation through `urllib` redirects.
- The live llama.cpp release API returned 24/24 assets with non-empty `digest` fields and no `sha256` property.

## Resolution progress

- **Batch 1 complete:** release asset SHA256 digests are verified when GitHub supplies a usable `digest` value, while missing/unsupported metadata remains warning-only; cloudflared downloads and extraction now stage into temporary paths before atomic replacement; external-server probes no longer follow redirects or forward API keys to redirect targets.
- Batch 1 verification: `python -m py_compile` passed for all touched Python files; `python -m unittest discover tests -v` passed 517 tests with 2 platform-dependent skips.
- **Batch 2 complete:** installs and launches now claim runtime access atomically; release lookup failures leave install progress in an error state; tunnel workers are generation-bound across start/stop races; idle HF cancellation is a no-op; HF polling rejects overlapping ticks; active tunnel polling survives transient status failures.
- Batch 2 verification: Python compilation passed; `python -m unittest discover tests -v` passed 524 tests with 2 platform-dependent skips; all fast frontend tests passed; the Playwright smoke test passed when rerun with browser-launch permission.
- **Batch 3 complete:** malformed Host ports are rejected safely; API request bodies must be JSON objects; unsupported transfer encodings receive an explicit 501 response; preset files are read as UTF-8; backend and API-tab URLs bracket IPv6 hosts.
- Batch 3 verification: Python compilation passed; `python -m unittest discover tests -v` passed 530 tests with 2 platform-dependent skips; all fast frontend tests passed; the Playwright smoke test passed when rerun with browser-launch permission.
- **Batch 4 complete:** install and cleanup config rewrites preserve the remembered external chat target; unexpected HF download, tunnel, and web-search failures are logged and sanitized; status target fallback errors are logged; file-picker directory creation failures return a sanitized response.
- Batch 4 verification: Python compilation passed; focused regression tests passed; `python -m unittest discover tests -v` passed 535 tests with 2 platform-dependent skips.
- **Batch 5 complete:** the unsupported `apply_diff` tool was removed from the UI and docs; launch generation enforces chat-template XOR; Jinja defaults and negation match llama.cpp; legacy builtin templates render in both dropdowns; exponent notation is parsed correctly; empty chat responses render one error bubble; optional frontend failures log debug context; the `fetchJson()` documentation matches its implementation.
- Batch 5 verification: syntax checks passed for all 47 frontend JavaScript files; all fast frontend suites passed; flag validation and live llama.cpp compatibility checks passed for 154 GUI flags; the Playwright smoke test passed.
- **Deferred for user-flow review:** stopped-stream reconciliation, installer Python-version gating, sampler save/import collision behavior, launch-preset import overwrite behavior, malformed sampler-import rejection, app-update prefetch failure feedback, and HF overwrite-decline feedback.

---

## P1

### [Resolved — Batch 5] Remove the unsupported `apply_diff` tool enum value — it kills every launch
`ui/js/flags/definitions.js:1596`

The `tools` multi_enum offers `{ value: "apply_diff", label: "Apply Diff" }`, but the bundled binary's `--tools` help lists only `read_file, file_glob_search, grep_search, exec_shell_command, write_file, edit_file, get_datetime`. Verified live: `llama/bin/llama-server.exe --tools apply_diff ...` exits with `tools setup failed: unknown tool "apply_diff"`.

- **Trigger:** user checks "Apply Diff" in Configure → MCP Settings → Built-in Tools (or the Quick Launch equivalent).
- **Impact:** every subsequent launch fails at server startup. `tests/frontend/llama_flags_supported_unit.cjs` validates flag *names* only, not enum values, so nothing catches this. `docs/directory.md:812` also documents `apply_diff` as existing.

---

## P2

### [Resolved — Batch 1] Fix dead SHA256 verification of release assets (wrong GitHub API field)
`backend/services/llama_manager.py:824`

`asset_map[bin_filename].get("sha256")` reads a key that does not exist — GitHub release assets carry the hash in the `digest` field (`"sha256:<hex>"`). Verified against the live API: every asset has `digest`, none has `sha256`.

- **Trigger:** every install/update.
- **Impact:** `expected_sha` is always `None`, the "skipping checksum verification" warning fires on every install, and a corrupted/tampered archive proceeds to extraction *after* `llama_bin`/`llama_grammars` have been rmtree'd (`llama_manager.py:861-864`) — a broken install instead of a rejected download. The existing test can't catch it: `tests/backend/test_services.py:1331` mocks a synthetic asset with a `"sha256"` key that never occurs in reality. Secondary: `extra_assets` (e.g. cudart zips) are never checksum-verified even with the right field.

### [Resolved — Batch 2] Close the install-vs-launch race that rmtree's `llama_bin` under a running process
`backend/routes/install.py:59`, `:92`; `backend/services/llama_manager.py:861-864`

`is_process_running` is checked only before spawning the background install thread; `install_release` later deletes `ctx.paths.llama_bin` and `llama_grammars` with no re-check, and `launch_process` (`backend/services/process_manager.py:1155-1164`) never consults `install_in_progress`.

- **Trigger:** start an install, then launch llama-server while the download is still in flight; the rmtree runs against the live installation when the download finishes.
- **Impact:** on Windows the rmtree fails on the locked `.exe` and leaves bin/grammars partially deleted — subsequent launches fail with "not found. Install llama.cpp first." until Repair Install. On Linux the swap mostly succeeds but replaces binaries under a running process and deletes grammars.

### [Resolved — Batch 3] Guard against malformed `Host` header ports crashing the request thread
`backend/http.py:108`

`port = parsed.port or gui_port` in `get_request_host_origin()`: `urllib.parse.urlparse(...).port` raises `ValueError` for a non-numeric or out-of-range port (e.g. `Host: example.com:abc`, `:99999`).

- **Trigger:** start the GUI with `LLAMA_GUI_HOST=0.0.0.0` (sets `allow_request_host_origin=True`, `backend/app.py:631`), then any request with a malformed Host port. The exception propagates out of `get_access_control_origin()` (called by `Response.json/bytes/text` and `end_headers`), killing the handler thread. Not reachable with the default `127.0.0.1` bind.
- **Impact:** in the supported LAN-exposed mode, any client (or scanner) sending a bad Host header gets connection resets; server process survives but logs raw tracebacks.

### [Resolved — Batch 3] Reject valid-JSON non-object request bodies before they reach handlers
`backend/app.py:563-569` (`read_body`), dispatch at `backend/app.py:758`

`read_body` accepts any valid JSON (`[1]`, `"str"`, `42`) and `dispatch_api_request` calls handlers with no try/except. Handlers assume a mapping: e.g. `save_preset` does `body.get("name")` (`backend/routes/presets.py:237-238`) → `AttributeError: 'list' object has no attribute 'get'`.

- **Trigger:** `curl -X POST -d '[1]' -H 'Content-Type: application/json' http://127.0.0.1:5240/api/presets` (same for most POST routes that do `body.get(...)`).
- **Impact:** connection reset instead of a sanitized JSON error. A one-line `isinstance(parsed, dict)` guard in `read_body` (→ existing 400 path) fixes the whole class.

### [Resolved — Batch 1] Clean up partial cloudflared downloads (interrupted download poisons the tunnel permanently)
`backend/services/tunnel.py:84` (reuse check) + `backend/services/llama_manager.py:576-588` (`download_file` writes straight to `dest`, no temp file, no cleanup on failure)

- **Trigger:** any network failure mid-download of the cloudflared binary; also a mid-extraction failure on the macOS tgz path.
- **Impact:** the partial file stays at the final path, and every later `ensure_cloudflared()` call sees `binary_path.exists()` and returns the truncated binary — the remote tunnel fails to start forever with a cryptic exec error, no self-recovery. Violates the "download threads clean partial files in `finally`" invariant. Not covered by `tests/backend/test_services.py`.

### [Resolved — Batch 1] Stop `probe()` from forwarding the API key to redirect targets
`backend/services/external_server.py:182-186`

`urllib.request.urlopen` uses the default redirect handler, whose `redirect_request` copies all request headers except `content-length`/`content-type` (verified against stdlib source) — so `Authorization: Bearer <key>` is re-sent to the redirect target, including an external https host whose address is never validated.

- **Trigger:** operator registers an external llama-server *with an API key* and the service answers 301/302/303/307/308 to any URL.
- **Impact:** the registered llama-server key is exfiltrated to a third party if the registered service is malicious or compromised. Contrast `web_search.py`, which deliberately disables auto-redirects and pins pre-validated IPs to avoid exactly this.

### [Deferred — user-flow review] Keep chat DOM and state in sync after a stopped stream (undo/regenerate removes the wrong node)
`ui/js/chat-ui.js:477-479` (root cause), `:519-538` (undo), `:540-559` (regenerate)

When a stream is aborted (Stop button), the `catch` swallows `AbortError` and never removes or reconciles the partially-streamed assistant bubble: it stays in the DOM but is never pushed into `chatMessages`. DOM and state now diverge by one node. Both `undoMessage()` and `regenerateResponse()` pair `chatMessages.pop()` with removing the last `.chat-message` element — so after a stop they remove the stale partial assistant bubble instead of the user's bubble.

- **Trigger:** send a message → press Stop mid-stream → press Undo or Regenerate.
- **Impact:** for regenerate, a duplicated user bubble on screen while `chatMessages` (and the saved conversation) holds one copy; for undo, the user bubble stays visible but is gone from state. Subsequent saves persist a history that doesn't match the screen. No test covers `chat-ui.js`. Fix direction: on abort, either remove the partial bubble or push the partial content into `chatMessages`.

### [Resolved — Batch 3] Read preset files as UTF-8 instead of the platform default encoding
`backend/routes/presets.py:201`

`list_presets` opens preset files with `open(path, "r")` (no `encoding=`), but `_write_preset_json` (`presets.py:58`) writes with `encoding="utf-8"`.

- **Trigger:** on Windows (default cp1252), any preset containing non-ASCII text written by `save_preset` is read back as mojibake (`é` → `Ã©`). UTF-8 sequences containing bytes undefined in cp1252 (0x81/0x8D/0x8F/0x90/0x9D) raise `UnicodeDecodeError`, which is not caught by the `except (json.JSONDecodeError, OSError)` guard at line 221.
- **Impact:** corrupted preset content served to the UI (a subsequent save makes it permanent), or the whole `/api/presets` request dies with a dropped connection.

---

## P3

**Backend**

- **[Resolved — Batch 3] Reject chunked request bodies instead of treating them as empty** — `backend/app.py:572-574`. `get_request_content_length()` returns `0` when `Content-Length` is absent, so `read_body()` returns `{}` and the proxy forwards an empty body. A client POSTing `Transfer-Encoding: chunked` to `/v1/chat/completions` gets a confusing "missing field" error from llama-server. Stdlib `http.server` can't decode chunked bodies; the actionable fix is rejecting with 411/501.
- **[Resolved — Batch 2] Reset install progress when release lookup fails** — `backend/services/llama_manager.py:791` sets `status="downloading"`, but the release-lookup phase (`:798-830`) sits before the `try/finally` at `:832`. If `get_release_by_tag` fails and the fallback also raises (network down, rate limit), `download_progress` stays `{"status": "downloading"}` forever — the UI spinner never resolves and no error is surfaced.
- **[Resolved — Batch 3] Bracket IPv6 hosts in backend probe URLs** — `backend/services/external_server.py:182`, `backend/services/chat.py:129`, `backend/services/local_llama_http.py:37`. `f"http://{host}:{port}/health"` with host `::1` parses to `hostname=None`, so an IPv6-loopback server can never be registered; the user gets a misleading "No server answered at ::1:8080".
- **[Resolved — Batch 2] Fix tunnel start/stop race and stale-worker status clobbering** — `backend/services/tunnel.py:148-162`, `:182-194`. (a) `stop_remote_tunnel()` between `Popen()` and the locked assignment reports "stopped" but never kills the child; (b) a superseded worker can stamp `status="error"` over a newer worker's state. Both self-heal on the next poll/start.
- **[Resolved — Batch 4] Log real errors to stderr in blanket `except Exception` paths** — `backend/services/hf_download.py:319-321`, `backend/services/tunnel.py:195-198`, `backend/services/web_search.py:284-285`, `backend/routes/hf_download.py:17-18`, `:37-38`, `backend/routes/status.py:36-37`. These store `str(exc)` into user-visible state or return it raw with no stderr print, violating the "real error always to stderr" invariant and making failures undebuggable from logs.
- **[Resolved — Batch 2] Don't set "cancelling" state when no download is running** — `backend/routes/hf_download.py:42-43`. `cancel_download` unconditionally sets the cancel event and `status="cancelling"`; a direct POST while idle leaves the status endpoint reporting "cancelling" indefinitely (UI only exposes the button mid-download).
- **[Resolved — Batch 4] Move `mkdir` inside the error handler in the file-picker route** — `backend/routes/file_picker.py:14`. An `OSError` escapes the handler; the client gets a dropped connection instead of a sanitized JSON error.
- **[Deferred — user-flow review] `install.sh` never checks the Python version it finds** — `install.sh:8-18` (same gap in `mac_linux_start.sh:26-30`, `mac_linux_silent_start.sh:26-30`). The backend uses 3.9+ syntax (`tuple[str, ...]` in `backend/config.py:55`); on a Python 3.8 system the install "succeeds" and the server fails at import with a raw `TypeError`.

**Frontend**

- **[Resolved — Batch 5] Enforce `--chat-template` XOR `--chat-template-file` in the launch path, not just UI setters** — `ui/js/flag-core.js:411-431`, `ui/js/presets.js:204`. A preset JSON containing both `chat_template` and `chat_template_custom` flows through `applyFlagValues` and `buildLaunchArgs` emits both flags (verified in a `node:vm` simulation). No shipped preset has both — latent, reachable via hand-edited/imported presets.
- **[Resolved — Batch 5] Fix the `jinja` definition's default and add a `false_flag`** — `ui/js/flags/definitions.js:1168-1177`. `default: false` renders "Disabled", but the bundled llama-server advertises `--jinja, --no-jinja ... (default: enabled)`; since nothing is emitted when false, the server runs with jinja on. Displayed state ≠ actual behavior, and users can't turn jinja off from the GUI.
- **[Resolved — Batch 5] Render unknown builtin chat-template names in the dropdown** — `ui/js/app.js:421`. A valid builtin name not in `CHAT_TEMPLATE_PRESETS` (e.g. `phi4` from an old preset) has no matching `<option>`, so the dropdown shows nothing selected while launch still emits `--chat-template phi4`. Launch is correct; only the display is confusing.
- **[Resolved — Batch 5] Use `parseFloat`/`Number` for int fields to stop exponent-notation truncation** — `ui/js/quick-launch-ui.js:663`, `:166`, `ui/js/config-flags-ui.js:609`. `type="number"` inputs accept `1e5`; `parseInt("1e5", 10)` → `1`, passing all guards, so shared state silently stores `1` and launch emits `-c 1` when the user entered 100000.
- **[Resolved — Batch 5] Remove the stray empty bubble when a response has no body** — `ui/js/chat-ui.js:374-379`. On `!resp.body` an empty assistant bubble is appended, then a second "Error: Response body is empty." message — a blank bubble above the error. Cosmetic, rare path.
- **[Resolved — Batch 5] Add `console.debug` to silent catches** — `ui/js/chat-rendering.js:418-420` (`getSafeExternalUrl`), `ui/js/presets.js:490-498` (`loadPresetGroupState`), `ui/js/benchmark-ui.js:613-615`, `:650-651`, `:683-684`. All violate the no-silent-catch invariant; the benchmark ones also make "Missing"/"No saved presets" indistinguishable from genuine emptiness.
- **[Deferred — user-flow review] Apply the sampler name-collision guard to Save and Import, not just Rename** — `ui/js/sampler-presets.js:314-328`, `:428-441` (case-sensitive `taken` set) vs. the case-insensitive check in `renameSamplerPreset` (`:126-131`). Saving/importing a preset named like a builtin (e.g. `Creative`) creates duplicate dropdown entries, and name-only lookups silently resolve to the builtin — the user's custom preset is ignored by `applyProfile()` in `ui/js/quick-launch-ui.js:156`.
- **[Deferred — user-flow review] Confirm or dedupe before preset import overwrites a same-named preset** — `ui/js/presets.js:1998`, `:2016`. Import is an unconditional upsert with no prompt, asymmetric with `duplicatePreset`'s `buildDuplicatePresetName` and sampler import's `buildUniqueName`. Bulk entries with duplicate names also collapse into one while `imported` counts both.
- **[Deferred — user-flow review] Reject malformed entries in sampler import** — `ui/js/sampler-presets.js:416-419`, `:439`. Entries whose `values` is not an object (e.g. `{"presets": {"foo": "bar"}}`) are saved as empty presets; loading one resets every sampler flag to defaults.
- **[Deferred — user-flow review] Wrap the status pre-fetch in `updateAppFromGitHub` in try/catch** — `ui/js/manager.js:923`. The `await fetchJson("/api/app-update-status")` sits before the `try` at `:937`; if the cached status is null and the fetch fails, the click listener (`app.js:686`, no `.catch`) gets an unhandled rejection and the user sees a dead button with zero feedback.
- **[Resolved — Batch 2] Add an in-flight guard to the HF download poller** — `ui/js/hf-download-ui.js:237`. The 500 ms `setInterval` lacks the `installPollInFlight`-style guard used in `manager.js:742-770`; a slow status fetch lets two ticks both observe `"done"` and both run `finishDownload` (duplicate `refreshModels()`/`applyPresetModel()` — idempotent, but doubled work).
- **[Deferred — user-flow review] Don't show an error when the user declines an HF overwrite** — `ui/js/hf-download-ui.js:164-174`. Cancelling the replace-confirmation falls through to `showStatus("error", "Download failed to start: ...")` — a red error for a deliberate cancel.
- **[Resolved — Batch 2] Keep tunnel polling alive across transient status-fetch failures** — `ui/js/remote-tunnel-ui.js:96`, `:86`. One failed `/api/remote-tunnel/status` renders `{status: "error"}`, which calls `setPolling(false)` — the badge shows a wrong "error" state and the 2 s poll never resumes until the user re-enters the tab.
- **[Resolved — Batch 3] Bracket IPv6 hosts in the API tab base URL** — `ui/js/api-tab.js:210`. Setting the `host` flag to `::` or `::1` yields `http://::1:8080` instead of `http://[::1]:8080` in the link, copy buttons, and all four client snippets.
- **[Resolved — Batch 4] Preserve `external_chat_target` when rewriting `config.json`** — `backend/services/llama_manager.py:880`, `backend/services/process_manager.py:1401`. Both call `save_config({...})` with a fresh dict containing only `version`/`backend`/`tag`, dropping the remembered external-server address that `README.md:204` promises persists across sessions. The sibling writer `activate_custom_backend` (`llama_manager.py:474-478`) does `dict(load_config())` first, proving it's an oversight. Existing tests never seed `external_chat_target`, so the clobber is uncovered.

**Docs**

- **[Resolved — Batch 5] Sync the `fetchJson()` contract between AGENTS.md and `manager.js`** — AGENTS.md says "`fetchJson()` returns `null` for non-JSON 200s — callers must handle `null`", but `ui/js/manager.js:142-147` actually **throws** `Invalid JSON response` for that case; `null` is only returned for a literal JSON `null` body. Related: `exportPreset` (`ui/js/presets.js:1877`) lacks the null guard its siblings have — unreachable under current behavior, one contract-change away from a crash.
- **[Resolved — Batch 5] Remove `apply_diff` from `docs/directory.md:812`** — documents a tool the bundled llama-server doesn't support (see P1).

---

## Checks run during the review

- `npm run test:flag-definitions` — pass (154 flags); `tests/frontend/llama_flags_supported_unit.cjs` — pass against bundled binaries.
- `node --check` on all reviewed JS files; `js_syntax_check.cjs` (46 files), `module_namespace_unit.cjs` (25 scripts) — pass.
- Frontend unit tests run by reviewers: `custom_launch_args_unit.cjs`, `launch_args_unit.cjs`, `presets_unit.cjs`, `sampler_presets_unit.cjs`, `preset_roving_focus_unit.cjs`, `chat_rendering_unit.cjs`, `benchmark_args_unit.cjs`, `api_tab_unit.cjs`, `theme_ui_unit.cjs`, `process_lifecycle_unit.cjs`, `external_server_ui_unit.cjs`, `hf_download_ui_unit.cjs`, `manager_model_cache_unit.cjs`, `manager_releases_unit.cjs`, `model_switch_ui_unit.cjs` — all pass.
- Playwright `flag_sync_smoke.cjs` — pass.
- `python -m unittest discover tests` — 511 passed, 2 skipped (symlink-availability guards); `python -m py_compile` on all backend files — OK.
- Live probes: bundled `llama-server.exe --help` / `--tools apply_diff` / dual chat-template flags; `llama-bench.exe --help`; GitHub releases API asset schema; stdlib redirect-handler and `urlparse` behavior.
- Not run: `.sh` installers end-to-end (Windows host, would mutate the system); live end-to-end flows (install polling, HF download, tunnel, model switch) — those findings rest on code-path analysis.

## Verified clean (highlights)

- `_BODY_HANDLED` sentinel compared with `is` everywhere; `sanitize_error` 4xx/5xx split; proxy path triple-decode traversal guard; CORS origin checks.
- Windows process rules followed: `CREATE_NEW_PROCESS_GROUP` + `CTRL_BREAK_EVENT`, `os._exit()` only in the restart path, no silent backend catches in process services.
- No direct `flagValues` mutation anywhere; command preview generated only from shared state; no per-tab state copies; `parseCustomLaunchArgs` errors block launch and surface near the textarea.
- No `-cd`/`ctx_size_draft` in any definition or emitter; builtin template list matches the bundled binary exactly (all 54 names); all 15 bundled `.jinja` paths exist.
- No `innerHTML` with user/model content outside the `renderMarkdown()` exception; no cross-realm `instanceof`; all 326 HTML IDs referenced from JS resolve; script load order matches `docs/directory.md`; `style.css` free of `[data-theme]` selectors and color literals; 5 `THEMES` entries ↔ 5 palette blocks in `tokens.css`.
- HF download: `.part` cleanup on cancel/error, path traversal blocked, token never logged; `web_search` SSRF defenses solid (per-hop revalidation, pinned IPs).

---

*Verified findings are tracked here and are being resolved in batches.*
