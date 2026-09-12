# Frontend Module Split Plan

> **Status: Tier 1 complete (2026-09-11).** Both sessions landed and the full suite is green.
> This document records the completed Tier 1 recipe and session notes. The current
> Tier 2 roadmap lives in `docs/frontend-maintainability-tier-2-plan.md`.
> Scope was Tier 1 only — split `ui/js/chat-ui.js` and `ui/js/presets.js`. Stay inside the
> current global-script architecture (no ES modules, no bundler). One module per session,
> full test suite green before the next.

## Why

The four largest frontend modules are single IIFEs with ~50 shared mutable closure
variables and 100–160 functions each. Git churn over the last 90 days confirms these are
also the most-edited files, so every change requires reloading a 2,000–3,000-line module
into your head, and the coupling between the closure variables is invisible until you are
hundreds of lines deep.

| File | Lines | Functions | Churn (90d) |
|---|---|---|---|
| `ui/js/chat-ui.js` | 2,954 | 164 | 37 |
| `ui/js/presets.js` | 2,505 | 121 | 35 |
| `ui/js/chat-window.js` | 2,231 | 108 | 9 |
| `ui/js/monitor-ui.js` | 2,052 | 101 | 22 |

Session A split `chat-ui.js` (highest churn × size). Session B applied the same recipe to
`presets.js`. The remaining large modules are tracked as future targets below.

## Mechanism (both sessions)

- New sibling package `ui/js/chat/` (resp. `ui/js/presets/`), each file a plain IIFE,
  loaded in order in the exact `ui/index.html` slot the old file occupied. No new public
  namespaces, no ES modules.
- **File 1 (`chat-internal.js`)** creates `window.LlamaGui._chatInternal` (underscore =
  private convention, like `window.__LLAMA_GUI_TEST_HOOKS__`) holding an explicit `state`
  object for the shared mutable variables, plus shared constants. The previously hidden
  closure coupling becomes explicit property access. No other module may touch it.
- **Middle files** own one cohesive concern each and attach their functions to the
  internal namespace via `Object.assign` (the pattern `presets.js` already uses for its
  public namespace). Read-only load-time constants may stay as file-local consts.
- **Last file (`chat-main.js`)** holds `init()`, the public namespace assembly with the
  exact same keys as today, and the `__LLAMA_GUI_TEST_HOOKS__` block (the flag is set
  before evaluation, so the hooks must be attached from the final file).
- Cross-file calls go through the internal namespace; state access goes through the
  state object (`S.x` style). No behavior change: diffs are code movement plus
  state-access renames only.

## Session A — split `ui/js/chat-ui.js`

Steps:

1. **Map first, move second.** Full read of `chat-ui.js`; produce a complete mapping of
   all 74 module-level declarations and every function to a target sub-file before
   touching anything. Candidate seams (confirm against actual function clusters):
   workspace ownership/transfer machinery · history persistence & rendering ·
   streaming/send/abort/tool-call assembly · context preview & compaction wiring ·
   sidebar/sampler/panels/badge · DOM/rendering helpers.
2. Create `ui/js/chat/` package per the mechanism above.
3. `ui/index.html`: replace the single tag with the ordered `chat/*.js` tags in the same
   slot (after `character-cards.js`, before `chat-window.js`), each with a fresh `?v=`
   cache-buster.
4. Update harnesses that reference the module directly:
   - `tests/frontend/chat_ui_unit.cjs` — read the ordered file list instead of the single
     source; the `__LLAMA_GUI_TEST_HOOKS__` flag is set before evaluation, so the hook
     block must remain in the final file.
   - `tests/frontend/chat_popout_integration.cjs` — retarget its `/js/chat-ui.js` network
     interception (Chat-init-failure fixture overriding `chatUi.init`) to the final
     `chat-main.js` path.
   - Verify `chat_window_unit.cjs` needs no change (it loads `chat-window.js`).
5. Docs: `docs/directory.md` (Script Loading Order, Frontend Module Reference, Chat Tab
   references), `docs/architecture.html` script-order ladder, and a dated changelog
   entry (the changelog file has since been removed). No route changes, so
   `tests/backend/test_docs_sync.py` is unaffected.
6. Delete `ui/js/chat-ui.js` only after green.
7. Verify: `node --check` per new file → chat-focused units (`chat_ui_unit`,
   `chat_window_unit`, `chat_compaction_unit`, `chat_rendering_unit`, `chat_tools_unit`,
   `character_cards_unit`) → `npm run test:frontend:modules` → full `npm test`.

## Session B — split `ui/js/presets.js`

Unlike `chat-ui.js`, presets.js declares everything top-level (script globals, no IIFE),
and the VM harnesses rely on that (`preset_roving_focus_unit.cjs` mutates module state
via bare `presetRovingKey = …` assignments; `presets_unit.cjs` calls internals bare).
So the split is **pure code movement**: ordered slices keeping every declaration
 top-level, state in `presets-internal.js`, and the `Object.assign` namespace in
`presets-main.js` — no renames. Final package (10 files): `presets-internal.js`
(state/configure/sensitive scrubbing/fetch/normalize/import validation) ·
`presets-apply.js` (apply/compare/context bar) · `presets-models.js` (matching/warnings) ·
`presets-local.js` (favorites/last-used/sort) · `presets-library.js` (grouping/search/labels) ·
`presets-detail.js` (summary/detail/bulk/entry rendering) · `presets-roving.js` ·
`presets-groups.js` (list rendering/toasts/loadPresets/controls init) · `presets-crud.js` ·
`presets-main.js` (namespace assembly, loaded last).
Harness updates: `presets_unit.cjs`, `preset_roving_focus_unit.cjs`,
`launch_args_unit.cjs` (loads the package + `config-flags-ui.js`), all evaluating the
package per file to mirror browser script boundaries. Same index.html slot
(position 7, after `manager.js`, before `searchable-select.js`), same docs, same
verification bar.

## Historical Tier 2 candidate snapshot

> **Superseded planning detail:** `docs/frontend-maintainability-tier-2-plan.md`
> is now the source of truth for Tier 2 scope and implementation order. The
> snapshot below is retained as the original follow-up list from the Tier 1 work.

The original follow-up snapshot proposed one module per session, with the same Tier 1
bar: map first, move second, full `npm test` green, docs updated in the same session,
and the old file deleted only after green. It chose a recipe by module shape:

- **Session A recipe** — IIFE with closure state → ordered package with a private
  internal namespace, explicit state object, and `I.`/`S.` renames.
- **Session B recipe** — top-level script globals → ordered slices, pure movement,
  no renames (the VM harnesses may rely on bare global access — check first).

Candidates from the original review, in rough priority order (churn × payoff):

| Candidate | Lines | Functions | Churn (90d) | Recipe | Notes |
|---|---|---|---|---|---|
| `app.js` chat-template helpers | ~70 | 5 | (app.js: 45) | — | Not a split: a quick win. Move the chat-template mapping helpers (`getChatTemplatePresetByValue`/`ByBuiltinName`/`ByPath` plus the reverse-mapping helpers, ~lines 449–520) out of the orchestrator into a focused module beside `flags/chat-templates.js`. `app.js` is the highest-churn file in the repo, so shrinking it pays off first. |
| `manager.js` | 1,481 | 61 | 29 | B | Five separable concerns: backend/release install UI, app-update UI, Python server lifecycle (`stopPythonServer`/`restartPythonServer`/`waitForServerReady`), model-dir controls, and the model-name cache; plus shared utilities (`fetchJson`, `confirmAction`, `promptAction`, `openFolder`). Top-level globals → pure movement. Update the `manager releases`/`model cache`/`model directory` unit harness source lists per file. |
| `monitor-ui.js` | 2,052 | 101 | 22 | A | Monitor polling with visibility gating, process-output terminal, reconciled GPU cards, and the shared inference snapshot engine (`createInferenceStats`). IIFE → Session A recipe. `monitor_ui_unit.cjs` reads the file directly — extend its VM source list. |
| `chat-window.js` | 2,231 | 108 | 9 | A | Verified Chat pop-out window and ownership/handoff/recovery coordination; already strict-mode. Largest remaining file but low churn since the pop-out rebuild, so lowest urgency. `chat_window_unit.cjs` reads it directly; `chat_popout_integration.cjs` loads it via the browser (its init-failure fixture intercepts `chat-main.js`, unaffected by this split). |

From the original review's later tiers (Tier 3+), whenever they get picked up: backend
packages (`system_stats.py` per-platform collectors + GPU probes with `__init__` re-exports,
`process_manager.py` launch-args/estimates extraction), splitting the largest test files
(`flag_sync_smoke.cjs`, `monitor_ui_unit.cjs`, `test_extracted_routes.py`), and an
aggregate `test:units` script for faster focused runs.

## Success criteria

- `window.LlamaGui.chatUi` / `.presets` keep their exact public keys;
  `module_namespace_unit.cjs` green (it derives load order from `ui/index.html`).
- Zero behavior change — code movement + state-access renames only.
- Full `npm test` green after each session.
- Pinokio launcher unaffected: its `scripts/check-app-compat.js` pins `server.py`,
  `backend/` lifecycle files, and the flags/flag-core/app-data frontend files only —
  verified 2026-09-11 that `chat-ui.js`/`presets.js` are not referenced.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Missed state-var renames → ReferenceErrors | Checklist of all 74 declarations; grep removed identifiers against the new package before deleting the old file; unit suites + Playwright load catch the rest |
| Pop-out fixture silently stops applying | Its `chatUiRouteHit` assertion fails loudly if the URL is not retargeted |
| Script-order regressions | `module_namespace_unit` and `flag_sync_smoke` both load the real index.html order |
| `_chatInternal` leaking to other modules | Underscore-private convention; enforce in review |
| Docs drift | Update `directory.md` in the same session (AGENTS.md requirement) |

## Progress

- [x] Audit codebase, identify hotspots (2026-09-11)
- [x] Scope agreed: Tier 1, globals kept, one module per session (2026-09-11)
- [x] Launcher compat verified against `llama-gui-pinokio` `check-app-compat.js` (2026-09-11)
- [x] Planning document created (2026-09-11)
- [x] Session A: chat-ui.js mapping produced
- [x] Session A: `ui/js/chat/` package created, index.html updated
- [x] Session A: test harnesses updated, old file deleted
- [x] Session A: docs updated, changelog entry, full `npm test` green
- [x] Session B: presets.js mapping produced
- [x] Session B: `ui/js/presets/` package created, index.html updated
- [x] Session B: test harnesses updated, old file deleted
- [x] Session B: docs updated, changelog entry, full `npm test` green
