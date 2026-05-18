(function () {
    window.LlamaGui = window.LlamaGui || {};

    let dependencies = {};

    function configure(options) {
        dependencies = Object.assign({}, dependencies, options || {});
    }

    function getFlagCore() {
        return dependencies.flagCore || window.LlamaGui.flagCore;
    }

    function getFlags() {
        return typeof dependencies.getFlags === "function" ? dependencies.getFlags() : [];
    }

    function getDefaultFlagValues() {
        return typeof dependencies.getDefaultFlagValues === "function" ? dependencies.getDefaultFlagValues() : {};
    }

    function getSamplerFlags() {
        return getFlags().filter(f => f.category === "sampling");
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
        try {
            localStorage.setItem(SAMPLER_PRESET_STORAGE_KEY, JSON.stringify(store));
        } catch (e) {
            console.warn("Failed to save sampler presets", e);
        }
    }

    function collectSamplerValues() {
        const core = getFlagCore();
        const values = {};
        const currentValues = core ? core.getFlagValues() : {};
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
        const core = getFlagCore();
        if (!core) return;

        const defaults = getDefaultFlagValues();
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
        core.setMultipleFlagValues(patch);
    }

    function refreshConsumers() {
        if (typeof dependencies.refreshSamplerPresetSelect === "function") {
            dependencies.refreshSamplerPresetSelect();
        }
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
            refreshConsumers();
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
            const confirmAction = dependencies.confirmAction;
            const ok = typeof confirmAction === "function"
                ? await confirmAction(
                    "Delete Sampler Preset",
                    `Delete sampler preset "${selected.name}"? This cannot be undone.`,
                    "Delete"
                )
                : confirm(`Delete sampler preset "${selected.name}"? This cannot be undone.`);
            if (!ok) return;

            const store = loadSamplerPresetStore();
            delete store[selected.name];
            saveSamplerPresetStore(store);
            refreshOptions();
            refreshConsumers();
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
                refreshConsumers();
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

    window.LlamaGui.samplerPresets = {
        configure,
        getSamplerFlags,
        loadSamplerPresetStore,
        saveSamplerPresetStore,
        collectSamplerValues,
        normalizeSamplerPresetValues,
        getAllSamplerPresets,
        applySamplerPresetValues,
        createSamplerPresetControls,
    };
})();
