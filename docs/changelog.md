--Changelog--

Please give a brief summary of changes made to the program (excluding documentation changes), include the date the changes were made.

## 2026-09-11

- Improved separate Chat focus and accessible controls, stopped background inference polling after popup close, and kept main GUI navigation available after Chat startup failures.
- Bounded Chat ownership waits and hardened transfer cancellation and detached-window startup failures.
- Hardened separate Chat window recovery and added lifecycle, failure, and compatibility coverage with documented browser limits.
- Fixed hidden main-window Return styling, cleared stale pop-out/return tooltips after ownership transitions, and added persistent blocked/handshake failure guidance.
- Detached Chat failures now establish the isolated Chat shell before validation and offer same-browser full-GUI recovery guidance without starting app activity.
- Added a separate Chat window with shared main-window settings, an ownership-safe return action, and a dedicated Chat bootstrap.
- Added Chat transfer snapshots, ownership guards, and recovery boundaries for the pop-out integration.
- Removed unused CSS for retired controls and preset chips, including an unused status-dot animation.
- Marked the legacy mmap/no-mmap, mlock, and Direct I/O flags as removed in llama.cpp b10875 (PR #28334); they stay available for older builds with --load-mode as the replacement.
- Added a warn-only hint on b10875+ when Legacy load controls or custom args would emit a removed flag, covering the -ndio spelling too.
- Translated benchmark legacy load toggles to --load-mode on b10875+ because llama-bench and llama-perplexity also dropped --no-mmap, -mmp, and -dio.
- Exempted flags marked removed_in from the installed-binary compatibility check on builds at or above the removal tag, keeping npm test green on b10875+ installs.

## 2026-09-10

- Moved each conversation's Delete button beside Rename and Export, replacing the trash icon with text.
- Added opt-in Current Date & Time tool for Chat; small Chat and validation fixes.

## 2026-09-09

- Chat cleanup: delete confirmations, compact copy button, Context panel, focus-mode panels, and conversation management.
- Added character-card import, auto-compaction with recoverable history, exact sampler inputs, and preset-table columns.

## 2026-09-08

- Clarified the `-cram` label as host-RAM prompt caching.

## 2026-09-07

- Added Custom and Custom 02 llama.cpp slots with activation safeguards.
- Added Configure Reset to defaults, Preserve Reasoning Auto mode, and Ngram Simple controls.

## 2026-09-06

- Added live prompt/generation throughput to Monitor and stats bar; stabilized readings.
- Expanded HTTP, telemetry, and browser test coverage; fixed benchmark Stop feedback.

## 2026-09-05

- Rebuilt Quick Launch, standardized Monitor cards/telemetry, reorganized navigation, and polished UI.
- Connected presets to Configure/Quick Launch with comparison and validation; added Restart with changes.
- Hardening and fixes: credentials, inference averages, Chat status, install overflow, Linux polling.

## 2026-09-04

- Added native app launchers, Monitor Live badge, and expanded GPU telemetry.
- Added Chat context metering, manual compaction, and safer retry/regeneration.

## 2026-09-03

- Added Monitor tab with cached telemetry; preset favorites persist across refreshes.

## 2026-09-02

- Added official llama.cpp ROCm 10.0 binaries.

## 2026-09-01

- Added per-slot context limit for unified KV cache.

## 2026-08-31

- Removed Conversation Mode; aligned load mode and tool choices with llama.cpp.

## 2026-08-30

- Faster Hugging Face downloads; updated ROCm/Lemonade install options and lazy tensor flag.

## 2026-08-29

- Reorganized Install and Update layout; hardened downloads and health checks.

## 2026-08-28

- Hardened proxy/DNS/install handling; fixed Auto Fit and added lazy tensor control.

## 2026-08-27

- Added CPU FFN layer control.

## 2026-08-25

- Improved custom-backend handling; added Adaptive Draft Size and Projector Device controls.

## 2026-08-22

- Added Ngram Map K4V controls; renamed Install to Install and Update.

## 2026-08-19

- Migrated reasoning effort to native llama.cpp support.

## 2026-08-18

- Split ngram-mod into stackable controls with migration.

## 2026-08-16

- Reworked custom-fork docs; added download finished state to Quick Launch.

## 2026-08-15

- Updated Draft GPU Layers to canonical arg; fixed preset round-tripping.

## 2026-08-14

- Added reasoning controls; made mmap the default load mode.

## 2026-08-13

- Added configurable models folder; fixed path and state races.

## 2026-08-12

- Added preset archiving and Stable/Nightly app updates; reworked sidebar into runtime dock.

## 2026-08-11

- Updated official AMD assets to ROCm 7.14.

## 2026-08-10

- Planned editable launch-command support (deferred).

## 2026-08-07

- Kept HF projectors beside models, out of the model list.

## 2026-08-06

- Fixed server stats/speed calculations; added launch and reconnect coverage.

## 2026-08-04

- Added architecture guide, doc-sync tests, and upstream compatibility tracking.
