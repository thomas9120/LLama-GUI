// Main orchestration, loaded last after all modules: configure()/init() sequencing,
// shared utility injection (showToast, fetchJson), polling engines, and tab wiring.
function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

const manager = window.LlamaGui.manager;
const apiClient = window.LlamaGui.apiClient;
const dialogs = window.LlamaGui.dialogs;
const flagCore = window.LlamaGui.flagCore;
const configFlagsUi = window.LlamaGui.configFlagsUi;
const themeUi = window.LlamaGui.themeUi;
// Chat-template mapping and mutation rules live in their own module; configure()
// only stores dependencies, so this stays inert on the detached Chat page.
const chatTemplateSelection = window.LlamaGui.chatTemplateSelection;
chatTemplateSelection.configure({ flagCore });
// A detached page keeps the shared module declarations available, but must not
// create the main page's cursor, defaults, or polling engines.
const processOutputCursor = window.LlamaGui.chatWindow?.isDetachedView?.() === true
    ? null : window.LlamaGui.outputCursor.create(appendOutput);
if (window.LlamaGui.chatWindow?.isDetachedView?.() !== true) {
    flagCore.setCurrentToolValue("llama-server");
    flagCore.replaceFlagValues(getDefaultValues());
}
let outputTimer = null;
let inferenceTimer = null;
let inferenceInitialTimer = null;
let statsEpoch = 0;
let statsActiveEpoch = null;
let statsAbortController = null;
let memoryEstimateRequestId = 0;
let pollOutputActiveEpoch = null;
let pollOutputFailCount = 0;
const TOAST_MAX_VISIBLE = 5;
const DEFAULT_TOAST_DURATION_MS = 4000;
// Slow-load warning outlives default toasts: the model may still come up.
const SLOW_LOAD_WARNING_TOAST_MS = 10000;
// Server-ready toast lingers a little longer so its Monitor shortcut is usable.
const SERVER_READY_TOAST_MS = 8000;

const monitorUi = window.LlamaGui.monitorUi;
// One shared inference snapshot feeds the fixed stats bar and the Monitor
// Inference card. app.js owns the single polling cycle; the engine owns the
// target-keyed baselines, rate samples, and per-source availability.
const inferenceStats = window.LlamaGui.chatWindow?.isDetachedView?.() === true
    ? null : window.LlamaGui.inferenceStats.createInferenceStats({ onSnapshot: renderInferenceViews });
let statsDocumentVisible = window.LlamaGui.chatWindow?.isDetachedView?.() !== true;
let externalTargetRevision = 0;
const scheduleMemoryEstimate = debounce(updateMemoryEstimate, 700);
// Shared Quick Launch and sampler data is defined in app-data.js.
const apiTab = window.LlamaGui.apiTab;
if (window.LlamaGui.chatWindow?.isDetachedView?.() !== true) {
apiTab.configure({
    flagCore,
    copyText,
    getLatestStatus: manager.getLatestStatus,
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
});
}
const {
    getServerBaseUrl,
    getServerEndpointConfig,
    getApiAuthorizationHeaders,
} = apiTab;
const initApiTab = apiTab.init;
const updateApiEndpoints = apiTab.updateEndpoints;
const chatUi = window.LlamaGui.chatUi;
const samplerPresets = window.LlamaGui.samplerPresets;
const quickLaunchUi = window.LlamaGui.quickLaunchUi;
const benchmarkUi = window.LlamaGui.benchmarkUi;
const processLifecycle = window.LlamaGui.processLifecycle;
const modelSwitchUi = window.LlamaGui.modelSwitchUi;
const presetsApi = window.LlamaGui.presets;
const remoteTunnelUi = window.LlamaGui.remoteTunnelUi;
const externalServerUi = window.LlamaGui.externalServerUi;
const hfDownloadUi = window.LlamaGui.hfDownloadUi;
if (window.LlamaGui.chatWindow?.isDetachedView?.() !== true) {
samplerPresets.configure({
    flagCore,
    getFlags: () => FLAGS,
    getDefaultFlagValues: getDefaultValues,
    confirmAction: dialogs.confirmAction,
    promptAction: dialogs.promptAction,
    showToast,
    refreshSamplerPresetSelect: (preferredValue) => quickLaunchUi.refreshSamplerPresetSelect(preferredValue),
});
manager.configure({
    fetchJson: apiClient.fetchJson,
    confirmAction: dialogs.confirmAction,
    showToast,
    syncQuickLaunchModelOptions,
    onModelPresenceChanged: () => presetsApi.refreshModelPresence(),
    onAcceptedStatus: reconcileAuthoritativeStatus,
});
presetsApi.configure({
    fetchJson: apiClient.fetchJson,
    confirmAction: dialogs.confirmAction,
    promptAction: dialogs.promptAction,
    showToast,
    switchTab,
});
remoteTunnelUi.configure({
    fetchJson: apiClient.fetchJson,
    copyText,
    getServerEndpointConfig,
});
externalServerUi.configure({
    fetchJson: apiClient.fetchJson,
    getLatestStatus: manager.getLatestStatus,
    refreshStatus: refreshRuntimeStatusPanels,
    onExternalTargetChanged: markExternalTargetChanged,
});
hfDownloadUi.configure({
    flagCore,
    fetchJson: apiClient.fetchJson,
    confirmAction: dialogs.confirmAction,
    refreshModels: manager.refreshModels,
    applyPresetModel,
    refreshQuickLaunchUI,
});
quickLaunchUi.configure({
    flagCore,
    presets: presetsApi,
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
    getLatestStatus: manager.getLatestStatus,
    configFlagsUi,
    hfDownloadUi,
    debounce,
    refreshModels: manager.refreshModels,
    applyPresetModel,
    switchTab,
    launchLlama,
    stopLlama,
    copyQuickServerUrl: () => copyServerUrl("quick-server-url"),
    updateQuickServerAddressPreview,
    setChatTemplateValue: chatTemplateSelection.setChatTemplateValue,
    getSelectedChatTemplateDropdownValue: chatTemplateSelection.getSelectedChatTemplateDropdownValue,
    getQuickTemplateSummaryText: chatTemplateSelection.getQuickTemplateSummaryText,
    getAllSamplerPresets: samplerPresets.getAllSamplerPresets,
    applySamplerPresetValues: samplerPresets.applySamplerPresetValues,
    loadSamplerPresetStore: samplerPresets.loadSamplerPresetStore,
    saveSamplerPresetStore: samplerPresets.saveSamplerPresetStore,
    normalizeSamplerPresetValues: samplerPresets.normalizeSamplerPresetValues,
    collectSamplerValues: samplerPresets.collectSamplerValues,
    isSamplerPresetNameTaken: samplerPresets.isSamplerPresetNameTaken,
    saveSamplerPreset: samplerPresets.saveSamplerPreset,
    renameSamplerPreset: samplerPresets.renameSamplerPreset,
    getSamplerRenameMessage: samplerPresets.getSamplerRenameMessage,
    confirmAction: dialogs.confirmAction,
    promptAction: dialogs.promptAction,
    showToast,
    hasLaunchModelArg: flagCore.hasLaunchModelArg,
});
benchmarkUi.configure({
    flagCore,
    fetchJson: apiClient.fetchJson,
    showToast,
    getFlags: () => FLAGS,
    getDefaultFlagValues: getDefaultValues,
    getLatestStatus: manager.getLatestStatus,
    refreshRuntimeStatusPanels,
    processLifecycle,
});
monitorUi.configure({
    fetchJson: apiClient.fetchJson,
    copyText,
    showToast,
    invalidateCursor: () => processOutputCursor.invalidate(),
    resetStatsBaseline: () => snapshotStatsBaseline(),
    getInferenceSnapshot: () => inferenceStats.getSnapshot(),
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
    getLatestStatus: manager.getLatestStatus,
    compareLaunchSettings: runtime => flagCore.compareLaunchSettings(runtime),
    switchTab,
    reviewLaunchChanges: () => configFlagsUi.openLaunchComparison(),
});
processLifecycle.configure({
    fetchJson: apiClient.fetchJson,
    refreshStatus: () => apiClient.fetchJson("/api/status"),
    buildLaunchRequest: buildManualLaunchRequest,
    abortChat: async () => {
        const stopped = typeof window.LlamaGui.chatWindow?.abortActiveStream === "function"
            ? await window.LlamaGui.chatWindow.abortActiveStream()
            : await chatUi.abortActiveStream();
        if (stopped === false) throw new Error("The active Chat stream could not be stopped.");
        return stopped;
    },
    invalidateOutput: stopOutputPolling,
    invalidateStats: stopStatsPolling,
    startOutput: handleLifecycleProcessStarted,
    startStats: startStatsPolling,
    postReady: handleLifecycleReady,
    onFailed: handleLifecycleFailure,
    onSlowLoad: handleLifecycleSlowLoad,
});
modelSwitchUi.configure({
    fetchPresetEntries: fetchModelSwitcherPresetEntries,
    findPresetByName: presetsApi.findPresetByName,
    getAssignments: modelSwitchUi.getAssignments,
    getAssignmentIssues: modelSwitchUi.getAssignmentIssues,
    getStorageStatus: modelSwitchUi.getStorageStatus,
    getLatestBackendStatus: manager.getLatestStatus,
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
    getPresetFingerprint: entry => entry && entry.preset_fingerprint || "",
    switchSlot: switchModelSlot,
});
processLifecycle.subscribe(handleLifecycleSnapshot);
}

function syncUiAfterToolChange(nextTool) {
    const toolSel = document.getElementById("tool-select");
    if (toolSel && toolSel.value !== nextTool) {
        toolSel.value = nextTool;
    }

    configFlagsUi.resetOpenCategories();
    configFlagsUi.renderFlags();
    flagCore.updateCommandPreview();
    window.LlamaGui.chatWindow?.notifyHostChange?.({ type: "settings", fields: ["tool"] });
}

function syncUiAfterSharedStateChange(options) {
    configFlagsUi.restoreFlagInputs(options);
    restoreCustomLaunchArgsInput();
    flagCore.updateCommandPreview();
    refreshChatSidebarUI();
    window.LlamaGui.chatWindow?.notifyHostChange?.({
        type: "settings",
        fields: options && Array.isArray(options.fields) ? options.fields : undefined,
    });
}

async function fetchModelSwitcherPresetEntries() {
    const entries = await presetsApi.fetchPresetEntries();
    const assignments = modelSwitchUi.getAssignments();
    const assignedNames = new Set([
        assignments.slots.a.preset,
        assignments.slots.b.preset,
    ].filter(Boolean));
    return Promise.all(entries.map(async entry => {
        const normalized = presetsApi.normalizePresetData(entry && entry.data);
        let presetFingerprint = "";
        if (assignedNames.has(String(entry && entry.name || ""))) {
            try {
                const result = await apiClient.fetchJson("/api/presets/fingerprint", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fingerprint_data: normalized }),
                });
                presetFingerprint = String(result && result.preset_fingerprint || "");
            } catch (error) {
                console.debug("Could not fingerprint Model Switcher preset", error);
            }
        }
        return Object.assign({}, entry, { preset_fingerprint: presetFingerprint });
    }));
}

async function resolveModelSwitchTarget(slotId) {
    const assignments = modelSwitchUi.getAssignments();
    const presetName = assignments.slots[slotId] && assignments.slots[slotId].preset;
    if (!presetName) throw new Error(`Model ${slotId.toUpperCase()} is not assigned.`);

    const entries = await presetsApi.fetchPresetEntries();
    const entry = presetsApi.findPresetByName(entries, presetName);
    if (!entry) throw new Error(`Preset "${presetName}" no longer exists.`);
    if (!entry.full) throw new Error(`Preset "${presetName}" is not a full launcher preset.`);
    if (entry.data.tool !== "llama-server") throw new Error(`Preset "${presetName}" does not use llama-server.`);

    const presetData = presetsApi.normalizePresetData(entry.data);
    const prepared = presetsApi.preparePresetLaunchState(presetData, { preserveApiKey: true });
    const launch = flagCore.buildLaunchArgs(prepared);
    const launchSettings = flagCore.captureLaunchSettings(prepared);
    if (launch.error) throw new Error(launch.error);
    if (!flagCore.hasLaunchModelArg(launch.args)) throw new Error(`Preset "${presetName}" has no model source.`);

    const preflight = await apiClient.fetchJson("/api/launch/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            tool: "llama-server",
            args: launch.args,
            fingerprint_data: presetData,
        }),
    });
    if (!preflight || !preflight.ok || !preflight.preset_fingerprint) {
        throw new Error("The target preset could not be validated.");
    }

    return {
        tool: "llama-server",
        args: launch.args,
        launch_settings: launchSettings,
        launch_context: {
            source: "model-switcher",
            slot: slotId,
            preset: presetName,
            preset_fingerprint: preflight.preset_fingerprint,
        },
        presetData,
        presetName,
        slotId,
    };
}

function getRuntimeDisplayLabel(runtime) {
    if (!runtime) return "";
    return String(runtime.alias || runtime.preset || runtime.model || "local model");
}

async function switchModelSlot(slotId) {
    const previousRuntime = processLifecycle.getSnapshot().activeRuntime
        || manager.getLatestStatus()?.active_runtime
        || null;
    const outcome = await processLifecycle.switchRuntime({
        slot: slotId,
        resolveTarget: resolveModelSwitchTarget,
        invalidateOutput: stopOutputPolling,
        startOutput: (...args) => {
            clearOutput();
            handleLifecycleProcessStarted(...args);
        },
        applyTarget: target => {
            presetsApi.applyPresetData(target.presetData, { preserveApiKey: true });
            syncUiAfterSharedStateChange({ force: true });
        },
    });
    if (outcome.ok && previousRuntime && outcome.runtime) {
        chatUi.addModelTransitionDivider(
            getRuntimeDisplayLabel(previousRuntime),
            getRuntimeDisplayLabel(outcome.runtime)
        );
    } else if (!outcome.ok && outcome.status && outcome.status.running && !outputTimer) {
        resumeRuntimePolling(outcome.status);
    }
    return outcome;
}

function resumeRuntimePolling(status) {
    const runtime = status && status.active_runtime;
    if (!runtime) return;
    startOutputPolling();
    if (runtime.tool === "llama-server") startStatsPolling(runtime);
}

function setCustomLaunchArgsMessages(result = {}) {
    const status = document.getElementById("custom-launch-args-status");
    if (!status) return;

    status.textContent = "";
    status.className = "custom-args-status";

    if (result.error) {
        status.textContent = result.error;
        status.classList.add("error");
        return;
    }

    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        status.textContent = result.warnings.join(" ");
        status.classList.add("warning");
    }
}

function restoreCustomLaunchArgsInput() {
    const textarea = document.getElementById("custom-launch-args");
    if (!textarea) return;
    const value = flagCore.getFlagValues().custom_args;
    const nextValue = value !== undefined && value !== null ? String(value) : "";
    if (textarea.value !== nextValue) {
        textarea.value = nextValue;
    }
}

function initCustomLaunchArgsControls() {
    const textarea = document.getElementById("custom-launch-args");
    if (!textarea) return;
    textarea.addEventListener("input", () => {
        flagCore.setFlagValue("custom_args", textarea.value.trim() ? textarea.value : undefined);
    });
    restoreCustomLaunchArgsInput();
}

if (window.LlamaGui.chatWindow?.isDetachedView?.() !== true) {
configFlagsUi.configure({
    debounce,
    fetchJson: apiClient.fetchJson,
    getFlagsByCategory,
    getFlags: () => FLAGS,
    switchTab,
    createSamplerPresetControls: samplerPresets.createSamplerPresetControls,
    refreshQuickLaunchUI,
    browseForPathFlag,
    showStatus: manager.showStatus,
    setChatTemplateValue: chatTemplateSelection.setChatTemplateValue,
    getSelectedChatTemplateDropdownValue: chatTemplateSelection.getSelectedChatTemplateDropdownValue,
    copyText,
    showToast,
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
    getLatestStatus: manager.getLatestStatus,
    processLifecycle,
    buildLaunchRequest: buildManualLaunchRequest,
    resumeRuntimePolling,
});

flagCore.configure({
    getDefaultFlagValues: getDefaultValues,
    getFlags: () => FLAGS,
    normalizeMultiEnumValue: configFlagsUi.normalizeMultiEnumValue,
    shouldOmitSpeculativeFlag: (flag, values) => (
        typeof shouldOmitSpeculativeFlag === "function" && shouldOmitSpeculativeFlag(flag, values)
    ),
    isSupportedChatTemplateValue: chatTemplateSelection.isSupportedChatTemplateValue,
    getToolBinaryName,
    renderCommandPreview(command, result) {
        const preview = document.getElementById("command-preview-text");
        preview.textContent = result && result.error ? `Cannot launch: ${result.error}` : command;
        preview.classList.toggle("command-preview-error", Boolean(result && result.error));
        setCustomLaunchArgsMessages(result || {});
        configFlagsUi.refreshComparison();
        presetsApi.refreshContext();
        monitorUi.renderRuntime();
        updateServerAddressPreview();
        updateApiEndpoints();
        refreshQuickLaunchUI();
        scheduleMemoryEstimate();
    },
    afterToolChange: syncUiAfterToolChange,
    beforePathPatch(flagId, value, patch) {
        if (flagId === "mmproj" && value) {
            patch.no_mmproj = false;
        }
        // The manual custom-template-path rule is owned by the selection module.
        chatTemplateSelection.beforePathPatch(flagId, value, patch);
    },
    afterPatch(patch, options) {
        quickLaunchUi.afterPatch(patch, options);
    },
    afterApply(values) {
        quickLaunchUi.afterApply(values);
    },
    postUpdate: syncUiAfterSharedStateChange,
});
}

function getPathPickerRequest(flag) {
    return {
        purpose: flag.id,
        title: `Select ${flag.label || "File"}`,
    };
}

async function browseForPathFlag(flag) {
    const result = await apiClient.fetchJson("/api/select-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getPathPickerRequest(flag)),
    });
    if (!result || !result.selected || !result.path) return "";
    return String(result.path);
}

function updateQuickLaunchActionButtons() {
    quickLaunchUi.updateActionButtons();
}

function syncQuickLaunchModelOptions() {
    quickLaunchUi.syncModelOptions();
}

function refreshQuickLaunchUI() {
    quickLaunchUi.refresh();
}

function initQuickLaunch() {
    quickLaunchUi.init();
    modelSwitchUi.init();
}

document.addEventListener("DOMContentLoaded", async () => {
    if (window.LlamaGui.chatWindow?.isDetachedView?.() === true) {
        await window.LlamaGui.chatWindow.startDetachedView({
            chatUi,
            themeUi,
            monitorUi,
            confirmAction: dialogs.confirmAction,
        });
        return;
    }
    try {
        await window.LlamaGui.chatWindow.startHostView({
            chatUi,
            flagCore,
            getLatestStatus: manager.getLatestStatus,
            getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
            getInferenceSnapshot: () => inferenceStats.getSnapshot(),
            resetInferenceBaseline: () => snapshotStatsBaseline(),
            getApiAuthorizationHeaders,
            switchTab,
            confirmAction: dialogs.confirmAction,
            initializeChat: initChatTab,
            onDetachedChange(detached) {
                // The hidden main page remains the authoritative inference poller
                // while its Chat is shown in the detached window. System telemetry
                // continues to follow ordinary document visibility.
                statsDocumentVisible = (detached && window.LlamaGui.chatWindow?.hasDetachedView?.() === true)
                    || document.visibilityState === "visible";
                monitorUi.setDocumentVisibility(document.visibilityState === "visible");
                if (!inferenceStats.getTargetKey()) return;
                if (statsDocumentVisible) {
                    clearInferenceTimers();
                    pollStats(statsEpoch);
                } else {
                    statsEpoch += 1;
                    clearInferenceTimers();
                    if (statsAbortController) {
                        statsAbortController.abort();
                        statsAbortController = null;
                    }
                    statsActiveEpoch = null;
                }
            },
        });
    } catch (error) {
        console.warn("Chat host startup failed; continuing shell startup.", error);
    }
    themeUi.init();
    initTabs();
    initToolSelect();
    initConfigControls();
    initCustomLaunchArgsControls();
    manager.init();
    initApiTab();
    remoteTunnelUi.init();
    externalServerUi.init();
    initPresetImport();
    initPresetLibraryControls();
    presetsApi.initContextControls();
    initQuickLaunch();
    benchmarkUi.init();
    monitorUi.init();
    configFlagsUi.renderFlags();
    manager.fetchReleases();
    flagCore.updateCommandPreview();
    updateApiEndpoints();

    document.getElementById("btn-launch").addEventListener("click", launchLlama);
    document.getElementById("btn-stop").addEventListener("click", stopLlama);
    const btnSidebarLaunch = document.getElementById("btn-sidebar-launch");
    if (btnSidebarLaunch) btnSidebarLaunch.addEventListener("click", launchLlama);
    const btnSidebarStop = document.getElementById("btn-sidebar-stop");
    if (btnSidebarStop) btnSidebarStop.addEventListener("click", stopLlama);
    document.getElementById("model-select").addEventListener("change", () => {
        flagCore.setSelectedModelValue(document.getElementById("model-select").value || "");
        syncQuickLaunchModelOptions();
        flagCore.updateCommandPreview();
    });

    const btnClearOutput = document.getElementById("btn-clear-output");
    if (btnClearOutput) btnClearOutput.addEventListener("click", clearOutput);
    const btnSendInput = document.getElementById("btn-send-input");
    if (btnSendInput) btnSendInput.addEventListener("click", sendInput);
    const btnCopyServerUrl = document.getElementById("btn-copy-server-url");
    if (btnCopyServerUrl) btnCopyServerUrl.addEventListener("click", () => copyServerUrl("server-url"));
    wireCommandCopyButton("btn-copy-command", "command-preview-text");
    wireCommandCopyButton("btn-copy-quick-command", "quick-command-preview");
    wireCommandCopyButton("btn-copy-benchmark-command", "benchmark-command-preview");

    // Pause both polling flows while the browser document is hidden.
    // Inference polling resumes immediately (it also feeds the global stats
    // bar across app tabs); Monitor system polling resumes while visible.
    document.addEventListener("visibilitychange", () => {
        const visible = document.visibilityState === "visible";
        statsDocumentVisible = visible || window.LlamaGui.chatWindow?.hasDetachedView?.() === true;
        monitorUi.setDocumentVisibility(visible);
        if (!inferenceStats.getTargetKey()) return;
        if (statsDocumentVisible) {
            clearInferenceTimers();
            pollStats(statsEpoch);
        } else {
            statsEpoch += 1;
            clearInferenceTimers();
            if (statsAbortController) {
                statsAbortController.abort();
                statsAbortController = null;
            }
            statsActiveEpoch = null;
        }
    });
    const btnSavePreset = document.getElementById("btn-save-preset");
    if (btnSavePreset) btnSavePreset.addEventListener("click", savePreset);
    const btnImportPreset = document.getElementById("btn-import-preset");
    if (btnImportPreset) btnImportPreset.addEventListener("click", () => document.getElementById("preset-import").click());
    const btnExportAllPresets = document.getElementById("btn-export-all-presets");
    if (btnExportAllPresets) btnExportAllPresets.addEventListener("click", exportAllPresets);

    showToast("Llama GUI ready", "info");

    const initStatus = await manager.checkStatus();
    await manager.refreshModels();
    if (initStatus && initStatus.running) {
        await restoreRunningState(initStatus);
    }
    await loadStartupPresetFromUrl();
    manager.clearAppReloadParam();
});

function getStartupPresetName() {
    try {
        const params = new URLSearchParams(window.location.search || "");
        const name = params.get("preset");
        return name ? name.trim() : "";
    } catch (e) {
        console.debug("Failed to read startup preset parameter", e);
        return "";
    }
}

async function loadStartupPresetFromUrl() {
    const presetName = getStartupPresetName();
    if (!presetName) return;
    if (typeof loadPreset === "function") {
        await loadPreset(presetName);
    }
}

function initTabs() {
    window.LlamaGui.shellUi.init({ switchTab, getLifecycleSnapshot: () => processLifecycle.getSnapshot(), getLatestStatus: manager.getLatestStatus });
}

function switchTab(tabId) {
    if (chatUi && typeof chatUi.onTabChanged === "function") chatUi.onTabChanged(tabId);
    document.querySelectorAll(".section-panel").forEach(panel => {
        panel.style.display = panel.id === "section-" + tabId ? "" : "none";
    });
    monitorUi.onTabChanged(tabId);
    window.LlamaGui.shellUi.onTabChanged(tabId);
    if (tabId === "presets") loadPresets();
    if (tabId === "benchmarking") benchmarkUi.onShow();
    if (tabId === "quick-launch") {
        refreshQuickLaunchUI();
        quickLaunchUi.refreshSavedPresets();
        refreshRuntimeStatusPanels();
        modelSwitchUi.refresh({ reloadPresets: true })
            .catch(error => console.debug("Failed to reload Model Switcher presets", error));
    }
    if (tabId === "chat") {
        refreshChatSidebarUI();
        refreshRuntimeStatusPanels();
    }
    if (tabId === "configure") flagCore.updateCommandPreview();
    if (tabId === "api") {
        Promise.resolve(refreshRuntimeStatusPanels()).finally(() => {
            updateApiEndpoints();
            remoteTunnelUi.refreshStatus();
            externalServerUi.refresh();
        });
    }
}

function initToolSelect() {
    const toolSel = document.getElementById("tool-select");
    toolSel.value = flagCore.getCurrentTool();
    toolSel.addEventListener("change", () => {
        flagCore.setCurrentTool(toolSel.value);
    });
}

function initConfigControls() {
    return configFlagsUi.initConfigControls();
}

function renderServerAddressPreview(containerId, urlId, webUiId, getBaseUrl) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (flagCore.getCurrentTool() !== "llama-server") {
        el.classList.add("hidden");
        return;
    }

    const baseUrl = getBaseUrl();
    const urlLink = document.getElementById(urlId);
    const webUiLink = document.getElementById(webUiId);
    if (!urlLink || !webUiLink) return;

    urlLink.href = baseUrl;
    urlLink.textContent = baseUrl;
    webUiLink.href = baseUrl + "/";
    el.classList.remove("hidden");
}

function updateServerAddressPreview() {
    renderServerAddressPreview(
        "server-address",
        "server-url",
        "server-webui",
        () => getServerEndpointConfig().baseUrl
    );
}

function updateQuickServerAddressPreview() {
    renderServerAddressPreview(
        "quick-server-address",
        "quick-server-url",
        "quick-server-webui",
        getServerBaseUrl
    );
}

function initPresetImport() {
    document.getElementById("preset-import").addEventListener("change", (e) => {
        if (e.target.files.length > 0) handlePresetImport(e.target.files[0]);
        e.target.value = "";
    });
}

function getExecutableSuffix() {
    const status = manager.getLatestStatus();
    if (status && typeof status.executable_suffix === "string") {
        return status.executable_suffix;
    }
    // TODO: fallback sniffs navigator.userAgent (frontend platform decision).
    // Acceptable because the primary path uses backend status; remove when
    // executable_suffix is guaranteed in every status response.
    const ua = navigator.userAgent || "";
    return /Windows/i.test(ua) ? ".exe" : "";
}

function getToolBinaryName(tool) {
    return tool + getExecutableSuffix();
}

function handleLifecycleSnapshot(state) {
    window.LlamaGui.shellUi.renderRuntime();
    configFlagsUi.refreshComparison();
    const launchBtn = document.getElementById("btn-launch");
    const stopBtn = document.getElementById("btn-stop");
    if (!launchBtn || !stopBtn) return;

    const transitional = state.phase === "starting" || state.phase === "loading" || state.phase === "stopping";
    const hasProcess = Boolean(state.activeRuntime) || transitional;
    launchBtn.classList.toggle("hidden", hasProcess);
    launchBtn.disabled = Boolean(state.busy);
    stopBtn.classList.toggle("hidden", !hasProcess);
    stopBtn.disabled = state.phase === "stopping";

    const outputSection = document.getElementById("output-section");
    if (outputSection && hasProcess) outputSection.classList.remove("hidden");
    const inputRow = document.getElementById("input-row");
    if (inputRow) {
        inputRow.classList.toggle("hidden", !(state.activeRuntime && state.activeRuntime.tool === "llama-cli"));
    }
    const serverAddress = document.getElementById("server-address");
    if (serverAddress && !state.activeRuntime) serverAddress.classList.add("hidden");

    updateQuickLaunchActionButtons();
    updateChatStatusBadge();
    updateApiEndpoints();
    monitorUi.updateProcessHeader();
    if (document.getElementById("model-switch-card")) {
        modelSwitchUi.refresh().catch(error => console.debug("Failed to refresh Model Switcher", error));
    }
    window.LlamaGui.chatWindow?.notifyHostChange?.({ type: "lifecycle" });
}

function handleLifecycleProcessStarted(initialCursor, runtime, _state, launchResult) {
    const tool = runtime && runtime.tool ? runtime.tool : "llama.cpp";
    if (launchResult) {
        appendOutput(`Started ${tool}${launchResult.pid ? ` (PID: ${launchResult.pid})` : ""}`);
        if (launchResult.command) appendOutput(launchResult.command);
        appendOutput("---");
    }
    startOutputPolling(initialCursor);
    if (tool === "llama-server") {
        updateServerAddressPreview();
        updateQuickServerAddressPreview();
    }
}

async function handleLifecycleReady(runtime) {
    if (runtime && runtime.tool === "llama-server") {
        const { baseUrl } = getServerEndpointConfig();
        appendOutput(`Server ready at ${baseUrl}`);
        appendOutput(`Web UI: ${baseUrl}/`);
        showToast("Server is ready!", "success", {
            duration: SERVER_READY_TOAST_MS,
            action: {
                label: "Open Monitor",
                onClick: () => switchTab("monitor"),
            },
        });
    }
    await refreshRuntimeStatusPanels();
}

async function handleLifecycleFailure(message) {
    appendOutput("ERROR: " + message);
    await refreshRuntimeStatusPanels();
}

function handleLifecycleSlowLoad(message) {
    appendOutput("WARNING: " + message);
    showToast(message, "warning", { duration: SLOW_LOAD_WARNING_TOAST_MS });
}

async function handleReconciliationFailure(message) {
    appendOutput("ERROR: " + message);
    showToast(message, "error", { duration: 0 });
    updateChatStatusBadge();
    updateApiEndpoints();
    benchmarkUi.refreshStatus();
    await modelSwitchUi.refresh();
}

async function restoreRunningState(status) {
    if (!status || !status.running) return;

    const tool = status.active_process_tool || "llama-server";
    const lifecycleState = processLifecycle.getSnapshot();
    const statusGeneration = Number(status.active_runtime && status.active_runtime.generation);
    const lifecycleGeneration = Number(lifecycleState.activeRuntime && lifecycleState.activeRuntime.generation);
    const lifecycleAlreadyRestored = Number.isSafeInteger(statusGeneration)
        && statusGeneration >= 1
        && statusGeneration === lifecycleGeneration
        && lifecycleState.ready === true;
    if (tool === "llama-bench" || tool === "llama-perplexity") {
        switchTab("benchmarking");
        if (lifecycleAlreadyRestored || benchmarkUi.restoreRunningState(status)) {
            if (!lifecycleAlreadyRestored) {
                await processLifecycle.restore(status, {
                    startOutput: () => {},
                    postReady: () => {},
                });
            }
            updateQuickLaunchActionButtons();
            await refreshRuntimeStatusPanels();
        }
        return;
    }
    appendOutput("--- Reconnected to running " + tool + " process ---");
    if (!lifecycleAlreadyRestored) await processLifecycle.restore(status);
}

function buildManualLaunchRequest() {
    const result = flagCore.getLaunchArgs();
    if (result.error) {
        throw new Error(result.error);
    }
    const args = result.args;
    const tool = flagCore.getCurrentTool();
    if (!flagCore.hasLaunchModelArg(args)) {
        throw new Error("Select a model or provide a remote model source before launching.");
    }
    return { tool, args, launch_settings: flagCore.captureLaunchSettings() };
}

async function launchLlama() {
    let request;
    try {
        request = buildManualLaunchRequest();
    } catch (error) {
        showToast(error.message, "error", { duration: 0 });
        refreshQuickLaunchUI();
        return { ok: false, error: error.message };
    }
    clearOutput();
    const outcome = await processLifecycle.launch(request);
    if (!outcome.ok && !outcome.cancelled && outcome.error) {
        showToast(outcome.error, "error", { duration: 0 });
    }
    return outcome;
}

async function stopLlama() {
    const outcome = await processLifecycle.stop();
    if (outcome.ok) {
        appendOutput("--- Process stopped ---");
        await refreshRuntimeStatusPanels();
    } else if (!outcome.cancelled && outcome.error) {
        appendOutput("ERROR: " + outcome.error);
        showToast(outcome.error, "error", { duration: 0 });
        if (outcome.status && outcome.status.running) resumeRuntimePolling(outcome.status);
    }
    return outcome;
}

function startOutputPolling(initialCursor = null) {
    processOutputCursor.reset(initialCursor);
    pollOutputFailCount = 0;
    if (outputTimer) clearInterval(outputTimer);
    outputTimer = setInterval(pollOutput, 300);
}

function stopOutputPolling() {
    if (outputTimer) {
        clearInterval(outputTimer);
        outputTimer = null;
    }
    processOutputCursor.reset();
}

function startStatsPolling(runtime, lifecycleState) {
    stopStatsPolling();
    // Fresh processes start their counters at zero. Restored processes need a
    // first-poll baseline so their lifetime counters do not become session totals.
    const freshLaunch = lifecycleState && lifecycleState.operation !== "restore";
    const generation = Number(runtime && runtime.generation);
    const key = Number.isSafeInteger(generation) && generation >= 1 ? `gui:${generation}` : null;
    inferenceStats.setTarget(key, { zeroBaseline: freshLaunch });
    beginInferencePolling();
}

function stopStatsPolling() {
    statsEpoch += 1;
    clearInferenceTimers();
    if (statsAbortController) {
        statsAbortController.abort();
        statsAbortController = null;
    }
    statsActiveEpoch = null;
    inferenceStats.setTarget(null);
}

function clearInferenceTimers() {
    if (inferenceInitialTimer) {
        clearTimeout(inferenceInitialTimer);
        inferenceInitialTimer = null;
    }
    if (inferenceTimer) {
        clearTimeout(inferenceTimer);
        inferenceTimer = null;
    }
}

function inferencePollingActive() {
    return Boolean(inferenceInitialTimer || inferenceTimer || statsActiveEpoch !== null);
}

function beginInferencePolling() {
    if (!inferenceStats.getTargetKey() || !statsDocumentVisible) return;
    clearInferenceTimers();
    const epoch = statsEpoch;
    inferenceInitialTimer = setTimeout(() => {
        inferenceInitialTimer = null;
        pollStats(epoch);
    }, 2000);
}

function scheduleNextInferencePoll(epoch) {
    if (epoch !== statsEpoch || !statsDocumentVisible || !inferenceStats.getTargetKey()) return;
    if (inferenceTimer) clearTimeout(inferenceTimer);
    inferenceTimer = setTimeout(() => {
        inferenceTimer = null;
        pollStats(epoch);
    }, 3000);
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
    const result = flagCore.getLaunchArgs();
    if (result.error) {
        setMemoryEstimateState("Unavailable", result.error);
        return;
    }
    const args = result.args || [];
    if (!flagCore.hasLaunchModelArg(args)) {
        setMemoryEstimateState("Idle", "Select a model to estimate.");
        return;
    }

    setMemoryEstimateState("Estimating", "Checking current command arguments...");
    try {
        const data = await apiClient.fetchJson("/api/estimate-memory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: flagCore.getCurrentTool(), args }),
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

function snapshotStatsBaseline() {
    // The one and only reset operation. With valid raw counters it re-renders
    // the fixed bar and the Inference card as zero immediately; otherwise the
    // reset stays pending until the next valid sample.
    return inferenceStats?.resetBaseline?.() ?? false;
}

function renderInferenceViews(snapshot) {
    monitorUi.renderStatsBarFromSnapshot(snapshot);
    monitorUi.renderInferenceSnapshot(snapshot);
    if (window.LlamaGui.chatWindow?.isDetachedView?.() !== true) {
        window.LlamaGui.chatWindow?.notifyHostChange?.({ type: "inference" });
    }
}

async function pollStats(epoch = statsEpoch) {
    if (epoch !== statsEpoch || statsActiveEpoch === epoch) return;
    statsActiveEpoch = epoch;
    const controller = new AbortController();
    statsAbortController = controller;
    try {
        const { host, port } = getServerEndpointConfig();
        const params = new URLSearchParams({ host, port: String(port) });
        const headers = getApiAuthorizationHeaders();
        // Fetch /metrics and /slots independently: a disabled or unavailable
        // metrics endpoint must not suppress slot-based context, and vice versa.
        const [metricsResp, slotsResp] = await Promise.all([
            fetch(`/api/llama/metrics?${params.toString()}`, { headers, signal: controller.signal }).catch(error => {
                if (error && error.name !== "AbortError" && epoch === statsEpoch) {
                    console.debug("Failed to fetch llama-server metric stats", error);
                }
                return null;
            }),
            fetch(`/api/llama/slots?${params.toString()}`, { headers, signal: controller.signal }).catch(error => {
                if (error && error.name !== "AbortError" && epoch === statsEpoch) {
                    console.debug("Failed to fetch llama-server slot stats", error);
                }
                return null;
            }),
        ]);
        if (epoch !== statsEpoch) return;

        let metricsOk = false;
        let metricsValues = null;
        if (metricsResp && metricsResp.ok) {
            try {
                const text = await metricsResp.text();
                if (epoch !== statsEpoch) return;
                metricsValues = window.LlamaGui.inferenceStats.parseMetricsText(text);
                metricsOk = true;
            } catch (e) {
                console.debug("Failed to parse llama-server metric stats", e);
            }
        }

        let slotsOk = false;
        let slotsNormalized = null;
        if (slotsResp && slotsResp.ok) {
            let slotsPayload = null;
            try {
                slotsPayload = await slotsResp.json();
            } catch (e) {
                console.debug("Failed to parse llama-server slot stats", e);
            }
            if (epoch !== statsEpoch) return;
            slotsNormalized = window.LlamaGui.inferenceStats.normalizeSlots(slotsPayload);
            slotsOk = slotsNormalized !== null;
        }

        if (epoch !== statsEpoch) return;
        inferenceStats.applyPollResult({
            metricsOk,
            metricsValues,
            slotsOk,
            slotsNormalized,
            now: Date.now(),
        });
        scheduleNextInferencePoll(epoch);
    } catch (e) {
        if (e && e.name !== "AbortError" && epoch === statsEpoch) {
            console.debug("Failed to fetch llama-server metrics", e);
        }
        if (epoch === statsEpoch) scheduleNextInferencePoll(epoch);
    } finally {
        if (statsActiveEpoch === epoch) statsActiveEpoch = null;
        if (statsAbortController === controller) statsAbortController = null;
    }
}



async function refreshRuntimeStatusPanels() {
    const status = await manager.checkStatus();
    window.LlamaGui.chatWindow?.notifyHostChange?.({ type: "status" });
    monitorUi.updateProcessHeader();
    updateChatStatusBadge();
    updateApiEndpoints();
    benchmarkUi.refreshStatus();
    modelSwitchUi.refresh().catch(error => console.debug("Failed to refresh Model Switcher", error));
    return status;
}

function resolveInferenceTargetKey(status) {
    if (status && status.running && status.active_runtime
        && status.active_runtime.tool === "llama-server") {
        const generation = Number(status.active_runtime.generation);
        if (Number.isSafeInteger(generation) && generation >= 1) return `gui:${generation}`;
    }
    const target = status && status.external_chat_target;
    if (target && target.connected) {
        const host = String(target.host || "").trim().toLowerCase() || "127.0.0.1";
        const port = Number(target.port);
        const normalizedPort = Number.isFinite(port) && port > 0 ? port : 0;
        // The revision changes on every successful external connect/restore so
        // even a reconnect to the same address starts a fresh baseline. The
        // API key is deliberately excluded from the identity.
        return `ext:${externalTargetRevision}:${host}:${normalizedPort}`;
    }
    return null;
}

function reconcileInferenceTarget(status) {
    const key = resolveInferenceTargetKey(status);
    const current = inferenceStats.getTargetKey();
    if (!key) {
        if (current !== null) stopStatsPolling();
        return;
    }
    if (key !== current) {
        if (key.startsWith("gui:")) {
            // GUI-owned launches and restores belong to the process lifecycle,
            // which sets the correct baseline through startStatsPolling. Do not
            // preempt an in-progress transition from here.
            const lifecycle = processLifecycle.getSnapshot();
            const lifecycleGeneration = Number(
                lifecycle.activeRuntime && lifecycle.activeRuntime.generation
            );
            if (!lifecycle.ready || lifecycleGeneration !== Number(key.slice(4))) return;
        }
        // A target discovered through status (startup restore, external
        // connect/restore, or an out-of-band replacement) never had its
        // counters start at zero in this session: the first valid counter
        // sample becomes the baseline.
        // Invalidate delayed responses from the previous external connection,
        // including a reconnect to the same host with a new revision.
        stopStatsPolling();
        inferenceStats.setTarget(key, { zeroBaseline: false });
    }
    if (!inferencePollingActive()) beginInferencePolling();
}

function markExternalTargetChanged() {
    externalTargetRevision += 1;
}

async function reconcileAuthoritativeStatus(status) {
    const tool = status && status.active_process_tool;
    const before = processLifecycle.getSnapshot();
    const incomingGeneration = Number(status && status.active_runtime && status.active_runtime.generation);
    const currentGeneration = Number(before.activeRuntime && before.activeRuntime.generation);
    const shouldAdoptBenchmark = (tool === "llama-bench" || tool === "llama-perplexity")
        && status.running === true
        && Number.isSafeInteger(incomingGeneration)
        && incomingGeneration >= 1
        && (incomingGeneration !== currentGeneration || before.activeRuntime?.tool !== tool || before.ready !== true);
    const reconcileOptions = tool === "llama-bench" || tool === "llama-perplexity"
        ? { startOutput: () => {}, postReady: () => {}, onFailed: handleReconciliationFailure }
        : { postReady: () => {}, onFailed: handleReconciliationFailure };
    const outcome = await processLifecycle.reconcile(status, reconcileOptions);
    // Every accepted status, including the first page-load status, is the
    // authoritative source for the resolved inference target.
    reconcileInferenceTarget(status);
    configFlagsUi.refreshComparison();
    quickLaunchUi.refreshRuntime();
    window.LlamaGui.shellUi.renderRuntime();
    monitorUi.updateProcessHeader();
    window.LlamaGui.chatWindow?.notifyHostChange?.({ type: "status" });
    if (outcome.ok && shouldAdoptBenchmark) benchmarkUi.restoreRunningState(status);
    return outcome;
}



async function pollOutput() {
    const request = processOutputCursor.getRequest();
    if (pollOutputActiveEpoch === request.epoch) return;
    pollOutputActiveEpoch = request.epoch;
    try {
        const data = await apiClient.fetchJson(request.url);
        const observedGeneration = Number(data && data.runtime_generation);
        const expectedGeneration = Number(processLifecycle.getSnapshot().activeRuntime?.generation);
        if (
            data && data.running
            && Number.isSafeInteger(observedGeneration)
            && observedGeneration >= 1
            && (!Number.isSafeInteger(expectedGeneration) || observedGeneration !== expectedGeneration)
        ) {
            processOutputCursor.reset();
            await refreshRuntimeStatusPanels();
            return;
        }
        const consumed = processOutputCursor.consume(data, request.epoch);
        if (!consumed.current) return;
        if (!data.running) {
            stopOutputPolling();
            stopStatsPolling();
            appendOutput("--- Process exited ---");
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
            document.getElementById("input-row").classList.add("hidden");
            document.getElementById("server-address").classList.add("hidden");
            updateQuickLaunchActionButtons();
            setTimeout(async () => {
                const status = await refreshRuntimeStatusPanels();
                if (status && !status.running) await processLifecycle.restore(status);
            }, 500);
        }
        pollOutputFailCount = 0;
    } catch (e) {
        if (!processOutputCursor.isCurrent(request.epoch)) return;
        pollOutputFailCount++;
        if (pollOutputFailCount <= 5) {
            appendOutput("Output polling error (retry " + pollOutputFailCount + "/5): " + e.message);
        } else {
            appendOutput("Connection to server lost: " + e.message);
            stopOutputPolling();
            stopStatsPolling();
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
            document.getElementById("input-row").classList.add("hidden");
            document.getElementById("server-address").classList.add("hidden");
            updateQuickLaunchActionButtons();
            refreshRuntimeStatusPanels();
        }
    } finally {
        if (pollOutputActiveEpoch === request.epoch) pollOutputActiveEpoch = null;
    }
}

function appendOutput(text) {
    monitorUi.appendOutputLine(text);
}

function clearOutput() {
    // Clears the DOM and advances the cursor epoch without discarding the
    // cursor, so the next poll does not replay the backend backlog.
    monitorUi.clearTerminal();
}

async function sendInput() {
    const input = document.getElementById("cli-input");
    const text = input.value;
    if (!text) return;
    input.value = "";
    try {
        await apiClient.fetchJson("/api/send-input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        });
    } catch (e) {
        console.debug("Send input request failed", e);
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement.id === "cli-input") {
        sendInput();
    }
});

function copyServerUrl(linkId) {
    const url = document.getElementById(linkId).href;
    copyText(url);
}

function copyText(text) {
    // Resolve to a success flag so callers never claim a copy that failed
    // (denied permission, insecure context, or no Clipboard API at all).
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        console.debug("Clipboard API unavailable");
        return Promise.resolve(false);
    }
    return navigator.clipboard.writeText(text).then(
        () => true,
        (error) => {
            console.debug("Clipboard write failed", error);
            return false;
        },
    );
}

function wireCommandCopyButton(buttonId, previewId) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    button.addEventListener("click", () => {
        const preview = document.getElementById(previewId);
        const command = preview ? preview.textContent.trim() : "";
        if (!command) {
            showToast("No command to copy yet", "info");
            return;
        }
        copyText(command).then((copied) => {
            showToast(copied ? "Command copied" : "Could not copy command",
                copied ? "info" : "error");
        });
    });
}

function dismissToast(toast) {
    if (!toast || toast.dataset.dismissing === "true") return;
    toast.dataset.dismissing = "true";
    const timerId = Number(toast.dataset.timerId || 0);
    if (timerId) {
        clearTimeout(timerId);
    }
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-8px)";
    toast.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    setTimeout(() => toast.remove(), 220);
}

function capToastStack(container) {
    const toasts = Array.from(container.querySelectorAll(".toast"));
    const overflow = toasts.length - TOAST_MAX_VISIBLE;
    if (overflow <= 0) return;
    for (const toast of toasts.slice(0, overflow)) {
        dismissToast(toast);
    }
}

function showToast(message, type, options = {}) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const duration = Object.prototype.hasOwnProperty.call(options, "duration")
        ? Number(options.duration)
        : DEFAULT_TOAST_DURATION_MS;
    const action = options.action;
    const toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "info");
    toast.setAttribute("role", "status");
    const icon = document.createElement("span");
    icon.className = "icon icon-sm toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24">' +
        (type === "success" ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>' +
            '<polyline points="22 4 12 14.01 9 11.01"/>' :
            type === "error" ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' :
                type === "warning" ? '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' :
                    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>') +
        '</svg>';
    const text = document.createElement("span");
    text.className = "toast-message";
    text.textContent = String(message || "");
    const closeBtn = document.createElement("button");
    closeBtn.className = "toast-close";
    closeBtn.type = "button";
    closeBtn.title = "Dismiss";
    closeBtn.setAttribute("aria-label", "Dismiss notification");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        dismissToast(toast);
    });
    toast.addEventListener("click", () => dismissToast(toast));
    toast.appendChild(icon);
    toast.appendChild(text);
    if (action && typeof action.label === "string" && action.label
        && typeof action.onClick === "function") {
        const actionBtn = document.createElement("button");
        actionBtn.className = "toast-action";
        actionBtn.type = "button";
        // textContent only: toast content must never be HTML (XSS smoke test).
        actionBtn.textContent = action.label;
        actionBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            dismissToast(toast);
            action.onClick();
        });
        toast.appendChild(actionBtn);
    }
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    capToastStack(container);
    if (Number.isFinite(duration) && duration > 0) {
        const timerId = setTimeout(() => dismissToast(toast), duration);
        toast.dataset.timerId = String(timerId);
    }
}

// Chat Tab

if (window.LlamaGui.chatWindow?.isDetachedView?.() !== true) chatUi.configure({
    flagCore,
    confirmAction: dialogs.confirmAction,
    getLatestStatus: manager.getLatestStatus,
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
    snapshotStatsBaseline,
    switchTab,
    getApiAuthorizationHeaders,
});

function refreshChatSidebarUI() {
    chatUi.refreshSidebarUI();
}

function updateChatStatusBadge() {
    chatUi.updateStatusBadge();
}

function initChatTab() {
    chatUi.init();
}
