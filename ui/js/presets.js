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

function applyPresetModel(modelName) {
    const modelSelect = document.getElementById("model-select");
    const target = String(modelName || "");

    if (!target) {
        modelSelect.value = "";
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
}

function buildCurrentPresetData() {
    const values = collectFlagValues();
    const selectedModel = document.getElementById("model-select").value || "";
    return { tool: currentTool, model: selectedModel, flags: values };
}

let presetStatusTimer = null;

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
        if (presets.length === 0) {
            container.innerHTML = '<div style="color:var(--fg-dim);padding:12px">No saved presets yet.</div>';
            return;
        }
        for (const p of presets) {
            const el = document.createElement("div");
            el.className = "preset-item";
            const presetData = normalizePresetData(p.data);
            const flagCount = Object.keys(presetData.flags || {}).length;

            const details = document.createElement("div");
            const nameEl = document.createElement("div");
            nameEl.className = "preset-name";
            nameEl.textContent = p.name;
            const metaEl = document.createElement("div");
            metaEl.className = "preset-meta";
            const toolText = presetData.tool || "(keep current tool)";
            const modelText = presetData.model || "(none)";
            metaEl.textContent = `${flagCount} configured flag(s) • tool: ${toolText} • model: ${modelText}`;
            details.appendChild(nameEl);
            details.appendChild(metaEl);

            const actions = document.createElement("div");
            actions.className = "form-row";

            const loadBtn = document.createElement("button");
            loadBtn.className = "btn btn-sm";
            loadBtn.textContent = "Load";
            loadBtn.addEventListener("click", () => loadPreset(p.name));

            const exportBtn = document.createElement("button");
            exportBtn.className = "btn btn-sm";
            exportBtn.textContent = "Export";
            exportBtn.addEventListener("click", () => exportPreset(p.name));

            const updateBtn = document.createElement("button");
            updateBtn.className = "btn btn-sm";
            updateBtn.textContent = "Update";
            updateBtn.title = "Overwrite this preset with current Configure values";
            updateBtn.addEventListener("click", () => updatePreset(p.name));

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "btn btn-sm btn-danger";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", () => deletePreset(p.name));

            actions.appendChild(loadBtn);
            actions.appendChild(exportBtn);
            actions.appendChild(updateBtn);
            actions.appendChild(deleteBtn);

            el.appendChild(details);
            el.appendChild(actions);
            container.appendChild(el);
        }
    } catch (e) {
        container.innerHTML = '<div style="color:var(--red);padding:12px">Failed to load presets.</div>';
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
            const presetData = normalizePresetData(preset.data);
            if (presetData.tool === "llama-cli" || presetData.tool === "llama-server") {
                currentTool = presetData.tool;
                document.getElementById("tool-select").value = presetData.tool;
                renderFlags();
            }
            applyPresetModel(presetData.model);
            applyFlagValues(presetData.flags);
            switchTab("configure");
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
