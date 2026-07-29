const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "sampler-presets.js"), "utf8");

let storedValue = null;
const debugMessages = [];
const context = {
    window: { LlamaGui: {} },
    console: {
        debug: (...args) => debugMessages.push(args),
        warn: () => {},
    },
    localStorage: {
        getItem: () => storedValue,
        setItem: (_key, value) => {
            storedValue = value;
        },
    },
    SAMPLER_PRESET_STORAGE_KEY: "llama_gui_sampler_presets_v1",
    BUILTIN_SAMPLER_PRESETS: {
        Balanced: { temperature: 0.75, top_k: 100, ctx_size: 32768 },
        Creative: { temperature: 1, top_p: 0.98 },
    },
    document: {
        createElement: () => ({
            appendChild: () => {},
            addEventListener: () => {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            style: {},
        }),
    },
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
    Blob: function Blob() {},
    alert: () => {},
    confirm: () => true,
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/sampler-presets.js" });

const samplerPresets = context.window.LlamaGui.samplerPresets;
let appliedPatch = null;
samplerPresets.configure({
    getFlags: () => [
        { id: "temperature", category: "sampling" },
        { id: "top_k", category: "sampling" },
        { id: "top_p", category: "sampling" },
        { id: "ctx_size", category: "context" },
    ],
    getDefaultFlagValues: () => ({
        temperature: 0.8,
        top_k: 40,
        top_p: 0.95,
        ctx_size: 4096,
    }),
    flagCore: {
        getFlagValues: () => ({
            temperature: 0.2,
            top_k: 12,
            ctx_size: 8192,
        }),
        setMultipleFlagValues: (patch) => {
            appliedPatch = patch;
        },
    },
});

function assertJsonEqual(actual, expected, message) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

storedValue = null;
assertJsonEqual(samplerPresets.loadSamplerPresetStore(), {}, "missing sampler preset storage should load as empty object");

storedValue = "not json";
assertJsonEqual(samplerPresets.loadSamplerPresetStore(), {}, "invalid sampler preset storage should load as empty object");
assert.ok(debugMessages.length > 0, "invalid sampler preset storage should produce a debug log");

storedValue = JSON.stringify(["not", "an", "object"]);
assertJsonEqual(samplerPresets.loadSamplerPresetStore(), {}, "array sampler preset storage should load as empty object");

assertJsonEqual(
    samplerPresets.normalizeSamplerPresetValues({
        temperature: 0.61,
        top_k: 77,
        ctx_size: 12345,
        unknown: true,
    }),
    { temperature: 0.61, top_k: 77 },
    "sampler preset normalization should keep only sampling flags"
);

assertJsonEqual(
    samplerPresets.getSamplerPresetImportEntries({
        presets: {
            First: { temperature: 0.5 },
            Second: { top_p: 0.8 },
        },
    }),
    [
        { name: "First", values: { temperature: 0.5 } },
        { name: "Second", values: { top_p: 0.8 } },
    ],
    "a structurally valid sampler bundle should produce import entries"
);
assert.equal(
    samplerPresets.getSamplerPresetImportEntries({ presets: { Good: { temperature: 0.5 }, Broken: "nope" } }),
    null,
    "one malformed sampler entry should reject the entire bundle"
);
assert.equal(
    samplerPresets.getSamplerPresetImportEntries({ name: "Broken", values: [] }),
    null,
    "array sampler values should be rejected rather than saved as an empty preset"
);

assertJsonEqual(
    samplerPresets.collectSamplerValues(),
    { temperature: 0.2, top_k: 12 },
    "sampler value collection should ignore non-sampling current flags"
);

samplerPresets.applySamplerPresetValues({ temperature: 0.42 });
assertJsonEqual(
    appliedPatch,
    { temperature: 0.42, top_k: 40, top_p: 0.95 },
    "applying a sampler preset should reset missing sampler values to defaults only"
);
assert.equal(
    Object.prototype.hasOwnProperty.call(appliedPatch, "ctx_size"),
    false,
    "applying a sampler preset should not patch unrelated flags"
);

storedValue = JSON.stringify({
    "My Sampler": { temperature: 0.33, ctx_size: 9999, top_p: 0.7 },
});
assertJsonEqual(
    samplerPresets.getAllSamplerPresets(),
    [
        { name: "Balanced", values: { temperature: 0.75, top_k: 100 }, source: "builtin" },
        { name: "Creative", values: { temperature: 1, top_p: 0.98 }, source: "builtin" },
        { name: "My Sampler", values: { temperature: 0.33, top_p: 0.7 }, source: "custom" },
    ],
    "all sampler presets should expose a stable normalized shape for consumers"
);

assert.equal(
    samplerPresets.isSamplerPresetNameTaken("balanced", { Custom: {} }),
    true,
    "sampler preset names must not collide case-insensitively with built-ins"
);
assert.equal(
    samplerPresets.isSamplerPresetNameTaken("CUSTOM", { Custom: {} }),
    true,
    "sampler preset names must not collide case-insensitively with custom presets"
);
assert.equal(
    samplerPresets.isSamplerPresetNameTaken("custom", { Custom: {} }, "Custom"),
    false,
    "rename checks may exclude the custom preset being renamed"
);
assert.equal(
    samplerPresets.isSamplerPresetNameTaken("New Sampler", { Custom: {} }),
    false,
    "an unused sampler preset name should be accepted"
);

// --- renameSamplerPreset ---

const setStore = (store) => {
    storedValue = JSON.stringify(store);
};

setStore({ "My Sampler": { temperature: 0.33, ctx_size: 9999 } });
let renameResult = samplerPresets.renameSamplerPreset("My Sampler", "  Renamed Sampler  ");
assertJsonEqual(renameResult, { ok: true, name: "Renamed Sampler" }, "renaming a custom preset should trim and succeed");
assertJsonEqual(
    samplerPresets.loadSamplerPresetStore(),
    { "Renamed Sampler": { temperature: 0.33, ctx_size: 9999 } },
    "rename should move stored values verbatim under the new key"
);

setStore({ "My Sampler": { temperature: 0.33 } });
assertJsonEqual(
    samplerPresets.renameSamplerPreset("Balanced", "Anything"),
    { ok: false, reason: "builtin" },
    "built-in sampler presets should not be renameable"
);

setStore({ Balanced: { temperature: 0.33 } });
renameResult = samplerPresets.renameSamplerPreset("Balanced", "Renamed Balanced");
assertJsonEqual(
    renameResult,
    { ok: true, name: "Renamed Balanced" },
    "a custom preset that shadows a built-in name should be renameable"
);
assertJsonEqual(
    samplerPresets.loadSamplerPresetStore(),
    { "Renamed Balanced": { temperature: 0.33 } },
    "renaming a shadowing custom preset should move the custom entry"
);

setStore({ Balanced: { temperature: 0.33 } });
assertJsonEqual(
    samplerPresets.renameSamplerPreset("Balanced", "BALANCED"),
    { ok: false, reason: "taken" },
    "re-casing a shadowing custom preset must not preserve a built-in collision"
);

setStore({ "My Sampler": { temperature: 0.33 } });
assertJsonEqual(
    samplerPresets.renameSamplerPreset("Nope", "Anything"),
    { ok: false, reason: "missing" },
    "renaming an unknown sampler preset should report missing"
);
assertJsonEqual(
    samplerPresets.renameSamplerPreset("Nope", "Nope"),
    { ok: false, reason: "missing" },
    "an identical target should not make a missing preset look successful"
);

assertJsonEqual(
    samplerPresets.renameSamplerPreset("My Sampler", "   "),
    { ok: false, reason: "empty" },
    "a whitespace-only sampler preset name should be rejected"
);

setStore({ "My Sampler": { temperature: 0.33 }, Other: { temperature: 0.5 } });
assertJsonEqual(
    samplerPresets.renameSamplerPreset("My Sampler", "other"),
    { ok: false, reason: "taken" },
    "a case-insensitive collision with another custom preset should be rejected"
);
assertJsonEqual(
    samplerPresets.renameSamplerPreset("My Sampler", "balanced"),
    { ok: false, reason: "taken" },
    "a case-insensitive collision with a built-in preset should be rejected"
);

setStore({ "my sampler": { temperature: 0.33 } });
renameResult = samplerPresets.renameSamplerPreset("my sampler", "My Sampler");
assertJsonEqual(renameResult, { ok: true, name: "My Sampler" }, "re-casing a preset's own name should be allowed");
assertJsonEqual(
    samplerPresets.loadSamplerPresetStore(),
    { "My Sampler": { temperature: 0.33 } },
    "a case-only rename should replace the old key"
);

setStore({ "My Sampler": { temperature: 0.33 } });
assertJsonEqual(
    samplerPresets.renameSamplerPreset("My Sampler", "My Sampler"),
    { ok: true, name: "My Sampler" },
    "renaming to the identical name should be a no-op success"
);

assert.equal(
    samplerPresets.getSamplerRenameMessage("builtin"),
    "Built-in sampler presets cannot be renamed.",
    "rename messages should be resolvable by reason"
);
assert.ok(
    samplerPresets.getSamplerRenameMessage("something-else"),
    "an unknown rename reason should still produce a message"
);

// --- saveSamplerPreset ---

// Both Save buttons fall back to the selected preset's own name when the name
// field is blank. Without excluding that name the taken check fired against the
// preset being saved, so Save could never update an existing custom preset.
setStore({ "My Sampler": { temperature: 0.33 } });
assertJsonEqual(
    samplerPresets.saveSamplerPreset("My Sampler", "My Sampler", { temperature: 0.9 }),
    { ok: true, name: "My Sampler" },
    "saving over the selected custom preset should update it, not report a collision"
);
assertJsonEqual(
    samplerPresets.loadSamplerPresetStore()["My Sampler"].temperature,
    0.9,
    "an update should overwrite the stored values"
);

setStore({ "My Sampler": { temperature: 0.33 }, Other: { temperature: 0.4 } });
assertJsonEqual(
    samplerPresets.saveSamplerPreset("Other", "My Sampler", { temperature: 0.9 }),
    { ok: false, reason: "taken" },
    "saving onto a different existing preset must still be rejected"
);
assertJsonEqual(
    samplerPresets.saveSamplerPreset("balanced", "My Sampler", { temperature: 0.9 }),
    { ok: false, reason: "taken" },
    "a built-in name must still be rejected even while updating a selection"
);

// Save is not a rename affordance (renameSamplerPreset owns the re-casing
// carve-out), so a case-differing name must still collide rather than silently
// re-key the preset.
setStore({ "My Sampler": { temperature: 0.33 } });
assertJsonEqual(
    samplerPresets.saveSamplerPreset("my sampler", "My Sampler", { temperature: 0.9 }),
    { ok: false, reason: "taken" },
    "a case-differing name must collide even against the selected preset"
);
assertJsonEqual(
    Object.keys(samplerPresets.loadSamplerPresetStore()),
    ["My Sampler"],
    "a rejected save must leave the store untouched"
);

setStore({});
assertJsonEqual(
    samplerPresets.saveSamplerPreset("  Fresh  ", "", { temperature: 0.5 }),
    { ok: true, name: "Fresh" },
    "a new preset should trim and save"
);
assertJsonEqual(
    samplerPresets.saveSamplerPreset("   ", "", { temperature: 0.5 }),
    { ok: false, reason: "empty" },
    "a blank name should be rejected"
);

console.log("sampler presets unit tests passed");
