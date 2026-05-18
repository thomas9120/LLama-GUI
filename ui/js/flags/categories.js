// NOTE: "conversation", "lora", and "grammar" are used as both category ids and flag ids.
// This is intentional and harmless â€” categories and flags occupy separate data domains
// (FLAG_CATEGORIES vs FLAGS). flag-validation.js warns about these collisions at startup.
// Do NOT rename without checking the audit notes in docs/todo.md (Phase 2, Item 6).
const FLAG_CATEGORIES = [
    { id: "model", name: "Model", icon: "ðŸ“¦" },
    { id: "context", name: "Context & Memory", icon: "ðŸ§ " },
    { id: "cpu", name: "CPU & Threads", icon: "âš™ï¸" },
    { id: "gpu", name: "GPU / Acceleration", icon: "ðŸŽ®" },
    { id: "sampling", name: "Sampling", icon: "ðŸŽ²" },
    { id: "rope", name: "RoPE Scaling", icon: "ðŸ“" },
    { id: "conversation", name: "Conversation & Chat", icon: "ðŸ’¬" },
    { id: "lora", name: "LoRA & Control Vectors", icon: "ðŸ”—" },
    { id: "kv", name: "KV Cache", icon: "ðŸ’¾" },
    { id: "speculative", name: "Speculative Decoding", icon: "âš¡" },
    { id: "server", name: "Server and MCP Settings", icon: "ðŸŒ" },
    { id: "grammar", name: "Grammar & Constraints", icon: "ðŸ“" },
    { id: "logging", name: "Logging", icon: "ðŸ“‹" },
    { id: "advanced", name: "Advanced", icon: "ðŸ”§" },
];
