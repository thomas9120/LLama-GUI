# Llama GUI code review — 2026-09-05

Reviewed checkout: `63f2fe9`. First review pass across the application, concentrating on correctness, credential handling, lifecycle transitions, persistence, downloads, and frontend integration. Findings include existing defects, not just regressions introduced by the UI revamp. The initial review did not change application code.

**Resolution (2026-09-05):** All ten findings below have been fixed in the working tree, and the listed dead code has been removed. Split GGUF downloads now fetch the complete shard set; installation backups remain available until configuration is committed; preset application preserves session credentials while persisted/displayed data is scrubbed. Regression coverage was added to the backend review suite and existing frontend suites. Validation: 782 backend tests passed (3 skipped), frontend syntax/unit/module/flag checks passed, and the Playwright browser smoke test passed. The findings below describe the original defects; their line numbers refer to the reviewed checkout.

Result: **2 high, 6 medium, and 2 low severity issues**, plus dead code. Severity maps to P1/P2/P3 respectively. Reproductions used dummy credentials, the existing Node VM harnesses, and isolated Python contexts with temporary directories and mocked network/process operations.

## High severity

### 1. HF access tokens survive preset exports and runtime metadata

Locations: `ui/js/flags/definitions.js:23`, `ui/js/presets.js:1`, `backend/routes/presets.py:14`, `backend/services/process_manager.py:28`.

The HF Token definition lacks `sensitive: true`, and the frontend/backend preset exclusions and backend command redactor only protect the GUI API key. Entering an HF token and saving/exporting a preset includes that credential in plaintext. It also survives `normalize_launch_settings()`, so the active runtime publishes it through launch/status responses. Command previews and benchmark output can expose it as well. The preset review hides `hf_token`, which makes the exported secret particularly easy to miss.

Confirmed: `sanitize_preset_data({"flags":{"hf_token":"hf_review_placeholder"}})` retains the token; `normalize_launch_settings()` retains it in `flags`; `redact_sensitive_args(["llama-server","-hft","hf_review_placeholder"])` returns it unchanged.

Fix direction: classify HF credentials as sensitive across definitions, snapshots, saved/exported presets, custom arguments, and displayed commands; cover both `-hft` and `--hf-token`. Preserve credentials only where required to execute the actual request. Existing saved files need the same sanitization on read.

### 2. Quoted API-key flag bypasses preset secret rejection

Locations: `backend/routes/presets.py:15`, `ui/js/presets.js:2`, `backend/services/process_manager.py:35`.

The raw-text regular expression recognizes `--api-key` only when followed by whitespace, `=`, or end of input. A valid custom argument such as `"--api-key" review-placeholder` does not match because the next character is a closing quote. The launch parser removes the quotes and executes it as an API-key flag, while preset saving and exports retain the original secret-bearing text. The same pattern is reused for fingerprint sanitization.

Confirmed: the unquoted form is rejected; the quoted form returns `False` from `has_sensitive_custom_args()` and survives `sanitize_preset_data()`. The frontend parser returns the tokens `["--api-key", "review-placeholder"]` for the quoted form.

Fix direction: apply credential detection to parsed argument tokens, accounting for separate-value and equals forms, with equivalent validation on the backend.

## Medium severity

### 3. `/v1` does not fall back to the external server after a local server exits

Locations: `backend/services/process_manager.py:192`, `backend/app.py:720`, `backend/services/external_server.py:74`.

Register an external llama-server, launch a local llama-server on a different port, then stop the local process or let it exit. Chat and metrics call `resolve_llama_target()` and correctly select the external server. `/v1` instead reads the saved `llama_api_target`, which still names the exited local server. Clearing the runtime never synchronizes that target; synchronization only happens on external connect/disconnect and local launch. OpenAI-compatible clients, including clients using the tunnel URL, therefore fail while built-in Chat works.

Confirmed with an exited process in an isolated context: Chat/metrics resolved port 9001, while the `/v1` target remained port 9002.

Fix direction: resolve the `/v1` destination from the shared authoritative target at request time, or update it on every process transition, including natural exits.

### 4. Neutral Chat sampler values are omitted instead of overriding the server

Location: `ui/js/chat-ui.js:474`.

`getChatSamplerParams()` omits Top K when it equals 0 and Repeat Penalty when it equals 1. Those are explicit disabling values, not unset values. After launching with non-neutral defaults, moving the Chat controls to these values leaves the launch defaults effective. Connecting to an external server with its own defaults has the same problem. The controls and request do not agree. The upstream API defines 0 and 1 respectively as the disabling values. [llama.cpp sampling schema](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-schema.cpp)

Confirmed using the existing Chat harness: with `{top_k: 0, repeat_penalty: 1}`, the actual completion payload contained neither field.

Fix direction: omit only unavailable/invalid inputs and transmit valid neutral values. Add a case that starts from non-neutral server defaults.

### 5. Deleted active conversations are silently recreated

Location: `ui/js/chat-ui.js:1171`.

Deleting the active conversation removes its stored entry and clears its ID, but leaves `chatMessages` intact. Clicking New Chat calls `saveCurrentConversation()` before clearing the transcript, creating a new stored copy of the deleted conversation. Completing an in-flight answer or changing thinking effort can also save it again. This defeats the user's deletion action.

Confirmed using the actual history delete button handler in the existing Chat harness: history count became 0 after Delete, then returned to 1 after New Chat, containing the deleted transcript.

Fix direction: clear/abort the active conversation as part of deleting it, or explicitly suppress subsequent automatic persistence of that deleted transcript.

### 6. Benchmark adapter changes the meaning of multi-GPU settings

Location: `ui/js/benchmark-ui.js:249`.

Configure defines Tensor Split and Device(s) as comma-separated lists. The throughput adapter forwards them verbatim. However, the installed `llama-bench --help` specifies slash-separated values within a tensor split or device group, and commas separate independent benchmark parameter values. Thus Configure's `3,1` split or `CUDA0,CUDA1` device group becomes multiple benchmark configurations instead of the requested multi-GPU configuration. Results can look valid while measuring a different setup, and a model requiring both GPUs may fail to fit.

Confirmed adapter output: `llama-bench -m models/tiny.gguf -ts 3,1 -dev CUDA0,CUDA1 -r 5 -p 512 -n 128 -o md`. Installed help specifies `-ts <ts0/ts1/..>` and `-dev <dev0/dev1/...>`.

Fix direction: translate these shared list values into the benchmark tool's syntax rather than treating every compatible flag as a verbatim value mapping.

### 7. Failed installation can replace binaries while retaining old metadata

Location: `backend/services/llama_manager.py:1076`.

The binary directory is swapped first, and its backup is immediately deleted. The grammar swap, executable-bit repair, and configuration save happen afterward. Failure at any of those later steps returns an installation error without restoring the old binaries. The installed version/backend metadata can consequently describe a different build from the files that launch. Recovery via repair can also act on the wrong recorded backend.

Confirmed with temporary directories and a simulated grammar-directory permission error: installation returned `False`, live binaries contained only `new.exe`, `bin.old` no longer existed, and the recorded tag remained `old`.

Fix direction: retain the previous installation until the complete installation transaction succeeds, including metadata, and restore it if a later step fails.

### 8. HF downloader reports split models complete after fetching one shard

Locations: `backend/services/hf_download.py:111`, `backend/services/hf_download.py:466`.

Repository discovery offers each non-projector `.gguf` as a model, including `*-00001-of-00002.gguf` and subsequent shards. The worker downloads only the selected model file and optional projector, then marks the operation done and selects the shard for launch. On a fresh download, the remaining shards are missing, so the result cannot load. llama.cpp resolves split models as a set of files. [llama.cpp split-model loader](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-model-loader.cpp)

Confirmed with an isolated worker: selecting `model-00001-of-00002.gguf` invoked exactly one model download and returned status `done` with that shard selected.

Fix direction: group and fetch the complete shard set before reporting success, or explicitly reject/identify split files until supported. Do not present individual shards as complete launchable models.

## Low severity

### 9. Chat template-capability hint remains cached across external targets

Location: `ui/js/chat-ui.js:348`.

The capability cache key includes only the local runtime generation. Replacing the registered external server without an intermediate disconnected state leaves this key unchanged, so `refreshTemplateCaps()` reuses the former server's capability result. The reasoning-effort support hint can remain wrong indefinitely even though other panels have adopted the new server.

Confirmed with two connected external targets at different ports and unchanged local generation: only one props request was issued across both refreshes.

Fix direction: include external endpoint identity/reconnect generation in the capability key and reject responses from superseded targets.

### 10. Interrupted WikiText download leaves an orphan temporary ZIP

Location: `backend/routes/benchmarks.py:48`.

The `delete=False` temporary ZIP is created and filled before entering the `try/finally` that unlinks it. If the network read or file write fails during `shutil.copyfileobj()`, control skips that cleanup block. Every retry can leave another partial archive in the system temporary directory.

Confirmed with an interrupted upstream read: the route returned an error and one temporary ZIP remained.

Fix direction: encompass both download and extraction in the cleanup scope, starting when the temporary file is created.

## Dead code

These have no production callers in this checkout. No deletions were made.

- `ui/js/benchmark-ui.js:36`: `BENCH_ONLY_IDS` and `PERPLEXITY_ONLY_IDS` are declared but never read.
- `ui/js/model-switch-ui.js:379`: `selectActionSlot()` is exported and exercised by old tests, but production rendering uses `selectActionSlots()` at line 618. The obsolete single-action selector and its dedicated assertions are deletion candidates.
- `ui/js/chat-rendering.js:466`: `finalizeChatStreamMarkdown()` is exported but never called. `finalizeChatReasoningMarkdown()` at line 324 is called only by a unit test. Live response finalization now goes through `finalizeAssistantResponse()` and `renderConversationMessages()`.
- `backend/services/process_manager.py:1036`: `is_active_llama_api_auth_configured()` is called only by a unit test. Production status obtains the authentication flag through the process-status snapshot.

Compatibility exports in `backend/app.py` and `server.py` were not classified as removable merely because they lack internal callers; those modules explicitly preserve an external compatibility surface.

## Verification and limits

- Project-venv backend suite: **774 tests, OK, 3 skipped**.
- `npm test`: syntax checks, Node unit suites, module loading, flag definitions, and installed server/CLI flag compatibility passed. Its first browser launch failed with sandbox `spawn EPERM`.
- Reran `npm run test:frontend` with Chromium launch permitted: **passed** on the fixture server at port 5241.
- Additional isolated reproductions confirmed the findings above. Tests used dummy credentials; no real credentials were inspected or printed.
- No actual model inference, multi-GPU benchmark, full release installation, Cloudflare tunnel, or Linux/macOS desktop session was run. Hardware/OS-dependent behavior beyond the installed executable help and existing mocked tests remains a verification limit.
- This is a first broad review pass, not a claim that every line or platform has been exhaustively verified. The larger platform-specific telemetry collectors, bundled Jinja templates, native launchers, and visual behavior beyond the browser smoke suite warrant further focused review.
