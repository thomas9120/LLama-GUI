"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { getScriptPaths } = require("./script_order.cjs");
const { createMonitorHarness } = require("./monitor_harness.cjs");

test("package loading and configuration need no DOM, storage, transport or timers", () => {
    const context = vm.createContext({ window: {} });
    for (const src of getScriptPaths().filter(src => src === "js/inference-stats.js" || src.startsWith("js/monitor/"))) {
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../ui", src), "utf8"), context, { filename: src });
    }
    context.window.LlamaGui.monitorUi.configure({ fetchJson: () => assert.fail("configuration must be inert") });
    assert.deepEqual(Object.keys(context), ["window"]);
    assert.deepEqual(Object.keys(context.window), ["LlamaGui"]);
    for (const name of ["pollSystemStats", "renderSample", "hiddenCards", "cardOrder", "deps", "init"]) {
        assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined");
    }
});

test("controls and polling read dependencies configured after initialization", async (t) => {
    const fixture = createMonitorHarness();
    t.after(fixture.dispose);
    const { monitorUi, documentStub, makeSample, wait } = fixture;
    const calls = [];
    monitorUi.configure({ resetStatsBaseline: () => assert.fail("obsolete callback") });
    monitorUi.init();
    monitorUi.configure({
        resetStatsBaseline: () => calls.push("reset"),
        switchTab: tab => calls.push(tab),
        reviewLaunchChanges: () => calls.push("review"),
        fetchJson: async url => { calls.push(url); return makeSample(); },
    });
    documentStub.getElementById("btn-reset-inference").dispatch("click");
    documentStub.getElementById("btn-monitor-configure").dispatch("click");
    documentStub.getElementById("btn-monitor-review").dispatch("click");
    documentStub.getElementById("btn-monitor-recheck").dispatch("click");
    await wait(20);
    assert.deepEqual(calls, ["reset", "configure", "review", "/api/system-stats?refresh=1"]);
});
