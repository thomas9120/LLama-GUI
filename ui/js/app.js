let currentTool = "llama-server";
let flagValues = getDefaultValues();
let outputTimer = null;
let lastOutputLen = 0;
let openCategories = new Set();
let openSubmenus = new Set();
let configSearchQuery = "";
let selectedChatTemplatePresetValue = "";

const SAMPLER_PRESET_STORAGE_KEY = "llama_gui_sampler_presets_v1";
const BUILTIN_SAMPLER_PRESETS = {
    Neutral: {
        temperature: 1.0,
        top_k: 0,
        top_p: 1.0,
        min_p: 0,
        top_n_sigma: -1,
        xtc_probability: 0,
        xtc_threshold: 1.0,
        typical_p: 1.0,
        repeat_last_n: 0,
        repeat_penalty: 1.0,
        presence_penalty: 0,
        frequency_penalty: 0,
        dry_multiplier: 0,
        dynatemp_range: 0,
        mirostat: "0",
    },
    Balanced: {
        temperature: 0.8,
        top_k: 40,
        top_p: 0.95,
        min_p: 0.05,
        repeat_penalty: 1.05,
        repeat_last_n: 64,
    },
    Creative: {
        temperature: 1.05,
        top_k: 100,
        top_p: 0.97,
        min_p: 0.03,
        repeat_penalty: 1.02,
        repeat_last_n: 64,
    },
    Precise: {
        temperature: 0.45,
        top_k: 30,
        top_p: 0.9,
        min_p: 0.08,
        repeat_penalty: 1.1,
        repeat_last_n: 96,
    },
};

const QUICK_CONTEXT_PRESETS = ["8192", "16000", "32768", "64000", "128000", "256000"];
const QUICK_PROFILES = {
    "safe-defaults": {
        label: "Safe Defaults",
        summary: "Applies a full starter setup: 16000 context, Auto Fit on, GPU offload on auto, and balanced sampler settings.",
        tool: "llama-server",
        flags: {
            ctx_size: 16000,
            gpu_layers: "auto",
            fit: "on",
            fit_target: "1024",
            fit_ctx: 16000,
            temperature: 0.8,
            top_p: 0.95,
            min_p: 0.05,
            repeat_penalty: 1.05,
        },
        samplerPresetName: "Balanced",
    },
    balanced: {
        label: "Balanced",
        summary: "Applies a full general-purpose setup with 16000 context, Auto Fit, auto GPU offload, and the Balanced sampler preset.",
        tool: "llama-server",
        flags: {
            ctx_size: 16000,
            gpu_layers: "auto",
            fit: "on",
            fit_target: "1024",
            fit_ctx: 16000,
            temperature: 0.8,
            top_p: 0.95,
            min_p: 0.05,
            repeat_penalty: 1.05,
        },
        samplerPresetName: "Balanced",
    },
    "low-memory": {
        label: "Low Memory",
        summary: "Applies a lighter setup with lower context, smaller batch sizes, conservative fit settings, and a more precise sampler profile.",
        tool: "llama-server",
        flags: {
            ctx_size: 8192,
            gpu_layers: "auto",
            fit: "on",
            fit_target: "1536",
            fit_ctx: 8192,
            batch_size: 1024,
            ubatch_size: 256,
            temperature: 0.7,
            top_p: 0.92,
            min_p: 0.06,
            repeat_penalty: 1.08,
        },
        samplerPresetName: "Precise",
    },
    "long-context": {
        label: "Long Context",
        summary: "Applies a larger context window while keeping Auto Fit active and the rest of the launch settings beginner-friendly.",
        tool: "llama-server",
        flags: {
            ctx_size: 32768,
            gpu_layers: "auto",
            fit: "on",
            fit_target: "1024",
            fit_ctx: 32768,
            temperature: 0.75,
            top_p: 0.95,
            min_p: 0.04,
            repeat_penalty: 1.05,
        },
        samplerPresetName: "Balanced",
    },
    "creative-chat": {
        label: "Creative Chat",
        summary: "Applies the standard launch setup, then warms up the sampler for more creative and open-ended responses.",
        tool: "llama-server",
        flags: {
            ctx_size: 16000,
            gpu_layers: "auto",
            fit: "on",
            fit_target: "1024",
            fit_ctx: 16000,
            temperature: 1.05,
            top_p: 0.97,
            min_p: 0.03,
            repeat_penalty: 1.02,
        },
        samplerPresetName: "Creative",
    },
};

let quickLaunchFitCtxLinked = true;
let quickLaunchGpuCustomSelected = false;

const API_ENDPOINTS = [
    {
        name: "OpenAI Chat Completions",
        method: "POST",
        path: "/v1/chat/completions",
        compatibility: "OpenAI compatible",
        detail: "Primary chat endpoint used by most OpenAI-compatible clients.",
    },
    {
        name: "OpenAI Completions",
        method: "POST",
        path: "/v1/completions",
        compatibility: "OpenAI compatible",
        detail: "Legacy text completion endpoint.",
    },
    {
        name: "OpenAI Embeddings",
        method: "POST",
        path: "/v1/embeddings",
        compatibility: "OpenAI compatible",
        detail: "Create vector embeddings for retrieval and semantic search.",
    },
    {
        name: "OpenAI Models",
        method: "GET",
        path: "/v1/models",
        compatibility: "OpenAI compatible",
        detail: "Lists available model aliases exposed by llama-server.",
    },
    {
        name: "Health Check",
        method: "GET",
        path: "/health",
        compatibility: "Native llama-server",
        detail: "Quick status probe for monitoring and uptime checks.",
    },
    {
        name: "Web UI",
        method: "GET",
        path: "/",
        compatibility: "Native llama-server",
        detail: "Built-in browser interface.",
    },
];

const API_SNIPPETS = [
    {
        name: "cURL (Chat Completions)",
        language: "bash",
        build: (baseUrl, modelName) => [
            "curl -X POST \"" + baseUrl + "/v1/chat/completions\" \\",
            "  -H \"Content-Type: application/json\" \\",
            "  -H \"Authorization: Bearer YOUR_API_KEY\" \\",
            "  -d '{",
            "    \"model\": \"" + modelName + "\",",
            "    \"messages\": [",
            "      {\"role\": \"user\", \"content\": \"Write a short hello from llama.cpp\"}",
            "    ]",
            "  }'",
        ].join("\n"),
    },
    {
        name: "Python (OpenAI SDK)",
        language: "python",
        build: (baseUrl, modelName) => [
            "from openai import OpenAI",
            "",
            "client = OpenAI(",
            "    base_url=\"" + baseUrl + "/v1\",",
            "    api_key=\"YOUR_API_KEY\",",
            ")",
            "",
            "resp = client.chat.completions.create(",
            "    model=\"" + modelName + "\",",
            "    messages=[",
            "        {\"role\": \"user\", \"content\": \"Explain KV cache in one sentence.\"}",
            "    ],",
            ")",
            "",
            "print(resp.choices[0].message.content)",
        ].join("\n"),
    },
    {
        name: "JavaScript (fetch)",
        language: "javascript",
        build: (baseUrl, modelName) => [
            "const response = await fetch(\"" + baseUrl + "/v1/chat/completions\", {",
            "  method: \"POST\",",
            "  headers: {",
            "    \"Content-Type\": \"application/json\",",
            "    \"Authorization\": \"Bearer YOUR_API_KEY\"",
            "  },",
            "  body: JSON.stringify({",
            "    model: \"" + modelName + "\",",
            "    messages: [",
            "      { role: \"user\", content: \"Give me 3 bullet points about GGUF.\" }",
            "    ]",
            "  })",
            "});",
            "",
            "const data = await response.json();",
            "console.log(data.choices?.[0]?.message?.content);",
        ].join("\n"),
    },
    {
        name: "JavaScript (OpenAI SDK)",
        language: "javascript",
        build: (baseUrl, modelName) => [
            "import OpenAI from \"openai\";",
            "",
            "const client = new OpenAI({",
            "  baseURL: \"" + baseUrl + "/v1\",",
            "  apiKey: \"YOUR_API_KEY\"",
            "});",
            "",
            "const resp = await client.chat.completions.create({",
            "  model: \"" + modelName + "\",",
            "  messages: [",
            "    { role: \"user\", content: \"Summarize llama.cpp in 2 lines.\" }",
            "  ]",
            "});",
            "",
            "console.log(resp.choices[0].message.content);",
        ].join("\n"),
    },
];

function getSamplerFlags() {
    return FLAGS.filter(f => f.category === "sampling");
}

function loadSamplerPresetStore() {
    try {
        const raw = localStorage.getItem(SAMPLER_PRESET_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed;
    } catch (_) {
        return {};
    }
}

function saveSamplerPresetStore(store) {
    localStorage.setItem(SAMPLER_PRESET_STORAGE_KEY, JSON.stringify(store));
}

function collectSamplerValues() {
    const values = {};
    for (const f of getSamplerFlags()) {
        const v = flagValues[f.id];
        if (v !== undefined && v !== null && v !== "") {
            values[f.id] = v;
        }
    }
    return values;
}

function normalizeSamplerPresetValues(values) {
    const result = {};
    if (!values || typeof values !== "object" || Array.isArray(values)) return result;

    const allowed = new Set(getSamplerFlags().map(f => f.id));
    for (const [k, v] of Object.entries(values)) {
        if (allowed.has(k)) {
            result[k] = v;
        }
    }
    return result;
}

function getAllSamplerPresets() {
    const custom = loadSamplerPresetStore();
    const entries = [];

    for (const [name, values] of Object.entries(BUILTIN_SAMPLER_PRESETS)) {
        entries.push({ name, values: normalizeSamplerPresetValues(values), source: "builtin" });
    }
    for (const [name, values] of Object.entries(custom)) {
        entries.push({ name, values: normalizeSamplerPresetValues(values), source: "custom" });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function applySamplerPresetValues(values) {
    const defaults = getDefaultValues();
    const patch = {};
    for (const f of getSamplerFlags()) {
        if (Object.prototype.hasOwnProperty.call(values, f.id)) {
            patch[f.id] = values[f.id];
        } else if (Object.prototype.hasOwnProperty.call(defaults, f.id)) {
            patch[f.id] = defaults[f.id];
        } else {
            patch[f.id] = undefined;
        }
    }
    setMultipleFlagValues(patch);
}

function createSamplerPresetControls() {
    const panel = document.createElement("div");
    panel.className = "sampler-presets";

    const title = document.createElement("div");
    title.className = "sampler-presets-title";
    title.textContent = "Sampler Presets";

    const row = document.createElement("div");
    row.className = "sampler-presets-row";

    const select = document.createElement("select");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Preset name...";

    const loadBtn = document.createElement("button");
    loadBtn.className = "btn btn-sm";
    loadBtn.type = "button";
    loadBtn.textContent = "Load";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-sm";
    saveBtn.type = "button";
    saveBtn.textContent = "Save";

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-sm btn-danger";
    delBtn.type = "button";
    delBtn.textContent = "Delete";

    const exportBtn = document.createElement("button");
    exportBtn.className = "btn btn-sm";
    exportBtn.type = "button";
    exportBtn.textContent = "Export";

    const importBtn = document.createElement("button");
    importBtn.className = "btn btn-sm";
    importBtn.type = "button";
    importBtn.textContent = "Import";

    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".json";
    importInput.style.display = "none";

    const getSelectedPresetEntry = () => {
        const value = select.value;
        if (!value) return null;
        const [source, ...nameParts] = value.split("|");
        const name = nameParts.join("|");
        if (!name) return null;
        const entries = getAllSamplerPresets();
        return entries.find(e => e.source === source && e.name === name) || null;
    };

    const buildUniqueName = (base, takenNames) => {
        if (!takenNames.has(base)) return base;
        let idx = 2;
        let candidate = `${base} (${idx})`;
        while (takenNames.has(candidate)) {
            idx += 1;
            candidate = `${base} (${idx})`;
        }
        return candidate;
    };

    const refreshOptions = () => {
        const entries = getAllSamplerPresets();
        const builtins = entries.filter(e => e.source === "builtin");
        const customs = entries.filter(e => e.source === "custom");
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = entries.length ? "-- Select Sampler Preset --" : "No sampler presets";
        select.appendChild(placeholder);

        if (builtins.length) {
            const group = document.createElement("optgroup");
            group.label = "Built-in";
            for (const p of builtins) {
                const opt = document.createElement("option");
                opt.value = `builtin|${p.name}`;
                opt.textContent = p.name;
                group.appendChild(opt);
            }
            select.appendChild(group);
        }

        if (customs.length) {
            const group = document.createElement("optgroup");
            group.label = "Custom";
            for (const p of customs) {
                const opt = document.createElement("option");
                opt.value = `custom|${p.name}`;
                opt.textContent = p.name;
                group.appendChild(opt);
            }
            select.appendChild(group);
        }

        if (entries.length) {
            const first = entries[0];
            select.value = `${first.source}|${first.name}`;
        }
    };

    loadBtn.addEventListener("click", () => {
        const selected = getSelectedPresetEntry();
        if (!selected) return;
        applySamplerPresetValues(selected.values);
    });

    saveBtn.addEventListener("click", () => {
        const typedName = nameInput.value.trim();
        const selected = getSelectedPresetEntry();
        const name = typedName || (selected && selected.source === "custom" ? selected.name : "");
        if (!name) {
            nameInput.focus();
            return;
        }
        const store = loadSamplerPresetStore();
        store[name] = normalizeSamplerPresetValues(collectSamplerValues());
        saveSamplerPresetStore(store);
        refreshOptions();
        select.value = `custom|${name}`;
        nameInput.value = "";
    });

    delBtn.addEventListener("click", async () => {
        const selected = getSelectedPresetEntry();
        if (!selected) return;
        if (selected.source !== "custom") {
            alert("Built-in sampler presets cannot be deleted.");
            return;
        }
        const ok = await confirmAction(
            "Delete Sampler Preset",
            `Delete sampler preset "${selected.name}"? This cannot be undone.`,
            "Delete"
        );
        if (!ok) return;

        const store = loadSamplerPresetStore();
        delete store[selected.name];
        saveSamplerPresetStore(store);
        refreshOptions();
    });

    exportBtn.addEventListener("click", () => {
        const selected = getSelectedPresetEntry();
        if (!selected) return;

        const payload = {
            name: selected.name,
            values: normalizeSamplerPresetValues(selected.values),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${selected.name.replace(/[<>:"/\\|?*]/g, "_")}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    importBtn.addEventListener("click", () => importInput.click());

    importInput.addEventListener("change", async () => {
        if (!importInput.files || importInput.files.length === 0) return;
        const file = importInput.files[0];
        importInput.value = "";

        try {
            const text = await file.text();
            const parsed = JSON.parse(text);

            const incoming = [];
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                if (parsed.name && parsed.values && typeof parsed.values === "object") {
                    incoming.push({ name: String(parsed.name), values: parsed.values });
                } else if (parsed.presets && typeof parsed.presets === "object") {
                    for (const [name, values] of Object.entries(parsed.presets)) {
                        incoming.push({ name, values });
                    }
                }
            }

            if (incoming.length === 0) {
                alert("Invalid sampler preset JSON format.");
                return;
            }

            const store = loadSamplerPresetStore();
            const taken = new Set([
                ...Object.keys(BUILTIN_SAMPLER_PRESETS),
                ...Object.keys(store),
            ]);

            let lastImportedName = "";
            for (const item of incoming) {
                const baseName = String(item.name || "Imported Sampler").trim() || "Imported Sampler";
                const uniqueName = buildUniqueName(baseName, taken);
                taken.add(uniqueName);
                store[uniqueName] = normalizeSamplerPresetValues(item.values);
                lastImportedName = uniqueName;
            }

            saveSamplerPresetStore(store);
            refreshOptions();
            if (lastImportedName) {
                select.value = `custom|${lastImportedName}`;
            }
        } catch (e) {
            alert("Failed to import sampler preset: " + e.message);
        }
    });

    row.appendChild(select);
    row.appendChild(nameInput);
    row.appendChild(loadBtn);
    row.appendChild(saveBtn);
    row.appendChild(delBtn);
    row.appendChild(exportBtn);
    row.appendChild(importBtn);
    panel.appendChild(title);
    panel.appendChild(row);
    panel.appendChild(importInput);

    refreshOptions();
    return panel;
}

function setCurrentTool(tool) {
    const nextTool = tool === "llama-cli" ? "llama-cli" : "llama-server";
    currentTool = nextTool;

    const toolSel = document.getElementById("tool-select");
    if (toolSel && toolSel.value !== nextTool) {
        toolSel.value = nextTool;
    }

    openCategories.clear();
    renderFlags();
    updateCommandPreview();
}

function syncUiAfterSharedStateChange() {
    restoreFlagInputs();
    updateCommandPreview();
}

function setFlagValue(flagId, value, options = {}) {
    setMultipleFlagValues({ [flagId]: value }, options);
}

function setPathFlagValue(flagId, value, options = {}) {
    const patch = { [flagId]: value };
    if (flagId === "mmproj" && value) {
        patch.no_mmproj = false;
    }
    if (flagId === "chat_template_custom") {
        patch.chat_template = undefined;
        const matchedPreset = getChatTemplatePresetByPath(value);
        selectedChatTemplatePresetValue = matchedPreset ? matchedPreset.value : "";
    }
    setMultipleFlagValues(patch, options);
}

function setMultipleFlagValues(patch, options = {}) {
    for (const [flagId, value] of Object.entries(patch || {})) {
        if (value === undefined) {
            delete flagValues[flagId];
        } else {
            flagValues[flagId] = value;
        }
    }

    if (Object.prototype.hasOwnProperty.call(options, "quickLaunchFitCtxLinked")) {
        quickLaunchFitCtxLinked = options.quickLaunchFitCtxLinked;
    } else if (Object.prototype.hasOwnProperty.call(patch || {}, "fit_ctx")
        || Object.prototype.hasOwnProperty.call(patch || {}, "ctx_size")) {
        const fitCtx = flagValues.fit_ctx;
        const ctxSize = flagValues.ctx_size;
        quickLaunchFitCtxLinked = fitCtx === undefined || fitCtx === ctxSize;
    }

    if (Object.prototype.hasOwnProperty.call(options, "quickLaunchGpuCustomSelected")) {
        quickLaunchGpuCustomSelected = options.quickLaunchGpuCustomSelected;
    } else if (Object.prototype.hasOwnProperty.call(patch || {}, "gpu_layers")) {
        const gpuLayers = String(flagValues.gpu_layers ?? "auto");
        quickLaunchGpuCustomSelected = gpuLayers !== "auto" && gpuLayers !== "0" && gpuLayers !== "all";
    }

    syncUiAfterSharedStateChange();
}

function getPathPickerRequest(flag) {
    return {
        purpose: flag.id,
        title: `Select ${flag.label || "File"}`,
    };
}

async function browseForPathFlag(flag) {
    const result = await fetchJson("/api/select-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getPathPickerRequest(flag)),
    });
    if (!result || !result.selected || !result.path) return "";
    return String(result.path);
}

function populateQuickTemplatePackOptions() {
    const select = document.getElementById("quick-template-pack");
    if (!select) return;

    select.innerHTML = "";
    const chatTemplateFlag = FLAGS.find((f) => f.id === "chat_template");
    for (const pack of chatTemplateFlag?.options || []) {
        const opt = document.createElement("option");
        opt.value = pack.value;
        opt.textContent = pack.label;
        select.appendChild(opt);
    }
}

function syncQuickLaunchModelOptions() {
    const mainSelect = document.getElementById("model-select");
    const quickSelect = document.getElementById("quick-model-select");
    if (!mainSelect || !quickSelect) return;

    const currentQuickValue = quickSelect.value;
    quickSelect.innerHTML = "";
    for (const option of Array.from(mainSelect.options)) {
        quickSelect.appendChild(option.cloneNode(true));
    }

    const preferredValue = mainSelect.value || currentQuickValue || "";
    const hasPreferredValue = Array.from(quickSelect.options).some((opt) => opt.value === preferredValue);
    quickSelect.value = hasPreferredValue ? preferredValue : "";
}

function applyQuickTemplatePack(templateValue) {
    setChatTemplateValue(templateValue);
}

function getSelectedQuickSamplerEntry() {
    const select = document.getElementById("quick-sampler-select");
    if (!select || !select.value) return null;
    const [source, ...nameParts] = String(select.value).split("|");
    const name = nameParts.join("|");
    return getAllSamplerPresets().find((entry) => entry.source === source && entry.name === name) || null;
}

function refreshQuickSamplerPresetSelect() {
    const select = document.getElementById("quick-sampler-select");
    if (!select) return;

    const previous = select.value;
    const entries = getAllSamplerPresets();
    const builtins = entries.filter((entry) => entry.source === "builtin");
    const customs = entries.filter((entry) => entry.source === "custom");

    select.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = entries.length ? "-- Select Sampler Preset --" : "No sampler presets";
    select.appendChild(placeholder);

    if (builtins.length) {
        const group = document.createElement("optgroup");
        group.label = "Built-in";
        for (const preset of builtins) {
            const opt = document.createElement("option");
            opt.value = `builtin|${preset.name}`;
            opt.textContent = preset.name;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }

    if (customs.length) {
        const group = document.createElement("optgroup");
        group.label = "Custom";
        for (const preset of customs) {
            const opt = document.createElement("option");
            opt.value = `custom|${preset.name}`;
            opt.textContent = preset.name;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }

    const hasPrevious = Array.from(select.options).some((opt) => opt.value === previous);
    if (hasPrevious) {
        select.value = previous;
    }
}

function applyQuickProfile(profileId) {
    const profile = QUICK_PROFILES[profileId];
    if (!profile) return;

    setCurrentTool(profile.tool || "llama-server");
    setMultipleFlagValues(profile.flags || {}, { quickLaunchFitCtxLinked: true });

    if (profile.samplerPresetName) {
        const preset = getAllSamplerPresets().find((entry) => entry.name === profile.samplerPresetName);
        if (preset) {
            applySamplerPresetValues(preset.values);
            return;
        }
    }
}

function normalizeTemplatePathValue(value) {
    return String(value || "").trim().replace(/\\/g, "/");
}

function getChatTemplatePresetByValue(value) {
    return CHAT_TEMPLATE_PRESETS.find((preset) => preset.value === String(value || "")) || null;
}

function getChatTemplatePresetByBuiltinName(value) {
    const normalized = String(value || "");
    return CHAT_TEMPLATE_PRESETS.find((preset) => preset.mode === "builtin" && preset.builtin === normalized) || null;
}

function getChatTemplatePresetByPath(path) {
    const normalizedPath = normalizeTemplatePathValue(path);
    if (!normalizedPath) return null;
    return CHAT_TEMPLATE_PRESETS.find((preset) =>
        preset.mode === "bundled"
        && normalizeTemplatePathValue(preset.path) === normalizedPath
    ) || null;
}

function getSelectedChatTemplateDropdownValue() {
    if (selectedChatTemplatePresetValue === "__koboldcpp_automatic__"
        && !flagValues.chat_template
        && !flagValues.chat_template_custom) {
        return selectedChatTemplatePresetValue;
    }

    const bundledPreset = getChatTemplatePresetByPath(flagValues.chat_template_custom);
    if (bundledPreset) {
        selectedChatTemplatePresetValue = bundledPreset.value;
        return bundledPreset.value;
    }

    const builtinPreset = getChatTemplatePresetByBuiltinName(flagValues.chat_template);
    if (builtinPreset) {
        selectedChatTemplatePresetValue = builtinPreset.value;
        return builtinPreset.value;
    }

    selectedChatTemplatePresetValue = "";
    return isSupportedChatTemplateValue(flagValues.chat_template) ? String(flagValues.chat_template ?? "") : "";
}

function getQuickTemplateSummaryText() {
    const selectedTemplateValue = getSelectedChatTemplateDropdownValue();
    const preset = getChatTemplatePresetByValue(selectedTemplateValue);
    if (preset) {
        if (preset.mode === "bundled") {
            return `Using bundled template preset: ${preset.label}.`;
        }
        if (preset.mode === "auto_alias") {
            return `Using model-provided template preset: ${preset.label}.`;
        }
        if (preset.mode === "builtin") {
            return `Using preset: ${preset.label}.`;
        }
    }
    if (selectedTemplateValue) {
        return `Using llama.cpp built-in template: ${selectedTemplateValue}`;
    }
    if (flagValues.chat_template_custom) {
        return `Using custom template file: ${flagValues.chat_template_custom}`;
    }
    return "Use the template embedded in the model metadata when available.";
}

function setChatTemplateValue(value, options = {}) {
    const normalizedValue = String(value || "");
    const preset = getChatTemplatePresetByValue(normalizedValue);

    if (preset && preset.mode === "bundled") {
        selectedChatTemplatePresetValue = preset.value;
        setMultipleFlagValues({
            chat_template: undefined,
            chat_template_custom: preset.path,
        });
        return;
    }

    if (preset && (preset.mode === "auto" || preset.mode === "auto_alias")) {
        selectedChatTemplatePresetValue = preset.value;
        setMultipleFlagValues({
            chat_template: undefined,
            chat_template_custom: undefined,
        });
        return;
    }

    if (preset && preset.mode === "builtin") {
        selectedChatTemplatePresetValue = preset.value;
        setMultipleFlagValues({
            chat_template: preset.builtin,
            chat_template_custom: undefined,
        });
        return;
    }

    selectedChatTemplatePresetValue = "";
    const patch = {
        chat_template: normalizedValue || undefined,
    };
    if (!options.preserveCustomTemplateFile) {
        patch.chat_template_custom = undefined;
    }
    setMultipleFlagValues(patch);
}

function setReasoningMode(value, options = {}) {
    const normalized = value === "on" || value === "off" ? value : "auto";
    setFlagValue("reasoning", normalized, options);
}

function setQuickLaunchContextValue(rawValue, options = {}) {
    const parsed = rawValue === "" || rawValue === null || rawValue === undefined
        ? undefined
        : parseInt(rawValue, 10);
    const nextCtxSize = Number.isFinite(parsed) ? parsed : undefined;
    const patch = { ctx_size: nextCtxSize };

    if (quickLaunchFitCtxLinked || options.forceFitSync) {
        patch.fit_ctx = nextCtxSize;
    }

    setMultipleFlagValues(patch);
}

function setQuickLaunchGpuLayers(value) {
    if (value === "custom") {
        const customInput = document.getElementById("quick-gpu-custom");
        const customValue = String(customInput && customInput.value ? customInput.value : "").trim();
        if (customValue) {
            setFlagValue("gpu_layers", customValue, { quickLaunchGpuCustomSelected: true });
        } else {
            quickLaunchGpuCustomSelected = true;
            refreshQuickLaunchUI();
        }
    } else {
        setFlagValue("gpu_layers", value || "auto", { quickLaunchGpuCustomSelected: false });
    }
}

function updateQuickLaunchActionButtons() {
    const quickLaunchBtn = document.getElementById("btn-quick-launch");
    const quickStopBtn = document.getElementById("btn-quick-stop");
    const mainLaunchBtn = document.getElementById("btn-launch");
    const mainStopBtn = document.getElementById("btn-stop");
    if (!quickLaunchBtn || !quickStopBtn || !mainLaunchBtn || !mainStopBtn) return;

    quickLaunchBtn.classList.toggle("hidden", mainLaunchBtn.classList.contains("hidden"));
    quickStopBtn.classList.toggle("hidden", mainStopBtn.classList.contains("hidden"));
}

function refreshQuickLaunchUI() {
    const quickCommand = document.getElementById("quick-command-preview");
    if (!quickCommand) return;

    quickLaunchFitCtxLinked = flagValues.fit_ctx === undefined || flagValues.fit_ctx === flagValues.ctx_size;
    syncQuickLaunchModelOptions();
    refreshQuickSamplerPresetSelect();

    const mainModelSelect = document.getElementById("model-select");
    const quickModelSelect = document.getElementById("quick-model-select");
    if (quickModelSelect && mainModelSelect) {
        quickModelSelect.value = mainModelSelect.value || "";
    }

    for (const radio of document.querySelectorAll('input[name="quick-launch-mode"]')) {
        radio.checked = radio.value === currentTool;
    }

    const modeSummary = document.getElementById("quick-mode-summary");
    if (modeSummary) {
        modeSummary.textContent = currentTool === "llama-server"
            ? "API Server is selected. This exposes the web UI and OpenAI-compatible endpoints."
            : "Chat mode is selected. The process runs as an interactive local terminal chat.";
    }

    const ctxValue = flagValues.ctx_size ?? 16000;
    const contextPreset = document.getElementById("quick-context-preset");
    const contextCustom = document.getElementById("quick-context-custom");
    if (contextPreset && contextCustom) {
        const ctxString = String(ctxValue);
        if (QUICK_CONTEXT_PRESETS.includes(ctxString)) {
            contextPreset.value = ctxString;
            contextCustom.value = "";
            contextCustom.disabled = true;
        } else {
            contextPreset.value = "custom";
            contextCustom.value = ctxString;
            contextCustom.disabled = false;
        }
    }

    const gpuMode = document.getElementById("quick-gpu-mode");
    const gpuCustom = document.getElementById("quick-gpu-custom");
    const gpuLayers = String(flagValues.gpu_layers ?? "auto");
    if (gpuMode && gpuCustom) {
        const hasCustomGpuValue = gpuLayers !== "auto" && gpuLayers !== "0" && gpuLayers !== "all";
        if (hasCustomGpuValue) {
            quickLaunchGpuCustomSelected = true;
        } else if (!quickLaunchGpuCustomSelected) {
            quickLaunchGpuCustomSelected = false;
        }

        if (!quickLaunchGpuCustomSelected && (gpuLayers === "auto" || gpuLayers === "0" || gpuLayers === "all")) {
            gpuMode.value = gpuLayers;
            gpuCustom.value = "";
            gpuCustom.disabled = true;
        } else {
            gpuMode.value = "custom";
            gpuCustom.value = hasCustomGpuValue ? gpuLayers : "";
            gpuCustom.disabled = false;
        }
    }

    const fitToggle = document.getElementById("quick-fit-toggle");
    const fitTarget = document.getElementById("quick-fit-target");
    const fitCtx = document.getElementById("quick-fit-ctx");
    if (fitToggle) fitToggle.value = String(flagValues.fit ?? "on");
    if (fitTarget) fitTarget.value = String(flagValues.fit_target ?? "1024");
    if (fitCtx) fitCtx.value = flagValues.fit_ctx ?? "";

    const fitSummary = document.getElementById("quick-fit-summary");
    if (fitSummary) {
        fitSummary.textContent = String(flagValues.fit ?? "on") === "on"
            ? `Auto Fit will leave about ${flagValues.fit_target ?? "1024"} MiB free and will not shrink below ${flagValues.fit_ctx ?? ctxValue} context.`
            : "Auto Fit is off, so llama.cpp will use your manual memory settings as-is.";
    }

    const templateSelect = document.getElementById("quick-template-pack");
    const templateSummary = document.getElementById("quick-template-summary");
    const selectedTemplateValue = getSelectedChatTemplateDropdownValue();
    if (templateSelect) {
        const hasOption = Array.from(templateSelect.options).some((opt) => opt.value === selectedTemplateValue);
        templateSelect.value = hasOption ? selectedTemplateValue : "";
    }
    if (templateSummary) {
        templateSummary.textContent = getQuickTemplateSummaryText();
    }

    const temperature = document.getElementById("quick-temperature");
    const topK = document.getElementById("quick-top-k");
    const topP = document.getElementById("quick-top-p");
    const minP = document.getElementById("quick-min-p");
    const repeatPenalty = document.getElementById("quick-repeat-penalty");
    if (temperature) temperature.value = flagValues.temperature ?? "";
    if (topK) topK.value = flagValues.top_k ?? "";
    if (topP) topP.value = flagValues.top_p ?? "";
    if (minP) minP.value = flagValues.min_p ?? "";
    if (repeatPenalty) repeatPenalty.value = flagValues.repeat_penalty ?? "";

    const profileSummary = document.getElementById("quick-profile-summary");
    const profileSelect = document.getElementById("quick-profile-select");
    if (profileSummary && profileSelect) {
        const profile = QUICK_PROFILES[profileSelect.value];
        profileSummary.textContent = profile
            ? profile.summary
            : "Profiles apply a full starter setup, including context, Auto Fit, GPU offload, and sampler settings.";
    }

    quickCommand.textContent = document.getElementById("command-preview-text").textContent || "";
    updateQuickServerAddressPreview();
    updateQuickLaunchActionButtons();
}

function initQuickLaunch() {
    populateQuickTemplatePackOptions();
    refreshQuickSamplerPresetSelect();
    syncQuickLaunchModelOptions();

    document.getElementById("btn-open-configure").addEventListener("click", () => {
        switchTab("configure");
    });

    document.getElementById("btn-quick-refresh-models").addEventListener("click", () => {
        refreshModels();
    });

    document.getElementById("quick-model-select").addEventListener("change", (e) => {
        applyPresetModel(e.target.value);
        updateCommandPreview();
    });

    for (const radio of document.querySelectorAll('input[name="quick-launch-mode"]')) {
        radio.addEventListener("change", () => {
            if (radio.checked) {
                setCurrentTool(radio.value);
            }
        });
    }

    document.getElementById("quick-profile-select").addEventListener("change", (e) => {
        applyQuickProfile(e.target.value);
        refreshQuickLaunchUI();
    });

    document.getElementById("quick-context-preset").addEventListener("change", (e) => {
        const customInput = document.getElementById("quick-context-custom");
        if (e.target.value === "custom") {
            customInput.disabled = false;
            customInput.focus();
            return;
        }

        customInput.disabled = true;
        customInput.value = "";
        setQuickLaunchContextValue(e.target.value);
    });

    document.getElementById("quick-context-custom").addEventListener("input", (e) => {
        const rawValue = e.target.value.trim();
        if (rawValue === "") return;
        setQuickLaunchContextValue(rawValue);
    });

    document.getElementById("quick-gpu-mode").addEventListener("change", (e) => {
        const gpuCustom = document.getElementById("quick-gpu-custom");
        gpuCustom.disabled = e.target.value !== "custom";
        if (e.target.value === "custom") {
            gpuCustom.focus();
        }
        setQuickLaunchGpuLayers(e.target.value);
    });

    document.getElementById("quick-gpu-custom").addEventListener("input", () => {
        const gpuMode = document.getElementById("quick-gpu-mode");
        if (gpuMode.value === "custom") {
            setQuickLaunchGpuLayers("custom");
        }
    });

    document.getElementById("quick-fit-toggle").addEventListener("change", (e) => {
        setFlagValue("fit", e.target.value || "on");
    });

    document.getElementById("quick-fit-target").addEventListener("input", (e) => {
        setFlagValue("fit_target", e.target.value.trim() || undefined);
    });

    document.getElementById("quick-fit-ctx").addEventListener("input", (e) => {
        const rawValue = e.target.value.trim();
        const nextFitCtx = rawValue === "" ? undefined : parseInt(rawValue, 10);
        setFlagValue("fit_ctx", nextFitCtx, { quickLaunchFitCtxLinked: false });
    });

    document.getElementById("btn-quick-fit-sync").addEventListener("click", () => {
        setFlagValue("fit_ctx", flagValues.ctx_size ?? 16000, { quickLaunchFitCtxLinked: true });
    });

    document.getElementById("quick-template-pack").addEventListener("change", (e) => {
        applyQuickTemplatePack(e.target.value);
    });

    document.getElementById("btn-quick-sampler-load").addEventListener("click", () => {
        const selected = getSelectedQuickSamplerEntry();
        if (!selected) return;
        applySamplerPresetValues(selected.values);
        refreshQuickLaunchUI();
    });

    document.getElementById("btn-quick-sampler-save").addEventListener("click", () => {
        const nameInput = document.getElementById("quick-sampler-name");
        const typedName = nameInput.value.trim();
        const selected = getSelectedQuickSamplerEntry();
        const name = typedName || (selected && selected.source === "custom" ? selected.name : "");
        if (!name) {
            nameInput.focus();
            return;
        }

        const store = loadSamplerPresetStore();
        store[name] = normalizeSamplerPresetValues(collectSamplerValues());
        saveSamplerPresetStore(store);
        nameInput.value = "";
        refreshQuickSamplerPresetSelect();
        document.getElementById("quick-sampler-select").value = `custom|${name}`;
    });

    document.getElementById("btn-quick-sampler-delete").addEventListener("click", async () => {
        const selected = getSelectedQuickSamplerEntry();
        if (!selected) return;
        if (selected.source !== "custom") {
            alert("Built-in sampler presets cannot be deleted.");
            return;
        }

        const ok = await confirmAction(
            "Delete Sampler Preset",
            `Delete sampler preset "${selected.name}"? This cannot be undone.`,
            "Delete"
        );
        if (!ok) return;

        const store = loadSamplerPresetStore();
        delete store[selected.name];
        saveSamplerPresetStore(store);
        refreshQuickSamplerPresetSelect();
    });

    const quickSamplerFieldMap = {
        "quick-temperature": "temperature",
        "quick-top-k": "top_k",
        "quick-top-p": "top_p",
        "quick-min-p": "min_p",
        "quick-repeat-penalty": "repeat_penalty",
    };

    for (const [elementId, flagId] of Object.entries(quickSamplerFieldMap)) {
        document.getElementById(elementId).addEventListener("input", (e) => {
            const rawValue = e.target.value.trim();
            let nextValue;
            if (rawValue === "") {
                nextValue = undefined;
            } else if (flagId === "top_k") {
                nextValue = parseInt(rawValue, 10);
            } else {
                nextValue = parseFloat(rawValue);
            }
            setFlagValue(flagId, nextValue);
        });
    }

    document.getElementById("btn-copy-quick-server-url").addEventListener("click", copyQuickServerUrl);

    document.getElementById("btn-quick-launch").addEventListener("click", async () => {
        switchTab("configure");
        await launchLlama();
    });

    document.getElementById("btn-quick-stop").addEventListener("click", stopLlama);

    refreshQuickLaunchUI();
}

document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initToolSelect();
    initConfigControls();
    initInstallButtons();
    initApiTab();
    initPresetImport();
    initQuickLaunch();
    renderFlags();
    refreshModels();
    checkStatus();
    fetchReleases();
    updateCommandPreview();
    updateApiEndpoints();
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
    if (tabId === "quick-launch") refreshQuickLaunchUI();
    if (tabId === "configure") updateCommandPreview();
    if (tabId === "api") {
        Promise.resolve(checkStatus()).finally(() => {
            updateApiEndpoints();
        });
    }
}

function initToolSelect() {
    const toolSel = document.getElementById("tool-select");
    toolSel.value = currentTool;
    toolSel.addEventListener("change", () => {
        setCurrentTool(toolSel.value);
    });
}

function initApiTab() {
    const copyBaseBtn = document.getElementById("btn-copy-api-base");
    if (copyBaseBtn) {
        copyBaseBtn.addEventListener("click", () => {
            copyText(getServerBaseUrl());
        });
    }
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

function updateQuickServerAddressPreview() {
    const el = document.getElementById("quick-server-address");
    if (!el) return;

    if (currentTool !== "llama-server") {
        el.classList.add("hidden");
        return;
    }

    const baseUrl = getServerBaseUrl();
    document.getElementById("quick-server-url").href = baseUrl;
    document.getElementById("quick-server-url").textContent = baseUrl;
    document.getElementById("quick-server-webui").href = baseUrl + "/";
    el.classList.remove("hidden");
}

function getServerBaseUrl() {
    const host = String(flagValues.host || "127.0.0.1").trim() || "127.0.0.1";
    const parsedPort = Number(flagValues.port);
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
    return `http://${host}:${port}`;
}

function getPreferredApiModelName() {
    const alias = String(flagValues.alias || "").split(",")[0].trim();
    if (alias) return alias;

    const modelSel = document.getElementById("model-select");
    const selectedModel = modelSel && modelSel.value ? String(modelSel.value).trim() : "";
    if (selectedModel) return selectedModel;

    return "your-model";
}

function updateApiEndpoints() {
    const baseUrl = getServerBaseUrl();
    const modelName = getPreferredApiModelName();
    const baseLink = document.getElementById("api-base-url");
    const list = document.getElementById("api-endpoints-list");
    const snippets = document.getElementById("api-snippets-list");
    const statusNote = document.getElementById("api-status-note");
    if (!baseLink || !list || !statusNote || !snippets) return;

    baseLink.href = baseUrl;
    baseLink.textContent = baseUrl;

    const isRunning = (!document.getElementById("btn-stop").classList.contains("hidden")) || !!(latestStatus && latestStatus.running);
    const hasApiKey = String(flagValues.api_key || "").trim().length > 0;
    const modeText = currentTool === "llama-server"
        ? "Tool mode is set to llama-server."
        : "Tool mode is set to llama-cli. Switch to llama-server to expose HTTP endpoints.";
    const runningText = isRunning
        ? "Server process appears to be running."
        : "Server process is not running right now.";
    const authText = hasApiKey
        ? "API key is configured. Use `Authorization: Bearer <key>` in clients."
        : "No API key configured. Endpoints are open on this host/port.";
    statusNote.textContent = `${modeText} ${runningText} ${authText}`;

    list.innerHTML = "";
    for (const endpoint of API_ENDPOINTS) {
        const card = document.createElement("div");
        card.className = "api-card";

        const topRow = document.createElement("div");
        topRow.className = "api-card-top";

        const title = document.createElement("div");
        title.className = "api-card-title";
        title.textContent = endpoint.name;

        const meta = document.createElement("div");
        meta.className = "api-card-meta";
        meta.textContent = `${endpoint.method} | ${endpoint.compatibility}`;

        const urlRow = document.createElement("div");
        urlRow.className = "api-url-row";

        const code = document.createElement("code");
        code.textContent = baseUrl + endpoint.path;

        const copyBtn = document.createElement("button");
        copyBtn.className = "btn btn-sm";
        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", () => copyText(baseUrl + endpoint.path));

        const detail = document.createElement("div");
        detail.className = "api-card-detail";
        detail.textContent = endpoint.detail;

        topRow.appendChild(title);
        topRow.appendChild(meta);
        urlRow.appendChild(code);
        urlRow.appendChild(copyBtn);
        card.appendChild(topRow);
        card.appendChild(urlRow);
        card.appendChild(detail);
        list.appendChild(card);
    }

    snippets.innerHTML = "";
    for (const snippet of API_SNIPPETS) {
        const card = document.createElement("div");
        card.className = "api-snippet";

        const top = document.createElement("div");
        top.className = "api-snippet-top";

        const title = document.createElement("div");
        title.className = "api-snippet-title";
        title.textContent = snippet.name;

        const copyBtn = document.createElement("button");
        copyBtn.className = "btn btn-sm";
        copyBtn.type = "button";
        copyBtn.textContent = "Copy";

        const code = document.createElement("code");
        code.textContent = snippet.build(baseUrl, modelName);

        copyBtn.addEventListener("click", () => copyText(code.textContent || ""));

        top.appendChild(title);
        top.appendChild(copyBtn);
        card.appendChild(top);
        card.appendChild(code);
        snippets.appendChild(card);
    }
}

function initInstallButtons() {
    document.getElementById("btn-install").addEventListener("click", installRelease);
    document.getElementById("btn-update").addEventListener("click", checkForUpdates);
    document.getElementById("btn-repair").addEventListener("click", repairInstall);
    document.getElementById("btn-remove-llama").addEventListener("click", removeLlamaFiles);
    document.getElementById("btn-stop-app").addEventListener("click", stopPythonServer);
    document.getElementById("refresh-releases").addEventListener("click", fetchReleases);
    document.getElementById("btn-open-models").addEventListener("click", () => openFolder("models"));
    document.getElementById("btn-open-llama").addEventListener("click", () => openFolder("llama"));
    document.getElementById("btn-check-app-update").addEventListener("click", checkAppUpdateStatus);
    document.getElementById("btn-update-app").addEventListener("click", updateAppFromGitHub);
    if (typeof checkAppUpdateStatus === "function") {
        checkAppUpdateStatus();
    }
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

        if (catId === "sampling") {
            body.appendChild(createSamplerPresetControls());
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
            const row = createFlagRow(f);
            body.appendChild(row);
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
    refreshQuickLaunchUI();
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
            if (f.id === "chat_template") {
                setChatTemplateValue(sel.value);
            } else {
                setFlagValue(f.id, sel.value || undefined);
            }
        });
        input.appendChild(sel);
    } else if (f.type === "multi_enum") {
        const selected = normalizeMultiEnumValue(flagValues[f.id]);
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
            flagValues[f.id] = unique.length > 0 ? unique : undefined;
            updateCommandPreview();
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
                const current = normalizeMultiEnumValue(flagValues[f.id]);
                if (opt.value === "all" && cb.checked) {
                    setValueAndRefresh(["all"]);
                } else {
                    const next = cb.checked
                        ? [...current.filter(v => v !== "all"), opt.value]
                        : current.filter(v => v !== opt.value);
                    setValueAndRefresh(next);
                }

                const nextSelected = normalizeMultiEnumValue(flagValues[f.id]);
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
    } else if (f.type === "path") {
        const textField = document.createElement("input");
        textField.type = "text";
        textField.id = "flag-" + f.id;
        textField.dataset.flagId = f.id;
        textField.dataset.flagType = "path";
        textField.placeholder = f.placeholder || "Path...";
        textField.value = flagValues[f.id] || "";
        textField.addEventListener("input", () => {
            setPathFlagValue(f.id, textField.value || undefined);
        });
        const browseBtn = document.createElement("button");
        browseBtn.className = "btn btn-sm";
        browseBtn.textContent = "Browse";
        browseBtn.addEventListener("click", async () => {
            try {
                const selectedPath = await browseForPathFlag(f);
                if (!selectedPath) return;
                textField.value = selectedPath;
                setPathFlagValue(f.id, selectedPath);
            } catch (e) {
                showStatus("error", "Failed to select file: " + e.message);
            }
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
    selectedChatTemplatePresetValue = "";
    const fitCtx = flagValues.fit_ctx;
    const ctxSize = flagValues.ctx_size;
    quickLaunchFitCtxLinked = fitCtx === undefined || fitCtx === ctxSize;
    syncUiAfterSharedStateChange();
}

function restoreFlagInputs() {
    for (const f of FLAGS) {
        const el = document.getElementById("flag-" + f.id);
        const val = flagValues[f.id];
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
                el.value = getSelectedChatTemplateDropdownValue();
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

function getExecutableSuffix() {
    if (typeof latestStatus !== "undefined" && latestStatus && typeof latestStatus.executable_suffix === "string") {
        return latestStatus.executable_suffix;
    }
    const ua = navigator.userAgent || "";
    return /Windows/i.test(ua) ? ".exe" : "";
}

function getToolBinaryName(tool) {
    return tool + getExecutableSuffix();
}

function updateCommandPreview() {
    const args = getLaunchArgs();
    const parts = [getToolBinaryName(currentTool)];
    for (const entry of args) {
        if (Array.isArray(entry)) {
            parts.push(...entry);
        } else {
            parts.push(String(entry));
        }
    }
    const cmd = parts.join(" ");
    document.getElementById("command-preview-text").textContent = cmd;
    updateServerAddressPreview();
    updateApiEndpoints();
    refreshQuickLaunchUI();
}

function shouldOmitFlagValue(f, value) {
    const inertDefaultValues = {
        n_predict: -1,
        keep: 0,
        threads: -1,
        top_n_sigma: -1,
        typical_p: 1.0,
        repeat_penalty: 1.0,
        presence_penalty: 0,
        frequency_penalty: 0,
        dry_multiplier: 0,
        dynatemp_range: 0,
        seed: -1,
        yarn_orig_ctx: 0,
        yarn_ext_factor: -1,
        yarn_attn_factor: -1,
        yarn_beta_slow: -1,
        yarn_beta_fast: -1,
        reasoning_budget: -1,
        cache_reuse: 0,
    };

    if (!Object.prototype.hasOwnProperty.call(inertDefaultValues, f.id)) {
        return false;
    }

    const expected = inertDefaultValues[f.id];
    if (typeof expected === "number") {
        return Number(value) === expected;
    }
    return String(value) === String(expected);
}

function getLaunchArgs() {
    const modelSel = document.getElementById("model-select");
    const args = [];
    const toolBase = currentTool.replace("llama-", "");

    for (const f of FLAGS) {
        if (f.tool !== "both" && f.tool !== toolBase) continue;
        if (typeof shouldOmitSpeculativeFlag === "function" && shouldOmitSpeculativeFlag(f, flagValues)) continue;
        const val = flagValues[f.id];
        if (val === undefined || val === null || val === "") continue;

        if (f.type === "bool") {
            if (val === true && !f.flag.startsWith("--no-")) {
                if (f.id === "preserve_thinking") {
                    args.push([f.flag, '{"preserve_thinking":true}']);
                } else {
                    args.push([f.flag]);
                }
            } else if (val === false && f.false_flag) {
                args.push([f.false_flag]);
            } else if (val === false && f.flag.startsWith("--no-")) {
                args.push([f.flag]);
            }
        } else if (f.type === "multi_enum") {
            const values = normalizeMultiEnumValue(val);
            if (values.length > 0) {
                args.push([f.flag, values.join(",")]);
            }
        } else {
            if (f.id === "chat_template" && typeof isSupportedChatTemplateValue === "function" && !isSupportedChatTemplateValue(val)) {
                continue;
            }
            if (shouldOmitFlagValue(f, val)) continue;
            args.push([f.flag, String(val)]);
        }
    }

    if (modelSel.value) {
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
    updateQuickLaunchActionButtons();

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
            updateQuickLaunchActionButtons();
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
            updateApiEndpoints();
        }
    } catch (e) {
        appendOutput("ERROR: " + e.message);
        document.getElementById("btn-launch").classList.remove("hidden");
        document.getElementById("btn-stop").classList.add("hidden");
        updateQuickLaunchActionButtons();
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
    updateQuickLaunchActionButtons();
    updateApiEndpoints();
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
            updateQuickLaunchActionButtons();
            updateApiEndpoints();
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
    syncQuickLaunchModelOptions();
    updateCommandPreview();
});

function copyServerUrl() {
    const url = document.getElementById("server-url").href;
    copyText(url);
}

function copyQuickServerUrl() {
    const url = document.getElementById("quick-server-url").href;
    copyText(url);
}

function copyText(text) {
    navigator.clipboard.writeText(text).catch(() => {});
}
