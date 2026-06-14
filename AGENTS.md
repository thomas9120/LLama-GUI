# AGENTS.md

## Project Reference

The full project reference lives in **`docs/directory.md`**. It covers architecture, directory map, backend/frontend module reference, data flow, flag system, chat template presets, Quick Launch, Chat, HF downloader, tunnel, auto-update, sampler presets, metrics, MCP, reasoning support, custom launch args, configuration search, smoke tests, and native file picker.

The test reference lives in **`docs/tests.md`**. It lists the frontend/backend test commands, test file purposes, and when to use focused unit tests versus browser smoke tests.

Read `docs/directory.md` before starting any task.

## UI State Sync Rule

When the same setting appears in more than one place in the UI, all instances must stay linked.

Examples:
- A setting shown in both `Configure` and `Quick Launch`
- Any duplicated model, template, sampler, or launch flag control across tabs

Required behavior:
- All duplicate controls must read from the same underlying state object.
- Changing the setting in one tab must immediately update the matching control in every other tab.
- Command preview / launch args must be generated only from the shared underlying state, never from per-tab copies.
- Avoid separate option lists for the same setting. Reuse the same flag definition or shared source list whenever possible.
- Prefer one shared setter function for each shared setting so updates, UI refresh, and launch-arg sync happen in one place.

Anti-patterns to avoid:
- Maintaining a custom dropdown list in one tab while another tab uses the real flag enum
- Having "helper" controls that do not call the same setter as the main control
- Letting one tab keep its own derived copy of a shared setting
- Re-implementing the same setting logic in multiple places

Safe implementation pattern:
1. Define the setting once in shared flag/state definitions.
2. Reuse the same options source anywhere the setting is rendered.
3. Route all changes through one shared setter.
4. Refresh all mirrored controls after state changes.
5. Verify that changing either control updates the other and changes the final command preview.

If a shared control becomes unreliable, prefer removing the duplicate UI over keeping two unsynchronized versions.

## Agent Workflow Guidelines

### Before You Start
- Read the task carefully and identify which files are involved. Use the
  File Ownership Reference in this file to locate the right files.
- Search for existing patterns before writing new code. If a helper, setter,
  or validation function already exists, reuse it.
- Check `docs/todo.md` for known planned work. If your task overlaps with a
  TODO item, follow its acceptance criteria.

### Make Minimal, Focused Changes
- Change only the files necessary for the task. Avoid "while I'm here" edits
  to unrelated code.
- When fixing a bug, fix the root cause. Do not add workarounds that mask the
  symptom (e.g., adding `setTimeout` to hide a race condition).
- When adding a new flag, template, or preset, follow the existing pattern
  exactly. Do not invent a new pattern when one already exists.

### Verify After Every Change
- Run `node --check ui/js/<file>.js` on every JS file you touch to catch
  syntax errors immediately.
- Run `node tests/frontend/custom_launch_args_unit.cjs` after parser changes.
- Run `npm run test:frontend` (Playwright smoke test) after any change to
  mirrored controls, flag state, command preview, or shared setters.
- Run `python -m unittest discover tests -v` after backend changes.
- Test the generated command preview manually if Playwright is not available.

### Prefer Incremental Changes Over Large Refactors
- Decompose large tasks into small, independently verifiable steps.
- Each step should leave the app in a working state.
- Do not batch multiple unrelated changes into one commit or one edit session.

## Common Pitfalls

### Frontend

- **Never mutate `flagValues` directly.** All changes must go through
  `setFlagValue()` / `setMultipleFlagValues()` / `applyFlagValues()` in
  `flag-core.js`. Direct mutation (e.g.,
  `flagCore.getFlagValues().temperature = 0.5`) bypasses the sync broadcast
  and silently breaks Configure, Quick Launch, Chat, and command preview.

- **Never create per-tab copies of shared state.** If a tab needs to display
  a flag value, read from `flagCore.getFlagValues()`. Do not store a local
  copy that can drift out of sync.

- **Never maintain a separate options list for a duplicated setting.** If
  Configure and Quick Launch both show a chat template dropdown, both must
  read from the same `CHAT_TEMPLATE_PRESET_OPTIONS` source in `flags.js`.

- **Do not use `innerHTML` with user/model content.** Use `textContent` for
  user-facing text. The `renderMarkdown()` function is the one exception for
  model output; do not add new `innerHTML` usage.

- **Do not add new global functions to `app.js`.** The file already has 80+
  global functions. New behavior should be namespaced under
  `window.LlamaGui` or placed in a focused module.

- **Avoid silent error swallowing.** Empty `catch` blocks hide bugs. Use
  `console.debug()` for expected optional failures and `console.warn()` for
  unexpected ones.

### Backend

- **Do not add broad `except Exception` without re-raising or logging.**
  Routes use `sanitize_error()` for tunnel security, but the real error must
  appear in server console output via `print()` to stderr.

- **Do not bypass threading locks for state mutations.** All stateful
  operations (process, download, tunnel, install) use locks in
  `backend/state.py`. Always acquire the appropriate lock before reading or
  writing shared state.

- **Do not use `os._exit()` except in the restart path.** It skips all Python
  cleanup. For normal shutdown, use the graceful shutdown path in
  `backend/services/lifecycle.py`.

- **Validate all external input.** HF repo IDs, filenames, revisions, and
  user-provided paths must be validated with strict regex and path traversal
  checks before use.

### Platform-Specific

- **Test Windows process termination carefully.** `CTRL_BREAK_EVENT` on
  Windows requires `CREATE_NEW_PROCESS_GROUP` at creation time and can be
  received by the parent if it shares the console.
- **Use platform-agnostic patterns in frontend code.** All platform decisions
  should be made backend-side. The frontend must remain platform-agnostic.

## Task-Specific Recipes

### Adding a New llama.cpp Flag

1. Verify the flag exists upstream in `common/arg.cpp` or `server.cpp`.
2. Add the flag definition to `FLAGS` in `ui/js/flags/definitions.js` with correct
   `id`, `flag`, `type`, `default`, `desc`, `tool`, and `category`.
3. For `enum` type, verify all option values match upstream.
4. For `bool` type with a negation (e.g., `--no-mmap`), set `false_flag`.
5. Run `node --check ui/js/flags/definitions.js`.
6. Verify the flag appears in the Configure tab and command preview.
7. If the flag should appear in Quick Launch, add it to the Quick Launch
   controls in `app.js` reading from the same `flagCore` state.
8. Run `npm run test:frontend` to verify sync.
9. Update `docs/flag_report.md` if doing a flag audit.

### Known Omitted llama.cpp Flags

- Do not expose `-cd` / `ctx_size_draft`. Current `llama-server` and
  `llama-cli` builds do not advertise a draft context-size flag, and launching
  with `-cd` fails as an unsupported argument. Keep stale preset values inert
  rather than emitting this flag.

### Adding a New Chat Template Preset

1. Decide: `builtin` (maps to upstream template name), `bundled` (new
   `.jinja` file), or `auto`/`auto_alias`.
2. Add one entry to `CHAT_TEMPLATE_PRESETS` in `ui/js/flags/chat-templates.js`.
3. If bundled, add the `.jinja` file under `ui/templates/`.
4. `CHAT_TEMPLATE_PRESET_OPTIONS` populates the dropdown automatically.
5. Verify the preset appears in both Configure and Quick Launch.
6. Verify `--chat-template` (builtin) or `--chat-template-file` (bundled)
   appears in command preview but not both.
7. Verify reverse mapping works (builtin name or file path -> dropdown
   preset).
8. Run `npm run test:frontend`.

### Adding a New Quick Launch Profile

1. Add an entry to `QUICK_PROFILES` in `ui/js/app-data.js`.
2. Set `tool`, `flagValues`, `fitLinked`, and `samplerPresetName`.
3. Verify applying the profile updates Configure, Chat, and command preview.
4. Verify the profile summary text is accurate.

### Modifying the Custom Launch Args Parser

1. Edit `parseCustomLaunchArgs()` in `ui/js/flag-core.js`.
2. Run `node tests/frontend/custom_launch_args_unit.cjs` immediately.
3. Add new test cases to `tests/frontend/custom_launch_args_unit.cjs` for
  new parsing behavior.
4. Verify command preview updates correctly for success and error cases.
5. Verify parser errors block launch and show near the textarea.

### Changing Backend Route Behavior

1. Identify the route file in `backend/routes/`.
2. Identify the service file in `backend/services/` if applicable.
3. Check threading lock requirements in `backend/state.py`.
4. Make the change.
5. Run `python -m unittest discover tests -v`.
6. Check that error paths produce useful console output (not silent).
7. Verify CORS handling if the route is new or changes origin behavior.

## File Ownership Reference

This table shows which files own which concerns. When making changes, start
with the primary file and only touch secondary files if the change requires it.

| Concern | Primary File | Secondary Files |
|---------|-------------|-----------------|
| Flag definitions | `ui/js/flags/definitions.js` | `ui/js/flags/options.js` (enum lists), `ui/js/flag-validation.js` |
| Flag categories / filtering helpers | `ui/js/flags/categories.js`, `ui/js/flags/helpers.js` | `ui/js/config-flags-ui.js` (rendering consumers), `ui/js/flag-core.js` (default values) |
| Shared flag state | `ui/js/flag-core.js` | `ui/js/app.js` (callbacks) |
| Launch args / command preview | `ui/js/flag-core.js` | `ui/js/app.js` (render) |
| Configure tab rendering | `ui/js/config-flags-ui.js` | `ui/js/flag-core.js` (state) |
| Quick Launch controls | `ui/js/quick-launch-ui.js` | `ui/js/app.js` (init/callbacks), `ui/js/flag-core.js` (state) |
| Quick Launch profiles | `ui/js/app-data.js` | `ui/js/quick-launch-ui.js` (apply/render), `ui/js/sampler-presets.js` (sampler values) |
| Chat state/controller | `ui/js/chat-ui.js` | `ui/js/app.js` (init/status/stats callbacks), `ui/js/flag-core.js` (sampler state) |
| Chat sidebar samplers | `ui/js/chat-ui.js` | `ui/js/app-data.js` (slider map), `ui/js/flag-core.js` (state) |
| Chat markdown/rendering helpers | `ui/js/chat-rendering.js` | `ui/js/chat-ui.js` (chat state/controller) |
| API tab docs/snippets | `ui/js/api-tab.js` | `ui/js/app.js` (status/init), `ui/js/flag-core.js` (state reads) |
| HF download UI | `ui/js/hf-download-ui.js` | `ui/js/quick-launch-ui.js` (init), `ui/js/app.js` (callbacks), `ui/js/manager.js` (fetchJson) |
| Remote tunnel UI | `ui/js/remote-tunnel-ui.js` | `ui/js/app.js` (init), `ui/js/api-tab.js` (endpoint config), `ui/js/manager.js` (fetchJson) |
| Chat template presets | `ui/js/flags/chat-templates.js` | `ui/js/app.js` (mapping helpers) |
| Sampler presets | `ui/js/sampler-presets.js` | `ui/js/app-data.js` (built-ins), `ui/js/flag-core.js` (apply), `ui/js/app.js` (callbacks) |
| Preset save/load/import/export | `ui/js/presets.js` | `ui/js/flag-core.js` (collect/apply) |
| Install/update/model manager UI | `ui/js/manager.js` | `ui/js/app.js` (lifecycle callbacks), `ui/js/flag-core.js` (selected model sync) |
| Shared frontend API utility | `ui/js/manager.js` (`fetchJson`) | UI modules that call backend APIs |
| Backend route registry / server lifecycle | `backend/app.py` | `backend/routing.py`, `backend/routes/*.py`, `backend/services/lifecycle.py` |
| Backend route handlers | `backend/routes/*.py` | Matching `backend/services/*.py` where service logic exists |
| Backend install / release services | `backend/services/llama_manager.py` | `backend/routes/install.py`, `backend/app.py` (service wiring) |
| Backend process services | `backend/services/process_manager.py` | `backend/routes/process.py`, `backend/state.py` |
| Backend HF download services | `backend/services/hf_download.py` | `backend/routes/hf_download.py`, `backend/state.py` |
| Backend tunnel services | `backend/services/tunnel.py` | `backend/routes/tunnel.py`, `backend/state.py`, `backend/http.py` (CORS tunnel URL) |
| Backend web search / chat helpers | `backend/services/web_search.py`, `backend/services/chat.py` | `backend/routes/search.py`, `backend/routes/chat.py` |
| Backend app update services | `backend/services/git_update.py` | `backend/routes/git_update.py` |
| Backend file picker services | `backend/services/file_picker.py` | `backend/routes/file_picker.py` |
| Backend config / paths | `backend/config.py` | `backend/context.py`, `backend/app.py` |
| Backend state/locks | `backend/state.py` | `backend/context.py` |
| Backend HTTP/CORS | `backend/http.py` | `backend/app.py` |
| Chat templates | `ui/templates/*.jinja` | `ui/js/flags/chat-templates.js` (preset defs) |
| Frontend tests | `tests/frontend/*.cjs` | — |
| Backend tests | `tests/backend/*.py` | — |

The canonical script loading order is in **`docs/directory.md` (Frontend → Script Loading Order)**. This file only tracks load order changes — keep that section in `directory.md` in sync.

## Error Handling Expectations

### Frontend
- `fetchJson()` (manager.js) returns `null` for non-JSON 200 responses.
  Callers must handle `null` gracefully.
- Polling functions (`pollStats`, `pollOutput`) may fail silently when the
  server is not ready. This is expected. Do not add user-visible errors for
  polling failures during startup.
- `saveSamplerPresetStore()` in `ui/js/sampler-presets.js` logs storage
  failures with `console.warn()`. Keep custom preset save failures visible.
- localStorage `getItem` returns `null` for missing keys. Always check
  before parsing JSON.

### Backend
- Routes return sanitized errors to clients via `sanitize_error()`. The real
  error goes to stderr via `print()`.
- `_BODY_TOO_LARGE` sentinel from `read_body()` is a three-state return:
  `dict` (success), `None` (malformed JSON), or sentinel (too large). Check
  with `is` not `==`.
- Thread daemon threads may be killed mid-operation on process exit. Downloads
  should clean up partial files in `finally` blocks.
