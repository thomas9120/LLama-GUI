// Chat-template selection: preset lookup and reverse mapping from shared flag state,
// atomic selection application, Quick Launch summary text, and the manual custom-path
// clearing rule. Template data lives in ui/js/flags/chat-templates.js; every state
// write goes through the configured flagCore setters. Exposed as
// window.LlamaGui.chatTemplateSelection.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    let dependencies = {};

    // Storing dependencies is the only configure() effect: no flag writes and no DOM
    // initialization, including when the detached Chat page evaluates this module.
    function configure(options) {
        dependencies = Object.assign({}, dependencies, options || {});
    }

    function getFlagCore() {
        return dependencies.flagCore || window.LlamaGui.flagCore;
    }

    // Delegates to the compatibility allowlist declared in ui/js/flags/chat-templates.js
    // (top-level bare binding, like every other cross-script reference here). Legacy saved
    // presets may reference built-in template names that the curated dropdown does not
    // offer; the allowlist still accepts them.
    function isSupportedTemplateValue(value) {
        return typeof isSupportedChatTemplateValue === "function"
            ? isSupportedChatTemplateValue(value)
            : true;
    }

    // For comparison only: trimming and backslash conversion, never rewriting the
    // stored path. No case folding, basename matching, or filesystem access.
    function normalizeTemplatePathValue(value) {
        return String(value || "").trim().replace(/\\/g, "/");
    }

    function getChatTemplatePresetByValue(value) {
        return CHAT_TEMPLATE_PRESETS.find((preset) => preset.value === String(value || "")) || null;
    }

    function getChatTemplatePresetByBuiltinName(value) {
        const normalized = String(value || "");
        return CHAT_TEMPLATE_PRESETS.find((preset) => preset.mode === "builtin" && preset.builtin === normalized) || null;
    }

    function getChatTemplatePresetByPath(path) {
        const normalizedPath = normalizeTemplatePathValue(path);
        if (!normalizedPath) return null;
        return CHAT_TEMPLATE_PRESETS.find((preset) =>
            preset.mode === "bundled"
            && normalizeTemplatePathValue(preset.path) === normalizedPath
        ) || null;
    }

    // Read-only reverse mapping from current flag values to a dropdown value.
    // Reads getFlagValues() on every call because preset application can replace
    // the state object. Precedence: matching bundled path, direct named preset,
    // builtin-name mapping, then any supported raw value.
    function getSelectedChatTemplateDropdownValue() {
        const values = getFlagCore().getFlagValues();

        const bundledPreset = getChatTemplatePresetByPath(values.chat_template_custom);
        if (bundledPreset) {
            return bundledPreset.value;
        }

        const directPreset = getChatTemplatePresetByValue(values.chat_template);
        if (directPreset && directPreset.mode !== "auto") {
            return directPreset.value;
        }

        const builtinPreset = getChatTemplatePresetByBuiltinName(values.chat_template);
        if (builtinPreset) {
            return builtinPreset.value;
        }

        return isSupportedTemplateValue(values.chat_template) ? String(values.chat_template ?? "") : "";
    }

    function getQuickTemplateSummaryText() {
        const selectedTemplateValue = getSelectedChatTemplateDropdownValue();
        const preset = getChatTemplatePresetByValue(selectedTemplateValue);
        if (preset) {
            if (preset.mode === "bundled") {
                return `Using bundled template preset: ${preset.label}.`;
            }
            if (preset.mode === "builtin") {
                return `Using preset: ${preset.label}.`;
            }
        }
        if (selectedTemplateValue) {
            return `Using llama.cpp built-in template: ${selectedTemplateValue}`;
        }
        const values = getFlagCore().getFlagValues();
        if (values.chat_template_custom) {
            return `Using custom template file: ${values.chat_template_custom}`;
        }
        return "Use the template embedded in the model metadata when available.";
    }

    // One atomic patch per selection: set one template field and clear the other
    // with undefined, which deletes the stored override. Auto clears both.
    function setChatTemplateValue(value, options = {}) {
        const normalizedValue = String(value || "");
        const preset = getChatTemplatePresetByValue(normalizedValue);

        if (preset && preset.mode === "bundled") {
            getFlagCore().setMultipleFlagValues({
                chat_template: undefined,
                chat_template_custom: preset.path,
            });
            return;
        }

        if (preset && preset.mode === "auto") {
            getFlagCore().setMultipleFlagValues({
                chat_template: undefined,
                chat_template_custom: undefined,
            });
            return;
        }

        if (preset && preset.mode === "builtin") {
            getFlagCore().setMultipleFlagValues({
                chat_template: preset.builtin,
                chat_template_custom: undefined,
            });
            return;
        }

        // Raw-value fallback for supported legacy names and unsupported stored
        // values. Only this branch honors options.preserveCustomTemplateFile;
        // named builtin, bundled, and Auto selections above still clear the
        // competing value.
        const patch = {
            chat_template: normalizedValue || undefined,
        };
        if (!options.preserveCustomTemplateFile) {
            patch.chat_template_custom = undefined;
        }
        getFlagCore().setMultipleFlagValues(patch);
    }

    // Manual-path rule for flagCore's beforePathPatch hook: editing the Custom
    // Template File path — typed or picked, including clearing it — clears
    // chat_template inside the same patch, so no second write or broadcast is
    // needed. Other path flags are untouched; app.js keeps its mmproj rule.
    function beforePathPatch(flagId, value, patch) {
        if (flagId !== "chat_template_custom") return;
        patch.chat_template = undefined;
    }

    window.LlamaGui.chatTemplateSelection = {
        configure,
        isSupportedChatTemplateValue: isSupportedTemplateValue,
        getChatTemplatePresetByValue,
        getChatTemplatePresetByBuiltinName,
        getChatTemplatePresetByPath,
        getSelectedChatTemplateDropdownValue,
        getQuickTemplateSummaryText,
        setChatTemplateValue,
        beforePathPatch,
    };
})();
