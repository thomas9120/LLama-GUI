// Detached Chat settings bridge; writes stay authoritative in the host flag core.
(function () {
    "use strict";
    const root = typeof window !== "undefined" ? window : globalThis;
    const I = root.LlamaGui._chatWindowInternal;
    const { safeRead } = I.bootstrap;

    function createFlagCoreBridge(host, options = {}) {
        const listeners = new Set();
        let values = {};
        let selectedModel = "";
        const logger = options.window && options.window.console;

        function refresh(nextSettings) {
            const settings = nextSettings && typeof nextSettings === "object" ? nextSettings
                : safeRead(host && host.getSettings, {}, logger);
            values = Object.assign({}, settings || {});
            selectedModel = values.selected_model === null || values.selected_model === undefined
                ? "" : String(values.selected_model);
            for (const listener of Array.from(listeners)) {
                try { listener(values); } catch (error) {
                    if (logger && typeof logger.warn === "function") logger.warn("Detached Chat settings listener failed", error);
                }
            }
            return values;
        }

        function currentValues() {
            const live = safeRead(host && host.getSettings, null, logger);
            if (live && typeof live === "object" && !Array.isArray(live)) refresh(live);
            return Object.assign({}, values);
        }

        function write(patch) {
            if (!host || typeof host.setSettings !== "function") throw new Error("Chat host settings writer is unavailable.");
            try {
                if (typeof host.isSessionValid === "function" && host.isSessionValid() !== true) {
                    throw new Error("Chat host is not connected.");
                }
            } catch (error) {
                options.onUnavailable?.(error);
                return currentValues();
            }
            let resultValue;
            try { resultValue = host.setSettings(patch); } catch (error) {
                logger?.warn?.("Chat host settings write failed", error);
                options.onUnavailable?.(error);
                return currentValues();
            }
            refresh(resultValue);
            return values;
        }

        refresh();
        return Object.freeze({
            getFlagValues: currentValues,
            getSelectedModel: () => {
                currentValues();
                return selectedModel;
            },
            getCurrentTool: () => "llama-server",
            setFlagValue: (field, value) => write({ [field]: value }),
            setMultipleFlagValues: patch => write(patch),
            subscribe(listener) {
                if (typeof listener !== "function") return () => {};
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            refresh,
        });
    }

    I.flagCoreBridge = Object.freeze({ createFlagCoreBridge });
})();
