"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMonitorHarness } = require("./monitor_harness.cjs");

async function copyButtonScenario(fixture, copyText) {
    const { monitorUi, resetDom, buildStandardDom, context, makeStorage, makeSample, documentStub, wait } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    context.localStorage = makeStorage();
    const toasts = [];
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpu_setup: [{
                provider: "amd", state: "setup_required", action: "copy_command",
                command: "sudo apt install amdrocm-amdsmi",
                package_manager: "apt", docs_url: "https://example.invalid/",
                message: "amd-smi was not found.", details: { reason: "not_found" },
            }],
        }),
        copyText,
        showToast: (message, type) => toasts.push(`${type}:${message}`),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);
    const setupGrid = documentStub.getElementById("monitor-setup-cards");
    const button = setupGrid.querySelector(".monitor-command-row").querySelector("button");
    button.dispatch("click");
    await wait(20);
    return toasts;
}

test("GPU identity and hostile names", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, makeGpu, wait } = fixture;
    const hostileName = "<img src=x onerror=alert(1)> RTX";
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [
                makeGpu("nvidia:uuid:GPU-AAAA"),
                makeGpu("nvidia:pci:0000:0b:00.0", {
                    index: 1, name: hostileName, temperature_c: null,
                    utilization_percent: null, memory_used_bytes: null,
                    memory_total_bytes: null,
                }),
            ],
        }),
    });
    monitorUi.recheck();
    await wait(80);
    const grid = documentStub.getElementById("monitor-card-grid");
    assert.equal(grid.children.length, 2);
    const keys = grid.children.map(card => card.dataset.monitorKey);
    assert.deepEqual(keys, ["gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:pci:0000:0b:00.0"]);
    const second = grid.children[1];
    assert.equal(second.querySelector(".card-title").textContent, hostileName);
    for (const metric of ["utilization", "vram", "temperature"]) {
        assert.equal(
            second.querySelector(`.monitor-metric-row[data-metric="${metric}"]`)
                .querySelector(".monitor-metric-reading").textContent,
            "Not available",
            `${metric} renders as unavailable instead of inventing zero`,
        );
    }
    assert.equal(
        second.querySelector(".monitor-drag-handle").getAttribute("aria-label"),
        `Move GPU 1 · ${hostileName} monitor; use arrow keys`,
    );
    // No element was created from the hostile name.
    assert.equal(second.querySelectorAll("img").length, 0);

});

test("mixed providers", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, makeGpu, wait } = fixture;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [makeGpu("nvidia:uuid:GPU-AAAA")],
            gpu_setup: [{
                provider: "amd", state: "setup_required", action: "copy_command",
                command: "sudo apt install amdrocm-amdsmi", package_manager: "apt",
                docs_url: "https://rocm.docs.amd.com/", message: "amd-smi was not found.",
            }],
        }),
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(documentStub.getElementById("monitor-card-grid").children.length, 1);
    const setupSection = documentStub.getElementById("monitor-gpu-setup");
    assert.equal(setupSection.classList.contains("hidden"), false);
    const setupCard = documentStub.getElementById("monitor-setup-cards").children[0];
    assert.equal(setupCard.dataset.monitorKey, "setup:amd");
    const command = setupCard.querySelector(".monitor-command");
    assert.equal(command.textContent, "sudo apt install amdrocm-amdsmi");
    const copyBtn = setupCard.querySelectorAll("button")
        .find(btn => btn.textContent === "Copy");
    copyBtn.dispatch("click");
    const stateCards = documentStub.getElementById("monitor-gpu-states").children;
    assert.deepEqual(stateCards.map(card => card.dataset.monitorKey), ["state:amd"]);

});

test("probe diagnostics", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    const details = {
        reason: "exit_code",
        // Hostile value on purpose: the path must render as text.
        executable: "<img src=x onerror=alert(1)>/nvidia-smi",
        exit_code: 9,
        stderr: "driver problem",
    };
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpu_setup: [{
                provider: "nvidia", state: "error", action: "open_docs",
                command: null, package_manager: null,
                docs_url: "https://developer.nvidia.com/",
                message: "nvidia-smi ran but returned no usable GPU data.",
                details,
            }],
        }),
    });
    monitorUi.recheck();
    await wait(80);
    const setupCard = documentStub.getElementById("monitor-setup-cards").children[0];
    const detailBox = setupCard.querySelector(".monitor-probe-details");
    assert.ok(detailBox, "setup card renders probe details");
    const labels = detailBox.querySelectorAll(".monitor-metric-row")
        .map(row => row.querySelector(".monitor-metric-label").textContent);
    assert.deepEqual(labels, ["Reason", "Tool", "Exit code", "Stderr"]);
    assert.ok(detailBox.textContent.includes("Non-zero exit"));
    assert.ok(detailBox.textContent.includes("9"));
    assert.ok(detailBox.textContent.includes("driver problem"));
    assert.equal(detailBox.querySelectorAll("img").length, 0, "hostile executable stays text");
    const stateCard = documentStub.getElementById("monitor-gpu-states").children[0];
    const stateBox = stateCard.querySelector(".monitor-probe-details");
    assert.ok(stateBox, "state card renders probe details");
    assert.ok(stateCard.textContent.includes("Non-zero exit"));

});

test("missing diagnostics", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpu_setup: [{
                provider: "nvidia", state: "error", action: "open_docs",
                command: null, package_manager: null,
                docs_url: "https://developer.nvidia.com/",
                message: "nvidia-smi ran but returned no usable GPU data.",
                details: null,
            }],
        }),
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(
        documentStub.getElementById("monitor-setup-cards").children[0]
            .querySelector(".monitor-probe-details"),
        null,
        "no detail block when details are absent",
    );
    assert.equal(
        documentStub.getElementById("monitor-gpu-states").children[0]
            .querySelector(".monitor-probe-details"),
        null,
    );

});

test("generic guidance", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    monitorUi.configure({ fetchJson: async () => makeSample() });
    monitorUi.recheck();
    await wait(80);
    const stateCards = documentStub.getElementById("monitor-gpu-states").children;
    assert.deepEqual(stateCards.map(card => card.dataset.monitorKey), ["state:generic"]);
    assert.ok(stateCards[0].textContent.includes("No supported GPU telemetry detected"));
    const guide = stateCards[0].querySelector("a");
    assert.equal(guide.textContent, "GPU monitoring setup guide");
    assert.equal(
        guide.href,
        "https://github.com/thomas9120/LLama-GUI/blob/main/docs/gpu-monitoring.md",
    );
    assert.equal(guide.target, "_blank");
    assert.equal(guide.rel, "noopener noreferrer");
    assert.equal(
        documentStub.getElementById("monitor-gpu-setup").classList.contains("hidden"),
        true,
    );

});

test("unsupported provider", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpu_setup: [{
                provider: "amd", state: "unsupported", action: "open_docs",
                command: null, package_manager: null, docs_url: "https://rocm.docs.amd.com/",
                message: "AMD SMI monitoring is unavailable on this platform.",
            }],
        }),
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(
        documentStub.getElementById("monitor-gpu-setup").classList.contains("hidden"),
        true,
        "unsupported providers get no setup card",
    );
    const stateCards = documentStub.getElementById("monitor-gpu-states").children;
    assert.ok(stateCards[0].textContent.includes("unavailable on this platform"));

});

test("backend guidance", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpu_setup: [{
                provider: "", state: "unavailable",
                message: "On Windows, AMD monitoring is unavailable because AMD SMI supports Linux only.",
            }],
        }),
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(
        documentStub.getElementById("monitor-gpu-setup").classList.contains("hidden"),
        true,
        "generic guidance gets no setup card",
    );
    assert.ok(
        documentStub.getElementById("monitor-gpu-states").children[0]
            .textContent.includes("AMD SMI supports Linux only"),
    );

});

test("GPU node and focus preservation", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    context.localStorage = makeStorage();
    let utilization = 40;
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [
                makeGpu("nvidia:uuid:GPU-AAAA", { utilization_percent: utilization }),
                makeGpu("nvidia:uuid:GPU-BBBB", { index: 1, utilization_percent: 55 }),
            ],
        }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);

    const grid = documentStub.getElementById("monitor-card-grid");
    const first = grid.children[0];
    const utilRow = () => grid.children[0]
        .querySelector('.monitor-metric-row[data-metric="utilization"]');
    const utilReading = () => utilRow().querySelector(".monitor-metric-reading").textContent;
    const utilBarWidth = () => grid.children[0]
        .querySelectorAll(".progress-bar")[0].querySelector(".progress-fill").style.width;

    assert.equal(utilReading(), "40%");
    assert.equal(utilBarWidth(), "40%");

    // Same GPU, new sample: reuse the node, update the value.
    utilization = 91;
    monitorUi.recheck();
    await wait(80);
    assert.equal(grid.children[0], first, "GPU card node is reused across polls");
    assert.equal(utilReading(), "91%", "the reading updates in place");
    assert.equal(utilBarWidth(), "91%", "the meter updates in place");
    assert.equal(grid.children.length, 2, "no duplicate cards accumulate");

    // A hidden card stays hidden across a refresh of the same node.
    grid.children[1].querySelector(".monitor-hide-btn").dispatch("click");
    const restoreButton = documentStub.getElementById("monitor-restore-items")
        .children[0].querySelectorAll("button")[0];
    restoreButton.focus();
    monitorUi.recheck();
    await wait(80);
    assert.equal(grid.children[1].classList.contains("hidden"), true,
        "hiding survives an in-place refresh");
    assert.equal(
        documentStub.getElementById("monitor-restore-items").children[0].querySelectorAll("button")[0],
        restoreButton,
        "unchanged restore controls retain their DOM identity and focus across polls",
    );

    // A GPU that disappears is removed; one that appears is added.
    monitorUi.configure({
        fetchJson: async () => makeSample({
            gpus: [makeGpu("nvidia:uuid:GPU-CCCC", { utilization_percent: 12 })],
        }),
    });
    monitorUi.recheck();
    await wait(80);
    assert.deepEqual(
        grid.children.map(card => card.dataset.monitorKey),
        ["gpu:nvidia:uuid:GPU-CCCC"],
        "stale cards are removed and new ones added",
    );

    // The Hide button reports the card's current label, not the one captured
    // when the card was first constructed.
    const card = grid.children[0];
    card.querySelector(".monitor-hide-btn").dispatch("click");
    const stored = JSON.parse(context.localStorage.map.get("llama_gui_monitor_hidden_cards"));
    assert.equal(stored[stored.length - 1].label, "GPU 0 \u00b7 NVIDIA GeForce RTX 4090",
        "the hide label comes from the live card");

});

test("setup card reuse", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, resetDom, buildStandardDom, makeSample, makeStorage, wait } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    context.localStorage = makeStorage();
    let message = "amd-smi was not found.";
    const entry = () => ({
        provider: "amd", state: "setup_required", action: "copy_command",
        command: "sudo apt install amdrocm-amdsmi",
        package_manager: "apt", docs_url: "https://example.invalid/",
        message, details: { reason: "not_found" },
    });
    monitorUi.configure({
        fetchJson: async () => makeSample({ gpu_setup: [entry()] }),
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);

    const setup = documentStub.getElementById("monitor-setup-cards");
    const first = setup.children[0];
    assert.equal(setup.children.length, 1);

    monitorUi.recheck();
    await wait(80);
    assert.equal(setup.children[0], first,
        "setup card is reused when the advice is unchanged");

    message = "Different guidance from a newer backend.";
    monitorUi.recheck();
    await wait(80);
    assert.ok(setup.children[0] !== first,
        "setup card is rebuilt when the advice changes");
    assert.equal(setup.children.length, 1, "exactly one card either way");
    assert.ok(setup.children[0].textContent.includes(message),
        "the rebuilt card shows the new advice");

});

test("clipboard success", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);

    const toasts = await copyButtonScenario(fixture, () => Promise.resolve(true));
    assert.deepEqual(toasts, ["info:Command copied"], "success announces the copy");

});

test("clipboard refusal", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);

    const toasts = await copyButtonScenario(fixture, () => Promise.resolve(false));
    assert.deepEqual(toasts, ["error:Could not copy command"],
        "a rejected clipboard does not claim success");

});

test("clipboard error", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);

    const toasts = await copyButtonScenario(fixture, () => Promise.reject(new Error("denied")));
    assert.deepEqual(toasts, ["error:Could not copy command"],
        "a throwing clipboard reports failure instead of crashing");

});

