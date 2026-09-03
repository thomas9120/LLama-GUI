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

assert.equal(presetApi.sanitizeImportedPresetName("  My/Preset?.json  "), "My_Preset_.json");
assert.equal(
    presetApi.findPresetImportNameCollision(
        [{ name: "Existing" }],
        [{ name: "existing" }, { name: "New" }]
    ),
    "existing",
    "preset imports must reject case-insensitive collisions with saved presets"
);
assert.equal(
    presetApi.findPresetImportNameCollision(
        [],
        [{ name: "Duplicate" }, { name: "DUPLICATE" }]
    ),
    "DUPLICATE",
    "bulk preset imports must reject duplicate names before any write"
);
assert.equal(
    presetApi.findPresetImportNameCollision(
        [{ name: "Existing" }],
        [{ name: "New One" }, { name: "New Two" }]
    ),
    "",
    "distinct imported preset names should pass collision validation"
);

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
// Presets are files named "<name>.json" and POST /api/presets overwrites by
// default, so on Windows/macOS a differently-cased name is the same file.
assert.equal(
    vm.runInContext("buildDuplicatePresetName('Base', new Set(['Base', 'base copy']))", duplicateContext),
    "Base copy 2",
    "a case-differing copy must still bump the suffix or it clobbers that file"
);
assert.equal(
    vm.runInContext("buildDuplicatePresetName('Foo', new Set(['Foo', 'FOO COPY', 'foo copy 2']))", duplicateContext),
    "Foo copy 3",
    "case-insensitive collisions must be skipped at every suffix, not just the base"
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

const deleteContext = createStoredContext({
    llama_gui_preset_favorites_v1: JSON.stringify({ Deleted: true, Kept: true }),
    llama_gui_preset_last_used_v1: JSON.stringify({ Deleted: 1234, Kept: 99 }),
});
vm.runInContext("deletePresetLocalState('Deleted')", deleteContext);
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetJsonMap('llama_gui_preset_favorites_v1'))", deleteContext),
    JSON.stringify({ Kept: true }),
    "confirmed deletion must remove only that preset's favorite"
);
assert.equal(
    vm.runInContext("JSON.stringify(loadPresetJsonMap('llama_gui_preset_last_used_v1'))", deleteContext),
    JSON.stringify({ Kept: 99 }),
    "confirmed deletion must remove only that preset's usage history"
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
function createModelContext(knownModelNames, initialStorage = {}) {
    const store = { ...initialStorage };
    const ctx = {
        window: {},
        document: { getElementById: () => null },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
            setItem: (key, value) => { store[key] = String(value); },
        },
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

const modelsPresent = createModelContext(new Set(["kept.gguf", "other.gguf", "vendor/nested.gguf"]));
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
assert.equal(isMissing(modelsPresent, "vendor/nested.gguf"), false, "relative subfolder paths must match exactly");
assert.equal(isMissing(modelsPresent, "nested.gguf"), false, "bare names must match a nested file basename");
assert.equal(isMissing(modelsPresent, "vendor/gone.gguf"), true, "a missing relative path must be flagged");

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

// A bare name held by two subfolders cannot be resolved, so it must warn rather
// than silently pick one. applyPresetModel() below must agree with this.
const ambiguousModels = createModelContext(new Set(["vendor-a/dup.gguf", "vendor-b/dup.gguf"]));
assert.equal(
    isMissing(ambiguousModels, "dup.gguf"),
    false,
    "an ambiguous basename must warn without inflating the missing-model count"
);
assert.equal(
    ambiguousModels.window.LlamaGui.presets.getPresetModelIssue("dup.gguf"),
    "ambiguous",
    "an unresolvable basename must be reported as ambiguous, not as missing"
);
const ambiguousWarnings = ambiguousModels.window.LlamaGui.presets.getPresetWarnings({
    model: "dup.gguf",
    flags: {},
});
assert.equal(ambiguousWarnings.length, 1, "an ambiguous model must surface exactly one warning");
assert.match(ambiguousWarnings[0], /more than one models subfolder/, "the warning must explain the ambiguity");
assert.equal(
    ambiguousModels.window.LlamaGui.presets.getPresetModelIssue("vendor-a/dup.gguf"),
    "",
    "the full relative path stays unambiguous"
);
const staleExplicitPath = createModelContext(new Set(["vendor-b/dup.gguf"]));
assert.equal(
    staleExplicitPath.window.LlamaGui.presets.getPresetModelIssue("vendor-a/dup.gguf"),
    "missing",
    "an explicit relative path must not fall back to a different folder"
);

// --- applyPresetModel must agree with the warning ---------------------------
// Regression: a legacy preset storing a bare name once reported healthy while the
// dropdown appended "<name>  (missing)" and the launch emitted a path that does
// not exist. Resolution and warning now share matchKnownModelName().
function createSelectContext(optionValues, knownModelNames) {
    const select = {
        options: optionValues.map((value) => ({ value, textContent: value })),
        value: "",
        appendChild(option) { this.options.push(option); },
    };
    const selected = [];
    const ctx = {
        window: {},
        document: {
            getElementById: (id) => (id === "model-select" ? select : null),
            createElement: () => ({ value: "", textContent: "" }),
        },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: { getItem: () => null, setItem: () => {} },
        FLAGS: [],
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = {
        manager: { getKnownModelNames: () => knownModelNames },
        flagCore: {
            setSelectedModelValue: (value) => selected.push(value),
            buildEffectiveFlagValues: (values) => ({ ...values }),
            getFlagValues: () => ({}),
        },
    };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    return { ctx, select, selected };
}

{
    const known = new Set(["kept.gguf", "vendor/nested.gguf"]);
    const { ctx, select, selected } = createSelectContext(["", "kept.gguf", "vendor/nested.gguf"], known);
    const optionCount = select.options.length;

    ctx.window.LlamaGui.presets.applyPresetModel("nested.gguf");
    assert.equal(select.value, "vendor/nested.gguf", "a legacy bare name must resolve to its nested path");
    assert.equal(selected.at(-1), "vendor/nested.gguf", "the launch must use the resolved path");
    assert.equal(select.options.length, optionCount, "resolving must not append a (missing) option");
    assert.equal(
        ctx.window.LlamaGui.presets.isPresetModelMissing("nested.gguf"),
        false,
        "the warning must agree that the resolved model is present"
    );
    assert.equal(
        ctx.window.LlamaGui.presets.preparePresetLaunchState({
            tool: "llama-server",
            model: "nested.gguf",
            flags: {},
        }).model,
        "vendor/nested.gguf",
        "Model Switcher launch preparation must use the same resolved path"
    );

    ctx.window.LlamaGui.presets.applyPresetModel("vendor/nested.gguf");
    assert.equal(select.value, "vendor/nested.gguf", "an exact relative path must select the same option");
    assert.equal(select.options.length, optionCount, "an exact match must not append an option either");

    ctx.window.LlamaGui.presets.applyPresetModel("VENDOR/NESTED.GGUF");
    assert.equal(select.value, "vendor/nested.gguf", "resolution must restore the option's exact spelling");
}

{
    // Both halves must still agree when the name genuinely cannot be resolved.
    const known = new Set(["vendor-a/dup.gguf", "vendor-b/dup.gguf"]);
    const { ctx, select } = createSelectContext(["", "vendor-a/dup.gguf", "vendor-b/dup.gguf"], known);

    ctx.window.LlamaGui.presets.applyPresetModel("dup.gguf");
    assert.equal(select.value, "dup.gguf", "an ambiguous basename must not silently pick a folder");
    assert.equal(select.options.at(-1).textContent, "dup.gguf  (missing)", "it must be marked in the dropdown");
    assert.equal(
        ctx.window.LlamaGui.presets.isPresetModelMissing("dup.gguf"),
        false,
        "ambiguity is a warning, not a missing file"
    );
}

{
    const known = new Set(["vendor-b/dup.gguf"]);
    const { ctx, select } = createSelectContext(["", "vendor-b/dup.gguf"], known);

    ctx.window.LlamaGui.presets.applyPresetModel("vendor-a/dup.gguf");
    assert.equal(select.value, "vendor-a/dup.gguf", "a stale explicit path must not select another folder");
    assert.equal(select.options.at(-1).textContent, "vendor-a/dup.gguf  (missing)");
}

{
    const known = new Set(["kept.gguf"]);
    const { ctx, select } = createSelectContext(["", "kept.gguf"], known);

    ctx.window.LlamaGui.presets.applyPresetModel("gone.gguf");
    assert.equal(select.value, "gone.gguf", "a genuine miss keeps the saved value");
    assert.equal(select.options.at(-1).textContent, "gone.gguf  (missing)", "a genuine miss is still marked");
    assert.equal(
        ctx.window.LlamaGui.presets.isPresetModelMissing("gone.gguf"),
        true,
        "a genuine miss must warn"
    );
}

// --- Library summary (preset-todo item 6) ----------------------------------
// The summary describes the visible presets, so its numbers always agree with
// the list beside it. buildPresetGroups() is driven through the real filters
// rather than hand-building currentPresetGroups, so the two cannot drift.
const summaryContext = createModelContext(new Set(["kept.gguf"]));
const summaryPresets = [
    { name: "alpha", data: { model: "kept.gguf", flags: {} } },
    { name: "beta", data: { model: "gone.gguf", flags: {} } },
    { name: "gamma", data: { model: "kept.gguf", flags: { custom_args: "--verbose" } } },
];
summaryContext.__presets = summaryPresets;
vm.runInContext("currentPresetGroups = buildPresetGroups(__presets)", summaryContext);

let summary = vm.runInContext("getPresetLibrarySummary()", summaryContext);
assert.equal(summary.presetCount, 3);
assert.equal(summary.modelCount, 2, "kept.gguf and gone.gguf are two model groups");
assert.equal(summary.missingModelCount, 1, "only the preset pointing at gone.gguf counts as missing");
assert.equal(summary.warningCount, 2, "one missing model plus one custom-args preset");
assert.equal(summary.filtered, false, "no search or filter is active");
assert.equal(summary.mostRecent, null, "an unused library has no most-recent preset");

const ambiguousSummaryContext = createModelContext(new Set(["vendor-a/dup.gguf", "vendor-b/dup.gguf"]));
ambiguousSummaryContext.__presets = [{ name: "ambiguous", data: { model: "dup.gguf", flags: {} } }];
vm.runInContext("currentPresetGroups = buildPresetGroups(__presets)", ambiguousSummaryContext);
const ambiguousSummary = vm.runInContext("getPresetLibrarySummary()", ambiguousSummaryContext);
assert.equal(ambiguousSummary.warningCount, 1, "an ambiguous legacy name remains actionable");
assert.equal(ambiguousSummary.missingModelCount, 0, "existing ambiguous files are not missing");

// A filtered view must report what is visible, not the whole library, or the
// summary would contradict the list and the count line next to it.
vm.runInContext("presetWarningFilterActive = true; currentPresetGroups = buildPresetGroups(__presets)", summaryContext);
summary = vm.runInContext("getPresetLibrarySummary()", summaryContext);
assert.equal(summary.presetCount, 2, "only the two presets with warnings remain visible");
assert.equal(summary.filtered, true, "the summary must announce that it is filtered");

vm.runInContext("presetWarningFilterActive = false; presetSearchQuery = 'alpha'; currentPresetGroups = buildPresetGroups(__presets)", summaryContext);
summary = vm.runInContext("getPresetLibrarySummary()", summaryContext);
assert.equal(summary.presetCount, 1);
assert.equal(summary.missingModelCount, 0, "the missing preset is filtered out, so it is not counted");
assert.equal(summary.filtered, true, "an active search counts as filtered");

// Most-recently-used must pick the newest entry, not the first or the last.
const usedContext = createModelContext(new Set(["kept.gguf"]), {
    llama_gui_preset_last_used_v1: JSON.stringify({
        alpha: 1000,
        beta: 9000,
        gamma: 5000,
    }),
});
usedContext.__presets = summaryPresets;
vm.runInContext("currentPresetGroups = buildPresetGroups(__presets)", usedContext);
summary = vm.runInContext("getPresetLibrarySummary()", usedContext);
assert.equal(summary.mostRecent.name, "beta", "the newest lastUsed entry must win");
assert.equal(summary.mostRecent.lastUsed, 9000);

// Health copy must never make an absolute claim while a filter is narrowing the
// view. The regression this guards: searching past a preset with a deleted GGUF
// rendered a green "every preset loads cleanly" all-clear over hidden rot.
const healthContext = createModelContext(new Set(["kept.gguf"]));
healthContext.__presets = [
    { name: "hermes-a", data: { model: "kept.gguf", flags: {} } },
    { name: "hermes-b", data: { model: "kept.gguf", flags: {} } },
    { name: "old-rig", data: { model: "gone.gguf", flags: {} } },
];
const healthMessage = (setup) => {
    vm.runInContext(`${setup}; currentPresetGroups = buildPresetGroups(__presets)`, healthContext);
    return vm.runInContext("getPresetHealthMessage(getPresetLibrarySummary())", healthContext);
};
const RESET = "presetSearchQuery = ''; presetWarningFilterActive = false; presetFavoritesMode = 'all'";

const unfilteredRot = healthMessage(RESET);
assert.match(unfilteredRot, /^1 preset points at a model file/, "an unfiltered view states the count plainly");
assert.match(unfilteredRot, /Use the Warnings filter/, "the review hint belongs on an unfiltered view");

const hiddenRot = healthMessage(`${RESET}; presetSearchQuery = 'hermes'`);
assert.doesNotMatch(
    hiddenRot,
    /Every preset/,
    "a filtered view that hides the only rotten preset must not claim every preset is clean"
);
assert.match(hiddenRot, /among the presets shown/, "a clean filtered view must scope its all-clear");
assert.match(hiddenRot, /Clear the search and filters/, "and must say how to check the rest");

assert.match(
    healthMessage(`${RESET}; presetSearchQuery = 'old'`),
    /^Of the presets shown, 1 preset points/,
    "counts under a filter must be scoped to what is visible"
);

// The Warnings filter cannot be the suggested next step when it is already on.
assert.doesNotMatch(
    healthMessage(`${RESET}; presetWarningFilterActive = true`),
    /Use the Warnings filter/,
    "advice to apply the already-active filter is dead advice"
);

// A clean count means "none found" only when the model list actually loaded.
// With no list it means "not checked", and claiming every model is present is
// the same false all-clear as the filtered case above.
const uncheckedContext = createModelContext(null);
uncheckedContext.__presets = [
    { name: "a", data: { model: "deleted-1.gguf", flags: {} } },
    { name: "b", data: { model: "deleted-2.gguf", flags: {} } },
];
vm.runInContext("currentPresetGroups = buildPresetGroups(__presets)", uncheckedContext);
const uncheckedSummary = vm.runInContext("getPresetLibrarySummary()", uncheckedContext);
assert.equal(uncheckedSummary.modelsChecked, false, "a null model cache means presence was not checked");
assert.equal(uncheckedSummary.missingModelCount, 0, "and the count stays silent, as designed");

const uncheckedMessage = vm.runInContext("getPresetHealthMessage(getPresetLibrarySummary())", uncheckedContext);
assert.doesNotMatch(
    uncheckedMessage,
    /model that is present/,
    "an unloaded model list must not produce an all-clear about model presence"
);
assert.match(uncheckedMessage, /not checked/, "it must say plainly which check did not run");

// The same applies under a filter, where both caveats are in play at once.
vm.runInContext("presetSearchQuery = 'a'; currentPresetGroups = buildPresetGroups(__presets)", uncheckedContext);
const uncheckedFiltered = vm.runInContext("getPresetHealthMessage(getPresetLibrarySummary())", uncheckedContext);
assert.match(uncheckedFiltered, /presets shown/, "the filtered scope is still stated");
assert.match(uncheckedFiltered, /not checked/, "and so is the skipped model check");

// Unfiltered and clean is the one case allowed to speak for the whole library.
const cleanContext = createModelContext(new Set(["kept.gguf"]));
cleanContext.__presets = [{ name: "alpha", data: { model: "kept.gguf", flags: {} } }];
vm.runInContext("currentPresetGroups = buildPresetGroups(__presets)", cleanContext);
assert.match(
    vm.runInContext("getPresetHealthMessage(getPresetLibrarySummary())", cleanContext),
    /Every preset points at a model that is present/,
    "an unfiltered clean library may still give an absolute all-clear"
);

const formatPresetTimestamp = summaryContext.window.LlamaGui.presets.formatPresetTimestamp;
assert.equal(formatPresetTimestamp(0), "", "a preset never used has no timestamp to show");
assert.equal(formatPresetTimestamp(Date.now()), "Just now");
assert.equal(formatPresetTimestamp(Date.now() - 5 * 60000), "5m ago");
assert.equal(formatPresetTimestamp(Date.now() - 3 * 3600000), "3h ago");

// --- Search across override flags (preset-todo item 4) ---------------------
// Driven through buildPresetGroups with the real flag definitions, so the
// examples named in the todo are pinned against the shipping flag list rather
// than a stub that could drift from it.
// definitions.js reads shared constants from its sibling modules, so the whole
// set loads in the same order ui/index.html uses.
const FLAG_SOURCES = [
    "ui/js/flags/categories.js",
    "ui/js/flags/options.js",
    "ui/js/flags/chat-templates.js",
    "ui/js/flags/definitions.js",
];

function createSearchContext() {
    const ctx = {
        window: {},
        document: { getElementById: () => null },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: { getItem: () => null, setItem: () => {} },
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = { manager: { getKnownModelNames: () => null } };
    vm.createContext(ctx);
    for (const relativePath of FLAG_SOURCES) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, relativePath), "utf8"), ctx, {
            filename: relativePath,
        });
    }
    // A top-level `const` in a vm script lives in the shared global lexical
    // scope, which later scripts see but the context object does not expose.
    // presets.js therefore resolves FLAGS fine; the test has to ask for it.
    const flagCount = vm.runInContext("Array.isArray(FLAGS) ? FLAGS.length : -1", ctx);
    assert.ok(flagCount > 100, `expected the real FLAGS list, got ${flagCount}`);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    return ctx;
}

const searchContext = createSearchContext();
searchContext.__presets = [
    { name: "long-context", data: { model: "a.gguf", flags: { ctx_size: 200000 } } },
    { name: "speculative", data: { model: "b.gguf", flags: { draft_max: 24 } } },
    { name: "gpu-tuned", data: { model: "c.gguf", flags: { flash_attn: "on" } } },
    // Carries ctx_size at its shipping default, so it must not match "ctx".
    { name: "plain", data: { model: "d.gguf", flags: { ctx_size: 64000 } } },
];
assert.equal(
    searchContext.window.LlamaGui.presets.getPresetLibrarySummary === undefined,
    false,
    "sanity: the presets namespace is populated in this context"
);

function searchNames(query) {
    vm.runInContext(
        `presetSearchQuery = ${JSON.stringify(query)}; currentPresetGroups = buildPresetGroups(__presets)`,
        searchContext
    );
    return vm.runInContext("getVisiblePresetEntries().map((e) => e.name).sort()", searchContext).join(",");
}

// The three examples the todo calls out by name.
assert.equal(searchNames("ctx"), "long-context", "'ctx' must find the preset that tuned ctx_size");
assert.equal(searchNames("draft"), "speculative", "'draft' must find the preset that set a draft flag");
assert.equal(searchNames("flash"), "gpu-tuned", "'flash' must find the preset that set flash_attn");

// Human labels are searchable too, not just raw ids.
assert.equal(searchNames("flash attention"), "gpu-tuned", "the flag label must be searchable");
assert.equal(searchNames("context window"), "long-context", "'ctx_size' is labelled Total Context Window");
// The de-underscored id, which neither the raw id nor the label contains.
assert.equal(searchNames("ctx size"), "long-context", "an id typed with a space must still match");

// Only non-default flags are folded in, so search returns presets that actually
// changed a setting rather than every preset that has the flag.
// "plain" carries ctx_size: 64000, the shipping default, so it holds the flag
// but did not change it. Matching it would make the search return the whole
// library for any common flag name.
assert.equal(
    searchNames("ctx"),
    "long-context",
    "a preset holding a flag at its default must not match that flag name"
);

// The pre-existing search fields must keep working.
assert.equal(searchNames("long-context"), "long-context", "name search must still work");
assert.equal(searchNames("c.gguf"), "gpu-tuned", "model search must still work");
assert.equal(searchNames("zzz-no-match"), "", "an unmatched query returns nothing");

// The text is precomputed on the entry, not rebuilt per keystroke.
vm.runInContext("presetSearchQuery = ''; currentPresetGroups = buildPresetGroups(__presets)", searchContext);
assert.equal(
    vm.runInContext("typeof getVisiblePresetEntries()[0].searchText", searchContext),
    "string",
    "buildPresetGroups must precompute searchText onto each entry"
);
// getPresetSearchText must stay correct for an entry built outside that path.
assert.match(
    vm.runInContext(
        "getPresetSearchText({ name: 'Ad Hoc', groupKey: 'x.gguf', modelLabel: 'x.gguf', toolText: 'llama-server', overrideFlagIds: ['ctx_size'] })",
        searchContext
    ),
    /ctx_size/,
    "an entry without precomputed text must fall back to building it"
);

// Label lookup is cached on the definitions array identity.
const flagLabel = searchContext.window.LlamaGui.presets.getPresetFlagLabel;
assert.equal(flagLabel("ctx_size"), "Total Context Window");
assert.equal(flagLabel("flash_attn"), "Flash Attention");
assert.equal(flagLabel("not_a_real_flag"), "not a real flag", "an unknown id degrades to spaced text");
searchContext.FLAGS = [{ id: "ctx_size", label: "Replaced Label" }];
assert.equal(
    flagLabel("ctx_size"),
    "Replaced Label",
    "replacing the definitions array must invalidate the label cache"
);

// --- refreshModelPresence guard (PR #231 follow-up) ------------------------
// Rebuilds only while the Presets tab is actually on screen. The guard keys on
// #section-presets, because #presets-list is static markup in index.html and is
// present even for a user who has never opened the tab.
function createPresenceContext(sectionDisplay) {
    const section = sectionDisplay === null ? null : { style: { display: sectionDisplay } };
    const ctx = {
        window: {},
        document: {
            getElementById: (id) => (id === "section-presets" ? section : null),
        },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: { getItem: () => null, setItem: () => {} },
        FLAGS: [],
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = { manager: { getKnownModelNames: () => null } };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    // Count rebuilds without performing one; loadPresets would hit the network.
    vm.runInContext("__rebuilds = 0; loadPresets = () => { __rebuilds++; }", ctx);
    return ctx;
}

const visibleTab = createPresenceContext("");
vm.runInContext("refreshModelPresence()", visibleTab);
assert.equal(visibleTab.__rebuilds, 1, "a visible Presets tab must rebuild when the model list changes");

const hiddenTab = createPresenceContext("none");
vm.runInContext("refreshModelPresence()", hiddenTab);
assert.equal(hiddenTab.__rebuilds, 0, "a hidden Presets tab must not fetch presets on every model refresh");

const noSection = createPresenceContext(null);
vm.runInContext("refreshModelPresence()", noSection);
assert.equal(noSection.__rebuilds, 0, "a missing section must be safe rather than throwing");

function createPresetLoadElement() {
    const classes = new Set();
    const element = {
        children: [],
        disabled: false,
        className: "",
        _textContent: "",
        classList: {
            toggle(name, force) {
                const add = force === undefined ? !classes.has(name) : Boolean(force);
                if (add) classes.add(name); else classes.delete(name);
                return add;
            },
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
    };
    Object.defineProperty(element, "textContent", {
        get() {
            return this._textContent;
        },
        set(value) {
            this._textContent = String(value || "");
            this.children = [];
        },
    });
    return element;
}

async function testPresetRefreshPreservesMissingFavorite() {
    const store = {
        llama_gui_preset_favorites_v1: JSON.stringify({ Visible: true, TemporarilyMissing: true }),
    };
    const container = createPresetLoadElement();
    const ctx = {
        window: {},
        document: {
            getElementById: (id) => (id === "presets-list" ? container : null),
        },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
            setItem: (key, value) => { store[key] = String(value); },
        },
        FLAGS: [],
        fetchJson: async () => [{ name: "Visible", data: { model: "", flags: {} } }],
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = { manager: { getKnownModelNames: () => null } };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    vm.runInContext("renderPresetGroups = () => {}", ctx);

    await vm.runInContext("loadPresets()", ctx);

    assert.equal(
        store.llama_gui_preset_favorites_v1,
        JSON.stringify({ Visible: true, TemporarilyMissing: true }),
        "an incomplete successful refresh must not discard favorites"
    );
}

async function testPresetLoadFailureClearsAuxiliaryState() {
    const elements = new Map();
    for (const id of [
        "presets-list",
        "preset-detail-panel",
        "presets-selection-count",
        "btn-presets-delete-selected",
        "btn-presets-export-selected",
        "btn-presets-select-none",
        "btn-presets-favorite-selected",
        "btn-presets-unfavorite-selected",
        "presets-browser",
        "presets-count-line",
    ]) {
        elements.set(id, createPresetLoadElement());
    }
    elements.get("preset-detail-panel").appendChild({ textContent: "Stale preset actions" });

    const ctx = {
        window: {},
        document: {
            createElement: () => createPresetLoadElement(),
            getElementById: (id) => elements.get(id) || null,
        },
        console: { ...console, debug: () => {}, warn: () => {} },
        localStorage: { getItem: () => null, setItem: () => {} },
        FLAGS: [],
        fetchJson: async () => {
            throw new Error("network down");
        },
    };
    ctx.window = ctx;
    ctx.window.LlamaGui = { manager: { getKnownModelNames: () => null } };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: "presets.js" });
    vm.runInContext(
        "currentPresetGroups = [{ key: 'stale', entries: [] }]; selectedPresetName = 'stale'; selectedPresetNames.add('stale')",
        ctx
    );

    await vm.runInContext("loadPresets()", ctx);

    assert.equal(vm.runInContext("currentPresetGroups.length", ctx), 0);
    assert.equal(vm.runInContext("selectedPresetName", ctx), "");
    assert.equal(vm.runInContext("selectedPresetNames.size", ctx), 0);
    assert.match(elements.get("presets-list").children[0].textContent, /Failed to load presets/);
    assert.equal(elements.get("preset-detail-panel").children.length, 1, "stale preset actions must be removed");
    assert.match(elements.get("preset-detail-panel").children[0].textContent, /library unavailable/);
    assert.equal(elements.get("btn-presets-delete-selected").disabled, true);
    assert.equal(elements.get("presets-count-line").textContent, "0 presets · 0 models");
}

// --- Archive view ------------------------------------------------------------
// Archived presets stay in the library (still loadable by name or shortcut)
// but are hidden from the main list; the archive view shows only them.
{
    const ctx = createModelContext(new Set(["kept.gguf"]));
    ctx.__presets = [
        { name: "daily", archived: false, data: { model: "kept.gguf", flags: {} } },
        { name: "shelved", archived: true, data: { model: "kept.gguf", flags: {} } },
    ];
    // joined before compare: a vm-context array is not host Array, so
    // deepStrictEqual would fail on the prototype even with equal contents
    const visibleNames = () => vm.runInContext("getVisiblePresetEntries().map((e) => e.name).join(',')", ctx);

    vm.runInContext("currentPresetGroups = buildPresetGroups(__presets)", ctx);
    assert.equal(visibleNames(), "daily", "archived presets are hidden from the main list");
    assert.equal(vm.runInContext("getPresetLibrarySummary().filtered", ctx), false);

    vm.runInContext("presetArchiveViewActive = true; currentPresetGroups = buildPresetGroups(__presets)", ctx);
    assert.equal(visibleNames(), "shelved", "the archive view shows only archived presets");
    assert.equal(
        vm.runInContext("getPresetLibrarySummary().filtered", ctx),
        true,
        "the archive view reports itself as filtered so the summary stays scoped"
    );

    vm.runInContext("presetArchiveViewActive = false", ctx);
}

async function testSetPresetArchivedPostsBatchPayload() {
    const ctx = createModelContext(new Set(["kept.gguf"]));
    const calls = [];
    ctx.fetchJson = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { archived: options ? JSON.parse(options.body).archived : true, count: 1 };
    };
    vm.runInContext("selectedPresetNames = new Set(['shelved'])", ctx);

    await vm.runInContext("setPresetArchived(['shelved'], true)", ctx);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/presets/archive");
    assert.deepEqual(calls[0].body, { names: ["shelved"], archived: true });
    assert.equal(
        vm.runInContext("selectedPresetNames.size", ctx),
        0,
        "presets moved to the archive leave the current view, so they must leave the selection"
    );

    await vm.runInContext("setPresetArchived('solo', false)", ctx);
    assert.deepEqual(calls[1].body, { names: ["solo"], archived: false }, "a bare name is wrapped into a batch");
}

testSetPresetArchivedPostsBatchPayload()
    .then(() => testPresetRefreshPreservesMissingFavorite())
    .then(() => testPresetLoadFailureClearsAuxiliaryState())
    .then(() => console.log("presets unit tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
