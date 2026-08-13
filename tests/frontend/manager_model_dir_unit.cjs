const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "manager.js"), "utf8");

function makeElement() {
    let html = "";
    const listeners = {};
    const classes = new Set();
    const el = {
        children: [],
        value: "",
        textContent: "",
        className: "",
        style: {},
        disabled: false,
        hidden: false,
        listeners,
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            contains: (name) => classes.has(name),
            toggle(name, force) {
                const enabled = force === undefined ? !classes.has(name) : Boolean(force);
                if (enabled) classes.add(name); else classes.delete(name);
                return enabled;
            },
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener(type, handler) {
            listeners[type] = handler;
        },
        querySelectorAll() {
            return [];
        },
    };
    Object.defineProperty(el, "options", { get: () => el.children });
    Object.defineProperty(el, "innerHTML", {
        get: () => html,
        set(value) {
            html = String(value || "");
            el.children = [];
            el.value = "";
        },
    });
    return el;
}

const elements = new Map();
[
    "release-select", "backend-select", "installed-backend-summary", "version-badge",
    "sidebar-status", "sidebar-status-text", "installed-info", "btn-repair",
    "btn-install", "btn-update", "release-group", "custom-backend-info",
    "install-status", "model-select", "models-folder-path", "models-folder-error",
    "btn-change-models-folder", "btn-reset-models-folder",
].forEach((id) => elements.set(id, makeElement()));

const coreCalls = [];
const flagCore = {
    setModelDirInfo: (info) => coreCalls.push(["setModelDirInfo", info]),
    setSelectedModelValue: (value) => coreCalls.push(["setSelectedModelValue", value]),
    updateCommandPreview: () => coreCalls.push(["updateCommandPreview"]),
};
const fetchCalls = [];
let fetchHandler = async () => ({ ok: true, json: async () => ({}) });
const context = {
    window: {
        addEventListener() {},
        LlamaGui: {
            flagCore,
            presets: { refreshModelPresence: () => coreCalls.push(["refreshModelPresence"]) },
        },
    },
    document: {
        createElement: () => makeElement(),
        createTextNode: (text) => ({ textContent: String(text || "") }),
        getElementById: (id) => elements.get(id) || null,
    },
    console: { ...console, debug: () => {} },
    fetch: async (url, options) => {
        fetchCalls.push({ url, options });
        return fetchHandler(url, options);
    },
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/manager.js" });
vm.runInContext('releasesBackend = "cpu"', context);

const customInfo = {
    models_dir: "D:\\Smoke & Models",
    models_arg_root: "D:\\Smoke & Models",
    models_dir_is_default: false,
    models_dir_available: true,
    models_dir_error: "",
};

(async () => {
    context.window.LlamaGui.manager.initModelDirControls();
    assert.equal(elements.get("models-folder-path").textContent, "Loading...");
    assert.equal(typeof elements.get("btn-change-models-folder").listeners.click, "function");
    assert.equal(typeof elements.get("btn-reset-models-folder").listeners.click, "function");

    fetchHandler = async (url) => ({
        ok: true,
        json: async () => url === "/api/select-folder"
            ? { selected: false, path: "" }
            : (() => { throw new Error(`unexpected request: ${url}`); })(),
    });
    assert.equal(await context.window.LlamaGui.manager.chooseModelsDir(), false);
    assert.deepEqual(fetchCalls.map((call) => call.url), ["/api/select-folder"]);

    fetchCalls.length = 0;
    coreCalls.length = 0;
    elements.get("model-select").value = "old.gguf";
    const status = {
        installed: true,
        config_stale: false,
        version: "smoke",
        tag: "smoke",
        backend: "cpu",
        running: false,
        available_backends: [{ id: "cpu", label: "CPU" }],
        executables: { "llama-cli": true, "llama-server": true },
        ...customInfo,
    };
    fetchHandler = async (url, options) => {
        if (url === "/api/models-dir") {
            assert.equal(JSON.parse(options.body).path, customInfo.models_dir);
            return { ok: true, json: async () => customInfo };
        }
        if (url === "/api/status") return { ok: true, json: async () => status };
        if (url === "/api/models") {
            return { ok: true, json: async () => [{ name: "new.gguf", size_mb: 1 }] };
        }
        throw new Error(`unexpected request: ${url}`);
    };

    assert.equal(
        await context.window.LlamaGui.manager.persistModelsDir(customInfo.models_dir),
        true
    );
    assert.deepEqual(fetchCalls.map((call) => call.url), [
        "/api/models-dir", "/api/status", "/api/models",
    ]);
    assert.equal(elements.get("models-folder-path").textContent, customInfo.models_dir);
    assert.equal(elements.get("models-folder-path").innerHTML, "");
    assert.equal(elements.get("btn-reset-models-folder").hidden, false);
    assert.equal(elements.get("model-select").value, "", "a missing old selection must be cleared");
    assert.ok(coreCalls.some((call) => call[0] === "setSelectedModelValue" && call[1] === ""));
    assert.ok(coreCalls.some((call) => call[0] === "refreshModelPresence"));
    assert.ok(coreCalls.some((call) => call[0] === "updateCommandPreview"));

    fetchCalls.length = 0;
    coreCalls.length = 0;
    fetchHandler = async (url) => {
        if (url === "/api/models-dir") {
            return { ok: false, status: 400, json: async () => ({ error: "Save rejected." }) };
        }
        if (url === "/api/status") return { ok: true, json: async () => status };
        throw new Error(`unexpected request: ${url}`);
    };
    assert.equal(await context.window.LlamaGui.manager.persistModelsDir("X:\\bad"), false);
    assert.ok(coreCalls.some((call) => call[0] === "setModelDirInfo" && call[1] === null));
    assert.equal(elements.get("models-folder-error").textContent, "Save rejected.");
    await context.window.LlamaGui.manager.checkStatus();
    assert.equal(
        elements.get("models-folder-error").textContent,
        "Save rejected.",
        "ordinary status polls must not erase an operation error"
    );

    const savedInfo = {
        ...customInfo,
        models_dir: "E:\\Saved Models",
        models_arg_root: "E:\\Saved Models",
    };
    const savedStatus = { ...status, ...savedInfo };
    fetchCalls.length = 0;
    coreCalls.length = 0;
    fetchHandler = async (url) => {
        if (url === "/api/models-dir") return { ok: true, json: async () => savedInfo };
        if (url === "/api/status") return { ok: true, json: async () => savedStatus };
        if (url === "/api/models") {
            return { ok: false, status: 409, json: async () => ({ error: "Folder is offline." }) };
        }
        throw new Error(`unexpected request: ${url}`);
    };
    assert.equal(await context.window.LlamaGui.manager.persistModelsDir(savedInfo.models_dir), false);
    assert.equal(
        coreCalls.some((call) => call[0] === "setModelDirInfo" && call[1] === null),
        false,
        "a saved root must survive a later model-refresh failure"
    );
    assert.ok(coreCalls.some(
        (call) => call[0] === "setModelDirInfo" && call[1]?.models_dir === savedInfo.models_dir
    ));

    const raceInfo = {
        ...customInfo,
        models_dir: "F:\\Race Models",
        models_arg_root: "F:\\Race Models",
    };
    const raceStatus = { ...status, ...raceInfo };
    let firstStatusResolve;
    let secondStatusResolve;
    let statusCallCount = 0;
    fetchCalls.length = 0;
    coreCalls.length = 0;
    fetchHandler = async (url) => {
        if (url === "/api/select-folder") {
            return { ok: true, json: async () => ({ selected: true, path: raceInfo.models_dir }) };
        }
        if (url === "/api/models-dir") return { ok: true, json: async () => raceInfo };
        if (url === "/api/status") {
            statusCallCount += 1;
            return new Promise((resolve) => {
                if (statusCallCount === 1) firstStatusResolve = resolve;
                else secondStatusResolve = resolve;
            });
        }
        if (url === "/api/models") {
            return { ok: true, json: async () => [{ name: "race.gguf", size_mb: 1 }] };
        }
        throw new Error(`unexpected request: ${url}`);
    };
    const racedPersist = context.window.LlamaGui.manager.chooseModelsDir();
    while (!firstStatusResolve) await Promise.resolve();
    const competingStatus = context.window.LlamaGui.manager.checkStatus();
    while (!secondStatusResolve) await Promise.resolve();
    firstStatusResolve({ ok: true, json: async () => raceStatus });
    assert.equal(
        await racedPersist,
        true,
        "a stale status response must not turn a successful save into a failure"
    );
    assert.equal(elements.get("models-folder-path").textContent, raceInfo.models_dir);
    secondStatusResolve({ ok: true, json: async () => raceStatus });
    await competingStatus;
    assert.equal(
        coreCalls.some((call) => call[0] === "setModelDirInfo" && call[1] === null),
        false
    );
    assert.equal(elements.get("models-folder-error").textContent, "");

    fetchCalls.length = 0;
    fetchHandler = async (url) => {
        if (url === "/api/status") return { ok: true, json: async () => raceStatus };
        throw new Error(`unexpected request: ${url}`);
    };
    assert.equal(await context.waitForServerReady(1, 0), true);
    assert.deepEqual(fetchCalls.map((call) => call.url), ["/api/status"]);

    const unavailable = {
        ...customInfo,
        models_dir: "<offline-models>",
        models_arg_root: "",
        models_dir_available: false,
        models_dir_error: "Models folder is offline.",
    };
    context.applyModelDirInfo(unavailable);
    assert.equal(elements.get("models-folder-path").textContent, "<offline-models>");
    assert.equal(elements.get("models-folder-path").innerHTML, "");
    assert.equal(elements.get("models-folder-error").textContent, "Models folder is offline.");
    assert.equal(elements.get("btn-reset-models-folder").hidden, false);

    console.log("manager model directory unit tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
