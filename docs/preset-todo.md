# Presets Tab TODO

UI/UX backlog for the Presets tab (`ui/js/presets.js`, `.presets-browser` in `ui/css/style.css`).

Context: the tab is comfortable at ~10 presets and degrades past ~40. Reference case is a
library of 58 presets across 33 model groups, where the browser list renders ~91 blocks into a
320 px viewport.

Status legend: `[ ]` open, `[x]` shipped.

## 1. Keep The Selected Preset Visible

- [x] Shipped 2026-07-24.

Already in place before this pass: groups collapse by default (`isPresetGroupCollapsed()` returns
`true` unless a group was explicitly expanded), and Expand all / Collapse all toolbar buttons are
wired in `initPresetLibraryControls()`.

The gap was selection tracking. Searching force-expands groups, so picking a match and then
clearing the search left the selected row hidden inside a re-collapsed group while the detail
panel still showed it.

- Expand the group containing a newly selected preset so the selection is never hidden.
- Keep the existing search/filter force-expand path intact.

Acceptance criteria:
- Select via search, clear the search, selected row stays visible.
- Explicit user collapse/expand still wins elsewhere.
- `npm run test:frontend` passes.

## 2. Favorites As A Real Filter

- [x] Shipped 2026-07-24.

`presetFavoritesFirst` was only a sort key, but its pill sat in the filter row beside `All` and
`⚠ Warnings`, so clicking it never changed the list length. Mixed metaphor.

- Make the favorites pill tri-state: `All` → `★ First` → `★ Only`, where `★ Only` filters.
- Persist the tri-state, migrating the old boolean storage value.
- Reflect the active mode in the empty-state copy.

Acceptance criteria:
- Old `llama_gui_preset_favorites_first_v1` values still load without resetting the preference.
- `npm run test:frontend` passes.

## 3. Duplicate And Rename Presets

- [ ] Open.

Neither action exists in the frontend or `backend/routes/presets.py`. Creating a variant means
Load → edit → retype a name → Save, which round-trips through Configure and mutates live launch
state. Renaming means save-under-new-name plus delete.

- Add Duplicate to the detail panel action row. Pure frontend plus one `POST /api/presets`;
  suggest a `<name> copy` default and do not touch current Configure state.
- Add Rename. Needs a backend endpoint (or a copy-then-delete helper) that preserves `created`
  and migrates the favorite/last-used/group localStorage keys to the new name.
- Both must preserve the sensitive-flag stripping applied on save.

Acceptance criteria:
- Duplicating a preset does not alter the active Configure/Quick Launch values.
- Renaming carries favorite and last-used state across the name change.
- `python -m unittest discover tests -v` and `npm run test:frontend` pass.

## 4. Search Across Override Flags

- [ ] Open.

`getPresetSearchText()` covers only name, model path, and tool, so a preset cannot be found by
what it actually changes.

- Fold `overrideFlagIds` and their human labels (`getPresetFlagLabel`) into the search text so
  `ctx`, `draft`, or `flash` match.
- Watch the cost: search text is rebuilt per entry per render inside `buildPresetGroups`.
  Precompute it on the entry rather than per keystroke if profiling shows churn.

## 5. Bulk Favorite / Unfavorite

- [ ] Open.

The bulk bar offers Select All / Clear / Export / Delete. Starring ten presets is ten clicks,
each triggering a full `loadPresets()` re-render.

- Add Favorite / Unfavorite to the bulk bar.
- Batch the storage write and re-render once.

## 6. Library Summary In The Empty Detail Panel

- [ ] Open.

The detail panel occupies roughly half the tab width and shows a placeholder until a preset is
selected.

- Render a library summary when nothing is selected: total presets, model group count, total
  warnings, most recently used, and presets whose model file is missing (depends on item 9).

## 7. Let The Browser List Fill The Card Height

- [x] Shipped 2026-07-24.

`.presets-browser-list` used `max-height: calc(100vh - 330px)` with `min-height: 320px`, so the
two column heights were computed independently and never matched. The detail panel sat at its
380 px floor while the browser ran taller, and `.main-content`'s 56 px bottom padding pushed the
whole tab into a page scroll on top of the list's own scroll.

- `.presets-workspace` now takes a definite `height: max(460px, calc(100vh - 216px))` and
  stretches both columns, so they end level.
- `.presets-browser` is a flex column; the list is the only flexible child (`flex: 1 1 auto;
  min-height: 0`) and scrolls internally. Toolbar, filters, and bulk bar are pinned `flex: none`.
- The detail panel scrolls internally rather than stretching the page.
- The mobile stack resets to `height: auto` and keeps the `max-height: 50vh` list cap.

Note: a definite height is required. An earlier attempt using `min-height` let the list grow to
its full 1,213 px content and the page scrolled instead of the list.

Acceptance criteria:
- List scrolls internally; the page itself does not scroll on a 1000 px-tall window.
- No horizontal or double scrollbars at narrow widths.

## 8. Roving Arrow-Key Focus In The List

- [ ] Open.

Every row is a tab stop and carries a checkbox, a favorite toggle, and a Load button — roughly
230 tab stops to cross a 58-preset library.

- Give the list roving `tabindex` so Up/Down move between rows and Tab exits the list.
- Keep Enter/Space selection and the existing `role="button"` semantics.

## 9. Warn On Missing Model Files

- [ ] Open.

`getPresetWarnings()` only flags unsupported chat templates and custom launch args. With many
model groups, presets pointing at deleted GGUFs are the likeliest form of library rot, and the
`⚠ Warnings` filter would become a real cleanup tool if it caught them.

- Compare each preset's `model` against the known model list already fetched by the frontend.
- Treat a missing file as a warning, not an error; presets for models on another machine are a
  legitimate case.
