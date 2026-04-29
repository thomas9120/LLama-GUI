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

## How the program works

### Architecture
- A static web UI served by a Python `http.server` backend.
- The backend handles `llama.cpp` installation, process management, and API proxying.
- `config.json` persists application state (installed version, active backend, tag).

### Backend (`server.py`)
- Manages downloading `llama.cpp` releases from GitHub.
- Runs `llama-server` as a subprocess and streams stdout/stderr.
- Handles preset and model file APIs.
- Selects binary based on backend type (e.g., `cuda-12.4`, `cpu`).

### Frontend
- **`ui/index.html`**: HTML template defining the tabbed layout and UI structure.
- **`ui/js/app.js`**: Core frontend logic; manages tab switching, flag collection, server launch/stop, and output polling.
- **`ui/js/flags.js`**: Defines CLI flag categories, data types, and built-in chat templates.
- **`ui/js/manager.js`**: Handles GitHub release fetching, backend selection, and installation progress UI.
- **`ui/js/presets.js`**: Manages preset normalization, validation, saving, and applying to the UI.
- **`ui/css/style.css`**: Stylesheet implementing the dark theme (Tokyo Night) and responsive layout.

### Tabs
1. **Install**: Download and install `llama.cpp` releases, select backend.
2. **Quick Launch**: One-click model launch with preset configuration.
3. **Configure**: Full CLI flag configuration for `llama-server`.
4. **API**: View and interact with the `llama.cpp` API endpoints.
5. **Presets**: Save, load, and manage preset configurations.

### Data Flow
- UI changes route through a shared setter to update state.
- All mirrored controls read from the same underlying state object.
- Command preview and launch args are generated from shared state, never per-tab copies.
- Server output is polled via HTTP endpoint and streamed to the terminal panel.

## llama.cpp Compatibility

### Flag Reference
- `ui/js/flags.js` is the single source of truth for all CLI flags exposed in the UI.
- Before adding, removing, or modifying any flag definition, verify the flag still exists and works as documented in the upstream `llama.cpp` repository.

### Checking for Updates
1. Check the official repository at `https://github.com/ggerganov/llama.cpp` for flag changes.
2. Review the `llama-server --help` output or the `examples/server/README.md` in the repo for the current flag list, descriptions, and default values.
3. Cross-reference every flag in `ui/js/flags.js` against the upstream documentation:
   - Flag name and shorthand (e.g., `--ctx-size` vs `-c`)
   - Expected value type (integer, string, boolean, enum, etc.)
   - Valid option values for enum-type flags
   - Default values
   - Whether the flag has been renamed, deprecated, or removed
4. If a flag has changed upstream, update `flags.js` to match the new behavior before merging.

### Compatibility Verification
- After any flag-related changes, confirm the generated command preview produces valid arguments that `llama-server` will accept.
- Test that toggling a flag in the UI produces the correct argument in the final launch command.
- Verify that enum dropdowns only contain values still recognized by the current `llama.cpp` version.
- Check that chat template names in `flags.js` match templates bundled with the installed `llama.cpp` release.
