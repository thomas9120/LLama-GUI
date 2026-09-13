// Sidebar memory estimates; only schedule() starts work.
(function () {
    "use strict";
    const root = window.LlamaGui = window.LlamaGui || {};

    let deps = {};
    let memoryEstimateRequestId = 0;
    let timer = null;

    function configure(nextDeps) {
        deps = Object.assign({}, deps, nextDeps || {});
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            updateMemoryEstimate();
        }, 700);
    }

    function formatMiB(mib) {
        const value = Number(mib);
        if (!Number.isFinite(value) || value <= 0) return "--";
        if (value >= 1024) return `${(value / 1024).toFixed(value >= 10240 ? 1 : 2)} GB`;
        return `${Math.round(value)} MiB`;
    }

    function setMemoryEstimateState(state, detail, values) {
        const stateEl = document.getElementById("memory-estimate-state");
        const acceleratorEl = document.getElementById("memory-estimate-accelerator");
        const ramEl = document.getElementById("memory-estimate-ram");
        const detailEl = document.getElementById("memory-estimate-detail");
        if (!stateEl || !acceleratorEl || !ramEl || !detailEl) return;

        stateEl.textContent = state;
        stateEl.classList.toggle("is-error", state === "Unavailable");
        stateEl.classList.toggle("is-ready", state === "Ready");
        acceleratorEl.textContent = values ? formatMiB(values.accelerator_mib) : "--";
        ramEl.textContent = values ? formatMiB(values.ram_mib) : "--";
        detailEl.textContent = detail || "";
    }

    function summarizeMemoryEstimate(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return "";
        return rows.map(row => {
            const label = row.device || (row.kind === "ram" ? "Host" : "Device");
            const parts = [];
            if (row.model_mib > 0) parts.push(`model ${formatMiB(row.model_mib)}`);
            if (row.context_mib > 0) parts.push(`ctx ${formatMiB(row.context_mib)}`);
            if (row.compute_mib > 0) parts.push(`compute ${formatMiB(row.compute_mib)}`);
            const breakdown = parts.length ? ` (${parts.join(" · ")})` : "";
            return `${label}: ${formatMiB(row.total_mib)}${breakdown}`;
        }).join("\n");
    }

    async function updateMemoryEstimate() {
        const requestId = ++memoryEstimateRequestId;
        const result = deps.flagCore.getLaunchArgs();
        if (result.error) {
            setMemoryEstimateState("Unavailable", result.error);
            return;
        }
        const args = result.args || [];
        if (!deps.flagCore.hasLaunchModelArg(args)) {
            setMemoryEstimateState("Idle", "Select a model to estimate.");
            return;
        }

        setMemoryEstimateState("Estimating", "Checking current command arguments...");
        try {
            const data = await deps.fetchJson("/api/estimate-memory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tool: deps.flagCore.getCurrentTool(), args }),
            });
            if (requestId !== memoryEstimateRequestId) return;
            if (!data || data.error) {
                setMemoryEstimateState("Unavailable", data?.error || "Memory estimate failed.");
                return;
            }
            const detail = summarizeMemoryEstimate(data.rows) || "Estimate complete.";
            setMemoryEstimateState("Ready", detail, data);
        } catch (e) {
            if (requestId !== memoryEstimateRequestId) return;
            setMemoryEstimateState("Unavailable", e.message || "Memory estimate failed.");
        }
    }

    root.memoryEstimateUi = { configure, schedule };
})();
