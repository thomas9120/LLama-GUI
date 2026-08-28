(function () {
    "use strict";

    const HF_DOWNLOAD_POLL_MAX_FAILS = 5;
    // Give up only after this long with no observable movement. This used to be a
    // flat 30-minute cap on total download time, which a large GGUF on a slow link
    // exceeds legitimately — the UI then declared failure while the backend was
    // still downloading, and polling only resumed on a full page reload.
    const HF_DOWNLOAD_STALL_TIMEOUT_MS = 5 * 60 * 1000;

    let hfDownloadTimer = null;
    let hfDownloadFailCount = 0;
    let hfDownloadLastProgressAt = null;
    let hfDownloadLastFingerprint = "";
    let hfDownloadPollInFlight = false;
    let deps = {};

    // Both sources share the download-status/cancel endpoints and the same
    // progress state machine on the backend; only listing and starting differ.
    const DOWNLOAD_SOURCES = {
        hf: { repoFiles: "/api/hf/repo-files", download: "/api/hf/download" },
        ms: { repoFiles: "/api/ms/repo-files", download: "/api/ms/download" },
    };
    const SOURCE_LABELS = { hf: "Hugging Face", ms: "ModelScope" };

    function selectedSource() {
        const select = document.getElementById("hf-source-select");
        return select && select.value === "ms" ? "ms" : "hf";
    }

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
        // The backend keeps reporting downloaded == total after finishing and
        // clears current_file — without an explicit done branch the bar sits at
        // "Downloading 100%" forever (and again on a reload of a finished run).
        fill.classList.toggle("done", status === "done");

        if (status === "done") {
            fill.style.width = "100%";
            text.textContent = `下载完成（${formatHfBytes(prog.total)}）`;
        } else if (prog.total > 0) {
            const pct = Math.min(100, Math.round((prog.downloaded / prog.total) * 100));
            fill.style.width = pct + "%";
            text.textContent = `${prog.current_file || "下载中"} ${pct}%（${formatHfBytes(prog.downloaded)} / ${formatHfBytes(prog.total)}）`;
        } else {
            fill.style.width = active ? "25%" : "100%";
            text.textContent = prog.message || status || "处理中…";
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
        const source = selectedSource();
        if (!repoId) {
            showStatus("warning", `Enter a ${SOURCE_LABELS[source]} repo ID first.`);
            return;
        }

        showStatus("info", "正在查找 GGUF 文件…");
        setBusy(true);
        try {
            const result = await fetchJson(DOWNLOAD_SOURCES[source].repoFiles, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo_id: repoId,
                    revision: revisionInput && revisionInput.value.trim() ? revisionInput.value.trim() : "main",
                    token: tokenInput ? tokenInput.value.trim() : "",
                }),
            });
            populateFileSelect(modelSelect, result.models || [], "— 请选择模型文件 —");
            populateFileSelect(mmprojSelect, result.mmproj || [], "无");
            if (result.models && result.models.length === 1) modelSelect.value = result.models[0].name;
            if (mmprojGroup) mmprojGroup.classList.toggle("hidden", !(result.mmproj && result.mmproj.length));
            if (options) options.classList.remove("hidden");
            const modelCount = (result.models || []).length;
            const mmprojCount = (result.mmproj || []).length;
            showStatus(
                modelCount ? "success" : "warning",
                modelCount
                    ? `找到 ${modelCount} 个模型文件${mmprojCount ? `，配套 ${mmprojCount} 个 mmproj` : ""}。`
                    : "该仓库没有可启动的 GGUF 模型文件。"
            );
        } catch (e) {
            if (options) options.classList.add("hidden");
            showStatus("error", `${SOURCE_LABELS[source]} lookup failed: ` + e.message);
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

        showStatus("info", "正在开始下载…");
        setBusy(true);
        try {
            await fetchJson(DOWNLOAD_SOURCES[selectedSource()].download, {
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
            if (e.message && e.message.startsWith("已存在：")) {
                const ok = await confirmAction(`${e.message}，要替换现有文件吗？`);
                if (ok) {
                    startDownload(true);
                    return;
                }
                showStatus("info", "已取消下载，保留现有文件。");
                return;
            }
            showStatus("error", "下载启动失败：" + e.message);
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
            console.debug("HF download status read failed", e);
        }
    }

    function clearPollTimer() {
        if (hfDownloadTimer) clearInterval(hfDownloadTimer);
        hfDownloadTimer = null;
        hfDownloadPollInFlight = false;
    }

    // Anything that changes while a download is healthy. Byte counts move on every
    // chunk; current_file also moves when a multi-file download advances between
    // files at a byte boundary.
    function progressFingerprint(prog) {
        if (!prog || typeof prog !== "object") return "";
        return [prog.status, prog.current_file, prog.downloaded, prog.total].join("|");
    }

    function pollProgress() {
        const fetchJson = requireDependency("fetchJson");
        clearPollTimer();
        hfDownloadFailCount = 0;
        hfDownloadLastProgressAt = Date.now();
        hfDownloadLastFingerprint = "";
        hfDownloadTimer = setInterval(async () => {
            if (hfDownloadPollInFlight) return;
            hfDownloadPollInFlight = true;
            try {
                const prog = await fetchJson("/api/hf/download-status");
                hfDownloadFailCount = 0;

                // Any observable movement resets the deadline, so a slow but
                // healthy download is never cut off for taking a long time.
                const fingerprint = progressFingerprint(prog);
                if (fingerprint !== hfDownloadLastFingerprint) {
                    hfDownloadLastFingerprint = fingerprint;
                    hfDownloadLastProgressAt = Date.now();
                }

                updateProgress(prog);
                if (prog.status === "done") {
                    clearPollTimer();
                    await finishDownload(prog);
                } else if (["error", "cancelled"].includes(prog.status)) {
                    clearPollTimer();
                    setBusy(false);
                    showStatus(prog.status === "cancelled" ? "warning" : "error", prog.message || "下载已停止。");
                } else if (Date.now() - hfDownloadLastProgressAt > HF_DOWNLOAD_STALL_TIMEOUT_MS) {
                    clearPollTimer();
                    setBusy(false);
                    showStatus(
                        "error",
                        "下载已数分钟没有进展。服务器上可能仍在继续——"
                        + "刷新页面可重新接上进度。"
                    );
                }
            } catch (e) {
                hfDownloadFailCount++;
                if (hfDownloadFailCount >= HF_DOWNLOAD_POLL_MAX_FAILS) {
                    clearPollTimer();
                    setBusy(false);
                    showStatus("error", "下载期间与服务器失去联系。下载可能仍在进行——尝试重启 Llama GUI。");
                }
            } finally {
                hfDownloadPollInFlight = false;
            }
        }, 500);
    }

    async function cancelDownload() {
        const fetchJson = requireDependency("fetchJson");
        try {
            await fetchJson("/api/hf/download-cancel", { method: "POST" });
            showStatus("warning", "正在取消下载…");
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

        // Revision/token are Hugging Face concepts; ModelScope ignores them.
        const sourceSelect = document.getElementById("hf-source-select");
        if (sourceSelect) {
            const syncSourceFields = () => {
                const isMs = selectedSource() === "ms";
                for (const id of ["hf-revision-input", "hf-token-input"]) {
                    const el = document.getElementById(id);
                    if (el) el.disabled = isMs;
                }
            };
            syncSourceFields();
            sourceSelect.addEventListener("change", syncSourceFields);
        }
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
