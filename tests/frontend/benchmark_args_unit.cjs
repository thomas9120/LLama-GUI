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
        source: { model: "", flags: { hf_repo: "owner/model-GGUF:Q4_K_M", mmap: false } },
        promptFile: "eval.txt",
        chunks: 2,
        pplStride: 64,
        warmup: false,
    });

    assert.equal(result.error, null);
    assert.deepEqual(flat(result), [
        "--no-mmap",
        "-hf", "owner/model-GGUF:Q4_K_M",
        "-f", "eval.txt",
        "--chunks", "2",
        "--ppl-stride", "64",
        "--no-warmup",
    ]);
}

console.log("benchmark adapter tests passed");
