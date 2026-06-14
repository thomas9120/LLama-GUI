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

flagValues = { host: "0.0.0.0", port: "9099", alias: "primary-alias, backup", api_key: "secret" };
selectedModel = "selected-model.gguf";
currentTool = "llama-server";
elements.set("api-base-url", createElement("a"));
elements.set("api-endpoints-list", createElement("div"));
elements.set("api-snippets-list", createElement("div"));
elements.set("api-status-note", createElement("div"));

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
assert.ok(!snippetsText.includes("selected-model.gguf"), "API snippets should prefer first alias over selected model");

flagValues = { host: "localhost", port: 8081, alias: "", api_key: "" };
selectedModel = "fallback-model.gguf";
apiTab.updateEndpoints();

const fallbackSnippetsText = elements.get("api-snippets-list").children
    .map((card) => JSON.stringify(card))
    .join("\n");
assert.match(fallbackSnippetsText, /fallback-model\.gguf/);
assert.match(fallbackSnippetsText, /no-key-needed/);

console.log("api tab unit tests passed");
