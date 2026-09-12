# Frontend Module Split Plan

> **Status: in progress.** Tracking document for the maintainability refactor agreed on 2026-09-11.
> Scope: Tier 1 only — split `ui/js/chat-ui.js` and `ui/js/presets.js`. Stay inside the
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

Session A targets `chat-ui.js` (highest churn × size). Session B applies the same recipe
to `presets.js`. `chat-window.js` and `monitor-ui.js` are deliberately out of scope for
now; revisit after the first two land.

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
   references), `docs/architecture.html` script-order ladder, `docs/changelog.md` dated
   entry. No route changes, so `tests/backend/test_docs_sync.py` is unaffected.
6. Delete `ui/js/chat-ui.js` only after green.
7. Verify: `node --check` per new file → chat-focused units (`chat_ui_unit`,
   `chat_window_unit`, `chat_compaction_unit`, `chat_rendering_unit`, `chat_tools_unit`,
   `character_cards_unit`) → `npm run test:frontend:modules` → full `npm test`.

## Session B — split `ui/js/presets.js`

Same recipe. Expected package `ui/js/presets/`: internal/state + configure ·
normalization/validation/sensitive scrubbing · model-matching/warnings · local state
(favorites/last-used/group/sort) · library rendering (groups/search/detail/summary/
saved-settings table) · roving focus · CRUD ops + context bar · `presets-main.js`.
Harness updates: `presets_unit.cjs`, `preset_roving_focus_unit.cjs`,
`launch_args_unit.cjs` (loads `presets.js` + `config-flags-ui.js`). Same index.html slot
(position 7, after `manager.js`, before `searchable-select.js`), same docs, same
verification bar.

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
- [ ] Session B: presets.js mapping produced
- [ ] Session B: `ui/js/presets/` package created, index.html updated
- [ ] Session B: test harnesses updated, old file deleted
- [ ] Session B: docs updated, changelog entry, full `npm test` green