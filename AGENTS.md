# AGENTS.md

## Workflow

- Read `docs/directory.md` before non-trivial work; it contains the architecture, module map, and canonical frontend script order. See `docs/tests.md` for test coverage and commands.
- Keep diffs minimal, reuse existing helpers, and fix root causes. Start in the owning module; touch others only as needed.
- Add a dated summary to `docs/changelog.md` for program changes; documentation-only changes are excluded.
- When adding/reordering frontend scripts, preserve dependency order and update `docs/directory.md`.
- When adding/removing backend routes, update the Route Modules table and endpoint count in `docs/directory.md` and the API surface table in `docs/architecture.html`. `tests/backend/test_docs_sync.py` checks both.

## Frontend

- **One source of truth:** Configure, Quick Launch, Chat, and command preview must read shared flag/template/sampler state and option lists. No per-tab copies.
- **Never mutate `flagCore.getFlagValues()` directly.** Write through `setFlagValue`, `setMultipleFlagValues`, or `applyFlagValues` in `ui/js/flag-core.js` so every control and preview receives the sync broadcast.
- Reuse `CHAT_TEMPLATE_PRESET_OPTIONS` from `ui/js/flags/chat-templates.js` for chat-template dropdowns.
- Use `textContent` for user/model content. The only HTML-rendering exception is `renderMarkdown()` for model output.
- Add behavior in focused `window.LlamaGui` modules; no new globals in `app.js`.
- Keep platform decisions in the backend.
- No silent empty `catch`: use `console.debug` for expected optional failures, `console.warn` for unexpected ones.
- Avoid `instanceof` across realms (`node:vm` tests). Duck-type collections; use `Array.isArray` for arrays.
- `fetchJson()` in `ui/js/manager.js` throws on non-JSON, even HTTP 200. Guard against `null` only when the endpoint can return literal JSON `null`.

## Backend

- Mutate shared process, download, tunnel, and install state only under the locks in `backend/state.py`.
- Log real errors to stderr; send clients `sanitize_error()` output. Never blanket-catch `Exception` without logging it.
- Validate external input (HF repo IDs, filenames, revisions, paths) before use.
- Clean partial downloads in `finally`.
- Normal shutdown goes through `backend/services/lifecycle.py`; `os._exit()` is reserved for restart.
- On Windows, `CTRL_BREAK_EVENT` requires `CREATE_NEW_PROCESS_GROUP` at process creation; a shared console can cause the signal to hit the parent.
- `read_body()` returns a `dict`, `None`, or `_BODY_HANDLED` (already responded). Compare the sentinel with `is`, not `==`.

## Feature pitfalls

- **Never expose or emit `-cd` / `ctx_size_draft`.** Keep stale preset values inert.
- New llama.cpp flags: verify upstream (`common/arg.cpp` / `server.cpp`), add to `FLAGS` in `ui/js/flags/definitions.js`, match enum values exactly, and set `false_flag` for negated booleans.
- Fork-only flags: track in `docs/upstream-changes.md`, set `fork_only: true`, and use booleans defaulting to false. Upstream binary compatibility checks exclude them.
- Chat templates: add one `CHAT_TEMPLATE_PRESETS` entry in `ui/js/flags/chat-templates.js`; bundle `.jinja` files under `ui/templates/`. Emit `--chat-template` or `--chat-template-file`, never both, and reverse-map names/paths to the dropdown.
- Custom launch args: edit `parseCustomLaunchArgs()` in `ui/js/flag-core.js`, extend its unit tests for new cases, and run them immediately. Parser errors must block launch and appear near the textarea.
- Themes: add one palette block in `ui/css/tokens.css` and one `THEMES` entry in `ui/js/theme-ui.js`. Never add theme selectors or color literals to `ui/css/style.css`.
- Preserve theme contrast floors: AA for text; 3:1 for `--fg-faint` and fill-only `-solid` tokens, across surfaces, semantic chips, and composited interaction washes. `theme_ui_unit.cjs` enforces the details documented in `docs/tests.md`.

## Verification

Run checks appropriate to the change; use `docs/tests.md` to select focused unit tests.

| Change | Required check |
|--------|----------------|
| Any JS file | `node --check <path-to-file>` |
| Flag definitions | `npm run test:flag-definitions` |
| Custom launch-args parser | `node tests/frontend/custom_launch_args_unit.cjs` |
| Themes | `node tests/frontend/theme_ui_unit.cjs` |
| Mirrored controls, shared state, command preview, or DOM wiring | `npm run test:frontend` |
| Backend | `.venv/Scripts/python.exe -m unittest discover tests -v` |
| Full frontend suite | `npm test` |

Use the **project venv** for backend tests (`.venv/bin/python` on Unix). System Python may lack runtime dependencies and produce misleading failures.
