// Presets package (6/10): library summary, health message, detail/bulk panels, and entry rendering.
// Describes the presets currently visible rather than every preset on disk, so
// the numbers always agree with the list beside them and with the count line.
// Reading currentPresetGroups keeps this free of a second copy of library state.
function getPresetLibrarySummary() {
    const entries = getVisiblePresetEntries();
    const mostRecent = entries.reduce(
        (best, entry) => (entry.lastUsed && (!best || entry.lastUsed > best.lastUsed) ? entry : best),
        null
    );
    return {
        presetCount: entries.length,
        modelCount: currentPresetGroups.length,
        warningCount: entries.reduce((total, entry) => total + entry.warnings.length, 0),
        missingModelCount: entries.filter((entry) => entry.modelMissing).length,
        favoriteCount: entries.filter((entry) => entry.favorite).length,
        mostRecent,
        filtered: isPresetFilterActive(),
        // A zero missing-model count means "none found" only when the model list
        // actually loaded. With no list it means "not checked", and the two must
        // not read the same in the summary.
        modelsChecked: getKnownModelNames() !== null,
    };
}

// Health copy must never make a claim the counts underneath it cannot support.
// Two ways that goes wrong, both producing a false all-clear:
//   1. A filter narrows the view. Searching past the one preset with a deleted
//      GGUF would otherwise render "every preset loads cleanly" over hidden rot.
//   2. The model list never loaded. isPresetModelMissing() stays silent by
//      design when it has nothing to compare against, so a clean count there
//      means "not checked", not "checked and fine".
function getPresetHealthMessage(summary) {
    // Pointing at a filter that is already applied is dead advice.
    const review = presetWarningFilterActive ? "" : " Use the Warnings filter to review them.";
    const scopePrefix = summary.filtered ? "Of the presets shown, " : "";

    if (summary.missingModelCount > 0) {
        const count = summary.missingModelCount;
        const subject = count === 1 ? "1 preset points" : `${count} presets point`;
        return `${scopePrefix}${subject} at a model file that is no longer in the models folder.${review}`;
    }

    if (summary.warningCount > 0) {
        const count = summary.warningCount;
        const subject = `${count} warning${count === 1 ? "" : "s"}`;
        return summary.filtered
            ? `${subject} among the presets shown.${review}`
            : `${subject} across the library.${review}`;
    }

    // Clean, but model presence was never verified. Report the other warnings
    // honestly and say plainly which check did not run.
    if (!summary.modelsChecked) {
        return summary.filtered
            ? "No warnings among the presets shown. The model list has not loaded, so model files were not checked."
            : "No template or launch-argument warnings. The model list has not loaded, so model files were not checked.";
    }

    return summary.filtered
        ? "No warnings among the presets shown. Clear the search and filters to check the whole library."
        : "No warnings. Every preset points at a model that is present and loads cleanly.";
}

function renderPresetLibrarySummary(panel) {
    const summary = getPresetLibrarySummary();

    if (summary.presetCount === 0) {
        const empty = document.createElement("div");
        empty.className = "preset-detail-empty";
        empty.appendChild(createPresetIcon(PRESET_ICON_EMPTY));

        const emptyTitle = document.createElement("div");
        emptyTitle.className = "preset-detail-empty-title";
        emptyTitle.textContent = summary.filtered ? "No presets match" : "No presets saved yet";

        const emptyText = document.createElement("p");
        emptyText.textContent = summary.filtered
            ? "Clear the search or filters to see the rest of the library."
            : "Save a preset from Configure to keep a launch setup you can return to.";

        empty.appendChild(emptyTitle);
        empty.appendChild(emptyText);
        panel.appendChild(empty);
        return;
    }

    const kicker = document.createElement("div");
    kicker.className = "preset-detail-kicker";
    kicker.textContent = summary.filtered ? "Matching Presets" : "Preset Library";

    const title = document.createElement("div");
    title.className = "preset-detail-title";
    title.textContent = `${summary.presetCount} preset${summary.presetCount === 1 ? "" : "s"}`;

    const subtitle = document.createElement("div");
    subtitle.className = "preset-detail-subtitle";
    subtitle.textContent = summary.filtered
        ? "Filtered view. Clear the search and filters to summarize the whole library."
        : "Select a preset on the left to preview its saved model, tool, warnings, and settings.";

    const stats = document.createElement("div");
    stats.className = "preset-detail-stats";
    appendDetailStat(stats, "Models", String(summary.modelCount));
    appendDetailStat(stats, "Favorites", String(summary.favoriteCount));
    appendDetailStat(
        stats,
        "Warnings",
        String(summary.warningCount),
        summary.warningCount ? "warn" : "ok"
    );
    // An unchecked count must not render as a green zero, which reads as
    // "checked, none missing" — the same false all-clear as the health line.
    let missingModelClass = "";
    if (summary.modelsChecked) {
        missingModelClass = summary.missingModelCount ? "warn" : "ok";
    }
    appendDetailStat(
        stats,
        "Missing Models",
        summary.modelsChecked ? String(summary.missingModelCount) : "—",
        missingModelClass
    );

    panel.appendChild(kicker);
    panel.appendChild(title);
    panel.appendChild(subtitle);
    panel.appendChild(stats);

    const recentTitle = document.createElement("div");
    recentTitle.className = "preset-detail-section-title";
    recentTitle.textContent = "Most Recently Used";

    const recent = document.createElement("div");
    recent.className = "preset-detail-info preset-summary-block";
    const recentText = document.createElement("span");
    // textContent, never innerHTML: preset names are user-supplied.
    recentText.textContent = summary.mostRecent
        ? `${summary.mostRecent.name} · ${formatPresetTimestamp(summary.mostRecent.lastUsed)}`
        : "No preset loaded yet on this machine.";
    recent.appendChild(recentText);

    panel.appendChild(recentTitle);
    panel.appendChild(recent);

    const healthTitle = document.createElement("div");
    healthTitle.className = "preset-detail-section-title";
    // "Library Health" is an absolute claim, and the counts under it are not.
    healthTitle.textContent = summary.filtered ? "Health Of Presets Shown" : "Library Health";

    const health = document.createElement("div");
    const needsAttention = summary.warningCount > 0;
    health.className = needsAttention ? "preset-warning" : "preset-detail-note";
    health.appendChild(createPresetIcon(needsAttention ? PRESET_ICON_WARNING : PRESET_ICON_CHECK));
    const healthText = document.createElement("span");
    healthText.textContent = getPresetHealthMessage(summary);
    health.appendChild(healthText);

    panel.appendChild(healthTitle);
    panel.appendChild(health);
}

function renderPresetDetailPanel() {
    const panel = document.getElementById("preset-detail-panel");
    if (!panel) return;
    panel.textContent = "";

    const entry = findVisiblePresetEntry(selectedPresetName);
    if (!entry) {
        renderPresetLibrarySummary(panel);
        return;
    }

    const kicker = document.createElement("div");
    kicker.className = "preset-detail-kicker";
    kicker.textContent = "Saved configuration";

    const title = document.createElement("div");
    title.className = "preset-detail-title";
    title.textContent = entry.name;

    const subtitle = document.createElement("div");
    subtitle.className = "preset-detail-subtitle";
    subtitle.textContent = entry.groupKey === NO_MODEL_PRESET_GROUP_KEY ? "No model saved" : entry.groupKey;

    const actions = document.createElement("div");
    actions.className = "preset-detail-actions";
    actions.appendChild(createPresetButton("Load into Configure", "btn btn-sm btn-primary", async () => {
        const result = await loadPreset(entry.name);
        if (result.ok) presetDependencies.switchTab("configure");
    }, "Load these saved settings for editing; the running process stays as it is"));

    const favoriteBtn = document.createElement("button");
    favoriteBtn.type = "button";
    favoriteBtn.className = entry.favorite ? "btn btn-sm preset-favorite-btn active" : "btn btn-sm preset-favorite-btn";
    favoriteBtn.title = entry.favorite ? "Remove from favorites" : "Add to favorites";
    favoriteBtn.setAttribute("aria-pressed", String(entry.favorite));
    favoriteBtn.appendChild(createPresetIcon(entry.favorite ? PRESET_ICON_STAR : PRESET_ICON_STAR_OUTLINE));
    favoriteBtn.appendChild(document.createTextNode(entry.favorite ? " Favorited" : " Favorite"));
    favoriteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePresetFavorite(entry.name);
        loadPresets();
    });
    actions.appendChild(favoriteBtn);

    const more = document.createElement("details");
    more.className = "preset-more-actions";
    const moreLabel = document.createElement("summary");
    moreLabel.className = "btn btn-sm";
    moreLabel.textContent = "More actions";
    const moreButtons = document.createElement("div");
    moreButtons.className = "preset-more-buttons";
    moreButtons.appendChild(createPresetButton(`Update "${entry.name}"…`, "btn btn-sm", () => updatePreset(entry.name), "Review current edits before overwriting this saved preset"));
    moreButtons.appendChild(createPresetButton("Duplicate", "btn btn-sm", () => duplicatePreset(entry.name), "Save a copy of this preset without changing current settings"));
    moreButtons.appendChild(createPresetButton("Rename", "btn btn-sm", () => renamePreset(entry.name), "Rename this preset, keeping its favorite and usage history"));
    moreButtons.appendChild(createPresetButton("Export", "btn btn-sm", () => exportPreset(entry.name)));
    moreButtons.appendChild(createPresetButton("Windows Shortcut", "btn btn-sm", () => exportPresetShortcut(entry.name), "Export a Windows .cmd shortcut for this preset"));
    moreButtons.appendChild(createPresetButton(
        entry.archived ? "Restore" : "Archive",
        "btn btn-sm",
        () => setPresetArchived([entry.name], !entry.archived),
        entry.archived
            ? "Restore this preset from the archive back into the main list"
            : "Move this preset to the archive to clean up the list; it can be restored any time"
    ));

    moreButtons.appendChild(createPresetButton("Delete", "btn btn-sm btn-danger", () => deletePreset(entry.name)));
    more.append(moreLabel, moreButtons);
    more.addEventListener("keydown", event => {
        if (event.key === "Escape" && more.open) {
            event.preventDefault();
            more.open = false;
            moreLabel.focus();
        }
    });
    actions.appendChild(more);

    const stats = document.createElement("div");
    stats.className = "preset-detail-stats";
    appendDetailStat(stats, "Tool", entry.data.tool || "Keep current tool");
    const effective = getPresetFlagCore().buildEffectiveFlagValues(entry.data.flags);
    for (const [id, label] of [["ctx_size", "Context"], ["gpu_layers", "GPU offload"], ["cache_type_k", "K cache"], ["cache_type_v", "V cache"]]) {
        const saved = Object.prototype.hasOwnProperty.call(entry.data.flags, id);
        appendDetailStat(stats, label, `${saved ? "" : "GUI default · "}${formatSavedPresetValue(id, effective[id])}`);
    }

    const settingsTitle = document.createElement("div");
    settingsTitle.className = "preset-detail-section-title";
    settingsTitle.textContent = "Launch inputs";

    const settings = document.createElement("details");
    settings.className = "preset-saved-settings";
    const settingsLabel = document.createElement("summary");
    settingsLabel.textContent = `All saved settings · ${entry.overrideCount} non-default overrides`;
    const values = document.createElement("table");
    values.className = "preset-comparison-table preset-saved-values";
    const caption = document.createElement("caption");
    caption.textContent = "GUI defaults are shown only where saved values differ. Blank cells match the current GUI default.";
    const head = document.createElement("thead");
    const headings = document.createElement("tr");
    for (const title of ["Setting", "Saved value", "GUI default"]) {
        const heading = document.createElement("th");
        heading.scope = "col";
        heading.textContent = title;
        headings.appendChild(heading);
    }
    head.appendChild(headings);
    const body = document.createElement("tbody");
    const definitions = new Map(getPresetFlagDefinitions().map(flag => [flag.id, flag]));
    const overrides = new Set(entry.overrideFlagIds);
    for (const [id, value] of Object.entries(entry.data.flags)) {
        if (SENSITIVE_PRESET_FLAG_IDS.has(id) || id === "ctx_size_draft") continue;
        const row = document.createElement("tr");
        const label = document.createElement("th");
        label.scope = "row";
        label.textContent = getPresetFlagLabel(id);
        const text = document.createElement("td");
        text.textContent = formatSavedPresetValue(id, value);
        const defaultText = document.createElement("td");
        if (overrides.has(id)) {
            const definition = definitions.get(id);
            defaultText.textContent = definition && Object.prototype.hasOwnProperty.call(definition, "default")
                ? formatSavedPresetValue(id, definition.default)
                : "Unavailable";
        }
        row.append(label, text, defaultText);
        body.appendChild(row);
    }
    values.append(caption, head, body);
    settings.append(settingsLabel, values);
    const settingsNote = document.createElement("p");
    settingsNote.className = "help-text";
    settingsNote.textContent = "Saved launch inputs, before llama.cpp resolves Auto or Auto Fit. Missing settings use GUI defaults on load. API keys and HF tokens are excluded; sensitive values and Custom Launch Args are hidden here.";

    const warnings = document.createElement("div");
    warnings.className = entry.warnings.length ? "preset-warning" : "preset-detail-note";
    warnings.appendChild(createPresetIcon(entry.warnings.length ? PRESET_ICON_WARNING : PRESET_ICON_CHECK));
    const warningsText = document.createElement("span");
    warningsText.textContent = entry.warnings.length
        ? entry.warnings.join(" ")
        : "No preset warnings. This preset should load cleanly into Configure and Quick Launch.";
    warnings.appendChild(warningsText);

    panel.appendChild(kicker);
    panel.appendChild(title);
    panel.appendChild(subtitle);
    panel.appendChild(warnings);
    panel.appendChild(actions);
    panel.appendChild(settingsTitle);
    panel.appendChild(stats);
    panel.appendChild(settingsNote);
    panel.appendChild(settings);
}

function renderPresetBulkControls() {
    const countEl = document.getElementById("presets-selection-count");
    const deleteButton = document.getElementById("btn-presets-delete-selected");
    const exportButton = document.getElementById("btn-presets-export-selected");
    const clearButton = document.getElementById("btn-presets-select-none");
    const favoriteButton = document.getElementById("btn-presets-favorite-selected");
    const unfavoriteButton = document.getElementById("btn-presets-unfavorite-selected");
    const browser = document.getElementById("presets-browser");
    const visibleNames = new Set(getVisiblePresetEntries().map((entry) => entry.name));
    let visibleSelectedCount = 0;

    for (const name of selectedPresetNames) {
        if (visibleNames.has(name)) visibleSelectedCount++;
    }

    if (countEl) {
        countEl.textContent = `${visibleSelectedCount} selected`;
    }
    if (deleteButton) {
        deleteButton.disabled = selectedPresetNames.size === 0;
    }
    if (exportButton) {
        exportButton.disabled = selectedPresetNames.size === 0;
    }
    if (clearButton) {
        clearButton.disabled = selectedPresetNames.size === 0;
    }
    if (favoriteButton) {
        favoriteButton.disabled = selectedPresetNames.size === 0;
    }
    if (unfavoriteButton) {
        unfavoriteButton.disabled = selectedPresetNames.size === 0;
    }
    const archiveButton = document.getElementById("btn-presets-archive-selected");
    if (archiveButton) {
        archiveButton.disabled = selectedPresetNames.size === 0;
    }
    const restoreButton = document.getElementById("btn-presets-restore-selected");
    if (restoreButton) {
        restoreButton.disabled = selectedPresetNames.size === 0;
    }
    if (browser) {
        browser.classList.toggle("has-checked", selectedPresetNames.size > 0);
    }
}

function renderPresetArchiveChip() {
    const chip = document.getElementById("preset-archive-view");
    if (!chip) return;
    const countText = presetArchivedCount > 0 ? ` (${presetArchivedCount})` : "";
    chip.textContent = presetArchiveViewActive
        ? `\uD83D\uDCE6 Viewing archive${countText}`
        : `\uD83D\uDCE6 Archived${countText}`;
    chip.title = presetArchiveViewActive
        ? "Viewing archived presets. Click to return to the main list"
        : "Show presets hidden from the main list by archiving";
    chip.classList.toggle("active", presetArchiveViewActive);
    chip.setAttribute("aria-pressed", String(presetArchiveViewActive));
}

function renderPresetCountLine() {
    const countLine = document.getElementById("presets-count-line");
    if (!countLine) return;
    const presetCount = getVisiblePresetEntries().length;
    const modelCount = currentPresetGroups.length;
    countLine.textContent = `${presetCount} preset${presetCount === 1 ? "" : "s"} · ${modelCount} model${modelCount === 1 ? "" : "s"}`;
}

function renderPresetAuxiliaryPanels() {
    renderPresetDetailPanel();
    renderPresetBulkControls();
    renderPresetCountLine();
}

function renderPresetLoadErrorState() {
    const panel = document.getElementById("preset-detail-panel");
    if (panel) {
        panel.textContent = "";
        const error = document.createElement("div");
        error.className = "preset-detail-empty presets-error";
        error.textContent = "Preset library unavailable. Try refreshing the list.";
        panel.appendChild(error);
    }
    renderPresetBulkControls();
    renderPresetCountLine();
}

function selectPresetEntry(name) {
    selectedPresetName = String(name || "");
    // searching force-expands groups, so a selection made from search results would be
    // hidden again once the query is cleared unless its group is expanded for real
    const entry = findVisiblePresetEntry(selectedPresetName);
    if (entry && isPresetGroupCollapsed(entry.groupKey)) {
        setPresetGroupCollapsed(entry.groupKey, false);
    }
    renderPresetGroups(document.getElementById("presets-list"), currentPresetGroups);
}

function setPresetChecked(name, checked) {
    if (checked) {
        selectedPresetNames.add(name);
    } else {
        selectedPresetNames.delete(name);
    }
    renderPresetBulkControls();
}

function renderPresetEntry(entry) {
    const el = document.createElement("div");
    el.className = "preset-item";
    if (entry.name === selectedPresetName) {
        el.classList.add("selected");
    }
    // Identity for the roving focus sequence, which has to survive the full
    // re-render that selecting, favoriting, or filtering triggers.
    el.setAttribute("data-preset-name", entry.name);
    // Overwritten by applyPresetRovingTabIndex; only the current row keeps 0.
    el.tabIndex = -1;
    el.setAttribute("role", "button");
    el.setAttribute("aria-pressed", String(entry.name === selectedPresetName));
    el.addEventListener("click", () => selectPresetEntry(entry.name));
    el.addEventListener("keydown", (event) => {
        // Only when the row itself has focus. Keydown from the checkbox, the
        // favorite toggle, or Load bubbles up here, and preventDefault would
        // swallow Space on the checkbox and double-fire Enter on the buttons.
        if (event.target !== el) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectPresetEntry(entry.name);
        }
    });

    const checkWrap = document.createElement("label");
    checkWrap.className = "preset-checkbox";
    checkWrap.title = "Select this preset for bulk actions";
    checkWrap.addEventListener("click", (event) => event.stopPropagation());

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPresetNames.has(entry.name);
    checkbox.setAttribute("aria-label", `Select preset ${entry.name}`);
    checkbox.addEventListener("change", () => setPresetChecked(entry.name, checkbox.checked));
    checkWrap.appendChild(checkbox);

    const details = document.createElement("div");
    details.className = "preset-details";

    const titleRow = document.createElement("div");
    titleRow.className = "preset-title-row";

    const nameEl = document.createElement("div");
    nameEl.className = "preset-name";
    nameEl.textContent = entry.name;
    nameEl.title = entry.name;
    titleRow.appendChild(nameEl);

    if (entry.favorite) el.classList.add("preset-item-favorite");

    const metaEl = document.createElement("div");
    metaEl.className = "preset-meta";
    metaEl.textContent = `${entry.toolText} · ${entry.overrideCount} override${entry.overrideCount === 1 ? "" : "s"}`;

    details.appendChild(titleRow);
    details.appendChild(metaEl);

    el.appendChild(checkWrap);
    el.appendChild(details);

    if (entry.warnings.length > 0) {
        const warnIcon = createPresetIcon(PRESET_ICON_WARNING);
        const warnWrap = document.createElement("span");
        warnWrap.className = "preset-row-warn";
        warnWrap.title = entry.warnings.join(" ");
        warnWrap.appendChild(warnIcon);
        el.appendChild(warnWrap);
    }

    const rowFavorite = document.createElement("button");
    rowFavorite.type = "button";
    rowFavorite.className = entry.favorite ? "preset-row-favorite active" : "preset-row-favorite";
    rowFavorite.title = entry.favorite ? "Remove from favorites" : "Add to favorites";
    rowFavorite.setAttribute("aria-label", `${entry.favorite ? "Remove" : "Add"} ${entry.name} ${entry.favorite ? "from" : "to"} favorites`);
    rowFavorite.setAttribute("aria-pressed", String(entry.favorite));
    rowFavorite.appendChild(createPresetIcon(entry.favorite ? PRESET_ICON_STAR : PRESET_ICON_STAR_OUTLINE));
    rowFavorite.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePresetFavorite(entry.name);
        loadPresets();
    });
    el.appendChild(rowFavorite);

    const rowArchive = document.createElement("button");
    rowArchive.type = "button";
    rowArchive.className = "preset-row-archive";
    rowArchive.title = entry.archived ? "Restore from archive" : "Archive preset";
    rowArchive.setAttribute("aria-label", `${entry.archived ? "Restore" : "Archive"} ${entry.name}`);
    rowArchive.appendChild(createPresetIcon(entry.archived ? PRESET_ICON_RESTORE : PRESET_ICON_ARCHIVE));
    rowArchive.addEventListener("click", (event) => {
        event.stopPropagation();
        setPresetArchived([entry.name], !entry.archived);
    });
    el.appendChild(rowArchive);

    el.appendChild(createPresetButton("Load", "btn btn-sm btn-primary preset-row-load", () => loadPreset(entry.name)));
    return el;
}
