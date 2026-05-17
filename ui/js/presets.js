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
        modelSelect.value = "";
        if (flagCore) flagCore.setSelectedModelValue("");
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
    const values = flagCore.collectFlagValues();
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

    return warnings;
}

const PRESET_GROUP_STATE_STORAGE_KEY = "llama_gui_preset_group_state_v1";
const NO_MODEL_PRESET_GROUP_KEY = "__no_model__";

let presetStatusTimer = null;
let presetSearchQuery = "";
let currentPresetGroups = [];

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
    button.addEventListener("click", onClick);
    return button;
}

function renderPresetEntry(entry) {
    const el = document.createElement("div");
    el.className = "preset-item";

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
    actions.appendChild(createPresetButton("Load", "btn btn-sm", () => loadPreset(entry.name)));
    actions.appendChild(createPresetButton("Update", "btn btn-sm", () => updatePreset(entry.name), "Overwrite this preset with current Configure values"));
    actions.appendChild(createPresetButton("Export", "btn btn-sm", () => exportPreset(entry.name)));
    actions.appendChild(createPresetButton("Delete", "btn btn-sm btn-danger", () => deletePreset(entry.name)));

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
        renderPresetGroups(container, currentPresetGroups);
    } catch (e) {
        container.innerHTML = '<div style="color:var(--red);padding:12px">Failed to load presets.</div>';
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
        alert("Failed to save preset: " + e.message);
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
        alert("Failed to update preset: " + e.message);
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
                document.getElementById("tool-select").value = presetData.tool;
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
        alert("Failed to load preset: " + e.message);
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
        alert("Failed to delete preset: " + e.message);
    }
}

function exportPreset(name) {
    fetchJson("/api/presets")
        .then((presets) => {
            const p = presets.find(x => x.name === name);
            if (!p) return;
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
            alert("Failed to export preset: " + e.message);
        });
}

function handlePresetImport(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            const normalized = normalizePresetData(data);
            const importData = { tool: normalized.tool, model: normalized.model, flags: normalized.flags };
            if (!normalized.model && Object.keys(normalized.flags).length === 0) {
                showPresetStatus("Preset file contains no usable data.", "error", 3200);
                return;
            }
            const name = file.name.replace(/\.json$/i, "");
            await fetchJson("/api/presets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, data: importData }),
            });
            loadPresets();
            showPresetStatus(`Imported preset \"${name}\"`, "success");
        } catch (err) {
            showPresetStatus("Failed to import preset", "error", 3200);
            alert("Failed to import preset: " + err.message);
        }
    };
    reader.readAsText(file);
}
