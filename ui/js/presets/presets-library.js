// Presets package (5/10): grouping, search text, flag-label cache, icons, and shared render helpers.
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
    // Number controls can save strings. Do not coerce blanks or booleans to zero.
    if (typeof right === "number" && typeof left === "string" && left.trim() !== "") {
        return Number.isFinite(right) && Number(left) === right;
    }
    return left === right;
}

function getNonDefaultPresetFlagIds(presetData) {
    const flags = (presetData && presetData.flags) || {};
    const core = getPresetFlagCore();
    const defaults = new Map(
        getPresetFlagDefinitions()
            .filter((flag) => flag && flag.id && Object.prototype.hasOwnProperty.call(flag, "default"))
            .map((flag) => [flag.id, flag.default])
    );
    return Object.keys(flags).filter((flagId) => (
        !SENSITIVE_PRESET_FLAG_IDS.has(flagId) && flagId !== "ctx_size_draft"
        && (!defaults.has(flagId) || !presetValuesEqual(core.normalizeStoredFlagValue(flagId, flags[flagId]), defaults.get(flagId)))
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
            archived: preset.archived === true,
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
            .filter((entry) => (presetArchiveViewActive ? entry.archived : !entry.archived))
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

const PRESET_ICON_WARNING = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';
const PRESET_ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const PRESET_ICON_CHEVRON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const PRESET_ICON_EMPTY = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>';
const PRESET_ICON_STAR = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
const PRESET_ICON_STAR_OUTLINE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
const PRESET_ICON_ARCHIVE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
const PRESET_ICON_RESTORE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 16v-5"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/></svg>';

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

// Same wording as formatHistoryTime() in the Chat package (chat-history.js),
// which stays private there. Kept as a local copy rather than widening that
// module's surface.
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
    return Boolean(presetSearchQuery.trim()) || presetWarningFilterActive || presetFavoritesMode === "only" || presetArchiveViewActive;
}
