"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMonitorHarness } = require("./monitor_harness.cjs");

test("fixed bar renders only into the supplied detached document", (t) => {
    const host = createMonitorHarness();
    const popup = createMonitorHarness();
    t.after(host.dispose);
    t.after(popup.dispose);
    for (const fixture of [host, popup]) {
        for (const id of ["stats-bar", "stats-prompt-tokens", "stats-gen-tokens", "stats-context", "stats-kv-usage", "stats-prompt-speed", "stats-gen-speed", "stats-prompt-speed-label", "stats-gen-speed-label"]) {
            fixture.mount(id).textContent = "untouched";
        }
    }
    const engine = host.monitorUi.createInferenceStats({});
    engine.setTarget("gui:1", { zeroBaseline: true });
    const snapshot = engine.applyPollResult({ metricsOk: true, metricsValues: host.metricValues(), slotsOk: true, slotsNormalized: host.slotsSample(0, 1000, 100), now: 1000 });
    host.monitorUi.renderStatsBarFromSnapshot(snapshot, popup.documentStub);
    assert.equal(popup.documentStub.getElementById("stats-context").textContent, "1,500");
    assert.equal(host.documentStub.getElementById("stats-context").textContent, "untouched");
    host.monitorUi.renderStatsBarFromSnapshot(null, popup.documentStub);
    assert.equal(popup.documentStub.getElementById("stats-context").textContent, "--");
    assert.equal(popup.documentStub.getElementById("stats-bar").classList.contains("hidden"), true);
    assert.equal(host.documentStub.getElementById("stats-context").textContent, "untouched");
});

test("snapshot rendering", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, context, documentStub, metricValues } = fixture;
    monitorUi.renderInferenceSnapshot(null);
    assert.equal(documentStub.getElementById("monitor-inference-body").classList.contains("hidden"), true);
    assert.equal(documentStub.getElementById("monitor-inference-empty").classList.contains("hidden"), false);
    assert.equal(documentStub.getElementById("monitor-inference-state-badge").textContent, "Unavailable");

    const engine = monitorUi.createInferenceStats({});
    engine.setTarget("gui:9", { zeroBaseline: true });
    const snapshot = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true,
        slotsNormalized: monitorUi.normalizeSlots([
            { id: 3, id_task: 7, is_processing: false, n_ctx: 8192, n_prompt_tokens: 3072,
                n_prompt_tokens_processed: 3072, next_token: { n_decoded: 200 } },
        ]),
        now: 1000,
    });
    monitorUi.renderInferenceSnapshot(snapshot);
    const body = documentStub.getElementById("monitor-inference-body");
    const contextBar = documentStub.getElementById("monitor-inference-context-bar")
        .querySelector(".progress-bar");
    assert.equal(body.classList.contains("hidden"), false);
    assert.equal(documentStub.getElementById("monitor-inference-prompt").textContent, "1,000 tokens");
    assert.equal(documentStub.getElementById("monitor-inference-total").textContent, "1,500 tokens");
    assert.ok(
        documentStub.getElementById("monitor-inference-context-label").textContent.includes("(idle)"),
        "retained context on an idle slot is labeled honestly",
    );
    assert.ok(
        documentStub.getElementById("monitor-inference-context-reading").textContent.includes("3,072 / 8,192"),
    );
    assert.equal(documentStub.getElementById("monitor-inference-requests").textContent, "1 active \u00b7 0 queued");
    assert.equal(documentStub.getElementById("monitor-inference-slots").textContent, "0 / 1 busy");

    // Warning/critical bar classes.
    const critical = engine.applyPollResult({
        metricsOk: false, metricsValues: null,
        slotsOk: true,
        slotsNormalized: monitorUi.normalizeSlots([
            { id: 3, is_processing: true, n_ctx: 100, n_prompt_tokens: 97 },
        ]),
        now: 2000,
    });
    monitorUi.renderInferenceSnapshot(critical);
    const barHolder = documentStub.getElementById("monitor-inference-context-bar");
    assert.equal(barHolder.querySelector(".progress-bar"), contextBar,
        "context progress bar is updated in place");
    assert.ok(barHolder.querySelector(".progress-fill-critical"));
    assert.equal(
        documentStub.getElementById("monitor-inference-prompt").textContent, "--",
        "metrics failure leaves session tokens unavailable, not stale",
    );
    const unknownActivity = engine.applyPollResult({
        metricsOk: false, metricsValues: null,
        slotsOk: false, slotsNormalized: null, now: 3000,
    });
    monitorUi.renderInferenceSnapshot(unknownActivity);
    assert.match(documentStub.getElementById("monitor-inference-kicker").textContent, /Activity unknown/);
    assert.equal(documentStub.getElementById("monitor-inference-state-badge").textContent, "Activity unknown");
    const unavailableBar = documentStub.getElementById("monitor-inference-context-bar").querySelector(".progress-bar");
    assert.equal(unavailableBar.hasAttribute("aria-valuenow"), false,
        "unavailable meters must not announce zero");
    assert.equal(unavailableBar.getAttribute("aria-valuetext"), "Not available");

    monitorUi.renderInferenceSnapshot(engine.applyPollResult({
        metricsOk: false, metricsValues: null,
        slotsOk: true,
        slotsNormalized: monitorUi.normalizeSlots([{
            id: 3, id_task: 7, is_processing: false, n_ctx: 100, n_prompt_tokens: 97,
        }]),
        now: 4000,
    }));
    const availableBar = documentStub.getElementById("monitor-inference-context-bar").querySelector(".progress-bar");
    assert.equal(availableBar.getAttribute("aria-valuenow"), "97");
    assert.equal(availableBar.hasAttribute("aria-valuetext"), false);

});

