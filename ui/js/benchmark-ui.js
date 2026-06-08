(function () {
    const root = window.LlamaGui = window.LlamaGui || {};

    const BENCH_COMPATIBLE_IDS = new Set([
        "hf_repo",
        "hf_file",
        "hf_token",
        "ctx_size",
        "batch_size",
        "ubatch_size",
        "threads",
        "threads_batch",
        "numa",
        "prio",
        "poll",
        "gpu_layers",
        "split_mode",
        "tensor_split",
        "main_gpu",
        "device",
        "flash_attn",
        "mmap",
        "direct_io",
        "fit",
        "fit_target",
        "fit_ctx",
        "cache_type_k",
        "cache_type_v",
    ]);

    const BENCH_ONLY_IDS = new Set(["repetitions", "n_prompt", "n_gen", "output_format"]);
    const PERPLEXITY_ONLY_IDS = new Set(["prompt_file", "chunks", "ppl_stride", "warmup"]);
    const BENCHMARK_SOURCE_LABELS = {
        current: "Current Configure",
        preset: "Saved Preset",
        manual: "Manual Model",
    };
    const BENCHMARK_TYPE_LABELS = {
        bench: "Throughput",
        perplexity: "Perplexity",
    };
    const PERPLEXITY_PRESETS = {
        gui: {
            ctx: "4096",
            batch: "2048",
            ubatch: "512",
            threads: "-1",
            gpuLayers: "auto",
            flashAttention: "auto",
            cacheTypeK: "f16",
            cacheTypeV: "f16",
            chunks: "5",
            pplStride: "0",
            warmup: true,
        },
        llamacpp: {
            ctx: "512",
            batch: "2048",
            ubatch: "512",
            threads: "-1",
            gpuLayers: "auto",
            flashAttention: "auto",
            cacheTypeK: "f16",
            cacheTypeV: "f16",
            chunks: "-1",
            pplStride: "0",
            warmup: true,
        },
    };
    const PERPLEXITY_PRESET_CONTROL_IDS = [
        "benchmark-ppl-ctx",
        "benchmark-ppl-batch",
        "benchmark-ppl-ubatch",
        "benchmark-ppl-threads",
        "benchmark-ppl-gpu-layers",
        "benchmark-ppl-flash-attn",
        "benchmark-ppl-cache-k",
        "benchmark-ppl-cache-v",
        "benchmark-chunks",
        "benchmark-ppl-stride",
        "benchmark-warmup",
    ];

    let flagCore = null;
    let fetchJson = null;
    let showToast = null;
    let getFlags = () => [];
    let getDefaultFlagValues = () => ({});
    let getLatestStatus = () => null;
    let refreshRuntimeStatusPanels = null;
    let statusTimer = null;
    let outputTimer = null;
    let lastOutputLen = 0;
    let outputLines = [];
    let cachedPresets = [];
    let cachedModels = [];
    let selectedPresetName = "";
    let applyingPerplexityPreset = false;

    function byId(id) {
        return document.getElementById(id);
    }

    function toArrayEntry(entry) {
        return Array.isArray(entry) ? entry.map(String) : [String(entry)];
    }

    function flattenArgs(args) {
        return (args || []).flatMap(toArrayEntry);
    }

    function quoteArg(arg) {
        const text = String(arg);
        return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    }

    function formatCommand(tool, args) {
        return [tool, ...flattenArgs(args)].map(quoteArg).join(" ");
    }

    function normalizePresetData(data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return { tool: null, model: "", flags: {} };
        }
        if (data.flags && typeof data.flags === "object" && !Array.isArray(data.flags)) {
            return {
                tool: typeof data.tool === "string" ? data.tool : null,
                model: typeof data.model === "string" ? data.model : "",
                flags: data.flags,
            };
        }
        return { tool: null, model: "", flags: data };
    }

    function cloneFlags(values) {
        const copy = {};
        for (const [key, value] of Object.entries(values || {})) {
            copy[key] = Array.isArray(value) ? [...value] : value;
        }
        return copy;
    }

    function getFlagLabel(flag) {
        return flag && (flag.label || flag.id || flag.flag) || "Unknown";
    }

    function isEmptyFlagValue(value) {
        return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    }

    function valuesEqual(left, right) {
        if (Array.isArray(left) || Array.isArray(right)) {
            return JSON.stringify(left || []) === JSON.stringify(right || []);
        }
        return String(left) === String(right);
    }

    function hasSelectedModelArg(args) {
        const flat = flattenArgs(args);
        return flat.some((token) => {
            const value = String(token || "");
            return value === "-m" || value === "--model" || value === "-hf" || value === "--hf-repo"
                || value.startsWith("-m=") || value.startsWith("--model=")
                || value.startsWith("-hf=") || value.startsWith("--hf-repo=");
        });
    }

    function pushFlagArg(args, tool, flag, value) {
        if (isEmptyFlagValue(value)) return false;

        if (tool === "llama-bench") {
            if (flag.id === "ctx_size") {
                return false;
            }
            if (flag.id === "threads" && String(value).trim() === "-1") {
                return false;
            }
            if (flag.id === "gpu_layers") {
                const normalizedGpuLayers = String(value).trim().toLowerCase();
                if (normalizedGpuLayers === "auto" || normalizedGpuLayers === "all") {
                    return false;
                }
            }
            if (flag.id === "mmap") {
                args.push(["-mmp", value ? "1" : "0"]);
                return true;
            }
            if (flag.id === "direct_io") {
                args.push(["-dio", value ? "1" : "0"]);
                return true;
            }
            if (flag.id === "fit") {
                return false;
            }
        }

        if (flag.type === "bool") {
            if (value === true && flag.flag && !String(flag.flag).startsWith("--no-")) {
                args.push([flag.flag]);
                return true;
            }
            if (value === false && flag.false_flag) {
                args.push([flag.false_flag]);
                return true;
            }
            if (value === true && flag.flag) {
                args.push([flag.flag]);
                return true;
            }
            return false;
        }

        if (flag.type === "multi_enum") {
            const values = Array.isArray(value) ? value.filter(Boolean) : [];
            if (values.length === 0) return false;
            args.push([flag.flag, values.join(",")]);
            return true;
        }

        args.push([flag.flag, String(value)]);
        return true;
    }

    function buildBenchmarkArgs(options = {}) {
        const source = options.source || {};
        const benchmarkType = options.benchmarkType === "perplexity" ? "perplexity" : "bench";
        const tool = benchmarkType === "perplexity" ? "llama-perplexity" : "llama-bench";
        const flags = cloneFlags(source.flags || {});
        const defaultFlags = options.defaultFlags || {};
        const model = String(source.model || "").trim();
        const allFlags = options.flags || [];
        const args = [];
        const applied = [];
        const excluded = [];

        if (model) {
            if (model.includes("..") || model.includes("/") || model.includes("\\")) {
                return { tool, args, applied, excluded, error: "Invalid model filename." };
            }
            args.push(["-m", "models/" + model]);
            applied.push({ label: "Model", value: model });
        }

        if (benchmarkType === "perplexity" && !hasSelectedModelArg(args)) {
            return { tool, args, applied, excluded, error: "Select a manual model before running perplexity." };
        }

        if (benchmarkType === "bench") {
            for (const flag of allFlags) {
                if (!flag || !flag.id || !flag.flag) continue;
                const value = flags[flag.id];
                if (isEmptyFlagValue(value)) continue;

                if (!BENCH_COMPATIBLE_IDS.has(flag.id)) {
                    if (!Object.prototype.hasOwnProperty.call(defaultFlags, flag.id) || !valuesEqual(value, defaultFlags[flag.id])) {
                        excluded.push({ label: getFlagLabel(flag), reason: "Not used by benchmark tools" });
                    }
                    continue;
                }

                if (flag.id === "threads_batch") {
                    if (!Object.prototype.hasOwnProperty.call(defaultFlags, flag.id) || !valuesEqual(value, defaultFlags[flag.id])) {
                        excluded.push({ label: getFlagLabel(flag), reason: "llama-bench uses one thread setting" });
                    }
                    continue;
                }

                const before = args.length;
                const didApply = pushFlagArg(args, tool, flag, value);
                if (didApply && args.length > before) {
                    applied.push({ label: getFlagLabel(flag), value: Array.isArray(value) ? value.join(",") : String(value) });
                } else {
                    if (!Object.prototype.hasOwnProperty.call(defaultFlags, flag.id) || !valuesEqual(value, defaultFlags[flag.id])) {
                        excluded.push({ label: getFlagLabel(flag), reason: "Not supported for this benchmark" });
                    }
                }
            }
            const repetitions = options.repetitions || 5;
            const nPrompt = options.nPrompt || 512;
            const nGen = options.nGen || 128;
            const outputFormat = options.outputFormat || "md";
            args.push(["-r", String(repetitions)]);
            args.push(["-p", String(nPrompt)]);
            args.push(["-n", String(nGen)]);
            args.push(["-o", outputFormat]);
            applied.push({ label: "Repetitions", value: String(repetitions) });
            applied.push({ label: "Prompt Tokens", value: String(nPrompt) });
            applied.push({ label: "Generation Tokens", value: String(nGen) });
            applied.push({ label: "Output Format", value: outputFormat });
        } else {
            const contextSize = options.pplContextSize || 4096;
            const batchSize = options.pplBatchSize || 2048;
            const ubatchSize = options.pplUbatchSize || 512;
            const threads = options.pplThreads ?? -1;
            const gpuLayers = String(options.pplGpuLayers || "auto").trim();
            const flashAttention = options.pplFlashAttention || "auto";
            const cacheTypeK = options.pplCacheTypeK || "f16";
            const cacheTypeV = options.pplCacheTypeV || "f16";
            args.push(["-c", String(contextSize)]);
            args.push(["-b", String(batchSize)]);
            args.push(["-ub", String(ubatchSize)]);
            args.push(["-t", String(threads)]);
            if (gpuLayers) args.push(["-ngl", gpuLayers]);
            if (flashAttention) args.push(["-fa", flashAttention]);
            if (cacheTypeK) args.push(["-ctk", cacheTypeK]);
            if (cacheTypeV) args.push(["-ctv", cacheTypeV]);
            if (options.promptFile) {
                args.push(["-f", String(options.promptFile)]);
            } else {
                return { tool, args, applied, excluded, error: "Choose a prompt/data file before running perplexity." };
            }
            if (options.chunks !== undefined && options.chunks !== "") args.push(["--chunks", String(options.chunks)]);
            if (options.pplStride !== undefined && options.pplStride !== "") args.push(["--ppl-stride", String(options.pplStride)]);
            args.push([options.warmup === false ? "--no-warmup" : "--warmup"]);
            applied.push({ label: "Context Size", value: String(contextSize) });
            applied.push({ label: "Batch Size", value: String(batchSize) });
            applied.push({ label: "Micro Batch Size", value: String(ubatchSize) });
            applied.push({ label: "Threads", value: String(threads) });
            if (gpuLayers) applied.push({ label: "GPU Layers", value: gpuLayers });
            if (flashAttention) applied.push({ label: "Flash Attention", value: flashAttention });
            if (cacheTypeK) applied.push({ label: "K Cache Type", value: cacheTypeK });
            if (cacheTypeV) applied.push({ label: "V Cache Type", value: cacheTypeV });
            if (options.promptFile) applied.push({ label: "Prompt/Data File", value: String(options.promptFile) });
            applied.push({ label: "Chunks", value: options.chunks === undefined || options.chunks === "" ? "-1" : String(options.chunks) });
            applied.push({ label: "PPL Stride", value: options.pplStride === undefined || options.pplStride === "" ? "0" : String(options.pplStride) });
            applied.push({ label: "Warmup", value: options.warmup === false ? "Off" : "On" });
            if (Object.keys(flags).length > 0) {
                excluded.push({ label: "Configure/Preset Flags", reason: "Perplexity uses only the settings shown here" });
            }
        }

        if (!hasSelectedModelArg(args)) {
            return { tool, args, applied, excluded, error: "Select a model, saved preset with a model, or HF repo before running a benchmark." };
        }

        if (typeof flags.custom_args === "string" && flags.custom_args.trim()) {
            excluded.push({ label: "Custom Launch Args", reason: "Excluded for benchmark safety" });
        }

        return { tool, args, applied, excluded, error: null, command: formatCommand(tool, args) };
    }

    function renderList(container, items, emptyText) {
        if (!container) return;
        container.textContent = "";
        if (!items || items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "benchmark-empty";
            empty.textContent = emptyText;
            container.appendChild(empty);
            return;
        }
        for (const item of items) {
            const row = document.createElement("div");
            row.className = "benchmark-list-row";
            const label = document.createElement("span");
            label.textContent = item.label;
            const value = document.createElement("strong");
            value.textContent = item.value || item.reason || "";
            row.appendChild(label);
            row.appendChild(value);
            container.appendChild(row);
        }
    }

    function getSelectedBenchmarkType() {
        const value = byId("benchmark-type")?.value;
        return value === "perplexity" ? "perplexity" : "bench";
    }

    function getSelectedSourceType() {
        const value = byId("benchmark-source")?.value;
        return value === "preset" || value === "manual" ? value : "current";
    }

    function getNumberValue(id, fallback) {
        const raw = byId(id)?.value;
        if (raw === undefined || raw === null || raw === "") return fallback;
        const value = Number(raw);
        return Number.isFinite(value) ? value : fallback;
    }

    function setControlValue(id, value) {
        const el = byId(id);
        if (!el) return;
        if (el.type === "checkbox") {
            el.checked = Boolean(value);
            return;
        }
        el.value = String(value);
    }

    function setPerplexityPresetSelection(value) {
        const select = byId("benchmark-ppl-preset");
        if (select) select.value = value;
    }

    function markPerplexityPresetCustom() {
        if (applyingPerplexityPreset) return;
        setPerplexityPresetSelection("custom");
        renderCommand();
    }

    function applyPerplexityPreset(name) {
        const preset = PERPLEXITY_PRESETS[name];
        if (!preset) {
            setPerplexityPresetSelection("custom");
            renderCommand();
            return false;
        }
        applyingPerplexityPreset = true;
        setControlValue("benchmark-ppl-ctx", preset.ctx);
        setControlValue("benchmark-ppl-batch", preset.batch);
        setControlValue("benchmark-ppl-ubatch", preset.ubatch);
        setControlValue("benchmark-ppl-threads", preset.threads);
        setControlValue("benchmark-ppl-gpu-layers", preset.gpuLayers);
        setControlValue("benchmark-ppl-flash-attn", preset.flashAttention);
        setControlValue("benchmark-ppl-cache-k", preset.cacheTypeK);
        setControlValue("benchmark-ppl-cache-v", preset.cacheTypeV);
        setControlValue("benchmark-chunks", preset.chunks);
        setControlValue("benchmark-ppl-stride", preset.pplStride);
        setControlValue("benchmark-warmup", preset.warmup);
        setPerplexityPresetSelection(name);
        applyingPerplexityPreset = false;
        renderCommand();
        return true;
    }

    function getSourceSnapshot() {
        const sourceType = getSelectedSourceType();
        if (getSelectedBenchmarkType() === "perplexity") {
            return {
                sourceType: "manual",
                label: "Manual Model",
                model: byId("benchmark-manual-model")?.value || "",
                flags: {},
            };
        }
        if (sourceType === "preset") {
            const preset = cachedPresets.find((entry) => entry.name === selectedPresetName);
            const data = normalizePresetData(preset && preset.data);
            return { sourceType, label: selectedPresetName || "Saved Preset", model: data.model, flags: data.flags };
        }
        if (sourceType === "manual") {
            return {
                sourceType,
                label: "Manual Model",
                model: byId("benchmark-manual-model")?.value || "",
                flags: {},
            };
        }
        return {
            sourceType,
            label: "Current Configure",
            model: flagCore ? flagCore.getSelectedModel() : "",
            flags: flagCore ? flagCore.collectFlagValues() : {},
        };
    }

    function getBuildOptions() {
        return {
            source: getSourceSnapshot(),
            benchmarkType: getSelectedBenchmarkType(),
            flags: getFlags(),
            defaultFlags: getDefaultFlagValues(),
            repetitions: getNumberValue("benchmark-repetitions", 5),
            nPrompt: getNumberValue("benchmark-n-prompt", 512),
            nGen: getNumberValue("benchmark-n-gen", 128),
            outputFormat: byId("benchmark-output-format")?.value || "md",
            promptFile: byId("benchmark-prompt-file")?.value || "",
            pplContextSize: getNumberValue("benchmark-ppl-ctx", 4096),
            pplBatchSize: getNumberValue("benchmark-ppl-batch", 2048),
            pplUbatchSize: getNumberValue("benchmark-ppl-ubatch", 512),
            pplThreads: getNumberValue("benchmark-ppl-threads", -1),
            pplGpuLayers: byId("benchmark-ppl-gpu-layers")?.value || "auto",
            pplFlashAttention: byId("benchmark-ppl-flash-attn")?.value || "auto",
            pplCacheTypeK: byId("benchmark-ppl-cache-k")?.value || "f16",
            pplCacheTypeV: byId("benchmark-ppl-cache-v")?.value || "f16",
            chunks: byId("benchmark-chunks")?.value || "-1",
            pplStride: byId("benchmark-ppl-stride")?.value || "0",
            warmup: Boolean(byId("benchmark-warmup")?.checked),
        };
    }

    function renderCommand() {
        const result = buildBenchmarkArgs(getBuildOptions());
        const command = byId("benchmark-command-preview");
        const status = byId("benchmark-status");
        const runBtn = byId("btn-run-benchmark");
        const sourceLabel = byId("benchmark-source-summary");
        if (sourceLabel) {
            const source = getSourceSnapshot();
            if (getSelectedBenchmarkType() === "perplexity") {
                sourceLabel.textContent = `Perplexity uses the manual model and settings below -> ${source.model || "No model selected"}`;
            } else {
                sourceLabel.textContent = `${BENCHMARK_SOURCE_LABELS[source.sourceType]} -> ${source.model || source.flags.hf_repo || "No model selected"}`;
            }
        }
        if (command) {
            command.textContent = result.error ? `Cannot run: ${result.error}` : result.command;
            command.classList.toggle("command-preview-error", Boolean(result.error));
        }
        if (status) {
            status.className = "status-box";
            if (result.error) {
                status.classList.add("warning");
                status.textContent = result.error;
            } else {
                status.textContent = "";
            }
        }
        if (runBtn) runBtn.disabled = Boolean(result.error);
        renderList(byId("benchmark-applied-list"), result.applied, "No compatible settings applied yet.");
        renderList(byId("benchmark-excluded-list"), result.excluded, "No configured settings were excluded.");
        return result;
    }

    function setBadge(id, ok, label) {
        const el = byId(id);
        if (!el) return;
        el.textContent = `${label}: ${ok ? "Ready" : "Missing"}`;
        el.className = ok ? "badge badge-green" : "badge badge-yellow";
    }

    async function refreshStatus() {
        let status = getLatestStatus ? getLatestStatus() : null;
        if (!status && fetchJson) {
            try {
                status = await fetchJson("/api/status");
            } catch (e) {
                status = null;
            }
        }
        const suffix = status && typeof status.executable_suffix === "string" ? status.executable_suffix : "";
        const exes = status && status.executables ? status.executables : {};
        setBadge("benchmark-bench-badge", Boolean(exes["llama-bench" + suffix]), "llama-bench");
        setBadge("benchmark-ppl-badge", Boolean(exes["llama-perplexity" + suffix]), "llama-perplexity");
        const runBtn = byId("btn-run-benchmark");
        if (runBtn && status && status.running) {
            const tool = status.active_process_tool || "process";
            runBtn.disabled = tool !== "llama-bench" && tool !== "llama-perplexity";
        }
    }

    function syncModePanels() {
        const type = getSelectedBenchmarkType();
        const source = byId("benchmark-source");
        if (source) source.disabled = type === "perplexity";
        byId("benchmark-bench-controls")?.classList.toggle("hidden", type !== "bench");
        byId("benchmark-ppl-controls")?.classList.toggle("hidden", type !== "perplexity");
        syncSourcePanels();
        renderCommand();
    }

    function syncSourcePanels() {
        const source = getSelectedSourceType();
        const isPerplexity = getSelectedBenchmarkType() === "perplexity";
        byId("benchmark-preset-row")?.classList.toggle("hidden", isPerplexity || source !== "preset");
        byId("benchmark-manual-row")?.classList.toggle("hidden", !isPerplexity && source !== "manual");
        renderCommand();
    }

    async function loadPresetsForSelect() {
        if (!fetchJson) return;
        try {
            cachedPresets = await fetchJson("/api/presets") || [];
        } catch (e) {
            cachedPresets = [];
        }
        const select = byId("benchmark-preset-select");
        if (!select) return;
        select.textContent = "";
        if (cachedPresets.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "No saved presets";
            select.appendChild(opt);
            selectedPresetName = "";
            renderCommand();
            return;
        }
        for (const preset of cachedPresets) {
            const data = normalizePresetData(preset.data);
            const opt = document.createElement("option");
            opt.value = preset.name;
            opt.textContent = data.model ? `${preset.name} (${data.model})` : preset.name;
            select.appendChild(opt);
        }
        if (!selectedPresetName || !cachedPresets.some((entry) => entry.name === selectedPresetName)) {
            selectedPresetName = cachedPresets[0].name;
        }
        select.value = selectedPresetName;
        renderCommand();
    }

    async function loadModelsForSelect() {
        if (!fetchJson) return;
        try {
            cachedModels = await fetchJson("/api/models") || [];
        } catch (e) {
            cachedModels = [];
        }
        const select = byId("benchmark-manual-model");
        if (!select) return;
        const current = select.value;
        select.textContent = "";
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "-- Select Model --";
        select.appendChild(empty);
        for (const model of cachedModels) {
            const name = typeof model === "string" ? model : (model.name || model.filename || "");
            if (!name) continue;
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        }
        if (current && cachedModels.some((model) => (typeof model === "string" ? model : model.name) === current)) {
            select.value = current;
        }
        renderCommand();
    }

    function appendOutput(text) {
        const terminal = byId("benchmark-output-terminal");
        if (!terminal) return;
        const line = document.createElement("div");
        line.textContent = text;
        terminal.appendChild(line);
        terminal.scrollTop = terminal.scrollHeight;
        outputLines.push(String(text || ""));
        renderSummary();
    }

    function clearOutput() {
        const terminal = byId("benchmark-output-terminal");
        if (terminal) terminal.textContent = "";
        outputLines = [];
        lastOutputLen = 0;
        renderSummary();
    }

    function parseBenchSummary(lines) {
        const summary = [];
        for (const line of lines) {
            const matches = Array.from(String(line).matchAll(/([\d.]+)\s*(?:±\s*[\d.]+\s*)?t\/s/gi));
            for (const match of matches) {
                summary.push(`${match[1]} t/s`);
            }
        }
        return Array.from(new Set(summary)).slice(0, 6);
    }

    function renderSummary() {
        const el = byId("benchmark-summary");
        if (!el) return;
        const summary = parseBenchSummary(outputLines);
        el.textContent = summary.length ? `Throughput observed: ${summary.join(", ")}` : "Summary appears here when benchmark output includes recognizable throughput data.";
    }

    function stopOutputPolling() {
        if (outputTimer) {
            clearInterval(outputTimer);
            outputTimer = null;
        }
    }

    async function pollOutput() {
        if (!fetchJson) return;
        try {
            const data = await fetchJson("/api/output");
            const lines = Array.isArray(data.output) ? data.output : [];
            if (lines.length > lastOutputLen) {
                for (const line of lines.slice(lastOutputLen)) appendOutput(line);
                lastOutputLen = lines.length;
            }
            if (!data.running) {
                stopOutputPolling();
                appendOutput("--- Benchmark process exited ---");
                setRunningState(false);
                if (refreshRuntimeStatusPanels) refreshRuntimeStatusPanels();
            }
        } catch (e) {
            appendOutput("Output polling error: " + e.message);
            stopOutputPolling();
            setRunningState(false);
        }
    }

    function startOutputPolling() {
        stopOutputPolling();
        lastOutputLen = 0;
        outputTimer = setInterval(pollOutput, 300);
    }

    function setRunningState(running) {
        byId("btn-run-benchmark")?.classList.toggle("hidden", running);
        byId("btn-stop-benchmark")?.classList.toggle("hidden", !running);
    }

    async function runBenchmark() {
        const result = renderCommand();
        if (result.error) {
            if (showToast) showToast(result.error, "warning");
            return;
        }
        clearOutput();
        setRunningState(true);
        appendOutput("Started " + result.tool);
        appendOutput(result.command);
        appendOutput("---");
        try {
            const launchResult = await fetchJson("/api/launch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tool: result.tool, args: result.args }),
            });
            appendOutput("PID: " + launchResult.pid);
            startOutputPolling();
            if (refreshRuntimeStatusPanels) refreshRuntimeStatusPanels();
        } catch (e) {
            appendOutput("ERROR: " + e.message);
            setRunningState(false);
            if (refreshRuntimeStatusPanels) refreshRuntimeStatusPanels();
        }
    }

    async function stopBenchmark() {
        try {
            await fetchJson("/api/stop", { method: "POST" });
        } catch (e) {
            appendOutput("Stop request failed: " + e.message);
        }
        stopOutputPolling();
        appendOutput("--- Benchmark stopped ---");
        setRunningState(false);
        if (refreshRuntimeStatusPanels) refreshRuntimeStatusPanels();
    }

    function init() {
        const source = byId("benchmark-source");
        if (!source) return;

        source.addEventListener("change", syncSourcePanels);
        byId("benchmark-type")?.addEventListener("change", syncModePanels);
        byId("benchmark-preset-select")?.addEventListener("change", (event) => {
            selectedPresetName = event.target.value || "";
            renderCommand();
        });
        byId("benchmark-ppl-preset")?.addEventListener("change", (event) => {
            const value = event.target.value || "custom";
            if (value === "custom") {
                renderCommand();
                return;
            }
            applyPerplexityPreset(value);
        });
        byId("benchmark-manual-model")?.addEventListener("change", renderCommand);
        byId("btn-refresh-benchmark-presets")?.addEventListener("click", loadPresetsForSelect);
        byId("btn-refresh-benchmark-models")?.addEventListener("click", loadModelsForSelect);
        byId("btn-run-benchmark")?.addEventListener("click", runBenchmark);
        byId("btn-stop-benchmark")?.addEventListener("click", stopBenchmark);
        byId("btn-clear-benchmark-output")?.addEventListener("click", clearOutput);

        for (const id of [
            "benchmark-repetitions",
            "benchmark-n-prompt",
            "benchmark-n-gen",
            "benchmark-output-format",
            "benchmark-prompt-file",
        ]) {
            const el = byId(id);
            if (el) el.addEventListener("input", renderCommand);
            if (el) el.addEventListener("change", renderCommand);
        }

        for (const id of PERPLEXITY_PRESET_CONTROL_IDS) {
            const el = byId(id);
            if (el) el.addEventListener("input", markPerplexityPresetCustom);
            if (el) el.addEventListener("change", markPerplexityPresetCustom);
        }

        syncModePanels();
        syncSourcePanels();
        loadPresetsForSelect();
        loadModelsForSelect();
        refreshStatus();
    }

    function onShow() {
        loadPresetsForSelect();
        loadModelsForSelect();
        refreshStatus();
        renderCommand();
    }

    function restoreRunningState(status) {
        const tool = status && status.active_process_tool;
        if (tool !== "llama-bench" && tool !== "llama-perplexity") return false;
        clearOutput();
        setRunningState(true);
        appendOutput("--- Reconnected to running " + tool + " process ---");
        startOutputPolling();
        return true;
    }

    function configure(options = {}) {
        flagCore = options.flagCore || flagCore;
        fetchJson = options.fetchJson || fetchJson;
        showToast = options.showToast || showToast;
        getFlags = typeof options.getFlags === "function" ? options.getFlags : getFlags;
        getDefaultFlagValues = typeof options.getDefaultFlagValues === "function" ? options.getDefaultFlagValues : getDefaultFlagValues;
        getLatestStatus = typeof options.getLatestStatus === "function" ? options.getLatestStatus : getLatestStatus;
        refreshRuntimeStatusPanels = typeof options.refreshRuntimeStatusPanels === "function"
            ? options.refreshRuntimeStatusPanels
            : refreshRuntimeStatusPanels;
    }

    if (typeof window.addEventListener === "function") {
        window.addEventListener("beforeunload", () => {
            stopOutputPolling();
            if (statusTimer) clearInterval(statusTimer);
        });
    }

    root.benchmarkUi = {
        configure,
        init,
        onShow,
        restoreRunningState,
        refreshStatus,
        renderCommand,
        buildBenchmarkArgs,
        applyPerplexityPreset,
        normalizePresetData,
        flattenArgs,
        formatCommand,
    };
})();
