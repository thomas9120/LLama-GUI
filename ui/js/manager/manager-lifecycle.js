// GUI-server shutdown, restart, and reconnection (not llama-process lifecycle).
(() => {
    const I = window.LlamaGui._managerInternal;

    async function stopPythonServer() {
        const status = I.status.getLatestStatus() || await I.status.checkStatus();
        const runningHint = status && status.running
            ? " Any running llama.cpp process will be stopped first."
            : "";
        const ok = await I.dependencies.confirmAction(
            "Quit Llama GUI",
            `Quit Llama GUI? The page will disconnect until you start Llama GUI again.${runningHint}`,
            "Quit Llama GUI"
        );
        if (!ok) return;

        const button = document.getElementById("btn-stop-app");
        const sidebarButton = document.getElementById("btn-sidebar-stop-app");
        if (button) button.disabled = true;
        if (sidebarButton) sidebarButton.disabled = true;
        I.install.showStatus("info", "Quitting Llama GUI...");

        try {
            await I.dependencies.fetchJson("/api/shutdown", { method: "POST" });
            I.install.showStatus("success", "Llama GUI is shutting down. This page will stop responding.");
            window.setTimeout(() => {
                window.location.reload();
            }, 1500);
        } catch (e) {
            I.install.showStatus("error", "Failed to quit Llama GUI: " + e.message);
            if (button) button.disabled = false;
            if (sidebarButton) sidebarButton.disabled = false;
        }
    }

    async function restartPythonServer() {
        const status = I.status.getLatestStatus() || await I.status.checkStatus();
        const runningHint = status && status.running
            ? " Any running llama.cpp process will be stopped first."
            : "";
        const ok = await I.dependencies.confirmAction(
            "Restart Llama GUI",
            `Restart Llama GUI? The page will briefly disconnect.${runningHint}`,
            "Restart"
        );
        if (!ok) return;

        await restartPythonServerAndReload({
            button: document.getElementById("btn-restart-app"),
            showStatusFn: I.install.showStatus,
            restartingMessage: "Restarting Llama GUI...",
            reconnectingMessage: "Llama GUI is restarting. Reconnecting...",
            successMessage: "Llama GUI restarted successfully.",
            timeoutMessage: "Server did not become ready in time. Try reloading manually.",
            failurePrefix: "Failed to restart Llama GUI: ",
        });
    }

    async function restartPythonServerAndReload(options = {}) {
        const button = document.getElementById("btn-restart-app");
        const targetButton = options.button || button;
        const showStatusFn = options.showStatusFn || I.install.showStatus;
        if (targetButton) targetButton.disabled = true;
        showStatusFn("info", options.restartingMessage || "Restarting Llama GUI...");

        try {
            await I.dependencies.fetchJson("/api/restart", { method: "POST" });
            showStatusFn("info", options.reconnectingMessage || "Llama GUI is restarting. Reconnecting...");
            const ready = await waitForServerReady(30, 1000);
            if (ready) {
                showStatusFn("success", options.successMessage || "Llama GUI restarted successfully.");
            } else {
                showStatusFn("error", options.timeoutMessage || "Server did not become ready in time. Try reloading manually.");
            }
            window.setTimeout(() => {
                reloadAppWithCacheBust();
            }, 500);
        } catch (e) {
            showStatusFn("error", (options.failurePrefix || "Failed to restart Llama GUI: ") + e.message);
            if (targetButton) targetButton.disabled = false;
        }
    }

    function reloadAppWithCacheBust() {
        const url = new URL(window.location.href);
        url.pathname = "/";
        url.search = "";
        url.hash = "";
        url.searchParams.set("appReload", Date.now().toString());
        window.location.replace(url.toString());
    }

    function clearAppReloadParam() {
        // the timestamp only exists to defeat the cache on the reload it triggered; once the
        // page is up it is dead weight that every later refresh would carry along
        try {
            const url = new URL(window.location.href);
            if (!url.searchParams.has("appReload")) return false;
            url.searchParams.delete("appReload");
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
            return true;
        } catch (e) {
            console.debug("Failed to clear the appReload parameter", e);
            return false;
        }
    }

    async function waitForServerReady(maxRetries, intervalMs) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await I.dependencies.fetchJson("/api/status");
                return true;
            } catch (e) {
                console.debug("Server readiness probe failed", e);
                await new Promise(r => setTimeout(r, intervalMs));
            }
        }
        return false;
    }

    I.lifecycle = {
        stopPythonServer,
        restartPythonServer,
        restartPythonServerAndReload,
        clearAppReloadParam,
        waitForServerReady,
    };
})();
