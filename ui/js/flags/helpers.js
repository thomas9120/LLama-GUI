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

function isSpeculativeDecodingEnabled(values) {
    const cfg = values || {};
    const specType = String(cfg.spec_type || "none").trim();
    return Boolean(cfg.model_draft || cfg.hf_repo_draft || (specType && specType !== "none"));
}

function hasDraftModelSpeculation(values) {
    const cfg = values || {};
    if (cfg.model_draft || cfg.hf_repo_draft) return true;
    const specType = String(cfg.spec_type || "none").trim();
    return new Set(["draft-simple", "draft-eagle3", "draft-mtp"]).has(specType);
}

function shouldOmitSpeculativeFlag(f, values) {
    if (f.category !== "speculative") return false;
    if (!isSpeculativeDecodingEnabled(values)) return true;

    if (f.id === "spec_type") {
        const specType = String((values || {}).spec_type || "none").trim();
        return !specType || specType === "none";
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

function getDefaultValues() {
    const defaults = {};
    for (const f of FLAGS) {
        if (f.default !== undefined) {
            defaults[f.id] = f.default;
        }
    }
    return defaults;
}
