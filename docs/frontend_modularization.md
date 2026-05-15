# Frontend Modularization Plan

## Summary

Breaking down the frontend is feasible and worthwhile for long-term maintainability, but it should be done as a staged refactor rather than a big-bang rewrite.

The current frontend is already partly separated:

- `ui/js/flags.js` owns flag definitions, chat template presets, and option metadata.
- `ui/js/manager.js` owns install/update flow.
- `ui/js/presets.js` owns launcher preset management.
- `ui/js/app.js` still owns most runtime UI behavior and is the main maintainability pressure point.

`app.js` currently mixes several domains in one file: shared flag state, Configure rendering, Quick Launch, Hugging Face download UI, Chat, stats polling, process output, API docs, remote tunnel UI, sampler presets, tab switching, command generation, and general utilities.

The backend has already been successfully modularized into route and service modules, so the repository has a good precedent for staged extraction with compatibility preserved.

## Recommendation

Refactor the frontend gradually while keeping the current vanilla HTML/CSS/JS architecture. Do not start with a framework migration or full ES module conversion.

The first goal should be to turn `app.js` into a small bootstrap and orchestration file while moving feature behavior into focused files.

Most importantly, preserve the AGENTS.md UI state sync rule:

- Duplicated controls must read from the same shared state.
- All launch-relevant updates must route through shared setters.
- Command preview and launch arguments must be generated only from shared state.
- Quick Launch, Configure, Chat sliders, and preset controls must remain mirrored.

## Proposed Extraction Order

### 1. Shared Utilities

Create `ui/js/utils.js` for low-risk helpers:

- `debounce`
- `escapeHtml`
- `copyText`
- `showToast`
- small formatting helpers such as byte/time formatting

This is the safest first extraction because these functions have minimal state ownership.

### 2. Shared State and Command Generation

Create a focused shared state layer, either as `ui/js/state.js` or a namespace inside `app.js` before moving it out.

This layer should own:

- `currentTool`
- `flagValues`
- `setFlagValue`
- `setPathFlagValue`
- `setMultipleFlagValues`
- `syncUiAfterSharedStateChange`
- `collectFlagValues`
- `applyFlagValues`
- `getLaunchArgs`
- `updateCommandPreview`

This is the most important step. Without it, later feature extractions would risk duplicating state or breaking mirrored controls.

### 3. Sampler Presets

Create `ui/js/sampler-presets.js` for:

- built-in sampler presets
- custom sampler preset storage
- sampler preset import/export
- `applySamplerPresetValues`
- shared sampler preset controls

This is a good early module because sampler presets are shared by Configure, Quick Launch, and Chat, so it will validate the shared-state interface.

### 4. Output and Stats

Create:

- `ui/js/output-panel.js`
- `ui/js/stats.js`

Move:

- process output polling
- output append/clear/send-input behavior
- stats polling
- stats baseline snapshots
- metrics rendering

These areas are mostly independent of Configure and Quick Launch rendering.

### 5. Remote Tunnel and API UI

Create:

- `ui/js/tunnel-ui.js`
- `ui/js/api-ui.js`

Move:

- Cloudflare tunnel start/stop/status polling
- tunnel URL rendering/copy behavior
- API endpoint rendering
- copyable API snippets
- server URL preview helpers where appropriate

This keeps the API tab from being interleaved with launch and chat logic.

### 6. Configure UI

Create `ui/js/config-ui.js` for:

- `renderFlags`
- `createFlagRow`
- `createSubmenuBlock`
- Configure search
- expand/collapse behavior
- type-specific flag row builders

While extracting, split `createFlagRow()` into type-specific builders:

- `createBoolFlagRow`
- `createEnumFlagRow`
- `createMultiEnumFlagRow`
- `createPathFlagRow`
- `createNumericFlagRow`
- `createTextFlagRow`

This should make future flag additions safer and reduce the chance of breaking unrelated input types.

### 7. Quick Launch

Create `ui/js/quick-launch.js` for:

- Quick Launch profiles
- context controls
- GPU controls
- model selector sync
- template selector sync
- Quick Launch sampler controls
- Hugging Face downloader UI

This module must continue using the shared flag setter API. It must not keep per-tab copies of model, template, sampler, or launch flag state.

### 8. Chat

Create `ui/js/chat.js` for:

- streaming chat requests
- SSE parsing
- chat markdown rendering
- web search status/source display
- conversation history
- system prompt handling
- chat sampler sliders
- send/stop/undo/regenerate behavior

Chat should be extracted later because it touches shared sampler flags, stats baselines, localStorage, streaming UI, and backend proxy behavior.

## Module Loading Strategy

Start with classic scripts and a shared namespace such as `window.LlamaGui`.

This avoids a risky runtime change while the code is being split. After the extraction is stable, consider migrating to `<script type="module">` and explicit imports.

Suggested initial shape:

```js
window.LlamaGui = window.LlamaGui || {};
window.LlamaGui.state = { ... };
window.LlamaGui.utils = { ... };
window.LlamaGui.quickLaunch = { ... };
```

Keep script order explicit in `ui/index.html` during the transition.

## Helpful Tools

The most useful tooling for this refactor should protect the existing vanilla JS architecture instead of forcing a framework rewrite.

### Recommended First

- **ESLint**: Add linting before the split so accidental globals, unused functions, duplicate declarations, and risky browser globals are caught early. Useful rules include `no-implicit-globals`, `no-unused-vars`, `no-redeclare`, and later `no-restricted-globals`.
- **TypeScript check mode for JavaScript**: Keep `.js` files, but add JSDoc types and run `tsc --allowJs --checkJs --noEmit`. This is especially useful around flag definitions, shared state setters, launch args, and feature-module interfaces without converting the project to TypeScript.
- **Playwright**: Add browser-level regression tests for the workflows most likely to break during modularization: tab switching, mirrored controls, command preview sync, sampler sync, HF downloader controls, tunnel controls, and chat controls.
- **Madge or dependency-cruiser**: Once feature files exist, use a dependency graph tool to catch circular dependencies and confirm modules are not reaching into each other in surprising ways.

### Useful Later

- **Native ES modules**: After namespace-based extraction is stable, migrate from classic global scripts to `<script type="module">` with explicit `import`/`export` boundaries. This gives real browser-supported module structure without a bundler.
- **Vite**: Consider only if static script/module loading becomes cramped or if the project wants a Node-based dev server, bundling, cache busting, and faster frontend iteration. Do not make Vite a prerequisite for the first modularization pass.
- **Prettier**: Useful for consistent formatting, but lower priority than linting, type checking, and browser regression tests.

Suggested adoption order:

1. Add ESLint.
2. Add `checkJs` with lightweight JSDoc on shared interfaces.
3. Add Playwright smoke/regression tests.
4. Split into namespace-based files.
5. Add dependency graph checks once modules exist.
6. Consider native ES modules.
7. Consider Vite only if the static setup becomes limiting.

## Risks

- Hidden coupling through global variables in `app.js`.
- Duplicate controls becoming unsynchronized if feature modules maintain local copies.
- Command preview drifting from actual launch arguments.
- Initialization order bugs from classic script loading.
- Chat and Quick Launch regressions because both touch shared sampler and template state.

These risks are manageable if shared state is extracted first and each later module only uses the shared setter/getter interface.

## Verification Checklist

After each extraction, verify:

- Configure and Quick Launch model controls stay synchronized.
- Configure and Quick Launch chat template controls stay synchronized.
- Chat sampler sliders update the same sampler state used by Configure and Quick Launch.
- Loading a sampler preset updates every mirrored sampler control.
- Command preview changes after any mirrored control changes.
- Launch arguments still come from `getLaunchArgs()`.
- Launch/stop/output polling still works.
- Stats polling still works after launch.
- HF repo file search, download, completion, and cancel still work.
- Remote tunnel start/stop/status UI still works.
- Preset save/load/import/export still works.
- Existing non-module scripts still load in the correct order.

## Success Criteria

The refactor is successful when:

- `app.js` is mostly bootstrap, tab orchestration, and cross-module wiring.
- Feature modules can be reasoned about independently.
- Shared state remains centralized.
- Adding a new flag or mirrored control has one obvious implementation path.
- No user-facing behavior changes except fixes made intentionally.
