const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const FLAG_SOURCES = [
    path.join(ROOT, "ui", "js", "flags", "options.js"),
    path.join(ROOT, "ui", "js", "flags", "chat-templates.js"),
    path.join(ROOT, "ui", "js", "flags", "definitions.js"),
];

function loadFlags() {
    const context = { console };
    vm.createContext(context);
    const source = FLAG_SOURCES.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    vm.runInContext(`${source}\nthis.FLAGS = FLAGS;`, context, {
        filename: "ui/js/flags/definitions.js",
    });
    assert.ok(Array.isArray(context.FLAGS), "expected FLAGS to load as an array");
    return context.FLAGS;
}

function pathEntries() {
    const raw = process.env.PATH || process.env.Path || "";
    return raw.split(path.delimiter).filter(Boolean);
}

function candidateExecutables(toolName) {
    const exeName = process.platform === "win32" ? `${toolName}.exe` : toolName;
    const dirs = [
        process.env.LLAMA_GUI_LLAMA_BIN_DIR,
        process.env.LLAMA_CPP_BIN_DIR,
        path.join(ROOT, "llama", "bin"),
        path.join(ROOT, "llama"),
        ...pathEntries(),
    ].filter(Boolean);

    const seen = new Set();
    const candidates = [];
    for (const dir of dirs) {
        const candidate = path.resolve(dir, exeName);
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
    }
    return candidates;
}

function findExecutable(toolName) {
    for (const candidate of candidateExecutables(toolName)) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function runHelp(executable) {
    const result = spawnSync(executable, ["--help"], {
        cwd: ROOT,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(
        result.status,
        0,
        `expected "${executable} --help" to exit successfully\n${result.stderr || result.stdout || ""}`
    );
    return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function stripAnsi(value) {
    return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function parseAdvertisedOptions(helpText) {
    const options = new Set();
    const text = stripAnsi(helpText);
    const pattern = /(^|[\s,[(])(-{1,2}[A-Za-z][A-Za-z0-9_-]*)(?=$|[\s,\])<=>])/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        options.add(match[2]);
    }
    return options;
}

function expectedTools(flag) {
    if (flag.tool === "both") return ["server", "cli"];
    return [flag.tool];
}

function collectUnsupportedFlags(flags, advertisedByTool) {
    const unsupported = [];
    for (const flag of flags) {
        for (const option of [flag.flag, flag.false_flag].filter(Boolean)) {
            for (const tool of expectedTools(flag)) {
                const advertised = advertisedByTool[tool];
                if (!advertised) continue;
                if (!advertised.has(option)) {
                    unsupported.push({
                        tool,
                        id: flag.id,
                        option,
                        label: flag.label,
                    });
                }
            }
        }
    }
    return unsupported;
}

const flags = loadFlags();
const executables = {
    server: findExecutable("llama-server"),
    cli: findExecutable("llama-cli"),
};

const advertisedByTool = {};
for (const [tool, executable] of Object.entries(executables)) {
    if (!executable) continue;
    advertisedByTool[tool] = parseAdvertisedOptions(runHelp(executable));
}

if (!advertisedByTool.server && !advertisedByTool.cli) {
    console.log(
        "llama flag compatibility check skipped: no llama-server or llama-cli executable found. " +
        "Set LLAMA_GUI_LLAMA_BIN_DIR or LLAMA_CPP_BIN_DIR to check a specific build."
    );
    process.exit(0);
}

const unsupported = collectUnsupportedFlags(flags, advertisedByTool);
if (unsupported.length > 0) {
    console.error("Unsupported llama.cpp flags exposed by the GUI:");
    for (const item of unsupported) {
        console.error(`- ${item.tool}: ${item.option} (${item.id}, ${item.label || "unlabeled"})`);
    }
    process.exit(1);
}

const checkedTools = Object.entries(executables)
    .filter(([tool]) => advertisedByTool[tool])
    .map(([tool, executable]) => `${tool}=${executable}`)
    .join(", ");

console.log(`llama flag compatibility check passed for ${flags.length} GUI flags against ${checkedTools}`);
