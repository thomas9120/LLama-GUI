# UX Improvement Suggestions

Suggestions for improving the user experience within the existing scope of configuring, launching, running, and serving llama.cpp with basic built-in chat.

---

## High Impact / Low Effort

### 1. "Server Ready" notification [DONE]
The UI has no clear signal when `llama-server` finishes loading. Users have to watch the terminal for `HTTP server listening`. A simple toast notification when that log line is detected would be a meaningful improvement — especially for users with large models that take time to load.

### 2. Quick Launch: stay on the tab after launching
Clicking "Launch" on the Quick Launch tab silently redirects to the Configure tab (where the output terminal lives). This is disorienting. Options:
- Add a small collapsible output panel to Quick Launch so users don't have to leave
- Or simply stop the forced tab switch, and let users navigate manually

### 3. Fix `deleteAllConversations` to use the custom modal [DONE]
Currently uses a bare `window.confirm()`, inconsistent with every other destructive action in the app which uses the custom `confirmAction()` modal.

### 4. Fix cache-busting for `flags.js` and `manager.js` [DONE]
Two of the seven scripts have no `?v=` cache-bust param. If either is updated, users may silently run stale cached versions without reloading.

### 5. API tab: dynamic API key awareness [DONE]
The client code snippets always show `YOUR_API_KEY` as a placeholder even when no `--api-key` is configured. The snippet should reflect actual configured auth state.

---

## High Impact / Medium Effort

### 6. Custom Launch Args textarea [DONE]
Already planned in `docs/todo.md`. A raw textarea that appends arbitrary flags to the generated command would cover all the flags not yet exposed in the UI — especially useful for newly added upstream features.

### 7. Improved Markdown rendering in Chat [DONE]
The custom renderer has no support for lists (`-`, `1.`), headings (`#`), tables, or blockquotes — all common in model outputs. This is a significant usability gap for the chat tab. Adding these to the existing renderer is straightforward.

### 8. "Server Ready" badge on Quick Launch
Related to #1 — show a visible server status indicator on the Quick Launch launch card (beyond just the command preview line). The stats bar at the bottom appears, but only if toggled on.

### 9. Port/Host accessible from Quick Launch
If port 8080 is already in use, the only way to change it is in Configure → Server and MCP Settings. First-time users will hit an error with no obvious fix on the Quick Launch tab. A simple port input in the launch card would help.

### 10. Max tokens slider range in Chat [DONE]
The chat sidebar's "Max Tokens" slider is hard-capped at 4096 in the HTML, but `n_predict` supports up to 131072. If a user sets a higher value in Configure, the chat slider won't reflect it. The range should at minimum be derived from the context size setting.

---

## Medium Impact / Medium Effort

### 11. Model metadata in the dropdown
Model selection currently shows `filename (X MB)`. Surfacing the quant type (Q4_K_M, Q8_0, etc.) parsed from the filename would be a minimal but useful improvement for model selection — users often choose based on quantization.

### 12. Conversation history size management
All conversation history is stored in `localStorage` with no limit. Long sessions can accumulate significant data. A simple max-conversation-count setting or automatic trimming of the oldest conversations would prevent silent storage failures.

### 13. Surface llama-server errors more prominently in Chat
If the server isn't running, the error currently appears inside the chat bubble itself. A more visible status indicator (not just the small badge) would make the "server is down" state clearer before users try to send a message.

### 14. Drag-and-drop model loading
Dropping a `.gguf` file onto the page is a natural shortcut, especially for users who keep models outside the `models/` directory. This would complement the existing file browser.

---

## Lower Impact / Nice to Have

### 15. Flag search text highlighting
`AGENTS.md` describes "partial matches are highlighted," but the code only filters visibility — it does not highlight matched text within flag descriptions. True highlighting would make search results more scannable.

### 16. "Last used settings" persistence
There is no record of what launch arguments were used in previous sessions (only presets, which require deliberate saving). Automatically restoring the last-used configuration on startup would reduce friction.

### 17. Web search configuration [DONE]
The max results (5) and page fetch limit (3) are hardcoded constants. A setting for result count would allow tuning for speed vs. context depth.

---

## Out of Scope

The following would require expanding beyond the current scope of launching/running/serving llama.cpp with basic chat, and are noted here only for reference:

- Benchmark runner (`llama-bench` tab)
- Quantization tool (`llama-quantize`)
- VRAM usage estimator
- Perplexity testing (`llama-perplexity`)
