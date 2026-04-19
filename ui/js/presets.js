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
            const flagCount = Object.keys(p.data || {}).length;

            const details = document.createElement("div");
            const nameEl = document.createElement("div");
            nameEl.className = "preset-name";
            nameEl.textContent = p.name;
            const metaEl = document.createElement("div");
            metaEl.className = "preset-meta";
            metaEl.textContent = `${flagCount} configured flag(s)`;
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

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "btn btn-sm btn-danger";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", () => deletePreset(p.name));

            actions.appendChild(loadBtn);
            actions.appendChild(exportBtn);
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
    const values = collectFlagValues();
    try {
        const result = await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data: values }),
        });
        if (result.saved) {
            nameInput.value = "";
            loadPresets();
        }
    } catch (e) {
        alert("Failed to save preset: " + e.message);
    }
}

async function loadPreset(name) {
    try {
        const presets = await fetchJson("/api/presets");
        const preset = presets.find(p => p.name === name);
        if (preset) {
            applyFlagValues(preset.data);
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
    } catch (e) {
        alert("Failed to delete preset: " + e.message);
    }
}

function exportPreset(name) {
    fetchJson("/api/presets")
        .then((presets) => {
            const p = presets.find(x => x.name === name);
            if (!p) return;
            const blob = new Blob([JSON.stringify(p.data, null, 2)], { type: "application/json" });
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
            const name = file.name.replace(/\.json$/i, "");
            await fetchJson("/api/presets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, data }),
            });
            loadPresets();
        } catch (err) {
            alert("Failed to import preset: " + err.message);
        }
    };
    reader.readAsText(file);
}
