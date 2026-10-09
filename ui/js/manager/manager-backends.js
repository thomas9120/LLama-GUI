// Backend selection, activation, and installed-backend presentation.
(() => {
    const I = window.LlamaGui._managerInternal;

    let lastInstalledInfoRenderKey = "";
    let pendingInstallBackendId = null;
    let customActivationInProgress = false;
    let systemActivationInProgress = false;

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

    function isCustomBackend(backendId, status = I.status.getLatestStatus()) {
        return backendId === "custom" || backendOptionsFromStatus(status)
            .some((backend) => backend.id === backendId && backend.custom === true);
    }

    function isSystemBackend(backendId, status = I.status.getLatestStatus()) {
        if (normalizeBackendId(backendId) === "system") return true;
        return backendOptionsFromStatus(status)
            .some((backend) => backend && backend.id === backendId && backend.system_path === true);
    }

    function customBackendFolder(backendId, status = I.status.getLatestStatus()) {
        const backend = backendOptionsFromStatus(status).find((entry) => entry.id === backendId);
        return backend && backend.bin_dir ? backend.bin_dir : "llama/custom/bin/";
    }

    function installedBackendIdFromStatus(status) {
        return normalizeBackendId(status && status.backend);
    }

    function canActivateOfficialBackend(status, backendId) {
        const target = normalizeBackendId(backendId);
        const official = status && status.official_install;
        const recordedBackend = normalizeBackendId(official && official.backend);
        const sourceIsSwitchable = isCustomBackend(status && status.backend, status)
            || isSystemBackend(status && status.backend, status);
        return Boolean(
            status
            && sourceIsSwitchable
            && target
            && !isCustomBackend(target, status)
            && !isSystemBackend(target, status)
            && official
            && official.files_present
            && (!recordedBackend || recordedBackend === target)
        );
    }

    function systemBuildTagForTool(status, tool) {
        const tags = status && status.runtime_health && status.runtime_health.build_tags;
        const tag = tags && typeof tags === "object" ? tags[tool] : null;
        return typeof tag === "string" && tag ? tag : null;
    }

    function systemToolEntries(status) {
        const tools = status && status.system_tools && typeof status.system_tools === "object"
            ? status.system_tools
            : {};
        return Object.entries(tools);
    }

    function describeSystemToolsForSetup(status) {
        const entries = systemToolEntries(status);
        if (!entries.length) return "Checking PATH for llama.cpp tools...";
        return entries.map(([tool, info]) => {
            const path = info && info.path ? info.path : "not found on PATH";
            return `${tool}: ${path}`;
        }).join(" · ");
    }

    function renderSystemToolRows(status, container) {
        const entries = systemToolEntries(status);
        for (const [tool, info] of entries) {
            const available = Boolean(info && info.available);
            const required = tool === "llama-server";
            const row = document.createElement("div");
            row.className = "installed-tool-row";
            const label = document.createElement("code");
            label.textContent = tool;
            const state = document.createElement("span");
            state.className = available ? "exe-ok" : required ? "exe-missing" : "exe-optional";
            state.textContent = available ? "Available" : required ? "Missing · required" : "Not installed";
            row.appendChild(label);
            row.appendChild(state);
            container.appendChild(row);
            const pathLine = document.createElement("div");
            pathLine.className = "installed-info-hint";
            const toolPath = info && info.path ? info.path : "not found on PATH";
            const tag = info && info.build_tag ? ` · build ${info.build_tag}` : "";
            pathLine.textContent = toolPath + tag;
            container.appendChild(pathLine);
        }
    }

    function renderInstalledSystemStatus(status, appendRow, info, optionalToolsOpen) {
        appendRow("Backend", backendLabelFromStatus(status, status.backend));
        const serverInfo = (status.system_tools || {})["llama-server"] || {};
        if (serverInfo.path) appendRow("Server", serverInfo.path);
        appendRow("Server build", serverInfo.build_tag || "unknown build");

        const requiredBox = document.createElement("div");
        requiredBox.className = "installed-tools";
        const requiredTitle = document.createElement("h4");
        requiredTitle.textContent = "Required tool";
        requiredBox.appendChild(requiredTitle);
        const serverRow = document.createElement("div");
        serverRow.className = "installed-tool-row";
        const serverLabel = document.createElement("code");
        serverLabel.textContent = "llama-server";
        const serverState = document.createElement("span");
        serverState.className = serverInfo.available ? "exe-ok" : "exe-missing";
        serverState.textContent = serverInfo.available ? "Available" : "Missing · required";
        serverRow.appendChild(serverLabel);
        serverRow.appendChild(serverState);
        requiredBox.appendChild(serverRow);
        if (serverInfo.path) {
            const pathLine = document.createElement("div");
            pathLine.className = "installed-info-hint";
            pathLine.textContent = serverInfo.path;
            requiredBox.appendChild(pathLine);
        }
        info.appendChild(requiredBox);

        const others = systemToolEntries(status).filter(([tool]) => tool !== "llama-server");
        if (others.length) {
            const optionalBox = document.createElement("details");
            optionalBox.id = "installed-optional-tools";
            optionalBox.className = "installed-tools";
            optionalBox.open = Boolean(optionalToolsOpen);
            const availableCount = others.filter(([, entry]) => entry && entry.available).length;
            const optionalTitle = document.createElement("summary");
            optionalTitle.textContent = `Feature tools · ${availableCount} of ${others.length} available`;
            optionalBox.appendChild(optionalTitle);
            const hint = document.createElement("p");
            hint.className = "installed-info-hint";
            hint.textContent = "Each tool is optional for its own feature: Terminal needs llama-cli; Benchmarking needs llama-bench or llama-perplexity.";
            optionalBox.appendChild(hint);
            for (const [tool, entry] of others) {
                const row = document.createElement("div");
                row.className = "installed-tool-row";
                const label = document.createElement("code");
                label.textContent = tool;
                const state = document.createElement("span");
                state.className = entry && entry.available ? "exe-ok" : "exe-optional";
                state.textContent = entry && entry.available ? "Available" : "Not installed";
                row.appendChild(label);
                row.appendChild(state);
                optionalBox.appendChild(row);
                const pathLine = document.createElement("div");
                pathLine.className = "installed-info-hint";
                const toolPath = entry && entry.path ? entry.path : "not found on PATH";
                const tag = entry && entry.build_tag ? ` · build ${entry.build_tag}` : "";
                pathLine.textContent = toolPath + tag;
                optionalBox.appendChild(pathLine);
            }
            info.appendChild(optionalBox);
        }

        const note = document.createElement("div");
        note.className = "installed-info-hint";
        note.textContent = "Installation and updates are managed by the OS package manager.";
        info.appendChild(note);
    }

    function renderStaleSystemStatus(status, appendRow, info) {
        const warning = document.createElement("div");
        warning.className = "installed-info-warning";
        warning.textContent = status.system_server_error
            || "Configuration exists, but the required llama-server was not found.";
        info.appendChild(warning);

        const hint = document.createElement("div");
        hint.className = "installed-info-hint";
        hint.textContent = "System tools are discovered from the PATH inherited by Llama GUI. "
            + "Start the GUI from the environment where llama-server is available, "
            + "or restart the GUI after changing its launch environment. "
            + "Updates are managed by the OS package manager.";
        info.appendChild(hint);

        appendRow("Version (config)", String(status.version));
        appendRow("Backend (config)", backendLabelFromStatus(status, status.backend));
        const box = document.createElement("div");
        box.className = "installed-tools";
        renderSystemToolRows(status, box);
        info.appendChild(box);
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
        const customTargetSelected = isCustomBackend(installTarget, status);
        const systemTargetSelected = isSystemBackend(installTarget, status);
        const systemInstalled = isSystemBackend(installedBackend, status);
        const customInstalled = isCustomBackend(installedBackend, status);
        const canActivateExisting = canActivateOfficialBackend(status, installTarget);

        if (installBtn && systemTargetSelected) {
            installBtn.textContent = "Activate System";
            installBtn.title = "Use the llama.cpp tools on the PATH inherited by Llama GUI";
        } else if (installBtn && !customTargetSelected) {
            installBtn.textContent = canActivateExisting ? "Activate Existing" : "Install";
            installBtn.title = canActivateExisting
                ? "Use the official llama.cpp files already installed in llama/bin"
                : "Download and install the selected llama.cpp release";
        }

        if (updateBtn) {
            const canUpdate = !customTargetSelected && !systemTargetSelected && hasInstalledBackend && !customInstalled && !systemInstalled;
            updateBtn.disabled = !canUpdate;
            updateBtn.title = canUpdate
                ? "Check the installed backend for updates"
                : customTargetSelected || customInstalled
                    ? "Custom backend installations are managed manually"
                    : systemTargetSelected || systemInstalled
                        ? "System (PATH) tools are updated by the OS package manager"
                        : "Install llama.cpp before checking for updates";
        }

        if (repairBtn) {
            const canRepair = !customTargetSelected && !systemTargetSelected && hasStaleBackendConfig && !customInstalled && !systemInstalled;
            repairBtn.classList.toggle("hidden", !canRepair && !customTargetSelected && !systemTargetSelected);
            repairBtn.disabled = !canRepair;
            repairBtn.title = customTargetSelected || customInstalled
                ? "Custom backend files are managed manually"
                : systemTargetSelected || systemInstalled
                    ? "System (PATH) tools are managed by the OS package manager"
                    : canRepair
                        ? "Reinstall the configured backend files"
                        : "Repair is available only for incomplete default backend installs";
        }
    }

    function selectedBackendId() {
        const sel = document.getElementById("backend-select");
        return sel ? String(sel.value || "") : "";
    }

    function showCustomBackendControls(backend = selectedBackendId(), status = I.status.getLatestStatus()) {
        I.install.resetReleasesForBackend(backend);

        const sel = document.getElementById("release-select");
        if (sel) {
            sel.textContent = "";
            const option = document.createElement("option");
            option.value = backend;
            option.textContent = backendLabelFromStatus(status, backend);
            sel.appendChild(option);
            sel.disabled = true;
        }
        const releaseGroup = document.getElementById("release-group");
        if (releaseGroup) releaseGroup.style.display = "none";
        const customInfo = document.getElementById("custom-backend-info");
        if (customInfo) customInfo.style.display = "";
        const systemInfo = document.getElementById("system-backend-info");
        if (systemInfo) systemInfo.style.display = "none";
        const folder = document.getElementById("custom-backend-folder");
        if (folder) folder.textContent = customBackendFolder(backend, status);
        const title = document.getElementById("custom-backend-title");
        if (title) title.textContent = backendLabelFromStatus(status, backend) + " Setup:";
        const installBtn = document.getElementById("btn-install");
        if (installBtn) {
            installBtn.textContent = "Activate Custom";
        }
        const updateBtn = document.getElementById("btn-update");
        if (updateBtn) updateBtn.disabled = true;
        const repairBtn = document.getElementById("btn-repair");
        if (repairBtn) repairBtn.classList.add("hidden");
    }

    function showSystemBackendControls(backend = selectedBackendId(), status = I.status.getLatestStatus()) {
        I.install.resetReleasesForBackend(backend);

        const sel = document.getElementById("release-select");
        if (sel) {
            sel.textContent = "";
            const option = document.createElement("option");
            option.value = backend;
            option.textContent = backendLabelFromStatus(status, backend);
            sel.appendChild(option);
            sel.disabled = true;
        }
        const releaseGroup = document.getElementById("release-group");
        if (releaseGroup) releaseGroup.style.display = "none";
        const customInfo = document.getElementById("custom-backend-info");
        if (customInfo) customInfo.style.display = "none";
        const systemInfo = document.getElementById("system-backend-info");
        if (systemInfo) systemInfo.style.display = "";
        const tools = document.getElementById("system-backend-tools");
        if (tools) tools.textContent = describeSystemToolsForSetup(status);
        const title = document.getElementById("system-backend-title");
        if (title) title.textContent = backendLabelFromStatus(status, backend) + " Setup:";
        const installBtn = document.getElementById("btn-install");
        if (installBtn) {
            installBtn.textContent = "Activate System";
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
        const systemInfo = document.getElementById("system-backend-info");
        if (systemInfo) systemInfo.style.display = "none";
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
        const installedBackend = installedBackendIdFromStatus(I.status.getLatestStatus());
        pendingInstallBackendId = backend && backend !== installedBackend ? backend : null;
        if (isSystemBackend(backend)) {
            showSystemBackendControls();
            syncInstallActionButtons(I.status.getLatestStatus(), backend);
            return;
        }
        if (isCustomBackend(backend)) {
            showCustomBackendControls();
            syncInstallActionButtons(I.status.getLatestStatus(), backend);
            return;
        }
        showOfficialBackendControls();
        syncInstallActionButtons(I.status.getLatestStatus(), backend);
        I.install.fetchReleases(backend);
    }

    async function activateCustomBackend() {
        if (customActivationInProgress) return;
        customActivationInProgress = true;
        const backend = selectedBackendId();
        const label = backendLabelFromStatus(I.status.getLatestStatus(), backend);
        const folder = customBackendFolder(backend);
        I.install.setInstallButtonsDisabled(true);
        I.install.showStatus("info", `Checking ${label} binaries...`);
        try {
            const result = await I.dependencies.fetchJson("/api/activate-custom", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ backend }),
            });
            if (result.ok) {
                const foundList = (result.found || []).join(", ");
                const missingList = (result.missing || []).join(", ");
                let msg = label + " backend activated. Found: " + (foundList || "none") + ".";
                if (missingList) msg += " Missing: " + missingList + ".";
                I.install.showStatus("success", msg);
                await I.status.checkStatus();
            } else {
                const missingRequired = (result.missing_required || []).join(", ");
                const notExecutable = (result.not_executable || []).join(", ");
                const missingRuntime = (result.missing_runtime_files || []).join(", ");
                if (result.error) {
                    I.install.showStatus("error", result.error);
                } else if (missingRuntime) {
                    I.install.showStatus("error", `${label} is missing runtime libraries in ${folder}: ${missingRuntime}.`);
                } else if (notExecutable) {
                    I.install.showStatus("error", `${label} tools must be executable in ${folder}: ${notExecutable}.`);
                } else {
                    const missingList = missingRequired || (result.missing || []).join(", ");
                    I.install.showStatus("error", `${label} needs llama-cli and llama-server in ${folder}. Missing: ${missingList || "required tools"}.`);
                }
            }
        } catch (e) {
            I.install.showStatus("error", `Failed to activate ${label}: ${e.message}`);
        } finally {
            customActivationInProgress = false;
            I.install.setInstallButtonsDisabled(false);
            syncInstallActionButtons(I.status.getLatestStatus(), selectedBackendId());
        }
    }

    async function activateSystemBackend() {
        if (systemActivationInProgress) return;
        systemActivationInProgress = true;
        const backend = selectedBackendId();
        const label = backendLabelFromStatus(I.status.getLatestStatus(), backend);
        I.install.setInstallButtonsDisabled(true);
        I.install.showStatus("info", `Checking ${label} tools on PATH...`);
        try {
            const result = await I.dependencies.fetchJson("/api/activate-system", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (result.ok) {
                const foundList = (result.found || []).join(", ");
                const missingList = (result.missing || []).join(", ");
                const serverPath = result.server_path || (result.paths && result.paths["llama-server"]) || "";
                let msg = `${label} activated. Server: ${serverPath || "found on PATH"}.`;
                if (foundList) msg += ` Found: ${foundList}.`;
                if (missingList) msg += ` Unavailable: ${missingList}.`;
                I.install.showStatus("success", msg);
                await I.status.checkStatus();
            } else if (result.error) {
                I.install.showStatus("error", result.error);
            } else {
                I.install.showStatus("error", `Failed to activate ${label}.`);
            }
        } catch (e) {
            I.install.showStatus("error", `Failed to activate ${label}: ${e.message}`);
        } finally {
            systemActivationInProgress = false;
            I.install.setInstallButtonsDisabled(false);
            syncInstallActionButtons(I.status.getLatestStatus(), selectedBackendId());
        }
    }

    async function activateOfficialBackend(backend) {
        I.install.setInstallButtonsDisabled(true);
        I.install.showStatus("info", `Activating existing ${backend} backend...`);
        try {
            const result = await I.dependencies.fetchJson("/api/install", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ backend, activate_existing: true }),
            });
            I.install.showStatus("success", `Existing ${result.tag} (${result.backend}) installation activated.`);
            await I.status.checkStatus();
        } catch (e) {
            I.install.showStatus("error", "Failed to activate existing backend: " + e.message);
        } finally {
            I.install.setInstallButtonsDisabled(false);
            syncInstallActionButtons(I.status.getLatestStatus(), selectedBackendId());
        }
    }

    function updateStatusUI(status) {
        if (!status) return;
        const badge = document.getElementById("version-badge");
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
        if (isSystemBackend(activeBackend, status)) {
            showSystemBackendControls(activeBackend, status);
        } else if (isCustomBackend(activeBackend, status)) {
            showCustomBackendControls(activeBackend, status);
        } else {
            showOfficialBackendControls();
        }
        syncInstallActionButtons(status, activeBackend);
        if (customActivationInProgress || systemActivationInProgress) I.install.setInstallButtonsDisabled(true);

        if (backendSelect) {
            const targetBackend = activeBackend;
            if (!isCustomBackend(targetBackend, status) && !isSystemBackend(targetBackend, status)) {
                I.install.ensureReleasesForBackend(targetBackend);
            }
        }

        if ((status.installed || status.config_stale) && status.tag && releaseSelect) {
            const hasTagOption = Array.from(releaseSelect.options).some((opt) => opt.value === status.tag);
            if (hasTagOption) {
                releaseSelect.value = status.tag;
            }
        }

        if (status.installed) {
            if (isSystemBackend(status.backend, status)) {
                const serverTag = systemBuildTagForTool(status, "llama-server");
                badge.textContent = serverTag
                    ? `${backendLabelFromStatus(status, status.backend)} ${serverTag}`
                    : `${backendLabelFromStatus(status, status.backend)} (unknown build)`;
            } else {
                badge.textContent = isCustomBackend(status.backend, status)
                    ? backendLabelFromStatus(status, status.backend)
                    : status.version + " (" + status.backend + ")";
            }
            badge.className = "badge badge-green";
        } else if (status.config_stale) {
            badge.textContent = "Install Incomplete";
            badge.className = "badge badge-yellow";
        } else {
            badge.textContent = "Not Installed";
            badge.className = "badge";
        }

        // Keep disclosure focus and state during status polls that change only runtime data.
        const installedInfoRenderKey = JSON.stringify([
            status.installed, status.config_stale, status.version, status.backend, status.executables,
            status.runtime_files, status.runtime_files_label, status.missing_runtime_files,
            status.platform, status.platform_label, status.arch, status.available_backends,
            status.system_tools, status.system_server_error,
            status.runtime_health && status.runtime_health.build_tags,
        ]);
        if (installedInfoRenderKey === lastInstalledInfoRenderKey) return;
        lastInstalledInfoRenderKey = installedInfoRenderKey;
        const optionalToolsOpen = Boolean(document.getElementById("installed-optional-tools")?.open);
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
            if (isSystemBackend(status.backend, status)) {
                renderInstalledSystemStatus(status, appendRow, info, optionalToolsOpen);
            } else {
                appendRow("Version", String(status.version));
                appendRow("Backend", backendLabelFromStatus(status, status.backend));
            if (isCustomBackend(status.backend, status)) {
                appendRow("Folder", customBackendFolder(status.backend, status));
            }

            const tools = Object.entries(status.executables || {});
            const isCoreTool = name => /^llama-(cli|server)(\.|$)/.test(String(name));
            const coreTools = document.createElement("div");
            coreTools.className = "installed-tools";
            const coreTitle = document.createElement("h4");
            coreTitle.textContent = "Launch tools";
            coreTools.appendChild(coreTitle);

            const optionalTools = document.createElement("details");
            optionalTools.id = "installed-optional-tools";
            optionalTools.className = "installed-tools";
            optionalTools.open = optionalToolsOpen;
            const optionalEntries = tools.filter(([name]) => !isCoreTool(name));
            const optionalTitle = document.createElement("summary");
            optionalTitle.textContent = `Optional tools · ${optionalEntries.filter(([, exists]) => exists).length} of ${optionalEntries.length} installed`;
            optionalTools.appendChild(optionalTitle);
            const hint = document.createElement("p");
            hint.className = "installed-info-hint";
            hint.textContent = "Benchmark and utility tools are only needed for their respective tasks.";
            optionalTools.appendChild(hint);

            for (const [name, exists] of tools) {
                const required = isCoreTool(name);
                const row = document.createElement("div");
                row.className = "installed-tool-row";
                const label = document.createElement("code");
                label.textContent = name;
                const state = document.createElement("span");
                state.className = exists ? "exe-ok" : required ? "exe-missing" : "exe-optional";
                state.textContent = exists ? "Available" : required ? "Missing · required" : "Not installed";
                row.appendChild(label);
                row.appendChild(state);
                (required ? coreTools : optionalTools).appendChild(row);
            }
            info.appendChild(coreTools);
            if (optionalEntries.length) info.appendChild(optionalTools);

            if (status.runtime_files && status.runtime_files.length > 0) {
                appendRow(status.runtime_files_label || "Runtime libraries", `${status.runtime_files.length} file(s)`);
            }
            }
        } else if (status.config_stale) {
            if (isSystemBackend(status.backend, status)) {
                renderStaleSystemStatus(status, appendRow, info);
            } else {
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
            hint.textContent = isCustomBackend(status.backend, status)
                ? `Check the required tools and runtime libraries in ${customBackendFolder(status.backend, status)}, then click Activate Custom again.`
                : status.platform === "linux" && missingRuntimeFiles.length > 0
                    ? "Click Repair Install first. If the same libraries remain missing, install or update the Vulkan/ROCm driver runtime for this system."
                    : "Click Repair Install to reinstall the configured version/backend and restore binaries.";
            info.appendChild(hint);

            appendRow("Version (config)", String(status.version));
            appendRow("Backend (config)", backendLabelFromStatus(status, status.backend));
            if (isCustomBackend(status.backend, status)) {
                appendRow("Folder", customBackendFolder(status.backend, status));
            }
            }
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

    I.backends = {
        isCustomBackend,
        isSystemBackend,
        canActivateOfficialBackend,
        selectedBackendId,
        onBackendChange,
        activateCustomBackend,
        activateSystemBackend,
        activateOfficialBackend,
        updateStatusUI,
    };
})();
