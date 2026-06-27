const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "manager.js"), "utf8");

function makeElement() {
    let html = "";
    const el = {
        children: [],
        value: "",
        textContent: "",
        className: "",
        style: {},
        disabled: false,
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
["release-select", "backend-select"].forEach((id) => elements.set(id, makeElement()));

const fetchCalls = [];
const fetchPayload = [{ tag: "b1294", published: "2024-01-01T00:00:00Z", assets: [] }];

const context = {
    window: { addEventListener() {}, LlamaGui: {} },
    document: {
        createElement: () => makeElement(),
        getElementById: (id) => elements.get(id) || null,
    },
    console,
    fetch: async (url) => {
        fetchCalls.push(url);
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
        fetchCalls[fetchCalls.length - 1],
        "/api/releases?backend=lemonade-rocm-gfx110X",
        "fetchReleases(backend) should hit backend-aware releases URL"
    );

    await context.fetchReleases();
    assert.equal(
        fetchCalls[fetchCalls.length - 1],
        "/api/releases",
        "fetchReleases() without backend should hit default releases URL"
    );

    backendSelect.value = "cpu";
    await context.onBackendChange();
    assert.equal(
        fetchCalls[fetchCalls.length - 1],
        "/api/releases?backend=cpu",
        "onBackendChange should refetch releases for the selected backend"
    );

    const pending = new Map();
    context.fetch = async (url) => {
        fetchCalls.push(url);
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

    console.log("manager releases unit tests passed");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
