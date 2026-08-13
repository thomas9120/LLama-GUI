# Custom Model Folder — Final Implementation Plan

Status: deferred; no feature code has been implemented.

## Goal

Allow the user to choose one model-library folder instead of the repository's
default `models/` folder, while preserving existing presets, mirrored model
controls, command previews, Hugging Face downloads, benchmarks, and Model
Switcher behavior.

The folder change should take effect without restarting Llama GUI. The default
installation must remain byte-for-byte compatible in its generated model
argument: `-m models/<relative-id>`.

## Decisions

- Keep exactly one active model root. No union of multiple folders.
- Store model selections and `preset.model` as paths relative to the active
  model root, such as `Qwen/model.gguf`. Never store the root or an absolute
  model path in `preset.model`.
- Persist an optional absolute `models_dir` in `config.json`. A missing, empty,
  or removed key means the repository's default `models/` folder.
- Require a custom folder to exist and be a directory when it is selected. Do
  not create arbitrary custom paths from user input.
- If a configured custom folder later becomes missing or unreadable, report it
  as unavailable and block affected operations. Never silently fall back to
  the default folder, because the same relative filename there could launch the
  wrong model.
- Keep `GET /api/models` backward compatible: it continues returning the
  existing array of `{name, size_mb}` objects.
- Use `/api/status` plus the setting response for model-root metadata; do not
  change the `/api/models` response shape.
- Hugging Face model and projector downloads follow the active model folder.
- Keep WikiText-2 benchmark data in the application-managed default data
  location for v1. It is benchmark data, not part of the user's model library.
- Leave `mmproj`, `model_draft`, other path flags, existing presets, and sampler
  presets unchanged.
- Do not add an environment-variable override in v1. Add one later only if a
  launcher or headless deployment has a demonstrated need.

## Current Contract to Preserve

- `GET /api/models` recursively scans `ctx.paths.models` and returns names
  relative to that root.
- Configure and Quick Launch model controls share the same model-relative value.
- Presets store a model-relative ID and use compatibility-aware exact/basename
  matching.
- `flag-core.js` and `benchmark-ui.js` validate the relative ID, then currently
  prepend the literal `models/` path.
- llama.cpp processes run with the repository root as their working directory.
- Model Switcher preflight accepts an absolute `-m` value and resolves relative
  values against the repository root.
- `ctx.paths.models` remains the immutable default models directory. The active
  model root becomes a runtime setting resolved through one backend helper.

## Backend Design

### 1. Central model-directory service

Add `backend/services/model_dir.py`. All code that needs the active model root
must use this service rather than re-reading or interpreting `models_dir`
itself.

Suggested responsibilities:

- `get_models_dir_info(ctx)` returns a safe metadata mapping:
  - `models_dir`: configured path for display, or the default path.
  - `models_arg_root`: backend-generated launch prefix. Use `models` for the
    default and a launch-ready absolute path for a custom folder.
  - `models_dir_is_default`: boolean.
  - `models_dir_available`: boolean.
  - `models_dir_error`: safe user-facing error string or `"`.
- `get_models_dir(ctx)` returns the usable `Path` from that state or raises a
  clear validation/unavailable error. It must not fall back when an override is
  present but invalid.
- `set_models_dir(ctx, value)` validates and persists an absolute existing
  directory, or resets to default for an empty/null value. It returns the same
  metadata mapping used by status.

Resolve and normalize a selected custom path before storing it. Preserve native
path semantics in the backend; the frontend must not guess the operating system
or rewrite arbitrary path characters. The backend-provided `models_arg_root`
is the only prefix used for command generation.

All `config.json` writes must:

1. Acquire `ctx.state.config_lock`.
2. Load the current mapping.
3. Change or remove only `models_dir`.
4. Save the merged mapping atomically.

This preserves `version`, `backend`, `tag`, `external_chat_target`, and future
unrelated settings.

### 2. Setting endpoint

Add `backend/routes/model_dir.py` with `POST /api/models-dir`.

Set request:

~~~json
{ path: D:/Models }
~~~

Reset request:

~~~json
{ path: null }
~~~

Successful responses use the metadata mapping described above. Return a 400 for
invalid input or a missing/non-directory selection. Return a 409 when the
folder cannot be changed because a model download is active. Sanitize client
errors and log unexpected failures to stderr.

Do not add a separate GET endpoint. Initial state already belongs in
`GET /api/status`, and a successful POST returns the new state directly.

### 3. Native directory picker

Add `POST /api/select-folder` to `backend/routes/file_picker.py` and a focused
directory-picker helper in `backend/services/file_picker.py`.

- Windows/Linux: tkinter `filedialog.askdirectory`.
- macOS: `osascript` `choose folder`, matching the existing file-picker
  packaging approach.
- Cancellation returns `{ selected: false, path: " }` and must not alter
  the setting.
- The picker only selects a path. Persistence still goes through
  `POST /api/models-dir`, so validation and config writes have one owner.

### 4. Status metadata

Update `GET /api/status` to publish the model-directory metadata. Status must
continue succeeding when the configured folder is unavailable so the UI can
show the error and offer Reset to default.

Do not expose stack traces or raw filesystem exceptions. The absolute directory
is already local-management information exposed by the current status API, but
avoid copying it into unrelated logs or process output.

### 5. Active-root consumers

Switch these consumers from direct `ctx.paths.models` access to
`model_dir.get_models_dir(ctx)`:

- `backend/routes/models.py`: model discovery.
- `backend/services/hf_download.py`: model/projector destination resolved once
  at download start.
- `backend/routes/lifecycle.py`: the `models` Open Folder target.
- `backend/services/file_picker.py`: initial directory for model-related path
  flags.
- `backend/routes/status.py`: active directory metadata through the service.

Do not switch `backend/routes/benchmarks.py`'s WikiText-2 directory in v1.
Because `ctx.paths.models` remains the immutable default, leaving that use in
place deliberately keeps benchmark data application-managed.

After implementation, search for every direct `ctx.paths.models` use and
classify it explicitly as either active-model-root or default-application-data.

### 6. Hugging Face concurrency

Changing the folder while a download is running can leave the completed model
outside the newly active list and can auto-select a different same-named file.
Prevent that race rather than trying to repair it afterward.

- Resolve the download root and transition `model_download_in_progress` under
  `ctx.state.model_download_lock`.
- `set_models_dir` checks the same lock/state and rejects changes while a
  download is active.
- If nested locks are required, use one documented order everywhere:
  `model_download_lock` before `config_lock`.
- The UI may disable Change/Reset during a download, but the backend check is
  authoritative.

A running llama.cpp process may continue using the model path with which it was
started. Changing the configured folder affects later selections and launches;
it does not relocate or restart the active process.

## Frontend Design

### 7. Shared model-directory state

Add private `modelDirInfo` state and a `setModelDirInfo(info)` setter to
`ui/js/flag-core.js`. Export only the narrow accessors/builders needed by other
modules. Do not add globals to `app.js`, create per-tab copies, or store this as
a launch flag.

The setter must distinguish:

- Not loaded yet.
- Default directory available.
- Custom directory available.
- Configured directory unavailable.

An unknown or unavailable state must block local-model command generation. It
must never assume the default folder.

### 8. One model-argument builder

Add one shared helper in `flag-core.js`, such as
`buildLocalModelPath(modelName)`:

1. Validate only `modelName` with the existing `normalizeModelRelPath()`.
2. Read the backend-provided `models_arg_root` from shared state.
3. Return `models/<relative-id>` for the default folder.
4. Return `<absolute-custom-root>/<relative-id>` for a custom folder.
5. Return a clear error when the ID, root state, or configured directory is
   invalid/unavailable.

Use this helper from:

- `flag-core.js` normal launch args and command preview.
- `benchmark-ui.js` benchmark/perplexity args.
- Any future local-model launch path.

The selected dropdown value and saved preset remain the relative ID. The
absolute path exists only in the generated command argument.

Do not normalize the complete native root with the model-ID validator. Do not
manually quote it before placing it in the argument array; `Popen` receives an
argument list, and the existing preview quoting helper handles display/copying.

### 9. Model-folder controls

Add one Models Folder row in the Configure tab near `#model-select`:

- Read-only current path display using `textContent`.
- `Change…` button: open `/api/select-folder`, then POST the selected path to
  `/api/models-dir`.
- `Reset to default` button, visible/enabled only for a configured override.
- Inline unavailable/error state with a Reset action.
- Optional warning when the chosen folder is inside the repository but outside
  `models/`, because its contents can become blocking git changes for app
  updates.

Wiring may remain in `manager.js`, which already owns model discovery, status,
Open Models, and the known-model cache. Do not add a new frontend module unless
the resulting code is demonstrably clearer.

After a successful set/reset:

1. Apply the POST response to shared state.
2. Force a fresh `checkStatus()` so its existing request-ID protection makes
   older in-flight status responses stale.
3. Call `refreshModels()`.
4. Let the existing model-option synchronization update Quick Launch.
5. Let `notifyModelPresenceChanged()` rebuild Presets warnings.
6. Update the command preview.

Keep `GET /api/models` parsing unchanged. Update the empty-state copy to refer
to the displayed active folder without inserting the path through `innerHTML`.

### 10. Selection behavior after a folder change

- Preserve the selected relative model only if it exists in the new list.
- Otherwise clear the live selection rather than retaining a hidden stale
  value.
- Presets are not rewritten. Existing preset matching/warnings determine
  whether their relative model exists in the new active folder.
- A known-empty folder retains the repository's current conservative preset
  warning behavior unless that policy is changed as a separate feature.
- Model Switcher preflight uses the shared absolute/custom argument and should
  continue validating the actual file before stopping the current server.

## Expected File Changes

Primary files:

- New: `backend/services/model_dir.py`
- New: `backend/routes/model_dir.py`
- `backend/app.py`
- `backend/routes/models.py`
- `backend/routes/status.py`
- `backend/routes/lifecycle.py`
- `backend/routes/file_picker.py`
- `backend/services/file_picker.py`
- `backend/services/hf_download.py`
- `backend/state.py` only if a lock/state adjustment is required
- `ui/js/flag-core.js`
- `ui/js/manager.js`
- `ui/js/benchmark-ui.js`
- `ui/index.html`
- `ui/css/style.css` only for structural layout; no color literals

Tests and documentation:

- `tests/backend/test_extracted_routes.py`
- Relevant backend service/foundation tests
- `tests/frontend/manager_model_cache_unit.cjs`
- Flag-core and benchmark unit tests
- `tests/frontend/flag_sync_smoke.cjs`
- `docs/directory.md`
- `docs/architecture.html`
- `docs/tests.md`
- `docs/changelog.md`

Adding `POST /api/models-dir` and `POST /api/select-folder` increases the route
registry by two exact routes. Update both API documentation tables and their
endpoint counts in the same change.

## Implementation Sequence

1. Add and unit-test the backend model-directory service, including unavailable
   configured-folder behavior and config merge preservation.
2. Add the setting and folder-picker routes, register them, and update status.
3. Migrate backend active-root consumers and add the HF download lock rule.
4. Add shared frontend directory state and the single path builder.
5. Switch normal launch and benchmark argument generation to that builder.
6. Add Configure UI controls and the refresh/status sequencing.
7. Extend unit and browser smoke coverage.
8. Update route/API architecture documentation, test documentation, and the
   changelog.

## Required Tests

### Backend

- No `models_dir` key resolves to `ctx.paths.models` and reports default.
- Valid absolute custom directory resolves and persists.
- Empty/null setting removes the key and resets to default.
- Reject relative paths, files, missing paths, malformed values, and unusable
  directories.
- A configured path that disappears reports unavailable and never falls back.
- Setting/reset preserves every unrelated `config.json` key.
- `GET /api/models` keeps its array shape and returns IDs relative to the custom
  root, including nested and symlinked models.
- Status reports available/default/custom/unavailable states without failing.
- Open Models and model-file picker use the active root.
- HF downloads use the active root and keep returned `model_name` relative.
- Folder changes are rejected while a model download is active.
- Directory-picker success, cancellation, and platform errors are covered with
  mocked native calls.
- WikiText-2 remains in the default application location.
- Documentation-sync tests pass with the two new routes.

### Frontend

- Default root produces exactly `models/<id>`.
- Custom root produces the backend-authoritative absolute path.
- Nested IDs work; absolute IDs and traversal remain rejected.
- Unknown and unavailable root state block launch and preview.
- Normal launch and benchmark paths use the same builder.
- `/api/models` remains an array contract in manager and benchmark consumers.
- Successful Change/Reset refreshes accepted status, both model selects,
  command previews, known-model cache, and Presets warnings.
- Stale overlapping status/model refreshes cannot restore the old folder or
  selection.
- Picker cancellation makes no API setting change.
- Folder paths are rendered with `textContent`.

## Verification

Run at minimum:

~~~powershell
node --check ui/js/flag-core.js
node --check ui/js/manager.js
node --check ui/js/benchmark-ui.js
npm run test:frontend
npm run test:flag-definitions
.venv/Scripts/python.exe -m unittest discover tests -v
~~~

Also manually verify paths containing spaces, a nested model, a Windows drive
path, a UNC/network path when available, a POSIX path, a symlinked model folder,
an unavailable/remounted folder, reset to default, and an attempted change
during an HF download.

## Pitfalls to Avoid

- Do not store absolute paths or `models/` prefixes in `preset.model`.
- Do not change `/api/models` from an array to an object.
- Do not silently use the default folder when custom-root state is unknown,
  invalid, disconnected, or unreadable.
- Do not let the UI determine Windows/macOS/Linux path semantics.
- Do not run a native path through `normalizeModelRelPath()`; that validator is
  only for the model-relative ID.
- Do not hand-build shell command strings or pre-quote `Popen` arguments.
- Do not mutate `flagValues` directly or introduce separate Configure, Quick
  Launch, Benchmark, or Presets copies of the root.
- Do not refresh the model list without also updating accepted root state and
  invalidating older in-flight responses.
- Do not allow a root change to race an active HF download.
- Do not rewrite or migrate presets when the folder changes.
- Do not move/retarget absolute `mmproj` or draft-model values as part of v1.
- Do not turn v1 into per-preset folders, multiple roots, basename guessing, or
  model-library merging.
- Do not move WikiText-2 merely because it currently lives below
  `ctx.paths.models`.
- Do not overwrite unrelated `config.json` keys; always merge under
  `config_lock`.
- Do not create a missing custom directory automatically. This is especially
  dangerous for temporarily disconnected drives or network mount points.
- Do not assume an existence check guarantees later availability. Catch and
  report filesystem errors at each operation boundary.
- Do not use `innerHTML` for directory names, errors, or model filenames.
- Do not add platform conditionals to frontend code.
- Do not overlook custom folders inside the git repository: outside the safe
  `models/` prefix, model files may block automatic app updates.
- Do not remove the current symlink/junction behavior. It remains a useful
  zero-code alternative and `_iter_gguf_files` cycle protection must remain.
- Do not claim the active folder changed until set, status acceptance, and model
  refresh have all succeeded. On partial failure, keep a visible recoverable
  error and offer Reset.

## Acceptance Criteria

- A user can select, view, use, and reset one custom models folder without
  restarting Llama GUI.
- Configure, Quick Launch, Presets, Benchmarking, Model Switcher, command
  previews, HF downloads, Open Models, and model-file pickers agree on the same
  active root.
- Existing presets remain unchanged and launch the same relative model when it
  exists in the active folder.
- Default installations continue generating `-m models/<id>`.
- A missing custom folder cannot cause a default-folder model with the same ID
  to launch.
- `/api/models` remains backward compatible.
- Folder changes cannot race active model downloads.
- Backend, frontend, docs-sync, and syntax checks pass.

