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

{
    const templateOptions = vm.runInContext("CHAT_TEMPLATE_PRESET_OPTIONS.map((option) => option.value)", context);
    assert.ok(!templateOptions.includes("__koboldcpp_automatic__"));
}

function flatLaunchArgs() {
    return vm.runInContext("window.LlamaGui.flagCore.getLaunchArgs().args.flat()", context);
}

function launchResult() {
    return vm.runInContext("window.LlamaGui.flagCore.getLaunchArgs()", context);
}

{
    const args = flatLaunchArgs();
    for (const flag of [
        "--dry-base",
        "--dry-allowed-length",
        "--dynatemp-exp",
        "--xtc-probability",
        "--xtc-threshold",
        "--image-min-tokens",
        "--image-max-tokens",
        "--mirostat",
        "--mirostat-lr",
        "--mirostat-ent",
        "--mtmd-batch-max-tokens",
        "--reasoning-format",
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
            mirostat_lr: 0.1,
            mirostat_ent: 5,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(!args.includes("--xtc-probability"), "disabled XTC probability should be omitted");
    assert.ok(!args.includes("--xtc-threshold"), "disabled XTC threshold should be omitted");
    assert.ok(!args.includes("--mirostat"), "disabled Mirostat should be omitted");
    assert.ok(!args.includes("--mirostat-lr"), "Mirostat LR should be omitted when Mirostat is disabled");
    assert.ok(!args.includes("--mirostat-ent"), "Mirostat entropy should be omitted when Mirostat is disabled");
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setFlagValue("custom_args", "--temp 0.5");
    `, context);
    assert.deepEqual(
        Array.from(launchResult().warnings),
        ["Custom launch args duplicate UI-managed flags: --temp"]
    );

    vm.runInContext(`
        window.LlamaGui.flagCore.setFlagValue("custom_args", "--temp=0.5");
    `, context);
    assert.deepEqual(
        Array.from(launchResult().warnings),
        ["Custom launch args duplicate UI-managed flags: --temp"]
    );
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            mmproj_url: "https://example.com/mmproj.gguf",
            mtmd_batch_max_tokens: 2048,
            op_offload: false,
            sampler_seq: "edskypmxt",
            reasoning_format: "none",
            reasoning_budget_message: "Reasoning budget exhausted.",
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--mmproj-url") && args.includes("https://example.com/mmproj.gguf"));
    assert.ok(args.includes("--mtmd-batch-max-tokens") && args.includes("2048"));
    assert.ok(args.includes("--no-op-offload"));
    assert.ok(args.includes("--sampler-seq") && args.includes("edskypmxt"));
    assert.ok(args.includes("--reasoning-format") && args.includes("none"));
    assert.ok(args.includes("--reasoning-budget-message") && args.includes("Reasoning budget exhausted."));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.setMultipleFlagValues({
            dry_multiplier: 0.8,
            dynatemp_range: 0.5,
            xtc_probability: 0.1,
            mirostat: "2",
            mirostat_lr: 0.2,
            mirostat_ent: 6,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--dry-multiplier") && args.includes("0.8"));
    assert.ok(args.includes("--dynatemp-range") && args.includes("0.5"));
    assert.ok(args.includes("--xtc-probability") && args.includes("0.1"));
    assert.ok(args.includes("--mirostat") && args.includes("2"));
    assert.ok(args.includes("--mirostat-lr") && args.includes("0.2"));
    assert.ok(args.includes("--mirostat-ent") && args.includes("6"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            image_min_tokens: 256,
            image_max_tokens: 1024,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--image-min-tokens") && args.includes("256"));
    assert.ok(args.includes("--image-max-tokens") && args.includes("1024"));
    assert.ok(!args.includes("--image-min-token"), "singular image min token flag should not be emitted");
    assert.ok(!args.includes("--image-max-token"), "singular image max token flag should not be emitted");
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
    `, context);
    let args = flatLaunchArgs();
    assert.ok(!args.includes("--reasoning-preserve"), "preserve reasoning default should be omitted");

    vm.runInContext(`
        window.LlamaGui.flagCore.setFlagValue("reasoning_preserve", true);
    `, context);
    args = flatLaunchArgs();
    assert.ok(args.includes("--reasoning-preserve"), "enabled preserve reasoning should emit upstream flag");
    assert.ok(!args.includes("--chat-template-kwargs"), "preserve reasoning should not use legacy template kwargs");
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            spec_type: "draft-eagle3",
            draft_max: 8,
            gpu_layers_draft: "auto",
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--spec-type") && args.includes("draft-eagle3"));
    assert.ok(args.includes("--spec-draft-n-max") && args.includes("8"));
    assert.ok(args.includes("-ngld") && args.includes("auto"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            spec_type: "draft-dflash",
            draft_max: 15,
            flash_attn: "on",
            jinja: true,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--spec-type") && args.includes("draft-dflash"));
    assert.ok(args.includes("--spec-draft-n-max") && args.includes("15"));
    assert.ok(args.includes("-fa") && args.includes("on"));
    assert.ok(args.includes("--jinja"));
}

console.log("launch args unit tests passed");
