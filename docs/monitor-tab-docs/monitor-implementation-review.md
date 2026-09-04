# Monitor Tab — Implementation Review

Review of the Phase 1–3 Monitor implementation (commits `6a83497`, `1689527`, `93f9e7a`) against
[`monitor-plan.md`](monitor-plan.md). Status: **reviewed 2026-09-05**.

- **Verdict:** high quality overall, but confirmation found **four functional regressions**
  (`R1`–`R4`) plus several smaller correctness and edge-case issues. Two observations in the
  original review (`M1`, `M6`) were not confirmed as defects and are retained below with the
  reasoning so they are not accidentally implemented as fixes.
- **Verification at confirmation time:** full backend suite green (`713 tests OK`, project venv),
  frontend unit/static checks green, browser smoke green (`npm run test:frontend`), `node --check`
  clean, and `test_docs_sync` green. The first browser-smoke launch was blocked by the sandbox
  (`spawn EPERM`); it passed unchanged when run with normal Chromium process-launch permission.
- **Fix status:** all actionable confirmed findings (`R1`–`R4`, `M2`–`M5`, `M7`, and
  `M9`–`M14`) were implemented in the 2026-09-05 follow-up. `M1`, `M6`, `M8`, and `O1`
  retain their original no-change dispositions.

## Follow-up resolution (2026-09-05)

- **R1:** recovery now passes the authoritative active runtime into `startStatsPolling`; browser
  coverage exercises a refused Stop while the runtime remains live.
- **R2:** the accepted-status observer is the single inference-target reconciliation path, so an
  already-connected external target starts polling on reload without a duplicate revision/reset.
- **R3:** prompt and generated counters are fresh per successful payload, baseline independently,
  and rebase independently after rollback. Reset anchors only currently valid fields and leaves
  unavailable fields pending; missing, invalid, empty, late, and post-reset fields are covered.
- **R4 / M7:** CPU, memory, and disk percentages render with `%`; an available CPU collector with
  no first delta renders `--` and "Waiting for first sample".
- **M2 / M11:** slot rates require a 1–30 second interval, stable slot and task IDs, and complete
  comparability across current processing slots; otherwise the metrics gauge is used and slot
  samples are reseeded.
- **M3:** anchor-button styling is scoped to Monitor setup cards.
- **M4 / M12:** `probe_amd` no longer accepts the unused WSL argument, and inconsistent CPU idle
  deltas return null while the current counter sample becomes the next baseline.
- **M5:** the fixed-bar field is labeled "Context (most-filled slot)"; the obsolete KV semantic was
  not reintroduced.
- **M9 / M10:** unknown activity is distinct from Idle, and unavailable meters expose
  `aria-valuetext="Not available"` without `aria-valuenow` until a numeric value returns.
- **M13:** every persistent hidden-card write keeps the 100 most recent stable identities;
  session-only `:index:` identities remain outside persistence and the cap.
- **M14:** metrics text and slots JSON are parsed in independent error boundaries, with browser
  coverage for a rejected metrics body alongside valid slots.
- **Validation:** focused frontend units, syntax/module/static checks, flag compatibility, all
  714 backend tests, and the Playwright smoke suite passed. Chromium initially hit the restricted
  worker sandbox's `spawn EPERM`; the same smoke command passed with normal process-launch permission.

## Findings and confirmation status

### R1 (confirmed bug) — No-arg `startStatsPolling()` stops inference polling instead of resuming it

- **Where:** `ui/js/app.js:290` (`resumeRuntimePolling`), reachable from the failure paths of
  `switchModelSlot` (`ui/js/app.js:258`) and `stopLlama` (`ui/js/app.js:893`).
- **What:** the old signature `startStatsPolling(_runtime, …)` ignored its first argument, so
  `resumeRuntimePolling` called it with no arguments to unconditionally resume polling and re-show
  the fixed stats bar. The Phase 2 rewrite derives the target key from that argument:

  ```js
  const generation = Number(runtime && runtime.generation);   // undefined → NaN
  const key = Number.isSafeInteger(generation) && generation >= 1 ? `gui:${generation}` : null;
  inferenceStats.setTarget(key, { zeroBaseline: freshLaunch }); // setTarget(null)
  beginInferencePolling();                                    // early-returns: no target
  ```

  With no arguments the key is `null`, so the recovery path now *disables* the inference target,
  hides the fixed stats bar, and never restarts polling — the opposite of its purpose. Because
  the lifecycle `stop`/`switch` already invalidated stats before the recovery call, nothing else
  restores telemetry until the next unrelated status refresh.
- **Impact:** after a failed Stop or a failed model switch while a llama-server is still running,
  the fixed stats bar disappears and the Monitor Inference card shows "unavailable" even though a
  server is live.
- **Proposed fix:** pass the runtime — `startStatsPolling(runtime)` in `resumeRuntimePolling`.
  `status.active_runtime` carries `generation`; with `lifecycleState` undefined,
  `zeroBaseline` is false, so the first valid counter sample becomes the baseline — the same
  semantics the old code had for an already-running process. Also consider a smoke assertion that
  a failed Stop with a still-running server keeps the stats bar live (the existing suites do not
  cover `resumeRuntimePolling`; `app.js` is only exercised end-to-end by the smoke test).

### R2 (confirmed bug) — A restored external target does not start inference polling after reload

- **Where:** `ui/js/external-server-ui.js` (`restore`) and the initial status path in
  `ui/js/app.js`. `reconcileInferenceTarget` is called only by `refreshRuntimeStatusPanels`.
- **What:** when `/api/chat/target` reports an already-active external target, `restore()` renders
  it and returns early. It does not call `onExternalTargetChanged` or refresh dependent panels.
  The initial `checkStatus()` reconciles process lifecycle but does not reconcile the inference
  target. Consequently, `createInferenceStats` remains targetless after a page reload even though
  Chat and the header know an external server is connected.
- **Impact:** the fixed stats bar and Inference card remain unavailable until the user visits a tab
  that happens to call `refreshRuntimeStatusPanels`, reconnects the target, or otherwise triggers
  a later refresh.
- **Proposed fix:** reconcile the inference target once from the accepted initial status (for
  example, call `reconcileInferenceTarget(initStatus)` after `checkStatus()`), or make the
  authoritative accepted-status path own this reconciliation. Avoid doing both. Add a browser
  smoke case that reloads the page while an external target is already connected.

### R3 (confirmed bug) — Missing metrics fields are carried forward as fresh token counters

- **Where:** `ui/js/monitor-ui.js`, `createInferenceStats.rebuild`.
- **What:** parsed prompt/generated counters update `raw` only when finite. If a later successful
  `/metrics` response omits one counter, contains an invalid value, or is empty/comment-only,
  `metricsOk` is still true and the previous raw counter is rendered as if it came from the current
  sample. This violates the plan's per-field freshness rule and creates live-looking stale values.
  For restored/external targets, the baseline is also initialized as one object when either counter
  first appears; a counter that appears only in a later response never receives its own first-sample
  baseline.
- **Impact:** Session tokens can silently freeze at old values while the metrics source still looks
  healthy, and a late-appearing counter can be measured against the wrong implicit baseline.
- **Proposed fix:** track validity/freshness per counter for the current response, retain raw values
  only for reset detection if needed, and compute displayed session values only from currently valid
  fields. Initialize the prompt and generated baseline components independently. Add tests for a
  field disappearing, an empty successful payload, and a field appearing after the other counter.

### R4 (confirmed UI bug) — System utilization values omit the percent unit

- **Where:** `ui/js/monitor-ui.js` (`setMetricCard` / `formatPercentValue`) and the CPU, Memory,
  and Disk cards.
- **What:** the formatter returns a bare number and `setMetricCard` writes it directly. Thus the
  cards display values such as `18.4` rather than `18.4%`. The mockup includes a percent unit and
  the existing unit test currently locks in the unitless result.
- **Proposed fix:** append a visible `%` (preferably using the existing
  `.monitor-metric-unit` presentation) and update the unit tests.

### M1 (not confirmed) — Focus after hiding a card is appropriate

- **Where:** `ui/js/monitor-ui.js:1172` (`hideCard`).
- **Confirmation:** both current callers invoke `hideCard` from a hide button inside the card.
  Activating that button normally focuses it for keyboard use and commonly for pointer use in the
  supported browser, and the focused control is about to be hidden. Moving focus to the restore
  summary therefore prevents focus from being lost. Checking whether `document.activeElement` is
  inside the card would still be true for the pointer case in Chromium and would not implement the
  proposed distinction.
- **Disposition:** no change recommended. Revisit only if a future programmatic caller hides a card
  without activation from within it; that caller can then opt out of focus transfer explicitly.

### M2 (confirmed minor) — Slot-rate samples have no maximum age

- **Where:** `ui/js/monitor-ui.js:276` (`createInferenceStats.rebuild`, `elapsed >= 1` check).
- **What:** live speed is computed whenever two samples share a slot/task identity and
  `elapsed >= 1`, with no upper bound. If `/slots` fails for minutes and then recovers with the
  same identity, the "live" speed becomes an average across the whole gap (e.g. `delta / 600 s`)
  — technically the same task, but misleading as live speed. The backend enforces a 0.1–30 s
  window for its own rates; the engine should mirror it. This is pre-existing behavior carried
  over from the old `pollStats`, not a regression — it is now centralized in one place and easy to
  fix.
- **Proposed fix:** skip the delta and only re-seed `rate` when `elapsed > 30` (fall through to
  the metrics gauge for that cycle), mirroring the backend's
  `MAX_RATE_INTERVAL_SECONDS` rationale. Add a unit test: slots fail for a long interval, then
  recover with the same identity → gauge speed is used, not a gap-spanning average.

### M3 (confirmed minor) — Global `a.btn` rules added under the Monitor CSS block

- **Where:** `ui/css/style.css:4514–4516` (`a.btn`, `a.btn:hover`, `a.btn-primary`).
- **What:** the rules restyle every anchor-button app-wide, not just the Monitor setup cards' doc
  links. They fix a real problem (the setup-card "Open … documentation" links render as `.btn`
  anchors), but they silently change anchor-button styling anywhere else in the app.
- **Proposed fix:** scope them to the setup card container (e.g.
  `.monitor-setup-cards a.btn { … }`), or move the rules out of the Monitor block and next to the
  existing `.btn` definition with a comment, so the global nature is explicit.

### M4 (confirmed cleanup) — Unused `is_wsl` parameter on `probe_amd`

- **Where:** `backend/services/system_stats.py:961` (`probe_amd(platform_name, is_wsl)`).
- **What:** WSL gating lives entirely in `build_gpu_setup_entries` / `_amd_setup_entry`; the probe
  never reads `is_wsl`. Dead parameter.
- **Proposed fix:** drop the parameter and update the call in `collect_sample` and the
  `test_probe_platform_gating` expectations. (Behavior-neutral cleanup.)

### M5 (confirmed semantic regression) — Fixed bar "KV" label no longer reports KV-cache usage

- **Where:** `ui/js/app.js:1063–1085` (`renderStatsBarFromSnapshot`).
- **What:** the bar's `stats-kv-usage` value is now fed `snapshot.context.percent`
  (most-filled-slot token occupancy). The previously supported
  `llamacpp:kv_cache_usage_ratio` Prometheus metric is no longer consulted anywhere. These values
  are not equivalent on all server versions or multi-slot/unified-cache configurations, so the
  "KV" label is now semantically wrong and the bar duplicates the Inference card's context metric.
  Current upstream llama.cpp documentation no longer lists the KV-cache gauge, which makes a clear
  context label the more future-proof default, but older supported servers may still expose it.
- **Proposed fix (product decision):** either (a) rename the bar item to match the new semantics
  (e.g. "Context · most-filled slot") and note it in the changelog, or (b) restore preference for
  `llamacpp:kv_cache_usage_ratio` in the engine when present, falling back to slot occupancy with a
  label that makes the fallback clear. Option (a) is smaller and keeps one concept across both
  views. See the [current llama.cpp server metrics documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#metrics).

### M6 (not confirmed) — Generic state-card message is grammatically complete

- **Where:** `ui/js/monitor-ui.js:791` (`makeStateCard` fallback message).
- **Confirmation:** "No supported vendor tool or GPU backend identified NVIDIA or AMD hardware."
  has a compound subject ("tool or backend"), verb ("identified"), and object ("hardware"). It is
  a complete sentence. The alternative wording may be a stylistic improvement, but the current
  text is not defective.
- **Disposition:** no correctness fix recommended. A copy edit can still be made if present-tense
  wording better matches the surrounding UI.

### M7 (confirmed minor) — CPU card shows "Not available" during the first sample window

- **Where:** `ui/js/monitor-ui.js:649` (`setMetricCard`), CPU branch of `renderSystemMetrics`.
- **What:** on the first poll (counter baseline not yet established) the CPU value slot renders
  "Not available" while the sub-line says "Waiting for first sample". The plan frames missing
  metrics as normal capability states; the value slot implying an error for a routine 2-second
  cold start is mildly alarming.
- **Proposed fix:** render "--" in the value slot (and an empty bar) while
  `available === true && percent == null`, keeping "Not available" for `available === false`.

### M8 (confirmed historical note) — Unrelated `fork_only` change rides in the Phase 3 commit

- **Where:** commit `93f9e7a` ("Phase 3 - Document Monitor tab and fork-only flags").
- **What:** the `fork_only: true` flag-definition change (and its test/docs updates) is correct
  per AGENTS.md and disclosed in the commit message, but mixing a behavior change with a
  documentation commit makes future bisection harder.
- **Proposed fix:** none for the code; just keep unrelated changes in their own commits going
  forward.

### M9 (confirmed minor) — Unknown inference activity is presented as "Idle"

- **Where:** `ui/js/monitor-ui.js`, `renderInferenceSnapshot`.
- **What:** any `processingBest` value other than a positive number, including `null`, renders as
  "Idle". When both `/metrics` and `/slots` are unavailable (or neither returns an activity field),
  the UI cannot know that the server is idle.
- **Proposed fix:** render "Idle" only for a known zero, "Generating" for a positive value, and
  "Unavailable" or "Activity unknown" for `null`. Add coverage for both sources being unavailable.

### M10 (confirmed accessibility issue) — Unavailable meters announce zero to assistive technology

- **Where:** `ui/js/monitor-ui.js`, `makeProgressBar`.
- **What:** a `null` percentage produces an empty visual bar but sets `aria-valuenow="0"`. Screen
  readers therefore receive an invented zero even though the visible text says the metric is not
  available.
- **Proposed fix:** omit `aria-valuenow` while unavailable and set an appropriate
  `aria-valuetext` such as "Not available". Restore the numeric attribute when a real value returns.
  Add an attribute-level unit test.

### M11 (confirmed rate-correctness issue) — Slot deltas do not require a stable task identity

- **Where:** `ui/js/monitor-ui.js`, `normalizeSlots` and the slot-rate calculation in
  `createInferenceStats.rebuild`.
- **What:** a processing slot with counters but no `id_task` is keyed as `<slot id>:` and can be
  compared across two different tasks that reuse the slot. Also, in a multi-slot sample, one
  comparable slot is enough to publish a summed rate even when another current processing slot is
  new or unmatched; the displayed value is then only a partial global rate. Both cases weaken the
  plan's requirement that slot deltas use the same stable slot/task identity.
- **Proposed fix:** require both a stable slot ID and task ID for delta samples. Publish a slot-based
  global rate only when every current processing slot that contributes tokens has a valid match in
  the previous sample; otherwise use the metrics gauge for that cycle. Test missing `id_task`, slot
  reuse, and a continuing slot plus a newly active slot.

### M12 (confirmed counter edge case) — CPU idle-counter rollback reports 100% usage

- **Where:** `backend/services/system_stats.py`, `compute_cpu_percent`, and the corresponding
  rollback test in `tests/backend/test_system_stats.py`.
- **What:** a negative idle delta is clamped to zero while a positive total delta is retained, so a
  reset/rollback of the idle counter produces 100% CPU rather than `null`. The test currently
  codifies that result, but the plan says counter rollback should invalidate the rate and replace
  the baseline. An idle delta greater than the total delta is similarly inconsistent and currently
  becomes 0% after final clamping.
- **Proposed fix:** return `null` for negative idle deltas or idle deltas greater than the total
  delta; the caller already stores the new sample as the next baseline. Update the rollback tests.

### M13 (confirmed edge case) — Hidden-card storage cap is enforced only after reload

- **Where:** `ui/js/monitor-ui.js`, `normalizeHiddenEntries`, `hideCard`, and
  `persistHiddenCards`.
- **What:** loading storage enforces the 100-entry cap, but hiding cards adds directly to the live
  map and persistence writes every entry. A long-running session with changing device identities can
  therefore exceed the documented cap; the next reload then truncates entries implicitly.
- **Proposed fix:** enforce the cap before every persistent write, retaining current/recent entries
  deterministically. Keep session-only `:index:` entries outside persistent-cap accounting. Add a
  test that crosses the cap without reloading.

### M14 (confirmed resilience edge case) — A metrics body-read failure discards a valid slots response

- **Where:** `ui/js/app.js`, `pollStats` response parsing.
- **What:** the two HTTP requests are initiated independently, and slots JSON parsing has its own
  error handling, but `metricsResp.text()` is awaited outside a per-source guard. If reading that
  response body rejects, the outer catch skips the already-successful slots response. This is rare,
  but it breaks the plan's source-independence guarantee during a transport/body failure.
- **Proposed fix:** parse each response inside its own settled/error boundary, then update the
  snapshot with whichever source completed successfully. Add a mocked response whose `text()`
  rejects while slots JSON succeeds.

### O1 (observation) — Disk-rate fallback sums all whole disks

- **Where:** `backend/services/system_stats.py:306` (`select_disk_counters`, `"disk:all"` branch).
- **What:** when the root device cannot be resolved, the fallback sums *all* whole-disk devices.
  This is broader than the plan's "limited to the device containing the application path", but
  the plan also scopes disk I/O as best-effort, the source identity (`"disk:all"`) keys the delta
  baseline, and Linux root-device resolution failing is rare. No change proposed; recorded so the
  fallback is a known, honest degradation rather than a surprise.

## What matches the plan well (verified during review)

- **Backend locking/coalescing:** `system_stats_lock` is never held across subprocesses;
  `system_stats_collection_lock` plus the generation comparison implement "forced refresh joins
  an in-progress collection and bypasses an already-complete cache entry" exactly, with dedicated
  tests (`CachingTests`).
- **Delta math:** timestamps captured immediately beside counter reads (vendor probes run
  afterwards), 0.1–30 s window, and counter-source identity keyed baselines are implemented and
  tested. Total/disk counter rollback correctly yields `null`; the CPU idle-counter exception is
  recorded in `M12`.
- **Contract rules:** per-field `null` (never zero), `available` flags, `gpus` always an array,
  provider-qualified identities with UUID → PCI/BDF → index fallback, invalid fields degrade
  without discarding devices; HTTP 200 for partial availability; `refresh=1`-only query validation.
- **Evidence gating:** `cuda*` → NVIDIA and `hip`/`rocm*`/`lemonade*` → AMD match the actual
  backend IDs (`cuda-12.4`, `rocm-10.0`, `lemonade-rocm-10.0`, …); Vulkan/SYCL/Metal/CPU produce no
  speculative rows; WSL excluded before distribution detection; native Windows/macOS never execute
  an incidental `amd-smi`; package commands come from a fixed allowlist and are never executed.
- **Security posture:** argv arrays, `shell=False`, no-window creation flags, short timeouts,
  sanitized client errors with real errors on stderr; no user input reaches any subprocess.
- **Shared inference snapshot:** one poller in `app.js`; `createInferenceStats` owns target-keyed
  baselines, rollback rebasing, and rate samples; the requests are initiated independently and
  normal failures allow partial snapshots (with the body-read exception in `M14`);
  `requests_deferred` is normalized; "Session tokens" and most-filled-slot context remain distinct;
  the Inference card adds no requests of its own; Reset is shared and updates both views
  immediately. Per-field counter freshness still needs `R3`.
- **Target transitions:** GUI runtime generations for GUI-owned servers; external revision
  incremented on every successful connect/restore (even to the same address) and excluded from
  the identity's API key; target-key changes abort in-flight polls and reset baselines/rate
  samples; document-visibility pause/resume for inference polling; panel-visibility gating for
  system/GPU polling; truthful badge states; schedule-after-completion with no overlap. The initial
  page-load restore path is the exception recorded in `R2`.
- **Terminal move:** IDs preserved, `invalidate()` advances the epoch without discarding the
  cursor (tested), 5,000/1,000 DOM trim, auto-scroll disabled on upward scroll, process lifecycle
  and cursor ownership stay in `app.js`.
- **Card hiding:** namespaced keys, session-only `:index:` hides, tolerant localStorage with
  load-time normalization caps (100 entries / 256-char keys / 120-char labels), dormant entries,
  "Show all" clears dormant, native `<details>`/`<summary>` restore list, and auto-fit grids close
  gaps. Write-time cap enforcement remains in `M13`.
- **Frontend hygiene:** `textContent` everywhere (only static SVG constants use `innerHTML`,
  matching the established pattern), no cross-realm `instanceof`, no silent empty catches,
  tokens-only CSS (no color literals, no `[data-theme]` selectors), no new globals on `app.js`.
- **Docs/tests:** `docs/directory.md` script order (21. `monitor-ui.js`) and route table (endpoint
  count 48, verified by `test_docs_sync`), `docs/architecture.html` API surface, AGENTS.md
  "Where to edit", README + screenshot, changelog; ~60 focused backend tests and a 1,269-line
  monitor unit suite, plus extended cursor/smoke/module-namespace tests.

## Suggested follow-up order

1. **R1–R3** — fix recovery, initial external-target restoration, and per-field counter freshness;
   these can make telemetry disappear or present stale values as current.
2. **R4, M2, M9–M12, M14** — correct visible units, rate validity, unknown states, ARIA semantics,
   CPU rollback, and per-source response handling; add focused regression tests for each.
3. **M5** — make the fixed bar label/data source an explicit product decision (context vs. KV).
4. **M3, M4, M7, M13** — scoped styling, cleanup, cold-start copy, and persistence hardening.
5. **M1 and M6** — no fix recommended; **M8 and O1** are historical/known-degradation notes only.

## Verification commands for the follow-up change

```powershell
node --check ui/js/app.js
node --check ui/js/monitor-ui.js
node tests/frontend/monitor_ui_unit.cjs
node tests/frontend/output_cursor_unit.cjs
npm run test:frontend
.venv\Scripts\python.exe -m unittest discover tests -v
git diff --check
```
