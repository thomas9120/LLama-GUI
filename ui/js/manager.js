let cachedReleases = null;
let releasesBackend = null;
let releasesBackendInFlight = null;
let releaseFetchRequestId = 0;
let statusRequestId = 0;
let refreshModelsRequestId = 0;
let refreshModelsInFlight = null;
let acceptedStatusObserver = null;
let installPollTimer = null;
let installPollStartTime = null;
let installPollFailCount = 0;
let installPollInFlight = false;
let latestStatus = null;
let latestAppUpdateStatus = null;
let pendingInstallBackendId = null;
let modelDirChangeInProgress = false;
let modelDirOperationError = "";

const INSTALL_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_POLL_MAX_FAILS = 5;

function normalizeBackendId(value) {
    return String(value || "").trim();
}

function backendOptionsFromStatus(status) {
    return Array.isArray(status && status.available_backends)
        ? status.available_backends
        : [];
}

function hasBackendOption(options, backendId) {
    return options.some((backend) => backend && backend.id === backendId);
}

function backendLabelFromStatus(status, backendId) {
    const id = normalizeBackendId(backendId);
    const match = backendOptionsFromStatus(status).find((backend) => backend && backend.id === id);
    return match && match.label ? match.label : (id || "None");
}

function installedBackendIdFromStatus(status) {
    return normalizeBackendId(status && status.backend);
}

function canActivateOfficialBackend(status, backendId) {
    const target = normalizeBackendId(backendId);
    const official = status && status.official_install;
    const recordedBackend = normalizeBackendId(official && official.backend);
    return Boolean(
        status
        && status.backend === "custom"
        && target
        && target !== "custom"
        && official
        && official.files_present
        && (!recordedBackend || recordedBackend === target)
    );
}

function renderBackendOptions(status) {
    const backendSelect = document.getElementById("backend-select");
    if (!backendSelect) return;

    const availableBackends = backendOptionsFromStatus(status);
    const previousValue = normalizeBackendId(backendSelect.value);
    const installedValue = installedBackendIdFromStatus(status);

    backendSelect.innerHTML = "";

    if (availableBackends.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No supported backends for this platform";
        backendSelect.appendChild(opt);
        backendSelect.disabled = true;
        return;
    }

    backendSelect.disabled = false;
    for (const backend of availableBackends) {
        const opt = document.createElement("option");
        opt.value = backend.id;
        opt.textContent = backend.label;
        backendSelect.appendChild(opt);
    }

    const pendingIsValid = pendingInstallBackendId && hasBackendOption(availableBackends, pendingInstallBackendId);
    const installedIsValid = installedValue && hasBackendOption(availableBackends, installedValue);
    const previousIsValid = previousValue && hasBackendOption(availableBackends, previousValue);

    if (pendingInstallBackendId && !pendingIsValid) {
        pendingInstallBackendId = null;
    }

    backendSelect.value = pendingIsValid
        ? pendingInstallBackendId
        : installedIsValid
            ? installedValue
            : previousIsValid
                ? previousValue
                : availableBackends[0].id;
}

function updateInstalledBackendSummary(status) {
    const el = document.getElementById("installed-backend-summary");
    if (!el) return;

    const installedBackend = installedBackendIdFromStatus(status);
    const label = backendLabelFromStatus(status, installedBackend);
    el.className = "installed-backend-summary";

    if (status && status.installed && installedBackend) {
        el.textContent = "Installed backend: " + label;
        el.classList.add("is-installed");
    } else if (status && status.config_stale && installedBackend) {
        el.textContent = "Configured backend: " + label + " (incomplete)";
        el.classList.add("is-stale");
    } else {
        el.textContent = "Installed backend: None";
        el.classList.add("is-empty");
    }
}

function syncInstallActionButtons(status, selectedInstallBackend) {
    const installBtn = document.getElementById("btn-install");
    const updateBtn = document.getElementById("btn-update");
    const repairBtn = document.getElementById("btn-repair");
    const installTarget = normalizeBackendId(selectedInstallBackend);
    const installedBackend = installedBackendIdFromStatus(status);
    const hasInstalledBackend = Boolean(status && status.installed && installedBackend);
    const hasStaleBackendConfig = Boolean(status && status.config_stale && installedBackend);
    const customTargetSelected = installTarget === "custom";
    const canActivateExisting = canActivateOfficialBackend(status, installTarget);

    if (installBtn && !customTargetSelected) {
        installBtn.textContent = canActivateExisting ? "Activate Existing" : "Install";
        installBtn.title = canActivateExisting
            ? "Use the official llama.cpp files already installed in llama/bin"
            : "Download and install the selected llama.cpp release";
    }

    if (updateBtn) {
        const canUpdate = !customTargetSelected && hasInstalledBackend && installedBackend !== "custom";
        updateBtn.disabled = !canUpdate;
        updateBtn.title = canUpdate
            ? "Check the installed backend for updates"
            : customTargetSelected || installedBackend === "custom"
                ? "Custom backend installations are managed manually"
                : "Install llama.cpp before checking for updates";
    }

    if (repairBtn) {
        const canRepair = !customTargetSelected && hasStaleBackendConfig && installedBackend !== "custom";
        repairBtn.classList.toggle("hidden", !canRepair && !customTargetSelected);
        repairBtn.disabled = !canRepair;
        repairBtn.title = customTargetSelected
            ? "Custom backend files are managed manually"
            : canRepair
                ? "Reinstall the configured backend files"
                : "Repair is available only for incomplete default backend installs";
    }
}

async function fetchJson(url, options) {
    const resp = await fetch(url, { cache: "no-store", ...(options || {}) });
    let data = null;
    try {
        data = await resp.json();
    } catch (e) {
        if (!resp.ok) {
            throw new Error(`Request failed (${resp.status})`);
        }
        throw new Error(`Invalid JSON response from ${url}`);
    }

    if (!resp.ok) {
        const message = data && data.error ? data.error : `Request failed (${resp.status})`;
        throw new Error(message);
    }

    return data;
}

function selectedBackendId() {
    const sel = document.getElementById("backend-select");
    return sel ? String(sel.value || "") : "";
}

function showCustomBackendControls() {
    releaseFetchRequestId += 1;
    cachedReleases = null;
    releasesBackend = "custom";
    releasesBackendInFlight = null;

    const sel = document.getElementById("release-select");
    if (sel) {
        sel.innerHTML = '<option value="custom">Custom (User-Provided)</option>';
        sel.disabled = true;
    }
    const releaseGroup = document.getElementById("release-group");
    if (releaseGroup) releaseGroup.style.display = "none";
    const customInfo = document.getElementById("custom-backend-info");
    if (customInfo) customInfo.style.display = "";
    const installBtn = document.getElementById("btn-install");
    if (installBtn) {
        installBtn.textContent = "Activate Custom";
    }
    const updateBtn = document.getElementById("btn-update");
    if (updateBtn) updateBtn.disabled = true;
    const repairBtn = document.getElementById("btn-repair");
    if (repairBtn) repairBtn.classList.add("hidden");
}

function showOfficialBackendControls() {
    const releaseGroup = document.getElementById("release-group");
    if (releaseGroup) releaseGroup.style.display = "";
    const customInfo = document.getElementById("custom-backend-info");
    if (customInfo) customInfo.style.display = "none";
    const sel = document.getElementById("release-select");
    if (sel) sel.disabled = false;
    const installBtn = document.getElementById("btn-install");
    if (installBtn) {
        installBtn.textContent = "Install";
    }
    const updateBtn = document.getElementById("btn-update");
    if (updateBtn) updateBtn.disabled = false;
    const repairBtn = document.getElementById("btn-repair");
    if (repairBtn) repairBtn.classList.remove("hidden");
}

function onBackendChange() {
    const backend = selectedBackendId();
    const installedBackend = installedBackendIdFromStatus(latestStatus);
    pendingInstallBackendId = backend && backend !== installedBackend ? backend : null;
    if (backend === "custom") {
        showCustomBackendControls();
        syncInstallActionButtons(latestStatus, backend);
        return;
    }
    showOfficialBackendControls();
    syncInstallActionButtons(latestStatus, backend);
    fetchReleases(backend);
}

async function activateCustomBackend() {
    setInstallButtonsDisabled(true);
    showStatus("info", "Checking custom binaries...");
    try {
        const result = await fetchJson("/api/activate-custom", { method: "POST" });
        if (result.ok) {
            const foundList = (result.found || []).join(", ");
            const missingList = (result.missing || []).join(", ");
            let msg = "Custom backend activated. Found: " + (foundList || "none") + ".";
            if (missingList) msg += " Missing: " + missingList + ".";
            showStatus("success", msg);
            checkStatus();
        } else {
            const missingRequired = (result.missing_required || []).join(", ");
            const notExecutable = (result.not_executable || []).join(", ");
            const missingRuntime = (result.missing_runtime_files || []).join(", ");
            if (missingRuntime) {
                showStatus("error", "Custom backend is missing runtime libraries in llama/custom/bin/: " + missingRuntime + ".");
            } else if (notExecutable) {
                showStatus("error", "Custom backend tools must be executable: " + notExecutable + ".");
            } else {
                const missingList = missingRequired || (result.missing || []).join(", ");
                showStatus("error", "Custom backend needs llama-cli and llama-server in llama/custom/bin/. Missing: " + (missingList || "required tools") + ".");
            }
        }
    } catch (e) {
        showStatus("error", "Failed to activate custom backend: " + e.message);
    } finally {
        setInstallButtonsDisabled(false);
    }
}

async function activateOfficialBackend(backend) {
    setInstallButtonsDisabled(true);
    showStatus("info", `Activating existing ${backend} backend...`);
    try {
        const result = await fetchJson("/api/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ backend, activate_existing: true }),
        });
        showStatus("success", `Existing ${result.tag} (${result.backend}) installation activated.`);
        await checkStatus();
    } catch (e) {
        showStatus("error", "Failed to activate existing backend: " + e.message);
    } finally {
        setInstallButtonsDisabled(false);
        syncInstallActionButtons(latestStatus, selectedBackendId());
    }
}

async function fetchReleases(backend) {
    const sel = document.getElementById("release-select");
    if (!sel) return;
    const backendParam = typeof backend === "string" ? backend.trim() : "";
    const url = backendParam
        ? `/api/releases?backend=${encodeURIComponent(backendParam)}`
        : "/api/releases";
    const requestId = ++releaseFetchRequestId;
    releasesBackendInFlight = backendParam;
    sel.innerHTML = '<option value="">Loading...</option>';
    try {
        const releases = await fetchJson(url);
        if (requestId !== releaseFetchRequestId) return;
        cachedReleases = releases;
        releasesBackend = backendParam;
        releasesBackendInFlight = null;
        sel.innerHTML = "";
        for (const r of cachedReleases) {
            const opt = document.createElement("option");
            opt.value = r.tag;
            const date = new Date(r.published).toLocaleDateString();
            opt.textContent = `${r.tag}  (${date})`;
            sel.appendChild(opt);
        }
        if (latestStatus && latestStatus.tag) {
            const hasInstalledTag = Array.from(sel.options).some((opt) => opt.value === latestStatus.tag);
            if (hasInstalledTag) {
                sel.value = latestStatus.tag;
                return;
            }
        }
        if (cachedReleases.length > 0) {
            sel.value = cachedReleases[0].tag;
        }
    } catch (e) {
        if (requestId !== releaseFetchRequestId) return;
        releasesBackendInFlight = null;
        sel.innerHTML = '<option value="">Failed to load</option>';
        showStatus("error", "Failed to fetch releases: " + e.message);
    }
}

async function checkStatus() {
    const requestId = ++statusRequestId;
    try {
        const status = await fetchJson("/api/status");
        if (!status || requestId !== statusRequestId) return null;
        latestStatus = status;
        // Feeds the launch-arg gate for build-dependent flags such as native
        // --reasoning-effort (llama.cpp b10434+); custom backends and older
        // installs stay on their compatible fallback path.
        if (window.LlamaGui.flagCore && typeof window.LlamaGui.flagCore.setBinaryTag === "function") {
            window.LlamaGui.flagCore.setBinaryTag(status.version);
        }
        applyModelDirInfo(status);
        updateStatusUI(status);
        await notifyAcceptedStatusObserver(status);
        if (requestId !== statusRequestId) {
            const currentStatus = latestStatus;
            if (currentStatus && currentStatus !== status) {
                await notifyAcceptedStatusObserver(currentStatus);
            }
            return currentStatus;
        }
        return status;
    } catch (e) {
        if (requestId !== statusRequestId) return null;
        markSelectFailedToLoad("backend-select");
        markSelectFailedToLoad("release-select");
        showStatus("error", "Could not check installation status: " + e.message);
        return null;
    }
}

async function notifyAcceptedStatusObserver(status) {
    if (typeof acceptedStatusObserver !== "function") return;
    try {
        await acceptedStatusObserver(status);
    } catch (observerError) {
        console.warn("Failed to reconcile authoritative process status", observerError);
    }
}

function setAcceptedStatusObserver(observer) {
    acceptedStatusObserver = typeof observer === "function" ? observer : null;
}

function markSelectFailedToLoad(id) {
    const sel = document.getElementById(id);
    if (!sel) return;
    if (sel.options.length === 0) return;
    const first = sel.options[0];
    if (first && /loading/i.test(first.textContent || "")) {
        sel.innerHTML = '<option value="">Failed to load</option>';
    }
}

function updateStatusUI(status) {
    if (!status) return;
    const badge = document.getElementById("version-badge");
    const sidebarStatus = document.getElementById("sidebar-status");
    const sidebarStatusText = document.getElementById("sidebar-status-text");
    const info = document.getElementById("installed-info");
    const backendSelect = document.getElementById("backend-select");
    const releaseSelect = document.getElementById("release-select");
    const installBtn = document.getElementById("btn-install");

    const installedBackend = installedBackendIdFromStatus(status);
    if (
        pendingInstallBackendId
        && installedBackend
        && pendingInstallBackendId === installedBackend
        && (status.installed || status.config_stale)
    ) {
        pendingInstallBackendId = null;
    }

    updateInstalledBackendSummary(status);
    renderBackendOptions(status);
    installBtn.disabled = !status.available_backends || status.available_backends.length === 0;

    const activeBackend = backendSelect ? backendSelect.value || "" : "";
    if (activeBackend === "custom") {
        showCustomBackendControls();
    } else {
        showOfficialBackendControls();
    }
    syncInstallActionButtons(status, activeBackend);

    if (backendSelect) {
        const targetBackend = activeBackend;
        if (targetBackend !== releasesBackend && targetBackend !== releasesBackendInFlight) {
            fetchReleases(targetBackend);
        }
    }

    if ((status.installed || status.config_stale) && status.tag && releaseSelect) {
        const hasTagOption = Array.from(releaseSelect.options).some((opt) => opt.value === status.tag);
        if (hasTagOption) {
            releaseSelect.value = status.tag;
        }
    }

    if (status.installed) {
        badge.textContent = status.version + " (" + status.backend + ")";
        badge.className = "badge badge-green";
    } else if (status.config_stale) {
        badge.textContent = "Install Incomplete";
        badge.className = "badge badge-yellow";
    } else {
        badge.textContent = "Not Installed";
        badge.className = "badge";
    }

    if (status.running) {
        if (sidebarStatus) sidebarStatus.style.display = "";
        if (sidebarStatusText) sidebarStatusText.textContent = (status.active_process_tool || "llama.cpp") + " running";
    } else {
        if (sidebarStatus) sidebarStatus.style.display = "none";
    }

    info.textContent = "";

    const appendRow = (label, value) => {
        const row = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = label + ":";
        row.appendChild(strong);
        row.appendChild(document.createTextNode(" " + value));
        info.appendChild(row);
    };

    if (status.installed) {
        appendRow("Version", String(status.version));
        appendRow("Backend", String(status.backend));

        const exeWrap = document.createElement("div");
        const exeTitle = document.createElement("strong");
        exeTitle.textContent = "Available tools:";
        exeWrap.appendChild(exeTitle);
        const exeHint = document.createElement("span");
        exeHint.className = "installed-info-hint";
        exeHint.textContent = " Core launch tools are required; benchmark and utility tools are optional.";
        exeWrap.appendChild(exeHint);
        exeWrap.appendChild(document.createElement("br"));
        for (const [name, exists] of Object.entries(status.executables)) {
            const isCoreTool = /^llama-(cli|server)(\.|$)/.test(String(name));
            const line = document.createElement("span");
            line.className = exists ? "exe-ok" : "exe-missing";
            line.textContent = `${exists ? "✓" : "✗"} ${name}${isCoreTool ? "" : " (optional)"}`;
            exeWrap.appendChild(line);
            exeWrap.appendChild(document.createElement("br"));
        }
        info.appendChild(exeWrap);

        if (status.runtime_files && status.runtime_files.length > 0) {
            appendRow(status.runtime_files_label || "Runtime libraries", `${status.runtime_files.length} file(s)`);
        }
    } else if (status.config_stale) {
        const missingRuntimeFiles = Array.isArray(status.missing_runtime_files)
            ? status.missing_runtime_files.filter(Boolean)
            : [];
        const warning = document.createElement("div");
        warning.className = "installed-info-warning";
        warning.textContent = missingRuntimeFiles.length > 0
            ? "Configuration exists, but required llama.cpp runtime libraries are missing."
            : "Configuration exists, but required llama.cpp executables are missing.";
        info.appendChild(warning);

        if (missingRuntimeFiles.length > 0) {
            const missing = document.createElement("div");
            missing.className = "installed-info-note";
            const shown = missingRuntimeFiles.slice(0, 8).join(", ");
            const extra = missingRuntimeFiles.length > 8 ? `, and ${missingRuntimeFiles.length - 8} more` : "";
            missing.textContent = "Missing runtime libraries: " + shown + extra;
            info.appendChild(missing);
        }

        const hint = document.createElement("div");
        hint.className = "installed-info-hint";
        hint.textContent = status.backend === "custom"
            ? "Add llama-cli and llama-server to llama/custom/bin/, then click Activate Custom again."
            : status.platform === "linux" && missingRuntimeFiles.length > 0
                ? "Click Repair Install first. If the same libraries remain missing, install or update the Vulkan/ROCm driver runtime for this system."
                : "Click Repair Install to reinstall the configured version/backend and restore binaries.";
        info.appendChild(hint);

        appendRow("Version (config)", String(status.version));
        appendRow("Backend (config)", String(status.backend));
    } else {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        const title = document.createElement("div");
        title.className = "empty-state-title";
        const hint = document.createElement("p");
        const platformText = status.platform_label ? `${status.platform_label} (${status.arch})` : "this system";
        if (!status.available_backends || status.available_backends.length === 0) {
            title.textContent = "No prebuilt backends available";
            hint.textContent = `No prebuilt llama.cpp backends are configured for ${platformText}.`;
        } else {
            title.textContent = "No llama.cpp installed";
            hint.textContent = `Select a version above and click Install to set up llama.cpp for ${platformText}.`;
        }
        empty.appendChild(title);
        empty.appendChild(hint);
        info.appendChild(empty);
    }
}

async function installRelease() {
    const backendEl = document.getElementById("backend-select");
    if (backendEl && backendEl.value === "custom") {
        return activateCustomBackend();
    }
    const backend = backendEl ? backendEl.value : "";
    if (canActivateOfficialBackend(latestStatus, backend)) {
        return activateOfficialBackend(backend);
    }
    const tag = document.getElementById("release-select").value;
    if (!tag) {
        showStatus("error", "Select a version first");
        return;
    }

    await startInstall(tag, backend, `Installing ${tag} (${backend})...`);
}

async function repairInstall() {
    const status = latestStatus || await checkStatus();
    if (!status || !status.version || !status.backend) {
        showStatus("error", "No saved installation config found to repair.");
        return;
    }

    const ok = await confirmAction(
        "Repair Install",
        `Repair installation for ${status.version} (${status.backend})? This will replace existing llama.cpp runtime files.`,
        "Repair"
    );
    if (!ok) return;

    await startInstall(
        status.version,
        status.backend,
        `Repairing ${status.version} (${status.backend})...`
    );
}

async function removeLlamaFiles() {
    const status = latestStatus || await checkStatus();
    if (status && status.running) {
        showStatus("error", "Stop the running llama.cpp process before cleaning files.");
        return;
    }

    const ok = await confirmAction(
        "Remove llama.cpp Files",
        "Delete all files under llama/bin, llama/dll, and llama/grammars, and clear install metadata? Models and presets will be kept.",
        "Remove"
    );
    if (!ok) return;

    try {
        const result = await fetchJson("/api/cleanup-llama", { method: "POST" });
        showStatus("success", `Removed ${result.removed_files || 0} llama.cpp file(s).`);
        checkStatus();
    } catch (e) {
        showStatus("error", "Cleanup failed: " + e.message);
    }
}

function setInstallButtonsDisabled(disabled) {
    const ids = [
        "btn-install", "btn-update", "btn-repair", "btn-remove-llama",
        "btn-stop-app", "btn-sidebar-stop-app", "btn-restart-app", "btn-check-app-update", "btn-update-app",
    ];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled;
    }
}

async function stopPythonServer() {
    const status = latestStatus || await checkStatus();
    const runningHint = status && status.running
        ? " Any running llama.cpp process will be stopped first."
        : "";
    const ok = await confirmAction(
        "Stop Python Server",
        `Stop this Llama GUI Python server? The page will disconnect until you start server.py again.${runningHint}`,
        "Stop Server"
    );
    if (!ok) return;

    const button = document.getElementById("btn-stop-app");
    const sidebarButton = document.getElementById("btn-sidebar-stop-app");
    if (button) button.disabled = true;
    if (sidebarButton) sidebarButton.disabled = true;
    showStatus("info", "Stopping Python server...");

    try {
        await fetchJson("/api/shutdown", { method: "POST" });
        showStatus("success", "Python server is shutting down. This page will stop responding.");
        window.setTimeout(() => {
            window.location.reload();
        }, 1500);
    } catch (e) {
        showStatus("error", "Failed to stop Python server: " + e.message);
        if (button) button.disabled = false;
        if (sidebarButton) sidebarButton.disabled = false;
    }
}

async function restartPythonServer() {
    const status = latestStatus || await checkStatus();
    const runningHint = status && status.running
        ? " Any running llama.cpp process will be stopped first."
        : "";
    const ok = await confirmAction(
        "Restart Python Server",
        `Restart the Llama GUI Python server? The page will briefly disconnect.${runningHint}`,
        "Restart"
    );
    if (!ok) return;

    await restartPythonServerAndReload({
        button: document.getElementById("btn-restart-app"),
        showStatusFn: showStatus,
        restartingMessage: "Restarting Python server...",
        reconnectingMessage: "Python server is restarting. Reconnecting...",
        successMessage: "Python server restarted successfully.",
        timeoutMessage: "Server did not become ready in time. Try reloading manually.",
        failurePrefix: "Failed to restart Python server: ",
    });
}

async function restartPythonServerAndReload(options = {}) {
    const button = document.getElementById("btn-restart-app");
    const targetButton = options.button || button;
    const showStatusFn = options.showStatusFn || showStatus;
    if (targetButton) targetButton.disabled = true;
    showStatusFn("info", options.restartingMessage || "Restarting Python server...");

    try {
        await fetchJson("/api/restart", { method: "POST" });
        showStatusFn("info", options.reconnectingMessage || "Python server is restarting. Reconnecting...");
        const ready = await waitForServerReady(30, 1000);
        if (ready) {
            showStatusFn("success", options.successMessage || "Python server restarted successfully.");
        } else {
            showStatusFn("error", options.timeoutMessage || "Server did not become ready in time. Try reloading manually.");
        }
        window.setTimeout(() => {
            reloadAppWithCacheBust();
        }, 500);
    } catch (e) {
        showStatusFn("error", (options.failurePrefix || "Failed to restart Python server: ") + e.message);
        if (targetButton) targetButton.disabled = false;
    }
}

function reloadAppWithCacheBust() {
    const url = new URL(window.location.href);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    url.searchParams.set("appReload", Date.now().toString());
    window.location.replace(url.toString());
}

function clearAppReloadParam() {
    // the timestamp only exists to defeat the cache on the reload it triggered; once the
    // page is up it is dead weight that every later refresh would carry along
    try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has("appReload")) return false;
        url.searchParams.delete("appReload");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        return true;
    } catch (e) {
        console.debug("Failed to clear the appReload parameter", e);
        return false;
    }
}

async function waitForServerReady(maxRetries, intervalMs) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await fetchJson("/api/status");
            return true;
        } catch (e) {
            console.debug("Server readiness probe failed", e);
            await new Promise(r => setTimeout(r, intervalMs));
        }
    }
    return false;
}

async function startInstall(tag, backend, startMessage) {
    showStatus("info", startMessage);
    setInstallButtonsDisabled(true);
    showProgress(true);

    try {
        const result = await fetchJson("/api/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag, backend }),
        });
        if (result.error) {
            showStatus("error", result.error);
            showProgress(false);
            setInstallButtonsDisabled(false);
        } else {
            pollInstallProgress();
        }
    } catch (e) {
        showStatus("error", "Install request failed: " + e.message);
        showProgress(false);
        setInstallButtonsDisabled(false);
    }
}

async function checkForUpdates() {
    showStatus("info", "Checking for updates...");
    try {
        const result = await fetchJson("/api/update", { method: "POST" });
        if (result.error) {
            showStatus("error", result.error);
        } else if (result.status === "already_latest") {
            showStatus("success", "Already on the latest version");
        } else if (result.status === "started") {
            showStatus("info", `Updating from ${result.from} to ${result.to}...`);
            setInstallButtonsDisabled(true);
            showProgress(true);
            pollInstallProgress();
        }
    } catch (e) {
        showStatus("error", "Update check failed: " + e.message);
    }
}

function stopInstallProgressPolling() {
    if (installPollTimer) {
        clearInterval(installPollTimer);
        installPollTimer = null;
    }
    installPollStartTime = null;
    installPollFailCount = 0;
    installPollInFlight = false;
}

function pollInstallProgress() {
    stopInstallProgressPolling();
    installPollStartTime = Date.now();
    installPollTimer = setInterval(async () => {
        if (Date.now() - installPollStartTime > INSTALL_POLL_TIMEOUT_MS) {
            stopInstallProgressPolling();
            showStatus("error", "Installation timed out. The server may have stopped responding. Try restarting Llama GUI.");
            showProgress(false);
            setInstallButtonsDisabled(false);
            return;
        }
        if (installPollInFlight) return;
        installPollInFlight = true;
        try {
            const prog = await fetchJson("/api/download-progress");
            installPollFailCount = 0;
            updateProgressBar(prog);
            if (prog.status === "done") {
                stopInstallProgressPolling();
                showStatus("success", prog.message);
                showProgress(false);
                setInstallButtonsDisabled(false);
                checkStatus();
            } else if (prog.status === "error") {
                stopInstallProgressPolling();
                showStatus("error", prog.message);
                showProgress(false);
                setInstallButtonsDisabled(false);
            }
        } catch (e) {
            installPollFailCount++;
            if (installPollFailCount >= INSTALL_POLL_MAX_FAILS) {
                stopInstallProgressPolling();
                showStatus("error", "Lost contact with the server during installation. The install may still be in progress \u2014 try restarting Llama GUI.");
                showProgress(false);
                setInstallButtonsDisabled(false);
            }
        } finally {
            installPollInFlight = false;
        }
    }, 500);
}

function updateProgressBar(prog) {
    if (prog.total > 0) {
        const pct = Math.round((prog.downloaded / prog.total) * 100);
        document.getElementById("progress-fill").style.width = pct + "%";
        const dlMB = (prog.downloaded / 1048576).toFixed(1);
        const totMB = (prog.total / 1048576).toFixed(1);
        document.getElementById("progress-text").textContent =
            `${prog.status === "extracting" ? "Extracting..." : "Downloading..."} ${pct}% (${dlMB} / ${totMB} MB)`;
    } else if (prog.status === "extracting") {
        document.getElementById("progress-fill").style.width = "100%";
        document.getElementById("progress-fill").style.background = "var(--yellow)";
        document.getElementById("progress-text").textContent = "Extracting files...";
    } else {
        document.getElementById("progress-text").textContent = prog.message || prog.status;
    }
}

function showProgress(visible) {
    const el = document.getElementById("download-progress");
    if (visible) {
        el.classList.remove("hidden");
        document.getElementById("progress-fill").style.width = "0%";
        document.getElementById("progress-fill").style.background = "var(--accent)";
        document.getElementById("progress-text").textContent = "Starting...";
    } else {
        el.classList.add("hidden");
    }
}

function showStatus(type, message) {
    const el = document.getElementById("install-status");
    el.className = "status-box " + (type || "");
    el.textContent = message || "";
    if (!type) {
        el.style.display = "none";
    } else {
        el.style.display = "";
    }
}

function showAppUpdateStatus(type, message) {
    const el = document.getElementById("app-update-status");
    if (!el) return;
    el.className = "status-box " + (type || "");
    el.textContent = message || "";
    if (!type) {
        el.style.display = "none";
    } else {
        el.style.display = "";
    }
}

function renderModelDirInfo(info) {
    const pathEl = document.getElementById("models-folder-path");
    const changeBtn = document.getElementById("btn-change-models-folder");
    const resetBtn = document.getElementById("btn-reset-models-folder");
    const errorEl = document.getElementById("models-folder-error");
    if (pathEl) pathEl.textContent = info && info.models_dir ? info.models_dir : "Loading...";
    if (changeBtn) changeBtn.disabled = modelDirChangeInProgress;
    if (resetBtn) {
        resetBtn.hidden = !info || info.models_dir_is_default === true;
        resetBtn.disabled = modelDirChangeInProgress;
    }
    if (errorEl) {
        const unavailableError = info && info.models_dir_available === false
            ? String(info.models_dir_error || "Models folder is unavailable.")
            : "";
        const message = modelDirOperationError || unavailableError;
        errorEl.textContent = message;
        errorEl.className = message ? "status-box error" : "status-box hidden";
    }
}

function applyModelDirInfo(info) {
    const core = window.LlamaGui && window.LlamaGui.flagCore;
    if (core && typeof core.setModelDirInfo === "function") {
        core.setModelDirInfo(info);
        if (typeof core.updateCommandPreview === "function") core.updateCommandPreview();
    }
    renderModelDirInfo(info);
}

async function persistModelsDir(path) {
    let postedInfo = null;
    let displayInfo = latestStatus;
    const statusBeforeSave = latestStatus;
    modelDirChangeInProgress = true;
    renderModelDirInfo(latestStatus);
    try {
        postedInfo = await fetchJson("/api/models-dir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
        displayInfo = postedInfo;
        applyModelDirInfo(postedInfo);
        const status = await checkStatus();
        if (status) {
            displayInfo = status;
        } else if (latestStatus && latestStatus !== statusBeforeSave) {
            displayInfo = latestStatus;
        }
        if (await refreshModels() !== true) {
            throw new Error("The folder was saved, but its models could not be refreshed.");
        }
        const core = window.LlamaGui && window.LlamaGui.flagCore;
        if (core && typeof core.updateCommandPreview === "function") core.updateCommandPreview();
        modelDirOperationError = "";
        if (typeof showToast === "function") showToast("Models folder updated.", "success");
        return true;
    } catch (error) {
        const core = window.LlamaGui && window.LlamaGui.flagCore;
        if (!postedInfo) {
            if (core && typeof core.setModelDirInfo === "function") core.setModelDirInfo(null);
            if (core && typeof core.updateCommandPreview === "function") core.updateCommandPreview();
        }
        modelDirOperationError = error && error.message ? error.message : "Could not update the models folder.";
        renderModelDirInfo(displayInfo || latestStatus);
        if (typeof showToast === "function") showToast(modelDirOperationError, "error");
        return false;
    } finally {
        modelDirChangeInProgress = false;
        renderModelDirInfo(displayInfo || latestStatus);
    }
}

async function chooseModelsDir() {
    let persistStarted = false;
    modelDirChangeInProgress = true;
    renderModelDirInfo(latestStatus);
    try {
        const selection = await fetchJson("/api/select-folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Select Models Folder" }),
        });
        if (!selection || !selection.selected) return false;
        persistStarted = true;
        return await persistModelsDir(selection.path);
    } catch (error) {
        modelDirOperationError = error && error.message ? error.message : "Could not open the folder picker.";
        if (typeof showToast === "function") showToast(modelDirOperationError, "error");
        return false;
    } finally {
        modelDirChangeInProgress = false;
        if (!persistStarted) renderModelDirInfo(latestStatus);
    }
}

function initModelDirControls() {
    const changeBtn = document.getElementById("btn-change-models-folder");
    const resetBtn = document.getElementById("btn-reset-models-folder");
    if (changeBtn) changeBtn.addEventListener("click", chooseModelsDir);
    if (resetBtn) resetBtn.addEventListener("click", () => persistModelsDir(null));
    renderModelDirInfo(latestStatus);
}

function selectedAppUpdateChannel() {
    const select = document.getElementById("app-update-channel");
    return select && select.value === "nightly" ? "nightly" : "stable";
}

function appUpdateStatusChannel(status) {
    return status && status.update_channel === "nightly" ? "nightly" : "stable";
}

function describeAppUpdateTarget(status) {
    if (appUpdateStatusChannel(status) === "nightly") {
        return `latest nightly commit on origin/${status.release_branch || "main"}`;
    }
    return status.release_tag ? `release ${status.release_tag}` : "latest release";
}

function describeAppUpdateStatus(status) {
    if (!status) return "Unable to determine app update status.";
    if (status.reason && !status.available) return status.reason;

    const formatPaths = (paths) => {
        const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
        if (list.length === 0) return "";
        const shown = list.slice(0, 8).join(", ");
        const extra = list.length > 8 ? `, and ${list.length - 8} more` : "";
        return shown + extra;
    };

    const blockingPaths = formatPaths(status.blocking_dirty_paths);
    const safePaths = formatPaths(status.safe_dirty_paths);
    const branch = status.branch ? `branch ${status.branch}` : "current branch";
    const target = describeAppUpdateTarget(status);
    const behindCount = status.behind || 0;
    const behindNote = behindCount
        ? ` You are ${behindCount} commit${behindCount === 1 ? "" : "s"} behind it.`
        : "";

    // The backend never reports "ahead" as a state: commits made after the
    // latest release are reported as up_to_date, since there is nothing to
    // fast-forward to.
    if (status.state === "error") {
        return status.reason || "Unable to determine app update status.";
    }
    if (status.state === "up_to_date") {
        const safeNote = safePaths ? ` Local app data is present and ignored for updates: ${safePaths}.` : "";
        return `Llama GUI already includes the ${target} on ${branch}.${safeNote}`;
    }
    if (status.state === "behind") {
        if (status.has_blocking_changes) {
            const detail = blockingPaths ? ` Blocking paths: ${blockingPaths}.` : "";
            return `${target} is available, but source changes must be committed or stashed first.${behindNote}${detail}`;
        }
        if (status.dirty) {
            const detail = safePaths ? ` Safe local app data will be left alone: ${safePaths}.` : "";
            return `${target} is available.${behindNote}${detail}`;
        }
        return `${target} is available.${behindNote}`;
    }
    if (status.state === "diverged") {
        return `Local branch and the ${target} diverged; update manually with git.`;
    }
    if (status.state === "no_release") {
        return status.reason || `No tagged release was found for ${branch}.`;
    }
    if (status.has_blocking_changes) {
        const detail = blockingPaths ? ` Blocking paths: ${blockingPaths}.` : "";
        return "Source changes detected. Commit or stash before updating." + detail;
    }
    if (status.dirty) {
        const detail = safePaths ? ` Safe local app data: ${safePaths}.` : "";
        return "Only local app data changes were detected." + detail;
    }
    return "App update status is available, but cannot auto-update in current state.";
}

function renderAppUpdateStatus(status) {
    latestAppUpdateStatus = status;
    const msg = describeAppUpdateStatus(status);
    let type = "info";
    if (!status || status.error) {
        type = "error";
    } else if (status.state === "up_to_date") {
        type = "success";
    } else if (status.state === "behind") {
        type = status.can_update ? "info" : "error";
    } else if (status.state === "diverged" || status.state === "error") {
        type = "error";
    } else if (status.state === "no_release") {
        type = "warning";
    }

    showAppUpdateStatus(type, msg);

    const updateBtn = document.getElementById("btn-update-app");
    if (updateBtn && status) {
        updateBtn.disabled = !status.can_update;
        updateBtn.title = status.can_update
            ? `Install ${describeAppUpdateTarget(status)}`
            : msg;
    }
}

async function checkAppUpdateStatus() {
    const channel = selectedAppUpdateChannel();
    const updateBtn = document.getElementById("btn-update-app");
    if (updateBtn) updateBtn.disabled = true;
    showAppUpdateStatus("info", "Checking app update status...");
    try {
        const url = channel === "nightly"
            ? "/api/app-update-status?channel=nightly"
            : "/api/app-update-status";
        const status = await fetchJson(url);
        if (selectedAppUpdateChannel() !== channel) return;
        renderAppUpdateStatus(status);
    } catch (e) {
        if (selectedAppUpdateChannel() !== channel) return;
        showAppUpdateStatus("error", "Failed to check app updates: " + e.message);
    }
}

async function updateAppFromGitHub() {
    const channel = selectedAppUpdateChannel();
    let status = latestAppUpdateStatus;
    if (!status || appUpdateStatusChannel(status) !== channel) {
        showAppUpdateStatus("info", "Checking app update status...");
        try {
            const url = channel === "nightly"
                ? "/api/app-update-status?channel=nightly"
                : "/api/app-update-status";
            status = await fetchJson(url);
            if (selectedAppUpdateChannel() !== channel) return;
        } catch (e) {
            showAppUpdateStatus("error", "Failed to check app updates: " + e.message);
            return;
        }
    }
    if (!status.can_update) {
        renderAppUpdateStatus(status);
        return;
    }

    const ok = await confirmAction(
        "Update Llama GUI",
        `Install the ${describeAppUpdateTarget(status)} from GitHub now? Python dependencies from requirements.txt will be installed after the update. The app may need a restart after updating.`,
        "Update"
    );
    if (!ok) return;

    showAppUpdateStatus("info", `Installing the ${describeAppUpdateTarget(status)} from GitHub...`);
    try {
        const result = await fetchJson("/api/app-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel }),
        });
        if (result.updated) {
            if (result.dependency_error) {
                showAppUpdateStatus("warning", "App updated, but dependency installation failed: " + result.dependency_error + " Restart Llama GUI after fixing dependencies.");
            } else {
                const depText = result.dependencies_installed
                    ? " Dependencies were installed."
                    : result.dependency_message
                        ? " " + result.dependency_message
                        : "";
                const shortcutText = result.shortcuts_created
                    ? " Desktop shortcut was updated."
                    : result.shortcuts_error
                        ? " Desktop shortcut update failed: " + result.shortcuts_error
                        : "";
                await restartPythonServerAndReload({
                    button: document.getElementById("btn-update-app"),
                    showStatusFn: showAppUpdateStatus,
                    restartingMessage: "App updated." + depText + shortcutText + " Restarting Llama GUI...",
                    reconnectingMessage: "Llama GUI is restarting. Reconnecting...",
                    successMessage: "Llama GUI restarted. Loading the updated interface...",
                    timeoutMessage: "Llama GUI updated, but the server did not become ready in time. Try reloading manually.",
                    failurePrefix: "App updated, but restart failed: ",
                });
                return;
            }
        } else if (result.message) {
            showAppUpdateStatus("info", result.message);
        }
        if (result.status) {
            renderAppUpdateStatus(result.status);
        } else {
            checkAppUpdateStatus();
        }
    } catch (e) {
        showAppUpdateStatus("error", "App update failed: " + e.message);
    }
}

function confirmAction(title, message, confirmText) {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-modal-title");
    const messageEl = document.getElementById("confirm-modal-message");
    const cancelBtn = document.getElementById("confirm-modal-cancel");
    const okBtn = document.getElementById("confirm-modal-ok");

    titleEl.textContent = title || "Confirm Action";
    messageEl.textContent = message || "Are you sure you want to continue?";
    okBtn.textContent = confirmText || "Confirm";

    modal.classList.remove("hidden");
    okBtn.focus();

    return new Promise((resolve) => {
        const cleanup = () => {
            modal.classList.add("hidden");
            cancelBtn.removeEventListener("click", onCancel);
            okBtn.removeEventListener("click", onConfirm);
            modal.removeEventListener("click", onBackdrop);
            document.removeEventListener("keydown", onKeydown);
        };

        const finish = (value) => {
            cleanup();
            resolve(value);
        };

        const onCancel = () => finish(false);
        const onConfirm = () => finish(true);
        const onBackdrop = (e) => {
            if (e.target === modal) finish(false);
        };
        const onKeydown = (e) => {
            if (e.key === "Escape") finish(false);
            if (e.key === "Enter") finish(true);
        };

        cancelBtn.addEventListener("click", onCancel);
        okBtn.addEventListener("click", onConfirm);
        modal.addEventListener("click", onBackdrop);
        document.addEventListener("keydown", onKeydown);
    });
}

function promptAction(title, message, defaultValue, confirmText) {
    const modal = document.getElementById("prompt-modal");
    const titleEl = document.getElementById("prompt-modal-title");
    const messageEl = document.getElementById("prompt-modal-message");
    const input = document.getElementById("prompt-modal-input");
    const cancelBtn = document.getElementById("prompt-modal-cancel");
    const okBtn = document.getElementById("prompt-modal-ok");

    titleEl.textContent = title || "Enter a Value";
    messageEl.textContent = message || "";
    okBtn.textContent = confirmText || "Confirm";
    input.value = defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);

    modal.classList.remove("hidden");
    input.focus();
    input.select();

    return new Promise((resolve) => {
        const cleanup = () => {
            modal.classList.add("hidden");
            cancelBtn.removeEventListener("click", onCancel);
            okBtn.removeEventListener("click", onConfirm);
            modal.removeEventListener("click", onBackdrop);
            document.removeEventListener("keydown", onKeydown);
        };

        const finish = (value) => {
            cleanup();
            resolve(value);
        };

        // resolves to null on cancel so callers can tell "dismissed" from "cleared the field"
        const onCancel = () => finish(null);
        const onConfirm = () => finish(input.value.trim());
        const onBackdrop = (e) => {
            if (e.target === modal) finish(null);
        };
        const onKeydown = (e) => {
            if (e.key === "Escape") finish(null);
            if (e.key === "Enter") {
                e.preventDefault();
                finish(input.value.trim());
            }
        };

        cancelBtn.addEventListener("click", onCancel);
        okBtn.addEventListener("click", onConfirm);
        modal.addEventListener("click", onBackdrop);
        document.addEventListener("keydown", onKeydown);
    });
}

function openFolder(folder) {
    fetchJson("/api/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
    })
        .then(() => {
            const label = folder === "llama" ? "llama.cpp" : "models";
            showStatus("info", `Opened ${label} folder.`);
        })
        .catch((e) => {
            showStatus("error", "Failed to open folder: " + e.message);
        });
}

// Lowercased .gguf file names last seen in the models/ folder, shared with any
// module that needs to know whether a saved model still exists (see the missing
// model warning in presets.js). `null` means "not known yet" - never fetched, or
// the fetch failed - which callers must treat differently from a known-empty
// folder, since an unavailable list is not evidence that a model is gone.
let knownModelNames = null;

function getKnownModelNames() {
    return knownModelNames;
}

// Presets derive their missing-model warnings from the cache above at build
// time, so whoever changed it has to say so. Kept as a narrow one-way poke
// rather than a general event bus, matching setAcceptedStatusObserver's scope.
function notifyModelPresenceChanged() {
    const presets = window.LlamaGui && window.LlamaGui.presets;
    if (presets && typeof presets.refreshModelPresence === "function") {
        presets.refreshModelPresence();
    }
}

function refreshModels() {
    const requestId = ++refreshModelsRequestId;
    const request = refreshModelsForRequest(requestId);
    refreshModelsInFlight = request;
    return request;
}

async function refreshModelsForRequest(requestId) {
    const sel = document.getElementById("model-select");
    if (!sel) return false;
    try {
        const models = await fetchJson("/api/models");
        if (requestId !== refreshModelsRequestId) return refreshModelsInFlight || false;
        // Keep the current options in place while requests overlap. Clearing
        // them before the await made a second refresh snapshot an empty value,
        // so the winning response silently dropped the selected model.
        const selectedValue = sel.value;
        sel.innerHTML = '<option value="">-- Select Model --</option>';
        const names = new Set();
        const optionValues = new Set();
        let added = 0;
        for (const m of models) {
            if (!m.name || !String(m.name).toLowerCase().endsWith(".gguf")) continue;
            names.add(String(m.name).toLowerCase());
            optionValues.add(String(m.name));
            const opt = document.createElement("option");
            opt.value = m.name;
            opt.textContent = `${m.name}  (${m.size_mb} MB)`;
            sel.appendChild(opt);
            added++;
        }
        knownModelNames = names;
        if (added === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "No .gguf models found in the active models folder \u2014 download one from Quick Launch";
            sel.appendChild(opt);
        }
        sel.value = selectedValue && optionValues.has(selectedValue) ? selectedValue : "";
        if (window.LlamaGui && window.LlamaGui.flagCore) {
            window.LlamaGui.flagCore.setSelectedModelValue(sel.value || "");
        }
        if (typeof syncQuickLaunchModelOptions === "function") {
            syncQuickLaunchModelOptions();
        }
        notifyModelPresenceChanged();
        if (window.LlamaGui && window.LlamaGui.flagCore
            && typeof window.LlamaGui.flagCore.updateCommandPreview === "function") {
            window.LlamaGui.flagCore.updateCommandPreview();
        }
        return true;
    } catch (e) {
        if (requestId !== refreshModelsRequestId) return refreshModelsInFlight || false;
        // Drop the cache rather than keeping a stale one: callers must not read
        // a failed refresh as proof that a model is missing.
        knownModelNames = null;
        sel.innerHTML = '<option value="">-- Select Model --</option>';
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Failed to load models";
        sel.appendChild(opt);
        if (window.LlamaGui && window.LlamaGui.flagCore) {
            window.LlamaGui.flagCore.setSelectedModelValue("");
        }
        if (typeof syncQuickLaunchModelOptions === "function") {
            syncQuickLaunchModelOptions();
        }
        if (typeof showToast === "function") {
            showToast("Could not load models: " + e.message, "error");
        } else {
            console.debug("Failed to refresh model list", e);
        }
        // The failure path matters as much as the success path: clearing the
        // cache changes missing-model warnings from "none found" to "not
        // checked", and the Presets tab has to be told.
        notifyModelPresenceChanged();
        return false;
    }
}

if (window.addEventListener) {
    window.addEventListener("beforeunload", stopInstallProgressPolling);
}

if (window.LlamaGui) {
    window.LlamaGui.manager = Object.assign(window.LlamaGui.manager || {}, {
        fetchJson,
        fetchReleases,
        checkStatus,
        setAcceptedStatusObserver,
        initModelDirControls,
        chooseModelsDir,
        persistModelsDir,
        refreshModels,
        getKnownModelNames,
        checkAppUpdateStatus,
        updateAppFromGitHub,
        stopInstallProgressPolling,
    });
}
