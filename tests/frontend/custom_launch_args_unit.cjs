const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "flag-core.js"), "utf8");
const context = {
    window: {},
};

vm.createContext(context);
vm.runInContext(source, context, { filename: "flag-core.js" });

const parse = context.window.LlamaGui.flagCore.parseCustomLaunchArgs;

function assertTokens(raw, expected) {
    const result = parse(raw);
    assert.equal(result.error, undefined);
    assert.deepEqual(Array.from(result.tokens), expected);
}

assertTokens("--threads 8 --flash-attn --parallel 4", ["--threads", "8", "--flash-attn", "--parallel", "4"]);
assertTokens("--threads 8\n--flash-attn\n--parallel 4", ["--threads", "8", "--flash-attn", "--parallel", "4"]);
assertTokens("--chat-template-kwargs '{\"preserve_thinking\":true}'", ["--chat-template-kwargs", "{\"preserve_thinking\":true}"]);
assertTokens('--log-prefix "my local test"', ["--log-prefix", "my local test"]);
assertTokens('--label "say \\"hello\\""', ["--label", 'say "hello"']);
assertTokens(String.raw`--label "say \"hello\" and \\bye"`, ["--label", String.raw`say "hello" and \bye`]);
assertTokens('--empty ""', ["--empty", ""]);
assertTokens(String.raw`--log-file C:\temp\llama.log`, ["--log-file", String.raw`C:\temp\llama.log`]);
assertTokens(String.raw`--log-file "C:\Users\pegas\My Models\model.gguf"`, ["--log-file", String.raw`C:\Users\pegas\My Models\model.gguf`]);
assertTokens(String.raw`--log-prefix my\ local\ test`, ["--log-prefix", "my local test"]);
assertTokens(String.raw`--label say\"hello\"`, ["--label", 'say"hello"']);
assertTokens("--path C:\\temp\\", ["--path", "C:\\temp\\"]);

const state = context.window.LlamaGui.flagCore;
state.replaceFlagValues({ tools: ["web_search"], temperature: 0.7 });
const snapshot = state.getFlagValues();
snapshot.tools.push("mutated");
snapshot.temperature = 1.5;
assert.equal(
    JSON.stringify(state.getFlagValues()),
    JSON.stringify({ tools: ["web_search"], temperature: 0.7 })
);

assert.match(parse("--flag 'unterminated").error, /unmatched single quote/);
assert.match(parse('--flag "unterminated').error, /unmatched double quote/);
assert.match(parse('--flag "unterminated\\').error, /unfinished escape/);

const parseEnv = context.window.LlamaGui.flagCore.parseRuntimeEnvVars;

function assertEnvVars(raw, expected) {
    const result = parseEnv(raw);
    assert.equal(result.error, undefined, `expected no error for: ${raw}`);
    assert.deepEqual({ ...result.vars }, expected);
}

assertEnvVars("CUDA_VISIBLE_DEVICES=0", { CUDA_VISIBLE_DEVICES: "0" });
assertEnvVars("LLAMA_LOG_PREFIX=1\nGGML_CUDA_NO_PEER_COPY=1", {
    LLAMA_LOG_PREFIX: "1",
    GGML_CUDA_NO_PEER_COPY: "1",
});
assertEnvVars("# comment\nKEY=value\n\nOTHER=another", { KEY: "value", OTHER: "another" });
assertEnvVars("VALUE_WITH_EQUALS=A=B=C", { VALUE_WITH_EQUALS: "A=B=C" });
assertEnvVars("EMPTY_KEY=", { EMPTY_KEY: "" });
assertEnvVars("  SPACED  =  value  ", { SPACED: "value" });
assertEnvVars("UNDER_SCORE123=ok", { UNDER_SCORE123: "ok" });
assertEnvVars("_LEADING_UNDER=ok", { _LEADING_UNDER: "ok" });
assertEnvVars("MY_PROMPT=hello world", { MY_PROMPT: "hello world" });
assertEnvVars("CRLF_TESTING=ok\r\nSECOND=1", { CRLF_TESTING: "ok", SECOND: "1" });

assert.match(parseEnv("BAD-KEY=value").error, /invalid key "BAD-KEY"/);
assert.match(parseEnv("1KEY=value").error, /invalid key "1KEY"/);
assert.match(parseEnv("NO_EQUALS").error, /missing "="/);
assert.match(parseEnv("=value").error, /missing "="/);
assert.match(parseEnv("DUP=1\nDUP=2").error, /duplicate key "DUP"/);

const core = context.window.LlamaGui.flagCore;
core.replaceFlagValues({ runtime_env_vars: "CUDA_VISIBLE_DEVICES=0\nLLAMA_LOG_PREFIX=1" });
const launchResult = core.getLaunchArgs();
assert.deepEqual({ ...launchResult.envVars }, { CUDA_VISIBLE_DEVICES: "0", LLAMA_LOG_PREFIX: "1" });
assert.equal(launchResult.error, null);

core.replaceFlagValues({ runtime_env_vars: "BAD-KEY=value" });
const errResult = core.getLaunchArgs();
assert.match(errResult.error, /invalid key/);

core.replaceFlagValues({ runtime_env_vars: "" });
const emptyResult = core.getLaunchArgs();
assert.deepEqual({ ...emptyResult.envVars }, {});

console.log("custom launch args parser tests passed");
