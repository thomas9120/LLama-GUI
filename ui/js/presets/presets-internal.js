// Presets package (1/10): module state, configure(), sensitive-arg scrubbing,
// fetch/normalize helpers, and import-name validation. Declarations stay
// top-level script globals exactly like the former presets.js single file;
// the ui/index.html load order preserves the original evaluation order.
const SENSITIVE_PRESET_FLAG_IDS = new Set(["api_key", "hf_token"]);
const SENSITIVE_CUSTOM_ARG_MESSAGE = "Presets cannot include --api-key, -hft, or --hf-token in Custom Launch Args. Use the API Key or HF Token field instead, and check argument quoting.";
let presetDependencies = {};
let lastLoadedPresetName = "";
let loadedPresetData = null;
let loadedPresetMissing = false;
let loadedPresetArchived = false;
let presetSavePending = false;

function configurePresetModule(options = {}) {
    presetDependencies = Object.assign({}, presetDependencies, options);
}

function hasSensitiveCustomArgs(flags) {
    const raw = flags && flags.custom_args;
    return typeof raw === "string" && Boolean(raw.trim()) && getPresetFlagCore().hasSensitiveCustomArgs(raw);
}

function clonePresetFlagValue(value) {
    return Array.isArray(value) ? [...value] : value;
}

function assertNoSensitiveCustomArgs(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const flags = data.flags && typeof data.flags === "object" && !Array.isArray(data.flags)
        ? data.flags
        : data;
    if (hasSensitiveCustomArgs(flags)) throw new Error(SENSITIVE_CUSTOM_ARG_MESSAGE);
}

function stripSensitivePresetFlags(flags) {
    const sanitized = {};
    for (const [key, value] of Object.entries(flags || {})) {
        if (SENSITIVE_PRESET_FLAG_IDS.has(key)) continue;
        if (key === "custom_args" && hasSensitiveCustomArgs(flags)) continue;
        sanitized[key] = clonePresetFlagValue(value);
    }
    return sanitized;
}

function isFullPresetData(data) {
    return Boolean(
        data
        && typeof data === "object"
        && !Array.isArray(data)
        && data.flags
        && typeof data.flags === "object"
        && !Array.isArray(data.flags)
    );
}

function findPresetByName(entries, name) {
    if (!Array.isArray(entries)) return null;
    const target = String(name || "");
    const entry = entries.find((candidate) => candidate && String(candidate.name || "") === target);
    if (!entry) return null;
    return {
        name: String(entry.name || ""),
        data: normalizePresetData(entry.data),
        full: isFullPresetData(entry.data),
        created: entry.created,
        modified: entry.modified,
    };
}

function getPresetFetchJson() {
    const managerFetch = window.LlamaGui
        && window.LlamaGui.manager
        && window.LlamaGui.manager.fetchJson;
    if (typeof managerFetch === "function") return managerFetch;
    if (typeof fetchJson === "function") return fetchJson;
    throw new Error("Preset API is not available.");
}

async function fetchPresetEntries() {
    const entries = await getPresetFetchJson()("/api/presets");
    if (!Array.isArray(entries)) {
        throw new Error("Preset API returned an invalid response.");
    }
    return entries;
}

function normalizePresetData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { tool: null, model: "", flags: {} };
    }

    if (data.flags && typeof data.flags === "object" && !Array.isArray(data.flags)) {
        const tool = typeof data.tool === "string" ? data.tool : null;
        const model = typeof data.model === "string" ? data.model : "";
        return { tool, model, flags: stripSensitivePresetFlags(data.flags) };
    }

    return { tool: null, model: "", flags: stripSensitivePresetFlags(data) };
}

function getKnownPresetFlagIds() {
    const flags = Array.isArray(window.FLAGS)
        ? window.FLAGS
        : (typeof FLAGS !== "undefined" && Array.isArray(FLAGS) ? FLAGS : []);
    return new Set(flags.map((flag) => flag && flag.id).filter(Boolean));
}

function normalizeImportedPresetData(data) {
    assertNoSensitiveCustomArgs(data);
    const normalized = normalizePresetData(data);
    const tool = normalized.tool === "llama-server" || normalized.tool === "llama-cli"
        ? normalized.tool
        : null;
    const model = typeof normalized.model === "string" ? normalized.model : "";
    const knownFlagIds = getKnownPresetFlagIds();
    const flags = {};

    for (const [key, value] of Object.entries(normalized.flags || {})) {
        if (knownFlagIds.has(key) && !SENSITIVE_PRESET_FLAG_IDS.has(key)) {
            flags[key] = value;
        }
    }

    return { tool, model, flags };
}

function hasUsablePresetData(presetData) {
    return Boolean(presetData && (presetData.model || Object.keys(presetData.flags || {}).length > 0));
}

function sanitizeImportedPresetName(name) {
    return String(name || "")
        .replace(/[^A-Za-z0-9 ._-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[. _]+|[. _]+$/g, "");
}

function findPresetImportNameCollision(existingPresets, importedPresets) {
    const taken = new Set((existingPresets || [])
        .map((preset) => String(preset && preset.name || "").toLowerCase())
        .filter(Boolean));
    for (const preset of importedPresets || []) {
        const name = String(preset && preset.name || "");
        const folded = name.toLowerCase();
        if (folded && taken.has(folded)) return name;
        if (folded) taken.add(folded);
    }
    return "";
}

function getPresetFlagCore() {
    if (!window.LlamaGui || !window.LlamaGui.flagCore) {
        throw new Error("Flag core is not available.");
    }
    return window.LlamaGui.flagCore;
}
