function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

let currentTool = "llama-server";
let flagValues = getDefaultValues();
let outputTimer = null;
let lastOutputLen = 0;
let statsTimer = null;
let pollOutputActive = false;
let pollStatsActive = false;
let remoteTunnelTimer = null;
let hfDownloadTimer = null;
let openCategories = new Set();
let openSubmenus = new Set();
let configSearchQuery = "";
let selectedChatTemplatePresetValue = "";

let chatMessages = [];
let chatStreaming = false;
let chatAbortController = null;
let currentConversationId = null;
let chatStatsBaseline = { promptTokens: 0, genTokens: 0 };
let chatStatsRaw = { promptTokens: 0, genTokens: 0 };
const CHAT_CONVERSATIONS_STORAGE_KEY = "llama_gui_conversations";
const CHAT_WEB_SEARCH_STORAGE_KEY = "llama_gui_chat_web_search_enabled";
const CHAT_SAMPLER_SLIDER_MAP = {
    "chat-slider-temp": { flag: "temperature", decimals: 2 },
    "chat-slider-top-p": { flag: "top_p", decimals: 2 },
    "chat-slider-top-k": { flag: "top_k", decimals: 0 },
    "chat-slider-min-p": { flag: "min_p", decimals: 2 },
    "chat-slider-repeat": { flag: "repeat_penalty", decimals: 2 },
    "chat-slider-max-tokens": { flag: "n_predict", decimals: 0 },
};

const SAMPLER_PRESET_STORAGE_KEY = "llama_gui_sampler_presets_v1";
const BUILTIN_SAMPLER_PRESETS = {
    Neutral: {
        temperature: 1.0,
        top_k: 200,
        top_p: 1.0,
        min_p: 0,
        top_n_sigma: -1,
        xtc_probability: 0,
        xtc_threshold: 1.0,
        typical_p: 1.0,
        repeat_last_n: 360,
        repeat_penalty: 1.0,
        presence_penalty: 0,
        frequency_penalty: 0,
        dry_multiplier: 0,
        dynatemp_range: 0,
        mirostat: "0",
    },
    Balanced: {
        temperature: 0.75,
        top_k: 100,
        top_p: 0.92,
        min_p: 0,
        repeat_penalty: 1.05,
        repeat_last_n: 360,
    },
    Creative: {
        temperature: 1.0,
        top_k: 100,
        top_p: 0.98,
        min_p: 0,
        repeat_penalty: 1.1,
        repeat_last_n: 360,
    },
    Precise: {
        temperature: 0.3,
        top_k: 25,
        top_p: 0.6,
        min_p: 0,
        repeat_penalty: 1.02,
        repeat_last_n: 360,
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
    refreshChatSidebarUI();
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

function formatHfBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return "unknown size";
    if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
    return `${(value / 1048576).toFixed(1)} MB`;
}

function showHfDownloadStatus(type, message) {
    const el = document.getElementById("hf-download-status");
    if (!el) return;
    el.className = "hf-download-status" + (type ? " " + type : "");
    el.textContent = message || "";
}

function setHfDownloadBusy(isBusy) {
    const findBtn = document.getElementById("btn-hf-find-files");
    const downloadBtn = document.getElementById("btn-hf-download");
    const cancelBtn = document.getElementById("btn-hf-cancel");
    if (findBtn) findBtn.disabled = isBusy;
    if (downloadBtn) downloadBtn.disabled = isBusy;
    if (cancelBtn) cancelBtn.classList.toggle("hidden", !isBusy);
}

function updateHfProgress(prog) {
    const wrap = document.getElementById("hf-download-progress");
    const fill = document.getElementById("hf-progress-fill");
    const text = document.getElementById("hf-progress-text");
    if (!wrap || !fill || !text) return;

    const status = String(prog.status || "");
    const active = ["starting", "downloading", "cancelling"].includes(status);
    wrap.classList.toggle("hidden", !active && status !== "done");

    if (prog.total > 0) {
        const pct = Math.min(100, Math.round((prog.downloaded / prog.total) * 100));
        fill.style.width = pct + "%";
        text.textContent = `${prog.current_file || "Downloading"} ${pct}% (${formatHfBytes(prog.downloaded)} / ${formatHfBytes(prog.total)})`;
    } else {
        fill.style.width = active ? "25%" : "100%";
        text.textContent = prog.message || status || "Working...";
    }
}

function populateHfFileSelect(select, files, placeholder) {
    if (!select) return;
    select.innerHTML = "";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.appendChild(first);
    for (const file of files || []) {
        const opt = document.createElement("option");
        opt.value = file.name;
        opt.textContent = `${file.name}  (${formatHfBytes(file.size)})`;
        select.appendChild(opt);
    }
}

async function findHfFiles() {
    const repoInput = document.getElementById("hf-repo-input");
    const revisionInput = document.getElementById("hf-revision-input");
    const tokenInput = document.getElementById("hf-token-input");
    const options = document.getElementById("hf-file-options");
    const modelSelect = document.getElementById("hf-model-file-select");
    const mmprojSelect = document.getElementById("hf-mmproj-file-select");
    const mmprojGroup = document.getElementById("hf-mmproj-group");
    if (!repoInput || !modelSelect || !mmprojSelect) return;

    const repoId = repoInput.value.trim();
    if (!repoId) {
        showHfDownloadStatus("warning", "Enter a Hugging Face repo ID first.");
        return;
    }

    showHfDownloadStatus("info", "Looking for GGUF files...");
    setHfDownloadBusy(true);
    try {
        const result = await fetchJson("/api/hf/repo-files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                repo_id: repoId,
                revision: revisionInput && revisionInput.value.trim() ? revisionInput.value.trim() : "main",
                token: tokenInput ? tokenInput.value.trim() : "",
            }),
        });
        populateHfFileSelect(modelSelect, result.models || [], "-- Select model file --");
        populateHfFileSelect(mmprojSelect, result.mmproj || [], "None");
        if (result.models && result.models.length === 1) modelSelect.value = result.models[0].name;
        if (mmprojGroup) mmprojGroup.classList.toggle("hidden", !(result.mmproj && result.mmproj.length));
        if (options) options.classList.remove("hidden");
        const modelCount = (result.models || []).length;
        const mmprojCount = (result.mmproj || []).length;
        showHfDownloadStatus(
            modelCount ? "success" : "warning",
            modelCount
                ? `Found ${modelCount} model file${modelCount === 1 ? "" : "s"}${mmprojCount ? ` and ${mmprojCount} mmproj companion${mmprojCount === 1 ? "" : "s"}` : ""}.`
                : "No launchable GGUF model files were found in this repo."
        );
    } catch (e) {
        if (options) options.classList.add("hidden");
        showHfDownloadStatus("error", "Hugging Face lookup failed: " + e.message);
    } finally {
        setHfDownloadBusy(false);
    }
}

async function startHfDownload(overwrite = false) {
    const repoInput = document.getElementById("hf-repo-input");
    const revisionInput = document.getElementById("hf-revision-input");
    const tokenInput = document.getElementById("hf-token-input");
    const modelSelect = document.getElementById("hf-model-file-select");
    const mmprojSelect = document.getElementById("hf-mmproj-file-select");
    if (!repoInput || !modelSelect) return;

    const modelFile = modelSelect.value;
    if (!modelFile) {
        showHfDownloadStatus("warning", "Choose a model file to download.");
        return;
    }

    showHfDownloadStatus("info", "Starting download...");
    setHfDownloadBusy(true);
    try {
        await fetchJson("/api/hf/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                repo_id: repoInput.value.trim(),
                revision: revisionInput && revisionInput.value.trim() ? revisionInput.value.trim() : "main",
                token: tokenInput ? tokenInput.value.trim() : "",
                model_file: modelFile,
                mmproj_file: mmprojSelect ? mmprojSelect.value : "",
                overwrite,
            }),
        });
        pollHfDownloadProgress();
    } catch (e) {
        setHfDownloadBusy(false);
        if (e.message && e.message.startsWith("Already exists:")) {
            const ok = await confirmAction(`${e.message}. Replace the existing file?`);
            if (ok) {
                startHfDownload(true);
                return;
            }
        }
        showHfDownloadStatus("error", "Download failed to start: " + e.message);
    }
}

async function finishHfDownload(prog) {
    showHfDownloadStatus("success", prog.message || "Download complete.");
    setHfDownloadBusy(false);
    await refreshModels();
    if (prog.model_name) {
        applyPresetModel(prog.model_name);
    }
    if (prog.mmproj_path) {
        setPathFlagValue("mmproj", prog.mmproj_path);
    }
    updateCommandPreview();
    refreshQuickLaunchUI();
}

async function refreshHfDownloadStatus() {
    try {
        const prog = await fetchJson("/api/hf/download-status");
        updateHfProgress(prog);

        const status = String(prog.status || "");
        const active = ["starting", "downloading", "cancelling"].includes(status);
        setHfDownloadBusy(active);

        if (prog.message) {
            const type = status === "error"
                ? "error"
                : status === "cancelled"
                    ? "warning"
                    : status === "done"
                        ? "success"
                        : "info";
            showHfDownloadStatus(type, prog.message);
        }

        if (active) {
            pollHfDownloadProgress();
        }
    } catch (e) {
        // Ignore initial status read failures; the panel remains available for manual use.
    }
}

function pollHfDownloadProgress() {
    if (hfDownloadTimer) clearInterval(hfDownloadTimer);
    hfDownloadTimer = setInterval(async () => {
        try {
            const prog = await fetchJson("/api/hf/download-status");
            updateHfProgress(prog);
            if (prog.status === "done") {
                clearInterval(hfDownloadTimer);
                hfDownloadTimer = null;
                await finishHfDownload(prog);
            } else if (["error", "cancelled"].includes(prog.status)) {
                clearInterval(hfDownloadTimer);
                hfDownloadTimer = null;
                setHfDownloadBusy(false);
                showHfDownloadStatus(prog.status === "cancelled" ? "warning" : "error", prog.message || "Download stopped.");
            }
        } catch (e) {
            // Ignore transient poll errors while the server is busy with a large download.
        }
    }, 500);
}

async function cancelHfDownload() {
    try {
        await fetchJson("/api/hf/download-cancel", { method: "POST" });
        showHfDownloadStatus("warning", "Cancelling download...");
    } catch (e) {
        showHfDownloadStatus("error", "Failed to cancel download: " + e.message);
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

    if (quickLaunchFitCtxLinked !== false) {
        quickLaunchFitCtxLinked = flagValues.fit_ctx === undefined || flagValues.fit_ctx === flagValues.ctx_size;
    }
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

    const quickMetricsToggle = document.getElementById("quick-metrics-toggle");
    if (quickMetricsToggle) quickMetricsToggle.checked = flagValues.metrics === true;

    quickCommand.textContent = document.getElementById("command-preview-text").textContent || "";
    updateQuickServerAddressPreview();
    updateQuickLaunchActionButtons();
}

function initQuickLaunch() {
    const on = (id, event, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, handler);
    };

    populateQuickTemplatePackOptions();
    refreshQuickSamplerPresetSelect();
    syncQuickLaunchModelOptions();
    refreshHfDownloadStatus();

    on("btn-open-configure", "click", () => {
        switchTab("configure");
    });

    on("btn-quick-refresh-models", "click", () => {
        refreshModels();
    });

    on("btn-hf-find-files", "click", findHfFiles);
    on("btn-hf-download", "click", () => startHfDownload(false));
    on("btn-hf-cancel", "click", cancelHfDownload);

    on("quick-model-select", "change", (e) => {
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

    on("quick-profile-select", "change", (e) => {
        applyQuickProfile(e.target.value);
        refreshQuickLaunchUI();
    });

    on("quick-context-preset", "change", (e) => {
        const customInput = document.getElementById("quick-context-custom");
        if (e.target.value === "custom") {
            if (customInput) { customInput.disabled = false; customInput.focus(); }
            return;
        }

        if (customInput) { customInput.disabled = true; customInput.value = ""; }
        setQuickLaunchContextValue(e.target.value);
    });

    on("quick-context-custom", "input", (e) => {
        const rawValue = e.target.value.trim();
        if (rawValue === "") return;
        setQuickLaunchContextValue(rawValue);
    });

    on("quick-gpu-mode", "change", (e) => {
        const gpuCustom = document.getElementById("quick-gpu-custom");
        if (gpuCustom) {
            gpuCustom.disabled = e.target.value !== "custom";
            if (e.target.value === "custom") gpuCustom.focus();
        }
        setQuickLaunchGpuLayers(e.target.value);
    });

    on("quick-gpu-custom", "input", () => {
        const gpuMode = document.getElementById("quick-gpu-mode");
        if (gpuMode && gpuMode.value === "custom") {
            setQuickLaunchGpuLayers("custom");
        }
    });

    on("quick-fit-toggle", "change", (e) => {
        setFlagValue("fit", e.target.value || "on");
    });

    on("quick-fit-target", "input", (e) => {
        setFlagValue("fit_target", e.target.value.trim() || undefined);
    });

    on("quick-fit-ctx", "input", (e) => {
        const rawValue = e.target.value.trim();
        const nextFitCtx = rawValue === "" ? undefined : parseInt(rawValue, 10);
        setFlagValue("fit_ctx", nextFitCtx, { quickLaunchFitCtxLinked: false });
    });

    on("btn-quick-fit-sync", "click", () => {
        setFlagValue("fit_ctx", flagValues.ctx_size ?? 16000, { quickLaunchFitCtxLinked: true });
    });

    on("quick-template-pack", "change", (e) => {
        applyQuickTemplatePack(e.target.value);
    });

    on("btn-quick-sampler-load", "click", () => {
        const selected = getSelectedQuickSamplerEntry();
        if (!selected) return;
        applySamplerPresetValues(selected.values);
        refreshQuickLaunchUI();
    });

    on("btn-quick-sampler-save", "click", () => {
        const nameInput = document.getElementById("quick-sampler-name");
        if (!nameInput) return;
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
        const samplerSelect = document.getElementById("quick-sampler-select");
        if (samplerSelect) samplerSelect.value = `custom|${name}`;
    });

    on("btn-quick-sampler-delete", "click", async () => {
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
        on(elementId, "input", debounce((e) => {
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
        }, 200));
    }

    on("btn-copy-quick-server-url", "click", copyQuickServerUrl);

    on("quick-metrics-toggle", "change", (e) => {
        setFlagValue("metrics", e.target.checked);
    });

    on("btn-quick-launch", "click", async () => {
        switchTab("configure");
        await launchLlama();
    });

    on("btn-quick-stop", "click", stopLlama);

    refreshQuickLaunchUI();
}

document.addEventListener("DOMContentLoaded", async () => {
    initTabs();
    initToolSelect();
    initConfigControls();
    initInstallButtons();
    initApiTab();
    initPresetImport();
    initPresetLibraryControls();
    initQuickLaunch();
    initChatTab();
    renderFlags();
    refreshModels();
    fetchReleases();
    updateCommandPreview();
    updateApiEndpoints();

    document.getElementById("btn-launch").addEventListener("click", launchLlama);
    document.getElementById("btn-stop").addEventListener("click", stopLlama);
    document.getElementById("model-select").addEventListener("change", () => {
        syncQuickLaunchModelOptions();
        updateCommandPreview();
    });

    const btnRefreshModels = document.getElementById("btn-refresh-models");
    if (btnRefreshModels) btnRefreshModels.addEventListener("click", () => refreshModels());
    const btnClearOutput = document.getElementById("btn-clear-output");
    if (btnClearOutput) btnClearOutput.addEventListener("click", clearOutput);
    const btnSendInput = document.getElementById("btn-send-input");
    if (btnSendInput) btnSendInput.addEventListener("click", sendInput);
    const btnCopyServerUrl = document.getElementById("btn-copy-server-url");
    if (btnCopyServerUrl) btnCopyServerUrl.addEventListener("click", copyServerUrl);
    const btnSavePreset = document.getElementById("btn-save-preset");
    if (btnSavePreset) btnSavePreset.addEventListener("click", savePreset);
    const btnImportPreset = document.getElementById("btn-import-preset");
    if (btnImportPreset) btnImportPreset.addEventListener("click", () => document.getElementById("preset-import").click());

    showToast("Llama GUI ready", "info");

    const initStatus = await checkStatus();
    if (initStatus && initStatus.running) {
        restoreRunningState(initStatus);
    }
});

function initTabs() {
    document.querySelectorAll(".nav-item").forEach(navItem => {
        navItem.addEventListener("click", () => switchTab(navItem.dataset.section));
    });
    const mobileToggle = document.getElementById("mobile-toggle");
    if (mobileToggle) {
        mobileToggle.addEventListener("click", () => {
            document.getElementById("sidebar").classList.toggle("open");
        });
    }
}

function switchTab(tabId) {
    document.querySelectorAll(".nav-item").forEach(t => t.classList.toggle("active", t.dataset.section === tabId));
    document.querySelectorAll(".section-panel").forEach(panel => {
        panel.style.display = panel.id === "section-" + tabId ? "" : "none";
    });
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("open");
    if (tabId === "presets") loadPresets();
    if (tabId === "quick-launch") refreshQuickLaunchUI();
    if (tabId === "chat") { refreshChatSidebarUI(); updateChatStatusBadge(); }
    if (tabId === "configure") updateCommandPreview();
    if (tabId === "api") {
        Promise.resolve(checkStatus()).finally(() => {
            updateApiEndpoints();
            refreshRemoteTunnelStatus();
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
    initRemoteTunnelControls();
}

function initRemoteTunnelControls() {
    const startBtn = document.getElementById("btn-start-remote-tunnel");
    const stopBtn = document.getElementById("btn-stop-remote-tunnel");
    const copyBtn = document.getElementById("btn-copy-remote-tunnel");
    const copyOpenAiBtn = document.getElementById("btn-copy-remote-openai");
    if (!startBtn || !stopBtn) return;

    startBtn.addEventListener("click", startRemoteTunnel);
    stopBtn.addEventListener("click", stopRemoteTunnel);
    if (copyBtn) {
        copyBtn.addEventListener("click", () => {
            const link = document.getElementById("remote-tunnel-url");
            copyText(link ? link.href : "");
        });
    }
    if (copyOpenAiBtn) {
        copyOpenAiBtn.addEventListener("click", () => {
            const link = document.getElementById("remote-openai-url");
            copyText(link ? link.href : "");
        });
    }
    refreshRemoteTunnelStatus();
}

function setRemoteTunnelPolling(enabled) {
    if (enabled && !remoteTunnelTimer) {
        remoteTunnelTimer = setInterval(refreshRemoteTunnelStatus, 2000);
    } else if (!enabled && remoteTunnelTimer) {
        clearInterval(remoteTunnelTimer);
        remoteTunnelTimer = null;
    }
}

function renderRemoteTunnelStatus(state) {
    const status = state && state.status ? state.status : "idle";
    const url = state && state.url ? state.url : "";
    const message = state && state.message ? state.message : "Remote tunnel is not running.";
    const startBtn = document.getElementById("btn-start-remote-tunnel");
    const stopBtn = document.getElementById("btn-stop-remote-tunnel");
    const badge = document.getElementById("remote-tunnel-badge");
    const statusEl = document.getElementById("remote-tunnel-status");
    const urlRow = document.getElementById("remote-tunnel-url-row");
    const urlLink = document.getElementById("remote-tunnel-url");
    const openAiRow = document.getElementById("remote-openai-url-row");
    const openAiLink = document.getElementById("remote-openai-url");

    const isWorking = status === "preparing" || status === "downloading" || status === "starting";
    const isRunning = status === "running";
    const isError = status === "error";

    if (badge) {
        badge.textContent = status.replace(/-/g, " ");
        badge.classList.toggle("running", isRunning);
        badge.classList.toggle("working", isWorking);
        badge.classList.toggle("error", isError);
    }
    if (statusEl) {
        statusEl.textContent = message;
    }
    if (urlRow && urlLink) {
        if (url) {
            urlLink.href = url;
            urlLink.textContent = url;
            urlRow.classList.remove("hidden");
        } else {
            urlLink.href = "#";
            urlLink.textContent = "";
            urlRow.classList.add("hidden");
        }
    }
    if (openAiRow && openAiLink) {
        if (url) {
            const apiUrl = url.replace(/\/+$/, "") + "/v1";
            openAiLink.href = apiUrl;
            openAiLink.textContent = apiUrl;
            openAiRow.classList.remove("hidden");
        } else {
            openAiLink.href = "#";
            openAiLink.textContent = "";
            openAiRow.classList.add("hidden");
        }
    }
    if (startBtn) {
        startBtn.disabled = isWorking || isRunning;
        startBtn.textContent = isWorking ? "Starting..." : "Start Tunnel";
    }
    if (stopBtn) {
        stopBtn.classList.toggle("hidden", !(isWorking || isRunning));
        stopBtn.disabled = false;
    }

    setRemoteTunnelPolling(isWorking || isRunning);
}

async function refreshRemoteTunnelStatus() {
    try {
        const state = await fetchJson("/api/remote-tunnel/status");
        renderRemoteTunnelStatus(state);
        return state;
    } catch (e) {
        renderRemoteTunnelStatus({ status: "error", message: "Failed to read remote tunnel status: " + e.message });
        return null;
    }
}

async function startRemoteTunnel() {
    renderRemoteTunnelStatus({ status: "starting", message: "Starting Cloudflare tunnel..." });
    try {
        const state = await fetchJson("/api/remote-tunnel/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                host: flagValues.host || "127.0.0.1",
                port: flagValues.port || 8080,
            }),
        });
        renderRemoteTunnelStatus(state);
        setRemoteTunnelPolling(true);
    } catch (e) {
        renderRemoteTunnelStatus({ status: "error", message: "Failed to start remote tunnel: " + e.message });
    }
}

async function stopRemoteTunnel() {
    try {
        const state = await fetchJson("/api/remote-tunnel/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        renderRemoteTunnelStatus(state);
    } catch (e) {
        renderRemoteTunnelStatus({ status: "error", message: "Failed to stop remote tunnel: " + e.message });
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

    search.addEventListener("input", debounce(() => {
        configSearchQuery = search.value.trim().toLowerCase();
        if (configSearchQuery) {
            const groups = getFlagsByCategory(currentTool);
            openCategories = new Set(Object.keys(groups));
        }
        renderFlags();
    }, 200));

    search.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && (search.value || configSearchQuery)) {
            e.preventDefault();
            clearSearch();
        }
    });

    document.getElementById("btn-clear-search").addEventListener("click", () => {
        clearSearch();
    });

    document.getElementById("btn-configure-hf-download").addEventListener("click", () => {
        switchTab("quick-launch");
        const repoInput = document.getElementById("hf-repo-input");
        if (repoInput) repoInput.focus();
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

    const isRunning = !!(latestStatus && latestStatus.running);
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
    document.getElementById("btn-restart-app").addEventListener("click", restartPythonServer);
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
            setFlagValue(f.id, checkbox.checked);
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
            const val = unique.length > 0 ? unique : undefined;
            setFlagValue(f.id, val);
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
            setFlagValue(f.id, v);
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
            setFlagValue(f.id, v);
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
            setFlagValue(f.id, textField.value || undefined);
        });
        input.appendChild(textField);
    }

    row.appendChild(label);
    row.appendChild(input);
    return row;
}

function collectFlagValues() {
    const values = {};
    for (const [k, v] of Object.entries(flagValues)) {
        values[k] = Array.isArray(v) ? [...v] : v;
    }
    return values;
}

function applyFlagValues(data) {
    flagValues = { ...getDefaultValues(), ...data };
    selectedChatTemplatePresetValue = "";
    if (flagValues.chat_template_custom) {
        const bundled = getChatTemplatePresetByPath(flagValues.chat_template_custom);
        if (bundled) selectedChatTemplatePresetValue = bundled.value;
    } else if (flagValues.chat_template) {
        const builtin = getChatTemplatePresetByBuiltinName(flagValues.chat_template);
        if (builtin) selectedChatTemplatePresetValue = builtin.value;
    }
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
    const result = getLaunchArgs();
    const args = result.args;
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
        ctx_checkpoints: 32,
        checkpoint_every_n_tokens: 8192,
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
            } else if (val === true && f.flag.startsWith("--no-")) {
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
        const modelName = modelSel.value;
        if (modelName.includes("..") || modelName.includes("/") || modelName.includes("\\")) {
            return { args, error: "Invalid model filename." };
        }
        args.push(["-m", "models/" + modelName]);
    }

    return { args, error: null };
}

function restoreRunningState(status) {
    if (!status || !status.running) return;

    const tool = status.active_process_tool || "llama-server";
    currentTool = tool;
    const toolSelect = document.getElementById("tool-select");
    if (toolSelect) toolSelect.value = tool;

    if (status.api_target) {
        if (status.api_target.host) setFlagValue("host", status.api_target.host);
        if (status.api_target.port) setFlagValue("port", status.api_target.port);
    }

    document.getElementById("btn-launch").classList.add("hidden");
    document.getElementById("btn-stop").classList.remove("hidden");
    document.getElementById("output-section").classList.remove("hidden");
    updateQuickLaunchActionButtons();

    if (tool === "llama-cli") {
        document.getElementById("input-row").classList.remove("hidden");
    } else {
        document.getElementById("input-row").classList.add("hidden");
    }

    appendOutput("--- Reconnected to running " + tool + " process ---");
    startOutputPolling();

    if (tool === "llama-server") {
        updateServerAddressPreview();
        updateQuickServerAddressPreview();
        startStatsPolling();
    }

    updateApiEndpoints();
    updateChatStatusBadge();
}

async function launchLlama() {
    const result = getLaunchArgs();
    if (result.error) {
        alert(result.error);
        return;
    }
    const args = result.args;
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
        const launchResult = await fetchJson("/api/launch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: currentTool, args }),
        });
        if (launchResult.error) {
            appendOutput("ERROR: " + launchResult.error);
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
            updateQuickLaunchActionButtons();
        } else {
            appendOutput("Started " + currentTool + " (PID: " + launchResult.pid + ")");
            appendOutput(launchResult.command);
            appendOutput("---");
            startOutputPolling();
            updateServerAddressPreview();

            if (currentTool === "llama-server") {
                const host = flagValues.host || "127.0.0.1";
                const port = flagValues.port || 8080;
                const baseUrl = `http://${host}:${port}`;
                appendOutput(`Server running at ${baseUrl}`);
                appendOutput(`Web UI: ${baseUrl}/`);
                startStatsPolling();
            }
            updateApiEndpoints();
            updateChatStatusBadge();
        }
    } catch (e) {
        appendOutput("ERROR: " + e.message);
        document.getElementById("btn-launch").classList.remove("hidden");
        document.getElementById("btn-stop").classList.add("hidden");
        updateQuickLaunchActionButtons();
        updateChatStatusBadge();
    }
}

async function stopLlama() {
    try {
        await fetchJson("/api/stop", { method: "POST" });
    } catch (e) {
        // ignore
    }
    stopOutputPolling();
    stopStatsPolling();
    appendOutput("--- Process stopped ---");
    document.getElementById("btn-launch").classList.remove("hidden");
    document.getElementById("btn-stop").classList.add("hidden");
    document.getElementById("input-row").classList.add("hidden");
    document.getElementById("server-address").classList.add("hidden");
    updateQuickLaunchActionButtons();
    updateApiEndpoints();
    updateChatStatusBadge();
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

function startStatsPolling() {
    stopStatsPolling();
    document.getElementById("stats-bar").classList.remove("hidden");
    setTimeout(() => pollStats(), 2000);
    statsTimer = setInterval(pollStats, 3000);
}

function stopStatsPolling() {
    if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
    }
    document.getElementById("stats-bar").classList.add("hidden");
    document.getElementById("stats-prompt-tokens").textContent = "--";
    document.getElementById("stats-prompt-speed").textContent = "--";
    document.getElementById("stats-gen-tokens").textContent = "--";
    document.getElementById("stats-gen-speed").textContent = "--";
    document.getElementById("stats-context").textContent = "--";
    document.getElementById("stats-kv-usage").textContent = "--%";
}

function snapshotStatsBaseline() {
    chatStatsBaseline.promptTokens = chatStatsRaw.promptTokens;
    chatStatsBaseline.genTokens = chatStatsRaw.genTokens;
}

async function pollStats() {
    if (pollStatsActive) return;
    pollStatsActive = true;
    try {
        const host = String(flagValues.host || "127.0.0.1").trim() || "127.0.0.1";
        const parsedPort = Number(flagValues.port);
        const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
        const params = new URLSearchParams({ host, port: String(port) });
        const resp = await fetch(`/api/llama/metrics?${params.toString()}`);
        if (!resp.ok) return;
        const text = await resp.text();
        const metrics = {};
        for (const line of text.split("\n")) {
            if (line.startsWith("#") || !line.trim()) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) metrics[parts[0]] = parseFloat(parts[1]);
        }
        const promptTokens = metrics["llamacpp:prompt_tokens_total"];
        const promptSpeed = metrics["llamacpp:prompt_tokens_seconds"];
        const genTokens = metrics["llamacpp:tokens_predicted_total"];
        const genSpeed = metrics["llamacpp:predicted_tokens_seconds"];
        const kvUsage = metrics["llamacpp:kv_cache_usage_ratio"];
        if (promptTokens !== undefined) chatStatsRaw.promptTokens = promptTokens;
        if (genTokens !== undefined) chatStatsRaw.genTokens = genTokens;
        const deltaPrompt = promptTokens !== undefined ? Math.max(0, promptTokens - chatStatsBaseline.promptTokens) : null;
        const deltaGen = genTokens !== undefined ? Math.max(0, genTokens - chatStatsBaseline.genTokens) : null;
        if (deltaPrompt !== null) {
            document.getElementById("stats-prompt-tokens").textContent = deltaPrompt.toLocaleString();
        }
        if (promptSpeed !== undefined) {
            document.getElementById("stats-prompt-speed").textContent = promptSpeed.toFixed(1);
        }
        if (deltaGen !== null) {
            document.getElementById("stats-gen-tokens").textContent = deltaGen.toLocaleString();
        }
        if (genSpeed !== undefined) {
            document.getElementById("stats-gen-speed").textContent = genSpeed.toFixed(1);
        }
        if (deltaPrompt !== null && deltaGen !== null) {
            document.getElementById("stats-context").textContent = (deltaPrompt + deltaGen).toLocaleString();
        }
        if (kvUsage !== undefined) {
            document.getElementById("stats-kv-usage").textContent = (kvUsage * 100).toFixed(0) + "%";
        }
    } catch (e) {
        // server not ready yet or metrics unavailable
    } finally {
        pollStatsActive = false;
    }
}

async function pollOutput() {
    if (pollOutputActive) return;
    pollOutputActive = true;
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
            stopStatsPolling();
            appendOutput("--- Process exited ---");
            document.getElementById("btn-launch").classList.remove("hidden");
            document.getElementById("btn-stop").classList.add("hidden");
            document.getElementById("input-row").classList.add("hidden");
            document.getElementById("server-address").classList.add("hidden");
            updateQuickLaunchActionButtons();
            updateApiEndpoints();
            updateChatStatusBadge();
            setTimeout(() => checkStatus(), 500);
        }
    } catch (e) {
        appendOutput("Connection to server lost: " + e.message);
        stopOutputPolling();
        stopStatsPolling();
        document.getElementById("btn-launch").classList.remove("hidden");
        document.getElementById("btn-stop").classList.add("hidden");
        document.getElementById("input-row").classList.add("hidden");
        document.getElementById("server-address").classList.add("hidden");
        updateQuickLaunchActionButtons();
        updateApiEndpoints();
        updateChatStatusBadge();
    } finally {
        pollOutputActive = false;
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

function showToast(message, type) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "info");
    const iconNames = { success: "check-circle", error: "alert-circle", info: "info" };
    const iconName = iconNames[type] || "info";
    toast.innerHTML = '<span class="icon icon-sm toast-icon"><svg viewBox="0 0 24 24">' +
        (type === "success" ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>' +
            '<polyline points="22 4 12 14.01 9 11.01"/>' :
            type === "error" ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' :
                '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>') +
        '</svg></span><span>' + message + '</span>';
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ── Chat Tab ──

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderMarkdown(text) {
    let html = escapeHtml(text);
    const codeBlocks = [];

    // Fenced code blocks ``` ... ```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const langAttr = lang ? ` data-lang="${lang}"` : "";
        const index = codeBlocks.length;
        codeBlocks.push(`<pre${langAttr}><code>${code.replace(/\n$/, "")}</code></pre>`);
        return `\u0000CODE_BLOCK_${index}\u0000`;
    });

    // Inline code `...`
    html = html.replace(/`([^`\n]+?)`/g, "<code>$1</code>");

    // Bold **...** or __...__
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

    // Italic *...* or _..._ (but not inside words like some_code)
    html = html.replace(/(?<!\w)\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\w)/g, "<em>$1</em>");
    html = html.replace(/(?<!\w)_([^\s_](?:[^_]*?[^\s_])?)_(?!\w)/g, "<em>$1</em>");

    // Strikethrough ~~...~~
    html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // Paragraphs: split on double newlines
    const blocks = html.split(/\n{2,}/);
    html = blocks.map(block => {
        block = block.trim();
        if (!block) return "";
        if (/^\u0000CODE_BLOCK_\d+\u0000$/.test(block)) return block;
        // Convert single newlines to <br>
        block = block.replace(/\n/g, "<br>");
        return `<p>${block}</p>`;
    }).join("");

    html = html.replace(/\u0000CODE_BLOCK_(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)] || "");

    return html;
}

function refreshChatSidebarUI() {
    for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
        const slider = document.getElementById(sliderId);
        const display = document.getElementById(sliderId.replace("slider", "val"));
        if (!slider || !display) continue;
        const val = flagValues[meta.flag];
        if (val !== undefined && val !== null && val !== "") {
            slider.value = val;
            display.textContent = parseFloat(val).toFixed(meta.decimals);
        }
    }
    const maxTokensSlider = document.getElementById("chat-slider-max-tokens");
    const maxTokensDisplay = document.getElementById("chat-val-max-tokens");
    if (maxTokensSlider && maxTokensDisplay) {
        const nPredict = flagValues.n_predict;
        if (nPredict !== undefined && nPredict !== null && nPredict !== "" && nPredict !== -1) {
            maxTokensSlider.value = nPredict;
            maxTokensDisplay.textContent = parseInt(nPredict, 10);
        } else {
            maxTokensSlider.value = 512;
            maxTokensDisplay.textContent = "512";
        }
    }
}

function getChatModelName() {
    const modelSel = document.getElementById("model-select");
    const alias = String(flagValues.alias || "").split(",")[0].trim();
    if (alias) return alias;
    if (modelSel && modelSel.value) return modelSel.value;
    return "local-model";
}

function getChatApiUrl() {
    const host = String(flagValues.host || "127.0.0.1").trim() || "127.0.0.1";
    const parsedPort = Number(flagValues.port);
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
    return `http://${host}:${port}/v1/chat/completions`;
}

function isChatWebSearchEnabled() {
    const toggle = document.getElementById("chat-web-search-toggle");
    return Boolean(toggle && toggle.checked);
}

function getChatRequestMessages(messages) {
    return messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
    }));
}

function updateChatStatusBadge() {
    const runningBadge = document.getElementById("chat-status-badge");
    const noServerBadge = document.getElementById("chat-no-server-badge");
    if (!runningBadge || !noServerBadge) return;

    const isRunning = !!(latestStatus && latestStatus.running);
    runningBadge.style.display = isRunning ? "" : "none";
    noServerBadge.style.display = isRunning ? "none" : "";
}

function renderChatMessage(role, content) {
    const container = document.getElementById("chat-messages");
    const empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "none";

    const msg = document.createElement("div");
    msg.className = `chat-message ${role}`;

    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.textContent = role === "user" ? "U" : "A";

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    if (role === "assistant") {
        bubble.innerHTML = renderMarkdown(content);
        bubble.dataset.rawText = content;
    } else {
        bubble.textContent = content;
    }

    msg.appendChild(avatar);
    const contentWrap = document.createElement("div");
    contentWrap.className = "chat-message-content";
    contentWrap.appendChild(bubble);
    msg.appendChild(contentWrap);
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    return bubble;
}

function getChatMessageContentWrap(bubble) {
    return bubble ? bubble.closest(".chat-message-content") : null;
}

function setChatWebStatus(bubble, text) {
    const wrap = getChatMessageContentWrap(bubble);
    if (!wrap) return;
    let status = wrap.querySelector(".chat-web-status");
    if (!text) {
        if (status) status.remove();
        return;
    }
    if (!status) {
        status = document.createElement("div");
        status.className = "chat-web-status";
        wrap.appendChild(status);
    }
    status.textContent = text;
}

function renderChatSources(bubble, sources) {
    const wrap = getChatMessageContentWrap(bubble);
    if (!wrap || !Array.isArray(sources) || sources.length === 0) return;
    const existing = wrap.querySelector(".chat-sources");
    if (existing) existing.remove();
    const sourceWrap = document.createElement("div");
    sourceWrap.className = "chat-sources";

    for (const source of sources) {
        const chip = document.createElement("a");
        chip.className = "chat-source-chip";
        chip.href = source.url || "#";
        chip.target = "_blank";
        chip.rel = "noopener noreferrer";
        const title = source.title || source.url || "Source";
        chip.title = source.url || title;
        chip.textContent = `[${source.index || sourceWrap.children.length + 1}] ${title}`;
        sourceWrap.appendChild(chip);
    }

    wrap.appendChild(sourceWrap);
}

function renderChatTypingIndicator() {
    const container = document.getElementById("chat-messages");
    const msg = document.createElement("div");
    msg.className = "chat-message assistant";
    msg.id = "chat-typing-msg";

    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.textContent = "A";

    const typing = document.createElement("div");
    typing.className = "chat-typing";
    typing.id = "chat-typing";
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        dot.className = "chat-typing-dot";
        typing.appendChild(dot);
    }

    msg.appendChild(avatar);
    msg.appendChild(typing);
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
}

function removeChatTypingIndicator() {
    const typing = document.getElementById("chat-typing-msg");
    if (typing) typing.remove();
}

function appendChatStreamToken(bubble, token) {
    bubble.dataset.rawText = (bubble.dataset.rawText || "") + token;
    bubble.innerHTML = renderMarkdown(bubble.dataset.rawText);
    const container = document.getElementById("chat-messages");
    container.scrollTop = container.scrollHeight;
}

function showChatSendButton(show) {
    const sendBtn = document.getElementById("btn-chat-send");
    const stopBtn = document.getElementById("btn-chat-stop");
    if (sendBtn) sendBtn.style.display = show ? "flex" : "none";
    if (stopBtn) stopBtn.style.display = show ? "none" : "flex";
}

function getChatSamplerParams() {
    const params = {};
    const temp = flagValues.temperature;
    if (temp !== undefined && temp !== null) params.temperature = temp;
    const topP = flagValues.top_p;
    if (topP !== undefined && topP !== null) params.top_p = topP;
    const topK = flagValues.top_k;
    if (topK !== undefined && topK !== null && topK !== 0) params.top_k = topK;
    const minP = flagValues.min_p;
    if (minP !== undefined && minP !== null) params.min_p = minP;
    const repeatPenalty = flagValues.repeat_penalty;
    if (repeatPenalty !== undefined && repeatPenalty !== null && repeatPenalty !== 1.0) {
        params.repeat_penalty = repeatPenalty;
    }
    const nPredict = flagValues.n_predict;
    if (nPredict !== undefined && nPredict !== null && nPredict !== -1) {
        params.max_tokens = nPredict;
    }
    return params;
}

async function sendChatMessage(userText) {
    if (chatStreaming || !userText.trim()) return;

    const systemPrompt = (document.getElementById("chat-system-prompt").value || "").trim();
    chatMessages.push({ role: "user", content: userText.trim() });
    renderChatMessage("user", userText.trim());

    const chatInput = document.getElementById("chat-input");
    chatInput.value = "";
    chatInput.style.height = "auto";

    chatStreaming = true;
    showChatSendButton(false);
    renderChatTypingIndicator();

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
    }
    messages.push(...getChatRequestMessages(chatMessages));

    const body = {
        model: getChatModelName(),
        messages,
        stream: true,
        host: String(flagValues.host || "127.0.0.1").trim() || "127.0.0.1",
        port: (() => { const p = Number(flagValues.port); return Number.isFinite(p) && p > 0 ? p : 8080; })(),
        ...getChatSamplerParams(),
    };
    const webSearchEnabled = isChatWebSearchEnabled();
    if (webSearchEnabled) {
        body.web_search = true;
    }

    chatAbortController = new AbortController();

    try {
        const resp = await fetch("/api/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: chatAbortController.signal,
        });

        removeChatTypingIndicator();

        if (!resp.ok) {
            const errText = await resp.text().catch(() => resp.statusText);
            renderChatMessage("assistant", `Error: ${resp.status} - ${errText}`);
            chatStreaming = false;
            showChatSendButton(true);
            return;
        }

        const bubble = renderChatMessage("assistant", "");
        if (!resp.body) {
            renderChatMessage("assistant", "Error: Response body is empty.");
            chatStreaming = false;
            showChatSendButton(true);
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let responseSources = [];
        let streamDone = false;

        while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;
                const data = trimmed.slice(6);
                if (data === "[DONE]") {
                    streamDone = true;
                    setChatWebStatus(bubble, "");
                    break;
                }

                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === "web_status") {
                        setChatWebStatus(bubble, parsed.content || "");
                        continue;
                    }
                    if (parsed.type === "web_sources") {
                        responseSources = parsed.sources || [];
                        renderChatSources(bubble, responseSources);
                        continue;
                    }
                    if (parsed.error) {
                        const message = parsed.error.message || "Unknown error";
                        fullContent += `Error: ${message}`;
                        appendChatStreamToken(bubble, `Error: ${message}`);
                        continue;
                    }
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullContent += delta;
                        appendChatStreamToken(bubble, delta);
                    }
                } catch (_) {
                    // skip malformed chunks
                }
            }
        }

        if (streamDone) {
            await reader.cancel().catch(() => {});
        }
        setChatWebStatus(bubble, "");
        if (fullContent) {
            chatMessages.push({ role: "assistant", content: fullContent, sources: responseSources });
            saveCurrentConversation();
        }
    } catch (e) {
        removeChatTypingIndicator();
        if (e.name !== "AbortError") {
            renderChatMessage("assistant", "Error: " + e.message);
        }
    } finally {
        chatStreaming = false;
        chatAbortController = null;
        showChatSendButton(true);
        document.getElementById("chat-input").focus();
    }
}

function stopChatStream() {
    if (chatAbortController) {
        chatAbortController.abort();
    }
    removeChatTypingIndicator();
}

function undoChatMessage() {
    if (chatStreaming || chatMessages.length === 0) return;
    chatMessages.pop();
    const container = document.getElementById("chat-messages");
    const msgs = container.querySelectorAll(".chat-message");
    if (msgs.length > 0) msgs[msgs.length - 1].remove();

    if (chatMessages.length === 0) {
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        if (currentConversationId) {
            const conversations = getStoredConversations();
            saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId));
            currentConversationId = null;
            renderHistoryList();
        }
    } else {
        saveCurrentConversation();
    }
}

function regenerateChatResponse() {
    if (chatStreaming || chatMessages.length === 0) return;
    const lastMsg = chatMessages[chatMessages.length - 1];
    if (lastMsg.role === "assistant") {
        chatMessages.pop();
        const container = document.getElementById("chat-messages");
        const msgs = container.querySelectorAll(".chat-message");
        if (msgs.length > 0) msgs[msgs.length - 1].remove();
    }

    const lastUserMsg = chatMessages[chatMessages.length - 1];
    if (!lastUserMsg || lastUserMsg.role !== "user") return;

    chatMessages.pop();
    const container = document.getElementById("chat-messages");
    const msgs = container.querySelectorAll(".chat-message");
    if (msgs.length > 0) msgs[msgs.length - 1].remove();

    sendChatMessage(lastUserMsg.content);
}

// ── Chat History (localStorage) ──

function getStoredConversations() {
    try {
        return JSON.parse(localStorage.getItem(CHAT_CONVERSATIONS_STORAGE_KEY)) || [];
    } catch (_) {
        return [];
    }
}

function saveConversationsToStorage(list) {
    try {
        localStorage.setItem(CHAT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn("Failed to save conversations to localStorage:", e);
    }
}

function saveCurrentConversation() {
    if (chatMessages.length === 0) return;
    const sysPrompt = document.getElementById("chat-system-prompt");
    const conversations = getStoredConversations();
    const existing = currentConversationId
        ? conversations.find(c => c.id === currentConversationId)
        : null;

    if (existing) {
        existing.messages = chatMessages.slice();
        existing.systemPrompt = sysPrompt ? sysPrompt.value : "";
        existing.timestamp = Date.now();
        existing.title = generateConversationTitle(chatMessages);
    } else {
        const convo = {
            id: (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
                ? crypto.randomUUID()
                : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
                  }),
            title: generateConversationTitle(chatMessages),
            messages: chatMessages.slice(),
            systemPrompt: sysPrompt ? sysPrompt.value : "",
            timestamp: Date.now()
        };
        conversations.unshift(convo);
        currentConversationId = convo.id;
    }

    saveConversationsToStorage(conversations);
    renderHistoryList();
}

function generateConversationTitle(messages) {
    const first = messages.find(m => m.role === "user");
    if (!first) return "Untitled";
    const text = first.content.trim().replace(/\n/g, " ");
    return text.length > 50 ? text.slice(0, 50) + "..." : text;
}

function loadConversation(id) {
    const conversations = getStoredConversations();
    const convo = conversations.find(c => c.id === id);
    if (!convo) return;

    if (chatStreaming) stopChatStream();

    currentConversationId = convo.id;
    chatMessages = convo.messages.slice();

    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    if (sysPrompt) {
        sysPrompt.value = convo.systemPrompt || "";
        if (sysCharCount) sysCharCount.textContent = (convo.systemPrompt || "").length + " chars";
    }

    const container = document.getElementById("chat-messages");
    container.querySelectorAll(".chat-message").forEach(el => el.remove());
    const empty = document.getElementById("chat-empty");

    if (chatMessages.length === 0) {
        if (empty) empty.style.display = "";
    } else {
        if (empty) empty.style.display = "none";
        for (const msg of chatMessages) {
            renderChatMessage(msg.role, msg.content);
        }
    }

    renderHistoryList();
    snapshotStatsBaseline();
}

function deleteConversation(id) {
    const conversations = getStoredConversations();
    const filtered = conversations.filter(c => c.id !== id);
    saveConversationsToStorage(filtered);

    if (currentConversationId === id) {
        currentConversationId = null;
    }

    renderHistoryList();
}

function deleteAllConversations() {
    saveConversationsToStorage([]);
    currentConversationId = null;
    renderHistoryList();
}

function startNewChat() {
    saveCurrentConversation();
    currentConversationId = null;
    chatMessages = [];
    const container = document.getElementById("chat-messages");
    container.querySelectorAll(".chat-message").forEach(el => el.remove());
    const empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "";
    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    if (sysPrompt) sysPrompt.value = "";
    if (sysCharCount) sysCharCount.textContent = "0 chars";
    renderHistoryList();
    snapshotStatsBaseline();
}

function renderHistoryList() {
    const list = document.getElementById("chat-history-list");
    if (!list) return;

    const conversations = getStoredConversations();
    list.innerHTML = "";

    if (conversations.length === 0) {
        const empty = document.createElement("div");
        empty.className = "chat-history-empty";
        empty.textContent = "No saved conversations";
        list.appendChild(empty);
        return;
    }

    for (const convo of conversations) {
        const item = document.createElement("div");
        item.className = "chat-history-item" + (convo.id === currentConversationId ? " active" : "");

        const header = document.createElement("div");
        header.className = "chat-history-item-header";

        const title = document.createElement("div");
        title.className = "chat-history-item-title";
        title.textContent = convo.title;

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "chat-history-item-delete";
        deleteBtn.innerHTML = "&#128465;";
        deleteBtn.title = "Delete conversation";
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteConversation(convo.id);
        });

        header.appendChild(title);
        header.appendChild(deleteBtn);

        const preview = document.createElement("div");
        preview.className = "chat-history-item-preview";
        const lastMsg = convo.messages[convo.messages.length - 1];
        preview.textContent = lastMsg ? lastMsg.content.trim().replace(/\n/g, " ").slice(0, 60) : "";

        const time = document.createElement("div");
        time.className = "chat-history-item-time";
        time.textContent = formatHistoryTime(convo.timestamp);

        item.appendChild(header);
        item.appendChild(preview);
        item.appendChild(time);

        item.addEventListener("click", () => loadConversation(convo.id));
        list.appendChild(item);
    }
}

function formatHistoryTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return diffMin + "m ago";
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    return d.toLocaleDateString();
}

function clearChat() {
    if (chatStreaming) stopChatStream();
    if (currentConversationId) {
        const conversations = getStoredConversations();
        saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId));
        currentConversationId = null;
        renderHistoryList();
    }
    chatMessages = [];
    const container = document.getElementById("chat-messages");
    container.querySelectorAll(".chat-message").forEach(el => el.remove());
    const empty = document.getElementById("chat-empty");
    if (empty) empty.style.display = "";
    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    if (sysPrompt) sysPrompt.value = "";
    if (sysCharCount) sysCharCount.textContent = "0 chars";
    snapshotStatsBaseline();
}

function initChatTab() {
    const chatInput = document.getElementById("chat-input");
    const sendBtn = document.getElementById("btn-chat-send");
    const stopBtn = document.getElementById("btn-chat-stop");
    const undoBtn = document.getElementById("btn-chat-undo");
    const regenBtn = document.getElementById("btn-chat-regenerate");
    const sysPrompt = document.getElementById("chat-system-prompt");
    const sysCharCount = document.getElementById("chat-sys-char-count");
    const sidebar = document.getElementById("chat-sidebar");
    const btnCollapse = document.getElementById("btn-collapse-sidebar");
    const btnOpen = document.getElementById("btn-open-sidebar");
    const webSearchToggle = document.getElementById("chat-web-search-toggle");

    updateChatStatusBadge();

    if (webSearchToggle) {
        webSearchToggle.checked = localStorage.getItem(CHAT_WEB_SEARCH_STORAGE_KEY) === "true";
        webSearchToggle.addEventListener("change", () => {
            localStorage.setItem(CHAT_WEB_SEARCH_STORAGE_KEY, String(webSearchToggle.checked));
        });
    }

    // Auto-resize chat input
    chatInput.addEventListener("input", () => {
        chatInput.style.height = "auto";
        chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
    });

    // Send on Enter
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage(chatInput.value);
        }
    });

    sendBtn.addEventListener("click", () => sendChatMessage(chatInput.value));
    stopBtn.addEventListener("click", stopChatStream);
    undoBtn.addEventListener("click", undoChatMessage);
    regenBtn.addEventListener("click", regenerateChatResponse);

    // System prompt char count
    sysPrompt.addEventListener("input", () => {
        sysCharCount.textContent = sysPrompt.value.length + " chars";
    });
    sysCharCount.textContent = "0 chars";

    // Sidebar collapse/expand
    btnCollapse.addEventListener("click", () => {
        sidebar.classList.add("collapsed");
        btnOpen.style.display = "flex";
    });

    btnOpen.addEventListener("click", () => {
        sidebar.classList.remove("collapsed");
        btnOpen.style.display = "none";
    });

    // History panel collapse/expand
    const historyPanel = document.getElementById("chat-history-panel");
    const btnCollapseHistory = document.getElementById("btn-collapse-history");
    const btnOpenHistory = document.getElementById("btn-open-history");

    if (btnCollapseHistory && historyPanel) {
        btnCollapseHistory.addEventListener("click", () => {
            historyPanel.classList.add("collapsed");
            if (btnOpenHistory) btnOpenHistory.style.display = "flex";
        });
    }

    if (btnOpenHistory && historyPanel) {
        btnOpenHistory.addEventListener("click", () => {
            historyPanel.classList.remove("collapsed");
            btnOpenHistory.style.display = "none";
        });
    }

    // New Chat button
    const newChatBtn = document.getElementById("btn-chat-new");
    if (newChatBtn) {
        newChatBtn.addEventListener("click", startNewChat);
    }

    // Delete All History button
    const deleteAllBtn = document.getElementById("btn-delete-all-history");
    if (deleteAllBtn) {
        deleteAllBtn.addEventListener("click", () => {
            if (getStoredConversations().length === 0) return;
            if (confirm("Delete all conversations? This cannot be undone.")) {
                deleteAllConversations();
                clearChat();
            }
        });
    }

    // Initial render of history list
    renderHistoryList();

    // Sidebar sampler sliders -> setFlagValue
    for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
        const slider = document.getElementById(sliderId);
        const display = document.getElementById(sliderId.replace("slider", "val"));
        if (!slider || !display) continue;

        slider.addEventListener("input", () => {
            const raw = parseFloat(slider.value);
            display.textContent = raw.toFixed(meta.decimals);
            const val = meta.flag === "top_k" ? parseInt(slider.value, 10) : parseFloat(slider.value);
            setFlagValue(meta.flag, val);
        });
    }

    // Clear chat button in header
    const clearBtn = document.getElementById("btn-chat-clear");
    if (clearBtn) {
        clearBtn.addEventListener("click", clearChat);
    }

    // Suggestion chips
    document.querySelectorAll("#chat-empty .suggestion-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const prompt = chip.dataset.prompt;
            if (prompt) sendChatMessage(prompt);
        });
    });

    refreshChatSidebarUI();
}
