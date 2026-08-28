(function () {
    window.LlamaGui = window.LlamaGui || {};

    let dependencies = {};
    // Survives the panel rebuilds that renderFlags() triggers, so the Configure sampler
    // dropdown does not lose the user's pick on an unrelated re-render.
    let selectedConfigPresetValue = "";

    function configure(options) {
        dependencies = Object.assign({}, dependencies, options || {});
    }

    function showSamplerPresetToast(message, type = "success", options = {}) {
        if (typeof dependencies.showToast === "function") {
            dependencies.showToast(message, type, options);
        }
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

    function getSamplerPresetImportEntries(parsed) {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

        if (parsed.name && Object.prototype.hasOwnProperty.call(parsed, "values")) {
            if (!parsed.values || typeof parsed.values !== "object" || Array.isArray(parsed.values)) return null;
            return [{ name: String(parsed.name), values: parsed.values }];
        }

        const presets = parsed.presets;
        if (!presets || typeof presets !== "object" || Array.isArray(presets)) return null;
        const incoming = Object.entries(presets).map(([name, values]) => ({ name, values }));
        if (incoming.length === 0) return null;
        if (incoming.some((item) => !item.values || typeof item.values !== "object" || Array.isArray(item.values))) {
            return null;
        }
        return incoming;
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
        builtin: "内置采样器预设不能重命名。",
        missing: "That sampler preset no longer exists.",
        taken: "同名采样器预设已存在。",
    };

    function getSamplerRenameMessage(reason) {
        return SAMPLER_RENAME_MESSAGES[reason] || "Failed to rename sampler preset.";
    }

    function isSamplerPresetNameTaken(name, store, excludeCustomName = "") {
        const folded = String(name == null ? "" : name).trim().toLowerCase();
        if (!folded) return false;
        const customStore = store && typeof store === "object" && !Array.isArray(store) ? store : {};
        const builtinTaken = Object.keys(BUILTIN_SAMPLER_PRESETS)
            .some(existingName => existingName.toLowerCase() === folded);
        const customTaken = Object.keys(customStore)
            .some(existingName => existingName !== excludeCustomName && existingName.toLowerCase() === folded);
        return builtinTaken || customTaken;
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
        if (isSamplerPresetNameTaken(to, store, from)) return { ok: false, reason: "taken" };

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

    /**
     * Create or update a custom sampler preset.
     *
     * Saving over the preset that is currently selected is an *update*, not a
     * collision. Both Save buttons fall back to the selected preset's own name
     * when the name field is blank, so without excluding that name the taken
     * check always fired against the preset being saved and Save could never
     * update an existing custom preset at all.
     *
     * @returns {{ok: true, name: string}|{ok: false, reason: "empty"|"taken"}}
     */
    function saveSamplerPreset(name, selectedCustomName, values) {
        const target = String(name == null ? "" : name).trim();
        if (!target) return { ok: false, reason: "empty" };

        const selected = String(selectedCustomName == null ? "" : selectedCustomName);
        // Exact match, not case-insensitive: a case-differing name must still
        // collide. Save is not a rename affordance — renameSamplerPreset() owns
        // the re-casing carve-out — so accepting "fast" while "Fast" is selected
        // would silently re-key a preset as a side effect of saving.
        const isUpdatingSelected = Boolean(selected) && target === selected;

        const store = loadSamplerPresetStore();
        if (isSamplerPresetNameTaken(target, store, isUpdatingSelected ? selected : "")) {
            return { ok: false, reason: "taken" };
        }

        store[target] = normalizeSamplerPresetValues(values);
        saveSamplerPresetStore(store);
        return { ok: true, name: target };
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
        title.textContent = "采样器预设";

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
        saveBtn.textContent = "保存";

        const renameBtn = document.createElement("button");
        renameBtn.className = "btn btn-sm";
        renameBtn.type = "button";
        renameBtn.textContent = "重命名";

        const delBtn = document.createElement("button");
        delBtn.className = "btn btn-sm btn-danger";
        delBtn.type = "button";
        delBtn.textContent = "删除";

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
            placeholder.textContent = entries.length ? "— 请选择采样器预设 —" : "暂无采样器预设";
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
            const selectedCustomName = selected && selected.source === "custom" ? selected.name : "";
            const name = typedName || selectedCustomName;
            if (!name) {
                nameInput.focus();
                showSamplerPresetToast("请输入采样器预设名称。", "error");
                return;
            }
            const result = saveSamplerPreset(name, selectedCustomName, collectSamplerValues());
            if (!result.ok) {
                showSamplerPresetToast(getSamplerRenameMessage(result.reason) + " Rename or delete the existing preset first.", "error");
                return;
            }
            refreshOptions(`custom|${result.name}`);
            refreshConsumers();
            nameInput.value = "";
            showSamplerPresetToast(`已保存采样器预设 "${result.name}"`, "success");
        });

        renameBtn.addEventListener("click", async () => {
            const selected = getSelectedPresetEntry();
            if (!selected) return;
            if (selected.source !== "custom") {
                showSamplerPresetToast(getSamplerRenameMessage("builtin"), "error");
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
                showSamplerPresetToast(getSamplerRenameMessage(result.reason), "error");
                return;
            }

            refreshOptions(`custom|${result.name}`);
            refreshConsumers(`custom|${result.name}`);
            showSamplerPresetToast(`已重命名采样器预设为 "${result.name}"`, "success");
        });

        delBtn.addEventListener("click", async () => {
            const selected = getSelectedPresetEntry();
            if (!selected) return;
            if (selected.source !== "custom") {
                showSamplerPresetToast("Built-in sampler presets cannot be deleted.", "error");
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
            showSamplerPresetToast(`Deleted sampler preset "${selected.name}"`, "success");
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

                const incoming = getSamplerPresetImportEntries(parsed);
                if (!incoming) {
                    showSamplerPresetToast("Invalid sampler preset JSON format. Every preset must contain an object of sampler values.", "error");
                    return;
                }

                const store = loadSamplerPresetStore();
                const pendingStore = { ...store };
                let lastImportedName = "";
                for (const item of incoming) {
                    const baseName = String(item.name || "Imported Sampler").trim() || "Imported Sampler";
                    if (isSamplerPresetNameTaken(baseName, pendingStore)) {
                        showSamplerPresetToast(`名为 "${baseName}" 的采样器预设已存在。请先重命名或删除再导入。`, "error");
                        return;
                    }
                    pendingStore[baseName] = normalizeSamplerPresetValues(item.values);
                    lastImportedName = baseName;
                }

                saveSamplerPresetStore(pendingStore);
                refreshOptions(lastImportedName ? `custom|${lastImportedName}` : "");
                refreshConsumers();
                showSamplerPresetToast(`Imported ${incoming.length} sampler preset${incoming.length === 1 ? "" : "s"}`, "success");
            } catch (e) {
                showSamplerPresetToast("Failed to import sampler preset: " + e.message, "error");
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
        getSamplerPresetImportEntries,
        getAllSamplerPresets,
        isSamplerPresetNameTaken,
        saveSamplerPreset,
        renameSamplerPreset,
        getSamplerRenameMessage,
        applySamplerPresetValues,
        createSamplerPresetControls,
    };
})();
