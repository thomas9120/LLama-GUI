// Shared flag state and launch-argument core: currentTool, flagValues and shared setters,
// custom launch args parsing, preset apply/collect helpers, getLaunchArgs(), and command
// preview generation. Exposed as window.LlamaGui.flagCore - the one shared state layer.
(function () {
    const root = window.LlamaGui = window.LlamaGui || {};
    let currentTool = "llama-server";
    let selectedModel = "";
    let modelDirInfo = null;
    let flagValues = {};
    let binaryTag = "";
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

    function normalizeReasoningPreserveValue(value) {
        // The old unchecked checkbox omitted the flag; it did not disable it.
        if (value === true) return "enabled";
        if (value === false || value === undefined || value === null || value === "") return "auto";
        return value;
    }

    function normalizeStoredFlagValue(flagId, value) {
        return flagId === "reasoning_preserve" ? normalizeReasoningPreserveValue(value) : cloneFlagValue(value);
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
            flagValues[key] = normalizeStoredFlagValue(key, value);
        }
        return flagValues;
    }

    const draftSpeculativeTypes = new Set([
        "draft-simple",
        "draft-eagle3",
        "draft-dflash",
        "draft-dspark",
        "draft-mtp",
    ]);

    function getSpeculativeTypeParts(values) {
        const raw = String((values || {}).spec_type || "auto").trim();
        return raw.split(",").map(value => value.trim()).filter(Boolean);
    }

    function isNgramSimpleValue(value) {
        return value === true || String(value || "").trim() === "ngram-simple";
    }

    function isNgramSimpleEnabled(values) {
        const cfg = values || {};
        return isNgramSimpleValue(cfg.ngram_simple) || getSpeculativeTypeParts(cfg).includes("ngram-simple");
    }

    function isNgramModValue(value) {
        return value === true || String(value || "").trim() === "ngram-mod";
    }

    function isNgramModEnabled(values) {
        const cfg = values || {};
        const explicit = cfg.ngram_mod !== undefined ? cfg.ngram_mod : cfg.spec_ngram_mod;
        return isNgramModValue(explicit) || getSpeculativeTypeParts(cfg).includes("ngram-mod");
    }

    function isNgramMapK4vValue(value) {
        return value === true || String(value || "").trim() === "ngram-map-k4v";
    }

    function isNgramMapK4vEnabled(values) {
        const cfg = values || {};
        const explicit = cfg.ngram_map_k4v !== undefined ? cfg.ngram_map_k4v : cfg.spec_ngram_map_k4v;
        return isNgramMapK4vValue(explicit) || getSpeculativeTypeParts(cfg).includes("ngram-map-k4v");
    }

    function getCombinedSpeculativeType(values) {
        const specTypes = getSpeculativeTypeParts(values);
        if (specTypes.includes("none")) return "none";
        const draftType = specTypes.find(type => draftSpeculativeTypes.has(type));
        return [
            draftType,
            isNgramModEnabled(values) ? "ngram-mod" : "",
            isNgramMapK4vEnabled(values) ? "ngram-map-k4v" : "",
            isNgramSimpleEnabled(values) ? "ngram-simple" : "",
        ]
            .filter(Boolean)
            .join(",");
    }

    function normalizeSpeculativeFlagValues(values) {
        const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
        const normalized = { ...source };
        const specTypes = getSpeculativeTypeParts(source);
        const hasExplicitNgram = Object.prototype.hasOwnProperty.call(source, "ngram_mod")
            || Object.prototype.hasOwnProperty.call(source, "spec_ngram_mod");
        if (hasExplicitNgram) {
            const explicit = Object.prototype.hasOwnProperty.call(source, "ngram_mod")
                ? source.ngram_mod
                : source.spec_ngram_mod;
            normalized.ngram_mod = isNgramModValue(explicit);
            delete normalized.spec_ngram_mod;
        } else if (specTypes.includes("ngram-mod")) {
            // Legacy presets stored ngram-mod in spec_type. Keep that preset
            // working while moving the UI to the independent shared control.
            normalized.ngram_mod = true;
        }
        const hasExplicitNgramMap = Object.prototype.hasOwnProperty.call(source, "ngram_map_k4v")
            || Object.prototype.hasOwnProperty.call(source, "spec_ngram_map_k4v");
        if (hasExplicitNgramMap) {
            const explicit = Object.prototype.hasOwnProperty.call(source, "ngram_map_k4v")
                ? source.ngram_map_k4v
                : source.spec_ngram_map_k4v;
            normalized.ngram_map_k4v = isNgramMapK4vValue(explicit);
            delete normalized.spec_ngram_map_k4v;
        } else if (specTypes.includes("ngram-map-k4v")) {
            // Legacy presets stored ngram-map-k4v in spec_type. Keep that preset
            // working while moving the UI to the independent shared control.
            normalized.ngram_map_k4v = true;
        }
        if (Object.prototype.hasOwnProperty.call(source, "ngram_simple")) {
            normalized.ngram_simple = isNgramSimpleValue(source.ngram_simple);
        } else if (specTypes.includes("ngram-simple")) {
            normalized.ngram_simple = true;
        }
        if (specTypes.includes("ngram-mod") || specTypes.includes("ngram-map-k4v") || specTypes.includes("ngram-simple")) {
            const withoutNgram = specTypes.filter(type => type !== "ngram-mod" && type !== "ngram-map-k4v" && type !== "ngram-simple");
            normalized.spec_type = withoutNgram.join(",") || "auto";
        }
        return normalized;
    }

    function buildEffectiveFlagValues(values) {
        const effective = {
            ...getDefaultFlagValues(),
            ...normalizeSpeculativeFlagValues(values),
        };
        const cloned = {};
        for (const [key, value] of Object.entries(effective)) {
            cloned[key] = normalizeStoredFlagValue(key, value);
        }
        return cloned;
    }

    function patchFlagValues(patch) {
        for (const [flagId, value] of Object.entries(patch || {})) {
            if (value === undefined) {
                delete flagValues[flagId];
            } else {
                flagValues[flagId] = normalizeStoredFlagValue(flagId, value);
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

    function setModelDirInfo(info) {
        if (
            !info
            || typeof info.models_dir_available !== "boolean"
            || typeof info.models_dir_is_default !== "boolean"
            || !Object.prototype.hasOwnProperty.call(info, "models_dir")
            || !Object.prototype.hasOwnProperty.call(info, "models_arg_root")
        ) {
            modelDirInfo = null;
            return null;
        }
        modelDirInfo = {
            models_dir: String(info.models_dir || ""),
            models_arg_root: String(info.models_arg_root || ""),
            models_dir_is_default: info.models_dir_is_default,
            models_dir_available: info.models_dir_available,
            models_dir_error: String(info.models_dir_error || ""),
        };
        return { ...modelDirInfo };
    }

    function buildLocalModelPath(modelName) {
        const name = normalizeModelRelPath(modelName);
        if (!name) return { path: "", error: "Invalid model filename." };
        if (!modelDirInfo) {
            return { path: "", error: "Models folder status is not available yet." };
        }
        if (!modelDirInfo.models_dir_available) {
            return {
                path: "",
                error: modelDirInfo.models_dir_error || "Models folder is unavailable.",
            };
        }
        const argRoot = modelDirInfo.models_arg_root;
        if (!argRoot) return { path: "", error: "Models folder launch path is unavailable." };
        const separator = /[\\/]$/.test(argRoot) ? "" : "/";
        return { path: argRoot + separator + name, error: null };
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
            draft_sampling: "greedy",
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
            moe_cache_mib: 0,
            moe_cache_cpu_share: 0,
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
            for (const alias of f.aliases || []) names.add(alias);
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

    // llama.cpp uses CSV for hosts, keys and built-in tools, including quoted
    // fields (for example a UNIX socket path containing a comma).
    function parseLaunchCsv(value) {
        const fields = [];
        let field = "";
        let quoted = false;
        for (let i = 0; i < value.length; i += 1) {
            const ch = value[i];
            if (ch === '"') {
                if (!quoted && field !== "") field += ch;
                else if (quoted && value[i + 1] === '"') { field += '"'; i += 1; }
                else quoted = !quoted;
            } else if (ch === "," && !quoted) {
                fields.push(field);
                field = "";
            } else field += ch;
        }
        fields.push(field);
        return fields;
    }

    function getToolsAuthenticationState(args) {
        const state = { host: "127.0.0.1", tools: false, proxy: false, config: "", json: "", hasKey: false, allow: false };
        const valueFlags = new Set(["--host", "--tools", "--tools-runtime", "--mcp-servers-config", "--mcp-servers-json", "--api-key", "--api-key-file", "--alias", "-m", "--model", "-hf", "--hf-repo", "-mu", "--model-url"]);
        for (const flag of getFlags()) {
            if (flag.type === "bool") continue;
            for (const name of [flag.flag, ...(flag.aliases || [])]) valueFlags.add(name);
        }
        // Preserve UI pairs and consume custom values so a quoted value such as
        // --alias '--allow-unauthenticated-tools' cannot masquerade as a flag.
        for (let i = 0; i < args.length; i += 1) {
            const entry = args[i];
            const token = String(Array.isArray(entry) ? entry[0] : entry);
            const name = getCustomArgFlagName(token);
            const eq = token.indexOf("=");
            let value = Array.isArray(entry) ? String(entry[1] ?? "") : eq > 0 ? token.slice(eq + 1) : "";
            if (!Array.isArray(entry) && eq < 0 && typeof args[i + 1] === "string"
                && (valueFlags.has(name) || !args[i + 1].startsWith("-"))) value = args[++i];
            if (name === "--host") state.host = value;
            // Even --tools '' produces a nonempty upstream vector ([""]).
            else if (name === "--tools") state.tools = true;
            else if (name === "--mcp-servers-config") state.config = value;
            else if (name === "--mcp-servers-json") state.json = value;
            else if (name === "--api-key") state.hasKey ||= parseLaunchCsv(value).some(key => key !== "");
            else if (name === "--api-key-file") state.hasKey ||= value !== "";
            else if (name === "--allow-unauthenticated-tools") state.allow = true;
            else if (name === "--ui-mcp-proxy" || name === "--webui-mcp-proxy") state.proxy = true;
            else if (name === "--no-ui-mcp-proxy" || name === "--no-webui-mcp-proxy") state.proxy = false;
            else if (["--agent", "-ag", "--no-agent", "-no-ag"].includes(name)) {
                state.tools = state.proxy = name === "--agent" || name === "-ag";
            }
        }
        return state;
    }

    function getSensitiveCliFlags() {
        return new Set(["--api-key", "-hft", "--hf-token", ...getFlags()
            .filter(flag => flag && flag.sensitive && flag.flag)
            .map(flag => String(flag.flag))]);
    }

    function hasSensitiveCustomArgs(raw) {
        const parsed = parseCustomLaunchArgs(raw);
        // Malformed input cannot be established safe to persist.
        return Boolean(parsed.error) || parsed.tokens.some(token => getSensitiveCliFlags().has(getCustomArgFlagName(token)));
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

    // Gate for llama.cpp b10434+, where --reasoning-effort became a native
    // launch flag (upstream PR 26941). The tag comes from /api/status
    // (config.json "version"): official releases use "bNNNNN"; both custom
    // slots use "custom". Anything unrecognized stays on the legacy
    // --chat-template-kwargs path, which every build accepts.
    function setBinaryTag(tag) {
        binaryTag = String(tag || "");
    }

    function supportsNativeReasoningEffort() {
        const match = /^b(\d+)/.exec(binaryTag);
        return Boolean(match) && Number(match[1]) >= 10434;
    }

    // Gate for llama.cpp b10875+, where --mmap/--no-mmap, --mlock, and
    // -dio/--direct-io/--no-direct-io were removed from llama-server and
    // llama-cli in favor of --load-mode (upstream PR 28334). The tag comes
    // from /api/status like the reasoning-effort gate above: official
    // releases use "bNNNNN" (trailing build suffixes such as "-cuda" are
    // accepted); custom slots use "custom". Anything unrecognized stays
    // silent, keeping older and custom builds working.
    function supportsLoadModeOnly() {
        const match = /^b(\d+)/.exec(binaryTag);
        return Boolean(match) && Number(match[1]) >= 10875;
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
        const environment = parseEnvironmentVariables(values.custom_env);
        if (environment.error) return { args, error: environment.error, errorField: "custom_env", warnings };
        if (tool !== "llama-server" && tool !== "llama-cli") {
            return { args, error: "Unsupported llama.cpp tool.", warnings };
        }
        const toolBase = tool.replace("llama-", "");

        for (const f of getFlags()) {
            if (f.tool !== "both" && f.tool !== toolBase) continue;
            if (f.id === "ngram_mod" || f.id === "ngram_map_k4v" || f.id === "ngram_simple") continue;
            if (values.fit === "off" && (f.id === "fit_target" || f.id === "fit_ctx")) continue;
            if (f.id === "kv_unified_per_slot" && values.kv_unified === "disabled") continue;
            if (typeof shouldOmitSpeculativeFlag === "function" && shouldOmitSpeculativeFlag(f, values)) continue;
            if (shouldOmitLegacyLoadFlag(f, values)) continue;
            const val = values[f.id];

            if (f.id === "spec_type") {
                const specType = getCombinedSpeculativeType(values);
                if (specType) args.push([f.flag, specType]);
                continue;
            }

            if (f.id === "chat_template_reasoning_effort") {
                if (val && val !== "auto") {
                    if (supportsNativeReasoningEffort()) {
                        args.push([f.flag, val]);
                    } else {
                        const kwargs = {};
                        if (values.preserve_thinking === true) kwargs.preserve_thinking = true;
                        kwargs.reasoning_effort = val;
                        args.push(["--chat-template-kwargs", JSON.stringify(kwargs)]);
                    }
                }
                continue;
            }
            if (f.id === "reasoning_preserve") {
                const mode = normalizeReasoningPreserveValue(val);
                if (mode === "enabled") args.push([f.flag]);
                else if (mode === "disabled") args.push([f.false_flag]);
                else if (mode !== "auto") warnings.push(`Unsupported ${f.label || f.id} value "${mode}" — omitted.`);
                continue;
            }
            if (f.id === "preserve_thinking") {
                // On the legacy path with a non-auto effort, preserve_thinking
                // is merged into the single kwargs object emitted above.
                const mergedIntoEffortKwargs = toolBase === "server"
                    && !supportsNativeReasoningEffort()
                    && values.chat_template_reasoning_effort
                    && values.chat_template_reasoning_effort !== "auto";
                if (val === true && !mergedIntoEffortKwargs) {
                    args.push([f.flag, '{"preserve_thinking":true}']);
                }
                continue;
            }
            if (val === undefined || val === null || val === "") continue;

            if (f.type === "bool") {
                if (val === true && !f.flag.startsWith("--no-")) {
                    args.push([f.flag]);
                } else if (val === false && f.false_flag) {
                    args.push([f.false_flag]);
                } else if (val === true && f.flag.startsWith("--no-")) {
                    args.push([f.flag]);
                }
            } else if (f.type === "multi_enum") {
                const selectedValues = normalizeMultiEnumValue(val);
                const allowedValues = new Set((f.options || []).map(option => String(option.value)));
                const supportedValues = selectedValues.filter(value => allowedValues.has(value));
                for (const value of selectedValues.filter(value => !allowedValues.has(value))) {
                    warnings.push(`Unsupported ${f.label || f.id} value "${value}" — omitted.`);
                }
                if (supportedValues.length > 0) {
                    args.push([f.flag, supportedValues.join(",")]);
                }
            } else if (f.type === "path_list") {
                for (const path of Array.isArray(val) ? val : []) {
                    const normalized = String(path).trim();
                    // Upstream parses each occurrence as CSV, even for one file.
                    const csvPath = /[,"]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
                    if (normalized) args.push([f.flag, csvPath]);
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

            // TODO: token-naive duplicate detection — values that happen
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
            const localModel = buildLocalModelPath(model);
            if (localModel.error) return { args, error: localModel.error, warnings };
            args.push(["-m", localModel.path]);
        }

        if (supportsLoadModeOnly()) {
            const removedLoadFlags = new Set(["--mmap", "--no-mmap", "--mlock", "-dio", "-ndio", "--direct-io", "--no-direct-io"]);
            const hasRemovedLoadFlag = args.some((entry) => {
                if (Array.isArray(entry)) return removedLoadFlags.has(String(entry[0]));
                return removedLoadFlags.has(getCustomArgFlagName(entry));
            });
            if (hasRemovedLoadFlag) {
                warnings.push("Legacy load flags (--mmap/--no-mmap, --mlock, -dio/--direct-io) were removed in llama.cpp b10875 and will fail on this build. Select a --load-mode instead of Legacy controls.");
            }
        }

        const build = /^b(\d+)/.exec(binaryTag);
        if (build && Number(build[1]) <= 12191 && args.some(entry => {
            const name = Array.isArray(entry) ? entry[0] : getCustomArgFlagName(entry);
            return name === "--shard" || name === "--ple";
        })) {
            warnings.push("Additional GGUF shards / PLE require a newer llama.cpp build containing PR #31185. This build (b12191 or older) does not support --shard / --ple; update llama.cpp before launching.");
        }

        // FP8 KV cache types entered the shared -ctk/-ctv option list in
        // b12274 and need model-side FP8 scales. Older builds reject the value.
        // Check emitted pairs so a draft cache type left over from a disabled
        // draft model does not warn about an argument that is never sent.
        const fp8CacheFlags = new Set(["-ctk", "--cache-type-k", "-ctv", "--cache-type-v", "-ctkd", "--cache-type-k-draft", "-ctvd", "--cache-type-v-draft"]);
        const usesFp8Cache = args.some(entry => Array.isArray(entry)
            && fp8CacheFlags.has(String(entry[0])) && String(entry[1]) === "f8_e4m3");
        if (build && Number(build[1]) < 12274 && usesFp8Cache) {
            warnings.push("FP8 KV cache (f8_e4m3) requires llama.cpp b12274 or newer. This build does not support it; choose another cache type or update llama.cpp.");
        }

        // llama.cpp b12340+ refuses tools, MCP servers, or the MCP proxy on a
        // non-loopback host without an API key (upstream PR 32113). Warn before
        // launch instead of letting the server exit with a startup error.
        const auth = getToolsAuthenticationState(args);
        const loopbackHost = parseLaunchCsv(auth.host).map(host => host.trim()).filter(Boolean).every(host =>
            host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.") || host.endsWith(".sock"));
        const toolsEnabled = auth.tools || auth.proxy || auth.config !== "" || auth.json !== "";
        if (build && Number(build[1]) < 12340 && auth.allow) {
            warnings.push("Allow Unauthenticated Tools requires llama.cpp b12340 or newer. This build does not support --allow-unauthenticated-tools; update llama.cpp.");
        }
        if (toolBase === "server" && build && Number(build[1]) >= 12340
            && toolsEnabled && !loopbackHost && !auth.hasKey && !auth.allow) {
            warnings.push("llama.cpp b12340+ refuses tools, MCP servers, or the MCP proxy on a non-loopback host without an API key. Set an API Key, bind to 127.0.0.1, or enable Allow Unauthenticated Tools.");
        }
        return { args, env: environment.env, error: null, warnings };
    }

    function parseEnvironmentVariables(raw) {
        const env = {};
        if (raw === undefined || raw === null || raw === "") return { env, error: null };
        if (typeof raw !== "string" || raw.length > 16000) {
            return { env, error: "Environment Variables must be text up to 16,000 characters." };
        }
        const lines = raw.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (!line) continue;
            const separator = line.indexOf("=");
            const name = line.slice(0, separator).trim();
            if (separator < 1 || !/^(LLAMA_|GGML_)[A-Z0-9_]+$/.test(name)
                || /^(LLAMA_GUI_|LLAMA_ARG_)/.test(name) || /[\0\r]/.test(line)) {
                return { env: {}, error: `Environment Variables line ${index + 1}: use LLAMA_ or GGML_ names and NAME=value. LLAMA_GUI_ and LLAMA_ARG_ settings belong in the existing controls.` };
            }
            if (Object.prototype.hasOwnProperty.call(env, name)) {
                return { env: {}, error: `Environment Variables line ${index + 1}: duplicate name ${name}.` };
            }
            env[name] = line.slice(separator + 1).trim();
        }
        return { env, error: null };
    }

    function getLaunchArgs() {
        return buildLaunchArgs({
            tool: currentTool,
            model: selectedModel,
            flags: flagValues,
        });
    }

    // Capture the inputs used to build a request, never the edits made while
    // the request is in flight. These are GUI inputs, not resolved runtime values.
    function captureLaunchSettings(state = { tool: currentTool, model: selectedModel, flags: flagValues }) {
        const values = state.flags || {};
        const flags = values.custom_env ? { custom_env: values.custom_env } : {};
        let remaining = 120000 - JSON.stringify(flags).length;
        if (String(state.model || "").length > 4096 || (modelDirInfo && modelDirInfo.models_arg_root.length > 4096)) return undefined;
        for (const flag of getFlags()) {
            if (flag.sensitive || (flag.tool !== "both" && flag.tool !== state.tool.replace("llama-", ""))) continue;
            const value = values[flag.id] === undefined ? null : cloneFlagValue(values[flag.id]);
            const size = JSON.stringify(value).length + flag.id.length + 5;
            // Optional comparison metadata must never prevent a launch with a
            // large grammar or stop-string list. Omitted fields stay Unknown.
            if (size > 16000 || size > remaining || (Array.isArray(value) && value.length > 256)) continue;
            flags[flag.id] = value;
            remaining -= size;
        }
        return {
            model: String(state.model || ""),
            model_root: modelDirInfo ? modelDirInfo.models_arg_root : null,
            flags,
            has_custom_args: Boolean(String(values.custom_args || "").trim()),
        };
    }

    function normalizeComparisonValue(flag, value) {
        if (flag.id === "reasoning_preserve") return normalizeReasoningPreserveValue(value);
        if (flag.type === "bool") return value === true;
        if (flag.type === "multi_enum") return [...normalizeMultiEnumValue(value)].sort();
        if (flag.type === "text_list" || flag.type === "path_list") {
            return (Array.isArray(value) ? value : String(value || "").split(/\r?\n/))
                .map(item => String(item).trim()).filter(Boolean);
        }
        if (flag.type === "enum" && value === "" && (flag.options || []).some(option => option.value === "")) return "";
        if (value === undefined || value === null || value === "") return null;
        if (flag.type === "int" || flag.type === "float") {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : String(value);
        }
        return String(value);
    }

    function compareLaunchSettings(runtime) {
        const baseline = runtime && runtime.tool === currentTool && runtime.launch_settings;
        const known = baseline && baseline.flags && typeof baseline.flags === "object" && !Array.isArray(baseline.flags);
        const entries = [];
        if (known) {
            for (const flag of getFlags()) {
                if (flag.sensitive || (flag.tool !== "both" && flag.tool !== currentTool.replace("llama-", ""))) continue;
                if (!Object.prototype.hasOwnProperty.call(baseline.flags, flag.id)) continue;
                const before = normalizeComparisonValue(flag, baseline.flags[flag.id]);
                const after = normalizeComparisonValue(flag, flagValues[flag.id]);
                entries.push({ flag, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) });
            }
        }
        return {
            available: Boolean(known && entries.length),
            entries,
            changes: entries.filter(entry => entry.changed),
            modelChanged: Boolean(known && typeof baseline.model === "string" && baseline.model !== selectedModel),
            modelRootChanged: Boolean(known && typeof baseline.model_root === "string"
                && modelDirInfo && baseline.model_root !== modelDirInfo.models_arg_root),
        };
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
        normalizeStoredFlagValue,
        buildEffectiveFlagValues,
        normalizeSpeculativeFlagValues,
        getCombinedSpeculativeType,
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
        parseEnvironmentVariables,
        hasSensitiveCustomArgs,
        normalizeModelRelPath,
        setModelDirInfo,
        buildLocalModelPath,
        quoteArg,
        redactSensitiveTokens,
        hasLaunchModelArg,
        buildLaunchArgs,
        getLaunchArgs,
        captureLaunchSettings,
        compareLaunchSettings,
        setBinaryTag,
        supportsNativeReasoningEffort,
        supportsLoadModeOnly,
        updateCommandPreview,
        registerApi,
    };
})();
