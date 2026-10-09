const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const { getScriptPaths } = require("./script_order.cjs");

// ---------------------------------------------------------------------------
// Shared DOM stub (extends the manager_releases_unit harness with System IDs
// and innerHTML tracking for the safe-path-rendering check).
// ---------------------------------------------------------------------------

function makeElement(track) {
    let html = "";
    const classNames = new Set();
    const listeners = {};
    const el = {
        children: [],
        value: "",
        textContent: "",
        className: "",
        style: {},
        disabled: false,
        checked: false,
        open: false,
        title: "",
        dataset: {},
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
                if (shouldAdd) classNames.add(name);
                else classNames.delete(name);
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
        append(...nodes) {
            for (const node of nodes) this.children.push(node);
            return this;
        },
        replaceChildren(...nodes) {
            this.children = nodes;
            return this;
        },
        listeners,
        addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
        removeEventListener() {},
        setAttribute(name, value) { el.dataset[String(name)] = String(value); },
        getAttribute(name) { return el.dataset[String(name)] ?? null; },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        cloneNode() { const c = makeElement(track); c.value = el.value; c.textContent = el.textContent; return c; },
        setCustomValidity() {},
        focus() {},
    };
    Object.defineProperty(el, "options", {
        get() { return this.children; },
        configurable: true,
    });
    Object.defineProperty(el, "innerHTML", {
        get() { return html; },
        set(value) {
            html = String(value || "");
            if (typeof track === "function") track(html);
            else if (track && typeof track.push === "function") track.push(html);
            this.children = [];
            this.value = "";
        },
        configurable: true,
    });
    return el;
}

const SYSTEM_PATH_GUIDANCE = "llama-server was not found on the PATH inherited by Llama GUI. Start the GUI from the environment where it is available, or restart the GUI after changing its launch environment.";

function systemStatus(overrides = {}) {
    return {
        installed: true,
        config_stale: false,
        version: "system",
        backend: "system",
        tag: "system",
        running: false,
        platform: "linux",
        platform_label: "Linux",
        arch: "x64",
        executable_suffix: "",
        available_backends: [
            { id: "cpu", label: "CPU" },
            { id: "system", label: "System (PATH)", system_path: true },
        ],
        executables: {
            "llama-server": true,
            "llama-cli": false,
            "llama-bench": false,
        },
        official_install: { backend: "cpu", tag: "b123", version: "b123", files_present: true },
        runtime_health: {
            ok: true,
            checked: true,
            build_tags: { "llama-server": "b1234" },
            system_probes: {
                "llama-server": { ok: true, build_tag: "b1234", error: null, executable: "/usr/bin/llama-server" },
            },
        },
        system_tools: {
            "llama-server": { path: "/usr/bin/llama-server", available: true, build_tag: "b1234", probe_ok: true, probe_error: null },
            "llama-cli": { path: null, available: false, build_tag: null, probe_ok: null, probe_error: null },
            "llama-bench": { path: null, available: false, build_tag: null, probe_ok: null, probe_error: null },
        },
        system_server_error: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 1. Manager: System selection, activation, update/repair, pending, rendering.
// ---------------------------------------------------------------------------

async function testManager() {
    const innerHtmlWrites = [];
    const track = (html) => innerHtmlWrites.push(html);
    const elements = new Map();
    [
        "release-select", "refresh-releases", "backend-discovery-status", "backend-select",
        "installed-backend-summary", "version-badge", "installed-info", "btn-repair",
        "btn-install", "btn-update", "release-group", "custom-backend-info",
        "custom-backend-folder", "custom-backend-title", "system-backend-info",
        "system-backend-tools", "system-backend-title", "install-status",
        "download-progress", "progress-fill", "progress-text",
    ].forEach((id) => elements.set(id, makeElement(track)));

    const fetchCalls = [];
    let latestStatus = systemStatus({ installed: false, config_stale: false, version: null, backend: null });
    // Preview before activation: PATH discovery visible, server present.
    latestStatus.system_tools["llama-server"] = { path: "/usr/bin/llama-server", available: true, build_tag: "b1234", probe_ok: true, probe_error: null };

    const context = {
        window: { addEventListener() {}, LlamaGui: {} },
        document: {
            createElement: () => makeElement(track),
            createTextNode: (text) => ({ textContent: String(text || "") }),
            getElementById: (id) => elements.get(id) || null,
        },
        console,
        fetch: async (url, options) => {
            fetchCalls.push({ url, options });
            if (url === "/api/status") return { ok: true, json: async () => latestStatus };
            if (url === "/api/activate-system") {
                return { ok: true, json: async () => ({ ok: true, found: ["llama-server"], missing: ["llama-cli"], server_path: "/usr/bin/llama-server", paths: { "llama-server": "/usr/bin/llama-server" }, build_tags: { "llama-server": "b1234" } }) };
            }
            if (url.startsWith("/api/releases")) return { ok: true, json: async () => [] };
            if (url.startsWith("/api/backends")) return { ok: true, json: async () => ({ warning: "" }) };
            return { ok: true, json: async () => ({}) };
        },
    };
    context.window.window = context.window;
    vm.createContext(context);
    context.window.__LLAMA_GUI_TEST_HOOKS__ = true;
    for (const src of getScriptPaths().filter((s) => s === "js/api-client.js" || s.startsWith("js/manager/"))) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, "ui", src), "utf8"), context, { filename: `ui/${src}` });
    }
    const manager = context.window.LlamaGui.manager;
    const test = manager._test;
    assert.equal(typeof test.isSystemBackend, "function", "isSystemBackend must be exposed for tests");
    assert.equal(test.isSystemBackend("system", latestStatus), true);
    assert.equal(test.isSystemBackend("cpu", latestStatus), false);

    // Selecting System shows Activate System, hides releases, shows setup text, no fetch.
    const backendSelect = elements.get("backend-select");
    await manager.checkStatus();
    const releaseCallsBefore = fetchCalls.filter((c) => c.url.startsWith("/api/releases")).length;
    backendSelect.value = "system";
    test.onBackendChange();
    assert.equal(elements.get("btn-install").textContent, "Activate System");
    assert.equal(elements.get("release-group").style.display, "none");
    assert.equal(elements.get("system-backend-info").style.display, "");
    assert.equal(elements.get("custom-backend-info").style.display, "none");
    assert.match(elements.get("system-backend-tools").textContent, /llama-server.*\/usr\/bin\/llama-server/);
    assert.equal(elements.get("btn-update").disabled, true);
    assert.equal(elements.get("btn-repair").disabled, true);
    assert.equal(
        elements.get("btn-repair").classList.contains("hidden"),
        false,
        "repair button should be visible but disabled when system is selected as install target"
    );
    assert.equal(
        fetchCalls.filter((c) => c.url.startsWith("/api/releases")).length,
        releaseCallsBefore,
        "selecting System must not fetch releases"
    );

    // Activation routes to /api/activate-system with duplicate guard.
    let releaseGate;
    const pendingCalls = [];
    context.fetch = async (url, options) => {
        fetchCalls.push({ url, options });
        if (url === "/api/status") return { ok: true, json: async () => latestStatus };
        if (url === "/api/activate-system") {
            pendingCalls.push(JSON.parse(options.body));
            await new Promise((resolve) => { releaseGate = resolve; });
            return { ok: true, json: async () => ({ ok: true, found: ["llama-server"], missing: ["llama-cli"], server_path: "/usr/bin/llama-server", paths: {}, build_tags: {} }) };
        }
        return { ok: true, json: async () => [] };
    };
    const first = manager._test.installRelease();
    const second = manager._test.installRelease();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(pendingCalls, [{}], "duplicate System activation must be ignored");
    assert.equal(elements.get("btn-install").disabled, true, "polling must not unlock activation in flight");
    latestStatus = systemStatus();
    releaseGate();
    await first;
    await second;
    assert.match(elements.get("install-status").textContent, /System.*activated.*llama-server/);
    assert.equal(elements.get("installed-backend-summary").textContent, "Installed backend: System (PATH)");
    assert.match(elements.get("version-badge").textContent, /System \(PATH\).*b1234/);

    // Installed rendering: server required, CLI feature-specific, paths as text.
    // Stub DOM nodes do not aggregate descendant text like real DOM, so walk
    // the tree the way textContent would read.
    const collectText = (node) => {
        let out = String(node.textContent || "");
        for (const child of node.children || []) {
            if (typeof child === "string") out += child;
            else if (child && typeof child === "object") out += " " + collectText(child);
        }
        return out;
    };
    const info = elements.get("installed-info");
    const dump = collectText(info);
    assert.match(dump, /Required tool/);
    assert.match(dump, /Feature tools/);
    assert.match(dump, /\/usr\/bin\/llama-server/);
    assert.match(dump, /unknown|b1234/);
    for (const html of innerHtmlWrites) {
        assert.ok(!html.includes("/usr/bin"), "discovered paths must render via textContent, never innerHTML");
    }

    // Unknown build shows explicit unknown display, gates stay conservative.
    latestStatus = systemStatus({
        runtime_health: { ok: true, checked: true, build_tags: {}, system_probes: { "llama-server": { ok: true, build_tag: null, error: null, executable: "/usr/bin/llama-server" } } },
        system_tools: {
            "llama-server": { path: "/usr/bin/llama-server", available: true, build_tag: null, probe_ok: true, probe_error: null },
            "llama-cli": { path: null, available: false, build_tag: null, probe_ok: null, probe_error: null },
        },
    });
    await manager.checkStatus();
    assert.match(elements.get("version-badge").textContent, /unknown build/);

    // Stale (removed server) shows PATH guidance and keeps selection.
    latestStatus = systemStatus({
        installed: false, config_stale: true,
        runtime_health: { ok: true, checked: false, build_tags: {}, system_probes: {} },
        system_tools: {
            "llama-server": { path: null, available: false, build_tag: null, probe_ok: null, probe_error: null },
            "llama-cli": { path: null, available: false, build_tag: null, probe_ok: null, probe_error: null },
        },
        system_server_error: SYSTEM_PATH_GUIDANCE,
    });
    await manager.checkStatus();
    assert.match(collectText(elements.get("installed-info")), /PATH inherited by Llama GUI/);
    assert.equal(elements.get("installed-backend-summary").textContent, "Configured backend: System (PATH) (incomplete)");
    assert.equal(backendSelect.value, "system", "stale selection must not reset");

    // Failed activation surfaces the backend error near the controls.
    context.fetch = async (url) => {
        if (url === "/api/status") return { ok: true, json: async () => latestStatus };
        if (url === "/api/activate-system") return { ok: true, json: async () => ({ ok: false, error: SYSTEM_PATH_GUIDANCE }) };
        return { ok: true, json: async () => ({}) };
    };
    backendSelect.value = "system";
    test.onBackendChange();
    await manager._test.installRelease();
    assert.match(elements.get("install-status").textContent, /PATH inherited by Llama GUI/);

    // Official return: selecting an official target while System is active
    // offers Activate Existing derived from accepted status.
    latestStatus = systemStatus();
    await manager.checkStatus();
    assert.equal(test.canActivateOfficialBackend(latestStatus, "cpu"), true);
    assert.equal(test.canActivateOfficialBackend(latestStatus, "system"), false);
    backendSelect.value = "cpu";
    test.onBackendChange();
    await manager.checkStatus();
    assert.equal(elements.get("btn-install").textContent, "Activate Existing");
    assert.equal(backendSelect.value, "cpu", "pending official target survives status polls");

    // Forced backend refresh must not fetch releases for System.
    const releasesBefore = fetchCalls.filter((c) => c.url.startsWith("/api/releases")).length;
    backendSelect.value = "system";
    test.onBackendChange();
    await manager.refreshBackends(true);
    assert.equal(
        fetchCalls.filter((c) => c.url.startsWith("/api/releases")).length,
        releasesBefore,
        "forced refresh must suppress release fetching for System"
    );

    console.log("system manager unit tests passed");
}

// ---------------------------------------------------------------------------
// 2. Flag core: per-tool build tags.
// ---------------------------------------------------------------------------

function testFlagCore() {
    const context = { window: { LlamaGui: {} }, console, shouldOmitLegacyLoadFlag: () => false };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/flag-core.js"), "utf8"), context, { filename: "ui/js/flag-core.js" });
    const core = context.window.LlamaGui.flagCore;

    core.setBinaryTag("system");
    core.setBinaryTags({ "llama-server": "b11000", "llama-cli": "custom" });
    assert.equal(core.getBinaryTagForTool("llama-server"), "b11000");
    assert.equal(core.getBinaryTagForTool("llama-cli"), "custom");
    assert.equal(core.supportsLoadModeOnly("llama-server"), true);
    assert.equal(core.supportsLoadModeOnly("llama-cli"), false);
    assert.equal(core.supportsNativeReasoningEffort("llama-server"), true);
    assert.equal(core.supportsNativeReasoningEffort("llama-cli"), false);

    // Unknown build formats stay conservative.
    core.setBinaryTags({ "llama-server": "" });
    assert.equal(core.supportsLoadModeOnly("llama-server"), false);
    assert.equal(core.supportsNativeReasoningEffort("llama-server"), false);

    // buildLaunchArgs uses the tag for the tool being generated, not the
    // currently selected tool: server from a new build emits the native flag
    // while CLI from an old build keeps the legacy kwargs path.
    vm.runInContext(`
        window.LlamaGui.flagCore.configure({
            getDefaultFlagValues: () => ({}),
            getFlags: () => [
                { id: "chat_template_reasoning_effort", flag: "--reasoning-effort", tool: "server", type: "text" },
                { id: "preserve_thinking", flag: "--preserve-thinking", tool: "server", type: "bool" },
            ],
        });
        window.LlamaGui.flagCore.setCurrentToolValue("llama-cli");
        window.LlamaGui.flagCore.setBinaryTag("system");
        window.LlamaGui.flagCore.setBinaryTags({ "llama-server": "b11000", "llama-cli": "b10000" });
    `, context);
    const serverArgs = vm.runInContext(
        `window.LlamaGui.flagCore.buildLaunchArgs({ tool: "llama-server", model: "", flags: { chat_template_reasoning_effort: "high" } }).args.flat()`,
        context
    );
    assert.ok(serverArgs.includes("--reasoning-effort"), "new server build must emit the native flag");
    const cliArgs = vm.runInContext(
        `window.LlamaGui.flagCore.buildLaunchArgs({ tool: "llama-cli", model: "", flags: {} }).args`,
        context
    );
    assert.equal(cliArgs.length, 0, "per-tool gates must not leak across tools");

    console.log("system flag-core unit tests passed");
}

// ---------------------------------------------------------------------------
// 3. Quick Launch: server-only readiness, CLI-specific guidance.
// ---------------------------------------------------------------------------

function testQuickLaunch() {
    const ids = [
        "quick-command-preview", "command-preview-text", "quick-context-preset", "quick-context-custom",
        "quick-gpu-mode", "quick-gpu-custom", "quick-fit-toggle", "quick-fit-target", "quick-fit-ctx",
        "quick-fit-summary", "quick-template-pack", "quick-template-summary", "quick-temperature",
        "quick-top-k", "quick-top-p", "quick-min-p", "quick-repeat-penalty", "quick-presence-penalty",
        "quick-temperature-input", "quick-top-p-input", "quick-port", "quick-profile-select",
        "quick-profile-summary", "quick-metrics-toggle", "quick-api-key-control", "quick-auth-section",
        "quick-server-fields", "quick-server-summary", "model-select", "quick-model-select",
        "quick-chip-model", "quick-chip-profile", "quick-chip-context", "quick-chip-gpu", "quick-chip-api",
        "quick-api-protected-badge", "btn-quick-launch", "btn-quick-stop", "btn-launch", "btn-stop",
        "btn-sidebar-launch", "btn-sidebar-stop", "btn-quick-launch-label", "btn-quick-stop-label",
        "btn-sidebar-launch-label", "btn-sidebar-stop-label", "quick-launch-readiness",
        "sidebar-launch-reason", "quick-launch-status", "quick-runtime-state", "quick-runtime-model",
        "quick-runtime-build", "quick-server-url", "quick-server-webui", "quick-saved-presets",
        "quick-presets-status",
    ];
    const elements = new Map(ids.map((id) => [id, makeElement()]));
    for (const id of ["btn-launch", "btn-stop", "btn-quick-launch", "btn-quick-stop", "btn-sidebar-launch", "btn-sidebar-stop"]) {
        elements.get(id).classList.remove("hidden");
    }
    elements.get("model-select").value = "smoke.gguf";
    elements.get("model-select").options = [{ value: "smoke.gguf" }];
    elements.get("command-preview-text").textContent = "llama-server -m models/smoke.gguf";
    elements.get("quick-template-pack").selectedOptions = [{ textContent: "Auto" }];

    let currentTool = "llama-server";
    let latestStatus = systemStatus();
    const context = {
        window: { LlamaGui: { searchableSelect: { enhance() {} } } },
        document: {
            getElementById: (id) => elements.get(id) || null,
            createElement: () => makeElement(),
            createTextNode: (text) => ({ textContent: String(text || "") }),
            querySelector: () => ({ textContent: "", classList: { toggle() {}, add() {}, remove() {} } }),
            querySelectorAll: () => [],
        },
        console: { ...console, debug: () => {} },
        FLAGS: [],
        QUICK_PROFILES: {},
        QUICK_CONTEXT_PRESETS: ["8192"],
        setTimeout, clearTimeout,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/quick-launch-ui.js"), "utf8"), context, { filename: "ui/js/quick-launch-ui.js" });
    const ui = context.window.LlamaGui.quickLaunchUi;
    const flagCore = {
        getCurrentTool: () => currentTool,
        getFlagValues: () => ({}),
        getSelectedModel: () => "smoke.gguf",
        setSelectedModelValue: () => {},
        getLaunchArgs: () => ({ args: [["-m", "models/smoke.gguf"]], error: null }),
        normalizeGpuLayersValue: (v) => v,
        updateCommandPreview: () => {},
    };
    ui.configure({
        flagCore,
        getLifecycleSnapshot: () => ({ activeRuntime: null, busy: false, phase: "idle" }),
        getLatestStatus: () => latestStatus,
        configFlagsUi: { ensureChatTemplateOption() {}, syncSensitiveTextInput() {}, createSensitiveTextInput: () => makeElement() },
        hasLaunchModelArg: (args) => (args || []).flat().includes("-m"),
        updateQuickServerAddressPreview: () => {},
        getSelectedChatTemplateDropdownValue: () => "",
        getQuickTemplateSummaryText: () => "",
        getAllSamplerPresets: () => [],
    });

    ui.refresh();
    assert.equal(elements.get("btn-quick-launch").disabled, false, "server-only System must leave server launches usable");
    assert.equal(elements.get("btn-quick-launch").title, "");

    currentTool = "llama-cli";
    ui.refresh();
    assert.equal(elements.get("btn-quick-launch").disabled, true, "missing CLI must block Terminal launches");
    assert.match(elements.get("btn-quick-launch").title, /llama-cli was not found/);
    assert.match(elements.get("btn-quick-launch").title, /server.*usable|Chat.*usable/i);

    latestStatus = systemStatus({
        installed: false, config_stale: true,
        system_tools: {
            "llama-server": { path: null, available: false },
            "llama-cli": { path: null, available: false },
        },
        system_server_error: SYSTEM_PATH_GUIDANCE,
    });
    currentTool = "llama-server";
    ui.refresh();
    assert.equal(elements.get("btn-quick-launch").disabled, true);
    assert.match(elements.get("btn-quick-launch").title, /PATH inherited by Llama GUI/);

    // Non-System backends never gate the launch up front: the launch
    // endpoint stays authoritative even for inconsistent statuses.
    latestStatus = systemStatus({ backend: "cpu", version: "b1234", tag: "b1234" });
    currentTool = "llama-cli";
    ui.refresh();
    assert.equal(elements.get("btn-quick-launch").disabled, false, "official backends must not be gated by frontend tool checks");
    assert.equal(elements.get("btn-quick-launch").title, "");

    console.log("system quick-launch unit tests passed");
}

// ---------------------------------------------------------------------------
// 4. Benchmark: missing-tool guidance and per-tool load-mode gate.
// ---------------------------------------------------------------------------

function testBenchmark() {
    const context = {
        window: { LlamaGui: {}, addEventListener: () => {}, __LLAMA_GUI_TEST_HOOKS__: true },
        document: { getElementById: () => null, createElement: () => ({ appendChild: () => {}, classList: { toggle: () => {} } }) },
        console: { ...console, debug: () => {} },
        setInterval, clearInterval,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/output-cursor.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/flags/helpers.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/flag-core.js"), "utf8"), context);
    vm.runInContext(`window.LlamaGui.flagCore.setModelDirInfo({
        models_dir: "models", models_arg_root: "models",
        models_dir_is_default: true, models_dir_available: true, models_dir_error: "",
    })`, context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/benchmark-ui.js"), "utf8"), context);
    const bench = context.window.LlamaGui.benchmarkUi;
    const core = context.window.LlamaGui.flagCore;

    // Per-tool gate: bench from a new build translates mmap even when the
    // server tag is old.
    core.setBinaryTag("system");
    core.setBinaryTags({ "llama-bench": "b10900", "llama-server": "b10000" });
    const flags = [
        { id: "mmap", flag: "--mmap", type: "bool", label: "Mmap" },
        { id: "ctx_size", flag: "-c", type: "int", label: "Context" },
    ];
    const translated = bench.buildBenchmarkArgs({
        benchmarkType: "bench", flags, defaultFlags: {},
        source: { sourceType: "manual", model: "m.gguf", flags: { mmap: true } },
    });
    assert.ok(translated.args.some((entry) => entry[0] === "--load-mode"), "new bench build must translate legacy mmap");
    core.setBinaryTags({ "llama-bench": "b10000" });
    const legacy = bench.buildBenchmarkArgs({
        benchmarkType: "bench", flags, defaultFlags: {},
        source: { sourceType: "manual", model: "m.gguf", flags: { mmap: true } },
    });
    assert.ok(legacy.args.some((entry) => entry[0] === "-mmp"), "old bench build must keep the legacy flag");

    // Missing bench tool produces feature-specific guidance via renderCommand.
    const nodes = {};
    for (const id of ["benchmark-command-preview", "benchmark-status", "btn-run-benchmark", "benchmark-source-summary", "benchmark-applied-list", "benchmark-excluded-list", "benchmark-type", "benchmark-source", "benchmark-manual-model", "benchmark-preset-select"]) {
        const el = makeElement();
        el.value = id === "benchmark-type" ? "bench" : id === "benchmark-source" ? "manual" : "m.gguf";
        nodes[id] = el;
    }
    context.window.LlamaGui.benchmarkUi.configure({
        flagCore: core,
        getFlags: () => [],
        getDefaultFlagValues: () => ({}),
        getLatestStatus: () => systemStatus(),
    });
    const documentBackup = context.document;
    context.document.getElementById = (id) => nodes[id] || null;
    context.document.createElement = () => ({ textContent: "", className: "", appendChild() {} });
    const result = bench.renderCommand();
    assert.match(result.error || "", /llama-bench was not found/);
    assert.equal(nodes["btn-run-benchmark"].disabled, true);
    void documentBackup;

    // Non-System backends never gate the run up front: the launch endpoint
    // stays authoritative even for inconsistent statuses.
    context.window.LlamaGui.benchmarkUi.configure({
        getLatestStatus: () => ({ ...systemStatus(), backend: "cpu" }),
    });
    const unrestricted = bench.renderCommand();
    assert.ok(!unrestricted.error || !unrestricted.error.includes("was not found"), "official backends must not be gated by frontend tool checks");
    assert.equal(nodes["btn-run-benchmark"].disabled, false);

    console.log("system benchmark unit tests passed");
}

(async () => {
    await testManager();
    testFlagCore();
    testQuickLaunch();
    testBenchmark();
    console.log("system path frontend unit tests passed");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
