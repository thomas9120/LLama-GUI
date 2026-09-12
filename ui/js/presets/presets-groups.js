// Presets package (8/10): group/list rendering, status toasts, loadPresets, and library control wiring.
function renderPresetGroups(container, groups) {
    // Selecting, favoriting, or filtering rebuilds every row, which would drop
    // keyboard focus to the body mid-navigation. Restored below, but only when
    // focus was inside the list to begin with, so a background re-render never
    // steals it from elsewhere on the page.
    const restoreFocus = presetListHasFocus(container);
    container.textContent = "";

    if (groups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "presets-empty";
        empty.textContent = presetSearchQuery
            ? "No presets match your search."
            : presetArchiveViewActive
                ? "The archive is empty. Archive a preset to move it out of the main list."
                : presetWarningFilterActive
                    ? "No presets with warnings."
                    : presetFavoritesMode === "only"
                        ? "No favorite presets yet. Star a preset to keep it here."
                        : "No saved presets yet. Save the current configuration above or import a JSON preset file.";
        container.appendChild(empty);
        renderPresetAuxiliaryPanels();
        return;
    }

    // when searching or filtering, force groups open so matches are visible
    const forceExpanded = Boolean(presetSearchQuery.trim())
        || presetWarningFilterActive
        || presetFavoritesMode === "only"
        || presetArchiveViewActive;

    for (const group of groups) {
        const groupEl = document.createElement("section");
        groupEl.className = "preset-group";
        const collapsed = !forceExpanded && isPresetGroupCollapsed(group.key);
        if (collapsed) groupEl.classList.add("collapsed");

        const header = document.createElement("button");
        header.className = "preset-group-header";
        header.type = "button";
        header.setAttribute("data-group-key", group.key);
        header.setAttribute("aria-expanded", String(!collapsed));
        header.title = group.modelPath && group.modelPath !== group.label ? group.modelPath : group.label;

        const chevron = document.createElement("span");
        chevron.className = "preset-group-chevron";
        chevron.appendChild(createPresetIcon(PRESET_ICON_CHEVRON));

        const title = document.createElement("span");
        title.className = "preset-group-title";
        const titleText = document.createElement("bdo");
        titleText.textContent = group.label.replace(/\.gguf$/i, "");
        title.appendChild(titleText);

        header.appendChild(chevron);
        header.appendChild(title);

        if (group.visibleWarningCount > 0) {
            const warnDot = document.createElement("span");
            warnDot.className = "preset-warn-dot";
            warnDot.title = `${group.visibleWarningCount} warning${group.visibleWarningCount === 1 ? "" : "s"}`;
            header.appendChild(warnDot);
        }

        const quant = getModelQuantLabel(group.label);
        if (quant) {
            const quantBadge = document.createElement("span");
            quantBadge.className = "preset-quant-badge";
            quantBadge.textContent = quant;
            header.appendChild(quantBadge);
        }

        const countBadge = document.createElement("span");
        countBadge.className = "preset-count-badge";
        countBadge.textContent = String(group.entries.length);
        countBadge.title = `${group.entries.length} preset${group.entries.length === 1 ? "" : "s"}`;
        header.appendChild(countBadge);

        header.addEventListener("click", () => {
            const nextCollapsed = !groupEl.classList.contains("collapsed");
            groupEl.classList.toggle("collapsed", nextCollapsed);
            header.setAttribute("aria-expanded", String(!nextCollapsed));
            setPresetGroupCollapsed(group.key, nextCollapsed);
            // Collapsing removes this group's rows from the focus sequence, and
            // expanding adds them back, so the roving state has to be rebuilt.
            // Anchoring on the header keeps focus where the user just acted,
            // rather than stranding it on a row that no longer exists.
            presetRovingKey = getPresetFocusItemKey(header);
            applyPresetRovingTabIndex(container);
        });

        const list = document.createElement("div");
        list.className = "preset-group-list";
        for (const entry of group.entries) {
            list.appendChild(renderPresetEntry(entry));
        }

        groupEl.appendChild(header);
        groupEl.appendChild(list);
        container.appendChild(groupEl);
    }

    initPresetRovingFocus(container);
    applyPresetRovingTabIndex(container, restoreFocus);

    renderPresetAuxiliaryPanels();
}

function showPresetStatus(message, type = "success", durationMs = 2200) {
    const statusEl = document.getElementById("preset-status");
    if (!statusEl) return;
    if (presetStatusTimer) {
        clearTimeout(presetStatusTimer);
        presetStatusTimer = null;
    }
    statusEl.className = "status-box";
    statusEl.classList.add(type);
    statusEl.textContent = message;
    presetStatusTimer = setTimeout(() => {
        statusEl.className = "status-box";
        statusEl.textContent = "";
        presetStatusTimer = null;
    }, durationMs);
}

function showPresetActionStatus(message, type = "success", durationMs = 2200) {
    showPresetStatus(message, type, durationMs);
    const showToast = presetDependencies.showToast;
    if (typeof showToast === "function") {
        showToast(message, type, { duration: durationMs });
    }
}

// Missing-model warnings are computed at build time from the cached model list,
// so a model list that changes after the groups were built leaves the badges,
// the Warnings filter, and the summary stale. loadPresets() already runs on
// every switch into the tab, which covers the user who arrives afterwards; this
// covers the two cases where the list moves while the tab is already open:
// a download finishing in the background, and the startup refreshModels() that
// resolves after a fast click into Presets.
//
// Guarded on the section rather than #presets-list, which is static markup in
// index.html and therefore always present — testing for it would rebuild on
// every model refresh, including for users who never open the tab.
function refreshModelPresence() {
    const section = document.getElementById("section-presets");
    if (!section || section.style.display === "none") return;
    loadPresets();
}

async function loadPresets() {
    const requestId = ++loadPresetsRequestId;
    const container = document.getElementById("presets-list");
    if (!container) return;
    container.textContent = "";
    try {
        const presets = await fetchPresetEntries();
        if (requestId !== loadPresetsRequestId) return;
        reconcileLoadedPreset(presets);
        presetArchivedCount = presets.filter((preset) => preset.archived === true).length;
        renderPresetArchiveChip();
        currentPresetGroups = buildPresetGroups(presets);
        const visibleEntries = getVisiblePresetEntries();
        const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
        selectedPresetNames = new Set(Array.from(selectedPresetNames).filter((name) => visibleNames.has(name)));
        if (!visibleNames.has(selectedPresetName)) {
            selectedPresetName = "";
        }
        renderPresetGroups(container, currentPresetGroups);
    } catch (e) {
        if (requestId !== loadPresetsRequestId) return;
        console.warn("Failed to load preset library", e);
        currentPresetGroups = [];
        selectedPresetName = "";
        selectedPresetNames.clear();
        const error = document.createElement("div");
        error.className = "presets-empty presets-error";
        error.textContent = "Failed to load presets.";
        container.appendChild(error);
        renderPresetLoadErrorState();
    }
}

function renderPresetFavoritesChip() {
    const chip = document.getElementById("preset-favorites-first");
    if (!chip) return;
    const labels = {
        all: { text: "★ Favorites", title: "Click to keep favorite presets and model groups above other results" },
        first: { text: "★ Favorites first", title: "Favorites are sorted first. Click to show only favorites" },
        only: { text: "★ Favorites only", title: "Showing only favorites. Click to show all presets" },
    };
    const label = labels[presetFavoritesMode] || labels.all;
    chip.textContent = label.text;
    chip.title = label.title;
    chip.classList.toggle("active", presetFavoritesMode !== "all");
    chip.classList.toggle("preset-chip-favorite-only", presetFavoritesMode === "only");
    chip.setAttribute("aria-pressed", String(presetFavoritesMode !== "all"));
}

function initPresetLibraryControls() {
    const search = document.getElementById("preset-search");
    if (search) {
        search.addEventListener("input", () => {
            presetSearchQuery = search.value.trim();
            loadPresets();
        });
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && search.value) {
                search.value = "";
                presetSearchQuery = "";
                loadPresets();
            }
        });
    }

    const sortSelect = document.getElementById("preset-sort");
    if (sortSelect) {
        sortSelect.value = presetSortMode;
        sortSelect.addEventListener("change", () => {
            presetSortMode = PRESET_SORT_MODES.has(sortSelect.value) ? sortSelect.value : "name";
            setPresetStorageItem(PRESET_SORT_STORAGE_KEY, presetSortMode);
            loadPresets();
        });
    }

    const expandAll = document.getElementById("btn-presets-expand-all");
    if (expandAll) {
        expandAll.addEventListener("click", () => {
            const state = loadPresetGroupState();
            for (const group of currentPresetGroups) {
                state[group.key] = false;
            }
            savePresetGroupState(state);
            loadPresets();
        });
    }

    const collapseAll = document.getElementById("btn-presets-collapse-all");
    if (collapseAll) {
        collapseAll.addEventListener("click", () => {
            const state = loadPresetGroupState();
            for (const group of currentPresetGroups) {
                state[group.key] = true;
            }
            savePresetGroupState(state);
            loadPresets();
        });
    }

    const selectAll = document.getElementById("btn-presets-select-all");
    if (selectAll) {
        selectAll.addEventListener("click", () => {
            for (const entry of getVisiblePresetEntries()) {
                selectedPresetNames.add(entry.name);
            }
            renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
        });
    }

    const selectNone = document.getElementById("btn-presets-select-none");
    if (selectNone) {
        selectNone.addEventListener("click", () => {
            selectedPresetNames.clear();
            renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
        });
    }

    const deleteSelected = document.getElementById("btn-presets-delete-selected");
    if (deleteSelected) {
        deleteSelected.addEventListener("click", deleteSelectedPresets);
    }

    const favoriteSelected = document.getElementById("btn-presets-favorite-selected");
    if (favoriteSelected) {
        favoriteSelected.addEventListener("click", () => favoriteSelectedPresets(true));
    }

    const unfavoriteSelected = document.getElementById("btn-presets-unfavorite-selected");
    if (unfavoriteSelected) {
        unfavoriteSelected.addEventListener("click", () => favoriteSelectedPresets(false));
    }

    const exportSelected = document.getElementById("btn-presets-export-selected");
    if (exportSelected) {
        exportSelected.addEventListener("click", exportSelectedPresets);
    }

    const archiveSelected = document.getElementById("btn-presets-archive-selected");
    if (archiveSelected) {
        archiveSelected.addEventListener("click", () => archiveSelectedPresets(true));
    }

    const restoreSelected = document.getElementById("btn-presets-restore-selected");
    if (restoreSelected) {
        restoreSelected.addEventListener("click", () => archiveSelectedPresets(false));
    }

    const archiveView = document.getElementById("preset-archive-view");
    if (archiveView) {
        renderPresetArchiveChip();
        archiveView.addEventListener("click", () => {
            presetArchiveViewActive = !presetArchiveViewActive;
            renderPresetArchiveChip();
            loadPresets();
        });
    }

    const filterAll = document.getElementById("preset-filter-all");
    const filterWarnings = document.getElementById("preset-filter-warnings");
    const favoritesFirst = document.getElementById("preset-favorites-first");
    const setWarningFilter = (active) => {
        presetWarningFilterActive = active;
        if (filterAll) filterAll.classList.toggle("active", !active);
        if (filterWarnings) filterWarnings.classList.toggle("active", active);
        loadPresets();
    };
    if (filterAll) {
        filterAll.addEventListener("click", () => setWarningFilter(false));
    }
    if (filterWarnings) {
        filterWarnings.addEventListener("click", () => setWarningFilter(!presetWarningFilterActive));
    }
    if (favoritesFirst) {
        renderPresetFavoritesChip();
        favoritesFirst.addEventListener("click", () => {
            presetFavoritesMode = nextPresetFavoritesMode(presetFavoritesMode);
            renderPresetFavoritesChip();
            setPresetStorageItem(PRESET_FAVORITES_FIRST_STORAGE_KEY, presetFavoritesMode);
            loadPresets();
        });
    }
}
