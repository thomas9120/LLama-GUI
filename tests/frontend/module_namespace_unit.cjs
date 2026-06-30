const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");

const scriptFiles = Array.from(INDEX_HTML.matchAll(/<script\s+src="\/([^"?]+)(?:\?[^"]*)?"><\/script>/g))
    .map((match) => match[1])
    .filter((src) => src.startsWith("js/"));

assert.ok(scriptFiles.length > 0, "expected to find frontend scripts in ui/index.html");

const logs = [];
const context = {
    window: {},
    console: {
        info: (...args) => logs.push(["info", args]),
        warn: (...args) => logs.push(["warn", args]),
        error: (...args) => logs.push(["error", args]),
        groupCollapsed: (...args) => logs.push(["groupCollapsed", args]),
        groupEnd: () => logs.push(["groupEnd", []]),
        debug: (...args) => logs.push(["debug", args]),
        log: (...args) => logs.push(["log", args]),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    Blob,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            appendChild: () => {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            setAttribute: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            style: {},
        }),
    },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    },
};

context.window = context;
vm.createContext(context);

for (const scriptFile of scriptFiles) {
    const fullPath = path.join(ROOT, "ui", scriptFile);
    const source = fs.readFileSync(fullPath, "utf8");
    vm.runInContext(source, context, { filename: scriptFile });
}

const expectedNamespaces = [
    "flagCore",
    "configFlagsUi",
    "quickLaunchUi",
    "chatUi",
    "chatRendering",
    "apiTab",
    "hfDownloadUi",
    "remoteTunnelUi",
    "samplerPresets",
];

for (const namespace of expectedNamespaces) {
    assert.ok(
        context.window.LlamaGui && context.window.LlamaGui[namespace],
        `expected window.LlamaGui.${namespace} to be defined`
    );
}

assert.equal(typeof context.window.LlamaGui.flagCore.setFlagValue, "function");
assert.equal(typeof context.window.LlamaGui.quickLaunchUi.refresh, "function");
assert.equal(typeof context.window.LlamaGui.chatUi.init, "function");
assert.equal(typeof context.window.LlamaGui.apiTab.updateEndpoints, "function");
assert.equal(typeof context.window.LlamaGui.remoteTunnelUi.renderStatus, "function");

console.log(`module namespace check passed for ${scriptFiles.length} scripts`);
