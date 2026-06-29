function normalizePresetData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { tool: null, model: "", flags: {} };
    }

    if (data.flags && typeof data.flags === "object" && !Array.isArray(data.flags)) {
        const tool = typeof data.tool === "string" ? data.tool : null;
        const model = typeof data.model === "string" ? data.model : "";
        return { tool, model, flags: data.flags };
    }

    return { tool: null, model: "", flags: data };
}

function getKnownPresetFlagIds() {
    const flags = Array.isArray(window.FLAGS)
        ? window.FLAGS
        : (typeof FLAGS !== "undefined" && Array.isArray(FLAGS) ? FLAGS : []);
    return new Set(flags.map((flag) => flag && flag.id).filter(Boolean));
}

function normalizeImportedPresetData(data) {
    const normalized = normalizePresetData(data);
    const tool = normalized.tool === "llama-server" || normalized.tool === "llama-cli"
        ? normalized.tool
        : null;
    const model = typeof normalized.model === "string" ? normalized.model : "";
    const knownFlagIds = getKnownPresetFlagIds();
    const flags = {};

    for (const [key, value] of Object.entries(normalized.flags || {})) {
        if (knownFlagIds.has(key)) {
            flags[key] = value;
        }
    }

    return { tool, model, flags };
}

function hasUsablePresetData(presetData) {
    return Boolean(presetData && (presetData.model || Object.keys(presetData.flags || {}).length > 0));
}

function getPresetFlagCore() {
    if (!window.LlamaGui || !window.LlamaGui.flagCore) {
        throw new Error("Flag core is not available.");
    }
    return window.LlamaGui.flagCore;
}

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

    const existingOption = Array.from(modelSelect.options).find(o => o.value === target);
    if (!existingOption) {
        const opt = document.createElement("option");
        opt.value = target;
        opt.textContent = `${target}  (missing)`;
        modelSelect.appendChild(opt);
    }

    modelSelect.value = target;
    if (flagCore) flagCore.setSelectedModelValue(target);
    if (typeof syncQuickLaunchModelOptions === "function") {
        syncQuickLaunchModelOptions();
    }
}

function buildCurrentPresetData() {
    const flagCore = getPresetFlagCore();
    const values = flagCore.getFlagValues();
    const selectedModel = flagCore.getSelectedModel();
    const tool = flagCore.getCurrentTool();
    return { tool, model: selectedModel, flags: values };
}

function getPresetWarnings(presetData) {
    const warnings = [];
    const flags = (presetData && presetData.flags) || {};
    const chatTemplate = flags.chat_template;

    if (chatTemplate && typeof isSupportedChatTemplateValue === "function" && !isSupportedChatTemplateValue(chatTemplate)) {
        warnings.push(`Uses outdated or unsupported chat template "${chatTemplate}". It will be ignored and Auto from model is safer.`);
    }

    if (typeof flags.custom_args === "string" && flags.custom_args.trim()) {
        warnings.push("Includes custom launch args. Review them before launching because they may override UI controls.");
    }

    if (typeof flags.runtime_env_vars === "string" && flags.runtime_env_vars.trim()) {
        warnings.push("Includes runtime environment variables. Review them before launching because they may change GPU selection or runtime behavior.");
    }

    return warnings;
}

const PRESET_GROUP_STATE_STORAGE_KEY = "llama_gui_preset_group_state_v1";
const NO_MODEL_PRESET_GROUP_KEY = "__no_model__";

let presetStatusTimer = null;
let presetSearchQuery = "";
let currentPresetGroups = [];
let selectedPresetName = "";
let selectedPresetNames = new Set();

function getPresetGroupKey(model) {
    const normalized = String(model || "").trim();
    return normalized || NO_MODEL_PRESET_GROUP_KEY;
}

function getPresetGroupLabel(groupKey) {
    if (groupKey === NO_MODEL_PRESET_GROUP_KEY) {
        return "No model saved";
    }

    const parts = String(groupKey).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : groupKey;
}

function loadPresetGroupState() {
    try {
        const raw = localStorage.getItem(PRESET_GROUP_STATE_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function savePresetGroupState(state) {
    localStorage.setItem(PRESET_GROUP_STATE_STORAGE_KEY, JSON.stringify(state));
}

function isPresetGroupCollapsed(groupKey) {
    return loadPresetGroupState()[groupKey] === true;
}

function setPresetGroupCollapsed(groupKey, collapsed) {
    const state = loadPresetGroupState();
    state[groupKey] = Boolean(collapsed);
    savePresetGroupState(state);
}

function getPresetSearchText(entry) {
    return [
        entry.name,
        entry.groupKey === NO_MODEL_PRESET_GROUP_KEY ? "no model saved" : entry.groupKey,
        entry.modelLabel,
        entry.toolText,
    ].join(" ").toLowerCase();
}

function buildPresetGroups(presets) {
    const groupsByKey = new Map();

    for (const preset of presets) {
        const presetData = normalizePresetData(preset.data);
        const groupKey = getPresetGroupKey(presetData.model);
        const warnings = getPresetWarnings(presetData);
        const entry = {
            name: preset.name,
            data: presetData,
            groupKey,
            modelLabel: getPresetGroupLabel(groupKey),
            toolText: presetData.tool || "Keep current tool",
            flagCount: Object.keys(presetData.flags || {}).length,
            warnings,
        };

        if (!groupsByKey.has(groupKey)) {
            groupsByKey.set(groupKey, {
                key: groupKey,
                label: entry.modelLabel,
                modelPath: groupKey === NO_MODEL_PRESET_GROUP_KEY ? "" : groupKey,
                entries: [],
            });
        }

        groupsByKey.get(groupKey).entries.push(entry);
    }

    const query = presetSearchQuery.trim().toLowerCase();
    const groups = Array.from(groupsByKey.values()).map((group) => {
        const entries = group.entries
            .filter((entry) => !query || getPresetSearchText(entry).includes(query))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        return {
            ...group,
            entries,
            visibleWarningCount: entries.reduce((count, entry) => count + entry.warnings.length, 0),
        };
    }).filter((group) => group.entries.length > 0);

    groups.sort((a, b) => {
        if (a.key === NO_MODEL_PRESET_GROUP_KEY) return 1;
        if (b.key === NO_MODEL_PRESET_GROUP_KEY) return -1;
        return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });

    return groups;
}

function createPresetButton(label, className, onClick, title = "") {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.textContent = label;
    if (title) button.title = title;
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return button;
}

function getVisiblePresetEntries() {
    return currentPresetGroups.flatMap((group) => group.entries);
}

function findVisiblePresetEntry(name) {
    return getVisiblePresetEntries().find((entry) => entry.name === name) || null;
}

function getPresetFlagLabel(flagId) {
    const flags = Array.isArray(window.FLAGS)
        ? window.FLAGS
        : (typeof FLAGS !== "undefined" && Array.isArray(FLAGS) ? FLAGS : []);
    const flag = flags.find((entry) => entry && entry.id === flagId);
    return (flag && flag.label) || flagId.replace(/_/g, " ");
}

function getNotablePresetSettings(presetData) {
    const flags = (presetData && presetData.flags) || {};
    const notableIds = [
        "ctx_size",
        "gpu_layers",
        "chat_template",
        "chat_template_custom",
        "temperature",
        "top_k",
        "top_p",
        "min_p",
        "repeat_penalty",
    ];
    const settings = [];

    for (const id of notableIds) {
        if (Object.prototype.hasOwnProperty.call(flags, id) && flags[id] !== "" && flags[id] !== null && flags[id] !== undefined) {
            settings.push({ label: getPresetFlagLabel(id), value: String(flags[id]) });
        }
    }

    settings.push({
        label: "Custom Args",
        value: typeof flags.custom_args === "string" && flags.custom_args.trim() ? "present" : "none",
    });

    settings.push({
        label: "Runtime Env Vars",
        value: typeof flags.runtime_env_vars === "string" && flags.runtime_env_vars.trim() ? "present" : "none",
    });

    return settings;
}

function appendDetailRow(container, label, value) {
    const row = document.createElement("div");
    row.className = "preset-detail-row";

    const labelEl = document.createElement("span");
    labelEl.className = "preset-detail-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = "preset-detail-value";
    valueEl.textContent = value;

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    container.appendChild(row);
}

function renderPresetDetailPanel() {
    const panel = document.getElementById("preset-detail-panel");
    if (!panel) return;
    panel.textContent = "";

    const entry = findVisiblePresetEntry(selectedPresetName);
    if (!entry) {
        const kicker = document.createElement("div");
        kicker.className = "preset-detail-kicker";
        kicker.textContent = "Selected Preset";

        const empty = document.createElement("div");
        empty.className = "preset-detail-empty";
        empty.textContent = "Select a preset to preview its saved model, tool, warnings, and notable settings.";

        panel.appendChild(kicker);
        panel.appendChild(empty);
        return;
    }

    const kicker = document.createElement("div");
    kicker.className = "preset-detail-kicker";
    kicker.textContent = "Selected Preset";

    const title = document.createElement("div");
    title.className = "preset-detail-title";
    title.textContent = entry.name;

    const subtitle = document.createElement("div");
    subtitle.className = "preset-detail-subtitle";
    subtitle.textContent = entry.groupKey === NO_MODEL_PRESET_GROUP_KEY ? "No model saved" : entry.groupKey;

    const actions = document.createElement("div");
    actions.className = "preset-detail-actions";
    actions.appendChild(createPresetButton("Load", "btn btn-sm btn-primary", () => loadPreset(entry.name)));
    actions.appendChild(createPresetButton("Update", "btn btn-sm", () => updatePreset(entry.name), "Overwrite this preset with current Configure values"));
    actions.appendChild(createPresetButton("Export", "btn btn-sm", () => exportPreset(entry.name)));
    actions.appendChild(createPresetButton("Shortcut", "btn btn-sm", () => exportPresetShortcut(entry.name), "Export a Windows shortcut for this preset"));
    actions.appendChild(createPresetButton("Delete", "btn btn-sm btn-danger", () => deletePreset(entry.name)));

    const details = document.createElement("div");
    details.className = "preset-detail-grid";
    appendDetailRow(details, "Tool", entry.toolText);
    appendDetailRow(details, "Configured Flags", String(entry.flagCount));
    appendDetailRow(details, "Warnings", String(entry.warnings.length));

    const settingsTitle = document.createElement("div");
    settingsTitle.className = "preset-detail-section-title";
    settingsTitle.textContent = "Notable Settings";

    const settings = document.createElement("div");
    settings.className = "preset-detail-settings";
    for (const item of getNotablePresetSettings(entry.data)) {
        appendDetailRow(settings, item.label, item.value);
    }

    const warningsTitle = document.createElement("div");
    warningsTitle.className = "preset-detail-section-title";
    warningsTitle.textContent = "Warnings";

    const warnings = document.createElement("div");
    warnings.className = entry.warnings.length ? "preset-warning" : "preset-detail-note";
    warnings.textContent = entry.warnings.length
        ? entry.warnings.join(" ")
        : "No preset warnings. This preset should load cleanly into Configure and Quick Launch.";

    panel.appendChild(kicker);
    panel.appendChild(title);
    panel.appendChild(subtitle);
    panel.appendChild(actions);
    panel.appendChild(details);
    panel.appendChild(settingsTitle);
    panel.appendChild(settings);
    panel.appendChild(warningsTitle);
    panel.appendChild(warnings);
}

function renderPresetBulkControls() {
    const countEl = document.getElementById("presets-selection-count");
    const deleteButton = document.getElementById("btn-presets-delete-selected");
    const visibleNames = new Set(getVisiblePresetEntries().map((entry) => entry.name));
    let visibleSelectedCount = 0;

    for (const name of selectedPresetNames) {
        if (visibleNames.has(name)) visibleSelectedCount++;
    }

    if (countEl) {
        countEl.textContent = `${visibleSelectedCount} selected`;
    }
    if (deleteButton) {
        deleteButton.disabled = selectedPresetNames.size === 0;
    }
}

function renderPresetAuxiliaryPanels() {
    renderPresetDetailPanel();
    renderPresetBulkControls();
}

function togglePresetChecked(name) {
    selectedPresetName = String(name || "");
    if (selectedPresetNames.has(name)) {
        selectedPresetNames.delete(name);
    } else {
        selectedPresetNames.add(name);
    }
    renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
}

function setPresetChecked(name, checked) {
    selectedPresetName = String(name || "");
    if (checked) {
        selectedPresetNames.add(name);
    } else {
        selectedPresetNames.delete(name);
    }
    renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
}

function renderPresetEntry(entry) {
    const el = document.createElement("div");
    el.className = "preset-item";
    if (entry.name === selectedPresetName) {
        el.classList.add("selected");
    }
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-pressed", String(entry.name === selectedPresetName));
    el.addEventListener("click", () => togglePresetChecked(entry.name));
    el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            togglePresetChecked(entry.name);
        }
    });

    const checkWrap = document.createElement("label");
    checkWrap.className = "preset-checkbox";
    checkWrap.title = "Select this preset for bulk actions";
    checkWrap.addEventListener("click", (event) => event.stopPropagation());

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPresetNames.has(entry.name);
    checkbox.setAttribute("aria-label", `Select preset ${entry.name}`);
    checkbox.addEventListener("change", () => setPresetChecked(entry.name, checkbox.checked));
    checkWrap.appendChild(checkbox);

    const details = document.createElement("div");
    details.className = "preset-details";

    const titleRow = document.createElement("div");
    titleRow.className = "preset-title-row";

    const nameEl = document.createElement("div");
    nameEl.className = "preset-name";
    nameEl.textContent = entry.name;
    titleRow.appendChild(nameEl);

    if (entry.warnings.length > 0) {
        const warningBadge = document.createElement("span");
        warningBadge.className = "preset-warning-badge";
        warningBadge.textContent = entry.warnings.length === 1 ? "Warning" : `${entry.warnings.length} warnings`;
        titleRow.appendChild(warningBadge);
    }

    const metaEl = document.createElement("div");
    metaEl.className = "preset-meta";
    metaEl.textContent = `${entry.toolText} - ${entry.flagCount} configured flag${entry.flagCount === 1 ? "" : "s"}`;

    details.appendChild(titleRow);
    details.appendChild(metaEl);

    if (entry.warnings.length > 0) {
        const warningEl = document.createElement("div");
        warningEl.className = "preset-warning preset-warning-compact";
        warningEl.textContent = entry.warnings.join(" ");
        details.appendChild(warningEl);
    }

    const actions = document.createElement("div");
    actions.className = "preset-actions";
    actions.appendChild(createPresetButton("Load", "btn btn-sm btn-primary", () => loadPreset(entry.name)));
    actions.appendChild(createPresetButton("Update", "btn btn-sm", () => updatePreset(entry.name), "Overwrite this preset with current Configure values"));
    actions.appendChild(createPresetButton("Export", "btn btn-sm", () => exportPreset(entry.name)));
    actions.appendChild(createPresetButton("Shortcut", "btn btn-sm", () => exportPresetShortcut(entry.name), "Export a Windows shortcut for this preset"));

    el.appendChild(checkWrap);
    el.appendChild(details);
    el.appendChild(actions);
    return el;
}

function renderPresetGroups(container, groups) {
    container.textContent = "";

    if (groups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "presets-empty";
        empty.textContent = presetSearchQuery ? "No presets match your search." : "No saved presets yet.";
        container.appendChild(empty);
        renderPresetAuxiliaryPanels();
        return;
    }

    for (const group of groups) {
        const groupEl = document.createElement("section");
        groupEl.className = "preset-group";
        const collapsed = isPresetGroupCollapsed(group.key);
        if (collapsed) groupEl.classList.add("collapsed");

        const header = document.createElement("button");
        header.className = "preset-group-header";
        header.type = "button";
        header.setAttribute("aria-expanded", String(!collapsed));
        if (group.modelPath && group.modelPath !== group.label) {
            header.title = group.modelPath;
        }

        const chevron = document.createElement("span");
        chevron.className = "preset-group-chevron";
        chevron.textContent = collapsed ? "+" : "-";

        const headerText = document.createElement("div");
        headerText.className = "preset-group-text";

        const title = document.createElement("div");
        title.className = "preset-group-title";
        title.textContent = group.label;

        const meta = document.createElement("div");
        meta.className = "preset-group-meta";
        const warningText = group.visibleWarningCount > 0 ? ` - ${group.visibleWarningCount} warning${group.visibleWarningCount === 1 ? "" : "s"}` : "";
        meta.textContent = `${group.entries.length} preset${group.entries.length === 1 ? "" : "s"}${warningText}`;

        headerText.appendChild(title);
        headerText.appendChild(meta);
        header.appendChild(chevron);
        header.appendChild(headerText);
        header.addEventListener("click", () => {
            const nextCollapsed = !groupEl.classList.contains("collapsed");
            groupEl.classList.toggle("collapsed", nextCollapsed);
            header.setAttribute("aria-expanded", String(!nextCollapsed));
            chevron.textContent = nextCollapsed ? "+" : "-";
            setPresetGroupCollapsed(group.key, nextCollapsed);
        });

        const list = document.createElement("div");
        list.className = "preset-group-list";
        for (const entry of group.entries) {
            list.appendChild(renderPresetEntry(entry));
        }

        groupEl.appendChild(header);
        groupEl.appendChild(list);
        container.appendChild(groupEl);
    }

    renderPresetAuxiliaryPanels();
}

function showPresetStatus(message, type = "success", durationMs = 2200) {
    const statusEl = document.getElementById("preset-status");
    if (!statusEl) return;
    if (presetStatusTimer) {
        clearTimeout(presetStatusTimer);
        presetStatusTimer = null;
    }
    statusEl.className = "status-box";
    statusEl.classList.add(type);
    statusEl.textContent = message;
    presetStatusTimer = setTimeout(() => {
        statusEl.className = "status-box";
        statusEl.textContent = "";
        presetStatusTimer = null;
    }, durationMs);
}

async function loadPresets() {
    const container = document.getElementById("presets-list");
    container.textContent = "";
    try {
        const presets = await fetchJson("/api/presets");
        currentPresetGroups = buildPresetGroups(presets);
        const visibleEntries = getVisiblePresetEntries();
        const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
        selectedPresetNames = new Set(Array.from(selectedPresetNames).filter((name) => visibleNames.has(name)));
        if (!selectedPresetName || !visibleNames.has(selectedPresetName)) {
            selectedPresetName = visibleEntries.length ? visibleEntries[0].name : "";
        }
        renderPresetGroups(container, currentPresetGroups);
    } catch (e) {
        const error = document.createElement("div");
        error.className = "presets-empty presets-error";
        error.textContent = "Failed to load presets.";
        container.appendChild(error);
        renderPresetAuxiliaryPanels();
    }
}

function initPresetLibraryControls() {
    const search = document.getElementById("preset-search");
    if (search) {
        search.addEventListener("input", () => {
            presetSearchQuery = search.value.trim();
            loadPresets();
        });
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && search.value) {
                search.value = "";
                presetSearchQuery = "";
                loadPresets();
            }
        });
    }

    const expandAll = document.getElementById("btn-presets-expand-all");
    if (expandAll) {
        expandAll.addEventListener("click", () => {
            const state = loadPresetGroupState();
            for (const group of currentPresetGroups) {
                state[group.key] = false;
            }
            savePresetGroupState(state);
            loadPresets();
        });
    }

    const collapseAll = document.getElementById("btn-presets-collapse-all");
    if (collapseAll) {
        collapseAll.addEventListener("click", () => {
            const state = loadPresetGroupState();
            for (const group of currentPresetGroups) {
                state[group.key] = true;
            }
            savePresetGroupState(state);
            loadPresets();
        });
    }

    const selectAll = document.getElementById("btn-presets-select-all");
    if (selectAll) {
        selectAll.addEventListener("click", () => {
            for (const entry of getVisiblePresetEntries()) {
                selectedPresetNames.add(entry.name);
            }
            renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
        });
    }

    const selectNone = document.getElementById("btn-presets-select-none");
    if (selectNone) {
        selectNone.addEventListener("click", () => {
            selectedPresetNames.clear();
            renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
        });
    }

    const deleteSelected = document.getElementById("btn-presets-delete-selected");
    if (deleteSelected) {
        deleteSelected.addEventListener("click", deleteSelectedPresets);
    }
}

async function savePreset() {
    const nameInput = document.getElementById("preset-name-input");
    const name = nameInput.value.trim();
    if (!name) {
        nameInput.style.borderColor = "var(--red)";
        setTimeout(() => nameInput.style.borderColor = "", 1500);
        return;
    }
    const data = buildCurrentPresetData();
    try {
        const result = await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
        });
        if (result.saved) {
            nameInput.value = "";
            loadPresets();
            showPresetStatus(`Saved preset \"${result.name || name}\"`, "success");
        }
    } catch (e) {
        showPresetStatus("Failed to save preset", "error", 3200);
        console.warn("Failed to save preset", e);
    }
}

async function updatePreset(name) {
    const ok = await confirmAction(
        "Update Preset",
        `Overwrite preset "${name}" with current Configure settings?`,
        "Update"
    );
    if (!ok) return;

    try {
        const data = buildCurrentPresetData();
        const result = await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
        });
        if (result.saved) {
            loadPresets();
            showPresetStatus(`Updated preset \"${name}\"`, "success");
        }
    } catch (e) {
        showPresetStatus("Failed to update preset", "error", 3200);
        console.warn("Failed to update preset", e);
    }
}

async function loadPreset(name) {
    try {
        const presets = await fetchJson("/api/presets");
        const preset = presets.find(p => p.name === name);
        if (preset) {
            const flagCore = getPresetFlagCore();
            const presetData = normalizePresetData(preset.data);
            const warnings = getPresetWarnings(presetData);
            if (presetData.tool === "llama-cli" || presetData.tool === "llama-server") {
                flagCore.setCurrentTool(presetData.tool);
                const toolSelect = document.getElementById("tool-select");
                if (toolSelect) toolSelect.value = presetData.tool;
            }
            applyPresetModel(presetData.model);
            flagCore.applyFlagValues(presetData.flags);
            if (warnings.length > 0) {
                showPresetStatus(`Loaded "${name}" with warning: ${warnings[0]}`, "warning", 5000);
            } else {
                showPresetStatus(`Loaded preset "${name}"`, "success");
            }
            switchTab("configure");
        } else {
            showPresetStatus(`Preset "${name}" not found.`, "error", 3200);
        }
    } catch (e) {
        showPresetStatus("Failed to load preset", "error", 3200);
        console.warn("Failed to load preset", e);
    }
}

async function deletePreset(name) {
    const ok = await confirmAction(
        "Delete Preset",
        `Delete preset "${name}"? This cannot be undone.`,
        "Delete"
    );
    if (!ok) return;
    try {
        await fetchJson("/api/presets/" + encodeURIComponent(name), { method: "DELETE" });
        loadPresets();
        showPresetStatus(`Deleted preset \"${name}\"`, "success");
    } catch (e) {
        showPresetStatus("Failed to delete preset", "error", 3200);
        console.warn("Failed to delete preset", e);
    }
}

async function deleteSelectedPresets() {
    const names = Array.from(selectedPresetNames);
    if (names.length === 0) {
        showPresetStatus("No presets selected", "error", 3200);
        return;
    }

    const ok = await confirmAction(
        "Delete Selected Presets",
        `Delete ${names.length} selected preset${names.length === 1 ? "" : "s"}? This cannot be undone.`,
        "Delete"
    );
    if (!ok) return;

    try {
        for (const name of names) {
            await fetchJson("/api/presets/" + encodeURIComponent(name), { method: "DELETE" });
        }
        selectedPresetNames.clear();
        if (names.includes(selectedPresetName)) {
            selectedPresetName = "";
        }
        await loadPresets();
        showPresetStatus(`Deleted ${names.length} preset${names.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
        showPresetStatus("Failed to delete selected presets", "error", 3200);
        console.warn("Failed to delete selected presets", e);
        loadPresets();
    }
}

function exportPreset(name) {
    fetchJson("/api/presets")
        .then((presets) => {
            const p = presets.find(x => x.name === name);
            if (!p) {
                showPresetStatus(`Preset "${name}" not found.`, "error", 3200);
                return;
            }
            const presetData = normalizePresetData(p.data);
            const exportData = { tool: presetData.tool, model: presetData.model, flags: presetData.flags };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name + ".json";
            a.click();
            URL.revokeObjectURL(url);
        })
        .catch((e) => {
            showPresetStatus("Failed to export preset", "error", 3200);
            console.warn("Failed to export preset", e);
        });
}

async function exportPresetShortcut(name) {
    try {
        const resp = await fetch("/api/presets/shortcut", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) {
            throw new Error(`Shortcut export failed with HTTP ${resp.status}`);
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const safeName = String(name || "Llama GUI").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/^[. _]+|[. _]+$/g, "") || "Llama GUI";
        a.href = url;
        a.download = `${safeName}.cmd`;
        a.click();
        URL.revokeObjectURL(url);
        showPresetStatus(`Exported shortcut for "${name}"`, "success");
    } catch (e) {
        showPresetStatus("Failed to export shortcut", "error", 3200);
        console.warn("Failed to export preset shortcut", e);
    }
}

function exportAllPresets() {
    fetchJson("/api/presets")
        .then((presets) => {
            if (!presets || presets.length === 0) {
                showPresetStatus("No presets to export", "error", 3200);
                return;
            }
            const exportData = { presets: presets.map(p => ({
                name: p.name,
                data: normalizePresetData(p.data)
            })) };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "llama-gui-presets.json";
            a.click();
            URL.revokeObjectURL(url);
            showPresetStatus(`Exported ${presets.length} preset(s)`, "success");
        })
        .catch((e) => {
            showPresetStatus("Failed to export presets", "error", 3200);
            console.warn("Failed to export presets", e);
        });
}

async function handlePresetImport(file) {
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const bulkPresets = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === "object" && Array.isArray(parsed.presets)
                ? parsed.presets
                : null;

        if (bulkPresets && bulkPresets.length > 0) {
            let imported = 0;
            let unnamedIdx = 0;
            for (const entry of bulkPresets) {
                const name = entry.name || "Imported-" + (++unnamedIdx);
                const normalized = normalizeImportedPresetData(entry.data || {});
                if (!hasUsablePresetData(normalized)) continue;
                await fetchJson("/api/presets", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, data: { tool: normalized.tool, model: normalized.model, flags: normalized.flags } }),
                });
                imported++;
            }
            loadPresets();
            showPresetStatus(`Imported ${imported} preset(s)`, "success");
            return;
        }

        const normalized = normalizeImportedPresetData(parsed);
        if (!hasUsablePresetData(normalized)) {
            showPresetStatus("Preset file contains no usable data.", "error", 3200);
            return;
        }
        const name = file.name.replace(/\.json$/i, "");
        await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data: { tool: normalized.tool, model: normalized.model, flags: normalized.flags } }),
        });
        loadPresets();
        showPresetStatus(`Imported preset \"${name}\"`, "success");
    } catch (err) {
        showPresetStatus("Failed to import preset", "error", 3200);
        console.warn("Failed to import preset", err);
    }
}

if (window.LlamaGui) {
    window.LlamaGui.presets = Object.assign(window.LlamaGui.presets || {}, {
        loadPreset,
        normalizeImportedPresetData,
    });
}
