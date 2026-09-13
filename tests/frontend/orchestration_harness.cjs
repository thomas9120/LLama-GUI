"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getScriptPaths } = require("./script_order.cjs");

async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function createHarness(files, overrides = {}) {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    function addTimer(fn, delay, interval = false) {
        const id = ++nextId;
        timers.set(id, { fn, at: now + delay, delay, interval });
        return id;
    }
    const context = {
        window: {}, console, URLSearchParams, AbortController,
        __LLAMA_GUI_TEST_HOOKS__: true,
        setTimeout: (fn, delay) => addTimer(fn, delay),
        setInterval: (fn, delay) => addTimer(fn, delay, true),
        clearTimeout: id => timers.delete(id),
        clearInterval: id => timers.delete(id),
        Date: class extends Date { static now() { return now; } },
        ...overrides,
    };
    context.window = context;
    vm.createContext(context);
    const selected = getScriptPaths().filter(file => files.includes(file));
    if (selected.length !== files.length) throw new Error("Missing canonical orchestration script");
    for (const file of selected) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, "../../ui", file), "utf8"),
            context, { filename: file });
    }
    async function tick(ms) {
        const end = now + ms;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.interval) timer.at += timer.delay;
            else timers.delete(id);
            timer.fn();
            await flush();
        }
        now = end;
        await flush();
    }
    return { context, api: context.LlamaGui, timers, tick };
}

module.exports = { createHarness, deferred, flush };
