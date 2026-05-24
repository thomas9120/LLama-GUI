function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

const flagCore = window.LlamaGui.flagCore;
const configFlagsUi = window.LlamaGui.configFlagsUi;
flagCore.setCurrentToolValue("llama-server");
flagCore.replaceFlagValues(getDefaultValues());
let outputTimer = null;
let lastOutputLen = 0;
let statsTimer = null;
let pollOutputActive = false;
let pollStatsActive = false;
let pollOutputFailCount = 0;
let serverReadyNotified = false;

let selectedChatTemplatePresetValue = "";

let chatStatsBaseline = { promptTokens: 0, genTokens: 0 };
let chatStatsRaw = { promptTokens: 0, genTokens: 0 };
// Shared Quick Launch and sampler data is defined in app-data.js.
const apiTab = window.LlamaGui.apiTab;
apiTab.configure({
    flagCore,
    copyText,
    getLatestStatus: () => latestStatus,
});
const {
    getServerBaseUrl,
    getServerEndpointConfig,
} = apiTab;
const initApiTab = apiTab.init;
const updateApiEndpoints = apiTab.updateEndpoints;
const chatUi = window.LlamaGui.chatUi;
const samplerPresets = window.LlamaGui.samplerPresets;
const quickLaunchUi = window.LlamaGui.quickLaunchUi;
samplerPresets.configure({
    flagCore,
    getFlags: () => FLAGS,
    getDefaultFlagValues: getDefaultValues,
    confirmAction,
    refreshSamplerPresetSelect: () => quickLaunchUi.refreshSamplerPresetSelect(),
});
const remoteTunnelUi = window.LlamaGui.remoteTunnelUi;
remoteTunnelUi.configure({
    fetchJson,
    copyText,
    getServerEndpointConfig,
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
    copyQuickServerUrl,
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
    confirmAction,
});

function syncUiAfterToolChange(nextTool) {
    const toolSel = document.getElementById("tool-select");
    if (toolSel && toolSel.value !== nextTool) {
        toolSel.value = nextTool;
    }

    configFlagsUi.resetOpenCategories();
    configFlagsUi.renderFlags();
    flagCore.updateCommandPreview();
}

function syncUiAfterSharedStateChange() {
    configFlagsUi.restoreFlagInputs();
    restoreCustomLaunchArgsInput();
    flagCore.updateCommandPreview();
    refreshChatSidebarUI();
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
    getFlagsByCategory,
    getFlags: () => FLAGS,
    switchTab,
    createSamplerPresetControls: samplerPresets.createSamplerPresetControls,
    refreshQuickLaunchUI,
    browseForPathFlag,
    showStatus,
    setChatTemplateValue,
    getSelectedChatTemplateDropdownValue,
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
    },
    afterToolChange: syncUiAfterToolChange,
    beforePathPatch(flagId, value, patch) {
        if (flagId === "mmproj" && value) {
            patch.no_mmproj = false;
        }
        if (flagId === "chat_template_custom") {
            patch.chat_template = undefined;
            const matchedPreset = getChatTemplatePresetByPath(value);
            selectedChatTemplatePresetValue = matchedPreset ? matchedPreset.value : "";
        }
    },
    afterPatch(patch, options) {
        quickLaunchUi.afterPatch(patch, options);
    },
    afterApply(values) {
        selectedChatTemplatePresetValue = "";
        if (values.chat_template_custom) {
            const bundled = getChatTemplatePresetByPath(values.chat_template_custom);
            if (bundled) selectedChatTemplatePresetValue = bundled.value;
        } else if (values.chat_template) {
            const builtin = getChatTemplatePresetByBuiltinName(values.chat_template);
            if (builtin) selectedChatTemplatePresetValue = builtin.value;
        }
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
    if (selectedChatTemplatePresetValue === "__koboldcpp_automatic__"
        && !values.chat_template
        && !values.chat_template_custom) {
        return selectedChatTemplatePresetValue;
    }

    const bundledPreset = getChatTemplatePresetByPath(values.chat_template_custom);
    if (bundledPreset) {
        selectedChatTemplatePresetValue = bundledPreset.value;
        return bundledPreset.value;
    }

    const builtinPreset = getChatTemplatePresetByBuiltinName(values.chat_template);
    if (builtinPreset) {
        selectedChatTemplatePresetValue = builtinPreset.value;
        return builtinPreset.value;
    }

    selectedChatTemplatePresetValue = "";
    return isSupportedChatTemplateValue(values.chat_template) ? String(values.chat_template ?? "") : "";
}

function getQuickTemplateSummaryText() {
    const selectedTemplateValue = getSelectedChatTemplateDropdownValue();
    const preset = getChatTemplatePresetByValue(selectedTemplateValue);
    if (preset) {
        if (preset.mode === "bundled") {
            return `Using bundled template preset: ${preset.label}.`;
        }
        if (preset.mode === "auto_alias") {
            return `Using model-provided template preset: ${preset.label}.`;
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
        selectedChatTemplatePresetValue = preset.value;
        flagCore.setMultipleFlagValues({
            chat_template: undefined,
            chat_template_custom: preset.path,
        });
        return;
    }

    if (preset && (preset.mode === "auto" || preset.mode === "auto_alias")) {
        selectedChatTemplatePresetValue = preset.value;
        flagCore.setMultipleFlagValues({
            chat_template: undefined,
            chat_template_custom: undefined,
        });
        return;
    }

    if (preset && preset.mode === "builtin") {
        selectedChatTemplatePresetValue = preset.value;
        flagCore.setMultipleFlagValues({
            chat_template: preset.builtin,
            chat_template_custom: undefined,
        });
        return;
    }

    selectedChatTemplatePresetValue = "";
    const patch = {
        chat_template: normalizedValue || undefined,
    };
    if (!options.preserveCustomTemplateFile) {
        patch.chat_template_custom = undefined;
    }
    flagCore.setMultipleFlagValues(patch);
}

function setReasoningMode(value, options = {}) {
    const normalized = value === "on" || value === "off" ? value : "auto";
    flagCore.setFlagValue("reasoning", normalized, options);
}

function updateQuickLaunchActionButtons() {
    quickLaunchUi.updateActionButtons();
}

function syncQuickLaunchModelOptions() {
    quickLaunchUi.syncModelOptions();
}

function refreshQuickSamplerPresetSelect() {
    quickLaunchUi.refreshSamplerPresetSelect();
}

function refreshQuickLaunchUI() {
    quickLaunchUi.refresh();
}

function initQuickLaunch() {
    quickLaunchUi.init();
}

document.addEventListener("DOMContentLoaded", async () => {
    initTabs();
    initToolSelect();
    initConfigControls();
    initCustomLaunchArgsControls();
    initInstallButtons();
    initApiTab();
    remoteTunnelUi.init();
    initPresetImport();
    initPresetLibraryControls();
    initQuickLaunch();
    initChatTab();
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
    if (btnCopyServerUrl) btnCopyServerUrl.addEventListener("click", copyServerUrl);
    const btnSavePreset = document.getElementById("btn-save-preset");
    if (btnSavePreset) btnSavePreset.addEventListener("click", savePreset);
    const btnImportPreset = document.getElementById("btn-import-preset");
    if (btnImportPreset) btnImportPreset.addEventListener("click", () => document.getElementById("preset-import").click());
    const btnExportAllPresets = document.getElementById("btn-export-all-presets");
    if (btnExportAllPresets) btnExportAllPresets.addEventListener("click", exportAllPresets);

    showToast("Llama GUI ready", "info");

    const initStatus = await checkStatus();
    if (initStatus && initStatus.running) {
        restoreRunningState(initStatus);
    }
    await loadStartupPresetFromUrl();
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
    document.querySelectorAll(".nav-item").forEach(t => t.classList.toggle("active", t.dataset.section === tabId));
    document.querySelectorAll(".section-panel").forEach(panel => {
        panel.style.display = panel.id === "section-" + tabId ? "" : "none";
    });
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("open");
    if (tabId === "presets") loadPresets();
    if (tabId === "quick-launch") refreshQuickLaunchUI();
    if (tabId === "chat") {
        refreshChatSidebarUI();
        refreshRuntimeStatusPanels();
    }
    if (tabId === "configure") flagCore.updateCommandPreview();
    if (tabId === "api") {
        Promise.resolve(checkStatus()).finally(() => {
            updateApiEndpoints();
            remoteTunnelUi.refreshStatus();
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

function updateServerAddressPreview() {
    const el = document.getElementById("server-address");
    if (flagCore.getCurrentTool() !== "llama-server") {
        el.classList.add("hidden");
        return;
    }
    const { baseUrl } = getServerEndpointConfig();
    document.getElementById("server-url").href = baseUrl;
    document.getElementById("server-url").textContent = baseUrl;
    document.getElementById("server-webui").href = baseUrl + "/";
    el.classList.remove("hidden");
}

function updateQuickServerAddressPreview() {
    const el = document.getElementById("quick-server-address");
    if (!el) return;

    if (flagCore.getCurrentTool() !== "llama-server") {
        el.classList.add("hidden");
        return;
    }

    const baseUrl = getServerBaseUrl();
    document.getElementById("quick-server-url").href = baseUrl;
    document.getElementById("quick-server-url").textContent = baseUrl;
    document.getElementById("quick-server-webui").href = baseUrl + "/";
    el.classList.remove("hidden");
}

function initInstallButtons() {
    document.getElementById("btn-install").addEventListener("click", installRelease);
    document.getElementById("btn-update").addEventListener("click", checkForUpdates);
    document.getElementById("btn-repair").addEventListener("click", repairInstall);
    document.getElementById("btn-remove-llama").addEventListener("click", removeLlamaFiles);
    document.getElementById("btn-stop-app").addEventListener("click", stopPythonServer);
    document.getElementById("btn-restart-app").addEventListener("click", restartPythonServer);
    document.getElementById("refresh-releases").addEventListener("click", fetchReleases);
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
    const ua = navigator.userAgent || "";
    return /Windows/i.test(ua) ? ".exe" : "";
}

function getToolBinaryName(tool) {
    return tool + getExecutableSuffix();
}

function restoreRunningState(status) {
    if (!status || !status.running) return;

    const tool = status.active_process_tool || "llama-server";
    flagCore.setCurrentTool(tool);
    const toolSelect = document.getElementById("tool-select");
    if (toolSelect) toolSelect.value = tool;

    if (status.api_target) {
        const patch = {};
        if (status.api_target.host) patch.host = status.api_target.host;
        if (status.api_target.port) patch.port = status.api_target.port;
        if (Object.keys(patch).length > 0) flagCore.setMultipleFlagValues(patch);
    }

    document.getElementById("btn-launch").classList.add("hidden");
    document.getElementById("btn-stop").classList.remove("hidden");
    document.getElementById("output-section").classList.remove("hidden");
    updateQuickLaunchActionButtons();

    if (tool === "llama-cli") {
        document.getElementById("input-row").classList.remove("hidden");
    } else {
        document.getElementById("input-row").classList.add("hidden");
    }

    appendOutput("--- Reconnected to running " + tool + " process ---");
    startOutputPolling();

    if (tool === "llama-server") {
        updateServerAddressPreview();
        updateQuickServerAddressPreview();
        startStatsPolling();
    }

    updateApiEndpoints();
    updateChatStatusBadge();
}

async function launchLlama() {
    const result = flagCore.getLaunchArgs();
    if (result.error) {
        alert(result.error);
        return;
    }
    const args = result.args;
    const tool = flagCore.getCurrentTool();
    const hasModel = args.some(a => {
        const entryValues = Array.isArray(a) ? a : [a];
        return entryValues.includes("-m") || entryValues.includes("-hf");
    });
    if (!hasModel) {
        alert("Select a model or provide an HF repo before launching.");
        return;
    }

    document.getElementById("btn-launch").classList.add("hidden");
    document.getElementById("btn-stop").classList.remove("hidden");
    document.getElementById("output-section").classList.remove("hidden");
    updateQuickLaunchActionButtons();

    if (tool === "llama-cli") {
        document.getElementById("input-row").classList.remove("hidden");
    } else {
        document.getElementById("input-row").classList.add("hidden");
    }

    clearOutput();

    try {
        const launchResult = await fetchJson("/api/launch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool, args }),
        });
        if (launchResult.error) {
            appendOutput("ERROR: " + launchResult.error);
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
            updateQuickLaunchActionButtons();
        } else {
            appendOutput("Started " + tool + " (PID: " + launchResult.pid + ")");
            appendOutput(launchResult.command);
            appendOutput("---");
            startOutputPolling();
            updateServerAddressPreview();

            if (tool === "llama-server") {
                const { baseUrl } = getServerEndpointConfig();
                appendOutput(`Server running at ${baseUrl}`);
                appendOutput(`Web UI: ${baseUrl}/`);
                startStatsPolling();
            }
            await refreshRuntimeStatusPanels();
        }
    } catch (e) {
        appendOutput("ERROR: " + e.message);
        document.getElementById("btn-launch").classList.remove("hidden");
        document.getElementById("btn-stop").classList.add("hidden");
        updateQuickLaunchActionButtons();
        updateChatStatusBadge();
    }
}

async function stopLlama() {
    try {
        await fetchJson("/api/stop", { method: "POST" });
    } catch (e) {
        // ignore
    }
    stopOutputPolling();
    stopStatsPolling();
    appendOutput("--- Process stopped ---");
    document.getElementById("btn-launch").classList.remove("hidden");
    document.getElementById("btn-stop").classList.add("hidden");
    document.getElementById("input-row").classList.add("hidden");
    document.getElementById("server-address").classList.add("hidden");
    updateQuickLaunchActionButtons();
    await refreshRuntimeStatusPanels();
}

function startOutputPolling() {
    lastOutputLen = 0;
    serverReadyNotified = false;
    pollOutputFailCount = 0;
    if (outputTimer) clearInterval(outputTimer);
    outputTimer = setInterval(pollOutput, 300);
}

function stopOutputPolling() {
    if (outputTimer) {
        clearInterval(outputTimer);
        outputTimer = null;
    }
}

function startStatsPolling() {
    stopStatsPolling();
    document.getElementById("stats-bar").classList.remove("hidden");
    setTimeout(() => pollStats(), 2000);
    statsTimer = setInterval(pollStats, 3000);
}

function stopStatsPolling() {
    if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
    }
    document.getElementById("stats-bar").classList.add("hidden");
    document.getElementById("stats-prompt-tokens").textContent = "--";
    document.getElementById("stats-prompt-speed").textContent = "--";
    document.getElementById("stats-gen-tokens").textContent = "--";
    document.getElementById("stats-gen-speed").textContent = "--";
    document.getElementById("stats-context").textContent = "--";
    document.getElementById("stats-kv-usage").textContent = "--%";
}

function snapshotStatsBaseline() {
    chatStatsBaseline.promptTokens = chatStatsRaw.promptTokens;
    chatStatsBaseline.genTokens = chatStatsRaw.genTokens;
}

async function pollStats() {
    if (pollStatsActive) return;
    pollStatsActive = true;
    try {
        const { host, port } = getServerEndpointConfig();
        const params = new URLSearchParams({ host, port: String(port) });
        const resp = await fetch(`/api/llama/metrics?${params.toString()}`);
        if (!resp.ok) return;
        const text = await resp.text();
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
            kvUsage = await fetchSlotKvUsage(host, port);
        }
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
        console.debug("Failed to fetch llama-server metrics", e);
    } finally {
        pollStatsActive = false;
    }
}

async function refreshRuntimeStatusPanels() {
    const status = await checkStatus();
    updateChatStatusBadge();
    updateApiEndpoints();
    return status;
}

async function fetchSlotKvUsage(host, port) {
    try {
        const params = new URLSearchParams({ host, port: String(port) });
        const resp = await fetch(`/api/llama/slots?${params.toString()}`);
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
    if (pollOutputActive) return;
    pollOutputActive = true;
    try {
        const data = await fetchJson("/api/output");
        if (data.output.length > lastOutputLen) {
            const newLines = data.output.slice(lastOutputLen);
            for (const line of newLines) {
                appendOutput(line);
                if (!serverReadyNotified && /HTTP server listening/i.test(line)) {
                    serverReadyNotified = true;
                    showToast("Server is ready!", "success");
                }
            }
            lastOutputLen = data.output.length;
        }
        if (!data.running) {
            stopOutputPolling();
            stopStatsPolling();
            appendOutput("--- Process exited ---");
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
            document.getElementById("input-row").classList.add("hidden");
            document.getElementById("server-address").classList.add("hidden");
            updateQuickLaunchActionButtons();
            setTimeout(() => refreshRuntimeStatusPanels(), 500);
        }
        pollOutputFailCount = 0;
    } catch (e) {
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
        pollOutputActive = false;
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
    lastOutputLen = 0;
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
        // ignore
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement.id === "cli-input") {
        sendInput();
    }
});

function copyServerUrl() {
    const url = document.getElementById("server-url").href;
    copyText(url);
}

function copyQuickServerUrl() {
    const url = document.getElementById("quick-server-url").href;
    copyText(url);
}

function copyText(text) {
    navigator.clipboard.writeText(text).catch(() => {});
}

function showToast(message, type) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "info");
    const icon = document.createElement("span");
    icon.className = "icon icon-sm toast-icon";
    icon.innerHTML = '<svg viewBox="0 0 24 24">' +
        (type === "success" ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>' +
            '<polyline points="22 4 12 14.01 9 11.01"/>' :
            type === "error" ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' :
                '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>') +
        '</svg>';
    const text = document.createElement("span");
    text.textContent = String(message || "");
    toast.appendChild(icon);
    toast.appendChild(text);
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Chat Tab

chatUi.configure({
    flagCore,
    confirmAction,
    getServerEndpointConfig,
    getLatestStatus: () => latestStatus,
    snapshotStatsBaseline,
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
