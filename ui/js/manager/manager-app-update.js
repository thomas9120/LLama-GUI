// Git update status, channel selection, and the application update flow.
(() => {
    const I = window.LlamaGui._managerInternal;

    let latestAppUpdateStatus = null;

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
            const status = await I.dependencies.fetchJson(url);
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
                status = await I.dependencies.fetchJson(url);
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

        const ok = await I.dependencies.confirmAction(
            "Update Llama GUI",
            `Install the ${describeAppUpdateTarget(status)} from GitHub now? Python I.dependencies from requirements.txt will be installed after the update. The app may need a restart after updating.`,
            "Update"
        );
        if (!ok) return;

        showAppUpdateStatus("info", `Installing the ${describeAppUpdateTarget(status)} from GitHub...`);
        try {
            const result = await I.dependencies.fetchJson("/api/app-update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ channel }),
            });
            if (result.updated) {
                if (result.dependency_error) {
                    showAppUpdateStatus("warning", "App updated, but dependency installation failed: " + result.dependency_error + " Restart Llama GUI after fixing I.dependencies.");
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
                    await I.lifecycle.restartPythonServerAndReload({
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

    I.appUpdate = {
        checkAppUpdateStatus,
        updateAppFromGitHub,
    };
})();
