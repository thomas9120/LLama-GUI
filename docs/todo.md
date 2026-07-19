# TODO

## Code Review Polish (2026-07 backend review)

Low-severity findings from a full-codebase review. None are blockers; pick up opportunistically.

- **`web_search` (`ddgs`) is not SSRF-pinned like `fetch_page_text`.** `DDGS().text()` in `backend/services/web_search.py` uses the library's own networking, bypassing the IP-pinning/private-range blocking that `fetch_page_text` enforces. Impact is limited (fixed DuckDuckGo endpoints, not user-controlled hosts), but the asymmetry is worth closing if the library ever allows custom endpoints or proxies.
- **`parse_memory_estimate_output` requires exactly 4 whitespace-split columns.** In `backend/services/process_manager.py`, a device name containing a space, or a new column added by a future llama.cpp version, silently drops the row and the estimate reports "output was not recognized." Fails safe, but brittle against upstream output changes.
- **Confirm `.env` prefix match in auto-update safe-dirty list is intended.** `is_safe_dirty_path` in `backend/services/git_update.py` treats any path starting with `.env` as safe (so it won't block `git pull --ff-only`). That also matches e.g. `.environment_notes.md`. If only `.env` / `.env.*` files are meant, tighten the match.
- **`install_in_progress` stays set across a synchronous network call.** In `backend/routes/install.py` `start_update`, the flag is set before a blocking GitHub `get_releases()` call runs on the request thread. A slow/hung GitHub response leaves the UI showing an install in progress with no worker thread started. Consider moving the release lookup into the worker.

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
