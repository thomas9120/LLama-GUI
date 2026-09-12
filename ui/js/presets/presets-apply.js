// Presets package (2/10): preset apply/compare flow and the saved-settings context bar.
function applyPresetModel(modelName) {
    const modelSelect = document.getElementById("model-select");
    const target = String(modelName || "");
    const flagCore = getPresetFlagCore();

    if (!target) {
        if (flagCore) flagCore.setSelectedModelValue("");
        if (modelSelect) modelSelect.value = "";
        return;
    }

    if (!modelSelect) {
        if (flagCore) flagCore.setSelectedModelValue(target);
        if (typeof syncQuickLaunchModelOptions === "function") {
            syncQuickLaunchModelOptions();
        }
        return;
    }

    // Resolve against the live options rather than the cached name set: only the
    // options carry the exact spelling, and a preset saved before models/ gained
    // subfolders stores a bare name that now lives at "<folder>/<name>". Falling
    // back to the raw value keeps the "(missing)" marker for a genuine miss, and
    // for an ambiguous basename that getPresetWarnings() also flags.
    const options = Array.from(modelSelect.options);
    const resolved = resolvePresetModelName(target, options.map((option) => option.value));

    if (!options.some(o => o.value === resolved)) {
        const opt = document.createElement("option");
        opt.value = resolved;
        opt.textContent = `${resolved}  (missing)`;
        modelSelect.appendChild(opt);
    }

    modelSelect.value = resolved;
    if (flagCore) flagCore.setSelectedModelValue(resolved);
    if (typeof syncQuickLaunchModelOptions === "function") {
        syncQuickLaunchModelOptions();
    }
}

function buildCurrentPresetData() {
    const flagCore = getPresetFlagCore();
    const currentValues = flagCore.getFlagValues();
    assertNoSensitiveCustomArgs(currentValues);
    const values = stripSensitivePresetFlags(currentValues);
    const selectedModel = flagCore.getSelectedModel();
    const tool = flagCore.getCurrentTool();
    return { tool, model: selectedModel, flags: values };
}

function preparePresetLaunchState(data, options = {}) {
    const flagCore = getPresetFlagCore();
    const normalized = normalizePresetData(data);
    const preserveApiKey = options.preserveApiKey !== false;
    if (typeof flagCore.buildEffectiveFlagValues !== "function") {
        throw new Error("Flag defaults are not available.");
    }
    const flags = flagCore.buildEffectiveFlagValues(normalized.flags);
    if (preserveApiKey) {
        const currentValues = flagCore.getFlagValues();
        for (const id of SENSITIVE_PRESET_FLAG_IDS) {
            if (currentValues[id]) flags[id] = currentValues[id];
        }
    }
    return {
        tool: normalized.tool,
        model: resolvePresetModelName(normalized.model),
        flags,
    };
}

function applyPresetData(data, options = {}) {
    const flagCore = getPresetFlagCore();
    const prepared = preparePresetLaunchState(data, options);
    if (prepared.tool === "llama-cli" || prepared.tool === "llama-server") {
        flagCore.setCurrentTool(prepared.tool);
        const toolSelect = document.getElementById("tool-select");
        if (toolSelect) toolSelect.value = prepared.tool;
    }
    applyPresetModel(prepared.model);
    flagCore.applyFlagValues(prepared.flags);
    return prepared;
}

function matchesCurrentPreset(data) {
    const comparison = comparePresetToCurrent(data);
    return !comparison.blocked && comparison.changes.length === 0;
}

function comparePresetToCurrent(data, currentData) {
    const core = getPresetFlagCore();
    const prepared = preparePresetLaunchState(data, { preserveApiKey: false });
    const current = currentData ? currentData.flags : core.getFlagValues();
    const flags = core.normalizeSpeculativeFlagValues(stripSensitivePresetFlags(current));
    const keys = new Set([...Object.keys(prepared.flags), ...Object.keys(flags)]);
    const valueKey = value => Array.isArray(value) ? JSON.stringify(value.map(String)) : String(value ?? "");
    const entries = [
        { id: "tool", label: "Tool", before: prepared.tool || (currentData ? currentData.tool : core.getCurrentTool()), after: currentData ? currentData.tool : core.getCurrentTool() },
        { id: "model", label: "Model", before: prepared.model, after: currentData ? currentData.model : core.getSelectedModel() },
        ...Array.from(keys).filter(id => !SENSITIVE_PRESET_FLAG_IDS.has(id) && id !== "ctx_size_draft")
            .map(id => ({ id, label: getPresetFlagLabel(id), before: prepared.flags[id], after: flags[id] })),
    ];
    return { changes: entries.filter(entry => valueKey(entry.before) !== valueKey(entry.after)), blocked: hasSensitiveCustomArgs(current) };
}

function formatSavedPresetValue(id, value) {
    value = getPresetFlagCore().normalizeStoredFlagValue(id, value);
    if (value === null || value === undefined || value === "") return "Not set";
    const definition = (typeof FLAGS !== "undefined" ? FLAGS : []).find(flag => flag.id === id);
    if (definition?.sensitive || SENSITIVE_PRESET_FLAG_IDS.has(id) || id === "custom_args") return "Set · value hidden";
    if (id === "ctx_size" && String(value) === "0") return "Auto · from model (0)";
    if (id === "gpu_layers" && value === "auto") return "Auto";
    if (id === "gpu_layers" && value === "all") return "All layers";
    const option = definition?.options?.find(option => String(option.value) === String(value));
    if (option) return option.label;
    if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
    return Array.isArray(value) ? value.join(", ") || "None" : String(value);
}

function renderPresetChangeRows(body, changes) {
    body.replaceChildren();
    for (const entry of changes) {
        const row = document.createElement("tr");
        const before = formatSavedPresetValue(entry.id, entry.before);
        const after = formatSavedPresetValue(entry.id, entry.after);
        for (const text of [entry.label, before, before === after && after === "Set · value hidden" ? "Changed · value hidden" : after]) {
            const cell = document.createElement("td");
            cell.textContent = text;
            row.appendChild(cell);
        }
        body.appendChild(row);
    }
}

function setLoadedPreset(name, data, archived = false) {
    lastLoadedPresetName = name;
    loadedPresetData = normalizePresetData(data);
    loadedPresetMissing = false;
    loadedPresetArchived = archived;
    refreshPresetContext();
}

function reconcileLoadedPreset(entries) {
    if (!lastLoadedPresetName) return;
    const entry = entries.find(entry => entry.name === lastLoadedPresetName);
    loadedPresetMissing = !entry;
    if (entry) {
        loadedPresetData = normalizePresetData(entry.data);
        loadedPresetArchived = entry.archived === true;
    }
    refreshPresetContext();
}

function refreshPresetContext() {
    const panels = document.querySelectorAll?.("[data-preset-context]") || [];
    if (!panels.length) return;
    const comparison = loadedPresetData ? comparePresetToCurrent(loadedPresetData)
        : { changes: [], blocked: hasSensitiveCustomArgs(getPresetFlagCore().getFlagValues()) };
    for (const panel of panels) {
        panel.classList.remove("hidden");
        panel.querySelector("[data-preset-origin]").textContent = lastLoadedPresetName ? "Based on:" : "Unsaved configuration";
        const name = panel.querySelector("[data-preset-name]");
        name.classList.toggle("hidden", !lastLoadedPresetName);
        name.textContent = lastLoadedPresetName;
        name.title = lastLoadedPresetName;
        panel.querySelector("[data-preset-state]").classList.toggle("hidden", !lastLoadedPresetName);
        panel.querySelector("[data-preset-state]").textContent = loadedPresetMissing ? "No longer saved"
            : comparison.blocked ? "Cannot save custom API key"
                : comparison.changes.length ? "Modified" : "Matches saved preset";
        const update = panel.querySelector("[data-preset-update]");
        update.classList.toggle("hidden", !lastLoadedPresetName);
        update.textContent = `Update ${lastLoadedPresetName}`;
        update.disabled = presetSavePending || loadedPresetMissing || comparison.blocked || !comparison.changes.length;
        panel.querySelector("[data-preset-save-new]").disabled = presetSavePending || comparison.blocked;
        const review = panel.querySelector("[data-preset-review]");
        review.classList.toggle("hidden", loadedPresetMissing || !comparison.changes.length);
        panel.querySelector("[data-preset-review-label]").textContent = `Compared with saved preset · ${comparison.changes.length} changes`;
        if (review.open) renderPresetChangeRows(review.querySelector("tbody"), comparison.changes);
        const note = panel.querySelector("[data-preset-context-note]");
        note.classList.toggle("hidden", !loadedPresetMissing && !loadedPresetArchived && !comparison.blocked && !review.open);
        note.textContent = loadedPresetMissing ? "The source preset was removed. Your edits remain available to save as a new preset."
            : comparison.blocked ? SENSITIVE_CUSTOM_ARG_MESSAGE
                : `${loadedPresetArchived ? "This preset is archived. " : ""}Compares saved launch inputs with your edits. API keys and HF tokens are excluded; sensitive values and Custom Launch Args are hidden in this review.`;
    }
}

async function openLoadedPresetInLibrary() {
    presetSearchQuery = lastLoadedPresetName;
    presetWarningFilterActive = false;
    presetFavoritesMode = "all";
    presetArchiveViewActive = loadedPresetArchived;
    document.getElementById("preset-search").value = presetSearchQuery;
    // Clear filter controls together with their state so the requested preset
    // remains reachable even after browsing a filtered/archived library.
    document.getElementById("preset-filter-all").classList.add("active");
    document.getElementById("preset-filter-warnings").classList.remove("active");
    renderPresetFavoritesChip();
    setPresetStorageItem(PRESET_FAVORITES_FIRST_STORAGE_KEY, presetFavoritesMode);
    selectedPresetName = lastLoadedPresetName;
    presetDependencies.switchTab("presets");
    await loadPresets();
    const title = document.querySelector("#preset-detail-panel .preset-detail-title");
    if (title) { title.tabIndex = -1; title.focus(); }
}

function initPresetContextControls() {
    for (const panel of document.querySelectorAll("[data-preset-context]")) {
        panel.querySelector("[data-preset-name]").addEventListener("click", openLoadedPresetInLibrary);
        panel.querySelector("[data-preset-update]").addEventListener("click", () => updatePreset(lastLoadedPresetName));
        panel.querySelector("[data-preset-save-new]").addEventListener("click", () => savePresetAsNew());
        panel.querySelector("[data-preset-review]").addEventListener("toggle", refreshPresetContext);
    }
    refreshPresetContext();
}
