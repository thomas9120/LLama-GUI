const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "manager.js"), "utf8");

function makeElement() {
    let html = "";
    const classNames = new Set();
    const el = {
        children: [],
        value: "",
        textContent: "",
        className: "",
        style: {},
        disabled: false,
        classList: {
            add(...names) {
                names.forEach((name) => classNames.add(name));
                el.className = Array.from(classNames).join(" ");
            },
            remove(...names) {
                names.forEach((name) => classNames.delete(name));
                el.className = Array.from(classNames).join(" ");
            },
            toggle(name, force) {
                const shouldAdd = force === undefined ? !classNames.has(name) : Boolean(force);
                if (shouldAdd) {
                    classNames.add(name);
                } else {
                    classNames.delete(name);
                }
                el.className = Array.from(classNames).join(" ");
                return shouldAdd;
            },
            contains(name) {
                return classNames.has(name);
            },
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll() {
            return [];
        },
    };
    Object.defineProperty(el, "options", {
        get() {
            return this.children;
        },
        configurable: true,
    });
    Object.defineProperty(el, "innerHTML", {
        get() {
            return html;
        },
        set(value) {
            html = String(value || "");
            this.children = [];
            this.value = "";
        },
        configurable: true,
    });
    return el;
}

const elements = new Map();
[
    "release-select",
    "backend-select",
    "installed-backend-summary",
    "version-badge",
    "sidebar-status",
    "sidebar-status-text",
    "installed-info",
    "btn-repair",
    "btn-install",
    "btn-update",
    "release-group",
    "custom-backend-info",
    "app-update-status",
    "btn-update-app",
].forEach((id) => elements.set(id, makeElement()));

const fetchCalls = [];
const fetchPayload = [{ tag: "b1294", published: "2024-01-01T00:00:00Z", assets: [] }];

const context = {
    window: { addEventListener() {}, LlamaGui: {} },
    document: {
        createElement: () => makeElement(),
        createTextNode: (text) => ({ textContent: String(text || "") }),
        getElementById: (id) => elements.get(id) || null,
    },
    console,
    fetch: async (url, options) => {
        fetchCalls.push({ url, options });
        return { ok: true, json: async () => fetchPayload };
    },
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/manager.js" });

(async () => {
    const backendSelect = elements.get("backend-select");
    backendSelect.value = "lemonade-rocm-gfx110X";

    assert.equal(
        context.selectedBackendId(),
        "lemonade-rocm-gfx110X",
        "selectedBackendId should read backend-select value"
    );

    await context.fetchReleases("lemonade-rocm-gfx110X");
    assert.equal(
        fetchCalls[fetchCalls.length - 1].url,
        "/api/releases?backend=lemonade-rocm-gfx110X",
        "fetchReleases(backend) should hit backend-aware releases URL"
    );
    assert.equal(
        fetchCalls[fetchCalls.length - 1].options.cache,
        "no-store",
        "fetchJson should bypass browser cache for API requests"
    );

    await context.fetchReleases();
    assert.equal(
        fetchCalls[fetchCalls.length - 1].url,
        "/api/releases",
        "fetchReleases() without backend should hit default releases URL"
    );

    backendSelect.value = "cpu";
    await context.onBackendChange();
    assert.equal(
        fetchCalls[fetchCalls.length - 1].url,
        "/api/releases?backend=cpu",
        "onBackendChange should refetch releases for the selected backend"
    );

    const availableBackends = [
        { id: "cpu", label: "CPU" },
        { id: "vulkan", label: "Vulkan" },
        { id: "custom", label: "Custom (User-Provided)" },
    ];
    const cpuStatus = {
        installed: true,
        config_stale: false,
        version: "smoke",
        backend: "cpu",
        tag: "smoke",
        running: false,
        available_backends: availableBackends,
        executables: {
            "llama-cli": true,
            "llama-server": true,
        },
    };
    context.updateStatusUI(cpuStatus);
    assert.equal(elements.get("btn-update").disabled, false);

    backendSelect.value = "custom";
    context.onBackendChange();
    context.updateStatusUI(cpuStatus);
    assert.equal(backendSelect.value, "custom");
    assert.equal(elements.get("btn-update").disabled, true);
    assert.equal(elements.get("btn-repair").disabled, true);
    assert.equal(
        elements.get("btn-repair").classList.contains("hidden"),
        false,
        "repair button should be visible but disabled when custom is selected as install target"
    );

    backendSelect.value = "cpu";
    context.onBackendChange();
    context.updateStatusUI(cpuStatus);
    assert.equal(elements.get("btn-update").disabled, false);
    assert.equal(elements.get("btn-repair").classList.contains("hidden"), true);

    const customStatus = {
        installed: true,
        config_stale: false,
        version: "custom",
        backend: "custom",
        tag: "custom",
        running: false,
        available_backends: availableBackends,
        executables: {
            "llama-cli": true,
            "llama-server": true,
        },
    };
    context.updateStatusUI(customStatus);
    assert.equal(backendSelect.value, "custom");
    assert.match(
        elements.get("installed-backend-summary").textContent,
        /Installed backend: Custom/,
        "installed backend summary should render as read-only status"
    );

    backendSelect.value = "vulkan";
    context.onBackendChange();
    context.updateStatusUI(customStatus);
    assert.equal(
        backendSelect.value,
        "vulkan",
        "pending install backend should survive status refresh while installed backend is still custom"
    );
    assert.equal(elements.get("btn-install").textContent, "Install");
    assert.equal(
        elements.get("btn-update").disabled,
        true,
        "custom installed backend should not become auto-updatable because a default backend is selected as install target"
    );

    context.updateStatusUI({ ...customStatus, version: "smoke", backend: "vulkan", tag: "smoke" });
    assert.equal(
        backendSelect.value,
        "vulkan",
        "install target should remain on the newly installed backend once status catches up"
    );
    assert.equal(elements.get("btn-update").disabled, false);

    const pending = new Map();
    context.fetch = async (url, options) => {
        fetchCalls.push({ url, options });
        return new Promise((resolve) => {
            pending.set(url, (payload) => resolve({ ok: true, json: async () => payload }));
        });
    };

    const first = context.fetchReleases("cpu");
    const second = context.fetchReleases("lemonade-rocm-gfx110X");
    pending.get("/api/releases?backend=lemonade-rocm-gfx110X")([
        { tag: "b1294", published: "2024-01-01T00:00:00Z", assets: [] },
    ]);
    await second;
    const releaseSelect = elements.get("release-select");
    assert.equal(releaseSelect.options.length, 1);
    assert.equal(releaseSelect.options[0].value, "b1294");

    pending.get("/api/releases?backend=cpu")([
        { tag: "b9999", published: "2024-01-02T00:00:00Z", assets: [] },
    ]);
    await first;
    assert.equal(
        releaseSelect.options[0].value,
        "b1294",
        "stale release responses should not overwrite the latest backend releases"
    );

    let statusFetchCount = 0;
    let releaseFirstObserver;
    const firstObserverGate = new Promise(resolve => { releaseFirstObserver = resolve; });
    const observedGenerations = [];
    context.fetch = async (url) => {
        if (url.startsWith("/api/releases")) {
            return { ok: true, json: async () => [] };
        }
        assert.equal(url, "/api/status");
        statusFetchCount += 1;
        const generation = statusFetchCount;
        return {
            ok: true,
            json: async () => ({
                installed: true,
                running: true,
                active_process_tool: "llama-server",
                active_runtime: { generation, tool: "llama-server" },
                runtime_generation: generation,
                available_backends: [],
                executables: {},
            }),
        };
    };
    context.window.LlamaGui.manager.setAcceptedStatusObserver(async status => {
        observedGenerations.push(status.runtime_generation);
        if (status.runtime_generation === 1) await firstObserverGate;
    });
    const firstStatusCheck = context.checkStatus();
    while (observedGenerations.length === 0) await Promise.resolve();
    const secondStatus = await context.checkStatus();
    assert.equal(secondStatus.runtime_generation, 2);
    releaseFirstObserver();
    const firstStatus = await firstStatusCheck;
    assert.equal(firstStatus.runtime_generation, 2, "an older accepted request must return the latest status");
    assert.deepEqual(
        observedGenerations,
        [1, 2, 2],
        "the latest status must be re-observed after an older long-running observer settles"
    );

    // appReload is a one-shot cache buster; it must not survive into the address bar
    const replaceCalls = [];
    context.window.history = {
        replaceState: (state, title, url) => replaceCalls.push(url),
    };
    context.URL = URL;

    const runClear = (href) => {
        replaceCalls.length = 0;
        context.window.location = { href };
        return {
            cleared: vm.runInContext("clearAppReloadParam()", context),
            replaced: replaceCalls.slice(),
        };
    };

    let result = runClear("http://127.0.0.1:5240/?appReload=1784942368226");
    assert.equal(result.cleared, true);
    assert.deepEqual(result.replaced, ["/"], "a lone appReload param must leave a clean root URL");

    result = runClear("http://127.0.0.1:5240/?preset=My%20Preset&appReload=123");
    assert.equal(result.cleared, true);
    assert.deepEqual(
        result.replaced,
        ["/?preset=My+Preset"],
        "clearing appReload must preserve other query parameters"
    );

    result = runClear("http://127.0.0.1:5240/?appReload=123#chat");
    assert.deepEqual(result.replaced, ["/#chat"], "the hash must survive the cleanup");

    result = runClear("http://127.0.0.1:5240/?preset=Test");
    assert.equal(result.cleared, false, "a URL without appReload must not be rewritten");
    assert.deepEqual(result.replaced, [], "no history entry should be replaced when nothing changes");

    context.fetch = async (url) => {
        assert.equal(url, "/api/app-update-status");
        throw new Error("network down");
    };
    await assert.doesNotReject(
        () => context.window.LlamaGui.manager.updateAppFromGitHub(),
        "an app-update preflight failure must be handled by the update UI"
    );
    assert.equal(elements.get("app-update-status").className, "status-box error");
    assert.equal(
        elements.get("app-update-status").textContent,
        "Failed to check app updates: network down"
    );

    console.log("manager releases unit tests passed");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
