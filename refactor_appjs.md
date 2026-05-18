# Phased Plan: Refactor `ui/js/app.js`

## Goal

Improve maintainability by breaking `ui/js/app.js` into focused modules while preserving current behavior, script loading style, and shared UI state synchronization.

This should be done a little at a time. `app.js` is large enough that a single sweeping refactor would be harder to review and riskier to verify. Each phase below should be independently reviewable and leave the app working.

## Ground Rules

- Keep `app.js` as the main bootstrap/orchestration file until the smaller modules are stable.
- Preserve the current global script architecture; do not switch to ES modules in this refactor.
- Use the existing namespace pattern: attach new module APIs under `window.LlamaGui`.
- Insert new scripts in `ui/index.html` after their dependencies and before `app.js`.
- Do not introduce per-tab copies of shared launch state.
- Continue reading and writing launch-relevant values through `window.LlamaGui.flagCore`.
- Keep each phase behavior-preserving unless a bug is discovered and intentionally fixed.
- After every phase, run syntax checks for touched JS files and the relevant frontend smoke tests.

## Phase 1: Extract Markdown And Chat Rendering Helpers - Done

Status: Completed. `ui/js/chat-rendering.js` now exposes the moved helpers through `window.LlamaGui.chatRendering`, and `ui/index.html` loads it before `app.js`.

This is the easiest first win because the markdown and rendering helpers are mostly self-contained and do not own launch state.

### Implementation

- Add a focused module such as `ui/js/chat-rendering.js`.
- Move markdown helpers out of `app.js`, including:
  - `escapeHtml`
  - `processBlocks`
  - `renderMarkdown`
  - `getSafeExternalUrl`
- Move low-level chat DOM rendering helpers if they can be extracted without pulling chat state with them:
  - `renderChatMessage`
  - `getChatMessageContentWrap`
  - `setChatWebStatus`
  - `renderChatSources`
  - `renderChatTypingIndicator`
  - `removeChatTypingIndicator`
  - `appendChatStreamToken`
- Expose the moved helpers through `window.LlamaGui.chatRendering`.
- Update `app.js` to call the new namespace instead of local functions.
- Add the new script to `ui/index.html` before `app.js`.

### Verification

- Run `node --check ui/js/chat-rendering.js`.
- Run `node --check ui/js/app.js`.
- Start the app and verify chat markdown rendering still handles:
  - fenced code blocks
  - inline code
  - bold and italic text
  - lists
  - tables
  - web search source chips
- Run `npm run test:frontend` if available.

### Code Review

- Review the phase for behavior-preserving moves only.
- Confirm no user/model content was changed from safe text handling to unsafe `innerHTML`.
- Confirm `app.js` no longer defines duplicate copies of the moved helpers.
- Confirm script order is correct and the app still loads cleanly.

## Phase 2: Extract API Tab Data And Rendering - Done

Status: Completed. `ui/js/api-tab.js` now owns API endpoint/snippet data and API tab rendering through `window.LlamaGui.apiTab`, with dependencies injected from `app.js`.

The API tab is another low-risk boundary because most of it is static endpoint/snippet data plus rendering and copy controls.

### Implementation

- Add a focused module such as `ui/js/api-tab.js`.
- Move API tab constants and helpers out of `app.js`, including:
  - `API_ENDPOINTS`
  - `API_SNIPPETS`
  - `initApiTab`
  - `getServerBaseUrl`
  - `getServerEndpointConfig`
  - `getPreferredApiModelName`
  - `updateApiEndpoints`
- Expose the module through `window.LlamaGui.apiTab`.
- Keep shared utilities such as `copyText` and `showToast` in `app.js` for now unless the new module needs a cleaner dependency injection point.
- Update `app.js` initialization to call `window.LlamaGui.apiTab.init(...)` or equivalent.
- Add the new script to `ui/index.html` before `app.js`.

### Verification

- Run `node --check ui/js/api-tab.js`.
- Run `node --check ui/js/app.js`.
- Verify the API tab renders endpoint cards and code snippets.
- Verify copy buttons still work.
- Verify server base URL and model name update when launch state changes.
- Run `npm run test:frontend` if available.

### Code Review

- Review the module boundary and confirm API tab behavior is isolated from unrelated app state.
- Confirm copied snippets and endpoint URLs are unchanged.
- Confirm no launch argument or flag state generation moved into the API module.
- Confirm script order is correct and there are no new globals outside `window.LlamaGui`.

## Phase 3: Extract Hugging Face Download UI

The Hugging Face downloader has a clear boundary around its backend endpoints, progress timer, form controls, and status rendering.

### Implementation

- Add a focused module such as `ui/js/hf-download-ui.js`.
- Move HF download state and helpers out of `app.js`, including:
  - `hfDownloadTimer`
  - `hfDownloadFailCount`
  - `hfDownloadStartTime`
  - `HF_DOWNLOAD_POLL_MAX_FAILS`
  - `HF_DOWNLOAD_TIMEOUT_MS`
  - `formatHfBytes`
  - `showHfDownloadStatus`
  - `setHfDownloadBusy`
  - `updateHfProgress`
  - `populateHfFileSelect`
  - `findHfFiles`
  - `startHfDownload`
  - `finishHfDownload`
  - `refreshHfDownloadStatus`
  - `pollHfDownloadProgress`
  - `cancelHfDownload`
- Expose the module through `window.LlamaGui.hfDownloadUi`.
- Pass dependencies explicitly where useful, such as `fetchJson`, `showToast`, `confirmAction`, and model refresh/select callbacks.
- Keep downloaded model selection synchronized through `flagCore`.
- Add the new script to `ui/index.html` before `app.js`.

### Verification

- Run `node --check ui/js/hf-download-ui.js`.
- Run `node --check ui/js/app.js`.
- Verify the downloader can:
  - fetch repo file lists
  - populate model and mmproj selectors
  - start a download
  - show progress
  - cancel a download
  - auto-select the completed model
- Run `npm run test:frontend` if available.

### Code Review

- Review timer lifecycle handling and confirm polling is not duplicated.
- Confirm download completion still updates shared selected model state.
- Confirm error/status messages are unchanged or clearer.
- Confirm the module does not directly mutate `flagValues`.

## Phase 4: Extract Remote Tunnel UI

Remote tunnel controls are a good next extraction because they own a distinct timer, status renderer, and backend route set.

### Implementation

- Add a focused module such as `ui/js/remote-tunnel-ui.js`.
- Move remote tunnel state and helpers out of `app.js`, including:
  - `remoteTunnelTimer`
  - `initRemoteTunnelControls`
  - `setRemoteTunnelPolling`
  - `renderRemoteTunnelStatus`
  - `refreshRemoteTunnelStatus`
  - `startRemoteTunnel`
  - `stopRemoteTunnel`
- Expose the module through `window.LlamaGui.remoteTunnelUi`.
- Pass dependencies explicitly where useful, such as `fetchJson`, `copyText`, and `showToast`.
- Add the new script to `ui/index.html` before `app.js`.

### Verification

- Run `node --check ui/js/remote-tunnel-ui.js`.
- Run `node --check ui/js/app.js`.
- Verify tunnel start, stop, status polling, URL rendering, and copy buttons.
- Verify tunnel status still updates CORS-visible URL text correctly.
- Run `npm run test:frontend` if available.

### Code Review

- Review polling start/stop behavior for leaks or duplicate intervals.
- Confirm tunnel status rendering is unchanged.
- Confirm copy buttons still use the same public URL and OpenAI-compatible base URL formats.
- Confirm no unrelated API tab or launch logic moved with this phase.

## Phase 5: Extract Quick Launch UI

Quick Launch is high-value but riskier because it touches mirrored controls, shared flag state, sampler presets, profiles, templates, command preview, and launch buttons.

### Implementation

- Add a focused module such as `ui/js/quick-launch-ui.js`.
- Move Quick Launch state and helpers out of `app.js`, including:
  - `quickLaunchFitCtxLinked`
  - `quickLaunchGpuCustomSelected`
  - Quick Launch profile rendering and application
  - Quick Launch context/GPU setters
  - Quick Launch template dropdown rendering and selection
  - Quick Launch sampler preset controls
  - Quick Launch sampler field wiring
  - Quick Launch command preview mirroring
  - Quick Launch action button sync
- Keep shared sampler preset storage helpers in one place. If both Chat and Quick Launch need them, extract them to a small shared sampler module instead of duplicating.
- Keep chat template mapping helpers shared if Configure and Quick Launch both depend on them.
- Route all launch-relevant updates through `flagCore.setFlagValue`, `flagCore.setMultipleFlagValues`, or existing shared setters.
- Add the new script to `ui/index.html` before `app.js`.

### Verification

- Run `node --check ui/js/quick-launch-ui.js`.
- Run `node --check ui/js/app.js`.
- Run `npm run test:frontend`.
- Manually verify:
  - model selection syncs between Configure and Quick Launch
  - context size syncs with command preview
  - GPU layers sync with Configure
  - Auto Fit controls update launch args
  - template dropdown syncs with Configure
  - sampler sliders sync with Chat and Configure
  - profile selection updates all expected shared state

### Code Review

- Review specifically against the UI State Sync Rule in `AGENTS.md`.
- Confirm there are no per-tab copies of launch-relevant state.
- Confirm duplicate controls reuse the same options sources.
- Confirm command preview still comes only from `flagCore.getLaunchArgs()`.
- Confirm all changed controls use shared setters.

## Phase 6: Extract Chat Controller

The chat controller is the largest and most stateful extraction. Do it after the easier module boundaries have reduced noise in `app.js`.

### Implementation

- Add a focused module such as `ui/js/chat-ui.js`.
- Move chat state and controller behavior out of `app.js`, including:
  - `chatMessages`
  - `chatStreaming`
  - `chatAbortController`
  - `currentConversationId`
  - chat web search storage/settings
  - chat send/stop/regenerate/undo logic
  - conversation history storage and rendering
  - chat sidebar controls
  - chat sampler params
  - chat status badge updates
  - `initChatTab`
- Reuse `window.LlamaGui.chatRendering` from Phase 1.
- Keep stats baseline interactions explicit so process stats and chat stats remain understandable.
- Route sampler slider updates through `flagCore.setFlagValue`.
- Add the new script to `ui/index.html` before `app.js`.

### Verification

- Run `node --check ui/js/chat-ui.js`.
- Run `node --check ui/js/app.js`.
- Run `npm run test:frontend`.
- Manually verify:
  - send message
  - stop streaming
  - regenerate response
  - undo message
  - clear chat
  - create and reload conversations
  - delete one conversation
  - delete all conversations
  - web search toggle and result count persistence
  - sampler sliders sync with Configure and Quick Launch

### Code Review

- Review streaming and abort behavior carefully.
- Confirm localStorage keys and stored data shapes are unchanged.
- Confirm chat sampler controls still use shared flag state.
- Confirm chat rendering still goes through the extracted safe rendering helpers.
- Confirm stats interactions did not become hidden cross-module coupling.

## Phase 7: Shrink `app.js` To Bootstrap And Shared App Shell

After feature modules are extracted, clean up `app.js` so it is mostly startup sequencing and shared shell behavior.

### Implementation

- Leave `app.js` responsible for:
  - initial `flagCore` setup
  - DOMContentLoaded orchestration
  - tab switching
  - launch/stop process controls if not yet extracted
  - command preview refresh coordination
  - shared app shell utilities that are still genuinely global
- Consider extracting remaining generic utilities into `ui/js/app-utils.js` only if multiple modules need them.
- Avoid large renames. Keep this phase focused on removing leftover dead code and clarifying initialization order.

### Verification

- Run `node --check` on all touched JS files.
- Run `npm run test:frontend`.
- Verify all tabs load and basic workflows still work:
  - Install
  - Quick Launch
  - Configure
  - Chat
  - API
  - Presets

### Code Review

- Review `app.js` for remaining mixed responsibilities.
- Confirm extracted modules have narrow public APIs.
- Confirm there are no duplicate function definitions or stale globals.
- Confirm `ui/index.html` script order documents the dependency flow clearly.

## Suggested Commit Strategy

- Use one commit per phase.
- Keep each commit reviewable and behavior-preserving.
- If a phase reveals an actual bug, either fix it in a separate commit or call it out clearly in that phase's commit message.
- Prefer stopping after each phase if tests or manual verification reveal unclear behavior.
