# TODO

## llama.cpp Flag Candidates

Follow up on adding useful b9701-era `llama.cpp` flags to the curated Configure surface.

- `--op-offload`: GPU/accelerator host-operation offload toggle. Add as a GPU boolean with the upstream default represented safely.
- `--mmproj-url`: Multimodal projector URL. Add near the existing mmproj model path controls and keep HF downloader behavior unchanged.
- `--mtmd-batch-max-tokens`: Maximum image tokens per multimodal batch. Add under Context & Memory or Model after confirming current upstream defaults.
- `--sampler-seq` / `--sampling-seq`: Simplified sampler sequence. Decide how it should coexist with the existing advanced `--samplers` text field.
- Newer reasoning controls such as `--reasoning-format` and `--reasoning-budget-message`: add only after confirming how they interact with the existing reasoning mode and preserve-thinking controls.

Acceptance criteria:
- Verify each flag against the installed `llama-server --help` and `llama-cli --help`.
- Reuse existing shared flag state and option sources.
- Run `node --check ui/js/flags/definitions.js` and `npm run test:frontend`.

## Cross-Platform Preset Shortcuts

Follow up on extending preset shortcut export beyond the current Windows `.cmd` flow.

- Linux: add `.desktop` launcher export. This should start `server.py` if needed, open `http://127.0.0.1:5240/?preset=<name>`, and use an absolute icon path when available. If the backend writes directly to the Desktop later, mark the file executable with `chmod +x`; browser-downloaded `.desktop` files may still require the user to trust/allow launch depending on desktop environment.
- macOS: add `.command` export first. It can reuse the existing mac/Linux shell launcher logic and open the preset URL with `open`. Custom icons are not reliable for this simple format.
- Optional macOS polish: investigate a generated `.app` bundle with `Info.plist` and an `.icns` icon. This is more work than `.command` but would feel native.
- Keep all formats loading the preset only. They should start Llama GUI's Python server and open the web UI, but must not launch `llama.cpp`.
- Reuse the existing `/?preset=<name>` deep-link behavior so shared flag state, command preview, Configure, and Quick Launch remain synchronized.

