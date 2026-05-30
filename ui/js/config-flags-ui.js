(function () {
    window.LlamaGui = window.LlamaGui || {};

    let openCategories = new Set();
    let openSubmenus = new Set();
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

    function initConfigControls() {
        const search = document.getElementById("config-search");
        if (!search) return;

        const clearSearch = () => {
            search.value = "";
            configSearchQuery = "";
            renderFlags();
            search.focus();
        };

        search.addEventListener("input", dependencies.debounce(() => {
            configSearchQuery = search.value.trim().toLowerCase();
            if (configSearchQuery) {
                openCategories = new Set(Object.keys(getGroups()));
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

            for (const [submenuName, submenuFlags] of submenuMap.entries()) {
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
        sel.addEventListener("change", () => {
            if (f.id === "chat_template") {
                dependencies.setChatTemplateValue(sel.value);
            } else {
                getFlagCore().setFlagValue(f.id, sel.value || undefined);
            }
        });
        return sel;
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
                const v = parseInt(numField.value, 10);
                getFlagCore().setFlagValue(f.id, Number.isNaN(v) ? undefined : v);
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

    function restoreFlagInputs() {
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
            if (!el) continue;
            if (f.type === "bool") {
                el.checked = val === true;
                const lbl = el.parentElement.querySelector("label");
                if (lbl) lbl.textContent = val === true ? "Enabled" : "Disabled";
            } else if (f.type === "enum") {
                if (f.id === "chat_template") {
                    el.value = dependencies.getSelectedChatTemplateDropdownValue();
                } else {
                    el.value = val !== undefined ? String(val) : "";
                }
            } else {
                el.value = val !== undefined ? String(val) : "";
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
        createSubmenuBlock,
        createFlagRow,
        restoreFlagInputs,
        normalizeMultiEnumValue,
        hasSelectedHighRiskOption,
        flagMatchesSearch,
        getFlagDescriptionParts,
    };
})();
