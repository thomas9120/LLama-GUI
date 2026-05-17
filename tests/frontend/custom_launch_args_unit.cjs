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
assertTokens('--empty ""', ["--empty", ""]);

assert.match(parse("--flag 'unterminated").error, /unmatched single quote/);
assert.match(parse('--flag "unterminated').error, /unmatched double quote/);
assert.match(parse("--flag \\").error, /unfinished escape/);

console.log("custom launch args parser tests passed");
