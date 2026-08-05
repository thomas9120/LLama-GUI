# AGENTS.md

When changes are made to llama-gui, update the /docs/changelog.md (summaries are fine)

## Project Reference

- Full architecture / module map: **`docs/directory.md`** (read before non-trivial work)
- Test commands and when to use them: **`docs/tests.md`**
- Canonical script load order lives in `docs/directory.md` — keep it in sync if you add/reorder frontend scripts

## Invariants

### UI state sync
When the same setting appears in more than one place (Configure, Quick Launch, Chat, command preview), all instances must stay linked:

- Read from the same underlying state (`flagCore.getFlagValues()`, shared option lists).
- Route all writes through one shared setter (`setFlagValue` / `setMultipleFlagValues` / `applyFlagValues` in `flag-core.js`).
- Generate command preview only from that shared state — never from per-tab copies.
- If a mirrored control stays unreliable, delete the duplicate UI rather than keep two sources of truth.

### Frontend
- **Never mutate `flagValues` directly.**  
  Bad: `flagCore.getFlagValues().temperature = 0.5`  
  Good: `flagCore.setFlagValue("temperature", 0.5)`  
  Direct mutation skips the sync broadcast and silently desyncs Configure / Quick Launch / Chat / preview.
- **No per-tab copies** of flag/template/sampler state, and **no separate options lists** for a duplicated control. Chat templates: `CHAT_TEMPLATE_PRESET_OPTIONS` from `ui/js/flags/chat-templates.js`.
- **No `innerHTML` with user/model content** — use `textContent`. Exception: `renderMarkdown()` for model output only.
- **No new globals on `app.js`.** New behavior goes on `window.LlamaGui` or a focused module.
- **No silent empty `catch`.** Prefer `console.debug` (expected optional) / `console.warn` (unexpected).
- **No `instanceof` for values that cross a realm** (frontend unit tests run source in `node:vm`). Duck-type; use `Array.isArray` for arrays.

```js
// Wrong — false for a Set created in the vm test context
return names instanceof Set ? names : null;

// Right
return names && typeof names.has === "function" && typeof names.size === "number"
    ? names
    : null;
```

- Frontend stays **platform-agnostic**; platform decisions belong in the backend.

### Backend
- Stateful ops (process, download, tunnel, install) mutate only under locks in `backend/state.py`.
- Do not blanket `except Exception` without logging the real error to stderr (`print`). Clients get `sanitize_error()`.
- No `os._exit()` except the restart path — normal shutdown goes through `backend/services/lifecycle.py`.
- Validate external input (HF repo IDs, filenames, revisions, paths) before use.
- Windows process stop: `CTRL_BREAK_EVENT` needs `CREATE_NEW_PROCESS_GROUP` at create time; it can hit the parent if they share a console.

## Landmines / non-obvious rules

- **Do not expose `-cd` / `ctx_size_draft`.** Current `llama-server` / `llama-cli` reject it. Keep stale preset values inert; do not emit the flag.
- New llama.cpp flags: confirm upstream (`common/arg.cpp` / `server.cpp`), add to `FLAGS` in `ui/js/flags/definitions.js`, match enum values exactly, set `false_flag` for negated bools. Run `npm run test:flag-definitions`.
- Chat template presets: one entry in `CHAT_TEMPLATE_PRESETS` (`ui/js/flags/chat-templates.js`); bundled `.jinja` under `ui/templates/`. Emit `--chat-template` **or** `--chat-template-file`, never both. Reverse-map builtin name / file path back to the dropdown.
- Custom launch args: edit `parseCustomLaunchArgs()` in `flag-core.js` and run `node tests/frontend/custom_launch_args_unit.cjs` immediately; extend that file for new cases. Parser errors must block launch and surface near the textarea.
- Themes: a theme is **one palette block in `ui/css/tokens.css` plus one `THEMES` entry in `ui/js/theme-ui.js`**. Never add a `[data-theme=…]` selector or a color literal to `style.css` — both are absent by design and `theme_ui_unit.cjs` will not let a new theme render as the fallback. Contrast floors are enforced per theme (AA for text, 3:1 for `--fg-faint` and the fill-only `-solid` tokens), measured against `--bg-surface`, `--bg-raised`, `--bg-elevated`, each semantic color's own `-subtle` chip, **and composited interaction-state washes**. On a mid-tone theme the chip sits *lighter* than the surface, so its colors need brightening where light themes need darkening.
- `fetchJson()` (`manager.js`) throws for non-JSON responses, including HTTP 200; callers only need a `null` guard when an endpoint can return a literal JSON `null`.
- `_BODY_HANDLED` from `read_body()` is a three-state sentinel: `dict` / `None` / already-responded. Compare with `is`, not `==`.
- Sanitize errors to clients; real error always to stderr. Download threads should clean partial files in `finally`.

## Where to edit

Start at the primary file; touch secondaries only if required.

| Concern | Primary |
|---------|---------|
| Flag definitions / enums | `ui/js/flags/definitions.js`, `options.js` |
| Flag categories / helpers | `ui/js/flags/categories.js`, `helpers.js` |
| Shared flag state, launch args, custom-arg parser | `ui/js/flag-core.js` |
| Configure tab | `ui/js/config-flags-ui.js` |
| Quick Launch UI / profiles | `ui/js/quick-launch-ui.js`, `ui/js/app-data.js` (`QUICK_PROFILES`) |
| Chat UI / sidebar samplers | `ui/js/chat-ui.js` |
| Chat markdown | `ui/js/chat-rendering.js` |
| Chat template presets | `ui/js/flags/chat-templates.js` |
| Sampler presets | `ui/js/sampler-presets.js`, `ui/js/app-data.js` |
| Presets save/load/library | `ui/js/presets.js` |
| Themes / palettes / theme menu | `ui/css/tokens.css`, `ui/js/theme-ui.js` (`THEMES`) |
| Models / install UI / `fetchJson` | `ui/js/manager.js` |
| HF download UI | `ui/js/hf-download-ui.js` |
| Tunnel UI | `ui/js/remote-tunnel-ui.js` |
| API tab | `ui/js/api-tab.js` |
| Benchmark UI | `ui/js/benchmark-ui.js` |
| Backend routes | `backend/routes/*.py` → matching `backend/services/*.py` |
| Route registry / server lifecycle | `backend/app.py`, `backend/routing.py`, `backend/services/lifecycle.py` |
| Locks / shared server state | `backend/state.py` |
| Config / paths | `backend/config.py` |
| HTTP / CORS / `sanitize_error` | `backend/http.py` |

Deeper maps (services, data flow, script order): `docs/directory.md`.

## Verify

| Change | Check |
|--------|--------|
| Any touched JS file | `node --check ui/js/<file>.js` |
| Flag definitions | `npm run test:flag-definitions` |
| Custom launch-args parser | `node tests/frontend/custom_launch_args_unit.cjs` |
| Mirrored controls / flag state / command preview / shared setters | `npm run test:frontend` |
| Backend | `python -m unittest discover tests -v` |
| New or removed backend route | Also update the Route Modules table in `docs/directory.md` (including its endpoint count) and the API surface table in `docs/architecture.html` — `tests/backend/test_docs_sync.py` fails on drift in either direction |
| Full frontend suite / more detail | `docs/tests.md` |

Minimal diffs; reuse existing helpers and patterns; fix root causes, not symptoms.
