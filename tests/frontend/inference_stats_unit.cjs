// Pure inference tests: deliberately no DOM, storage, fetch, or timers in the VM.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../../ui/js/inference-stats.js"), "utf8"), context);
const inferenceCore = context.window.LlamaGui.inferenceStats;
assert.deepEqual(Object.keys(context.window), ["LlamaGui"]);
assert.deepEqual(Object.keys(context.window.LlamaGui), ["inferenceStats"]);
assert.deepEqual(Object.keys(context), ["window"]);

// Constructing engines is inert; each instance owns its target, baseline and emissions.
{
    const seenA = [];
    const seenB = [];
    const a = inferenceCore.createInferenceStats({ onSnapshot: s => seenA.push(s) });
    const b = inferenceCore.createInferenceStats({ onSnapshot: s => seenB.push(s) });
    assert.equal(a.getSnapshot(), null);
    assert.equal(b.getSnapshot(), null);
    assert.equal(seenA.length + seenB.length, 0);
    a.setTarget("gui:1", { zeroBaseline: true });
    b.setTarget("gui:2");
    const input = { metricsOk: true, metricsValues: metricValues(), slotsOk: false, now: 1000 };
    a.applyPollResult(input);
    b.applyPollResult(input);
    assert.equal(a.getSnapshot().session.total, 1500);
    assert.equal(b.getSnapshot().session.total, 0);
    const snapshotA = a.getSnapshot();
    const countA = seenA.length;
    b.resetBaseline();
    b.setTarget(null);
    assert.equal(a.getSnapshot(), snapshotA);
    assert.equal(a.getTargetKey(), "gui:1");
    assert.equal(seenA.length, countA);
    assert.equal(b.getSnapshot(), null);
}

// ═════════════════════════════════════════════════════════════════════════
// 2. Metrics text + slot normalization
// ═════════════════════════════════════════════════════════════════════════

const metricsText = [
    "# comment line",
    "llamacpp:prompt_tokens_total 1024",
    "llamacpp:tokens_predicted_total 512",
    "llamacpp:prompt_tokens_seconds 342.7",
    "llamacpp:predicted_tokens_seconds 28.4",
    "llamacpp:requests_processing 1",
    "llamacpp:requests_deferred 2",
    "",
    "not a metric",
].join("\n");
const parsedMetrics = inferenceCore.parseMetricsText(metricsText);
assert.equal(parsedMetrics["llamacpp:prompt_tokens_total"], 1024);
assert.equal(parsedMetrics["llamacpp:requests_deferred"], 2);
assert.equal(Object.prototype.hasOwnProperty.call(parsedMetrics, "not"), false);

assert.equal(inferenceCore.normalizeSlots(null), null);
assert.equal(inferenceCore.normalizeSlots({}), null);

const slotsFixture = [
    { id: 0, id_task: 11, is_processing: true, n_ctx: 8192, n_prompt_tokens: 3072,
        n_prompt_tokens_processed: 3072, next_token: { n_decoded: 200 } },
    { id: 1, id_task: 12, is_processing: false, n_ctx: 8192, n_prompt_tokens: 6000,
        n_prompt_tokens_processed: 6000, next_token: { n_decoded: 100 } },
    { id: 2, is_processing: false, n_ctx: 0 },
];
const normalizedSlots = inferenceCore.normalizeSlots(slotsFixture);
assert.equal(normalizedSlots.processing, 1);
assert.equal(normalizedSlots.busySlots, 1);
assert.equal(normalizedSlots.totalSlots, 3);
// Most-filled slot is the idle slot 1 (retained context), honestly labeled.
assert.equal(normalizedSlots.busiest.slotId, 1);
assert.equal(normalizedSlots.busiest.isProcessing, false);
assert.equal(normalizedSlots.busiest.used, 6000);
assert.equal(normalizedSlots.busiest.total, 8192);
assert.equal(normalizedSlots.busiest.remaining, 2192);
assert.ok(Math.abs(normalizedSlots.busiest.percent - 73.24) < 0.01);
// Rate samples only come from processing slots with stable identities.
assert.equal(normalizedSlots.samples.length, 1);
assert.equal(normalizedSlots.samples[0].key, "0:11");

// Older builds expose next_token as an array.
const legacySlots = inferenceCore.normalizeSlots([
    { id: 0, is_processing: true, n_ctx: 100, n_prompt_tokens: 50,
        next_token: [{ n_decoded: 5 }] },
]);
assert.equal(legacySlots.busiest.used, 50);
assert.equal(legacySlots.samples.length, 0, "slot deltas require an id_task");

// ═════════════════════════════════════════════════════════════════════════
// 3. Shared inference engine
// ═════════════════════════════════════════════════════════════════════════

function metricValues(overrides = {}) {
    return Object.assign({
        "llamacpp:prompt_tokens_total": 1000,
        "llamacpp:tokens_predicted_total": 500,
        "llamacpp:prompt_tokens_seconds": 300,
        "llamacpp:predicted_tokens_seconds": 30,
        "llamacpp:requests_processing": 1,
        "llamacpp:requests_deferred": 0,
    }, overrides);
}

function slotsSample(slotId, promptProcessed, decoded, taskId = 1) {
    return {
        processing: 1,
        busySlots: 1,
        totalSlots: 2,
        busiest: { used: promptProcessed, total: 8192, remaining: 8192 - promptProcessed,
            percent: promptProcessed / 8192 * 100, isProcessing: true, slotId },
        samples: [{ key: `${slotId}:${taskId}`, promptTokens: promptProcessed, genTokens: decoded }],
    };
}

// Fresh GUI launch: zero baseline, session counts immediately.
{
    const seen = [];
    const engine = inferenceCore.createInferenceStats({ onSnapshot: (s) => seen.push(s) });
    assert.equal(engine.getTargetKey(), null);
    engine.setTarget("gui:1", { zeroBaseline: true });
    assert.equal(engine.getTargetKey(), "gui:1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].baselinePending, true);

    const snap = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, 200),
        now: 1000,
    });
    assert.equal(snap.session.prompt, 1000);
    assert.equal(snap.session.generated, 500);
    assert.equal(snap.session.total, 1500);
    assert.equal(snap.requests.queued, 0);
    assert.equal(snap.slots.busy, 1);
    assert.equal(snap.context.used, 1000);
    assert.equal(snap.baselinePending, false);
}

// Restored/external target: the first valid sample becomes the baseline.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("ext:1:127.0.0.1:8081");
    const first = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: false, slotsNormalized: null, now: 1000,
    });
    assert.equal(first.session.total, 0, "first sample establishes the baseline");
    const second = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 1200,
            "llamacpp:tokens_predicted_total": 600,
        }),
        slotsOk: false, slotsNormalized: null, now: 2000,
    });
    assert.equal(second.session.prompt, 200);
    assert.equal(second.session.generated, 100);
    assert.equal(second.session.total, 300);
}

// Counter fields are fresh per successful payload and baseline independently,
// including when one counter appears after the other.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("ext:fresh");
    const firstValues = metricValues();
    delete firstValues["llamacpp:tokens_predicted_total"];
    const first = engine.applyPollResult({
        metricsOk: true, metricsValues: firstValues,
        slotsOk: false, slotsNormalized: null, now: 1000,
    });
    assert.equal(first.session.prompt, 0);
    assert.equal(first.session.generated, null);

    const secondValues = metricValues();
    delete secondValues["llamacpp:prompt_tokens_total"];
    const second = engine.applyPollResult({
        metricsOk: true, metricsValues: secondValues,
        slotsOk: false, slotsNormalized: null, now: 2000,
    });
    assert.equal(second.session.prompt, null, "missing prompt must not carry forward");
    assert.equal(second.session.generated, 0, "late generated counter gets its own baseline");

    const third = engine.applyPollResult({
        metricsOk: true,
        metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 1100,
            "llamacpp:tokens_predicted_total": 550,
        }),
        slotsOk: false, slotsNormalized: null, now: 3000,
    });
    assert.equal(third.session.prompt, 100);
    assert.equal(third.session.generated, 50);
    assert.equal(third.session.total, 150);

    const empty = engine.applyPollResult({
        metricsOk: true, metricsValues: {},
        slotsOk: false, slotsNormalized: null, now: 4000,
    });
    assert.equal(empty.sources.metrics, "ok");
    assert.equal(empty.session.prompt, null, "an empty successful payload is not fresh");
    assert.equal(empty.session.generated, null);

    const rollback = engine.applyPollResult({
        metricsOk: true,
        metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 5,
            "llamacpp:tokens_predicted_total": 600,
        }),
        slotsOk: false, slotsNormalized: null, now: 5000,
    });
    assert.equal(rollback.session.prompt, 0, "rolled prompt counter rebases");
    assert.equal(rollback.session.generated, 100, "unrolled counter keeps its own baseline");
}

// Independent source failures: neither carries the other forward as live.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("gui:2", { zeroBaseline: true });
    engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, 200), now: 1000,
    });
    // /metrics fails: session tokens unavailable, slot context survives.
    const metricsDown = engine.applyPollResult({
        metricsOk: false, metricsValues: null,
        slotsOk: true, slotsNormalized: slotsSample(0, 1200, 250), now: 2000,
    });
    assert.equal(metricsDown.sources.metrics, "unavailable");
    assert.equal(metricsDown.sources.slots, "ok");
    assert.equal(metricsDown.session.total, null, "failed metrics must not carry forward");
    assert.equal(metricsDown.context.used, 1200, "valid slots must still render");
    assert.equal(metricsDown.slots.busy, 1);
    // /slots fails: context unavailable, cumulative metrics survive.
    const slotsDown = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 1300,
        }),
        slotsOk: false, slotsNormalized: null, now: 3000,
    });
    assert.equal(slotsDown.context, null);
    assert.equal(slotsDown.slots, null);
    assert.equal(slotsDown.session.prompt, 1300);
    // Counter rollback without a target change: upstream restart, rebase.
    const restarted = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 5,
            "llamacpp:tokens_predicted_total": 2,
        }),
        slotsOk: false, slotsNormalized: null, now: 4000,
    });
    assert.equal(restarted.session.prompt, 0, "rollback must rebase, not clamp");
    assert.equal(restarted.session.total, 0);
    // Malformed slot payloads stay unavailable.
    const badSlots = engine.applyPollResult({
        metricsOk: false, metricsValues: null,
        slotsOk: true, slotsNormalized: inferenceCore.normalizeSlots({ nope: true }), now: 5000,
    });
    assert.equal(badSlots.sources.slots, "unavailable");
}

// Invalid numeric fields never invent values.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("gui:3", { zeroBaseline: true });
    const snap = engine.applyPollResult({
        metricsOk: true,
        metricsValues: {
            "llamacpp:prompt_tokens_total": NaN,
            "llamacpp:tokens_predicted_total": -1,
            "llamacpp:requests_processing": "many",
        },
        slotsOk: true,
        slotsNormalized: inferenceCore.normalizeSlots([
            { id: 0, is_processing: true, n_ctx: -5, n_prompt_tokens: 10 },
        ]),
        now: 1000,
    });
    assert.equal(snap.session.prompt, null);
    assert.equal(snap.session.total, null);
    assert.equal(snap.requests.processing, null);
    assert.equal(snap.context, null);
}

// Current llama.cpp builds expose cumulative active-processing time. Session
// averages use those counters, so idle polls neither zero nor dilute them.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("gui:averages", { zeroBaseline: true });
    const first = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_seconds_total": 2,
            "llamacpp:tokens_predicted_seconds_total": 10,
        }),
        slotsOk: false, slotsNormalized: null, now: 1000,
    });
    assert.equal(first.speed.prompt, 500);
    assert.equal(first.speed.generated, 50);

    const idle = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_seconds_total": 2,
            "llamacpp:tokens_predicted_seconds_total": 10,
            "llamacpp:prompt_tokens_seconds": 0,
            "llamacpp:predicted_tokens_seconds": 0,
            "llamacpp:requests_processing": 0,
        }),
        slotsOk: false, slotsNormalized: null, now: 5000,
    });
    assert.equal(idle.speed.prompt, 500, "idle time does not dilute the prompt average");
    assert.equal(idle.speed.generated, 50, "idle time does not dilute the generation average");

    const moreWork = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 1200,
            "llamacpp:tokens_predicted_total": 900,
            "llamacpp:prompt_seconds_total": 2.5,
            "llamacpp:tokens_predicted_seconds_total": 14,
        }),
        slotsOk: false, slotsNormalized: null, now: 7000,
    });
    assert.equal(moreWork.speed.prompt, 480, "average is weighted by active prompt time");
    assert.equal(moreWork.speed.generated, 900 / 14, "average is weighted by active generation time");

    assert.equal(engine.resetBaseline(), true);
    assert.equal(engine.getSnapshot().speed.prompt, null);
    assert.equal(engine.getSnapshot().speed.generated, null);
}

// Session averages survive idle time but never mix data across resets/restarts.
{
    const engine = inferenceCore.createInferenceStats({});
    const poll = (tokens, seconds) => engine.applyPollResult({
        metricsOk: true,
        metricsValues: {
            "llamacpp:tokens_predicted_total": tokens,
            "llamacpp:tokens_predicted_seconds_total": seconds,
            "llamacpp:predicted_tokens_seconds": 999,
        },
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, tokens), now: 1000,
    });
    engine.setTarget("gui:restart-average", { zeroBaseline: true });
    assert.equal(poll(1000, 10).speed.generated, 100);
    assert.equal(poll(100, 2).speed.generated, null, "rollback must clear the zero-origin average");
    assert.equal(poll(200, 4).speed.generated, 50, "only post-restart work contributes");
    assert.equal(poll(300, 3).speed.generated, null, "time rollback also rebases even if tokens increased");
    assert.equal(poll(350, 4).speed.generated, 50);
    assert.equal(poll(10, null).speed.generated, null, "missing time cannot use a rolling gauge");
    assert.equal(poll(50, 1).speed.generated, null, "late timing establishes a matched pair");
    assert.equal(poll(100, 2).speed.generated, 50);

    engine.setTarget("ext:average");
    assert.equal(poll(1000, 10).speed.generated, null, "restored target excludes pre-connection work");
    assert.equal(poll(1100, 12).speed.generated, 50);
    engine.resetBaseline();
    assert.equal(poll(1300, 13).speed.generated, 200, "reset rebases tokens and time together");
    poll(1400, null);
    engine.resetBaseline();
    assert.equal(poll(1500, 15).speed.generated, null, "reset with missing time stays pending");
    assert.equal(poll(1600, 17).speed.generated, 50);

    engine.setTarget("gui:pending-reset", { zeroBaseline: true });
    assert.equal(engine.resetBaseline(), false);
    assert.equal(poll(500, 5).speed.generated, null, "reset before the first poll excludes previous work");
}

// Live generation updates while completed-request counters remain unchanged.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("ext:live");
    const poll = (now, decoded, taskId = 1, slotsOk = true) => engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:tokens_predicted_seconds_total": 10,
        }),
        slotsOk, slotsNormalized: slotsSample(0, 1000, decoded, taskId), now,
    });
    assert.equal(poll(1000, 4000).speed.generated, null);
    const live = poll(4000, 4045);
    assert.equal(live.speed.generated, 15, "no completed-request delta is needed");
    assert.equal(live.speed.generatedIsLive, true);
    assert.equal(live.session.generated, 0, "live samples do not inflate completed counters");
    assert.equal(poll(7000, 4105).speed.generated, 20, "the next poll updates the live rate");
    assert.equal(poll(10000, 4105).speed.generated, 0, "a stalled active task is a real zero");
    assert.equal(poll(13000, 5000, 2).speed.generated, null, "task replacement needs a new sample pair");
    assert.equal(poll(16000, 5030, 2).speed.generated, 10);
    assert.equal(poll(19000, 5, 2).speed.generated, null, "token rollback discards the old sample");
    assert.equal(poll(22000, 35, 2).speed.generated, 10);
    engine.resetBaseline();
    assert.equal(engine.getSnapshot().speed.generated, null, "reset clears the live rate immediately");
    assert.equal(poll(25000, 65, 2).speed.generated, 10);
    assert.equal(poll(28000, 95, 2, false).speed.generated, null);
    assert.equal(poll(31000, 125, 2).speed.generated, null, "missing slots break sample continuity");
    assert.equal(poll(61000, 425, 2).speed.generated, null, "long pauses do not dilute the rate");
    assert.equal(poll(64000, 455, 2).speed.generated, 10);
    assert.equal(poll(67000, 0, 3).speed.generated, null);
    assert.equal(poll(70000, 10, 3).speed.generated, null, "prompt processing is excluded from generation time");
    assert.equal(poll(73000, 40, 3).speed.generated, 10);
    engine.setTarget("ext:replacement");
    assert.equal(poll(76000, 70, 3).speed.generated, null);

    // Parallel tasks contribute their combined throughput; idle tasks do not.
    const parallel = (now, first, second) => engine.applyPollResult({
        metricsOk: false, slotsOk: true, now,
        slotsNormalized: inferenceCore.normalizeSlots([
            { id: 0, id_task: 3, is_processing: true, next_token: { n_decoded: first } },
            { id: 1, id_task: 4, is_processing: true, next_token: [{ n_decoded: second }] },
            { id: 2, id_task: 5, is_processing: false, next_token: { n_decoded: 10000 } },
        ]),
    });
    parallel(79000, 100, 100);
    assert.equal(parallel(82000, 130, 160).speed.generated, 30);
    const idle = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:tokens_predicted_total": 600,
            "llamacpp:tokens_predicted_seconds_total": 12,
        }), slotsOk: true, slotsNormalized: inferenceCore.normalizeSlots([]), now: 85000,
    });
    assert.equal(idle.speed.generated, 50, "idle returns to the completed-session average");
    assert.equal(idle.speed.generatedIsLive, false);
}

// Live prefill excludes cache reuse and never spans the transition to generation.
{
    const engine = inferenceCore.createInferenceStats();
    engine.setTarget("ext:prefill");
    const slot = (processed, decoded = 0, taskId = 1) => ({
        id: 0, id_task: taskId, is_processing: true, n_ctx: 10000,
        n_prompt_tokens: 8000 + (processed || 0), n_prompt_tokens_cache: 8000,
        n_prompt_tokens_processed: processed, next_token: [{ n_decoded: decoded }],
    });
    const poll = (now, slots) => engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({ "llamacpp:prompt_seconds_total": 2 }),
        slotsOk: slots !== null, slotsNormalized: inferenceCore.normalizeSlots(slots), now,
    });
    assert.equal(poll(1000, [slot(100)]).speed.prompt, null);
    const live = poll(4000, [slot(400)]);
    assert.equal(live.speed.prompt, 100, "8000 cached tokens do not count toward live speed");
    assert.equal(live.speed.promptIsLive, true);
    assert.equal(live.session.prompt, 0, "completed counters remain independent");
    assert.equal(live.speed.generated, null);
    assert.equal(poll(7000, [slot(400)]).speed.prompt, 100, "unchanged batch counts retain the measured rate");
    assert.equal(poll(10000, [slot(600, 1)]).speed.prompt, null, "mixed prefill/generation interval is excluded");
    assert.equal(poll(13000, [slot(600, 30)]).speed.promptIsLive, false);
    assert.equal(poll(16000, [slot(100, 0, 2)]).speed.prompt, null, "new task starts a fresh pair");
    assert.equal(poll(19000, [slot(400, 0, 2)]).speed.prompt, 100);
    assert.equal(poll(22000, [slot(10, 0, 2)]).speed.prompt, null, "rollback cannot create a live rate");
    assert.equal(poll(25000, [slot(null, 0, 2)]).speed.prompt, null, "null is not a zero counter");
    assert.equal(poll(28000, [slot(40, 0, 2)]).speed.prompt, null);
    assert.equal(poll(31000, [slot(70, null, 2)]).speed.prompt, null, "missing decode count does not prove prefill");
    poll(34000, [slot(100, 0, 2)]);
    assert.equal(poll(37000, [slot(400, 0, 2)]).speed.prompt, 100);
    engine.resetBaseline();
    assert.equal(engine.getSnapshot().speed.prompt, null);
    assert.equal(engine.getSnapshot().speed.promptIsLive, false);
    assert.equal(poll(40000, [slot(700, 0, 2)]).speed.prompt, 100);
    poll(43000, null);
    assert.equal(poll(46000, [slot(1000, 0, 2)]).speed.prompt, null);
    assert.equal(poll(76000, [slot(1300, 0, 2)]).speed.prompt, null, "long gaps break continuity");
    engine.setTarget("ext:other-prefill");
    assert.equal(poll(79000, [slot(1600, 0, 2)]).speed.prompt, null);

    const parallelSlots = (processed) => [
        slot(processed, 0, 2),
        { ...slot(processed, 0, 3), id: 1, next_token: { n_decoded: 0 } },
        { ...slot(processed, 40, 4), id: 2 },
        { ...slot(processed, 0, 5), id: 3, is_processing: false },
    ];
    poll(82000, parallelSlots(1900));
    assert.equal(poll(85000, parallelSlots(2200)).speed.prompt, 200, "only prefill slots contribute");
    const complete = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 1600, "llamacpp:prompt_seconds_total": 4,
        }), slotsOk: true, slotsNormalized: inferenceCore.normalizeSlots([]), now: 88000,
    });
    assert.equal(complete.speed.prompt, 300, "completed average replaces the live rate");
    assert.equal(complete.speed.promptIsLive, false);
}

// Batch-sized prompt updates must include the intervening unchanged polls.
{
    const engine = inferenceCore.createInferenceStats();
    engine.setTarget("ext:batched-prefill");
    const poll = (now, tokens) => engine.applyPollResult({
        metricsOk: false, slotsOk: true,
        slotsNormalized: slotsSample(0, tokens, 0), now,
    });
    assert.equal(poll(0, 0).speed.prompt, null);
    assert.equal(poll(3000, 0).speed.prompt, null);
    assert.equal(poll(6000, 2048).speed.prompt, null, "the first batch establishes the observation baseline");
    assert.equal(poll(9000, 2048).speed.prompt, null);
    assert.equal(poll(12000, 2048).speed.prompt, null);
    assert.equal(poll(15000, 4096).speed.prompt, 2048 / 9,
        "a batch taking nine seconds must not be divided by the last three-second poll");
    assert.equal(poll(18000, 4096).speed.prompt, 2048 / 9, "hold the measured average between batches");
    assert.equal(poll(21000, 6144).speed.prompt, 4096 / 15, "average all observed progress and elapsed time");
    assert.equal(poll(24000, 6144).speed.prompt, 4096 / 15);
    assert.equal(poll(42000, 8192).speed.prompt, null, "a polling gap discards the previous prompt average");
}

// 80%/95% context presentation levels.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("gui:5", { zeroBaseline: true });
    const levelFor = (used) => engine.applyPollResult({
        metricsOk: false, metricsValues: null,
        slotsOk: true,
        slotsNormalized: inferenceCore.normalizeSlots([
            { id: 0, is_processing: true, n_ctx: 100, n_prompt_tokens: used },
        ]),
        now: 1000,
    }).contextLevel;
    assert.equal(levelFor(50), "normal");
    assert.equal(levelFor(85), "warning");
    assert.equal(levelFor(96), "critical");
}

// Reset baseline: immediate re-render when sampled, pending otherwise.
{
    const seen = [];
    const engine = inferenceCore.createInferenceStats({ onSnapshot: (s) => seen.push(s) });
    engine.setTarget("gui:6", { zeroBaseline: true });
    engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: false, slotsNormalized: null, now: 1000,
    });
    const before = seen.length;
    assert.equal(engine.resetBaseline(), true);
    assert.ok(seen.length > before, "reset re-renders immediately");
    const after = seen[seen.length - 1];
    assert.equal(after.session.total, 0, "reset renders zero immediately");

    const engine2 = inferenceCore.createInferenceStats({});
    engine2.setTarget("gui:7", { zeroBaseline: true });
    assert.equal(engine2.resetBaseline(), false, "no sample yet: reset stays pending");
    const first = engine2.applyPollResult({
        metricsOk: true, metricsValues: metricValues(), slotsOk: false,
        slotsNormalized: null, now: 1000,
    });
    assert.equal(first.session.total, 0, "pending reset uses the next sample as baseline");

    // Reset with only one counter ever present must keep the other counter's
    // baseline pending until that field first appears.
    const engine3 = inferenceCore.createInferenceStats({});
    engine3.setTarget("gui:pending-counter", { zeroBaseline: true });
    const promptOnly = metricValues({
        "llamacpp:prompt_tokens_total": 100,
    });
    delete promptOnly["llamacpp:tokens_predicted_total"];
    engine3.applyPollResult({
        metricsOk: true, metricsValues: promptOnly, slotsOk: false,
        slotsNormalized: null, now: 1000,
    });
    assert.equal(engine3.resetBaseline(), true, "sampled counter reset succeeds");
    const resetPendingSnapshot = engine3.getSnapshot();
    assert.equal(resetPendingSnapshot.session.prompt, 0, "reset renders the current prompt as zero");
    assert.equal(resetPendingSnapshot.session.generated, null, "missing counter stays pending after reset");
    const promptOnlyAfterReset = metricValues({
        "llamacpp:prompt_tokens_total": 125,
    });
    delete promptOnlyAfterReset["llamacpp:tokens_predicted_total"];
    const pendingGenerated = engine3.applyPollResult({
        metricsOk: true, metricsValues: promptOnlyAfterReset, slotsOk: false,
        slotsNormalized: null, now: 2000,
    });
    assert.equal(pendingGenerated.session.prompt, 25, "present counter advances from the reset baseline");
    assert.equal(pendingGenerated.session.generated, null, "absent counter stays pending");
    const lateGeneratedValues = metricValues({
        "llamacpp:tokens_predicted_total": 7,
    });
    delete lateGeneratedValues["llamacpp:prompt_tokens_total"];
    const lateGenerated = engine3.applyPollResult({
        metricsOk: true, metricsValues: lateGeneratedValues, slotsOk: false,
        slotsNormalized: null, now: 3000,
    });
    assert.equal(lateGenerated.session.prompt, null, "missing prompt is unavailable");
    assert.equal(lateGenerated.session.generated, 0, "late counter establishes its own baseline");

    // A reset after a successful payload with a missing field must not anchor
    // that field to the stale raw counter from before the omission.
    const engine4 = inferenceCore.createInferenceStats({});
    engine4.setTarget("gui:reset-freshness", { zeroBaseline: true });
    engine4.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 1000,
            "llamacpp:tokens_predicted_total": 500,
        }), slotsOk: false, slotsNormalized: null, now: 1000,
    });
    const generatedOmitted = metricValues({
        "llamacpp:prompt_tokens_total": 1100,
    });
    delete generatedOmitted["llamacpp:tokens_predicted_total"];
    const omitted = engine4.applyPollResult({
        metricsOk: true, metricsValues: generatedOmitted,
        slotsOk: false, slotsNormalized: null, now: 2000,
    });
    assert.equal(omitted.session.prompt, 1100);
    assert.equal(omitted.session.generated, null);
    assert.equal(engine4.resetBaseline(), true);
    const resetSnapshot = engine4.getSnapshot();
    assert.equal(resetSnapshot.session.prompt, 0, "reset anchors the current prompt counter");
    assert.equal(resetSnapshot.session.generated, null,
        "reset leaves the omitted generated counter pending");
    const generatedReappeared = metricValues({
        "llamacpp:tokens_predicted_total": 550,
    });
    delete generatedReappeared["llamacpp:prompt_tokens_total"];
    const reappeared = engine4.applyPollResult({
        metricsOk: true, metricsValues: generatedReappeared,
        slotsOk: false, slotsNormalized: null, now: 3000,
    });
    assert.equal(reappeared.session.prompt, null);
    assert.equal(reappeared.session.generated, 0,
        "reappearing generated counter starts at the reset baseline");
}

// Target changes never mix counters or rate samples.
{
    const engine = inferenceCore.createInferenceStats({});
    engine.setTarget("gui:8", { zeroBaseline: true });
    engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, 100), now: 1000,
    });
    engine.setTarget("ext:2:host:9999");
    assert.equal(engine.getSnapshot().targetKey, "ext:2:host:9999");
    const after = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_total": 5000,
            "llamacpp:tokens_predicted_total": 2500,
        }),
        slotsOk: true, slotsNormalized: slotsSample(0, 5000, 400), now: 2000,
    });
    assert.equal(after.session.total, 0, "new target gets a fresh baseline");
    assert.equal(after.speed.prompt, null, "missing timing counters leave averages unavailable");
    assert.equal(after.speed.generated, null);
    engine.setTarget(null);
    assert.equal(engine.getSnapshot(), null);
    assert.equal(engine.applyPollResult({ metricsOk: true, metricsValues: {}, slotsOk: false, slotsNormalized: null, now: 3000 }), null);
}

console.log("inference stats unit tests passed");
