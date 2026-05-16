# TODO

## Custom Launch Args Input

Goal: add an advanced Configure-tab input where users can enter raw llama.cpp flags that are not yet represented in `ui/js/flags.js`. These args should be appended to the generated launch arguments so Llama GUI can temporarily support new or renamed upstream flags without waiting for a full UI flag-definition update.

### Intended Behavior

- Add a `Custom Launch Args` textarea to the Configure tab near the command preview.
- Treat the value as shared launch state, not as a per-tab scratch field.
- Save and load the value with presets by storing it in the preset `flags` object under a reserved key such as `custom_args`.
- Include the value in preset import/export without requiring a new preset schema version.
- Update command preview immediately when the textarea changes.
- Include parsed custom args in `flagCore.getLaunchArgs()`.
- Show a clear warning that custom args may conflict with configured UI flags and should only be used when the user understands the llama.cpp option they are adding.

### Implementation Plan

1. Add shared state support in `ui/js/flag-core.js`.
   - Keep the raw textarea value in `flagValues.custom_args`.
   - Let existing `setFlagValue()`, `collectFlagValues()`, and `applyFlagValues()` handle it naturally.
   - Do not add `custom_args` to `FLAGS`, because it is not a real llama.cpp flag definition.

2. Add a parser for custom args.
   - Parse shell-like tokens instead of splitting on spaces.
   - Support quoted values so JSON-style args can work, for example:
     `--chat-template-kwargs '{"preserve_thinking":true}'`
   - Return a structured error for unmatched quotes or malformed escapes.
   - Keep the parser frontend-only unless backend launch handling later needs the same logic.

3. Append custom args during launch argument generation.
   - In `getLaunchArgs()`, generate normal known flags first.
   - Parse `flagValues.custom_args`.
   - If parsing fails, return the existing launch args plus an error message so command preview and launch can block safely.
   - Append parsed custom args after known UI-generated flags.
   - Keep model arg handling unchanged unless testing proves llama.cpp requires custom args after `-m`.

4. Render the Configure-tab control in `ui/js/config-flags-ui.js` or directly in `ui/index.html`.
   - Prefer a simple static textarea in `ui/index.html` near the command preview.
   - Wire its `input` event to `window.LlamaGui.flagCore.setFlagValue("custom_args", value || undefined)`.
   - Add a refresh path so loading presets updates the textarea.
   - Display parser errors close to the textarea and in command-preview status when possible.

5. Preserve existing preset behavior in `ui/js/presets.js`.
   - No schema change should be required because preset flags already preserve unknown keys.
   - Confirm save, update, load, import, and export keep `custom_args`.
   - If preset warnings are expanded later, consider warning when a preset includes custom args.

6. Add verification coverage.
   - Extend `tests/frontend/flag_sync_smoke.cjs` to enter custom args and confirm:
     - command preview includes the parsed args
     - `flagCore.getLaunchArgs().args` includes the parsed tokens
     - `flagCore.collectFlagValues().custom_args` preserves the raw text
     - loading/applying preset-shaped state restores the textarea
   - Add a parser-error smoke case for unmatched quotes.
   - Run `node --check` on touched frontend scripts.
   - Run the Playwright smoke test from the repo root with the existing `NODE_PATH` setup.

### Open Design Notes

- Default persistence: save custom args with presets.
- Recommended placement: Configure tab only, near command preview.
- Recommended append order: after known UI flags and before the model arg, unless runtime testing shows llama.cpp expects otherwise.
- Security posture: this should not execute shell commands by itself, but it can enable dangerous llama.cpp flags such as tool execution, so the UI should label it as advanced.
- Future cleanup: once a custom arg becomes common or stable upstream, move it into `ui/js/flags.js` as a normal typed control.
