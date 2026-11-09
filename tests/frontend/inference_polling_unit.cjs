"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, deferred, flush } = require("./orchestration_harness.cjs");

test("orchestration modules load without DOM, storage or transport access", () => {
    const h = createHarness(["js/memory-estimate-ui.js", "js/notifications.js",
        "js/inference-polling.js", "js/process-output.js"]);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(Object.keys(h.api).sort(),
        ["inferencePolling", "memoryEstimateUi", "notifications", "processOutput"]);
});

function fixture(overrides = {}) {
    const h = createHarness(["js/inference-stats.js", "js/inference-polling.js"], overrides);
    const calls = [], targets = [], results = [];
    let key = null;
    let lifecycle = { ready: false };
    const poller = h.api.inferencePolling.create({
        inferenceStats: {
            getTargetKey: () => key,
            setTarget: (next, options) => { key = next; targets.push({ key, options }); },
            applyPollResult: result => results.push(result),
        },
        fetch: (url, options) => {
            const gate = deferred();
            calls.push({ url, options, ...gate });
            return gate.promise;
        },
        getServerEndpointConfig: () => ({ host: "fixture.local", port: 8080 }),
        getApiAuthorizationHeaders: () => ({ Authorization: "Bearer fixture-secret" }),
        getLifecycleSnapshot: () => lifecycle,
    });
    function respond(offset = 0) {
        calls[offset].resolve({ ok: true, text: async () => "llamacpp:tokens_predicted_total 7" });
        calls[offset + 1].resolve({ ok: true, json: async () => [] });
    }
    const external = { external_chat_target: { connected: true, host: "Fixture.LOCAL", port: 8080 } };
    return { ...h, poller, calls, targets, results, respond, external,
        state: () => poller._test.getState(),
        setLifecycle: value => { lifecycle = value; } };
}

test("inference creation is inert and production instances expose no test state", () => {
    const h = fixture({ __LLAMA_GUI_TEST_HOOKS__: false });
    assert.equal(h.calls.length, 0);
    assert.equal(h.targets.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.poller._test, undefined);
    assert.deepEqual(Object.keys(h.poller).sort(),
        ["markExternalTargetChanged", "reconcileTarget", "setActive", "start", "stop"]);
});

test("inference preserves initial/subsequent delays, independent sources, auth and no overlap", async () => {
    const h = fixture();
    h.poller.start({ generation: 4 }, { operation: "launch" });
    assert.equal(h.targets.at(-1).key, "gui:4");
    assert.equal(h.targets.at(-1).options.zeroBaseline, true);
    await h.tick(1999);
    assert.equal(h.calls.length, 0);
    await h.tick(1);
    assert.equal(h.calls.length, 2);
    assert.match(h.calls[0].url, /metrics\?host=fixture.local&port=8080/);
    assert.equal(h.calls[0].options.headers.Authorization, "Bearer fixture-secret");
    assert.equal(h.calls[0].options.signal, h.calls[1].options.signal);
    h.poller.setActive(true);
    await h.tick(9000);
    assert.equal(h.calls.length, 2, "an unfinished pair prevents overlap");
    h.calls[0].resolve({ ok: false });
    h.calls[1].resolve({ ok: true, json: async () => [] });
    await flush();
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].metricsOk, false);
    assert.equal(h.results[0].slotsOk, true);
    await h.tick(2999);
    assert.equal(h.calls.length, 2);
    await h.tick(1);
    assert.equal(h.calls.length, 4);
    h.calls[2].resolve({ ok: true, text: async () => "llamacpp:tokens_predicted_total 9" });
    h.calls[3].resolve({ ok: false });
    await flush();
    assert.equal(h.results[1].metricsOk, true);
    assert.equal(h.results[1].slotsOk, false);
    h.poller.stop();
    assert.equal(h.timers.size, 0);
});

test("visibility pause retains the baseline and rejects aborted work without reviving timers", async () => {
    const h = fixture();
    h.poller.reconcileTarget(h.external);
    await h.tick(2000);
    h.poller.setActive(false);
    assert.equal(h.calls[0].options.signal.aborted, true);
    assert.equal(h.targets.at(-1).key, "ext:0:fixture.local:8080");
    assert.equal(h.state().active, false);
    assert.equal(h.state().hasAbortController, false);
    h.respond();
    await flush();
    await h.tick(10000);
    assert.equal(h.results.length, 0);
    assert.equal(h.calls.length, 2);
    const targetsBeforeResume = h.targets.length;
    h.poller.setActive(true);
    assert.equal(h.calls.length, 4, "resume polls immediately");
    assert.equal(h.targets.length, targetsBeforeResume, "resume does not reset the baseline");
    h.respond(2); await flush();
    assert.equal(h.results.length, 1);
    h.poller.stop();
    assert.equal(h.targets.at(-1).key, null);
    assert.equal(h.timers.size, 0);
});

test("same-address reconnect invalidates old work and preserves the replacement in-flight guard", async () => {
    const h = fixture();
    h.poller.reconcileTarget(h.external);
    await h.tick(2000);
    h.poller.markExternalTargetChanged();
    h.poller.reconcileTarget(h.external);
    assert.equal(h.targets.at(-1).key, "ext:1:fixture.local:8080");
    assert.equal(h.targets.at(-1).options.zeroBaseline, false);
    await h.tick(2000);
    h.respond(0); await flush();
    assert.equal(h.results.length, 0);
    assert.equal(h.state().inFlight, true, "old finally must not clear the new epoch");
    assert.equal(h.state().hasAbortController, true);
    h.poller.setActive(true);
    assert.equal(h.calls.length, 4);
    h.respond(2); await flush();
    assert.equal(h.results.length, 1);
    assert.equal(h.timers.size, 1);
    h.poller.stop();
});

for (const body of ["metrics", "slots"]) {
    test(`late ${body} body parsing is discarded after a target change`, async () => {
        const h = fixture();
        const delayedBody = deferred();
        h.poller.reconcileTarget(h.external);
        await h.tick(2000);
        h.calls[0].resolve({ ok: true, text: () => body === "metrics"
            ? delayedBody.promise : Promise.resolve("llamacpp:tokens_predicted_total 99") });
        h.calls[1].resolve({ ok: true, json: () => body === "slots"
            ? delayedBody.promise : Promise.resolve([]) });
        await flush();
        h.poller.stop();
        delayedBody.resolve(body === "metrics" ? "llamacpp:tokens_predicted_total 99" : []);
        await flush();
        assert.equal(h.results.length, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.state().hasAbortController, false);
    });
}

test("accepted status cannot preempt GUI readiness and restore uses a first-sample baseline", () => {
    const h = fixture();
    const status = { running: true, active_runtime: { tool: "llama-server", generation: 3 } };
    h.poller.reconcileTarget(status);
    assert.equal(h.targets.length, 0);
    h.setLifecycle({ ready: true, activeRuntime: { generation: 2 } });
    h.poller.reconcileTarget(status);
    assert.equal(h.targets.length, 0);
    h.poller.start(status.active_runtime, { operation: "restore" });
    assert.equal(h.targets.at(-1).options.zeroBaseline, false);
    h.setLifecycle({ ready: true, activeRuntime: { generation: 3 } });
    const targetCount = h.targets.length;
    h.poller.reconcileTarget(status);
    assert.equal(h.targets.length, targetCount);
    h.poller.stop();
    h.poller.reconcileTarget(status);
    assert.equal(h.targets.at(-1).options.zeroBaseline, false);
    assert.equal(h.timers.size, 1);
    h.poller.reconcileTarget({ running: false });
    assert.equal(h.timers.size, 0);
});

test("transport and parsing failures remain per-source and subsequent polls recover", async () => {
    const logs = [];
    const h = fixture({ console: { debug: (...args) => logs.push(args) } });
    h.poller.reconcileTarget(h.external);
    await h.tick(2000);
    h.calls[0].reject(new Error("metrics offline"));
    h.calls[1].resolve({ ok: true, json: async () => { throw new Error("invalid slots"); } });
    await flush();
    assert.equal(h.results[0].metricsOk, false);
    assert.equal(h.results[0].slotsOk, false);
    assert.equal(logs.length, 2);
    await h.tick(3000);
    h.respond(2); await flush();
    assert.equal(h.results[1].metricsOk, true);
    assert.equal(h.results[1].slotsOk, true);
    h.poller.stop();
});
