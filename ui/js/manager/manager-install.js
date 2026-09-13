// Release cache, installation actions, progress polling, and install-status UI.
(() => {
    const I = window.LlamaGui._managerInternal;

    let cachedReleases = null;
    let releasesBackend = null;
    let releasesBackendInFlight = null;
    let releaseFetchRequestId = 0;
    let installPollTimer = null;
    let installPollStartTime = null;
    let installPollFailCount = 0;
    let installPollInFlight = false;
    const INSTALL_POLL_TIMEOUT_MS = 10 * 60 * 1000;
    const INSTALL_POLL_MAX_FAILS = 5;

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
            const releases = await I.dependencies.fetchJson(url);
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
            if (I.status.getLatestStatus() && I.status.getLatestStatus().tag) {
                const hasInstalledTag = Array.from(sel.options).some((opt) => opt.value === I.status.getLatestStatus().tag);
                if (hasInstalledTag) {
                    sel.value = I.status.getLatestStatus().tag;
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

    async function installRelease() {
        const backendEl = document.getElementById("backend-select");
        if (backendEl && I.backends.isCustomBackend(backendEl.value)) {
            return I.backends.activateCustomBackend();
        }
        const backend = backendEl ? backendEl.value : "";
        if (I.backends.canActivateOfficialBackend(I.status.getLatestStatus(), backend)) {
            return I.backends.activateOfficialBackend(backend);
        }
        const tag = document.getElementById("release-select").value;
        if (!tag) {
            showStatus("error", "Select a version first");
            return;
        }

        await startInstall(tag, backend, `Installing ${tag} (${backend})...`);
    }

    async function repairInstall() {
        const status = I.status.getLatestStatus() || await I.status.checkStatus();
        if (!status || !status.version || !status.backend) {
            showStatus("error", "No saved installation config found to repair.");
            return;
        }

        const ok = await I.dependencies.confirmAction(
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
        const status = I.status.getLatestStatus() || await I.status.checkStatus();
        if (status && status.running) {
            showStatus("error", "Stop the running llama.cpp process before cleaning files.");
            return;
        }

        const ok = await I.dependencies.confirmAction(
            "Remove llama.cpp Files",
            "Delete all files under llama/bin, llama/dll, and llama/grammars, and clear official install metadata? Both Custom slots, models, and presets will be kept.",
            "Remove"
        );
        if (!ok) return;

        try {
            const result = await I.dependencies.fetchJson("/api/cleanup-llama", { method: "POST" });
            showStatus("success", `Removed ${result.removed_files || 0} llama.cpp file(s).`);
            I.status.checkStatus();
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

    async function startInstall(tag, backend, startMessage) {
        showStatus("info", startMessage);
        setInstallButtonsDisabled(true);
        showProgress(true);

        try {
            const result = await I.dependencies.fetchJson("/api/install", {
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
            const result = await I.dependencies.fetchJson("/api/update", { method: "POST" });
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
                const prog = await I.dependencies.fetchJson("/api/download-progress");
                installPollFailCount = 0;
                updateProgressBar(prog);
                if (prog.status === "done") {
                    stopInstallProgressPolling();
                    showStatus("success", prog.message);
                    showProgress(false);
                    setInstallButtonsDisabled(false);
                    I.status.checkStatus();
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

    function openFolder(folder) {
        I.dependencies.fetchJson("/api/open-folder", {
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

    function resetReleasesForBackend(backend) {
        releaseFetchRequestId += 1;
        cachedReleases = null;
        releasesBackend = backend;
        releasesBackendInFlight = null;
    }

    function ensureReleasesForBackend(targetBackend) {
        if (targetBackend !== releasesBackend && targetBackend !== releasesBackendInFlight) {
            fetchReleases(targetBackend);
        }
    }

    I.install = {
        fetchReleases,
        installRelease,
        repairInstall,
        removeLlamaFiles,
        setInstallButtonsDisabled,
        checkForUpdates,
        stopInstallProgressPolling,
        showStatus,
        openFolder,
        resetReleasesForBackend,
        ensureReleasesForBackend,
    };
})();
