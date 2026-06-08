const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "benchmark-ui.js"), "utf8");

const context = {
    window: {
        LlamaGui: {},
        addEventListener: () => {},
    },
    document: {
        getElementById: () => null,
        createElement: () => ({
            appendChild: () => {},
            classList: { toggle: () => {}, add: () => {}, remove: () => {} },
        }),
    },
    console,
    setInterval,
    clearInterval,
};

context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/benchmark-ui.js" });

const adapter = context.window.LlamaGui.benchmarkUi;

const flags = [
    { id: "ctx_size", flag: "-c", type: "int", label: "Context" },
    { id: "gpu_layers", flag: "-ngl", type: "text", label: "GPU Layers" },
    { id: "threads", flag: "-t", type: "int", label: "Threads" },
    { id: "mmap", flag: "--mmap", false_flag: "--no-mmap", type: "bool", label: "Mmap" },
    { id: "direct_io", flag: "-dio", type: "bool", label: "Direct I/O" },
    { id: "hf_repo", flag: "-hf", type: "text", label: "HF Repo" },
    { id: "temperature", flag: "--temp", type: "float", label: "Temperature" },
    { id: "port", flag: "--port", type: "int", label: "Port" },
];

function flat(result) {
    return Array.from(adapter.flattenArgs(result.args));
}

{
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "bench",
        flags,
        source: {
            model: "tiny.gguf",
            flags: {
                ctx_size: 4096,
                gpu_layers: "auto",
                threads: 8,
                temperature: 0.4,
                custom_args: "--danger",
            },
        },
        repetitions: 3,
        nPrompt: 256,
        nGen: 64,
        outputFormat: "json",
    });

    assert.equal(result.error, null);
    assert.deepEqual(flat(result), [
        "-m", "models/tiny.gguf",
        "-t", "8",
        "-r", "3",
        "-p", "256",
        "-n", "64",
        "-o", "json",
    ]);
    assert.ok(result.excluded.some((item) => item.label === "Context"));
    assert.ok(result.excluded.some((item) => item.label === "GPU Layers"));
    assert.ok(result.excluded.some((item) => item.label === "Temperature"));
    assert.ok(result.excluded.some((item) => item.label === "Custom Launch Args"));
}

{
    const preset = {
        tool: "llama-server",
        model: "preset-model.gguf",
        flags: { ctx_size: 8192, port: 8080 },
    };
    const original = JSON.stringify(preset);
    const normalized = adapter.normalizePresetData(preset);
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "bench",
        flags,
        source: normalized,
    });

    assert.equal(JSON.stringify(preset), original, "preset data should not be mutated");
    assert.ok(flat(result).includes("models/preset-model.gguf"));
    assert.ok(result.excluded.some((item) => item.label === "Context"));
    assert.ok(result.excluded.some((item) => item.label === "Port"));
}

{
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "bench",
        flags,
        source: { model: "", flags: {} },
    });

    assert.match(result.error, /Select a model/);
}

{
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "perplexity",
        flags,
        source: { model: "ppl-model.gguf", flags: { hf_repo: "owner/model-GGUF:Q4_K_M", mmap: false, ctx_size: 100000 } },
        promptFile: "eval.txt",
        pplContextSize: 4096,
        pplBatchSize: 2048,
        pplUbatchSize: 512,
        pplThreads: -1,
        pplGpuLayers: "auto",
        pplFlashAttention: "auto",
        pplCacheTypeK: "f16",
        pplCacheTypeV: "f16",
        pplMmap: false,
        chunks: 5,
        pplStride: 64,
        warmup: false,
    });

    assert.equal(result.error, null);
    assert.deepEqual(flat(result), [
        "-m", "models/ppl-model.gguf",
        "-c", "4096",
        "-b", "2048",
        "-ub", "512",
        "-t", "-1",
        "-ngl", "auto",
        "-fa", "auto",
        "-ctk", "f16",
        "-ctv", "f16",
        "--no-mmap",
        "-f", "eval.txt",
        "--chunks", "5",
        "--ppl-stride", "64",
        "--no-warmup",
    ]);
    assert.ok(result.excluded.some((item) => item.label === "Configure/Preset Flags"));
    assert.ok(!flat(result).includes("-hf"));
}

{
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "perplexity",
        flags,
        source: { model: "ppl-model.gguf", flags: {} },
        promptFile: "wiki.test.raw",
        pplCleanRun: true,
        pplContextSize: 4096,
        pplBatchSize: 2048,
        pplUbatchSize: 512,
        pplThreads: -1,
        pplGpuLayers: "auto",
        pplFlashAttention: "auto",
        pplCacheTypeK: "f16",
        pplCacheTypeV: "f16",
        pplMmap: false,
        chunks: 5,
        pplStride: 0,
        warmup: false,
    });

    assert.equal(result.error, null);
    assert.deepEqual(flat(result), ["-m", "models/ppl-model.gguf", "-f", "wiki.test.raw"]);
    assert.ok(result.excluded.some((item) => item.label === "Perplexity Controls"));
}

{
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "perplexity",
        flags,
        source: { model: "ppl-model.gguf", flags: {} },
        promptFile: "eval.txt",
        pplMmap: true,
    });

    assert.equal(result.error, null);
    assert.ok(!flat(result).includes("--no-mmap"));
}

{
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "perplexity",
        flags,
        source: { model: "ppl-model.gguf", flags: {} },
    });

    assert.match(result.error, /prompt\/data file/);
}

{
    const result = adapter.buildBenchmarkArgs({
        benchmarkType: "perplexity",
        flags,
        source: { model: "ppl-model.gguf", flags: {} },
        promptFile: "eval.txt",
        pplCleanRun: true,
    });

    assert.equal(result.error, null);
    assert.deepEqual(flat(result), ["-m", "models/ppl-model.gguf", "-f", "eval.txt"]);
}

{
    function element(value = "") {
        return {
            value,
            checked: false,
            type: "text",
            className: "",
            textContent: "",
            classList: { toggle: () => {}, add: () => {}, remove: () => {} },
            appendChild: () => {},
        };
    }

    const elements = {
        "benchmark-ppl-preset": element("clean"),
        "benchmark-ppl-ctx": element("4096"),
        "benchmark-ppl-batch": element("2048"),
        "benchmark-ppl-ubatch": element("512"),
        "benchmark-ppl-threads": element("-1"),
        "benchmark-ppl-gpu-layers": element("auto"),
        "benchmark-ppl-flash-attn": element("auto"),
        "benchmark-ppl-cache-k": element("f16"),
        "benchmark-ppl-cache-v": element("f16"),
        "benchmark-ppl-mmap": { ...element(""), type: "checkbox", checked: false },
        "benchmark-chunks": element("5"),
        "benchmark-ppl-stride": element("0"),
        "benchmark-warmup": { ...element(""), type: "checkbox", checked: false },
    };
    context.document.getElementById = (id) => elements[id] || null;

    assert.equal(adapter.applyPerplexityPreset("llamacpp"), true);
    assert.equal(elements["benchmark-ppl-preset"].value, "llamacpp");
    assert.equal(elements["benchmark-ppl-ctx"].value, "512");
    assert.equal(elements["benchmark-chunks"].value, "-1");
    assert.equal(elements["benchmark-ppl-batch"].value, "2048");
    assert.equal(elements["benchmark-ppl-ubatch"].value, "512");
    assert.equal(elements["benchmark-ppl-threads"].value, "-1");
    assert.equal(elements["benchmark-ppl-gpu-layers"].value, "auto");
    assert.equal(elements["benchmark-ppl-flash-attn"].value, "auto");
    assert.equal(elements["benchmark-ppl-cache-k"].value, "f16");
    assert.equal(elements["benchmark-ppl-cache-v"].value, "f16");
    assert.equal(elements["benchmark-ppl-mmap"].checked, true);
    assert.equal(elements["benchmark-ppl-stride"].value, "0");
    assert.equal(elements["benchmark-warmup"].checked, true);

    assert.equal(adapter.applyPerplexityPreset("gui"), true);
    assert.equal(elements["benchmark-ppl-preset"].value, "gui");
    assert.equal(elements["benchmark-ppl-ctx"].value, "4096");
    assert.equal(elements["benchmark-chunks"].value, "5");
}

console.log("benchmark adapter tests passed");
