"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const { getScriptPaths } = require("./script_order.cjs");

function createMonitorHarness() {
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

    function matchesOne(el, selector) {
        if (!el || !el.dataset) return false;
        if (/\s/.test(String(selector))) {
            throw new Error(`Test DOM does not support descendant selectors: ${selector}`);
        }
        // Minimal compound-selector matcher: a tag, any number of `.class` parts
        // and `[attr]` / `[attr="value"]` parts, in any order — e.g.
        // `.monitor-metric-row[data-metric="utilization"]`. Silently failing to
        // match a compound selector is how bugs reach the real DOM untested.
        const parts = String(selector).match(/^[a-zA-Z][\w-]*|\.[\w-]+|\[[^\]]+\]/g);
        if (!parts) return false;
        for (const part of parts) {
            if (part.startsWith(".")) {
                if (!el._classes.has(part.slice(1))) return false;
            } else if (part.startsWith("[")) {
                const body = part.slice(1, -1);
                const eq = body.indexOf("=");
                const rawName = (eq === -1 ? body : body.slice(0, eq)).trim();
                const key = rawName.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
                if (eq === -1) {
                    if (el.dataset[key] === undefined) return false;
                } else {
                    const value = body.slice(eq + 1).trim().replace(/^"|"$/g, "");
                    if (el.dataset[key] !== value) return false;
                }
            } else if (el.tagName !== part.toUpperCase()) {
                return false;
            }
        }
        return true;
    }

    // Real-DOM semantics: a selector list matches when any member matches. Without
    // this, `closest(".a, .b")` silently matches nothing — which is exactly how a
    // multi-part drag guard shipped untested and ineffective.
    function matches(el, selector) {
        const parts = String(selector).split(",").map(part => part.trim()).filter(Boolean);
        return parts.some(part => matchesOne(el, part));
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
            draggable: false,
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
            dispatch(type, event) {
                // Real-DOM semantics: listeners fire with a target; callers may
                // supply extra event fields (dataTransfer, clientY, ...).
                const detail = Object.assign(
                    { target: this, preventDefault: () => {}, stopPropagation: () => {} },
                    event,
                );
                for (const handler of this._listeners[type] || []) handler(detail);
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
            removeAttribute(name) {
                delete this._attributes[name];
            },
            appendChild(child) {
                // Real-DOM semantics: re-appending an attached node moves it.
                if (child.parentNode) {
                    child.parentNode.children = child.parentNode.children.filter(c => c !== child);
                }
                child.parentNode = this;
                this.children.push(child);
                return child;
            },
            replaceChildren(...kids) {
                // Real-DOM semantics: this removes every child node — including
                // text nodes — so any direct text goes away with them.
                for (const child of this.children) child.parentNode = null;
                this.children = [];
                this._textContent = "";
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
            getBoundingClientRect() {
                // No real layout in the vm; tests set `_rect` per element.
                return this._rect || {
                    top: 0, height: 100, bottom: 100, left: 0, right: 0, width: 0,
                };
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
    for (const src of getScriptPaths().filter(src => src === "js/inference-stats.js" || src.startsWith("js/monitor/"))) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, "ui", src), "utf8"), context, { filename: `ui/${src}` });
    }

    const monitorUi = context.window.LlamaGui.monitorUi;
    assert.ok(monitorUi, "window.LlamaGui.monitorUi must exist");

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

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
        for (const id of ["monitor-runtime-state", "monitor-runtime-model", "monitor-runtime-build", "monitor-runtime-endpoint", "monitor-runtime-note", "monitor-runtime-error", "monitor-output-title", "monitor-inference-note", "monitor-gpu-summary"]) mount(id);
        for (const id of ["btn-monitor-configure", "btn-monitor-review", "btn-monitor-quick-launch", "btn-monitor-api"]) mount(id, "button");
        const terminal = mount("output-terminal");
        terminal.scrollHeight = 100;
        terminal.clientHeight = 50;
        mount("btn-clear-output", "button");
        mount("input-row");
        mount("monitor-process-tool", "span");
        mount("monitor-process-state", "span");
        mount("monitor-nav-live", "span");
        mount("monitor-no-process-note", "p");
        mount("monitor-external-note");
        mount("monitor-hidden-controls", "details").appendChild(createElement("summary"));
        mount("monitor-hidden-count", "span");
        mount("monitor-restore-items");
        mount("btn-monitor-show-all", "button");
        for (const prefix of ["cpu", "memory"]) {
            mount(`monitor-${prefix}-value`);
            mount(`monitor-${prefix}-bar`);
            mount(`monitor-${prefix}-sub`);
        }
        mount("monitor-disk-io");
        mount("monitor-disk-activity");
        mount("monitor-disk-sub");
        mount("monitor-disk-read", "span");
        mount("monitor-disk-write", "span");
        mount("monitor-card-grid")._classes.add("monitor-drag-container");
        mount("monitor-gpu-states")._classes.add("monitor-drag-container");
        mount("monitor-gpu-setup").classList.add("hidden");
        mount("monitor-setup-cards")._classes.add("monitor-drag-container");
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
                    io_available: true,
                    io_label: "All physical disks",
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
    function deferred() {
        let resolveFn;
        let rejectFn;
        const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });
        return { promise, resolve: resolveFn, reject: rejectFn };
    }
    function normalized(value) {
        return JSON.parse(JSON.stringify(monitorUi.normalizeHiddenEntries(value)));
    }


    monitorUi.configure({
        fetchJson: async () => makeSample(),
        copyText: async () => true,
        showToast: () => {},
        invalidateCursor: () => {},
        resetStatsBaseline: () => {},
        getLifecycleSnapshot: () => ({ activeRuntime: null, phase: "idle", busy: false }),
        getLatestStatus: () => null,
        pollIntervalMs: 25,
    });
    buildStandardDom();
    return { monitorUi, context, documentStub, warnings, createElement, mount,
        resetDom, buildStandardDom, makeSample, makeGpu, makeStorage, wait,
        metricValues, slotsSample, deferred, normalized,
        dispose: () => monitorUi._resetForTests() };
}
module.exports = { createMonitorHarness };
