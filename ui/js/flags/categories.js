// NOTE: "conversation", "lora", and "grammar" are used as both category ids and flag ids.
// This is intentional and harmless: categories and flags occupy separate data domains
// (FLAG_CATEGORIES vs FLAGS). flag-validation.js warns about these collisions at startup.
// Do NOT rename without checking the audit notes in docs/todo.md (Phase 2, Item 6).
const FLAG_CATEGORIES = [
    { id: "model", name: "Model", icon: "📦" },
    { id: "context", name: "Context & Memory", icon: "🧠" },
    { id: "cpu", name: "CPU & Threads", icon: "⚙️" },
    { id: "gpu", name: "GPU / Acceleration", icon: "🎮" },
    { id: "auto_fit", name: "Auto Fit", icon: "📐" },
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
