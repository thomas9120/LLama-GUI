# TODO

## Reasoning Content Follow-Up

Plain `--reasoning-format deepseek` is intentionally not exposed yet. It returns
thinking text through separated `reasoning_content` fields, and the Chat tab
currently renders streamed `delta.content` only.

Acceptance criteria:
- Update the Chat tab stream handling to render `delta.reasoning_content`.
- Add `deepseek` to the `Reasoning Output Format` dropdown after the stream UI
  can display separated reasoning content clearly.
- Run `node --check ui/js/chat-ui.js` and `npm run test:frontend`.

## DeepSeek V4 Follow-Ups

PR `ggml-org/llama.cpp#24162` landed in `b9840` and adds DeepSeek V4 runtime/conversion support plus an upstream conversion-time template at `models/templates/deepseek-ai-DeepSeek-V4.jinja`.

- Consider adding a bundled `DeepSeek V4` chat template preset as a fallback for GGUFs that do not carry the converted template metadata.
- Keep Auto/template-from-model as the recommended default; `b9840` does not advertise `deepseek4` as a built-in `--chat-template` value.
- If adding the bundled preset, copy the upstream Jinja template intentionally, add it under `ui/templates/`, register it in `CHAT_TEMPLATE_PRESETS`, and verify Configure/Quick Launch template sync.

Acceptance criteria:
- Confirm the current installed `llama-server --help` still does not list `deepseek4` before deciding between bundled and built-in preset modes.
- Verify `--chat-template-file ui/templates/<deepseek-v4>.jinja` appears in command preview when the preset is selected.
- Run `node --check ui/js/flags/chat-templates.js` and `npm run test:frontend`.

## Cross-Platform Preset Shortcuts

Follow up on extending preset shortcut export beyond the current Windows `.cmd` flow.

- Linux: add `.desktop` launcher export. This should start `server.py` if needed, open `http://127.0.0.1:5240/?preset=<name>`, and use an absolute icon path when available. If the backend writes directly to the Desktop later, mark the file executable with `chmod +x`; browser-downloaded `.desktop` files may still require the user to trust/allow launch depending on desktop environment.
- macOS: add `.command` export first. It can reuse the existing mac/Linux shell launcher logic and open the preset URL with `open`. Custom icons are not reliable for this simple format.
- Optional macOS polish: investigate a generated `.app` bundle with `Info.plist` and an `.icns` icon. This is more work than `.command` but would feel native.
- Keep all formats loading the preset only. They should start Llama GUI's Python server and open the web UI, but must not launch `llama.cpp`.
- Reuse the existing `/?preset=<name>` deep-link behavior so shared flag state, command preview, Configure, and Quick Launch remain synchronized.
