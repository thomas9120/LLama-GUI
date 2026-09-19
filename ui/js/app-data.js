// Shared pure data: QUICK_PROFILES, BUILTIN_SAMPLER_PRESETS, CHAT_SAMPLER_SLIDER_MAP.
const CHAT_SAMPLER_SLIDER_MAP = {
    "chat-slider-temp": { flag: "temperature", decimals: 2, fallback: 0.8 },
    "chat-slider-top-p": { flag: "top_p", decimals: 2, fallback: 0.95 },
    "chat-slider-top-k": { flag: "top_k", decimals: 0, fallback: 40 },
    "chat-slider-min-p": { flag: "min_p", decimals: 2, fallback: 0.05 },
    "chat-slider-repeat": { flag: "repeat_penalty", decimals: 2, fallback: 1.0 },
    "chat-slider-max-tokens": { flag: "n_predict", decimals: 0 },
};

const SAMPLER_PRESET_STORAGE_KEY = "llama_gui_sampler_presets_v1";
const BUILTIN_SAMPLER_PRESETS = {
    Neutral: {
        temperature: 1.0,
        top_k: 0,
        top_p: 1.0,
        min_p: 0,
        top_n_sigma: -1,
        xtc_probability: 0,
        xtc_threshold: 1.0,
        typical_p: 1.0,
        repeat_last_n: 64,
        repeat_penalty: 1.0,
        presence_penalty: 0,
        frequency_penalty: 0,
        dry_multiplier: 0,
        dynatemp_range: 0,
        mirostat: "0",
    },
    Balanced: {
        temperature: 1.0,
        top_k: 0,
        top_p: 0.95,
        min_p: 0.1,
        top_n_sigma: -1,
        xtc_probability: 0,
        xtc_threshold: 1.0,
        typical_p: 1.0,
        repeat_last_n: 64,
        repeat_penalty: 1.03,
        presence_penalty: 0,
        frequency_penalty: 0,
        dry_multiplier: 0,
        dry_base: 1.75,
        dry_allowed_length: 2,
        dynatemp_range: 0,
        dynatemp_exp: 1.0,
        mirostat: "0",
        mirostat_lr: 0.1,
        mirostat_ent: 5,
        seed: -1,
        ignore_eos: false,
    },
    Creative: {
        temperature: 1.0,
        top_k: 100,
        top_p: 0.98,
        min_p: 0,
        repeat_penalty: 1.1,
        repeat_last_n: 64,
    },
    Precise: {
        temperature: 0.3,
        top_k: 25,
        top_p: 0.6,
        min_p: 0,
        repeat_penalty: 1.02,
        repeat_last_n: 64,
    },
};

const QUICK_CONTEXT_PRESETS = ["8192", "16000", "32768", "64000", "128000", "256000"];
const QUICK_PROFILES = Object.fromEntries(
    [64000, 128000, 256000].flatMap(ctx => ["none", "auto"].map(specType => {
        const size = `${ctx / 1000}K`;
        const mode = specType === "auto" ? "Auto" : "Off";
        return [`${size.toLowerCase()}-mtp-${mode.toLowerCase()}`, {
            label: `${size} · MTP ${mode}`,
            summary: `${size} context · MTP ${mode} · Automatic runtime settings. `
                + (specType === "auto" ? "MTP depends on model/build support; draft max uses the llama.cpp default. " : "Speculative decoding disabled. ")
                + "Samplers unchanged.",
            flags: { ctx_size: ctx, spec_type: specType },
        }];
    }))
);
