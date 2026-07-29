const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "api-tab.js"), "utf8");

function createElement(tagName = "div") {
    return {
        tagName: tagName.toUpperCase(),
        children: [],
        className: "",
        textContent: "",
        href: "",
        addEventListener: () => {},
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        set innerHTML(_value) {
            this.children = [];
        },
        get innerHTML() {
            return "";
        },
        querySelectorAll(selector) {
            const matches = [];
            const className = selector.startsWith(".") ? selector.slice(1) : "";
            const stack = [...this.children];
            while (stack.length) {
                const child = stack.shift();
                if (className && String(child.className || "").split(/\s+/).includes(className)) {
                    matches.push(child);
                }
                stack.push(...(child.children || []));
            }
            return matches;
        },
    };
}

const elements = new Map();
const context = {
    window: { LlamaGui: {} },
    document: {
        createElement,
        getElementById: (id) => elements.get(id) || null,
    },
    console,
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: "ui/js/api-tab.js" });

const apiTab = context.window.LlamaGui.apiTab;
let flagValues = {};
let selectedModel = "";
let currentTool = "llama-server";
apiTab.configure({
    flagCore: {
        getFlagValues: () => flagValues,
        getSelectedModel: () => selectedModel,
        getCurrentTool: () => currentTool,
    },
    getLatestStatus: () => ({ running: true }),
});

flagValues = { host: "", port: "bad" };
assert.equal(
    JSON.stringify(apiTab.getServerEndpointConfig()),
    JSON.stringify({ host: "127.0.0.1", port: 8080, baseUrl: "http://127.0.0.1:8080" }),
    "API endpoint config should fall back for blank host and invalid port"
);

flagValues = { host: "::1", port: 8080 };
assert.equal(
    JSON.stringify(apiTab.getServerEndpointConfig()),
    JSON.stringify({ host: "::1", port: 8080, baseUrl: "http://[::1]:8080" }),
    "API endpoint config should bracket IPv6 hosts"
);

flagValues = { host: "pending-host", port: 9999, alias: "pending-alias" };
apiTab.configure({
    getLatestStatus: () => ({
        running: true,
        active_runtime: {
            tool: "llama-server",
            host: "127.0.0.1",
            port: 8123,
            alias: "active-alias",
            model: "active-model.gguf",
        },
    }),
});
assert.equal(
    JSON.stringify(apiTab.getServerEndpointConfig()),
    JSON.stringify({ host: "127.0.0.1", port: 8123, baseUrl: "http://127.0.0.1:8123" }),
    "running API consumers should prefer the backend active-runtime endpoint"
);

flagValues = { host: "0.0.0.0", port: "9099", alias: "primary-alias, backup", api_key: "secret" };
selectedModel = "selected-model.gguf";
currentTool = "llama-server";
apiTab.configure({ getLatestStatus: () => ({ running: true }) });
elements.set("api-base-url", createElement("a"));
elements.set("api-endpoints-list", createElement("div"));
elements.set("api-snippets-list", createElement("div"));
elements.set("api-status-note", createElement("div"));

apiTab.configure({
    getLatestStatus: () => ({
        running: true,
        active_process_tool: "llama-server",
        active_runtime: {
            tool: "llama-server",
            host: "127.0.0.1",
            port: 8123,
            alias: "active-alias",
            model: "active-model.gguf",
        },
    }),
});
apiTab.updateEndpoints();
const activeSnippetsText = elements.get("api-snippets-list").children
    .map((card) => JSON.stringify(card))
    .join("\n");
assert.match(activeSnippetsText, /active-alias/);
assert.doesNotMatch(activeSnippetsText, /primary-alias/);
apiTab.configure({
    getLifecycleSnapshot: () => ({
        phase: "loading",
        activeRuntime: { tool: "llama-server", host: "127.0.0.3", port: 8222, alias: "loading-alias" },
    }),
});
apiTab.updateEndpoints();
assert.match(elements.get("api-status-note").textContent, /temporarily unavailable/);
assert.equal(apiTab.getServerEndpointConfig().baseUrl, "http://127.0.0.3:8222");

apiTab.configure({
    getLatestStatus: () => ({ running: true }),
    getLifecycleSnapshot: () => null,
});
apiTab.updateEndpoints();

assert.equal(elements.get("api-base-url").textContent, "http://0.0.0.0:9099");
assert.match(elements.get("api-status-note").textContent, /API key is configured/);

const endpointText = elements.get("api-endpoints-list").children
    .map((card) => JSON.stringify(card))
    .join("\n");
assert.match(endpointText, /http:\/\/0\.0\.0\.0:9099\/v1\/chat\/completions/);

const snippetsText = elements.get("api-snippets-list").children
    .map((card) => JSON.stringify(card))
    .join("\n");
assert.match(snippetsText, /primary-alias/);
assert.match(snippetsText, /Authorization: Bearer YOUR_API_KEY/);
assert.equal(apiTab.getApiAuthorizationHeaders().Authorization, "Bearer secret");
flagValues.api_key = "first ,second";
assert.equal(apiTab.getApiAuthorizationHeaders().Authorization, "Bearer first ");
flagValues.api_key = '"first,part",second';
assert.equal(apiTab.getApiAuthorizationHeaders().Authorization, "Bearer first,part");
flagValues.api_key = '"first""quoted",second';
assert.equal(apiTab.getApiAuthorizationHeaders().Authorization, 'Bearer first"quoted');
flagValues.api_key = "   ";
assert.equal(apiTab.getApiAuthorizationHeaders().Authorization, "Bearer    ");
assert.equal(
    JSON.stringify(apiTab.parseApiKeyCsv('first ,"second,part",third')),
    JSON.stringify(["first ", "second,part", "third"])
);
assert.ok(!snippetsText.includes("selected-model.gguf"), "API snippets should prefer first alias over selected model");

flagValues.api_key = "pending-secret";
apiTab.configure({ getLatestStatus: () => ({ running: true, active_process_tool: "llama-server", api_auth_configured: false }) });
apiTab.updateEndpoints();
assert.match(elements.get("api-status-note").textContent, /No API key configured/);
apiTab.configure({ getLatestStatus: () => ({ running: true, active_process_tool: "llama-server", api_auth_configured: true }) });
flagValues.api_key = "";
apiTab.updateEndpoints();
assert.match(elements.get("api-status-note").textContent, /API key is configured/);

apiTab.configure({
    getLatestStatus: () => ({
        running: true,
        active_process_tool: "llama-bench",
        external_chat_target: {
            connected: true,
            host: "127.0.0.4",
            port: 8333,
            api_key_configured: false,
        },
    }),
});
apiTab.updateEndpoints();
assert.match(elements.get("api-status-note").textContent, /Connected to a llama-server started outside this GUI/);
assert.doesNotMatch(elements.get("api-status-note").textContent, /endpoints are not available/);
assert.equal(apiTab.getServerEndpointConfig().baseUrl, "http://127.0.0.4:8333");

flagValues = { host: "localhost", port: 8081, alias: "", api_key: "" };
selectedModel = "fallback-model.gguf";
apiTab.configure({ getLatestStatus: () => ({ running: false }) });
apiTab.updateEndpoints();

const fallbackSnippetsText = elements.get("api-snippets-list").children
    .map((card) => JSON.stringify(card))
    .join("\n");
assert.match(fallbackSnippetsText, /fallback-model\.gguf/);
assert.match(fallbackSnippetsText, /no-key-needed/);

console.log("api tab unit tests passed");
