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
    flagCore.setModelDirInfo({
        models_dir: "models",
        models_arg_root: "models",
        models_dir_is_default: true,
        models_dir_available: true,
        models_dir_error: "",
    });
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
    assert.ok(!flatLaunchArgs().includes("--spec-draft-adaptive"));
    vm.runInContext(
        'window.LlamaGui.flagCore.setFlagValue("spec_draft_adaptive", true)',
        context
    );
    assert.ok(flatLaunchArgs().includes("--spec-draft-adaptive"));
    vm.runInContext("window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues())", context);
}

{
    vm.runInContext(
        'window.LlamaGui.flagCore.setFlagValue("mmproj_device", "Vulkan0")',
        context
    );
    const args = flatLaunchArgs();
    const flagIndex = args.indexOf("--mmproj-device");
    assert.equal(args[flagIndex + 1], "Vulkan0");
    vm.runInContext("window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues())", context);
}

{
    const recognizedModelArgs = [
        [["-m", "models/local.gguf"]],
        [["--model", "models/local.gguf"]],
        [["-hf", "owner/repo"]],
        [["--hf-repo=owner/repo"]],
        [["-mu", "https://example.test/model.gguf"]],
        [["--model-url", "https://example.test/model.gguf"]],
        ["--model-url=https://example.test/model.gguf?signature=a=b"],
    ];
    for (const args of recognizedModelArgs) {
        context.modelArgs = args;
        assert.equal(
            vm.runInContext("window.LlamaGui.flagCore.hasLaunchModelArg(modelArgs)", context),
            true,
            `expected a recognized model source in ${JSON.stringify(args)}`
        );
    }
    context.modelArgs = ["https://example.test/model.gguf", "--model-url-draft"];
    assert.equal(
        vm.runInContext("window.LlamaGui.flagCore.hasLaunchModelArg(modelArgs)", context),
        false,
        "model URLs and similarly prefixed flags must not count without a recognized model-source flag"
    );
    delete context.modelArgs;
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.setFlagValue("api_key", "primary-secret,backup-secret");
    `, context);
    const args = flatLaunchArgs();
    const apiKeyIndex = args.indexOf("--api-key");
    assert.notEqual(apiKeyIndex, -1, "configured API key should be emitted for llama-server");
    assert.equal(args[apiKeyIndex + 1], "primary-secret,backup-secret");

    const redacted = vm.runInContext(
        "window.LlamaGui.flagCore.redactSensitiveTokens(['--api-key', 'primary-secret', '--api-key=backup-secret'])",
        context
    );
    assert.deepEqual(Array.from(redacted), ["--api-key", "<redacted>", "--api-key=<redacted>"]);
    vm.runInContext("window.LlamaGui.flagCore.setFlagValue('api_key', undefined)", context);
}

{
    const args = flatLaunchArgs();
    assert.equal(
        vm.runInContext("window.LlamaGui.flagCore.getFlagValues().mmap", context),
        false,
        "deprecated mmap control should be disabled by default"
    );
    assert.ok(args.includes("--load-mode") && args.includes("mmap"), "default launch args should use mmap load mode");
    assert.ok(!args.includes("--mmap") && !args.includes("--no-mmap"), "default launch args should not use deprecated mmap flags");
    assert.ok(args.includes("--jinja"), "default launch args should reflect llama.cpp's enabled Jinja default");
    assert.ok(!args.includes("--no-jinja"), "default launch args should not disable Jinja");
    const timeoutIndex = args.indexOf("-to");
    assert.notEqual(timeoutIndex, -1, "default launch args should include server timeout");
    assert.equal(args[timeoutIndex + 1], "3600");
    for (const flag of [
        "--dry-base",
        "--dry-allowed-length",
        "--dry-penalty-last-n",
        "--dry-sequence-breaker",
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
        "--tensor-read-lazy",
    ]) {
        assert.ok(!args.includes(flag), `default launch args should omit ${flag}`);
    }
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setFlagValue("fit", "off");
    `, context);
    let args = flatLaunchArgs();
    const fitIndex = args.indexOf("-fit");
    assert.notEqual(fitIndex, -1);
    assert.equal(args[fitIndex + 1], "off");
    assert.ok(!args.includes("-fitt"), "disabled auto-fit should omit its target margin");
    assert.ok(!args.includes("-fitc"), "disabled auto-fit should omit its context floor");

    vm.runInContext(`window.LlamaGui.flagCore.setFlagValue("fit", "on")`, context);
    args = flatLaunchArgs();
    assert.ok(args.includes("-fitt"), "re-enabled auto-fit should restore its target margin");
    assert.ok(args.includes("-fitc"), "re-enabled auto-fit should restore its context floor");
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            dry_multiplier: 0.8,
            dry_penalty_last_n: 2048,
            dry_sequence_breakers: ["—", "##"],
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--dry-penalty-last-n") && args.includes("2048"));
    assert.equal(args.filter(value => value === "--dry-sequence-breaker").length, 2);
    assert.ok(args.includes("—") && args.includes("##"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setFlagValue("dry_sequence_breakers", ["none"]);
    `, context);
    let args = flatLaunchArgs();
    assert.ok(args.includes("--dry-sequence-breaker") && args.includes("none"));

    vm.runInContext(`window.LlamaGui.flagCore.setFlagValue("dry_sequence_breakers", undefined)`, context);
    args = flatLaunchArgs();
    assert.ok(!args.includes("--dry-sequence-breaker"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setFlagValue("load_mode", "dio");
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--load-mode") && args.includes("dio"));
    assert.ok(!args.includes("--mmap") && !args.includes("--no-mmap"));
    assert.ok(!args.includes("--mlock") && !args.includes("-dio"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setFlagValue("tensor_read_lazy", "on");
    `, context);
    let args = flatLaunchArgs();
    let flagIndex = args.indexOf("--tensor-read-lazy");
    assert.notEqual(flagIndex, -1);
    assert.equal(args[flagIndex + 1], "on");

    vm.runInContext(`window.LlamaGui.flagCore.setFlagValue("tensor_read_lazy", "off")`, context);
    args = flatLaunchArgs();
    flagIndex = args.indexOf("--tensor-read-lazy");
    assert.notEqual(flagIndex, -1);
    assert.equal(args[flagIndex + 1], "off");
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        const external = ["first"];
        window.LlamaGui.flagCore.setFlagValue("dry_sequence_breakers", external);
        external.push("mutated-outside");
        this.__isolatedBreakers = window.LlamaGui.flagCore.getFlagValues().dry_sequence_breakers;
    `, context);
    const isolated = vm.runInContext("Array.from(this.__isolatedBreakers)", context);
    assert.deepEqual(Array.from(isolated), ["first"]);
}

{
    vm.runInContext(`
        const firstDefaults = getDefaultValues();
        firstDefaults.dry_sequence_breakers.push("mutated-default");
        this.__freshDefaultBreakers = getDefaultValues().dry_sequence_breakers;
    `, context);
    const freshDefaults = vm.runInContext("Array.from(this.__freshDefaultBreakers)", context);
    assert.deepEqual(Array.from(freshDefaults), []);
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
    // Legacy binaries (pre-b10434 installs, custom backends, unknown tags)
    // keep the single merged --chat-template-kwargs object.
    vm.runInContext(`
        window.LlamaGui.flagCore.setBinaryTag("b10375");
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
    `, context);
    let args = flatLaunchArgs();
    assert.ok(!args.includes("--chat-template-kwargs"), "Auto effort should leave the template default unchanged");
    assert.ok(!args.includes("--reasoning-effort"), "Auto effort must not emit the native flag");

    vm.runInContext(`
        window.LlamaGui.flagCore.setFlagValue("preserve_thinking", true);
    `, context);
    args = flatLaunchArgs();
    assert.equal(args.filter((arg) => arg === "--chat-template-kwargs").length, 1);
    assert.ok(args.includes('{"preserve_thinking":true}'));

    vm.runInContext(`
        window.LlamaGui.flagCore.setMultipleFlagValues({
            chat_template_reasoning_effort: "high",
            preserve_thinking: false,
        });
    `, context);
    args = flatLaunchArgs();
    assert.equal(args.filter((arg) => arg === "--chat-template-kwargs").length, 1);
    assert.ok(args.includes('{"reasoning_effort":"high"}'));

    vm.runInContext(`
        window.LlamaGui.flagCore.setMultipleFlagValues({
            chat_template_reasoning_effort: "xhigh",
            preserve_thinking: true,
        });
    `, context);
    args = flatLaunchArgs();
    assert.equal(args.filter((arg) => arg === "--chat-template-kwargs").length, 1);
    assert.ok(args.includes('{"preserve_thinking":true,"reasoning_effort":"xhigh"}'));

    // Non-release tags stay on the legacy path too.
    vm.runInContext(`
        window.LlamaGui.flagCore.setBinaryTag("custom");
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setFlagValue("chat_template_reasoning_effort", "medium");
    `, context);
    args = flatLaunchArgs();
    assert.ok(args.includes('{"reasoning_effort":"medium"}'), "custom backend keeps the kwargs fallback");
    assert.ok(!args.includes("--reasoning-effort"));
}

{
    // llama.cpp b10434+ gets the native --reasoning-effort launch flag, and
    // Preserve Thinking returns to its own --chat-template-kwargs object.
    vm.runInContext(`
        window.LlamaGui.flagCore.setBinaryTag("b10502");
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
    `, context);
    let args = flatLaunchArgs();
    assert.ok(!args.includes("--reasoning-effort"), "Auto effort omits the native flag");
    assert.ok(!args.includes("--chat-template-kwargs"), "Auto effort emits no template kwargs");

    vm.runInContext(`
        window.LlamaGui.flagCore.setFlagValue("chat_template_reasoning_effort", "high");
    `, context);
    args = flatLaunchArgs();
    assert.ok(args.includes("--reasoning-effort"), "native flag emitted on current builds");
    assert.ok(args.includes("high"));
    assert.ok(!args.includes("--chat-template-kwargs"));

    vm.runInContext(`
        window.LlamaGui.flagCore.setMultipleFlagValues({
            chat_template_reasoning_effort: "xhigh",
            preserve_thinking: true,
        });
    `, context);
    args = flatLaunchArgs();
    assert.ok(args.includes("--reasoning-effort") && args.includes("xhigh"));
    assert.equal(args.filter((arg) => arg === "--chat-template-kwargs").length, 1);
    assert.ok(args.includes('{"preserve_thinking":true}'), "preserve thinking keeps its own kwargs object");

    vm.runInContext(`
        window.LlamaGui.flagCore.setMultipleFlagValues({
            chat_template_reasoning_effort: "auto",
            preserve_thinking: true,
        });
    `, context);
    args = flatLaunchArgs();
    assert.ok(!args.includes("--reasoning-effort"));
    assert.equal(args.filter((arg) => arg === "--chat-template-kwargs").length, 1);
    assert.ok(args.includes('{"preserve_thinking":true}'));

    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
    `, context);
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
    assert.ok(args.includes("--spec-draft-ngl") && args.includes("auto"));
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

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            spec_type: "draft-dspark",
            draft_max: 7,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--spec-type") && args.includes("draft-dspark"));
    assert.ok(args.includes("--spec-draft-n-max") && args.includes("7"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            spec_type: "draft-eagle3",
            ngram_mod: true,
            ngram_mod_n_match: 24,
            ngram_mod_n_min: 48,
            ngram_mod_n_max: 64,
            ngram_map_k4v: true,
            ngram_map_k4v_size_n: 12,
            ngram_map_k4v_size_m: 48,
            ngram_map_k4v_min_hits: 1,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.equal(args.filter((arg) => arg === "--spec-type").length, 1);
    assert.ok(
        args.includes("draft-eagle3,ngram-mod,ngram-map-k4v"),
        "draft and ngram methods must share one --spec-type value"
    );
    assert.ok(args.includes("--spec-ngram-mod-n-match") && args.includes("24"));
    assert.ok(args.includes("--spec-ngram-mod-n-min") && args.includes("48"));
    assert.ok(args.includes("--spec-ngram-mod-n-max") && args.includes("64"));
    assert.ok(args.includes("--spec-ngram-map-k4v-size-n") && args.includes("12"));
    assert.ok(args.includes("--spec-ngram-map-k4v-size-m") && args.includes("48"));
    assert.ok(args.includes("--spec-ngram-map-k4v-min-hits") && args.includes("1"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            ngram_mod: true,
            ngram_mod_n_match: 12,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.equal(args.filter((arg) => arg === "--spec-type").length, 1);
    assert.ok(args.includes("ngram-mod"), "ngram-only speculation must emit ngram-mod");
    assert.ok(args.includes("--spec-ngram-mod-n-match") && args.includes("12"));
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            ngram_mod: false,
            ngram_mod_n_match: 12,
            ngram_mod_n_min: 48,
            ngram_mod_n_max: 64,
            ngram_map_k4v: false,
            ngram_map_k4v_size_n: 12,
            ngram_map_k4v_size_m: 48,
            ngram_map_k4v_min_hits: 1,
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(!args.includes("--spec-type"), "disabled ngram-mod must not emit --spec-type");
    for (const flag of [
        "--spec-ngram-mod-n-match",
        "--spec-ngram-mod-n-min",
        "--spec-ngram-mod-n-max",
        "--spec-ngram-map-k4v-size-n",
        "--spec-ngram-map-k4v-size-m",
        "--spec-ngram-map-k4v-min-hits",
    ]) {
        assert.ok(!args.includes(flag), `${flag} must be inert while its ngram mode is disabled`);
    }
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setSelectedModelValue("live-a.gguf");
        window.LlamaGui.flagCore.setFlagValue("temperature", 0.11);
    `, context);
    const pendingBefore = vm.runInContext(`JSON.stringify({
        tool: window.LlamaGui.flagCore.getCurrentTool(),
        model: window.LlamaGui.flagCore.getSelectedModel(),
        flags: window.LlamaGui.flagCore.getFlagValues(),
    })`, context);
    const target = vm.runInContext(`(() => {
        const core = window.LlamaGui.flagCore;
        const flags = core.buildEffectiveFlagValues({
            temperature: 0.42,
            custom_args: "--parallel 2",
        });
        return core.buildLaunchArgs({
            tool: "llama-server",
            model: "target-b.gguf",
            flags,
        });
    })()`, context);
    const targetArgs = Array.from(target.args).flat().map(String);
    assert.ok(targetArgs.includes("models/target-b.gguf"));
    assert.ok(targetArgs.includes("0.42"));
    assert.ok(targetArgs.includes("--parallel") && targetArgs.includes("2"));
    assert.ok(targetArgs.includes("-to") && targetArgs.includes("3600"), "effective target flags should include defaults");
    assert.equal(target.error, null);
    const pendingAfter = vm.runInContext(`JSON.stringify({
        tool: window.LlamaGui.flagCore.getCurrentTool(),
        model: window.LlamaGui.flagCore.getSelectedModel(),
        flags: window.LlamaGui.flagCore.getFlagValues(),
    })`, context);
    assert.equal(pendingAfter, pendingBefore, "explicit target argument generation must not mutate pending state");

    const liveArgs = flatLaunchArgs();
    assert.ok(liveArgs.includes("models/live-a.gguf"));
    assert.ok(liveArgs.includes("0.11"));
    assert.ok(!liveArgs.includes("models/target-b.gguf"));
}

{
    const pendingBefore = vm.runInContext(
        "JSON.stringify(window.LlamaGui.flagCore.getFlagValues())",
        context
    );
    const invalid = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "target-b.gguf",
        flags: { custom_args: "--flag 'unterminated" },
    })`, context);
    assert.match(invalid.error, /unmatched single quote/);
    assert.equal(
        vm.runInContext("JSON.stringify(window.LlamaGui.flagCore.getFlagValues())", context),
        pendingBefore,
        "invalid target args must not mutate pending state"
    );

    const unsupported = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-bench",
        model: "target-b.gguf",
        flags: {},
    })`, context);
    assert.match(unsupported.error, /Unsupported/);
}

{
    const nested = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "vendor/nested.gguf",
        flags: {},
    })`, context);
    assert.equal(nested.error, null);
    const nestedFlat = nested.args.flat().map(String);
    assert.ok(nestedFlat.includes("-m"));
    assert.ok(nestedFlat.includes("models/vendor/nested.gguf"));

    const escaped = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "../secret.gguf",
        flags: {},
    })`, context);
    assert.match(escaped.error, /Invalid model filename/);

    const absolute = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "/tmp/model.gguf",
        flags: {},
    })`, context);
    assert.match(absolute.error, /Invalid model filename/);

    const windowsAbsolute = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "C:/models/model.gguf",
        flags: {},
    })`, context);
    assert.match(windowsAbsolute.error, /Invalid model filename/);

    context.customModelDir = {
        models_dir: String.raw`D:\My Models`,
        models_arg_root: String.raw`D:\My Models`,
        models_dir_is_default: false,
        models_dir_available: true,
        models_dir_error: "",
    };
    vm.runInContext("window.LlamaGui.flagCore.setModelDirInfo(customModelDir)", context);
    const custom = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "vendor/nested.gguf",
        flags: {},
    })`, context);
    assert.ok(custom.args.flat().includes(String.raw`D:\My Models/vendor/nested.gguf`));

    context.customModelDir = {
        ...context.customModelDir,
        models_dir: String.raw`\\server\models`,
        models_arg_root: String.raw`\\server\models`,
    };
    vm.runInContext("window.LlamaGui.flagCore.setModelDirInfo(customModelDir)", context);
    const unc = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "vendor/nested.gguf",
        flags: {},
    })`, context);
    assert.ok(unc.args.flat().includes(String.raw`\\server\models/vendor/nested.gguf`));

    context.unavailableModelDir = {
        models_dir: String.raw`D:\Offline Models`,
        models_arg_root: "",
        models_dir_is_default: false,
        models_dir_available: false,
        models_dir_error: "Configured models folder is offline.",
    };
    vm.runInContext("window.LlamaGui.flagCore.setModelDirInfo(unavailableModelDir)", context);
    const unavailable = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "vendor/nested.gguf",
        flags: {},
    })`, context);
    assert.match(unavailable.error, /offline/);

    vm.runInContext("window.LlamaGui.flagCore.setModelDirInfo(null)", context);
    const unknown = vm.runInContext(`window.LlamaGui.flagCore.buildLaunchArgs({
        tool: "llama-server",
        model: "vendor/nested.gguf",
        flags: {},
    })`, context);
    assert.match(unknown.error, /status is not available/);
    vm.runInContext(`window.LlamaGui.flagCore.setModelDirInfo({
        models_dir: "models",
        models_arg_root: "models",
        models_dir_is_default: true,
        models_dir_available: true,
        models_dir_error: "",
    })`, context);
    delete context.customModelDir;
    delete context.unavailableModelDir;
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setFlagValue("jinja", false);
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--no-jinja"), "disabled Jinja should emit the upstream negated flag");
    assert.ok(!args.includes("--jinja"), "disabled Jinja should not emit the positive flag");
}

{
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setMultipleFlagValues({
            chat_template: "chatml",
            chat_template_custom: "ui/templates/custom.jinja",
        });
    `, context);
    const args = flatLaunchArgs();
    assert.ok(args.includes("--chat-template-file"));
    assert.ok(!args.includes("--chat-template"), "a custom template file must take precedence over a builtin name");
}

// Command preview quoting: the preview is copy-pasteable, so any value holding a
// space (a Windows model path, most often) has to survive the round trip.
{
    const quoteArg = vm.runInContext("window.LlamaGui.flagCore.quoteArg", context);
    assert.equal(quoteArg("plain"), "plain", "an ordinary token must not be quoted");
    assert.equal(quoteArg("C:\\My Models\\qwen.gguf"), '"C:\\My Models\\qwen.gguf"');
    assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""', "embedded quotes must be escaped");
    assert.equal(quoteArg(7), "7", "non-strings must be coerced");
}

{
    // A model-relative subfolder with a space must remain one preview argument.
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.flagCore.setSelectedModelValue("My Models/qwen.gguf");
    `, context);
    const { command } = vm.runInContext("window.LlamaGui.flagCore.updateCommandPreview()", context);
    assert.match(
        command,
        /-m "models\/My Models\/qwen\.gguf"/,
        "a model path containing spaces must be quoted in the copyable command"
    );
    assert.ok(
        !/-m models\/My Models/.test(command),
        "an unquoted path would split into two arguments when pasted"
    );
}

console.log("launch args unit tests passed");

{
    // Regression: --load-mode "Legacy controls" ("") must survive the Configure
    // dropdown, preset save, and preset load. `sel.value || undefined` used to
    // delete the key, so the "mmap" default resurrected on preset load and
    // shouldOmitLegacyLoadFlag silently dropped the saved legacy switches.
    const byId = new Map();
    const makeElement = (tag = "div") => {
        const el = {
            tagName: tag.toUpperCase(),
            children: [],
            className: "",
            value: "",
            textContent: "",
            dataset: {},
            listeners: {},
            appendChild(child) { el.children.push(child); return child; },
            addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
            fire(type) { for (const fn of el.listeners[type] || []) fn(); },
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        };
        Object.defineProperty(el, "id", {
            set(id) { if (id) byId.set(id, el); },
            get() { return ""; },
        });
        return el;
    };
    context.document = {
        createElement: makeElement,
        getElementById: (id) => byId.get(id) || null,
        querySelectorAll: () => [],
    };
    context.localStorage = { getItem: () => null, setItem: () => {} };
    byId.set("flags-container", makeElement());

    for (const file of ["ui/js/config-flags-ui.js", "ui/js/presets.js"]) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
    }

    const loadModeFlag = vm.runInContext(
        "FLAGS.find((flag) => flag.id === 'load_mode')",
        context
    );
    const numaFlag = vm.runInContext("FLAGS.find((flag) => flag.id === 'numa')", context);
    context.window.LlamaGui.configFlagsUi.configure({
        getFlagsByCategory: () => ({ context: { name: "Context", flags: [loadModeFlag, numaFlag] } }),
        getFlags: () => [loadModeFlag, numaFlag],
        refreshQuickLaunchUI: () => {},
    });
    vm.runInContext("window.LlamaGui.configFlagsUi.renderFlags()", context);
    const loadModeSelect = byId.get("flag-load_mode");
    const numaSelect = byId.get("flag-numa");
    assert.ok(loadModeSelect && numaSelect, "renderFlags must create the enum dropdowns");

    // Pick "Legacy controls" and enable the legacy mlock switch, like a real session.
    loadModeSelect.value = "";
    loadModeSelect.fire("change");
    vm.runInContext("window.LlamaGui.flagCore.setFlagValue('mlock', true)", context);
    assert.equal(
        vm.runInContext("window.LlamaGui.flagCore.getFlagValues().load_mode", context),
        "",
        "the Legacy controls option must be stored as a real value, not deleted"
    );

    // Sibling enums with a "" option still treat it as unset (numa has no default).
    numaSelect.value = "";
    numaSelect.fire("change");
    assert.ok(
        !Object.prototype.hasOwnProperty.call(
            vm.runInContext("window.LlamaGui.flagCore.getFlagValues()", context),
            "numa"
        ),
        "empty enum options without a non-empty default must still collapse to unset"
    );

    const saved = vm.runInContext("buildCurrentPresetData()", context);
    assert.equal(saved.flags.load_mode, "", "a saved preset must keep load_mode: \"\"");
    vm.runInContext(`
        window.LlamaGui.flagCore.replaceFlagValues(getDefaultValues());
        window.LlamaGui.presets.applyPresetData(${JSON.stringify(saved)});
    `, context);
    assert.equal(
        vm.runInContext("window.LlamaGui.flagCore.getFlagValues().load_mode", context),
        "",
        "loading the preset must restore Legacy controls, not the mmap default"
    );
    const roundTripArgs = flatLaunchArgs();
    assert.ok(roundTripArgs.includes("--mlock"), "legacy mlock must survive a Legacy-controls preset round-trip");
    assert.ok(!roundTripArgs.includes("--load-mode"), "Legacy controls must not emit --load-mode");

    const legacyNgram = vm.runInContext(`window.LlamaGui.presets.preparePresetLaunchState({
        tool: "llama-server",
        model: "",
        flags: { spec_type: "ngram-mod", ngram_mod_n_match: 12 },
    })`, context);
    assert.equal(legacyNgram.flags.spec_type, "none", "legacy ngram spec_type should migrate to the draft-only field");
    assert.equal(legacyNgram.flags.ngram_mod, true, "legacy ngram spec_type should enable the shared ngram control");
    assert.equal(
        legacyNgram.flags.ngram_mod_n_match,
        12,
        "legacy ngram tuning values should survive preset migration"
    );

    const legacyNgramMap = vm.runInContext(`window.LlamaGui.presets.preparePresetLaunchState({
        tool: "llama-server",
        model: "",
        flags: { spec_type: "ngram-map-k4v", ngram_map_k4v_size_n: 10 },
    })`, context);
    assert.equal(legacyNgramMap.flags.spec_type, "none", "legacy map spec_type should migrate to the draft-only field");
    assert.equal(legacyNgramMap.flags.ngram_map_k4v, true, "legacy map spec_type should enable the shared map control");
    assert.equal(
        legacyNgramMap.flags.ngram_map_k4v_size_n,
        10,
        "legacy map tuning values should survive preset migration"
    );
}

console.log("load-mode preset round-trip tests passed");
