// Active model-directory controls and folder-operation state.
(() => {
    const I = window.LlamaGui._managerInternal;

    let modelDirControlsInitialized = false;
    let modelDirChangeInProgress = false;
    let modelDirOperationError = "";

    function renderModelDirInfo(info) {
        for (const prefix of ["", "quick-"]) {
            const pathEl = document.getElementById(prefix + "models-folder-path");
            const changeBtn = document.getElementById("btn-" + prefix + "change-models-folder");
            const resetBtn = document.getElementById("btn-" + prefix + "reset-models-folder");
            const errorEl = document.getElementById(prefix + "models-folder-error");
            if (pathEl) pathEl.textContent = info && info.models_dir ? info.models_dir : "Loading...";
            if (changeBtn) changeBtn.disabled = modelDirChangeInProgress;
            if (resetBtn) {
                resetBtn.hidden = !info || info.models_dir_is_default === true;
                resetBtn.disabled = modelDirChangeInProgress;
            }
            if (errorEl) {
                const unavailableError = info && info.models_dir_available === false
                    ? String(info.models_dir_error || "Models folder is unavailable.")
                    : "";
                const message = modelDirOperationError || unavailableError;
                errorEl.textContent = message;
                errorEl.className = message ? "status-box error" : "status-box hidden";
            }
        }
    }

    function applyModelDirInfo(info) {
        const core = window.LlamaGui && window.LlamaGui.flagCore;
        if (core && typeof core.setModelDirInfo === "function") {
            core.setModelDirInfo(info);
            if (typeof core.updateCommandPreview === "function") core.updateCommandPreview();
        }
        renderModelDirInfo(info);
    }

    async function persistModelsDir(path) {
        let postedInfo = null;
        let displayInfo = I.status.getLatestStatus();
        const statusBeforeSave = I.status.getLatestStatus();
        modelDirChangeInProgress = true;
        renderModelDirInfo(I.status.getLatestStatus());
        try {
            postedInfo = await I.dependencies.fetchJson("/api/models-dir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });
            displayInfo = postedInfo;
            applyModelDirInfo(postedInfo);
            const status = await I.status.checkStatus();
            if (status) {
                displayInfo = status;
            } else if (I.status.getLatestStatus() && I.status.getLatestStatus() !== statusBeforeSave) {
                displayInfo = I.status.getLatestStatus();
            }
            if (await I.models.refreshModels() !== true) {
                throw new Error("The folder was saved, but its models could not be refreshed.");
            }
            const core = window.LlamaGui && window.LlamaGui.flagCore;
            if (core && typeof core.updateCommandPreview === "function") core.updateCommandPreview();
            modelDirOperationError = "";
            if (typeof I.dependencies.showToast === "function") I.dependencies.showToast("Models folder updated.", "success");
            return true;
        } catch (error) {
            const core = window.LlamaGui && window.LlamaGui.flagCore;
            if (!postedInfo) {
                if (core && typeof core.setModelDirInfo === "function") core.setModelDirInfo(null);
                if (core && typeof core.updateCommandPreview === "function") core.updateCommandPreview();
            }
            modelDirOperationError = error && error.message ? error.message : "Could not update the models folder.";
            renderModelDirInfo(displayInfo || I.status.getLatestStatus());
            if (typeof I.dependencies.showToast === "function") I.dependencies.showToast(modelDirOperationError, "error");
            return false;
        } finally {
            modelDirChangeInProgress = false;
            renderModelDirInfo(displayInfo || I.status.getLatestStatus());
        }
    }

    async function chooseModelsDir() {
        let persistStarted = false;
        modelDirChangeInProgress = true;
        renderModelDirInfo(I.status.getLatestStatus());
        try {
            const selection = await I.dependencies.fetchJson("/api/select-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: "Select Models Folder" }),
            });
            if (!selection || !selection.selected) return false;
            persistStarted = true;
            return await persistModelsDir(selection.path);
        } catch (error) {
            modelDirOperationError = error && error.message ? error.message : "Could not open the folder picker.";
            if (typeof I.dependencies.showToast === "function") I.dependencies.showToast(modelDirOperationError, "error");
            return false;
        } finally {
            modelDirChangeInProgress = false;
            if (!persistStarted) renderModelDirInfo(I.status.getLatestStatus());
        }
    }

    function initModelDirControls() {
        if (modelDirControlsInitialized) return;
        modelDirControlsInitialized = true;
        for (const prefix of ["", "quick-"]) {
            const changeBtn = document.getElementById("btn-" + prefix + "change-models-folder");
            const resetBtn = document.getElementById("btn-" + prefix + "reset-models-folder");
            if (changeBtn) changeBtn.addEventListener("click", chooseModelsDir);
            if (resetBtn) resetBtn.addEventListener("click", () => persistModelsDir(null));
        }
        renderModelDirInfo(I.status.getLatestStatus());
    }

    I.modelDir = {
        applyModelDirInfo,
        persistModelsDir,
        chooseModelsDir,
        initModelDirControls,
    };
})();
