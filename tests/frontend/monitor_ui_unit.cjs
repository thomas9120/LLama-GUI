// Unit tests for ui/js/monitor-ui.js: formatting, inference snapshot
// normalization, the shared inference engine, system/GPU rendering,
// auto-scroll and terminal behavior, polling lifecycle, and hidden-card
// preferences.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "monitor-ui.js"), "utf8");

// ─────────────────────────────────────────────────────────────────────────
// Minimal DOM harness
// ─────────────────────────────────────────────────────────────────────────

function makeClassList(el) {
    return {
        add: (...names) => {
            for (const name of names) el._classes.add(name);
        },
        remove: (...names) => {
            for (const name of names) el._classes.delete(name);
        },
        contains: (name) => el._classes.has(name),
        toggle: (name, force) => {
            const shouldAdd = force === undefined ? !el._classes.has(name) : Boolean(force);
            if (shouldAdd) el._classes.add(name);
            else el._classes.delete(name);
            return shouldAdd;
        },
    };
}

function matches(el, selector) {
    if (!el || !el.dataset) return false;
    if (selector.startsWith("[") && selector.endsWith("]")) {
        const body = selector.slice(1, -1);
        const eq = body.indexOf("=");
        if (eq === -1) {
            const name = body.replace(/^data-/, "");
            const key = name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
            return el.dataset[key] !== undefined;
        }
        const rawName = body.slice(0, eq);
        const value = body.slice(eq + 1).replace(/^"|"$/g, "");
        const key = rawName.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        return el.dataset[key] === value;
    }
    if (selector.startsWith(".")) return el._classes.has(selector.slice(1));
    return el.tagName === selector.toUpperCase();
}

function queryAll(root, selector) {
    const found = [];
    const walk = (node) => {
        for (const child of node.children) {
            if (matches(child, selector)) found.push(child);
            walk(child);
        }
    };
    walk(root);
    return found;
}

function createElement(tagName = "div") {
    const el = {
        tagName: String(tagName).toUpperCase(),
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        _classes: new Set(),
        _textContent: "",
        _innerHTML: "",
        _listeners: {},
        _attributes: {},
        id: "",
        value: "",
        checked: false,
        disabled: false,
        open: false,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        title: "",
        href: "",
        target: "",
        rel: "",
        type: "",
        focusCalls: 0,
        get className() {
            return Array.from(this._classes).join(" ");
        },
        set className(value) {
            this._classes = new Set(String(value || "").split(/\s+/).filter(Boolean));
        },
        get textContent() {
            if (this.children.length === 0) return this._textContent;
            return this._textContent + this.children.map(child => child.textContent).join("");
        },
        set textContent(value) {
            // Real DOM semantics: assigning textContent replaces children.
            this._textContent = String(value);
            for (const child of this.children) child.parentNode = null;
            this.children = [];
        },
        set innerHTML(value) {
            // innerHTML is allowed only for fixed SVG markup; record it so
            // tests can prove no user/model content flows through it.
            this._innerHTML = String(value);
            this.children = [];
        },
        addEventListener(type, handler) {
            (this._listeners[type] = this._listeners[type] || []).push(handler);
        },
        removeEventListener() {},
        dispatch(type) {
            for (const handler of this._listeners[type] || []) handler({ target: this });
        },
        setAttribute(name, value) {
            this._attributes[name] = String(value);
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this._attributes, name)
                ? this._attributes[name]
                : null;
        },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this._attributes, name);
        },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        replaceChildren(...kids) {
            for (const child of this.children) child.parentNode = null;
            this.children = [];
            for (const kid of kids) this.appendChild(kid);
        },
        remove() {
            if (this.parentNode) {
                this.parentNode.children = this.parentNode.children.filter(c => c !== this);
            }
            this.parentNode = null;
        },
        get firstElementChild() {
            return this.children[0] || null;
        },
        get childElementCount() {
            return this.children.length;
        },
        focus() {
            this.focusCalls += 1;
        },
        contains(other) {
            let node = other;
            while (node) {
                if (node === this) return true;
                node = node.parentNode;
            }
            return false;
        },
        closest(selector) {
            let node = this;
            while (node) {
                if (matches(node, selector)) return node;
                node = node.parentNode;
            }
            return null;
        },
        querySelector(selector) {
            return queryAll(this, selector)[0] || null;
        },
        querySelectorAll(selector) {
            return queryAll(this, selector);
        },
    };
    el.classList = makeClassList(el);
    return el;
}

const documentRoot = createElement("body");
const elementsById = new Map();
const docListeners = {};

function mount(id, tagName = "div", parent = documentRoot) {
    const el = createElement(tagName);
    el.id = id;
    elementsById.set(id, el);
    parent.appendChild(el);
    return el;
}

const documentStub = {
    getElementById: (id) => elementsById.get(id) || null,
    createElement,
    addEventListener: (type, handler) => {
        (docListeners[type] = docListeners[type] || []).push(handler);
    },
    removeEventListener: () => {},
    querySelector: (selector) => queryAll(documentRoot, selector)[0] || null,
    querySelectorAll: (selector) => queryAll(documentRoot, selector),
};

// ─────────────────────────────────────────────────────────────────────────
// Storage harness
// ─────────────────────────────────────────────────────────────────────────

function makeStorage({ fail = false } = {}) {
    const map = new Map();
    return {
        map,
        getItem: (key) => {
            if (fail) throw new Error("storage blocked");
            return map.has(key) ? map.get(key) : null;
        },
        setItem: (key, value) => {
            if (fail) throw new Error("storage blocked");
            map.set(key, String(value));
        },
        removeItem: (key) => {
            if (fail) throw new Error("storage blocked");
            map.delete(key);
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// VM context
// ─────────────────────────────────────────────────────────────────────────

const warnings = [];
const context = {
    window: {},
    console: {
        debug: () => {},
        warn: (...args) => warnings.push(args),
        error: (...args) => warnings.push(args),
        info: () => {},
        log: () => {},
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    URLSearchParams,
    Promise,
    Object,
    Array,
    Set,
    Map,
    Number,
    String,
    Math,
    JSON,
    Date,
    document: documentStub,
    localStorage: makeStorage(),
    navigator: { userAgent: "test" },
};
context.window = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/monitor-ui.js" });

const monitorUi = context.window.LlamaGui.monitorUi;
assert.ok(monitorUi, "window.LlamaGui.monitorUi must exist");

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {

function resetDom() {
    documentRoot.children = [];
    elementsById.clear();
}

// Standard element set required by init()/rendering paths.
function buildStandardDom() {
    resetDom();
    mount("monitor-live-badge", "span");
    mount("monitor-last-updated", "span");
    mount("btn-monitor-recheck", "button");
    mount("monitor-auto-scroll", "input").checked = true;
    const terminal = mount("output-terminal");
    terminal.scrollHeight = 100;
    terminal.clientHeight = 50;
    mount("btn-clear-output", "button");
    mount("input-row");
    mount("monitor-process-tool", "span");
    mount("monitor-process-state", "span");
    mount("monitor-no-process-note", "p");
    mount("monitor-external-note");
    mount("monitor-hidden-controls", "details").appendChild(createElement("summary"));
    mount("monitor-hidden-count", "span");
    mount("monitor-restore-items");
    mount("btn-monitor-show-all", "button");
    for (const prefix of ["cpu", "memory", "disk"]) {
        mount(`monitor-${prefix}-value`);
        mount(`monitor-${prefix}-bar`);
        mount(`monitor-${prefix}-sub`);
    }
    mount("monitor-disk-io").classList.add("hidden");
    mount("monitor-disk-read", "span");
    mount("monitor-disk-write", "span");
    mount("monitor-gpu-grid");
    mount("monitor-gpu-states");
    mount("monitor-gpu-setup").classList.add("hidden");
    mount("monitor-setup-cards");
    mount("monitor-inference-kicker");
    mount("monitor-inference-state-badge", "span");
    mount("monitor-inference-body").classList.add("hidden");
    mount("monitor-inference-empty");
    for (const id of [
        "monitor-inference-prompt", "monitor-inference-generated", "monitor-inference-total",
        "monitor-inference-context-label", "monitor-inference-context-reading",
        "monitor-inference-prompt-speed", "monitor-inference-gen-speed",
        "monitor-inference-requests", "monitor-inference-slots",
    ]) {
        mount(id, "span");
    }
    mount("monitor-inference-context-bar");
    mount("btn-reset-inference", "button");
}

function makeSample(overrides = {}) {
    return Object.assign({
        sampled_at: 1788278400.5,
        interval_seconds: 2.0,
        system: {
            cpu: { available: true, percent: 18.4 },
            memory: { available: true, used_bytes: 12884901888, total_bytes: 34359738368, percent: 37.5 },
            disk: {
                available: true,
                path_label: "Application disk",
                used_bytes: 500000000000,
                total_bytes: 1000000000000,
                percent: 50,
                read_bytes_per_second: 1240000,
                write_bytes_per_second: 420000,
            },
        },
        gpus: [],
        gpu_setup: [],
    }, overrides);
}

function makeGpu(id, extras = {}) {
    return Object.assign({
        provider: "nvidia",
        id,
        id_persistent: true,
        index: 0,
        name: "NVIDIA GeForce RTX 4090",
        utilization_percent: 72,
        memory_used_bytes: 18400000000,
        memory_total_bytes: 24000000000,
        temperature_c: 63,
    }, extras);
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Formatting helpers
// ═════════════════════════════════════════════════════════════════════════

assert.equal(monitorUi.formatBytes(0), "0 B");
assert.equal(monitorUi.formatBytes(1024), "1.0 KB");
assert.equal(monitorUi.formatBytes(512 * 1024 * 1024), "512 MB");
assert.equal(monitorUi.formatBytes(96.5 * 1024 * 1024), "96.5 MB");
assert.equal(monitorUi.formatBytes(48.0 * 1024 ** 3), "48.0 GB");
assert.equal(monitorUi.formatBytes(1.9 * 1024 ** 4), "1.9 TB");
assert.equal(monitorUi.formatBytes(null), "Not available");
assert.equal(monitorUi.formatBytes(-5), "Not available");
assert.equal(monitorUi.formatBytes("abc"), "Not available");

assert.equal(monitorUi.formatRate(1240000), "1.2 MB/s");
assert.equal(monitorUi.formatRate(null), "Not available");
assert.equal(monitorUi.formatRate(0), "0 B/s");

assert.equal(monitorUi.formatPercentValue(37.5, 1), "37.5");
assert.equal(monitorUi.formatPercentValue(150, 0), "100");
assert.equal(monitorUi.formatPercentValue(null), "Not available");
assert.equal(monitorUi.formatTokens(1536), "1,536");
assert.equal(monitorUi.formatTokens(null), "--");
assert.equal(monitorUi.formatClock(null), "--:--:--");
assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(monitorUi.formatClock(1788278400.5)));
assert.equal(monitorUi.shortGpuId("gpu-short"), "gpu-short");
assert.equal(
    monitorUi.shortGpuId("nvidia:uuid:GPU-7f3e2a91-4c1d-8b0e-93aa-c2f5d41b09e8").includes("\u2026"),
    true,
);

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
const parsedMetrics = monitorUi.parseMetricsText(metricsText);
assert.equal(parsedMetrics["llamacpp:prompt_tokens_total"], 1024);
assert.equal(parsedMetrics["llamacpp:requests_deferred"], 2);
assert.equal(Object.prototype.hasOwnProperty.call(parsedMetrics, "not"), false);

assert.equal(monitorUi.normalizeSlots(null), null);
assert.equal(monitorUi.normalizeSlots({}), null);

const slotsFixture = [
    { id: 0, id_task: 11, is_processing: true, n_ctx: 8192, n_prompt_tokens: 3072,
        n_prompt_tokens_processed: 3072, next_token: { n_decoded: 200 } },
    { id: 1, id_task: 12, is_processing: false, n_ctx: 8192, n_prompt_tokens: 6000,
        n_prompt_tokens_processed: 6000, next_token: { n_decoded: 100 } },
    { id: 2, is_processing: false, n_ctx: 0 },
];
const normalizedSlots = monitorUi.normalizeSlots(slotsFixture);
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
const legacySlots = monitorUi.normalizeSlots([
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
    const engine = monitorUi.createInferenceStats({ onSnapshot: (s) => seen.push(s) });
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
    const engine = monitorUi.createInferenceStats({});
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
    const engine = monitorUi.createInferenceStats({});
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
    const engine = monitorUi.createInferenceStats({});
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
        slotsOk: true, slotsNormalized: monitorUi.normalizeSlots({ nope: true }), now: 5000,
    });
    assert.equal(badSlots.sources.slots, "unavailable");
}

// Invalid numeric fields never invent values.
{
    const engine = monitorUi.createInferenceStats({});
    engine.setTarget("gui:3", { zeroBaseline: true });
    const snap = engine.applyPollResult({
        metricsOk: true,
        metricsValues: {
            "llamacpp:prompt_tokens_total": NaN,
            "llamacpp:tokens_predicted_total": -1,
            "llamacpp:requests_processing": "many",
        },
        slotsOk: true,
        slotsNormalized: monitorUi.normalizeSlots([
            { id: 0, is_processing: true, n_ctx: -5, n_prompt_tokens: 10 },
        ]),
        now: 1000,
    });
    assert.equal(snap.session.prompt, null);
    assert.equal(snap.session.total, null);
    assert.equal(snap.requests.processing, null);
    assert.equal(snap.context, null);
}

// Slot-derived speeds require a stable slot/task identity across samples.
{
    const engine = monitorUi.createInferenceStats({});
    engine.setTarget("gui:4", { zeroBaseline: true });
    engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, 100), now: 10000,
    });
    const sameTask = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 2000, 200), now: 12000,
    });
    assert.ok(Math.abs(sameTask.speed.prompt - 500) < 0.001, "same identity yields slot speed");
    assert.ok(Math.abs(sameTask.speed.generated - 50) < 0.001);
    const differentTask = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_seconds": 111,
            "llamacpp:predicted_tokens_seconds": 11,
        }),
        slotsOk: true, slotsNormalized: slotsSample(0, 3000, 300, 999), now: 14000,
    });
    assert.equal(differentTask.speed.prompt, 111, "task change falls back to the gauge");
    assert.equal(differentTask.speed.generated, 11);
}

// A long polling gap uses the metrics gauge for that cycle and reseeds the
// slot baseline for the next normal interval.
{
    const engine = monitorUi.createInferenceStats({});
    engine.setTarget("gui:gap", { zeroBaseline: true });
    engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, 100), now: 1000,
    });
    const afterGap = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_seconds": 123,
            "llamacpp:predicted_tokens_seconds": 13,
        }),
        slotsOk: true, slotsNormalized: slotsSample(0, 2000, 200), now: 33001,
    });
    assert.equal(afterGap.speed.prompt, 123);
    assert.equal(afterGap.speed.generated, 13);
    const recovered = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 3000, 300), now: 35001,
    });
    assert.ok(Math.abs(recovered.speed.prompt - 500) < 0.001);
    assert.ok(Math.abs(recovered.speed.generated - 50) < 0.001);
}

// Slot deltas require both identities, and a global slot rate is published
// only when every currently processing slot is comparable.
{
    const missingTask = monitorUi.normalizeSlots([{
        id: 0, is_processing: true, n_ctx: 1000,
        n_prompt_tokens_processed: 100, next_token: { n_decoded: 10 },
    }]);
    assert.equal(missingTask.samples.length, 0);

    const engine = monitorUi.createInferenceStats({});
    engine.setTarget("gui:slots", { zeroBaseline: true });
    engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, 100, 1), now: 1000,
    });
    const reused = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_seconds": 77,
            "llamacpp:predicted_tokens_seconds": 7,
        }),
        slotsOk: true,
        slotsNormalized: monitorUi.normalizeSlots([{
            id: 0, is_processing: true, n_ctx: 8192,
            n_prompt_tokens_processed: 200, next_token: { n_decoded: 20 },
        }]),
        now: 2000,
    });
    assert.equal(reused.speed.prompt, 77, "slot reuse without id_task uses the gauge");
    assert.equal(reused.speed.generated, 7);

    const twoSlots = (first, second) => monitorUi.normalizeSlots([
        { id: 0, id_task: 1, is_processing: true, n_ctx: 8192,
            n_prompt_tokens_processed: first, next_token: { n_decoded: first / 10 } },
        { id: 1, id_task: 2, is_processing: true, n_ctx: 8192,
            n_prompt_tokens_processed: second, next_token: { n_decoded: second / 10 } },
    ]);
    engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues(),
        slotsOk: true, slotsNormalized: slotsSample(0, 1000, 100, 1), now: 3000,
    });
    const continuingAndNew = engine.applyPollResult({
        metricsOk: true, metricsValues: metricValues({
            "llamacpp:prompt_tokens_seconds": 88,
            "llamacpp:predicted_tokens_seconds": 8,
        }),
        slotsOk: true, slotsNormalized: twoSlots(1100, 100), now: 4000,
    });
    assert.equal(continuingAndNew.speed.prompt, 88,
        "a new processing slot prevents a partial global rate");
    assert.equal(continuingAndNew.speed.generated, 8);
}

// 80%/95% context presentation levels.
{
    const engine = monitorUi.createInferenceStats({});
    engine.setTarget("gui:5", { zeroBaseline: true });
    const levelFor = (used) => engine.applyPollResult({
        metricsOk: false, metricsValues: null,
        slotsOk: true,
        slotsNormalized: monitorUi.normalizeSlots([
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
    const engine = monitorUi.createInferenceStats({ onSnapshot: (s) => seen.push(s) });
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

    const engine2 = monitorUi.createInferenceStats({});
    engine2.setTarget("gui:7", { zeroBaseline: true });
    assert.equal(engine2.resetBaseline(), false, "no sample yet: reset stays pending");
    const first = engine2.applyPollResult({
        metricsOk: true, metricsValues: metricValues(), slotsOk: false,
        slotsNormalized: null, now: 1000,
    });
    assert.equal(first.session.total, 0, "pending reset uses the next sample as baseline");

    // Reset with only one counter ever present must keep the other counter's
    // baseline pending until that field first appears.
    const engine3 = monitorUi.createInferenceStats({});
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
    const engine4 = monitorUi.createInferenceStats({});
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
    const engine = monitorUi.createInferenceStats({});
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
    // Slot-derived deltas must not leak across targets: with the old sample
    // cleared there is no previous slot to compare, so the gauge is used
    // instead of a bogus (5000 - 1000) / 1s spike.
    assert.equal(after.speed.prompt, 300, "rate samples must not cross targets");
    assert.equal(after.speed.generated, 30);
    engine.setTarget(null);
    assert.equal(engine.getSnapshot(), null);
    assert.equal(engine.applyPollResult({ metricsOk: true, metricsValues: {}, slotsOk: false, slotsNormalized: null, now: 3000 }), null);
}

// ═════════════════════════════════════════════════════════════════════════
// 4. System/GPU rendering
// ═════════════════════════════════════════════════════════════════════════

buildStandardDom();
{
    const copyCalls = [];
    monitorUi.configure({
        fetchJson: async () => makeSample(),
        copyText: (text) => copyCalls.push(text),
        showToast: () => {},
        invalidateCursor: () => {},
        resetStatsBaseline: () => {},
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
        pollIntervalMs: 25,
    });

    monitorUi.onTabChanged("monitor");
    monitorUi.renderInferenceSnapshot(null);

    // Wait for the first poll to land.
    await wait(80);

    const cpuValue = documentStub.getElementById("monitor-cpu-value");
    assert.equal(cpuValue.textContent, "18.4%");
    const memSub = documentStub.getElementById("monitor-memory-sub");
    assert.ok(memSub.textContent.includes("12.0 GB used of 32.0 GB"), memSub.textContent);
    const diskSub = documentStub.getElementById("monitor-disk-sub");
    assert.ok(diskSub.textContent.includes("Application disk"));
    const ioGrid = documentStub.getElementById("monitor-disk-io");
    assert.equal(ioGrid.classList.contains("hidden"), false, "disk I/O shown when supported");
    assert.equal(documentStub.getElementById("monitor-disk-read").textContent, "1.2 MB/s");
}

// The first CPU sample is a normal pending state, not collector failure.
{
    monitorUi.configure({
        fetchJson: async () => makeSample({
            system: { cpu: { available: true, percent: null } },
        }),
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "--");
    assert.equal(documentStub.getElementById("monitor-cpu-sub").textContent.includes("Waiting for first sample"), true);
}

// Partial metric availability: only the failed metric is unavailable.
{
    const fetches = [];
    monitorUi.configure({
        fetchJson: async () => {
            fetches.push(1);
            return makeSample({
                system: {
                    cpu: { available: false },
                    memory: { available: true, used_bytes: 1, total_bytes: 4, percent: 25 },
                    disk: { available: true, percent: 10, read_bytes_per_second: null, write_bytes_per_second: null },
                },
            });
        },
    });
    monitorUi.recheck();
    await wait(80);
    assert.equal(documentStub.getElementById("monitor-cpu-value").textContent, "Not available");
    assert.equal(documentStub.getElementById("monitor-memory-value").textContent, "25.0%");
    assert.equal(
        documentStub.getElementById("monitor-disk-io").classList.contains("hidden"),
        true,
        "disk I/O grid hidden when the collector cannot supply rates",
    );
}

// Multiple GPUs render stable provider-qualified cards; missing fields say
// "Not available", never zero; hostile names stay text.
{
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
    const grid = documentStub.getElementById("monitor-gpu-grid");
    assert.equal(grid.children.length, 2);
    const keys = grid.children.map(card => card.dataset.monitorKey);
    assert.deepEqual(keys, ["gpu:nvidia:uuid:GPU-AAAA", "gpu:nvidia:pci:0000:0b:00.0"]);
    const second = grid.children[1];
    assert.equal(second.querySelector(".card-title").textContent, hostileName);
    assert.ok(
        second.textContent.includes("Not available"),
        "unsupported fields render as Not available",
    );
    assert.ok(!second.textContent.includes("0%"), "no invented zeros");
    // No element was created from the hostile name.
    assert.equal(second.querySelectorAll("img").length, 0);
}

// Mixed providers: working GPU cards coexist with the failed provider's
// setup + state cards; without evidence there are no speculative cards.
{
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
    assert.equal(documentStub.getElementById("monitor-gpu-grid").children.length, 1);
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
}

// No provider hint: one generic state card, no vendor setup cards.
{
    monitorUi.configure({ fetchJson: async () => makeSample() });
    monitorUi.recheck();
    await wait(80);
    const stateCards = documentStub.getElementById("monitor-gpu-states").children;
    assert.deepEqual(stateCards.map(card => card.dataset.monitorKey), ["state:generic"]);
    assert.ok(stateCards[0].textContent.includes("No supported GPU telemetry detected"));
    assert.equal(
        documentStub.getElementById("monitor-gpu-setup").classList.contains("hidden"),
        true,
    );
}

// Unsupported platform state: no setup card, honest state card.
{
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
}

// ═════════════════════════════════════════════════════════════════════════
// 5. Inference card rendering
// ═════════════════════════════════════════════════════════════════════════

{
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
}

// ═════════════════════════════════════════════════════════════════════════
// 6. Terminal: auto-scroll, trim, cursor-preserving clear
// ═════════════════════════════════════════════════════════════════════════

{
    let invalidated = 0;
    monitorUi.configure({ invalidateCursor: () => { invalidated += 1; } });
    monitorUi.init();
    const terminal = documentStub.getElementById("output-terminal");
    const checkbox = documentStub.getElementById("monitor-auto-scroll");
    terminal.scrollHeight = 500;
    terminal.clientHeight = 100;

    monitorUi.setAutoScroll(true);
    monitorUi.appendOutputLine("line one");
    assert.equal(terminal.children.length, 1);
    assert.equal(terminal.children[0].textContent, "line one");
    assert.equal(terminal.scrollTop, terminal.scrollHeight, "auto-scroll follows output");

    // Scrolling up disables auto-scroll and keeps the user's position.
    terminal.scrollTop = 10;
    terminal.children[0].dispatch.call(terminal, "scroll");
    assert.equal(checkbox.checked, false, "scrolling up unchecks Auto-scroll");
    terminal.scrollHeight = 800;
    monitorUi.appendOutputLine("line two");
    assert.equal(terminal.scrollTop, 10, "position preserved while auto-scroll is off");

    // Re-enabling jumps back to the bottom.
    checkbox.checked = true;
    checkbox.dispatch("change");
    assert.equal(terminal.scrollTop, terminal.scrollHeight);

    // DOM stays bounded at 5,000 lines, trimming 1,000 at a time.
    for (let i = 0; i < 5001; i += 1) monitorUi.appendOutputLine(`bulk ${i}`);
    assert.ok(terminal.children.length <= 5000, `got ${terminal.children.length}`);
    assert.ok(terminal.children.length > 4000);
    assert.ok(!terminal.textContent.includes("bulk 0"), "oldest lines trimmed first");

    // Clear empties the DOM and invalidates (not resets) the cursor.
    monitorUi.clearTerminal();
    assert.equal(terminal.children.length, 0);
    assert.equal(invalidated, 1, "clear must advance the cursor epoch without discarding it");
}

// ═════════════════════════════════════════════════════════════════════════
// 7. Polling lifecycle
// ═════════════════════════════════════════════════════════════════════════

function deferred() {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return { promise, resolve: resolveFn, reject: rejectFn };
}

{
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
}

// ═════════════════════════════════════════════════════════════════════════
// 8. Hidden-card preferences
// ═════════════════════════════════════════════════════════════════════════

function normalized(value) {
    return JSON.parse(JSON.stringify(monitorUi.normalizeHiddenEntries(value)));
}

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
assert.equal(monitorUi.isSessionOnlyKey("system:cpu"), false);

{
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

    const cards = () => documentStub.getElementById("monitor-gpu-grid").children;
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
}

// Persistent hidden-card writes retain the most recent 100 entries and do not
// count session-only index identities toward that cap.
{
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
    const cards = () => documentStub.getElementById("monitor-gpu-grid").children;
    for (const card of Array.from(cards())) card.querySelector(".monitor-hide-btn").dispatch("click");
    const persisted = JSON.parse(storage.map.get("llama_gui_monitor_hidden_cards"));
    assert.equal(persisted.length, 100);
    assert.equal(persisted.some(entry => entry.key.includes("nvidia:index:session")), false);
    assert.equal(persisted.some(entry => entry.key.includes("CAP-0")), false);
    assert.equal(persisted.some(entry => entry.key.includes("CAP-104")), true);
}

// Malformed persisted storage is normalized on load.
{
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
}

// ═════════════════════════════════════════════════════════════════════════
// 9. Process header + inference wiring
// ═════════════════════════════════════════════════════════════════════════

{
    resetDom();
    buildStandardDom();
    context.localStorage = makeStorage();
    let lifecycle = { activeRuntime: { tool: "llama-server", generation: 4 }, phase: "ready", busy: false };
    let status = null;
    let resets = 0;
    monitorUi.configure({
        fetchJson: async () => makeSample(),
        getLifecycleSnapshot: () => lifecycle,
        getLatestStatus: () => status,
        resetStatsBaseline: () => { resets += 1; },
    });
    monitorUi.init();
    monitorUi.onTabChanged("monitor");
    await wait(80);

    assert.equal(documentStub.getElementById("monitor-process-tool").textContent, "llama-server");
    assert.equal(documentStub.getElementById("monitor-process-state").textContent, "Running");
    assert.equal(documentStub.getElementById("monitor-no-process-note").classList.contains("hidden"), true);

    // External server, no GUI process: stdout note replaces the terminal.
    lifecycle = { activeRuntime: null, phase: "idle", busy: false };
    status = { external_chat_target: { connected: true, host: "10.0.0.5", port: 8080 } };
    monitorUi.updateProcessHeader();
    assert.equal(documentStub.getElementById("monitor-process-tool").textContent, "external server");
    assert.equal(documentStub.getElementById("monitor-external-note").classList.contains("hidden"), false);
    assert.equal(documentStub.getElementById("output-terminal").classList.contains("hidden"), true);

    // Reset button delegates to the shared baseline.
    documentStub.getElementById("btn-reset-inference").dispatch("click");
    assert.equal(resets, 1);
    monitorUi.onTabChanged("configure");
}

console.log("monitor ui unit tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
