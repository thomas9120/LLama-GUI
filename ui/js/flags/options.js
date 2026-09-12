// Flags package (2/5): shared enum option lists for option-typed flags (CACHE_TYPE_OPTIONS etc.).
const CACHE_TYPE_OPTIONS = [
    { value: "f16", label: "F16 (default)" }, { value: "f32", label: "F32" },
    { value: "bf16", label: "BF16" }, { value: "q8_0", label: "Q8_0" },
    { value: "q4_0", label: "Q4_0" }, { value: "q4_1", label: "Q4_1" },
    { value: "iq4_nl", label: "IQ4_NL" }, { value: "q5_0", label: "Q5_0" }, { value: "q5_1", label: "Q5_1" },
];

const REASONING_FORMAT_OPTIONS = [
    { value: "auto", label: "Auto (default)" },
    { value: "deepseek", label: "DeepSeek (separate reasoning)" },
    { value: "none", label: "None (leave thoughts in content)" },
    { value: "deepseek-legacy", label: "DeepSeek Legacy (keep think tags)" },
];
