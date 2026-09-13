# Frontend Maintainability Refactor — Tier 2 Plan

> **Status: in progress (2026-09-12).** Sessions 0–8 are complete; Session 9
> (Chat-window protocol and host-adapter extraction) is next. Tier 1 is complete and recorded in
> `docs/frontend-module-split-plan.md`. This document is the source of truth for
> Tier 2 scope, boundaries, implementation order, and verification.

## Goal

Make frontend changes easier to understand, test, and review by giving mutable
state and behavior clear owners, making cross-module dependencies explicit, and
keeping the application bootstrap readable.

Smaller files are useful, but file size is not the primary success metric. A split
that leaves the same bare globals or replaces one closure with a package-wide god
object only improves navigation. Tier 2 should reduce the amount of state and
behavior a maintainer must understand for one change.

## Constraints and principles

- Preserve behavior and the current vanilla JavaScript architecture during each
  session. No framework or bundler is required for Tier 2.
- Keep `ui/index.html` as the canonical frontend load order. Update
  `docs/directory.md` whenever scripts or stylesheets are added or reordered.
- Keep stable `window.LlamaGui` facades for consumers. Private package namespaces
  must not be referenced outside their owning package.
- Prefer one owner for each piece of mutable state. Pass dependencies through a
  narrow `configure()` or constructor/factory boundary instead of relying on bare
  globals declared by an earlier script.
- Preserve per-instance state. A factory closure must not be converted into a
  package singleton merely to follow the Tier 1 Chat recipe.
- Extract pure logic before DOM orchestration when a natural seam exists. Pure
  code is easier to test and can be shared without introducing UI dependencies.
- Complete one coherent session, update its tests and docs, and return the full
  suite to green before starting the next session.
- Keep diffs mechanical inside movement sessions. Do not combine a package split
  with unrelated behavior changes or visual redesigns.
- Treat candidate file lists as provisional. Split where ownership becomes clearer;
  combine concerns where separation would merely add forwarding methods.

## Baseline and priority signals

The 90-day touch counts below are a planning signal captured on 2026-09-11, not a
permanent score. Complexity, ownership, and correctness risk can outweigh churn.

| Area | Approximate size / touches | Maintainability concern |
|---|---:|---|
| `ui/js/app.js` | 1,400+ lines / 45 touches | Composition, polling, memory estimates, output, toasts, and feature wiring share one script |
| `ui/js/flags/definitions.js` | 2,000+ lines / 42 touches | One high-churn data array creates navigation and merge-conflict pressure |
| `ui/js/manager.js` | 1,400+ lines / 30 touches | Install, update, model-directory, model-cache, dialogs, API transport, and shared status are coupled through top-level globals |
| `ui/js/monitor-ui.js` | 2,000+ lines / 22 touches | Pure inference logic, polling, rendering, terminal, preferences, and drag state share one closure |
| `ui/js/chat-window.js` | 2,200+ lines / 10 touches | Low churn, but the ownership/recovery protocol has high correctness and security sensitivity |
| `ui/css/style.css` | about 151 KB / 89 touches | Nearly every feature and responsive rule shares one cascade surface |
| `ui/index.html` | about 143 KB / 77 touches | Large composition document; runtime fragment loading would add initialization risk |

## Implementation order

| Order | Session | Outcome |
|---:|---|---|
| 0 | Refactor guardrails | Package load order, public contracts, and private boundaries become mechanically checked |
| 1 | Chat-template selection | Template mapping and flag application leave `app.js` |
| 2 | Flag-definition package | The large `FLAGS` array is split without changing its final order or authority |
| 3 | Shared services and Manager boundary | Bare transport/dialog/status dependencies gain explicit owners and a stable facade |
| 4 | Manager package split | Install, app update, model directory, model cache, and lifecycle concerns gain focused modules |
| 5 | Inference core extraction | Pure metrics/slot normalization and inference state leave Monitor UI |
| 6 | Monitor package and test split | Polling, cards, terminal, preferences, and rendering gain separate owners |
| 7 | `app.js` composition cleanup | Remaining runtime polling and memory-estimate mechanics leave the composition root |
| 8 | Stylesheet package | Feature CSS is separated while token and cascade contracts remain intact |
| 9 | Chat-window protocol extraction | Pure protocol/validation and the host adapter move first |
| 10 | Chat-window package split | Coordinator, host view, detached view, and public facade are separated without changing per-instance state |

The order is deliberate. Sessions 0–2 are low-risk guardrail/data work. Manager and
Monitor then establish explicit services that allow `app.js` to shrink naturally.
The Chat-window work comes last because its lower churn does not justify taking its
protocol risk before the shared patterns and tests are mature.

## Session 0 — refactor guardrails

### Changes

1. Add a shared frontend test helper that reads ordered script paths from
   `ui/index.html` and can select a package by path prefix. Replace duplicated
   hard-coded Chat and Presets package lists where doing so stays simple.
2. Extend the module contract coverage to verify:
   - every local script tag resolves and evaluates in canonical order;
   - expected public facade keys exist (use exact keys where they are an intended
     compatibility contract);
   - private namespaces such as `_chatInternal` are referenced only inside their
     owning package;
   - package main files load after their internal contributors.
3. Add an aggregate fast unit-test command, leaving Playwright as a separate
   explicit stage and keeping `npm test` as the full gate.

### Verification

- Existing unit tests run through the shared loader without changing behavior.
- `npm run test:frontend:modules`
- `npm test`

## Session 1 — extract Chat-template selection

Create `ui/js/chat-template-selection.js`, loaded after `flag-core.js`, with a
focused `window.LlamaGui.chatTemplateSelection` facade.

### Ownership

- Keep `CHAT_TEMPLATE_PRESETS`, `CHAT_TEMPLATE_PRESET_OPTIONS`, and supported
  built-in data in `ui/js/flags/chat-templates.js`.
- Move path normalization, value/builtin/path lookup, reverse mapping from current
  flags, selection application, and summary text out of `app.js`.
- Configure the module with `flagCore`; all writes must continue through
  `setFlagValue`, `setMultipleFlagValues`, or `applyFlagValues`.
- Inject the new facade methods into Configure and Quick Launch from `app.js`.

### Pitfalls to preserve during extraction

- **Dropdown choices are not the compatibility allowlist.** Keep accepting legacy
  built-in names such as `phi4` through `isSupportedChatTemplateValue()` even when
  absent from the curated options. Preserve the controls' temporary legacy option
  handling. Synthetic bundled values such as `__alpaca__` map to file paths and
  must never be emitted as `--chat-template` names. Unsupported stored values must
  retain the existing launch warning/omission behavior; rendering must not erase
  them or silently migrate saved presets.
- **Template changes must be atomic.** Use one `setMultipleFlagValues()` patch to
  set one template field and clear the other with `undefined`, which deletes the
  stored override. Auto clears both. Preserve the existing
  `preserveCustomTemplateFile` option only in the raw-value fallback branch;
  named builtin, bundled, and Auto selections still clear the competing value.
- **The manual-path rule is outside the extracted helper block.** The
  `flagCore.configure()` `beforePathPatch` hook in `app.js` currently clears
  `chat_template` whenever `chat_template_custom` is edited, including clearing
  the path. Delegate that template-specific rule to the new module while keeping
  the shared hook wiring and unrelated projector logic in `app.js`. Cover both
  typing and file-picker updates without adding another state write/broadcast.
- **Reverse mapping is read-only and must use live state.** Read
  `flagCore.getFlagValues()` on each lookup; preset application can replace the
  state object. Preserve lookup precedence: matching bundled path, direct named
  preset, builtin-name mapping, then supported raw value. For mixed stored values,
  preserve the separate launch rule that a nonblank custom path suppresses
  `--chat-template`; neither rendering nor extraction should repair state.
- **Path normalization is for comparison only.** Preserve trimming and backslash
  conversion without rewriting the user's stored path. Do not add case folding,
  basename matching, absolute-path resolution, or filesystem access. An unrelated
  file named `alpaca.jinja` must not become the bundled Alpaca preset.
- **Loading a module must not apply a selection.** Configure dependencies before
  consumers invoke the facade, and keep evaluation/configuration free of flag
  writes or DOM initialization, including on the detached Chat page. Extend the
  Session 0 namespace and callable-method contracts for the new facade and add
  the new unit suite to `test:unit` so it also runs under `npm test`.

### Tests

Add `tests/frontend/chat_template_selection_unit.cjs` for auto, builtin, bundled,
custom, unsupported, and Windows-path normalization cases. Retain shared-state and
browser coverage for the rendered dropdowns.

Cover transitions between selection modes, both template fields initially set,
the preservation option's branch behavior, manual-path clearing, and lookups after
`applyFlagValues()` replaces state. Assert complete patches and shared-state
notifications, read-only getters, legacy preset round trips, and emitted launch
arguments (at most one of `--chat-template` and `--chat-template-file`). Keep
initialization and Configure/Quick Launch synchronization covered in the browser.

### Success criteria

- Configure, Quick Launch, command preview, and persisted presets still resolve
  the same template values.
- `app.js` no longer implements Chat-template mapping or mutation rules.

## Session 2 — split flag definitions by domain

**Completed (2026-09-12).** Six contiguous domain files now feed the retained
`definitions.js` assembler. Mechanical comparison preserved all 169 flags, their
exact order and metadata, and shared option references. Every harness that loads
real flag definitions now follows the canonical loader. Independent diff review,
`npm test` (including all 22 browser cases), and asset-versioning checks passed.
Pinokio source compatibility was reviewed; its required module paths remain intact.

The original `ui/js/flags/definitions.js` was pure data but was one of the largest
and most-edited frontend files. The split uses a small ordered package of broad
domains rather than one tiny file per flag category:

- model and context;
- CPU, GPU, and auto-fit;
- sampling and RoPE;
- conversation, LoRA, and KV cache;
- speculative decoding;
- server, MCP, grammar, logging, advanced, and experimental;
- a final assembly file defining the single authoritative `FLAGS` array.

### Rules

- Preserve the exact final `FLAGS` order; CLI argument order depends on it.
- Reuse the existing shared option constants. Do not duplicate definitions or
  create per-tab flag arrays.
- Update every VM harness that currently assumes one `definitions.js` source.
- During the split, mechanically compare the assembled array with the original
  array before deleting the old file.

### Verification

- `npm run test:flag-definitions`
- `npm run test:flags`
- `node tests/frontend/launch_args_unit.cjs`
- `npm run test:frontend:modules`
- `npm test`

## Session 3 — establish shared services and the Manager boundary

**Completed (2026-09-12).** Shared `apiClient` and `dialogs` facades now own JSON
transport and confirmation/prompt behavior. Manager state is closure-local;
`configure()`, idempotent `init()`, and `getLatestStatus()` provide the boundary.
Consumers receive explicit services and live status providers, and Manager receives
callbacks for Presets notifications and Quick Launch synchronization. Existing
Manager exports remain compatible, including the shared `fetchJson` alias.
Tests use public methods or gated hooks without assigning Manager-private state.
Independent review, the full `npm test` (all 22 browser cases), documentation links,
and asset-versioning checks passed. Pinokio source compatibility was reviewed;
its required paths and entrypoints remain intact.

Do not use pure top-level movement as the final Manager architecture. Before this
session, `app.js` consumed Manager state and functions as bare globals, while
Presets and other modules relied on generic helpers declared in `manager.js`.
Establish explicit owners before distributing the implementation.

### Shared services

- Move `fetchJson()` to a small API-client facade. Preserve
  `window.LlamaGui.manager.fetchJson` as a compatibility alias while consumers are
  migrated through injected dependencies.
- Move `confirmAction()` and `promptAction()` to a dialog facade. Configure
  Presets, sampler presets, and other consumers explicitly instead of relying on
  global lexical lookup.
- Leave feature-specific status boxes and folder actions with the feature that
  renders them unless another real consumer justifies a shared service.

### Manager facade

- Add `configure()`, `init()`, and `getLatestStatus()` to the Manager boundary.
- Replace bare `latestStatus` reads in `app.js` with the accessor or an injected
  status provider.
- Let Manager wire Manager-owned install/update/model-directory controls from
  `manager.init()`; `app.js` should not know every internal action function.
- Replace the forward reach from Manager into the later-loaded Presets package
  with an injected callback or narrow subscription.
- Preserve request-generation guards, installation polling cleanup, and the
  distinction between an unknown and known-empty model cache.

### Tests

Update Manager tests to use the public facade or explicit test hooks. Do not retain
bare-global mutation only to make the old harness convenient.

## Session 4 — split the Manager package

**Completed (2026-09-12).** Nine ordered package files replace `manager.js`,
preserving the public facade and app startup sequence. Mechanical comparison of
all 61 original function bodies found no changes beyond namespace qualification
and the two release-cache owner methods. Manager harnesses now load the package
canonically, and a new lifecycle suite covers inert loading/configuration, live
dependencies after initialization, quit/restart behavior, and app-update restart
handoff. Diff review, full `npm test` (all 22 browser cases), documentation links,
and asset-versioning checks passed. The local Pinokio launcher's source compatibility
checker passed against this checkout; a native supervised-restart smoke was not run.

The package lives in `ui/js/manager/`, with `manager-internal.js` loading first
to establish private dependency links and `manager-main.js` loading last. Each
concern keeps its mutable state in its own closure; the internal namespace exposes
named method groups, not state fields. Configuration and script evaluation remain
inert, and cross-concern calls read current dependencies and accepted status.

Package ownership:

| File | Owner |
|---|---|
| `manager-internal.js` | Private package links and injected dependencies |
| `manager-status.js` | Accepted backend status, request generation, observer/subscription |
| `manager-backends.js` | Backend selection, labels, activation, installed summary |
| `manager-install.js` | Releases, install/repair/remove, progress polling |
| `manager-app-update.js` | Git update status and application update flow |
| `manager-model-dir.js` | Active model-directory controls and operation state |
| `manager-models.js` | Model refresh race guards and known-name cache |
| `manager-lifecycle.js` | GUI-server shutdown, restart, and reconnection |
| `manager-main.js` | Configuration, initialization, and public facade assembly |

Keep llama-process launch, stop, switching, and readiness orchestration owned by
the existing `ui/js/process-lifecycle.js`.

Each concern should own its mutable state where practical. If a private internal
namespace is needed for ordered classic scripts, use named sub-objects or narrow
facades rather than placing every function and variable in one undifferentiated
registry.

### Extraction guardrails

- Keep release-cache invalidation and backend-specific fetch deduplication in
  installation; backend presentation calls narrow methods for those operations.
- Preserve status acceptance, rendering, and asynchronous observer ordering,
  including re-reconciliation after a newer status supersedes an awaited observer.
- Preserve model-cache unknown/known-empty semantics, stale callers adopting the
  newest refresh, and notification timing after cache changes.
- Keep initialization idempotent and preserve the detached-Chat early exit in
  `app.js`; package loading must not start polling or bind controls.
- Retain the complete public Manager facade and gated test hooks. Unit harnesses
  load the package in canonical `index.html` order; private-namespace and assembler
  checks cover the new package.

### Success criteria

- No code outside the Manager package reads Manager-private state or calls a bare
  Manager function.
- `app.js` configures and initializes Manager through its facade.
- Existing public Manager keys remain compatible unless a removal is explicitly
  reviewed and documented.

## Session 5 — extract the inference core

**Completed (2026-09-12).** Extracted the unchanged parser, slots normalizer, and
per-instance inference engine into the DOM-free inference facade, loaded before
Monitor. `app.js` uses that facade directly; Monitor retains compatibility aliases
and both snapshot renderers. Moved every pure inference case to its own DOM-free
suite, added independent-instance/inertness coverage, and strengthened the browser
check for continuing hidden-host inference, host-only requests, no popup engine,
and paused system telemetry. Mechanical comparison confirmed the moved bodies and
existing cases are unchanged. Diff review, full `npm test` (all 22 browser cases),
documentation links, asset-versioning checks, and the local Pinokio compatibility
checker passed. Native supervised-restart smoke was not run.

The metrics parser, slots normalizer, and `createInferenceStats()` engine are
application services extracted from `monitor-ui.js` into
`ui/js/inference-stats.js` with no DOM dependency.

### Changes

- Export parsing, normalization, and engine creation through
  `window.LlamaGui.inferenceStats`.
- Make `app.js` depend on the inference facade directly instead of obtaining its
  engine from Monitor UI.
- Have the pure engine emit data snapshots; UI modules render the same shared
  snapshot in Monitor and the fixed stats bar.
- Temporarily preserve the existing Monitor exports as compatibility delegates if
  that keeps the session behavior-only and reduces blast radius.
- Move the pure inference cases from `monitor_ui_unit.cjs` into
  `inference_stats_unit.cjs`.

### Extraction guardrails

- Keep polling, target reconciliation, abort/timer generations, and visibility
  coordination in `app.js` until Session 7. Keep both renderers in Monitor until
  Session 6; only parsing, normalization, and per-instance state move here.
- Preserve fresh-launch versus restored-target baselines, paired token/time
  averages, batched prompt sampling, task identity, counter rollback, and the
  15-second live-sampling cutoff. Metrics and slots remain independently available;
  empty slots must not become indistinguishable from unavailable slots.
- Keep the two small numeric helpers private to both owning modules; the inference
  core must not acquire a dependency on Monitor formatting.
- Preserve the three Monitor methods as aliases of the new facade, with no second
  implementation or engine instance. Use canonical script order in the Monitor
  test harness, and retain rendering cases when moving the pure engine tests.

### Success criteria

- The inference core can be evaluated and tested without a DOM stub.
- Exactly one inference polling controller and one target-keyed inference engine
  remain in the main application, separate from Monitor system telemetry polling.
- Preserve and test the visibility distinction: the hidden host continues inference
  polling while detached Chat is open; system telemetry retains its existing
  panel/document visibility gates. The detached window consumes host snapshots
  without starting another inference poller.

## Session 6 — split Monitor UI and its tests

**Completed (2026-09-12).** Nine ordered package files replace `monitor-ui.js`,
retaining the public facade and inference-core aliases. Polling and preferences
keep separate closure state. Mechanical comparison found 84 of 88 original
functions unchanged apart from namespace qualification; the remaining four contain
sample-interval access, drag deferral, reset delegation and initialization wiring.
Reassembling initialization confirmed its original operation order. All original
scenario bodies were retained across independent concern suites with fresh fixtures.
The 35 Monitor cases include added inertness/live-dependency, ignored-abort and
detached-document checks. Diff review, full `npm test` (all 22 browser cases),
documentation links, asset-versioning checks and the local Pinokio compatibility
checker passed. Native supervised-restart smoke was not run.

The package lives in `ui/js/monitor/`, with `monitor-internal.js` first and
`monitor-main.js` last. Each concern owns its mutable state; internal method groups
provide the links between concerns, and dependencies are read live after configuration.

| Module | State / behavior owner |
|---|---|
| `monitor-internal.js` / `monitor-main.js` | Dependencies, initialization, stable public facade |
| `monitor-dom.js` | Shared formatting, text updates, metric rows and progress meters |
| `monitor-polling.js` | Panel/document visibility, timer, abort controller, generation, last sample and live badge |
| `monitor-system.js` | CPU, RAM, disk and accepted-sample presentation |
| `monitor-gpu.js` | GPU identity, in-place reconciliation, state/setup cards |
| `monitor-preferences.js` | Hidden-card storage, order, keyboard/drag state and deferred sample |
| `monitor-terminal.js` | Runtime/header presentation, output lines, trimming and follow-to-bottom behavior |
| `monitor-inference.js` | Monitor card and fixed stats-bar rendering |

### Extraction guardrails

- Keep GPU nodes, text selection, focus, setup disclosures and restore controls
  stable across unchanged samples. Preferences own the latest deferred sample
  during dragging and flush it once after the drag ends.
- Preserve bounded storage, persistent GPU identities versus session-only index
  identities, and relative order between static cards and reconciled GPU cards.
- Keep system telemetry's visibility gates, Recheck cache bypass, abort/generation
  guards and badge behavior. The polling owner exposes the accepted sample interval
  through a narrow method for system-card labels.
- Keep both inference renderers on the shared snapshot, including the supplied
  target document for detached Chat. Inference polling, lifecycle actions, input-row
  visibility and output cursors remain with their existing owners until Session 7.
- Preserve the complete Monitor facade, including inference-core aliases and the
  existing test reset method. Loading/configuration stay inert, and initialization
  retains its existing call order.
- Replace the monolithic Monitor suite with concern-specific suites using fresh
  VM/DOM/storage fixtures per scenario and canonical package loading. Retain the
  original assertions and cross-concern interaction coverage; do not rely on
  listeners or configuration inherited from a preceding case.

## Session 7 — make `app.js` a composition root

**Completed 2026-09-12.** Extracted four focused modules and retargeted the existing
browser harnesses. Diff review confirmed 19 moved functions unchanged apart from
dependency qualification; reassembling the output callbacks matched the original
poller except for the tested stale-response guard described below. All 21 new
orchestration cases and full `npm test` passed, including all 22 browser cases.
Documentation links, asset-versioning checks and the local Pinokio compatibility
checker also passed. Native supervised-restart smoke was not run.

The implementation extracts four focused modules, with `app.js` retaining
configuration, startup order, launch/stop coordination, accepted-status sequencing,
and shared snapshot distribution:

| Module | Ownership |
|---|---|
| `memory-estimate-ui.js` | 700 ms debounce, request generation, shared-argument reads and sidebar rendering |
| `notifications.js` | Toast rendering, safe text, dismissal, actions, durations and stack limits |
| `inference-polling.js` | Instance-owned transport, timers, abort/epoch state, target reconciliation and external connection revisions |
| `process-output.js` | Instance-owned output cursor, interval, overlap guard and retries; app callbacks handle lifecycle/UI effects |

### Extraction guardrails

- Keep module loading, configuration and factory creation inert. Create the inference
  engine and both pollers only on the main page; detached Chat consumes host snapshots.
- Route document visibility and popup changes through one inference polling method.
  Hidden hosts keep inference polling while detached Chat is open, while system
  telemetry retains its document/panel gates. Pausing keeps the target and baseline;
  stopping invalidates the epoch and clears the target.
- Preserve fresh-launch versus restored-target baselines, GUI readiness checks,
  external reconnect revisions, independent metrics/slots availability, and stale
  rejection after transport and asynchronous body parsing.
- Preserve output cursor handoff, clear-without-replay, overlap/retry behavior, and
  application ordering for exit, connection loss and delayed runtime restoration.
  Benchmark polling keeps its current owner; the shared cursor stays transport-free.
- Reject superseded output responses before runtime-generation reconciliation as
  well as before cursor consumption. A new regression test exposed the prior race
  where an old process response could reset the replacement process's cursor; the
  extraction adds an immediate post-fetch epoch check.
- Retarget browser tests that used bare polling globals to instance methods and
  explicitly gated test hooks. Keep timer/controller details private in production
  and retain the browser assertions for host/popup ownership and recovery.
- Use focused controlled-clock tests for estimate and polling races, plus the full
  browser suite for startup, lifecycle, Monitor, toast and detached-Chat integration.

## Session 8 — split feature CSS

**Completed (2026-09-12).** Canonical link-order reconstruction reproduced the
original CSS byte for byte apart from the duplicate token import. Chromium's
parsed rule order/content matched, and 60 fixed-DOM before/after screenshots were
pixel-identical across the widths, themes and views described below. The full
`npm test` passed, including all 22 interactive browser cases. The backend suite
ran 811 tests successfully with three skips, including asset-versioning and
reference checks. The local Pinokio source compatibility checker passed; native
supervised-restart smoke was not run. Ownership, theme guardrails and test coverage
are documented in the project reference, `AGENTS.md` and `docs/tests.md`.

Ten ordered component stylesheets replace the former 5,003-line `ui/css/style.css`.
The package preserves contiguous sections in their original order:

1. `base-shell.css` — reset, typography, shell and sidebar;
2. `shared-controls.css` — badges, cards, forms, buttons and help;
3. `quick-launch.css` — Quick Launch and Hugging Face downloads;
4. `configure.css` — code blocks, Configure and shared launch/output presentation;
5. `runtime-tools.css` — progress, API and Benchmarking;
6. `presets.css` — preset library and installed info;
7. `shared-overlays.css` — dialogs, scrollbars, tooltips, stats bar and toasts;
8. `chat.css` — Chat and detached-window presentation;
9. `responsive.css` — mobile toggle and mixed-feature responsive overrides;
10. `monitor.css` — Monitor and its media queries.

`tokens.css` stays unchanged and loads first. The duplicate token import formerly
at the start of `style.css` is removed; every stylesheet now loads once through an
unconditional link in `index.html`. Backend asset discovery already handles these
links, so production backend code and the Pinokio launcher need no changes.

### Extraction guardrails

- Preserve selector declarations, enclosing at-rules and their order across the
  concatenated stylesheets. Monitor still follows the mixed responsive blocks;
  shared rules remain in their original neighboring sections.
- Treat further regrouping or colocation of feature media queries as a separate
  cascade change with its own visual checks. No selector cleanup or redesign is
  part of this extraction.
- Keep tokens as the only source of theme palettes and color literals. Theme tests
  discover all local CSS links from `index.html`, require tokens first and reject
  duplicate, missing, orphaned, conditional or imported stylesheets. Existing
  fill-token and placeholder checks now inspect every component stylesheet.
- Keep the same stylesheet order for main and detached Chat documents. The backend
  asset-versioning fixture covers tokens and a component file; the existing asset
  discovery test checks every local link.

### Verification

- One-time reconstruction from canonical link order must reproduce the original
  CSS exactly except for the duplicate import; `tokens.css` must be unchanged.
- Compare browser-parsed rule order and content, then fixed-DOM before/after views
  at 390/900/1440px with Tokyo and Cappuccino themes, including populated Chat,
  Monitor, detached presentation and overlays. Use the existing interactive
  browser suite for responsive transitions, focus and popup ownership.
- Run the theme suite, full `npm test`, backend asset-versioning and documentation
  checks, and the local Pinokio source compatibility checker.

## Sessions 9–10 — split Chat-window safely

### Session 9: pure protocol and adapter extraction

Move protocol constants, JSON safety/copying, allowlist validation, result helpers,
and `createHostAdapter()` into focused package files. These have natural inputs and
outputs and can move without changing coordinator state.

Add or preserve tests for sensitive-key rejection, allowed runtime/inference shapes,
session invalidation, and adapter subscriptions.

### Session 10: coordinator and view package

Candidate package:

- protocol and serialization;
- host adapter;
- coordinator factory;
- flag-core bridge;
- host-window view/bootstrap;
- detached-window view/bootstrap;
- public facade.

The state declared inside `createCoordinator()` must remain local to each coordinator
instance. Do **not** apply the Tier 1 Chat package's single shared `S` object to this
factory. Multiple coordinators are used by tests and are part of the design.

Document and test these invariants explicitly:

- at most one workspace owner;
- lock ownership is required whenever Web Locks are available;
- an unverified or wrong-origin peer cannot transfer state;
- recovery revisions never move backward;
- a disposed coordinator cannot reacquire ownership or mutate the workspace;
- failed or timed-out transfer leaves a recoverable, non-resending state;
- secrets and unknown fields never cross the window protocol.

Retarget the Chat-window VM and pop-out integration harnesses to the ordered package
and keep the real browser transfer/reload suite as the acceptance gate.

## Cross-cutting verification for every program session

1. Run `node --check` for every changed or added JavaScript file.
2. Run the focused unit tests named by `docs/tests.md`.
3. Run `npm run test:frontend:modules` for script order and facade availability.
4. Run `npm run test:frontend` for DOM wiring, mirrored state, and pop-out behavior
   when those areas are touched.
5. Run `npm test` before completing the session; this is the full frontend gate,
   not the backend suite.
6. Update `docs/directory.md` for ownership and load-order changes,
   `docs/tests.md` for test coverage and commands, and this plan's completion
   checklist and status as sessions finish.
7. Run `.venv/Scripts/python.exe -m unittest tests.backend.test_docs_links -v`
   after documentation-reference changes.
8. When backend code changes, including static-asset or cache-buster handling, run
   `.venv/Scripts/python.exe -m unittest discover tests -v`. Use the project venv
   (`.venv/bin/python` on Unix).
9. Check Pinokio compatibility whenever static asset paths, script/style loading,
   startup, shutdown, or cache busting changes.

## Explicit non-goals for Tier 2

- No UI redesign or behavior changes mixed into movement sessions.
- No general event bus, dependency-injection framework, or speculative abstraction.
- No runtime fetching of HTML fragments. `ui/index.html` is large, but asynchronous
  fragment loading would make DOM availability and bootstrap ordering harder to
  reason about. If HTML composition becomes necessary, prefer a deliberate
  build-time approach with a reproducible generated artifact.
- No requirement to adopt ES modules, TypeScript, a bundler, or a frontend framework.

## Longer-term direction after Tier 2

Two follow-ups may be worthwhile once the boundaries above are stable:

1. Add JSDoc types and incremental `// @ts-check` coverage for dependency objects,
   state shapes, protocol messages, and public facades. Syntax checks cannot detect
   a misspelled cross-file method such as `I.someMethod`.
2. Evaluate native browser ES modules behind the existing `window.LlamaGui` facades.
   Native modules could eventually provide explicit imports and true privacy without
   requiring a bundler, but mixing module and classic-script initialization should be
   handled as its own architectural project rather than folded into Tier 2.

## Completion checklist

- [x] Session 0: refactor guardrails
- [x] Session 1: Chat-template selection
- [x] Session 2: flag-definition package
- [x] Session 3: shared services and Manager boundary
- [x] Session 4: Manager package split
- [x] Session 5: inference core extraction
- [x] Session 6: Monitor package and test split
- [x] Session 7: `app.js` composition cleanup
- [x] Session 8: feature stylesheet package
- [ ] Session 9: Chat-window protocol and host-adapter extraction
- [ ] Session 10: Chat-window coordinator/view package split
