more info needed for missing telemetry (vendor probes for GPUs) 

for server ready badge/notification that shows up when launching llama.cpp, offer a "switch to monitor tab" link. - not too intrusive, temporary.

allow for re-ordering cards in monitor tab.

---

# Implementation Plan

Current state noted while drafting (verify against code when implementing):

- GPU probes: `backend/services/system_stats.py` — `probe_nvidia()` / `probe_amd()` return only `(status, devices)`; failure details go to stderr via `_log_probe_failure()` and never reach the frontend. Setup/state entries built by `build_gpu_setup_entries()` carry generic messages only.
- Ready notification: `handleLifecycleReady()` in `ui/js/app.js` fires `showToast("Server is ready!", "success")`. `showToast()` (app.js) supports message/type/duration only — no action/link.
- Monitor cards: static system + Inference cards live in `.monitor-metrics-grid` (inline markup in `ui/index.html`); GPU cards are rebuilt per sample into `#monitor-gpu-grid`, state cards into `#monitor-gpu-states`, setup cards into `#monitor-setup-cards` (`renderGpuArea()` in `ui/js/monitor-ui.js`). All carry `data-monitor-key`. Hide/show preferences already persist to `localStorage` key `llama_gui_monitor_hidden_cards`.

## Fix 1 — more info for missing GPU telemetry (vendor probe details)

Goal: when a vendor probe fails or finds nothing, the Monitor state/setup cards explain *why* (tool not found vs. non-zero exit vs. timeout vs. parsed-but-empty), not just the generic message.

Backend — `backend/services/system_stats.py`:

1. Give probes a diagnostics return without churning every call site: `probe_nvidia()` / `probe_amd()` return `(status, devices, details)` where `details` is a small dict, e.g. `{ "reason": "not_found" | "timeout" | "exit_code" | "no_devices" | "parse_error", "executable": <resolved path or None>, "exit_code": int|None, "stderr": <first line, truncated to ~200 chars> | None }`. Update both call sites in `collect_sample()` and any test callers.
2. Sanitize/validate `details` the same way other external input is treated: truncate stderr, drop anything that isn't the fixed key set, no full command echoing (the query args are fixed constants anyway).
3. `build_gpu_setup_entries()` / `_nvidia_setup_entry()` / `_amd_setup_entry()` accept the details dicts and attach them as `"details"` on each emitted entry. Keep messages evidence-gated as today — details only add facts the probe observed.
4. Keep `_log_probe_failure()` stderr logging unchanged (invariant: real error to stderr).

Frontend — `ui/js/monitor-ui.js`:

5. In `makeSetupCard()` / `makeStateCard()`, when `entry.details` exists, render 1–3 extra `makeMetricRow()` lines (e.g. "Reason", "Tool", "Exit code" / first stderr line). Use `textContent`-based helpers only (already the case via `makeMetricRow`).
6. No new polling/refresh changes — details ride the existing `/api/system-stats` payload and Recheck path.

Tests:

- `tests/backend/test_system_stats.py`: cases for each `reason` (missing tool, non-zero exit, timeout, ok-but-empty), truncation of stderr, and that `details` never appears when status is `ok` with devices.
- `tests/frontend/monitor_ui_unit.cjs`: state/setup card rendering shows detail rows when present and nothing extra when absent.

## Fix 2 — "switch to Monitor tab" link on the server-ready notification

Goal: when llama-server becomes ready, the existing toast offers a temporary, non-intrusive link into the Monitor tab. No new banner system.

1. `showToast()` in `ui/js/app.js`: add optional `options.action = { label, onClick }`. When present, render a `<button class="toast-action">` (textContent only) before the close button; on click, `stopPropagation()`, dismiss the toast, then call `onClick`. Reuse existing dismiss path so the auto-hide timer is cleared.
2. `handleLifecycleReady()`: pass `{ action: { label: "Open Monitor", onClick: () => switchTab("monitor") } }` on the ready toast. Optionally bump this toast's duration a bit (e.g. 8000 ms) so the link is usable; still auto-dismisses.
3. Minimal CSS for `.toast-action` in `ui/css/style.css` (ghost-styled inline button). No palette/theme tokens needed — reuse existing button/badge styles if a class already fits; check `--fg` tokens before adding anything.
4. Scope guard: only the llama-server ready toast gets the action. Benchmark tool ready paths and reconciliation toasts stay unchanged.

Tests:

- No dedicated unit test required (toast is DOM glue), but verify manually: launch → toast shows link → click lands on Monitor → toast dismisses; and that toasts without `action` render identically to before.

## Fix 3 — re-ordering Monitor cards

Goal: users can persistently reorder cards. Lazy scope: ordering within the tab's card flow, persisted like the hidden-card preference.

Design decisions (keep it minimal):

- **Interaction:** HTML5 drag-and-drop. Each card gets `draggable="true"` plus a drag-handle affordance (the whole card header is the drag source; `cursor: grab` via one CSS rule). Rebuild churn is handled by *delegated* listeners bound once to each container (`#monitor-gpu-grid`, `.monitor-metrics-grid`, `#monitor-gpu-states`, `#monitor-setup-cards`) in `init()` — `dragstart`/`dragover`/`drop` read `data-monitor-key` from `event.target.closest("[data-monitor-key]")`, so per-sample card rebuilds in `renderGpuArea()` need zero re-binding.
- **Storage:** new `localStorage` key `llama_gui_monitor_card_order` = JSON array of card keys. Reuse the normalization pattern of `normalizeHiddenEntries()` (dedupe, max entries, max key length) as `normalizeOrderEntries()`.
- **Application:** `drop` computes the insertion index from the drop position relative to the hovered card (before/after by pointer y within the card), reorders the persisted key list, persists, and calls `applyCardOrderToDom()` — for each container, sort its `[data-monitor-key]` children by their index in the persisted order (unknown keys keep DOM order after known ones) and re-append. Call it everywhere `applyHiddenCardsToDom()` is called: `renderGpuArea()` tail, `onTabChanged()`, `init()`. During drag, `dragover` shows a simple insertion marker (a class on the hovered card, e.g. `.drop-before`/`.drop-after`) — no ghost previews, no libraries.
- **Cross-container moves:** out of scope for v1 — cards reorder within their own container (metrics grid, GPU grid, states, setup). Note this as a known ceiling in a `ponytail:` comment; upgrade path is a single flattened grid if it's ever wanted.
- **Accessibility:** drag-and-drop alone is not keyboard-accessible, so each card's tools row also gets a tiny fallback: keep the existing Hide button as-is and rely on the hidden-cards "Show all" bar for recovery. If keyboard reordering is ever requested, add move-arrow buttons then (they compose with this design — both write the same persisted key list).

Changes — `ui/js/monitor-ui.js`:

1. Order store: `loadCardOrder()`, `persistCardOrder()`, `applyCardOrderToDom()`.
2. DnD wiring in `init()`: `cardShell()` and the static-card init loop set `draggable="true"` + `data-monitor-key` (already present on static cards); one delegated listener set per container (`dragstart` stores the dragged key, `dragover` preventDefault + insertion-marker class, `drop` reorders + persists + applies, `dragend` clears marker state).
3. A drop landing on an empty area of a container appends the dragged card at that container's end.
4. Wire into `resetForTests()` and export `normalizeOrderEntries` for tests.

CSS — `ui/css/style.css`:

5. `[data-monitor-key] { cursor: grab; }` while dragging state via `.dragging` (opacity dim) and `.drop-before`/`.drop-after` marker classes (border/outline on the relevant edge). No theme tokens needed.

Tests:

- `tests/frontend/monitor_ui_unit.cjs`: order normalization; drop-before/drop-after reorder math and persistence; apply-order reorders a container's children; unknown keys stay last; interaction with hidden cards (hidden cards don't break ordering). DOM drag events can be synthesized in the vm harness by dispatching plain Events with a stubbed `dataTransfer`.

## Housekeeping (per AGENTS.md)

- Update `docs/changelog.md` with summaries of all three fixes.
- No new backend routes → no `docs/directory.md` route-table or `architecture.html` surface changes; verify with `.venv/Scripts/python.exe -m unittest discover tests -v`.
- Verify commands: `node --check` on touched JS, `npm run test:frontend`, backend suite via project venv.
- Suggested order of implementation: Fix 2 (smallest, ~30 lines), Fix 1 (backend details plumbing + card rows), Fix 3 (order store + move buttons), each independently shippable.

