(function () {
    "use strict";

    let deps = {};
    const dirtyAddressFields = new Set();

    function configure(nextDeps) {
        deps = Object.assign({}, deps, nextDeps || {});
    }

    function requireDependency(name) {
        const value = deps[name];
        if (typeof value !== "function") {
            throw new Error(`External server dependency missing: ${name}`);
        }
        return value;
    }

    function byId(id) {
        return document.getElementById(id);
    }

    function getTarget() {
        const status = typeof deps.getLatestStatus === "function" ? deps.getLatestStatus() : null;
        const target = status && status.external_chat_target;
        return target && target.connected ? target : null;
    }

    function describeTarget(target) {
        if (!target) return "";
        const address = `${target.host}:${target.port}`;
        const label = String(target.label || "").trim();
        return label ? `${label} (${address})` : address;
    }

    function setNote(message, type) {
        const note = byId("external-server-note");
        if (!note) return;
        note.textContent = message || "";
        note.classList.toggle("error", type === "error");
        note.classList.toggle("warning", type === "warning");
    }

    function render(target, options = {}) {
        const badge = byId("external-server-badge");
        const connectBtn = byId("btn-connect-external-server");
        const disconnectBtn = byId("btn-disconnect-external-server");
        const summary = byId("external-server-summary");
        const summaryText = byId("external-server-target");
        const isConnected = Boolean(target);
        const isBusy = Boolean(options.busy);

        if (badge) {
            badge.textContent = isBusy ? (options.label || "Connecting") : isConnected ? "Connected" : "Not connected";
            badge.classList.toggle("running", isConnected && !isBusy);
            badge.classList.toggle("working", isBusy);
        }
        if (summaryText) summaryText.textContent = isConnected ? describeTarget(target) : "";
        if (summary) summary.classList.toggle("hidden", !isConnected);
        if (connectBtn) {
            connectBtn.disabled = isBusy;
            connectBtn.textContent = isBusy
                ? "Connecting..."
                : isConnected
                    ? "Reconnect"
                    : "Connect";
        }
        if (disconnectBtn) {
            disconnectBtn.classList.toggle("hidden", !isConnected);
            disconnectBtn.disabled = isBusy;
        }

        // Only prefill from the registered target, never overwrite what the
        // user is in the middle of typing.
        const hostInput = byId("external-server-host");
        const portInput = byId("external-server-port");
        if (isConnected && options.syncInputs) {
            if (hostInput && !dirtyAddressFields.has("external-server-host")) {
                hostInput.value = target.host;
            }
            if (portInput && !dirtyAddressFields.has("external-server-port")) {
                portInput.value = String(target.port);
            }
        }
    }

    function readForm() {
        const host = String(byId("external-server-host")?.value || "").trim();
        const port = String(byId("external-server-port")?.value || "").trim();
        const apiKey = String(byId("external-server-key")?.value || "");
        return { host: host || "127.0.0.1", port, api_key: apiKey };
    }

    async function connect() {
        const fetchJson = requireDependency("fetchJson");
        const form = readForm();
        if (!form.port) {
            setNote("Enter the port llama-server is listening on.", "error");
            return null;
        }

        render(getTarget(), { busy: true });
        setNote("Checking the server...");
        try {
            const result = await fetchJson("/api/chat/target", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(form),
            });
            const target = result && result.external_chat_target;
            const warning = target && target.warning;
            setNote(warning || `Connected to ${describeTarget(target)}.`, warning ? "warning" : "");
            dirtyAddressFields.clear();
            render(target, { syncInputs: true });
            // A successful connect (even to the same address) starts a fresh
            // inference baseline; the status refresh below then reconciles it.
            if (typeof deps.onExternalTargetChanged === "function") deps.onExternalTargetChanged();
            await refreshDependentPanels();
            return target;
        } catch (error) {
            setNote(error.message, "error");
            render(getTarget());
            return null;
        }
    }

    async function disconnect() {
        const fetchJson = requireDependency("fetchJson");
        render(getTarget(), { busy: true, label: "Disconnecting..." });
        try {
            await fetchJson("/api/chat/target", { method: "DELETE" });
            const keyInput = byId("external-server-key");
            if (keyInput) keyInput.value = "";
            setNote("Disconnected.");
            render(null);
            await refreshDependentPanels();
        } catch (error) {
            setNote(error.message, "error");
            render(getTarget());
        }
    }

    async function refreshDependentPanels() {
        // The registered target reaches the rest of the UI through /api/status,
        // so chat availability and the endpoint list only update once it is
        // re-read.
        if (typeof deps.refreshStatus === "function") {
            try {
                await deps.refreshStatus();
            } catch (error) {
                console.debug("Failed to refresh status after a connection change", error);
            }
        }
    }

    function prefill(remembered) {
        if (!remembered) return;
        const hostInput = byId("external-server-host");
        const portInput = byId("external-server-port");
        if (hostInput && !dirtyAddressFields.has("external-server-host")) {
            hostInput.value = remembered.host;
        }
        if (portInput && !dirtyAddressFields.has("external-server-port")) {
            portInput.value = String(remembered.port);
        }
    }

    async function restore(options = {}) {
        const fetchJson = requireDependency("fetchJson");
        if (!options.preserveDrafts) dirtyAddressFields.clear();
        let state = null;
        try {
            state = await fetchJson("/api/chat/target");
        } catch (error) {
            console.debug("Failed to read the chat target", error);
            return null;
        }

        const active = state && state.external_chat_target;
        const remembered = state && state.remembered_target;
        if (active) {
            render(active, { syncInputs: true });
            return active;
        }

        prefill(remembered);
        render(null);
        if (!remembered) return null;

        if (remembered.api_key_required) {
            // The key was never stored, so this is the one case the user has to
            // finish by hand. Say why rather than silently failing to connect.
            setNote(
                `Re-enter the API key for ${describeTarget(remembered)} to reconnect.`,
                "warning"
            );
            return null;
        }

        render(null, { busy: true });
        try {
            const result = await fetchJson("/api/chat/target", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ restore: true }),
            });
            const target = result && result.external_chat_target;
            if (!target) {
                render(null);
                return null;
            }
            setNote(`Reconnected to ${describeTarget(target)}.`);
            render(target);
            // A restored connection is a fresh inference target even when the
            // address did not change.
            if (typeof deps.onExternalTargetChanged === "function") deps.onExternalTargetChanged();
            await refreshDependentPanels();
            return target;
        } catch (error) {
            setNote(`${describeTarget(remembered)} did not answer: ${error.message}`, "error");
            render(null);
            return null;
        }
    }

    function refresh() {
        render(getTarget(), { syncInputs: true });
    }

    function init() {
        const connectBtn = byId("btn-connect-external-server");
        const disconnectBtn = byId("btn-disconnect-external-server");
        if (!connectBtn || !disconnectBtn) return;

        const keyInput = byId("external-server-key");
        if (keyInput && window.LlamaGui.configFlagsUi) {
            window.LlamaGui.configFlagsUi.initializeSensitiveTextInput(keyInput);
        }

        connectBtn.addEventListener("click", connect);
        disconnectBtn.addEventListener("click", disconnect);
        for (const id of ["external-server-host", "external-server-port", "external-server-key"]) {
            const input = byId(id);
            if (!input) continue;
            if (id !== "external-server-key") {
                input.addEventListener("input", () => dirtyAddressFields.add(id));
            }
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    connect();
                }
            });
        }
        refresh();
        restore({ preserveDrafts: true })
            .catch((error) => console.debug("Failed to restore the saved chat target", error));
    }

    window.LlamaGui = window.LlamaGui || {};
    window.LlamaGui.externalServerUi = {
        configure,
        init,
        refresh,
        render,
        restore,
        getTarget,
        describeTarget,
        connect,
        disconnect,
    };
})();
