// NOTE: "conversation", "lora", and "grammar" are used as both category ids and flag ids.
// This is intentional and harmless: categories and flags occupy separate data domains
// (FLAG_CATEGORIES vs FLAGS). The structural definition test explicitly allows these collisions.
// Do not add another collision without reviewing tests/frontend/flag_definitions_unit.cjs.
const FLAG_CATEGORIES = [
	{ id: "model", name: "Model", icon: "📦" },
	{ id: "context", name: "Context & Memory", icon: "🧠" },
	{ id: "cpu", name: "CPU & Threads", icon: "⚙️" },
	{ id: "gpu", name: "GPU / Acceleration", icon: "🎮" },
	{ id: "auto_fit", name: "Auto Fit", icon: "📐" },
	// submenuOrder controls only the display order of submenu blocks in the Configure
	// tab. It is deliberately separate from the FLAGS array order, which determines CLI
	// argument order in buildLaunchArgs() and must not be reordered for presentation.
	{
		id: "sampling",
		name: "Sampling",
		icon: "🎲",
		submenuOrder: [
			"Repetition Penalties",
			"DRY Sampling",
			"XTC Sampling",
			"Advanced Truncation",
			"Dynamic Temperature",
			"Mirostat",
			"Sampler Order",
			"Generation Control",
		],
	},
	{ id: "rope", name: "RoPE Scaling", icon: "📏" },
	{ id: "conversation", name: "Conversation & Chat", icon: "💬" },
	{ id: "lora", name: "LoRA & Control Vectors", icon: "🔗" },
	{ id: "kv", name: "KV Cache", icon: "💾" },
	{ id: "speculative", name: "Speculative Decoding", icon: "⚡" },
	{ id: "server", name: "Server Settings", icon: "🌐" },
	{ id: "mcp", name: "MCP Settings" },
	{ id: "grammar", name: "Grammar & Constraints", icon: "📝" },
	{ id: "logging", name: "Logging", icon: "📋" },
	{ id: "advanced", name: "Advanced", icon: "🔧" },
];
