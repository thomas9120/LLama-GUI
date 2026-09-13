"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, deferred, flush } = require("./orchestration_harness.cjs");

function fixture(overrides = {}) {
    const h = createHarness(["js/output-cursor.js", "js/process-output.js"], overrides);
    const calls = [], lines = [], events = [];
    let runtime = { generation: 1 };
    const poller = h.api.processOutput.create({
        fetchJson: url => {
            const gate = deferred();
            calls.push({ url, ...gate });
            return gate.promise;
        },
        appendOutput: line => lines.push(line),
        getLifecycleSnapshot: () => ({ activeRuntime: runtime }),
        onGenerationChanged: async () => events.push("generation"),
        onExit: () => events.push("exit"),
        onConnectionLost: () => events.push("lost"),
    });
    const sample = (extra = {}) => ({ running: true, runtime_generation: 1,
        lines: ["one"], next_cursor: 1, ...extra });
    return { ...h, poller, calls, lines, events, sample,
        setRuntime: next => { runtime = next; } };
}

test("output creation is inert and production instances expose only the application contract", () => {
    const h = fixture({ __LLAMA_GUI_TEST_HOOKS__: false });
    assert.deepEqual(Object.keys(h.poller).sort(), ["invalidate", "isActive", "start", "stop"]);
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.poller.isActive(), false);
});

test("output starts at the requested cursor, avoids overlap and clear preserves progress", async () => {
    const h = fixture();
    h.poller.start(10);
    await h.tick(299);
    assert.equal(h.calls.length, 0);
    await h.tick(1);
    assert.equal(h.calls[0].url, "/api/output?since=10");
    await h.tick(900);
    assert.equal(h.calls.length, 1);
    h.calls[0].resolve(h.sample({ next_cursor: 11 })); await flush();
    await h.tick(300);
    assert.equal(h.calls[1].url, "/api/output?since=11");
    h.lines.length = 0;
    h.poller.invalidate();
    h.calls[1].resolve(h.sample({ lines: ["discarded during clear"], next_cursor: 12 }));
    await flush();
    assert.deepEqual(h.lines, []);
    await h.tick(300);
    assert.equal(h.calls[2].url, "/api/output?since=11");
    h.calls[2].resolve(h.sample({ lines: ["new"], next_cursor: 12 })); await flush();
    assert.deepEqual(h.lines, ["new"]);
    h.poller.stop();
    assert.equal(h.timers.size, 0);
});

test("a current runtime replacement resets the cursor and asks the application to reconcile", async () => {
    const h = fixture();
    h.poller.start(8); await h.tick(300);
    h.calls[0].resolve(h.sample({ runtime_generation: 2, lines: ["replacement"] }));
    await flush();
    assert.deepEqual(h.events, ["generation"]);
    assert.deepEqual(h.lines, []);
    assert.equal(h.poller._test.getUrl(), "/api/output");
    h.poller.stop();
});

test("a superseded response cannot reset a replacement cursor or trigger reconciliation", async () => {
    const h = fixture();
    h.poller.start(); await h.tick(300);
    h.poller.stop();
    h.setRuntime({ generation: 2 });
    h.poller.start(20); await h.tick(300);
    h.calls[0].resolve(h.sample()); await flush();
    assert.deepEqual(h.events, []);
    assert.equal(h.poller._test.getUrl(), "/api/output?since=20");
    await h.tick(600);
    assert.equal(h.calls.length, 2, "old finally must not clear the replacement's overlap guard");
    h.calls[1].resolve(h.sample({ runtime_generation: 2, next_cursor: 21 })); await flush();
    assert.deepEqual(h.lines, ["one"]);
    h.poller.stop();
});

test("current exit consumes final lines and stops before notifying the application", async () => {
    const h = fixture();
    h.poller.start(); await h.tick(300);
    h.calls[0].resolve(h.sample({ running: false, lines: ["final"] })); await flush();
    assert.deepEqual(h.lines, ["final"]);
    assert.deepEqual(h.events, ["exit"]);
    assert.equal(h.poller.isActive(), false);
    await h.tick(3000);
    assert.equal(h.calls.length, 1);
});

test("stale exits and failures after stop have no application effects", async () => {
    for (const failure of [false, true]) {
        const h = fixture();
        h.poller.start(); await h.tick(300);
        h.poller.stop();
        if (failure) h.calls[0].reject(new Error("old failure"));
        else h.calls[0].resolve(h.sample({ running: false }));
        await flush();
        assert.deepEqual(h.events, []);
        assert.deepEqual(h.lines, []);
        assert.equal(h.timers.size, 0);
    }
});

test("output allows five retries, resets the count on success, then stops on the sixth failure", async () => {
    const h = fixture();
    h.poller.start();
    for (let i = 0; i < 2; i++) {
        await h.tick(300); h.calls.at(-1).reject(new Error("offline")); await flush();
    }
    await h.tick(300); h.calls.at(-1).resolve(h.sample()); await flush();
    for (let i = 1; i <= 6; i++) {
        await h.tick(300); h.calls.at(-1).reject(new Error("offline")); await flush();
        assert.equal(h.poller.isActive(), i <= 5);
        assert.match(h.lines.at(-1), i <= 5 ? new RegExp(`retry ${i}/5`) : /Connection to server lost/);
    }
    assert.deepEqual(h.events, ["lost"]);
    assert.equal(h.timers.size, 0);
    h.poller.start(); await h.tick(300);
    h.calls.at(-1).reject(new Error("offline")); await flush();
    assert.match(h.lines.at(-1), /retry 1\/5/);
    h.poller.stop();
});
