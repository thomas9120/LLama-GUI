# Chat pop-out Phase 1 capability findings

Date: 2026-09-11  
Status: Phase 1 fixture evidence (2026-09-11). The production pop-out in `ui/js/chat-window/` is covered in [Chat in a separate window](chat-popout.md) and [Tests](tests.md); this fixture itself implements no production behavior.

The disposable check is run with:

```powershell
node tests/frontend/chat_popout_capabilities.cjs
```

The runner launches Playwright Chromium with fresh browser contexts and an ephemeral HTTP server. The server serves only the synthetic fixture page. It does not serve `ui/`, read or write `llama_gui_conversations`, accept chat requests, or expose any `/api/*` route. Each scenario uses a unique nonce and the only storage key it may create is `chat-popout-capability:<nonce>`. Closing the context removes that disposable state.

## Evidence from the loopback fixture

| Capability | Evidence | Finding |
| --- | --- | --- |
| Secure context | The fixture is loaded over `http://127.0.0.1:<ephemeral-port>/`; Chromium reports `window.isSecureContext === true`. | Loopback HTTP is eligible for APIs that require a secure context in the tested Chromium environment. |
| Popup and tab reference | A direct click calls `window.open()` with a stable name and receives a Playwright popup page. The receiver remains on the fixture origin and the source observes its `WindowProxy.closed` state. | A real same-origin popup reference is available in the tested loopback browser context. A browser may still present a page as a tab; the receiver must be verified rather than inferred from the returned handle. |
| Exact messaging contract | The receiver sends protocol version `1`, the nonce, and its hello through `postMessage(..., location.origin)`. The source accepts only the exact origin, the opened popup reference (`event.source`), version, and nonce. A wrong version from the popup is rejected; a `localhost` attacker page is rejected for origin and source. | Origin, source, version, and nonce checks are practical in the same browser context. |
| Storage partition | The source writes only the nonce key. The same-context receiver reads the same value and has the same single key. A page in a separate browser context reads `null`. | Same-context pages share the storage partition; isolated contexts do not. Storage is a capability probe, not an ownership mechanism. |
| Web Locks | One page holds `chat-popout:<nonce>` in `exclusive` mode. A second page remains queued until the first releases it, then acquires it. `navigator.locks.query()` reports the held lock and mode. | Exclusive coordination works for participating same-origin pages in the tested secure loopback context. |
| Close and focus messaging | The receiver acknowledges the verified focus request. After it is closed, the source observes `WindowProxy.closed`. | This checks the focus message contract and close detection, not native window activation. Browser chrome and user focus policy remain host decisions. |
| Lifecycle isolation | The fixture records every request and asserts there are no `/api/*` requests. Storage assertions permit only the disposable nonce key. | The Phase 1 exit path has no model, backend, launch, stop, reconnect, shutdown, or chat-history side effects. |

The exact protocol values are intentionally small and synthetic. The fixture does not transfer prompts, messages, credentials, draft text, files, or a production snapshot.

## Fallback evidence

Every fallback case uses a fresh browser context and keeps the source page recoverable:

- Web Locks unavailable: an initialization script removes `navigator.locks`; Pop out is refused with an exclusive-lock capability message.
- Opener unavailable: the synthetic receiver clears `window.opener`; the source leaves the original page intact when the verified handshake does not complete.
- Popup blocked: an initialization script makes `window.open()` return `null`; the source reports that the popup was blocked or did not return a window reference.
- Storage blocked: an initialization script makes the Storage methods throw `SecurityError`; the source refuses a handoff because its storage partition cannot be probed.

The blocked-popup, blocked-storage, missing-Web-Locks, and missing-opener conditions are controlled browser-context simulations. The normal popup, opener reference, same-context storage sharing, Web Locks contention, secure-context result, and close checks run against Chromium itself. Native window activation is not asserted by the headless fixture. A real embedded host that strips or changes these capabilities still needs a native check.

## Bootstrap and request-setting audit

The current frontend is a strict ordered global-script page. `app.js` is not a safe popup entry point to run wholesale:

- Before `DOMContentLoaded`, it selects `llama-server`, replaces `flagCore` values with defaults, creates the shared inference-stat engine, and configures API, sampler-preset, preset, tunnel, external-server, Hugging Face, Quick Launch, benchmark, Monitor, process-lifecycle, and Model Switcher modules. It also subscribes to lifecycle snapshots.
- Its `DOMContentLoaded` handler initializes the theme, tabs, tool and Configure controls, installation/API/preset/Quick Launch/Chat/benchmark/Monitor flows, model-directory controls, release fetching, command preview, endpoint rendering, launch/stop actions, polling visibility handlers, and the remaining page wiring.
- `chatUi.configure()` is a top-level dependency injection call near the end of `app.js`; `initChatTab()` only calls `chatUi.init()`. Loading the full application in a popup would therefore risk a second configuration authority, lifecycle controller, release fetch, and polling cycle.

The smallest popup bootstrap must retain the ordered dependencies required by the Chat package (`ui/js/chat/`) (`flagCore`, `chatTools`, `app-data`, `chat-rendering`, `chat-compaction`, and `character-cards`) and provide the existing Chat DOM/dependency boundary. It should inject a verified host adapter for settings, runtime identity/status, authorization behavior, and the existing baseline helper. The popup must not initialize its own lifecycle controller or external-server restore. This is an audit result for the next phase; it does not add a popup module or alter the application bootstrap.

`buildChatBody(history, draft, includeUsage)` currently consumes these request inputs:

- `#chat-system-prompt` and `chatTools.getInstructions()` for the system message.
- The complete history after `chatCompaction.workingMessages(...)`, passed through `chatTools.requestMessages(...)`, plus the trimmed draft as a final user message.
- The active model from the lifecycle snapshot first, then running status, then shared `flagCore` alias/selected model, with `local-model` as the last fallback.
- `stream: true` and, when requested, `stream_options.include_usage: true`.
- Shared `flagCore` sampler values: `temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, and `n_predict` mapped to `max_tokens` (with numeric normalization and the `-1` server-default sentinel omitted from `max_tokens`).
- `#chat-thinking-effort` (`auto`, `off`, `low`, `medium`, `high`, or `xhigh`). Non-auto values produce the top-level `reasoning_effort` and the compatibility `chat_template_kwargs`; `off` uses `none` and disables thinking.
- `#chat-web-search-toggle` and the clamped `#chat-web-search-max-results` value (1–10, default 5) when search is enabled.
- `chatTools.getDefinitions()` when the configured browser tools list is non-empty.

Context-preview and compaction keys also include the active runtime, external target, template capabilities, and the same request body. A popup host adapter therefore needs notifications that invalidate stale previews when the main window changes runtime or shared sampler state.

## Launch-environment limits

The Phase 1 fixture evidence is limited to a normal Chromium browser using loopback HTTP and isolated synthetic contexts. The following capabilities are not established by that fixture; later native observations are recorded separately below:

- HTTPS tunnel behavior and certificate/secure-context handling.
- Plain HTTP access through a LAN address, including whether that origin is a secure context.
- Pinokio's embedded/native browser behavior for popup acceptance, opener retention, storage partitioning, Web Locks, focus, and close.
- Native desktop window placement, chrome, and close-policy behavior.

The Pinokio audit supplied for this phase found that the current launcher runs `node ../scripts/supervise.js` from its `app` directory with `LLAMA_GUI_SUPERVISED=1` and `PYTHONUNBUFFERED`, captures the dynamic local URL, and exposes **Open Web UI** as a link to that URL. Its static `check-app-compat.js` check passed against the existing frontend file/script/lifecycle expectations. Those facts show that the dynamic loopback URL and current script entrypoint are launcher-compatible by inspection; they do not establish embedded popup/opener/partition behavior. See the native follow-ups below for subsequent application checks.

The accepted first-version lifetime boundary remains that the original GUI page stays open as the settings and runtime authority while Chat is detached. The current app also pauses visibility-driven polling when a document is hidden; integration work must preserve the host's authoritative runtime/status behavior while the main page is backgrounded and ensure abort/recovery reaches the detached owner. Neither concern is solved by this capability fixture.

## Native follow-up: Windows Pinokio, 2026-09-11

The implemented application was launched through Pinokio in a disposable test checkout. A direct **Pop out** click in the embedded GUI returned no window reference, displayed the popup-blocked fallback reason, and opened no separate Pinokio window. Pop-out is therefore unavailable in that tested embedded surface; the original Chat remains the fallback. This observation does not establish opener retention or shared storage for a popup that the host refused to open.

Separately requesting a popup through `pterm open` selected an external browser surface (Firefox). That is not evidence of a same-origin, same-partition application handoff from the embedded GUI. The entire GUI must be opened in one supported browser context before testing its own Pop out action.

The launcher later forwarded a `?chat-window=1` URL to Chrome without the original page's opener connection. The pre-fix page showed inactive Quick Launch controls because error handling had not selected the dedicated Chat shell. The orphan-page regression now requires visible Chat failure guidance and a deliberate link to open the full GUI in that browser, with no automatic transfer or startup.

The full GUI opened directly in Chrome successfully opened a dedicated Chat window and showed the main-page detached placeholder. The main page's **Return chat here** closed the popup; reopening and then closing the popup exposed **Recover chat here**, which restored normal Chat. These native checks used an empty workspace without model generation. Native automation timed out when operating the popup's own Return button, so no native result is claimed for that button; the automated Chromium tests cover it.

## Native follow-up: Tier 2 completion, 2026-09-12

The maintainer reported that the post-refactor Windows/Chrome and Pinokio smoke checklist passed, including real model generation, populated workspace/draft transfers, both Return controls, native focus, shared settings, minimized-host generation, recovery without automatic resend, narrow layout, themes and launcher restart/shutdown/relaunch. The embedded popup/fallback check also passed; opener/storage support remains unestablished where the embedded host blocks opening. These are manual application results, separate from the synthetic capability fixture. See [Native smoke checks](tests.md#native-smoke-checks) for the checklist. Public HTTPS tunnel/trusted-certificate, second-device LAN and native macOS checks remain pending; local transport results are recorded under [Local HTTPS and LAN-address follow-up](tests.md#local-https-and-lan-address-follow-up).
