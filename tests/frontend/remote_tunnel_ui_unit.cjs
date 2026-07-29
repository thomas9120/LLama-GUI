const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "remote-tunnel-ui.js"), "utf8");

function createElement() {
    const classes = new Set();
    return {
        textContent: "",
        disabled: false,
        href: "",
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            toggle: (name, force) => {
                if (arguments.length < 2) {
                    if (classes.has(name)) classes.delete(name); else classes.add(name);
                } else if (force) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            },
            contains: (name) => classes.has(name),
        },
    };
}

(async () => {
    const elements = new Map();
    for (const id of [
        "btn-start-remote-tunnel",
        "btn-stop-remote-tunnel",
        "remote-tunnel-badge",
        "remote-tunnel-status",
        "remote-tunnel-url-row",
        "remote-tunnel-url",
        "remote-openai-url-row",
        "remote-openai-url",
    ]) {
        elements.set(id, createElement());
    }

    let intervalCount = 0;
    let clearCount = 0;
    const context = {
        window: { LlamaGui: {} },
        document: { getElementById: (id) => elements.get(id) || null },
        console,
        setInterval: () => {
            intervalCount += 1;
            return intervalCount;
        },
        clearInterval: () => {
            clearCount += 1;
        },
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "ui/js/remote-tunnel-ui.js" });

    const ui = context.window.LlamaGui.remoteTunnelUi;
    ui.configure({
        fetchJson: async () => {
            throw new Error("temporary outage");
        },
    });
    ui.renderStatus({
        status: "running",
        url: "https://example.trycloudflare.com",
        message: "Remote tunnel is running.",
    });

    assert.equal(intervalCount, 1);
    assert.equal(elements.get("remote-tunnel-badge").textContent, "running");

    const result = await ui.refreshStatus();

    assert.equal(result, null);
    assert.equal(clearCount, 0);
    assert.equal(intervalCount, 1);
    assert.equal(elements.get("remote-tunnel-badge").textContent, "running");
    assert.match(elements.get("remote-tunnel-status").textContent, /Retrying/);

    console.log("remote tunnel ui unit tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
