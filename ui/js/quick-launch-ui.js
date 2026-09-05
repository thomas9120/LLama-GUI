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
    let isSamplerPresetNameTaken = () => false;
    let saveSamplerPreset = () => ({ ok: false, reason: "missing" });
    let renameSamplerPreset = () => ({ ok: false, reason: "missing" });
    let getSamplerRenameMessage = () => "Failed to rename sampler preset.";
    let confirmAction = async () => false;
    let promptAction = async () => null;
    let showToast = () => {};
    let hasLaunchModelArg = () => false;
    let presets;
    let getLifecycleSnapshot = () => ({});
    let getLatestStatus = () => null;

    let quickLaunchFitCtxLinked = true;
    let quickLaunchGpuCustomSelected = false;
    let launchInProgress = false;
    let presetLoadInProgress = false;
    let savedPresets = [];
    let savedPresetsRequest = 0;

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
        isSamplerPresetNameTaken = options.isSamplerPresetNameTaken || isSamplerPresetNameTaken;
        saveSamplerPreset = options.saveSamplerPreset || saveSamplerPreset;
        renameSamplerPreset = options.renameSamplerPreset || renameSamplerPreset;
        getSamplerRenameMessage = options.getSamplerRenameMessage || getSamplerRenameMessage;
        confirmAction = options.confirmAction || confirmAction;
        promptAction = options.promptAction || promptAction;
        showToast = options.showToast || showToast;
        hasLaunchModelArg = options.hasLaunchModelArg || hasLaunchModelArg;
        presets = options.presets || presets;
        getLifecycleSnapshot = options.getLifecycleSnapshot || getLifecycleSnapshot;
        getLatestStatus = options.getLatestStatus || getLatestStatus;
    }

    async function refreshSavedPresets() {
        const request = ++savedPresetsRequest;
        const status = document.getElementById("quick-presets-status");
        try {
            const entries = await presets.fetchPresetEntries();
            if (request !== savedPresetsRequest) return;
            savedPresets = entries.filter(entry => !entry.archived && presets.isFullPresetData(entry.data)
                && ["llama-server", "llama-cli"].includes(entry.data.tool))
                .map(entry => ({ ...entry, favorite: presets.isPresetFavorite(entry.name), lastUsed: presets.getPresetLastUsed(entry.name) }))
                .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
                .slice(0, 3);
            const host = document.getElementById("quick-saved-presets");
            host.replaceChildren();
            for (const entry of savedPresets) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "quick-saved-preset";
                button.dataset.presetName = entry.name;
                const name = document.createElement("strong");
                name.textContent = (entry.favorite ? "★ " : "") + entry.name;
                const model = document.createElement("span");
                model.className = "quick-preset-model";
                model.textContent = entry.data.model || "No local model selected";
                model.title = model.textContent;
                const state = document.createElement("span");
                state.className = "quick-preset-state";
                button.append(name, model, state);
                button.addEventListener("click", async () => {
                    if (presetLoadInProgress) return;
                    presetLoadInProgress = true;
                    refreshPresetStates();
                    status.textContent = `Loading ${entry.name}…`;
                    try {
                        const outcome = await presets.loadPreset(entry.name);
                        status.textContent = outcome.ok
                            ? `Loaded ${entry.name}.${outcome.warnings.length ? " " + outcome.warnings[0] : ""}`
                            : outcome.error;
                        if (outcome.ok) {
                            entry.data = outcome.data;
                            const modelLabel = button.querySelector(".quick-preset-model");
                            modelLabel.textContent = outcome.data.model || "No local model selected";
                            modelLabel.title = modelLabel.textContent;
                            document.getElementById("quick-profile-select").value = "";
                        }
                    } catch (error) {
                        console.warn("Could not apply Quick Launch preset", error);
                        status.textContent = "Could not apply the preset. Open View all to retry.";
                    } finally {
                        presetLoadInProgress = false;
                        refresh();
                    }
                });
                host.appendChild(button);
            }
            status.textContent = savedPresets.length ? "Favorites first, then recently used. Loading a preset replaces pending settings." : "Save a launch preset in Presets to add a shortcut here.";
            refreshPresetStates();
        } catch (error) {
            if (request !== savedPresetsRequest) return;
            console.warn("Could not load Quick Launch presets", error);
            status.textContent = "Could not refresh presets. Open View all to retry.";
        }
    }

    function refreshPresetStates() {
        const buttons = document.querySelectorAll(".quick-saved-preset");
        for (const button of buttons) {
            const entry = savedPresets.find(preset => preset.name === button.dataset.presetName);
            const matches = entry && presets.matchesCurrentPreset(entry.data);
            button.setAttribute("aria-pressed", String(Boolean(matches)));
            button.disabled = presetLoadInProgress;
            button.querySelector(".quick-preset-state").textContent = matches ? "Matches settings"
                : presets.getLastLoadedPresetName() === entry?.name ? "Modified · load again" : "Load preset";
        }
    }

    function refreshRuntime() {
        const state = getLifecycleSnapshot();
        const status = getLatestStatus();
        const runtime = state.activeRuntime;
        const external = !runtime && status?.external_chat_target?.connected;
        const endpointLabel = document.querySelector(".quick-endpoint-label");
        if (endpointLabel) endpointLabel.textContent = runtime?.tool === "llama-server" || status?.external_chat_target?.connected ? "Active endpoint" : "Next launch endpoint";
        const phaseLabels = { idle: "Stopped", starting: "Starting", loading: "Loading model", ready: "Ready", running: "Running", stopping: "Stopping", failed: "Action failed" };
        const label = document.getElementById("quick-runtime-state");
        if (!label) return;
        label.textContent = external ? "External server" : phaseLabels[state.phase] || "Checking runtime…";
        label.dataset.phase = state.phase || "idle";
        const model = document.getElementById("quick-runtime-model");
        model.textContent = runtime ? [runtime.tool, runtime.alias || runtime.model || "Model unavailable", runtime.host && runtime.port ? `${runtime.host}:${runtime.port}` : ""].filter(Boolean).join(" · ") : external ? "Managed outside this app" : "No local process running";
        model.title = model.textContent;
        const build = document.getElementById("quick-runtime-build");
        build.textContent = runtime ? [runtime.backend, runtime.version].filter(Boolean).join(" · ")
            : status?.installed ? [status.backend, status.version].filter(Boolean).join(" · ") : status ? "llama.cpp not installed" : "";
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

    // `preferredValue` keeps the selection when the current name is about to disappear,
    // e.g. after a rename made from the Configure tab.
    function refreshSamplerPresetSelect(preferredValue) {
        const select = document.getElementById("quick-sampler-select");
        if (!select) return;

        const previous = preferredValue || select.value;
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
            : Number(rawValue);
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

    function setQuickLaunchStatus(type, message) {
        const status = document.getElementById("quick-launch-status");
        if (!status) return;
        status.className = "quick-launch-status" + (type ? " " + type : "");
        status.textContent = message || "";
    }

    function getDefaultCtxSize() {
        const flag = Array.isArray(FLAGS) ? FLAGS.find((entry) => entry.id === "ctx_size") : null;
        const value = flag && Number(flag.default);
        return Number.isFinite(value) ? value : 64000;
    }

    function formatContextLabel(ctx) {
        const key = String(ctx);
        const presetLabels = {
            "8192": "8K",
            "16000": "16K",
            "32768": "32K",
            "64000": "64K",
            "128000": "128K",
            "256000": "256K",
        };
        if (presetLabels[key]) return presetLabels[key];
        const num = Number(ctx);
        if (!Number.isFinite(num)) return String(ctx ?? "—");
        if (num >= 1024 && num % 1024 === 0) return `${num / 1024}K`;
        if (num >= 1000 && num % 1000 === 0) return `${num / 1000}K`;
        return `${num}`;
    }

    function formatSamplerBadgeValue(value, step) {
        if (!Number.isFinite(value)) return "—";
        if (Number.isInteger(step) || step >= 1) return String(Math.round(value));
        const decimals = Math.max(0, (String(step).split(".")[1] || "").length || 2);
        return value.toFixed(decimals);
    }

    function updateSamplerSliderVisual(slider, displayValue, options = {}) {
        if (!slider || slider.type !== "range") return;
        const unset = options.unset === true;
        const min = parseFloat(slider.min || "0");
        const max = parseFloat(slider.max || "100");
        if (unset) slider.value = slider.min || "0";
        const thumbValue = parseFloat(slider.value);
        const value = Number.isFinite(displayValue) ? displayValue : thumbValue;
        const fillSource = unset ? min : Number.isFinite(thumbValue) ? thumbValue : value;
        const pct = Number.isFinite(fillSource) && max > min
            ? Math.min(100, Math.max(0, ((fillSource - min) / (max - min)) * 100))
            : 0;
        slider.dataset.unset = String(unset);
        slider.style.setProperty("--fill", `${pct}%`);
        const badge = document.getElementById(`${slider.id}-value`);
        if (badge) {
            const step = parseFloat(slider.step || "1");
            badge.textContent = unset ? "—" : formatSamplerBadgeValue(value, step);
            badge.title = unset
                ? "Not set; llama.cpp will use its default."
                : Number.isFinite(value) && Number.isFinite(thumbValue) && value !== thumbValue
                    ? `Stored value ${formatSamplerBadgeValue(value, step)} is outside this slider's range`
                    : "";
        }
    }

    function applySamplerSliderValue(slider, rawValue) {
        if (!slider) return;
        if (rawValue === undefined || rawValue === null || rawValue === "") {
            updateSamplerSliderVisual(slider, undefined, { unset: true });
            return;
        }
        const num = Number(rawValue);
        if (!Number.isFinite(num)) {
            updateSamplerSliderVisual(slider);
            return;
        }
        slider.value = String(num);
        updateSamplerSliderVisual(slider, num);
    }

    function setReadinessChip(id, tone, text) {
        const chip = document.getElementById(id);
        if (!chip) return;
        chip.classList.remove("ok", "missing", "info");
        if (tone) chip.classList.add(tone);
        const label = chip.querySelector(".chip-text");
        if (label) label.textContent = text;
        chip.title = text && text.length > 40 ? text : "";
    }

    function hasLaunchFlag(args, names) {
        const expected = new Set(names);
        return (args || []).some((entry) => {
            const tokens = Array.isArray(entry) ? entry : [entry];
            return tokens.some((token) => {
                const value = String(token || "");
                const separator = value.indexOf("=");
                const flag = separator === -1 ? value : value.slice(0, separator);
                return expected.has(flag);
            });
        });
    }

    function updateReadinessChips(values, tool) {
        const launchArgs = flagCore.getLaunchArgs().args;
        const modelSelect = document.getElementById("model-select");
        const modelName = modelSelect && modelSelect.value ? modelSelect.value : "";
        const hasModel = Boolean(modelName) || hasLaunchModelArg(launchArgs);
        setReadinessChip(
            "quick-chip-model",
            hasModel ? "ok" : "missing",
            modelName ? `Model: ${modelName}` : hasModel ? "Model: remote source" : "Model: none",
        );

        const profileSelect = document.getElementById("quick-profile-select");
        const profileLabel = profileSelect && profileSelect.value
            ? (profileSelect.selectedOptions[0] ? profileSelect.selectedOptions[0].textContent : profileSelect.value)
            : "";
        setReadinessChip(
            "quick-chip-profile",
            "info",
            profileLabel ? `Profile: ${profileLabel}` : "Profile: optional",
        );

        const ctx = values.ctx_size ?? getDefaultCtxSize();
        setReadinessChip("quick-chip-context", "info", `Context: ${formatContextLabel(ctx)}`);

        const gpuLayers = String(values.gpu_layers ?? "auto");
        const gpuLabel = gpuLayers === "auto" ? "Auto" : gpuLayers === "0" ? "CPU only" : gpuLayers === "all" ? "All layers" : `${gpuLayers} layers`;
        setReadinessChip("quick-chip-gpu", "info", `GPU: ${gpuLabel}`);

        const apiApplies = tool === "llama-server";
        const hasApiKey = apiApplies && hasLaunchFlag(launchArgs, ["--api-key"]);
        setReadinessChip(
            "quick-chip-api",
            hasApiKey ? "ok" : "info",
            !apiApplies ? "API: not applicable" : hasApiKey ? "API: protected" : "API: open access",
        );

        const protectedBadge = document.getElementById("quick-api-protected-badge");
        if (protectedBadge) protectedBadge.classList.toggle("visible", hasApiKey);
    }

    function setQuickLaunchBusy(busy, outcome) {
        launchInProgress = busy;
        const launchBtn = document.getElementById("btn-quick-launch");
        const label = document.getElementById("btn-quick-launch-label");
        if (!launchBtn || !label) return;
        if (busy) {
            launchBtn.disabled = true;
            label.replaceChildren();
            const spinner = document.createElement("span");
            spinner.className = "spinner";
            label.appendChild(spinner);
            label.appendChild(document.createTextNode("Starting…"));
            setQuickLaunchStatus("info", "Launching llama.cpp — loading the model, this can take a moment.");
            return;
        }
        label.textContent = flagCore.getCurrentTool() === "llama-server" ? "Launch server" : "Launch terminal";
        launchBtn.disabled = false;
        updateActionButtons();
        if (outcome && outcome.ok) {
            const launchedTool = outcome.runtime?.tool || getLifecycleSnapshot().activeRuntime?.tool;
            setQuickLaunchStatus("info", launchedTool === "llama-server" ? "Server is ready. Open Chat or the Web UI to begin." : "Terminal process started. Open Monitor for output and input.");
        } else if (outcome && !outcome.cancelled && outcome.error) {
            setQuickLaunchStatus("error", outcome.error);
        } else {
            setQuickLaunchStatus("", "");
        }
    }

    function getQuickLaunchReadiness() {
        if (getLatestStatus()?.installed === false) return { ok: false, type: "warning", message: "Install llama.cpp in Install and Update before launching." };
        const result = flagCore.getLaunchArgs();
        if (result.error) {
            return { ok: false, type: "error", message: result.error };
        }
        if (!hasLaunchModelArg(result.args)) {
            return {
                ok: false,
                type: "warning",
                message: "Select a model or provide a remote model source before launching.",
            };
        }
        return { ok: true, type: "", message: "" };
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
        const readiness = getQuickLaunchReadiness();
        const state = getLifecycleSnapshot();
        quickLaunchBtn.disabled = launchInProgress || Boolean(state.busy) || mainLaunchBtn.disabled || !readiness.ok;
        quickStopBtn.disabled = mainStopBtn.disabled;
        quickLaunchBtn.title = readiness.ok ? "" : readiness.message;
        if (!launchInProgress) document.getElementById("btn-quick-launch-label").textContent = flagCore.getCurrentTool() === "llama-server" ? "Launch server" : "Launch terminal";
        document.getElementById("btn-quick-stop-label").textContent = state.activeRuntime?.tool === "llama-cli" ? "Stop terminal" : state.activeRuntime?.tool && state.activeRuntime.tool !== "llama-server" ? "Stop process" : "Stop server";
        const summary = document.getElementById("quick-launch-readiness");
        summary.textContent = state.busy ? "Process action in progress…" : state.activeRuntime ? "Settings for your next launch" : readiness.ok ? "Ready to launch" : "Launch not ready";
        refreshRuntime();
        if (sidebarLaunchBtn) {
            sidebarLaunchBtn.classList.toggle("hidden", mainLaunchBtn.classList.contains("hidden"));
            sidebarLaunchBtn.disabled = quickLaunchBtn.disabled;
            sidebarLaunchBtn.title = quickLaunchBtn.title;
            document.getElementById("btn-sidebar-launch-label").textContent = document.getElementById("btn-quick-launch-label").textContent;
            const reason = document.getElementById("sidebar-launch-reason");
            reason.hidden = readiness.ok || sidebarLaunchBtn.classList.contains("hidden");
            reason.textContent = reason.hidden ? "" : readiness.message;
            sidebarLaunchBtn.setAttribute("aria-describedby", "sidebar-launch-reason");
        }
        if (sidebarStopBtn) {
            sidebarStopBtn.classList.toggle("hidden", mainStopBtn.classList.contains("hidden"));
            sidebarStopBtn.disabled = quickStopBtn.disabled;
            document.getElementById("btn-sidebar-stop-label").textContent = state.phase === "stopping" ? "Stopping…" : document.getElementById("btn-quick-stop-label").textContent;
        }
    }

    // Same hazard as restoreFlagInputs() in config-flags-ui.js: refresh() runs on
    // every keystroke via the flag-state postUpdate hook, so writing state back
    // into the field being typed in resets the caret and, on type="number",
    // discards partial input the browser reports as "" (a lone "-" or "0.").
    function setInputValueUnlessEditing(el, nextValue) {
        if (!el) return;
        const doc = el.ownerDocument || document;
        if (doc && doc.activeElement === el) return;
        const next = String(nextValue);
        if (el.value !== next) el.value = next;
    }

    function refresh() {
        const quickCommand = document.getElementById("quick-command-preview");
        if (!quickCommand) return;
        const values = flagCore.getFlagValues();
        const tool = flagCore.getCurrentTool();

        if (quickLaunchFitCtxLinked !== false) {
            quickLaunchFitCtxLinked = values.fit_ctx === undefined || values.fit_ctx === values.ctx_size;
        }
        // Model and sampler options refresh at their mutation sites. Rebuilding
        // them here cloned every model option on every unrelated flag keystroke.

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
                ? "llama-server · Web UI and API"
                : "llama-cli · Interactive chat";
        }

        const ctxValue = values.ctx_size ?? getDefaultCtxSize();
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
                setInputValueUnlessEditing(contextCustom, ctxString);
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
            }

            if (!quickLaunchGpuCustomSelected && (gpuLayers === "auto" || gpuLayers === "0" || gpuLayers === "all")) {
                gpuMode.value = gpuLayers;
                gpuCustom.value = "";
                gpuCustom.disabled = true;
            } else {
                gpuMode.value = "custom";
                setInputValueUnlessEditing(gpuCustom, hasCustomGpuValue ? gpuLayers : "");
                gpuCustom.disabled = false;
            }
        }

        const fitToggle = document.getElementById("quick-fit-toggle");
        const fitTarget = document.getElementById("quick-fit-target");
        const fitCtx = document.getElementById("quick-fit-ctx");
        if (fitToggle) fitToggle.value = String(values.fit ?? "on");
        // fit_target has no "" fallback on purpose in the summary below, but the
        // input itself must stay clearable: forcing "1024" back in made the field
        // impossible to empty.
        setInputValueUnlessEditing(fitTarget, values.fit_target ?? "");
        setInputValueUnlessEditing(fitCtx, values.fit_ctx ?? "");

        const fitSummary = document.getElementById("quick-fit-summary");
        if (fitSummary) {
            fitSummary.textContent = String(values.fit ?? "on") === "on"
                ? `Auto Fit: ${values.fit_target ?? "1024"} MiB headroom · ${formatContextLabel(values.fit_ctx ?? ctxValue)} minimum context.`
                : "Auto Fit is off. Manual memory settings apply.";
        }

        const templateSelect = document.getElementById("quick-template-pack");
        const templateSummary = document.getElementById("quick-template-summary");
        const selectedTemplateValue = getSelectedChatTemplateDropdownValue();
        if (templateSelect) {
            configFlagsUi.ensureChatTemplateOption(templateSelect, selectedTemplateValue);
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
        applySamplerSliderValue(temperature, values.temperature);
        applySamplerSliderValue(topK, values.top_k);
        applySamplerSliderValue(topP, values.top_p);
        applySamplerSliderValue(minP, values.min_p);
        applySamplerSliderValue(repeatPenalty, values.repeat_penalty);
        applySamplerSliderValue(presencePenalty, values.presence_penalty);
        setInputValueUnlessEditing(document.getElementById("quick-temperature-input"), values.temperature ?? "");
        setInputValueUnlessEditing(document.getElementById("quick-top-p-input"), values.top_p ?? "");
        setInputValueUnlessEditing(document.getElementById("quick-port"), values.port ?? "");

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

        const quickApiKeyControl = document.getElementById("quick-api-key-control")?.firstElementChild;
        configFlagsUi.syncSensitiveTextInput(quickApiKeyControl, values.api_key);
        const quickAuthSection = document.getElementById("quick-auth-section");
        if (quickAuthSection) quickAuthSection.classList.toggle("hidden", tool !== "llama-server");
        document.getElementById("quick-server-fields").classList.toggle("hidden", tool !== "llama-server");
        document.querySelector(".quick-endpoint-label").classList.toggle("hidden", tool !== "llama-server");
        const templateLabel = templateSelect?.selectedOptions[0]?.textContent || "Auto template";
        const protectedApi = hasLaunchFlag(flagCore.getLaunchArgs().args, ["--api-key"]);
        document.getElementById("quick-server-summary").textContent = tool === "llama-server"
            ? `Port ${values.port || "default"} · ${protectedApi ? "API key set" : "No API key"} · ${templateLabel}` : templateLabel;

        quickCommand.textContent = document.getElementById("command-preview-text").textContent || "";
        quickCommand.classList.toggle("command-preview-error", document.getElementById("command-preview-text").classList.contains("command-preview-error"));
        updateQuickServerAddressPreview();
        updateReadinessChips(values, tool);
        updateActionButtons();
        refreshPresetStates();
        const readiness = getQuickLaunchReadiness();
        const mainLaunchBtn = document.getElementById("btn-launch");
        if (readiness.ok || (mainLaunchBtn && mainLaunchBtn.classList.contains("hidden"))) {
            setQuickLaunchStatus("", "");
        } else {
            setQuickLaunchStatus(readiness.type, readiness.message);
        }
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

        // Runs first: the markup ships this field as type="password", and until
        // it is upgraded a stored token would be readable if anything below throws.
        configFlagsUi.initializeSensitiveTextInput(document.getElementById("hf-token-input"));

        populateTemplatePackOptions();
        populateProfileOptions();
        refreshSamplerPresetSelect();
        syncModelOptions();
        if (window.LlamaGui.searchableSelect) {
            window.LlamaGui.searchableSelect.enhance(document.getElementById("model-select"), {
                searchPlaceholder: "Search models...",
            });
            window.LlamaGui.searchableSelect.enhance(document.getElementById("quick-model-select"), {
                searchPlaceholder: "Search models...",
            });
        }
        hfDownloadUi.init();

        const quickApiKeyHost = document.getElementById("quick-api-key-control");
        const apiKeyFlag = FLAGS.find((flag) => flag.id === "api_key");
        if (quickApiKeyHost && apiKeyFlag && !quickApiKeyHost.firstElementChild) {
            quickApiKeyHost.appendChild(configFlagsUi.createSensitiveTextInput(apiKeyFlag, {
                inputId: "quick-api-key",
            }));
        }

        on("btn-open-configure", "click", () => {
            switchTab("configure");
        });
        on("btn-quick-presets", "click", () => switchTab("presets"));
        on("btn-quick-download", "click", () => {
            const panel = document.querySelector(".hf-download-panel");
            panel.open = true;
            document.getElementById("hf-repo-input").focus();
        });
        on("btn-quick-more-sampling", "click", () => {
            switchTab("configure");
            const search = document.getElementById("config-search");
            search.value = "sampling";
            search.dispatchEvent(new Event("input", { bubbles: true }));
            search.focus();
        });
        for (const [id, flag] of [["quick-port", "port"], ["quick-temperature-input", "temperature"], ["quick-top-p-input", "top_p"]]) {
            on(id, "input", e => {
                const value = e.target.value;
                flagCore.setFlagValue(flag, value === "" ? undefined : Number(value));
            });
        }

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
            const parsed = rawValue === "" ? undefined : Number(rawValue);
            const nextFitCtx = Number.isFinite(parsed) ? parsed : undefined;
            flagCore.setFlagValue("fit_ctx", nextFitCtx, { quickLaunchFitCtxLinked: false });
        });

        on("btn-quick-fit-sync", "click", () => {
            const values = flagCore.getFlagValues();
            flagCore.setFlagValue("fit_ctx", values.ctx_size ?? getDefaultCtxSize(), { quickLaunchFitCtxLinked: true });
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
            const selectedCustomName = selected && selected.source === "custom" ? selected.name : "";
            const name = typedName || selectedCustomName;
            if (!name) {
                nameInput.focus();
                showToast("Enter a sampler preset name.", "error");
                return;
            }

            const result = saveSamplerPreset(name, selectedCustomName, collectSamplerValues());
            if (!result.ok) {
                showToast(getSamplerRenameMessage(result.reason) + " Rename or delete the existing preset first.", "error");
                return;
            }
            nameInput.value = "";
            refreshSamplerPresetSelect();
            configFlagsUi.renderFlags();
            const samplerSelect = document.getElementById("quick-sampler-select");
            if (samplerSelect) samplerSelect.value = `custom|${result.name}`;
            showToast(`Saved sampler preset "${result.name}"`, "success");
        });

        on("btn-quick-sampler-rename", "click", async () => {
            const selected = getSelectedSamplerEntry();
            if (!selected) return;
            if (selected.source !== "custom") {
                showToast(getSamplerRenameMessage("builtin"), "error");
                return;
            }

            // resolves to null on cancel, so an empty string still means "cleared the field"
            const nextName = await promptAction(
                "Rename Sampler Preset",
                `Enter a new name for "${selected.name}".`,
                selected.name,
                "Rename"
            );
            if (nextName === null || nextName === undefined) return;

            const result = renameSamplerPreset(selected.name, nextName);
            if (!result.ok) {
                showToast(getSamplerRenameMessage(result.reason), "error");
                return;
            }

            refreshSamplerPresetSelect(`custom|${result.name}`);
            configFlagsUi.renderFlags();
            showToast(`Renamed sampler preset to "${result.name}"`, "success");
        });

        on("btn-quick-sampler-delete", "click", async () => {
            const selected = getSelectedSamplerEntry();
            if (!selected) return;
            if (selected.source !== "custom") {
                showToast("Built-in sampler presets cannot be deleted.", "error");
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
            showToast(`Deleted sampler preset "${selected.name}"`, "success");
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
                updateSamplerSliderVisual(e.target);
                applyQuickSamplerValue(e.target.value.trim());
            });
        }

        on("btn-copy-quick-server-url", "click", copyQuickServerUrl);

        on("quick-metrics-toggle", "change", (e) => {
            flagCore.setFlagValue("metrics", e.target.checked);
        });

        on("btn-quick-launch", "click", async () => {
            const readiness = getQuickLaunchReadiness();
            setQuickLaunchStatus(readiness.ok ? "" : readiness.type, readiness.message);
            if (!readiness.ok) return;
            setQuickLaunchBusy(true);
            const outcome = await launchLlama();
            setQuickLaunchBusy(false, outcome);
        });

        on("btn-quick-stop", "click", stopLlama);

        refresh();
        refreshSavedPresets();
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
        refreshSavedPresets,
        refreshRuntime,
        syncModelOptions,
        updateActionButtons,
        refreshSamplerPresetSelect,
        afterPatch,
        afterApply,
    };
})();
