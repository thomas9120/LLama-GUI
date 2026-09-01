(function () {
    window.LlamaGui = window.LlamaGui || {};

    let openCategories = new Set();
    let openSubmenus = new Set();
    let savedOpenSubmenus = null;
    let configSearchQuery = "";
    let dependencies = {};
    let tensorBufferTypesPromise = null;
    let tensorBufferTypesState = { buffers: ["CPU"], default: "CPU", detail: "" };

    const MOE_EXPERT_OVERRIDE_PATTERN = "blk.*.ffn_.*_exps.weight";

    function configure(options) {
        dependencies = Object.assign({}, dependencies, options || {});
    }

    function getFlagCore() {
        return window.LlamaGui.flagCore;
    }

    function getFlagValues() {
        const core = getFlagCore();
        return core ? core.getFlagValues() : {};
    }

    function getCurrentTool() {
        const core = getFlagCore();
        return core ? core.getCurrentTool() : "llama-server";
    }

    function getGroups() {
        const getFlagsByCategory = dependencies.getFlagsByCategory || window.getFlagsByCategory;
        return getFlagsByCategory(getCurrentTool());
    }

    function openMatchingSearchSections() {
        const groups = getGroups();
        openCategories = new Set(Object.keys(groups));
        openSubmenus = new Set();
        for (const [catId, group] of Object.entries(groups)) {
            const categoryMatches = group.name.toLowerCase().includes(configSearchQuery);
            for (const flag of group.flags) {
                const submenu = String(flag.submenu || "").trim();
                if (submenu && (categoryMatches || flagMatchesSearch(flag, configSearchQuery))) {
                    openSubmenus.add(`${catId}::${submenu}`);
                }
            }
        }
    }

    function initConfigControls() {
        const search = document.getElementById("config-search");
        if (!search) return;

        const clearSearch = () => {
            search.value = "";
            configSearchQuery = "";
            if (savedOpenSubmenus !== null) {
                openSubmenus = savedOpenSubmenus;
                savedOpenSubmenus = null;
            }
            renderFlags();
            search.focus();
        };

        search.addEventListener("input", dependencies.debounce(() => {
            const previousQuery = configSearchQuery;
            configSearchQuery = search.value.trim().toLowerCase();
            if (configSearchQuery) {
                if (!previousQuery) {
                    savedOpenSubmenus = openSubmenus;
                }
                openMatchingSearchSections();
            } else if (previousQuery && savedOpenSubmenus !== null) {
                openSubmenus = savedOpenSubmenus;
                savedOpenSubmenus = null;
            }
            renderFlags();
        }, 200));

        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && (search.value || configSearchQuery)) {
                e.preventDefault();
                clearSearch();
            }
        });

        document.getElementById("btn-clear-search").addEventListener("click", clearSearch);

        document.getElementById("btn-configure-hf-download").addEventListener("click", () => {
            dependencies.switchTab("quick-launch");
            const repoInput = document.getElementById("hf-repo-input");
            if (repoInput) repoInput.focus();
        });

        document.getElementById("btn-expand-all").addEventListener("click", () => {
            const groups = getGroups();
            openCategories = new Set(Object.keys(groups));
            openSubmenus.clear();
            for (const [catId, group] of Object.entries(groups)) {
                for (const flag of group.flags) {
                    const submenu = String(flag.submenu || "").trim();
                    if (submenu) {
                        openSubmenus.add(`${catId}::${submenu}`);
                    }
                }
            }
            renderFlags();
        });

        document.getElementById("btn-collapse-all").addEventListener("click", () => {
            openCategories.clear();
            openSubmenus.clear();
            renderFlags();
        });
    }

    function resetOpenCategories() {
        openCategories.clear();
        openSubmenus.clear();
        savedOpenSubmenus = null;
        if (configSearchQuery) {
            savedOpenSubmenus = new Set();
            openMatchingSearchSections();
        }
    }

    function flagMatchesSearch(flag, query) {
        if (!query) return true;

        const terms = [
            flag.flag,
            flag.label,
            flag.id,
            flag.desc,
            flag.short_desc,
            flag.beginner_tip,
            flag.submenu,
        ];

        if (flag.id === "override_tensor") {
            terms.push("moe", "expert", "experts", "tensor buffer", "cuda", "gpu", "accelerator");
        }

        if (Array.isArray(flag.options)) {
            for (const opt of flag.options) {
                terms.push(opt.label, opt.value);
            }
        }

        return terms
            .filter(Boolean)
            .some(v => String(v).toLowerCase().includes(query));
    }

    function getFlagDescriptionParts(flag) {
        const full = String((flag && flag.desc) || "").trim();
        const short = String((flag && flag.short_desc) || "").trim();

        if (short) {
            return {
                summary: short,
                details: full && full !== short ? full : "",
            };
        }
        if (!full) return { summary: "", details: "" };

        const sentenceMatch = full.match(/^(.+?[.!?])(?:\s|$)/);
        let summary = sentenceMatch ? sentenceMatch[1].trim() : full;

        if (summary.length > 140) {
            summary = summary.slice(0, 137).trimEnd() + "...";
        }

        const details = full !== summary ? full : "";
        return { summary, details };
    }

    function renderFlags() {
        const container = document.getElementById("flags-container");
        if (!container) return;
        container.innerHTML = "";
        const groups = getGroups();

        let visibleGroups = 0;

        for (const [catId, group] of Object.entries(groups)) {
            const categoryMatches = group.name.toLowerCase().includes(configSearchQuery);
            const visibleFlags = configSearchQuery
                ? group.flags.filter(f => categoryMatches || flagMatchesSearch(f, configSearchQuery))
                : group.flags;

            if (visibleFlags.length === 0) {
                continue;
            }

            visibleGroups += 1;

            const acc = document.createElement("div");
            acc.className = "accordion";
            acc.dataset.categoryId = catId;

            const header = document.createElement("div");
            header.className = "accordion-header";
            const countText = visibleFlags.length === group.flags.length
                ? String(group.flags.length)
                : `${visibleFlags.length}/${group.flags.length}`;

            const arrow = document.createElement("span");
            arrow.className = "arrow";
            arrow.textContent = "\u25B6";

            const title = document.createElement("h3");
            title.textContent = group.name;

            const count = document.createElement("span");
            count.className = "count";
            count.textContent = countText;

            header.appendChild(arrow);
            header.appendChild(title);
            header.appendChild(count);

            const body = document.createElement("div");
            body.className = "accordion-body";

            if (openCategories.has(catId)) {
                header.classList.add("open");
                body.classList.add("open");
            }

            header.addEventListener("click", () => {
                header.classList.toggle("open");
                body.classList.toggle("open");
                if (body.classList.contains("open")) {
                    openCategories.add(catId);
                } else {
                    openCategories.delete(catId);
                }
            });

            if (catId === "sampling") {
                body.appendChild(dependencies.createSamplerPresetControls());
            }

            const topLevelFlags = visibleFlags.filter(f => !String(f.submenu || "").trim());
            const submenuMap = new Map();
            for (const f of visibleFlags) {
                const submenu = String(f.submenu || "").trim();
                if (!submenu) continue;
                if (!submenuMap.has(submenu)) submenuMap.set(submenu, []);
                submenuMap.get(submenu).push(f);
            }

            for (const f of topLevelFlags) {
                body.appendChild(createFlagRow(f));
            }

            for (const [submenuName, submenuFlags] of sortSubmenus(submenuMap, group.submenuOrder)) {
                body.appendChild(createSubmenuBlock(catId, submenuName, submenuFlags));
            }

            acc.appendChild(header);
            acc.appendChild(body);
            container.appendChild(acc);
        }

        if (visibleGroups === 0) {
            const empty = document.createElement("div");
            empty.className = "flags-empty";
            empty.textContent = "No configuration options match your search.";
            container.appendChild(empty);
        }

        restoreFlagInputs();
        dependencies.refreshQuickLaunchUI();
    }

    // Orders submenu blocks by the category's optional submenuOrder hint. Names not listed
    // there keep their definition order and sort after every listed name.
    function sortSubmenus(submenuMap, submenuOrder) {
        const entries = Array.from(submenuMap.entries());
        if (!Array.isArray(submenuOrder) || submenuOrder.length === 0) return entries;

        const rank = new Map(submenuOrder.map((name, index) => [name, index]));
        const unlisted = submenuOrder.length;
        return entries
            .map((entry, index) => ({ entry, index, rank: rank.has(entry[0]) ? rank.get(entry[0]) : unlisted }))
            .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
            .map(item => item.entry);
    }

    function createSubmenuBlock(categoryId, submenuName, submenuFlags) {
        const wrap = document.createElement("div");
        wrap.className = "flag-submenu";

        const header = document.createElement("button");
        header.type = "button";
        header.className = "flag-submenu-header";

        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.innerHTML = "&#x25B6;";

        const title = document.createElement("span");
        title.className = "submenu-title";
        title.textContent = submenuName;

        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(submenuFlags.length);

        header.appendChild(arrow);
        header.appendChild(title);
        header.appendChild(count);

        const body = document.createElement("div");
        body.className = "flag-submenu-body";

        const key = `${categoryId}::${submenuName}`;
        if (openSubmenus.has(key)) {
            header.classList.add("open");
            body.classList.add("open");
        }

        header.addEventListener("click", () => {
            header.classList.toggle("open");
            body.classList.toggle("open");
            if (body.classList.contains("open")) {
                openSubmenus.add(key);
            } else {
                openSubmenus.delete(key);
            }
        });

        for (const flag of submenuFlags) {
            body.appendChild(createFlagRow(flag));
        }

        wrap.appendChild(header);
        wrap.appendChild(body);
        return wrap;
    }

    function createFlagRow(f) {
        const row = document.createElement("div");
        row.className = "flag-row";
        row.dataset.flagId = f.id;

        const label = createFlagLabel(f);
        const input = document.createElement("div");
        input.className = "flag-input";

        const builder = {
            bool: createBoolInput,
            enum: createEnumInput,
            multi_enum: createMultiEnumInput,
            text_list: createTextListInput,
            path: createPathInput,
            int: createIntInput,
            float: createFloatInput,
            text: createTextInput,
        }[f.type] || createTextInput;

        input.appendChild(builder(f));
        row.appendChild(label);
        row.appendChild(input);
        return row;
    }

    function createFlagLabel(f) {
        const label = document.createElement("div");
        label.className = "flag-label";
        let defaultText = "";
        if (f.default !== undefined) defaultText = ` [default: ${f.default}]`;

        const titleRow = document.createElement("div");
        titleRow.className = "flag-title-row";

        const flagName = document.createElement("span");
        flagName.className = "flag-name";
        flagName.textContent = f.flag;
        titleRow.appendChild(flagName);

        if (f.beginner_tip) {
            const tipDetails = document.createElement("details");
            tipDetails.className = "flag-tip-details";

            const tipSummary = document.createElement("summary");
            tipSummary.className = "flag-tip";
            tipSummary.textContent = "Beginner tip";

            const tipText = document.createElement("div");
            tipText.className = "flag-tip-text";
            tipText.textContent = f.beginner_tip;

            tipDetails.appendChild(tipSummary);
            tipDetails.appendChild(tipText);
            titleRow.appendChild(tipDetails);
        }

        const { summary, details } = getFlagDescriptionParts(f);
        const flagDesc = document.createElement("span");
        flagDesc.className = "flag-desc";
        flagDesc.textContent = summary;

        label.appendChild(titleRow);
        label.appendChild(flagDesc);

        if (details) {
            const more = document.createElement("details");
            more.className = "flag-more";

            const moreSummary = document.createElement("summary");
            moreSummary.textContent = "More info";

            const moreText = document.createElement("div");
            moreText.className = "flag-more-text";
            moreText.textContent = details;

            more.appendChild(moreSummary);
            more.appendChild(moreText);
            label.appendChild(more);
        }

        if (defaultText) {
            const flagDefault = document.createElement("span");
            flagDefault.className = "flag-default";
            flagDefault.textContent = defaultText;
            label.appendChild(flagDefault);
        }

        if (f.type === "bool" && f.false_flag) {
            const toggleHint = document.createElement("span");
            toggleHint.className = "flag-toggle-hint";
            toggleHint.textContent = `Off -> ${f.false_flag}`;
            label.appendChild(toggleHint);
        }

        return label;
    }

    function createBoolInput(f) {
        const cb = document.createElement("div");
        cb.className = "checkbox-group";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = "flag-" + f.id;
        checkbox.dataset.flagId = f.id;
        checkbox.dataset.flagType = "bool";
        checkbox.checked = getFlagValues()[f.id] === true;
        checkbox.addEventListener("change", () => {
            getFlagCore().setFlagValue(f.id, checkbox.checked);
        });
        const lbl = document.createElement("label");
        lbl.htmlFor = "flag-" + f.id;
        lbl.textContent = checkbox.checked ? "Enabled" : "Disabled";
        checkbox.addEventListener("change", () => {
            lbl.textContent = checkbox.checked ? "Enabled" : "Disabled";
        });
        cb.appendChild(checkbox);
        cb.appendChild(lbl);
        return cb;
    }

    function createEnumInput(f) {
        const values = getFlagValues();
        const sel = document.createElement("select");
        sel.id = "flag-" + f.id;
        sel.dataset.flagId = f.id;
        sel.dataset.flagType = "enum";
        for (const opt of f.options) {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = opt.label;
            o.selected = String(values[f.id] || "") === opt.value;
            sel.appendChild(o);
        }
        if (f.id === "chat_template") {
            ensureChatTemplateOption(sel, values[f.id]);
        }
        sel.addEventListener("change", () => {
            if (f.id === "chat_template") {
                dependencies.setChatTemplateValue(sel.value);
            } else if (f.id === "load_mode") {
                // "" ("Legacy controls") is a deliberate choice, not "unset":
                // undefined would delete the key, so a saved preset would lose
                // it and loading would resurrect the "auto" default, silently
                // suppressing the legacy mlock/mmap/direct_io switches saved
                // alongside it.
                getFlagCore().setFlagValue(f.id, sel.value);
            } else {
                getFlagCore().setFlagValue(f.id, sel.value || undefined);
            }
        });
        return sel;
    }

    function ensureChatTemplateOption(select, value) {
        if (!select) return;
        const normalized = String(value || "");
        for (const option of Array.from(select.options || [])) {
            if (option.dataset.chatTemplateFallback === "true") option.remove();
        }
        let hasOption = Array.from(select.options || []).some((option) => option.value === normalized);
        if (!hasOption && normalized && isSupportedChatTemplateValue(normalized)) {
            const option = document.createElement("option");
            option.value = normalized;
            option.textContent = `${normalized} (llama.cpp built-in)`;
            option.dataset.chatTemplateFallback = "true";
            select.appendChild(option);
            hasOption = true;
        }
        select.value = hasOption ? normalized : "";
    }

    function createMultiEnumInput(f) {
        const values = getFlagValues();
        const selected = normalizeMultiEnumValue(values[f.id]);
        const input = document.createElement("div");
        const optionWrap = document.createElement("div");
        optionWrap.className = "flag-multi-options";
        const hasHighRiskOptions = (f.options || []).some(opt => opt.risk === "high");
        const warning = document.createElement("div");
        warning.className = "flag-multi-warning hidden";
        warning.dataset.flagWarningId = f.id;
        warning.textContent = "High-risk tools selected. Only enable on trusted/local environments.";

        const updateWarning = (selectedValues) => {
            if (!hasHighRiskOptions) return;
            warning.classList.toggle("hidden", !hasSelectedHighRiskOption(f.options, selectedValues));
        };

        const setValueAndRefresh = (arr) => {
            const unique = [...new Set(arr.filter(Boolean))];
            const val = unique.length > 0 ? unique : undefined;
            getFlagCore().setFlagValue(f.id, val);
        };

        for (const opt of f.options || []) {
            const row = document.createElement("label");
            row.className = "flag-multi-option";

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.flagId = f.id;
            cb.dataset.flagType = "multi_enum";
            cb.dataset.optionValue = opt.value;
            cb.checked = selected.includes(opt.value);

            cb.addEventListener("change", () => {
                const current = normalizeMultiEnumValue(getFlagValues()[f.id]);
                let nextSelected;
                if (opt.value === "all" && cb.checked) {
                    nextSelected = ["all"];
                } else {
                    nextSelected = cb.checked
                        ? [...current.filter(v => v !== "all"), opt.value]
                        : current.filter(v => v !== opt.value);
                }

                setValueAndRefresh(nextSelected);
                for (const other of optionWrap.querySelectorAll('input[type="checkbox"]')) {
                    other.checked = nextSelected.includes(other.dataset.optionValue);
                }
                updateWarning(nextSelected);
            });

            const text = document.createElement("span");
            text.textContent = opt.label;

            row.appendChild(cb);
            row.appendChild(text);
            if (opt.risk === "high") {
                const badge = document.createElement("span");
                badge.className = "flag-risk-badge";
                badge.textContent = "High risk";
                row.appendChild(badge);
            }
            optionWrap.appendChild(row);
        }

        input.appendChild(optionWrap);
        if (hasHighRiskOptions) {
            updateWarning(selected);
            input.appendChild(warning);
        }
        return input;
    }

    function createPathInput(f) {
        const input = document.createDocumentFragment();
        const textField = document.createElement("input");
        textField.type = "text";
        textField.id = "flag-" + f.id;
        textField.dataset.flagId = f.id;
        textField.dataset.flagType = "path";
        textField.placeholder = f.placeholder || "Path...";
        textField.value = getFlagValues()[f.id] || "";
        textField.addEventListener("input", () => {
            getFlagCore().setPathFlagValue(f.id, textField.value || undefined);
        });
        const browseBtn = document.createElement("button");
        browseBtn.className = "btn btn-sm";
        browseBtn.textContent = "Browse";
        browseBtn.addEventListener("click", async () => {
            try {
                const selectedPath = await dependencies.browseForPathFlag(f);
                if (!selectedPath) return;
                textField.value = selectedPath;
                getFlagCore().setPathFlagValue(f.id, selectedPath);
            } catch (e) {
                dependencies.showStatus("error", "Failed to select file: " + e.message);
            }
        });
        input.appendChild(textField);
        input.appendChild(browseBtn);
        return input;
    }

    function createIntInput(f) {
        const numField = document.createElement("input");
        numField.type = "number";
        numField.id = "flag-" + f.id;
        numField.dataset.flagId = f.id;
        numField.dataset.flagType = "int";
        numField.placeholder = f.placeholder || String(f.default ?? "");
        numField.value = getFlagValues()[f.id] ?? "";
        if (f.min !== undefined) numField.min = f.min;
        if (f.max !== undefined) numField.max = f.max;
        if (f.step !== undefined) numField.step = f.step;
        numField.addEventListener("input", () => {
            if (numField.value === "") {
                getFlagCore().setFlagValue(f.id, undefined);
            } else {
                const v = Number(numField.value);
                getFlagCore().setFlagValue(f.id, Number.isFinite(v) ? v : undefined);
            }
        });
        return numField;
    }

    function createFloatInput(f) {
        const numField = document.createElement("input");
        numField.type = "number";
        numField.id = "flag-" + f.id;
        numField.dataset.flagId = f.id;
        numField.dataset.flagType = "float";
        numField.placeholder = f.placeholder || String(f.default ?? "");
        numField.value = getFlagValues()[f.id] ?? "";
        numField.step = f.step || "0.01";
        if (f.min !== undefined) numField.min = f.min;
        if (f.max !== undefined) numField.max = f.max;
        numField.addEventListener("input", () => {
            if (numField.value === "") {
                getFlagCore().setFlagValue(f.id, undefined);
            } else {
                const v = parseFloat(numField.value);
                getFlagCore().setFlagValue(f.id, Number.isNaN(v) ? undefined : v);
            }
        });
        return numField;
    }

    function createTextInput(f) {
        if (f.id === "override_tensor") {
            return createOverrideTensorInput(f);
        }

        if (f.sensitive) {
            return createSensitiveTextInput(f);
        }

        const textField = document.createElement("input");
        textField.type = "text";
        textField.id = "flag-" + f.id;
        textField.dataset.flagId = f.id;
        textField.dataset.flagType = "text";
        textField.placeholder = f.placeholder || "";
        textField.value = getFlagValues()[f.id] || "";
        textField.addEventListener("input", () => {
            const raw = textField.value || undefined;
            if (f.id === "gpu_layers") {
                const normalized = getFlagCore().normalizeGpuLayersValue(raw);
                textField.setCustomValidity(raw && normalized === undefined ? "Use auto, all, 0, or a non-negative integer." : "");
                getFlagCore().setFlagValue(f.id, normalized);
                return;
            }
            getFlagCore().setFlagValue(f.id, raw);
        });
        return textField;
    }

    function createTextListInput(f) {
        const field = document.createElement("textarea");
        field.id = "flag-" + f.id;
        field.dataset.flagId = f.id;
        field.dataset.flagType = "text_list";
        field.rows = 4;
        field.placeholder = f.placeholder || "One value per line";
        const current = getFlagValues()[f.id];
        field.value = Array.isArray(current) ? current.join("\n") : String(current || "");
        field.addEventListener("input", () => {
            const values = field.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
            getFlagCore().setFlagValue(f.id, values.length > 0 ? values : undefined);
        });
        return field;
    }

    function generateSensitiveValue() {
        if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
            throw new Error("Secure random generation is unavailable in this browser.");
        }
        const bytes = new Uint8Array(32);
        window.crypto.getRandomValues(bytes);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return window.btoa(binary)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
    }

    function syncSensitiveTextInput(control, value) {
        if (!control) return;
        const input = control.querySelector("[data-sensitive-input]");
        const hasValue = String(value || "").length > 0;
        if (input && input.value !== String(value || "")) input.value = String(value || "");
        for (const button of control.querySelectorAll("[data-sensitive-requires-value]")) {
            button.disabled = !hasValue;
        }
    }

    function supportsSensitiveTextMasking() {
        return Boolean(
            window.CSS
            && typeof window.CSS.supports === "function"
            && window.CSS.supports("-webkit-text-security", "disc")
        );
    }

    function setSensitiveTextInputRevealed(input, revealed) {
        if (!input) return;
        if (input.dataset.sensitiveMaskMode === "css") {
            input.type = "text";
            input.classList.toggle("sensitive-input-masked", !revealed);
            return;
        }
        input.classList.remove("sensitive-input-masked");
        input.type = revealed ? "text" : "password";
    }

    function initializeSensitiveTextInput(input) {
        if (!input) return false;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.dataset.sensitiveMaskMode = supportsSensitiveTextMasking() ? "css" : "password";
        setSensitiveTextInputRevealed(input, false);
        return true;
    }

    function createSensitiveTextInput(f, options = {}) {
        const control = document.createElement("div");
        control.className = "sensitive-input-control";

        const textField = document.createElement("input");
        textField.id = options.inputId || ("flag-" + f.id);
        textField.dataset.flagId = f.id;
        textField.dataset.flagType = "text";
        textField.dataset.sensitiveInput = "true";
        initializeSensitiveTextInput(textField);
        textField.placeholder = f.placeholder || "Leave blank for no authentication";
        textField.value = getFlagValues()[f.id] || "";
        textField.addEventListener("input", () => {
            getFlagCore().setFlagValue(f.id, textField.value || undefined);
            syncSensitiveTextInput(control, textField.value);
        });

        const actions = document.createElement("div");
        actions.className = "sensitive-input-actions";

        const showButton = document.createElement("button");
        showButton.type = "button";
        showButton.className = "btn btn-sm btn-ghost";
        showButton.textContent = "Show";
        showButton.dataset.sensitiveRequiresValue = "true";
        showButton.addEventListener("click", () => {
            const isHidden = textField.dataset.sensitiveMaskMode === "css"
                ? textField.classList.contains("sensitive-input-masked")
                : textField.type === "password";
            setSensitiveTextInputRevealed(textField, isHidden);
            showButton.textContent = isHidden ? "Hide" : "Show";
            showButton.setAttribute("aria-pressed", String(isHidden));
        });

        const generateButton = document.createElement("button");
        generateButton.type = "button";
        generateButton.className = "btn btn-sm";
        generateButton.textContent = "Generate";
        generateButton.addEventListener("click", () => {
            try {
                const value = generateSensitiveValue();
                getFlagCore().setFlagValue(f.id, value);
                textField.value = value;
                syncSensitiveTextInput(control, value);
                if (dependencies.showToast) dependencies.showToast("Generated a new API key", "success");
            } catch (error) {
                if (dependencies.showToast) dependencies.showToast(error.message, "error");
                else console.warn(error.message);
            }
        });

        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "btn btn-sm btn-ghost";
        copyButton.textContent = "Copy key";
        copyButton.dataset.sensitiveRequiresValue = "true";
        copyButton.addEventListener("click", () => {
            if (!textField.value) return;
            if (dependencies.copyText) dependencies.copyText(textField.value);
            if (dependencies.showToast) dependencies.showToast("API key copied", "success");
        });

        actions.appendChild(showButton);
        actions.appendChild(generateButton);
        actions.appendChild(copyButton);
        control.appendChild(textField);
        control.appendChild(actions);
        syncSensitiveTextInput(control, textField.value);
        return control;
    }

    function createOverrideTensorInput(f) {
        const wrap = document.createElement("div");
        wrap.className = "override-tensor-control";

        const textField = document.createElement("input");
        textField.type = "text";
        textField.id = "flag-" + f.id;
        textField.dataset.flagId = f.id;
        textField.dataset.flagType = "text";
        textField.placeholder = f.placeholder || "";
        textField.value = getFlagValues()[f.id] || "";
        textField.addEventListener("input", () => {
            getFlagCore().setFlagValue(f.id, textField.value || undefined);
        });
        wrap.appendChild(textField);

        const helper = document.createElement("div");
        helper.className = "override-tensor-helper";

        const select = document.createElement("select");
        select.className = "override-tensor-buffer-select";
        select.setAttribute("aria-label", "MoE expert tensor buffer");
        populateTensorBufferSelect(select, tensorBufferTypesState);

        const applyBtn = document.createElement("button");
        applyBtn.type = "button";
        applyBtn.className = "btn btn-sm";
        applyBtn.textContent = "Apply MoE Experts";
        applyBtn.addEventListener("click", () => {
            const bufferType = select.value || tensorBufferTypesState.default || "CPU";
            const nextValue = mergeMoEExpertOverride(getFlagValues()[f.id], bufferType);
            textField.value = nextValue;
            const patch = { [f.id]: nextValue };
            if (String(bufferType).toUpperCase() !== "CPU") {
                patch.cpu_moe = undefined;
                patch.n_cpu_moe = undefined;
            }
            getFlagCore().setMultipleFlagValues(patch);
        });

        helper.appendChild(select);
        helper.appendChild(applyBtn);
        wrap.appendChild(helper);

        const note = document.createElement("div");
        note.className = "override-tensor-note";
        note.textContent = "Experimental. MoE models only: assigns matching expert weight tensors, not prompt-active experts. GPU targets clear CPU MoE settings to avoid conflicts.";
        wrap.appendChild(note);

        loadTensorBufferTypes().then((state) => {
            populateTensorBufferSelect(select, state);
        });

        return wrap;
    }

    function populateTensorBufferSelect(select, state) {
        const current = select.value;
        const buffers = Array.isArray(state.buffers) && state.buffers.length ? state.buffers : ["CPU"];
        select.textContent = "";
        for (const bufferType of buffers) {
            const option = document.createElement("option");
            option.value = bufferType;
            option.textContent = bufferType;
            select.appendChild(option);
        }
        const preferred = current && buffers.includes(current) ? current : (state.default || buffers[0]);
        select.value = buffers.includes(preferred) ? preferred : buffers[0];
        if (state.detail) {
            select.title = state.detail;
        }
    }

    function loadTensorBufferTypes() {
        if (tensorBufferTypesPromise) return tensorBufferTypesPromise;
        const fetchJson = dependencies.fetchJson;
        if (typeof fetchJson !== "function") {
            tensorBufferTypesPromise = Promise.resolve(tensorBufferTypesState);
            return tensorBufferTypesPromise;
        }
        tensorBufferTypesPromise = fetchJson("/api/llama/buffer-types")
            .then((data) => {
                if (data && Array.isArray(data.buffers) && data.buffers.length) {
                    tensorBufferTypesState = {
                        buffers: data.buffers.map(v => String(v)).filter(Boolean),
                        default: data.default || data.buffers[0],
                        detail: data.error || data.detail || "",
                    };
                }
                return tensorBufferTypesState;
            })
            .catch((error) => {
                tensorBufferTypesState = {
                    buffers: ["CPU"],
                    default: "CPU",
                    detail: error && error.message ? error.message : "Unable to discover buffer types.",
                };
                return tensorBufferTypesState;
            });
        return tensorBufferTypesPromise;
    }

    function mergeMoEExpertOverride(currentValue, bufferType) {
        const nextEntry = `${MOE_EXPERT_OVERRIDE_PATTERN}=${bufferType || "CPU"}`;
        const entries = String(currentValue || "")
            .split(",")
            .map(v => v.trim())
            .filter(Boolean);
        const existingIndex = entries.findIndex((entry) => (
            entry.split("=", 1)[0].trim() === MOE_EXPERT_OVERRIDE_PATTERN
        ));
        if (existingIndex >= 0) {
            entries[existingIndex] = nextEntry;
        } else {
            entries.push(nextEntry);
        }
        return entries.join(",");
    }

    // Every Configure input writes flag state on each keystroke, and that write
    // loops straight back here through postUpdate(). Re-assigning el.value while
    // the user is mid-edit resets the caret, and on type="number" it destroys the
    // keystroke outright: the browser reports partial input ("-", "0.", "0.0") as
    // "", so state holds undefined and writing that back clears the field. Leave
    // the focused input alone and sync every other field from state as usual;
    // applyFlagValues() passes force so a wholesale replace still wins.
    function isFlagInputBeingEdited(el, force) {
        if (force || !el) return false;
        const doc = el.ownerDocument || document;
        return Boolean(doc) && doc.activeElement === el;
    }

    function restoreFlagInputs(options) {
        const force = Boolean(options && options.force);
        const values = getFlagValues();
        const getFlags = dependencies.getFlags || (() => window.FLAGS || FLAGS);
        for (const f of getFlags()) {
            const el = document.getElementById("flag-" + f.id);
            const val = values[f.id];
            if (f.type === "multi_enum") {
                const selected = normalizeMultiEnumValue(val);
                const multiInputs = document.querySelectorAll(`input[data-flag-id="${f.id}"][data-flag-type="multi_enum"]`);
                for (const input of multiInputs) {
                    input.checked = selected.includes(input.dataset.optionValue);
                }
                const warning = document.querySelector(`.flag-multi-warning[data-flag-warning-id="${f.id}"]`);
                if (warning) {
                    warning.classList.toggle("hidden", !hasSelectedHighRiskOption(f.options, selected));
                }
                continue;
            }
            if (f.type === "text_list") {
                const nextValue = Array.isArray(val) ? val.join("\n") : String(val || "");
                if (el && !isFlagInputBeingEdited(el, force) && el.value !== nextValue) {
                    el.value = nextValue;
                }
                continue;
            }
            if (!el) continue;
            if (f.id === "kv_unified_per_slot") el.disabled = values.kv_unified === "disabled";
            if (f.type === "bool") {
                el.checked = val === true;
                const lbl = el.parentElement.querySelector("label");
                if (lbl) lbl.textContent = val === true ? "Enabled" : "Disabled";
            } else if (f.type === "enum") {
                if (f.id === "chat_template") {
                    ensureChatTemplateOption(
                        el,
                        dependencies.getSelectedChatTemplateDropdownValue()
                    );
                } else {
                    el.value = val !== undefined ? String(val) : "";
                }
            } else {
                const nextValue = val !== undefined ? String(val) : "";
                if (!isFlagInputBeingEdited(el, force) && el.value !== nextValue) {
                    el.value = nextValue;
                }
                if (f.sensitive) {
                    syncSensitiveTextInput(el.closest(".sensitive-input-control"), val);
                }
            }
        }
    }

    function normalizeMultiEnumValue(value) {
        if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
        if (typeof value === "string" && value.trim()) {
            return value
                .split(",")
                .map(v => v.trim())
                .filter(Boolean);
        }
        return [];
    }

    function hasSelectedHighRiskOption(options, selectedValues) {
        const highRiskValues = new Set((options || [])
            .filter(opt => opt && opt.risk === "high")
            .map(opt => String(opt.value)));
        return selectedValues.some(v => highRiskValues.has(String(v)));
    }

    window.LlamaGui.configFlagsUi = {
        configure,
        initConfigControls,
        resetOpenCategories,
        renderFlags,
        restoreFlagInputs,
        normalizeMultiEnumValue,
        initializeSensitiveTextInput,
        createSensitiveTextInput,
        syncSensitiveTextInput,
        ensureChatTemplateOption,
    };
})();
