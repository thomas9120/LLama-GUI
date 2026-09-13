"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, deferred, flush } = require("./orchestration_harness.cjs");

function fixture() {
    const nodes = Object.fromEntries(["state", "accelerator", "ram", "detail"].map(name =>
        [`memory-estimate-${name}`, { textContent: "", classList: { toggle() {} } }]));
    const h = createHarness(["js/memory-estimate-ui.js"], {
        document: { getElementById: id => nodes[id] },
    });
    let result = { args: ["--model", "fixture.gguf"] };
    const calls = [];
    h.api.memoryEstimateUi.configure({
        flagCore: {
            getLaunchArgs: () => result,
            hasLaunchModelArg: args => args.includes("--model"),
            getCurrentTool: () => "llama-server",
        },
        fetchJson: (url, options) => {
            const gate = deferred();
            calls.push({ url, options, ...gate });
            return gate.promise;
        },
    });
    return { ...h, calls, nodes, schedule: h.api.memoryEstimateUi.schedule,
        setResult: value => { result = value; },
        text: name => nodes[`memory-estimate-${name}`].textContent };
}

test("memory estimates load/configure inertly and debounce the current shared arguments", async () => {
    const h = fixture();
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
    h.schedule();
    await h.tick(500);
    h.setResult({ args: ["--model", "latest.gguf"] });
    h.schedule();
    await h.tick(699);
    assert.equal(h.calls.length, 0);
    await h.tick(1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, "/api/estimate-memory");
    assert.deepEqual(JSON.parse(h.calls[0].options.body),
        { tool: "llama-server", args: ["--model", "latest.gguf"] });
    h.calls[0].resolve({ accelerator_mib: 2048, ram_mib: 512,
        rows: [{ device: "<GPU>", total_mib: 2048, model_mib: 1024, context_mib: 512, compute_mib: 512 }] });
    await flush();
    assert.equal(h.text("state"), "Ready");
    assert.equal(h.text("accelerator"), "2.00 GB");
    assert.equal(h.text("ram"), "512 MiB");
    assert.match(h.text("detail"), /^<GPU>: 2.00 GB \(model 1.00 GB/);
});

for (const staleOutcome of ["success", "failure"]) {
    test(`memory estimates reject an older ${staleOutcome} after the newer request wins`, async () => {
        const h = fixture();
        h.schedule(); await h.tick(700);
        h.schedule(); await h.tick(700);
        h.calls[1].resolve({ accelerator_mib: 4096, ram_mib: 32 });
        await flush();
        if (staleOutcome === "success") h.calls[0].resolve({ accelerator_mib: 1 });
        else h.calls[0].reject(new Error("obsolete"));
        await flush();
        assert.equal(h.text("state"), "Ready");
        assert.equal(h.text("accelerator"), "4.00 GB");
    });
}

test("invalid arguments and missing models invalidate pending estimates without fetching", async () => {
    for (const [result, state, detail] of [
        [{ error: "unmatched quote" }, "Unavailable", "unmatched quote"],
        [{ args: [] }, "Idle", "Select a model to estimate."],
    ]) {
        const h = fixture();
        h.schedule(); await h.tick(700);
        h.setResult(result);
        h.schedule(); await h.tick(700);
        h.calls[0].resolve({ accelerator_mib: 9999 });
        await flush();
        assert.equal(h.calls.length, 1);
        assert.equal(h.text("state"), state);
        assert.equal(h.text("detail"), detail);
        assert.equal(h.text("accelerator"), "--");
    }
});

test("estimate failures and optional null responses retain useful messages", async () => {
    for (const outcome of [null, { error: "unsupported build" }, new Error("offline")]) {
        const h = fixture();
        h.schedule(); await h.tick(700);
        if (outcome instanceof Error) h.calls[0].reject(outcome);
        else h.calls[0].resolve(outcome);
        await flush();
        assert.equal(h.text("state"), "Unavailable");
        assert.equal(h.text("detail"), outcome?.message || outcome?.error || "Memory estimate failed.");
    }
});
