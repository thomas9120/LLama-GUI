# Chat in a separate window

Use **Pop out** beside **Focus** in Chat to move the current workspace into a separate browser window. The conversation, answer versions, reasoning, sources, tool results, compaction summaries, system prompt, and unsent draft move together. **Return to main window** moves Chat back. The main page also offers **Show window** and **Return chat here**.

Keep the original GUI page open. It can be minimized and its other tabs remain usable. That page remains the authority for model settings, runtime status, and inference statistics. Sampler edits in the separate window use the same settings as Configure and Quick Launch. Pending launch settings do not replace the identity of the running model.

Transfer is available while Chat is idle. Finish or stop a response, finish importing a character card, resolve a confirmation, and save/cancel a message edit before moving Chat. Moving a live response or tool round is not supported.

Main-window Focus and panel preferences are restored when Chat returns. Panel choices in the separate window are temporary. Browser controls determine window size, position, and whether a separate window or tab opens; this feature does not provide always-on-top behavior.

## Interrupted windows and recovery

Chat keeps one recovery checkpoint in addition to normal saved conversation history. Checkpoints include the draft and recoverable partial output. Closing or reloading a window can interrupt an active response; recovery never automatically sends the draft or retries generation. Changes after the last successful checkpoint can be lost in an abrupt browser/process crash.

If the separate window closes, use **Recover chat here** in the main page. Recovery first obtains exclusive Chat ownership and reads the latest valid checkpoint. A page that cannot obtain ownership remains an observer. A missing message or timeout never authorizes a second owner.

Reloading the separate window ends its verified connection. If it displays an unavailable message, close that window and use **Recover chat here** in the main page before opening Chat separately again.

If the original main page closes or reloads, the separate Chat pauses because its settings connection is no longer valid. Preserve any visible text you need and follow the recovery instruction in the page. Opening another GUI page does not make it a second editable Chat while another participating page still owns the workspace.

Closing the main browser page breaks that connection but does not itself request backend shutdown. **Quit Llama GUI** uses the existing backend shutdown action; a separate Chat window cannot keep the backend running after Quit.

Deletion, Delete All, Clear, and new/character-chat transitions invalidate older recovery state before destructive history writes. Recovery is not a deleted-conversation archive. Normal saved history retains its existing 50-conversation limit.

If browser storage is unavailable or full, a transfer that cannot save its checkpoint is refused. The source workspace remains available. Free storage or use the current window; final keystrokes and tokens are not guaranteed without a successful checkpoint.

## Browser and launcher support

The automated application tests use Chromium, an ephemeral loopback HTTP server, fresh browser contexts, synthetic conversations, and mock API responses. They do not start a model process or use an existing browser profile. The separate window must retain same-origin opener access and share the browser storage partition with the main page. Web Locks provide ownership where available; there is no timestamp-based substitute.

The Pinokio launcher's static compatibility check passes with the added frontend script. In the Windows Pinokio embedded view tested on 2026-09-11, a direct Pop out click did not receive a window reference and no separate Pinokio window opened. That embedded view therefore uses the single-window fallback. Its popup opener/storage behavior could not be tested beyond that blocked opening. HTTPS tunnels and native macOS/browser window behavior still require manual checks. Opening an unrelated external browser or another profile does not establish a shared workspace. Plain HTTP origins outside trusted loopback normally lack the secure-context capabilities required for pop-out; the ordinary single-window Chat remains the fallback.

Only pages running this implementation in the same browser storage partition participate in ownership coordination. Already-open older builds do not obey its lock. Version-mismatched peers refuse transfer and need a reload.

For a native launcher or browser check, use disposable test conversations and verify popup/opener retention, shared storage, focus, close/reload recovery, and Return/Send access with both panels and Context open. Check the launcher's embedded view separately from its external-browser link. Keep CI on Linux and Windows; native checks do not require adding macOS runners.

See [capability evidence](chat-popout-capabilities.md), the [implementation plan](chat-popout-implementation-plan.md), and [test commands](tests.md).
