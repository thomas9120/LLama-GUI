# Chat pop-out implementation plan

Date: 2026-09-10  
Status: Draft for review; no implementation is authorized by this document.

## Objective and proposed scope

Add **Pop out** beside Focus in the Chat header. It opens the existing chat in a separate, resizable browser window, using the same GUI backend and running model. Provide **Return to main window** to move it back without losing the conversation or draft.

The recommended first version supports one detached Chat workspace, including Conversations and Settings. Transfer is available only when Chat is idle. It reuses existing rendering, request construction, persistence, tools, character-card import, and confirmation dialogs.

**Draft scope decision: the original GUI page remains open, although it can be minimized.** It remains the authority for shared launch settings and runtime status. Closing or reloading that page requires recovery/reconnection before further chat actions. This boundary avoids introducing a second independent configuration authority. It is a proposal for review, not a requirement previously specified by the user. If continuing normally after closing the main GUI is required for the first release, revise the settings/lifecycle design before implementation; see Deferred work.

Out of scope for this version:

- Multiple independently editable chat windows.
- Moving a live response, compaction, or tool round between documents.
- Guaranteed generation continuation after its owning window closes.
- A native desktop wrapper, always-on-top controls, or guaranteed window placement.
- Cross-browser, cross-profile, or cross-device history synchronization.
- Changing model launch behavior, history retention, or conversation deletion semantics.

## Current architecture and implications

| Existing component | Implication for this feature |
| --- | --- |
| `ui/index.html` and ordered global scripts | Reuse one document and its script order; select a dedicated display mode at bootstrap. Avoid maintaining a duplicate chat page. |
| `ui/js/chat-ui.js` | Owns the transcript, current conversation ID, draft-related UI, streaming/abort state, compaction, history, and settings controls. Add explicit transfer and ownership APIs here rather than copying its private variables elsewhere. |
| `ui/js/chat-rendering.js`, `chat-compaction.js`, `chat-tools.js`, `character-cards.js` | Reuse these modules. Tool results, answer versions, reasoning, and compaction records must survive transfer along with visible messages. |
| `llama_gui_conversations` in localStorage | History is a whole-array read/modify/write operation. A second independently saving page can overwrite changes or resurrect a deleted entry. Storage access alone does not establish ownership. |
| `ui/js/flag-core.js` | Shared setters synchronize Configure, Quick Launch, and Chat within one document. A newly loaded page otherwise gets a separate state instance. Never mutate the object returned by `getFlagValues()`. |
| `ui/js/app.js` | Configures dependencies and initializes all tabs, polling, and lifecycle integration. A popup must not run that full startup sequence blindly. |
| Existing Python backend and SSE proxy | Both windows can use the same endpoints. No new model process or backend route is expected for the proposed scope. |

The source was inspected on the date above. Recheck these boundaries before implementation, since other Chat work may add state that the transfer snapshot must preserve.

## User experience

### Opening and using the window

1. Click **Pop out**. Open one named browser window directly from that click, before awaiting storage or network operations.
2. Show a brief loading state in the new window while its dependencies and handshake are checked. Keep the original chat intact until the receiver is ready.
3. Transfer the active conversation and unsent draft. Once ownership is confirmed, focus the popup composer.
4. Replace the original Chat workspace with a message: **Chat is open in another window**, plus **Show window** and **Return chat here**.
5. Keep Configure, Monitor, Quick Launch, and other main-window tabs available. Repeated Pop out/Show window actions focus the existing popup without navigating or reloading it.

The popup shows the Chat header, model/server status, Conversations, Settings, New Chat, transcript, composer, and the existing stats display. Its primary layout action is **Return to main window**; it does not need a second Focus toggle because the main navigation is already absent. Keep panel controls accessible at narrow widths and keep Context above the composer.

Preserve the main window's normal/focus state and panel preferences for the return journey. Popup panel changes are temporary for that window and do not overwrite those main-window preferences. System prompt, reasoning effort, web search, date/time tool preferences, and samplers remain functional settings, not merely layout preferences.

### Busy states

Disable transfer in either direction during generation, send preflight, web search, automatic/manual compaction, tool continuation, character-card file processing, an open destructive confirmation, or a pending message edit. Show a short reason such as **Finish or stop the response before moving chat**. Resolve an edit with Save/Cancel first.

Check these conditions again inside the transfer operation. A disabled button alone is insufficient: keyboard actions and asynchronous callbacks can race with a click. An ordinary debounced context preview can be cancelled and recomputed in the destination.

### Returning and closing

- **Return to main window** and **Return chat here** use the same idle handoff in reverse. Close the script-opened popup only after the main page has restored and acknowledged the snapshot.
- If automatic window closing/focusing is refused, leave a clear completed state with instructions to close/select the window manually. Never transfer back twice.
- Closing an idle popup through the window's X lets the main page recover the latest saved snapshot after it has acquired ownership. Do not depend on an unload callback for the final save.
- Closing a generating popup may interrupt that response. Recover the last successfully checkpointed partial output, marked interrupted; do not silently resend the request or claim completion.
- Closing the main GUI's browser page is distinct from **Quit Llama GUI**. The former breaks this version's settings/status bridge; the latter stops the backend through its existing lifecycle path. The popup must report the correct condition and preserve recoverable chat state.

## Proposed implementation

### 1. Display mode and bootstrap

Use a same-origin URL such as `/?view=chat-window`, derived from the current URL rather than hardcoding port 5240. Preserve existing asset/cache-version behavior. Do not put prompts, messages, credentials, or the draft in the URL.

Add a focused `window.LlamaGui.chatWindow` module to coordinate both sides. Keep `app.js` as wiring: detect the display mode before normal tab initialization, retain the shared markup needed by Chat/dialogs, and initialize only the popup's required behavior. Audit configuration work that currently happens before `DOMContentLoaded`, not just the event handler.

Use an explicit popup body class to hide/inert the main navigation. Do not set a stored focus preference or depend on a CSS selector alone to prevent hidden controls from running. When adding the script, update the canonical order in `docs/directory.md` and the module-loading test.

### 2. Keep one shared settings authority

For this version, the original GUI owns `flagCore`, runtime reconciliation, and the inference polling/baseline. Expose a narrow, same-origin, in-memory host adapter to the verified popup and inject it through the existing `chatUi.configure()` dependency boundary.

The adapter should provide only the operations Chat actually needs:

- Read the request-relevant shared settings and active runtime identity.
- Write allowed Chat sampler fields through the host's existing `setFlagValue` / `setMultipleFlagValues` path.
- Receive notifications after host patches and wholesale preset/reset/model changes, so the popup refreshes its controls and invalidates stale context previews.
- Obtain the existing runtime/status and inference snapshots; request a baseline reset through the existing helper.
- Bring the main page forward and select Quick Launch or API when Chat's existing recovery links require them.
- Obtain the existing authorization behavior without copying credentials into persistent transfer data.

Prefer a small synchronous host adapter for settings operations while same-origin window references are valid. This preserves existing setter semantics and prevents two windows from accepting competing settings snapshots. Notifications may use a targeted message channel; `BroadcastChannel` is useful for discovery/ownership announcements but is not a replacement for an authoritative state model. Same-origin messaging also depends on sharing a storage partition, so an external browser opened from an embedded host may not qualify. [Broadcast Channel reference](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API)

Do not synchronize all flags by broadcasting raw `getFlagValues()` output: it can include credentials and unrelated launch inputs. Keep the field selection derived from the existing Chat request/control definitions rather than creating another sampler option list. Do not initialize a competing lifecycle controller or external-server auto-restore in the popup. Its stream still uses the existing backend endpoint and request builder.

If the host bridge becomes unavailable, disable new sends, compaction, and sampler edits until it is re-established. A timeout is evidence of a lost connection, not proof that a window has closed. Preserve the transcript/draft; allow copying/exporting recoverable content. On a confirmed host close or incompatible reload, cancel ongoing chat work through the existing awaited abort path and checkpoint it. Recovery must not silently replace newly edited main-window settings with an old popup snapshot.

### 3. Explicit chat ownership

The active chat window alone may generate, mutate history, import cards, rename, delete, clear, compact, or save conversation state. Enforce this in the mutation entry points as well as in the UI. Delayed confirmation results and async imports must recheck ownership before committing.

Use one origin-scoped Web Lock for the Chat/history workspace when the feature is available. The main Chat controller holds it initially; the popup acquires it during handoff. Additional same-origin GUI pages become Chat observers while another page owns the workspace. They can still use non-Chat tabs. Use explicit acquisition attempts, cancel stale queued requests, and never force-steal the lock after a heartbeat timeout. Web Locks provide exclusive coordination across participating same-origin contexts and require a secure context. [Web Locks reference](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)

Define the scope honestly: this protection covers pages running the new code in the same browser storage partition. Already-open older builds do not participate. Version-mismatched peers must refuse transfer and request a reload; do not silently assume they obey the lock.

Where required browser capabilities are unavailable, retain existing single-window Chat and explain why Pop out is unavailable. Do not implement a localStorage timestamp/heartbeat as a substitute mutex. Test loopback access and HTTPS tunnels separately from plain HTTP LAN access.

### 4. Transfer contract

Add a small public interface to `chat-ui.js`, with names finalized during implementation: inspect whether transfer is allowed, suspend mutations, capture a snapshot, restore a snapshot without saving it as a new conversation, and activate/deactivate ownership.

The versioned snapshot contains:

| State | Rule |
| --- | --- |
| Conversation identity and title | Preserve IDs/custom titles; an unsaved empty chat can remain unsaved. |
| Transcript | Preserve full supported message records, answer versions, selected versions, reasoning, sources, response status/metadata, and tool-call/result records. Use the existing data representation. |
| Working context | Preserve the complete compaction stack; recompute context counts after restore. |
| Conversation inputs | Preserve system prompt, reasoning effort, draft text, and relevant Chat preferences. |
| View state | Preserve useful scroll position/near-bottom intent and draft selection where practical. Retain the main layout snapshot separately. |
| Transfer metadata | Include schema version, source/destination instance IDs, transfer ID, and a revision/epoch used to reject late messages. |

Exclude DOM nodes, functions, promises, AbortControllers, file objects, cached token counts, raw authorization headers, and pending requests. Do not try to serialize a live stream. Validate shape/version and use existing safe rendering after restoring.

Handoff sequence:

1. The source still owns Chat. Open/discover the receiver and validate its identity, version, capabilities, and host bridge.
2. Suspend source mutations, recheck idle state, cancel its context preview, and capture the snapshot.
3. Save the current conversation through existing persistence and write the recovery checkpoint. If either required write fails, abort the handoff and reactivate the source.
4. Send a prepare message with the transfer ID. The receiver validates and renders inertly, then acknowledges readiness without writing history.
5. After readiness, release the source's ownership lock. The designated receiver requests it, verifies the transfer is still current, and activates only after acquisition.
6. The receiver acknowledges ownership. The source becomes the detached placeholder and relinquishes live mutation state.

Before lock release, failure can simply resume the source. After release, **neither side may reactivate based on a timeout alone**: it must acquire the lock and verify the current transfer record. Duplicate/late acknowledgments are idempotent. If another page acquires ownership or the receiver disappears, keep the losing page inert and offer explicit recovery. All async work started under an older ownership epoch must be unable to save or send later.

The reverse transfer follows exactly this sequence. Failed opening or restoration must not clear the original chat, reset its draft, or create a duplicate history entry.

### 5. Recovery persistence and window lifetime

Keep normal saved history in its current format and retain the 50-conversation limit. Add at most one separate, versioned recovery record for the active workspace, containing its revision, conversation identity, draft, and recoverable transcript. It is not a second history archive or a restore-deleted feature.

Checkpoint before transfer, after meaningful committed edits, and at a bounded/debounced interval while draft text or a partial response changes. Reuse serialization and avoid rewriting the full history array on every token. Do not insert provisional streaming messages into normal history until the existing finalization path runs.

After normal completion, reconcile/clear the provisional recovery state. Explicit deletion, Delete All, Clear, and character/new-chat transitions must update or invalidate it under the same ownership guard. Because multiple localStorage keys are not transactional, record a durable invalidation before a destructive history write, and prefer preserving the deletion over replaying an uncertain checkpoint. A crash between writes must never restore an explicitly deleted conversation. Test these failure boundaries.

On reload/recovery, acquire ownership first, check versions and invalidations, then restore the newest valid record. Never auto-submit a recovered draft or retry an interrupted generation. If storage is blocked/full, leave the current chat usable, report that transfer/recovery cannot be guaranteed, and refuse a handoff that requires a durable checkpoint. Do not claim that the final keystrokes/tokens survive an abrupt browser/process crash.

Use a `beforeunload` prompt only while a response or unsaved state is genuinely at risk, and remove it when no longer needed. Browsers control that prompt's text and may never fire the event, so it cannot be the persistence mechanism. [beforeunload reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)

## Potential pitfalls and prevention

| Pitfall | Prevention / expected behavior |
| --- | --- |
| Popup blocked, opens as a tab, or host strips opener access | Open from the direct click; verify the receiver rather than relying only on the returned handle. If a functional same-origin tab is opened, it can be used as the detached view. If handshake/capabilities fail, preserve the original chat and offer the ordinary single-window fallback. Never launch an unrelated external browser and assume its history is shared. |
| Duplicate clicks reload a streaming popup | Keep a stable window name and live reference; focus the verified instance without calling navigation again. |
| Main and popup both write the history array | Guard all mutation paths with ownership; keep nonowners inert; re-read history only after ownership is acquired. |
| Transfer and Send/import/delete finish concurrently | Recheck busy/ownership state inside handlers and after awaits, and reject results from the old epoch. |
| Background throttling looks like a crashed owner | Use messages for status and the exclusive lock for permission. Never infer permission from a missed heartbeat. |
| Samplers drift or reset to defaults in the popup | Use the host adapter and existing setters, including preset/reset notifications; do not initialize a separate authoritative flag store. |
| Wrong model/status after a runtime switch | Use the existing active-runtime identity and invalidation paths. Refresh context before the next send; never substitute pending Configure values for live runtime identity. |
| Duplicate polling or backend side effects | Audit popup bootstrap, module top-level code, and auto-restore; reuse host status/inference snapshots. Opening/closing the popup must not launch, stop, reconnect, or shut down a server. |
| Stale checkpoint resurrects a deletion | Invalidate recovery durably before destructive writes; restore only validated current records. Preserve all three existing confirmation behaviors, including one dialog for Delete All. |
| Lost draft, edit state, tool results, or answer versions | Use a complete versioned snapshot and fixture coverage. Block transfer during an unresolved edit/import instead of silently discarding it. |
| Secrets or hostile content leak through transfer | Keep credentials memory-only within the verified host adapter; use exact-origin/source checks for messages and no wildcard target origin. Use textContent for user data and the existing renderMarkdown exception for model output. |
| External source links affect the host window | Preserve safe source-link handling and audit opener behavior. Same-origin window access is only for the app's verified peer. |
| Parent reload replaces the adapter during a call | Tag host sessions; catch unavailable/disposed bridges, pause mutations, and run a fresh handshake. Do not attach to a new host implicitly with stale settings. |
| Popup layout hides Send or dialogs at small sizes | Use existing tokens/responsive layouts; test expanded panels, Context, character picker, and deletion dialogs in short/narrow windows. Restore keyboard focus after transfer and cancellation. |
| Overly large snapshots stall or exceed storage quota | Avoid redundant copies/token-by-token history writes. Measure representative long chats and cap additional checkpoint overhead with explicit failure feedback; never truncate conversation content silently. |

Browser window size, placement, chrome, and popup acceptance remain browser/host decisions. Treat them as requests and test the actual supported environments. [Window.open reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)

## Implementation phases and exit criteria

### Phase 1: Capability and bootstrap spike

- Verify same-origin popup/tab opening, references, messaging, storage partition, Web Locks, focus/close behavior, and secure-context support in the actual launch environments.
- Identify the minimal popup initialization path and every request setting consumed by `buildChatBody()`.
- Confirm the proposed main-window lifetime restriction and document supported/fallback environments before committing to the implementation design.
- Exit: a disposable fixture can open a verified receiver without modifying real chat data or triggering backend lifecycle actions. If the supported embedded host cannot provide this, revisit scope rather than silently implementing a different launcher.

### Phase 2: State and ownership boundaries

- Add the host adapter, chat transfer APIs, ownership guards, snapshot validation, and recovery/invalidation handling.
- Keep existing single-window behavior intact; add focused unit tests for races and persistence failures.
- Exit: idle state round-trips without loss; failed transfers preserve the source; two participating pages cannot generate/save simultaneously.

### Phase 3: Pop-out UI and integration

- Wire header/placeholder/return controls and dedicated display mode.
- Connect shared settings, runtime/status, dialogs, stats, tools, import/export, and navigation recovery links.
- Exit: the complete detach/use/return cycle works with no second model process and no duplicate history entry.

### Phase 4: Recovery and compatibility validation

- Exercise close/reload/crash-like cases, failed handshakes, blocked storage, delayed messages, stale builds, and responsive/keyboard behavior.
- Record browser/embedded-host limitations and manual checks. Update documentation and add a dated implementation changelog entry only when program changes ship.
- Exit: the acceptance cases below pass, and remaining limitations are explicit in the product/help text.

## Expected files

| File | Planned responsibility |
| --- | --- |
| `ui/js/chat-window.js` (new, proposed) | Display-mode detection, verified peer/host adapter wiring, handoff coordination, ownership, and recovery orchestration. Keep it feature-specific. |
| `ui/js/chat-ui.js` | Capture/restore supported Chat state; busy/ownership checks; recovery hooks at existing mutation/finalization boundaries. |
| `ui/js/app.js` | Main/popup bootstrap selection and dependency injection; no new standalone global state. |
| `ui/index.html`, `ui/css/style.css` | Controls, detached placeholder, popup layout, accessible states, and script inclusion. Reuse theme tokens. |
| `tests/frontend/chat_window_unit.cjs` (new, proposed) | Transfer protocol, host failure, ownership, snapshot fidelity, recovery/invalidation cases. |
| Existing Chat/unit/module and browser tests | Regression coverage plus same-context multi-page interactions using fixture conversations. |
| `docs/directory.md`, `docs/tests.md`, `docs/changelog.md` | Architecture/script order, supported behavior, verification instructions, and implementation summary. |

Touch `flag-core.js`, rendering, or lifecycle modules only if the existing injection/notification hooks cannot support the adapter. No new backend routes or runtime dependencies are planned. If that changes, update the route/API documentation and run the backend checks required by AGENTS.md. Check the Pinokio launcher for compatibility before changing frontend startup/script loading; do not modify its launch behavior as an incidental part of this feature.

## Verification and acceptance

Use isolated browser contexts and synthetic history; never delete or mutate the developer's real conversations during automated checks. Same-profile tests must use two pages in the same context. Separate-context tests should prove that unsupported partition/profile combinations fail without transferring data.

1. Pop out a normal chat, a new empty chat with a draft/system prompt, a character chat, and a chat containing reasoning, sources, tool results, answer versions, and compaction. Return each and compare complete state.
2. Pop out from both normal and focus mode. Restore main panel preferences, scroll behavior, and usable keyboard focus.
3. Repeat opening/return clicks and inject duplicate/late prepare/ready/commit messages. Verify one owner, one popup, no extra request, and no duplicate conversation.
4. Refuse transfer during every busy state; race Send, confirmation resolution, and import completion against transfer.
5. Block popup creation, fail the handshake, close the receiver at each handoff stage, and simulate storage/quota failures. The surviving owner must remain recoverable.
6. Edit samplers in either window, load/reset a preset in the main window, and verify controls, request/context bodies, shared flag state, and command preview agree. Test exact numeric values and unset/default semantics.
7. Switch/stop the runtime or disconnect an external target in the main GUI. The popup updates honestly; opening or closing it emits no launch/stop/shutdown/restore request.
8. Close/reload either window while idle and during a response/tool round. Restore only checkpointed data, mark interrupted output, and never auto-resend. Test failure between recovery invalidation and history deletion writes.
9. Confirm single deletion, Delete All, and Clear each retain their one-dialog behavior and cannot be undone accidentally by returning/reloading a stale window.
10. Test a third GUI page, stale protocol versions, delayed/throttled messages, and unavailable Web Locks. No timeout-based dual ownership or silent downgrade is allowed.
11. Inspect localStorage, transfer URLs/messages, and console output for credentials; verify hostile titles/prompts/greetings remain safe text.
12. Check 390px, 900px, and desktop widths plus short window heights, with both panels and Context open. Send, Return, dialogs, and the character file picker remain accessible.

Commands for implementation verification:

```powershell
node --check ui/js/chat-window.js
node --check ui/js/chat-ui.js
node --check ui/js/app.js
node --check tests/frontend/chat_window_unit.cjs
node tests/frontend/chat_window_unit.cjs
node tests/frontend/chat_ui_unit.cjs
npm run test:frontend:modules
npm run test:frontend
git diff --check
```

Also syntax-check any additional changed JS/CJS files and run focused tests for any additional touched module. Run `npm test` for the integrated frontend release check. Backend tests are required only if backend code changes. Keep CI on Linux and Windows; do not add macOS runners. Document any native macOS/browser checks still requiring manual execution.

## Deferred work

- **Independent lifetime:** allow normal popup operation after closing the main page. This needs an explicit new authority for shared settings/runtime coordination and a reconnect policy for a later main page; merely retaining a stale `flagCore` copy is insufficient.
- **Seamless transfer while streaming:** move generation ownership outside the document, or introduce a resumable backend session. It is a distinct architecture change with cancellation and persistence requirements.
- **Multiple editable chat windows:** replace workspace-wide ownership with per-conversation ownership plus serialized history mutations and clearly scoped settings.
- **Guaranteed native window/always on top:** evaluate launcher or desktop-host integration separately, including storage/profile compatibility and packaging costs.

No program files should change as part of reviewing or saving this plan. The main-window lifetime assumption and Phase 1 environment findings are the principal decisions to settle before implementation begins.
