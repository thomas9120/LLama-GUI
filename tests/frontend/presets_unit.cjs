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

// duplicate naming
const duplicateContext = createStoredContext();
assert.equal(
    vm.runInContext("buildDuplicatePresetName('Base', new Set(['Base']))", duplicateContext),
    "Base copy"
);
assert.equal(
    vm.runInContext("buildDuplicatePresetName('Base', new Set(['Base', 'Base copy']))", duplicateContext),
    "Base copy 2",
    "an existing copy must bump the suffix rather than collide"
);
assert.equal(
    vm.runInContext("buildDuplicatePresetName('Base', new Set(['Base', 'Base copy', 'Base copy 2']))", duplicateContext),
    "Base copy 3"
);
assert.equal(
    vm.runInContext("buildDuplicatePresetName('Base', ['Base', 'Base copy'])", duplicateContext),
    "Base copy 2",
    "an array of names must work like a Set"
);

// rename carries name-keyed local state across
const renameContext = createStoredContext({
    llama_gui_preset_favorites_v1: JSON.stringify({ Original: true, Other: true }),
    llama_gui_preset_last_used_v1: JSON.stringify({ Original: 1234, Other: 99 }),
    llama_gui_preset_group_state_v1: JSON.stringify({ "models/a.gguf": false }),
});
vm.runInContext("renamePresetLocalState('Original', 'Renamed')", renameContext);
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetJsonMap('llama_gui_preset_favorites_v1'))", renameContext),
    JSON.stringify({ Other: true, Renamed: true }),
    "favorites must follow the rename"
);
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetJsonMap('llama_gui_preset_last_used_v1'))", renameContext),
    JSON.stringify({ Other: 99, Renamed: 1234 }),
    "last-used must follow the rename"
);
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetGroupState())", renameContext),
    JSON.stringify({ "models/a.gguf": false }),
    "group collapse state is keyed by model and must not change on rename"
);

const untrackedRenameContext = createStoredContext({
    llama_gui_preset_favorites_v1: JSON.stringify({ Other: true }),
});
vm.runInContext("renamePresetLocalState('Original', 'Renamed')", untrackedRenameContext);
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetJsonMap('llama_gui_preset_favorites_v1'))", untrackedRenameContext),
    JSON.stringify({ Other: true }),
    "renaming a preset with no local state must not invent entries"
);

// bulk favorite/unfavorite: one storage write for the whole selection
function countWrites(ctx) {
    return vm.runInContext("__writes", ctx);
}

function createWriteCountingContext(initialStorage = {}) {
    const store = { ...initialStorage };
    const ctx = {
        window: {},
        document: { getElementById: () => null },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
            setItem(key, value) {
                store[key] = String(value);
                ctx.__writes++;
            },
        },
        FLAGS: [],
        __writes: 0,
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = {};
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    ctx.__writes = 0;
    return ctx;
}

let bulkContext = createWriteCountingContext();
assert.equal(
    vm.runInContext("setPresetsFavorite(['a', 'b', 'c'], true)", bulkContext),
    3,
    "favoriting three unstarred presets must report three changes"
);
assert.equal(countWrites(bulkContext), 1, "a bulk favorite must write storage exactly once");
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetJsonMap('llama_gui_preset_favorites_v1'))", bulkContext),
    JSON.stringify({ a: true, b: true, c: true })
);

bulkContext = createWriteCountingContext({
    llama_gui_preset_favorites_v1: JSON.stringify({ a: true, b: true }),
});
assert.equal(
    vm.runInContext("setPresetsFavorite(['a', 'b'], true)", bulkContext),
    0,
    "re-favoriting already-starred presets must report no changes"
);
assert.equal(countWrites(bulkContext), 0, "a no-op bulk favorite must not touch storage");

bulkContext = createWriteCountingContext({
    llama_gui_preset_favorites_v1: JSON.stringify({ a: true, b: true, keep: true }),
});
assert.equal(vm.runInContext("setPresetsFavorite(['a', 'b', 'missing'], false)", bulkContext), 2);
assert.equal(countWrites(bulkContext), 1);
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetJsonMap('llama_gui_preset_favorites_v1'))", bulkContext),
    JSON.stringify({ keep: true }),
    "unfavoriting must only remove the named presets"
);

bulkContext = createWriteCountingContext();
assert.equal(vm.runInContext("setPresetsFavorite([], true)", bulkContext), 0);
assert.equal(vm.runInContext("setPresetsFavorite(undefined, true)", bulkContext), 0, "a missing list must be safe");
assert.equal(countWrites(bulkContext), 0);

// --- Missing model warnings (preset-todo item 9) ---------------------------
// The check must only fire on a confident miss. Anything else - an unknown
// model list, an empty models/ folder, a preset with no model - stays silent,
// because presets for models kept on another machine are legitimate.
function createModelContext(knownModelNames) {
    const ctx = {
        window: {},
        document: { getElementById: () => null },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: { getItem: () => null, setItem: () => {} },
        FLAGS: [],
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = {
        manager: { getKnownModelNames: () => knownModelNames },
    };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    return ctx;
}

const modelsPresent = createModelContext(new Set(["kept.gguf", "other.gguf"]));
const isMissing = (ctx, model) => ctx.window.LlamaGui.presets.isPresetModelMissing(model);

assert.equal(isMissing(modelsPresent, "gone.gguf"), true, "a model absent from models/ must be flagged");
assert.equal(isMissing(modelsPresent, "kept.gguf"), false, "a model present in models/ must not be flagged");
assert.equal(isMissing(modelsPresent, "KEPT.GGUF"), false, "the name match must ignore case");
assert.equal(isMissing(modelsPresent, ""), false, "a preset with no model saved is not library rot");
assert.equal(
    isMissing(modelsPresent, "C:\\models\\kept.gguf"),
    false,
    "a path-like model value must match on its file name"
);
assert.equal(isMissing(modelsPresent, "/srv/models/kept.gguf"), false, "posix paths must match on file name too");

// An unknown list must never be read as proof that a model is gone.
assert.equal(isMissing(createModelContext(null), "gone.gguf"), false, "a failed model fetch must not warn");
assert.equal(isMissing(createModelContext(new Set()), "gone.gguf"), false, "an empty models folder must not warn");
assert.equal(
    createModelContext(undefined).window.LlamaGui.presets.isPresetModelMissing("gone.gguf"),
    false,
    "a manager without the cache accessor must not warn"
);

const missingWarnings = modelsPresent.window.LlamaGui.presets.getPresetWarnings({
    model: "gone.gguf",
    flags: {},
});
assert.equal(missingWarnings.length, 1, "a missing model must surface exactly one warning");
assert.match(missingWarnings[0], /gone\.gguf/, "the warning must name the missing file");
assert.equal(
    modelsPresent.window.LlamaGui.presets.getPresetWarnings({ model: "kept.gguf", flags: {} }).length,
    0,
    "a preset whose model still exists must be warning-free"
);

console.log("presets unit tests passed");
