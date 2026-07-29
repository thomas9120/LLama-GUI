const SENSITIVE_PRESET_FLAG_IDS = new Set(["api_key"]);
const SENSITIVE_CUSTOM_ARG_PATTERN = /(^|[^A-Za-z0-9_-])--api-key(?=$|[=\s])/;
const SENSITIVE_CUSTOM_ARG_MESSAGE = "Presets cannot include --api-key in Custom Launch Args. Use the API Key field instead.";

function hasSensitiveCustomArgs(flags) {
    const raw = flags && flags.custom_args;
    return typeof raw === "string" && SENSITIVE_CUSTOM_ARG_PATTERN.test(raw);
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

function applyPresetModel(modelName) {
    const modelSelect = document.getElementById("model-select");
    const target = String(modelName || "");
    const flagCore = getPresetFlagCore();

    if (!target) {
        if (flagCore) flagCore.setSelectedModelValue("");
        if (modelSelect) modelSelect.value = "";
        return;
    }

    if (!modelSelect) {
        if (flagCore) flagCore.setSelectedModelValue(target);
        if (typeof syncQuickLaunchModelOptions === "function") {
            syncQuickLaunchModelOptions();
        }
        return;
    }

    // Resolve against the live options rather than the cached name set: only the
    // options carry the exact spelling, and a preset saved before models/ gained
    // subfolders stores a bare name that now lives at "<folder>/<name>". Falling
    // back to the raw value keeps the "(missing)" marker for a genuine miss, and
    // for an ambiguous basename that getPresetWarnings() also flags.
    const options = Array.from(modelSelect.options);
    const resolved = resolvePresetModelName(target, options.map((option) => option.value));

    if (!options.some(o => o.value === resolved)) {
        const opt = document.createElement("option");
        opt.value = resolved;
        opt.textContent = `${resolved}  (missing)`;
        modelSelect.appendChild(opt);
    }

    modelSelect.value = resolved;
    if (flagCore) flagCore.setSelectedModelValue(resolved);
    if (typeof syncQuickLaunchModelOptions === "function") {
        syncQuickLaunchModelOptions();
    }
}

function buildCurrentPresetData() {
    const flagCore = getPresetFlagCore();
    const currentValues = flagCore.getFlagValues();
    assertNoSensitiveCustomArgs(currentValues);
    const values = stripSensitivePresetFlags(currentValues);
    const selectedModel = flagCore.getSelectedModel();
    const tool = flagCore.getCurrentTool();
    return { tool, model: selectedModel, flags: values };
}

function preparePresetLaunchState(data, options = {}) {
    const flagCore = getPresetFlagCore();
    const normalized = normalizePresetData(data);
    const preserveApiKey = options.preserveApiKey !== false;
    if (typeof flagCore.buildEffectiveFlagValues !== "function") {
        throw new Error("Flag defaults are not available.");
    }
    const flags = flagCore.buildEffectiveFlagValues(normalized.flags);
    if (preserveApiKey) {
        const currentApiKey = flagCore.getFlagValues().api_key;
        if (currentApiKey) flags.api_key = currentApiKey;
    }
    return {
        tool: normalized.tool,
        model: resolvePresetModelName(normalized.model),
        flags,
    };
}

function applyPresetData(data, options = {}) {
    const flagCore = getPresetFlagCore();
    const prepared = preparePresetLaunchState(data, options);
    if (prepared.tool === "llama-cli" || prepared.tool === "llama-server") {
        flagCore.setCurrentTool(prepared.tool);
        const toolSelect = document.getElementById("tool-select");
        if (toolSelect) toolSelect.value = prepared.tool;
    }
    applyPresetModel(prepared.model);
    flagCore.applyFlagValues(prepared.flags);
    return prepared;
}

// The set of .gguf names currently in the models/ folder, as cached by
// refreshModels(). Returns null when the list is unknown so callers can stay
// silent instead of flagging every preset.
function getKnownModelNames() {
    const manager = window.LlamaGui && window.LlamaGui.manager;
    if (!manager || typeof manager.getKnownModelNames !== "function") return null;
    const names = manager.getKnownModelNames();
    // Duck-typed rather than `instanceof Set`, which is false for a Set built in
    // another realm (the vm-based unit tests, or any future iframe/worker).
    return names && typeof names.has === "function" && typeof names.size === "number" ? names : null;
}

// Presets normally store a bare file name, matching what /api/models returns,
// but getPresetGroupLabel() tolerates path-like values so this does too.
function getPresetModelFileName(model) {
    const parts = String(model || "").split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
}

// Match a saved preset model against a list of models/-relative names, which is
// what /api/models now reports. Presets written before models/ gained subfolders
// store a bare file name, so a bare name also matches a nested file's basename -
// but only when exactly one folder holds that name. Legacy absolute paths get the
// same compatibility fallback. Explicit relative paths must match exactly so a
// stale path cannot silently select different weights from another folder.
//
// Shared by presence checks and every preset launch path: if they disagreed, a
// preset could report healthy while the dropdown or launch used another value.
// Returns the matched name in its original spelling, since the launch needs the
// exact case even though the cached list is lowercased.
function matchKnownModelName(model, candidates) {
    const raw = String(model || "").trim().replace(/\\/g, "/");
    if (!raw) return { status: "empty", name: "" };

    const names = [];
    for (const entry of candidates || []) {
        if (typeof entry === "string" && entry) names.push(entry);
    }

    const lower = raw.toLowerCase();
    const exact = names.find((name) => name.toLowerCase() === lower);
    if (exact) return { status: "found", name: exact };

    const canMatchBasename = !raw.includes("/") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw);
    if (!canMatchBasename) return { status: "missing", name: "" };

    const fileName = getPresetModelFileName(raw).toLowerCase();
    if (!fileName) return { status: "missing", name: "" };
    const sameFileName = names.filter(
        (name) => getPresetModelFileName(name).toLowerCase() === fileName
    );
    if (sameFileName.length === 1) return { status: "found", name: sameFileName[0] };
    if (sameFileName.length > 1) return { status: "ambiguous", name: "" };
    return { status: "missing", name: "" };
}

function getModelSelectCandidateNames() {
    if (typeof document === "undefined") return [];
    const select = document.getElementById("model-select");
    return select ? Array.from(select.options).map((option) => option.value).filter(Boolean) : [];
}

function resolvePresetModelName(model, candidates = getModelSelectCandidateNames()) {
    const target = String(model || "");
    const match = matchKnownModelName(target, candidates);
    return match.status === "found" ? match.name : target;
}

// Deliberately conservative: only report a problem we are confident about. An
// unknown model list, an empty models/ folder, or a preset with no model saved
// all stay silent, since a preset for a model held on another machine is
// legitimate and false warnings would make the Warnings filter useless.
// Returns "" (no problem), "missing", or "ambiguous".
function getPresetModelIssue(model, knownModelNames = getKnownModelNames()) {
    if (!knownModelNames || knownModelNames.size === 0) return "";
    const match = matchKnownModelName(model, knownModelNames);
    return match.status === "missing" || match.status === "ambiguous" ? match.status : "";
}

function isPresetModelMissing(model, knownModelNames = getKnownModelNames()) {
    return getPresetModelIssue(model, knownModelNames) === "missing";
}

function getPresetWarnings(presetData, knownModelNames = getKnownModelNames()) {
    const warnings = [];
    const flags = (presetData && presetData.flags) || {};
    const chatTemplate = flags.chat_template;

    const modelIssue = getPresetModelIssue(presetData && presetData.model, knownModelNames);
    if (modelIssue === "missing") {
        const fileName = getPresetModelFileName(presetData.model);
        warnings.push(`Model file "${fileName}" is not in the models folder. Add it back or point this preset at another model before launching.`);
    } else if (modelIssue === "ambiguous") {
        const fileName = getPresetModelFileName(presetData.model);
        warnings.push(`Model file "${fileName}" is in more than one models subfolder, so this preset cannot say which one it means. Re-pick the model to save its full path.`);
    }

    if (chatTemplate && typeof isSupportedChatTemplateValue === "function" && !isSupportedChatTemplateValue(chatTemplate)) {
        warnings.push(`Uses outdated or unsupported chat template "${chatTemplate}". It will be ignored and Auto from model is safer.`);
    }

    if (typeof flags.custom_args === "string" && flags.custom_args.trim()) {
        warnings.push("Includes custom launch args. Review them before launching because they may override UI controls.");
    }

    return warnings;
}

const PRESET_GROUP_STATE_STORAGE_KEY = "llama_gui_preset_group_state_v1";
const PRESET_FAVORITES_STORAGE_KEY = "llama_gui_preset_favorites_v1";
const PRESET_LAST_USED_STORAGE_KEY = "llama_gui_preset_last_used_v1";
const PRESET_SORT_STORAGE_KEY = "llama_gui_preset_sort_v1";
const PRESET_FAVORITES_FIRST_STORAGE_KEY = "llama_gui_preset_favorites_first_v1";
const PRESET_SORT_MODES = new Set(["name", "recent", "added"]);
const PRESET_FAVORITES_MODES = ["all", "first", "only"];
const NO_MODEL_PRESET_GROUP_KEY = "__no_model__";

let presetStatusTimer = null;
let presetSearchQuery = "";
let presetWarningFilterActive = false;
let presetSortMode = loadPresetSortMode();
let presetFavoritesMode = loadPresetFavoritesMode();
let currentPresetGroups = [];
let selectedPresetName = "";
let selectedPresetNames = new Set();
let loadPresetsRequestId = 0;

function getPresetStorageItem(storageKey) {
    try {
        return localStorage.getItem(storageKey);
    } catch (e) {
        console.debug("Preset storage read failed", e);
        return null;
    }
}

function setPresetStorageItem(storageKey, value) {
    try {
        localStorage.setItem(storageKey, value);
        return true;
    } catch (e) {
        console.warn("Preset storage save failed", e);
        return false;
    }
}

function loadPresetJsonMap(storageKey) {
    try {
        const parsed = JSON.parse(getPresetStorageItem(storageKey) || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? Object.assign(Object.create(null), parsed)
            : Object.create(null);
    } catch (e) {
        console.debug("Preset storage data is invalid", e);
        return Object.create(null);
    }
}

function savePresetJsonMap(storageKey, map) {
    return setPresetStorageItem(storageKey, JSON.stringify(map));
}

function loadPresetSortMode() {
    const stored = getPresetStorageItem(PRESET_SORT_STORAGE_KEY) || "";
    return PRESET_SORT_MODES.has(stored) ? stored : "name";
}

function loadPresetFavoritesMode() {
    const stored = getPresetStorageItem(PRESET_FAVORITES_FIRST_STORAGE_KEY);
    if (stored === null) return "first";
    if (PRESET_FAVORITES_MODES.includes(stored)) return stored;
    // migrate the pre-tri-state boolean values
    return stored === "false" ? "all" : "first";
}

function nextPresetFavoritesMode(mode) {
    const index = PRESET_FAVORITES_MODES.indexOf(mode);
    return PRESET_FAVORITES_MODES[(index + 1) % PRESET_FAVORITES_MODES.length];
}

function isPresetFavorite(name) {
    return loadPresetJsonMap(PRESET_FAVORITES_STORAGE_KEY)[name] === true;
}

function togglePresetFavorite(name) {
    const favorites = loadPresetJsonMap(PRESET_FAVORITES_STORAGE_KEY);
    if (favorites[name]) {
        delete favorites[name];
    } else {
        favorites[name] = true;
    }
    savePresetJsonMap(PRESET_FAVORITES_STORAGE_KEY, favorites);
}

function getPresetLastUsed(name) {
    const value = loadPresetJsonMap(PRESET_LAST_USED_STORAGE_KEY)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function markPresetUsed(name) {
    const lastUsed = loadPresetJsonMap(PRESET_LAST_USED_STORAGE_KEY);
    lastUsed[name] = Date.now();
    savePresetJsonMap(PRESET_LAST_USED_STORAGE_KEY, lastUsed);
}

function setPresetsFavorite(names, favorite) {
    // one read/write for the whole selection instead of one per preset
    const favorites = loadPresetJsonMap(PRESET_FAVORITES_STORAGE_KEY);
    let changed = 0;
    for (const name of names || []) {
        if (favorite) {
            if (favorites[name] === true) continue;
            favorites[name] = true;
        } else {
            if (!favorites[name]) continue;
            delete favorites[name];
        }
        changed++;
    }
    if (changed) savePresetJsonMap(PRESET_FAVORITES_STORAGE_KEY, favorites);
    return changed;
}

function renamePresetLocalState(oldName, newName) {
    // group collapse state is keyed by model path, so only the name-keyed maps move
    for (const storageKey of [PRESET_FAVORITES_STORAGE_KEY, PRESET_LAST_USED_STORAGE_KEY]) {
        const map = loadPresetJsonMap(storageKey);
        if (!Object.prototype.hasOwnProperty.call(map, oldName)) continue;
        map[newName] = map[oldName];
        delete map[oldName];
        savePresetJsonMap(storageKey, map);
    }
}

function buildDuplicatePresetName(name, existingNames) {
    // Duck-typed rather than `instanceof Set`, which is false for a Set built in
    // another realm (an iframe/worker). The fallback copies any iterable, so
    // arrays and iterators keep working, and ignores anything else rather than
    // letting `new Set()` throw on it.
    const taken = existingNames && typeof existingNames.has === "function" && typeof existingNames.size === "number"
        ? existingNames
        : new Set(
            existingNames && typeof existingNames[Symbol.iterator] === "function" ? existingNames : []
        );
    // Compared case-insensitively because presets are stored as "<name>.json" and
    // POST /api/presets defaults to overwrite: on Windows/macOS "Foo copy" and
    // "foo copy" are the same file, so a case-sensitive check handed back a name
    // that silently clobbered an existing preset. Folding is best-effort — a
    // duck-typed `taken` that is not iterable still gets the exact-match check.
    const folded = new Set();
    if (taken && typeof taken[Symbol.iterator] === "function") {
        for (const existing of taken) folded.add(String(existing).toLowerCase());
    }
    const isTaken = (candidate) => taken.has(candidate) || folded.has(candidate.toLowerCase());

    const base = `${name} copy`;
    if (!isTaken(base)) return base;
    let suffix = 2;
    while (isTaken(`${base} ${suffix}`)) suffix++;
    return `${base} ${suffix}`;
}

function prunePresetLocalState(existingNames) {
    for (const storageKey of [PRESET_FAVORITES_STORAGE_KEY, PRESET_LAST_USED_STORAGE_KEY]) {
        const map = loadPresetJsonMap(storageKey);
        let changed = false;
        for (const name of Object.keys(map)) {
            if (!existingNames.has(name)) {
                delete map[name];
                changed = true;
            }
        }
        if (changed) savePresetJsonMap(storageKey, map);
    }
}

function getModelQuantLabel(modelLabel) {
    const match = String(modelLabel || "").replace(/\.gguf$/i, "")
        .match(/(?:i1-|UD-)?(?:I?Q\d[_A-Za-z0-9]*|f16|bf16|f32)$/i);
    return match ? match[0] : "";
}

function getPresetGroupKey(model) {
    const normalized = String(model || "").trim();
    return normalized || NO_MODEL_PRESET_GROUP_KEY;
}

function getPresetGroupLabel(groupKey) {
    if (groupKey === NO_MODEL_PRESET_GROUP_KEY) {
        return "No model saved";
    }

    const parts = String(groupKey).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : groupKey;
}

function loadPresetGroupState() {
    try {
        const raw = getPresetStorageItem(PRESET_GROUP_STATE_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        console.debug("Preset group state is invalid", e);
        return {};
    }
}

function savePresetGroupState(state) {
    setPresetStorageItem(PRESET_GROUP_STATE_STORAGE_KEY, JSON.stringify(state));
}

function isPresetGroupCollapsed(groupKey) {
    return loadPresetGroupState()[groupKey] !== false;
}

function setPresetGroupCollapsed(groupKey, collapsed) {
    const state = loadPresetGroupState();
    state[groupKey] = Boolean(collapsed);
    savePresetGroupState(state);
}

// A preset is findable by what it actually changes, not just by its name and
// model. Only non-default flags are folded in, so "ctx" returns the presets that
// tuned the context window rather than every preset that has the flag.
function buildPresetSearchText(entry) {
    const parts = [
        entry.name,
        entry.groupKey === NO_MODEL_PRESET_GROUP_KEY ? "no model saved" : entry.groupKey,
        entry.modelLabel,
        entry.toolText,
    ];

    for (const flagId of entry.overrideFlagIds || []) {
        // Three forms, because none of them subsumes the others: the raw id
        // matches "ctx" against ctx_size, the label matches "context window",
        // and the de-underscored id matches "ctx size", which neither of the
        // other two contains.
        parts.push(flagId, String(flagId).replace(/_/g, " "), getPresetFlagLabel(flagId));
    }

    return parts.join(" ").toLowerCase();
}

// Reads the text precomputed once per render in buildPresetGroups rather than
// rebuilding it per entry on every keystroke. The fallback keeps the function
// correct for any entry built outside that path.
function getPresetSearchText(entry) {
    return typeof entry.searchText === "string" ? entry.searchText : buildPresetSearchText(entry);
}

function presetValuesEqual(left, right) {
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => presetValuesEqual(value, right[index]));
    }
    return left === right;
}

function getNonDefaultPresetFlagIds(presetData) {
    const flags = (presetData && presetData.flags) || {};
    const definitions = Array.isArray(window.FLAGS)
        ? window.FLAGS
        : (typeof FLAGS !== "undefined" && Array.isArray(FLAGS) ? FLAGS : []);
    const defaults = new Map(
        definitions
            .filter((flag) => flag && flag.id && Object.prototype.hasOwnProperty.call(flag, "default"))
            .map((flag) => [flag.id, flag.default])
    );
    return Object.keys(flags).filter((flagId) => (
        !defaults.has(flagId) || !presetValuesEqual(flags[flagId], defaults.get(flagId))
    ));
}

function buildPresetGroups(presets) {
    const groupsByKey = new Map();
    // Resolved once per render rather than once per preset.
    const knownModelNames = getKnownModelNames();

    for (const preset of presets) {
        const presetData = normalizePresetData(preset.data);
        const groupKey = getPresetGroupKey(presetData.model);
        const warnings = getPresetWarnings(presetData, knownModelNames);
        const overrideFlagIds = getNonDefaultPresetFlagIds(presetData);
        const entry = {
            name: preset.name,
            data: presetData,
            groupKey,
            modelLabel: getPresetGroupLabel(groupKey),
            toolText: presetData.tool || "Keep current tool",
            overrideFlagIds,
            overrideCount: overrideFlagIds.length,
            warnings,
            modelMissing: isPresetModelMissing(presetData.model, knownModelNames),
            // backend sends epoch seconds; convert to ms to match Date.now()
            created: typeof preset.created === "number" ? preset.created * 1000 : 0,
            lastUsed: getPresetLastUsed(preset.name),
            favorite: isPresetFavorite(preset.name),
        };
        // Built once here, not once per entry per keystroke in the filter below.
        entry.searchText = buildPresetSearchText(entry);

        if (!groupsByKey.has(groupKey)) {
            groupsByKey.set(groupKey, {
                key: groupKey,
                label: entry.modelLabel,
                modelPath: groupKey === NO_MODEL_PRESET_GROUP_KEY ? "" : groupKey,
                entries: [],
            });
        }

        groupsByKey.get(groupKey).entries.push(entry);
    }

    const query = presetSearchQuery.trim().toLowerCase();
    const favoritesEmphasized = presetFavoritesMode !== "all";
    const compareEntries = (a, b) => {
        if (favoritesEmphasized && a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        if (presetSortMode === "recent" && b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed;
        if (presetSortMode === "added" && b.created !== a.created) return b.created - a.created;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    };
    const groups = Array.from(groupsByKey.values()).map((group) => {
        const entries = group.entries
            .filter((entry) => !query || getPresetSearchText(entry).includes(query))
            .filter((entry) => !presetWarningFilterActive || entry.warnings.length > 0)
            .filter((entry) => presetFavoritesMode !== "only" || entry.favorite)
            .sort(compareEntries);
        return {
            ...group,
            entries,
            hasFavorite: entries.some((entry) => entry.favorite),
            visibleWarningCount: entries.reduce((count, entry) => count + entry.warnings.length, 0),
            sortValue: entries.reduce(
                (best, entry) => Math.max(best, presetSortMode === "recent" ? entry.lastUsed : entry.created),
                0
            ),
        };
    }).filter((group) => group.entries.length > 0);

    groups.sort((a, b) => {
        if (a.key === NO_MODEL_PRESET_GROUP_KEY) return 1;
        if (b.key === NO_MODEL_PRESET_GROUP_KEY) return -1;
        if (favoritesEmphasized && a.hasFavorite !== b.hasFavorite) return a.hasFavorite ? -1 : 1;
        if (presetSortMode !== "name" && b.sortValue !== a.sortValue) return b.sortValue - a.sortValue;
        return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });

    return groups;
}

function createPresetButton(label, className, onClick, title = "") {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.textContent = label;
    if (title) button.title = title;
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return button;
}

function getVisiblePresetEntries() {
    return currentPresetGroups.flatMap((group) => group.entries);
}

function findVisiblePresetEntry(name) {
    return getVisiblePresetEntries().find((entry) => entry.name === name) || null;
}

function getPresetFlagDefinitions() {
    return Array.isArray(window.FLAGS)
        ? window.FLAGS
        : (typeof FLAGS !== "undefined" && Array.isArray(FLAGS) ? FLAGS : []);
}

let presetFlagLabelCache = null;
let presetFlagLabelCacheSource = null;

// This was a linear scan of ~150 definitions per call. Harmless for the handful
// of chips in the detail panel, but the search text asks for a label per
// override per preset, which turns it into a five-figure scan on every render
// of a large library. Cached on the definitions array identity, so a reloaded
// or replaced FLAGS rebuilds the map instead of serving stale labels.
function getPresetFlagLabelMap() {
    const definitions = getPresetFlagDefinitions();
    if (presetFlagLabelCacheSource !== definitions) {
        presetFlagLabelCache = new Map(
            definitions
                .filter((flag) => flag && flag.id)
                .map((flag) => [flag.id, flag.label || ""])
        );
        presetFlagLabelCacheSource = definitions;
    }
    return presetFlagLabelCache;
}

function getPresetFlagLabel(flagId) {
    return getPresetFlagLabelMap().get(flagId) || String(flagId).replace(/_/g, " ");
}

function getNotablePresetSettings(presetData, overrideFlagIds = getNonDefaultPresetFlagIds(presetData)) {
    const flags = (presetData && presetData.flags) || {};
    const overrides = new Set(overrideFlagIds);
    const notableIds = [
        "ctx_size",
        "gpu_layers",
        "chat_template",
        "chat_template_custom",
        "temperature",
        "top_k",
        "top_p",
        "min_p",
        "repeat_penalty",
    ];
    const settings = [];

    for (const id of notableIds) {
        if (overrides.has(id) && flags[id] !== "" && flags[id] !== null && flags[id] !== undefined) {
            settings.push({ label: getPresetFlagLabel(id), value: String(flags[id]) });
        }
    }

    if (overrides.has("custom_args") && typeof flags.custom_args === "string" && flags.custom_args.trim()) {
        settings.push({ label: "Custom Args", value: "present" });
    }

    return settings;
}

const PRESET_ICON_WARNING = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';
const PRESET_ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const PRESET_ICON_CHEVRON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const PRESET_ICON_EMPTY = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>';
const PRESET_ICON_STAR = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
const PRESET_ICON_STAR_OUTLINE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';

function createPresetIcon(svgMarkup) {
    const wrap = document.createElement("span");
    wrap.style.display = "inline-flex";
    wrap.innerHTML = svgMarkup;
    return wrap.firstElementChild || wrap;
}

function appendDetailStat(container, label, value, valueClass = "") {
    const stat = document.createElement("div");
    stat.className = "preset-stat";

    const labelEl = document.createElement("div");
    labelEl.className = "preset-stat-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("div");
    valueEl.className = valueClass ? `preset-stat-value ${valueClass}` : "preset-stat-value";
    valueEl.textContent = value;

    stat.appendChild(labelEl);
    stat.appendChild(valueEl);
    container.appendChild(stat);
}

// Same wording as formatHistoryTime() in chat-ui.js, which is closure-private
// there. Kept as a local copy rather than widening that module's surface.
function formatPresetTimestamp(ts) {
    if (!ts) return "";
    const then = new Date(ts);
    const diffMin = Math.floor((Date.now() - then.getTime()) / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return then.toLocaleDateString();
}

function isPresetFilterActive() {
    return Boolean(presetSearchQuery.trim()) || presetWarningFilterActive || presetFavoritesMode === "only";
}

// Describes the presets currently visible rather than every preset on disk, so
// the numbers always agree with the list beside them and with the count line.
// Reading currentPresetGroups keeps this free of a second copy of library state.
function getPresetLibrarySummary() {
    const entries = getVisiblePresetEntries();
    const mostRecent = entries.reduce(
        (best, entry) => (entry.lastUsed && (!best || entry.lastUsed > best.lastUsed) ? entry : best),
        null
    );
    return {
        presetCount: entries.length,
        modelCount: currentPresetGroups.length,
        warningCount: entries.reduce((total, entry) => total + entry.warnings.length, 0),
        missingModelCount: entries.filter((entry) => entry.modelMissing).length,
        favoriteCount: entries.filter((entry) => entry.favorite).length,
        mostRecent,
        filtered: isPresetFilterActive(),
        // A zero missing-model count means "none found" only when the model list
        // actually loaded. With no list it means "not checked", and the two must
        // not read the same in the summary.
        modelsChecked: getKnownModelNames() !== null,
    };
}

// Health copy must never make a claim the counts underneath it cannot support.
// Two ways that goes wrong, both producing a false all-clear:
//   1. A filter narrows the view. Searching past the one preset with a deleted
//      GGUF would otherwise render "every preset loads cleanly" over hidden rot.
//   2. The model list never loaded. isPresetModelMissing() stays silent by
//      design when it has nothing to compare against, so a clean count there
//      means "not checked", not "checked and fine".
function getPresetHealthMessage(summary) {
    // Pointing at a filter that is already applied is dead advice.
    const review = presetWarningFilterActive ? "" : " Use the Warnings filter to review them.";
    const scopePrefix = summary.filtered ? "Of the presets shown, " : "";

    if (summary.missingModelCount > 0) {
        const count = summary.missingModelCount;
        const subject = count === 1 ? "1 preset points" : `${count} presets point`;
        return `${scopePrefix}${subject} at a model file that is no longer in the models folder.${review}`;
    }

    if (summary.warningCount > 0) {
        const count = summary.warningCount;
        const subject = `${count} warning${count === 1 ? "" : "s"}`;
        return summary.filtered
            ? `${subject} among the presets shown.${review}`
            : `${subject} across the library.${review}`;
    }

    // Clean, but model presence was never verified. Report the other warnings
    // honestly and say plainly which check did not run.
    if (!summary.modelsChecked) {
        return summary.filtered
            ? "No warnings among the presets shown. The model list has not loaded, so model files were not checked."
            : "No template or launch-argument warnings. The model list has not loaded, so model files were not checked.";
    }

    return summary.filtered
        ? "No warnings among the presets shown. Clear the search and filters to check the whole library."
        : "No warnings. Every preset points at a model that is present and loads cleanly.";
}

function renderPresetLibrarySummary(panel) {
    const summary = getPresetLibrarySummary();

    if (summary.presetCount === 0) {
        const empty = document.createElement("div");
        empty.className = "preset-detail-empty";
        empty.appendChild(createPresetIcon(PRESET_ICON_EMPTY));

        const emptyTitle = document.createElement("div");
        emptyTitle.className = "preset-detail-empty-title";
        emptyTitle.textContent = summary.filtered ? "No presets match" : "No presets saved yet";

        const emptyText = document.createElement("p");
        emptyText.textContent = summary.filtered
            ? "Clear the search or filters to see the rest of the library."
            : "Save a preset from Configure to keep a launch setup you can return to.";

        empty.appendChild(emptyTitle);
        empty.appendChild(emptyText);
        panel.appendChild(empty);
        return;
    }

    const kicker = document.createElement("div");
    kicker.className = "preset-detail-kicker";
    kicker.textContent = summary.filtered ? "Matching Presets" : "Preset Library";

    const title = document.createElement("div");
    title.className = "preset-detail-title";
    title.textContent = `${summary.presetCount} preset${summary.presetCount === 1 ? "" : "s"}`;

    const subtitle = document.createElement("div");
    subtitle.className = "preset-detail-subtitle";
    subtitle.textContent = summary.filtered
        ? "Filtered view. Clear the search and filters to summarize the whole library."
        : "Select a preset on the left to preview its saved model, tool, warnings, and settings.";

    const stats = document.createElement("div");
    stats.className = "preset-detail-stats";
    appendDetailStat(stats, "Models", String(summary.modelCount));
    appendDetailStat(stats, "Favorites", String(summary.favoriteCount));
    appendDetailStat(
        stats,
        "Warnings",
        String(summary.warningCount),
        summary.warningCount ? "warn" : "ok"
    );
    // An unchecked count must not render as a green zero, which reads as
    // "checked, none missing" — the same false all-clear as the health line.
    let missingModelClass = "";
    if (summary.modelsChecked) {
        missingModelClass = summary.missingModelCount ? "warn" : "ok";
    }
    appendDetailStat(
        stats,
        "Missing Models",
        summary.modelsChecked ? String(summary.missingModelCount) : "—",
        missingModelClass
    );

    panel.appendChild(kicker);
    panel.appendChild(title);
    panel.appendChild(subtitle);
    panel.appendChild(stats);

    const recentTitle = document.createElement("div");
    recentTitle.className = "preset-detail-section-title";
    recentTitle.textContent = "Most Recently Used";

    const recent = document.createElement("div");
    recent.className = "preset-detail-info preset-summary-block";
    const recentText = document.createElement("span");
    // textContent, never innerHTML: preset names are user-supplied.
    recentText.textContent = summary.mostRecent
        ? `${summary.mostRecent.name} · ${formatPresetTimestamp(summary.mostRecent.lastUsed)}`
        : "No preset loaded yet on this machine.";
    recent.appendChild(recentText);

    panel.appendChild(recentTitle);
    panel.appendChild(recent);

    const healthTitle = document.createElement("div");
    healthTitle.className = "preset-detail-section-title";
    // "Library Health" is an absolute claim, and the counts under it are not.
    healthTitle.textContent = summary.filtered ? "Health Of Presets Shown" : "Library Health";

    const health = document.createElement("div");
    const needsAttention = summary.warningCount > 0;
    health.className = needsAttention ? "preset-warning" : "preset-detail-note";
    health.appendChild(createPresetIcon(needsAttention ? PRESET_ICON_WARNING : PRESET_ICON_CHECK));
    const healthText = document.createElement("span");
    healthText.textContent = getPresetHealthMessage(summary);
    health.appendChild(healthText);

    panel.appendChild(healthTitle);
    panel.appendChild(health);
}

function renderPresetDetailPanel() {
    const panel = document.getElementById("preset-detail-panel");
    if (!panel) return;
    panel.textContent = "";

    const entry = findVisiblePresetEntry(selectedPresetName);
    if (!entry) {
        renderPresetLibrarySummary(panel);
        return;
    }

    const kicker = document.createElement("div");
    kicker.className = "preset-detail-kicker";
    kicker.textContent = "Selected Preset";

    const title = document.createElement("div");
    title.className = "preset-detail-title";
    title.textContent = entry.name;

    const subtitle = document.createElement("div");
    subtitle.className = "preset-detail-subtitle";
    subtitle.textContent = entry.groupKey === NO_MODEL_PRESET_GROUP_KEY ? "No model saved" : entry.groupKey;

    const actions = document.createElement("div");
    actions.className = "preset-detail-actions";
    actions.appendChild(createPresetButton("Load Preset", "btn btn-sm btn-primary", () => loadPreset(entry.name)));
    actions.appendChild(createPresetButton("Duplicate", "btn btn-sm", () => duplicatePreset(entry.name), "Save a copy of this preset without changing current settings"));
    actions.appendChild(createPresetButton("Rename", "btn btn-sm", () => renamePreset(entry.name), "Rename this preset, keeping its favorite and usage history"));
    actions.appendChild(createPresetButton("Update from Current", "btn btn-sm", () => updatePreset(entry.name), "Overwrite this preset with current Configure values"));
    actions.appendChild(createPresetButton("Export", "btn btn-sm", () => exportPreset(entry.name)));
    actions.appendChild(createPresetButton("Windows Shortcut", "btn btn-sm", () => exportPresetShortcut(entry.name), "Export a Windows .cmd shortcut for this preset"));

    const favoriteBtn = document.createElement("button");
    favoriteBtn.type = "button";
    favoriteBtn.className = entry.favorite ? "btn btn-sm preset-favorite-btn active" : "btn btn-sm preset-favorite-btn";
    favoriteBtn.title = entry.favorite ? "Remove from favorites" : "Add to favorites";
    favoriteBtn.setAttribute("aria-pressed", String(entry.favorite));
    favoriteBtn.appendChild(createPresetIcon(entry.favorite ? PRESET_ICON_STAR : PRESET_ICON_STAR_OUTLINE));
    favoriteBtn.appendChild(document.createTextNode(entry.favorite ? " Favorited" : " Favorite"));
    favoriteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePresetFavorite(entry.name);
        loadPresets();
    });
    actions.appendChild(favoriteBtn);

    const spacer = document.createElement("span");
    spacer.className = "preset-detail-actions-spacer";
    actions.appendChild(spacer);
    actions.appendChild(createPresetButton("Delete", "btn btn-sm btn-danger", () => deletePreset(entry.name)));

    const stats = document.createElement("div");
    stats.className = "preset-detail-stats";
    appendDetailStat(stats, "Tool", entry.toolText);
    appendDetailStat(stats, "Non-default Overrides", String(entry.overrideCount));
    const quant = getModelQuantLabel(entry.modelLabel);
    if (quant) {
        appendDetailStat(stats, "Quant", quant);
    }
    appendDetailStat(stats, "Warnings", String(entry.warnings.length), entry.warnings.length ? "warn" : "ok");

    const settingsTitle = document.createElement("div");
    settingsTitle.className = "preset-detail-section-title";
    settingsTitle.textContent = "Notable Settings";

    const settings = document.createElement("div");
    settings.className = "preset-flag-chips";
    const notable = getNotablePresetSettings(entry.data, entry.overrideFlagIds);
    for (const item of notable) {
        const chip = document.createElement("span");
        chip.className = "preset-flag-chip";
        const labelEl = document.createElement("b");
        labelEl.textContent = item.label;
        chip.appendChild(labelEl);
        chip.appendChild(document.createTextNode(` ${item.value}`));
        settings.appendChild(chip);
    }
    const remaining = Math.max(entry.overrideCount - notable.length, 0);
    if (remaining > 0) {
        const moreChip = document.createElement("span");
        moreChip.className = "preset-flag-chip more";
        moreChip.textContent = `+ ${remaining} more override${remaining === 1 ? "" : "s"}`;
        settings.appendChild(moreChip);
    }

    const warningsTitle = document.createElement("div");
    warningsTitle.className = "preset-detail-section-title";
    warningsTitle.textContent = "Warnings";

    const warnings = document.createElement("div");
    warnings.className = entry.warnings.length ? "preset-warning" : "preset-detail-note";
    warnings.appendChild(createPresetIcon(entry.warnings.length ? PRESET_ICON_WARNING : PRESET_ICON_CHECK));
    const warningsText = document.createElement("span");
    warningsText.textContent = entry.warnings.length
        ? entry.warnings.join(" ")
        : "No preset warnings. This preset should load cleanly into Configure and Quick Launch.";
    warnings.appendChild(warningsText);

    panel.appendChild(kicker);
    panel.appendChild(title);
    panel.appendChild(subtitle);
    panel.appendChild(actions);
    panel.appendChild(stats);
    panel.appendChild(settingsTitle);
    panel.appendChild(settings);
    panel.appendChild(warningsTitle);
    panel.appendChild(warnings);
}

function renderPresetBulkControls() {
    const countEl = document.getElementById("presets-selection-count");
    const deleteButton = document.getElementById("btn-presets-delete-selected");
    const exportButton = document.getElementById("btn-presets-export-selected");
    const clearButton = document.getElementById("btn-presets-select-none");
    const favoriteButton = document.getElementById("btn-presets-favorite-selected");
    const unfavoriteButton = document.getElementById("btn-presets-unfavorite-selected");
    const browser = document.getElementById("presets-browser");
    const visibleNames = new Set(getVisiblePresetEntries().map((entry) => entry.name));
    let visibleSelectedCount = 0;

    for (const name of selectedPresetNames) {
        if (visibleNames.has(name)) visibleSelectedCount++;
    }

    if (countEl) {
        countEl.textContent = `${visibleSelectedCount} selected`;
    }
    if (deleteButton) {
        deleteButton.disabled = selectedPresetNames.size === 0;
    }
    if (exportButton) {
        exportButton.disabled = selectedPresetNames.size === 0;
    }
    if (clearButton) {
        clearButton.disabled = selectedPresetNames.size === 0;
    }
    if (favoriteButton) {
        favoriteButton.disabled = selectedPresetNames.size === 0;
    }
    if (unfavoriteButton) {
        unfavoriteButton.disabled = selectedPresetNames.size === 0;
    }
    if (browser) {
        browser.classList.toggle("has-checked", selectedPresetNames.size > 0);
    }
}

function renderPresetCountLine() {
    const countLine = document.getElementById("presets-count-line");
    if (!countLine) return;
    const presetCount = getVisiblePresetEntries().length;
    const modelCount = currentPresetGroups.length;
    countLine.textContent = `${presetCount} preset${presetCount === 1 ? "" : "s"} · ${modelCount} model${modelCount === 1 ? "" : "s"}`;
}

function renderPresetAuxiliaryPanels() {
    renderPresetDetailPanel();
    renderPresetBulkControls();
    renderPresetCountLine();
}

function renderPresetLoadErrorState() {
    const panel = document.getElementById("preset-detail-panel");
    if (panel) {
        panel.textContent = "";
        const error = document.createElement("div");
        error.className = "preset-detail-empty presets-error";
        error.textContent = "Preset library unavailable. Try refreshing the list.";
        panel.appendChild(error);
    }
    renderPresetBulkControls();
    renderPresetCountLine();
}

function selectPresetEntry(name) {
    selectedPresetName = String(name || "");
    // searching force-expands groups, so a selection made from search results would be
    // hidden again once the query is cleared unless its group is expanded for real
    const entry = findVisiblePresetEntry(selectedPresetName);
    if (entry && isPresetGroupCollapsed(entry.groupKey)) {
        setPresetGroupCollapsed(entry.groupKey, false);
    }
    renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
}

function setPresetChecked(name, checked) {
    if (checked) {
        selectedPresetNames.add(name);
    } else {
        selectedPresetNames.delete(name);
    }
    renderPresetBulkControls();
}

function renderPresetEntry(entry) {
    const el = document.createElement("div");
    el.className = "preset-item";
    if (entry.name === selectedPresetName) {
        el.classList.add("selected");
    }
    // Identity for the roving focus sequence, which has to survive the full
    // re-render that selecting, favoriting, or filtering triggers.
    el.setAttribute("data-preset-name", entry.name);
    // Overwritten by applyPresetRovingTabIndex; only the current row keeps 0.
    el.tabIndex = -1;
    el.setAttribute("role", "button");
    el.setAttribute("aria-pressed", String(entry.name === selectedPresetName));
    el.addEventListener("click", () => selectPresetEntry(entry.name));
    el.addEventListener("keydown", (event) => {
        // Only when the row itself has focus. Keydown from the checkbox, the
        // favorite toggle, or Load bubbles up here, and preventDefault would
        // swallow Space on the checkbox and double-fire Enter on the buttons.
        if (event.target !== el) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectPresetEntry(entry.name);
        }
    });

    const checkWrap = document.createElement("label");
    checkWrap.className = "preset-checkbox";
    checkWrap.title = "Select this preset for bulk actions";
    checkWrap.addEventListener("click", (event) => event.stopPropagation());

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPresetNames.has(entry.name);
    checkbox.setAttribute("aria-label", `Select preset ${entry.name}`);
    checkbox.addEventListener("change", () => setPresetChecked(entry.name, checkbox.checked));
    checkWrap.appendChild(checkbox);

    const details = document.createElement("div");
    details.className = "preset-details";

    const titleRow = document.createElement("div");
    titleRow.className = "preset-title-row";

    const nameEl = document.createElement("div");
    nameEl.className = "preset-name";
    nameEl.textContent = entry.name;
    nameEl.title = entry.name;
    titleRow.appendChild(nameEl);

    if (entry.favorite) el.classList.add("preset-item-favorite");

    const metaEl = document.createElement("div");
    metaEl.className = "preset-meta";
    metaEl.textContent = `${entry.toolText} · ${entry.overrideCount} override${entry.overrideCount === 1 ? "" : "s"}`;

    details.appendChild(titleRow);
    details.appendChild(metaEl);

    el.appendChild(checkWrap);
    el.appendChild(details);

    if (entry.warnings.length > 0) {
        const warnIcon = createPresetIcon(PRESET_ICON_WARNING);
        const warnWrap = document.createElement("span");
        warnWrap.className = "preset-row-warn";
        warnWrap.title = entry.warnings.join(" ");
        warnWrap.appendChild(warnIcon);
        el.appendChild(warnWrap);
    }

    const rowFavorite = document.createElement("button");
    rowFavorite.type = "button";
    rowFavorite.className = entry.favorite ? "preset-row-favorite active" : "preset-row-favorite";
    rowFavorite.title = entry.favorite ? "Remove from favorites" : "Add to favorites";
    rowFavorite.setAttribute("aria-label", `${entry.favorite ? "Remove" : "Add"} ${entry.name} ${entry.favorite ? "from" : "to"} favorites`);
    rowFavorite.setAttribute("aria-pressed", String(entry.favorite));
    rowFavorite.appendChild(createPresetIcon(entry.favorite ? PRESET_ICON_STAR : PRESET_ICON_STAR_OUTLINE));
    rowFavorite.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePresetFavorite(entry.name);
        loadPresets();
    });
    el.appendChild(rowFavorite);

    el.appendChild(createPresetButton("Load", "btn btn-sm btn-primary preset-row-load", () => loadPreset(entry.name)));
    return el;
}

// --- Roving focus -----------------------------------------------------------
// The browser list is one composite widget rather than a few hundred tab stops.
// A 58-preset library across 33 groups is 33 header buttons plus 58 rows each
// carrying a checkbox, a favorite toggle, and a Load button: 265 stops to cross.
// With roving tabindex it is one stop to enter, then Up/Down between items and
// Tab straight back out.
//
// The sequence is group headers plus the rows of expanded groups, in DOM order.
// Rows inside a collapsed group are display:none, so they are skipped entirely.
// Only the current item is reachable by Tab; its inner controls are restored to
// the tab order with it, so Tab still reaches the focused row's own buttons and
// then leaves the list.

let presetRovingKey = "";

function getPresetFocusItemKey(el) {
    if (!el || typeof el.getAttribute !== "function") return "";
    const presetName = el.getAttribute("data-preset-name");
    if (presetName !== null && presetName !== undefined) return `row:${presetName}`;
    const groupKey = el.getAttribute("data-group-key");
    if (groupKey !== null && groupKey !== undefined) return `group:${groupKey}`;
    return "";
}

function getPresetFocusItems(container) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    const items = [];
    for (const group of Array.from(container.querySelectorAll(".preset-group"))) {
        const header = group.querySelector(".preset-group-header");
        if (header) items.push(header);
        // Collapsed groups hide their list, so their rows are not focusable.
        if (group.classList && group.classList.contains("collapsed")) continue;
        items.push(...Array.from(group.querySelectorAll(".preset-item")));
    }
    return items;
}

function isPresetRowElement(el) {
    return Boolean(el && el.classList && el.classList.contains("preset-item"));
}

function setPresetFocusItemTabIndex(el, isCurrent) {
    el.tabIndex = isCurrent ? 0 : -1;
    if (!isPresetRowElement(el) || typeof el.querySelectorAll !== "function") return;
    // A row's checkbox, favorite toggle, and Load button ride with it. Left at
    // their default they would each stay a tab stop on all 58 rows, which is
    // where the bulk of the 265 came from.
    for (const control of Array.from(el.querySelectorAll("input, button"))) {
        control.tabIndex = isCurrent ? 0 : -1;
    }
}

function applyPresetRovingTabIndex(container, focusCurrent = false) {
    const items = getPresetFocusItems(container);
    if (items.length === 0) return null;

    let current = items.find((el) => getPresetFocusItemKey(el) === presetRovingKey);
    if (!current) {
        // Prefer the selected preset so keyboard focus starts where the user
        // last was, rather than snapping to the top of the library.
        current = items.find((el) => el.getAttribute("data-preset-name") === selectedPresetName)
            || items[0];
    }
    presetRovingKey = getPresetFocusItemKey(current);

    for (const el of items) {
        setPresetFocusItemTabIndex(el, el === current);
    }

    if (focusCurrent && typeof current.focus === "function") {
        current.focus();
    }
    return current;
}

function movePresetRovingFocus(container, delta, absolute = "") {
    const items = getPresetFocusItems(container);
    if (items.length === 0) return;

    const currentIndex = items.findIndex((el) => getPresetFocusItemKey(el) === presetRovingKey);
    let nextIndex;
    if (absolute === "first") {
        nextIndex = 0;
    } else if (absolute === "last") {
        nextIndex = items.length - 1;
    } else {
        // Clamped rather than wrapping: silently jumping from the last preset
        // back to the first is disorienting across a library this long.
        const from = currentIndex === -1 ? 0 : currentIndex;
        nextIndex = Math.min(Math.max(from + delta, 0), items.length - 1);
    }

    presetRovingKey = getPresetFocusItemKey(items[nextIndex]);
    applyPresetRovingTabIndex(container, true);
}

function presetListHasFocus(container) {
    if (!container || typeof container.contains !== "function") return false;
    if (typeof document === "undefined") return false;
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    return container.contains(active);
}

function syncPresetRovingToFocus(container, target) {
    const items = getPresetFocusItems(container);
    const item = items.find((el) => (
        el === target || (typeof el.contains === "function" && el.contains(target))
    ));
    if (!item) return;
    const key = getPresetFocusItemKey(item);
    if (!key || key === presetRovingKey) return;
    presetRovingKey = key;
    applyPresetRovingTabIndex(container);
}

function initPresetRovingFocus(container) {
    // Bound once on the container, which outlives the rows it is rebuilt with.
    if (!container || container.__presetRovingBound) return;
    container.__presetRovingBound = true;

    // Arrow keys are not the only way focus lands on an item: a mouse click, a
    // Tab from outside, or a programmatic focus() all bypass them. Without this
    // the roving key keeps pointing at wherever the keyboard last was, so the
    // next Up/Down jumps away from the row the user just clicked.
    container.addEventListener("focusin", (event) => {
        syncPresetRovingToFocus(container, event.target);
    });

    container.addEventListener("keydown", (event) => {
        // Leave shortcuts alone, and never swallow Enter or Space: row
        // selection and the header collapse buttons still own those.
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

        let handled = true;
        switch (event.key) {
            case "ArrowDown":
                movePresetRovingFocus(container, 1);
                break;
            case "ArrowUp":
                movePresetRovingFocus(container, -1);
                break;
            case "Home":
                movePresetRovingFocus(container, 0, "first");
                break;
            case "End":
                movePresetRovingFocus(container, 0, "last");
                break;
            default:
                handled = false;
        }

        if (handled) {
            // Otherwise Up/Down scroll the list out from under the focus.
            event.preventDefault();
        }
    });
}

function renderPresetGroups(container, groups) {
    // Selecting, favoriting, or filtering rebuilds every row, which would drop
    // keyboard focus to the body mid-navigation. Restored below, but only when
    // focus was inside the list to begin with, so a background re-render never
    // steals it from elsewhere on the page.
    const restoreFocus = presetListHasFocus(container);
    container.textContent = "";

    if (groups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "presets-empty";
        empty.textContent = presetSearchQuery
            ? "No presets match your search."
            : presetWarningFilterActive
                ? "No presets with warnings."
                : presetFavoritesMode === "only"
                    ? "No favorite presets yet. Star a preset to keep it here."
                    : "No saved presets yet. Save the current configuration above or import a JSON preset file.";
        container.appendChild(empty);
        renderPresetAuxiliaryPanels();
        return;
    }

    // when searching or filtering, force groups open so matches are visible
    const forceExpanded = Boolean(presetSearchQuery.trim())
        || presetWarningFilterActive
        || presetFavoritesMode === "only";

    for (const group of groups) {
        const groupEl = document.createElement("section");
        groupEl.className = "preset-group";
        const collapsed = !forceExpanded && isPresetGroupCollapsed(group.key);
        if (collapsed) groupEl.classList.add("collapsed");

        const header = document.createElement("button");
        header.className = "preset-group-header";
        header.type = "button";
        header.setAttribute("data-group-key", group.key);
        header.setAttribute("aria-expanded", String(!collapsed));
        header.title = group.modelPath && group.modelPath !== group.label ? group.modelPath : group.label;

        const chevron = document.createElement("span");
        chevron.className = "preset-group-chevron";
        chevron.appendChild(createPresetIcon(PRESET_ICON_CHEVRON));

        const title = document.createElement("span");
        title.className = "preset-group-title";
        const titleText = document.createElement("bdo");
        titleText.textContent = group.label.replace(/\.gguf$/i, "");
        title.appendChild(titleText);

        header.appendChild(chevron);
        header.appendChild(title);

        if (group.visibleWarningCount > 0) {
            const warnDot = document.createElement("span");
            warnDot.className = "preset-warn-dot";
            warnDot.title = `${group.visibleWarningCount} warning${group.visibleWarningCount === 1 ? "" : "s"}`;
            header.appendChild(warnDot);
        }

        const quant = getModelQuantLabel(group.label);
        if (quant) {
            const quantBadge = document.createElement("span");
            quantBadge.className = "preset-quant-badge";
            quantBadge.textContent = quant;
            header.appendChild(quantBadge);
        }

        const countBadge = document.createElement("span");
        countBadge.className = "preset-count-badge";
        countBadge.textContent = String(group.entries.length);
        countBadge.title = `${group.entries.length} preset${group.entries.length === 1 ? "" : "s"}`;
        header.appendChild(countBadge);

        header.addEventListener("click", () => {
            const nextCollapsed = !groupEl.classList.contains("collapsed");
            groupEl.classList.toggle("collapsed", nextCollapsed);
            header.setAttribute("aria-expanded", String(!nextCollapsed));
            setPresetGroupCollapsed(group.key, nextCollapsed);
            // Collapsing removes this group's rows from the focus sequence, and
            // expanding adds them back, so the roving state has to be rebuilt.
            // Anchoring on the header keeps focus where the user just acted,
            // rather than stranding it on a row that no longer exists.
            presetRovingKey = getPresetFocusItemKey(header);
            applyPresetRovingTabIndex(container);
        });

        const list = document.createElement("div");
        list.className = "preset-group-list";
        for (const entry of group.entries) {
            list.appendChild(renderPresetEntry(entry));
        }

        groupEl.appendChild(header);
        groupEl.appendChild(list);
        container.appendChild(groupEl);
    }

    initPresetRovingFocus(container);
    applyPresetRovingTabIndex(container, restoreFocus);

    renderPresetAuxiliaryPanels();
}

function showPresetStatus(message, type = "success", durationMs = 2200) {
    const statusEl = document.getElementById("preset-status");
    if (!statusEl) return;
    if (presetStatusTimer) {
        clearTimeout(presetStatusTimer);
        presetStatusTimer = null;
    }
    statusEl.className = "status-box";
    statusEl.classList.add(type);
    statusEl.textContent = message;
    presetStatusTimer = setTimeout(() => {
        statusEl.className = "status-box";
        statusEl.textContent = "";
        presetStatusTimer = null;
    }, durationMs);
}

// Missing-model warnings are computed at build time from the cached model list,
// so a model list that changes after the groups were built leaves the badges,
// the Warnings filter, and the summary stale. loadPresets() already runs on
// every switch into the tab, which covers the user who arrives afterwards; this
// covers the two cases where the list moves while the tab is already open:
// a download finishing in the background, and the startup refreshModels() that
// resolves after a fast click into Presets.
//
// Guarded on the section rather than #presets-list, which is static markup in
// index.html and therefore always present — testing for it would rebuild on
// every model refresh, including for users who never open the tab.
function refreshModelPresence() {
    const section = document.getElementById("section-presets");
    if (!section || section.style.display === "none") return;
    loadPresets();
}

async function loadPresets() {
    const requestId = ++loadPresetsRequestId;
    const container = document.getElementById("presets-list");
    if (!container) return;
    container.textContent = "";
    try {
        const presets = await fetchPresetEntries();
        if (requestId !== loadPresetsRequestId) return;
        prunePresetLocalState(new Set(presets.map((preset) => preset.name)));
        currentPresetGroups = buildPresetGroups(presets);
        const visibleEntries = getVisiblePresetEntries();
        const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
        selectedPresetNames = new Set(Array.from(selectedPresetNames).filter((name) => visibleNames.has(name)));
        if (!visibleNames.has(selectedPresetName)) {
            selectedPresetName = "";
        }
        renderPresetGroups(container, currentPresetGroups);
    } catch (e) {
        if (requestId !== loadPresetsRequestId) return;
        currentPresetGroups = [];
        selectedPresetName = "";
        selectedPresetNames.clear();
        const error = document.createElement("div");
        error.className = "presets-empty presets-error";
        error.textContent = "Failed to load presets.";
        container.appendChild(error);
        renderPresetLoadErrorState();
    }
}

function initPresetLibraryControls() {
    const search = document.getElementById("preset-search");
    if (search) {
        search.addEventListener("input", () => {
            presetSearchQuery = search.value.trim();
            loadPresets();
        });
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && search.value) {
                search.value = "";
                presetSearchQuery = "";
                loadPresets();
            }
        });
    }

    const sortSelect = document.getElementById("preset-sort");
    if (sortSelect) {
        sortSelect.value = presetSortMode;
        sortSelect.addEventListener("change", () => {
            presetSortMode = PRESET_SORT_MODES.has(sortSelect.value) ? sortSelect.value : "name";
            setPresetStorageItem(PRESET_SORT_STORAGE_KEY, presetSortMode);
            loadPresets();
        });
    }

    const expandAll = document.getElementById("btn-presets-expand-all");
    if (expandAll) {
        expandAll.addEventListener("click", () => {
            const state = loadPresetGroupState();
            for (const group of currentPresetGroups) {
                state[group.key] = false;
            }
            savePresetGroupState(state);
            loadPresets();
        });
    }

    const collapseAll = document.getElementById("btn-presets-collapse-all");
    if (collapseAll) {
        collapseAll.addEventListener("click", () => {
            const state = loadPresetGroupState();
            for (const group of currentPresetGroups) {
                state[group.key] = true;
            }
            savePresetGroupState(state);
            loadPresets();
        });
    }

    const selectAll = document.getElementById("btn-presets-select-all");
    if (selectAll) {
        selectAll.addEventListener("click", () => {
            for (const entry of getVisiblePresetEntries()) {
                selectedPresetNames.add(entry.name);
            }
            renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
        });
    }

    const selectNone = document.getElementById("btn-presets-select-none");
    if (selectNone) {
        selectNone.addEventListener("click", () => {
            selectedPresetNames.clear();
            renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
        });
    }

    const deleteSelected = document.getElementById("btn-presets-delete-selected");
    if (deleteSelected) {
        deleteSelected.addEventListener("click", deleteSelectedPresets);
    }

    const favoriteSelected = document.getElementById("btn-presets-favorite-selected");
    if (favoriteSelected) {
        favoriteSelected.addEventListener("click", () => favoriteSelectedPresets(true));
    }

    const unfavoriteSelected = document.getElementById("btn-presets-unfavorite-selected");
    if (unfavoriteSelected) {
        unfavoriteSelected.addEventListener("click", () => favoriteSelectedPresets(false));
    }

    const exportSelected = document.getElementById("btn-presets-export-selected");
    if (exportSelected) {
        exportSelected.addEventListener("click", exportSelectedPresets);
    }

    const filterAll = document.getElementById("preset-filter-all");
    const filterWarnings = document.getElementById("preset-filter-warnings");
    const favoritesFirst = document.getElementById("preset-favorites-first");
    const setWarningFilter = (active) => {
        presetWarningFilterActive = active;
        if (filterAll) filterAll.classList.toggle("active", !active);
        if (filterWarnings) filterWarnings.classList.toggle("active", active);
        loadPresets();
    };
    if (filterAll) {
        filterAll.addEventListener("click", () => setWarningFilter(false));
    }
    if (filterWarnings) {
        filterWarnings.addEventListener("click", () => setWarningFilter(!presetWarningFilterActive));
    }
    if (favoritesFirst) {
        const favoritesLabels = {
            all: { text: "★ Favorites", title: "Click to keep favorite presets and model groups above other results" },
            first: { text: "★ Favorites first", title: "Favorites are sorted first. Click to show only favorites" },
            only: { text: "★ Favorites only", title: "Showing only favorites. Click to show all presets" },
        };
        const renderFavoritesChip = () => {
            const label = favoritesLabels[presetFavoritesMode] || favoritesLabels.all;
            favoritesFirst.textContent = label.text;
            favoritesFirst.title = label.title;
            favoritesFirst.classList.toggle("active", presetFavoritesMode !== "all");
            favoritesFirst.classList.toggle("preset-chip-favorite-only", presetFavoritesMode === "only");
            favoritesFirst.setAttribute("aria-pressed", String(presetFavoritesMode !== "all"));
        };
        renderFavoritesChip();
        favoritesFirst.addEventListener("click", () => {
            presetFavoritesMode = nextPresetFavoritesMode(presetFavoritesMode);
            renderFavoritesChip();
            setPresetStorageItem(PRESET_FAVORITES_FIRST_STORAGE_KEY, presetFavoritesMode);
            loadPresets();
        });
    }
}

async function savePreset() {
    const nameInput = document.getElementById("preset-name-input");
    const name = nameInput.value.trim();
    if (!name) {
        nameInput.style.borderColor = "var(--red)";
        setTimeout(() => nameInput.style.borderColor = "", 1500);
        return;
    }
    try {
        const data = buildCurrentPresetData();
        const result = await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
        });
        if (result.saved) {
            nameInput.value = "";
            loadPresets();
            showPresetStatus(`Saved preset \"${result.name || name}\"`, "success");
        }
    } catch (e) {
        const message = e && e.message === SENSITIVE_CUSTOM_ARG_MESSAGE
            ? SENSITIVE_CUSTOM_ARG_MESSAGE
            : "Failed to save preset";
        showPresetStatus(message, "error", 5000);
        console.warn("Failed to save preset", e);
    }
}

async function updatePreset(name) {
    const ok = await confirmAction(
        "Update Preset",
        `Overwrite preset "${name}" with current Configure settings?`,
        "Update"
    );
    if (!ok) return;

    try {
        const data = buildCurrentPresetData();
        const result = await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
        });
        if (result.saved) {
            loadPresets();
            showPresetStatus(`Updated preset \"${name}\"`, "success");
        }
    } catch (e) {
        const message = e && e.message === SENSITIVE_CUSTOM_ARG_MESSAGE
            ? SENSITIVE_CUSTOM_ARG_MESSAGE
            : "Failed to update preset";
        showPresetStatus(message, "error", 5000);
        console.warn("Failed to update preset", e);
    }
}

async function duplicatePreset(name) {
    try {
        const presets = await fetchPresetEntries();
        const source = presets.find((preset) => preset.name === name);
        if (!source) {
            showPresetStatus(`Preset "${name}" not found.`, "error", 3200);
            return;
        }
        // duplicates the saved preset, not the live Configure state, so the current
        // launch settings are left untouched
        const duplicateName = buildDuplicatePresetName(name, new Set(presets.map((preset) => preset.name)));
        // overwrite:false so a duplicate can never destroy an existing preset. The
        // name check above should already have avoided the collision; this catches
        // the case-insensitive-filesystem edge it cannot see from the browser and
        // turns it into a 409 the user is told about instead of silent data loss.
        const result = await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: duplicateName,
                data: normalizePresetData(source.data),
                overwrite: false,
            }),
        });
        if (result.saved) {
            selectedPresetName = result.name || duplicateName;
            await loadPresets();
            showPresetStatus(`Duplicated to "${result.name || duplicateName}"`, "success");
        }
    } catch (e) {
        const message = e && e.message === SENSITIVE_CUSTOM_ARG_MESSAGE
            ? SENSITIVE_CUSTOM_ARG_MESSAGE
            : "Failed to duplicate preset";
        showPresetStatus(message, "error", 5000);
        console.warn("Failed to duplicate preset", e);
    }
}

async function renamePreset(name) {
    const nextName = await promptAction(
        "Rename Preset",
        `Enter a new name for "${name}".`,
        name,
        "Rename"
    );
    if (nextName === null) return;
    if (!nextName) {
        showPresetStatus("Preset name cannot be empty", "error", 3200);
        return;
    }
    if (nextName === name) return;

    try {
        const result = await fetchJson("/api/presets/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, new_name: nextName }),
        });
        if (result.renamed) {
            const savedName = result.name || nextName;
            // must run before loadPresets, which prunes local state for unknown names
            renamePresetLocalState(name, savedName);
            if (selectedPresetName === name) selectedPresetName = savedName;
            if (selectedPresetNames.has(name)) {
                selectedPresetNames.delete(name);
                selectedPresetNames.add(savedName);
            }
            await loadPresets();
            showPresetStatus(`Renamed to "${savedName}"`, "success");
        }
    } catch (e) {
        const message = e && e.message ? e.message : "Failed to rename preset";
        showPresetStatus(message, "error", 5000);
        console.warn("Failed to rename preset", e);
    }
}

async function loadPreset(name) {
    try {
        const presets = await fetchPresetEntries();
        const preset = findPresetByName(presets, name);
        if (preset) {
            const presetData = preset.data;
            const warnings = getPresetWarnings(presetData);
            applyPresetData(presetData);
            markPresetUsed(name);
            if (warnings.length > 0) {
                showPresetStatus(`Loaded "${name}" with warning: ${warnings[0]}`, "warning", 5000);
            } else {
                showPresetStatus(`Loaded preset "${name}"`, "success");
            }
            switchTab("configure");
        } else {
            showPresetStatus(`Preset "${name}" not found.`, "error", 3200);
        }
    } catch (e) {
        showPresetStatus("Failed to load preset", "error", 3200);
        console.warn("Failed to load preset", e);
    }
}

async function deletePreset(name) {
    const ok = await confirmAction(
        "Delete Preset",
        `Delete preset "${name}"? This cannot be undone.`,
        "Delete"
    );
    if (!ok) return;
    try {
        await fetchJson("/api/presets/" + encodeURIComponent(name), { method: "DELETE" });
        loadPresets();
        showPresetStatus(`Deleted preset \"${name}\"`, "success");
    } catch (e) {
        showPresetStatus("Failed to delete preset", "error", 3200);
        console.warn("Failed to delete preset", e);
    }
}

async function favoriteSelectedPresets(favorite) {
    const names = Array.from(selectedPresetNames);
    if (names.length === 0) {
        showPresetStatus("No presets selected", "error", 3200);
        return;
    }
    const changed = setPresetsFavorite(names, favorite);
    if (!changed) {
        showPresetStatus(
            favorite
                ? `Already favorited (${names.length} selected)`
                : `No favorites in the selection (${names.length} selected)`,
            "success"
        );
        return;
    }
    await loadPresets();
    showPresetStatus(
        `${favorite ? "Favorited" : "Unfavorited"} ${changed} preset${changed === 1 ? "" : "s"}`,
        "success"
    );
}

async function deleteSelectedPresets() {
    const names = Array.from(selectedPresetNames);
    if (names.length === 0) {
        showPresetStatus("No presets selected", "error", 3200);
        return;
    }

    const ok = await confirmAction(
        "Delete Selected Presets",
        `Delete ${names.length} selected preset${names.length === 1 ? "" : "s"}? This cannot be undone.`,
        "Delete"
    );
    if (!ok) return;

    try {
        for (const name of names) {
            await fetchJson("/api/presets/" + encodeURIComponent(name), { method: "DELETE" });
        }
        selectedPresetNames.clear();
        if (names.includes(selectedPresetName)) {
            selectedPresetName = "";
        }
        await loadPresets();
        showPresetStatus(`Deleted ${names.length} preset${names.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
        showPresetStatus("Failed to delete selected presets", "error", 3200);
        console.warn("Failed to delete selected presets", e);
        loadPresets();
    }
}

function exportPreset(name) {
    fetchJson("/api/presets")
        .then((presets) => {
            const p = presets.find(x => x.name === name);
            if (!p) {
                showPresetStatus(`Preset "${name}" not found.`, "error", 3200);
                return;
            }
            const presetData = normalizePresetData(p.data);
            const exportData = { tool: presetData.tool, model: presetData.model, flags: presetData.flags };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name + ".json";
            a.click();
            URL.revokeObjectURL(url);
        })
        .catch((e) => {
            showPresetStatus("Failed to export preset", "error", 3200);
            console.warn("Failed to export preset", e);
        });
}

async function exportPresetShortcut(name) {
    try {
        const resp = await fetch("/api/presets/shortcut", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) {
            throw new Error(`Shortcut export failed with HTTP ${resp.status}`);
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const safeName = String(name || "Llama GUI").replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/^[. _]+|[. _]+$/g, "") || "Llama GUI";
        a.href = url;
        a.download = `${safeName}.cmd`;
        a.click();
        URL.revokeObjectURL(url);
        showPresetStatus(`Exported shortcut for "${name}"`, "success");
    } catch (e) {
        showPresetStatus("Failed to export shortcut", "error", 3200);
        console.warn("Failed to export preset shortcut", e);
    }
}

function exportSelectedPresets() {
    const names = new Set(selectedPresetNames);
    if (names.size === 0) {
        showPresetStatus("No presets selected", "error", 3200);
        return;
    }
    fetchJson("/api/presets")
        .then((presets) => {
            const selected = (presets || []).filter((p) => names.has(p.name));
            if (selected.length === 0) {
                showPresetStatus("Selected presets not found", "error", 3200);
                return;
            }
            const exportData = { presets: selected.map(p => ({
                name: p.name,
                data: normalizePresetData(p.data)
            })) };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "llama-gui-presets-selected.json";
            a.click();
            URL.revokeObjectURL(url);
            showPresetStatus(`Exported ${selected.length} preset(s)`, "success");
        })
        .catch((e) => {
            showPresetStatus("Failed to export selected presets", "error", 3200);
            console.warn("Failed to export selected presets", e);
        });
}

function exportAllPresets() {
    fetchJson("/api/presets")
        .then((presets) => {
            if (!presets || presets.length === 0) {
                showPresetStatus("No presets to export", "error", 3200);
                return;
            }
            const exportData = { presets: presets.map(p => ({
                name: p.name,
                data: normalizePresetData(p.data)
            })) };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "llama-gui-presets.json";
            a.click();
            URL.revokeObjectURL(url);
            showPresetStatus(`Exported ${presets.length} preset(s)`, "success");
        })
        .catch((e) => {
            showPresetStatus("Failed to export presets", "error", 3200);
            console.warn("Failed to export presets", e);
        });
}

async function handlePresetImport(file) {
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const bulkPresets = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === "object" && Array.isArray(parsed.presets)
                ? parsed.presets
                : null;

        if (bulkPresets && bulkPresets.length > 0) {
            const pendingImports = [];
            let unnamedIdx = 0;
            for (const entry of bulkPresets) {
                const name = sanitizeImportedPresetName(entry.name || "Imported-" + (++unnamedIdx));
                if (!name) {
                    showPresetStatus("Preset import contains an invalid name.", "error", 3200);
                    return;
                }
                const normalized = normalizeImportedPresetData(entry.data || {});
                if (!hasUsablePresetData(normalized)) continue;
                pendingImports.push({ name, data: normalized });
            }
            const existingPresets = await fetchPresetEntries();
            const collision = findPresetImportNameCollision(existingPresets, pendingImports);
            if (collision) {
                showPresetStatus(`Preset "${collision}" already exists. Rename or delete it before importing.`, "error", 5000);
                return;
            }
            try {
                let importedCount = 0;
                for (const preset of pendingImports) {
                    await fetchJson("/api/presets", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: preset.name, data: preset.data, overwrite: false }),
                    });
                    importedCount++;
                }
                loadPresets();
                showPresetStatus(`Imported ${importedCount} preset(s)`, "success");
            } catch (e) {
                console.warn("Preset import failed mid-loop", e);
                loadPresets();
                showPresetStatus("Failed to import some presets.", "error", 3200);
            }
            return;
        }

        const normalized = normalizeImportedPresetData(parsed);
        if (!hasUsablePresetData(normalized)) {
            showPresetStatus("Preset file contains no usable data.", "error", 3200);
            return;
        }
        const name = sanitizeImportedPresetName(file.name.replace(/\.json$/i, ""));
        if (!name) {
            showPresetStatus("Preset import contains an invalid name.", "error", 3200);
            return;
        }
        const existingPresets = await fetchPresetEntries();
        const collision = findPresetImportNameCollision(existingPresets, [{ name }]);
        if (collision) {
            showPresetStatus(`Preset "${collision}" already exists. Rename or delete it before importing.`, "error", 5000);
            return;
        }
        await fetchJson("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data: normalized, overwrite: false }),
        });
        loadPresets();
        showPresetStatus(`Imported preset \"${name}\"`, "success");
    } catch (err) {
        const message = err && err.message === SENSITIVE_CUSTOM_ARG_MESSAGE
            ? SENSITIVE_CUSTOM_ARG_MESSAGE
            : "Failed to import preset";
        showPresetStatus(message, "error", 5000);
        console.warn("Failed to import preset", err);
    }
}

if (window.LlamaGui) {
    window.LlamaGui.presets = Object.assign(window.LlamaGui.presets || {}, {
        loadPreset,
        fetchPresetEntries,
        findPresetByName,
        normalizePresetData,
        normalizeImportedPresetData,
        sanitizeImportedPresetName,
        findPresetImportNameCollision,
        getPresetWarnings,
        isPresetModelMissing,
        getPresetModelIssue,
        matchKnownModelName,
        resolvePresetModelName,
        applyPresetModel,
        getPresetModelFileName,
        getPresetLibrarySummary,
        getPresetHealthMessage,
        buildPresetSearchText,
        getPresetFlagLabel,
        refreshModelPresence,
        getPresetFocusItems,
        applyPresetRovingTabIndex,
        movePresetRovingFocus,
        formatPresetTimestamp,
        isFullPresetData,
        preparePresetLaunchState,
        applyPresetData,
        stripSensitivePresetFlags,
        hasSensitiveCustomArgs,
    });
}
