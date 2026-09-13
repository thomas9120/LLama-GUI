// Session 0 (Tier 2) refactor guardrails: this harness loads every local
// script tag from ui/index.html in canonical order inside a Node VM and then
// enforces the mechanical contracts that keep future package splits safe:
//
//   1. Load order: every local script tag resolves on disk, every ui/js source
//      is referenced exactly once, and nothing loads from an external origin.
//      Commented tags are ignored; local scripts must be blocking classic scripts.
//   2. Public facades: the top-level window.LlamaGui keys match exactly, and
//      the facades pinned as compatibility contracts expose exactly their
//      documented keys with callable methods.
//   3. Private boundaries: underscore-private namespaces are referenced only
//      inside their owning package.
//   4. Package assembly order: a package's *-main.js file loads after every
//      other file in that package.
//
// See docs/frontend-maintainability-tier-2-plan.md ("Session 0").
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
    UI_DIR,
    readIndexHtml,
    listScriptTags,
    getScriptPaths,
} = require("./script_order.cjs");

const scriptFiles = getScriptPaths();
assert.ok(scriptFiles.length > 0, "expected to find frontend scripts in ui/index.html");

// --- 1. Load-order and resolution contracts -------------------------------

const externalScripts = listScriptTags()
    .filter((tag) => tag.external)
    .map((tag) => tag.src);
assert.deepEqual(
    externalScripts,
    [],
    "ui/index.html must not load external (CDN) scripts; the frontend is self-contained"
);

for (const scriptFile of scriptFiles) {
    assert.ok(
        scriptFile.startsWith("js/"),
        `script "${scriptFile}" is referenced by ui/index.html but lives outside ui/js/, ` +
            "so this harness would silently skip it"
    );
    assert.ok(
        fs.existsSync(path.join(UI_DIR, scriptFile)),
        `ui/index.html references missing script ui/${scriptFile}`
    );
}

const duplicateScripts = scriptFiles.filter(
    (src, index) => scriptFiles.indexOf(src) !== index
);
assert.deepEqual(
    duplicateScripts,
    [],
    "ui/index.html must not reference the same script twice (it would evaluate twice)"
);

function listUiJsSources(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...listUiJsSources(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            found.push(path.relative(UI_DIR, fullPath).split(path.sep).join("/"));
        }
    }
    return found;
}

const onDiskSources = listUiJsSources(path.join(UI_DIR, "js"));
function assertNoOrphanedSources(loadedScripts) {
    const orphanedSources = onDiskSources.filter((src) => !loadedScripts.includes(src));
    assert.deepEqual(
        orphanedSources,
        [],
        "ui/js contains .js files that ui/index.html never loads; add the script tag " +
            "in dependency order or delete the file"
    );
}
assertNoOrphanedSources(scriptFiles);

// Negative fixtures must exercise the same loader and contracts as real files.
for (const attribute of ["async", "defer", 'ASYNC="false"', "defer='defer'",
    'type="module"', "type=module", 'type="application/json"', "nomodule"]) {
    assert.throws(
        () => getScriptPaths(`<script ${attribute} src="/js/flag-core.js"></script>`),
        /must use blocking classic-script execution/,
        `must reject ${attribute}`
    );
}
assert.deepEqual(
    getScriptPaths(`<!-- <script src="/js/old.js"></script> -->
        <script data-note="defer > async" TYPE='text/javascript' src='/js/one.js?v=1#frag'></script>
        <script src=/js/two.js></script>`),
    ["js/one.js", "js/two.js"]
);
const historyTag = /<script\b[^>]*src="\/js\/chat\/chat-history\.js[^>]*><\/script>/;
const indexHtml = readIndexHtml();
assert.match(indexHtml, historyTag, "commented-contributor fixture must match a real tag");
assert.throws(
    () => assertNoOrphanedSources(getScriptPaths(indexHtml.replace(historyTag, "<!-- $& -->"))),
    /ui\/js contains .js files that ui\/index.html never loads/
);

// --- 2. Evaluate in canonical order ---------------------------------------

const logs = [];
const context = {
    window: {},
    console: {
        info: (...args) => logs.push(["info", args]),
        warn: (...args) => logs.push(["warn", args]),
        error: (...args) => logs.push(["error", args]),
        groupCollapsed: (...args) => logs.push(["groupCollapsed", args]),
        groupEnd: () => logs.push(["groupEnd", []]),
        debug: (...args) => logs.push(["debug", args]),
        log: (...args) => logs.push(["log", args]),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    Blob,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            appendChild: () => {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            setAttribute: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            style: {},
        }),
    },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    },
};

context.window = context;
vm.createContext(context);

// Evaluation in ui/index.html order is itself the dependency check: a module
// that reaches for a later-loaded script global fails here with the offending
// filename.
for (const scriptFile of scriptFiles) {
    const source = fs.readFileSync(path.join(UI_DIR, scriptFile), "utf8");
    vm.runInContext(source, context, { filename: scriptFile });
}

// --- 3. Public facade contracts -------------------------------------------

const llamaGui = context.window.LlamaGui;
assert.ok(llamaGui, "expected window.LlamaGui to be defined");

function assertSameKeys(actual, expected, label) {
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expected].sort();
    const missing = expectedSorted.filter((key) => !actualSorted.includes(key));
    const unexpected = actualSorted.filter((key) => !expectedSorted.includes(key));
    assert.deepEqual(
        actualSorted,
        expectedSorted,
        `${label} keys drifted from the contract.` +
            (missing.length ? ` Missing: ${missing.join(", ")}.` : "") +
            (unexpected.length ? ` Unexpected: ${unexpected.join(", ")}.` : "") +
            " Removing or renaming a public key must be an explicit, reviewed change."
    );
}

// The complete top-level surface. Adding a module or leaking a new global both
// fail here, so facade changes always go through review.
const expectedTopLevelKeys = [
    "apiTab",
    "benchmarkUi",
    "characterCards",
    "chatCompaction",
    "chatRendering",
    "chatTemplateSelection",
    "chatTools",
    "chatUi",
    "chatWindow",
    "configFlagsUi",
    "externalServerUi",
    "flagCore",
    "hfDownloadUi",
    "apiClient",
    "dialogs",
    "manager",
    "modelSwitchUi",
    "monitorUi",
    "outputCursor",
    "presets",
    "processLifecycle",
    "quickLaunchUi",
    "remoteTunnelUi",
    "samplerPresets",
    "searchableSelect",
    "shellUi",
    "themeUi",
    "_chatInternal", // private; pinned separately in section 4
    "_managerInternal",
];
assertSameKeys(Object.keys(llamaGui), expectedTopLevelKeys, "window.LlamaGui top level");

const expectedNamespaces = [
    "flagCore",
    "outputCursor",
    "processLifecycle",
    "themeUi",
    "shellUi",
    "configFlagsUi",
    "quickLaunchUi",
    "chatUi",
    "chatWindow",
    "chatRendering",
    "chatCompaction",
    "chatTemplateSelection",
    "chatTools",
    "characterCards",
    "apiTab",
    "hfDownloadUi",
    "remoteTunnelUi",
    "externalServerUi",
    "samplerPresets",
    "benchmarkUi",
    "monitorUi",
    "presets",
    "modelSwitchUi",
    "apiClient",
    "dialogs",
    "manager",
];

for (const namespace of expectedNamespaces) {
    assert.ok(llamaGui[namespace], `expected window.LlamaGui.${namespace} to be defined`);
}

// Exact key contracts for facades whose key names are an intended
// compatibility contract (AGENTS.md shared-state writes, the Tier 1 split
// success criteria, and the Manager fetchJson alias carried into Tier 2).
// Other facades keep the existence + documented-method checks below so
// internal churn stays cheap.
const facadeKeyContracts = {
    flagCore: [
        "applyFlagValues",
        "buildEffectiveFlagValues",
        "buildLaunchArgs",
        "buildLocalModelPath",
        "captureLaunchSettings",
        "compareLaunchSettings",
        "configure",
        "getCombinedSpeculativeType",
        "getCurrentTool",
        "getFlagValues",
        "getLaunchArgs",
        "getSelectedModel",
        "hasLaunchModelArg",
        "hasSensitiveCustomArgs",
        "isValidGpuLayersValue",
        "normalizeGpuLayersValue",
        "normalizeModelRelPath",
        "normalizeSpeculativeFlagValues",
        "normalizeStoredFlagValue",
        "parseCustomLaunchArgs",
        "patchFlagValues",
        "quoteArg",
        "redactSensitiveTokens",
        "registerApi",
        "replaceFlagValues",
        "setBinaryTag",
        "setCurrentTool",
        "setCurrentToolValue",
        "setFlagValue",
        "setModelDirInfo",
        "setMultipleFlagValues",
        "setPathFlagValue",
        "setSelectedModelValue",
        "shouldOmitFlagValue",
        "supportsLoadModeOnly",
        "supportsNativeReasoningEffort",
        "updateCommandPreview",
    ],
    apiClient: ["fetchJson"],
    dialogs: ["confirmAction", "promptAction"],
    manager: [
        "configure",
        "init",
        "getLatestStatus",
        "showStatus",
        "clearAppReloadParam",
        "checkAppUpdateStatus",
        "checkStatus",
        "chooseModelsDir",
        "fetchJson",
        "fetchReleases",
        "getKnownModelNames",
        "initModelDirControls",
        "persistModelsDir",
        "refreshModels",
        "setAcceptedStatusObserver",
        "stopInstallProgressPolling",
        "updateAppFromGitHub",
    ],
    chatTemplateSelection: [
        "beforePathPatch",
        "configure",
        "getChatTemplatePresetByBuiltinName",
        "getChatTemplatePresetByPath",
        "getChatTemplatePresetByValue",
        "getQuickTemplateSummaryText",
        "getSelectedChatTemplateDropdownValue",
        "isSupportedChatTemplateValue",
        "setChatTemplateValue",
    ],
    chatUi: [
        "abortActiveStream",
        "addModelTransitionDivider",
        "captureLayout",
        "captureSnapshot",
        "configure",
        "configureWorkspace",
        "getChatSamplerFlagIds",
        "getChatSamplerValues",
        "getTransferState",
        "init",
        "onTabChanged",
        "refreshSidebarUI",
        "refreshTemplateCaps",
        "resetWorkspace",
        "restoreLayout",
        "restoreSnapshot",
        "resumeTransfer",
        "saveForTransfer",
        "setChatSamplerValue",
        "setHostAvailable",
        "setOwnership",
        "suspendTransfer",
        "updateStatusBadge",
        "validateSnapshot",
    ],
    presets: [
        "applyPresetData",
        "applyPresetModel",
        "applyPresetRovingTabIndex",
        "buildPresetSearchText",
        "comparePresetToCurrent",
        "configure",
        "fetchPresetEntries",
        "findPresetByName",
        "findPresetImportNameCollision",
        "formatPresetTimestamp",
        "formatSavedPresetValue",
        "getLastLoadedPresetName",
        "getPresetFlagLabel",
        "getPresetFocusItems",
        "getPresetHealthMessage",
        "getPresetLastUsed",
        "getPresetLibrarySummary",
        "getPresetModelFileName",
        "getPresetModelIssue",
        "getPresetWarnings",
        "hasSensitiveCustomArgs",
        "initContextControls",
        "isFullPresetData",
        "isPresetFavorite",
        "isPresetModelMissing",
        "loadPreset",
        "matchKnownModelName",
        "matchesCurrentPreset",
        "movePresetRovingFocus",
        "normalizeImportedPresetData",
        "normalizePresetData",
        "preparePresetLaunchState",
        "refreshContext",
        "refreshModelPresence",
        "resolvePresetModelName",
        "sanitizeImportedPresetName",
        "stripSensitivePresetFlags",
    ],
};

function assertFacadeContract(facade, keys, label) {
    assertSameKeys(Object.keys(facade), keys, label);
    for (const key of keys) {
        assert.equal(typeof facade[key], "function", `${label}.${key} must be a function`);
    }
}
for (const [namespace, keys] of Object.entries(facadeKeyContracts)) {
    assertFacadeContract(llamaGui[namespace], keys, `window.LlamaGui.${namespace}`);
}
assert.throws(
    () => assertFacadeContract(
        { ...llamaGui.chatUi, restoreSnapshot: undefined },
        facadeKeyContracts.chatUi,
        "window.LlamaGui.chatUi"
    ),
    /window.LlamaGui.chatUi.restoreSnapshot must be a function/
);

// Documented entry points for the remaining facades (existence of the keys
// above is covered by the top-level contract).
assert.equal(typeof llamaGui.flagCore.setFlagValue, "function");
assert.equal(typeof llamaGui.themeUi.init, "function");
assert.equal(typeof llamaGui.themeUi.applyTheme, "function");
assert.equal(typeof llamaGui.searchableSelect.enhance, "function");
assert.equal(typeof llamaGui.quickLaunchUi.refresh, "function");
assert.equal(typeof llamaGui.chatUi.init, "function");
assert.equal(typeof llamaGui.chatRendering.renderMarkdown, "function");
assert.equal(typeof llamaGui.chatCompaction.compact, "function");
assert.equal(typeof llamaGui.characterCards.readFile, "function");
assert.equal(typeof llamaGui.chatWindow.createCoordinator, "function");
assert.equal(typeof llamaGui.configFlagsUi.renderFlags, "function");
assert.equal(typeof llamaGui.apiTab.updateEndpoints, "function");
assert.equal(typeof llamaGui.remoteTunnelUi.renderStatus, "function");
assert.equal(typeof llamaGui.shellUi.init, "function");
assert.equal(typeof llamaGui.benchmarkUi.init, "function");
assert.equal(typeof llamaGui.monitorUi.init, "function");
assert.equal(typeof llamaGui.monitorUi.createInferenceStats, "function");
assert.equal(typeof llamaGui.presets.loadPreset, "function");
assert.equal(typeof llamaGui.modelSwitchUi.getAssignments, "function");
assert.equal(typeof llamaGui.processLifecycle.switchRuntime, "function");
assert.equal(typeof llamaGui.outputCursor.create, "function");
assert.equal(llamaGui.manager.fetchJson, llamaGui.apiClient.fetchJson);
assert.equal(llamaGui.manager.getLatestStatus(), null);
assert.equal(llamaGui.manager._test, undefined, "test hooks are absent in production");
for (const name of ["latestStatus", "checkStatus", "refreshModels", "installRelease", "confirmAction", "promptAction"]) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined", `${name} must not leak globally`);
}

// --- 4. Private namespace boundaries --------------------------------------

// Every underscore-prefixed namespace must be registered with its owning
// package directory; references from outside that package fail below.
const privateNamespaceOwners = {
    _chatInternal: "js/chat",
    _managerInternal: "js/manager",
};

const observedPrivateKeys = Object.keys(llamaGui)
    .filter((key) => key.startsWith("_"))
    .sort();
assert.deepEqual(
    observedPrivateKeys,
    Object.keys(privateNamespaceOwners).sort(),
    "new private namespaces must be registered in privateNamespaceOwners with an owning package"
);

function listUiSourceFiles(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...listUiSourceFiles(fullPath));
        } else if (entry.isFile() && /\.(?:js|html)$/.test(entry.name)) {
            found.push(fullPath);
        }
    }
    return found;
}

const uiSourceFiles = listUiSourceFiles(UI_DIR);
for (const [namespace, ownerPrefix] of Object.entries(privateNamespaceOwners)) {
    const ownerDir = `${ownerPrefix}/`;
    // Identifier-boundary match: `__chatInternal` or `_chatInternalFoo` must
    // not create false positives or hide real leaks.
    const tokenRe = new RegExp(`(^|[^A-Za-z0-9_$])${namespace}(?![A-Za-z0-9_$])`);
    let ownerReferences = 0;
    for (const fullPath of uiSourceFiles) {
        const relPath = path.relative(UI_DIR, fullPath).split(path.sep).join("/");
        if (relPath.startsWith(ownerDir)) {
            if (tokenRe.test(fs.readFileSync(fullPath, "utf8"))) ownerReferences += 1;
            continue;
        }
        assert.ok(
            !tokenRe.test(fs.readFileSync(fullPath, "utf8")),
            `window.LlamaGui.${namespace} is private to the ${ownerPrefix} package ` +
                `but is referenced from ${relPath}`
        );
    }
    assert.ok(
        ownerReferences > 0,
        `the ${ownerPrefix} package no longer references its private namespace ${namespace}`
    );
}

// --- 5. Package assembly order --------------------------------------------

// Flag domains are data-only classic scripts. Their assembler precedes the
// helpers and all consumers, while shared option data precedes each domain.
const flagAssemblyIndex = scriptFiles.indexOf("js/flags/definitions.js");
const flagHelpersIndex = scriptFiles.indexOf("js/flags/helpers.js");
assert.ok(flagAssemblyIndex >= 0 && flagHelpersIndex > flagAssemblyIndex);
for (const [index, src] of scriptFiles.entries()) {
    if (!src.startsWith("js/flags/definitions-")) continue;
    assert.ok(index < flagAssemblyIndex, `${src} must load before the FLAGS assembler`);
    for (const dependency of ["options.js", "chat-templates.js"]) {
        assert.ok(
            scriptFiles.indexOf(`js/flags/${dependency}`) < index,
            `${src} must load after ${dependency}`
        );
    }
}

// A directory package with a *-main.js assembler must load that file after
// every other contributor in the same package (Tier 1 recipe).
const packagesByDir = new Map();
for (const src of scriptFiles) {
    const dir = path.posix.dirname(src);
    if (!packagesByDir.has(dir)) packagesByDir.set(dir, []);
    packagesByDir.get(dir).push(src);
}
for (const [dir, packageFiles] of packagesByDir) {
    if (packageFiles.length < 2) continue;
    const mainFiles = packageFiles.filter((src) => /(?:^|-|\/)main\.js$/.test(src));
    if (mainFiles.length === 0) continue;
    assert.equal(
        mainFiles.length,
        1,
        `package ${dir} must have at most one *-main.js assembler (found ${mainFiles.join(", ")})`
    );
    assert.equal(
        packageFiles[packageFiles.length - 1],
        mainFiles[0],
        `${mainFiles[0]} assembles the package public facade and must load after ` +
            "its internal contributors in ui/index.html"
    );
}

console.log(`module namespace check passed for ${scriptFiles.length} scripts`);
