# Monitor Tab — Phase 2 Progress (Monitor tab + log move)

Tracks `docs/monitor-tab-docs/monitor-plan.md` → "Phase 2 — Monitor tab and log move".

Status: **complete** (2026-09-04).

- [x] 1. `ui/js/monitor-ui.js` module + `window.LlamaGui.monitorUi`
- [x] 2. Tab nav + `section-monitor` markup (move output DOM, IDs preserved)
- [x] 3. Auto-scroll, cursor-preserving clear (`output-cursor.js` `invalidate()`), 5,000-line DOM trim
- [x] 4. Shared target-keyed inference snapshot: independent `/metrics` + `/slots`, baselines, rollback, slot rates, 80/95 levels (`createInferenceStats` in monitor-ui.js, single poll cycle in app.js)
- [x] 5. Target reconciliation in `refreshRuntimeStatusPanels()`; external revision hook (`onExternalTargetChanged`); document-visibility gating
- [x] 6. System/GPU polling gated on panel + document visibility; Recheck via `?refresh=1`
- [x] 7. Hide/restore for every card except Process Output (tolerant localStorage `llama_gui_monitor_hidden_cards`, session-only `:index:` GPU hides, focus moves)
- [x] 8. Monitor CSS (token-pure port of mockup block) + fixed bar "Session tokens" relabel + compacted nav to fit the 9th tab
- [x] 9. Tests: `monitor_ui_unit.cjs` (new), `output_cursor_unit.cjs` + `module_namespace_unit.cjs` + `flag_sync_smoke.cjs` extended, added to `npm test` chain
- [x] 10. `docs/directory.md` script order/module/tab sync; full suites green; `git diff --check`

## Acceptance checklist

- [x] Launches, stops, reconnects, output backlog, clear, llama-cli input still work *(smoke: full suite incl. existing launch/stop/external flows)*
- [x] Clear does not replay backlog; terminal DOM capped at 5,000 lines *(unit: trim + invalidate; smoke: `since=` preserved after Clear)*
- [x] Appended output and returning to Monitor follow the bottom; no toggle or scroll listener *(unit)*
- [x] System/GPU cards poll only while Monitor panel + document visible *(unit lifecycle + smoke: zero requests while hidden)*
- [x] Inference card adds no `/metrics` or `/slots` requests; hiding removes presentation only *(monitor-ui never fetches llama endpoints; card visibility is a view preference)*
- [x] `/metrics` failure keeps `/slots` context and vice versa *(unit: independent source failures; sources never carried forward as live)*
- [x] Fixed bar and Inference card share one baseline; Reset updates both immediately *(unit engine + smoke: `#stats-context` and `#monitor-inference-total` agree, Reset → both "0")*
- [x] Target changes never mix counters/rates; same-address external reconnect resets baseline *(unit: setTarget isolation; `externalTargetRevision` bumped on every successful connect/restore)*
- [x] "Session tokens" vs slot context occupancy not conflated; idle retained context labeled honestly *(fixed bar relabel; unit: idle slot `(idle)` label, busiest-slot selection)*
- [x] Partial/unavailable fields render safely ("Not available", never fake zero; hostile GPU names stay text) *(unit)*
- [x] Every card except Process Output hideable/restorable; grids close gaps *(unit + smoke; auto-fit grids, dormant entries cleared by Show all)*
