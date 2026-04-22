# Chat Template Preset Notes

## Current Approach

Llama GUI now treats the template dropdown as a curated preset list rather than a raw dump of every `llama.cpp` built-in template name.

The current preset list is aligned to the user-facing `Instruct Tag Preset` names from Kobold Lite, while still keeping:
- `Auto (from model)`
- the manual `Custom Template File` field

This trims the dropdown without removing low-level backward compatibility for older saved presets that may still reference hidden built-in `llama.cpp` template names directly.

## Shared Source Of Truth

The named dropdown presets now live in [ui/js/flags.js](C:/Users/pegas/Downloads/LLM/Misc%20LLM%20Programs/Llama%20GUI%20-%20Copy/LLama-GUI/ui/js/flags.js):
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

## State Mapping

Shared selection/state logic is in [ui/js/app.js](C:/Users/pegas/Downloads/LLM/Misc%20LLM%20Programs/Llama%20GUI%20-%20Copy/LLama-GUI/ui/js/app.js).

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

This keeps Configure and Quick Launch synchronized while still ensuring launch args are generated from launch-relevant state only.

## Bundled Templates

Bundled template files live under [ui/templates](C:/Users/pegas/Downloads/LLM/Misc%20LLM%20Programs/Llama%20GUI%20-%20Copy/LLama-GUI/ui/templates).

They are used for Kobold-style presets that are:
- non-thinking variants
- renamed presets that do not map cleanly to a single built-in `llama.cpp` template
- special tag formats not represented directly by current built-ins

Current bundled files include:
- `alpaca.jinja`
- `chatml-nonthinking.jinja`
- `deepseek-v31-nonthinking.jinja`
- `gemma4.jinja`
- `gemma4-e2b-e4b-nothink.jinja`
- `gemma4-26b-31b-nothink.jinja`
- `glm45-nonthinking.jinja`
- `glm47-nonthinking.jinja`
- `metharme.jinja`
- `mistral-non-tekken.jinja`
- `seed-oss-nonthinking.jinja`
- `openai-harmony-nonthinking.jinja`

These use a small generic Jinja message loop with preset-specific start/end tokens.

## Built-In Mappings

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

This keeps the user-facing list small while still using `llama.cpp`’s native template support when that is close enough.

## KoboldCppAutomatic

`KoboldCppAutomatic` is handled as a named preset that behaves like an auto/template-from-model selection.

It exists as a selectable label in the dropdown, but its launch behavior is still:
- no `--chat-template`
- no `--chat-template-file`

Because it resolves to the same launch-state shape as `Auto`, it is primarily a UI-facing alias rather than a distinct launch-format implementation.

## Backward Compatibility

The hidden compatibility layer is intentional:
- the dropdown is curated
- the old built-in allowlist is still present for launch/preset compatibility

That means:
- older saved presets using previously exposed built-in names can still launch
- but the main dropdown is no longer cluttered with all of those legacy options

## Reuse Pattern For Future Templates

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

## Validation Checklist

For any new preset:
- confirm it appears in Configure and Quick Launch
- confirm both tabs stay linked
- confirm built-in presets use `--chat-template`
- confirm bundled presets use `--chat-template-file`
- confirm manual custom files clear named preset selection unless they match a bundled preset path
