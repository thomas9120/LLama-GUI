const FLAG_CATEGORIES = [
    { id: "model", name: "Model", icon: "📦" },
    { id: "context", name: "Context & Memory", icon: "🧠" },
    { id: "cpu", name: "CPU & Threads", icon: "⚙️" },
    { id: "gpu", name: "GPU / Acceleration", icon: "🎮" },
    { id: "sampling", name: "Sampling", icon: "🎲" },
    { id: "rope", name: "RoPE Scaling", icon: "📏" },
    { id: "conversation", name: "Conversation & Chat", icon: "💬" },
    { id: "lora", name: "LoRA & Control Vectors", icon: "🔗" },
    { id: "kv", name: "KV Cache", icon: "💾" },
    { id: "speculative", name: "Speculative Decoding", icon: "⚡" },
    { id: "server", name: "Server and MCP Settings", icon: "🌐" },
    { id: "grammar", name: "Grammar & Constraints", icon: "📝" },
    { id: "logging", name: "Logging", icon: "📋" },
    { id: "advanced", name: "Advanced", icon: "🔧" },
];

const FLAGS = [
    // ── Model ──
    { id: "hf_repo", flag: "-hf", category: "model", type: "text", label: "HF Repo",
      short_desc: "Load a model directly from Hugging Face using repo/name.",
      desc: "Hugging Face repo: user/model[:quant], e.g. ggml-org/gemma-3-1b-it-GGUF:Q4_K_M", tool: "both" },
    { id: "hf_file", flag: "-hff", category: "model", type: "text", label: "HF File Override",
      desc: "Override specific GGUF file from HF repo", tool: "both" },
    { id: "hf_token", flag: "-hft", category: "model", type: "text", label: "HF Token",
      desc: "Hugging Face access token (or set HF_TOKEN env var)", tool: "both" },
    { id: "model_draft", flag: "-md", category: "model", type: "path", label: "Draft Model",
      desc: "Draft model for speculative decoding", tool: "both" },
    { id: "hf_repo_draft", flag: "-hfd", category: "model", type: "text", label: "HF Draft Repo",
      desc: "Hugging Face repo for draft model", tool: "both" },
    { id: "mmproj", flag: "-mm", category: "model", type: "path", label: "Multimodal Projector",
      desc: "Path to mmproj file (for vision models)", tool: "both" },
    { id: "model_vocoder", flag: "-mv", category: "model", type: "path", label: "Vocoder Model",
      desc: "Vocoder model for audio generation (server only)", tool: "server" },
    { id: "no_mmproj", flag: "--no-mmproj", category: "model", type: "bool", label: "Disable mmproj Auto",
      desc: "Disable automatic mmproj download when using -hf", tool: "both", default: false },

    // ── Context & Memory ──
    { id: "ctx_size", flag: "-c", category: "context", type: "int", label: "Total Context Window",
      short_desc: "How much text the model can keep in memory at once.",
      beginner_tip: "16000 is a strong default. Lower it if you run out of memory.",
      desc: "Total context size in tokens. This is the maximum number of tokens the model can 'remember' at once, including your prompt, system prompt, conversation history, AND the model's reply. Larger values use more VRAM/RAM. Set 0 to use the model's default.", tool: "both", default: 16000, min: 0, max: 131072, placeholder: "16000 recommended" },
    { id: "batch_size", flag: "-b", category: "context", type: "int", label: "Prompt Batch Size",
      short_desc: "Higher values read prompts faster but use more memory.",
      beginner_tip: "If you hit memory errors while loading prompts, lower this value first.",
      desc: "Maximum number of tokens processed in parallel during prompt ingestion (how fast your prompt is read). Higher = faster prompt processing but uses more memory. Only affects prompt speed, not generation speed.", tool: "both", default: 2048, min: 1, max: 8192 },
    { id: "ubatch_size", flag: "-ub", category: "context", type: "int", label: "Physical Batch Size",
      short_desc: "Lower this first if you get out-of-memory errors.",
      desc: "Internal GPU/CPU batch size. Should be <= batch_size. Lower values use less VRAM but may be slower. Typically leave at default unless you get out-of-memory errors.", tool: "both", default: 512, min: 1, max: 4096 },
    { id: "n_predict", flag: "-n", category: "context", type: "int", label: "Max Tokens Per Response",
      short_desc: "Caps how long each generated reply can be.",
      desc: "Maximum number of tokens the model will generate per response/reply. -1 means unlimited (the model will keep generating until it produces an EOS token or hits the context limit). Useful for preventing overly long responses.", tool: "both", default: -1, min: -1, max: 131072, placeholder: "-1 = unlimited" },
    { id: "keep", flag: "--keep", category: "context", type: "int", label: "Tokens to Keep",
      desc: "When the context fills up, how many tokens from the very beginning of the conversation (system prompt + first messages) to permanently keep. 0 = discard everything, -1 = keep everything.", tool: "both", default: 0, min: -1 },
    { id: "mlock", flag: "--mlock", category: "context", type: "bool", label: "Lock Model in RAM",
      desc: "Force the OS to keep the model in physical RAM and never swap it to disk. Prevents stuttering but requires enough free RAM for the entire model.", tool: "both", default: false },
    { id: "mmap", flag: "--mmap", false_flag: "--no-mmap", category: "context", type: "bool", label: "Memory Map Model",
      desc: "Load the model using memory-mapped files for faster loading and lower RAM usage. Disable if you get pageout/stuttering issues.", tool: "both", default: true },
    { id: "direct_io", flag: "-dio", category: "context", type: "bool", label: "Direct I/O",
      desc: "Bypass OS page cache when loading the model. Slower load but can prevent cache pollution with large models.", tool: "both", default: false },
    { id: "swa_full", flag: "--swa-full", category: "context", type: "bool", label: "Full SWA Cache",
      desc: "Use full-size sliding window attention cache instead of compressed. Uses more memory but preserves full context quality.", tool: "both", default: false },
    { id: "cache_ram", flag: "-cram", category: "context", type: "int", label: "KV Cache RAM Limit (MiB)",
      desc: "Maximum RAM/VRAM to use for the KV cache in MiB. The KV cache stores conversation history - more cache = longer conversations before older messages are evicted. -1 = no limit, 0 = disable.", tool: "both", default: 8192, min: -1, placeholder: "-1 unlimited" },

    // ── CPU & Threads ──
    { id: "threads", flag: "-t", category: "cpu", type: "int", label: "CPU Threads",
      short_desc: "CPU workers used during generation (-1 picks automatically).",
      desc: "Number of CPU threads for generation (-1 = auto)", tool: "both", default: -1, min: -1, max: 256, placeholder: "-1 = auto" },
    { id: "threads_batch", flag: "-tb", category: "cpu", type: "int", label: "Batch Threads",
      desc: "Threads for batch/prompt processing (default = same as threads)", tool: "both", min: -1, max: 256, placeholder: "default = threads" },
    { id: "cpu_mask", flag: "-C", category: "cpu", type: "text", label: "CPU Affinity Mask",
      desc: "CPU affinity mask (hex string)", tool: "both" },
    { id: "cpu_range", flag: "-Cr", category: "cpu", type: "text", label: "CPU Range",
      desc: "Range of CPUs for affinity, e.g. 0-7", tool: "both" },
    { id: "numa", flag: "--numa", category: "cpu", type: "enum", label: "NUMA Mode",
      desc: "NUMA optimization type", tool: "both",
      options: [{ value: "", label: "Disabled" }, { value: "distribute", label: "Distribute" }, { value: "isolate", label: "Isolate" }, { value: "numactl", label: "numactl" }] },
    { id: "prio", flag: "--prio", category: "cpu", type: "enum", label: "Thread Priority",
      desc: "Process/thread priority", tool: "both",
      options: [{ value: "0", label: "Normal (0)" }, { value: "-1", label: "Low (-1)" }, { value: "1", label: "Medium (1)" }, { value: "2", label: "High (2)" }, { value: "3", label: "Realtime (3)" }] },
    { id: "poll", flag: "--poll", category: "cpu", type: "int", label: "Poll Level",
      desc: "Polling level to wait for work (0 = no polling)", tool: "both", default: 50, min: 0, max: 100 },

    // ── GPU / Acceleration ──
    { id: "gpu_layers", flag: "-ngl", category: "gpu", type: "text", label: "GPU Layers",
      short_desc: "How much of the model to offload to GPU.",
      beginner_tip: "Leave on auto unless you are tuning performance manually.",
      desc: "Max layers in VRAM (number, 'auto', or 'all')", tool: "both", default: "auto", placeholder: "auto" },
    { id: "split_mode", flag: "-sm", category: "gpu", type: "enum", label: "Split Mode",
      desc: "How to split model across multiple GPUs", tool: "both",
      options: [{ value: "layer", label: "Layer (default)" }, { value: "none", label: "None" }, { value: "row", label: "Row" }] },
    { id: "tensor_split", flag: "-ts", category: "gpu", type: "text", label: "Tensor Split",
      desc: "Fraction of model per GPU, comma-separated, e.g. 3,1", tool: "both" },
    { id: "main_gpu", flag: "-mg", category: "gpu", type: "int", label: "Main GPU",
      desc: "GPU to use for the model / intermediate results", tool: "both", default: 0, min: 0 },
    { id: "device", flag: "-dev", category: "gpu", type: "text", label: "Device(s)",
      desc: "Comma-separated list of devices for offloading", tool: "both", placeholder: "none = don't offload" },
    { id: "flash_attn", flag: "-fa", category: "gpu", type: "enum", label: "Flash Attention",
      desc: "Flash Attention mode", tool: "both",
      default: "auto",
      options: [{ value: "auto", label: "Auto (default)" }, { value: "on", label: "On" }, { value: "off", label: "Off" }] },
    { id: "kv_offload", flag: "-kvo", false_flag: "--no-kv-offload", category: "gpu", type: "bool", label: "KV Offload",
      desc: "Enable KV cache offloading", tool: "both", default: true },
    { id: "repack", flag: "--repack", false_flag: "--no-repack", category: "gpu", type: "bool", label: "Weight Repacking",
      desc: "Enable weight repacking", tool: "both", default: false },
    { id: "fit", flag: "-fit", category: "gpu", type: "enum", label: "Auto Fit to VRAM",
      short_desc: "Automatically adjusts settings to avoid GPU memory crashes.",
      beginner_tip: "Keep this ON unless you specifically need manual control.",
      desc: "Automatically reduce context size and batch size so the model fits in your GPU VRAM. Highly recommended for beginners - prevents out-of-memory crashes. Turn off only if you know exactly what you're doing.", tool: "both",
      default: "on",
      options: [{ value: "on", label: "On (Recommended)" }, { value: "off", label: "Off" }] },
    { id: "cpu_moe", flag: "-cmoe", category: "gpu", type: "bool", label: "CPU MoE",
      desc: "Keep all MoE weights in CPU", tool: "both", default: false },
    { id: "n_cpu_moe", flag: "-ncmoe", category: "gpu", type: "int", label: "CPU MoE Layers",
      desc: "Keep MoE weights of first N layers in CPU", tool: "both", min: 0 },
    { id: "mmproj_offload", flag: "--mmproj-offload", false_flag: "--no-mmproj-offload", category: "gpu", type: "bool", label: "mmproj GPU Offload",
      desc: "Enable GPU offloading for multimodal projector", tool: "both", default: true },

    // ── Sampling ──
    { id: "temperature", flag: "--temp", category: "sampling", type: "float", label: "Temperature",
      short_desc: "Controls creativity: lower is focused, higher is more random.",
      beginner_tip: "Try 0.7-0.9 for general chat. Lower for factual tasks.",
      desc: "Sampling temperature (higher = more random)", tool: "both", default: 0.8, min: 0, max: 5, step: 0.05 },
    { id: "top_k", flag: "--top-k", category: "sampling", type: "int", label: "Top-K",
      short_desc: "Limits choices to the K most likely next tokens.",
      desc: "Limit selection to K most probable tokens (0 = disabled)", tool: "both", default: 40, min: 0, max: 1000 },
    { id: "top_p", flag: "--top-p", category: "sampling", type: "float", label: "Top-P",
      short_desc: "Keeps only the most probable token group by cumulative chance.",
      beginner_tip: "0.9-0.95 is a safe range for most chat use.",
      desc: "Nucleus sampling threshold (1.0 = disabled)", tool: "both", default: 0.95, min: 0, max: 1, step: 0.01 },
    { id: "min_p", flag: "--min-p", category: "sampling", type: "float", label: "Min-P",
      short_desc: "Drops very unlikely tokens to stabilize output.",
      desc: "Minimum token probability relative to top token (0 = disabled)", tool: "both", default: 0.05, min: 0, max: 1, step: 0.01 },
    { id: "top_n_sigma", flag: "--top-n-sigma", category: "sampling", type: "float", label: "Top-N-Sigma",
      desc: "Top-N-Sigma sampling (-1 = disabled)", tool: "both", default: -1, min: -1, max: 10, step: 0.01 },
    { id: "xtc_probability", flag: "--xtc-probability", category: "sampling", type: "float", label: "XTC Probability",
      desc: "XTC token removal probability (0 = disabled)", tool: "both", default: 0, min: 0, max: 1, step: 0.01 },
    { id: "xtc_threshold", flag: "--xtc-threshold", category: "sampling", type: "float", label: "XTC Threshold",
      desc: "XTC threshold (1.0 = disabled)", tool: "both", default: 0.1, min: 0, max: 1, step: 0.01 },
    { id: "typical_p", flag: "--typical-p", category: "sampling", type: "float", label: "Typical-P",
      desc: "Locally typical sampling (1.0 = disabled)", tool: "both", default: 1.0, min: 0, max: 1, step: 0.01 },
    { id: "repeat_last_n", flag: "--repeat-last-n", category: "sampling", type: "int", label: "Repeat Penalty Tokens",
      desc: "Last N tokens to penalize (0 = disabled, -1 = ctx)", tool: "both", default: 64, min: -1 },
    { id: "repeat_penalty", flag: "--repeat-penalty", category: "sampling", type: "float", label: "Repeat Penalty",
      short_desc: "Discourages the model from repeating itself.",
      beginner_tip: "If replies loop or repeat phrases, raise this slightly above 1.0.",
      desc: "Penalize repeat token sequences (1.0 = disabled)", tool: "both", default: 1.0, min: 0.5, max: 3, step: 0.05 },
    { id: "presence_penalty", flag: "--presence-penalty", category: "sampling", type: "float", label: "Presence Penalty",
      desc: "Alpha presence penalty (0 = disabled)", tool: "both", default: 0, min: 0, max: 5, step: 0.05 },
    { id: "frequency_penalty", flag: "--frequency-penalty", category: "sampling", type: "float", label: "Frequency Penalty",
      desc: "Alpha frequency penalty (0 = disabled)", tool: "both", default: 0, min: 0, max: 5, step: 0.05 },
    { id: "dry_multiplier", flag: "--dry-multiplier", category: "sampling", type: "float", label: "DRY Multiplier",
      desc: "DRY repetition penalty multiplier (0 = disabled)", tool: "both", default: 0, min: 0, max: 5, step: 0.05 },
    { id: "dry_base", flag: "--dry-base", category: "sampling", type: "float", label: "DRY Base",
      desc: "DRY base value for penalty exponent", tool: "both", default: 1.75, min: 1, max: 5, step: 0.05 },
    { id: "dry_allowed_length", flag: "--dry-allowed-length", category: "sampling", type: "int", label: "DRY Allowed Length",
      desc: "Allowed repetition length before DRY kicks in", tool: "both", default: 2, min: 1 },
    { id: "dynatemp_range", flag: "--dynatemp-range", category: "sampling", type: "float", label: "Dynamic Temp Range",
      desc: "Dynamic temperature range (0 = disabled)", tool: "both", default: 0, min: 0, max: 5, step: 0.01 },
    { id: "dynatemp_exp", flag: "--dynatemp-exp", category: "sampling", type: "float", label: "Dynamic Temp Exponent",
      desc: "Dynamic temperature exponent", tool: "both", default: 1.0, min: 0.1, max: 5, step: 0.05 },
    { id: "mirostat", flag: "--mirostat", category: "sampling", type: "enum", label: "Mirostat",
      desc: "Mirostat sampling mode", tool: "both",
      options: [{ value: "0", label: "Disabled (0)" }, { value: "1", label: "Mirostat (1)" }, { value: "2", label: "Mirostat 2.0 (2)" }] },
    { id: "mirostat_lr", flag: "--mirostat-lr", category: "sampling", type: "float", label: "Mirostat LR",
      desc: "Mirostat learning rate (eta)", tool: "both", default: 0.1, min: 0.001, max: 1, step: 0.01 },
    { id: "mirostat_ent", flag: "--mirostat-ent", category: "sampling", type: "float", label: "Mirostat Entropy",
      desc: "Mirostat target entropy (tau)", tool: "both", default: 5.0, min: 0, max: 20, step: 0.1 },
    { id: "seed", flag: "-s", category: "sampling", type: "int", label: "Seed",
      short_desc: "Use the same seed for reproducible outputs.",
      desc: "RNG seed (-1 = random)", tool: "both", default: -1, min: -1, placeholder: "-1 = random" },
    { id: "ignore_eos", flag: "--ignore-eos", category: "sampling", type: "bool", label: "Ignore EOS",
      desc: "Ignore end-of-stream token and continue generating", tool: "both", default: false },
    { id: "samplers", flag: "--samplers", category: "sampling", type: "text", label: "Sampler Sequence",
      desc: "Custom sampler order, semicolon separated", tool: "both", placeholder: "penalties;dry;top_k;top_p;temperature" },

    // ── RoPE Scaling ──
    { id: "rope_scaling", flag: "--rope-scaling", category: "rope", type: "enum", label: "RoPE Scaling",
      desc: "RoPE frequency scaling method", tool: "both",
      options: [{ value: "", label: "Default (from model)" }, { value: "none", label: "None" }, { value: "linear", label: "Linear" }, { value: "yarn", label: "YaRN" }] },
    { id: "rope_scale", flag: "--rope-scale", category: "rope", type: "float", label: "RoPE Scale",
      desc: "Context scaling factor (expands context by N)", tool: "both", min: 0, step: 0.1 },
    { id: "rope_freq_base", flag: "--rope-freq-base", category: "rope", type: "float", label: "RoPE Freq Base",
      desc: "RoPE base frequency for NTK-aware scaling", tool: "both", min: 0, step: 100 },
    { id: "rope_freq_scale", flag: "--rope-freq-scale", category: "rope", type: "float", label: "RoPE Freq Scale",
      desc: "RoPE frequency scaling factor (expands by 1/N)", tool: "both", min: 0, step: 0.01 },
    { id: "yarn_orig_ctx", flag: "--yarn-orig-ctx", category: "rope", type: "int", label: "YaRN Original Ctx",
      desc: "Original context size (0 = from model)", tool: "both", default: 0, min: 0 },
    { id: "yarn_ext_factor", flag: "--yarn-ext-factor", category: "rope", type: "float", label: "YaRN Extrapolation",
      desc: "YaRN extrapolation mix factor", tool: "both", default: -1, min: -1, max: 1, step: 0.01 },
    { id: "yarn_attn_factor", flag: "--yarn-attn-factor", category: "rope", type: "float", label: "YaRN Attention Factor",
      desc: "YaRN attention magnitude scaling", tool: "both", default: -1, min: -1, max: 2, step: 0.01 },
    { id: "yarn_beta_slow", flag: "--yarn-beta-slow", category: "rope", type: "float", label: "YaRN Beta Slow",
      desc: "YaRN high correction dimension", tool: "both", default: -1, min: -1, step: 0.01 },
    { id: "yarn_beta_fast", flag: "--yarn-beta-fast", category: "rope", type: "float", label: "YaRN Beta Fast",
      desc: "YaRN low correction dimension", tool: "both", default: -1, min: -1, step: 0.01 },

    // ── Conversation & Chat ──
    { id: "conversation", flag: "-cnv", category: "conversation", type: "bool", label: "Conversation Mode",
      desc: "Run in interactive conversation mode", tool: "cli", default: false },
    { id: "system_prompt", flag: "-sys", category: "conversation", type: "text", label: "System Prompt",
      desc: "System prompt for chat", tool: "cli" },
    { id: "system_prompt_file", flag: "-sysf", category: "conversation", type: "path", label: "System Prompt File",
      desc: "File containing the system prompt", tool: "cli" },
    { id: "reverse_prompt", flag: "-r", category: "conversation", type: "text", label: "Reverse Prompt",
      desc: "Halt generation at this prompt string (interactive)", tool: "both" },
    { id: "prompt", flag: "-p", category: "conversation", type: "text", label: "Initial Prompt",
      desc: "Prompt to start generation with", tool: "cli" },
    { id: "prompt_file", flag: "-f", category: "conversation", type: "path", label: "Prompt File",
      desc: "File containing the prompt", tool: "cli" },
    { id: "chat_template", flag: "--chat-template", category: "conversation", type: "enum", label: "Chat Template",
      desc: "Chat template name or custom Jinja template", tool: "both",
      options: [
        { value: "", label: "Auto (from model)" },
        { value: "chatml", label: "ChatML" }, { value: "llama3", label: "Llama 3" },
        { value: "llama2", label: "Llama 2" }, { value: "mistral-v1", label: "Mistral v1" },
        { value: "mistral-v3", label: "Mistral v3" }, { value: "deepseek", label: "DeepSeek" },
        { value: "deepseek2", label: "DeepSeek 2" }, { value: "deepseek3", label: "DeepSeek 3" },
        { value: "gemma", label: "Gemma" }, { value: "phi3", label: "Phi-3" },
        { value: "phi4", label: "Phi-4" }, { value: "command-r", label: "Command-R" },
        { value: "qwen", label: "Qwen" }, { value: "vicuna", label: "Vicuna" },
        { value: "zephyr", label: "Zephyr" }, { value: "falcon3", label: "Falcon 3" },
        { value: "granite", label: "Granite" }, { value: "chatglm3", label: "ChatGLM3" },
        { value: "chatglm4", label: "ChatGLM4" }, { value: "custom", label: "Custom..." },
      ] },
    { id: "chat_template_custom", flag: "--chat-template-file", category: "conversation", type: "path", label: "Custom Template File",
      desc: "Path to a custom Jinja chat template file", tool: "both" },
    { id: "reasoning", flag: "-rea", category: "conversation", type: "enum", label: "Reasoning / Thinking",
      desc: "Enable reasoning/thinking in chat", tool: "both",
      default: "auto",
      options: [{ value: "auto", label: "Auto" }, { value: "on", label: "On" }, { value: "off", label: "Off" }] },
    { id: "reasoning_budget", flag: "--reasoning-budget", category: "conversation", type: "int", label: "Reasoning Budget",
      desc: "Token budget for thinking (-1 = unlimited, 0 = off)", tool: "both", default: -1, min: -1 },
    { id: "preserve_thinking", flag: "--chat-template-kwargs", category: "conversation", type: "bool", label: "Preserve Thinking",
      desc: "Preserve thinking/reasoning tokens in the response output instead of stripping them. Required for models like Qwen3, DeepSeek-R1, etc. to show their chain-of-thought. Passes {\"preserve_thinking\":true} to the chat template engine.", tool: "both", default: false },
    { id: "single_turn", flag: "-st", category: "conversation", type: "bool", label: "Single Turn",
      desc: "Run for a single turn then exit", tool: "cli", default: false },
    { id: "multiline", flag: "-mli", category: "conversation", type: "bool", label: "Multiline Input",
      desc: "Allow multiline input without escaping", tool: "cli", default: false },

    // ── LoRA & Control Vectors ──
    { id: "lora", flag: "--lora", category: "lora", type: "text", label: "LoRA Adapter(s)",
      desc: "Path to LoRA adapter (comma-separated for multiple)", tool: "both" },
    { id: "lora_scaled", flag: "--lora-scaled", category: "lora", type: "text", label: "LoRA (Scaled)",
      desc: "LoRA adapter with scaling, format: path:scale,...", tool: "both" },
    { id: "control_vector", flag: "--control-vector", category: "lora", type: "text", label: "Control Vector(s)",
      desc: "Path to control vector (comma-separated for multiple)", tool: "both" },
    { id: "control_vector_scaled", flag: "--control-vector-scaled", category: "lora", type: "text", label: "Control Vector (Scaled)",
      desc: "Control vector with scaling, format: path:scale,...", tool: "both" },
    { id: "control_vector_range", flag: "--control-vector-layer-range", category: "lora", type: "text", label: "CV Layer Range",
      desc: "Layer range for control vectors: START END", tool: "both" },

    // ── KV Cache ──
    { id: "cache_type_k", flag: "-ctk", category: "kv", type: "enum", label: "KV Cache Type K",
      desc: "KV cache data type for K", tool: "both",
      options: [
        { value: "f16", label: "F16 (default)" }, { value: "f32", label: "F32" },
        { value: "bf16", label: "BF16" }, { value: "q8_0", label: "Q8_0" },
        { value: "q4_0", label: "Q4_0" }, { value: "q4_1", label: "Q4_1" },
        { value: "iq4_nl", label: "IQ4_NL" }, { value: "q5_0", label: "Q5_0" }, { value: "q5_1", label: "Q5_1" },
      ] },
    { id: "cache_type_v", flag: "-ctv", category: "kv", type: "enum", label: "KV Cache Type V",
      desc: "KV cache data type for V", tool: "both",
      options: [
        { value: "f16", label: "F16 (default)" }, { value: "f32", label: "F32" },
        { value: "bf16", label: "BF16" }, { value: "q8_0", label: "Q8_0" },
        { value: "q4_0", label: "Q4_0" }, { value: "q4_1", label: "Q4_1" },
        { value: "iq4_nl", label: "IQ4_NL" }, { value: "q5_0", label: "Q5_0" }, { value: "q5_1", label: "Q5_1" },
      ] },
    { id: "context_shift", flag: "--context-shift", category: "kv", type: "bool", label: "Context Shift",
      desc: "Use context shift on infinite text generation", tool: "both", default: false },

    // ── Speculative Decoding ──
    { id: "draft_max", flag: "--draft", category: "speculative", type: "int", label: "Draft Tokens",
      desc: "Number of draft tokens for speculative decoding", tool: "both", default: 16, min: 0, max: 128 },
    { id: "draft_min", flag: "--draft-min", category: "speculative", type: "int", label: "Draft Min Tokens",
      desc: "Minimum draft tokens", tool: "both", default: 0, min: 0 },
    { id: "draft_p_min", flag: "--draft-p-min", category: "speculative", type: "float", label: "Draft Min Probability",
      desc: "Minimum speculative decoding probability (greedy)", tool: "both", default: 0.75, min: 0, max: 1, step: 0.01 },
    { id: "ctx_size_draft", flag: "-cd", category: "speculative", type: "int", label: "Draft Context Size",
      desc: "Context size for draft model", tool: "both", min: 0 },
    { id: "gpu_layers_draft", flag: "-ngld", category: "speculative", type: "text", label: "Draft GPU Layers",
      desc: "Max draft model layers in VRAM", tool: "both", placeholder: "auto" },
    { id: "spec_type", flag: "--spec-type", category: "speculative", type: "enum", label: "Speculative Type",
      desc: "Type of speculative decoding (no draft model)", tool: "server",
      options: [
        { value: "none", label: "None (default)" }, { value: "ngram-cache", label: "Ngram Cache" },
        { value: "ngram-simple", label: "Ngram Simple" }, { value: "ngram-map-k", label: "Ngram Map K" },
        { value: "ngram-map-k4v", label: "Ngram Map K4V" }, { value: "ngram-mod", label: "Ngram Mod" },
      ] },

    // ── Server and MCP Settings ──
    { id: "host", flag: "--host", category: "server", type: "text", label: "Host",
      short_desc: "Network address the API server listens on.",
      desc: "IP address to listen on (default: 127.0.0.1)", tool: "server", default: "127.0.0.1" },
    { id: "port", flag: "--port", category: "server", type: "int", label: "Port",
      short_desc: "Port number for the API server.",
      beginner_tip: "Keep 8080 unless another app is already using it.",
      desc: "Port to listen on", tool: "server", default: 8080, min: 1, max: 65535 },
    { id: "alias", flag: "-a", category: "server", type: "text", label: "Model Alias",
      desc: "Model name alias(es) for the API (comma-separated)", tool: "server" },
    { id: "parallel", flag: "-np", category: "server", type: "int", label: "Parallel Slots",
      desc: "Number of server slots (-1 = auto)", tool: "server", default: -1, min: -1, max: 128, placeholder: "-1 = auto" },
    { id: "cont_batching", flag: "-cb", false_flag: "--no-cont-batching", category: "server", type: "bool", label: "Continuous Batching",
      desc: "Enable dynamic/continuous batching", tool: "server", default: true },
    { id: "cache_prompt", flag: "--cache-prompt", false_flag: "--no-cache-prompt", category: "server", type: "bool", label: "Prompt Caching",
      desc: "Enable prompt caching", tool: "server", default: true },
    { id: "timeout", flag: "-to", category: "server", type: "int", label: "Timeout (seconds)",
      desc: "Server read/write timeout", tool: "server", default: 600, min: 1 },
    { id: "api_key", flag: "--api-key", category: "server", type: "text", label: "API Key",
      short_desc: "Optional key required for clients to access the API.",
      desc: "API key for authentication (comma-separated for multiple)", tool: "server" },
    { id: "threads_http", flag: "--threads-http", category: "server", type: "int", label: "HTTP Threads",
      desc: "Threads for HTTP requests (-1 = auto)", tool: "server", min: -1 },
    { id: "metrics", flag: "--metrics", category: "server", type: "bool", label: "Prometheus Metrics",
      desc: "Enable Prometheus metrics endpoint", tool: "server", default: false },
    { id: "webui", flag: "--webui", false_flag: "--no-webui", category: "server", type: "bool", label: "Web UI",
      short_desc: "Turns on the built-in browser interface.",
      desc: "Enable the built-in web UI", tool: "server", default: true },
    { id: "webui_mcp_proxy", flag: "--webui-mcp-proxy", category: "server", submenu: "MCP Settings", type: "bool", label: "WebUI MCP Proxy",
      short_desc: "Enable MCP CORS proxy support for the Web UI.",
      desc: "Experimental. Allows the Web UI to proxy MCP requests via CORS. Do not enable in untrusted environments.", tool: "server", default: false },
    { id: "tools", flag: "--tools", category: "server", submenu: "MCP Settings", type: "multi_enum", label: "Built-in Tools",
      short_desc: "Enable local file/shell tools for AI agents in the Web UI.",
      beginner_tip: "Use 'all' only on trusted machines. In shared environments, list only what you need.",
      desc: "Experimental. Enables built-in agent tools exposed to the model through llama-server. Select one or more tools below, or choose 'all' to enable every tool.", tool: "server",
      options: [
        { value: "all", label: "All tools", risk: "high" },
        { value: "read_file", label: "Read File" },
        { value: "file_glob_search", label: "File Glob Search" },
        { value: "grep_search", label: "Grep Search" },
        { value: "exec_shell_command", label: "Exec Shell Command", risk: "high" },
        { value: "write_file", label: "Write File", risk: "high" },
        { value: "edit_file", label: "Edit File", risk: "high" },
        { value: "apply_diff", label: "Apply Diff", risk: "high" },
      ] },
    { id: "embedding", flag: "--embedding", category: "server", type: "bool", label: "Embedding Mode",
      desc: "Restrict to embedding use case only", tool: "server", default: false },
    { id: "slot_prompt_similarity", flag: "-sps", category: "server", type: "float", label: "Slot Prompt Similarity",
      desc: "Prompt similarity threshold for slot reuse (0 = disabled)", tool: "server", default: 0.1, min: 0, max: 1, step: 0.01 },
    { id: "cache_reuse", flag: "--cache-reuse", category: "server", type: "int", label: "Cache Reuse Size",
      desc: "Min chunk size for cache reuse via KV shifting (0 = disabled)", tool: "server", default: 0, min: 0 },

    // ── Grammar & Constraints ──
    { id: "grammar", flag: "--grammar", category: "grammar", type: "text", label: "Grammar",
      desc: "BNF-like grammar to constrain generation", tool: "both" },
    { id: "grammar_file", flag: "--grammar-file", category: "grammar", type: "path", label: "Grammar File",
      desc: "File containing grammar rules", tool: "both" },
    { id: "json_schema", flag: "-j", category: "grammar", type: "text", label: "JSON Schema",
      desc: "JSON schema to constrain output, e.g. {}", tool: "both" },
    { id: "json_schema_file", flag: "-jf", category: "grammar", type: "path", label: "JSON Schema File",
      desc: "File containing a JSON schema", tool: "both" },
    { id: "backend_sampling", flag: "-bs", category: "grammar", type: "bool", label: "Backend Sampling",
      desc: "Enable backend sampling (experimental)", tool: "both", default: false },

    // ── Logging ──
    { id: "verbose", flag: "-v", category: "logging", type: "bool", label: "Verbose",
      desc: "Set verbosity to maximum (log all messages)", tool: "both", default: false },
    { id: "verbosity", flag: "-lv", category: "logging", type: "int", label: "Verbosity Level",
      desc: "Log verbosity threshold (0=generic, 1=error, 2=warn, 3=info, 4=debug)", tool: "both", default: 3, min: 0, max: 4 },
    { id: "log_file", flag: "--log-file", category: "logging", type: "path", label: "Log File",
      desc: "Write logs to file", tool: "both" },
    { id: "log_colors", flag: "--log-colors", category: "logging", type: "enum", label: "Log Colors",
      desc: "Colored logging", tool: "both",
      default: "auto",
      options: [{ value: "auto", label: "Auto (default)" }, { value: "on", label: "On" }, { value: "off", label: "Off" }] },
    { id: "log_prefix", flag: "--log-prefix", category: "logging", type: "bool", label: "Log Prefix",
      desc: "Enable prefix in log messages", tool: "both", default: false },
    { id: "log_timestamps", flag: "--log-timestamps", category: "logging", type: "bool", label: "Log Timestamps",
      desc: "Enable timestamps in log messages", tool: "both", default: false },
    { id: "show_timings", flag: "--show-timings", false_flag: "--no-show-timings", category: "logging", type: "bool", label: "Show Timings",
      desc: "Show timing information after each response", tool: "cli", default: true },

    // ── Advanced ──
    { id: "override_kv", flag: "--override-kv", category: "advanced", type: "text", label: "Override KV Metadata",
      desc: "Override model metadata, e.g. KEY=TYPE:VALUE,...", tool: "both" },
    { id: "override_tensor", flag: "-ot", category: "advanced", type: "text", label: "Override Tensor Buffer",
      desc: "Override tensor buffer type, e.g. pattern=type,...", tool: "both" },
    { id: "check_tensors", flag: "--check-tensors", category: "advanced", type: "bool", label: "Check Tensors",
      desc: "Check model tensor data for invalid values", tool: "both", default: false },
    { id: "no_host", flag: "--no-host", category: "advanced", type: "bool", label: "No Host Buffer",
      desc: "Bypass host buffer for extra buffers", tool: "both", default: false },
    { id: "warmup", flag: "--warmup", false_flag: "--no-warmup", category: "advanced", type: "bool", label: "Warmup",
      desc: "Perform warmup with empty run", tool: "both", default: true },
    { id: "offline", flag: "--offline", category: "advanced", type: "bool", label: "Offline Mode",
      desc: "Force cache use, prevent network access", tool: "both", default: false },
];

function getFlagsForTool(tool) {
    const toolBase = String(tool).replace("llama-", "");
    return FLAGS.filter(f => f.tool === "both" || f.tool === toolBase);
}

function getFlagsByCategory(tool) {
    const flags = getFlagsForTool(tool);
    const groups = {};
    for (const cat of FLAG_CATEGORIES) {
        const catFlags = flags.filter(f => f.category === cat.id);
        if (catFlags.length > 0) {
            groups[cat.id] = { ...cat, flags: catFlags };
        }
    }
    return groups;
}

function buildCommand(tool, values) {
    const cfg = values;
    const toolBase = tool.replace("llama-", "");
    const parts = [tool + ".exe"];

    for (const f of FLAGS) {
        if (f.tool !== "both" && f.tool !== toolBase) continue;
        const val = cfg[f.id];
        if (val === undefined || val === null || val === "") continue;
        if (f.type === "bool") {
            if (val === true && !f.flag.startsWith("--no-")) {
                if (f.id === "preserve_thinking") {
                    parts.push(f.flag, '{"preserve_thinking":true}');
                } else {
                    parts.push(f.flag);
                }
            } else if (val === false && f.false_flag) {
                parts.push(f.false_flag);
            } else if (val === false && f.flag.startsWith("--no-")) {
                parts.push(f.flag);
            }
        } else if (f.type === "multi_enum") {
            if (Array.isArray(val) && val.length > 0) {
                parts.push(f.flag, val.map(v => String(v)).join(","));
            } else if (typeof val === "string" && val.trim()) {
                parts.push(f.flag, val.trim());
            }
        } else {
            parts.push(f.flag, String(val));
        }
    }
    return parts.join(" ");
}

function getDefaultValues() {
    const defaults = {};
    for (const f of FLAGS) {
        if (f.default !== undefined) {
            defaults[f.id] = f.default;
        }
    }
    return defaults;
}
