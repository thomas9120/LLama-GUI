// Manager configuration, idempotent initialization, and public facade assembly.
(() => {
    const I = window.LlamaGui._managerInternal;

    let initialized = false;

    function configure(options = {}) {
        I.dependencies = { ...I.dependencies, ...options };
        if ("onAcceptedStatus" in options) I.status.setAcceptedStatusObserver(options.onAcceptedStatus);
    }

    function init() {
        if (initialized) return;
        initialized = true;
        document.getElementById("btn-install")?.addEventListener("click", I.install.installRelease);
        document.getElementById("btn-update")?.addEventListener("click", I.install.checkForUpdates);
        document.getElementById("btn-repair")?.addEventListener("click", I.install.repairInstall);
        document.getElementById("btn-remove-llama")?.addEventListener("click", I.install.removeLlamaFiles);
        document.getElementById("btn-stop-app")?.addEventListener("click", I.lifecycle.stopPythonServer);
        document.getElementById("btn-restart-app")?.addEventListener("click", I.lifecycle.restartPythonServer);
        document.getElementById("refresh-releases")?.addEventListener("click", () => I.install.fetchReleases(I.backends.selectedBackendId()));
        document.getElementById("backend-select")?.addEventListener("change", I.backends.onBackendChange);
        document.getElementById("btn-open-models")?.addEventListener("click", () => I.install.openFolder("models"));
        document.getElementById("btn-open-llama")?.addEventListener("click", () => I.install.openFolder("llama"));
        document.getElementById("btn-check-app-update")?.addEventListener("click", I.appUpdate.checkAppUpdateStatus);
        document.getElementById("btn-update-app")?.addEventListener("click", I.appUpdate.updateAppFromGitHub);
        document.getElementById("app-update-channel")?.addEventListener("change", I.appUpdate.checkAppUpdateStatus);
        document.getElementById("btn-sidebar-stop-app")?.addEventListener("click", I.lifecycle.stopPythonServer);
        document.getElementById("btn-refresh-models")?.addEventListener("click", () => I.models.refreshModels());
        I.modelDir.initModelDirControls();
        window.addEventListener("beforeunload", I.install.stopInstallProgressPolling);
        I.appUpdate.checkAppUpdateStatus();
    }

    window.LlamaGui.manager = Object.assign(window.LlamaGui.manager || {}, {
        configure,
        init,
        getLatestStatus: I.status.getLatestStatus,
        showStatus: I.install.showStatus,
        clearAppReloadParam: I.lifecycle.clearAppReloadParam,
        fetchJson: window.LlamaGui.apiClient.fetchJson,
        fetchReleases: I.install.fetchReleases,
        checkStatus: I.status.checkStatus,
        setAcceptedStatusObserver: I.status.setAcceptedStatusObserver,
        initModelDirControls: I.modelDir.initModelDirControls,
        chooseModelsDir: I.modelDir.chooseModelsDir,
        persistModelsDir: I.modelDir.persistModelsDir,
        refreshModels: I.models.refreshModels,
        getKnownModelNames: I.models.getKnownModelNames,
        checkAppUpdateStatus: I.appUpdate.checkAppUpdateStatus,
        updateAppFromGitHub: I.appUpdate.updateAppFromGitHub,
        stopInstallProgressPolling: I.install.stopInstallProgressPolling,
    });

    if (window.__LLAMA_GUI_TEST_HOOKS__) {
        window.LlamaGui.manager._test = {
            selectedBackendId: I.backends.selectedBackendId,
            onBackendChange: I.backends.onBackendChange,
            updateStatusUI: I.backends.updateStatusUI,
            canActivateOfficialBackend: I.backends.canActivateOfficialBackend,
            installRelease: I.install.installRelease,
            waitForServerReady: I.lifecycle.waitForServerReady,
            applyModelDirInfo: I.modelDir.applyModelDirInfo,
        };
    }
})();
