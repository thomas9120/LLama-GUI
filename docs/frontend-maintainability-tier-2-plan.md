# Frontend Maintainability Refactor — Tier 2 Plan

> **Status: proposed (2026-09-11).** Tier 1 is complete and recorded in
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

### Tests

Add `tests/frontend/chat_template_selection_unit.cjs` for auto, builtin, bundled,
custom, unsupported, and Windows-path normalization cases. Retain shared-state and
browser coverage for the rendered dropdowns.

### Success criteria

- Configure, Quick Launch, command preview, and persisted presets still resolve
  the same template values.
- `app.js` no longer implements Chat-template mapping or mutation rules.

## Session 2 — split flag definitions by domain

`ui/js/flags/definitions.js` is pure data but is one of the largest and most-edited
frontend files. Split it into a small ordered package, using broad domains rather
than one tiny file per flag category. A candidate grouping is:

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

Do not use pure top-level movement as the final Manager architecture. `app.js`
currently consumes Manager state and functions as bare globals, while Presets and
other modules rely on generic helpers declared in `manager.js`. Establish explicit
owners before distributing the implementation.

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

A candidate package is:

| File | Owner |
|---|---|
| `manager-status.js` | Accepted backend status, request generation, observer/subscription |
| `manager-backends.js` | Backend selection, labels, activation, installed summary |
| `manager-install.js` | Releases, install/repair/remove, progress polling |
| `manager-app-update.js` | Git update status and application update flow |
| `manager-model-dir.js` | Active model-directory controls and operation state |
| `manager-models.js` | Model refresh race guards and known-name cache |
| `manager-lifecycle.js` | Stop/restart/reconnect behavior |
| `manager-main.js` | Configuration, initialization, and public facade assembly |

Each concern should own its mutable state where practical. If a private internal
namespace is needed for ordered classic scripts, use named sub-objects or narrow
facades rather than placing every function and variable in one undifferentiated
registry.

### Success criteria

- No code outside the Manager package reads Manager-private state or calls a bare
  Manager function.
- `app.js` configures and initializes Manager through its facade.
- Existing public Manager keys remain compatible unless a removal is explicitly
  reviewed and documented.

## Session 5 — extract the inference core

The metrics parser, slots normalizer, and `createInferenceStats()` engine are
application services currently housed in `monitor-ui.js`. Move them to
`ui/js/inference-stats.js` with no DOM dependency.

### Changes

- Export parsing, normalization, and engine creation through
  `window.LlamaGui.inferenceStats`.
- Make `app.js` depend on the inference facade directly instead of obtaining its
  engine from Monitor UI.
- Let Monitor consume rendered snapshots from the same facade.
- Temporarily preserve the existing Monitor exports as compatibility delegates if
  that keeps the session behavior-only and reduces blast radius.
- Move the pure inference cases from `monitor_ui_unit.cjs` into
  `inference_stats_unit.cjs`.

### Success criteria

- The inference core can be evaluated and tested without a DOM stub.
- Exactly one polling controller and one target-keyed inference engine remain in
  the main application.

## Session 6 — split Monitor UI and its tests

Candidate package boundaries:

| Module | State / behavior owner |
|---|---|
| Monitor internal/main | Dependencies, initialization, stable public facade |
| Polling | Panel/document visibility, timer, abort controller, last sample |
| System cards | CPU, RAM, disk, and shared metric-card rendering |
| GPU cards | GPU identity, reconciliation, state/setup cards |
| Card preferences | Hidden-card storage, order, keyboard and drag state |
| Terminal | Output lines, trimming, follow-to-bottom behavior |
| Inference rendering | Monitor card and fixed stats-bar rendering |

Use separate closure state or named internal sub-objects for these concerns. Avoid
a package-wide shared state bag unless a value is genuinely shared.

Split `monitor_ui_unit.cjs` along the same boundaries in this session. Shared DOM
fixtures may move to a test helper, but tests should remain runnable independently
and failures should identify the owning concern.

## Session 7 — make `app.js` a composition root

Manager and inference extraction should remove a significant amount of implicit
coupling first. Then reassess `app.js` and extract only the remaining cohesive
mechanisms:

- inference polling, target reconciliation, and abort/timer generations;
- memory-estimate request and rendering state;
- process-output polling if it does not belong in `process-lifecycle.js` or the
  existing output cursor;
- toast rendering only if its multiple consumers justify a stable notification
  facade.

Keep dependency wiring, application startup order, and small coordination callbacks
in `app.js`. The goal is for it to read like the composition diagram of the app,
not to hit an arbitrary line-count target.

## Session 8 — split feature CSS

`ui/css/style.css` is the highest-churn frontend file and should be treated as a
maintainability target, not merely an asset.

### Candidate order

1. base, typography, shell, and layout;
2. shared controls, surfaces, dialogs, and toasts;
3. Configure and command preview;
4. Quick Launch and Hugging Face download;
5. Presets;
6. Chat and Chat window;
7. API, Benchmarking, and Monitor;
8. any deliberately global responsive overrides that cannot live with a feature.

### Rules

- Keep `tokens.css` first and as the only source of theme palettes and color
  literals.
- Load component styles with ordered `<link>` elements; do not use CSS `@import`.
- Keep feature media queries with their feature where cascade behavior permits.
- Mechanically preserve selector declarations and order during the first split.
- Extend theme/style tests to inspect every non-token stylesheet, not only the old
  `style.css` path.
- Update backend static-asset/cache-buster expectations and Pinokio compatibility
  checks if they name the old stylesheet directly.

### Verification

- `node tests/frontend/theme_ui_unit.cjs`
- `npm run test:frontend`
- Visual checks at the responsive widths already covered by Playwright
- `npm test`

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
5. Run full `npm test` before completing the session.
6. Update `docs/directory.md`, `docs/architecture.html`, and the dated changelog
   entry required for program changes.
7. Check Pinokio compatibility whenever static asset paths, script/style loading,
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

- [ ] Session 0: refactor guardrails
- [ ] Session 1: Chat-template selection
- [ ] Session 2: flag-definition package
- [ ] Session 3: shared services and Manager boundary
- [ ] Session 4: Manager package split
- [ ] Session 5: inference core extraction
- [ ] Session 6: Monitor package and test split
- [ ] Session 7: `app.js` composition cleanup
- [ ] Session 8: feature stylesheet package
- [ ] Session 9: Chat-window protocol and host-adapter extraction
- [ ] Session 10: Chat-window coordinator/view package split
