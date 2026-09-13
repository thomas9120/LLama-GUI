// Chat host access: shared settings writes, safe state reads, and session lifetime.
// Each adapter owns its subscriptions and validity; loading creates no adapter.
(function () {
    "use strict";

    const root = typeof window !== "undefined" ? window : globalThis;
    const I = root.LlamaGui._chatWindowInternal;
    const {
        CHAT_READONLY_SETTING_FIELDS, SECRET_KEY, RUNTIME_FIELDS, INFERENCE_FIELDS,
        getWindow, debug, warn, isObject, isJsonValue, cloneJson, pickJson,
    } = I.protocol;

    function deriveSettingFields(config) {
        const target = getWindow(config);
        let fields = config && Array.isArray(config.fields) ? config.fields : null;
        const getter = config && (config.getChatSamplerFlagIds || config.getRequestSettingFields);
        if (!fields && typeof getter === "function") {
            try { fields = getter(); } catch (error) { debug(config, "Unable to read Chat sampler fields", error); }
        }
        if (!fields && target && target.LlamaGui && target.LlamaGui.chatUi
            && typeof target.LlamaGui.chatUi.getChatSamplerFlagIds === "function") {
            try { fields = target.LlamaGui.chatUi.getChatSamplerFlagIds(); } catch (error) { debug(config, "Unable to read Chat sampler fields", error); }
        }
        const samplerFields = Array.isArray(fields) ? fields.filter(field => typeof field === "string") : [];
        return Object.freeze(Array.from(new Set(samplerFields.concat(CHAT_READONLY_SETTING_FIELDS))));
    }

    function createHostAdapter(options) {
        const config = Object.assign({}, options || {});
        const core = config.flagCore || (getWindow(config)?.LlamaGui && getWindow(config).LlamaGui.flagCore);
        const fields = deriveSettingFields(config);
        const writableFields = fields.filter(field => !CHAT_READONLY_SETTING_FIELDS.includes(field));
        const listeners = new Set();
        let valid = true;
        let hostUnsubscribe = null;

        function assertValid() {
            if (!valid) throw new Error("Chat host session is no longer available.");
        }

        function readSettings() {
            assertValid();
            let values = {};
            if (core && typeof core.getFlagValues === "function") values = core.getFlagValues() || {};
            const selectedModel = typeof config.getChatModelName === "function" ? config.getChatModelName()
                : typeof config.getSelectedModel === "function" ? config.getSelectedModel() : undefined;
            const output = {};
            for (const field of fields) {
                if (Object.prototype.hasOwnProperty.call(values, field)) {
                    const value = cloneJson(values[field], config, `setting ${field}`);
                    if (value !== null || values[field] === null) output[field] = value;
                }
            }
            if (selectedModel !== undefined) {
                const value = cloneJson(selectedModel, config, "selected model");
                if (value !== null || selectedModel === null) output.selected_model = value;
            }
            return output;
        }

        function readRuntime() {
            assertValid();
            const getter = config.getActiveRuntime || config.getRuntime || config.getStatus;
            if (typeof getter !== "function") return null;
            return pickJson(getter(), RUNTIME_FIELDS, config, "runtime state");
        }

        function writeSettings(patch) {
            assertValid();
            if (!isObject(patch)) throw new TypeError("Chat settings patch must be an object.");
            const allowed = {};
            for (const [field, value] of Object.entries(patch)) {
                if (!writableFields.includes(field) || SECRET_KEY.test(field)) {
                    throw new Error(`Chat setting is not writable: ${field}`);
                }
                if (!isJsonValue(value, new Set())) throw new TypeError(`Chat setting is not JSON-safe: ${field}`);
                allowed[field] = cloneJson(value, config, `setting ${field}`);
            }
            if (!Object.keys(allowed).length) return readSettings();
            if (core && typeof core.setMultipleFlagValues === "function") core.setMultipleFlagValues(allowed);
            else if (core && typeof core.setFlagValue === "function") {
                for (const [field, value] of Object.entries(allowed)) core.setFlagValue(field, value);
            } else {
                throw new Error("Chat host settings writer is unavailable.");
            }
            notify({ type: "settings", fields: Object.keys(allowed) });
            return readSettings();
        }

        function notify(change) {
            const safe = { type: isObject(change) && typeof change.type === "string" ? change.type : "host-change" };
            if (isObject(change)) {
                if (Array.isArray(change.fields)) safe.fields = change.fields.filter(field => fields.includes(field));
                if (typeof change.reason === "string") safe.reason = change.reason;
                if (change.runtime !== undefined) safe.runtime = pickJson(change.runtime, RUNTIME_FIELDS, config, "runtime change");
                if (change.status !== undefined) safe.status = pickJson(change.status, RUNTIME_FIELDS, config, "status change");
                if (change.inference !== undefined) safe.inference = pickJson(change.inference, INFERENCE_FIELDS, config, "inference change");
            }
            for (const listener of Array.from(listeners)) {
                try { listener(safe); } catch (error) { warn(config, "Chat host listener failed", error); }
            }
        }

        function subscribe(listener) {
            if (typeof listener !== "function") return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        }

        if (typeof config.observeHostChanges === "function") {
            try {
                hostUnsubscribe = config.observeHostChanges(notify);
            } catch (error) {
                warn(config, "Unable to observe host changes", error);
            }
        }

        const adapter = {
            getSettings: readSettings,
            readSettings,
            setSettings: writeSettings,
            writeSettings,
            getRuntime: readRuntime,
            getActiveRuntime: readRuntime,
            getStatus: typeof config.getStatus === "function" ? () => { assertValid(); return pickJson(config.getStatus(), RUNTIME_FIELDS, config, "status"); } : readRuntime,
            getInference: typeof config.getInference === "function" ? () => { assertValid(); return pickJson(config.getInference(), INFERENCE_FIELDS, config, "inference state"); } : () => null,
            resetInferenceBaseline: typeof config.resetInferenceBaseline === "function" ? (...args) => { assertValid(); return config.resetInferenceBaseline(...args); } : () => undefined,
            getAuthorizationHeaders: typeof config.getAuthorizationHeaders === "function" ? (...args) => { assertValid(); return config.getAuthorizationHeaders(...args); } : () => ({}),
            bringToFront: typeof config.bringToFront === "function" ? (...args) => { assertValid(); return config.bringToFront(...args); } : () => false,
            navigate: typeof config.navigate === "function" ? (...args) => { assertValid(); return config.navigate(...args); } : () => false,
            subscribe,
            notify,
            isSessionValid: () => valid,
            invalidateSession() {
                if (!valid) return false;
                valid = false;
                notify({ type: "session-invalidated" });
                return true;
            },
            dispose() {
                if (typeof hostUnsubscribe === "function") {
                    try { hostUnsubscribe(); } catch (error) { debug(config, "Host observer cleanup failed", error); }
                }
                hostUnsubscribe = null;
                listeners.clear();
                valid = false;
            },
            fields,
        };
        return Object.freeze(adapter);
    }

    I.hostAdapter = Object.freeze({ deriveSettingFields, createHostAdapter });
})();
