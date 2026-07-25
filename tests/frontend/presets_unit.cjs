const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "presets.js"), "utf8");
const storageWarnings = [];
const context = {
    window: {},
    document: {
        getElementById: () => null,
    },
    console: {
        ...console,
        debug: () => {},
        warn: (...args) => storageWarnings.push(args),
    },
    localStorage: {
        getItem() {
            throw new Error("storage blocked");
        },
        setItem() {
            throw new Error("storage blocked");
        },
    },
    FLAGS: [
        { id: "temperature", default: 0.8 },
        { id: "ctx_size", default: 4096 },
        { id: "custom_args", default: "" },
        { id: "api_key", default: "" },
    ],
};

context.window = context;
context.window.LlamaGui = {};

vm.createContext(context);
assert.doesNotThrow(() => vm.runInContext(source, context, { filename: "presets.js" }));
assert.doesNotThrow(() => vm.runInContext("markPresetUsed('Blocked Storage Preset')", context));
assert.ok(storageWarnings.length > 0, "storage write failures should be logged without breaking preset actions");

const overrideIds = vm.runInContext(
    "getNonDefaultPresetFlagIds({ flags: { temperature: 0.8, ctx_size: 8192, custom_args: '' } })",
    context
);
assert.equal(JSON.stringify(Array.from(overrideIds)), JSON.stringify(["ctx_size"]));

const normalizeImportedPresetData = context.window.LlamaGui.presets.normalizeImportedPresetData;
const presetApi = context.window.LlamaGui.presets;

const normalized = normalizeImportedPresetData({
    tool: "llama-server",
    model: "model.gguf",
    flags: {
        temperature: 0.72,
        ctx_size: 8192,
        unknown_flag: "drop me",
        api_key: "must-not-import",
    },
});

assert.equal(
    JSON.stringify(normalized),
    JSON.stringify({
        tool: "llama-server",
        model: "model.gguf",
        flags: {
            temperature: 0.72,
            ctx_size: 8192,
        },
    })
);

assert.equal(
    JSON.stringify(context.window.LlamaGui.presets.stripSensitivePresetFlags({
        temperature: 0.5,
        api_key: "must-not-save",
    })),
    JSON.stringify({ temperature: 0.5 })
);

assert.equal(
    JSON.stringify(context.window.LlamaGui.presets.stripSensitivePresetFlags({
        temperature: 0.5,
        custom_args: "--api-key must-not-save --parallel 2",
    })),
    JSON.stringify({ temperature: 0.5 })
);

assert.throws(
    () => normalizeImportedPresetData({
        flags: { custom_args: "--metrics --api-key=must-not-import" },
    }),
    /Presets cannot include --api-key/
);

const legacyPlainFlags = normalizeImportedPresetData({
    temperature: 0.33,
    custom_args: "--parallel 4",
    stale_flag: "drop me",
});

assert.equal(
    JSON.stringify(legacyPlainFlags),
    JSON.stringify({
        tool: null,
        model: "",
        flags: {
            temperature: 0.33,
            custom_args: "--parallel 4",
        },
    })
);

const invalidTool = normalizeImportedPresetData({
    tool: "llama-bench",
    model: 123,
    flags: { temperature: 0.9 },
});

assert.equal(
    JSON.stringify(invalidTool),
    JSON.stringify({
        tool: null,
        model: "",
        flags: { temperature: 0.9 },
    })
);

assert.equal(presetApi.isFullPresetData({ tool: "llama-server", model: "a.gguf", flags: {} }), true);
assert.equal(presetApi.isFullPresetData({ temperature: 0.5 }), false);

const sourceEntry = {
    name: "Model A",
    data: {
        tool: "llama-server",
        model: "a.gguf",
        flags: { temperature: 0.25, tools: ["web_search"], api_key: "do-not-copy" },
    },
    modified: 123,
};
const sourceSnapshot = JSON.stringify(sourceEntry);
const foundEntry = presetApi.findPresetByName([sourceEntry], "Model A");
assert.equal(foundEntry.name, "Model A");
assert.equal(foundEntry.full, true);
assert.equal(foundEntry.data.flags.api_key, undefined);
assert.equal(presetApi.findPresetByName([sourceEntry], "model a"), null, "preset lookup should be exact");
foundEntry.data.flags.tools.push("mutated");
assert.equal(JSON.stringify(sourceEntry), sourceSnapshot, "normalized preset entries must not share array state");

const applied = [];
let currentApiKey = "session-secret";
context.window.LlamaGui.flagCore = {
    getFlagValues: () => ({ api_key: currentApiKey }),
    buildEffectiveFlagValues: (values) => ({ ctx_size: 4096, ...values }),
    setCurrentTool: (tool) => applied.push(["tool", tool]),
    setSelectedModelValue: (model) => applied.push(["model", model]),
    applyFlagValues: (flags) => applied.push(["flags", { ...flags }]),
};

const prepared = presetApi.preparePresetLaunchState(sourceEntry.data);
assert.equal(prepared.tool, "llama-server");
assert.equal(prepared.model, "a.gguf");
assert.equal(prepared.flags.ctx_size, 4096);
assert.equal(prepared.flags.api_key, "session-secret");
assert.equal(sourceEntry.data.flags.api_key, "do-not-copy", "preparing a preset must not mutate source data");

presetApi.applyPresetData(sourceEntry.data);
assert.equal(JSON.stringify(applied[0]), JSON.stringify(["tool", "llama-server"]));
assert.equal(JSON.stringify(applied[1]), JSON.stringify(["model", "a.gguf"]));
assert.equal(applied[2][0], "flags");
assert.equal(applied[2][1].api_key, "session-secret");
assert.equal(applied[2][1].ctx_size, 4096);

// favorites tri-state: needs a working storage, unlike the blocked-storage context above
function createStoredContext(initialStorage = {}) {
    const store = { ...initialStorage };
    const favoritesContext = {
        window: {},
        document: { getElementById: () => null },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
            setItem: (key, value) => { store[key] = String(value); },
        },
        FLAGS: [],
    };
    favoritesContext.window = favoritesContext;
    favoritesContext.window.LlamaGui = {};
    vm.createContext(favoritesContext);
    vm.runInContext(source, favoritesContext, { filename: "presets.js" });
    return favoritesContext;
}

const FAVORITES_KEY = "llama_gui_preset_favorites_first_v1";

assert.equal(
    vm.runInContext("presetFavoritesMode", createStoredContext()),
    "first",
    "favorites emphasis should default to sorting favorites first"
);
assert.equal(
    vm.runInContext("presetFavoritesMode", createStoredContext({ [FAVORITES_KEY]: "true" })),
    "first",
    "the legacy true value must migrate to first"
);
assert.equal(
    vm.runInContext("presetFavoritesMode", createStoredContext({ [FAVORITES_KEY]: "false" })),
    "all",
    "the legacy false value must migrate to all"
);
assert.equal(
    vm.runInContext("presetFavoritesMode", createStoredContext({ [FAVORITES_KEY]: "only" })),
    "only",
    "a stored tri-state value must load unchanged"
);

const cycleContext = createStoredContext();
assert.equal(
    JSON.stringify(vm.runInContext(
        "['all','first','only'].map(nextPresetFavoritesMode)",
        cycleContext
    )),
    JSON.stringify(["first", "only", "all"]),
    "the favorites chip must cycle all - first - only"
);

const filterContext = createStoredContext({
    [FAVORITES_KEY]: "only",
    llama_gui_preset_favorites_v1: JSON.stringify({ "Starred Preset": true }),
});
const favoriteOnlyGroups = vm.runInContext(`
    buildPresetGroups([
        { name: "Starred Preset", data: { tool: "llama-server", model: "a.gguf", flags: {} } },
        { name: "Plain Preset", data: { tool: "llama-server", model: "a.gguf", flags: {} } },
        { name: "Other Model Preset", data: { tool: "llama-server", model: "b.gguf", flags: {} } },
    ]).map(group => group.entries.map(entry => entry.name))
`, filterContext);
assert.equal(
    JSON.stringify(favoriteOnlyGroups),
    JSON.stringify([["Starred Preset"]]),
    "favorites-only must drop unstarred presets and their now-empty groups"
);

const emphasisContext = createStoredContext({
    [FAVORITES_KEY]: "first",
    llama_gui_preset_favorites_v1: JSON.stringify({ "Starred Preset": true }),
});
const favoriteFirstGroups = vm.runInContext(`
    buildPresetGroups([
        { name: "Plain Preset", data: { tool: "llama-server", model: "a.gguf", flags: {} } },
        { name: "Starred Preset", data: { tool: "llama-server", model: "a.gguf", flags: {} } },
    ]).map(group => group.entries.map(entry => entry.name))
`, emphasisContext);
assert.equal(
    JSON.stringify(favoriteFirstGroups),
    JSON.stringify([["Starred Preset", "Plain Preset"]]),
    "favorites-first must sort without filtering"
);

console.log("presets unit tests passed");
