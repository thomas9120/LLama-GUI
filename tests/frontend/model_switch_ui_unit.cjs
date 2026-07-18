const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "model-switch-ui.js"), "utf8");
const appSource = fs.readFileSync(path.join(ROOT, "ui", "js", "app.js"), "utf8");
const managerSource = fs.readFileSync(path.join(ROOT, "ui", "js", "manager.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");
const styleSource = fs.readFileSync(path.join(ROOT, "ui", "css", "style.css"), "utf8");

function createContext(storage) {
    const warnings = [];
    const context = {
        window: {},
        localStorage: storage,
        console: {
            ...console,
            warn: (...args) => warnings.push(args),
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "model-switch-ui.js" });
    return { context, api: context.window.LlamaGui.modelSwitchUi, warnings };
}

let storedValue = null;
const storage = {
    getItem: () => storedValue,
    setItem: (_key, value) => { storedValue = value; },
};
const { api } = createContext(storage);

assert.equal(
    JSON.stringify(api.getAssignments()),
    JSON.stringify({ version: 1, slots: { a: { preset: "" }, b: { preset: "" } } })
);

api.setAssignment("a", "  Model A  ");
api.setAssignment("b", "Model B");
assert.equal(api.getAssignments().slots.a.preset, "Model A");
assert.equal(api.getAssignments().slots.b.preset, "Model B");
assert.throws(() => api.setAssignment("b", "Model A"), /same preset/);
assert.throws(() => api.setAssignment("c", "Model C"), /slot/);
assert.throws(() => api.setAssignment("a", "x".repeat(129)), /128/);
assert.throws(() => api.setAssignment("a", "bad\u0000name"), /control/);
assert.throws(() => api.setAssignment("a", "bad\u202ename"), /control/);

const snapshot = api.getAssignments();
snapshot.slots.a.preset = "mutated";
assert.equal(api.getAssignments().slots.a.preset, "Model A", "assignment snapshots must be defensive copies");

const persisted = JSON.parse(storedValue);
assert.equal(
    JSON.stringify(persisted),
    JSON.stringify({ version: 1, slots: { a: { preset: "Model A" }, b: { preset: "Model B" } } })
);
assert.ok(!storedValue.includes("api_key"));
assert.ok(!storedValue.includes("flags"));

storedValue = JSON.stringify({
    version: 1,
    slots: {
        a: { preset: "Same", api_key: "secret", flags: { temperature: 1 } },
        b: { preset: "Same" },
        c: { preset: "Ignored" },
    },
    api_key: "secret",
});
api.reloadAssignments();
assert.equal(api.getAssignments().slots.a.preset, "Same");
assert.equal(api.getAssignments().slots.b.preset, "Same");
assert.match(api.getAssignmentIssues().a, /same preset/);
assert.ok(!storedValue.includes("api_key"), "loading v1 storage should remove unexpected secrets");
assert.ok(!storedValue.includes("flags"), "loading v1 storage should remove embedded flag state");
assert.ok(!storedValue.includes("Ignored"), "loading v1 storage should remove unsupported slots");
api.clearAssignment("b");
assert.equal(api.getAssignmentIssues().a, undefined);

storedValue = JSON.stringify({ version: 2, slots: {} });
api.reloadAssignments();
assert.match(api.getStorageStatus().warning, /unsupported version/);
assert.equal(api.getAssignments().slots.a.preset, "");

storedValue = "{not json";
api.reloadAssignments();
assert.match(api.getStorageStatus().warning, /could not be read/);

const blocked = createContext({
    getItem() { throw new Error("blocked read"); },
    setItem() { throw new Error("blocked write"); },
});
blocked.api.setAssignment("a", "Session Model");
assert.equal(blocked.api.getAssignments().slots.a.preset, "Session Model");
assert.equal(blocked.api.getStorageStatus().persistent, false);
assert.match(blocked.api.getStorageStatus().warning, /session only/);
assert.ok(blocked.warnings.length >= 2, "storage failures should be logged");

assert.match(indexHtml, /id="model-switch-card"/);
assert.match(indexHtml, /id="model-switch-toggle"[^>]+aria-controls="model-switch-body"/);
assert.doesNotMatch(indexHtml, /model-switch-manage-toggle/, "manage mode should be replaced by inline slot selects");
assert.match(indexHtml, /id="model-switch-slot-a"[\s\S]*?id="model-switch-select-a"/, "slot A should carry its own preset select");
assert.match(indexHtml, /id="model-switch-slot-b"[\s\S]*?id="model-switch-select-b"/, "slot B should carry its own preset select");
assert.match(indexHtml, /Standby means the model configuration is saved and ready to preflight/);
assert.match(
    styleSource,
    /\.model-switch-details\s*{[^}]*grid-template-columns:\s*repeat\(2,/,
    "the two remaining Model Switcher details should use a two-column grid"
);
assert.match(indexHtml, /id="sidebar-model-switcher-slider"[\s\S]*?role="slider"/);
assert.match(indexHtml, /id="sidebar-model-switcher-slider"[\s\S]*?aria-disabled="true"/);
assert.ok(
    indexHtml.indexOf('id="sidebar-model-switcher"') < indexHtml.indexOf('class="theme-switcher"'),
    "the compact model slider should sit above the theme switcher"
);
const sidebarSwitcherMarkup = indexHtml.match(/<section class="sidebar-model-switcher"[\s\S]*?<\/section>/)?.[0] || "";
assert.doesNotMatch(sidebarSwitcherMarkup, /<svg/, "the sidebar switch thumb should not contain an icon");
assert.match(source, /sidebarThumb\.addEventListener\("pointerdown", handleSidebarPointerDown\)/);
assert.doesNotMatch(source, /sidebarThumb\.addEventListener\("click"/, "thumb clicks must not switch models");
assert.match(appSource, /\/api\/presets\/fingerprint/);
assert.doesNotMatch(appSource, /crypto\.subtle/, "drift fingerprints must use backend canonicalization");
assert.match(source, /handleAssignmentChange[\s\S]*refresh\(\{ reloadPresets: true \}\)/);
assert.match(managerSource, /await acceptedStatusObserver\(status\)/);
assert.match(appSource, /setAcceptedStatusObserver\(reconcileAuthoritativeStatus\)/);
assert.match(
    appSource,
    /shouldAdoptBenchmark[\s\S]*benchmarkUi\.restoreRunningState\(status\)/,
    "authoritative benchmark replacements must adopt benchmark controls and output polling"
);
assert.match(
    appSource,
    /reconcileOptions[\s\S]*onFailed: handleReconciliationFailure/,
    "observer-driven health failures must not call the status-refreshing global failure hook"
);
assert.match(
    appSource,
    /invalidateOutput:\s*stopOutputPolling,\s*startOutput:\s*\(\.\.\.args\)\s*=>\s*\{\s*clearOutput\(\);\s*handleLifecycleProcessStarted\(\.\.\.args\);\s*\}/,
    "switches must preserve prior output until the replacement process is accepted"
);
assert.ok(
    indexHtml.indexOf('id="model-switch-card"') < indexHtml.indexOf('class="quick-grid"'),
    "model switcher card should appear before the existing Quick Launch grid"
);

const entries = [
    {
        name: "Model A Preset",
        full: true,
        fingerprint: "a".repeat(64),
        data: { tool: "llama-server", model: "alpha.gguf", flags: { alias: "alpha-api" } },
    },
    {
        name: "Model B Preset",
        full: true,
        fingerprint: "b".repeat(64),
        data: { tool: "llama-server", model: "beta.gguf", flags: {} },
    },
    {
        name: "CLI Preset",
        full: true,
        data: { tool: "llama-cli", model: "cli.gguf", flags: {} },
    },
];
api.configure({
    findPresetByName(list, name) {
        return list.find(entry => entry.name === name) || null;
    },
    getPresetFingerprint: entry => entry.fingerprint || "",
});

function slotViews(overrides = {}) {
    return api.buildSlotViews({
        entries,
        assignments: {
            version: 1,
            slots: {
                a: { preset: "Model A Preset" },
                b: { preset: "Model B Preset" },
            },
        },
        issues: {},
        status: {},
        lifecycle: {},
        failures: {},
        ...overrides,
    });
}

let views = slotViews();
assert.deepEqual(Array.from(views, view => view.state), ["standby", "standby"]);
assert.equal(views[0].model, "alpha-api");
assert.equal(views[0].gguf, "alpha.gguf");
assert.equal(api.selectActionSlot(views), "a", "only one initial target action should be selected");

const activeRuntime = {
    tool: "llama-server",
    source: "model-switcher",
    slot: "a",
    preset: "Model A Preset",
    model: "models/alpha.gguf",
    preset_fingerprint: "a".repeat(64),
};
views = slotViews({
    status: { running: true, active_runtime: activeRuntime },
    lifecycle: { phase: "ready", activeRuntime, busy: false },
});
assert.deepEqual(Array.from(views, view => view.state), ["active", "standby"]);
assert.equal(api.selectActionSlot(views), "b", "the non-active slot should be the sole switch target");

let sidebarState = api.buildSidebarSliderState(views, { phase: "ready", busy: false }, "a", true);
assert.equal(sidebarState.activeSlot, "a");
assert.equal(sidebarState.committedSlot, "a");
assert.equal(sidebarState.targetSlot, "b");
assert.equal(sidebarState.enabled, true);
assert.equal(sidebarState.status, "Drag to switch");

sidebarState = api.buildSidebarSliderState(slotViews(), { phase: "idle", busy: false }, "a", true);
assert.equal(sidebarState.committedSlot, "a", "the inactive slider should default visually to A");
assert.equal(sidebarState.enabled, false, "the sidebar shortcut must not become an initial launch surface");
assert.match(sidebarState.status, /Quick Launch first/);

sidebarState = api.buildSidebarSliderState(views, { phase: "ready", busy: true }, "a", true);
assert.equal(sidebarState.enabled, false, "a busy lifecycle must lock the sidebar slider");

assert.equal(api.resolveSidebarDragTarget("a", 0.95, false), "", "a click without movement must not switch");
assert.equal(api.resolveSidebarDragTarget("a", 0.6, true), "", "a short drag must snap back");
assert.equal(api.resolveSidebarDragTarget("a", 0.72, true), "b");
assert.equal(api.resolveSidebarDragTarget("b", 0.28, true), "a");
assert.equal(api.resolveSidebarDragTarget("b", 0.4, true), "", "the B-to-A drag must cross its threshold");

views = slotViews({
    status: { running: true, active_runtime: activeRuntime },
    lifecycle: { phase: "stopping", activeRuntime, busy: true },
    pendingSlot: "b",
});
assert.equal(views[0].state, "active", "the old runtime should not replace the pending target action");
assert.equal(views[1].state, "loading");
assert.equal(api.selectActionSlot(views), "b");

views = slotViews({
    status: { running: true, active_runtime: { ...activeRuntime, preset_fingerprint: "c".repeat(64) } },
    lifecycle: { phase: "ready", activeRuntime: { ...activeRuntime, preset_fingerprint: "c".repeat(64) } },
});
assert.equal(views[0].state, "drift");

views = slotViews({ failures: { b: "Load failed" } });
assert.equal(views[1].state, "failure");
assert.equal(views[1].message, "Load failed");
assert.equal(views[1].actionable, true, "a failed target should remain retryable");
assert.equal(api.selectActionSlot(views), "b", "the failed target should be the selected retry action");

views = slotViews({
    status: { running: true, active_runtime: activeRuntime },
    lifecycle: { phase: "failed", activeRuntime, error: "Stop refused", ready: true },
    failures: { b: "Stop refused" },
});
assert.equal(views[0].activeIdentity, true);
assert.equal(views[0].state, "active", "a healthy server surviving stop refusal should remain Active");
assert.equal(views[1].actionable, true);
assert.equal(api.selectActionSlot(views), "b", "stop refusal should leave the target slot retryable");

views = slotViews({
    status: { running: true, active_runtime: { tool: "llama-bench" } },
    lifecycle: { phase: "running", activeRuntime: { tool: "llama-bench" } },
});
assert.deepEqual(Array.from(views, view => view.state), ["other-tool", "other-tool"]);
assert.equal(api.selectActionSlot(views), "");

views = slotViews({
    assignments: { version: 1, slots: { a: { preset: "Deleted" }, b: { preset: "CLI Preset" } } },
});
assert.deepEqual(Array.from(views, view => view.state), ["missing", "invalid"]);

views = slotViews({
    assignments: { version: 1, slots: { a: { preset: "" }, b: { preset: "Model B Preset" } } },
    status: { running: true, active_runtime: activeRuntime },
    lifecycle: { phase: "ready", activeRuntime, busy: false },
});
assert.equal(views[0].state, "active", "clearing an assignment must not hide its live runtime");
assert.equal(views[0].presetName, "", "the cleared assignment must remain empty");
assert.equal(views[0].displayPresetName, "Model A Preset", "the card should use the launched preset snapshot");
assert.equal(views[0].gguf, "alpha.gguf");
assert.match(views[0].message, /assignment has been cleared/);

views = slotViews({
    assignments: { version: 1, slots: { a: { preset: "Deleted" }, b: { preset: "Model B Preset" } } },
    status: { running: true, active_runtime: activeRuntime },
    lifecycle: { phase: "ready", activeRuntime, busy: false },
});
assert.equal(views[0].state, "missing", "a deleted non-empty assignment must remain Missing");

views = slotViews({
    assignments: { version: 1, slots: { a: { preset: "" }, b: { preset: "Model B Preset" } } },
    issues: { b: "Duplicate assignment" },
});
assert.deepEqual(Array.from(views, view => view.state), ["unassigned", "invalid"]);

assert.equal(typeof api.configure, "function");
assert.equal(typeof api.init, "function");
assert.equal(typeof api.refresh, "function");
assert.equal(typeof api.handleSwitch, "function");

(async () => {
    storedValue = JSON.stringify({
        version: 1,
        slots: {
            a: { preset: "Model A Preset" },
            b: { preset: "Model B Preset" },
        },
    });
    api.reloadAssignments();

    let switchOutcome = { ok: false, error: "Model B failed" };
    api.configure({
        fetchPresetEntries: async () => entries,
        getLatestBackendStatus: () => ({}),
        getLifecycleSnapshot: () => ({ phase: "idle", busy: false }),
        switchSlot: async () => switchOutcome,
    });

    await api.handleSwitch("b");
    let refreshed = await api.refresh();
    assert.equal(refreshed.views[1].state, "failure", "genuine failures should remain retryable");

    switchOutcome = { ok: false, cancelled: true };
    await api.handleSwitch("b");
    refreshed = await api.refresh();
    assert.equal(refreshed.views[1].state, "failure", "cancelled retries must preserve an earlier genuine failure");
    assert.equal(refreshed.views[1].message, "Model B failed");

    api.clearAssignment("b");
    api.setAssignment("b", "Model B Preset");
    switchOutcome = { ok: false, cancelled: true };
    await api.handleSwitch("b");
    refreshed = await api.refresh();
    assert.equal(refreshed.views[1].state, "standby", "a first-attempt cancellation must remain neutral");

    views = slotViews({ pendingSlot: "b", failures: { b: "Earlier failure" } });
    assert.equal(views[1].state, "loading");
    assert.match(views[1].message, /Switch in progress/);

    switchOutcome = { ok: false, error: "Model B failed again" };
    await api.handleSwitch("b");
    switchOutcome = { ok: true };
    await api.handleSwitch("a");
    refreshed = await api.refresh();
    assert.deepEqual(
        Array.from(refreshed.views, view => view.state),
        ["standby", "standby"],
        "a successful switch must clear stale failures for both slots"
    );

    switchOutcome = { ok: false, error: "Model B failed after edit" };
    await api.handleSwitch("b");
    api.clearAssignment("b");
    refreshed = await api.refresh();
    assert.equal(refreshed.views[1].state, "unassigned", "changing an assignment must clear its stale failure");

    api.setAssignment("b", "Model B Preset");
    switchOutcome = { ok: false, error: "Model B failed before external recovery" };
    await api.handleSwitch("b");
    const recoveredRuntime = {
        tool: "llama-server",
        source: "model-switcher",
        slot: "b",
        preset: "Model B Preset",
        model: "models/beta.gguf",
        preset_fingerprint: "b".repeat(64),
    };
    api.configure({
        getLatestBackendStatus: () => ({ running: true, active_runtime: recoveredRuntime }),
        getLifecycleSnapshot: () => ({ phase: "ready", ready: true, activeRuntime: recoveredRuntime, busy: false }),
    });
    refreshed = await api.refresh();
    assert.equal(refreshed.views[1].state, "active", "authoritative healthy recovery must outrank stale failure history");
    api.configure({
        getLatestBackendStatus: () => ({}),
        getLifecycleSnapshot: () => ({ phase: "idle", busy: false }),
    });
    refreshed = await api.refresh();
    assert.equal(refreshed.views[1].state, "standby", "healthy recovery must permanently clear that slot's failure");

    console.log("model switch UI tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
