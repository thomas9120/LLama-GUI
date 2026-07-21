const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "process-lifecycle.js"), "utf8");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function loadLifecycle() {
    const warnings = [];
    const context = {
        window: { LlamaGui: {} },
        console: {
            debug() {},
            warn(...args) { warnings.push(args); },
        },
        setTimeout,
        clearTimeout,
        encodeURIComponent,
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "ui/js/process-lifecycle.js" });
    return { lifecycle: context.window.LlamaGui.processLifecycle, warnings };
}

function runtime(generation, overrides = {}) {
    return Object.assign({
        generation,
        tool: "llama-server",
        model: `models/model-${generation}.gguf`,
        alias: `model-${generation}`,
        host: "127.0.0.1",
        port: 8080 + generation,
        source: "manual",
        slot: null,
    }, overrides);
}

function runningStatus(activeRuntime) {
    return {
        running: true,
        active_process_tool: activeRuntime.tool,
        active_runtime: activeRuntime,
        runtime_generation: activeRuntime.generation,
    };
}

function idleStatus(generation = 0) {
    return { running: false, active_runtime: null, runtime_generation: generation };
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

async function waitForPhase(lifecycle, phase) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (lifecycle.getSnapshot().phase === phase) return;
        await flush();
    }
    assert.equal(lifecycle.getSnapshot().phase, phase);
}

async function testReadinessProgression() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(1);
    const health = [
        { state: "starting", ready: false, running: true, generation: 1 },
        { state: "loading", ready: false, running: true, generation: 1 },
        { state: "ready", ready: true, running: true, generation: 1 },
    ];
    const calls = [];
    const hooks = [];
    const phases = [];
    lifecycle.subscribe(state => phases.push(state.phase));
    lifecycle.configure({
        healthPollMs: 0,
        delay: async () => {},
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async (url, options) => {
            calls.push([url, options]);
            if (url === "/api/launch") {
                return { pid: 10, output_cursor: 4, active_runtime: activeRuntime };
            }
            if (url.startsWith("/api/llama/health")) return health.shift();
            throw new Error(`Unexpected URL: ${url}`);
        },
        startOutput: async (cursor, value) => hooks.push(["output", cursor, value.generation]),
        startStats: async value => hooks.push(["stats", value.generation]),
        postReady: async value => hooks.push(["ready", value.generation]),
    });

    const response = await lifecycle.launch({ tool: "llama-server", args: ["-m", "models/model-1.gguf"] });

    assert.equal(response.ok, true);
    assert.equal(lifecycle.getSnapshot().phase, "ready");
    assert.equal(lifecycle.getSnapshot().activeRuntime.generation, 1);
    assert.ok(phases.includes("starting"));
    assert.ok(phases.includes("loading"));
    assert.deepEqual(hooks, [["output", 4, 1], ["stats", 1], ["ready", 1]]);
    assert.equal(calls.filter(([url]) => url.startsWith("/api/llama/health")).length, 3);
}

async function testSlowLoadWarnsOnceAndContinuesToReady() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(2);
    const warnings = [];
    const health = [
        { state: "loading", ready: false, generation: 2 },
        { state: "loading", ready: false, generation: 2 },
        { state: "ready", ready: true, generation: 2 },
    ];
    lifecycle.configure({
        healthPollMs: 0,
        slowLoadWarningMs: 0,
        delay: async () => {},
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async (url) => {
            if (url === "/api/launch") {
                return { pid: 11, output_cursor: 5, active_runtime: activeRuntime };
            }
            if (url.startsWith("/api/llama/health")) return health.shift();
            throw new Error(`Unexpected URL: ${url}`);
        },
        onSlowLoad: async message => warnings.push(message),
    });

    const response = await lifecycle.launch({
        tool: "llama-server",
        args: ["-m", "models/model-2.gguf"],
    });

    assert.equal(response.ok, true);
    assert.equal(lifecycle.getSnapshot().phase, "ready");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /taking longer than expected/i);
}

async function testRestoreUsesAuthoritativeRuntimeAndHealth() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(9, { host: "127.0.0.1", port: 9009 });
    const outputStarts = [];
    lifecycle.configure({
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async (url) => {
            if (url === "/api/llama/health?expected_generation=9") {
                return { state: "ready", ready: true, generation: 9 };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
        startOutput: async (cursor, value) => outputStarts.push([cursor, value.host, value.port]),
    });

    const response = await lifecycle.restore(Object.assign(runningStatus(activeRuntime), { output_cursor: 23 }));

    assert.equal(response.ok, true);
    assert.equal(lifecycle.getSnapshot().phase, "ready");
    assert.equal(lifecycle.getSnapshot().activeRuntime.port, 9009);
    assert.deepEqual(outputStarts, [[23, "127.0.0.1", 9009]]);
}

async function testInvalidPreflightDoesNotStop() {
    const { lifecycle } = loadLifecycle();
    const calls = [];
    const failures = [];
    let abortCount = 0;
    let applyCount = 0;
    lifecycle.configure({
        fetchJson: async (url) => {
            calls.push(url);
            throw new Error("No process request expected");
        },
        resolveTarget: async () => ({ preset: "Broken" }),
        prepareTarget: async () => ({ ok: false, error: "Model file is missing" }),
        abortChat: async () => { abortCount += 1; },
        applyTarget: async () => { applyCount += 1; },
        buildLaunchRequest: async () => ({ tool: "llama-server", args: [] }),
        onFailed: async message => failures.push(message),
    });

    const response = await lifecycle.switchRuntime({ slot: "b" });

    assert.equal(response.ok, false);
    assert.equal(response.preflight, true);
    assert.match(response.error, /model file is missing/i);
    assert.deepEqual(calls, []);
    assert.equal(abortCount, 0);
    assert.equal(applyCount, 0);
    assert.deepEqual(failures, ["Model file is missing"]);
    assert.equal(lifecycle.getSnapshot().busy, false);
}

async function testStopRefusalPreventsApplyAndLaunch() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(2, { source: "model-switcher", slot: "a" });
    const calls = [];
    const order = [];
    lifecycle.configure({
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async (url, options) => {
            calls.push([url, options]);
            if (url === "/api/stop") return { stopped: false };
            throw new Error(`Unexpected URL: ${url}`);
        },
        resolveTarget: async () => {
            order.push("resolve");
            return { preset: "Model B" };
        },
        prepareTarget: async target => {
            order.push("prepare");
            return { ok: true, target };
        },
        abortChat: async () => order.push("abort"),
        invalidateOutput: async () => order.push("output"),
        invalidateStats: async () => order.push("stats"),
        applyTarget: async () => order.push("apply"),
        buildLaunchRequest: async () => {
            order.push("build");
            return { tool: "llama-server", args: ["-m", "models/b.gguf"] };
        },
        onFailed: async message => order.push(`failed:${message}`),
    });

    const response = await lifecycle.switchRuntime({ slot: "b" });

    assert.equal(response.ok, false);
    assert.match(response.error, /refused to stop/i);
    assert.deepEqual(order, [
        "resolve", "prepare", "abort", "output", "stats", "failed:The running process refused to stop.",
    ]);
    assert.equal(calls.filter(([url]) => url === "/api/stop").length, 1);
    assert.equal(calls.some(([url]) => url === "/api/launch"), false);
    const stopBody = JSON.parse(calls.find(([url]) => url === "/api/stop")[1].body);
    assert.equal(stopBody.expected_generation, 2);
    assert.equal(lifecycle.getSnapshot().phase, "failed");
    assert.equal(lifecycle.getSnapshot().activeRuntime.generation, 2);
}

async function testSwitchStopExceptionNotifiesOnce() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(26, { source: "model-switcher", slot: "a" });
    const failures = [];
    lifecycle.configure({
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async url => {
            if (url === "/api/stop") throw new Error("stop transport failed");
            throw new Error(`Unexpected URL: ${url}`);
        },
        resolveTarget: async () => ({ preset: "Model B" }),
        prepareTarget: async target => ({ ok: true, target }),
        buildLaunchRequest: async () => ({ tool: "llama-server", args: ["-m", "models/b.gguf"] }),
        onFailed: async message => failures.push(message),
    });

    const response = await lifecycle.switchRuntime({ slot: "b" });

    assert.equal(response.ok, false);
    assert.match(response.error, /stop transport failed/i);
    assert.deepEqual(failures, ["stop transport failed"], "stop exceptions must notify exactly once");
}

async function testSwitchOrdersPreflightStopApplyAndLaunch() {
    const { lifecycle } = loadLifecycle();
    const modelA = runtime(3, { source: "model-switcher", slot: "a" });
    const modelB = runtime(4, { source: "model-switcher", slot: "b" });
    const order = [];
    let launchBody = null;
    let statusStep = 0;
    lifecycle.configure({
        healthPollMs: 0,
        delay: async () => {},
        refreshStatus: async () => {
            statusStep += 1;
            if (statusStep === 1) return runningStatus(modelA);
            if (statusStep === 2) return idleStatus(3);
            return runningStatus(modelB);
        },
        fetchJson: async (url, options) => {
            if (url === "/api/stop") {
                order.push("stop");
                return { stopped: true };
            }
            if (url === "/api/launch") {
                order.push("launch");
                launchBody = JSON.parse(options.body);
                return { pid: 20, output_cursor: 8, active_runtime: modelB };
            }
            if (url.startsWith("/api/llama/health")) return { state: "ready", ready: true, generation: 4 };
            throw new Error(`Unexpected URL: ${url}`);
        },
        resolveTarget: async () => {
            order.push("resolve");
            return { preset: "Model B" };
        },
        prepareTarget: async target => {
            order.push("prepare");
            return { ok: true, target };
        },
        abortChat: async () => order.push("abort"),
        invalidateOutput: async () => order.push("output"),
        invalidateStats: async () => order.push("stats"),
        applyTarget: async () => order.push("apply"),
        buildLaunchRequest: async () => {
            order.push("build");
            return {
                tool: "llama-server",
                args: ["-m", "models/model-4.gguf"],
                launch_context: { source: "model-switcher", slot: "b", preset: "Model B", preset_fingerprint: "fp-b" },
                presetData: { flags: { ctx_size: 4096 } },
            };
        },
        postReady: async () => order.push("post-ready"),
    });

    const response = await lifecycle.switchRuntime({ slot: "b" });

    assert.equal(response.ok, true);
    assert.deepEqual(order, [
        "resolve", "prepare", "abort", "output", "stats", "stop", "apply", "build", "launch", "post-ready",
    ]);
    assert.equal(lifecycle.getSnapshot().phase, "ready");
    assert.equal(lifecycle.getSnapshot().activeRuntime.slot, "b");
    assert.equal(launchBody.launch_context.slot, "b");
    assert.equal(Object.prototype.hasOwnProperty.call(launchBody, "presetData"), false);
}

async function testDoubleActionAndStaleLaunchResponse() {
    const { lifecycle } = loadLifecycle();
    const launchDeferred = deferred();
    const activeRuntime = runtime(5);
    const calls = [];
    lifecycle.configure({
        delay: async () => {},
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async (url) => {
            calls.push(url);
            if (url === "/api/launch") return launchDeferred.promise;
            if (url.startsWith("/api/llama/health")) return { state: "ready", ready: true, generation: 5 };
            if (url === "/api/stop") return { stopped: true };
            throw new Error(`Unexpected URL: ${url}`);
        },
    });

    const first = lifecycle.launch({ tool: "llama-server", args: ["-m", "models/model-5.gguf"] });
    const second = await lifecycle.launch({ tool: "llama-server", args: ["-m", "models/other.gguf"] });
    assert.equal(second.ok, false);
    assert.equal(second.busy, true);
    assert.equal(calls.filter(url => url === "/api/launch").length, 1);

    launchDeferred.resolve({ pid: 30, output_cursor: 10, active_runtime: activeRuntime });
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    assert.equal(lifecycle.getSnapshot().activeRuntime.generation, 5);
}

async function testUserStopDuringLoadingCancelsStaleReadiness() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(6);
    const loadingDelay = deferred();
    let stopped = false;
    lifecycle.configure({
        healthPollMs: 0,
        delay: async () => loadingDelay.promise,
        refreshStatus: async () => stopped ? idleStatus(6) : runningStatus(activeRuntime),
        fetchJson: async (url) => {
            if (url === "/api/launch") return { pid: 40, output_cursor: 12, active_runtime: activeRuntime };
            if (url.startsWith("/api/llama/health")) {
                return { state: "loading", ready: false, running: true, generation: 6 };
            }
            if (url === "/api/stop") {
                stopped = true;
                return { stopped: true };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });

    const launchPromise = lifecycle.launch({ tool: "llama-server", args: ["-m", "models/model-6.gguf"] });
    await waitForPhase(lifecycle, "loading");
    assert.equal(lifecycle.getSnapshot().phase, "loading");

    const stopResponse = await lifecycle.stop();
    assert.equal(stopResponse.ok, true);
    assert.equal(lifecycle.getSnapshot().phase, "idle");
    loadingDelay.resolve();
    const launchResponse = await launchPromise;
    assert.equal(launchResponse.ok, false);
    assert.equal(launchResponse.cancelled, true);
    assert.equal(lifecycle.getSnapshot().phase, "idle");
}

async function testStaleHealthResponseCannotRestoreStoppedRuntime() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(7);
    const healthDeferred = deferred();
    let stopped = false;
    lifecycle.configure({
        refreshStatus: async () => stopped ? idleStatus(7) : runningStatus(activeRuntime),
        fetchJson: async (url) => {
            if (url === "/api/launch") return { pid: 50, output_cursor: 14, active_runtime: activeRuntime };
            if (url.startsWith("/api/llama/health")) return healthDeferred.promise;
            if (url === "/api/stop") {
                stopped = true;
                return { stopped: true };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });

    const launchPromise = lifecycle.launch({ tool: "llama-server", args: ["-m", "models/model-7.gguf"] });
    await flush();
    const stopResponse = await lifecycle.stop();
    assert.equal(stopResponse.ok, true);
    healthDeferred.resolve({ state: "ready", ready: true, generation: 7 });
    const launchResponse = await launchPromise;
    assert.equal(launchResponse.cancelled, true);
    assert.equal(lifecycle.getSnapshot().activeRuntime, null);
    assert.equal(lifecycle.getSnapshot().phase, "idle");
}

async function testLaunchFailureAndEarlyExit() {
    {
        const { lifecycle } = loadLifecycle();
        lifecycle.configure({
            refreshStatus: async () => idleStatus(),
            fetchJson: async (url) => {
                if (url === "/api/launch") throw new Error("spawn failed");
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        const response = await lifecycle.launch({ tool: "llama-server", args: ["-m", "models/bad.gguf"] });
        assert.equal(response.ok, false);
        assert.match(response.error, /spawn failed/i);
        assert.equal(lifecycle.getSnapshot().phase, "failed");
    }

    {
        const { lifecycle } = loadLifecycle();
        const activeRuntime = runtime(8);
        lifecycle.configure({
            refreshStatus: async () => idleStatus(8),
            fetchJson: async (url) => {
                if (url === "/api/launch") return { pid: 60, output_cursor: 16, active_runtime: activeRuntime };
                if (url.startsWith("/api/llama/health")) {
                    return { state: "failed", ready: false, running: false, generation: 8, exit_code: 1 };
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });
        const response = await lifecycle.launch({ tool: "llama-server", args: ["-m", "models/exits.gguf"] });
        assert.equal(response.ok, false);
        assert.match(response.error, /exited before it became ready/i);
        assert.equal(lifecycle.getSnapshot().phase, "failed");
        assert.equal(lifecycle.getSnapshot().activeRuntime, null);
    }
}

async function testRoundTripSwitchNeverOverlapsRuntimes() {
    const { lifecycle } = loadLifecycle();
    const modelA1 = runtime(10, { slot: "a", source: "model-switcher" });
    const modelB = runtime(11, { slot: "b", source: "model-switcher" });
    const modelA2 = runtime(12, { slot: "a", source: "model-switcher" });
    let current = modelA1;
    let processCount = 1;
    let maxProcessCount = 1;
    const launchedSlots = [];

    lifecycle.configure({
        healthPollMs: 0,
        delay: async () => {},
        refreshStatus: async () => current ? runningStatus(current) : idleStatus(12),
        fetchJson: async (url, options) => {
            if (url === "/api/stop") {
                assert.equal(processCount, 1, "stop must observe exactly one active process");
                current = null;
                processCount = 0;
                return { stopped: true };
            }
            if (url === "/api/launch") {
                assert.equal(processCount, 0, "replacement must not launch before stop completes");
                const body = JSON.parse(options.body);
                launchedSlots.push(body.launch_context.slot);
                current = body.launch_context.slot === "b" ? modelB : modelA2;
                processCount += 1;
                maxProcessCount = Math.max(maxProcessCount, processCount);
                return { pid: 70 + current.generation, output_cursor: 20, active_runtime: current };
            }
            if (url.startsWith("/api/llama/health")) {
                return { state: "ready", ready: true, generation: current.generation };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
        resolveTarget: async slot => ({
            tool: "llama-server",
            args: ["-m", `models/${slot}.gguf`],
            launch_context: {
                source: "model-switcher",
                slot,
                preset: `Model ${slot.toUpperCase()}`,
                preset_fingerprint: slot.repeat(64),
            },
            presetData: { tool: "llama-server", model: `models/${slot}.gguf`, flags: {} },
        }),
        applyTarget: async () => {},
    });

    await lifecycle.restore(runningStatus(modelA1));
    assert.equal((await lifecycle.switchRuntime({ slot: "b" })).ok, true);
    assert.equal((await lifecycle.switchRuntime({ slot: "a" })).ok, true);
    assert.deepEqual(launchedSlots, ["b", "a"]);
    assert.equal(maxProcessCount, 1);
    assert.equal(lifecycle.getSnapshot().activeRuntime.generation, 12);
}

async function testMissingAuthoritativeStatusCannotConfirmStop() {
    const { lifecycle } = loadLifecycle();
    const benchRuntime = runtime(13, { tool: "llama-bench", host: null, port: null });
    await lifecycle.restore(runningStatus(benchRuntime));
    lifecycle.configure({
        refreshStatus: async () => null,
        fetchJson: async url => {
            if (url === "/api/stop") return { stopped: false };
            throw new Error(`Unexpected URL: ${url}`);
        },
    });

    const response = await lifecycle.stop();
    assert.equal(response.ok, false);
    assert.match(response.error, /authoritative process status/i);
    assert.notEqual(lifecycle.getSnapshot().phase, "idle");
}

async function testReconcileOutOfBandGenerationReplacement() {
    const { lifecycle } = loadLifecycle();
    const modelA = runtime(20, { slot: "a", source: "model-switcher" });
    const modelB = runtime(21, { slot: "b", source: "model-switcher" });
    const hooks = [];
    lifecycle.configure({
        healthPollMs: 0,
        delay: async () => {},
        refreshStatus: async () => runningStatus(modelB),
        fetchJson: async url => {
            if (url === "/api/llama/health?expected_generation=20") {
                return { state: "ready", ready: true, generation: 20 };
            }
            if (url === "/api/llama/health?expected_generation=21") {
                return { state: "ready", ready: true, generation: 21 };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
        invalidateOutput: async () => hooks.push("invalidate-output"),
        invalidateStats: async () => hooks.push("invalidate-stats"),
        startOutput: async (_cursor, value) => hooks.push(`output-${value.generation}`),
    });
    await lifecycle.restore(runningStatus(modelA));
    hooks.length = 0;

    const response = await lifecycle.reconcile(Object.assign(runningStatus(modelB), { output_cursor: 31 }));

    assert.equal(response.ok, true);
    assert.equal(lifecycle.getSnapshot().phase, "ready");
    assert.equal(lifecycle.getSnapshot().activeRuntime.generation, 21);
    assert.deepEqual(hooks, ["invalidate-output", "invalidate-stats", "output-21"]);
}

async function testReconcileRepairsSameGenerationFailedState() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(22, { slot: "a", source: "model-switcher" });
    let healthCalls = 0;
    lifecycle.configure({
        healthPollMs: 0,
        delay: async () => {},
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async url => {
            if (url.startsWith("/api/llama/health")) {
                healthCalls += 1;
                return { state: "ready", ready: true, generation: 22 };
            }
            if (url === "/api/stop") return { stopped: false };
            throw new Error(`Unexpected URL: ${url}`);
        },
    });
    await lifecycle.restore(runningStatus(activeRuntime));
    const stopped = await lifecycle.stop();
    assert.equal(stopped.ok, false);
    assert.equal(lifecycle.getSnapshot().phase, "failed");

    const response = await lifecycle.reconcile(runningStatus(activeRuntime));

    assert.equal(response.ok, true);
    assert.equal(lifecycle.getSnapshot().phase, "ready");
    assert.equal(lifecycle.getSnapshot().ready, true);
    assert.equal(healthCalls, 2);
}

async function testReconcileHealthFailureUsesLocalNonRefreshingHook() {
    const { lifecycle } = loadLifecycle();
    const activeRuntime = runtime(23);
    let globalFailureCount = 0;
    let localFailureCount = 0;
    lifecycle.configure({
        refreshStatus: async () => runningStatus(activeRuntime),
        fetchJson: async url => {
            if (url.startsWith("/api/llama/health")) {
                return { state: "error", ready: false, generation: 23, error: "health endpoint unavailable" };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
        onFailed: async () => { globalFailureCount += 1; },
    });

    const response = await lifecycle.reconcile(runningStatus(activeRuntime), {
        onFailed: async () => { localFailureCount += 1; },
    });

    assert.equal(response.ok, false);
    assert.equal(lifecycle.getSnapshot().phase, "failed");
    assert.equal(lifecycle.getSnapshot().busy, false);
    assert.equal(localFailureCount, 1);
    assert.equal(globalFailureCount, 0);
}

async function testReconcileServerToBenchmarkReplacement() {
    const { lifecycle } = loadLifecycle();
    const serverRuntime = runtime(24);
    const benchmarkRuntime = runtime(25, { tool: "llama-bench", host: null, port: null });
    const hooks = [];
    lifecycle.configure({
        refreshStatus: async () => runningStatus(serverRuntime),
        fetchJson: async url => {
            if (url.startsWith("/api/llama/health")) {
                return { state: "ready", ready: true, generation: 24 };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
        invalidateOutput: async () => hooks.push("output"),
        invalidateStats: async () => hooks.push("stats"),
    });
    await lifecycle.restore(runningStatus(serverRuntime));

    const response = await lifecycle.reconcile(runningStatus(benchmarkRuntime), {
        startOutput: () => {},
        postReady: () => {},
    });

    assert.equal(response.ok, true);
    assert.equal(lifecycle.getSnapshot().phase, "running");
    assert.equal(lifecycle.getSnapshot().ready, true);
    assert.equal(lifecycle.getSnapshot().activeRuntime.generation, 25);
    assert.equal(lifecycle.getSnapshot().activeRuntime.tool, "llama-bench");
    assert.deepEqual(hooks, ["output", "stats"]);
}

async function main() {
    const tests = [
        ["readiness progression", testReadinessProgression],
        ["slow-load warning", testSlowLoadWarnsOnceAndContinuesToReady],
        ["authoritative restore", testRestoreUsesAuthoritativeRuntimeAndHealth],
        ["invalid preflight", testInvalidPreflightDoesNotStop],
        ["stop refusal", testStopRefusalPreventsApplyAndLaunch],
        ["switch stop exception notification", testSwitchStopExceptionNotifiesOnce],
        ["switch ordering", testSwitchOrdersPreflightStopApplyAndLaunch],
        ["double action", testDoubleActionAndStaleLaunchResponse],
        ["stop during loading", testUserStopDuringLoadingCancelsStaleReadiness],
        ["stale health", testStaleHealthResponseCannotRestoreStoppedRuntime],
        ["launch failure and exit", testLaunchFailureAndEarlyExit],
        ["A to B to A round trip", testRoundTripSwitchNeverOverlapsRuntimes],
        ["missing authoritative stop status", testMissingAuthoritativeStatusCannotConfirmStop],
        ["out-of-band generation reconciliation", testReconcileOutOfBandGenerationReplacement],
        ["same-generation failed-state recovery", testReconcileRepairsSameGenerationFailedState],
        ["observer health-failure hook isolation", testReconcileHealthFailureUsesLocalNonRefreshingHook],
        ["server-to-benchmark reconciliation", testReconcileServerToBenchmarkReplacement],
    ];
    for (const [name, run] of tests) {
        await run();
        process.stdout.write(`ok - ${name}\n`);
    }
    process.stdout.write("process lifecycle unit tests passed\n");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
