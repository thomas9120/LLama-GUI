# Upstream Changes

Track announced llama.cpp changes that may require coordinated Llama-GUI updates. Remove an entry after the local change is completed or deliberately declined.

## Pending

### Native reasoning-effort support — residual compatibility window - - - Done

- **Upstream:** [ggml-org/llama.cpp#26941](https://github.com/ggml-org/llama.cpp/pull/26941), merged on 2026-08-14 as commit `7e4c0a9`, first release `b10434`.
- **Status:** Implemented (2026-08-19). The Default Reasoning Effort control emits native `--reasoning-effort LEVEL` on b10434+ (gated by the installed build tag from `/api/status`), Chat sends top-level `reasoning_effort` with the nested `chat_template_kwargs` fallback, and `/props` `chat_template_caps.supports_reasoning_effort` drives a Chat sidebar hint via the new `GET /api/llama/props` proxy.
- **Remaining:** the dual paths stay until the supported binary floor makes them dead code — the legacy merged-kwargs launch path (`flag-core.js`) and the nested `chat_template_kwargs` copy in Chat requests (`chat-ui.js` `getChatThinkingParams`) can then be removed in one sweep.
- **Upstream caution:** [ggml-org/llama.cpp#27023](https://github.com/ggml-org/llama.cpp/issues/27023) remains open and reports Low/High having no effect on some models in an earlier build. Smoke-test levels visibly before treating them as verified on a given model.

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

Last checked: 2026-08-19.
