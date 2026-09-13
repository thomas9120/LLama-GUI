"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMonitorHarness } = require("./monitor_harness.cjs");

test("preference normalization", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, normalized } = fixture;
assert.deepEqual(normalized("garbage"), []);
assert.deepEqual(normalized(null), []);
assert.deepEqual(normalized([
    { key: "system:cpu", label: "CPU" },
    { key: "system:cpu", label: "duplicate" },
    { key: "", label: "empty key" },
    { key: 42, label: "numeric key" },
    { label: "missing key" },
    "string entry",
    { key: "system:disk", label: "x".repeat(500) },
]), [
    { key: "system:cpu", label: "CPU" },
    { key: "system:disk", label: "x".repeat(120) },
]);
const manyEntries = Array.from({ length: 150 }, (_v, i) => ({ key: `gpu:id-${i}`, label: `GPU ${i}` }));
assert.equal(normalized(manyEntries).length, 100);
assert.equal(monitorUi.isSessionOnlyKey("gpu:nvidia:index:0"), true);
assert.equal(monitorUi.isSessionOnlyKey("gpu:nvidia:uuid:GPU-AAAA"), false);

assert.deepEqual(Array.from(monitorUi.normalizeOrderEntries("nope")), []);
assert.deepEqual(Array.from(monitorUi.normalizeOrderEntries({})), []);
assert.deepEqual(
    Array.from(monitorUi.normalizeOrderEntries(["a", "dup", "a", "", 7, "b"])),
    ["a", "dup", "b"],
    "order normalization dedupes, drops non-strings, keeps order",
);
assert.deepEqual(Array.from(monitorUi.normalizeOrderEntries(["k".repeat(300), "ok"])), ["ok"]);
assert.equal(
    monitorUi.normalizeOrderEntries(Array.from({ length: 105 }, (_v, i) => `k${i}`)).length,
    100,
);
assert.equal(monitorUi.isSessionOnlyKey("system:cpu"), false);


});

test("hidden card persistence", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, warnings, resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait } = fixture;
    resetDom();
    buildStandardDom();
    const storage = makeStorage();
    context.localStorage = storage;

    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [
                makeGpu("nvidia:uuid:GPU-PERSIST"),
                makeGpu("nvidia:index:1", { index: 1, name: "Fallback GPU" }),
            ],
        }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);

    const cards = () => documentStub.getElementById("monitor-card-grid").children;
    const visibleCards = () => cards().filter(card => !card.classList.contains("hidden"));
    assert.equal(cards().length, 2);

    // Hiding a UUID card persists; the card disappears from the grid and
    // appears in the restore list; focus moves to the hidden-bar summary.
    const uuidCard = cards()[0];
    const hideBtn = uuidCard.querySelector(".monitor-hide-btn");
    hideBtn.dispatch("click");
    assert.equal(visibleCards().length, 1);
    const stored = JSON.parse(storage.map.get("llama_gui_monitor_hidden_cards"));
    assert.deepEqual(stored, [{ key: "gpu:nvidia:uuid:GPU-PERSIST", label: "GPU 0 \u00b7 NVIDIA GeForce RTX 4090" }]);
    const summary = documentStub.getElementById("monitor-hidden-controls").querySelector("summary");
    assert.ok(summary.focusCalls >= 1, "focus moves to the restore control on hide");
    const restoreRows = documentStub.getElementById("monitor-restore-items").children;
    assert.equal(restoreRows.length, 1);
    assert.equal(documentStub.getElementById("monitor-hidden-count").textContent, "1 card hidden");

    // Index-fallback GPU hides stay session-only.
    visibleCards()[0].querySelector(".monitor-hide-btn").dispatch("click");
    const storedAfterIndex = JSON.parse(storage.map.get("llama_gui_monitor_hidden_cards"));
    assert.equal(storedAfterIndex.length, 1, "index-fallback hides are not persisted");
    assert.equal(documentStub.getElementById("monitor-hidden-count").textContent, "2 cards hidden");

    // Per-item restore brings the card back and focuses it.
    const row0 = documentStub.getElementById("monitor-restore-items").children[0];
    row0.querySelectorAll("button")[0].dispatch("click");
    assert.equal(visibleCards().length, 1);
    const restored = visibleCards().find(card => card.dataset.monitorKey === "gpu:nvidia:uuid:GPU-PERSIST");
    assert.ok(restored, "restored card is visible again");
    assert.equal(JSON.parse(storage.map.get("llama_gui_monitor_hidden_cards")).length, 0);

    // Show all clears dormant entries too.
    storage.map.set("llama_gui_monitor_hidden_cards", JSON.stringify([
        { key: "gpu:amd:bdf:dormant", label: "Old AMD card" },
    ]));
    monitorUi.onTabChanged("other");
    monitorUi.onTabChanged("monitor");
    await wait(80);
    documentStub.getElementById("btn-monitor-show-all").dispatch("click");
    assert.equal(storage.map.get("llama_gui_monitor_hidden_cards"), "[]");
    assert.equal(documentStub.getElementById("monitor-hidden-controls").classList.contains("hidden"), true);

    // Deliberate hides survive telemetry-state changes.
    visibleCards()[0].querySelector(".monitor-hide-btn").dispatch("click");
    monitorUi.recheck();
    await wait(80);
    assert.equal(visibleCards().length, 1, "hidden card stays hidden across samples");

    // Storage failure degrades to session-only preferences.
    context.localStorage = makeStorage({ fail: true });
    warnings.length = 0;
    monitorUi.init();
    monitorUi.onTabChanged("other");
    monitorUi.onTabChanged("monitor");
    await wait(80);
    // The blocked storage cannot resurrect persisted hides, so both GPUs show.
    assert.equal(visibleCards().length, 2);
    visibleCards()[0].querySelector(".monitor-hide-btn").dispatch("click");
    assert.equal(visibleCards().length, 1,
        "hiding still works for the session when storage is blocked");

});

test("drag ordering and deferred samples", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait, deferred } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    const storage = makeStorage();
    storage.map.set("llama_gui_monitor_card_order",
        JSON.stringify(["gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-BBBB"]));
    context.localStorage = storage;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [
                makeGpu("nvidia:uuid:GPU-AAAA"),
                makeGpu("nvidia:uuid:GPU-BBBB", { index: 1 }),
                makeGpu("nvidia:uuid:GPU-CCCC", { index: 2 }),
            ],
        }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);

    const grid = () => documentStub.getElementById("monitor-card-grid");
    const keys = () => grid().children.map(card => card.dataset.monitorKey);
    const cardByKey = (key) => grid().children.find(card => card.dataset.monitorKey === key);
    const setRects = () => {
        grid().children.forEach((card, index) => {
            card._rect = { top: index * 60, height: 60, bottom: index * 60 + 60, left: 0, right: 0, width: 0 };
        });
    };

    // Persisted order wins over the backend's gpu array order.
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-BBBB",
    ]);
    // The hint lives on the dedicated handle, not the card or tools row.
    assert.equal(cardByKey("gpu:nvidia:uuid:GPU-AAAA").title, "",
        "the card as a whole claims no drag affordance");
    assert.equal(cardByKey("gpu:nvidia:uuid:GPU-AAAA").querySelector(".monitor-card-tools").title, "");
    assert.equal(
        cardByKey("gpu:nvidia:uuid:GPU-AAAA").querySelector(".monitor-drag-handle").title,
        "Drag GPU 0 · NVIDIA GeForce RTX 4090 to reorder; use arrow keys to move",
        "the grip advertises pointer and keyboard reordering",
    );

    // Cards on the same visual row use the horizontal midpoint.
    const setHorizontalRects = () => {
        grid().children.forEach((card, index) => {
            card._rect = {
                top: 0, height: 60, bottom: 60,
                left: index * 120, right: index * 120 + 100, width: 100,
            };
        });
    };
    const dragstart = (card) => grid().dispatch("dragstart", {
        target: card.querySelector(".monitor-drag-handle"),
        dataTransfer: { effectAllowed: "", setData() {}, getData: () => "" },
    });
    setHorizontalRects();
    dragstart(cardByKey("gpu:nvidia:uuid:GPU-CCCC"));
    grid().dispatch("dragover", {
        target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientX: 210, clientY: 30,
    });
    assert.ok(cardByKey("gpu:nvidia:uuid:GPU-AAAA").classList.contains("drop-after"));
    assert.ok(cardByKey("gpu:nvidia:uuid:GPU-AAAA").classList.contains("drop-horizontal"));
    grid().dispatch("drop", {
        target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientX: 210, clientY: 30,
    });
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-BBBB",
    ], "right-half drop lands after a card on the same row");
    setHorizontalRects();
    dragstart(cardByKey("gpu:nvidia:uuid:GPU-CCCC"));
    grid().dispatch("drop", {
        target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientX: 10, clientY: 30,
    });
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-BBBB",
    ], "left-half drop lands before a card on the same row");

    // Drag B into A's upper half -> B lands before A.
    setRects();
    dragstart(cardByKey("gpu:nvidia:uuid:GPU-BBBB"));
    assert.ok(cardByKey("gpu:nvidia:uuid:GPU-BBBB").classList.contains("dragging"),
        "dragged card is dimmed");
    grid().dispatch("dragover", { target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientY: 10 });
    assert.ok(cardByKey("gpu:nvidia:uuid:GPU-AAAA").classList.contains("drop-before"));
    grid().dispatch("drop", { target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientY: 10 });
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-BBBB", "gpu:nvidia:uuid:GPU-AAAA",
    ], "B lands immediately before A");
    assert.equal(cardByKey("gpu:nvidia:uuid:GPU-BBBB").classList.contains("dragging"), false,
        "drag state clears after drop");
    const persisted = JSON.parse(storage.map.get("llama_gui_monitor_card_order"));
    assert.deepEqual(persisted.slice(0, 3), [
        "gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-BBBB", "gpu:nvidia:uuid:GPU-AAAA",
    ]);

    // Drag C into A's lower half -> C lands after A.
    setRects();
    dragstart(cardByKey("gpu:nvidia:uuid:GPU-CCCC"));
    grid().dispatch("dragover", { target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientY: 160 });
    assert.ok(cardByKey("gpu:nvidia:uuid:GPU-AAAA").classList.contains("drop-after"));
    grid().dispatch("drop", { target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientY: 160 });
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-BBBB", "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-CCCC",
    ], "C lands immediately after A");

    // Dropping on empty container space appends at the end; hovering the
    // empty area marks the last card as the append slot.
    dragstart(cardByKey("gpu:nvidia:uuid:GPU-BBBB"));
    grid().dispatch("dragover", { target: grid(), clientY: 999 });
    assert.ok(cardByKey("gpu:nvidia:uuid:GPU-CCCC").classList.contains("drop-after"),
        "empty-space hover marks the last card as the append slot");
    grid().dispatch("drop", { target: grid(), clientY: 999 });
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-BBBB",
    ]);

    // A sample landing mid-drag is deferred; rendering resumes after dragend
    // and the new card takes its place after the known keys.
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [
                makeGpu("nvidia:uuid:GPU-AAAA"),
                makeGpu("nvidia:uuid:GPU-BBBB", { index: 1 }),
                makeGpu("nvidia:uuid:GPU-CCCC", { index: 2 }),
                makeGpu("nvidia:uuid:GPU-DDDD", { index: 3 }),
            ],
        }),
    });
    grid().dispatch("dragstart", {
        target: cardByKey("gpu:nvidia:uuid:GPU-AAAA").querySelector(".monitor-drag-handle"),
    });
    monitorUi.recheck();
    await wait(100);
    assert.equal(grid().children.length, 3, "poll render is deferred during a drag");
    grid().dispatch("dragend");
    assert.equal(grid().children.length, 4, "deferred sample renders after the drag");
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-CCCC", "gpu:nvidia:uuid:GPU-BBBB",
        "gpu:nvidia:uuid:GPU-DDDD",
    ], "new unknown card lands after known keys");

    // Hidden cards keep their position through reordering.
    setRects();
    cardByKey("gpu:nvidia:uuid:GPU-CCCC").querySelector(".monitor-hide-btn").dispatch("click");
    dragstart(cardByKey("gpu:nvidia:uuid:GPU-DDDD"));
    grid().dispatch("drop", { target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientY: 10 });
    assert.deepEqual(keys(), [
        "gpu:nvidia:uuid:GPU-DDDD", "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-CCCC",
        "gpu:nvidia:uuid:GPU-BBBB",
    ], "hidden cards keep their slot while others reorder around them");
    documentStub.getElementById("btn-monitor-show-all").dispatch("click");
    assert.equal(cardByKey("gpu:nvidia:uuid:GPU-CCCC").classList.contains("hidden"), false);

    // Index-fallback GPU keys order the session but never persist.
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [
                makeGpu("nvidia:index:9", { index: 9, name: "Fallback GPU" }),
                makeGpu("nvidia:uuid:GPU-AAAA"),
            ],
        }),
    });
    monitorUi.recheck();
    await wait(100);
    setRects();
    dragstart(cardByKey("gpu:nvidia:index:9"));
    grid().dispatch("drop", { target: cardByKey("gpu:nvidia:uuid:GPU-AAAA"), clientY: 10 });
    assert.deepEqual(keys(), [
        "gpu:nvidia:index:9", "gpu:nvidia:uuid:GPU-AAAA",
    ], "session drag order applies in memory");
    const persistedAfter = JSON.parse(storage.map.get("llama_gui_monitor_card_order"));
    assert.equal(persistedAfter.includes("gpu:nvidia:index:9"), false,
        "index-fallback keys are not persisted");
    assert.equal(persistedAfter.includes("gpu:nvidia:uuid:GPU-AAAA"), true);

    // Storage failure degrades to session-only ordering, like hidden cards.
    context.localStorage = makeStorage({ fail: true });
    dragstart(cardByKey("gpu:nvidia:uuid:GPU-AAAA"));
    grid().dispatch("drop", { target: cardByKey("gpu:nvidia:index:9"), clientY: 10 });
    assert.deepEqual(keys(), ["gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:index:9"],
        "reorder still works for the session when storage is blocked");

});

test("static and GPU ordering", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, createElement, resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    context.localStorage = makeStorage();
    const grid = documentStub.getElementById("monitor-card-grid");
    const cpuCard = createElement("div");
    cpuCard.classList.add("card");
    cpuCard.dataset.monitorKey = "system:cpu";
    grid.appendChild(cpuCard);

    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [makeGpu("all-smi:uuid:GPU-ONLY")],
        }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);

    const gpuCard = grid.children.find(card => card.dataset.monitorKey.startsWith("gpu:"));
    assert.ok(gpuCard, "GPU reconciliation preserves the static card and adds the GPU");
    grid.dispatch("dragstart", {
        target: gpuCard.querySelector(".monitor-drag-handle"),
        dataTransfer: { effectAllowed: "", setData() {} },
    });
    grid.dispatch("drop", { target: cpuCard, clientY: 10 });
    assert.deepEqual(
        grid.children.map(card => card.dataset.monitorKey),
        ["gpu:all-smi:uuid:GPU-ONLY", "system:cpu"],
        "a single GPU can move before a static metric card",
    );

    monitorUi.recheck();
    await wait(80);
    assert.deepEqual(
        grid.children.map(card => card.dataset.monitorKey),
        ["gpu:all-smi:uuid:GPU-ONLY", "system:cpu"],
        "GPU polling preserves the mixed-card order",
    );

});

test("keyboard and grip interaction", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    context.localStorage = makeStorage();
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [makeGpu("nvidia:uuid:GPU-AAAA"), makeGpu("nvidia:uuid:GPU-BBBB", { index: 1 })],
            gpu_setup: [{
                provider: "amd", state: "error", action: "open_docs",
                command: null, package_manager: null,
                docs_url: "https://example.invalid/",
                message: "amd-smi ran but returned no usable GPU data.",
                details: {
                    reason: "exit_code", executable: "/opt/rocm/bin/amd-smi",
                    exit_code: 9, stderr: "driver problem",
                },
            }],
        }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);

    const grid = documentStub.getElementById("monitor-card-grid");
    const card = grid.children[0];
    const handle = card.querySelector(".monitor-drag-handle");
    assert.equal(handle.draggable, true, "the dedicated grip is draggable");
    assert.equal(card.draggable, false, "the card body is not draggable");
    assert.equal(card.querySelector(".monitor-hide-btn").draggable, false,
        "Hide remains a normal button");

    const setupCard = documentStub.getElementById("monitor-setup-cards").children[0];
    assert.equal(setupCard.draggable, false, "setup card text stays selectable");
    assert.equal(setupCard.querySelector("a").draggable, false,
        "documentation links do not drag the card");

    // The focused grip moves through the visible card order with arrow keys.
    grid.dispatch("keydown", { target: handle, key: "ArrowRight" });
    assert.deepEqual(
        grid.children.map(entry => entry.dataset.monitorKey),
        ["gpu:nvidia:uuid:GPU-BBBB", "gpu:nvidia:uuid:GPU-AAAA"],
    );
    assert.equal(handle.focusCalls, 1, "keyboard reorder restores focus to the grip");
    grid.dispatch("keydown", { target: handle, key: "ArrowLeft" });
    assert.deepEqual(
        grid.children.map(entry => entry.dataset.monitorKey),
        ["gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-BBBB"],
    );

    // A drag that does start still reorders end to end.
    grid.dispatch("dragstart", {
        target: handle,
        dataTransfer: { effectAllowed: "", setData() {}, getData: () => "" },
    });
    grid.dispatch("drop", { target: grid.children[1], clientY: 90 });
    assert.deepEqual(
        grid.children.map(entry => entry.dataset.monitorKey),
        ["gpu:nvidia:uuid:GPU-BBBB", "gpu:nvidia:uuid:GPU-AAAA"],
        "drag still reorders after gating",
    );

});

test("reset clears preferences", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    const storage = makeStorage();
    storage.map.set("llama_gui_monitor_card_order", JSON.stringify([
        "gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-BBBB",
    ]));
    context.localStorage = storage;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [makeGpu("nvidia:uuid:GPU-BBBB"), makeGpu("nvidia:uuid:GPU-AAAA", { index: 1 })],
        }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);
    assert.deepEqual(
        documentStub.getElementById("monitor-card-grid").children.map(card => card.dataset.monitorKey),
        ["gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:uuid:GPU-BBBB"],
        "the stored order is applied",
    );

    // Next scenario: reset without re-running init(). Re-calling init() would
    // reload the order from storage and hide the leak this guards against.
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    context.localStorage = makeStorage();
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [makeGpu("nvidia:uuid:GPU-BBBB"), makeGpu("nvidia:uuid:GPU-AAAA", { index: 1 })],
        }),
    });
    monitorUi.onTabChanged("monitor");
    await wait(80);
    assert.deepEqual(
        documentStub.getElementById("monitor-card-grid").children.map(card => card.dataset.monitorKey),
        ["gpu:nvidia:uuid:GPU-BBBB", "gpu:nvidia:uuid:GPU-AAAA"],
        "resetForTests clears the leaked card order",
    );

});

test("storage cap", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    const storage = makeStorage();
    context.localStorage = storage;
    const cappedGpus = Array.from({ length: 105 }, (_value, index) =>
        makeGpu(`nvidia:uuid:CAP-${index}`, { index }));
    cappedGpus.unshift(makeGpu("nvidia:index:session", { index: 999 }));
    monitorUi.configure({
        fetchJson: async () => makeSample({ gpus: cappedGpus }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);
    const cards = () => documentStub.getElementById("monitor-card-grid").children;
    for (const card of Array.from(cards())) card.querySelector(".monitor-hide-btn").dispatch("click");
    const persisted = JSON.parse(storage.map.get("llama_gui_monitor_hidden_cards"));
    assert.equal(persisted.length, 100);
    assert.equal(persisted.some(entry => entry.key.includes("nvidia:index:session")), false);
    assert.equal(persisted.some(entry => entry.key.includes("CAP-0")), false);
    assert.equal(persisted.some(entry => entry.key.includes("CAP-104")), true);

});

test("malformed storage", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, resetDom, buildStandardDom, makeSample, makeStorage, wait } = fixture;
    resetDom();
    buildStandardDom();
    const storage = makeStorage();
    storage.map.set("llama_gui_monitor_hidden_cards", "{not json");
    context.localStorage = storage;
    monitorUi.configure({
        fetchJson: async () => makeSample(),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);
    assert.equal(documentStub.getElementById("monitor-hidden-controls").classList.contains("hidden"), true);

});

