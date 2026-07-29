const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "external-server-ui.js"), "utf8");

function createElement(tagName = "div") {
    const classes = new Set();
    return {
        tagName: tagName.toUpperCase(),
        textContent: "",
        value: "",
        disabled: false,
        listeners: {},
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
            toggle: (name, force) => {
                const next = force === undefined ? !classes.has(name) : Boolean(force);
                if (next) classes.add(name);
                else classes.delete(name);
                return next;
            },
        },
        addEventListener(type, handler) {
            this.listeners[type] = handler;
        },
        dispatch(type, event) {
            if (this.listeners[type]) this.listeners[type](event);
        },
    };
}

const elements = new Map();
for (const id of [
    "external-server-badge",
    "external-server-summary",
    "external-server-target",
    "external-server-note",
    "external-server-host",
    "external-server-port",
    "external-server-key",
    "btn-connect-external-server",
    "btn-disconnect-external-server",
]) {
    elements.set(id, createElement(id.startsWith("btn-") ? "button" : "div"));
}

const context = {
    window: { LlamaGui: {} },
    document: { getElementById: (id) => elements.get(id) || null },
    console,
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/external-server-ui.js" });

const externalServerUi = context.window.LlamaGui.externalServerUi;

const requests = [];
let nextResponse = null;
let nextError = null;
let latestStatus = {};
let refreshCount = 0;

externalServerUi.configure({
    fetchJson: async (url, options) => {
        requests.push({ url, options });
        if (nextError) throw nextError;
        return nextResponse;
    },
    getLatestStatus: () => latestStatus,
    refreshStatus: async () => {
        refreshCount += 1;
    },
});

const byId = (id) => elements.get(id);

function resetForm(host, port, apiKey) {
    byId("external-server-host").value = host;
    byId("external-server-port").value = port;
    byId("external-server-key").value = apiKey;
}

// --- rendering -------------------------------------------------------------

externalServerUi.render(null);
assert.equal(byId("external-server-badge").textContent, "Not connected");
assert.equal(byId("btn-connect-external-server").textContent, "Connect");
assert.ok(
    byId("btn-disconnect-external-server").classList.contains("hidden"),
    "disconnect should stay hidden while nothing is registered"
);
assert.ok(byId("external-server-summary").classList.contains("hidden"));

externalServerUi.render({ connected: true, host: "127.0.0.1", port: 9001, label: "Workstation" });
assert.equal(byId("external-server-badge").textContent, "Connected");
assert.equal(byId("external-server-target").textContent, "Workstation (127.0.0.1:9001)");
assert.equal(byId("btn-connect-external-server").textContent, "Reconnect");
assert.equal(byId("btn-disconnect-external-server").classList.contains("hidden"), false);

assert.equal(
    externalServerUi.describeTarget({ host: "127.0.0.1", port: 9001, label: "" }),
    "127.0.0.1:9001",
    "an unlabelled target should read as a bare address"
);

// --- reading the registered target from status -----------------------------

latestStatus = { external_chat_target: null };
assert.equal(externalServerUi.getTarget(), null);

latestStatus = { external_chat_target: { connected: false, host: "127.0.0.1", port: 9001 } };
assert.equal(externalServerUi.getTarget(), null, "a disconnected payload is not a target");

latestStatus = { external_chat_target: { connected: true, host: "127.0.0.1", port: 9001 } };
assert.equal(externalServerUi.getTarget().port, 9001);

// --- connect ---------------------------------------------------------------

(async () => {
    resetForm("127.0.0.1", "9001", "secret-key");
    nextResponse = {
        external_chat_target: {
            connected: true,
            host: "127.0.0.1",
            port: 9001,
            label: "",
            api_key_configured: true,
            warning: "",
        },
    };
    await externalServerUi.connect();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/chat/target");
    assert.equal(requests[0].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        host: "127.0.0.1",
        port: "9001",
        api_key: "secret-key",
    });
    assert.equal(byId("external-server-note").textContent, "Connected to 127.0.0.1:9001.");
    assert.equal(byId("external-server-badge").textContent, "Connected");
    assert.equal(refreshCount, 1, "connecting must re-read /api/status so chat unlocks");

    // A blank host is filled in for the user rather than rejected.
    resetForm("", "9001", "");
    nextResponse = {
        external_chat_target: { connected: true, host: "127.0.0.1", port: 9001, label: "" },
    };
    await externalServerUi.connect();
    assert.equal(JSON.parse(requests[requests.length - 1].options.body).host, "127.0.0.1");

    // A warning from the backend replaces the success message.
    resetForm("127.0.0.1", "9001", "wrong-key");
    nextResponse = {
        external_chat_target: {
            connected: true,
            host: "127.0.0.1",
            port: 9001,
            warning: "Connected, but the server rejected the API key.",
        },
    };
    await externalServerUi.connect();
    assert.equal(
        byId("external-server-note").textContent,
        "Connected, but the server rejected the API key."
    );
    assert.ok(byId("external-server-note").classList.contains("warning"));

    // A missing port never reaches the network.
    const requestsBefore = requests.length;
    resetForm("127.0.0.1", "", "");
    await externalServerUi.connect();
    assert.equal(requests.length, requestsBefore, "a blank port should not be sent");
    assert.equal(
        byId("external-server-note").textContent,
        "Enter the port llama-server is listening on."
    );
    assert.ok(byId("external-server-note").classList.contains("error"));

    // A failed request surfaces the backend message and leaves the panel usable.
    resetForm("127.0.0.1", "9001", "");
    nextError = new Error("No server answered at 127.0.0.1:9001.");
    latestStatus = { external_chat_target: null };
    await externalServerUi.connect();
    nextError = null;
    assert.equal(byId("external-server-note").textContent, "No server answered at 127.0.0.1:9001.");
    assert.ok(byId("external-server-note").classList.contains("error"));
    assert.equal(byId("btn-connect-external-server").disabled, false);
    assert.equal(byId("external-server-badge").textContent, "Not connected");

    // --- disconnect --------------------------------------------------------

    latestStatus = { external_chat_target: { connected: true, host: "127.0.0.1", port: 9001 } };
    byId("external-server-key").value = "secret-key";
    nextResponse = { external_chat_target: null };
    const refreshBefore = refreshCount;

    await externalServerUi.disconnect();

    const disconnectRequest = requests[requests.length - 1];
    assert.equal(disconnectRequest.url, "/api/chat/target");
    assert.equal(disconnectRequest.options.method, "DELETE");
    assert.equal(byId("external-server-key").value, "", "the key field should not survive a disconnect");
    assert.equal(byId("external-server-badge").textContent, "Not connected");
    assert.equal(byId("external-server-note").textContent, "Disconnected.");
    assert.equal(refreshCount, refreshBefore + 1);

    // --- restoring a remembered address ------------------------------------

    // Nothing saved: no reconnect attempt, no noise.
    latestStatus = { external_chat_target: null };
    resetForm("", "", "");
    requests.length = 0;
    nextResponse = { external_chat_target: null, remembered_target: null };
    await externalServerUi.restore();
    assert.equal(requests.length, 1, "restore should only read the target");
    assert.equal(requests[0].options, undefined, "the read must be a plain GET");
    assert.equal(byId("external-server-badge").textContent, "Not connected");

    // A keyless address reconnects on its own.
    requests.length = 0;
    let call = 0;
    nextResponse = null;
    const restoreResponses = [
        {
            external_chat_target: null,
            remembered_target: { host: "127.0.0.1", port: 9001, label: "Box", api_key_required: false },
        },
        {
            external_chat_target: { connected: true, host: "127.0.0.1", port: 9001, label: "Box" },
        },
    ];
    externalServerUi.configure({
        fetchJson: async (url, options) => {
            requests.push({ url, options });
            if (nextError) throw nextError;
            return restoreResponses[call++];
        },
    });
    const refreshBeforeRestore = refreshCount;

    await externalServerUi.restore();

    assert.equal(requests.length, 2, "a keyless address should be reconnected");
    assert.equal(requests[1].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[1].options.body), { restore: true });
    assert.equal(byId("external-server-host").value, "127.0.0.1", "the form should be prefilled");
    assert.equal(byId("external-server-port").value, "9001");
    assert.equal(byId("external-server-badge").textContent, "Connected");
    assert.equal(byId("external-server-note").textContent, "Reconnected to Box (127.0.0.1:9001).");
    assert.equal(refreshCount, refreshBeforeRestore + 1, "a restore must unlock Chat");

    // An address that needed a key is prefilled but never auto-connected.
    requests.length = 0;
    call = 0;
    resetForm("", "", "");
    restoreResponses[0] = {
        external_chat_target: null,
        remembered_target: { host: "127.0.0.1", port: 9001, label: "", api_key_required: true },
    };
    await externalServerUi.restore();
    assert.equal(requests.length, 1, "a key-protected address must not be auto-connected");
    assert.equal(byId("external-server-host").value, "127.0.0.1");
    assert.equal(
        byId("external-server-note").textContent,
        "Re-enter the API key for 127.0.0.1:9001 to reconnect."
    );
    assert.ok(byId("external-server-note").classList.contains("warning"));
    assert.equal(byId("external-server-badge").textContent, "Not connected");

    // A saved address whose port is now something else reports the failure.
    // Only the reconnect fails here; reading the target still succeeds.
    requests.length = 0;
    externalServerUi.configure({
        fetchJson: async (url, options) => {
            requests.push({ url, options });
            if (options && options.method === "POST") {
                throw new Error(
                    "Something is listening on 127.0.0.1:9001, but it does not look like llama-server."
                );
            }
            return {
                external_chat_target: null,
                remembered_target: { host: "127.0.0.1", port: 9001, label: "", api_key_required: false },
            };
        },
    });
    await externalServerUi.restore();
    assert.equal(requests.length, 2);
    assert.match(byId("external-server-note").textContent, /did not answer/);
    assert.ok(byId("external-server-note").classList.contains("error"));
    assert.equal(byId("external-server-badge").textContent, "Not connected");

    // An already-registered target is adopted without a second POST.
    requests.length = 0;
    externalServerUi.configure({
        fetchJson: async (url, options) => {
            requests.push({ url, options });
            return {
                external_chat_target: { connected: true, host: "127.0.0.2", port: 9100, label: "Live" },
                remembered_target: { host: "127.0.0.2", port: 9100, label: "Live", api_key_required: false },
            };
        },
    });
    await externalServerUi.restore();
    assert.equal(requests.length, 1, "an active target needs no reconnect");
    assert.equal(byId("external-server-badge").textContent, "Connected");
    assert.equal(byId("external-server-host").value, "127.0.0.2");

    externalServerUi.configure({
        fetchJson: async (url, options) => {
            requests.push({ url, options });
            if (nextError) throw nextError;
            return nextResponse;
        },
    });

    // --- init --------------------------------------------------------------

    latestStatus = {
        external_chat_target: { connected: true, host: "127.0.0.2", port: 9100, label: "Remote box" },
    };
    externalServerUi.init();
    assert.equal(byId("external-server-host").value, "127.0.0.2", "init should prefill from the registered target");
    assert.equal(byId("external-server-port").value, "9100");

    byId("external-server-host").value = "draft-host";
    byId("external-server-host").dispatch("input", {});
    byId("external-server-port").value = "9200";
    byId("external-server-port").dispatch("input", {});
    latestStatus = {
        external_chat_target: { connected: true, host: "127.0.0.9", port: 9300, label: "Updated box" },
    };
    externalServerUi.refresh();
    assert.equal(byId("external-server-host").value, "draft-host", "refresh must preserve a dirty host draft");
    assert.equal(byId("external-server-port").value, "9200", "refresh must preserve a dirty port draft");

    const enterRequests = requests.length;
    nextResponse = { external_chat_target: latestStatus.external_chat_target };
    let defaultPrevented = false;
    byId("external-server-host").dispatch("keydown", {
        key: "Enter",
        preventDefault: () => {
            defaultPrevented = true;
        },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(defaultPrevented, "Enter should not submit anything else");
    assert.equal(requests.length, enterRequests + 1, "Enter in the form should connect");
    assert.equal(byId("external-server-host").value, "127.0.0.9", "successful connect should clear the host draft");
    assert.equal(byId("external-server-port").value, "9300", "successful connect should clear the port draft");

    console.log("external server ui unit tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
