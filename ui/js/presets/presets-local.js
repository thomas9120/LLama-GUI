// Presets package (4/10): favorites, last-used, sort/favorites modes, and other persisted local state.
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
let presetArchiveViewActive = false;
let presetArchivedCount = 0;
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
    if (lastLoadedPresetName === oldName) {
        lastLoadedPresetName = newName;
        refreshPresetContext();
    }
    // group collapse state is keyed by model path, so only the name-keyed maps move
    for (const storageKey of [PRESET_FAVORITES_STORAGE_KEY, PRESET_LAST_USED_STORAGE_KEY]) {
        const map = loadPresetJsonMap(storageKey);
        if (!Object.prototype.hasOwnProperty.call(map, oldName)) continue;
        map[newName] = map[oldName];
        delete map[oldName];
        savePresetJsonMap(storageKey, map);
    }
}

function deletePresetLocalState(name) {
    if (lastLoadedPresetName === name) {
        loadedPresetMissing = true;
        refreshPresetContext();
    }
    for (const storageKey of [PRESET_FAVORITES_STORAGE_KEY, PRESET_LAST_USED_STORAGE_KEY]) {
        const map = loadPresetJsonMap(storageKey);
        if (!Object.prototype.hasOwnProperty.call(map, name)) continue;
        delete map[name];
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
