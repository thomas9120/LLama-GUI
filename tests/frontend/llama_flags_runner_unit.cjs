const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "llama_flags_supported_unit.cjs"), "utf8");
const both = ["/pin/llama-server", "/pin/llama-cli"];
const flags = [
    { id: "feature", flag: "--feature", false_flag: "--no-feature", tool: "both" },
    { id: "fork", flag: "--fork-only", tool: "both", fork_only: true },
];
const removedFlags = [
    { id: "feature", flag: "--feature", false_flag: "--no-feature", tool: "both" },
    { id: "legacy", flag: "--legacy", false_flag: "--no-legacy", tool: "both", removed_in: "b10875" },
];

function run({ env = {}, files = [], config, help, version, flagDefs = flags, required = false } = {}) {
    const calls = [];
    const messages = [];
    let exitCode = 0;
    let failure;
    const exit = {};
    const fakeFs = {
        existsSync: file => files.includes(file) || (file === "/repo/config.json" && config !== undefined),
        readFileSync: file => file === "/repo/config.json" ? JSON.stringify(config) : "",
    };
    const spawnSync = (file, args, options) => {
        const argv = Array.from(args);
        assert.ok(options.timeout > 0 && options.timeout <= 60000, "a stalled binary must not hang CI");
        if (argv[0] === "--version") {
            return version || { status: 0, stdout: "" };
        }
        assert.deepEqual(argv, ["--help"]);
        calls.push(file);
        return help || { status: 0, stdout: "--feature, --no-feature\n" };
    };
    try {
        vm.runInNewContext(source, {
            __dirname: "/repo/tests/frontend",
            process: {
                env, platform: "linux", argv: required ? ["--require-binaries"] : [],
                exit(code) { exitCode = code; throw exit; },
            },
            console: Object.fromEntries(["log", "warn", "error"].map(method => [method, text => messages.push(text)])),
            require(name) {
                if (name === "./script_order.cjs") return {
                    getPackageScripts(prefix) {
                        assert.equal(prefix, "js/flags");
                        return [{ uiPath: "fixture-flags.js", source: `const FLAGS = ${JSON.stringify(flagDefs)};` }];
                    },
                };
                if (name === "node:fs") return fakeFs;
                if (name === "node:path") return path.posix;
                if (name === "node:child_process") return { spawnSync };
                return require(name);
            },
        });
    } catch (error) {
        if (error !== exit) { failure = error; exitCode = 1; }
    }
    return { exitCode, failure, calls, output: messages.join("\n") };
}

const pinned = { env: { LLAMA_GUI_LLAMA_BIN_DIR: "/pin" }, files: both };
const passing = run(pinned);
assert.equal(passing.exitCode, 0);
assert.deepEqual(passing.calls, both, "both tools must be checked");
assert.match(passing.output, /skipped 1 fork-only/);

const optional = run();
assert.equal(optional.exitCode, 0);
assert.match(optional.output, /check skipped/);
assert.match(run({ required: true }).failure.message, /need LLAMA_GUI_LLAMA_BIN_DIR/);
for (const files of [[], [both[0]], [both[1]]]) {
    const missing = run({ ...pinned, files });
    assert.equal(missing.exitCode, 1, "explicit builds require both binaries");
    assert.match(missing.failure.message, /executable missing/);
}
const noFallback = run({
    env: { LLAMA_GUI_LLAMA_BIN_DIR: "/missing", PATH: "/pin" },
    files: [...both, "/repo/llama/bin/llama-server", "/repo/llama/bin/llama-cli"],
});
assert.equal(noFallback.exitCode, 1);
assert.deepEqual(noFallback.calls, [], "an invalid explicit pin cannot use PATH or the installed build");

for (const help of [{ status: 1, stderr: "broken library" }, { status: null, error: new Error("timed out") }]) {
    assert.equal(run({ ...pinned, help }).exitCode, 1);
}
const missingNegation = run({ ...pinned, help: { status: 0, stdout: "--feature\n" } });
assert.equal(missingNegation.exitCode, 1);
assert.match(missingNegation.output, /--no-feature/);

const custom = ["/repo/llama/custom/bin/llama-server", "/repo/llama/custom/bin/llama-cli"];
const selected = run({ config: { backend: "custom" }, files: [...custom, ...both], env: { PATH: "/pin" } });
assert.equal(selected.exitCode, 0);
assert.deepEqual(selected.calls, custom);
const custom02 = ["/repo/llama/custom-02/bin/llama-server", "/repo/llama/custom-02/bin/llama-cli"];
const selected02 = run({ config: { backend: "custom-02" }, files: [...custom02, ...custom, ...both], env: { PATH: "/pin" } });
assert.equal(selected02.exitCode, 0);
assert.deepEqual(selected02.calls, custom02, "the second slot must take precedence over the first and PATH");
assert.equal(run({ files: both, env: { LLAMA_CPP_BIN_DIR: "/pin" } }).exitCode, 0);

// removed_in exemption: builds at or above the removal tag may lack the flag;
// older builds must still advertise it; unparseable versions stay strict.
const removedPinned = { env: { LLAMA_GUI_LLAMA_BIN_DIR: "/pin" }, files: both, flagDefs: removedFlags };
const newBuild = run({
    ...removedPinned,
    version: { status: 0, stdout: "version: 0.4.0-dev (build 10917, commit 8ea290247)\n" },
});
assert.equal(newBuild.exitCode, 0);
assert.match(newBuild.output, /exempted 4 option\(s\) removed upstream/);
assert.match(newBuild.output, /--legacy/);

const oldBuild = run({
    ...removedPinned,
    version: { status: 0, stdout: "version: 0.4.0-dev (build 10826, commit abc1234)\n" },
});
assert.equal(oldBuild.exitCode, 1, "builds below the removal tag must still advertise removed_in flags");
assert.match(oldBuild.output, /--no-legacy/);

const unknownBuild = run({ ...removedPinned, version: { status: 0, stdout: "custom fork build\n" } });
assert.equal(unknownBuild.exitCode, 1, "an unparseable binary version must keep the strict check");

console.log("llama flag runner selection, strict failures and compatibility checks passed");
