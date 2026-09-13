// Presets package (9/10): save/update/duplicate/rename/load/delete/archive/favorite/export/import operations.
async function savePreset() {
    const nameInput = document.getElementById("preset-name-input");
    const name = nameInput.value.trim();
    if (!name) {
        nameInput.focus();
        showPresetActionStatus("Enter a name for the new preset", "error", 3200);
        return;
    }
    if (await savePresetAsNew(name)) nameInput.value = "";
}

function setPresetSavePending(pending) {
    presetSavePending = pending;
    const save = document.getElementById("btn-save-preset");
    if (save) save.disabled = pending;
    refreshPresetContext();
}

function restorePresetActionFocus(trigger) {
    if (trigger?.isConnected && !trigger.disabled) {
        trigger.focus();
        return;
    }
    const context = Array.from(document.querySelectorAll("[data-preset-context]"))
        .find(panel => panel.offsetParent !== null);
    context?.querySelector("[data-preset-name]")?.focus();
}

async function savePresetAsNew(name) {
    if (presetSavePending) return false;
    const trigger = document.activeElement;
    setPresetSavePending(true);
    try {
        const data = buildCurrentPresetData();
        if (name === undefined) {
            name = await presetDependencies.promptAction("Save as new preset", "Save the settings being edited under a new name. Existing presets will be kept.", "", "Save new preset");
        }
        if (name === null) return false;
        name = name.trim();
        if (!name) throw new Error("Preset name cannot be empty");
        const result = await presetDependencies.fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data, overwrite: false }),
        });
        if (!result.saved) throw new Error("The preset could not be saved");
        const savedName = result.name || name;
        setLoadedPreset(savedName, data);
        selectedPresetName = savedName;
        await loadPresets();
        showPresetActionStatus(`Saved new preset "${savedName}"`, "success");
        return true;
    } catch (e) {
        showPresetActionStatus(e.message || "Failed to save preset", "error", 5000);
        console.warn("Failed to save preset", e);
        return false;
    } finally {
        setPresetSavePending(false);
        restorePresetActionFocus(trigger);
    }
}

function reviewPresetUpdate(name, changes) {
    const dialog = document.getElementById("preset-update-dialog");
    document.getElementById("preset-update-title").textContent = `Update "${name}"?`;
    renderPresetChangeRows(dialog.querySelector("tbody"), changes);
    dialog.returnValue = "cancel";
    return new Promise(resolve => {
        dialog.addEventListener("close", () => resolve(dialog.returnValue === "update"), { once: true });
        dialog.showModal();
    });
}

async function updatePreset(name) {
    if (presetSavePending) return;
    const trigger = document.activeElement;
    setPresetSavePending(true);
    try {
        // Capture before opening the review; save only what the user reviewed.
        const data = buildCurrentPresetData();
        const entries = await fetchPresetEntries();
        reconcileLoadedPreset(entries);
        const preset = findPresetByName(entries, name);
        if (!preset) throw new Error(`Preset "${name}" no longer exists. Save your edits as a new preset.`);
        const { changes } = comparePresetToCurrent(preset.data, data);
        if (!changes.length) {
            showPresetActionStatus(`Current settings already match "${name}"`, "success");
            return;
        }
        if (!await reviewPresetUpdate(name, changes)) return;
        const latestEntries = await fetchPresetEntries();
        const latest = findPresetByName(latestEntries, name);
        if (!latest || JSON.stringify(latest.data) !== JSON.stringify(preset.data)) {
            reconcileLoadedPreset(latestEntries);
            throw new Error("The saved preset changed while this review was open. Review it again before updating.");
        }
        const result = await presetDependencies.fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
        });
        if (!result.saved) throw new Error("The preset could not be updated");
        setLoadedPreset(result.name || name, data, latestEntries.some(entry => entry.name === name && entry.archived));
        await loadPresets();
        showPresetActionStatus(`Updated preset "${name}"`, "success");
    } catch (e) {
        showPresetActionStatus(e.message || "Failed to update preset", "error", 5000);
        console.warn("Failed to update preset", e);
    } finally {
        setPresetSavePending(false);
        restorePresetActionFocus(trigger);
    }
}

async function duplicatePreset(name) {
    try {
        const presets = await fetchPresetEntries();
        const source = presets.find((preset) => preset.name === name);
        if (!source) {
            showPresetStatus(`Preset "${name}" not found.`, "error", 3200);
            return;
        }
        // duplicates the saved preset, not the live Configure state, so the current
        // launch settings are left untouched
        const duplicateName = buildDuplicatePresetName(name, new Set(presets.map((preset) => preset.name)));
        // overwrite:false so a duplicate can never destroy an existing preset. The
        // name check above should already have avoided the collision; this catches
        // the case-insensitive-filesystem edge it cannot see from the browser and
        // turns it into a 409 the user is told about instead of silent data loss.
        const result = await presetDependencies.fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: duplicateName,
                data: normalizePresetData(source.data),
                overwrite: false,
            }),
        });
        if (result.saved) {
            selectedPresetName = result.name || duplicateName;
            await loadPresets();
            showPresetStatus(`Duplicated to "${result.name || duplicateName}"`, "success");
        }
    } catch (e) {
        const message = e && e.message === SENSITIVE_CUSTOM_ARG_MESSAGE
            ? SENSITIVE_CUSTOM_ARG_MESSAGE
            : "Failed to duplicate preset";
        showPresetStatus(message, "error", 5000);
        console.warn("Failed to duplicate preset", e);
    }
}

async function renamePreset(name) {
    const nextName = await presetDependencies.promptAction(
        "Rename Preset",
        `Enter a new name for "${name}".`,
        name,
        "Rename"
    );
    if (nextName === null) return;
    if (!nextName) {
        showPresetActionStatus("Preset name cannot be empty", "error", 3200);
        return;
    }
    if (nextName === name) return;

    try {
        const result = await presetDependencies.fetchJson("/api/presets/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, new_name: nextName }),
        });
        if (result.renamed) {
            const savedName = result.name || nextName;
            // must run before loadPresets, which prunes local state for unknown names
            renamePresetLocalState(name, savedName);
            if (selectedPresetName === name) selectedPresetName = savedName;
            if (selectedPresetNames.has(name)) {
                selectedPresetNames.delete(name);
                selectedPresetNames.add(savedName);
            }
            await loadPresets();
            showPresetActionStatus(`Renamed to "${savedName}"`, "success");
        }
    } catch (e) {
        const message = e && e.message ? e.message : "Failed to rename preset";
        showPresetActionStatus(message, "error", 5000);
        console.warn("Failed to rename preset", e);
    }
}

async function loadPreset(name) {
    try {
        const presets = await fetchPresetEntries();
        const preset = findPresetByName(presets, name);
        if (preset) {
            const presetData = preset.data;
            const warnings = getPresetWarnings(presetData);
            applyPresetData(presetData);
            setLoadedPreset(name, presetData, presets.some(item => item.name === name && item.archived));
            markPresetUsed(name);
            if (warnings.length > 0) {
                showPresetStatus(`Loaded "${name}" with warning: ${warnings[0]}`, "warning", 5000);
            } else {
                showPresetStatus(`Loaded preset "${name}"`, "success");
            }
            return { ok: true, name, data: presetData, warnings };
        } else {
            showPresetStatus(`Preset "${name}" not found.`, "error", 3200);
            return { ok: false, error: `Preset "${name}" no longer exists.` };
        }
    } catch (e) {
        showPresetStatus("Failed to load preset", "error", 3200);
        console.warn("Failed to load preset", e);
        return { ok: false, error: "Could not load this preset. Try again from the preset library." };
    }
}

async function deletePreset(name) {
    const ok = await presetDependencies.confirmAction(
        "Delete Preset",
        `Delete preset "${name}"? This cannot be undone.`,
        "Delete"
    );
    if (!ok) return;
    try {
        await presetDependencies.fetchJson("/api/presets/" + encodeURIComponent(name), { method: "DELETE" });
        deletePresetLocalState(name);
        loadPresets();
        showPresetActionStatus(`Deleted preset \"${name}\"`, "success");
    } catch (e) {
        showPresetActionStatus("Failed to delete preset", "error", 3200);
        console.warn("Failed to delete preset", e);
    }
}

async function setPresetArchived(names, archived) {
    const list = Array.isArray(names) ? names : [names];
    if (list.length === 0) return;
    try {
        await presetDependencies.fetchJson("/api/presets/archive", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ names: list, archived }),
        });
        for (const name of list) {
            selectedPresetNames.delete(name);
        }
        if (list.includes(selectedPresetName)) {
            selectedPresetName = "";
        }
        await loadPresets();
        showPresetActionStatus(
            `${archived ? "Archived" : "Restored"} ${list.length} preset${list.length === 1 ? "" : "s"}`,
            "success"
        );
    } catch (e) {
        showPresetActionStatus(
            archived ? "Failed to archive presets" : "Failed to restore presets",
            "error",
            3200
        );
        console.warn("Failed to update preset archive state", e);
    }
}

function archiveSelectedPresets(archived) {
    const names = Array.from(selectedPresetNames);
    if (names.length === 0) {
        showPresetActionStatus("No presets selected", "error", 3200);
        return;
    }
    setPresetArchived(names, archived);
}

async function favoriteSelectedPresets(favorite) {
    const names = Array.from(selectedPresetNames);
    if (names.length === 0) {
        showPresetStatus("No presets selected", "error", 3200);
        return;
    }
    const changed = setPresetsFavorite(names, favorite);
    if (!changed) {
        showPresetStatus(
            favorite
                ? `Already favorited (${names.length} selected)`
                : `No favorites in the selection (${names.length} selected)`,
            "success"
        );
        return;
    }
    await loadPresets();
    showPresetStatus(
        `${favorite ? "Favorited" : "Unfavorited"} ${changed} preset${changed === 1 ? "" : "s"}`,
        "success"
    );
}

async function deleteSelectedPresets() {
    const names = Array.from(selectedPresetNames);
    if (names.length === 0) {
        showPresetActionStatus("No presets selected", "error", 3200);
        return;
    }

    const ok = await presetDependencies.confirmAction(
        "Delete Selected Presets",
        `Delete ${names.length} selected preset${names.length === 1 ? "" : "s"}? This cannot be undone.`,
        "Delete"
    );
    if (!ok) return;

    try {
        for (const name of names) {
            await presetDependencies.fetchJson("/api/presets/" + encodeURIComponent(name), { method: "DELETE" });
            deletePresetLocalState(name);
        }
        selectedPresetNames.clear();
        if (names.includes(selectedPresetName)) {
            selectedPresetName = "";
        }
        await loadPresets();
        showPresetActionStatus(`Deleted ${names.length} preset${names.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
        showPresetActionStatus("Failed to delete selected presets", "error", 3200);
        console.warn("Failed to delete selected presets", e);
        loadPresets();
    }
}

function exportPreset(name) {
    presetDependencies.fetchJson("/api/presets")
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

function exportSelectedPresets() {
    const names = new Set(selectedPresetNames);
    if (names.size === 0) {
        showPresetStatus("No presets selected", "error", 3200);
        return;
    }
    presetDependencies.fetchJson("/api/presets")
        .then((presets) => {
            const selected = (presets || []).filter((p) => names.has(p.name));
            if (selected.length === 0) {
                showPresetStatus("Selected presets not found", "error", 3200);
                return;
            }
            const exportData = { presets: selected.map(p => ({
                name: p.name,
                data: normalizePresetData(p.data)
            })) };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "llama-gui-presets-selected.json";
            a.click();
            URL.revokeObjectURL(url);
            showPresetStatus(`Exported ${selected.length} preset(s)`, "success");
        })
        .catch((e) => {
            showPresetStatus("Failed to export selected presets", "error", 3200);
            console.warn("Failed to export selected presets", e);
        });
}

function exportAllPresets() {
    presetDependencies.fetchJson("/api/presets")
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
            const pendingImports = [];
            let unnamedIdx = 0;
            for (const entry of bulkPresets) {
                const name = sanitizeImportedPresetName(entry.name || "Imported-" + (++unnamedIdx));
                if (!name) {
                    showPresetActionStatus("Preset import contains an invalid name.", "error", 3200);
                    return;
                }
                const normalized = normalizeImportedPresetData(entry.data || {});
                if (!hasUsablePresetData(normalized)) continue;
                pendingImports.push({ name, data: normalized });
            }
            const existingPresets = await fetchPresetEntries();
            const collision = findPresetImportNameCollision(existingPresets, pendingImports);
            if (collision) {
                showPresetActionStatus(`Preset "${collision}" already exists. Rename or delete it before importing.`, "error", 5000);
                return;
            }
            try {
                let importedCount = 0;
                for (const preset of pendingImports) {
                    await presetDependencies.fetchJson("/api/presets", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: preset.name, data: preset.data, overwrite: false }),
                    });
                    importedCount++;
                }
                loadPresets();
                showPresetActionStatus(`Imported ${importedCount} preset(s)`, "success");
            } catch (e) {
                console.warn("Preset import failed mid-loop", e);
                loadPresets();
                showPresetActionStatus("Failed to import some presets.", "error", 3200);
            }
            return;
        }

        const normalized = normalizeImportedPresetData(parsed);
        if (!hasUsablePresetData(normalized)) {
            showPresetActionStatus("Preset file contains no usable data.", "error", 3200);
            return;
        }
        const name = sanitizeImportedPresetName(file.name.replace(/\.json$/i, ""));
        if (!name) {
            showPresetActionStatus("Preset import contains an invalid name.", "error", 3200);
            return;
        }
        const existingPresets = await fetchPresetEntries();
        const collision = findPresetImportNameCollision(existingPresets, [{ name }]);
        if (collision) {
            showPresetActionStatus(`Preset "${collision}" already exists. Rename or delete it before importing.`, "error", 5000);
            return;
        }
        await presetDependencies.fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data: normalized, overwrite: false }),
        });
        loadPresets();
        showPresetActionStatus(`Imported preset \"${name}\"`, "success");
    } catch (err) {
        const message = err && err.message === SENSITIVE_CUSTOM_ARG_MESSAGE
            ? SENSITIVE_CUSTOM_ARG_MESSAGE
            : "Failed to import preset";
        showPresetActionStatus(message, "error", 5000);
        console.warn("Failed to import preset", err);
    }
}
