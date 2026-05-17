(function () {
    const root = window.LlamaGui = window.LlamaGui || {};
    let currentTool = "llama-server";
    let selectedModel = "";
    let flagValues = {};
    let getDefaultFlagValues = () => ({});
    let afterToolChange = null;
    let beforePathPatch = null;
    let afterPatch = null;
    let afterApply = null;
    let postUpdate = null;
    let getFlags = () => [];
    let normalizeMultiEnumValue = (value) => Array.isArray(value) ? value : [];
    let shouldOmitSpeculativeFlag = null;
    let isSupportedChatTemplateValue = null;
    let getToolBinaryName = (tool) => tool;
    let renderCommandPreview = null;

    function cloneFlagValue(value) {
        return Array.isArray(value) ? [...value] : value;
    }

    function isValidGpuLayersValue(val) {
        if (val === undefined || val === null || val === "") return false;
        const s = String(val).trim();
        if (s === "auto" || s === "all") return true;
        return /^\d+$/.test(s);
    }

    function setCurrentToolValue(tool) {
        currentTool = tool === "llama-cli" ? "llama-cli" : "llama-server";
        return currentTool;
    }

    function replaceFlagValues(values) {
        flagValues = { ...(values || {}) };
        return flagValues;
    }

    function patchFlagValues(patch) {
        for (const [flagId, value] of Object.entries(patch || {})) {
            if (value === undefined) {
                delete flagValues[flagId];
            } else {
                flagValues[flagId] = value;
            }
        }
        return flagValues;
    }

    function collectFlagValues() {
        const values = {};
        for (const [key, value] of Object.entries(flagValues)) {
            values[key] = cloneFlagValue(value);
        }
        return values;
    }

    function configure(options = {}) {
        if (typeof options.getDefaultFlagValues === "function") getDefaultFlagValues = options.getDefaultFlagValues;
        if (typeof options.afterToolChange === "function") afterToolChange = options.afterToolChange;
        if (typeof options.beforePathPatch === "function") beforePathPatch = options.beforePathPatch;
        if (typeof options.afterPatch === "function") afterPatch = options.afterPatch;
        if (typeof options.afterApply === "function") afterApply = options.afterApply;
        if (typeof options.postUpdate === "function") postUpdate = options.postUpdate;
        if (typeof options.getFlags === "function") getFlags = options.getFlags;
        if (typeof options.normalizeMultiEnumValue === "function") normalizeMultiEnumValue = options.normalizeMultiEnumValue;
        if (typeof options.shouldOmitSpeculativeFlag === "function") shouldOmitSpeculativeFlag = options.shouldOmitSpeculativeFlag;
        if (typeof options.isSupportedChatTemplateValue === "function") isSupportedChatTemplateValue = options.isSupportedChatTemplateValue;
        if (typeof options.getToolBinaryName === "function") getToolBinaryName = options.getToolBinaryName;
        if (typeof options.renderCommandPreview === "function") renderCommandPreview = options.renderCommandPreview;
        return flagCore;
    }

    function setCurrentTool(tool) {
        const nextTool = setCurrentToolValue(tool);
        if (typeof afterToolChange === "function") {
            afterToolChange(nextTool);
        }
        return nextTool;
    }

    function setSelectedModelValue(modelName) {
        selectedModel = String(modelName || "");
        return selectedModel;
    }

    function setMultipleFlagValues(patch, options = {}) {
        patchFlagValues(patch);
        if (typeof afterPatch === "function") {
            afterPatch(patch || {}, options || {});
        }
        if (typeof postUpdate === "function") {
            postUpdate();
        }
        return flagValues;
    }

    function setFlagValue(flagId, value, options = {}) {
        return setMultipleFlagValues({ [flagId]: value }, options);
    }

    function setPathFlagValue(flagId, value, options = {}) {
        const patch = { [flagId]: value };
        if (typeof beforePathPatch === "function") {
            beforePathPatch(flagId, value, patch, options || {});
        }
        return setMultipleFlagValues(patch, options);
    }

    function applyFlagValues(data) {
        replaceFlagValues({ ...getDefaultFlagValues(), ...(data || {}) });
        if (typeof afterApply === "function") {
            afterApply(flagValues);
        }
        if (typeof postUpdate === "function") {
            postUpdate();
        }
        return flagValues;
    }

    function shouldOmitFlagValue(f, value) {
        const inertDefaultValues = {
            n_predict: -1,
            keep: 0,
            threads: -1,
            top_n_sigma: -1,
            typical_p: 1.0,
            repeat_penalty: 1.0,
            presence_penalty: 0,
            frequency_penalty: 0,
            dry_multiplier: 0,
            dynatemp_range: 0,
            seed: -1,
            yarn_orig_ctx: 0,
            yarn_ext_factor: -1,
            yarn_attn_factor: -1,
            yarn_beta_slow: -1,
            yarn_beta_fast: -1,
            reasoning_budget: -1,
            cache_reuse: 0,
            ctx_checkpoints: 32,
            checkpoint_every_n_tokens: 8192,
        };

        if (!Object.prototype.hasOwnProperty.call(inertDefaultValues, f.id)) {
            return false;
        }

        const expected = inertDefaultValues[f.id];
        if (typeof expected === "number") {
            return Number(value) === expected;
        }
        return String(value) === String(expected);
    }

    function getLaunchArgs() {
        const args = [];
        const toolBase = currentTool.replace("llama-", "");

        for (const f of getFlags()) {
            if (f.tool !== "both" && f.tool !== toolBase) continue;
            if (typeof shouldOmitSpeculativeFlag === "function" && shouldOmitSpeculativeFlag(f, flagValues)) continue;
            const val = flagValues[f.id];
            if (val === undefined || val === null || val === "") continue;

            if (f.type === "bool") {
                if (val === true && !f.flag.startsWith("--no-")) {
                    if (f.id === "preserve_thinking") {
                        args.push([f.flag, '{"preserve_thinking":true}']);
                    } else {
                        args.push([f.flag]);
                    }
                } else if (val === false && f.false_flag) {
                    args.push([f.false_flag]);
                } else if (val === true && f.flag.startsWith("--no-")) {
                    args.push([f.flag]);
                }
            } else if (f.type === "multi_enum") {
                const values = normalizeMultiEnumValue(val);
                if (values.length > 0) {
                    args.push([f.flag, values.join(",")]);
                }
            } else {
                if (f.id === "chat_template"
                    && typeof isSupportedChatTemplateValue === "function"
                    && !isSupportedChatTemplateValue(val)) {
                    continue;
                }
                if (f.id === "gpu_layers" && !isValidGpuLayersValue(val)) continue;
                if (shouldOmitFlagValue(f, val)) continue;
                args.push([f.flag, String(val)]);
            }
        }

        const modelName = selectedModel;
        if (modelName) {
            if (modelName.includes("..") || modelName.includes("/") || modelName.includes("\\")) {
                return { args, error: "Invalid model filename." };
            }
            args.push(["-m", "models/" + modelName]);
        }

        return { args, error: null };
    }

    function updateCommandPreview() {
        const result = getLaunchArgs();
        const parts = [getToolBinaryName(currentTool)];
        for (const entry of result.args) {
            if (Array.isArray(entry)) {
                parts.push(...entry);
            } else {
                parts.push(String(entry));
            }
        }
        const command = parts.join(" ");
        if (typeof renderCommandPreview === "function") {
            renderCommandPreview(command, result);
        }
        return { ...result, command };
    }

    function registerApi(api) {
        Object.assign(flagCore, api || {});
        return flagCore;
    }

    const flagCore = root.flagCore = {
        getCurrentTool: () => currentTool,
        setCurrentToolValue,
        setCurrentTool,
        getSelectedModel: () => selectedModel,
        setSelectedModelValue,
        getFlagValues: () => flagValues,
        replaceFlagValues,
        patchFlagValues,
        collectFlagValues,
        configure,
        setMultipleFlagValues,
        setFlagValue,
        setPathFlagValue,
        applyFlagValues,
        shouldOmitFlagValue,
        isValidGpuLayersValue,
        getLaunchArgs,
        updateCommandPreview,
        registerApi,
    };
})();
