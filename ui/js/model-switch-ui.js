(function () {
    "use strict";

    const root = window.LlamaGui = window.LlamaGui || {};
    const STORAGE_KEY = "llama_gui_model_switcher_slots_v1";
    const STORAGE_VERSION = 1;
    const MAX_PRESET_NAME_CODE_POINTS = 128;
    const SLOT_IDS = ["a", "b"];
    const CONTROL_CHARACTER_PATTERN = /\p{C}/u;

    let assignments = createEmptyAssignments();
    let loaded = false;
    let persistent = true;
    let warning = "";
    let issues = {};
    let dependencies = {};
    let initialized = false;
    let presetEntries = null;
    let presetLoadError = "";
    let refreshId = 0;
    let pendingSlot = "";
    let uiWarning = "";
    let sidebarCommittedSlot = "a";
    let sidebarPreviewSlot = "";
    let sidebarKeyboardArmed = false;
    let sidebarDrag = null;
    let sidebarSliderState = null;
    let lastViewState = null;
    const slotFailures = {};

    function clearSlotFailures(slotId = "") {
        if (slotId) {
            delete slotFailures[slotId];
            return;
        }
        for (const id of SLOT_IDS) delete slotFailures[id];
    }

    function createEmptyAssignments() {
        return {
            version: STORAGE_VERSION,
            slots: {
                a: { preset: "" },
                b: { preset: "" },
            },
        };
    }

    function cloneAssignments(value = assignments) {
        return {
            version: STORAGE_VERSION,
            slots: {
                a: { preset: value.slots.a.preset },
                b: { preset: value.slots.b.preset },
            },
        };
    }

    function normalizePresetName(value, options = {}) {
        const allowEmpty = options.allowEmpty !== false;
        if (typeof value !== "string") {
            return { value: "", error: "Preset name must be text." };
        }
        const normalized = value.trim();
        if (!normalized) {
            return allowEmpty
                ? { value: "", error: null }
                : { value: "", error: "Preset name is required." };
        }
        if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
            return { value: "", error: "Preset name contains control characters." };
        }
        if (Array.from(normalized).length > MAX_PRESET_NAME_CODE_POINTS) {
            return { value: "", error: `Preset name must be ${MAX_PRESET_NAME_CODE_POINTS} characters or fewer.` };
        }
        return { value: normalized, error: null };
    }

    function collectDuplicateIssues(value) {
        const nextIssues = {};
        const first = value.slots.a.preset;
        const second = value.slots.b.preset;
        if (first && second && first === second) {
            nextIssues.a = "Both slots reference the same preset.";
            nextIssues.b = "Both slots reference the same preset.";
        }
        return nextIssues;
    }

    function normalizeAssignmentsRecord(value) {
        const record = createEmptyAssignments();
        const nextIssues = {};
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return { record, issues: { record: "Saved slot assignments are invalid." } };
        }
        if (value.version !== STORAGE_VERSION) {
            return { record, issues: { record: "Saved slot assignments use an unsupported version." } };
        }
        const slots = value.slots && typeof value.slots === "object" && !Array.isArray(value.slots)
            ? value.slots
            : {};
        for (const slotId of SLOT_IDS) {
            const slot = slots[slotId];
            const result = normalizePresetName(slot ? slot.preset : "", { allowEmpty: true });
            if (result.error) {
                nextIssues[slotId] = result.error;
            } else {
                record.slots[slotId].preset = result.value;
            }
        }
        Object.assign(nextIssues, collectDuplicateIssues(record));
        return { record, issues: nextIssues };
    }

    function reportStorageFailure(message, error) {
        persistent = false;
        warning = message;
        console.warn(message, error);
    }

    function reloadAssignments() {
        assignments = createEmptyAssignments();
        issues = {};
        warning = "";
        persistent = true;
        loaded = true;
        let raw;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            reportStorageFailure("Model switcher assignments are available for this session only.", error);
            return cloneAssignments();
        }
        if (!raw) return cloneAssignments();
        try {
            const parsed = JSON.parse(raw);
            const normalized = normalizeAssignmentsRecord(parsed);
            assignments = normalized.record;
            issues = normalized.issues;
            if (issues.record) warning = issues.record;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.version === STORAGE_VERSION) {
                persistAssignments();
            }
        } catch (error) {
            warning = "Saved model switcher assignments could not be read.";
            issues = { record: warning };
            console.warn(warning, error);
        }
        return cloneAssignments();
    }

    function ensureLoaded() {
        if (!loaded) reloadAssignments();
    }

    function persistAssignments() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(assignments));
            persistent = true;
            warning = "";
        } catch (error) {
            reportStorageFailure("Model switcher assignments are available for this session only.", error);
        }
    }

    function getAssignments() {
        ensureLoaded();
        return cloneAssignments();
    }

    function assertSlotId(slotId) {
        if (!SLOT_IDS.includes(slotId)) {
            throw new Error("Model switcher slot must be \"a\" or \"b\".");
        }
    }

    function setAssignment(slotId, presetName) {
        ensureLoaded();
        assertSlotId(slotId);
        const normalized = normalizePresetName(presetName, { allowEmpty: false });
        if (normalized.error) throw new Error(normalized.error);
        const otherSlot = slotId === "a" ? "b" : "a";
        if (assignments.slots[otherSlot].preset === normalized.value) {
            throw new Error("Both slots cannot reference the same preset.");
        }
        assignments.slots[slotId].preset = normalized.value;
        clearSlotFailures(slotId);
        issues = collectDuplicateIssues(assignments);
        persistAssignments();
        return cloneAssignments();
    }

    function clearAssignment(slotId) {
        ensureLoaded();
        assertSlotId(slotId);
        assignments.slots[slotId].preset = "";
        clearSlotFailures(slotId);
        issues = collectDuplicateIssues(assignments);
        persistAssignments();
        return cloneAssignments();
    }

    function getStorageStatus() {
        ensureLoaded();
        return {
            key: STORAGE_KEY,
            version: STORAGE_VERSION,
            persistent,
            warning,
        };
    }

    function getAssignmentIssues() {
        ensureLoaded();
        return { ...issues };
    }

    function configure(options = {}) {
        dependencies = Object.assign({}, dependencies, options || {});
        return root.modelSwitchUi;
    }

    function byId(id) {
        return typeof document === "undefined" ? null : document.getElementById(id);
    }

    function callDependency(name, fallback, ...args) {
        const callback = dependencies[name];
        if (typeof callback === "function") return callback(...args);
        return typeof fallback === "function" ? fallback(...args) : fallback;
    }

    function getPresetLookup() {
        if (typeof dependencies.findPresetByName === "function") return dependencies.findPresetByName;
        if (root.presets && typeof root.presets.findPresetByName === "function") {
            return root.presets.findPresetByName;
        }
        return (entries, name) => {
            const entry = Array.isArray(entries)
                ? entries.find(candidate => candidate && String(candidate.name || "") === name)
                : null;
            if (!entry) return null;
            const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
                ? entry.data
                : {};
            return Object.assign({}, entry, {
                name: String(entry.name || ""),
                data,
                full: Boolean(data.flags && typeof data.flags === "object" && !Array.isArray(data.flags)),
            });
        };
    }

    function basename(value) {
        const parts = String(value || "").split(/[\\/]/);
        return parts[parts.length - 1] || "";
    }

    function modelDetails(entry, runtime, activeIdentity) {
        const data = entry && entry.data && typeof entry.data === "object" ? entry.data : {};
        const flags = data.flags && typeof data.flags === "object" ? data.flags : {};
        const runtimeModel = activeIdentity && runtime ? runtime.model : "";
        const gguf = basename(data.model || runtimeModel);
        const alias = activeIdentity && runtime && runtime.alias
            ? String(runtime.alias).split(",")[0].trim()
            : String(flags.alias || "").split(",")[0].trim();
        const model = alias || gguf.replace(/\.gguf$/i, "") || "—";
        return { model, gguf: gguf || "—" };
    }

    function entryFingerprint(entry) {
        if (!entry) return "";
        const injected = callDependency("getPresetFingerprint", "", entry);
        if (typeof injected === "string") return injected;
        return String(entry.preset_fingerprint || entry.fingerprint || "");
    }

    function isFullServerPreset(entry) {
        return Boolean(entry && entry.full && entry.data && entry.data.tool === "llama-server");
    }

    function statePresentation(state) {
        const presentations = {
            unassigned: { badge: "Unassigned", tone: "neutral", message: "Choose a saved llama-server preset." },
            standby: { badge: "Standby", tone: "accent", message: "Configuration saved and ready to preflight." },
            active: { badge: "Active", tone: "active", message: "This is the active runtime." },
            loading: { badge: "Loading", tone: "warning", message: "Switch in progress…" },
            missing: { badge: "Missing", tone: "error", message: "The assigned preset no longer exists." },
            invalid: { badge: "Invalid", tone: "error", message: "Assign a full llama-server preset." },
            drift: { badge: "Modified", tone: "warning", message: "Preset changed since this runtime launched." },
            failure: { badge: "Failed", tone: "error", message: "The last switch attempt failed." },
            "other-tool": { badge: "Unavailable", tone: "neutral", message: "Another llama.cpp tool is running." },
        };
        return presentations[state] || presentations.invalid;
    }

    function buildSlotViews(options = {}) {
        const entries = Array.isArray(options.entries) ? options.entries : [];
        const record = options.assignments && options.assignments.slots
            ? options.assignments
            : createEmptyAssignments();
        const assignmentIssues = options.issues || {};
        const status = options.status || {};
        const lifecycle = options.lifecycle || {};
        const failures = options.failures || {};
        const currentPendingSlot = options.pendingSlot || "";
        const runtime = lifecycle.activeRuntime || status.active_runtime || null;
        const phase = String(lifecycle.phase || "");
        const runtimeRunning = status.running !== false && Boolean(runtime);
        const otherToolRunning = Boolean(runtimeRunning && runtime.tool && runtime.tool !== "llama-server");
        const lookup = getPresetLookup();
        const loadingPhases = new Set(["starting", "loading", "stopping"]);

        return SLOT_IDS.map(slotId => {
            const presetName = String(record.slots[slotId] && record.slots[slotId].preset || "");
            const entry = presetName ? lookup(entries, presetName) : null;
            const activeIdentity = Boolean(
                runtimeRunning
                && runtime
                && runtime.source === "model-switcher"
                && runtime.slot === slotId
                && runtime.tool === "llama-server"
            );
            const details = modelDetails(entry, runtime, activeIdentity);
            const currentFingerprint = entryFingerprint(entry);
            const runtimeFingerprint = activeIdentity ? String(runtime.preset_fingerprint || "") : "";
            const drifted = Boolean(currentFingerprint && runtimeFingerprint && currentFingerprint !== runtimeFingerprint);
            const displayPresetName = presetName || (activeIdentity ? String(runtime.preset || "") : "");
            const lifecycleFailure = phase === "failed" && activeIdentity && lifecycle.ready !== true
                ? String(lifecycle.error || "")
                : "";
            const failure = String(failures[slotId] || lifecycleFailure || "");
            const loading = Boolean(
                currentPendingSlot === slotId
                || (!currentPendingSlot && activeIdentity && loadingPhases.has(phase))
            );
            const healthyActive = activeIdentity && lifecycle.ready === true && !loading;
            let state;
            if (assignmentIssues[slotId]) state = "invalid";
            else if (!presetName && activeIdentity && loading) state = "loading";
            else if (!presetName && healthyActive) state = "active";
            else if (!presetName && activeIdentity && failure) state = "failure";
            else if (!presetName && activeIdentity) state = "active";
            else if (!presetName) state = "unassigned";
            else if (!entry) state = "missing";
            else if (!isFullServerPreset(entry)) state = "invalid";
            else if (otherToolRunning) state = "other-tool";
            else if (loading) state = "loading";
            else if (healthyActive && drifted) state = "drift";
            else if (healthyActive) state = "active";
            else if (failure) state = "failure";
            else if (activeIdentity && drifted) state = "drift";
            else if (activeIdentity) state = "active";
            else state = "standby";
            const presentation = statePresentation(state);
            const message = !presetName && activeIdentity && state === "active"
                ? "This runtime is active; its slot assignment has been cleared."
                : state === "failure"
                    ? failure || presentation.message
                    : assignmentIssues[slotId] || presentation.message;
            return {
                id: slotId,
                label: slotId === "a" ? "Model A" : "Model B",
                presetName,
                displayPresetName,
                entry,
                state,
                badge: presentation.badge,
                tone: presentation.tone,
                message,
                model: details.model,
                gguf: details.gguf,
                activeIdentity,
                actionable: state === "standby" || state === "failure",
            };
        });
    }

    function selectActionSlot(views, lifecycle = {}) {
        const list = Array.isArray(views) ? views : [];
        const loading = list.find(view => view.state === "loading");
        if (loading) return loading.id;
        const active = list.find(view => view.activeIdentity);
        if (active) {
            const alternate = list.find(view => view.id !== active.id && view.actionable);
            return alternate ? alternate.id : "";
        }
        const failed = list.find(view => view.state === "failure" && view.actionable);
        if (failed) return failed.id;
        const target = list.find(view => view.actionable);
        return target ? target.id : "";
    }

    function clampSliderProgress(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 0;
        return Math.min(1, Math.max(0, numeric));
    }

    function resolveSidebarDragTarget(currentSlot, progress, moved) {
        if (!moved || !SLOT_IDS.includes(currentSlot)) return "";
        const normalized = clampSliderProgress(progress);
        if (currentSlot === "a" && normalized >= 0.72) return "b";
        if (currentSlot === "b" && normalized <= 0.28) return "a";
        return "";
    }

    function buildSidebarSliderState(views, lifecycle = {}, fallbackSlot = "a", canSwitch = true) {
        const list = Array.isArray(views) ? views : [];
        const active = list.find(view => view && view.activeIdentity);
        const loading = list.find(view => view && view.state === "loading");
        const committedSlot = active && SLOT_IDS.includes(active.id)
            ? active.id
            : SLOT_IDS.includes(fallbackSlot) ? fallbackSlot : "a";
        const targetSlot = committedSlot === "a" ? "b" : "a";
        const target = list.find(view => view && view.id === targetSlot);
        const busy = Boolean(lifecycle.busy || pendingSlot || loading);
        const enabled = Boolean(active && target && target.actionable && !busy && canSwitch);
        let status = "Drag to switch";
        if (loading) status = `Switching to Model ${loading.id.toUpperCase()}`;
        else if (!active) status = "Launch a slot in Quick Launch first";
        else if (busy) status = "Model switcher is busy";
        else if (!canSwitch) status = "Model switching is unavailable";
        else if (!target || !target.actionable) status = `Model ${targetSlot.toUpperCase()} is not ready`;
        return {
            activeSlot: active ? active.id : "",
            committedSlot,
            targetSlot,
            enabled,
            busy,
            loadingSlot: loading ? loading.id : "",
            status,
        };
    }

    async function loadPresetEntries(force = false) {
        if (presetEntries && !force) return presetEntries;
        const fetchEntries = dependencies.fetchPresetEntries
            || (root.presets && root.presets.fetchPresetEntries);
        if (typeof fetchEntries !== "function") {
            throw new Error("Preset lookup is not available.");
        }
        const entries = await fetchEntries();
        if (!Array.isArray(entries)) throw new Error("Preset lookup returned an invalid response.");
        presetEntries = entries;
        return presetEntries;
    }

    function setText(id, value) {
        const element = byId(id);
        if (element) element.textContent = String(value === undefined || value === null || value === "" ? "—" : value);
    }

    function setHidden(element, hidden) {
        if (!element) return;
        element.classList.toggle("hidden", Boolean(hidden));
    }

    function renderNotice(storageStatus, assignmentIssues) {
        const notice = byId("model-switch-notice");
        if (!notice) return;
        const recordIssue = assignmentIssues && assignmentIssues.record;
        const message = uiWarning || presetLoadError || (storageStatus && storageStatus.warning) || recordIssue || "";
        notice.textContent = message;
        setHidden(notice, !message);
    }

    function validPresetEntries(entries) {
        const lookup = getPresetLookup();
        return (Array.isArray(entries) ? entries : [])
            .map(entry => lookup(entries, String(entry && entry.name || "")))
            .filter(isFullServerPreset)
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    function populateSlotSelect(slotId, entries, record) {
        const select = byId(`model-switch-select-${slotId}`);
        const clear = byId(`model-switch-clear-${slotId}`);
        if (!select) return;
        const current = record.slots[slotId].preset;
        const otherSlot = slotId === "a" ? "b" : "a";
        const other = record.slots[otherSlot].preset;
        const validEntries = validPresetEntries(entries);
        const validNames = new Set(validEntries.map(entry => entry.name));
        select.textContent = "";
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "Assign preset…";
        select.appendChild(empty);
        if (current && !validNames.has(current)) {
            const missing = document.createElement("option");
            missing.value = current;
            missing.textContent = `${current} (missing or unsupported)`;
            select.appendChild(missing);
        }
        for (const entry of validEntries) {
            const option = document.createElement("option");
            option.value = entry.name;
            const model = basename(entry.data.model);
            option.textContent = model ? `${entry.name} — ${model}` : entry.name;
            option.disabled = Boolean(other && other === entry.name && current !== entry.name);
            select.appendChild(option);
        }
        select.value = current;
        if (clear) clear.disabled = !current;
    }

    function renderSlot(view, actionSlot, lifecycle) {
        const slot = byId(`model-switch-slot-${view.id}`);
        const badge = byId(`model-switch-slot-${view.id}-badge`);
        const action = byId(`model-switch-slot-${view.id}-action`);
        if (slot) slot.dataset.state = view.state;
        setText(`model-switch-slot-${view.id}-title`, view.displayPresetName || view.presetName || "Unassigned");
        setText(`model-switch-slot-${view.id}-model`, view.model);
        setText(`model-switch-slot-${view.id}-gguf`, view.gguf);
        setText(`model-switch-slot-${view.id}-message`, view.message);
        for (const part of ["model", "gguf"]) {
            const el = byId(`model-switch-slot-${view.id}-${part}`);
            if (el) el.title = el.textContent || "";
        }
        if (badge) {
            badge.textContent = view.badge;
            badge.dataset.tone = view.tone;
        }
        const isTarget = actionSlot === view.id;
        if (action) {
            action.textContent = view.state === "loading" ? "Switching…" : `Switch to ${view.label}`;
            action.disabled = Boolean(
                lifecycle.busy
                || pendingSlot
                || !view.actionable
                || typeof dependencies.switchSlot !== "function"
            );
            action.setAttribute("aria-busy", String(view.state === "loading"));
            setHidden(action, !isTarget);
        }
    }

    function setSidebarSliderPresentation(slot, progress, status) {
        const slider = byId("sidebar-model-switcher-slider");
        const panel = byId("sidebar-model-switcher");
        const statusElement = byId("sidebar-model-switcher-status");
        const visibleSlot = SLOT_IDS.includes(slot) ? slot : "a";
        const normalizedProgress = clampSliderProgress(progress);
        if (slider) {
            slider.style.setProperty("--model-switch-progress", String(normalizedProgress));
            slider.setAttribute("aria-valuenow", visibleSlot === "b" ? "1" : "0");
            slider.setAttribute("aria-valuetext", `Model ${visibleSlot.toUpperCase()}`);
        }
        for (const slotId of SLOT_IDS) {
            const label = byId(`sidebar-model-switcher-label-${slotId}`);
            if (label) label.classList.toggle("is-active", slotId === visibleSlot);
        }
        if (panel) panel.dataset.position = visibleSlot;
        if (statusElement && status) statusElement.textContent = status;
    }

    function renderSidebarSlider(viewState) {
        const slider = byId("sidebar-model-switcher-slider");
        const panel = byId("sidebar-model-switcher");
        if (!slider || !panel) return;
        const lifecycle = viewState.lifecycle || {};
        sidebarSliderState = buildSidebarSliderState(
            viewState.views,
            lifecycle,
            sidebarCommittedSlot,
            typeof dependencies.switchSlot === "function"
        );
        if (sidebarSliderState.activeSlot) sidebarCommittedSlot = sidebarSliderState.activeSlot;
        if (!sidebarSliderState.enabled && !sidebarSliderState.busy) {
            sidebarKeyboardArmed = false;
            sidebarPreviewSlot = "";
        }
        const visibleSlot = sidebarSliderState.loadingSlot
            || (sidebarKeyboardArmed && sidebarPreviewSlot)
            || sidebarCommittedSlot;
        const status = sidebarKeyboardArmed && sidebarPreviewSlot !== sidebarCommittedSlot
            ? `Press Enter to switch to Model ${sidebarPreviewSlot.toUpperCase()}`
            : sidebarSliderState.status;
        slider.setAttribute("aria-disabled", String(!sidebarSliderState.enabled));
        slider.setAttribute("aria-busy", String(sidebarSliderState.busy));
        panel.dataset.state = sidebarSliderState.busy ? "busy" : sidebarSliderState.enabled ? "ready" : "disabled";
        panel.dataset.activeSlot = sidebarSliderState.activeSlot;
        setSidebarSliderPresentation(visibleSlot, visibleSlot === "b" ? 1 : 0, status);
    }

    function summaryText(views, lifecycle, runtime) {
        const loading = views.find(view => view.state === "loading");
        if (loading) return `Switching to ${loading.label}…`;
        const active = views.find(view => view.state === "active" || view.state === "drift");
        if (active) return `${active.label} is active — ${active.displayPresetName || active.presetName || "runtime"}`;
        if (runtime && runtime.tool && runtime.tool !== "llama-server") {
            return `${runtime.tool} is running; model switching is unavailable.`;
        }
        const configured = views.filter(view => view.presetName).length;
        return configured ? `${configured} standby slot${configured === 1 ? "" : "s"} configured.` : "Assign two saved server presets for quick switching.";
    }

    function render(viewState) {
        if (typeof document === "undefined") return;
        lastViewState = viewState;
        const lifecycle = viewState.lifecycle || {};
        const runtime = lifecycle.activeRuntime || viewState.status.active_runtime || null;
        const actionSlot = selectActionSlot(viewState.views, lifecycle);
        for (const view of viewState.views) renderSlot(view, actionSlot, lifecycle);
        setText("model-switch-summary", summaryText(viewState.views, lifecycle, runtime));
        renderNotice(viewState.storageStatus, viewState.issues);
        populateSlotSelect("a", viewState.entries, viewState.assignments);
        populateSlotSelect("b", viewState.entries, viewState.assignments);
        renderSidebarSlider(viewState);
    }

    async function refresh(options = {}) {
        const requestId = ++refreshId;
        try {
            await loadPresetEntries(Boolean(options.reloadPresets));
            presetLoadError = "";
        } catch (error) {
            presetLoadError = error && error.message ? error.message : "Failed to load saved presets.";
            if (!presetEntries) presetEntries = [];
        }
        if (requestId !== refreshId) return null;
        const record = callDependency("getAssignments", getAssignments);
        const assignmentIssues = callDependency("getAssignmentIssues", getAssignmentIssues);
        const storageStatus = callDependency("getStorageStatus", getStorageStatus);
        const status = callDependency("getLatestBackendStatus", {} ) || {};
        const lifecycle = callDependency("getLifecycleSnapshot", {}) || {};
        const activeRuntime = lifecycle.activeRuntime || status.active_runtime || null;
        if (
            status.running !== false
            && lifecycle.ready === true
            && activeRuntime
            && activeRuntime.source === "model-switcher"
            && SLOT_IDS.includes(activeRuntime.slot)
        ) {
            clearSlotFailures(activeRuntime.slot);
        }
        const views = buildSlotViews({
            entries: presetEntries,
            assignments: record,
            issues: assignmentIssues,
            status,
            lifecycle,
            pendingSlot,
            failures: slotFailures,
        });
        const viewState = {
            entries: presetEntries,
            assignments: record,
            issues: assignmentIssues,
            storageStatus,
            status,
            lifecycle,
            views,
        };
        render(viewState);
        return viewState;
    }

    function setExpanded(expanded) {
        const toggle = byId("model-switch-toggle");
        const body = byId("model-switch-body");
        if (toggle) toggle.setAttribute("aria-expanded", String(expanded));
        if (body) {
            body.setAttribute("aria-hidden", String(!expanded));
            setHidden(body, !expanded);
        }
    }

    async function handleAssignmentChange(slotId, presetName) {
        uiWarning = "";
        try {
            if (presetName) {
                callDependency("setAssignment", setAssignment, slotId, presetName);
            } else {
                callDependency("clearAssignment", clearAssignment, slotId);
            }
            clearSlotFailures(slotId);
        } catch (error) {
            uiWarning = error && error.message ? error.message : "Failed to update the model slot.";
        }
        return refresh({ reloadPresets: true });
    }

    function handlePresetRefresh() {
        uiWarning = "";
        return refresh({ reloadPresets: true });
    }

    async function handleSwitch(slotId) {
        if (pendingSlot) return;
        const switchSlot = dependencies.switchSlot;
        if (typeof switchSlot !== "function") {
            uiWarning = "Model switching is not available yet.";
            await refresh();
            return;
        }
        pendingSlot = slotId;
        sidebarPreviewSlot = slotId;
        sidebarKeyboardArmed = false;
        uiWarning = "";
        await refresh();
        try {
            const outcome = await switchSlot(slotId);
            if (outcome && outcome.ok === true) {
                clearSlotFailures();
            } else if (outcome && outcome.ok === false && !outcome.cancelled) {
                slotFailures[slotId] = outcome.error || "The model switch failed.";
            }
        } catch (error) {
            slotFailures[slotId] = error && error.message ? error.message : "The model switch failed.";
        } finally {
            pendingSlot = "";
            sidebarPreviewSlot = "";
            sidebarKeyboardArmed = false;
            await refresh({ reloadPresets: true });
        }
    }

    function sliderProgressFromPointer(event, drag = sidebarDrag) {
        if (!drag) return 0;
        const usableWidth = Math.max(1, drag.sliderRect.width - drag.thumbWidth);
        return clampSliderProgress((event.clientX - drag.sliderRect.left - drag.grabOffset) / usableWidth);
    }

    function resetSidebarPreview() {
        sidebarPreviewSlot = "";
        sidebarKeyboardArmed = false;
        if (lastViewState) renderSidebarSlider(lastViewState);
    }

    function handleSidebarPointerDown(event) {
        if (!sidebarSliderState || !sidebarSliderState.enabled) return;
        if (event.button !== undefined && event.button !== 0) return;
        const slider = byId("sidebar-model-switcher-slider");
        const thumb = byId("sidebar-model-switcher-thumb");
        if (!slider || !thumb) return;
        event.preventDefault();
        slider.focus();
        const sliderRect = slider.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        sidebarDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            sliderRect,
            thumbWidth: thumbRect.width,
            grabOffset: event.clientX - thumbRect.left,
            committedSlot: sidebarCommittedSlot,
            moved: false,
        };
        slider.classList.add("is-dragging");
        if (typeof thumb.setPointerCapture === "function") thumb.setPointerCapture(event.pointerId);
        setSidebarSliderPresentation(
            sidebarCommittedSlot,
            sidebarCommittedSlot === "b" ? 1 : 0,
            `Drag to Model ${sidebarSliderState.targetSlot.toUpperCase()} and release`
        );
    }

    function handleSidebarPointerMove(event) {
        if (!sidebarDrag || event.pointerId !== sidebarDrag.pointerId) return;
        event.preventDefault();
        if (Math.abs(event.clientX - sidebarDrag.startX) >= 4) sidebarDrag.moved = true;
        const progress = sliderProgressFromPointer(event);
        const visibleSlot = progress >= 0.5 ? "b" : "a";
        setSidebarSliderPresentation(
            visibleSlot,
            progress,
            `Release near Model ${sidebarSliderState.targetSlot.toUpperCase()} to switch`
        );
    }

    function finishSidebarPointer(event, cancelled = false) {
        if (!sidebarDrag || event.pointerId !== sidebarDrag.pointerId) return;
        const drag = sidebarDrag;
        const thumb = byId("sidebar-model-switcher-thumb");
        const slider = byId("sidebar-model-switcher-slider");
        const progress = sliderProgressFromPointer(event, drag);
        const targetSlot = cancelled ? "" : resolveSidebarDragTarget(drag.committedSlot, progress, drag.moved);
        sidebarDrag = null;
        if (slider) slider.classList.remove("is-dragging");
        if (thumb && typeof thumb.releasePointerCapture === "function" && thumb.hasPointerCapture(event.pointerId)) {
            thumb.releasePointerCapture(event.pointerId);
        }
        if (
            targetSlot
            && sidebarSliderState
            && sidebarSliderState.enabled
            && sidebarSliderState.targetSlot === targetSlot
        ) {
            sidebarPreviewSlot = targetSlot;
            setSidebarSliderPresentation(targetSlot, targetSlot === "b" ? 1 : 0, `Switching to Model ${targetSlot.toUpperCase()}`);
            void handleSwitch(targetSlot);
            return;
        }
        resetSidebarPreview();
    }

    function handleSidebarKeyDown(event) {
        if (!sidebarSliderState || !sidebarSliderState.enabled || sidebarDrag) return;
        const keyTargets = {
            ArrowLeft: "a",
            Home: "a",
            ArrowRight: "b",
            End: "b",
        };
        if (keyTargets[event.key]) {
            event.preventDefault();
            const preview = keyTargets[event.key];
            sidebarPreviewSlot = preview;
            sidebarKeyboardArmed = preview !== sidebarCommittedSlot;
            if (lastViewState) renderSidebarSlider(lastViewState);
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            resetSidebarPreview();
            return;
        }
        if ((event.key === "Enter" || event.key === " ") && sidebarKeyboardArmed) {
            event.preventDefault();
            const targetSlot = sidebarPreviewSlot;
            if (targetSlot === sidebarSliderState.targetSlot) {
                sidebarKeyboardArmed = false;
                void handleSwitch(targetSlot);
            }
        }
    }

    function init() {
        const card = byId("model-switch-card");
        if (!card) return false;
        if (!initialized) {
            initialized = true;
            const collapse = byId("model-switch-toggle");
            if (collapse) collapse.addEventListener("click", () => {
                setExpanded(collapse.getAttribute("aria-expanded") !== "true");
            });
            for (const slotId of SLOT_IDS) {
                const action = byId(`model-switch-slot-${slotId}-action`);
                const select = byId(`model-switch-select-${slotId}`);
                const refreshButton = byId(`model-switch-refresh-${slotId}`);
                const clear = byId(`model-switch-clear-${slotId}`);
                if (action) action.addEventListener("click", () => handleSwitch(slotId));
                if (select) select.addEventListener("change", () => handleAssignmentChange(slotId, select.value));
                if (select && root.searchableSelect) {
                    root.searchableSelect.enhance(select, { searchPlaceholder: "Search presets..." });
                }
                if (refreshButton) refreshButton.addEventListener("click", handlePresetRefresh);
                if (clear) clear.addEventListener("click", () => handleAssignmentChange(slotId, ""));
            }
            const sidebarSlider = byId("sidebar-model-switcher-slider");
            const sidebarThumb = byId("sidebar-model-switcher-thumb");
            if (sidebarSlider) {
                sidebarSlider.addEventListener("keydown", handleSidebarKeyDown);
                sidebarSlider.addEventListener("blur", () => {
                    if (!sidebarDrag && !pendingSlot) resetSidebarPreview();
                });
            }
            if (sidebarThumb) {
                sidebarThumb.addEventListener("pointerdown", handleSidebarPointerDown);
                sidebarThumb.addEventListener("pointermove", handleSidebarPointerMove);
                sidebarThumb.addEventListener("pointerup", event => finishSidebarPointer(event));
                sidebarThumb.addEventListener("pointercancel", event => finishSidebarPointer(event, true));
            }
        }
        setExpanded(false);
        refresh({ reloadPresets: true });
        return true;
    }

    root.modelSwitchUi = Object.assign(root.modelSwitchUi || {}, {
        storageKey: STORAGE_KEY,
        storageVersion: STORAGE_VERSION,
        maxPresetNameCodePoints: MAX_PRESET_NAME_CODE_POINTS,
        normalizePresetName,
        normalizeAssignmentsRecord,
        getAssignments,
        setAssignment,
        clearAssignment,
        reloadAssignments,
        getStorageStatus,
        getAssignmentIssues,
        configure,
        init,
        refresh,
        buildSlotViews,
        selectActionSlot,
        buildSidebarSliderState,
        resolveSidebarDragTarget,
        handleSwitch,
    });
})();
