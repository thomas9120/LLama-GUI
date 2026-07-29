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

    function normalizeGpuLayersValue(val) {
        if (!isValidGpuLayersValue(val)) return undefined;
        return String(val).trim();
    }

    function setCurrentToolValue(tool) {
        currentTool = tool === "llama-cli" ? "llama-cli" : "llama-server";
        return currentTool;
    }

    function replaceFlagValues(values) {
        flagValues = {};
        for (const [key, value] of Object.entries(values || {})) {
            flagValues[key] = cloneFlagValue(value);
        }
        return flagValues;
    }

    function buildEffectiveFlagValues(values) {
        const effective = { ...getDefaultFlagValues(), ...(values || {}) };
        const cloned = {};
        for (const [key, value] of Object.entries(effective)) {
            cloned[key] = cloneFlagValue(value);
        }
        return cloned;
    }

    function patchFlagValues(patch) {
        for (const [flagId, value] of Object.entries(patch || {})) {
            if (value === undefined) {
                delete flagValues[flagId];
            } else {
                flagValues[flagId] = cloneFlagValue(value);
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

    // Relative path under models/: bare name or folder/name.gguf. Rejects escapes.
    // Exported on the flagCore API and used by benchmark-ui too: this is the one
    // definition of the rule, so `-m models/<name>` cannot diverge between the
    // launch and benchmark paths. Deliberately kept here rather than injected via
    // configure(), so a missing configure() call can never disable the check.
    function normalizeModelRelPath(modelName) {
        const name = String(modelName || "").trim().replace(/\\/g, "/");
        if (
            !name
            || name.startsWith("/")
            || /^[A-Za-z]:/.test(name)
            || !name.toLowerCase().endsWith(".gguf")
        ) return "";
        const parts = name.split("/");
        if (parts.some((part) => !part || part === "." || part === "..")) return "";
        return parts.join("/");
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
        replaceFlagValues(buildEffectiveFlagValues(data));
        if (typeof afterApply === "function") {
            afterApply(flagValues);
        }
        if (typeof postUpdate === "function") {
            // A wholesale replace (preset load, import, model switch) must win over
            // whatever is in a focused input, unlike the incremental patches above
            // which are themselves driven by the user typing in that input.
            postUpdate({ force: true });
        }
        return flagValues;
    }

    function shouldOmitFlagValue(f, value) {
        const inertDefaultValues = {
            n_predict: -1,
            keep: 0,
            threads: -1,
            image_min_tokens: -1,
            image_max_tokens: -1,
            mtmd_batch_max_tokens: 1024,
            top_n_sigma: -1,
            xtc_probability: 0,
            xtc_threshold: 1.0,
            typical_p: 1.0,
            repeat_penalty: 1.0,
            presence_penalty: 0,
            frequency_penalty: 0,
            dry_multiplier: 0,
            dry_base: 1.75,
            dry_allowed_length: 2,
            dry_penalty_last_n: -1,
            dynatemp_range: 0,
            dynatemp_exp: 1.0,
            mirostat: "0",
            seed: -1,
            yarn_orig_ctx: 0,
            yarn_ext_factor: -1,
            yarn_attn_factor: -1,
            yarn_beta_slow: -1,
            yarn_beta_fast: -1,
            reasoning_budget: -1,
            reasoning_format: "auto",
            cache_reuse: 0,
            ctx_checkpoints: 32,
            checkpoint_every_n_tokens: 256,
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

    function isMirostatEnabled(values) {
        const mode = String((values || {}).mirostat || "0").trim();
        return mode === "1" || mode === "2";
    }

    function parseCustomLaunchArgs(raw) {
        const input = String(raw || "");
        const tokens = [];
        let token = "";
        let tokenStarted = false;
        let quote = null;
        let escaping = false;

        for (let i = 0; i < input.length; i += 1) {
            const ch = input[i];

            if (escaping) {
                token += ch;
                tokenStarted = true;
                escaping = false;
                continue;
            }

            if (quote === "\"") {
                if (ch === "\\") {
                    const nextCh = input[i + 1];
                    if (nextCh === undefined) {
                        escaping = true;
                        continue;
                    }
                    if (nextCh !== undefined && (/[\s'"\\]/.test(nextCh))) {
                        escaping = true;
                        continue;
                    }
                    token += ch;
                    tokenStarted = true;
                    continue;
                }
                if (ch === "\"") {
                    quote = null;
                    continue;
                }
                token += ch;
                tokenStarted = true;
                continue;
            }

            if (quote === "'") {
                if (ch === "'") {
                    quote = null;
                    continue;
                }
                token += ch;
                tokenStarted = true;
                continue;
            }

            if (/\s/.test(ch)) {
                if (tokenStarted) {
                    tokens.push(token);
                    token = "";
                    tokenStarted = false;
                }
                continue;
            }

            if (ch === "'" || ch === "\"") {
                quote = ch;
                tokenStarted = true;
                continue;
            }

            if (ch === "\\") {
                const nextCh = input[i + 1];
                if (nextCh !== undefined && (/[\s'"\\]/.test(nextCh))) {
                    escaping = true;
                    continue;
                }
                token += ch;
                tokenStarted = true;
                continue;
            }

            token += ch;
            tokenStarted = true;
        }

        if (escaping) {
            return { error: "Custom launch args end with an unfinished escape." };
        }
        if (quote) {
            return { error: `Custom launch args contain an unmatched ${quote === "'" ? "single" : "double"} quote.` };
        }
        if (tokenStarted) tokens.push(token);
        return { tokens };
    }

    function getKnownCliFlags() {
        const names = new Set();
        for (const f of getFlags()) {
            if (f.flag) names.add(String(f.flag));
            if (f.false_flag) names.add(String(f.false_flag));
        }
        // Model flags are not in FLAGS but the app emits them.
        for (const f of ["-m", "--model", "-hf", "--hf-repo", "-mu", "--model-url"]) {
            names.add(f);
        }
        return names;
    }

    function getCustomArgFlagName(token) {
        const value = String(token || "");
        if (!value.startsWith("-")) return value;
        const eqIndex = value.indexOf("=");
        return eqIndex > 0 ? value.slice(0, eqIndex) : value;
    }

    function getSensitiveCliFlags() {
        return new Set(getFlags()
            .filter(flag => flag && flag.sensitive && flag.flag)
            .map(flag => String(flag.flag)));
    }

    // Shell-quotes a single token for the copyable command preview. Without this
    // any value containing a space — the common case for a Windows model path —
    // was joined in raw, so "Copy command" produced a command that split into the
    // wrong arguments when pasted.
    function quoteArg(arg) {
        const text = String(arg);
        return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    }

    function redactSensitiveTokens(tokens) {
        const sensitiveFlags = getSensitiveCliFlags();
        const redacted = [];
        let redactNext = false;
        for (const rawToken of tokens || []) {
            const token = String(rawToken);
            if (redactNext) {
                redacted.push("<redacted>");
                redactNext = false;
                continue;
            }
            const matchedEqualsFlag = Array.from(sensitiveFlags)
                .find(flag => token.startsWith(flag + "="));
            if (matchedEqualsFlag) {
                redacted.push(matchedEqualsFlag + "=<redacted>");
                continue;
            }
            redacted.push(token);
            if (sensitiveFlags.has(token)) redactNext = true;
        }
        return redacted;
    }

    function hasLaunchModelArg(args) {
        const modelFlags = new Set(["-m", "--model", "-hf", "--hf-repo", "-mu", "--model-url"]);
        return (args || []).some(entry => {
            const values = Array.isArray(entry) ? entry : [entry];
            return values.some(value => {
                const token = String(value || "");
                const separator = token.indexOf("=");
                const flag = separator === -1 ? token : token.slice(0, separator);
                return modelFlags.has(flag);
            });
        });
    }

    function buildLaunchArgs(state) {
        const args = [];
        const warnings = [];
        const launchState = state && typeof state === "object" && !Array.isArray(state) ? state : {};
        const tool = launchState.tool;
        const values = launchState.flags && typeof launchState.flags === "object" && !Array.isArray(launchState.flags)
            ? launchState.flags
            : {};
        const model = String(launchState.model || "");
        if (tool !== "llama-server" && tool !== "llama-cli") {
            return { args, error: "Unsupported llama.cpp tool.", warnings };
        }
        const toolBase = tool.replace("llama-", "");

        for (const f of getFlags()) {
            if (f.tool !== "both" && f.tool !== toolBase) continue;
            if (typeof shouldOmitSpeculativeFlag === "function" && shouldOmitSpeculativeFlag(f, values)) continue;
            if (shouldOmitLegacyLoadFlag(f, values)) continue;
            const val = values[f.id];
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
            } else if (f.type === "text_list") {
                const items = Array.isArray(val) ? val : String(val).split(/\r?\n/);
                for (const item of items) {
                    const normalized = String(item).trim();
                    if (normalized) args.push([f.flag, normalized]);
                }
            } else {
                if (f.id === "kv_unified") {
                    if (val === "enabled") {
                        args.push([f.flag]);
                    } else if (val === "disabled" && f.false_flag) {
                        args.push([f.false_flag]);
                    }
                    continue;
                }
                if (f.id === "chat_template"
                    && typeof isSupportedChatTemplateValue === "function"
                    && !isSupportedChatTemplateValue(val)) {
                    warnings.push(`Unsupported chat-template preset "${val}" — no --chat-template will be emitted.`);
                    continue;
                }
                if (f.id === "chat_template" && String(values.chat_template_custom || "").trim()) {
                    continue;
                }
                if (f.id === "gpu_layers") {
                    const normalizedGpuLayers = normalizeGpuLayersValue(val);
                    if (normalizedGpuLayers === undefined) continue;
                    if (shouldOmitFlagValue(f, normalizedGpuLayers)) continue;
                    args.push([f.flag, normalizedGpuLayers]);
                    continue;
                }
                if (f.id === "checkpoint_every_n_tokens" && Number(val) < 0) {
                    args.push([f.flag, "0"]);
                    continue;
                }
                if ((f.id === "mirostat_lr" || f.id === "mirostat_ent") && !isMirostatEnabled(values)) {
                    continue;
                }
                if (shouldOmitFlagValue(f, val)) continue;
                args.push([f.flag, String(val)]);
            }
        }

        const customRaw = values.custom_args;
        if (customRaw !== undefined && customRaw !== null && String(customRaw).trim()) {
            const parsedCustom = parseCustomLaunchArgs(customRaw);
            if (parsedCustom.error) {
                return { args, error: parsedCustom.error, warnings };
            }

            // ponytail: token-naive duplicate detection — values that happen
            // to equal known flag strings are mis-flagged. Fix with flag/value
            // pairing when this produces user-visible false positives.
            const knownCliFlags = getKnownCliFlags();
            const duplicates = Array.from(new Set(parsedCustom.tokens
                .map(getCustomArgFlagName)
                .filter(token => knownCliFlags.has(token))));
            if (duplicates.length > 0) {
                warnings.push(`Custom launch args duplicate UI-managed flags: ${duplicates.join(", ")}`);
            }
            args.push(...parsedCustom.tokens);
        }

        if (model) {
            const modelName = normalizeModelRelPath(model);
            if (!modelName) {
                return { args, error: "Invalid model filename.", warnings };
            }
            args.push(["-m", "models/" + modelName]);
        }

        return { args, error: null, warnings };
    }

    function getLaunchArgs() {
        return buildLaunchArgs({
            tool: currentTool,
            model: selectedModel,
            flags: flagValues,
        });
    }

    function updateCommandPreview() {
        const result = getLaunchArgs();
        const launchTokens = [];
        for (const entry of result.args) {
            if (Array.isArray(entry)) {
                launchTokens.push(...entry);
            } else {
                launchTokens.push(String(entry));
            }
        }
        const parts = [getToolBinaryName(currentTool), ...redactSensitiveTokens(launchTokens)];
        const command = parts.map(quoteArg).join(" ");
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
        getFlagValues: collectFlagValues,
        replaceFlagValues,
        buildEffectiveFlagValues,
        patchFlagValues,
        configure,
        setMultipleFlagValues,
        setFlagValue,
        setPathFlagValue,
        applyFlagValues,
        shouldOmitFlagValue,
        isValidGpuLayersValue,
        normalizeGpuLayersValue,
        parseCustomLaunchArgs,
        normalizeModelRelPath,
        quoteArg,
        redactSensitiveTokens,
        hasLaunchModelArg,
        buildLaunchArgs,
        getLaunchArgs,
        updateCommandPreview,
        registerApi,
    };
})();
