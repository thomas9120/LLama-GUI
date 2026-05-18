(function () {
    window.LlamaGui = window.LlamaGui || {};

    let flagCore = null;
    let copyText = null;
    let getLatestStatus = () => null;

    const API_ENDPOINTS = [
        {
            name: "OpenAI Chat Completions",
            method: "POST",
            path: "/v1/chat/completions",
            compatibility: "OpenAI compatible",
            detail: "Primary chat endpoint used by most OpenAI-compatible clients.",
        },
        {
            name: "OpenAI Completions",
            method: "POST",
            path: "/v1/completions",
            compatibility: "OpenAI compatible",
            detail: "Legacy text completion endpoint.",
        },
        {
            name: "OpenAI Embeddings",
            method: "POST",
            path: "/v1/embeddings",
            compatibility: "OpenAI compatible",
            detail: "Create vector embeddings for retrieval and semantic search.",
        },
        {
            name: "OpenAI Models",
            method: "GET",
            path: "/v1/models",
            compatibility: "OpenAI compatible",
            detail: "Lists available model aliases exposed by llama-server.",
        },
        {
            name: "Health Check",
            method: "GET",
            path: "/health",
            compatibility: "Native llama-server",
            detail: "Quick status probe for monitoring and uptime checks.",
        },
        {
            name: "Web UI",
            method: "GET",
            path: "/",
            compatibility: "Native llama-server",
            detail: "Built-in browser interface.",
        },
    ];

    const API_SNIPPETS = [
        {
            name: "cURL (Chat Completions)",
            language: "bash",
            build: (baseUrl, modelName, hasApiKey) => {
                const lines = [
                    "curl -X POST \"" + baseUrl + "/v1/chat/completions\" \\",
                    "  -H \"Content-Type: application/json\" \\",
                ];
                if (hasApiKey) lines.push("  -H \"Authorization: Bearer YOUR_API_KEY\" \\");
                lines.push("  -d '{");
                lines.push("    \"model\": \"" + modelName + "\",");
                lines.push("    \"messages\": [");
                lines.push("      {\"role\": \"user\", \"content\": \"Write a short hello from llama.cpp\"}");
                lines.push("    ]");
                lines.push("  }'");
                return lines.join("\n");
            },
        },
        {
            name: "Python (OpenAI SDK)",
            language: "python",
            build: (baseUrl, modelName, hasApiKey) => {
                const lines = [
                    "from openai import OpenAI",
                    "",
                    "client = OpenAI(",
                    "    base_url=\"" + baseUrl + "/v1\",",
                ];
                if (hasApiKey) {
                    lines.push("    api_key=\"YOUR_API_KEY\",");
                } else {
                    lines.push("    api_key=\"no-key-needed\",");
                }
                lines.push(")");
                lines.push("");
                lines.push("resp = client.chat.completions.create(");
                lines.push("    model=\"" + modelName + "\",");
                lines.push("    messages=[");
                lines.push("        {\"role\": \"user\", \"content\": \"Explain KV cache in one sentence.\"}");
                lines.push("    ],");
                lines.push(")");
                lines.push("");
                lines.push("print(resp.choices[0].message.content)");
                return lines.join("\n");
            },
        },
        {
            name: "JavaScript (fetch)",
            language: "javascript",
            build: (baseUrl, modelName, hasApiKey) => {
                const headers = [
                    "    \"Content-Type\": \"application/json\",",
                ];
                if (hasApiKey) headers.push("    \"Authorization\": \"Bearer YOUR_API_KEY\"");
                const lines = [
                    "const response = await fetch(\"" + baseUrl + "/v1/chat/completions\", {",
                    "  method: \"POST\",",
                    "  headers: {",
                ];
                lines.push(...headers);
                lines.push("  },");
                lines.push("  body: JSON.stringify({");
                lines.push("    model: \"" + modelName + "\",");
                lines.push("    messages: [");
                lines.push("      { role: \"user\", content: \"Give me 3 bullet points about GGUF.\" }");
                lines.push("    ]");
                lines.push("  })");
                lines.push("});");
                lines.push("");
                lines.push("const data = await response.json();");
                lines.push("console.log(data.choices?.[0]?.message?.content);");
                return lines.join("\n");
            },
        },
        {
            name: "JavaScript (OpenAI SDK)",
            language: "javascript",
            build: (baseUrl, modelName, hasApiKey) => {
                const lines = [
                    "import OpenAI from \"openai\";",
                    "",
                    "const client = new OpenAI({",
                    "  baseURL: \"" + baseUrl + "/v1\",",
                ];
                if (hasApiKey) {
                    lines.push("  apiKey: \"YOUR_API_KEY\"");
                } else {
                    lines.push("  apiKey: \"no-key-needed\"");
                }
                lines.push("});");
                lines.push("");
                lines.push("const resp = await client.chat.completions.create({");
                lines.push("  model: \"" + modelName + "\",");
                lines.push("  messages: [");
                lines.push("    { role: \"user\", content: \"Summarize llama.cpp in 2 lines.\" }");
                lines.push("  ]");
                lines.push("});");
                lines.push("");
                lines.push("console.log(resp.choices[0].message.content);");
                return lines.join("\n");
            },
        },
    ];

    function configure(deps) {
        deps = deps || {};
        flagCore = deps.flagCore || flagCore;
        copyText = deps.copyText || copyText;
        getLatestStatus = deps.getLatestStatus || getLatestStatus;
    }

    function init() {
        const copyBaseBtn = document.getElementById("btn-copy-api-base");
        if (copyBaseBtn) {
            copyBaseBtn.addEventListener("click", () => {
                if (copyText) copyText(getServerBaseUrl());
            });
        }
    }

    function getServerBaseUrl() {
        return getServerEndpointConfig().baseUrl;
    }

    function getServerEndpointConfig() {
        const values = flagCore.getFlagValues();
        const host = String(values.host || "127.0.0.1").trim() || "127.0.0.1";
        const parsedPort = Number(values.port);
        const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
        return {
            host,
            port,
            baseUrl: `http://${host}:${port}`,
        };
    }

    function getPreferredApiModelName() {
        const values = flagCore.getFlagValues();
        const alias = String(values.alias || "").split(",")[0].trim();
        if (alias) return alias;

        const selectedModel = String(flagCore.getSelectedModel() || "").trim();
        if (selectedModel) return selectedModel;

        return "your-model";
    }

    function updateEndpoints() {
        const baseUrl = getServerBaseUrl();
        const modelName = getPreferredApiModelName();
        const baseLink = document.getElementById("api-base-url");
        const list = document.getElementById("api-endpoints-list");
        const snippets = document.getElementById("api-snippets-list");
        const statusNote = document.getElementById("api-status-note");
        if (!baseLink || !list || !statusNote || !snippets) return;

        baseLink.href = baseUrl;
        baseLink.textContent = baseUrl;

        const latestStatus = getLatestStatus();
        const isRunning = !!(latestStatus && latestStatus.running);
        const values = flagCore.getFlagValues();
        const hasApiKey = String(values.api_key || "").trim().length > 0;
        const modeText = flagCore.getCurrentTool() === "llama-server"
            ? "Tool mode is set to llama-server."
            : "Tool mode is set to llama-cli. Switch to llama-server to expose HTTP endpoints.";
        const runningText = isRunning
            ? "Server process appears to be running."
            : "Server process is not running right now.";
        const authText = hasApiKey
            ? "API key is configured. Use `Authorization: Bearer <key>` in clients."
            : "No API key configured. Endpoints are open on this host/port.";
        statusNote.textContent = `${modeText} ${runningText} ${authText}`;

        list.innerHTML = "";
        for (const endpoint of API_ENDPOINTS) {
            const card = document.createElement("div");
            card.className = "api-card";

            const topRow = document.createElement("div");
            topRow.className = "api-card-top";

            const title = document.createElement("div");
            title.className = "api-card-title";
            title.textContent = endpoint.name;

            const meta = document.createElement("div");
            meta.className = "api-card-meta";
            meta.textContent = `${endpoint.method} | ${endpoint.compatibility}`;

            const urlRow = document.createElement("div");
            urlRow.className = "api-url-row";

            const code = document.createElement("code");
            code.textContent = baseUrl + endpoint.path;

            const copyBtn = document.createElement("button");
            copyBtn.className = "btn btn-sm";
            copyBtn.type = "button";
            copyBtn.textContent = "Copy";
            copyBtn.addEventListener("click", () => {
                if (copyText) copyText(baseUrl + endpoint.path);
            });

            const detail = document.createElement("div");
            detail.className = "api-card-detail";
            detail.textContent = endpoint.detail;

            topRow.appendChild(title);
            topRow.appendChild(meta);
            urlRow.appendChild(code);
            urlRow.appendChild(copyBtn);
            card.appendChild(topRow);
            card.appendChild(urlRow);
            card.appendChild(detail);
            list.appendChild(card);
        }

        snippets.innerHTML = "";
        for (const snippet of API_SNIPPETS) {
            const card = document.createElement("div");
            card.className = "api-snippet";

            const top = document.createElement("div");
            top.className = "api-snippet-top";

            const title = document.createElement("div");
            title.className = "api-snippet-title";
            title.textContent = snippet.name;

            const copyBtn = document.createElement("button");
            copyBtn.className = "btn btn-sm";
            copyBtn.type = "button";
            copyBtn.textContent = "Copy";

            const code = document.createElement("code");
            code.textContent = snippet.build(baseUrl, modelName, hasApiKey);

            copyBtn.addEventListener("click", () => {
                if (copyText) copyText(code.textContent || "");
            });

            top.appendChild(title);
            top.appendChild(copyBtn);
            card.appendChild(top);
            card.appendChild(code);
            snippets.appendChild(card);
        }
    }

    window.LlamaGui.apiTab = {
        configure,
        init,
        getServerBaseUrl,
        getServerEndpointConfig,
        getPreferredApiModelName,
        updateEndpoints,
    };
})();
