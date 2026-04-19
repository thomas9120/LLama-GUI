let currentTool = "llama-cli";
let flagValues = getDefaultValues();
let outputTimer = null;
let lastOutputLen = 0;
let openCategories = new Set();
let configSearchQuery = "";

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initToolSelect();
    initConfigControls();
    initInstallButtons();
    initPresetImport();
    renderFlags();
    refreshModels();
    checkStatus();
    fetchReleases();
});

function initTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
}

function switchTab(tabId) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabId));
    document.querySelectorAll(".tab-content").forEach(tc => tc.classList.toggle("active", tc.id === "tab-" + tabId));
    if (tabId === "presets") loadPresets();
    if (tabId === "configure") updateCommandPreview();
}

function initToolSelect() {
    const toolSel = document.getElementById("tool-select");
    toolSel.addEventListener("change", () => {
        currentTool = toolSel.value;
        openCategories.clear();
        renderFlags();
        updateCommandPreview();
        updateServerAddressPreview();
    });
}

function initConfigControls() {
    const search = document.getElementById("config-search");

    const clearSearch = () => {
        search.value = "";
        configSearchQuery = "";
        renderFlags();
        search.focus();
    };

    search.addEventListener("input", () => {
        configSearchQuery = search.value.trim().toLowerCase();
        if (configSearchQuery) {
            const groups = getFlagsByCategory(currentTool);
            openCategories = new Set(Object.keys(groups));
        }
        renderFlags();
    });

    search.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && (search.value || configSearchQuery)) {
            e.preventDefault();
            clearSearch();
        }
    });

    document.getElementById("btn-clear-search").addEventListener("click", () => {
        clearSearch();
    });

    document.getElementById("btn-expand-all").addEventListener("click", () => {
        const groups = getFlagsByCategory(currentTool);
        openCategories = new Set(Object.keys(groups));
        renderFlags();
    });

    document.getElementById("btn-collapse-all").addEventListener("click", () => {
        openCategories.clear();
        renderFlags();
    });
}

function flagMatchesSearch(flag, query) {
    if (!query) return true;

    const terms = [
        flag.flag,
        flag.label,
        flag.id,
        flag.desc,
    ];

    if (Array.isArray(flag.options)) {
        for (const opt of flag.options) {
            terms.push(opt.label, opt.value);
        }
    }

    return terms
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(query));
}

function updateServerAddressPreview() {
    const el = document.getElementById("server-address");
    if (currentTool !== "llama-server") {
        el.classList.add("hidden");
        return;
    }
    const host = flagValues.host || "127.0.0.1";
    const port = flagValues.port || 8080;
    const baseUrl = `http://${host}:${port}`;
    document.getElementById("server-url").href = baseUrl;
    document.getElementById("server-url").textContent = baseUrl;
    document.getElementById("server-webui").href = baseUrl + "/";
    el.classList.remove("hidden");
}

function initInstallButtons() {
    document.getElementById("btn-install").addEventListener("click", installRelease);
    document.getElementById("btn-update").addEventListener("click", checkForUpdates);
    document.getElementById("btn-repair").addEventListener("click", repairInstall);
    document.getElementById("btn-remove-llama").addEventListener("click", removeLlamaFiles);
    document.getElementById("refresh-releases").addEventListener("click", fetchReleases);
}

function initPresetImport() {
    document.getElementById("preset-import").addEventListener("change", (e) => {
        if (e.target.files.length > 0) handlePresetImport(e.target.files[0]);
        e.target.value = "";
    });
}

function renderFlags() {
    const container = document.getElementById("flags-container");
    container.innerHTML = "";
    const groups = getFlagsByCategory(currentTool);

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
        header.innerHTML = `
            <span class="arrow">&#x25B6;</span>
            <h3>${group.name}</h3>
            <span class="count">${countText}</span>
        `;

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

        for (const f of visibleFlags) {
            const row = createFlagRow(f);
            body.appendChild(row);
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
}

function createFlagRow(f) {
    const row = document.createElement("div");
    row.className = "flag-row";
    row.dataset.flagId = f.id;

    const label = document.createElement("div");
    label.className = "flag-label";
    let defaultText = "";
    if (f.default !== undefined) defaultText = ` [default: ${f.default}]`;
    label.innerHTML = `
        <span class="flag-name">${escapeHtml(f.flag)}</span>
        <span class="flag-desc">${escapeHtml(f.desc)}</span>
        ${defaultText ? `<span class="flag-default">${escapeHtml(defaultText)}</span>` : ""}
    `;

    const input = document.createElement("div");
    input.className = "flag-input";

    if (f.type === "bool") {
        const cb = document.createElement("div");
        cb.className = "checkbox-group";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = "flag-" + f.id;
        checkbox.dataset.flagId = f.id;
        checkbox.dataset.flagType = "bool";
        checkbox.checked = flagValues[f.id] === true;
        checkbox.addEventListener("change", () => {
            flagValues[f.id] = checkbox.checked;
            updateCommandPreview();
        });
        const lbl = document.createElement("label");
        lbl.htmlFor = "flag-" + f.id;
        lbl.textContent = checkbox.checked ? "Enabled" : "Disabled";
        checkbox.addEventListener("change", () => {
            lbl.textContent = checkbox.checked ? "Enabled" : "Disabled";
        });
        cb.appendChild(checkbox);
        cb.appendChild(lbl);
        input.appendChild(cb);
    } else if (f.type === "enum") {
        const sel = document.createElement("select");
        sel.id = "flag-" + f.id;
        sel.dataset.flagId = f.id;
        sel.dataset.flagType = "enum";
        for (const opt of f.options) {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = opt.label;
            o.selected = String(flagValues[f.id] || "") === opt.value;
            sel.appendChild(o);
        }
        sel.addEventListener("change", () => {
            flagValues[f.id] = sel.value || undefined;
            updateCommandPreview();
        });
        input.appendChild(sel);
    } else if (f.type === "path") {
        const textField = document.createElement("input");
        textField.type = "text";
        textField.id = "flag-" + f.id;
        textField.dataset.flagId = f.id;
        textField.dataset.flagType = "path";
        textField.placeholder = f.placeholder || "Path...";
        textField.value = flagValues[f.id] || "";
        textField.addEventListener("input", () => {
            flagValues[f.id] = textField.value || undefined;
            updateCommandPreview();
        });
        const browseBtn = document.createElement("button");
        browseBtn.className = "btn btn-sm";
        browseBtn.textContent = "Browse";
        browseBtn.addEventListener("click", () => {
            const input = document.createElement("input");
            input.type = "file";
            if (f.flag.includes("model") || f.id.includes("lora") || f.id.includes("mmproj")) {
                input.accept = ".gguf,.bin";
            }
            input.addEventListener("change", () => {
                if (input.files.length > 0) {
                    textField.value = input.files[0].path;
                    flagValues[f.id] = textField.value;
                    updateCommandPreview();
                }
            });
            input.click();
        });
        input.appendChild(textField);
        input.appendChild(browseBtn);
    } else if (f.type === "int") {
        const numField = document.createElement("input");
        numField.type = "number";
        numField.id = "flag-" + f.id;
        numField.dataset.flagId = f.id;
        numField.dataset.flagType = "int";
        numField.placeholder = f.placeholder || String(f.default ?? "");
        numField.value = flagValues[f.id] ?? "";
        if (f.min !== undefined) numField.min = f.min;
        if (f.max !== undefined) numField.max = f.max;
        if (f.step !== undefined) numField.step = f.step;
        numField.addEventListener("input", () => {
            const v = numField.value === "" ? undefined : parseInt(numField.value, 10);
            flagValues[f.id] = v;
            updateCommandPreview();
        });
        input.appendChild(numField);
    } else if (f.type === "float") {
        const numField = document.createElement("input");
        numField.type = "number";
        numField.id = "flag-" + f.id;
        numField.dataset.flagId = f.id;
        numField.dataset.flagType = "float";
        numField.placeholder = f.placeholder || String(f.default ?? "");
        numField.value = flagValues[f.id] ?? "";
        numField.step = f.step || "0.01";
        if (f.min !== undefined) numField.min = f.min;
        if (f.max !== undefined) numField.max = f.max;
        numField.addEventListener("input", () => {
            const v = numField.value === "" ? undefined : parseFloat(numField.value);
            flagValues[f.id] = v;
            updateCommandPreview();
        });
        input.appendChild(numField);
    } else {
        const textField = document.createElement("input");
        textField.type = "text";
        textField.id = "flag-" + f.id;
        textField.dataset.flagId = f.id;
        textField.dataset.flagType = "text";
        textField.placeholder = f.placeholder || "";
        textField.value = flagValues[f.id] || "";
        textField.addEventListener("input", () => {
            flagValues[f.id] = textField.value || undefined;
            updateCommandPreview();
        });
        input.appendChild(textField);
    }

    row.appendChild(label);
    row.appendChild(input);
    return row;
}

function collectFlagValues() {
    const values = { ...flagValues };
    return values;
}

function applyFlagValues(data) {
    flagValues = { ...getDefaultValues(), ...data };
    restoreFlagInputs();
    updateCommandPreview();
}

function restoreFlagInputs() {
    for (const f of FLAGS) {
        const el = document.getElementById("flag-" + f.id);
        if (!el) continue;
        const val = flagValues[f.id];
        if (f.type === "bool") {
            el.checked = val === true;
            const lbl = el.parentElement.querySelector("label");
            if (lbl) lbl.textContent = val === true ? "Enabled" : "Disabled";
        } else if (f.type === "enum") {
            el.value = val !== undefined ? String(val) : "";
        } else {
            el.value = val !== undefined ? String(val) : "";
        }
    }
}

function updateCommandPreview() {
    const modelSel = document.getElementById("model-select");
    const vals = { ...flagValues };
    if (modelSel.value) vals.model = "models/" + modelSel.value;

    const cmd = buildCommand(currentTool, vals);
    document.getElementById("command-preview-text").textContent = cmd;
    updateServerAddressPreview();
}

function getLaunchArgs() {
    const modelSel = document.getElementById("model-select");
    const args = [];
    const toolBase = currentTool.replace("llama-", "");

    for (const f of FLAGS) {
        if (f.tool !== "both" && f.tool !== toolBase) continue;
        const val = flagValues[f.id];
        if (val === undefined || val === null || val === "") continue;

        if (f.type === "bool") {
            if (val === true && !f.flag.startsWith("--no-")) {
                if (f.id === "preserve_thinking") {
                    args.push([f.flag, '{"preserve_thinking":true}']);
                } else {
                    args.push([f.flag]);
                }
            } else if (val === false && f.flag.startsWith("--no-")) {
                args.push([f.flag]);
            }
        } else {
            args.push([f.flag, String(val)]);
        }
    }

    if (modelSel.value && !flagValues.model) {
        args.push(["-m", "models/" + modelSel.value]);
    }

    return args;
}

async function launchLlama() {
    const args = getLaunchArgs();
    const hasModel = args.some(a => a[0] === "-m" || a[0] === "-hf");
    if (!hasModel) {
        alert("Select a model or provide an HF repo before launching.");
        return;
    }

    document.getElementById("btn-launch").classList.add("hidden");
    document.getElementById("btn-stop").classList.remove("hidden");
    document.getElementById("output-section").classList.remove("hidden");

    if (currentTool === "llama-cli") {
        document.getElementById("input-row").classList.remove("hidden");
    } else {
        document.getElementById("input-row").classList.add("hidden");
    }

    clearOutput();

    try {
        const result = await fetchJson("/api/launch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: currentTool, args }),
        });
        if (result.error) {
            appendOutput("ERROR: " + result.error);
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
        } else {
            appendOutput("Started " + currentTool + " (PID: " + result.pid + ")");
            appendOutput(result.command);
            appendOutput("---");
            startOutputPolling();
            updateServerAddressPreview();

            if (currentTool === "llama-server") {
                const host = flagValues.host || "127.0.0.1";
                const port = flagValues.port || 8080;
                const baseUrl = `http://${host}:${port}`;
                appendOutput(`Server running at ${baseUrl}`);
                appendOutput(`Web UI: ${baseUrl}/`);
            }
        }
    } catch (e) {
        appendOutput("ERROR: " + e.message);
        document.getElementById("btn-launch").classList.remove("hidden");
        document.getElementById("btn-stop").classList.add("hidden");
    }
}

async function stopLlama() {
    try {
        await fetchJson("/api/stop", { method: "POST" });
    } catch (e) {
        // ignore
    }
    stopOutputPolling();
    appendOutput("--- Process stopped ---");
    document.getElementById("btn-launch").classList.remove("hidden");
    document.getElementById("btn-stop").classList.add("hidden");
    document.getElementById("input-row").classList.add("hidden");
    document.getElementById("server-address").classList.add("hidden");
    setTimeout(() => checkStatus(), 500);
}

function startOutputPolling() {
    lastOutputLen = 0;
    if (outputTimer) clearInterval(outputTimer);
    outputTimer = setInterval(pollOutput, 300);
}

function stopOutputPolling() {
    if (outputTimer) {
        clearInterval(outputTimer);
        outputTimer = null;
    }
}

async function pollOutput() {
    try {
        const data = await fetchJson("/api/output");
        if (data.output.length > lastOutputLen) {
            const newLines = data.output.slice(lastOutputLen);
            for (const line of newLines) {
                appendOutput(line);
            }
            lastOutputLen = data.output.length;
        }
        if (!data.running) {
            stopOutputPolling();
            appendOutput("--- Process exited ---");
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
            document.getElementById("input-row").classList.add("hidden");
            document.getElementById("server-address").classList.add("hidden");
            setTimeout(() => checkStatus(), 500);
        }
    } catch (e) {
        // ignore
    }
}

function appendOutput(text) {
    const terminal = document.getElementById("output-terminal");
    const line = document.createElement("div");
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
}

function clearOutput() {
    document.getElementById("output-terminal").innerHTML = "";
    lastOutputLen = 0;
}

async function sendInput() {
    const input = document.getElementById("cli-input");
    const text = input.value;
    if (!text) return;
    input.value = "";
    try {
        await fetchJson("/api/send-input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        });
    } catch (e) {
        // ignore
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement.id === "cli-input") {
        sendInput();
    }
});

document.getElementById("btn-launch").addEventListener("click", launchLlama);
document.getElementById("btn-stop").addEventListener("click", stopLlama);
document.getElementById("model-select").addEventListener("change", () => {
    updateCommandPreview();
});

function copyServerUrl() {
    const url = document.getElementById("server-url").href;
    navigator.clipboard.writeText(url).catch(() => {});
}
