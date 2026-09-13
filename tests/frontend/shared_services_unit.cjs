const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { UI_DIR, getScriptPaths } = require("./script_order.cjs");

const elements = new Map();
let domReads = 0;
let requests = 0;
function eventTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
        emit(type, event = {}) {
            for (const handler of [...(listeners.get(type) || [])]) handler({ target: this, ...event });
        },
        classList: { add() {}, remove() {} },
        focus() { document.activeElement = this; },
        select() { this.selected = true; },
    };
}
const document = {
    ...eventTarget(),
    getElementById(id) {
        domReads++;
        if (!elements.has(id)) elements.set(id, eventTarget());
        return elements.get(id);
    },
};
let response;
let request;
const context = vm.createContext({
    window: {}, document,
    fetch: async (url, options) => {
        requests++;
        request = { url, options };
        if (response instanceof Error) throw response;
        return response;
    },
});
for (const src of getScriptPaths().filter(src => ["js/api-client.js", "js/dialogs.js"].includes(src))) {
    vm.runInContext(fs.readFileSync(path.join(UI_DIR, src), "utf8"), context, { filename: src });
}
assert.equal(domReads, 0, "service evaluation must not touch the DOM");
assert.equal(requests, 0, "service evaluation must not start requests");
const { apiClient, dialogs } = context.window.LlamaGui;
function assertClean() {
    for (const target of [document, ...elements.values()]) {
        for (const handlers of target.listeners.values()) assert.equal(handlers.size, 0, "dialog listeners are removed");
    }
}

(async () => {
    response = { ok: true, json: async () => ({ value: 1 }) };
    assert.deepEqual(await apiClient.fetchJson("/api/test"), { value: 1 });
    assert.equal(request.options.cache, "no-store");
    const signal = new AbortController().signal;
    const headers = { "Content-Type": "application/json" };
    await apiClient.fetchJson("/api/test", { method: "POST", body: "{}", headers, signal, cache: "reload" });
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.body, "{}");
    assert.equal(request.options.headers, headers);
    assert.equal(request.options.signal, signal);
    assert.equal(request.options.cache, "reload");
    response = { ok: true, json: async () => null };
    assert.equal(await apiClient.fetchJson("/api/test"), null);
    response = { ok: true, json: async () => { throw new Error("not JSON"); } };
    await assert.rejects(apiClient.fetchJson("/api/test"), /Invalid JSON response from \/api\/test/);
    response = { ok: false, status: 503, json: async () => { throw new Error("not JSON"); } };
    await assert.rejects(apiClient.fetchJson("/api/test"), /Request failed \(503\)/);
    response = { ok: false, status: 409, json: async () => ({ error: "Conflict detail" }) };
    await assert.rejects(apiClient.fetchJson("/api/test"), /Conflict detail/);
    response = { ok: false, status: 404, json: async () => null };
    await assert.rejects(apiClient.fetchJson("/api/test"), /Request failed \(404\)/);
    response = new Error("aborted");
    await assert.rejects(apiClient.fetchJson("/api/test"), error => error === response);

    for (const [action, expected] of [["confirm", true], ["cancel", false], ["escape", false], ["backdrop", false], ["enter-cancel", false], ["enter", true]]) {
        const pending = dialogs.confirmAction("<title>", "<message>", "Proceed");
        const modal = elements.get("confirm-modal");
        const cancel = elements.get("confirm-modal-cancel");
        const ok = elements.get("confirm-modal-ok");
        assert.equal(document.activeElement, ok);
        assert.equal(elements.get("confirm-modal-title").textContent, "<title>");
        assert.equal(elements.get("confirm-modal-message").textContent, "<message>");
        if (action === "confirm") ok.emit("click");
        else if (action === "cancel") cancel.emit("click");
        else if (action === "backdrop") modal.emit("click");
        else document.emit("keydown", { key: action === "escape" ? "Escape" : "Enter", target: action === "enter-cancel" ? cancel : ok, preventDefault() {} });
        assert.equal(await pending, expected);
        assertClean();
    }
    for (const [action, expected] of [["cancel", null], ["escape", null], ["backdrop", null], ["empty", ""], ["enter", "changed"]]) {
        const pending = dialogs.promptAction("Rename", "Name", "original", "Save");
        const input = elements.get("prompt-modal-input");
        assert.equal(document.activeElement, input);
        assert.equal(input.value, "original");
        assert.equal(input.selected, true);
        input.value = action === "empty" ? "   " : " changed ";
        if (action === "cancel") elements.get("prompt-modal-cancel").emit("click");
        else if (action === "backdrop") elements.get("prompt-modal").emit("click");
        else if (action === "empty") elements.get("prompt-modal-ok").emit("click");
        else document.emit("keydown", { key: action === "escape" ? "Escape" : "Enter", preventDefault() {} });
        assert.equal(await pending, expected);
        assertClean();
    }
    console.log("shared services unit tests passed");
})().catch(error => { console.error(error); process.exit(1); });
