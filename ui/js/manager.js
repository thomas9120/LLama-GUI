let cachedReleases = null;
let installPollTimer = null;
let latestStatus = null;
let latestAppUpdateStatus = null;

async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    let data = null;
    try {
        data = await resp.json();
    } catch (e) {
        if (!resp.ok) {
            throw new Error(`Request failed (${resp.status})`);
        }
        return null;
    }

    if (!resp.ok) {
        const message = data && data.error ? data.error : `Request failed (${resp.status})`;
        throw new Error(message);
    }

    return data;
}

async function fetchReleases() {
    const sel = document.getElementById("release-select");
    sel.innerHTML = '<option value="">Loading...</option>';
    try {
        cachedReleases = await fetchJson("/api/releases");
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
        sel.innerHTML = '<option value="">Failed to load</option>';
        showStatus("error", "Failed to fetch releases: " + e.message);
    }
}

async function checkStatus() {
    try {
        const status = await fetchJson("/api/status");
        latestStatus = status;
        updateStatusUI(status);
        return status;
    } catch (e) {
        return null;
    }
}

function updateStatusUI(status) {
    const badge = document.getElementById("version-badge");
    const processBadge = document.getElementById("process-badge");
    const info = document.getElementById("installed-info");
    const repairBtn = document.getElementById("btn-repair");
    const backendSelect = document.getElementById("backend-select");
    const releaseSelect = document.getElementById("release-select");

    if ((status.installed || status.config_stale) && status.backend && backendSelect) {
        const hasBackendOption = Array.from(backendSelect.options).some((opt) => opt.value === status.backend);
        if (hasBackendOption) {
            backendSelect.value = status.backend;
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
        processBadge.classList.remove("hidden");
    } else {
        processBadge.classList.add("hidden");
    }

    repairBtn.classList.toggle("hidden", !status.config_stale);

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
        exeTitle.textContent = "Executables:";
        exeWrap.appendChild(exeTitle);
        exeWrap.appendChild(document.createElement("br"));
        for (const [name, exists] of Object.entries(status.executables)) {
            const line = document.createElement("span");
            line.className = exists ? "exe-ok" : "exe-missing";
            line.textContent = `${exists ? "✓" : "✗"} ${name}`;
            exeWrap.appendChild(line);
            exeWrap.appendChild(document.createElement("br"));
        }
        info.appendChild(exeWrap);

        if (status.dlls && status.dlls.length > 0) {
            appendRow("DLLs", `${status.dlls.length} file(s)`);
        }
    } else if (status.config_stale) {
        const warning = document.createElement("div");
        warning.style.color = "var(--yellow)";
        warning.style.marginBottom = "8px";
        warning.textContent = "Configuration exists, but required llama.cpp executables are missing.";
        info.appendChild(warning);

        const hint = document.createElement("div");
        hint.style.color = "var(--fg-dim)";
        hint.textContent = "Click Repair Install to reinstall the configured version/backend and restore binaries.";
        info.appendChild(hint);

        appendRow("Version (config)", String(status.version));
        appendRow("Backend (config)", String(status.backend));
    } else {
        const empty = document.createElement("span");
        empty.style.color = "var(--fg-dim)";
        empty.textContent = "No llama.cpp installation found. Select a version above and click Install.";
        info.appendChild(empty);
    }
}

async function installRelease() {
    const tag = document.getElementById("release-select").value;
    const backend = document.getElementById("backend-select").value;
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
    document.getElementById("btn-install").disabled = disabled;
    document.getElementById("btn-update").disabled = disabled;
    document.getElementById("btn-repair").disabled = disabled;
    document.getElementById("btn-remove-llama").disabled = disabled;
    document.getElementById("btn-check-app-update").disabled = disabled;
    document.getElementById("btn-update-app").disabled = disabled;
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

function pollInstallProgress() {
    if (installPollTimer) clearInterval(installPollTimer);
    installPollTimer = setInterval(async () => {
        try {
            const prog = await fetchJson("/api/download-progress");
            updateProgressBar(prog);
            if (prog.status === "done") {
                clearInterval(installPollTimer);
                installPollTimer = null;
                showStatus("success", prog.message);
                showProgress(false);
                setInstallButtonsDisabled(false);
                checkStatus();
            } else if (prog.status === "error") {
                clearInterval(installPollTimer);
                installPollTimer = null;
                showStatus("error", prog.message);
                showProgress(false);
                setInstallButtonsDisabled(false);
            }
        } catch (e) {
            // ignore poll errors
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
    el.className = "status-box " + type;
    el.textContent = message;
    if (!type) {
        el.style.display = "none";
    }
}

function showAppUpdateStatus(type, message) {
    const el = document.getElementById("app-update-status");
    if (!el) return;
    el.className = "status-box " + (type || "");
    el.textContent = message || "";
    if (!type) {
        el.style.display = "none";
    }
}

function describeAppUpdateStatus(status) {
    if (!status) return "Unable to determine app update status.";
    if (status.reason && !status.available) return status.reason;

    const branch = status.branch ? `branch ${status.branch}` : "current branch";
    if (status.state === "up_to_date") {
        return `Llama GUI is up to date on ${branch}.`;
    }
    if (status.state === "behind") {
        const n = status.behind || 0;
        if (status.dirty) {
            return `Update available (${n} commit${n === 1 ? "" : "s"} behind), but local changes must be committed or stashed first.`;
        }
        return `Update available: ${n} commit${n === 1 ? "" : "s"} behind origin.`;
    }
    if (status.state === "ahead") {
        return "Local branch is ahead of origin; auto-update is disabled.";
    }
    if (status.state === "diverged") {
        return "Local and remote branches diverged; update manually with git.";
    }
    if (status.dirty) {
        return "Local changes detected. Commit or stash before updating.";
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
    } else if (status.state === "ahead" || status.state === "diverged") {
        type = "error";
    }

    showAppUpdateStatus(type, msg);

    const updateBtn = document.getElementById("btn-update-app");
    if (updateBtn && status) {
        updateBtn.disabled = !status.can_update;
        updateBtn.title = status.can_update ? "Pull latest changes from GitHub" : msg;
    }
}

async function checkAppUpdateStatus() {
    showAppUpdateStatus("info", "Checking app update status...");
    try {
        const status = await fetchJson("/api/app-update-status");
        renderAppUpdateStatus(status);
    } catch (e) {
        showAppUpdateStatus("error", "Failed to check app updates: " + e.message);
    }
}

async function updateAppFromGitHub() {
    const status = latestAppUpdateStatus || await fetchJson("/api/app-update-status");
    if (!status.can_update) {
        renderAppUpdateStatus(status);
        return;
    }

    const ok = await confirmAction(
        "Update Llama GUI",
        "Pull latest changes from GitHub now? The app may need a restart after updating.",
        "Update"
    );
    if (!ok) return;

    showAppUpdateStatus("info", "Pulling latest changes from GitHub...");
    try {
        const result = await fetchJson("/api/app-update", { method: "POST" });
        if (result.updated) {
            showAppUpdateStatus("success", "App updated. Restart Llama GUI to load new code.");
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

async function refreshModels() {
    const sel = document.getElementById("model-select");
    const current = sel.value;
    sel.innerHTML = '<option value="">-- Select Model --</option>';
    try {
        const models = await fetchJson("/api/models");
        for (const m of models) {
            if (!m.name || !String(m.name).toLowerCase().endsWith(".gguf")) continue;
            const opt = document.createElement("option");
            opt.value = m.name;
            opt.textContent = `${m.name}  (${m.size_mb} MB)`;
            sel.appendChild(opt);
        }
        if (current) sel.value = current;
    } catch (e) {
        // ignore
    }
}

