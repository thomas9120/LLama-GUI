function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

const flagCore = window.LlamaGui.flagCore;
const configFlagsUi = window.LlamaGui.configFlagsUi;
const themeUi = window.LlamaGui.themeUi;
const processOutputCursor = window.LlamaGui.outputCursor.create(appendOutput);
flagCore.setCurrentToolValue("llama-server");
flagCore.replaceFlagValues(getDefaultValues());
let outputTimer = null;
let statsTimer = null;
let statsInitialTimer = null;
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

let chatStatsBaseline = { promptTokens: 0, genTokens: 0 };
let chatStatsRaw = { promptTokens: 0, genTokens: 0 };
const scheduleMemoryEstimate = debounce(updateMemoryEstimate, 700);
// Shared Quick Launch and sampler data is defined in app-data.js.
const apiTab = window.LlamaGui.apiTab;
apiTab.configure({
    flagCore,
    copyText,
    getLatestStatus: () => latestStatus,
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
});
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
samplerPresets.configure({
    flagCore,
    getFlags: () => FLAGS,
    getDefaultFlagValues: getDefaultValues,
    confirmAction,
    promptAction,
    showToast,
    refreshSamplerPresetSelect: (preferredValue) => quickLaunchUi.refreshSamplerPresetSelect(preferredValue),
});
presetsApi.configure({ showToast });
const remoteTunnelUi = window.LlamaGui.remoteTunnelUi;
remoteTunnelUi.configure({
    fetchJson,
    copyText,
    getServerEndpointConfig,
});
const externalServerUi = window.LlamaGui.externalServerUi;
externalServerUi.configure({
    fetchJson,
    getLatestStatus: () => latestStatus,
    refreshStatus: refreshRuntimeStatusPanels,
});
const hfDownloadUi = window.LlamaGui.hfDownloadUi;
hfDownloadUi.configure({
    flagCore,
    fetchJson,
    confirmAction,
    refreshModels,
    applyPresetModel,
    refreshQuickLaunchUI,
});
quickLaunchUi.configure({
    flagCore,
    configFlagsUi,
    hfDownloadUi,
    debounce,
    refreshModels,
    applyPresetModel,
    switchTab,
    launchLlama,
    stopLlama,
    copyQuickServerUrl: () => copyServerUrl("quick-server-url"),
    updateQuickServerAddressPreview,
    setChatTemplateValue,
    getSelectedChatTemplateDropdownValue,
    getQuickTemplateSummaryText,
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
    confirmAction,
    promptAction,
    showToast,
    hasLaunchModelArg: flagCore.hasLaunchModelArg,
});
benchmarkUi.configure({
    flagCore,
    fetchJson,
    showToast,
    getFlags: () => FLAGS,
    getDefaultFlagValues: getDefaultValues,
    getLatestStatus: () => latestStatus,
    refreshRuntimeStatusPanels,
    processLifecycle,
});
processLifecycle.configure({
    fetchJson,
    refreshStatus: () => fetchJson("/api/status"),
    buildLaunchRequest: buildManualLaunchRequest,
    abortChat: () => chatUi.abortActiveStream(),
    invalidateOutput: stopOutputPolling,
    invalidateStats: stopStatsPolling,
    startOutput: handleLifecycleProcessStarted,
    startStats: startStatsPolling,
    postReady: handleLifecycleReady,
    onFailed: handleLifecycleFailure,
    onSlowLoad: handleLifecycleSlowLoad,
});
window.LlamaGui.manager.setAcceptedStatusObserver(reconcileAuthoritativeStatus);
modelSwitchUi.configure({
    fetchPresetEntries: fetchModelSwitcherPresetEntries,
    findPresetByName: presetsApi.findPresetByName,
    getAssignments: modelSwitchUi.getAssignments,
    getAssignmentIssues: modelSwitchUi.getAssignmentIssues,
    getStorageStatus: modelSwitchUi.getStorageStatus,
    getLatestBackendStatus: () => latestStatus,
    getLifecycleSnapshot: () => processLifecycle.getSnapshot(),
    getPresetFingerprint: entry => entry && entry.preset_fingerprint || "",
    switchSlot: switchModelSlot,
});
processLifecycle.subscribe(handleLifecycleSnapshot);

function syncUiAfterToolChange(nextTool) {
    const toolSel = document.getElementById("tool-select");
    if (toolSel && toolSel.value !== nextTool) {
        toolSel.value = nextTool;
    }

    configFlagsUi.resetOpenCategories();
    configFlagsUi.renderFlags();
    flagCore.updateCommandPreview();
}

function syncUiAfterSharedStateChange(options) {
    configFlagsUi.restoreFlagInputs(options);
    restoreCustomLaunchArgsInput();
    flagCore.updateCommandPreview();
    refreshChatSidebarUI();
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
                const result = await fetchJson("/api/presets/fingerprint", {
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
    if (launch.error) throw new Error(launch.error);
    if (!flagCore.hasLaunchModelArg(launch.args)) throw new Error(`Preset "${presetName}" has no model source.`);

    const preflight = await fetchJson("/api/launch/preflight", {
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
        || (latestStatus && latestStatus.active_runtime)
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
    if (runtime.tool === "llama-server") startStatsPolling();
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

configFlagsUi.configure({
    debounce,
    fetchJson,
    getFlagsByCategory,
    getFlags: () => FLAGS,
    switchTab,
    createSamplerPresetControls: samplerPresets.createSamplerPresetControls,
    refreshQuickLaunchUI,
    browseForPathFlag,
    showStatus,
    setChatTemplateValue,
    getSelectedChatTemplateDropdownValue,
    copyText,
    showToast,
});

flagCore.configure({
    getDefaultFlagValues: getDefaultValues,
    getFlags: () => FLAGS,
    normalizeMultiEnumValue: configFlagsUi.normalizeMultiEnumValue,
    shouldOmitSpeculativeFlag: (flag, values) => (
        typeof shouldOmitSpeculativeFlag === "function" && shouldOmitSpeculativeFlag(flag, values)
    ),
    isSupportedChatTemplateValue: (value) => (
        typeof isSupportedChatTemplateValue === "function" ? isSupportedChatTemplateValue(value) : true
    ),
    getToolBinaryName,
    renderCommandPreview(command, result) {
        const preview = document.getElementById("command-preview-text");
        preview.textContent = result && result.error ? `Cannot launch: ${result.error}` : command;
        preview.classList.toggle("command-preview-error", Boolean(result && result.error));
        setCustomLaunchArgsMessages(result || {});
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
        if (flagId === "chat_template_custom") {
            patch.chat_template = undefined;
        }
    },
    afterPatch(patch, options) {
        quickLaunchUi.afterPatch(patch, options);
    },
    afterApply(values) {
        quickLaunchUi.afterApply(values);
    },
    postUpdate: syncUiAfterSharedStateChange,
});

function getPathPickerRequest(flag) {
    return {
        purpose: flag.id,
        title: `Select ${flag.label || "File"}`,
    };
}

async function browseForPathFlag(flag) {
    const result = await fetchJson("/api/select-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getPathPickerRequest(flag)),
    });
    if (!result || !result.selected || !result.path) return "";
    return String(result.path);
}

function normalizeTemplatePathValue(value) {
    return String(value || "").trim().replace(/\\/g, "/");
}

function getChatTemplatePresetByValue(value) {
    return CHAT_TEMPLATE_PRESETS.find((preset) => preset.value === String(value || "")) || null;
}

function getChatTemplatePresetByBuiltinName(value) {
    const normalized = String(value || "");
    return CHAT_TEMPLATE_PRESETS.find((preset) => preset.mode === "builtin" && preset.builtin === normalized) || null;
}

function getChatTemplatePresetByPath(path) {
    const normalizedPath = normalizeTemplatePathValue(path);
    if (!normalizedPath) return null;
    return CHAT_TEMPLATE_PRESETS.find((preset) =>
        preset.mode === "bundled"
        && normalizeTemplatePathValue(preset.path) === normalizedPath
    ) || null;
}

function getSelectedChatTemplateDropdownValue() {
    const values = flagCore.getFlagValues();

    const bundledPreset = getChatTemplatePresetByPath(values.chat_template_custom);
    if (bundledPreset) {
        return bundledPreset.value;
    }

    const directPreset = getChatTemplatePresetByValue(values.chat_template);
    if (directPreset && directPreset.mode !== "auto") {
        return directPreset.value;
    }

    const builtinPreset = getChatTemplatePresetByBuiltinName(values.chat_template);
    if (builtinPreset) {
        return builtinPreset.value;
    }

    return isSupportedChatTemplateValue(values.chat_template) ? String(values.chat_template ?? "") : "";
}

function getQuickTemplateSummaryText() {
    const selectedTemplateValue = getSelectedChatTemplateDropdownValue();
    const preset = getChatTemplatePresetByValue(selectedTemplateValue);
    if (preset) {
        if (preset.mode === "bundled") {
            return `Using bundled template preset: ${preset.label}.`;
        }
        if (preset.mode === "builtin") {
            return `Using preset: ${preset.label}.`;
        }
    }
    if (selectedTemplateValue) {
        return `Using llama.cpp built-in template: ${selectedTemplateValue}`;
    }
    const values = flagCore.getFlagValues();
    if (values.chat_template_custom) {
        return `Using custom template file: ${values.chat_template_custom}`;
    }
    return "Use the template embedded in the model metadata when available.";
}

function setChatTemplateValue(value, options = {}) {
    const normalizedValue = String(value || "");
    const preset = getChatTemplatePresetByValue(normalizedValue);

    if (preset && preset.mode === "bundled") {
        flagCore.setMultipleFlagValues({
            chat_template: undefined,
            chat_template_custom: preset.path,
        });
        return;
    }

    if (preset && preset.mode === "auto") {
        flagCore.setMultipleFlagValues({
            chat_template: undefined,
            chat_template_custom: undefined,
        });
        return;
    }

    if (preset && preset.mode === "builtin") {
        flagCore.setMultipleFlagValues({
            chat_template: preset.builtin,
            chat_template_custom: undefined,
        });
        return;
    }

    const patch = {
        chat_template: normalizedValue || undefined,
    };
    if (!options.preserveCustomTemplateFile) {
        patch.chat_template_custom = undefined;
    }
    flagCore.setMultipleFlagValues(patch);
}

function updateQuickLaunchActionButtons() {
    quickLaunchUi.updateActionButtons();
}

function syncQuickLaunchModelOptions() {
    quickLaunchUi.syncModelOptions();
}

function refreshQuickLaunchUI() {
    quickLaunchUi.refresh();
    modelSwitchUi.refresh().catch(error => console.debug("Failed to refresh Model Switcher", error));
}

function initQuickLaunch() {
    quickLaunchUi.init();
    modelSwitchUi.init();
}

document.addEventListener("DOMContentLoaded", async () => {
    themeUi.init();
    initTabs();
    initToolSelect();
    initConfigControls();
    initCustomLaunchArgsControls();
    initInstallButtons();
    initApiTab();
    remoteTunnelUi.init();
    externalServerUi.init();
    initPresetImport();
    initPresetLibraryControls();
    initQuickLaunch();
    initChatTab();
    benchmarkUi.init();
    configFlagsUi.renderFlags();
    refreshModels();
    fetchReleases();
    flagCore.updateCommandPreview();
    updateApiEndpoints();

    document.getElementById("btn-launch").addEventListener("click", launchLlama);
    document.getElementById("btn-stop").addEventListener("click", stopLlama);
    const btnSidebarLaunch = document.getElementById("btn-sidebar-launch");
    if (btnSidebarLaunch) btnSidebarLaunch.addEventListener("click", launchLlama);
    const btnSidebarStop = document.getElementById("btn-sidebar-stop");
    if (btnSidebarStop) btnSidebarStop.addEventListener("click", stopLlama);
    const btnSidebarStopApp = document.getElementById("btn-sidebar-stop-app");
    if (btnSidebarStopApp) btnSidebarStopApp.addEventListener("click", stopPythonServer);
    document.getElementById("model-select").addEventListener("change", () => {
        flagCore.setSelectedModelValue(document.getElementById("model-select").value || "");
        syncQuickLaunchModelOptions();
        flagCore.updateCommandPreview();
    });

    const btnRefreshModels = document.getElementById("btn-refresh-models");
    if (btnRefreshModels) btnRefreshModels.addEventListener("click", () => refreshModels());
    const btnClearOutput = document.getElementById("btn-clear-output");
    if (btnClearOutput) btnClearOutput.addEventListener("click", clearOutput);
    const btnSendInput = document.getElementById("btn-send-input");
    if (btnSendInput) btnSendInput.addEventListener("click", sendInput);
    const btnCopyServerUrl = document.getElementById("btn-copy-server-url");
    if (btnCopyServerUrl) btnCopyServerUrl.addEventListener("click", () => copyServerUrl("server-url"));
    wireCommandCopyButton("btn-copy-command", "command-preview-text");
    wireCommandCopyButton("btn-copy-quick-command", "quick-command-preview");
    wireCommandCopyButton("btn-copy-benchmark-command", "benchmark-command-preview");
    const btnSavePreset = document.getElementById("btn-save-preset");
    if (btnSavePreset) btnSavePreset.addEventListener("click", savePreset);
    const btnImportPreset = document.getElementById("btn-import-preset");
    if (btnImportPreset) btnImportPreset.addEventListener("click", () => document.getElementById("preset-import").click());
    const btnExportAllPresets = document.getElementById("btn-export-all-presets");
    if (btnExportAllPresets) btnExportAllPresets.addEventListener("click", exportAllPresets);

    showToast("Llama GUI ready", "info");

    const initStatus = await checkStatus();
    if (initStatus && initStatus.running) {
        await restoreRunningState(initStatus);
    }
    await loadStartupPresetFromUrl();
    clearAppReloadParam();
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
    document.querySelectorAll(".nav-item").forEach(navItem => {
        navItem.addEventListener("click", () => switchTab(navItem.dataset.section));
    });
    const mobileToggle = document.getElementById("mobile-toggle");
    if (mobileToggle) {
        mobileToggle.addEventListener("click", () => {
            document.getElementById("sidebar").classList.toggle("open");
        });
    }
}

function switchTab(tabId) {
    if (chatUi && typeof chatUi.onTabChanged === "function") chatUi.onTabChanged(tabId);
    document.querySelectorAll(".nav-item").forEach(t => t.classList.toggle("active", t.dataset.section === tabId));
    document.querySelectorAll(".section-panel").forEach(panel => {
        panel.style.display = panel.id === "section-" + tabId ? "" : "none";
    });
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("open");
    if (tabId === "presets") loadPresets();
    if (tabId === "benchmarking") benchmarkUi.onShow();
    if (tabId === "quick-launch") {
        refreshQuickLaunchUI();
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

function initInstallButtons() {
    document.getElementById("btn-install").addEventListener("click", installRelease);
    document.getElementById("btn-update").addEventListener("click", checkForUpdates);
    document.getElementById("btn-repair").addEventListener("click", repairInstall);
    document.getElementById("btn-remove-llama").addEventListener("click", removeLlamaFiles);
    document.getElementById("btn-stop-app").addEventListener("click", stopPythonServer);
    document.getElementById("btn-restart-app").addEventListener("click", restartPythonServer);
    document.getElementById("refresh-releases").addEventListener("click", () => fetchReleases(selectedBackendId()));
    document.getElementById("backend-select").addEventListener("change", onBackendChange);
    document.getElementById("btn-open-models").addEventListener("click", () => openFolder("models"));
    document.getElementById("btn-open-llama").addEventListener("click", () => openFolder("llama"));
    document.getElementById("btn-check-app-update").addEventListener("click", checkAppUpdateStatus);
    document.getElementById("btn-update-app").addEventListener("click", updateAppFromGitHub);
    if (typeof checkAppUpdateStatus === "function") {
        checkAppUpdateStatus();
    }
}

function initPresetImport() {
    document.getElementById("preset-import").addEventListener("change", (e) => {
        if (e.target.files.length > 0) handlePresetImport(e.target.files[0]);
        e.target.value = "";
    });
}

function getExecutableSuffix() {
    if (typeof latestStatus !== "undefined" && latestStatus && typeof latestStatus.executable_suffix === "string") {
        return latestStatus.executable_suffix;
    }
    // ponytail: fallback sniffs navigator.userAgent (frontend platform decision).
    // Acceptable because the primary path uses backend status; remove when
    // executable_suffix is guaranteed in every status response.
    const ua = navigator.userAgent || "";
    return /Windows/i.test(ua) ? ".exe" : "";
}

function getToolBinaryName(tool) {
    return tool + getExecutableSuffix();
}

function handleLifecycleSnapshot(state) {
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
    if (document.getElementById("model-switch-card")) {
        modelSwitchUi.refresh().catch(error => console.debug("Failed to refresh Model Switcher", error));
    }
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
        showToast("Server is ready!", "success");
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
    return { tool, args };
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

function startStatsPolling() {
    stopStatsPolling();
    const epoch = statsEpoch;
    chatStatsBaseline = { promptTokens: 0, genTokens: 0 };
    chatStatsRaw = { promptTokens: 0, genTokens: 0 };
    document.getElementById("stats-bar").classList.remove("hidden");
    statsInitialTimer = setTimeout(() => {
        statsInitialTimer = null;
        pollStats(epoch);
    }, 2000);
    statsTimer = setInterval(() => pollStats(epoch), 3000);
}

function stopStatsPolling() {
    statsEpoch += 1;
    if (statsInitialTimer) {
        clearTimeout(statsInitialTimer);
        statsInitialTimer = null;
    }
    if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
    }
    if (statsAbortController) {
        statsAbortController.abort();
        statsAbortController = null;
    }
    statsActiveEpoch = null;
    document.getElementById("stats-bar").classList.add("hidden");
    document.getElementById("stats-prompt-tokens").textContent = "--";
    document.getElementById("stats-prompt-speed").textContent = "--";
    document.getElementById("stats-gen-tokens").textContent = "--";
    document.getElementById("stats-gen-speed").textContent = "--";
    document.getElementById("stats-context").textContent = "--";
    document.getElementById("stats-kv-usage").textContent = "--%";
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
        const data = await fetchJson("/api/estimate-memory", {
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
    chatStatsBaseline.promptTokens = chatStatsRaw.promptTokens;
    chatStatsBaseline.genTokens = chatStatsRaw.genTokens;
}

async function pollStats(epoch = statsEpoch) {
    if (epoch !== statsEpoch || statsActiveEpoch === epoch) return;
    statsActiveEpoch = epoch;
    const controller = new AbortController();
    statsAbortController = controller;
    try {
        const { host, port } = getServerEndpointConfig();
        const params = new URLSearchParams({ host, port: String(port) });
        const resp = await fetch(`/api/llama/metrics?${params.toString()}`, {
            headers: getApiAuthorizationHeaders(),
            signal: controller.signal,
        });
        if (epoch !== statsEpoch || !resp.ok) return;
        const text = await resp.text();
        if (epoch !== statsEpoch) return;
        const metrics = {};
        for (const line of text.split("\n")) {
            if (line.startsWith("#") || !line.trim()) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) metrics[parts[0]] = parseFloat(parts[1]);
        }
        const promptTokens = metrics["llamacpp:prompt_tokens_total"];
        const promptSpeed = metrics["llamacpp:prompt_tokens_seconds"];
        const genTokens = metrics["llamacpp:tokens_predicted_total"];
        const genSpeed = metrics["llamacpp:predicted_tokens_seconds"];
        let kvUsage = metrics["llamacpp:kv_cache_usage_ratio"];
        if (kvUsage === undefined) {
            kvUsage = await fetchSlotKvUsage(host, port, controller.signal);
        }
        if (epoch !== statsEpoch) return;
        if (promptTokens !== undefined) chatStatsRaw.promptTokens = promptTokens;
        if (genTokens !== undefined) chatStatsRaw.genTokens = genTokens;
        const deltaPrompt = promptTokens !== undefined ? Math.max(0, promptTokens - chatStatsBaseline.promptTokens) : null;
        const deltaGen = genTokens !== undefined ? Math.max(0, genTokens - chatStatsBaseline.genTokens) : null;
        if (deltaPrompt !== null) {
            document.getElementById("stats-prompt-tokens").textContent = deltaPrompt.toLocaleString();
        }
        if (promptSpeed !== undefined) {
            document.getElementById("stats-prompt-speed").textContent = promptSpeed.toFixed(1);
        }
        if (deltaGen !== null) {
            document.getElementById("stats-gen-tokens").textContent = deltaGen.toLocaleString();
        }
        if (genSpeed !== undefined) {
            document.getElementById("stats-gen-speed").textContent = genSpeed.toFixed(1);
        }
        if (deltaPrompt !== null && deltaGen !== null) {
            document.getElementById("stats-context").textContent = (deltaPrompt + deltaGen).toLocaleString();
        }
        if (kvUsage !== undefined) {
            document.getElementById("stats-kv-usage").textContent = (kvUsage * 100).toFixed(0) + "%";
        }
    } catch (e) {
        if (e.name !== "AbortError" && epoch === statsEpoch) {
            console.debug("Failed to fetch llama-server metrics", e);
        }
    } finally {
        if (statsActiveEpoch === epoch) statsActiveEpoch = null;
        if (statsAbortController === controller) statsAbortController = null;
    }
}

async function refreshRuntimeStatusPanels() {
    const status = await checkStatus();
    updateChatStatusBadge();
    updateApiEndpoints();
    benchmarkUi.refreshStatus();
    modelSwitchUi.refresh().catch(error => console.debug("Failed to refresh Model Switcher", error));
    return status;
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
    if (outcome.ok && shouldAdoptBenchmark) benchmarkUi.restoreRunningState(status);
    return outcome;
}

async function fetchSlotKvUsage(host, port, signal) {
    try {
        const params = new URLSearchParams({ host, port: String(port) });
        const resp = await fetch(`/api/llama/slots?${params.toString()}`, {
            headers: getApiAuthorizationHeaders(),
            signal,
        });
        if (!resp.ok) return undefined;
        const slots = await resp.json();
        return getSlotKvUsage(slots);
    } catch (e) {
        console.debug("Failed to fetch llama-server slots for KV usage", e);
        return undefined;
    }
}

function getSlotKvUsage(slots) {
    if (!Array.isArray(slots)) return undefined;
    let maxUsage;
    for (const slot of slots) {
        const nCtx = Number(slot?.n_ctx);
        if (!Number.isFinite(nCtx) || nCtx <= 0) continue;
        const tokenState = Array.isArray(slot.next_token) ? slot.next_token[0] : null;
        const nDecoded = Number(tokenState?.n_decoded);
        if (!Number.isFinite(nDecoded) || nDecoded < 0) continue;
        const usage = Math.max(0, Math.min(1, nDecoded / nCtx));
        maxUsage = maxUsage === undefined ? usage : Math.max(maxUsage, usage);
    }
    return maxUsage;
}

async function pollOutput() {
    const request = processOutputCursor.getRequest();
    if (pollOutputActiveEpoch === request.epoch) return;
    pollOutputActiveEpoch = request.epoch;
    try {
        const data = await fetchJson(request.url);
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
    const terminal = document.getElementById("output-terminal");
    const line = document.createElement("div");
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
}

function clearOutput() {
    document.getElementById("output-terminal").innerHTML = "";
    processOutputCursor.reset();
}

async function sendInput() {
    const input = document.getElementById("cli-input");
    const text = input.value;
    if (!text) return;
    input.value = "";
    try {
        await fetchJson("/api/send-input", {
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
    navigator.clipboard.writeText(text).catch((e) => console.debug("Clipboard write failed", e));
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
        copyText(command);
        showToast("Command copied", "info");
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
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    capToastStack(container);
    if (Number.isFinite(duration) && duration > 0) {
        const timerId = setTimeout(() => dismissToast(toast), duration);
        toast.dataset.timerId = String(timerId);
    }
}

// Chat Tab

chatUi.configure({
    flagCore,
    confirmAction,
    getLatestStatus: () => latestStatus,
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
