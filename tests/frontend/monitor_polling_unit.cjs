"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMonitorHarness } = require("./monitor_harness.cjs");

test("generation guards reject responses even when transport ignores abort", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, deferred, wait } = fixture;
    const pending = [];
    monitorUi.configure({ pollIntervalMs: 10000, fetchJson: (_url, { signal }) => {
        const gate = deferred();
        pending.push({ gate, signal });
        return gate.promise;
    } });
    monitorUi.onTabChanged("monitor");
    monitorUi.recheck();
    assert.equal(pending[0].signal.aborted, true);
    pending[1].gate.resolve(makeSample());
    await wait(5);
    pending[0].gate.resolve(makeSample({ system: { cpu: { available: true, percent: 99 } } }));
    await wait(5);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "18.4%");
    monitorUi.recheck();
    const parked = pending[2];
    monitorUi.setDocumentVisibility(false);
    assert.equal(parked.signal.aborted, true);
    parked.gate.resolve(makeSample({ system: { cpu: { available: true, percent: 99 } } }));
    await wait(60);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "18.4%");
    assert.equal(pending.length, 3, "a stale finally block cannot resume polling");
});

test("polling lifecycle", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, resetDom, buildStandardDom, makeSample, wait, deferred } = fixture;
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    const calls = [];
    let behavior = () => Promise.resolve(makeSample());
    const fetchJson = (url, options = {}) => {
        const call = { url, aborted: false };
        calls.push(call);
        const result = behavior(url, call);
        const signal = options && options.signal;
        if (!signal) return result;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                call.aborted = true;
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort);
            result.then(resolve, reject);
        });
    };
    monitorUi.configure({ fetchJson, pollIntervalMs: 30 });

    // Hidden panel: no polling at all.
    monitorUi.onTabChanged("configure");
    await wait(80);
    assert.equal(calls.length, 0, "system stats never poll while the tab is hidden");

    // Opening the tab polls immediately, then schedules after completion.
    monitorUi.onTabChanged("monitor");
    await wait(10);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/system-stats");
    assert.equal(documentStub.getElementById("monitor-live-badge").textContent.includes("Live"), true);
    await wait(120);
    assert.ok(calls.length >= 3, `scheduled polls continue (saw ${calls.length})`);

    // No overlap: a slow request delays the next poll until it completes.
    const gate = deferred();
    behavior = () => gate.promise;
    const countBeforeSlow = calls.length;
    await wait(120);
    assert.equal(calls.length, countBeforeSlow + 1, "at most one in-flight request");
    assert.ok(documentStub.getElementById("monitor-live-badge").textContent.includes("Live"),
        "routine background polls do not flash a transient Refreshing state");
    gate.resolve(makeSample());
    await wait(120);
    assert.ok(calls.length >= countBeforeSlow + 3, "polling resumes after completion");

    // Recheck aborts the in-flight request and forces refresh=1.
    const gate2 = deferred();
    behavior = () => gate2.promise;
    await wait(60);
    const slowCall = calls[calls.length - 1];
    monitorUi.recheck();
    const recheckCall = calls[calls.length - 1];
    assert.equal(recheckCall.url, "/api/system-stats?refresh=1");
    assert.equal(slowCall.aborted, true, "recheck aborts the in-flight poll");
    assert.ok(documentStub.getElementById("monitor-live-badge").textContent.includes("Refreshing"),
        "manual Recheck still exposes its in-progress state");
    gate2.resolve(makeSample());
    await wait(20);

    // Stale responses are rejected by generation, never rendered.
    const staleGate = deferred();
    let first = true;
    behavior = () => {
        if (first) {
            first = false;
            return staleGate.promise;
        }
        return Promise.resolve(makeSample({ system: {
            cpu: { available: true, percent: 99.9 },
            memory: { available: false },
            disk: { available: false },
        } }));
    };
    monitorUi.recheck();
    await wait(30);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "99.9%");
    staleGate.resolve(makeSample({ system: {
        cpu: { available: true, percent: 1.0 },
        memory: { available: false },
        disk: { available: false },
    } }));
    await wait(30);
    assert.equal(
        documentStub.getElementById("monitor-cpu-value").textContent, "99.9%",
        "a stale response must not overwrite the newer sample",
    );

    // Failures keep previous values, marked stale, and keep retrying.
    behavior = () => Promise.reject(new Error("backend offline"));
    monitorUi.recheck();
    await wait(30);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "99.9%");
    assert.ok(documentStub.getElementById("monitor-live-badge").textContent.includes("Stale"));
    behavior = () => Promise.resolve(makeSample());
    await wait(120);
    assert.equal(documentStub.getElementById("monitor-live-badge").textContent.includes("Live"), true);

    // Leaving the tab aborts in flight and stops polling.
    const gate3 = deferred();
    behavior = () => gate3.promise;
    await wait(60);
    const parkedCall = calls[calls.length - 1];
    monitorUi.onTabChanged("chat");
    assert.equal(parkedCall.aborted, true, "leaving the tab aborts the in-flight poll");
    const frozen = calls.length;
    gate3.resolve(makeSample());
    await wait(120);
    assert.equal(calls.length, frozen, "no polling while the panel is hidden");
    assert.ok(documentStub.getElementById("monitor-live-badge").textContent.includes("Paused"));

    // Document visibility gates polling the same way.
    monitorUi.onTabChanged("monitor");
    await wait(20);
    monitorUi.setDocumentVisibility(false);
    const frozenHidden = calls.length;
    await wait(120);
    assert.equal(calls.length, frozenHidden, "no polling while the document is hidden");
    monitorUi.setDocumentVisibility(true);
    await wait(20);
    assert.ok(calls.length > frozenHidden, "visibility resumes with an immediate poll");

    // Unavailable before any success.
    monitorUi._resetForTests();
    resetDom();
    buildStandardDom();
    let failing = true;
    monitorUi.configure({ fetchJson: async () => { if (failing) throw new Error("down"); return makeSample(); } });
    monitorUi.onTabChanged("monitor");
    await wait(20);
    assert.ok(documentStub.getElementById("monitor-live-badge").textContent.includes("Unavailable"));
    failing = false;
    await wait(120);
    assert.ok(documentStub.getElementById("monitor-live-badge").textContent.includes("Live"));
    monitorUi.onTabChanged("configure");

});

