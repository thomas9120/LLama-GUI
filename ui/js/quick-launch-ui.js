(function () {
    const ns = window.LlamaGui = window.LlamaGui || {};

    let flagCore;
    let configFlagsUi;
    let hfDownloadUi;
    let debounce = (fn) => fn;
    let refreshModels = () => {};
    let applyPresetModel = () => {};
    let switchTab = () => {};
    let launchLlama = async () => {};
    let stopLlama = () => {};
    let copyQuickServerUrl = () => {};
    let updateQuickServerAddressPreview = () => {};
    let setChatTemplateValue = () => {};
    let getSelectedChatTemplateDropdownValue = () => "";
    let getQuickTemplateSummaryText = () => "";
    let getAllSamplerPresets = () => [];
    let applySamplerPresetValues = () => {};
    let loadSamplerPresetStore = () => ({});
    let saveSamplerPresetStore = () => {};
    let normalizeSamplerPresetValues = (values) => values || {};
    let collectSamplerValues = () => ({});
    let confirmAction = async () => false;

    let quickLaunchFitCtxLinked = true;
    let quickLaunchGpuCustomSelected = false;

    function configure(options = {}) {
        flagCore = options.flagCore || flagCore;
        configFlagsUi = options.configFlagsUi || configFlagsUi;
        hfDownloadUi = options.hfDownloadUi || hfDownloadUi;
        debounce = options.debounce || debounce;
        refreshModels = options.refreshModels || refreshModels;
        applyPresetModel = options.applyPresetModel || applyPresetModel;
        switchTab = options.switchTab || switchTab;
        launchLlama = options.launchLlama || launchLlama;
        stopLlama = options.stopLlama || stopLlama;
        copyQuickServerUrl = options.copyQuickServerUrl || copyQuickServerUrl;
        updateQuickServerAddressPreview = options.updateQuickServerAddressPreview || updateQuickServerAddressPreview;
        setChatTemplateValue = options.setChatTemplateValue || setChatTemplateValue;
        getSelectedChatTemplateDropdownValue = options.getSelectedChatTemplateDropdownValue || getSelectedChatTemplateDropdownValue;
        getQuickTemplateSummaryText = options.getQuickTemplateSummaryText || getQuickTemplateSummaryText;
        getAllSamplerPresets = options.getAllSamplerPresets || getAllSamplerPresets;
        applySamplerPresetValues = options.applySamplerPresetValues || applySamplerPresetValues;
        loadSamplerPresetStore = options.loadSamplerPresetStore || loadSamplerPresetStore;
        saveSamplerPresetStore = options.saveSamplerPresetStore || saveSamplerPresetStore;
        normalizeSamplerPresetValues = options.normalizeSamplerPresetValues || normalizeSamplerPresetValues;
        collectSamplerValues = options.collectSamplerValues || collectSamplerValues;
        confirmAction = options.confirmAction || confirmAction;
    }

    function populateTemplatePackOptions() {
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

    function syncModelOptions() {
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

    function getSelectedSamplerEntry() {
        const select = document.getElementById("quick-sampler-select");
        if (!select || !select.value) return null;
        const [source, ...nameParts] = String(select.value).split("|");
        const name = nameParts.join("|");
        return getAllSamplerPresets().find((entry) => entry.source === source && entry.name === name) || null;
    }

    function refreshSamplerPresetSelect() {
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

    function applyProfile(profileId) {
        const profile = QUICK_PROFILES[profileId];
        if (!profile) return;

        flagCore.setCurrentTool(profile.tool || "llama-server");
        flagCore.setMultipleFlagValues(profile.flags || {}, { quickLaunchFitCtxLinked: true });

        if (profile.samplerPresetName) {
            const preset = getAllSamplerPresets().find((entry) => entry.name === profile.samplerPresetName);
            if (preset) {
                applySamplerPresetValues(preset.values);
            }
        }
    }

    function setContextValue(rawValue, options = {}) {
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

    function setGpuLayers(value) {
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

    function updateActionButtons() {
        const quickLaunchBtn = document.getElementById("btn-quick-launch");
        const quickStopBtn = document.getElementById("btn-quick-stop");
        const mainLaunchBtn = document.getElementById("btn-launch");
        const mainStopBtn = document.getElementById("btn-stop");
        const sidebarLaunchBtn = document.getElementById("btn-sidebar-launch");
        const sidebarStopBtn = document.getElementById("btn-sidebar-stop");
        if (!quickLaunchBtn || !quickStopBtn || !mainLaunchBtn || !mainStopBtn) return;

        quickLaunchBtn.classList.toggle("hidden", mainLaunchBtn.classList.contains("hidden"));
        quickStopBtn.classList.toggle("hidden", mainStopBtn.classList.contains("hidden"));
        if (sidebarLaunchBtn) {
            sidebarLaunchBtn.classList.toggle("hidden", mainLaunchBtn.classList.contains("hidden"));
        }
        if (sidebarStopBtn) {
            sidebarStopBtn.classList.toggle("hidden", mainStopBtn.classList.contains("hidden"));
        }
    }

    function refresh() {
        const quickCommand = document.getElementById("quick-command-preview");
        if (!quickCommand) return;
        const values = flagCore.getFlagValues();
        const tool = flagCore.getCurrentTool();

        if (quickLaunchFitCtxLinked !== false) {
            quickLaunchFitCtxLinked = values.fit_ctx === undefined || values.fit_ctx === values.ctx_size;
        }
        syncModelOptions();
        refreshSamplerPresetSelect();

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

        const ctxValue = values.ctx_size ?? 32768;
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
        const presencePenalty = document.getElementById("quick-presence-penalty");
        if (temperature) temperature.value = values.temperature ?? "";
        if (topK) topK.value = values.top_k ?? "";
        if (topP) topP.value = values.top_p ?? "";
        if (minP) minP.value = values.min_p ?? "";
        if (repeatPenalty) repeatPenalty.value = values.repeat_penalty ?? "";
        if (presencePenalty) presencePenalty.value = values.presence_penalty ?? "";

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
        updateActionButtons();
    }

    function populateProfileOptions() {
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

    function init() {
        const on = (id, event, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, handler);
        };

        populateTemplatePackOptions();
        populateProfileOptions();
        refreshSamplerPresetSelect();
        syncModelOptions();
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
            applyProfile(e.target.value);
            refresh();
        });

        on("quick-context-preset", "change", (e) => {
            const customInput = document.getElementById("quick-context-custom");
            if (e.target.value === "custom") {
                if (customInput) { customInput.disabled = false; customInput.focus(); }
                return;
            }

            if (customInput) { customInput.disabled = true; customInput.value = ""; }
            setContextValue(e.target.value);
        });

        on("quick-context-custom", "input", (e) => {
            const rawValue = e.target.value.trim();
            if (rawValue === "") return;
            setContextValue(rawValue);
        });

        on("quick-gpu-mode", "change", (e) => {
            const gpuCustom = document.getElementById("quick-gpu-custom");
            if (gpuCustom) {
                gpuCustom.disabled = e.target.value !== "custom";
                if (e.target.value === "custom") gpuCustom.focus();
            }
            setGpuLayers(e.target.value);
        });

        on("quick-gpu-custom", "input", () => {
            const gpuMode = document.getElementById("quick-gpu-mode");
            if (gpuMode && gpuMode.value === "custom") {
                setGpuLayers("custom");
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
            flagCore.setFlagValue("fit_ctx", values.ctx_size ?? 32768, { quickLaunchFitCtxLinked: true });
        });

        on("quick-template-pack", "change", (e) => {
            setChatTemplateValue(e.target.value);
        });

        on("btn-quick-sampler-load", "click", () => {
            const selected = getSelectedSamplerEntry();
            if (!selected) return;
            applySamplerPresetValues(selected.values);
            refresh();
        });

        on("btn-quick-sampler-save", "click", () => {
            const nameInput = document.getElementById("quick-sampler-name");
            if (!nameInput) return;
            const typedName = nameInput.value.trim();
            const selected = getSelectedSamplerEntry();
            const name = typedName || (selected && selected.source === "custom" ? selected.name : "");
            if (!name) {
                nameInput.focus();
                return;
            }

            const store = loadSamplerPresetStore();
            store[name] = normalizeSamplerPresetValues(collectSamplerValues());
            saveSamplerPresetStore(store);
            nameInput.value = "";
            refreshSamplerPresetSelect();
            configFlagsUi.renderFlags();
            const samplerSelect = document.getElementById("quick-sampler-select");
            if (samplerSelect) samplerSelect.value = `custom|${name}`;
        });

        on("btn-quick-sampler-delete", "click", async () => {
            const selected = getSelectedSamplerEntry();
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
            refreshSamplerPresetSelect();
            configFlagsUi.renderFlags();
        });

        const quickSamplerFieldMap = {
            "quick-temperature": "temperature",
            "quick-top-k": "top_k",
            "quick-top-p": "top_p",
            "quick-min-p": "min_p",
            "quick-repeat-penalty": "repeat_penalty",
            "quick-presence-penalty": "presence_penalty",
        };

        for (const [elementId, flagId] of Object.entries(quickSamplerFieldMap)) {
            const applyQuickSamplerValue = debounce((rawValue) => {
                let nextValue;
                if (rawValue === "") {
                    nextValue = undefined;
                } else if (flagId === "top_k") {
                    nextValue = parseInt(rawValue, 10);
                } else {
                    nextValue = parseFloat(rawValue);
                }
                flagCore.setFlagValue(flagId, nextValue);
            }, 200);
            on(elementId, "input", (e) => {
                applyQuickSamplerValue(e.target.value.trim());
            });
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

        refresh();
    }

    function afterPatch(patch, options = {}) {
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
    }

    function afterApply(values) {
        const fitCtx = values.fit_ctx;
        const ctxSize = values.ctx_size;
        quickLaunchFitCtxLinked = fitCtx === undefined || fitCtx === ctxSize;
    }

    ns.quickLaunchUi = {
        configure,
        init,
        refresh,
        syncModelOptions,
        updateActionButtons,
        refreshSamplerPresetSelect,
        afterPatch,
        afterApply,
    };
})();
