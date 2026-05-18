# `app.js` And Flags Modularization Progress Log

## Phase 0: Baseline And Guardrails
- [x] Record current counts for `FLAGS`, `FLAG_CATEGORIES`, `CHAT_TEMPLATE_PRESETS`, and `BUILTIN_CHAT_TEMPLATES`.
  - Baseline: 139 flags, 14 categories, 31 chat template presets, 51 built-in chat templates.
- [x] Run baseline checks:
  - `node --check` on the ordered flag modules
  - `node --check ui/js/app.js`
  - `node tests/frontend/custom_launch_args_unit.cjs`
  - `npm run test:frontend`
- [x] Confirm current Quick Launch, Configure, chat template, command preview, and profile behavior before refactoring.
  - Baseline frontend smoke passed on `http://127.0.0.1:5240/`.

## Phase 1: Split `flags.js` Without Behavior Changes
- [x] Create focused ordered modules for categories, shared options, chat templates, flag definitions, and helpers.
  - Added `ui/js/flags/categories.js`, `options.js`, `chat-templates.js`, `definitions.js`, and `helpers.js`.
- [x] Preserve all existing global names used by current scripts and tests through the ordered split modules.
- [x] Update `ui/index.html` script loading order so dependencies load before consumers.
- [x] Update docs that refer to parsing `ui/js/flags.js` as the single source file.
  - Updated `docs/agent-workflows.md` and `docs/directory.md`.
- [x] Verify no flag defaults, template mappings, or launch args changed.
  - Post-split counts still match baseline: 139 flags, 14 categories, 31 chat template presets, 51 built-in chat templates.

## Phase 2: Move Shared Quick Launch And Sampler Data Out Of `app.js`
- [x] Move `QUICK_CONTEXT_PRESETS`, `QUICK_PROFILES`, built-in sampler preset data, and purely declarative sampler metadata into a shared data module.
  - Added `ui/js/app-data.js`.
- [x] Keep existing global compatibility names during the transition.
- [x] Populate the Quick Launch profile dropdown from `QUICK_PROFILES`.
- [x] Remove hardcoded Quick Launch profile `<option>` entries from `ui/index.html`.

## Phase 3: Consolidate Host And Port Helpers In `app.js`
- [x] Add one normalized helper for server endpoint config: host, port, and base URL.
  - Added `getServerEndpointConfig()` and kept `getServerBaseUrl()` as the base URL wrapper.
- [x] Reuse it in server address previews, API endpoint rendering, chat URL/body generation, metrics-adjacent call sites where applicable, and remote tunnel start.
- [x] Confirm UI previews and backend payloads still use the same defaults: `127.0.0.1` and `8080`.

## Phase 4: Verification And Cleanup
- [x] Run `node --check` on every touched JS file.
- [x] Run `node tests/frontend/custom_launch_args_unit.cjs`.
- [x] Run `npm run test:frontend`.
- [x] Manually verify:
  - Configure renders all flags.
  - Quick Launch profiles match the previous list.
  - Profile application updates Configure and command preview.
  - Chat template controls stay synced.
  - API URLs, chat requests, and remote tunnel payloads use normalized host/port.
  - Covered by `tests/frontend/flag_sync_smoke.cjs`; direct in-app browser navigation to `127.0.0.1:5240` and `localhost:5240` was blocked by the browser surface with `ERR_BLOCKED_BY_CLIENT`.
- [x] Update this progress log with results and any deferred follow-up items.

## Deferred Follow-Ups
- [ ] Wrap `app.js`, `manager.js`, and `presets.js` in IIFEs under `window.LlamaGui`.
- [ ] Remove fragile cross-file implicit globals after namespaced APIs exist.
- [ ] Address unrelated accessibility and CSP items from `docs/may_codereview.md`.
