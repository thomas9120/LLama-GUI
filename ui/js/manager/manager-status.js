// Accepted backend status, request generations, and observer reconciliation.
(() => {
    const I = window.LlamaGui._managerInternal;

    let statusRequestId = 0;
    let acceptedStatusObserver = null;
    let latestStatus = null;

    function getLatestStatus() {
        return latestStatus;
    }

    async function checkStatus() {
        const requestId = ++statusRequestId;
        try {
            const status = await I.dependencies.fetchJson("/api/status");
            if (!status || requestId !== statusRequestId) return null;
            latestStatus = status;
            // Feeds the launch-arg gate for build-dependent flags such as native
            // --reasoning-effort (llama.cpp b10434+); custom backends and older
            // installs stay on their compatible fallback path.
            if (window.LlamaGui.flagCore && typeof window.LlamaGui.flagCore.setBinaryTag === "function") {
                window.LlamaGui.flagCore.setBinaryTag(status.version);
            }
            I.modelDir.applyModelDirInfo(status);
            I.backends.updateStatusUI(status);
            await notifyAcceptedStatusObserver(status);
            if (requestId !== statusRequestId) {
                const currentStatus = latestStatus;
                if (currentStatus && currentStatus !== status) {
                    await notifyAcceptedStatusObserver(currentStatus);
                }
                return currentStatus;
            }
            return status;
        } catch (e) {
            if (requestId !== statusRequestId) return null;
            markSelectFailedToLoad("backend-select");
            markSelectFailedToLoad("release-select");
            I.install.showStatus("error", "Could not check installation status: " + e.message);
            return null;
        }
    }

    async function notifyAcceptedStatusObserver(status) {
        if (typeof acceptedStatusObserver !== "function") return;
        try {
            await acceptedStatusObserver(status);
        } catch (observerError) {
            console.warn("Failed to reconcile authoritative process status", observerError);
        }
    }

    function setAcceptedStatusObserver(observer) {
        acceptedStatusObserver = typeof observer === "function" ? observer : null;
    }

    function markSelectFailedToLoad(id) {
        const sel = document.getElementById(id);
        if (!sel) return;
        if (sel.options.length === 0) return;
        const first = sel.options[0];
        if (first && /loading/i.test(first.textContent || "")) {
            sel.innerHTML = '<option value="">Failed to load</option>';
        }
    }

    I.status = {
        getLatestStatus,
        checkStatus,
        setAcceptedStatusObserver,
    };
})();
