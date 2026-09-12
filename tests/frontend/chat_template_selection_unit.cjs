// Session 1 (Tier 2): chat-template selection extraction. Evaluates the real
// flags data modules, flag-core.js, and chat-template-selection.js in one VM
// context, so the facade is tested against the actual shared-state setters,
// launch-argument generation, and template preset data it consumes at runtime.
//
// Covers: load/configure inertness, auto/builtin/bundled/custom/unsupported
// selections, legacy built-in round trips, complete atomic patches with
// shared-state notifications, read-only reverse mapping (mixed state,
// Windows-path normalization), the manual custom-path clearing rule, lookups
// after applyFlagValues() replaces state, and emitted launch arguments (at
// most one of --chat-template and --chat-template-file).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT } = require("./script_order.cjs");

const context = {
    window: { LlamaGui: {} },
    console,
};
context.window.window = context.window;
vm.createContext(context);

for (const file of [
    "ui/js/flags/categories.js",
    "ui/js/flags/options.js",
    "ui/js/flags/chat-templates.js",
    "ui/js/flags/definitions.js",
    "ui/js/flags/helpers.js",
    "ui/js/flag-core.js",
]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
}

// Recording hooks, installed like app.js configures them: every shared-state
// write must flow through setMultipleFlagValues() and notify both observers.
vm.runInContext(`
    globalThis.__notifications = [];
    window.LlamaGui.flagCore.configure({
        getDefaultFlagValues: getDefaultValues,
        getFlags: () => FLAGS,
        normalizeMultiEnumValue: (value) => Array.isArray(value) ? value : [],
        shouldOmitSpeculativeFlag,
        afterPatch(patch, options) {
            globalThis.__notifications.push({ type: "afterPatch", patch, options });
        },
        postUpdate() {
            globalThis.__notifications.push({ type: "postUpdate" });
        },
    });
`, context);

function notifications() {
    return vm.runInContext("globalThis.__notifications", context);
}

// deepStrictEqual compares [[Prototype]]s, so objects and arrays from the VM
// realm must be copied into plain Node-realm values before deepEqual.
function toPlain(value) {
    if (Array.isArray(value)) return value.map(toPlain);
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value)) out[key] = toPlain(value[key]);
        return out;
    }
    return value;
}

// Loading the module must not apply a selection.
vm.runInContext(
    fs.readFileSync(path.join(ROOT, "ui/js/chat-template-selection.js"), "utf8"),
    context,
    { filename: "ui/js/chat-template-selection.js" }
);
assert.equal(
    notifications().length,
    0,
    "evaluating chat-template-selection.js must not write flag state"
);

const selection = context.window.LlamaGui.chatTemplateSelection;
assert.ok(selection, "expected window.LlamaGui.chatTemplateSelection to be defined");

// Configuring the module must not apply a selection either.
selection.configure({ flagCore: context.window.LlamaGui.flagCore });
assert.equal(
    notifications().length,
    0,
    "configuring chat-template-selection must not write flag state"
);

// Wire the manual-path rule and the template allowlist exactly like app.js does,
// then establish baseline state.
vm.runInContext(`
    window.LlamaGui.flagCore.configure({
        beforePathPatch(flagId, value, patch) {
            window.LlamaGui.chatTemplateSelection.beforePathPatch(flagId, value, patch);
        },
        isSupportedChatTemplateValue: window.LlamaGui.chatTemplateSelection.isSupportedChatTemplateValue,
    });
    window.LlamaGui.flagCore.setCurrentToolValue("llama-server");
    window.LlamaGui.flagCore.setModelDirInfo({
        models_dir: "models",
        models_arg_root: "models",
        models_dir_is_default: true,
        models_dir_available: true,
        models_dir_error: "",
    });
    window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
`, context);

const flagCore = context.window.LlamaGui.flagCore;
const optionValues = vm.runInContext(
    "CHAT_TEMPLATE_PRESET_OPTIONS.map((option) => option.value)",
    context
);

function currentValues() {
    return flagCore.getFlagValues();
}

function afterPatchEntries() {
    return notifications().filter((entry) => entry.type === "afterPatch");
}

// Every write must be one atomic patch plus exactly one notification of each kind.
function assertOneNotificationPair(label, action) {
    const start = notifications().length;
    action();
    const emitted = notifications().slice(start);
    assert.deepEqual(
        Array.from(emitted, (entry) => entry.type),
        ["afterPatch", "postUpdate"],
        `${label}: expected exactly one afterPatch followed by one postUpdate`
    );
    return emitted[0];
}

function assertPatch(patch, expected, label) {
    // Patch values are primitives; compare the exact key set explicitly so a
    // missing delete key cannot slip through a shape-only comparison.
    assert.deepEqual(
        Object.keys(patch).sort(),
        Object.keys(expected).sort(),
        `${label}: patch key set`
    );
    for (const key of Object.keys(expected)) {
        assert.equal(patch[key], expected[key], `${label}: patch.${key}`);
    }
}

function flatLaunchArgs() {
    return flagCore.getLaunchArgs().args.flat();
}

function assertSingleTemplateFlag(label) {
    const args = flatLaunchArgs();
    const templateCount = args.filter((arg) => arg === "--chat-template").length;
    const fileCount = args.filter((arg) => arg === "--chat-template-file").length;
    assert.ok(
        templateCount === 0 || fileCount === 0,
        `${label}: at most one of --chat-template and --chat-template-file may be emitted (got template=${templateCount}, file=${fileCount})`
    );
    return { templateCount, fileCount };
}

function assertTemplateArgs(args, flag, value, label) {
    const index = args.indexOf(flag);
    assert.ok(index >= 0, `${label}: expected ${flag} in launch args`);
    assert.equal(args[index + 1], value, `${label}: ${flag} value`);
}

// --- Auto clears both fields, even when both are set ----------------------

flagCore.setMultipleFlagValues({ chat_template: "chatml", chat_template_custom: "ui/templates/alpaca.jinja" });
let patch = assertOneNotificationPair("auto selection", () => selection.setChatTemplateValue(""));
assertPatch(
    patch.patch,
    { chat_template: undefined, chat_template_custom: undefined },
    "auto selection must clear both template fields with one patch"
);
assert.equal(currentValues().chat_template, undefined, "auto selection clears chat_template");
assert.equal(currentValues().chat_template_custom, undefined, "auto selection clears chat_template_custom");
assert.equal(selection.getSelectedChatTemplateDropdownValue(), "", "auto selection maps to the empty Auto value");
assert.equal(
    selection.getQuickTemplateSummaryText(),
    "Use the template embedded in the model metadata when available.",
    "auto selection with no custom file shows the model-metadata fallback"
);
assert.deepEqual(assertSingleTemplateFlag("auto"), { templateCount: 0, fileCount: 0 });

// --- Named builtin preset --------------------------------------------------

patch = assertOneNotificationPair("builtin selection", () => selection.setChatTemplateValue("chatml"));
assertPatch(
    patch.patch,
    { chat_template: "chatml", chat_template_custom: undefined },
    "builtin selection must set chat_template and clear chat_template_custom"
);
assert.equal(selection.getSelectedChatTemplateDropdownValue(), "chatml");
assert.equal(selection.getQuickTemplateSummaryText(), "Using preset: ChatML.");
{
    const args = flatLaunchArgs();
    assert.deepEqual(
        assertSingleTemplateFlag("builtin"),
        { templateCount: 1, fileCount: 0 },
        "builtin selection emits --chat-template"
    );
    assertTemplateArgs(args, "--chat-template", "chatml", "builtin selection");
}

// --- Bundled preset maps to a file path, never a --chat-template name ------

patch = assertOneNotificationPair("bundled selection", () => selection.setChatTemplateValue("__alpaca__"));
assertPatch(
    patch.patch,
    { chat_template: undefined, chat_template_custom: "ui/templates/alpaca.jinja" },
    "bundled selection must clear chat_template and set the bundled path"
);
assert.equal(currentValues().chat_template, undefined, "bundled selection must not store a template name");
assert.equal(selection.getSelectedChatTemplateDropdownValue(), "__alpaca__");
assert.equal(
    selection.getQuickTemplateSummaryText(),
    "Using bundled template preset: Alpaca.",
    "bundled selection summary"
);
{
    const args = flatLaunchArgs();
    assert.deepEqual(
        assertSingleTemplateFlag("bundled"),
        { templateCount: 0, fileCount: 1 },
        "bundled selection emits --chat-template-file"
    );
    assertTemplateArgs(args, "--chat-template-file", "ui/templates/alpaca.jinja", "bundled selection");
}

// --- Legacy built-in names round-trip through the raw-value branch ---------

assert.ok(!optionValues.includes("phi4"), "phi4 must stay absent from the curated dropdown options");
assert.equal(selection.isSupportedChatTemplateValue("phi4"), true, "legacy built-in phi4 stays accepted");
patch = assertOneNotificationPair("legacy phi4 selection", () => selection.setChatTemplateValue("phi4"));
assertPatch(
    patch.patch,
    { chat_template: "phi4", chat_template_custom: undefined },
    "legacy built-in selection must set chat_template and clear the custom path"
);
assert.equal(selection.getSelectedChatTemplateDropdownValue(), "phi4", "legacy built-in round trips to the dropdown");
assert.equal(
    selection.getQuickTemplateSummaryText(),
    "Using llama.cpp built-in template: phi4",
    "legacy built-in summary"
);
{
    const args = flatLaunchArgs();
    assertSingleTemplateFlag("legacy phi4");
    assertTemplateArgs(args, "--chat-template", "phi4", "legacy phi4");
}

// --- Unsupported stored values: rendered as empty, state untouched, no arg --

flagCore.setFlagValue("chat_template", "not-a-template");
const valueSnapshot = { ...currentValues() };
const readOnlyWrites = afterPatchEntries().length;
assert.equal(
    selection.getSelectedChatTemplateDropdownValue(),
    "",
    "unsupported stored values must not appear in the dropdown"
);
assert.equal(
    selection.isSupportedChatTemplateValue("not-a-template"),
    false,
    "unsupported values must fail the allowlist"
);
assert.deepEqual(toPlain(currentValues()), toPlain(valueSnapshot), "rendering must not repair or migrate unsupported state");
assert.equal(afterPatchEntries().length, readOnlyWrites, "read-only lookups must not write state");
{
    const result = flagCore.getLaunchArgs();
    assert.deepEqual(
        assertSingleTemplateFlag("unsupported"),
        { templateCount: 0, fileCount: 0 },
        "unsupported stored values must not emit --chat-template"
    );
    assert.ok(
        result.warnings.some((warning) => warning.includes("not-a-template")),
        "unsupported stored values must produce the launch warning"
    );
}

// --- preserveCustomTemplateFile applies only to the raw-value branch -------

flagCore.setMultipleFlagValues({ chat_template_custom: "ui/templates/keep-me.jinja" });
patch = assertOneNotificationPair("preserve option", () =>
    selection.setChatTemplateValue("phi4", { preserveCustomTemplateFile: true }));
assertPatch(
    patch.patch,
    { chat_template: "phi4" },
    "preserveCustomTemplateFile must leave chat_template_custom untouched"
);
assert.equal(currentValues().chat_template_custom, "ui/templates/keep-me.jinja", "preserve option keeps the custom file");

patch = assertOneNotificationPair("builtin ignores preserve option", () =>
    selection.setChatTemplateValue("chatml", { preserveCustomTemplateFile: true }));
assertPatch(
    patch.patch,
    { chat_template: "chatml", chat_template_custom: undefined },
    "named builtin selections still clear the competing value despite the preserve option"
);
assert.equal(currentValues().chat_template_custom, undefined);

// --- Reverse mapping precedence and read-only getters ----------------------

// A matching bundled path wins over a simultaneously stored builtin name...
flagCore.setMultipleFlagValues({ chat_template: "chatml", chat_template_custom: "ui/templates/alpaca.jinja" });
assert.equal(
    selection.getSelectedChatTemplateDropdownValue(),
    "__alpaca__",
    "a matching bundled path wins over a stored builtin name"
);
// ...and the launch rule keeps the custom path authoritative while the state
// stays untouched (rendering must not repair mixed state).
assert.deepEqual(
    assertSingleTemplateFlag("mixed bundled+builtin"),
    { templateCount: 0, fileCount: 1 },
    "a nonblank custom path suppresses --chat-template in mixed state"
);
assert.equal(currentValues().chat_template, "chatml", "rendering must not repair mixed state");
assert.equal(currentValues().chat_template_custom, "ui/templates/alpaca.jinja", "mixed state stays intact");

flagCore.setMultipleFlagValues({ chat_template_custom: "C:\\jinja\\other.jinja" });
assert.equal(
    selection.getSelectedChatTemplateDropdownValue(),
    "chatml",
    "an unmatched custom path falls back to the stored named preset"
);

flagCore.setMultipleFlagValues({ chat_template: "phi4", chat_template_custom: undefined });
assert.equal(
    selection.getSelectedChatTemplateDropdownValue(),
    "phi4",
    "a supported raw value maps to itself"
);

// --- Windows-path normalization is for comparison only ---------------------

flagCore.setMultipleFlagValues({ chat_template_custom: " ui\\templates\\alpaca.jinja " });
assert.equal(
    selection.getSelectedChatTemplateDropdownValue(),
    "__alpaca__",
    "bundled path lookup trims and converts backslashes"
);
assert.equal(
    currentValues().chat_template_custom,
    " ui\\templates\\alpaca.jinja ",
    "normalization must never rewrite the stored path"
);
assert.equal(
    selection.getChatTemplatePresetByPath("models/alpaca.jinja"),
    null,
    "an unrelated file named alpaca.jinja must not become the bundled preset"
);
assert.equal(
    selection.getChatTemplatePresetByPath("UI/TEMPLATES/ALPACA.JINJA"),
    null,
    "lookup must not case-fold paths"
);
assert.deepEqual(
    toPlain(selection.getChatTemplatePresetByPath("  ui\\templates\\alpaca.jinja\t")),
    toPlain(selection.getChatTemplatePresetByPath("ui/templates/alpaca.jinja")),
    "trimming and backslash conversion are equivalent for lookup"
);
assert.equal(
    selection.getQuickTemplateSummaryText(),
    "Using bundled template preset: Alpaca.",
    "a backslash-stored bundled path still resolves to its preset summary"
);

flagCore.setMultipleFlagValues({ chat_template: undefined, chat_template_custom: "C:\\jinja\\my.jinja" });
assert.equal(
    selection.getQuickTemplateSummaryText(),
    "Using custom template file: C:\\jinja\\my.jinja",
    "unmatched custom paths show the stored path as typed"
);
assert.deepEqual(assertSingleTemplateFlag("custom path"), { templateCount: 0, fileCount: 1 });

// --- Manual-path clearing through the flagCore hook ------------------------

flagCore.setMultipleFlagValues({ chat_template: "phi4" });
patch = assertOneNotificationPair("typed custom path", () =>
    flagCore.setPathFlagValue("chat_template_custom", "ui/templates/custom.jinja"));
assertPatch(
    patch.patch,
    { chat_template: undefined, chat_template_custom: "ui/templates/custom.jinja" },
    "typing a custom template path must clear chat_template inside the same patch"
);
assert.equal(currentValues().chat_template, undefined, "typing a custom path clears chat_template");
assert.equal(currentValues().chat_template_custom, "ui/templates/custom.jinja");

// Clearing the path must clear the competing name too, without a second write.
flagCore.setFlagValue("chat_template", "phi4");
assertOneNotificationPair("cleared custom path", () =>
    flagCore.setPathFlagValue("chat_template_custom", undefined));
assert.equal(
    currentValues().chat_template,
    undefined,
    "clearing the custom template path also clears chat_template"
);
assert.equal(currentValues().chat_template_custom, undefined);

// Unrelated path flags are untouched by the template rule.
{
    const unrelated = { grammar_path: "g.gbnf" };
    selection.beforePathPatch("grammar_path", "g.gbnf", unrelated);
    assert.deepEqual(Object.keys(unrelated), ["grammar_path"], "non-template path flags must not gain a chat_template key");
    const mmprojPatch = { no_mmproj: true };
    selection.beforePathPatch("mmproj", "p.mmproj", mmprojPatch);
    assert.deepEqual(Object.keys(mmprojPatch), ["no_mmproj"], "the mmproj rule stays owned by app.js");
}

// --- Lookups after applyFlagValues() replaces the state object -------------

flagCore.applyFlagValues({ chat_template: "granite" });
assert.equal(
    selection.getSelectedChatTemplateDropdownValue(),
    "granite",
    "reverse mapping must read the replaced state object, not a cached one"
);
assert.equal(
    selection.getQuickTemplateSummaryText(),
    "Using preset: Granite 3.x.",
    "summary follows the replaced state too"
);

// --- Getters never mutate shared state ------------------------------------

{
    const snapshot = toPlain(currentValues());
    const notificationsBefore = notifications().length;
    selection.getSelectedChatTemplateDropdownValue();
    selection.getQuickTemplateSummaryText();
    selection.isSupportedChatTemplateValue("chatml");
    selection.getChatTemplatePresetByValue("chatml");
    selection.getChatTemplatePresetByBuiltinName("chatml");
    selection.getChatTemplatePresetByPath("ui/templates/alpaca.jinja");
    assert.deepEqual(toPlain(currentValues()), snapshot, "read-only helpers must not change flag state");
    assert.equal(notifications().length, notificationsBefore, "read-only helpers must not notify");
}

// Equal cumulative counts must not disguise two writes from one action.
assert.throws(
    () => assertOneNotificationPair("duplicate selection", () => {
        selection.setChatTemplateValue("chatml");
        selection.setChatTemplateValue("chatml");
    }),
    /duplicate selection: expected exactly one afterPatch followed by one postUpdate/
);

console.log("chat_template_selection_unit passed");
