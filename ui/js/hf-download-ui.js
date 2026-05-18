(function () {
    "use strict";

    const HF_DOWNLOAD_POLL_MAX_FAILS = 5;
    const HF_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

    let hfDownloadTimer = null;
    let hfDownloadFailCount = 0;
    let hfDownloadStartTime = null;
    let deps = {};

    function requireDependency(name) {
        const value = deps[name];
        if (typeof value !== "function") {
            throw new Error(`Hugging Face downloader dependency missing: ${name}`);
        }
        return value;
    }

    function configure(nextDeps) {
        deps = Object.assign({}, deps, nextDeps || {});
    }

    function formatHfBytes(bytes) {
        const value = Number(bytes || 0);
        if (!value) return "unknown size";
        if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
        return `${(value / 1048576).toFixed(1)} MB`;
    }

    function showStatus(type, message) {
        const el = document.getElementById("hf-download-status");
        if (!el) return;
        el.className = "hf-download-status" + (type ? " " + type : "");
        el.textContent = message || "";
    }

    function setBusy(isBusy) {
        const findBtn = document.getElementById("btn-hf-find-files");
        const downloadBtn = document.getElementById("btn-hf-download");
        const cancelBtn = document.getElementById("btn-hf-cancel");
        if (findBtn) findBtn.disabled = isBusy;
        if (downloadBtn) downloadBtn.disabled = isBusy;
        if (cancelBtn) cancelBtn.classList.toggle("hidden", !isBusy);
    }

    function updateProgress(prog) {
        const wrap = document.getElementById("hf-download-progress");
        const fill = document.getElementById("hf-progress-fill");
        const text = document.getElementById("hf-progress-text");
        if (!wrap || !fill || !text) return;

        const status = String(prog.status || "");
        const active = ["starting", "downloading", "cancelling"].includes(status);
        wrap.classList.toggle("hidden", !active && status !== "done");

        if (prog.total > 0) {
            const pct = Math.min(100, Math.round((prog.downloaded / prog.total) * 100));
            fill.style.width = pct + "%";
            text.textContent = `${prog.current_file || "Downloading"} ${pct}% (${formatHfBytes(prog.downloaded)} / ${formatHfBytes(prog.total)})`;
        } else {
            fill.style.width = active ? "25%" : "100%";
            text.textContent = prog.message || status || "Working...";
        }
    }

    function populateFileSelect(select, files, placeholder) {
        if (!select) return;
        select.innerHTML = "";
        const first = document.createElement("option");
        first.value = "";
        first.textContent = placeholder;
        select.appendChild(first);
        for (const file of files || []) {
            const opt = document.createElement("option");
            opt.value = file.name;
            opt.textContent = `${file.name}  (${formatHfBytes(file.size)})`;
            select.appendChild(opt);
        }
    }

    async function findFiles() {
        const fetchJson = requireDependency("fetchJson");
        const repoInput = document.getElementById("hf-repo-input");
        const revisionInput = document.getElementById("hf-revision-input");
        const tokenInput = document.getElementById("hf-token-input");
        const options = document.getElementById("hf-file-options");
        const modelSelect = document.getElementById("hf-model-file-select");
        const mmprojSelect = document.getElementById("hf-mmproj-file-select");
        const mmprojGroup = document.getElementById("hf-mmproj-group");
        if (!repoInput || !modelSelect || !mmprojSelect) return;

        const repoId = repoInput.value.trim();
        if (!repoId) {
            showStatus("warning", "Enter a Hugging Face repo ID first.");
            return;
        }

        showStatus("info", "Looking for GGUF files...");
        setBusy(true);
        try {
            const result = await fetchJson("/api/hf/repo-files", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo_id: repoId,
                    revision: revisionInput && revisionInput.value.trim() ? revisionInput.value.trim() : "main",
                    token: tokenInput ? tokenInput.value.trim() : "",
                }),
            });
            populateFileSelect(modelSelect, result.models || [], "-- Select model file --");
            populateFileSelect(mmprojSelect, result.mmproj || [], "None");
            if (result.models && result.models.length === 1) modelSelect.value = result.models[0].name;
            if (mmprojGroup) mmprojGroup.classList.toggle("hidden", !(result.mmproj && result.mmproj.length));
            if (options) options.classList.remove("hidden");
            const modelCount = (result.models || []).length;
            const mmprojCount = (result.mmproj || []).length;
            showStatus(
                modelCount ? "success" : "warning",
                modelCount
                    ? `Found ${modelCount} model file${modelCount === 1 ? "" : "s"}${mmprojCount ? ` and ${mmprojCount} mmproj companion${mmprojCount === 1 ? "" : "s"}` : ""}.`
                    : "No launchable GGUF model files were found in this repo."
            );
        } catch (e) {
            if (options) options.classList.add("hidden");
            showStatus("error", "Hugging Face lookup failed: " + e.message);
        } finally {
            setBusy(false);
        }
    }

    async function startDownload(overwrite = false) {
        const fetchJson = requireDependency("fetchJson");
        const confirmAction = requireDependency("confirmAction");
        const repoInput = document.getElementById("hf-repo-input");
        const revisionInput = document.getElementById("hf-revision-input");
        const tokenInput = document.getElementById("hf-token-input");
        const modelSelect = document.getElementById("hf-model-file-select");
        const mmprojSelect = document.getElementById("hf-mmproj-file-select");
        if (!repoInput || !modelSelect) return;

        const modelFile = modelSelect.value;
        if (!modelFile) {
            showStatus("warning", "Choose a model file to download.");
            return;
        }

        showStatus("info", "Starting download...");
        setBusy(true);
        try {
            await fetchJson("/api/hf/download", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo_id: repoInput.value.trim(),
                    revision: revisionInput && revisionInput.value.trim() ? revisionInput.value.trim() : "main",
                    token: tokenInput ? tokenInput.value.trim() : "",
                    model_file: modelFile,
                    mmproj_file: mmprojSelect ? mmprojSelect.value : "",
                    overwrite,
                }),
            });
            pollProgress();
        } catch (e) {
            setBusy(false);
            if (e.message && e.message.startsWith("Already exists:")) {
                const ok = await confirmAction(`${e.message}. Replace the existing file?`);
                if (ok) {
                    startDownload(true);
                    return;
                }
            }
            showStatus("error", "Download failed to start: " + e.message);
        }
    }

    async function finishDownload(prog) {
        const refreshModels = requireDependency("refreshModels");
        const applyPresetModel = requireDependency("applyPresetModel");
        const refreshQuickLaunchUI = requireDependency("refreshQuickLaunchUI");
        const flagCore = deps.flagCore;

        showStatus("success", prog.message || "Download complete.");
        setBusy(false);
        await refreshModels();
        if (prog.model_name) {
            applyPresetModel(prog.model_name);
        }
        if (prog.mmproj_path && flagCore && typeof flagCore.setPathFlagValue === "function") {
            flagCore.setPathFlagValue("mmproj", prog.mmproj_path);
        }
        if (flagCore && typeof flagCore.updateCommandPreview === "function") {
            flagCore.updateCommandPreview();
        }
        refreshQuickLaunchUI();
    }

    async function refreshStatus() {
        const fetchJson = requireDependency("fetchJson");
        try {
            const prog = await fetchJson("/api/hf/download-status");
            updateProgress(prog);

            const status = String(prog.status || "");
            const active = ["starting", "downloading", "cancelling"].includes(status);
            setBusy(active);

            if (prog.message) {
                const type = status === "error"
                    ? "error"
                    : status === "cancelled"
                        ? "warning"
                        : status === "done"
                            ? "success"
                            : "info";
                showStatus(type, prog.message);
            }

            if (active) {
                pollProgress();
            }
        } catch (e) {
            // Ignore initial status read failures; the panel remains available for manual use.
        }
    }

    function clearPollTimer() {
        if (hfDownloadTimer) clearInterval(hfDownloadTimer);
        hfDownloadTimer = null;
    }

    function pollProgress() {
        const fetchJson = requireDependency("fetchJson");
        clearPollTimer();
        hfDownloadFailCount = 0;
        hfDownloadStartTime = Date.now();
        hfDownloadTimer = setInterval(async () => {
            if (Date.now() - hfDownloadStartTime > HF_DOWNLOAD_TIMEOUT_MS) {
                clearPollTimer();
                setBusy(false);
                showStatus("error", "Download timed out. The server may have stopped responding.");
                return;
            }
            try {
                const prog = await fetchJson("/api/hf/download-status");
                hfDownloadFailCount = 0;
                updateProgress(prog);
                if (prog.status === "done") {
                    clearPollTimer();
                    await finishDownload(prog);
                } else if (["error", "cancelled"].includes(prog.status)) {
                    clearPollTimer();
                    setBusy(false);
                    showStatus(prog.status === "cancelled" ? "warning" : "error", prog.message || "Download stopped.");
                }
            } catch (e) {
                hfDownloadFailCount++;
                if (hfDownloadFailCount >= HF_DOWNLOAD_POLL_MAX_FAILS) {
                    clearPollTimer();
                    setBusy(false);
                    showStatus("error", "Lost contact with the server during download. The download may still be in progress - try restarting Llama GUI.");
                }
            }
        }, 500);
    }

    async function cancelDownload() {
        const fetchJson = requireDependency("fetchJson");
        try {
            await fetchJson("/api/hf/download-cancel", { method: "POST" });
            showStatus("warning", "Cancelling download...");
        } catch (e) {
            showStatus("error", "Failed to cancel download: " + e.message);
        }
    }

    function init() {
        const on = (id, event, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, handler);
        };

        refreshStatus();
        on("btn-hf-find-files", "click", findFiles);
        on("btn-hf-download", "click", () => startDownload(false));
        on("btn-hf-cancel", "click", cancelDownload);
    }

    window.LlamaGui = window.LlamaGui || {};
    window.LlamaGui.hfDownloadUi = {
        configure,
        init,
        formatHfBytes,
        showStatus,
        setBusy,
        updateProgress,
        populateFileSelect,
        findFiles,
        startDownload,
        finishDownload,
        refreshStatus,
        pollProgress,
        cancelDownload,
    };
})();
