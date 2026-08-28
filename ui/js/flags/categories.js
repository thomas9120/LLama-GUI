// NOTE: "conversation", "lora", and "grammar" are used as both category ids and flag ids.
// This is intentional and harmless: categories and flags occupy separate data domains
// (FLAG_CATEGORIES vs FLAGS). The structural definition test explicitly allows these collisions.
// Do not add another collision without reviewing tests/frontend/flag_definitions_unit.cjs.
const FLAG_CATEGORIES = [
	{ id: "model", name: "模型", icon: "📦" },
	{ id: "context", name: "上下文与内存", icon: "🧠" },
	{ id: "cpu", name: "CPU 与线程", icon: "⚙️" },
	{ id: "gpu", name: "GPU / 加速", icon: "🎮" },
	{ id: "auto_fit", name: "自动适配", icon: "📐" },
	// submenuOrder controls only the display order of submenu blocks in the Configure
	// tab. It is deliberately separate from the FLAGS array order, which determines CLI
	// argument order in buildLaunchArgs() and must not be reordered for presentation.
	{
		id: "sampling",
		name: "采样",
		icon: "🎲",
		submenuOrder: [
			"重复惩罚",
			"DRY 采样",
			"XTC 采样",
			"高级截断",
			"动态温度",
			"Mirostat",
			"采样器顺序",
			"生成控制",
		],
	},
	{ id: "rope", name: "RoPE 缩放", icon: "📏" },
	{ id: "conversation", name: "对话与聊天", icon: "💬" },
	{ id: "lora", name: "LoRA 与控制向量", icon: "🔗" },
	{ id: "kv", name: "KV 缓存", icon: "💾" },
	{ id: "speculative", name: "投机解码", icon: "⚡", submenuOrder: ["Ngram Mod", "Ngram Map K4V"] },
	{ id: "server", name: "服务器设置", icon: "🌐" },
	{ id: "mcp", name: "MCP 设置" },
	{ id: "grammar", name: "语法与约束", icon: "📝" },
	{ id: "logging", name: "日志", icon: "📋" },
	{ id: "advanced", name: "高级", icon: "🔧" },
	{ id: "experimental", name: "实验性", icon: "🧪" },
];
