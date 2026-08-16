# Custom Forks — Flag Pack Design

**Status:** Accepted design direction; implementation intentionally deferred.

**Created:** 2026-08-16

**Last revised:** 2026-08-16

**Scope:** Let a user-provided llama.cpp fork add structured Configure controls
and extend existing enum values without Llama-GUI shipping per-fork code. Stock
llama.cpp behavior and the official `FLAGS` definitions remain unchanged.

This is a design note, not an implementation request. Do not begin this work
until it is explicitly scheduled.

Related, but separate: `docs/editable-launch-command-plan.md` describes a
Command Editor that round-trips argv into `flagCore`. It does not invent a flag
schema from `--help`. This note describes how fork-owned schema enters the
existing structured state.

## Decision summary

The product is **user flag packs**. A flag pack is a local JSON overlay on the
official flag definitions. It may append enum options to an official flag and
may declare new fork-owned flags.

The first version deliberately has a narrow surface:

- One active pack at a time.
- One fixed file: `llama/custom/flag-pack.json`.
- The pack is active only while the configured backend is `custom`.
- Pack flags use existing categories and existing Configure input types.
- `extends` may append enum options only; it cannot rewrite official flags.
- New pack flag IDs are namespaced internally.
- All values remain in `flagCore` shared state and all writes use its setters.
- Unknown enum values remain visible, selected, saved, and emitted.
- Pack values become inert rather than being deleted when the pack unloads.
- No built-in packs, network catalog, automatic download, or multi-pack
  composition.

Custom-argument collision overrides and a `--help` difference viewer are useful
follow-ups, but they are not prerequisites for the flag-pack product.

## Why this exists

Llama-GUI already activates user-provided executables from
`llama/custom/bin/`. The missing piece is structured support for flags those
executables add or extend.

[BeeLlama.cpp](https://github.com/Anbeeld/beellama.cpp) is the motivating
example. Its fork surface exposes three limitations in the current GUI:

1. **New values on official flags.** Bee adds values such as `kvarn4` to
   `--cache-type-k` and `--cache-type-v`, while Llama-GUI renders those controls
   from the fixed `CACHE_TYPE_OPTIONS` list.
2. **Brand-new flags.** Controls such as `--kv-tail-tokens`,
   `--kv-tail-type`, `--cache-type-k-swa`, `--reasoning-loop-guard`, and
   `--spec-dm-controller` have no official definitions to render.
3. **Custom-argument collisions.** A user can type fork arguments into Custom
   Launch Args, but a colliding GUI-managed argument is still emitted too.

Opaque Custom Launch Args are a valuable escape hatch, but they do not provide
labels, categories, input types, defaults, preset-friendly IDs, or safe
extension of an existing enum.

## Existing behavior to preserve

- Custom binary activation remains `POST /api/activate-custom` through
  `activateCustomBackend()`.
- `flagValues.custom_args` still passes through `parseCustomLaunchArgs()` and
  is appended by `buildLaunchArgs()`.
- Parser errors still block launch and appear beside the textarea.
- Command preview, Configure, Quick Launch, Chat, and presets continue to read
  the same `flagCore` state and launch arguments.
- Official flags remain in `ui/js/flags/definitions.js` and continue through
  the stock flag-definition and llama.cpp compatibility tests.
- `/api/launch` and the process supervisor remain argv consumers; they do not
  need to understand flag packs.

## Invariants

### Official definitions stay official

`FLAGS` remains the stock llama.cpp source of truth. Do not add BeeLlama or any
other fork's options to `definitions.js` or `options.js`.

The runtime list is derived:

```text
official FLAGS + validated active overlay = effective runtime flags
```

Creating an effective list must not mutate `FLAGS`, its flag objects, or shared
official option arrays. Activation and unload replace the effective array with
a new array identity so consumers with identity-based caches cannot stay stale.

### One launch state

Pack values are ordinary keys in `flagCore` state. Every control writes through
`setFlagValue`, `setMultipleFlagValues`, or `applyFlagValues`. There is no
parallel fork-settings object and no pack-specific command builder.

Only flags in the effective runtime list are rendered and emitted. A namespaced
pack value may remain in state while its pack is inactive, but without a
definition it is inert.

### Unknown values survive

If shared state contains an enum value not present in the active options, the
Configure select must add a temporary option such as:

```text
kvarn4 (not in active schema)
```

The value remains selected, is saved unchanged, and is emitted if its official
definition is active. The GUI may warn that the active schema does not
advertise it, but must not silently replace or omit it.

Brand-new pack flags behave differently when their pack is inactive: their
namespaced state keys survive, but no flag is emitted because no active
definition maps those keys to argv.

## V1 architecture

### Runtime flag registry

Add one focused frontend module, exposed as something like
`window.LlamaGui.flagRegistry`, with the minimum required API:

```text
getFlags()
getActivePack()
activatePack(pack)
clearPack()
```

`getFlags()` returns the current effective array. `activatePack()` validates and
merges a pack atomically: invalid input leaves the previous registry untouched.
`clearPack()` returns to an official-only effective list.

Consumers that need the complete definition list must use the registry rather
than referencing `FLAGS` directly. In particular:

- `getFlagsForTool()`, `getFlagsByCategory()`, and `getDefaultValues()`.
- `flagCore` launch generation and known-flag discovery.
- Configure rendering and input restoration.
- Preset normalization, labels, defaults, search, and override summaries.
- Sampler presets and benchmark helpers that are already injected with a
  `getFlags` callback.

Direct `FLAGS.find(...)` calls for fixed official-only controls may stay where
they are when they cannot refer to a pack flag, but new general-purpose code
must use the registry.

### Pack location and backend read

V1 uses exactly one path:

```text
llama/custom/flag-pack.json
```

The user places or replaces this file manually beside the custom backend. No UI
file writer, picker, pack library, or configurable path is needed in v1.

The browser cannot read that path directly, so implementation should add one
read-only endpoint, provisionally `GET /api/custom-flag-pack`:

- With a non-custom configured backend or no file, return
  `{ "active": false, "pack": null }`.
- With a custom backend and valid JSON object, return
  `{ "active": true, "pack": { ... } }`.
- Reject an oversized file, malformed JSON, or a non-object document with a
  sanitized error. The frontend catches the error, shows that the pack was not
  loaded, and continues with official flags.
- Accept no user-supplied path. Resolve only the fixed application path.

The endpoint performs file-size and JSON-shape checks. The pure frontend pack
validator performs the flag-schema checks so the same code can be covered by
fast Node tests. Adding the endpoint will require the normal route-table updates
in `docs/directory.md` and `docs/architecture.html`.

Do not attach the whole pack to `/api/status`; status polling should not resend
it. Do not probe or load it while the install lock is held.

### Activation lifecycle

On startup:

1. Obtain authoritative backend status.
2. If the configured backend is custom, fetch and validate the fixed pack.
3. Establish the effective flag list.
4. Initialize defaults and render Configure.
5. Only then apply a startup preset, if requested.

The current eager `replaceFlagValues(getDefaultValues())` must move or be
otherwise sequenced so pack defaults are known before the first authoritative
state initialization. Avoid rendering official controls and then replacing the
whole state after an asynchronous pack load.

After successful custom-backend activation, fetch and activate the pack, add
defaults only for new keys that are absent, and rerender from shared state.
Never overwrite an existing inert or preset-provided pack value with a pack
default.

When authoritative status switches to an official backend, clear the active
overlay and rerender. Leave namespaced pack keys in `flagValues`; they stop
rendering and emitting. Reactivating the same pack reuses those values.

## Pack document

### Example

```json
{
  "schema_version": 1,
  "id": "beellama",
  "label": "BeeLlama",
  "pack_version": "1.0.0",
  "source": "https://github.com/Anbeeld/beellama.cpp",
  "extends": [
    {
      "id": "cache_type_k",
      "options": [
        { "value": "kvarn4", "label": "KVarN 4" },
        { "value": "kvarn5", "label": "KVarN 5" }
      ]
    },
    {
      "id": "cache_type_v",
      "options": [
        { "value": "kvarn4", "label": "KVarN 4" },
        { "value": "kvarn5", "label": "KVarN 5" }
      ]
    }
  ],
  "flags": [
    {
      "id": "kv_tail_tokens",
      "flag": "--kv-tail-tokens",
      "category": "kv",
      "type": "text",
      "label": "KV Tail Tokens",
      "tool": "both",
      "placeholder": "0",
      "desc": "Exact-tail token specification accepted by this fork."
    }
  ]
}
```

`schema_version` is required and initially must equal `1`. `pack_version` is
display metadata, not an executable-version constraint. Compatibility metadata
may be added for display later, but v1 does not build a version resolver.

### `extends`

An extension may target an existing official enum ID and append options.

- The official definition and options are cloned before merging.
- Official option order stays first; pack options follow.
- An identical value already supplied by the official definition is ignored if
  its label is identical and rejected if it attempts to relabel the value.
- V1 cannot change an official `flag`, `false_flag`, aliases, label,
  description, type, default, category, tool scope, bounds, or option order.
- V1 cannot remove an official option.

### `flags`

New definitions use the existing renderable subset of the `FLAGS` shape:

- Required: `id`, `flag`, `category`, `type`, `label`, and `tool`.
- Optional: `aliases`, `false_flag`, `default`, `options`, `min`, `max`,
  `step`, `placeholder`, `desc`, `short_desc`, `beginner_tip`, and `submenu`.
- Supported types are the types Configure already renders. A type that needs
  custom serialization or a new widget is rejected in v1.
- `category` must name an existing `FLAG_CATEGORIES` entry. Packs cannot define
  categories in v1.
- `tool` must be exactly `server`, `cli`, or `both`.

Complex fork syntax belongs in a `text` control and its description. For
example, Bee's `--kv-tail-tokens` accepts numbers, `auto`, positional lists,
and named assignments, so treating it as a bounded integer would be incorrect.
Cross-field and model-dependent rules remain the binary's responsibility. Do
not add a conditional validation language in v1.

A pack `default` is a real initial state value and will normally be emitted.
Authors must omit `default` and use `placeholder` when omission is meaningfully
different from explicitly passing the binary's documented default.

### Internal IDs and aliases

Local pack IDs are automatically namespaced in the effective definitions:

```text
kv_tail_tokens -> pack__beellama__kv_tail_tokens
```

`extends` continues to use the official ID because it modifies an official
definition. Namespacing prevents an inert value from one fork from being
emitted through another fork that happened to choose the same local ID.

Pack and local IDs must use lowercase ASCII letters, digits, and underscores,
must begin with a letter, and must not contain `__`. The reserved namespace also
makes safe pack-owned keys recognizable during preset import.

`aliases` is an optional list of equivalent CLI spellings. It does not change
which spelling launch generation emits; `flag` remains canonical. A future
custom-argument override and help diff must map `flag`, `false_flag`, and every
alias to one logical flag ID. Official definitions may gain alias metadata for
that purpose without changing their emitted argv.

## Validation

Validation is fail-closed and atomic. Reject the entire pack when any entry is
invalid; do not partially activate it.

At minimum, reject:

- An unsupported or missing `schema_version`.
- Unsafe, reserved, malformed, duplicate, or overlong pack/local IDs.
- Reserved object keys such as `__proto__`, `prototype`, and `constructor`.
- Unsupported `type`, `tool`, or category values.
- Missing labels or malformed option objects.
- Defaults incompatible with the declared type.
- Invalid numeric bounds or a minimum greater than a maximum.
- Flags, false flags, or aliases containing whitespace, control characters, or
  anything other than a valid CLI option spelling.
- Duplicate primary flags, false flags, aliases, IDs, or option values within
  the pack.
- A new pack flag colliding with any official primary flag, false flag, alias,
  or model-source alias.
- `flags` reusing an official ID; use `extends` instead.
- `extends` targeting a missing or non-enum official ID.
- `extends` attempting anything other than option additions.
- Documents, strings, flag arrays, or option arrays above explicit conservative
  size/count limits.

Pack definitions do not run through the stock `npm run test:flag-definitions`
or installed-stock-binary compatibility comparison. The runtime validator gets
focused tests with representative valid and invalid packs.

## Presets

Preset behavior must make packs portable without turning every arbitrary stale
key into trusted schema.

- Saving while a pack is active stores namespaced pack values normally.
- Saved preset data may include active pack metadata such as
  `flag_pack: { "id": "beellama", "pack_version": "1.0.0" }`.
- Loading a preset without its required pack retains namespaced values in
  shared state, leaves them inert, and shows a non-blocking missing-pack warning.
- Loading it after the matching pack activates renders and emits the values.
- Existing official IDs extended by a pack need no special preset key; their
  raw enum strings already use the official ID.
- Preset import continues to reject sensitive values. It may preserve an
  unknown key only when it matches the validated reserved pack namespace; other
  unknown IDs retain the current stale-key filtering behavior.
- Preset labels and override summaries resolve definitions from the effective
  registry, not directly from `FLAGS`.

An inactive namespaced value may be included if the user saves another preset
in the same session. This is harmless because it cannot emit without its pack,
and preserving it is safer than silently destroying a fork configuration.

## Unknown enum rendering

Unknown-enum preservation is part of the flag-pack foundation, not a separate
product phase.

Generalize the existing chat-template fallback into a shared enum-option helper
used by both `createEnumInput()` and `restoreFlagInputs()`. It must:

- Remove only the temporary fallback option it owns.
- Preserve every declared official and pack option.
- Append and select the stored raw value when no declared option matches.
- Label the fallback as not present in the active schema.
- Write changes through `flagCore` setters.

Do not add an `Other...` text-entry control in v1. Pack authors can add a real
option, and Custom Launch Args remains the manual escape hatch. Unknown
`multi_enum` values can wait until a real fork requires them.

## Optional follow-up: custom args override structured flags

This is feasible, but the current token-naive duplicate detector is not safe to
reuse for suppression. A false-positive warning is tolerable; a false-positive
that removes a structured argument changes launch behavior.

When implemented, the override must:

1. Parse Custom Launch Args before generating structured arguments.
2. Build a name-to-logical-ID map from each active definition's `flag`,
   `false_flag`, and `aliases`, plus model-source aliases.
3. Determine overrides conservatively. An explicit `--known=value` is
   unambiguous. If an unknown preceding option makes a standalone known token
   ambiguous, warn but do not suppress; the user can use `--known=value`.
4. Omit every structured spelling for the overridden logical ID.
5. Handle the separately emitted selected-model argument as well as `FLAGS`.
6. Emit the custom tokens exactly once and report which structured controls
   they override.

This corrects two assumptions in the original plan: `getKnownCliFlags()` does
not currently know general short/long aliases, and model argv is not emitted by
the ordinary `FLAGS` loop.

Focused tests must cover short and long aliases, false flags, `--flag=value`, a
selected-model override, repeated custom flags, and a known-looking token used
as an ambiguous value.

## Optional follow-up: `--help` difference viewer

`--help` is useful discovery data and a poor schema. It may reveal names and
tool scope, but it does not reliably provide types, defaults, enum values,
aliases, or cross-field rules.

If implemented:

- Put it behind an explicit button and a dedicated backend probe endpoint; do
  not run it during activation or status polling.
- Run `llama-server --help` and `llama-cli --help` separately, without a shell,
  using the same executable resolution and runtime environment as launches.
- Apply a short timeout and bounded combined stdout/stderr capture.
- Infer `server`, `cli`, or `both` from which executable advertises each name.
- Extract `parseAdvertisedOptions()` from the test into a small production JS
  helper and make the existing test load that helper. Do not maintain separate
  frontend and test parsers.
- Compare against official and active-pack primary flags, false flags, and
  aliases so a known long alias is not reported as a new flag.
- Cache by an executable fingerprint such as resolved path, size, and
  modification time. The literal backend name `custom` is not an identity and
  would remain stale after the user replaces binaries.
- Offer Copy Name or create an **inactive draft** pack entry. Do not append an
  unknown flag directly to `custom_args`: name-only help parsing cannot know
  whether the flag requires a value.

Do not auto-generate active Configure rows from help output.

## Suggested implementation order

When this work is explicitly scheduled:

1. Add the pure runtime registry, namespacing, pack validation, and merge tests.
2. Add the fixed-path read-only backend endpoint and synchronize pack activation
   with authoritative custom-backend status.
3. Route flag-list consumers through the registry and establish correct startup
   and default-merging order.
4. Add pack-aware Configure rendering, unknown-enum preservation, preset
   metadata/import behavior, and emit/unload/reactivate tests.
5. Run the focused frontend suites and the browser shared-state smoke test.
6. Consider custom-argument overrides only if the remaining escape-hatch
   collision is worth the parser semantics.
7. Consider the `--help` viewer only if users need discovery after packs exist.

This order delivers the requested product before either nice-to-have.

## Acceptance criteria for flag-pack v1

- With no pack file or an official backend, effective flags and generated argv
  are byte-for-byte equivalent to current behavior.
- Activating a valid pack does not mutate official definitions or option arrays.
- Extended options appear on the targeted official controls and emit through
  the official flag spelling.
- New pack controls render in existing categories and emit only for their
  declared tool scope.
- Switching to an official backend removes pack rows and argv without deleting
  namespaced values.
- Reactivating the same pack restores those values instead of applying defaults
  over them.
- A preset containing an inactive pack value round-trips without emitting it.
- Imported safe namespaced pack keys survive while unrelated unknown IDs remain
  filtered.
- Unknown enum strings remain visible and selected and are never silently
  changed to the first option.
- Invalid packs fail atomically, display a useful error, and leave official
  controls usable.
- Command preview, Configure, Quick Launch, Chat, and preset launch paths still
  derive argv from the same `flagCore` state.

## Explicitly out of scope

- Shipping a BeeLlama or other fork pack in this repository.
- More than one active pack.
- A pack catalog, marketplace, network download, update checker, or GitHub
  integration.
- Arbitrary pack paths, a directory browser, or UI pack file editing.
- Pack-defined categories, input widgets, serializers, validation expressions,
  or conditional dependency rules.
- Treating fork documentation or `--help` as trusted schema.
- A raw launch-this-argv-as-is mode.
- A second fork-settings state model.
- Changing `/api/launch`, the process supervisor, or custom executable layout.
- Teaching memory estimate, benchmarks, or Model Switcher fork-specific
  semantics in v1. They continue to consume the launch state they already know;
  revisit only when a concrete pack flag must affect one of those features.
- Custom tools beyond the existing `llama-server` and `llama-cli` executables.
- Command Editor integration. A later editor should map active pack flags into
  structured state rather than dumping them into Custom Launch Args.

## Deferred status

The v1 product decisions in this note are intentionally settled so a future
implementation does not need another architecture round before beginning. The
feature itself remains deferred, and this document makes no code changes.
