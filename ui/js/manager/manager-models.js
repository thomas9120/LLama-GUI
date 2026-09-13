// Model refresh races and the known-model-name cache.
(() => {
    const I = window.LlamaGui._managerInternal;

    let refreshModelsRequestId = 0;
    let refreshModelsInFlight = null;
    // Lowercased .gguf names. null means unknown (never fetched or failed),
    // which is distinct from a known-empty folder for Presets missing-model warnings.
    let knownModelNames = null;

    function getKnownModelNames() {
        return knownModelNames;
    }

    // Notify consumers after changing the cache, on success and failure alike.
    function notifyModelPresenceChanged() {
        if (typeof I.dependencies.onModelPresenceChanged === "function") {
            I.dependencies.onModelPresenceChanged();
        }
    }

    function refreshModels() {
        const requestId = ++refreshModelsRequestId;
        const request = refreshModelsForRequest(requestId);
        refreshModelsInFlight = request;
        return request;
    }

    async function refreshModelsForRequest(requestId) {
        const sel = document.getElementById("model-select");
        if (!sel) return false;
        try {
            const models = await I.dependencies.fetchJson("/api/models");
            if (requestId !== refreshModelsRequestId) return refreshModelsInFlight || false;
            // Keep the current options in place while requests overlap. Clearing
            // them before the await made a second refresh snapshot an empty value,
            // so the winning response silently dropped the selected model.
            const selectedValue = sel.value;
            sel.innerHTML = '<option value="">-- Select Model --</option>';
            const names = new Set();
            const optionValues = new Set();
            let added = 0;
            for (const m of models) {
                if (!m.name || !String(m.name).toLowerCase().endsWith(".gguf")) continue;
                names.add(String(m.name).toLowerCase());
                optionValues.add(String(m.name));
                const opt = document.createElement("option");
                opt.value = m.name;
                opt.textContent = `${m.name}  (${m.size_mb} MB)`;
                sel.appendChild(opt);
                added++;
            }
            knownModelNames = names;
            if (added === 0) {
                const opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "No .gguf models found in the active models folder \u2014 download one from Quick Launch";
                sel.appendChild(opt);
            }
            sel.value = selectedValue && optionValues.has(selectedValue) ? selectedValue : "";
            if (window.LlamaGui && window.LlamaGui.flagCore) {
                window.LlamaGui.flagCore.setSelectedModelValue(sel.value || "");
            }
            if (typeof I.dependencies.syncQuickLaunchModelOptions === "function") {
                I.dependencies.syncQuickLaunchModelOptions();
            }
            notifyModelPresenceChanged();
            if (window.LlamaGui && window.LlamaGui.flagCore
                && typeof window.LlamaGui.flagCore.updateCommandPreview === "function") {
                window.LlamaGui.flagCore.updateCommandPreview();
            }
            return true;
        } catch (e) {
            if (requestId !== refreshModelsRequestId) return refreshModelsInFlight || false;
            // Drop the cache rather than keeping a stale one: callers must not read
            // a failed refresh as proof that a model is missing.
            knownModelNames = null;
            sel.innerHTML = '<option value="">-- Select Model --</option>';
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "Failed to load models";
            sel.appendChild(opt);
            if (window.LlamaGui && window.LlamaGui.flagCore) {
                window.LlamaGui.flagCore.setSelectedModelValue("");
            }
            if (typeof I.dependencies.syncQuickLaunchModelOptions === "function") {
                I.dependencies.syncQuickLaunchModelOptions();
            }
            if (typeof I.dependencies.showToast === "function") {
                I.dependencies.showToast("Could not load models: " + e.message, "error");
            } else {
                console.debug("Failed to refresh model list", e);
            }
            // The failure path matters as much as the success path: clearing the
            // cache changes missing-model warnings from "none found" to "not
            // checked", and the Presets tab has to be told.
            notifyModelPresenceChanged();
            return false;
        }
    }

    I.models = {
        getKnownModelNames,
        refreshModels,
    };
})();
