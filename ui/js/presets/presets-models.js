// Presets package (3/10): model-name matching, presence checks, and preset warnings.
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
