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
let remoteTunnelTimer = null;

let selectedChatTemplatePresetValue = "";

let chatMessages = [];
let chatStreaming = false;
let chatAbortController = null;
let currentConversationId = null;
let chatStatsBaseline = { promptTokens: 0, genTokens: 0 };
let chatStatsRaw = { promptTokens: 0, genTokens: 0 };
const CHAT_CONVERSATIONS_STORAGE_KEY = "llama_gui_conversations";
const CHAT_WEB_SEARCH_STORAGE_KEY = "llama_gui_chat_web_search_enabled";
const CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY = "llama_gui_chat_web_search_max_results";
const CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
const CHAT_WEB_SEARCH_MIN_RESULTS = 1;
const CHAT_WEB_SEARCH_MAX_RESULTS = 10;
// Shared Quick Launch and sampler data is defined in app-data.js.

let quickLaunchFitCtxLinked = true;
let quickLaunchGpuCustomSelected = false;
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
const hfDownloadUi = window.LlamaGui.hfDownloadUi;
hfDownloadUi.configure({
    flagCore,
    fetchJson,
    confirmAction,
    refreshModels,
    applyPresetModel,
    refreshQuickLaunchUI,
});

function getSamplerFlags() {
    return FLAGS.filter(f => f.category === "sampling");
}

function loadSamplerPresetStore() {
    try {
        const raw = localStorage.getItem(SAMPLER_PRESET_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed;
    } catch (_) {
        return {};
    }
}

function saveSamplerPresetStore(store) {
    localStorage.setItem(SAMPLER_PRESET_STORAGE_KEY, JSON.stringify(store));
}

function collectSamplerValues() {
    const values = {};
    const currentValues = flagCore.getFlagValues();
    for (const f of getSamplerFlags()) {
        const v = currentValues[f.id];
        if (v !== undefined && v !== null && v !== "") {
            values[f.id] = v;
        }
    }
    return values;
}

function normalizeSamplerPresetValues(values) {
    const result = {};
    if (!values || typeof values !== "object" || Array.isArray(values)) return result;

    const allowed = new Set(getSamplerFlags().map(f => f.id));
    for (const [k, v] of Object.entries(values)) {
        if (allowed.has(k)) {
            result[k] = v;
        }
    }
    return result;
}

function getAllSamplerPresets() {
    const custom = loadSamplerPresetStore();
    const entries = [];

    for (const [name, values] of Object.entries(BUILTIN_SAMPLER_PRESETS)) {
        entries.push({ name, values: normalizeSamplerPresetValues(values), source: "builtin" });
    }
    for (const [name, values] of Object.entries(custom)) {
        entries.push({ name, values: normalizeSamplerPresetValues(values), source: "custom" });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function applySamplerPresetValues(values) {
    const defaults = getDefaultValues();
    const patch = {};
    for (const f of getSamplerFlags()) {
        if (Object.prototype.hasOwnProperty.call(values, f.id)) {
            patch[f.id] = values[f.id];
        } else if (Object.prototype.hasOwnProperty.call(defaults, f.id)) {
            patch[f.id] = defaults[f.id];
        } else {
            patch[f.id] = undefined;
        }
    }
    flagCore.setMultipleFlagValues(patch);
}

function createSamplerPresetControls() {
    const panel = document.createElement("div");
    panel.className = "sampler-presets";

    const title = document.createElement("div");
    title.className = "sampler-presets-title";
    title.textContent = "Sampler Presets";

    const row = document.createElement("div");
    row.className = "sampler-presets-row";

    const select = document.createElement("select");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Preset name...";

    const loadBtn = document.createElement("button");
    loadBtn.className = "btn btn-sm";
    loadBtn.type = "button";
    loadBtn.textContent = "Load";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-sm";
    saveBtn.type = "button";
    saveBtn.textContent = "Save";

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-sm btn-danger";
    delBtn.type = "button";
    delBtn.textContent = "Delete";

    const exportBtn = document.createElement("button");
    exportBtn.className = "btn btn-sm";
    exportBtn.type = "button";
    exportBtn.textContent = "Export";

    const importBtn = document.createElement("button");
    importBtn.className = "btn btn-sm";
    importBtn.type = "button";
    importBtn.textContent = "Import";

    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".json";
    importInput.style.display = "none";

    const getSelectedPresetEntry = () => {
        const value = select.value;
        if (!value) return null;
        const [source, ...nameParts] = value.split("|");
        const name = nameParts.join("|");
        if (!name) return null;
        const entries = getAllSamplerPresets();
        return entries.find(e => e.source === source && e.name === name) || null;
    };

    const buildUniqueName = (base, takenNames) => {
        if (!takenNames.has(base)) return base;
        let idx = 2;
        let candidate = `${base} (${idx})`;
        while (takenNames.has(candidate)) {
            idx += 1;
            candidate = `${base} (${idx})`;
        }
        return candidate;
    };

    const refreshOptions = () => {
        const entries = getAllSamplerPresets();
        const builtins = entries.filter(e => e.source === "builtin");
        const customs = entries.filter(e => e.source === "custom");
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = entries.length ? "-- Select Sampler Preset --" : "No sampler presets";
        select.appendChild(placeholder);

        if (builtins.length) {
            const group = document.createElement("optgroup");
            group.label = "Built-in";
            for (const p of builtins) {
                const opt = document.createElement("option");
                opt.value = `builtin|${p.name}`;
                opt.textContent = p.name;
                group.appendChild(opt);
            }
            select.appendChild(group);
        }

        if (customs.length) {
            const group = document.createElement("optgroup");
            group.label = "Custom";
            for (const p of customs) {
                const opt = document.createElement("option");
                opt.value = `custom|${p.name}`;
                opt.textContent = p.name;
                group.appendChild(opt);
            }
            select.appendChild(group);
        }

        if (entries.length) {
            const first = entries[0];
            select.value = `${first.source}|${first.name}`;
        }
    };

    loadBtn.addEventListener("click", () => {
        const selected = getSelectedPresetEntry();
        if (!selected) return;
        applySamplerPresetValues(selected.values);
    });

    saveBtn.addEventListener("click", () => {
        const typedName = nameInput.value.trim();
        const selected = getSelectedPresetEntry();
        const name = typedName || (selected && selected.source === "custom" ? selected.name : "");
        if (!name) {
            nameInput.focus();
            return;
        }
        const store = loadSamplerPresetStore();
        store[name] = normalizeSamplerPresetValues(collectSamplerValues());
        saveSamplerPresetStore(store);
        refreshOptions();
        refreshQuickSamplerPresetSelect();
        select.value = `custom|${name}`;
        nameInput.value = "";
    });

    delBtn.addEventListener("click", async () => {
        const selected = getSelectedPresetEntry();
        if (!selected) return;
        if (selected.source !== "custom") {
            alert("Built-in sampler presets cannot be deleted.");
            return;
        }
        const ok = await confirmAction(
            "Delete Sampler Preset",
            `Delete sampler preset "${selected.name}"? This cannot be undone.`,
            "Delete"
        );
        if (!ok) return;

        const store = loadSamplerPresetStore();
        delete store[selected.name];
        saveSamplerPresetStore(store);
        refreshOptions();
        refreshQuickSamplerPresetSelect();
    });

    exportBtn.addEventListener("click", () => {
        const selected = getSelectedPresetEntry();
        if (!selected) return;

        const payload = {
            name: selected.name,
            values: normalizeSamplerPresetValues(selected.values),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${selected.name.replace(/[<>:"/\\|?*]/g, "_")}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    importBtn.addEventListener("click", () => importInput.click());

    importInput.addEventListener("change", async () => {
        if (!importInput.files || importInput.files.length === 0) return;
        const file = importInput.files[0];
        importInput.value = "";

        try {
            const text = await file.text();
            const parsed = JSON.parse(text);

            const incoming = [];
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                if (parsed.name && parsed.values && typeof parsed.values === "object") {
                    incoming.push({ name: String(parsed.name), values: parsed.values });
                } else if (parsed.presets && typeof parsed.presets === "object") {
                    for (const [name, values] of Object.entries(parsed.presets)) {
                        incoming.push({ name, values });
                    }
                }
            }

            if (incoming.length === 0) {
                alert("Invalid sampler preset JSON format.");
                return;
            }

            const store = loadSamplerPresetStore();
            const taken = new Set([
                ...Object.keys(BUILTIN_SAMPLER_PRESETS),
                ...Object.keys(store),
            ]);

            let lastImportedName = "";
            for (const item of incoming) {
                const baseName = String(item.name || "Imported Sampler").trim() || "Imported Sampler";
                const uniqueName = buildUniqueName(baseName, taken);
                taken.add(uniqueName);
                store[uniqueName] = normalizeSamplerPresetValues(item.values);
                lastImportedName = uniqueName;
            }

            saveSamplerPresetStore(store);
            refreshOptions();
            refreshQuickSamplerPresetSelect();
            if (lastImportedName) {
                select.value = `custom|${lastImportedName}`;
            }
        } catch (e) {
            alert("Failed to import sampler preset: " + e.message);
        }
    });

    row.appendChild(select);
    row.appendChild(nameInput);
    row.appendChild(loadBtn);
    row.appendChild(saveBtn);
    row.appendChild(delBtn);
    row.appendChild(exportBtn);
    row.appendChild(importBtn);
    panel.appendChild(title);
    panel.appendChild(row);
    panel.appendChild(importInput);

    refreshOptions();
    return panel;
}

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
    createSamplerPresetControls,
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
        if (Object.prototype.hasOwnProperty.call(options, "quickLaunchFitCtxLinked")) {
            quickLaunchFitCtxLinked = options.quickLaunchFitCtxLinked;
        } else if (Object.prototype.hasOwnProperty.call(patch || {}, "fit_ctx")
            || Object.prototype.hasOwnProperty.call(patch || {}, "ctx_size")) {
            const values = flagCore.getFlagValues();
            const fitCtx = values.fit_ctx;
            const ctxSize = values.ctx_size;
            quickLaunchFitCtxLinked = fitCtx === undefined || fitCtx === ctxSize;
        }

        if (Object.prototype.hasOwnProperty.call(options, "quickLaunchGpuCustomSelected")) {
            quickLaunchGpuCustomSelected = options.quickLaunchGpuCustomSelected;
        } else if (Object.prototype.hasOwnProperty.call(patch || {}, "gpu_layers")) {
            const values = flagCore.getFlagValues();
            const gpuLayers = String(values.gpu_layers ?? "auto");
            quickLaunchGpuCustomSelected = gpuLayers !== "auto" && gpuLayers !== "0" && gpuLayers !== "all";
        }
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
        const fitCtx = values.fit_ctx;
        const ctxSize = values.ctx_size;
        quickLaunchFitCtxLinked = fitCtx === undefined || fitCtx === ctxSize;
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

function populateQuickTemplatePackOptions() {
    const select = document.getElementById("quick-template-pack");
    if (!select) return;

    select.innerHTML = "";
    const chatTemplateFlag = FLAGS.find((f) => f.id === "chat_template");
    for (const pack of chatTemplateFlag?.options || []) {
        const opt = document.createElement("option");
        opt.value = pack.value;
        opt.textContent = pack.label;
        select.appendChild(opt);
    }
}

function syncQuickLaunchModelOptions() {
    const mainSelect = document.getElementById("model-select");
    const quickSelect = document.getElementById("quick-model-select");
    if (!mainSelect || !quickSelect) return;

    const currentQuickValue = quickSelect.value;
    quickSelect.innerHTML = "";
    for (const option of Array.from(mainSelect.options)) {
        quickSelect.appendChild(option.cloneNode(true));
    }

    const preferredValue = mainSelect.value || currentQuickValue || "";
    const hasPreferredValue = Array.from(quickSelect.options).some((opt) => opt.value === preferredValue);
    quickSelect.value = hasPreferredValue ? preferredValue : "";
    flagCore.setSelectedModelValue(mainSelect.value || "");
}

function applyQuickTemplatePack(templateValue) {
    setChatTemplateValue(templateValue);
}

function getSelectedQuickSamplerEntry() {
    const select = document.getElementById("quick-sampler-select");
    if (!select || !select.value) return null;
    const [source, ...nameParts] = String(select.value).split("|");
    const name = nameParts.join("|");
    return getAllSamplerPresets().find((entry) => entry.source === source && entry.name === name) || null;
}

function refreshQuickSamplerPresetSelect() {
    const select = document.getElementById("quick-sampler-select");
    if (!select) return;

    const previous = select.value;
    const entries = getAllSamplerPresets();
    const builtins = entries.filter((entry) => entry.source === "builtin");
    const customs = entries.filter((entry) => entry.source === "custom");

    select.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = entries.length ? "-- Select Sampler Preset --" : "No sampler presets";
    select.appendChild(placeholder);

    if (builtins.length) {
        const group = document.createElement("optgroup");
        group.label = "Built-in";
        for (const preset of builtins) {
            const opt = document.createElement("option");
            opt.value = `builtin|${preset.name}`;
            opt.textContent = preset.name;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }

    if (customs.length) {
        const group = document.createElement("optgroup");
        group.label = "Custom";
        for (const preset of customs) {
            const opt = document.createElement("option");
            opt.value = `custom|${preset.name}`;
            opt.textContent = preset.name;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }

    const hasPrevious = Array.from(select.options).some((opt) => opt.value === previous);
    if (hasPrevious) {
        select.value = previous;
    }
}

function applyQuickProfile(profileId) {
    const profile = QUICK_PROFILES[profileId];
    if (!profile) return;

    flagCore.setCurrentTool(profile.tool || "llama-server");
    flagCore.setMultipleFlagValues(profile.flags || {}, { quickLaunchFitCtxLinked: true });

    if (profile.samplerPresetName) {
        const preset = getAllSamplerPresets().find((entry) => entry.name === profile.samplerPresetName);
        if (preset) {
            applySamplerPresetValues(preset.values);
            return;
        }
    }
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

function setQuickLaunchContextValue(rawValue, options = {}) {
    const parsed = rawValue === "" || rawValue === null || rawValue === undefined
        ? undefined
        : parseInt(rawValue, 10);
    const nextCtxSize = Number.isFinite(parsed) ? parsed : undefined;
    const patch = { ctx_size: nextCtxSize };

    if (quickLaunchFitCtxLinked || options.forceFitSync) {
        patch.fit_ctx = nextCtxSize;
    }

    flagCore.setMultipleFlagValues(patch);
}

function setQuickLaunchGpuLayers(value) {
    if (value === "custom") {
        const customInput = document.getElementById("quick-gpu-custom");
        const customValue = String(customInput && customInput.value ? customInput.value : "").trim();
        const normalized = flagCore.normalizeGpuLayersValue(customValue);
        if (customInput) {
            customInput.setCustomValidity(customValue && normalized === undefined ? "Use auto, all, 0, or a non-negative integer." : "");
        }
        if (normalized !== undefined) {
            flagCore.setFlagValue("gpu_layers", normalized, { quickLaunchGpuCustomSelected: true });
        } else {
            quickLaunchGpuCustomSelected = true;
            flagCore.setFlagValue("gpu_layers", undefined, { quickLaunchGpuCustomSelected: true });
        }
    } else {
        flagCore.setFlagValue("gpu_layers", value || "auto", { quickLaunchGpuCustomSelected: false });
    }
}

function updateQuickLaunchActionButtons() {
    const quickLaunchBtn = document.getElementById("btn-quick-launch");
    const quickStopBtn = document.getElementById("btn-quick-stop");
    const mainLaunchBtn = document.getElementById("btn-launch");
    const mainStopBtn = document.getElementById("btn-stop");
    if (!quickLaunchBtn || !quickStopBtn || !mainLaunchBtn || !mainStopBtn) return;

    quickLaunchBtn.classList.toggle("hidden", mainLaunchBtn.classList.contains("hidden"));
    quickStopBtn.classList.toggle("hidden", mainStopBtn.classList.contains("hidden"));
}

function refreshQuickLaunchUI() {
    const quickCommand = document.getElementById("quick-command-preview");
    if (!quickCommand) return;
    const values = flagCore.getFlagValues();
    const tool = flagCore.getCurrentTool();

    if (quickLaunchFitCtxLinked !== false) {
        quickLaunchFitCtxLinked = values.fit_ctx === undefined || values.fit_ctx === values.ctx_size;
    }
    syncQuickLaunchModelOptions();
    refreshQuickSamplerPresetSelect();

    const mainModelSelect = document.getElementById("model-select");
    const quickModelSelect = document.getElementById("quick-model-select");
    if (quickModelSelect && mainModelSelect) {
        quickModelSelect.value = mainModelSelect.value || "";
        flagCore.setSelectedModelValue(mainModelSelect.value || "");
    }

    for (const radio of document.querySelectorAll('input[name="quick-launch-mode"]')) {
        radio.checked = radio.value === tool;
    }

    const modeSummary = document.getElementById("quick-mode-summary");
    if (modeSummary) {
        modeSummary.textContent = tool === "llama-server"
            ? "API Server is selected. This exposes the web UI and OpenAI-compatible endpoints."
            : "Chat mode is selected. The process runs as an interactive local terminal chat.";
    }

    const ctxValue = values.ctx_size ?? 16000;
    const contextPreset = document.getElementById("quick-context-preset");
    const contextCustom = document.getElementById("quick-context-custom");
    if (contextPreset && contextCustom) {
        const ctxString = String(ctxValue);
        if (QUICK_CONTEXT_PRESETS.includes(ctxString)) {
            contextPreset.value = ctxString;
            contextCustom.value = "";
            contextCustom.disabled = true;
        } else {
            contextPreset.value = "custom";
            contextCustom.value = ctxString;
            contextCustom.disabled = false;
        }
    }

    const gpuMode = document.getElementById("quick-gpu-mode");
    const gpuCustom = document.getElementById("quick-gpu-custom");
    const gpuLayers = String(values.gpu_layers ?? "auto");
    if (gpuMode && gpuCustom) {
        const hasCustomGpuValue = gpuLayers !== "auto" && gpuLayers !== "0" && gpuLayers !== "all";
        if (hasCustomGpuValue) {
            quickLaunchGpuCustomSelected = true;
        } else if (!quickLaunchGpuCustomSelected) {
            quickLaunchGpuCustomSelected = false;
        }

        if (!quickLaunchGpuCustomSelected && (gpuLayers === "auto" || gpuLayers === "0" || gpuLayers === "all")) {
            gpuMode.value = gpuLayers;
            gpuCustom.value = "";
            gpuCustom.disabled = true;
        } else {
            gpuMode.value = "custom";
            gpuCustom.value = hasCustomGpuValue ? gpuLayers : "";
            gpuCustom.disabled = false;
        }
    }

    const fitToggle = document.getElementById("quick-fit-toggle");
    const fitTarget = document.getElementById("quick-fit-target");
    const fitCtx = document.getElementById("quick-fit-ctx");
    if (fitToggle) fitToggle.value = String(values.fit ?? "on");
    if (fitTarget) fitTarget.value = String(values.fit_target ?? "1024");
    if (fitCtx) fitCtx.value = values.fit_ctx ?? "";

    const fitSummary = document.getElementById("quick-fit-summary");
    if (fitSummary) {
        fitSummary.textContent = String(values.fit ?? "on") === "on"
            ? `Auto Fit will leave about ${values.fit_target ?? "1024"} MiB free and will not shrink below ${values.fit_ctx ?? ctxValue} context.`
            : "Auto Fit is off, so llama.cpp will use your manual memory settings as-is.";
    }

    const templateSelect = document.getElementById("quick-template-pack");
    const templateSummary = document.getElementById("quick-template-summary");
    const selectedTemplateValue = getSelectedChatTemplateDropdownValue();
    if (templateSelect) {
        const hasOption = Array.from(templateSelect.options).some((opt) => opt.value === selectedTemplateValue);
        templateSelect.value = hasOption ? selectedTemplateValue : "";
    }
    if (templateSummary) {
        templateSummary.textContent = getQuickTemplateSummaryText();
    }

    const temperature = document.getElementById("quick-temperature");
    const topK = document.getElementById("quick-top-k");
    const topP = document.getElementById("quick-top-p");
    const minP = document.getElementById("quick-min-p");
    const repeatPenalty = document.getElementById("quick-repeat-penalty");
    if (temperature) temperature.value = values.temperature ?? "";
    if (topK) topK.value = values.top_k ?? "";
    if (topP) topP.value = values.top_p ?? "";
    if (minP) minP.value = values.min_p ?? "";
    if (repeatPenalty) repeatPenalty.value = values.repeat_penalty ?? "";

    const profileSummary = document.getElementById("quick-profile-summary");
    const profileSelect = document.getElementById("quick-profile-select");
    if (profileSummary && profileSelect) {
        const profile = QUICK_PROFILES[profileSelect.value];
        profileSummary.textContent = profile
            ? profile.summary
            : "Profiles apply a full starter setup, including context, Auto Fit, GPU offload, and sampler settings.";
    }

    const quickMetricsToggle = document.getElementById("quick-metrics-toggle");
    if (quickMetricsToggle) quickMetricsToggle.checked = values.metrics === true;

    quickCommand.textContent = document.getElementById("command-preview-text").textContent || "";
    quickCommand.classList.toggle("command-preview-error", document.getElementById("command-preview-text").classList.contains("command-preview-error"));
    updateQuickServerAddressPreview();
    updateQuickLaunchActionButtons();
}

function populateQuickProfileOptions() {
    const select = document.getElementById("quick-profile-select");
    if (!select) return;

    const previous = select.value;
    select.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a profile...";
    select.appendChild(placeholder);

    for (const [profileId, profile] of Object.entries(QUICK_PROFILES)) {
        const opt = document.createElement("option");
        opt.value = profileId;
        opt.textContent = profile.label;
        select.appendChild(opt);
    }

    select.value = Object.prototype.hasOwnProperty.call(QUICK_PROFILES, previous) ? previous : "";
}

function initQuickLaunch() {
    const on = (id, event, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, handler);
    };

    populateQuickTemplatePackOptions();
    populateQuickProfileOptions();
    refreshQuickSamplerPresetSelect();
    syncQuickLaunchModelOptions();
    hfDownloadUi.init();

    on("btn-open-configure", "click", () => {
        switchTab("configure");
    });

    on("btn-quick-refresh-models", "click", () => {
        refreshModels();
    });

    on("quick-model-select", "change", (e) => {
        applyPresetModel(e.target.value);
        flagCore.updateCommandPreview();
    });

    for (const radio of document.querySelectorAll('input[name="quick-launch-mode"]')) {
        radio.addEventListener("change", () => {
            if (radio.checked) {
                flagCore.setCurrentTool(radio.value);
            }
        });
    }

    on("quick-profile-select", "change", (e) => {
        applyQuickProfile(e.target.value);
        refreshQuickLaunchUI();
    });

    on("quick-context-preset", "change", (e) => {
        const customInput = document.getElementById("quick-context-custom");
        if (e.target.value === "custom") {
            if (customInput) { customInput.disabled = false; customInput.focus(); }
            return;
        }

        if (customInput) { customInput.disabled = true; customInput.value = ""; }
        setQuickLaunchContextValue(e.target.value);
    });

    on("quick-context-custom", "input", (e) => {
        const rawValue = e.target.value.trim();
        if (rawValue === "") return;
        setQuickLaunchContextValue(rawValue);
    });

    on("quick-gpu-mode", "change", (e) => {
        const gpuCustom = document.getElementById("quick-gpu-custom");
        if (gpuCustom) {
            gpuCustom.disabled = e.target.value !== "custom";
            if (e.target.value === "custom") gpuCustom.focus();
        }
        setQuickLaunchGpuLayers(e.target.value);
    });

    on("quick-gpu-custom", "input", () => {
        const gpuMode = document.getElementById("quick-gpu-mode");
        if (gpuMode && gpuMode.value === "custom") {
            setQuickLaunchGpuLayers("custom");
        }
    });

    on("quick-fit-toggle", "change", (e) => {
        flagCore.setFlagValue("fit", e.target.value || "on");
    });

    on("quick-fit-target", "input", (e) => {
        flagCore.setFlagValue("fit_target", e.target.value.trim() || undefined);
    });

    on("quick-fit-ctx", "input", (e) => {
        const rawValue = e.target.value.trim();
        const nextFitCtx = rawValue === "" ? undefined : parseInt(rawValue, 10);
        flagCore.setFlagValue("fit_ctx", nextFitCtx, { quickLaunchFitCtxLinked: false });
    });

    on("btn-quick-fit-sync", "click", () => {
        const values = flagCore.getFlagValues();
        flagCore.setFlagValue("fit_ctx", values.ctx_size ?? 16000, { quickLaunchFitCtxLinked: true });
    });

    on("quick-template-pack", "change", (e) => {
        applyQuickTemplatePack(e.target.value);
    });

    on("btn-quick-sampler-load", "click", () => {
        const selected = getSelectedQuickSamplerEntry();
        if (!selected) return;
        applySamplerPresetValues(selected.values);
        refreshQuickLaunchUI();
    });

    on("btn-quick-sampler-save", "click", () => {
        const nameInput = document.getElementById("quick-sampler-name");
        if (!nameInput) return;
        const typedName = nameInput.value.trim();
        const selected = getSelectedQuickSamplerEntry();
        const name = typedName || (selected && selected.source === "custom" ? selected.name : "");
        if (!name) {
            nameInput.focus();
            return;
        }

        const store = loadSamplerPresetStore();
        store[name] = normalizeSamplerPresetValues(collectSamplerValues());
        saveSamplerPresetStore(store);
        nameInput.value = "";
        refreshQuickSamplerPresetSelect();
        configFlagsUi.renderFlags();
        const samplerSelect = document.getElementById("quick-sampler-select");
        if (samplerSelect) samplerSelect.value = `custom|${name}`;
    });

    on("btn-quick-sampler-delete", "click", async () => {
        const selected = getSelectedQuickSamplerEntry();
        if (!selected) return;
        if (selected.source !== "custom") {
            alert("Built-in sampler presets cannot be deleted.");
            return;
        }

        const ok = await confirmAction(
            "Delete Sampler Preset",
            `Delete sampler preset "${selected.name}"? This cannot be undone.`,
            "Delete"
        );
        if (!ok) return;

        const store = loadSamplerPresetStore();
        delete store[selected.name];
        saveSamplerPresetStore(store);
        refreshQuickSamplerPresetSelect();
        configFlagsUi.renderFlags();
    });

    const quickSamplerFieldMap = {
        "quick-temperature": "temperature",
        "quick-top-k": "top_k",
        "quick-top-p": "top_p",
        "quick-min-p": "min_p",
        "quick-repeat-penalty": "repeat_penalty",
    };

    for (const [elementId, flagId] of Object.entries(quickSamplerFieldMap)) {
        on(elementId, "input", debounce((e) => {
            const rawValue = e.target.value.trim();
            let nextValue;
            if (rawValue === "") {
                nextValue = undefined;
            } else if (flagId === "top_k") {
                nextValue = parseInt(rawValue, 10);
            } else {
                nextValue = parseFloat(rawValue);
            }
            flagCore.setFlagValue(flagId, nextValue);
        }, 200));
    }

    on("btn-copy-quick-server-url", "click", copyQuickServerUrl);

    on("quick-metrics-toggle", "change", (e) => {
        flagCore.setFlagValue("metrics", e.target.checked);
    });

    on("btn-quick-launch", "click", async () => {
        switchTab("configure");
        await launchLlama();
    });

    on("btn-quick-stop", "click", stopLlama);

    refreshQuickLaunchUI();
}

document.addEventListener("DOMContentLoaded", async () => {
    initTabs();
    initToolSelect();
    initConfigControls();
    initCustomLaunchArgsControls();
    initInstallButtons();
    initApiTab();
    initRemoteTunnelControls();
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
});

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
    if (tabId === "chat") { refreshChatSidebarUI(); updateChatStatusBadge(); }
    if (tabId === "configure") flagCore.updateCommandPreview();
    if (tabId === "api") {
        Promise.resolve(checkStatus()).finally(() => {
            updateApiEndpoints();
            refreshRemoteTunnelStatus();
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

function initRemoteTunnelControls() {
    const startBtn = document.getElementById("btn-start-remote-tunnel");
    const stopBtn = document.getElementById("btn-stop-remote-tunnel");
    const copyBtn = document.getElementById("btn-copy-remote-tunnel");
    const copyOpenAiBtn = document.getElementById("btn-copy-remote-openai");
    if (!startBtn || !stopBtn) return;

    startBtn.addEventListener("click", startRemoteTunnel);
    stopBtn.addEventListener("click", stopRemoteTunnel);
    if (copyBtn) {
        copyBtn.addEventListener("click", () => {
            const link = document.getElementById("remote-tunnel-url");
            copyText(link ? link.href : "");
        });
    }
    if (copyOpenAiBtn) {
        copyOpenAiBtn.addEventListener("click", () => {
            const link = document.getElementById("remote-openai-url");
            copyText(link ? link.href : "");
        });
    }
    refreshRemoteTunnelStatus();
}

function setRemoteTunnelPolling(enabled) {
    if (enabled && !remoteTunnelTimer) {
        remoteTunnelTimer = setInterval(refreshRemoteTunnelStatus, 2000);
    } else if (!enabled && remoteTunnelTimer) {
        clearInterval(remoteTunnelTimer);
        remoteTunnelTimer = null;
    }
}

function renderRemoteTunnelStatus(state) {
    const status = state && state.status ? state.status : "idle";
    const url = state && state.url ? state.url : "";
    const message = state && state.message ? state.message : "Remote tunnel is not running.";
    const startBtn = document.getElementById("btn-start-remote-tunnel");
    const stopBtn = document.getElementById("btn-stop-remote-tunnel");
    const badge = document.getElementById("remote-tunnel-badge");
    const statusEl = document.getElementById("remote-tunnel-status");
    const urlRow = document.getElementById("remote-tunnel-url-row");
    const urlLink = document.getElementById("remote-tunnel-url");
    const openAiRow = document.getElementById("remote-openai-url-row");
    const openAiLink = document.getElementById("remote-openai-url");

    const isWorking = status === "preparing" || status === "downloading" || status === "starting";
    const isRunning = status === "running";
    const isError = status === "error";

    if (badge) {
        badge.textContent = status.replace(/-/g, " ");
        badge.classList.toggle("running", isRunning);
        badge.classList.toggle("working", isWorking);
        badge.classList.toggle("error", isError);
    }
    if (statusEl) {
        statusEl.textContent = message;
    }
    if (urlRow && urlLink) {
        if (url) {
            urlLink.href = url;
            urlLink.textContent = url;
            urlRow.classList.remove("hidden");
        } else {
            urlLink.href = "#";
            urlLink.textContent = "";
            urlRow.classList.add("hidden");
        }
    }
    if (openAiRow && openAiLink) {
        if (url) {
            const apiUrl = url.replace(/\/+$/, "") + "/v1";
            openAiLink.href = apiUrl;
            openAiLink.textContent = apiUrl;
            openAiRow.classList.remove("hidden");
        } else {
            openAiLink.href = "#";
            openAiLink.textContent = "";
            openAiRow.classList.add("hidden");
        }
    }
    if (startBtn) {
        startBtn.disabled = isWorking || isRunning;
        startBtn.textContent = isWorking ? "Starting..." : "Start Tunnel";
    }
    if (stopBtn) {
        stopBtn.classList.toggle("hidden", !(isWorking || isRunning));
        stopBtn.disabled = false;
    }

    setRemoteTunnelPolling(isWorking || isRunning);
}

async function refreshRemoteTunnelStatus() {
    try {
        const state = await fetchJson("/api/remote-tunnel/status");
        renderRemoteTunnelStatus(state);
        return state;
    } catch (e) {
        renderRemoteTunnelStatus({ status: "error", message: "Failed to read remote tunnel status: " + e.message });
        return null;
    }
}

async function startRemoteTunnel() {
    renderRemoteTunnelStatus({ status: "starting", message: "Starting Cloudflare tunnel..." });
    try {
        const endpoint = getServerEndpointConfig();
        const state = await fetchJson("/api/remote-tunnel/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                host: endpoint.host,
                port: endpoint.port,
            }),
        });
        renderRemoteTunnelStatus(state);
        setRemoteTunnelPolling(true);
    } catch (e) {
        renderRemoteTunnelStatus({ status: "error", message: "Failed to start remote tunnel: " + e.message });
    }
}

async function stopRemoteTunnel() {
    try {
        const state = await fetchJson("/api/remote-tunnel/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        renderRemoteTunnelStatus(state);
    } catch (e) {
        renderRemoteTunnelStatus({ status: "error", message: "Failed to stop remote tunnel: " + e.message });
    }
}

function initConfigControls() {
    return configFlagsUi.initConfigControls();
}

function flagMatchesSearch(flag, query) {
    return configFlagsUi.flagMatchesSearch(flag, query);
}

function getFlagDescriptionParts(flag) {
    return configFlagsUi.getFlagDescriptionParts(flag);
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
            updateApiEndpoints();
            updateChatStatusBadge();
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
    updateApiEndpoints();
    updateChatStatusBadge();
    setTimeout(() => checkStatus(), 500);
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
        const kvUsage = metrics["llamacpp:kv_cache_usage_ratio"];
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
        // server not ready yet or metrics unavailable
    } finally {
        pollStatsActive = false;
    }
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
            updateApiEndpoints();
            updateChatStatusBadge();
            setTimeout(() => checkStatus(), 500);
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
            updateApiEndpoints();
            updateChatStatusBadge();
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

const chatRendering = window.LlamaGui.chatRendering;
const {
    renderChatMessage,
    setChatWebStatus,
    renderChatSources,
    renderChatTypingIndicator,
    removeChatTypingIndicator,
    appendChatStreamToken,
} = chatRendering;

function refreshChatSidebarUI() {
    const values = flagCore.getFlagValues();
    for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
        const slider = document.getElementById(sliderId);
        const display = document.getElementById(sliderId.replace("slider", "val"));
        if (!slider || !display) continue;
        const val = values[meta.flag];
        if (val !== undefined && val !== null && val !== "") {
            slider.value = val;
            display.textContent = parseFloat(val).toFixed(meta.decimals);
        }
    }
    const maxTokensSlider = document.getElementById("chat-slider-max-tokens");
    const maxTokensDisplay = document.getElementById("chat-val-max-tokens");
    if (maxTokensSlider && maxTokensDisplay) {
        const ctxSize = parseInt(values.ctx_size, 10);
        const sliderMax = (Number.isFinite(ctxSize) && ctxSize > 0) ? Math.min(ctxSize, 131072) : 32768;
        maxTokensSlider.max = sliderMax;
        const nPredict = values.n_predict;
        if (nPredict !== undefined && nPredict !== null && nPredict !== "" && nPredict !== -1) {
            maxTokensSlider.value = Math.min(nPredict, sliderMax);
            maxTokensDisplay.textContent = parseInt(Math.min(nPredict, sliderMax), 10);
        } else {
            maxTokensSlider.value = 512;
            maxTokensDisplay.textContent = "512";
        }
    }
}

function getChatModelName() {
    const values = flagCore.getFlagValues();
    const alias = String(values.alias || "").split(",")[0].trim();
    if (alias) return alias;
    const selectedModel = flagCore.getSelectedModel();
    if (selectedModel) return selectedModel;
    return "local-model";
}

function getChatApiUrl() {
    return `${getServerEndpointConfig().baseUrl}/v1/chat/completions`;
}

function isChatWebSearchEnabled() {
    const toggle = document.getElementById("chat-web-search-toggle");
    return Boolean(toggle && toggle.checked);
}

function clampChatWebSearchMaxResults(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS;
    return Math.max(CHAT_WEB_SEARCH_MIN_RESULTS, Math.min(parsed, CHAT_WEB_SEARCH_MAX_RESULTS));
}

function getChatWebSearchMaxResults() {
    const input = document.getElementById("chat-web-search-max-results");
    return clampChatWebSearchMaxResults(input ? input.value : localStorage.getItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY));
}

function getChatRequestMessages(messages) {
    return messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
    }));
}

function updateChatStatusBadge() {
    const runningBadge = document.getElementById("chat-status-badge");
    const noServerBadge = document.getElementById("chat-no-server-badge");
    if (!runningBadge || !noServerBadge) return;

    const isRunning = !!(latestStatus && latestStatus.running);
    runningBadge.style.display = isRunning ? "" : "none";
    noServerBadge.style.display = isRunning ? "none" : "";
}

function showChatSendButton(show) {
    const sendBtn = document.getElementById("btn-chat-send");
    const stopBtn = document.getElementById("btn-chat-stop");
    if (sendBtn) sendBtn.style.display = show ? "flex" : "none";
    if (stopBtn) stopBtn.style.display = show ? "none" : "flex";
}

function getChatSamplerParams() {
    const params = {};
    const values = flagCore.getFlagValues();
    const temp = values.temperature;
    if (temp !== undefined && temp !== null) params.temperature = temp;
    const topP = values.top_p;
    if (topP !== undefined && topP !== null) params.top_p = topP;
    const topK = values.top_k;
    if (topK !== undefined && topK !== null && topK !== 0) params.top_k = topK;
    const minP = values.min_p;
    if (minP !== undefined && minP !== null) params.min_p = minP;
    const repeatPenalty = values.repeat_penalty;
    if (repeatPenalty !== undefined && repeatPenalty !== null && repeatPenalty !== 1.0) {
        params.repeat_penalty = repeatPenalty;
    }
    const nPredict = values.n_predict;
    if (nPredict !== undefined && nPredict !== null && nPredict !== -1) {
        params.max_tokens = nPredict;
    }
    return params;
}

async function sendChatMessage(userText) {
    if (chatStreaming || !userText.trim()) return;

    const systemPrompt = (document.getElementById("chat-system-prompt").value || "").trim();
    chatMessages.push({ role: "user", content: userText.trim() });
    renderChatMessage("user", userText.trim());

    const chatInput = document.getElementById("chat-input");
    chatInput.value = "";
    chatInput.style.height = "auto";

    chatStreaming = true;
    showChatSendButton(false);
    renderChatTypingIndicator();

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
    }
    messages.push(...getChatRequestMessages(chatMessages));

    const endpoint = getServerEndpointConfig();
    const body = {
        model: getChatModelName(),
        messages,
        stream: true,
        host: endpoint.host,
        port: endpoint.port,
        ...getChatSamplerParams(),
    };
    const webSearchEnabled = isChatWebSearchEnabled();
    if (webSearchEnabled) {
        body.web_search = true;
        body.web_search_max_results = getChatWebSearchMaxResults();
    }

    chatAbortController = new AbortController();

    try {
        const resp = await fetch("/api/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: chatAbortController.signal,
        });

        removeChatTypingIndicator();

        if (!resp.ok) {
            const errText = await resp.text().catch(() => resp.statusText);
            renderChatMessage("assistant", `Error: ${resp.status} - ${errText}`);
            chatStreaming = false;
            showChatSendButton(true);
            return;
        }

        const bubble = renderChatMessage("assistant", "");
        if (!resp.body) {
            renderChatMessage("assistant", "Error: Response body is empty.");
            chatStreaming = false;
            showChatSendButton(true);
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let responseSources = [];
        let streamDone = false;

        while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;
                const data = trimmed.slice(6);
                if (data === "[DONE]") {
                    streamDone = true;
                    setChatWebStatus(bubble, "");
                    break;
                }

                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === "web_status") {
                        setChatWebStatus(bubble, parsed.content || "");
                        continue;
                    }
                    if (parsed.type === "web_sources") {
                        responseSources = parsed.sources || [];
                        renderChatSources(bubble, responseSources);
                        continue;
                    }
                    if (parsed.error) {
                        const message = parsed.error.message || "Unknown error";
                        fullContent += `Error: ${message}`;
                        appendChatStreamToken(bubble, `Error: ${message}`);
                        continue;
                    }
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullContent += delta;
                        appendChatStreamToken(bubble, delta);
                    }
                } catch (_) {
                    // skip malformed chunks
                }
            }
        }

        if (streamDone) {
            await reader.cancel().catch(() => {});
        }
        setChatWebStatus(bubble, "");
        if (fullContent) {
            chatMessages.push({ role: "assistant", content: fullContent, sources: responseSources });
            saveCurrentConversation();
        }
    } catch (e) {
        removeChatTypingIndicator();
        if (e.name !== "AbortError") {
            renderChatMessage("assistant", "Error: " + e.message);
        }
    } finally {
        chatStreaming = false;
        chatAbortController = null;
        showChatSendButton(true);
        document.getElementById("chat-input").focus();
    }
}

function stopChatStream() {
    if (chatAbortController) {
        chatAbortController.abort();
    }
    removeChatTypingIndicator();
}

function undoChatMessage() {
    if (chatStreaming || chatMessages.length === 0) return;
    chatMessages.pop();
    const container = document.getElementById("chat-messages");
    const msgs = container.querySelectorAll(".chat-message");
    if (msgs.length > 0) msgs[msgs.length - 1].remove();

    if (chatMessages.length === 0) {
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        if (currentConversationId) {
            const conversations = getStoredConversations();
            saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId));
            currentConversationId = null;
            renderHistoryList();
        }
    } else {
        saveCurrentConversation();
    }
}

function regenerateChatResponse() {
    if (chatStreaming || chatMessages.length === 0) return;
    const lastMsg = chatMessages[chatMessages.length - 1];
    if (lastMsg.role === "assistant") {
        chatMessages.pop();
        const container = document.getElementById("chat-messages");
        const msgs = container.querySelectorAll(".chat-message");
        if (msgs.length > 0) msgs[msgs.length - 1].remove();
    }

    const lastUserMsg = chatMessages[chatMessages.length - 1];
    if (!lastUserMsg || lastUserMsg.role !== "user") return;

    chatMessages.pop();
    const container = document.getElementById("chat-messages");
    const msgs = container.querySelectorAll(".chat-message");
    if (msgs.length > 0) msgs[msgs.length - 1].remove();

    sendChatMessage(lastUserMsg.content);
}

// Chat History (localStorage)

function getStoredConversations() {
    try {
        return JSON.parse(localStorage.getItem(CHAT_CONVERSATIONS_STORAGE_KEY)) || [];
    } catch (_) {
        return [];
    }
}

function saveConversationsToStorage(list) {
    try {
        localStorage.setItem(CHAT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn("Failed to save conversations to localStorage:", e);
    }
}

function saveCurrentConversation() {
    if (chatMessages.length === 0) return;
    const sysPrompt = document.getElementById("chat-system-prompt");
    const conversations = getStoredConversations();
    const existing = currentConversationId
        ? conversations.find(c => c.id === currentConversationId)
        : null;

    if (existing) {
        existing.messages = chatMessages.slice();
        existing.systemPrompt = sysPrompt ? sysPrompt.value : "";
        existing.timestamp = Date.now();
        existing.title = generateConversationTitle(chatMessages);
    } else {
        const convo = {
            id: (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
                ? crypto.randomUUID()
                : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
                  }),
            title: generateConversationTitle(chatMessages),
            messages: chatMessages.slice(),
            systemPrompt: sysPrompt ? sysPrompt.value : "",
            timestamp: Date.now()
        };
        conversations.unshift(convo);
        currentConversationId = convo.id;
    }

    saveConversationsToStorage(conversations);
    renderHistoryList();
}

function generateConversationTitle(messages) {
    const first = messages.find(m => m.role === "user");
    if (!first) return "Untitled";
    const text = first.content.trim().replace(/\n/g, " ");
    return text.length > 50 ? text.slice(0, 50) + "..." : text;
}

function loadConversation(id) {
    const conversations = getStoredConversations();
    const convo = conversations.find(c => c.id === id);
    if (!convo) return;

    if (chatStreaming) stopChatStream();

    currentConversationId = convo.id;
    chatMessages = convo.messages.slice();

    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    if (sysPrompt) {
        sysPrompt.value = convo.systemPrompt || "";
        if (sysCharCount) sysCharCount.textContent = (convo.systemPrompt || "").length + " chars";
    }

    const container = document.getElementById("chat-messages");
    container.querySelectorAll(".chat-message").forEach(el => el.remove());
    const empty = document.getElementById("chat-empty");

    if (chatMessages.length === 0) {
        if (empty) empty.style.display = "";
    } else {
        if (empty) empty.style.display = "none";
        for (const msg of chatMessages) {
            renderChatMessage(msg.role, msg.content);
        }
    }

    renderHistoryList();
    snapshotStatsBaseline();
}

function deleteConversation(id) {
    const conversations = getStoredConversations();
    const filtered = conversations.filter(c => c.id !== id);
    saveConversationsToStorage(filtered);

    if (currentConversationId === id) {
        currentConversationId = null;
    }

    renderHistoryList();
}

function deleteAllConversations() {
    saveConversationsToStorage([]);
    currentConversationId = null;
    renderHistoryList();
}

function startNewChat() {
    saveCurrentConversation();
    currentConversationId = null;
    chatMessages = [];
    const container = document.getElementById("chat-messages");
    container.querySelectorAll(".chat-message").forEach(el => el.remove());
    const empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "";
    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    if (sysPrompt) sysPrompt.value = "";
    if (sysCharCount) sysCharCount.textContent = "0 chars";
    renderHistoryList();
    snapshotStatsBaseline();
}

function renderHistoryList() {
    const list = document.getElementById("chat-history-list");
    if (!list) return;

    const conversations = getStoredConversations();
    list.innerHTML = "";

    if (conversations.length === 0) {
        const empty = document.createElement("div");
        empty.className = "chat-history-empty";
        empty.textContent = "No saved conversations";
        list.appendChild(empty);
        return;
    }

    for (const convo of conversations) {
        const item = document.createElement("div");
        item.className = "chat-history-item" + (convo.id === currentConversationId ? " active" : "");

        const header = document.createElement("div");
        header.className = "chat-history-item-header";

        const title = document.createElement("div");
        title.className = "chat-history-item-title";
        title.textContent = convo.title;

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "chat-history-item-delete";
        deleteBtn.innerHTML = "&#128465;";
        deleteBtn.title = "Delete conversation";
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteConversation(convo.id);
        });

        header.appendChild(title);
        header.appendChild(deleteBtn);

        const preview = document.createElement("div");
        preview.className = "chat-history-item-preview";
        const lastMsg = convo.messages[convo.messages.length - 1];
        preview.textContent = lastMsg ? lastMsg.content.trim().replace(/\n/g, " ").slice(0, 60) : "";

        const time = document.createElement("div");
        time.className = "chat-history-item-time";
        time.textContent = formatHistoryTime(convo.timestamp);

        item.appendChild(header);
        item.appendChild(preview);
        item.appendChild(time);

        item.addEventListener("click", () => loadConversation(convo.id));
        list.appendChild(item);
    }
}

function formatHistoryTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return diffMin + "m ago";
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    return d.toLocaleDateString();
}

function clearChat() {
    if (chatStreaming) stopChatStream();
    if (currentConversationId) {
        const conversations = getStoredConversations();
        saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId));
        currentConversationId = null;
        renderHistoryList();
    }
    chatMessages = [];
    const container = document.getElementById("chat-messages");
    container.querySelectorAll(".chat-message").forEach(el => el.remove());
    const empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "";
    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    if (sysPrompt) sysPrompt.value = "";
    if (sysCharCount) sysCharCount.textContent = "0 chars";
    snapshotStatsBaseline();
}

function initChatTab() {
    const chatInput = document.getElementById("chat-input");
    const sendBtn = document.getElementById("btn-chat-send");
    const stopBtn = document.getElementById("btn-chat-stop");
    const undoBtn = document.getElementById("btn-chat-undo");
    const regenBtn = document.getElementById("btn-chat-regenerate");
    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    const sidebar = document.getElementById("chat-sidebar");
    const btnCollapse = document.getElementById("btn-collapse-sidebar");
    const btnOpen = document.getElementById("btn-open-sidebar");
    const webSearchToggle = document.getElementById("chat-web-search-toggle");
    const webSearchMaxResults = document.getElementById("chat-web-search-max-results");

    updateChatStatusBadge();

    if (webSearchToggle) {
        webSearchToggle.checked = localStorage.getItem(CHAT_WEB_SEARCH_STORAGE_KEY) === "true";
        webSearchToggle.addEventListener("change", () => {
            localStorage.setItem(CHAT_WEB_SEARCH_STORAGE_KEY, String(webSearchToggle.checked));
        });
    }

    if (webSearchMaxResults) {
        webSearchMaxResults.value = String(clampChatWebSearchMaxResults(
            localStorage.getItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY)
        ));
        webSearchMaxResults.addEventListener("change", () => {
            const value = clampChatWebSearchMaxResults(webSearchMaxResults.value);
            webSearchMaxResults.value = String(value);
            localStorage.setItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
        });
        webSearchMaxResults.addEventListener("input", () => {
            const value = clampChatWebSearchMaxResults(webSearchMaxResults.value);
            localStorage.setItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
        });
    }

    // Auto-resize chat input
    chatInput.addEventListener("input", () => {
        chatInput.style.height = "auto";
        chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
    });

    // Send on Enter
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage(chatInput.value);
        }
    });

    sendBtn.addEventListener("click", () => sendChatMessage(chatInput.value));
    stopBtn.addEventListener("click", stopChatStream);
    undoBtn.addEventListener("click", undoChatMessage);
    regenBtn.addEventListener("click", regenerateChatResponse);

    // System prompt char count
    sysPrompt.addEventListener("input", () => {
        sysCharCount.textContent = sysPrompt.value.length + " chars";
    });
    sysCharCount.textContent = "0 chars";

    // Sidebar collapse/expand
    btnCollapse.addEventListener("click", () => {
        sidebar.classList.add("collapsed");
        btnOpen.style.display = "flex";
    });

    btnOpen.addEventListener("click", () => {
        sidebar.classList.remove("collapsed");
        btnOpen.style.display = "none";
    });

    // History panel collapse/expand
    const historyPanel = document.getElementById("chat-history-panel");
    const btnCollapseHistory = document.getElementById("btn-collapse-history");
    const btnOpenHistory = document.getElementById("btn-open-history");

    if (btnCollapseHistory && historyPanel) {
        btnCollapseHistory.addEventListener("click", () => {
            historyPanel.classList.add("collapsed");
            if (btnOpenHistory) btnOpenHistory.style.display = "flex";
        });
    }

    if (btnOpenHistory && historyPanel) {
        btnOpenHistory.addEventListener("click", () => {
            historyPanel.classList.remove("collapsed");
            btnOpenHistory.style.display = "none";
        });
    }

    // New Chat button
    const newChatBtn = document.getElementById("btn-chat-new");
    if (newChatBtn) {
        newChatBtn.addEventListener("click", startNewChat);
    }

    // Delete All History button
    const deleteAllBtn = document.getElementById("btn-delete-all-history");
    if (deleteAllBtn) {
        deleteAllBtn.addEventListener("click", async () => {
            if (getStoredConversations().length === 0) return;
            const confirmed = await confirmAction("Delete All Conversations", "Delete all conversations? This cannot be undone.", "Delete All");
            if (confirmed) {
                deleteAllConversations();
                clearChat();
            }
        });
    }

    // Initial render of history list
    renderHistoryList();

    // Sidebar sampler sliders -> setFlagValue
    for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
        const slider = document.getElementById(sliderId);
        const display = document.getElementById(sliderId.replace("slider", "val"));
        if (!slider || !display) continue;

        slider.addEventListener("input", () => {
            const raw = parseFloat(slider.value);
            display.textContent = raw.toFixed(meta.decimals);
            const val = meta.flag === "top_k" ? parseInt(slider.value, 10) : parseFloat(slider.value);
            flagCore.setFlagValue(meta.flag, val);
        });
    }

    // Clear chat button in header
    const clearBtn = document.getElementById("btn-chat-clear");
    if (clearBtn) {
        clearBtn.addEventListener("click", clearChat);
    }

    // Suggestion chips
    document.querySelectorAll("#chat-empty .suggestion-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const prompt = chip.dataset.prompt;
            if (prompt) sendChatMessage(prompt);
        });
    });

    refreshChatSidebarUI();
}
