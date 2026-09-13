// Exercise GUI lifecycle and app-update handoffs through the assembled package.
// Everything is a fixture: no server, native lifecycle action, or real timer runs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getScriptPaths, UI_DIR } = require("./script_order.cjs");

function makeElement() {
    return {
        value: "", style: {}, disabled: false, textContent: "", listeners: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild(child) { return child; },
        addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    };
}

(async () => {
    let initialized = false;
    const elements = new Map([
        "btn-install", "version-badge", "installed-info", "install-status",
        "btn-restart-app", "btn-stop-app", "btn-sidebar-stop-app",
        "app-update-status", "btn-update-app", "app-update-channel",
    ].map(id => [id, makeElement()]));
    elements.get("app-update-channel").value = "stable";
    const timers = [];
    const replacements = [];
    let reloads = 0;
    const requests = [];
    const confirmations = [];
    let confirmed = true;
    const status = { installed: false, running: true, available_backends: [] };
    const updateStatus = {
        available: true, can_update: true, state: "behind", update_channel: "stable",
        release_tag: "v1.2.3", branch: "main",
    };
    let respond = async url => {
        if (url === "/api/status") return status;
        if (url === "/api/app-update-status") return updateStatus;
        if (url === "/api/restart" || url === "/api/shutdown") return { ok: true };
        throw new Error(`Unexpected request: ${url}`);
    };
    const context = vm.createContext({
        URL, console,
        window: {
            LlamaGui: {},
            addEventListener() { assert.ok(initialized, "loading must not bind unload listeners"); },
            setTimeout(callback, delay) {
                assert.ok(initialized, "loading/configuration must not start timers");
                timers.push({ callback, delay });
            },
            location: {
                href: "http://127.0.0.1:5240/?preset=Old#chat",
                replace(url) { replacements.push(url); },
                reload() { reloads++; },
            },
        },
        document: {
            getElementById(id) {
                assert.ok(initialized, "loading/configuration must not touch DOM");
                return elements.get(id) || null;
            },
            createElement: makeElement,
        },
        fetch() { assert.fail("all requests must use the configured client"); },
        setTimeout() { assert.fail("an immediate readiness success must not wait"); },
        setInterval() { assert.fail("loading/configuration must not start polling"); },
    });
    for (const src of getScriptPaths().filter(src => src === "js/api-client.js" || src.startsWith("js/manager/"))) {
        vm.runInContext(fs.readFileSync(path.join(UI_DIR, src), "utf8"), context, { filename: src });
    }
    const manager = context.window.LlamaGui.manager;
    manager.configure({
        fetchJson: async url => {
            assert.ok(initialized, "configuration must not fetch");
            assert.equal(url, "/api/app-update-status");
            return updateStatus;
        },
        confirmAction: async (...args) => { confirmations.push(args); return confirmed; },
    });
    assert.equal(manager.getLatestStatus(), null);
    assert.equal(manager.getKnownModelNames(), null);
    assert.equal(manager._test, undefined);
    initialized = true;
    manager.init();
    await Promise.resolve();

    // Replace transport after init: already-bound handlers and cross-concern
    // calls must use this client, while retaining the configured confirmation.
    manager.configure({ fetchJson: async (url, options) => {
        requests.push({ url, options });
        return respond(url, options);
    } });
    const click = id => elements.get(id).listeners.click[0]();
    await click("btn-restart-app");
    assert.deepEqual(requests.map(request => request.url), ["/api/status", "/api/restart", "/api/status"]);
    assert.match(confirmations[0][1], /running llama.cpp process will be stopped first/);
    assert.equal(requests[1].options.method, "POST");
    assert.equal(manager.getLatestStatus(), status);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 500);
    timers.shift().callback();
    const replacement = new URL(replacements[0]);
    assert.equal(replacement.pathname, "/");
    assert.deepEqual([...replacement.searchParams.keys()], ["appReload"]);
    assert.equal(replacement.hash, "");

    requests.length = 0;
    confirmed = false;
    await click("btn-stop-app");
    assert.equal(requests.length, 0, "cancelled quit makes no lifecycle request");
    assert.equal(timers.length, 0);
    confirmed = true;
    await click("btn-sidebar-stop-app");
    assert.deepEqual(requests.map(request => request.url), ["/api/shutdown"]);
    assert.equal(elements.get("btn-stop-app").disabled, true);
    assert.equal(elements.get("btn-sidebar-stop-app").disabled, true);
    assert.equal(timers[0].delay, 1500);
    timers.shift().callback();
    assert.equal(reloads, 1);

    respond = async () => { throw new Error("fixture offline"); };
    await click("btn-stop-app");
    assert.equal(elements.get("btn-stop-app").disabled, false);
    assert.equal(elements.get("btn-sidebar-stop-app").disabled, false);
    assert.match(elements.get("install-status").textContent, /Failed to quit.*fixture offline/);
    await click("btn-restart-app");
    assert.equal(elements.get("btn-restart-app").disabled, false);
    assert.match(elements.get("install-status").textContent, /Failed to restart.*fixture offline/);
    assert.equal(timers.length, 0, "failed lifecycle requests do not schedule a reload");

    // A successful application update delegates restart/readiness to lifecycle,
    // keeping its messages in the app-update status box.
    requests.length = 0;
    respond = async url => {
        if (url === "/api/app-update") return { updated: true, dependencies_installed: true };
        if (url === "/api/restart") return { ok: true };
        if (url === "/api/status") return status;
        throw new Error(`Unexpected update request: ${url}`);
    };
    const installMessage = elements.get("install-status").textContent;
    await manager.updateAppFromGitHub();
    assert.deepEqual(requests.map(request => request.url), ["/api/app-update", "/api/restart", "/api/status"]);
    assert.deepEqual(JSON.parse(requests[0].options.body), { channel: "stable" });
    assert.equal(elements.get("app-update-status").textContent, "Llama GUI restarted. Loading the updated interface...");
    assert.equal(elements.get("install-status").textContent, installMessage);
    assert.equal(timers.length, 1);
    console.log("manager lifecycle unit tests passed");
})().catch(error => {
    console.error(error);
    process.exit(1);
});
