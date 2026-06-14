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

console.log("sampler presets unit tests passed");
