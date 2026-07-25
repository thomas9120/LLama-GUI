(function () {
    window.LlamaGui = window.LlamaGui || {};

    let dependencies = {};
    // Survives the panel rebuilds that renderFlags() triggers, so the Configure sampler
    // dropdown does not lose the user's pick on an unrelated re-render.
    let selectedConfigPresetValue = "";

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
        } catch (e) {
            console.debug("Failed to load sampler presets", e);
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

    const SAMPLER_RENAME_MESSAGES = {
        empty: "Sampler preset name cannot be empty.",
        builtin: "Built-in sampler presets cannot be renamed.",
        missing: "That sampler preset no longer exists.",
        taken: "A sampler preset with that name already exists.",
    };

    function getSamplerRenameMessage(reason) {
        return SAMPLER_RENAME_MESSAGES[reason] || "Failed to rename sampler preset.";
    }

    /**
     * Rename a custom sampler preset in the shared store.
     *
     * Validation lives here so the Configure and Quick Launch buttons stay
     * thin; callers render their own message from `reason`.
     *
     * @returns {{ok: true, name: string}|{ok: false, reason: "empty"|"builtin"|"missing"|"taken"}}
     */
    function renameSamplerPreset(oldName, newName) {
        const from = String(oldName == null ? "" : oldName);
        const to = String(newName == null ? "" : newName).trim();
        if (!to) return { ok: false, reason: "empty" };

        const store = loadSamplerPresetStore();
        if (!Object.prototype.hasOwnProperty.call(store, from)) {
            if (Object.prototype.hasOwnProperty.call(BUILTIN_SAMPLER_PRESETS, from)) {
                return { ok: false, reason: "builtin" };
            }
            return { ok: false, reason: "missing" };
        }
        if (from === to) return { ok: true, name: to };

        // Compare case-insensitively so two presets can never differ by casing alone,
        // but allow re-casing a preset's own name (mirrors the case-only rename carve-out
        // in backend/routes/presets.py).
        const folded = to.toLowerCase();
        const builtinTaken = Object.keys(BUILTIN_SAMPLER_PRESETS)
            .some(name => name.toLowerCase() === folded);
        const customTaken = Object.keys(store)
            .some(name => name !== from && name.toLowerCase() === folded);
        if (builtinTaken || customTaken) return { ok: false, reason: "taken" };

        // Move the stored values as-is rather than re-normalizing, so a rename can
        // never silently drop a flag the current build does not know about.
        const values = store[from];
        delete store[from];
        store[to] = values;
        saveSamplerPresetStore(store);
        // Keep the Configure panel's remembered selection on the renamed preset, so a
        // rename made from Quick Launch does not snap it back to the first entry on the
        // next renderFlags() rebuild.
        if (selectedConfigPresetValue === `custom|${from}`) {
            selectedConfigPresetValue = `custom|${to}`;
        }
        return { ok: true, name: to };
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

    // `preferredValue` lets a rename carry the mirrored Quick Launch dropdown onto the
    // new name instead of dropping back to the placeholder when the old name disappears.
    function refreshConsumers(preferredValue) {
        if (typeof dependencies.refreshSamplerPresetSelect === "function") {
            dependencies.refreshSamplerPresetSelect(preferredValue);
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

        const renameBtn = document.createElement("button");
        renameBtn.className = "btn btn-sm";
        renameBtn.type = "button";
        renameBtn.textContent = "Rename";

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

        // Reads the value back after assigning it: the browser coerces `select.value`
        // to "" when no option matches, and the remembered value must track what the
        // DOM actually holds. Only refreshOptions calls this, once the options exist.
        const applySelection = (value) => {
            select.value = value;
            selectedConfigPresetValue = select.value;
        };

        // `preferredValue` is for callers that just changed the store and want the
        // selection to land on a name that did not exist before this rebuild.
        const refreshOptions = (preferredValue) => {
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

            // Keep the current pick instead of snapping back to the alphabetically first
            // preset, since renderFlags() rebuilds this panel on every Configure search
            // keystroke and on Expand/Collapse All.
            const desired = preferredValue || selectedConfigPresetValue;
            const stillExists = Array.from(select.options).some(opt => opt.value === desired);
            if (stillExists) {
                applySelection(desired);
            } else if (entries.length) {
                const first = entries[0];
                applySelection(`${first.source}|${first.name}`);
            }
        };

        select.addEventListener("change", () => {
            selectedConfigPresetValue = select.value;
        });

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
            refreshOptions(`custom|${name}`);
            refreshConsumers();
            nameInput.value = "";
        });

        renameBtn.addEventListener("click", async () => {
            const selected = getSelectedPresetEntry();
            if (!selected) return;
            if (selected.source !== "custom") {
                alert(getSamplerRenameMessage("builtin"));
                return;
            }

            const promptAction = dependencies.promptAction;
            // resolves to null on cancel, so an empty string still means "cleared the field"
            const nextName = typeof promptAction === "function"
                ? await promptAction(
                    "Rename Sampler Preset",
                    `Enter a new name for "${selected.name}".`,
                    selected.name,
                    "Rename"
                )
                : prompt(`Enter a new name for "${selected.name}".`, selected.name);
            if (nextName === null || nextName === undefined) return;

            const result = renameSamplerPreset(selected.name, nextName);
            if (!result.ok) {
                alert(getSamplerRenameMessage(result.reason));
                return;
            }

            refreshOptions(`custom|${result.name}`);
            refreshConsumers(`custom|${result.name}`);
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
                refreshOptions(lastImportedName ? `custom|${lastImportedName}` : "");
                refreshConsumers();
            } catch (e) {
                alert("Failed to import sampler preset: " + e.message);
            }
        });

        row.appendChild(select);
        row.appendChild(nameInput);
        row.appendChild(loadBtn);
        row.appendChild(saveBtn);
        row.appendChild(renameBtn);
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
        renameSamplerPreset,
        getSamplerRenameMessage,
        applySamplerPresetValues,
        createSamplerPresetControls,
    };
})();
