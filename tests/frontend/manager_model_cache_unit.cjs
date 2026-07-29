// Covers the shared model-name cache in refreshModels() and the notification
// that keeps the Presets tab in step with it. The bug this guards against:
// refreshModels() updated the cache but nothing rebuilt the preset groups, so
// missing-model badges, the Warnings filter, and the library summary went stale
// whenever the model list moved while the Presets tab was already open.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "manager.js"), "utf8");

function makeElement() {
    const el = {
        children: [],
        value: "",
        textContent: "",
        style: {},
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener() {},
    };
    Object.defineProperty(el, "innerHTML", {
        set() {
            this.children = [];
        },
        get() {
            return "";
        },
        configurable: true,
    });
    return el;
}

// The cache is a Set built inside the vm realm, so `instanceof Set` here is
// false even when it is one. See the realm note in AGENTS.md; duck-type it.
function isSetLike(value) {
    return Boolean(value) && typeof value.has === "function" && typeof value.size === "number";
}

function createContext({ models, failFetch = false } = {}) {
    const modelSelect = makeElement();
    const presenceCalls = [];
    const context = {
        window: { addEventListener() {}, LlamaGui: {} },
        document: {
            createElement: () => makeElement(),
            getElementById: (id) => (id === "model-select" ? modelSelect : null),
        },
        console: { ...console, debug: () => {} },
        fetch: async () => {
            if (failFetch) throw new Error("network down");
            return { ok: true, json: async () => models };
        },
    };
    context.window.window = context.window;
    context.window.LlamaGui.presets = {
        refreshModelPresence: () => {
            // Record what the cache looked like at notification time, so the
            // test can prove presets are told *after* the cache settles.
            presenceCalls.push(context.getKnownModelNames());
        },
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "ui/js/manager.js" });
    return { context, presenceCalls, modelSelect };
}

(async () => {
    // Before any refresh the cache is unknown, which callers must not read as
    // "no models installed".
    const cold = createContext({ models: [] });
    assert.equal(cold.context.getKnownModelNames(), null, "the cache starts unknown, not empty");

    // A successful refresh caches lowercased .gguf names only.
    const ok = createContext({
        models: [
            { name: "Kept.GGUF", size_mb: 1 },
            { name: "other.gguf", size_mb: 2 },
            { name: "notes.txt", size_mb: 3 },
        ],
    });
    await ok.context.refreshModels();
    const names = ok.context.getKnownModelNames();
    assert.ok(isSetLike(names), "a successful refresh caches a Set");
    assert.equal(names.size, 2, "non-gguf entries are excluded from the cache");
    assert.equal(names.has("kept.gguf"), true, "names are lowercased for case-insensitive matching");
    assert.equal(names.has("notes.txt"), false);
    assert.equal(ok.presenceCalls.length, 1, "a successful refresh notifies the presets tab exactly once");
    assert.equal(
        ok.presenceCalls[0] && ok.presenceCalls[0].size,
        2,
        "presets are notified after the cache is populated, not before"
    );

    // An empty models folder is a known-empty result, distinct from unknown.
    const empty = createContext({ models: [] });
    await empty.context.refreshModels();
    const emptyNames = empty.context.getKnownModelNames();
    assert.ok(isSetLike(emptyNames) && emptyNames.size === 0, "an empty folder caches an empty Set");
    assert.equal(empty.presenceCalls.length, 1);

    // A failed refresh must clear the cache rather than leave a stale one, and
    // must still notify: "none found" becoming "not checked" changes the UI.
    const failed = createContext({ failFetch: true });
    await failed.context.refreshModels();
    assert.equal(failed.context.getKnownModelNames(), null, "a failed refresh clears the cache");
    assert.equal(failed.presenceCalls.length, 1, "the failure path notifies the presets tab too");
    assert.equal(failed.presenceCalls[0], null, "and does so after the cache was cleared");

    // A stale cache from an earlier success must not survive a later failure.
    const thenFailed = createContext({ models: [{ name: "kept.gguf", size_mb: 1 }] });
    await thenFailed.context.refreshModels();
    assert.equal(thenFailed.context.getKnownModelNames().size, 1);
    thenFailed.context.fetch = async () => {
        throw new Error("network down");
    };
    await thenFailed.context.refreshModels();
    assert.equal(
        thenFailed.context.getKnownModelNames(),
        null,
        "a later failure must drop the previously cached names"
    );

    // The notification is optional wiring: presets.js may not be loaded.
    const noPresets = createContext({ models: [] });
    noPresets.context.window.LlamaGui.presets = undefined;
    await assert.doesNotReject(
        () => noPresets.context.refreshModels(),
        "refreshModels must not depend on the presets module being present"
    );

    // A slower failed request must not clobber a newer successful refresh.
    const race = createContext({ models: [] });
    let resolveSlowFail;
    const slowFail = new Promise((_, reject) => {
        resolveSlowFail = () => reject(new Error("stale network down"));
    });
    let fetchCount = 0;
    race.context.fetch = async () => {
        fetchCount += 1;
        if (fetchCount === 1) await slowFail;
        return {
            ok: true,
            json: async () => [{ name: "fresh.gguf", size_mb: 1 }],
        };
    };
    const stale = race.context.refreshModels();
    const fresh = race.context.refreshModels();
    await fresh;
    assert.equal(race.context.getKnownModelNames().size, 1, "newer success must populate the cache");
    assert.equal(race.presenceCalls.length, 1, "only the winning refresh notifies");
    resolveSlowFail();
    await stale;
    assert.equal(
        race.context.getKnownModelNames() && race.context.getKnownModelNames().size,
        1,
        "a late failure must not wipe a newer success"
    );
    assert.equal(race.presenceCalls.length, 1, "a late failure must not re-notify presets");
    assert.equal(
        race.modelSelect.children.some((opt) => /Failed to load models/.test(opt.textContent)),
        false,
        "a late failure must not append a failure option onto the fresh list"
    );

    console.log("manager model cache unit tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
