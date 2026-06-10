const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const context = {
    window: { LlamaGui: {} },
    console,
};

context.window.window = context.window;
vm.createContext(context);

for (const file of [
    "ui/js/flags/categories.js",
    "ui/js/flags/options.js",
    "ui/js/flags/chat-templates.js",
    "ui/js/flags/definitions.js",
    "ui/js/flags/helpers.js",
    "ui/js/flag-core.js",
]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    vm.runInContext(source, context, { filename: file });
}

vm.runInContext(`
    const flagCore = window.LlamaGui.flagCore;
    flagCore.configure({
        getDefaultFlagValues: getDefaultValues,
        getFlags: () => FLAGS,
        normalizeMultiEnumValue: (value) => Array.isArray(value) ? value : [],
        shouldOmitSpeculativeFlag,
    });
    flagCore.setCurrentToolValue("llama-server");
    flagCore.replaceFlagValues(getDefaultValues());
`, context);

function flatLaunchArgs() {
    return vm.runInContext("window.LlamaGui.flagCore.getLaunchArgs().args.flat()", context);
}

{
    const args = flatLaunchArgs();
    for (const flag of [
        "--dry-base",
        "--dry-allowed-length",
        "--dynatemp-exp",
        "--xtc-probability",
        "--xtc-threshold",
        "--mirostat",
    ]) {
        assert.ok(!args.includes(flag), `default launch args should omit ${flag}`);
    }
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.setMultipleFlagValues({
            xtc_probability: 0,
            xtc_threshold: 1.0,
            mirostat: "0",
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(!args.includes("--xtc-probability"), "disabled XTC probability should be omitted");
    assert.ok(!args.includes("--xtc-threshold"), "disabled XTC threshold should be omitted");
    assert.ok(!args.includes("--mirostat"), "disabled Mirostat should be omitted");
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.setMultipleFlagValues({
            dry_multiplier: 0.8,
            dynatemp_range: 0.5,
            xtc_probability: 0.1,
            mirostat: "2",
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--dry-multiplier") && args.includes("0.8"));
    assert.ok(args.includes("--dynatemp-range") && args.includes("0.5"));
    assert.ok(args.includes("--xtc-probability") && args.includes("0.1"));
    assert.ok(args.includes("--mirostat") && args.includes("2"));
}

console.log("launch args unit tests passed");
