function getFlagsForTool(tool) {
    const toolBase = String(tool).replace("llama-", "");
    if (toolBase !== "server" && toolBase !== "cli" && toolBase !== "both") {
        console.warn("[flags] getFlagsForTool() called with unexpected tool:", tool);
    }
    return FLAGS.filter(f => f.tool === "both" || f.tool === toolBase);
}

function getFlagsByCategory(tool) {
    const flags = getFlagsForTool(tool);
    const groups = {};
    for (const cat of FLAG_CATEGORIES) {
        const catFlags = flags.filter(f => f.category === cat.id);
        if (catFlags.length > 0) {
            groups[cat.id] = { ...cat, flags: catFlags };
        }
    }
    return groups;
}

function getSpeculativeTypeParts(values) {
    const raw = String((values || {}).spec_type || "none").trim();
    return raw.split(",").map(value => value.trim()).filter(Boolean);
}

function isNgramModEnabled(values) {
    const cfg = values || {};
    const explicit = cfg.ngram_mod !== undefined ? cfg.ngram_mod : cfg.spec_ngram_mod;
    return explicit === true
        || String(explicit || "").trim() === "ngram-mod"
        || getSpeculativeTypeParts(cfg).includes("ngram-mod");
}

function isSpeculativeDecodingEnabled(values) {
    const cfg = values || {};
    const specTypes = getSpeculativeTypeParts(cfg);
    return Boolean(cfg.model_draft || cfg.hf_repo_draft || specTypes.some(type => type !== "none") || isNgramModEnabled(cfg));
}

function hasDraftModelSpeculation(values) {
    const cfg = values || {};
    if (cfg.model_draft || cfg.hf_repo_draft) return true;
    return getSpeculativeTypeParts(cfg)
        .some(type => new Set(["draft-simple", "draft-eagle3", "draft-dflash", "draft-dspark", "draft-mtp"]).has(type));
}

function shouldOmitSpeculativeFlag(f, values) {
    if (f.category !== "speculative") return false;
    if (!isSpeculativeDecodingEnabled(values)) return true;

    if (f.id === "spec_type") {
        const specTypes = getSpeculativeTypeParts(values).filter(type => type !== "none" && type !== "ngram-mod");
        return specTypes.length === 0 && !isNgramModEnabled(values);
    }

    if (f.id === "ngram_mod") return true;

    if (new Set(["ngram_mod_n_match", "ngram_mod_n_min", "ngram_mod_n_max"]).has(f.id)) {
        return !isNgramModEnabled(values);
    }

    const draftModelOnlyFlags = new Set([
        "draft_max",
        "draft_min",
        "draft_p_min",
        "draft_p_split",
        "gpu_layers_draft",
        "draft_device",
        "draft_cache_type_k",
        "draft_cache_type_v",
    ]);
    return draftModelOnlyFlags.has(f.id) && !hasDraftModelSpeculation(values);
}

function shouldOmitLegacyLoadFlag(f, values) {
    const loadMode = String((values || {}).load_mode || "").trim();
    return Boolean(loadMode) && new Set(["mlock", "mmap", "direct_io"]).has(f.id);
}

function getDefaultValues() {
    const defaults = {};
    for (const f of FLAGS) {
        if (f.default !== undefined) {
            defaults[f.id] = Array.isArray(f.default) ? [...f.default] : f.default;
        }
    }
    return defaults;
}
