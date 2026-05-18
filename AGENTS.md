# AGENTS.md

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
  Implementation Map in `docs/agent-workflows.md` to locate the right files.
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
2. Add the flag definition to `FLAGS` in `ui/js/flags.js` with correct
   `id`, `flag`, `type`, `default`, `desc`, `tool`, and `category`.
3. For `enum` type, verify all option values match upstream.
4. For `bool` type with a negation (e.g., `--no-mmap`), set `false_flag`.
5. Run `node --check ui/js/flags.js`.
6. Verify the flag appears in the Configure tab and command preview.
7. If the flag should appear in Quick Launch, add it to the Quick Launch
   controls in `app.js` reading from the same `flagCore` state.
8. Run `npm run test:frontend` to verify sync.
9. Update `docs/flag_report.md` if doing a flag audit.

### Adding a New Chat Template Preset

1. Decide: `builtin` (maps to upstream template name), `bundled` (new
   `.jinja` file), or `auto`/`auto_alias`.
2. Add one entry to `CHAT_TEMPLATE_PRESETS` in `ui/js/flags.js`.
3. If bundled, add the `.jinja` file under `ui/templates/`.
4. `CHAT_TEMPLATE_PRESET_OPTIONS` populates the dropdown automatically.
5. Verify the preset appears in both Configure and Quick Launch.
6. Verify `--chat-template` (builtin) or `--chat-template-file` (bundled)
   appears in command preview but not both.
7. Verify reverse mapping works (builtin name or file path -> dropdown
   preset).
8. Run `npm run test:frontend`.

### Adding a New Quick Launch Profile

1. Add an entry to `QUICK_PROFILES` in `app.js`.
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
| Flag definitions | `ui/js/flags.js` | `ui/js/flag-validation.js` |
| Shared flag state | `ui/js/flag-core.js` | `ui/js/app.js` (callbacks) |
| Launch args / command preview | `ui/js/flag-core.js` | `ui/js/app.js` (render) |
| Configure tab rendering | `ui/js/config-flags-ui.js` | `ui/js/flag-core.js` (state) |
| Quick Launch controls | `ui/js/app.js` | `ui/js/flag-core.js` (state) |
| Chat sidebar samplers | `ui/js/app.js` | `ui/js/flag-core.js` (state) |
| Chat markdown/rendering helpers | `ui/js/chat-rendering.js` | `ui/js/app.js` (chat state/controller) |
| API tab docs/snippets | `ui/js/api-tab.js` | `ui/js/app.js` (status/init), `ui/js/flag-core.js` (state reads) |
| HF download UI | `ui/js/hf-download-ui.js` | `ui/js/app.js` (callbacks), `ui/js/manager.js` (fetchJson) |
| Remote tunnel UI | `ui/js/remote-tunnel-ui.js` | `ui/js/app.js` (init), `ui/js/api-tab.js` (endpoint config), `ui/js/manager.js` (fetchJson) |
| Chat template presets | `ui/js/flags.js` | `ui/js/app.js` (mapping helpers) |
| Sampler presets | `ui/js/app.js` | `ui/js/flag-core.js` (apply) |
| Preset save/load/import/export | `ui/js/presets.js` | `ui/js/flag-core.js` (collect/apply) |
| Install/update UI | `ui/js/manager.js` | — |
| Backend routes | `backend/routes/*.py` | `backend/services/*.py` |
| Backend state/locks | `backend/state.py` | `backend/context.py` |
| Backend HTTP/CORS | `backend/http.py` | `backend/app.py` |
| Chat templates | `ui/templates/*.jinja` | `ui/js/flags.js` (preset defs) |
| Frontend tests | `tests/frontend/*.cjs` | — |
| Backend tests | `tests/backend/*.py` | — |

## Script Loading Order

The frontend loads scripts in a strict dependency order via `ui/index.html`:

1. `ui/js/flags/*.js` — ordered pure data modules for categories, options, chat templates, definitions, and helpers
2. `flag-validation.js` — read-only validation of flag definitions
3. `flag-core.js` — shared state singleton (`window.LlamaGui.flagCore`)
4. `config-flags-ui.js` — Configure tab rendering
5. `manager.js` — GitHub releases, install, update, shared `fetchJson()`
6. `presets.js` — preset CRUD
7. `app-data.js` — shared Quick Launch, context, sampler, and chat slider data
8. `chat-rendering.js` — markdown and low-level chat DOM rendering helpers (`window.LlamaGui.chatRendering`)
9. `api-tab.js` — API endpoint/snippet rendering helpers (`window.LlamaGui.apiTab`)
10. `hf-download-ui.js` — Quick Launch Hugging Face downloader UI (`window.LlamaGui.hfDownloadUi`)
11. `remote-tunnel-ui.js` — API tab Cloudflare tunnel UI (`window.LlamaGui.remoteTunnelUi`)
12. `app.js` — main orchestration (wires everything together)

**Do not change this order.** Each file depends on the ones above it. If you
add a new module, place it after its dependencies and before its consumers.

`flag-core.js` exposes its API via `window.LlamaGui.flagCore`. Other modules
access shared state through this namespace, not by importing or referencing
private closure variables.

## Error Handling Expectations

### Frontend
- `fetchJson()` (manager.js) returns `null` for non-JSON 200 responses.
  Callers must handle `null` gracefully.
- Polling functions (`pollStats`, `pollOutput`) may fail silently when the
  server is not ready. This is expected. Do not add user-visible errors for
  polling failures during startup.
- `saveSamplerPresetStore()` has no error handling. If you change it, add a
  try/catch for `QuotaExceededError`.
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

## How the program works

### Companion Repositories
- **Pinokio launcher:** `https://github.com/thomas9120/llama-gui-pinokio`
- The Pinokio launcher clones this repo into its `app/` directory, installs `requirements.txt`, starts `python server.py`, and may apply launcher-specific patches.
- For large changes to startup/shutdown behavior, `server.py`, backend lifecycle routes, static asset loading, dependency installation, ports, cache busting, or frontend script loading, check the Pinokio launcher for compatibility.
- Frontend-only internal refactors, such as changes inside `ui/js/flag-core.js` or `ui/js/config-flags-ui.js`, are usually compatible as long as `ui/index.html` script loading and the `python server.py` entrypoint still work.

### Architecture
- A static web UI served by a Python `http.server` backend on `127.0.0.1:5240` by default; `LLAMA_GUI_HOST` and `LLAMA_GUI_PORT` can override the bind address for headless/LAN access.
- The backend handles `llama.cpp` installation, process management, API proxying, model downloading, remote tunnels, and web search.
- `llama-server` runs separately (default port 8080) as a subprocess.
- `config.json` persists application state (installed version, active backend, tag).
- Dependencies: `certifi` (SSL cert bundle), `ddgs` (DuckDuckGo web search), `huggingface_hub` (HF model downloads).
- All stateful operations (process, download, tunnel) use threading locks for thread safety.

### Backend (`server.py`)
- Manages downloading `llama.cpp` releases from GitHub with SHA256 verification.
- Runs `llama-server` or `llama-cli` as a subprocess and streams stdout/stderr.
- Handles preset, model file, and Hugging Face download APIs.
- Selects binary based on platform (`win32`/`darwin`/`linux`) and backend type (e.g., `cuda-12.4`, `cuda-13.1`, `vulkan`, `hip`, `sycl`, `openvino`, `metal`, `metal-kleidiai`).
- Proxies OpenAI-compatible chat completions (`/v1/chat/completions`) to `llama-server` with streaming SSE support.
- Built-in web search via DuckDuckGo (`ddgs` + page fetching with HTML-to-text parsing).
- Cloudflare tunnel management (auto-downloads `cloudflared`, starts/stops tunnel, returns public URL).
- Git-based app auto-updating (checks status, pulls, reinstalls dependencies, restarts server).
- Native file picker (tkinter) for selecting model files and paths.
- CORS origin validation restricts API access to loopback origins for the configured GUI port, trusted `LLAMA_GUI_ALLOWED_HOSTS` entries when wildcard-bound, and the active tunnel URL.
- Graceful shutdown/restart with port availability polling.

### Frontend
- **`ui/index.html`**: HTML template defining the tabbed layout and UI structure.
- **`ui/js/app.js`**: Main UI orchestration. Manages tab switching, server launch/stop, output polling, stats polling, chat state/controller (streaming, web search, conversation history), Quick Launch profiles/sampler presets, toasts, and cache-busting reload.
- **`ui/js/chat-rendering.js`**: Markdown and low-level chat DOM rendering helpers exposed as `window.LlamaGui.chatRendering`.
- **`ui/js/api-tab.js`**: API tab endpoint/snippet data, base URL helpers, and rendering exposed as `window.LlamaGui.apiTab`; reads shared state through injected `flagCore`.
- **`ui/js/hf-download-ui.js`**: Quick Launch Hugging Face downloader controls, status rendering, progress polling, cancel handling, and completion flow exposed as `window.LlamaGui.hfDownloadUi`; receives shared utilities and `flagCore` from `app.js`.
- **`ui/js/remote-tunnel-ui.js`**: API tab Cloudflare tunnel controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling exposed as `window.LlamaGui.remoteTunnelUi`; receives shared utilities and endpoint helpers from `app.js`.
- **`ui/js/flags.js`**: Single source of truth for exposed `llama.cpp` flags, flag categories, data types, built-in chat templates, chat template presets, sampler presets, and quick launch profiles.
- **`ui/js/flag-core.js`**: Shared frontend flag state and launch-argument core. Owns `currentTool`, selected model, `flagValues`, shared setters, custom launch args parsing, preset apply/collect helpers, `getLaunchArgs()`, and command preview generation.
- **`ui/js/config-flags-ui.js`**: Configure tab flag rendering, search/filtering, expand/collapse state, type-specific flag input builders, input restoration, and high-risk `multi_enum` warnings.
- **`ui/js/flag-validation.js`**: Non-blocking startup validation for `flags.js` definitions (duplicate ids, invalid categories/tools/types, enum options, default value shape, duplicate CLI flags).
- **`ui/js/manager.js`**: Handles GitHub release fetching, backend selection, installation progress UI, app update (git status/pull/restart), and the shared `fetchJson()` utility.
- **`ui/js/presets.js`**: Manages preset normalization, validation, saving, loading, updating, deleting, exporting, importing, and group-by-model rendering with search and collapsible groups.
- **`ui/css/style.css`**: Stylesheet implementing the dark theme (Tokyo Night) and responsive layout.
- **`ui/templates/`**: Bundled Jinja chat template files for Kohold-style presets.

### Tabs
1. **Install**: Download and install `llama.cpp` releases, select backend, update app from git.
2. **Quick Launch**: One-click model launch with preset configuration, quick profiles, integrated HF model downloader.
3. **Configure**: Full CLI flag configuration for `llama-server`/`llama-cli` with search, submenus, beginner tips, command preview, and Custom Launch Args.
4. **Chat**: Streaming OpenAI-compatible chat interface with web search, conversation history, sampler sliders.
5. **API**: View and interact with the `llama.cpp` API endpoints, start/stop Cloudflare tunnel.
6. **Presets**: Save, load, import, export, and manage preset configurations grouped by model.

### Data Flow
- Launch-relevant UI changes route through `window.LlamaGui.flagCore` shared setters (`setFlagValue`/`setMultipleFlagValues`) to update state.
- All mirrored controls read from the same underlying `flagCore` state object (`flagValues`, selected model, and current tool).
- Configure flag rendering lives in `window.LlamaGui.configFlagsUi`, but rendered controls still read from `flagCore` and write through the shared setter path.
- Configure's Custom Launch Args textarea stores its raw value in shared `flagCore.flagValues.custom_args` through `setFlagValue("custom_args", ...)`.
- Command preview and launch args are generated from shared state (`flagCore.getLaunchArgs()`), never per-tab copies.
- Custom launch args are parsed and appended only by `flagCore.getLaunchArgs()`, after UI-managed flags and before the selected model arg.
- Server output is polled via HTTP endpoint and streamed to the terminal panel.
- Chat completions are streamed via SSE from `/api/chat/completions` (backend proxies to `llama-server`).
- Stats are polled from `llama-server`'s Prometheus `/metrics` endpoint.
- Remote tunnel status is polled from `/api/remote-tunnel/status`.
- Model download progress is polled from `/api/hf/download-status`.
- After app update, the page reloads with a cache-busting `appReload` timestamp parameter.

## llama.cpp Compatibility

### Flag Reference
- `ui/js/flags.js` is the single source of truth for all CLI flags exposed in the UI.
- Before adding, removing, or modifying any flag definition, verify the flag still exists and works as documented in the upstream `llama.cpp` repository.

### Checking for Updates
1. Check the official repository at `https://github.com/ggerganov/llama.cpp` for flag changes.
2. Review the `llama-server --help` output or the `examples/server/README.md` in the repo for the current flag list, descriptions, and default values.
3. Cross-reference every flag in `ui/js/flags.js` against the upstream documentation:
   - Flag name and shorthand (e.g., `--ctx-size` vs `-c`)
   - Expected value type (integer, string, boolean, enum, multi_enum)
   - Valid option values for enum-type flags
   - Default values
   - Whether the flag has been renamed, deprecated, or removed
4. If a flag has changed upstream, update `flags.js` to match the new behavior before merging.

### Compatibility Verification
- After any flag-related changes, confirm the generated command preview produces valid arguments that `llama-server` will accept.
- Test that toggling a flag in the UI produces the correct argument in the final launch command.
- Verify that enum dropdowns only contain values still recognized by the current `llama.cpp` version.
- Check that chat template names in `flags.js` match templates bundled with the installed `llama.cpp` release.
- Run `tests/frontend/flag_sync_smoke.cjs` after mirrored-control, flag-state, or command-preview changes when Playwright is available.

## Flag Types

The UI supports these flag types in `flags.js`:
- `bool`: Checkbox. Supports `false_flag` for negation (e.g., `--no-mmap`).
- `int`: Numeric input with min/max/step constraints.
- `float`: Decimal input with min/max/step constraints.
- `text`: Free-form text input.
- `path`: Text input with native file picker "Browse" button (tkinter).
- `enum`: Dropdown select from a predefined options list.
- `multi_enum`: Multiple checkboxes for selecting zero or more values. Supports an `all` shortcut and `risk: "high"` badges with warnings for dangerous options (e.g., shell command execution).

Categories can also define `submenu` entries that render as collapsible sub-accordions within the main category.

## Chat Template Preset Notes

### Current Approach

Llama GUI now treats the template dropdown as a curated preset list rather than a raw dump of every `llama.cpp` built-in template name.

The current preset list is aligned to the user-facing `Instruct Tag Preset` names from Kobold Lite, while still keeping:
- `Auto (from model)`
- the manual `Custom Template File` field

This trims the dropdown without removing low-level backward compatibility for older saved presets that may still reference hidden built-in `llama.cpp` template names directly.

### Shared Source Of Truth

The named dropdown presets now live in `ui/js/flags.js`:
- `CHAT_TEMPLATE_PRESETS`
- `CHAT_TEMPLATE_PRESET_OPTIONS`

Each preset entry has:
- `value`
- `label`
- `mode`
- and, when needed, either:
  - `builtin`
  - or `path`

Modes:
- `auto`: clears both `chat_template` and `chat_template_custom`
- `auto_alias`: also clears both, but exists as a named dropdown preset
- `builtin`: maps the preset to a real `llama.cpp` built-in template name
- `bundled`: maps the preset to an app-owned Jinja file under `ui/templates/`

Quick Launch does not maintain its own template list. It clones the shared options source from the `chat_template` flag, which keeps Configure and Quick Launch linked.

### State Mapping

Template dropdown mapping helpers live in `ui/js/app.js`, while launch-relevant template values are stored in `window.LlamaGui.flagCore`.

Important helpers:
- `getChatTemplatePresetByValue(...)`
- `getChatTemplatePresetByBuiltinName(...)`
- `getChatTemplatePresetByPath(...)`
- `getSelectedChatTemplateDropdownValue()`
- `getQuickTemplateSummaryText()`
- `setChatTemplateValue(...)`

Behavior:
- built-in preset:
  - sets `chat_template`
  - clears `chat_template_custom`
- bundled preset:
  - clears `chat_template`
  - sets `chat_template_custom` to a bundled file path
- `Auto (from model)`:
  - clears both
- manual custom file:
  - clears `chat_template`
  - keeps the path in `chat_template_custom`
  - only shows a named preset if the chosen path exactly matches one of the bundled preset files

This keeps Configure and Quick Launch synchronized while still ensuring launch args are generated from `flagCore` launch-relevant state only.

### Bundled Templates

Bundled template files live under `ui/templates/`.

They are used for Kobold-style presets that are:
- non-thinking variants
- renamed presets that do not map cleanly to a single built-in `llama.cpp` template
- special tag formats not represented directly by current built-ins

Current bundled files include:
- `alpaca.jinja`
- `chatml-nonthinking.jinja`
- `deepseek-v31-nonthinking.jinja`
- `gemma4.jinja`
- `gemma4-e2b-e4b.jinja`
- `gemma4-e2b-e4b-nothink.jinja`
- `gemma4-26b-31b.jinja`
- `gemma4-26b-31b-nothink.jinja`
- `glm45-nonthinking.jinja`
- `glm47-nonthinking.jinja`
- `metharme.jinja`
- `mistral-non-tekken.jinja`
- `seed-oss-nonthinking.jinja`
- `openai-harmony-nonthinking.jinja`

These use a small generic Jinja message loop with preset-specific start/end tokens.

### Built-In Mappings

Some Kobold Lite preset names are intentionally mapped to existing `llama.cpp` built-ins rather than bundled files.

Current examples:
- `ChatML` -> `chatml`
- `CommandR` -> `command-r`
- `Gemma 2 & 3` -> `gemma`
- `GLM-4 & 4.5` -> `chatglm4`
- `Granite 4` -> `granite`
- `Kimi ChatML` -> `kimi-k2`
- `Llama 2 Chat` -> `llama2`
- `Llama 3 Chat` -> `llama3`
- `Llama 4 Chat` -> `llama4`
- `Mistral Tekken` -> `mistral-v3-tekken`
- `Phi-3 Mini` -> `phi3`
- `Seed OSS` -> `seed_oss`
- `Vicuna` -> `vicuna`
- `OpenAI Harmony` -> `gpt-oss`

This keeps the user-facing list small while still using `llama.cpp`'s native template support when that is close enough.

### KoboldCppAutomatic

`KoboldCppAutomatic` is handled as a named preset that behaves like an auto/template-from-model selection.

It exists as a selectable label in the dropdown, but its launch behavior is still:
- no `--chat-template`
- no `--chat-template-file`

Because it resolves to the same launch-state shape as `Auto`, it is primarily a UI-facing alias rather than a distinct launch-format implementation.

### Backward Compatibility

The hidden compatibility layer is intentional:
- the dropdown is curated
- the old built-in allowlist is still present for launch/preset compatibility

That means:
- older saved presets using previously exposed built-in names can still launch
- but the main dropdown is no longer cluttered with all of those legacy options

### Reuse Pattern For Future Templates

When adding another Kobold-style or model-specific preset later:

1. Decide whether it should be:
   - `builtin`
   - `bundled`
   - or `auto`/`auto_alias`
2. Add one entry to `CHAT_TEMPLATE_PRESETS`
3. If bundled, add the Jinja file under `ui/templates/`
4. Let `CHAT_TEMPLATE_PRESET_OPTIONS` populate the dropdown automatically
5. Verify reverse mapping:
   - builtin name -> dropdown preset
   - bundled file path -> dropdown preset
6. Verify both Configure and Quick Launch update immediately

### Validation Checklist

For any new preset:
- confirm it appears in Configure and Quick Launch
- confirm both tabs stay linked
- confirm built-in presets use `--chat-template`
- confirm bundled presets use `--chat-template-file`
- confirm manual custom files clear named preset selection unless they match a bundled preset path

## Quick Launch Tab

The Quick Launch tab (`section-quick-launch`) provides a simplified launch interface for quick model testing.

### Profiles

`QUICK_PROFILES` in `app.js` provides preconfigured setups:
- `safe-defaults` / `balanced`: 16K context, auto GPU, auto-fit, Balanced sampler preset
- `low-memory`: 8K context, smaller batch sizes, Precise sampler preset
- `long-context`: 32K context, auto-fit
- `creative-chat`: 16K context, Creative sampler preset

Each profile applies a tool setting, flag values, fit linking, and sampler preset in one action.

### Controls

Quick Launch renders simplified controls for:
- Model selection (synced with Configure's model dropdown)
- Tool mode toggle (llama-server / llama-cli)
- Context size (preset dropdown + custom input, linked to fit_ctx by default)
- GPU layers (auto/0/all/custom, synced with Configure)
- Auto Fit toggle + fit target/context inputs
- Chat template (reuses shared `chat_template` options from flags.js)
- Sampler preset selection (load/save/delete from shared sampler preset store)
- Quick sampler fields (temperature, top-k, top-p, min-p, repeat-penalty)
- Metrics toggle
- Profile selector with summary text

All controls write through `window.LlamaGui.flagCore` setters (`setFlagValue()` / `setMultipleFlagValues()`), keeping Configure and Quick Launch in sync.

### Hugging Face Download Integration

The Quick Launch tab includes a full HF model downloader section:
- Repo ID + revision + token inputs
- "Find Files" button fetches GGUF file listing from `/api/hf/repo-files`
- Model and mmproj file selectors
- Download progress bar with cancel support
- Auto-selects downloaded model on completion

Frontend downloader controls, status rendering, progress polling, cancel handling, and completion flow live in `ui/js/hf-download-ui.js`. `app.js` injects `fetchJson`, confirmation/model callbacks, and `flagCore`; the module must not mutate `flagValues` directly.

## Chat Tab

The Chat tab (`section-chat`) is a streaming OpenAI-compatible chat interface that proxies through the Python backend.

### Architecture

The backend proxies `/api/chat/completions` to `llama-server`'s `/v1/chat/completions` endpoint:
1. Frontend sends POST with messages, sampler params, and optional web_search flag.
2. Backend optionally performs web search via DuckDuckGo, fetches result pages, injects context into the system prompt.
3. Backend proxies the request to `llama-server` and streams the SSE response back to the frontend.
4. Frontend renders markdown and tracks source citations.

### Web Search

When the web search toggle is enabled:
- The backend extracts the latest user message and queries DuckDuckGo.
- The Chat sidebar's "Result Count" setting controls both how many search results are requested and how many result pages are read for full text.
- Result Count defaults to 5, is persisted in `localStorage` under `llama_gui_chat_web_search_max_results`, and is clamped to 1-10 by both frontend UI constraints and the backend chat route.
- Search context is injected into the system prompt with source citations.
- Sources are rendered as clickable chips below the assistant's response.
- Web search status messages (e.g., "Searching: ...", "Reading: ...") are streamed during processing.

### Conversation History

- Conversations are stored in `localStorage` under `llama_gui_conversations`.
- Each conversation has an id, title (derived from first user message), messages array, system prompt, and timestamp.
- Sidebar shows recent conversations with preview text and relative timestamps.
- Features: new chat, undo last message, regenerate last response, delete individual/all conversations, collapse sidebar.

### Markdown Rendering

`renderMarkdown()` in `ui/js/chat-rendering.js` converts chat output to HTML:
- Fenced code blocks (``` ... ```) with optional language attribute
- Inline code (`...`)
- Bold (**...**, __...__)
- Italic (*...*, _..._)
- Strikethrough (~~...~~)
- Paragraphs, line breaks

### Sampler Sliders

Chat sidebar has sliders for temperature, top-p, top-k, min-p, repeat-penalty, and max-tokens. Changes write through `window.LlamaGui.flagCore.setFlagValue()` and sync with Configure/Quick Launch.

## Hugging Face Model Downloader

Integrated model downloading from Hugging Face Hub.

### Backend API

- `POST /api/hf/repo-files`: Takes `repo_id`, `revision`, `token`. Uses `huggingface_hub.HfApi.model_info()` to list GGUF files. Returns separated model and mmproj file lists.
- `POST /api/hf/download`: Takes `repo_id`, `revision`, `model_file`, `mmproj_file`, `token`, `overwrite`. Downloads in a background thread with cancellation support. Validates filenames and repo IDs.
- `GET /api/hf/download-status`: Returns current download progress (total, downloaded, status, current_file, model_name, model_path, mmproj_path).
- `POST /api/hf/download-cancel`: Sets cancellation event to abort in-progress download.

### Frontend Flow

1. User enters a HF repo ID (e.g., `ggml-org/gemma-3-1b-it-GGUF`).
2. "Find Files" fetches available GGUF files.
3. User selects a model file and optional mmproj file.
4. "Download" starts the download with progress bar.
5. On completion, the model is auto-selected in the model dropdown and command preview updates.

### Safety

- Repo IDs, revisions, and filenames are validated with strict regex and path traversal checks.
- Only `.gguf` files can be downloaded.
- mmproj files must contain `mmproj`, `clip`, or `projector` in the stem.
- Duplicate downloads detect existing files and prompt for overwrite confirmation.
- Partial downloads are cleaned up on error/cancellation.

## Remote Tunnel (Cloudflare)

The API tab includes Cloudflare tunnel integration for exposing `llama-server` to the internet.

### Backend

- `cloudflared` binary is auto-downloaded on first use to `tools/cloudflared/`.
- Platform-specific assets: Windows `.exe`, macOS `.tgz`, Linux binary.
- Tunnel process runs `cloudflared tunnel --url` against the configured GUI port, using loopback when the GUI is wildcard-bound.
- Status polling detects the `trycloudflare.com` URL from stderr.
- Thread-safe state management with start/stop lifecycle.
- CORS origin is updated to include the active tunnel URL.

### Frontend

Frontend tunnel controls, status rendering, URL rendering, copy wiring, start/stop actions, and polling live in `ui/js/remote-tunnel-ui.js`. `app.js` injects `fetchJson`, `copyText`, and `getServerEndpointConfig`.

- Start/stop buttons with disabled states during transitions.
- Polls tunnel status every 2 seconds while running/starting.
- Displays tunnel URL as a clickable link with copy button.
- Status badge with running/working/error styling.
- Tunnel URL is added to allowed CORS origins for API requests.

## Auto-Update System

The Install tab includes git-based app updating.

### How It Works

1. `GET /api/app-update-status` (with `fetch=true`) runs `git fetch --prune origin`, then checks `git rev-list --left-right --count HEAD...origin/<branch>`.
2. Dirty git paths are classified as "safe" (ignored directories like `llama/`, `models/`, `presets/`, cache dirs, file suffixes like `.pyc`, `.log`, `.tmp`) or "blocking" (source file changes).
3. If the local branch is behind origin and has no blocking changes, auto-update is available.
4. `POST /api/app-update` runs `git pull --ff-only`, then reinstalls `requirements.txt` via pip.
5. After success, the server restarts and the frontend reloads with cache busting.
6. CORS-safe request origin validation applies to update endpoints.

### Dependency Installation

`install_python_dependencies()` runs `pip install -r requirements.txt` and reports success/failure. Called after git pull and exposed as `POST /api/install-deps`.

### Safe Dirty Path Classification

Paths matching these patterns are considered "safe" (not blocking updates):
- Prefixes: `llama/`, `models/`, `presets/`, `releases/`, `__pycache__/`, `.ruff_cache/`, `.pytest_cache/`, `.mypy_cache/`, `.venv/`, `venv/`, `env/`, `logs/`, `tmp/`, `temp/`
- Exact names: `config.json`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.env*`
- Suffixes: `.pyc`, `.pyo`, `.log`, `.tmp`, `.temp`, `.bak`, `.orig`, `.swp`, `.swo`, `.zip`, `.tar.gz`, `.tgz`

## Sampler Presets

Sampler presets allow saving and loading groups of sampling flags.

### Built-In Presets

Defined in `BUILTIN_SAMPLER_PRESETS` in `app.js`:
- **Neutral**: KoboldCpp-style neutral baseline with temperature=1.0, top_k=200, top_p=1.0, min_p=0, repeat_penalty=1.0, repeat_last_n=360
- **Balanced**: KoboldCpp `Simple Balanced` style with temperature=0.75, top_k=100, top_p=0.92, min_p=0, repeat_penalty=1.05, repeat_last_n=360
- **Creative**: KoboldCpp `Simple Creative` style with temperature=1.0, top_k=100, top_p=0.98, min_p=0, repeat_penalty=1.1, repeat_last_n=360
- **Precise**: Repurposed toward KoboldCpp `Simple Logical` behavior with temperature=0.3, top_k=25, top_p=0.6, min_p=0, repeat_penalty=1.02, repeat_last_n=360

### Custom Presets

- Stored in `localStorage` under `llama_gui_sampler_presets_v1`.
- Saved from current sampler values with user-defined names.
- Unique name generation handles collisions (e.g., "Creative (2)").
- Load, save, delete, export (single JSON file), and import (single or batch JSON) operations.

### Integration

- Configure tab: Sampler Preset controls appear at the top of the Sampling accordion.
- Quick Launch tab: Sampler Preset controls in the sampler section.
- Quick profiles reference preset names (e.g., `samplerPresetName: "Balanced"`).
- Loading a preset calls `applySamplerPresetValues()` which writes through `window.LlamaGui.flagCore.setMultipleFlagValues()`.

## Server Stats & Metrics

Live performance metrics are polled from `llama-server`'s Prometheus endpoint.

### How It Works

1. `startStatsPolling()` begins polling ~2 seconds after server launch.
2. Every 3 seconds, `pollStats()` fetches `/api/llama/metrics?host=...&port=...`.
3. The backend proxies to `llama-server`'s `/metrics` endpoint.
4. Metrics are parsed from Prometheus text format.

### Displayed Metrics

- **Prompt tokens**: Total tokens processed in prompts (delta since baseline)
- **Prompt speed**: Tokens per second during prompt ingestion
- **Generated tokens**: Total tokens generated (delta since baseline)
- **Generation speed**: Tokens per second during generation
- **Context usage**: Total prompt + generated tokens
- **KV cache usage**: Percentage of KV cache filled

The `snapshotStatsBaseline()` function resets the delta counter (called on conversation load and new chat).

Metrics host validation restricts proxying to local addresses only for security.

## MCP / Agent Tools

The Configure tab's "Server and MCP Settings" category includes an "MCP Settings" submenu with:
- **WebUI MCP Proxy**: Enables CORS proxy support for MCP requests in the Web UI.
- **Built-in Tools** (`multi_enum` type): Select from available agent tools exposed to the model:
  - `all`: Enable all tools (high risk)
  - `read_file`, `file_glob_search`, `grep_search`: Read-only tools
  - `exec_shell_command`: Execute shell commands (high risk)
  - `write_file`, `edit_file`, `apply_diff`: File modification tools (high risk)

When a high-risk tool is selected, a warning message appears: "High-risk tools selected. Only enable on trusted/local environments."

## Reasoning / Thinking Support

Flags for reasoning/thinking models:
- `-rea` (enum: auto/on/off): Enable or disable reasoning/thinking mode.
- `--reasoning-budget` (int): Token budget for thinking (-1 = unlimited, 0 = off).
- `--chat-template-kwargs` (bool, flag: `preserve_thinking`): When enabled, passes `{"preserve_thinking":true}` to the chat template engine. Required for models like Qwen3, DeepSeek-R1 to show chain-of-thought output.

If `preserve_thinking` is true and the flag passes the inert-default filter, the launch arg is `--chat-template-kwargs {"preserve_thinking":true}`.

## Custom Launch Args

The Configure tab includes an advanced `Custom Launch Args` textarea near the command preview.

Behavior:
- The raw value is stored in shared launch state as `custom_args`; do not keep a separate per-tab copy.
- `flagCore.parseCustomLaunchArgs()` tokenizes shell-like input with whitespace splitting, single/double quotes, escaped whitespace, escaped quotes, and escaped backslashes.
- Ordinary backslashes before non-special characters are preserved so Windows paths such as `C:\temp\llama.log` remain intact.
- Parsed custom tokens are appended after UI-managed flags. If a custom token duplicates a known UI-managed flag, show a warning but still allow launch.
- Parser errors, such as unmatched quotes or unfinished double-quoted escapes, must show near the textarea, mark the command preview as blocked, and prevent `/api/launch`.
- Presets store the raw textarea value under `flags.custom_args` and should preserve it through save, update, load, import, and export.

Validation:
- Run `node tests/frontend/custom_launch_args_unit.cjs` after parser changes.
- Run `npm run test:frontend` after mirrored-control, custom-args, flag-state, or command-preview changes when Playwright is available.

## Configuration Search

The Configure tab has a search input that filters visible flags in real-time.

### Search Behavior

- Searches across: flag name (`--flag`), label, id, description, short description, beginner tip, submenu name, and all option labels/values.
- When a search query is active, all accordion categories automatically expand to show matching flags.
- Partial matches are highlighted; unmatched flags within a category are hidden.
- Empty results show "No configuration options match your search."
- Escape key or clear button resets the search and collapses all categories.

### Expand/Collapse

- "Expand All" opens all categories and submenus.
- "Collapse All" closes all categories and submenus.
- Individual categories remember their open/closed state via `openCategories` Set.
- Individual submenus remember their state via `openSubmenus` Set.

## Frontend Smoke Tests

`tests/frontend/flag_sync_smoke.cjs` serves the static `ui/` directory, stubs backend API calls with Playwright routes, and verifies the shared-state contract:
- Quick Launch context syncs to Configure and command preview.
- Configure GPU and metrics controls sync back to Quick Launch.
- Chat temperature accepts two-decimal values such as `0.31`.
- Quick Launch sampler edits sync to Chat, Configure, shared flag state, and launch args.
- Custom Launch Args update shared state, command preview, launch args, and launch blocking on parser errors.

When running local browser smoke checks manually, serve `ui/` as the web root. Serving from the repo root will break root-relative assets such as `/js/app.js`.

Playwright is a dev/CI-only Node dependency:
- Use `npm ci`, `npx playwright install chromium`, and `npm run test:frontend` for frontend smoke checks.
- Do not add Playwright to `requirements.txt`, launch scripts, Pinokio setup, or app update dependency installation.
- Normal runtime installs should remain Python-only through `pip install -r requirements.txt`.

## Local Search Notes

Prefer `rg` for local search. On this Windows/PowerShell environment, use patterns like `rg -n "pattern" ui/js` or `rg -n -g "*.js" "pattern" ui/js`; avoid path globs like `rg "pattern" ui/js/*.js` because they can produce `os error 123`.

## Native File Picker

Path-type flags (model, mmproj, draft model, etc.) have a "Browse" button that opens a native OS file dialog via tkinter.

### Backend

`POST /api/select-file` accepts:
- `purpose`: Determines initial directory and file type filters.
- `title`: Dialog window title.

Returns `{"selected": bool, "path": string}`.

### File Type Filters

- Model files (purpose: model, model_draft, mmproj, model_vocoder): `*.gguf`, `*.bin`
- Other paths (grammar file, log file, etc.): `*.*`
