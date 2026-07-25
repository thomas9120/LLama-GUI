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

- [x] Shipped 2026-07-24.

Neither action existed in the frontend or `backend/routes/presets.py`. Creating a variant meant
Load → edit → retype a name → Save, which round-tripped through Configure and mutated live launch
state. Renaming meant save-under-new-name plus delete.

- Duplicate (`duplicatePreset`) copies the *saved* preset data straight to `POST /api/presets`,
  so live Configure/Quick Launch values are never touched. `buildDuplicatePresetName` picks
  `<name> copy`, then `<name> copy 2`, and so on against the existing names.
- Rename uses a new `POST /api/presets/rename` route. It renames the file, carries the
  `.preset-created-times` entry so "Date added" sorting survives, 404s on a missing source,
  409s on an existing target, and treats a same-name rename as a no-op success.
- Case-only renames (`Base` → `base`) need care on Windows: `Path.__eq__` is case-insensitive
  *and* `Path.resolve()` rewrites the requested spelling to the existing on-disk casing, so any
  comparison built on `get_preset_file_path()` output sees the two names as identical and skips
  the rename. The no-op check therefore compares the sanitized request strings, and the rename
  targets `preset_file.parent / f"{safe_new_name}.json"` to keep the requested casing. Collision
  detection uses `samefile()` so a case-only change is allowed through while a real collision
  still 409s on case-sensitive filesystems.
- `renamePresetLocalState` moves the favorite and last-used entries before `loadPresets()` runs,
  since that call prunes local state for names the backend no longer knows.
- Correction to the original note: group collapse state is keyed by *model path*, not preset
  name, so it needs no migration.
- Both paths keep the existing sensitive-flag stripping, which lives in `save_preset` /
  `sanitize_preset_data` on the backend and applies to duplicates automatically.
- Rename needed a text-input dialog, so `promptAction()` was added next to `confirmAction()` in
  `ui/js/manager.js` with a matching `#prompt-modal` in `index.html`. It resolves `null` on
  cancel so callers can tell "dismissed" from "cleared the field".

Acceptance criteria:
- Duplicating a preset does not alter the active Configure/Quick Launch values. Verified live.
- Renaming carries favorite and last-used state across the name change. Verified live.
- `python -m unittest discover tests` and `npm test` pass.

## 4. Search Across Override Flags

- [ ] Open.

`getPresetSearchText()` covers only name, model path, and tool, so a preset cannot be found by
what it actually changes.

- Fold `overrideFlagIds` and their human labels (`getPresetFlagLabel`) into the search text so
  `ctx`, `draft`, or `flash` match.
- Watch the cost: search text is rebuilt per entry per render inside `buildPresetGroups`.
  Precompute it on the entry rather than per keystroke if profiling shows churn.

## 5. Bulk Favorite / Unfavorite

- [x] Shipped 2026-07-24.

The bulk bar offered Select All / Clear / Export / Delete. Starring ten presets was ten clicks,
each doing its own storage read/write plus a full `loadPresets()` re-render.

- `★ Favorite` and `☆ Unfavorite` sit between Clear and Export, disabled with an empty
  selection like the other bulk actions.
- `setPresetsFavorite(names, favorite)` does one read and at most one write for the whole
  selection, and returns how many entries actually changed.
- A selection that is already fully favorited writes nothing and reports the no-op instead of
  triggering a pointless refetch.

Verified live: 58 presets favorited in a single storage write and one re-render; the no-op path
wrote nothing; unfavorite cleared exactly the selected names.

Follow-up (same day): the two text buttons pushed the bar 121 px past the 430 px column, clipping
Export and Delete. The left column always resolves to its 430 px maximum on desktop, so the
shortfall was constant rather than width-dependent. Fixed by making the toggles 26x24 icon
buttons reusing `.presets-icon-btn`, trimming the bar gap to 6 px and button padding to
`--space-2`, and adding `flex-wrap: wrap` to the base rule so a future action wraps instead of
clipping. `.presets-bulk-bar { flex-wrap: wrap }` previously existed only in the 700 px query.

Acceptance criteria:
- One storage write per bulk action regardless of selection size.
- `npm test` passes.

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
