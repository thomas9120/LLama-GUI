# Editable Launch Command Tab Implementation Plan

**Status:** Planned; implementation intentionally deferred

**Created:** 2026-08-10

**Scope:** Frontend command editing and shared-state synchronization for `llama-server` and `llama-cli`

## Summary

Add a separate Command Editor tab that presents the active llama.cpp launch command as four coordinated segments:

1. The executable name, selected by Llama-GUI and not directly editable.
2. GUI-managed arguments, editable as command text and synchronized with existing controls.
3. Additional/custom-backend arguments, editable as opaque shell-like text.
4. The generated local main-model argument, selected through the shared model picker and not directly editable.

The command text must not become a second persistent source of launch state. `window.LlamaGui.flagCore` remains authoritative for the active tool, selected model, structured flag values, and additional arguments. Applying a command draft parses the complete draft first and then commits one atomic shared-state update. Existing Configure, Quick Launch, Chat, API, command preview, memory estimate, presets, and launch flows continue to read from `flagCore.getLaunchArgs()`.

The initial implementation will preserve launch semantics, not exact textual formatting. Applying a draft may normalize flag aliases, ordering, whitespace, numeric spelling, and quoting.

## Current Architecture

The existing design already provides most of the forward command pipeline:

- `ui/js/flag-core.js` owns `currentTool`, `selectedModel`, and `flagValues`.
- Shared writes use `setFlagValue()`, `setMultipleFlagValues()`, `setPathFlagValue()`, or `applyFlagValues()`.
- `buildLaunchArgs()` serializes structured state into launch tokens.
- `parseCustomLaunchArgs()` tokenizes shell-like additional arguments, including quoted values and Windows paths.
- `updateCommandPreview()` creates a copyable, sensitive-value-redacted command.
- `ui/js/app.js` refreshes mirrored controls after shared-state changes.
- `ui/js/process-lifecycle.js` sends `{ tool, args }` to `POST /api/launch`.
- The backend chooses the executable itself and starts it with `subprocess.Popen()` without a shell.
- A custom backend resolves its executable from `llama/custom/bin/`; it does not replace the frontend `FLAGS` registry.
- Unknown arguments already pass through `flagValues.custom_args` without a backend allowlist.

The missing capability is a safe inverse transformation from edited command tokens back into exact shared flag state.

## Goals

- Add a dedicated Command Editor tab without changing the normal Configure or Quick Launch workflows.
- Keep `flagCore` as the only authoritative launch-state model.
- Synchronize recognized command edits back to Configure, Quick Launch, Chat sampler controls, API previews, presets, and launch arguments.
- Reflect changes from other tabs in the command editor whenever it has no unsaved draft.
- Preserve backend-specific and otherwise unknown arguments without requiring Llama-GUI to understand their schema.
- Keep the executable and generated local main-model path outside directly editable command text.
- Preserve current sensitive-value redaction and preset restrictions.
- Block every launch entry point while an unapplied or invalid command draft exists.
- Reuse the existing `/api/launch` contract and process lifecycle.
- Normalize commands predictably after Apply and explain that behavior in the UI.

## Non-Goals for the Initial Release

- Byte-for-byte preservation of whitespace, comments, quote style, aliases, or flag ordering.
- Running arbitrary shell commands, pipelines, redirections, environment assignments, or alternate executables.
- Automatically discovering a complete flag schema from a custom binary's `--help` output.
- Generating Configure controls for unknown custom-backend flags.
- Supporting custom tools other than the existing allowed `llama-server` and `llama-cli` executables.
- Changing the preset schema solely to identify a custom backend or fork.
- Treating frontend model locking as a security boundary for direct callers of `/api/launch`.
- Refactoring the launch pipeline into a general command AST.
- Adding a backend endpoint specifically for command parsing or validation.

## Core Design Decisions

### Shared Structured State Remains Authoritative

Do not add a persistent `manualCommand`, `commandTokens`, or per-tab copy of flag state.

The authoritative values remain:

- `flagCore.getCurrentTool()`
- `flagCore.getSelectedModel()`
- `flagCore.getFlagValues()`
- `flagValues.custom_args` for additional opaque arguments

The editor's textarea values are transient drafts only. Once Apply succeeds, regenerate the draft from shared state and mark it clean.

### Semantic Round Trip, Not Textual Round Trip

These inputs are semantically equivalent and may normalize to one canonical form:

```text
--temp=.70   -c "64000"
```

```text
-c 64000 --temp 0.7
```

The UI must explain that Apply normalizes the command. Copy Command always copies the normalized, effective launch command.

### Explicit Apply Instead of Live Mutation

Typing must not update shared state on every keystroke. Partial values, unmatched quotes, and unfinished escapes are normal while editing and must not temporarily corrupt the rest of the UI.

Provide these actions:

- **Apply edits:** Parse, validate, atomically commit, and refresh every mirrored view.
- **Apply & Launch:** Apply first; call the existing launch path only if Apply succeeds.
- **Discard & Reload:** Replace the draft with the latest shared state.
- **Copy command:** Copy the effective normalized command, not an invalid unapplied draft.

`Ctrl+Enter` / `Cmd+Enter` should Apply. On validation failure, focus the first invalid area. Normal textarea undo must continue to work.

### Segmented Command UI

Do not use one `contenteditable` element with partially non-editable spans. Use ordinary accessible controls styled as one command composition.

Recommended layout:

```text
Executable (locked)
llama-server.exe

Synchronized arguments
-c 64000 --temp 0.7 --flash-attn

Additional / custom-backend arguments
--fork-feature enabled --special-cache 12

Model source (locked)
-m models/example.gguf
```

The tab should also include:

- The shared tool selector.
- The shared model selector or a button that focuses the existing model selection workflow.
- A backend badge based on the latest authoritative status.
- Inline validation and normalization notices.
- Existing Launch/Stop controls wired through the shared lifecycle.

Move the existing Custom Launch Args panel from Configure into the new tab. Do not leave two free-form additional-argument editors.

## Protected Command Segments

### Executable

The executable is display-only command state:

- Its logical value comes from `currentTool`.
- Its displayed suffix comes from backend status.
- The backend remains authoritative for the actual executable path.
- Pasting an alternate executable into an argument editor must not make it executable.

Optional paste convenience may remove an exact leading `llama-server`, `llama-server.exe`, `llama-cli`, or `llama-cli.exe` token after confirming it matches the selected tool. A mismatch is an error. Do not support arbitrary executable paths.

### Main Local Model

The initial protected-model scope is the automatically generated local main-model argument:

- `-m models/<selected-relative-model>`
- `--model models/<selected-relative-model>` when parsing long-form input

The selected value continues to come from the shared model picker and `normalizeModelRelPath()`.

Reject attempts to insert a local main-model argument into either editable argument area. This prevents a visibly locked model from being overridden later in the token list.

Other existing model-related settings remain editable because they are already first-class Configure state:

- Hugging Face repository/file settings
- Remote model URLs, if exposed by the active definitions
- Draft model paths
- Multimodal projector paths or URLs
- Vocoder model paths

If the policy later expands to every model-like path, treat that as a separate compatibility decision because it would remove existing advanced capabilities.

Frontend locking is a UI invariant, not a security boundary. Backend model-root enforcement, if desired, belongs in a later separately audited phase.

## Command Parsing and Application

### Pure Parser Contract

Add a pure parser in `ui/js/flag-core.js` with a result approximately shaped like:

```javascript
{
    values: {},
    customArgs: "",
    warnings: [],
    error: null,
}
```

Inputs should include the active tool, managed draft, additional-argument draft, and current shared state for values that must be preserved. The parser must not mutate `flagValues`, the DOM, or caller-provided objects.

### Active Flag Lookup

Build a lookup from definitions eligible for the active tool:

- Positive `flag` token.
- Optional negated `false_flag` token.
- Definition id, type, options, limits, sensitivity, and tool eligibility.

Use exact case-sensitive token matching; `-c` and `-C` are different. Support `--flag value` and `--flag=value` when unambiguous. Do not implement bundled short flags unless llama.cpp defines the exact token.

### Type Conversion

Parse recognized definitions according to their existing types:

- `bool`: positive flag means `true`; `false_flag` means `false`.
- `int`: require a finite integer and enforce declared bounds.
- `float`: require a finite number and enforce declared bounds.
- `enum`: require one declared option value.
- `multi_enum`: split the existing comma representation and validate each option.
- `text`: consume one value token.
- `path`: consume one value token without frontend platform-specific rewriting.
- `text_list`: collect repeated occurrences in command order.

Missing values are errors. A value beginning with `-`, such as `-1`, remains a value when it follows a recognized value-taking flag.

### Serializer Special Cases

The inverse parser must mirror special behavior already present in `buildLaunchArgs()`, including:

- GPU layer normalization.
- `kv_unified` positive/negative forms.
- The legacy `preserve_thinking` JSON emission path.
- Repeated text-list flags.
- Chat-template/custom-template precedence.
- Mirostat-dependent fields.
- Flags omitted at inert defaults.
- Stale `ctx_size_draft` remaining inert and never emitting `-cd`.

Keep forward and inverse launch semantics together in `flag-core.js`, not in the DOM module. Cover every non-trivial special case with a round-trip test.

### Deletion and Atomic Application

Deleting a recognized flag from the managed command must remove it from the active tool's exact shared state. It must not immediately reappear because `getDefaultValues()` normally seeds a new session.

The Apply operation cannot call the current default-merging `applyFlagValues()` directly. Add a dedicated atomic operation that:

1. Clones current state.
2. Removes definitions eligible for the active tool.
3. Preserves definitions belonging only to the inactive tool.
4. Applies parsed active-tool values.
5. Replaces `custom_args` with the additional-argument result.
6. Preserves sensitive values represented by an unchanged placeholder.
7. Replaces shared state once.
8. Runs normal `afterApply` and one forced `postUpdate` synchronization.

No mutation occurs when parsing or validation fails.

### Duplicates

For repeated recognized flags that are not intentionally repeatable:

- Use the last occurrence.
- Warn that Apply normalized multiple occurrences into one shared value.
- Do not preserve earlier duplicates in `custom_args`; moving them after managed arguments could change which occurrence wins.

Intentionally repeatable `text_list` flags retain all values.

### Unknown Arguments

Unknown arguments remain launchable through `custom_args`. The dedicated Additional / Custom Backend Arguments area is their preferred home.

If unknown tokens appear in the synchronized area, Apply may move them into the additional area and show a notice. Do not guess their type, options, repeatability, or sensitivity.

If an unknown flag's value is identical to a known flag token, its arity is inherently ambiguous without a custom schema. Reject that ambiguous draft with an explanation rather than guessing.

### Shell Syntax Boundary

This is a llama.cpp argument editor, not a system shell. Continue supporting the existing tokenizer's whitespace, quotes, selected escapes, and Windows paths.

Do not interpret pipes, command chaining, redirection, environment expansion, command substitution, globs, or shell comments.

## Dirty Draft and Cross-Tab Synchronization

### Transient Editor State

`ui/js/command-editor-ui.js` may keep only:

- `dirty`: the DOM draft differs from the last rendered shared state.
- `stale`: shared state changed after the draft became dirty.
- `applying`: the Apply-triggered update must not mark its own draft stale.

Do not keep a JavaScript copy of every flag value in this module.

### Refresh Rules

When shared state changes:

- Regenerate a clean editor immediately.
- Preserve a dirty draft and mark it stale.
- If the active tool or selected model changes while dirty, require Discard & Reload before Apply; never reinterpret the draft silently.

The stale notice must explain the conflict and allow the user to copy their draft before discarding it.

### Launch Guard

Every manual launch path must share one guard:

- Configure Launch
- Quick Launch
- Sidebar Launch
- Command Editor Apply & Launch
- Future buttons that use the manual launch-request builder

If the editor is dirty, stale, or invalid, stop before `/api/launch` and show an actionable message. Put this check in the shared launch-request path, not in each button handler.

## Custom Backend Behavior

### Initial Support

No backend change is required to pass custom flags. The existing custom backend already:

- Uses standard `llama-server[.exe]` and `llama-cli[.exe]` names from `llama/custom/bin/`.
- Receives the same argument array as an official backend.
- Does not require arguments to exist in the mainline `FLAGS` registry.

When status reports `backend: "custom"`:

- Label the additional area **Custom backend arguments**.
- Explain that these arguments launch normally but have no synchronized Configure controls.
- Do not reject unknown flags merely because mainline llama.cpp does not define them.

For official backends, label the same area **Additional arguments** and retain the warning that unsupported arguments may make llama.cpp reject the launch.

### Name Collisions

If a custom backend reuses a mainline flag name with different semantics, the initial parser treats it as the mainline definition. Explicit override information is required to do otherwise.

Do not infer overrides from `--help`; help text does not reliably describe arity, limits, enums, repeatability, negated forms, sensitivity, or tool eligibility.

### Deferred Custom Flag Manifest

Only add a sidecar manifest after real custom backends require structured custom controls or name overrides. A possible future file could describe additions such as:

```json
{
  "name": "Example llama.cpp fork",
  "flags": [
    {
      "id": "custom_special_cache",
      "flag": "--special-cache",
      "type": "int",
      "tool": "server"
    }
  ]
}
```

Manifest validation, delivery, override rules, and security treatment are intentionally deferred.

## Sensitive Values

Do not place real known sensitive values into a plain command textarea.

For definitions marked `sensitive`:

- Render a masked or protected command segment.
- Edit through existing sensitive-input behavior.
- Preserve the value when parsing an internal unchanged placeholder.
- Never copy the real secret through Copy Command.
- Never launch a redaction placeholder literally.

Existing API-key behavior remains authoritative: real keys may remain in memory for an active launch, previews stay redacted, and presets must not persist `api_key` or sensitive Custom Launch Args.

Unknown custom-backend arguments cannot automatically be classified as sensitive. Warn that opaque additional arguments are plain text and may enter preset data unless an existing rule rejects them. A future manifest may add sensitivity metadata.

## Presets, Benchmarking, and Other Consumers

### Presets

No initial schema change is needed:

- Recognized edits use existing flag ids.
- Unknown arguments remain under `flags.custom_args`.
- Current sensitive-argument rejection remains unchanged.
- Existing custom-argument warnings remain useful.

When loading a preset with additional args under an official backend, preserve the args and warn. Do not add only `backend: "custom"` to presets because that does not identify a fork or version.

### Benchmarking

Preserve the current safety rule that excludes Custom Launch Args:

- Recognized edits flow through benchmark-compatible structured state.
- Opaque backend-specific arguments stay excluded unless benchmarking later gains an explicit reviewed opt-in.

### Quick Launch, Chat, and API

After Apply:

- Quick Launch and Chat refresh from `flagCore`.
- Command previews regenerate from `flagCore.getLaunchArgs()`.
- Server URL, API examples, and memory estimates refresh from shared state.
- No new sampler, template, model, or tool copies are introduced.

## Backend Impact

The initial implementation should require no backend route or service changes. The backend already validates the tool, resolves the executable, prepends it itself, uses `subprocess.Popen()` without a shell, and redacts known sensitive values from returned command text.

Possible later backend work:

- Enforce that local main-model paths resolve under `models/` for GUI-originated launches.
- Add a launch-context marker if enforcement must distinguish GUI launches from other consumers.
- Load and validate an optional custom flag manifest.

Audit model switching, remote model sources, draft models, projectors, benchmarking, and direct API callers before adding backend model restrictions.

## Planned File Changes

| File | Planned responsibility |
|---|---|
| `ui/js/flag-core.js` | Pure inverse parser, flag lookup, canonicalization, protected-model validation, and atomic exact-state Apply. |
| `ui/js/command-editor-ui.js` | New module for command rendering, dirty/stale state, events, errors, Apply/Discard/Copy, and launch readiness. |
| `ui/js/app.js` | Configure the module, include it in shared refresh paths, and add the centralized launch guard. No new globals. |
| `ui/index.html` | Add the navigation item and panel, move Custom Launch Args from Configure, and load the new script. |
| `ui/css/style.css` | Command layout and dirty/stale/error/responsive states using existing tokens. |
| `tests/frontend/command_editor_unit.cjs` | Focused parser, atomic application, and UI-state tests. |
| `tests/frontend/flag_sync_smoke.cjs` | Cross-tab sync, dirty-draft guard, accessibility, and launch-blocking coverage. |
| `tests/frontend/module_namespace_unit.cjs` | Assert `window.LlamaGui.commandEditorUi` and canonical load order. |
| `docs/directory.md` | Add the tab/module and update script order and data flow. |
| `docs/tests.md` | Document focused and browser coverage. |
| `docs/changelog.md` | Summarize the feature when it ships. |

If script-order assertions live elsewhere at implementation time, update those assertions rather than creating another source of truth.

## Script Load Order

Load `command-editor-ui.js` after `flag-core.js` and any helpers it directly consumes, but before `app.js`. Prefer dependency injection from `app.js` over reliance on later-loaded globals.

Update `ui/index.html`, the canonical Script Loading Order in `docs/directory.md`, and frontend module-loading tests together.

## Implementation Phases

### Phase 1: Pure Round-Trip Core

1. Define parser results and protected token sets.
2. Build active-tool lookups from `FLAGS`.
3. Parse every current flag type.
4. Mirror serializer special cases.
5. Implement duplicates, unknowns, sensitive placeholders, and model conflicts.
6. Add the atomic exact-state operation.
7. Add Node tests before DOM work.

Exit criteria:

- Representative states serialize, parse, and reserialize to equivalent argument arrays.
- Invalid input leaves shared state unchanged.
- Deleting a default-backed emitted flag keeps it omitted.
- Inactive-tool-only state survives Apply.

### Phase 2: Command Editor Module and Markup

1. Add `window.LlamaGui.commandEditorUi`.
2. Add accessible tab and panel markup.
3. Render locked executable/model segments.
4. Render managed and additional arguments.
5. Implement dirty, stale, applying, validation, Apply, Discard, and Copy.
6. Move Custom Launch Args out of Configure.
7. Add responsive and focus-visible styling.

Exit criteria:

- Keyboard-only operation works.
- Editing preserves caret and textarea undo.
- Clean state follows external changes.
- Dirty drafts are never silently overwritten.

### Phase 3: Shared Integration and Launch Guard

1. Refresh from existing shared-state synchronization.
2. Refresh after tool and model changes.
3. Make Apply trigger one forced shared refresh.
4. Add the centralized dirty/stale/invalid guard.
5. Wire Apply & Launch through `processLifecycle.launch()`.
6. Confirm every Launch button behaves identically.

Exit criteria:

- Command edits update Configure, Quick Launch, Chat, API, and launch args.
- Other-tab edits update a clean command editor.
- No request is sent for an unapplied, stale, or invalid draft.

### Phase 4: Custom Backend and Sensitive Verification

1. Render backend-aware labels from authoritative status.
2. Verify unknown custom flags survive Apply, preset save/load, and launch.
3. Verify documented collision behavior.
4. Verify sensitive placeholders are never exposed or launched.
5. Verify switching to an official backend preserves extras and warns.

### Phase 5: Documentation and Full Verification

1. Update `docs/directory.md` tab/module/data-flow/script-order sections.
2. Update `docs/tests.md`.
3. Update README text/screenshots only if the final UI makes them inaccurate.
4. Add the implementation changelog entry.
5. Run focused and full frontend checks.

## Test Plan

### Pure Parser and State Tests

Cover at minimum:

- Every current flag type.
- Positive and negated booleans.
- Separate and equals-form values.
- Negative numbers, invalid numbers, bounds, and enums.
- Repeated text lists.
- Duplicate normalization.
- Unknown official/custom flags.
- Spaces, quotes, JSON, and Windows paths.
- Unmatched quotes and unfinished escapes.
- Protected executable and local model tokens.
- Sensitive unchanged placeholders.
- Active-tool replacement preserving inactive-tool-only values.
- Deleting default-backed flags.
- No partial mutation after errors.
- Forward/inverse/forward semantic equivalence for server and CLI.
- Stale `ctx_size_draft` never emitting `-cd`.

### Browser Synchronization Tests

Cover at minimum:

- Configure context edit -> Command Editor.
- Command Editor context edit -> Configure and Quick Launch.
- Command Editor sampler edit -> Configure, Quick Launch, and Chat.
- Tool/model changes -> locked segments.
- Dirty draft preservation and stale notice.
- Tool/model change while dirty blocks Apply until reload.
- Invalid Apply preserves prior state.
- All Launch buttons block dirty/stale/invalid drafts.
- Apply & Launch sends normalized shared args.
- Unknown custom flags reach the launch body.
- Copy Command redacts secrets.
- Keyboard focus order and locked-segment behavior.
- Mobile layout without horizontal page overflow.

### Verification Commands

Run at minimum:

```powershell
node --check ui/js/flag-core.js
node --check ui/js/command-editor-ui.js
node tests/frontend/custom_launch_args_unit.cjs
node tests/frontend/launch_args_unit.cjs
node tests/frontend/command_editor_unit.cjs
npm run test:frontend:modules
npm run test:frontend
npm test
```

Run backend tests only if backend process, model-policy, manifest, route, or service behavior changes:

```powershell
.venv\Scripts\python.exe -m unittest discover tests -v
```

## Acceptance Criteria

- A separate accessible Command Editor tab exists.
- The executable cannot be replaced through command text.
- The generated local main-model path cannot be overridden through editable args.
- Recognized edits update shared state and every mirrored control.
- Other-tab changes update a clean editor.
- Dirty drafts are preserved and marked stale after external changes.
- Apply is atomic; invalid drafts change nothing.
- Normalization is documented and predictable.
- Unknown custom-backend flags persist and reach the selected binary unchanged.
- No custom schema is required for pass-through support.
- Known secrets remain redacted from command text, copies, logs, and presets.
- No launch path can launch older state while an unapplied draft is visible.
- Existing Configure, Quick Launch, Chat, API, Presets, Benchmarking, model-switching, and lifecycle tests remain green.
- `docs/directory.md`, `docs/tests.md`, and `docs/changelog.md` describe the shipped implementation accurately.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Command text becomes a second source of truth. | Persist only `flagCore` state; keep drafts transient and require Apply. |
| Partial input breaks other tabs. | Commit only after the complete draft validates. |
| Re-rendering destroys caret/undo. | Never rewrite a focused dirty textarea. |
| Unknown custom flags have unknowable arity. | Keep them opaque; reject genuinely ambiguous cases. |
| Duplicates make controls disagree with runtime. | Normalize recognized duplicates using last-value-wins. |
| A custom backend redefines a mainline flag. | Use mainline meaning in v1; defer explicit overrides to a manifest. |
| Locked model is overridden through extra args. | Reject local main-model flags in every editable area. |
| Secrets appear in plain command text. | Use protected/masked segments and current redaction rules. |
| Another tab launches an unapplied draft. | Put one guard in the shared launch-request builder. |
| Apply erases inactive-tool settings. | Replace active-tool definitions only. |
| Backend switching makes extras incompatible. | Preserve them, warn, and let the selected binary validate support. |

## Deferred Extensions

Do not include these initially:

- A custom-backend flag manifest.
- Backend identity/version metadata in presets.
- Arbitrary shell-script import.
- Exact command formatting preservation.
- Drag-and-drop token ordering.
- Per-token highlighting or autocomplete.
- Automatic `--help` discovery.
- Backend-enforced model-root restrictions.
- Custom executable names or arbitrary binary paths.

Add them only after the canonical shared-state-backed editor works and a concrete user need justifies the additional state or schema.
