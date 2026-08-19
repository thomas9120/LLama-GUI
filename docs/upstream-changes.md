# Upstream Changes

Track announced llama.cpp changes that may require coordinated Llama-GUI updates. Remove an entry after the local change is completed or deliberately declined.

## Pending

### Native reasoning-effort support

- **Upstream:** [ggml-org/llama.cpp#26941](https://github.com/ggml-org/llama.cpp/pull/26941), merged on 2026-08-14 as commit `7e4c0a9`.
- **Status:** Merged into llama.cpp `master`, but the Llama-GUI workspace's current bundled binary is build `10375` (`ba360efe1`) and does not yet advertise `--reasoning-effort` in `llama-server --help`.
- **Why this matters:** Llama-GUI currently sets its server-wide default with `--chat-template-kwargs {"reasoning_effort":"..."}` and sends per-chat effort levels through request `chat_template_kwargs`. This works across older and newer llama.cpp builds, but ordinary OpenAI-compatible harnesses such as OpenCode normally send top-level `reasoning_effort`; older llama.cpp builds ignored every top-level value except `none`.
- **New upstream behavior:**
  - `--reasoning-effort LEVEL` is now a native `llama-server`, `llama-cli`, and `llama-completion` launch option. Upstream documents `default`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `default` leaves the template default unchanged.
  - Top-level Chat Completions `reasoning_effort` is now made available to the Jinja template. `none` disables reasoning. This lets standard harness reasoning selectors work without custom request-body variants when the loaded template supports effort levels.
  - `/props` now includes `chat_template_caps.supports_reasoning_effort`. This is a boolean capability only; it does not enumerate the effort names accepted by a particular model.
  - The Jinja capability layer also supplies the value as `reasoning_strength` for model-specific templates such as Muse Glimmer.
- **Precedence after the merge:** Server defaults are the base, request `chat_template_kwargs.reasoning_effort` overrides that base, and top-level request `reasoning_effort` has final precedence. Therefore, a harness request for `medium` should override a server launch default of `xhigh`.
- **Current compatibility decision:** Keep emitting the server default through `--chat-template-kwargs` until the bundled/downloaded llama.cpp build advertises the native flag. The kwargs form remains supported upstream and avoids making current binaries reject the launch command.
- **Planned local migration:**
  1. After the supported binary floor includes `7e4c0a9`, change the server-wide **Default Reasoning Effort** control to emit native `--reasoning-effort LEVEL`; Auto should continue omitting an override rather than disabling reasoning.
  2. Stop combining reasoning effort with the legacy Preserve Thinking JSON. Preserve Thinking can remain on its own `--chat-template-kwargs` compatibility path, allowing the duplicate-flag exception and special combined serializer to be removed.
  3. Send the Chat sidebar's Low/Medium/High/XHigh choice as top-level `reasoning_effort`. During the older-build compatibility window, also retain the matching nested `chat_template_kwargs` fallback; Off should continue sending `reasoning_effort: "none"` and the nested disable fallback.
  4. Consider consuming `chat_template_caps.supports_reasoning_effort` after server startup to explain or disable effort controls for unsupported templates. Keep the model-specific warning because the capability does not reveal whether `high`, `xhigh`, or another level is valid.
- **Validation before removing fallbacks:** Confirm the selected llama.cpp binary exposes `--reasoning-effort`; test Auto and every Llama-GUI level in command generation; verify server XHigh plus request Medium resolves to Medium; exercise Llama-GUI Chat, a raw OpenAI-compatible request, and OpenCode's ordinary effort selector; compare visibly different levels on Qwen3.8 and at least one model that supports High; and confirm Preserve Thinking still produces one valid launch argument.
- **Upstream caution:** [ggml-org/llama.cpp#27023](https://github.com/ggml-org/llama.cpp/issues/27023) remains open and reports Low/High having no effect on some models in an earlier build. Smoke-test a post-merge binary before treating the native path as the sole implementation.

### Adaptive MTP draft depth (`draft-mtp-adaptive`)

- **Upstream:** [ggml-org/llama.cpp#27210](https://github.com/ggml-org/llama.cpp/pull/27210) (branch `stew675:adaptive-mtp`, 3 commits, head `77cd0e8`). The range `08ae079..77cd0e8` linked in tracking is the final commit: it gates the adaptive range validation on adaptive mode so plain `draft-mtp` no longer aborts when the effective `n_max` is below the default floor of 3 (e.g. `--spec-draft-n-max 2`), and improves the abort message when `n_max` was capped by the model's MTP layer count.
- **Status:** Open, not merged (2026-08-18). Awaiting review from `ggerganov`; labels `server`, `testing`. Third-party backports already exist (e.g. giveen/llama-cpp-turboquant `4be91d6`), so flag spellings are circulating before an upstream release.
- **Why this matters:** Adaptive MTP draft depth auto-tunes speculative depth per workload: deep drafts for highly predictable content (code recall, repeated phrasing) and shallow drafts for hard prose/reasoning where deep drafts mostly miss. PR benchmarks show coding throughput ~86 t/s adaptive vs ~79 t/s fixed depth 3 (Qwen3.8-27B Q8_0, ROCm), with no regression floor on prose. Recommended upstream config: `--spec-type draft-mtp-adaptive --spec-draft-n-max 12`.
- **New user-facing CLI surface (verified against PR head `common/arg.cpp`):**
  1. **New `--spec-type` enum value `draft-mtp-adaptive`.** Maps to the new `COMMON_SPECULATIVE_TYPE_DRAFT_MTP_ADAPTIVE` enum (type count 11 → 12; `--spec-type` help is generated from the type list, so the new value appears automatically). Available in `llama-speculative`, `llama-server`, `llama-cli`; env `LLAMA_ARG_SPEC_TYPE`. Like `draft-mtp`, it sets `load_mtp` so MTP layers load from the main model (no separate draft model). The type works alongside the other `--spec-type` combinability rules (comma-separated list).
  2. **New flag `--spec-draft-n-min-adaptive N` (int).** Help text: "minimum adaptive MTP draft depth; the depth starts here and never drops below it (default: 3)". Default `3` (`common_params_speculative_draft::n_min_adaptive`). Available in `llama-speculative`, `llama-server`, `llama-cli`; env `LLAMA_ARG_SPEC_DRAFT_N_MIN_ADAPTIVE`. Only meaningful with `draft-mtp-adaptive`; ignored by plain `draft-mtp` after the final fix commit. Validation at init: must be in `[1, n_max]`, otherwise the server aborts with `invalid adaptive draft range: n_min_adaptive=…, n_max=…`; if `n_max` was internally capped by the model MTP layer count, the abort says so and suggests `--spec-draft-n-min-adaptive ≤ <MTP layer count>`.
  3. **Changed semantics of existing flags under the new type (no new flag names):**
     - `--spec-draft-n-max` becomes the **ceiling** of the adaptive depth range (its normal default `3` still applies, so users wanting deep adaptation must raise it, e.g. `12`). Internally still capped at the model's MTP layer count when chained heads are used (multi-layer MTP, non-shared memory).
     - `--spec-draft-n-min` is **independent** of the adaptive depth and keeps its old meaning (minimum draft length to verify) only for the non-adaptive spec types; the generic `n_min` draft cutoff is explicitly skipped for `draft-mtp-adaptive`.
- **Controller algorithm (new file `common/speculative-adaptive.h`, useful for UI help text):** per-sequence hysteresis state machine. Cold-start depth = floor `max(1, n_min_adaptive)` clamped to `n_max`. Climb: one step up after `climb_threshold(depth)` consecutive verifies that accepted every drafted token — thresholds are 2 at depth 1, 4 at depth 2, 6 at depth 3, then 5/4/3/2 from depth 4 upward (fast early and at depth, sticky around 3 where marginal acceptance collapses). Drop: every miss adds `n_draft − n_accepted` to a pressure accumulator; one step down when it reaches `max(depth * 5, 20)`, then resets; a full accept clears pressure; at the floor no pressure accumulates. Truncated-but-fully-accepted drafts count as full accepts; only drafts produced by the MTP implementation update the controller (`is_other` results from other speculators are ignored). Depth changes log `adaptive draft depth seq …: A -> B` at spec debug level.
- **Upstream tests:** new `tests/test-speculative-adaptive.cpp` (registered in `tests/CMakeLists.txt`) plus arg-parser cases in `tests/test-arg-parser.cpp` asserting the default `3`, explicit parse of `--spec-draft-n-min-adaptive 5`, and `--spec-type draft-mtp-adaptive` → `COMMON_SPECULATIVE_TYPE_DRAFT_MTP_ADAPTIVE`.
- **Planned local implementation (after merge, once a bundled/downloaded binary advertises the flag):**
  1. Add `{ value: "draft-mtp-adaptive", label: "Draft MTP (Adaptive Depth)" }` (or similar) to the `spec_type` enum options in `ui/js/flags/definitions.js`; it shares the existing `--spec-type` flag and the ngram-mod stacking control already emits duplicate `--spec-type` values, so no second control is needed.
  2. Add a `--spec-draft-n-min-adaptive` int flag definition (category `speculative`, `tool: "both"`, min 1, placeholder "llama.cpp default", default 3 upstream) beside `draft_min`/`draft_max`; surface it only when the spec type includes `draft-mtp-adaptive`.
  3. Consider a hint on the `draft_max` (Draft Tokens) control that with `draft-mtp-adaptive` it sets the adaptive ceiling and upstream recommends ~12, and that `draft_min` does not apply to the adaptive type.
  4. Run `npm run test:flag-definitions` and `npm run test:frontend`; update `docs/directory.md` script/flag notes only if structure changes.
- **Cautions:**
  - Do not ship the enum/flag before the supported binary floor includes the merge commit; older binaries will reject the unknown `--spec-type` value / flag at launch. Confirm via `llama-server --help` as with `--reasoning-effort` above.
  - The PR description body contains a typo (`--spec-draft-n-min-adpative`); the actual flag name is `--spec-draft-n-min-adaptive`.
  - The PR is still open and could be reshaped by maintainer review (a related adaptive-length effort exists in PR #25726 / Us5rName's rolling-window branch); re-verify exact flag names, defaults, and help text against the merged commit before implementing.

### llama-server default port: 8080 to 9931

- **Upstream:** [ggml-org/llama.cpp#26508](https://github.com/ggml-org/llama.cpp/pull/26508)
- **Status:** The advance-warning notice merged on 2026-08-03; the actual default-port change is still pending.
- **Current impact:** None. Llama-GUI explicitly launches `llama-server` with `--port 8080`.
- **Recheck when:** Upstream changes the actual default or a bundled llama.cpp release includes that change.
- **Local decision:** Either keep Llama-GUI's explicit 8080 default or change the frontend, backend target fallback, external-server form, tests, and documentation to 9931 together.

Last checked: 2026-08-18.
