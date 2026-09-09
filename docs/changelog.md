--Changelog--

Please give a brief summary of changes made to the program (excluding documentation changes), include the date the changes were made.

## 2026-09-09

- Added spacing between Load character card and its help text.
- Added Load character card below Chat's System Prompt for JSON and PNG cards. Import saves the current conversation and opens a new character chat with an editable prompt and greeting, with notices for unsupported card features and validation that preserves the current chat on failure.
- Removed the duplicate reasoning indicator from the Chat header; reasoning controls remain in Settings.
- Replaced Chat's ellipsis menu with a labeled Context button and an expandable panel above the message box, keeping Send accessible while context usage and compaction controls are open.
- Show Rename and Export only for the selected conversation, in a separate row below its details so the buttons leave room for the title.
- Kept Conversations and Settings accessible in Chat focus mode. Panels open without leaving focus mode, start collapsed on entry, and restore the normal panel layout on exit.
- Added Saved value and GUI default columns to the Presets tab's saved-settings table, showing defaults only for overrides. Fixed numeric strings matching numeric defaults and excluded credentials and retired draft context from override counts.
- Added opt-in context-aware auto-compaction, selectable before-edit history copies for recoverable Edit and resend, exact numeric Chat sampler inputs, active model/reasoning indicators, near-bottom streaming follow with Jump to latest, response metadata and Copy integration, and searchable, renameable, exportable, recoverable conversation history with visible retention.
- Updated Conversations and Settings to use responsive side-by-side or stacked panels that keep the transcript and composer reachable, with Jump to latest staying in normal composer flow.

## 2026-09-08

- Corrected the `-cram` label and help text to describe host-RAM prompt caching for reuse, clarifying that it does not increase the context window or limit VRAM.

## 2026-09-07

- Simplified custom-slot launch diagnostics and GPU vendor hints, with explicit Custom 02 telemetry coverage and exact backend query matching in browser checks.
- Added two fixed custom llama.cpp slots: Custom (`llama/custom/`) and Custom 02 (`llama/custom-02/`). Activation validates the selected slot, preserves the other build and the remembered official installation, and keeps models/presets shared. Launch/runtime checks, installed status, and Open llama.cpp follow the active slot; official cleanup preserves both custom builds and their active selection.
- Added Configure's Reset to defaults button with a confirmation dialog. It restores shared configuration defaults and clears Custom Launch Args while keeping the selected model/tool, saved presets, chats, and running process.
- Fixed legacy Preserve Reasoning values in preset summaries and searches: unchecked presets display Auto and no longer count as non-default overrides.
- Replaced Preserve Reasoning's checkbox with Auto / Enabled / Disabled, including explicit `--no-reasoning-preserve` support. Auto inherits the binary default; legacy unchecked presets remain Auto, preserving their launch behavior. Added migration, command-preview, and browser coverage.
- Fixed standalone speculative-type helpers in flag-core.js by keeping Ngram Simple detection local, with regression coverage for string values, disabled presets, and tuning-only settings.
- Added opt-in Ngram Simple controls in Configure with match/draft sizes, shared command and preset support, and guidance explaining its fallback relationship with Ngram Mod. Quick Launch has no new controls.

## 2026-09-06

- Fixed the interrupted web-response test fixture for Python 3.9's `readinto()` path while preserving its cleanup and error-sanitization checks.
- Restored benchmark error feedback and output polling after a refused Stop request, allowing Stop to be retried.
- Added real HTTP and web-transport tests, native telemetry fixtures, independent browser scenarios and benchmark action coverage; isolated configuration-sensitive tests, replaced brittle source-text checks, and required pinned CPU flag compatibility in CI.
- Stabilized live prompt speed by averaging observed batch progress over its full elapsed time and retaining the reading between batches, avoiding spikes from dividing a multi-poll batch by one poll interval.
- Show live prompt processing throughput in Monitor and the stats bar, excluding cached tokens and falling back to the completed-session average after prefill.
- Show live generation throughput in Monitor and the stats bar while a reply is streaming, instead of waiting for completed-request counters; label live readings separately from completed-session averages.

## 2026-09-05

- Corrected inference averages after counter resets and server restarts; missing processing-time counters now show unavailable instead of a live rate labeled as an average.
- Aligned the installed llama.cpp build label with the Install & Update button text.
- Matched the installed llama.cpp version text to the Live indicator color.
- Hardened credentials, runtime snapshots, server targets, installations, downloads, and reconnect handling; removed obsolete code and added regression coverage.
- Simplified Configure launch/restart guidance and moved comparison details into an expandable note.
- Reworked Monitor disk telemetry with read/write activity, platform-native collectors, and clear unavailable states.
- Connected saved presets to Configure and Quick Launch with comparison, save/update, validation, and masked settings views.
- Standardized Monitor card sizing and connected it to active runtime identity, lifecycle state, logs, and Configure links.
- Polished Chat, API, and Install & Update controls, disclosures, history, sampler help, examples, and restart labeling.
- Standardized headings, spacing, controls, cards, focus states, and responsive layouts across the app.
- Reorganized navigation around Quick Launch, grouped pages, added shared runtime details, and improved mobile behavior.
- Changed Quick Launch's unready label to "Launch not ready".
- Fixed Chat retaining stale running status after the server stops.
- Fixed Linux Monitor polling after the first disk I/O sample.
- Rebuilt Quick Launch around compact model, memory, sampling, preset, runtime, and launch controls.
- Added Configure's validated Restart with changes flow for local llama-server processes.
- Added Configure launch-settings comparison, filtering, review, reverts, and scrubbed launch snapshots.
- Polished Configure labels, alignment, defaults, help, accessibility, and narrow-layout behavior.
- Fixed install dropdown overflow at narrow window sizes.

## 2026-09-04

- Added native Linux and macOS app launchers and desktop shortcuts.
- Loading a preset now keeps the current tab open.
- Added a green Monitor Live badge for ready or externally connected servers.
- Fixed responsive Chat settings width at intermediate window sizes.
- Chat conversations now start collapsed for more message space.
- Moved context details and compaction actions into a composer tools menu.
- Added manual compaction, summary handling, retry support, and preserved answer history to Chat.
- Fixed invalid empty context previews from reaching llama-server.
- Added Chat context metering, request-budget checks, and actionable oversized-request feedback.
- Added safer regeneration, retry, interruption, and web-source restoration behavior to Chat.
- Polished Monitor cards, polling, focus, speed metrics, accessibility, and lifecycle reporting.
- Expanded optional cross-vendor GPU telemetry and platform-specific setup guidance.
- Enlarged Configure command previews and strengthened Monitor tests and diagnostics.

## 2026-09-03

- Added the Monitor tab with live output, reorderable resource/GPU cards, stats, and inference counters.
- Added cached system-stats telemetry with improved accuracy, recovery, diagnostics, accessibility, and navigation.
- Preserved preset favorites and usage history across refreshes and added Linux file-picker guidance.

## 2026-09-02

- Added official llama.cpp ROCm 10.0 binaries for Windows and Linux installation.

## 2026-09-01

- Added an optional per-slot context limit for unified KV cache deployments.

## 2026-08-31

- Removed the obsolete llama-cli Conversation Mode control.
- Updated llama-server tool choices and filtered stale multi-select values.
- Aligned Model Load Mode defaults and labels with current llama.cpp behavior.

## 2026-08-30

- Corrected Xet dependency bounds for supported Python and Linux CI installs.
- Accelerated Hugging Face downloads with concurrent Xet transfers and retained the HTTP fallback.
- Updated the lazy tensor-reading control to emit the current llama.cpp flag.
- Renamed Lemonade ROCm Nightly options and added its stable ROCm 10.0 install option.
- Marked official llama.cpp ROCm 7.14 options as legacy and clarified runtime requirements.

## 2026-08-29

- Reorganized Install and Update controls into a responsive two-column layout.
- Hardened helper downloads, threaded operations, DNS validation, and runtime health checks.

## 2026-08-28

- Hardened local proxy DNS checks, error sanitization, UI rerendering, child-process decoding, and install/update concurrency.
- Fixed Auto Fit command emission and added the Advanced lazy tensor-reading control.

## 2026-08-27

- Added the llama.cpp CPU FFN layer control.

## 2026-08-25

- Preserved downloaded official backends alongside custom backends and improved activation validation.
- Fresh installs now create custom backend directories automatically.
- Added the experimental Adaptive Draft Size control.
- Added the Multimodal Projector Device control.

## 2026-08-22

- Added independent Ngram Map K4V speculative-decoding controls with legacy preset migration.
- Renamed Install to Install and Update.
- Fixed paginated GitHub release discovery for compatible llama.cpp assets.

## 2026-08-19

- Migrated reasoning effort to llama.cpp native support with compatibility handling for older builds.
- Added llama.cpp defaults to the ngram-mod tuning descriptions.

## 2026-08-18

- Documented upstream adaptive MTP draft-depth changes and implementation plans.
- Split ngram-mod into stackable speculative-decoding controls with legacy migration.

## 2026-08-16

- Reworked the custom-fork documentation around the fixed flag-pack product and lifecycle.
- Added a finished state to Quick Launch Hugging Face downloads.

## 2026-08-15

- Updated Draft GPU Layers to use llama.cpp's canonical argument.
- Fixed preset round-tripping for the legacy load-mode choice.

## 2026-08-14

- Documented llama.cpp native reasoning-effort support and migration requirements.
- Added server-wide and per-conversation reasoning controls with compatibility handling.
- Made mmap the default model-load mode and disabled the redundant deprecated control.
- Updated architecture documentation and source/test counts.

## 2026-08-13

- Fixed custom model-folder path handling and follow-up state, refresh, restart, benchmark, and status races.
- Added a validated user-configurable models folder shared by discovery, downloads, launches, previews, and benchmarks.

## 2026-08-12

- Added a deferred custom-model-folder implementation plan.
- Shortened the Nightly app-update label.
- Added preset archiving with per-row, bulk, metadata, API, and restore support.
- Added a manual stable-release workflow for testing, packaging, versioning, and publishing.
- Removed the obsolete Vocoder Model control.
- Added Stable/Nightly app-update selection with safety checks.
- Corrected the README backend list.
- Reworked the sidebar into a compact persistent runtime dock.
- Pinned Ruff to Python 3.9 and documented intentional baseline ignores.

## 2026-08-11

- Updated official AMD install assets to ROCm 7.14 and filtered releases by available backend assets.

## 2026-08-10

- Added a deferred editable launch-command implementation plan.

## 2026-08-07

- Moved Hugging Face companion projectors beside their models and kept them out of the model list.
- Aligned the models route module with the project's import style.

## 2026-08-06

- Fixed server stats KV usage and live speed calculations across current and legacy llama.cpp responses.
- Added frontend coverage for launch, reconnect, reset, and live-generation baselines.

## 2026-08-04

- Added a visual architecture guide covering system structure, routes, flows, persistence, and security.
- Added documentation-sync tests for API routes and corrected route, theme, and architecture documentation.
- Added upstream compatibility tracking documentation.
