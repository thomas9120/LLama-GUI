const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { character, cardFile } = require("./character_card_fixtures.cjs");
const { FakeLocks } = require("./fake_locks.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const renderingSource = fs.readFileSync(path.join(ROOT, "ui", "js", "chat-rendering.js"), "utf8");
const appDataSource = fs.readFileSync(path.join(ROOT, "ui", "js", "app-data.js"), "utf8");
const chatWindowSource = fs.readFileSync(path.join(ROOT, "ui", "js", "chat-window.js"), "utf8");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "chat-ui.js"), "utf8");

const STORAGE_KEY = "llama_gui_conversations";
const DELETED_STORAGE_KEY = "llama_gui_deleted_conversations";
const PARTIAL_TOKEN = "partial-token";

// --- DOM stub (adapted from chat_rendering_unit.cjs) ---

function createClassList(el) {
    return {
        add: (...names) => {
            for (const name of names) el._classes.add(name);
            el.className = Array.from(el._classes).join(" ");
        },
        remove: (...names) => {
            for (const name of names) el._classes.delete(name);
            el.className = Array.from(el._classes).join(" ");
        },
        contains: (name) => el._classes.has(name),
        toggle: (name, force) => {
            const shouldAdd = force === undefined ? !el._classes.has(name) : !!force;
            if (shouldAdd) el._classes.add(name);
            else el._classes.delete(name);
            el.className = Array.from(el._classes).join(" ");
            return shouldAdd;
        },
    };
}

function createElement(tagName = "div") {
    const el = {
        tagName: tagName.toUpperCase(),
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        _classes: new Set(),
        _className: "",
        _textContent: "",
        _innerHTML: "",
        id: "",
        value: "",
        title: "",
        disabled: false,
        checked: false,
        placeholder: "",
        scrollTop: 0,
        scrollHeight: 0,
        _listeners: {},
        addEventListener(type, handler) {
            this._listeners[type] = this._listeners[type] || [];
            this._listeners[type].push(handler);
        },
        removeEventListener() {},
        setAttribute(name, value) {
            this["attr_" + name] = String(value);
        },
        getAttribute(name) {
            return this["attr_" + name] !== undefined ? this["attr_" + name] : null;
        },
        focus() {},
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        insertBefore(child, before) {
            if (child.parentNode) child.remove();
            child.parentNode = this;
            const index = this.children.indexOf(before);
            if (index === -1) {
                this.children.push(child);
            } else {
                this.children.splice(index, 0, child);
            }
            return child;
        },
        remove() {
            if (!this.parentNode) return;
            this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
            this.parentNode = null;
        },
        closest(selector) {
            if (!selector.startsWith(".")) return null;
            const className = selector.slice(1);
            let node = this;
            while (node) {
                if (node._classes && node._classes.has(className)) return node;
                node = node.parentNode;
            }
            return null;
        },
        querySelector(selector) {
            if (!selector.startsWith(".")) return null;
            const className = selector.slice(1);
            const stack = [...this.children];
            while (stack.length) {
                const child = stack.shift();
                if (child._classes && child._classes.has(className)) return child;
                stack.push(...child.children);
            }
            return null;
        },
        querySelectorAll(selector) {
            if (!selector.startsWith(".")) return [];
            const className = selector.slice(1);
            const matches = [];
            const stack = [...this.children];
            while (stack.length) {
                const child = stack.shift();
                if (child._classes && child._classes.has(className)) matches.push(child);
                stack.push(...child.children);
            }
            return matches;
        },
    };
    Object.defineProperty(el, "className", {
        get() {
            return this._className;
        },
        set(value) {
            this._className = String(value || "");
            this._classes = new Set(this._className.split(/\s+/).filter(Boolean));
        },
    });
    Object.defineProperty(el, "textContent", {
        get() {
            return this._textContent;
        },
        set(value) {
            this._textContent = String(value || "");
        },
    });
    Object.defineProperty(el, "innerHTML", {
        get() {
            return this._innerHTML;
        },
        set(value) {
            this._innerHTML = String(value || "");
            this.children = [];
        },
    });
    el.classList = createClassList(el);
    return el;
}

function findById(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
        const found = findById(child, id);
        if (found) return found;
    }
    return null;
}

// --- fetch stub ---
// mode "hang": first read yields one SSE chunk, the second read stays pending
// until the request's AbortSignal fires, then rejects on a real microtask.
// That ordering is what makes the H2 regression test meaningful: abort() ->
// synchronous reassignment -> later AbortError. A synchronous rejection would
// pass with or without the `await abortActiveStream()` fix and prove nothing.
// mode "complete": chunk, then [DONE], then done.

function makeFetch(mode, hooks = {}) {
    const fetchImpl = (url, options) => {
        const urlString = String(url);
        // Non-stream endpoints get quiet no-op responses so capability probes
        // (and any future sibling fetches) never pollute captured payloads.
        if (urlString.includes("/api/llama/props")) {
            if (hooks.onPropsRequest) return hooks.onPropsRequest();
            if (hooks.propsResponse === undefined) {
                return Promise.resolve({ ok: false, status: 404 });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(hooks.propsResponse),
            });
        }
        if (!urlString.includes("/api/chat/completions")) {
            return Promise.resolve({ ok: false, status: 404 });
        }
        if (hooks.onRequest) {
            let parsedBody = null;
            try {
                parsedBody = JSON.parse(options.body);
            } catch (e) {
                console.debug("chat_ui_unit: could not parse request body", e);
            }
            hooks.onRequest(parsedBody);
        }
        if (mode === "network") return Promise.reject(new Error("Connection lost"));
        if (mode === "http") return Promise.resolve({ ok: false, status: 503, text: async () => "Unavailable" });
        if (mode === "empty-body") return Promise.resolve({ ok: true, body: null });
        const encoder = new TextEncoder();
        const chunk = encoder.encode(
            hooks.chunk === undefined ? 'data: {"choices":[{"delta":{"content":"' + PARTIAL_TOKEN + '"}}]}\n\n' : hooks.chunk
        );
        const doneChunk = encoder.encode("data: [DONE]\n\n");
        let reads = 0;
        const reader = {
            read() {
                reads += 1;
                if (reads === 1) return Promise.resolve({ done: false, value: chunk });
                if (mode === "fail") return Promise.reject(new Error("Connection lost"));
                if (mode === "eof") return Promise.resolve({ done: true });
                if (mode === "error") return Promise.resolve({ done: false, value: encoder.encode('data: {"error":{"message":"<script>failure</script>"}}\n\n') });
                if (mode === "complete") {
                    if (reads === 2) return Promise.resolve({ done: false, value: doneChunk });
                    return Promise.resolve({ done: true, value: undefined });
                }
                return new Promise((_resolve, reject) => {
                    if (hooks.onStreamPending) hooks.onStreamPending();
                    const signal = options && options.signal;
                    const fail = () => {
                        // Reject on a later microtask, not synchronously.
                        Promise.resolve().then(() => {
                            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
                        });
                    };
                    if (!signal) return;
                    if (signal.aborted) fail();
                    else signal.addEventListener("abort", fail, { once: true });
                });
            },
            cancel() {
                return hooks.onCancel ? hooks.onCancel() : Promise.resolve();
            },
        };
        return Promise.resolve({
            ok: true,
            status: 200,
            body: { getReader: () => reader },
        });
    };
    return fetchImpl;
}

// --- context ---

function makeContext({
    fetchImpl,
    seedConversations = [],
    seedDeletedConversations = [],
    flagValues = {},
    status,
    storageMode = "normal",
    confirmImpl = async () => true,
    extraElementIds = [],
    sharedStorageMap = null,
    loadChatWindow = false,
}) {
    const elements = new Map();
    const storageMap = sharedStorageMap || new Map();
    if (seedConversations.length) {
        storageMap.set(STORAGE_KEY, JSON.stringify(seedConversations));
    }
    if (seedDeletedConversations.length) {
        storageMap.set(DELETED_STORAGE_KEY, JSON.stringify(seedDeletedConversations));
    }

    const addElement = (id) => {
        const el = createElement("div");
        el.id = id;
        elements.set(id, el);
        return el;
    };
    for (const id of [
        "chat-input",
        "chat-system-prompt",
        "chat-sys-char-count",
        "chat-messages",
        "chat-empty",
        "chat-history-list",
        "chat-thinking-effort",
        "chat-thinking-effort-cap-hint",
        "chat-slider-temp",
        "chat-val-temp",
        "chat-slider-max-tokens",
        "chat-val-max-tokens",
        ...extraElementIds,
    ]) {
        addElement(id);
    }
    elements.get("chat-thinking-effort").value = "auto";

    const documentStub = {
        createElement,
        getElementById: (id) => {
            if (elements.has(id)) return elements.get(id);
            for (const root of elements.values()) {
                const found = findById(root, id);
                if (found) return found;
            }
            return null;
        },
    };

    // "throw" simulates a browser with storage blocked entirely (e.g. "block
    // all cookies"), where every localStorage access raises.
    const localStorageStub = storageMode === "throw"
        ? {
            getItem: () => { throw new Error("storage is blocked"); },
            setItem: () => { throw new Error("storage is blocked"); },
            removeItem: () => { throw new Error("storage is blocked"); },
        }
        : {
            getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
            setItem: storageMode === "fail-set"
                ? () => { throw new Error("storage write failed"); }
                : (key, value) => storageMap.set(key, String(value)),
            removeItem: (key) => storageMap.delete(key),
        };

    const context = {
        // Must be set before chat-ui.js is evaluated: the _test* hooks are only
        // attached to the namespace when this opt-in flag is present.
        window: {
            LlamaGui: {}, __LLAMA_GUI_TEST_HOOKS__: true,
            location: { origin: "http://127.0.0.1:5240" }, isSecureContext: true,
            console, addEventListener() {}, removeEventListener() {},
        },
        document: documentStub,
        localStorage: localStorageStub,
        fetch: fetchImpl,
        AbortController,
        TextDecoder,
        TextEncoder,
        URL,
        crypto,
        // Blocked storage logs the expected tolerant-path warnings on every
        // access; keep the suite output readable.
        console: storageMode === "throw"
            ? { ...console, debug: () => {}, warn: () => {} }
            : console,
        Date,
        clearTimeout: loadChatWindow ? clearTimeout : () => {},
        setTimeout: loadChatWindow ? setTimeout : (handler) => {
            handler();
            return 1;
        },
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(renderingSource, context, { filename: "ui/js/chat-rendering.js" });
    vm.runInContext(appDataSource, context, { filename: "ui/js/app-data.js" });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/chat-tools.js"), "utf8"), context, { filename: "ui/js/chat-tools.js" });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/chat-compaction.js"), "utf8"), context, { filename: "ui/js/chat-compaction.js" });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/character-cards.js"), "utf8"), context, { filename: "ui/js/character-cards.js" });
    vm.runInContext(source, context, { filename: "ui/js/chat-ui.js" });
    if (loadChatWindow) vm.runInContext(chatWindowSource, context, { filename: "ui/js/chat-window.js" });

    const api = context.window.LlamaGui.chatUi;
    const mutable = {
        flagValues,
        status: status === undefined ? {
            running: true,
            active_process_tool: "llama-server",
            active_runtime: { tool: "llama-server", model: "test-model" },
        } : status,
    };
    api.configure({
        flagCore: {
            getFlagValues: () => mutable.flagValues,
            getSelectedModel: () => "test-model",
            setFlagValue: () => {},
        },
        confirmAction: confirmImpl,
        getLatestStatus: () => mutable.status,
        getLifecycleSnapshot: () => mutable.lifecycle || null,
        snapshotStatsBaseline: () => {},
        getApiAuthorizationHeaders: (headers) => headers,
        switchTab: () => {},
    });

    const getStoredConversations = () => JSON.parse(storageMap.get(STORAGE_KEY) || "[]");
    const getStoredDeletedConversations = () => JSON.parse(storageMap.get(DELETED_STORAGE_KEY) || "[]");
    return {
        api,
        window: context.window,
        chatWindow: context.window.LlamaGui.chatWindow,
        tools: context.window.LlamaGui.chatTools,
        elements,
        getStoredConversations,
        getStoredDeletedConversations,
        setFlagValues: (values) => { mutable.flagValues = values; },
        setStatus: (value) => { mutable.status = value; },
        setLifecycle: (value) => { mutable.lifecycle = value; },
    };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

class IntegrationRecoveryStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
}

// flush() never blocks the event loop, so an unbounded wait on a condition that
// can no longer become true would spin forever instead of failing the suite.
async function flushUntil(predicate, description, maxTicks = 1000) {
    for (let tick = 0; tick < maxTicks; tick += 1) {
        if (predicate()) return;
        await flush();
    }
    throw new Error(`timed out after ${maxTicks} ticks waiting for ${description}`);
}

// Values returned from the vm context carry the vm realm's Array/Object
// prototypes, which fail assert.deepEqual's reference checks. Normalize
// through JSON before comparing (storage reads are already host-side parses).
const plain = (value) => JSON.parse(JSON.stringify(value));

// Starts a message, waits until the stream is hung on its pending second read,
// then runs the given conversation-switching action and returns both promises.
async function runAbortScenario(action) {
    let streamPending = false;
    const { api, getStoredConversations } = makeContext({
        fetchImpl: makeFetch("hang", { onStreamPending: () => { streamPending = true; } }),
        seedConversations: [{
            id: "convo-b",
            title: "B",
            messages: [{ role: "user", content: "B question" }],
            systemPrompt: "",
            timestamp: Date.now(),
        }],
    });

    const sendPromise = api._testSendMessage("hello");
    await flushUntil(() => streamPending, "the stream to hang on its pending second read");
    await action(api);
    await sendPromise;
    return { api, getStoredConversations };
}

(async () => {
    // Happy path first: proves the harness itself streams and persists correctly.
    {
        const { api, elements, getStoredConversations } = makeContext({ fetchImpl: makeFetch("complete") });
        await api._testSendMessage("hello");
        const state = api._testGetState();
        assert.equal(state.chatStreaming, false);
        assert.deepEqual(plain(state.chatMessages).map((m) => [m.role, m.content]), [
            ["user", "hello"],
            ["assistant", PARTIAL_TOKEN],
        ]);
        const stored = getStoredConversations();
        assert.equal(stored.length, 1);
        assert.deepEqual(stored[0].messages.map((m) => [m.role, m.content]), [
            ["user", "hello"],
            ["assistant", PARTIAL_TOKEN],
        ]);
        const userBubble = elements.get("chat-messages").querySelectorAll(".chat-message")
            .find(element => element._classes.has("user"));
        assert.equal(userBubble.querySelector(".chat-response-action").textContent, "Edit and resend");
    }

    // H2: switching to a stored conversation mid-stream must not finalize the
    // aborted reply into the conversation being loaded.
    {
        const { api, getStoredConversations } = await runAbortScenario((api) =>
            api._testLoadConversation("convo-b")
        );
        const state = api._testGetState();
        assert.equal(state.currentConversationId, "convo-b");
        assert.deepEqual(
            plain(state.chatMessages),
            [{ role: "user", content: "B question" }],
            "loaded conversation must not gain the aborted reply"
        );
        const stored = getStoredConversations();
        const convoB = stored.find((c) => c.id === "convo-b");
        assert.deepEqual(
            convoB.messages,
            [{ role: "user", content: "B question" }],
            "stored conversation must not gain the aborted reply"
        );
        const oldConvo = stored.find((c) => c.id !== "convo-b");
        assert.ok(oldConvo, "the aborted exchange should be preserved as its own conversation");
        assert.deepEqual(oldConvo.messages.map((m) => [m.role, m.content]), [
            ["user", "hello"],
            ["assistant", PARTIAL_TOKEN],
        ]);
    }

    // H2: starting a new chat mid-stream must not leak the aborted reply into
    // the fresh chat; the old exchange stays saved on its own.
    {
        const { api, getStoredConversations } = await runAbortScenario((api) =>
            api._testStartNewChat()
        );
        const state = api._testGetState();
        assert.equal(state.currentConversationId, null);
        assert.deepEqual(plain(state.chatMessages), [], "new chat must stay empty after the abort settles");
        const stored = getStoredConversations();
        const oldConvo = stored.find((c) => c.id !== "convo-b");
        assert.ok(oldConvo, "the aborted exchange should be preserved before clearing");
        assert.deepEqual(oldConvo.messages.map((m) => [m.role, m.content]), [
            ["user", "hello"],
            ["assistant", PARTIAL_TOKEN],
        ]);
    }

    // H2: clearing mid-stream must leave an empty chat and no resurrected
    // partial reply in storage.
    {
        const { api, getStoredConversations } = await runAbortScenario((api) =>
            api._testClearChat()
        );
        const state = api._testGetState();
        assert.equal(state.currentConversationId, null);
        assert.deepEqual(plain(state.chatMessages), [], "cleared chat must stay empty after the abort settles");
        const stored = getStoredConversations();
        assert.ok(
            !JSON.stringify(stored).includes(PARTIAL_TOKEN),
            "cleared conversation must not reappear in storage with the aborted reply"
        );
        assert.deepEqual(
            stored.find((c) => c.id === "convo-b").messages,
            [{ role: "user", content: "B question" }],
            "unrelated stored conversations must stay untouched"
        );
    }

    // H2 (read-after-abort ordering): reloading the conversation that is itself
    // streaming must not restore a snapshot taken before the abort settled, or
    // the finalized turn is dropped on the next save.
    {
        let streamPending = false;
        const { api, getStoredConversations } = makeContext({
            fetchImpl: makeFetch("hang", { onStreamPending: () => { streamPending = true; } }),
            seedConversations: [{
                id: "convo-b",
                title: "B",
                messages: [{ role: "user", content: "B question" }],
                systemPrompt: "",
                timestamp: Date.now(),
            }],
        });
        await api._testLoadConversation("convo-b");
        const sendPromise = api._testSendMessage("hello");
        await flushUntil(() => streamPending, "the stream to hang on its pending second read");
        await api._testLoadConversation("convo-b");
        await sendPromise;

        const state = api._testGetState();
        assert.equal(state.currentConversationId, "convo-b");
        const stored = getStoredConversations().find((c) => c.id === "convo-b");
        assert.deepEqual(
            plain(state.chatMessages).map((m) => [m.role, m.content]),
            stored.messages.map((m) => [m.role, m.content]),
            "reloading the streaming conversation must not desync memory from storage"
        );
        assert.deepEqual(stored.messages.map((m) => [m.role, m.content]), [
            ["user", "B question"],
            ["user", "hello"],
            ["assistant", PARTIAL_TOKEN],
        ]);
    }

    // Empty-string sampler values (from a cleared Configure input) must not be
    // sent to the backend, and the payload must not carry dead host/port fields.
    {
        const payloads = [];
        const { api } = makeContext({
            fetchImpl: makeFetch("complete", { onRequest: (body) => payloads.push(body) }),
            flagValues: {
                temperature: "",
                top_p: 0.9,
                top_k: "",
                min_p: "",
                repeat_penalty: "",
                n_predict: "",
            },
        });
        await api._testSendMessage("hello");
        assert.equal(payloads.length, 1);
        const body = payloads[0];
        assert.equal(body.top_p, 0.9, "set sampler values still go through");
        for (const key of ["temperature", "top_k", "min_p", "repeat_penalty", "max_tokens"]) {
            assert.ok(!(key in body), `empty-string sampler "${key}" must be omitted from the payload`);
        }
        assert.ok(!("host" in body), "payload must not carry a dead host field");
        assert.ok(!("port" in body), "payload must not carry a dead port field");
    }

    // Sampler values arriving as numeric strings (imported presets are copied
    // verbatim) must be coerced, so the disable sentinels compare equal to their
    // numeric forms and non-finite values never reach llama-server.
    {
        const payloads = [];
        const { api } = makeContext({
            fetchImpl: makeFetch("complete", { onRequest: (body) => payloads.push(body) }),
            flagValues: {
                temperature: "0.7",
                top_p: 0.9,
                top_k: "0",
                min_p: NaN,
                repeat_penalty: "1.0",
                n_predict: "-1",
            },
        });
        await api._testSendMessage("hello");
        const body = payloads[0];
        assert.strictEqual(body.temperature, 0.7, "numeric strings must be coerced to numbers");
        assert.strictEqual(body.top_p, 0.9);
        assert.equal(body.top_k, 0, "disabling Top K must override the server default");
        assert.equal(body.repeat_penalty, 1, "disabling repetition penalties must override the server default");
        assert.ok(!("max_tokens" in body), "unlimited output still uses the server limit");
        assert.ok(!("min_p" in body), "NaN must be omitted rather than serialized as null");
    }
    {
        // Non-numeric junk must be dropped, not forwarded for the server to reject.
        const payloads = [];
        const { api } = makeContext({
            fetchImpl: makeFetch("complete", { onRequest: (body) => payloads.push(body) }),
            flagValues: { temperature: "abc", top_p: 0.9 },
        });
        await api._testSendMessage("hello");
        assert.ok(!("temperature" in payloads[0]), "non-numeric sampler value must be omitted");
        assert.strictEqual(payloads[0].top_p, 0.9, "valid neighbours still go through");
    }

    // Effort levels go out as top-level reasoning_effort (native since
    // llama.cpp b10434, final precedence) with the nested chat_template_kwargs
    // copy retained as the older-build fallback. Auto must stay absent so
    // models without compatible template variables keep their defaults.
    {
        const payloads = [];
        const { api, elements, getStoredConversations } = makeContext({
            fetchImpl: makeFetch("complete", { onRequest: (body) => payloads.push(body) }),
        });
        await api._testSendMessage("auto");
        assert.ok(!("chat_template_kwargs" in payloads[0]), "Auto must omit template kwargs");
        assert.ok(!("reasoning_effort" in payloads[0]), "Auto must omit top-level reasoning_effort");

        await api._testStartNewChat();
        elements.get("chat-thinking-effort").value = "medium";
        await api._testSendMessage("think");
        assert.equal(payloads[1].reasoning_effort, "medium");
        assert.deepEqual(payloads[1].chat_template_kwargs, {
            enable_thinking: true,
            reasoning_effort: "medium",
        });
        assert.equal(getStoredConversations()[0].thinkingEffort, "medium");

        await api._testStartNewChat();
        assert.equal(elements.get("chat-thinking-effort").value, "auto", "new chats reset to Auto");
        elements.get("chat-thinking-effort").value = "high";
        await api._testSendMessage("deeper");
        assert.equal(payloads[2].reasoning_effort, "high");
        assert.deepEqual(payloads[2].chat_template_kwargs, {
            enable_thinking: true,
            reasoning_effort: "high",
        });

        await api._testStartNewChat();
        elements.get("chat-thinking-effort").value = "off";
        await api._testSendMessage("direct");
        assert.equal(payloads[3].reasoning_effort, "none");
        assert.deepEqual(payloads[3].chat_template_kwargs, {
            enable_thinking: false,
            reasoning_effort: "none",
        });
    }

    // Preserved reasoning must return to llama-server as reasoning_content, and
    // loading a conversation must restore its per-chat effort selection.
    {
        const payloads = [];
        const { api, elements } = makeContext({
            fetchImpl: makeFetch("complete", { onRequest: (body) => payloads.push(body) }),
            seedConversations: [{
                id: "reasoning-chat",
                title: "Reasoning",
                messages: [
                    { role: "user", content: "question" },
                    { role: "assistant", content: "answer", reasoning: "hidden trace" },
                ],
                systemPrompt: "",
                thinkingEffort: "low",
                timestamp: Date.now(),
            }],
        });
        await api._testLoadConversation("reasoning-chat");
        assert.equal(elements.get("chat-thinking-effort").value, "low");
        await api._testSendMessage("follow up");
        const assistant = payloads[0].messages.find((message) => message.role === "assistant");
        assert.equal(assistant.reasoning_content, "hidden trace");
        assert.equal(payloads[0].reasoning_effort, "low");
        assert.deepEqual(payloads[0].chat_template_kwargs, {
            enable_thinking: true,
            reasoning_effort: "low",
        });
    }

    // /props template-capability hint: an unsupported template earns an
    // explanatory warning; a supported (or silent) template hides it.
    {
        const unsupported = makeFetch("complete", {
            propsResponse: { chat_template_caps: { supports_reasoning_effort: false } },
        });
        const { api, elements } = makeContext({ fetchImpl: unsupported });
        const hint = elements.get("chat-thinking-effort-cap-hint");
        await api.refreshTemplateCaps();
        await flushUntil(() => hint.textContent !== "", "cap hint renders for unsupported template");
        assert.ok(!hint.classList.contains("hidden"), "unsupported template shows the hint");

        const supported = makeFetch("complete", {
            propsResponse: { chat_template_caps: { supports_reasoning_effort: true } },
        });
        const supportedContext = makeContext({ fetchImpl: supported });
        const supportedHint = supportedContext.elements.get("chat-thinking-effort-cap-hint");
        await supportedContext.api.refreshTemplateCaps();
        await flush();
        await flush();
        assert.equal(supportedHint.textContent, "", "supported template leaves the hint empty");
        assert.ok(supportedHint.classList.contains("hidden"), "supported template keeps the hint hidden");

        let attempts = 0;
        const retrying = makeFetch("complete", {
            onPropsRequest: () => {
                attempts += 1;
                if (attempts === 1) return Promise.resolve({ ok: false, status: 502 });
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        chat_template_caps: { supports_reasoning_effort: false },
                    }),
                });
            },
        });
        const retryContext = makeContext({ fetchImpl: retrying });
        await retryContext.api.refreshTemplateCaps();
        await retryContext.api.refreshTemplateCaps();
        assert.equal(attempts, 2, "a failed capability probe must remain retryable");
        assert.ok(!retryContext.elements.get("chat-thinking-effort-cap-hint").classList.contains("hidden"));

        const oldProbe = deferred();
        const newProbe = deferred();
        let probeCount = 0;
        const delayed = makeFetch("complete", {
            onPropsRequest: () => (++probeCount === 1 ? oldProbe.promise : newProbe.promise),
        });
        const staleContext = makeContext({
            fetchImpl: delayed,
            status: {
                running: true,
                active_process_tool: "llama-server",
                runtime_generation: 1,
            },
        });
        const staleHint = staleContext.elements.get("chat-thinking-effort-cap-hint");
        const oldRefresh = staleContext.api.refreshTemplateCaps();
        staleContext.setStatus({
            running: true,
            active_process_tool: "llama-server",
            runtime_generation: 2,
        });
        const newRefresh = staleContext.api.refreshTemplateCaps();
        newProbe.resolve({
            ok: true,
            json: () => Promise.resolve({ chat_template_caps: { supports_reasoning_effort: true } }),
        });
        await newRefresh;
        oldProbe.resolve({
            ok: true,
            json: () => Promise.resolve({ chat_template_caps: { supports_reasoning_effort: false } }),
        });
        await oldRefresh;
        assert.equal(staleHint.textContent, "", "an older generation must not overwrite the current hint");
        assert.ok(staleHint.classList.contains("hidden"));
    }

    // Stop clears the lifecycle runtime before the shared status poll catches up.
    // That stale running status must not restart props requests or unlock Chat.
    {
        let propsRequests = 0;
        const { api, elements, setStatus, setLifecycle } = makeContext({
            fetchImpl: makeFetch("complete", {
                onPropsRequest: () => {
                    propsRequests += 1;
                    return Promise.resolve({ ok: true, json: async () => ({}) });
                },
            }),
            extraElementIds: ["chat-status-badge", "chat-no-server-badge"],
        });
        let lifecycle = {
            phase: "running", ready: true,
            activeRuntime: { tool: "llama-server", generation: 1 },
        };
        setLifecycle(lifecycle);
        await api.refreshTemplateCaps();
        assert.equal(propsRequests, 1);

        lifecycle = { ...lifecycle, phase: "stopping", ready: false };
        setLifecycle(lifecycle);
        api.updateStatusBadge();
        lifecycle = { phase: "idle", ready: false, activeRuntime: null };
        setLifecycle(lifecycle);
        api.updateStatusBadge();
        await api.refreshTemplateCaps();
        assert.equal(propsRequests, 1, "stale running status must not probe the stopped server");
        assert.equal(elements.get("chat-input").disabled, true, "Chat stays disabled after Stop");

        setStatus({ running: false, external_chat_target: { connected: true } });
        api.updateStatusBadge();
        await api.refreshTemplateCaps();
        assert.equal(propsRequests, 2, "an external server remains usable with an idle lifecycle");
        assert.equal(elements.get("chat-input").disabled, false);
    }

    // Regeneration without a matching user turn must leave history intact.
    {
        // a) malformed adjacent assistant turns are preserved, not deleted.
        const fetchImpl = makeFetch("complete");
        let fetchCalls = 0;
        const countingFetch = (...args) => {
            fetchCalls += 1;
            return fetchImpl(...args);
        };
        const { api, getStoredConversations } = makeContext({
            fetchImpl: countingFetch,
            seedConversations: [{
                id: "convo-b",
                title: "B",
                messages: [
                    { role: "user", content: "q" },
                    { role: "assistant", content: "a1" },
                    { role: "assistant", content: "a2" },
                ],
                systemPrompt: "",
                timestamp: Date.now(),
            }],
        });
        await api._testLoadConversation("convo-b");
        api._testRegenerateResponse();
        assert.deepEqual(
            plain(api._testGetState().chatMessages).map((m) => m.content),
            ["q", "a1", "a2"],
            "invalid regeneration leaves in-memory messages intact"
        );
        assert.deepEqual(
            getStoredConversations()[0].messages.map((m) => m.content),
            ["q", "a1", "a2"],
            "stored conversation is unchanged"
        );
        assert.equal(fetchCalls, 0, "no regeneration request without a trailing user message");
    }
    {
        // b) an orphan response is never deleted by Regenerate.
        const { api, elements, getStoredConversations } = makeContext({
            fetchImpl: makeFetch("complete"),
            seedConversations: [{
                id: "convo-b",
                title: "B",
                messages: [{ role: "assistant", content: "orphan" }],
                systemPrompt: "",
                timestamp: Date.now(),
            }],
        });
        await api._testLoadConversation("convo-b");
        api._testRegenerateResponse();
        const state = api._testGetState();
        assert.deepEqual(plain(state.chatMessages), [{ role: "assistant", content: "orphan" }]);
        assert.equal(state.currentConversationId, "convo-b");
        assert.equal(getStoredConversations().length, 1, "orphan response stays saved");
        assert.equal(elements.get("chat-empty").style.display, "none");
    }
    {
        // c) control: a normal regenerate resends the last user message.
        const { api, getStoredConversations } = makeContext({
            fetchImpl: makeFetch("complete"),
            seedConversations: [{
                id: "convo-b",
                title: "B",
                messages: [
                    { role: "user", content: "hi" },
                    { role: "assistant", content: "stale" },
                ],
                systemPrompt: "",
                timestamp: Date.now(),
            }],
        });
        await api._testLoadConversation("convo-b");
        api._testRegenerateResponse();
        await flush();
        await flush();
        const messages = plain(api._testGetState().chatMessages);
        assert.deepEqual(messages.map((m) => [m.role, m.content]), [
            ["user", "hi"],
            ["assistant", PARTIAL_TOKEN],
        ]);
        assert.deepEqual(
            getStoredConversations()[0].messages.map((m) => [m.role, m.content]),
            [["user", "hi"], ["assistant", PARTIAL_TOKEN]],
            "regenerated reply replaces the stale one in storage"
        );
    }

    // M4: with storage blocked, init() must not throw before the primary
    // button handlers are wired, and storage-touching controls must keep
    // working on session defaults.
    {
        const { api, elements } = makeContext({
            fetchImpl: makeFetch("complete"),
            storageMode: "throw",
            extraElementIds: [
                "btn-chat-send",
                "btn-chat-stop",
                "btn-chat-undo",
                "btn-chat-regenerate",
                "btn-chat-focus",
                "chat-sidebar",
                "btn-collapse-sidebar",
                "btn-open-sidebar",
                "chat-history-panel",
                "btn-collapse-history",
                "btn-open-history",
                "chat-web-search-toggle",
                "chat-web-search-max-results",
            ],
        });

        assert.doesNotThrow(() => api.init(), "init() must survive blocked localStorage");

        for (const id of ["btn-chat-send", "btn-chat-stop", "btn-chat-undo", "btn-chat-regenerate"]) {
            const listeners = elements.get(id)._listeners.click || [];
            assert.ok(listeners.length > 0, `${id} must stay wired when storage is blocked`);
        }

        // Controls that persist their state must not throw when storage is
        // blocked; they just lose persistence for the session.
        const webSearchToggle = elements.get("chat-web-search-toggle");
        webSearchToggle.checked = true;
        assert.doesNotThrow(() => webSearchToggle._listeners.change.forEach((handler) => handler()));
        const maxResults = elements.get("chat-web-search-max-results");
        maxResults.value = "7";
        assert.doesNotThrow(() => maxResults._listeners.change.forEach((handler) => handler()));
        assert.doesNotThrow(() => elements.get("btn-collapse-sidebar")._listeners.click.forEach((handler) => handler()));
        assert.doesNotThrow(() => elements.get("btn-open-history")._listeners.click.forEach((handler) => handler()));
        assert.equal(elements.get("chat-history-panel").inert, false);
        assert.doesNotThrow(() => elements.get("btn-collapse-history")._listeners.click.forEach((handler) => handler()));
        assert.equal(elements.get("chat-history-panel").inert, true);
    }

    // Sidebar sliders: empty or non-numeric flag values must fall back to the
    // slider defaults instead of going stale or rendering NaN.
    {
        const { api, elements, setFlagValues } = makeContext({ fetchImpl: makeFetch("complete") });
        const slider = elements.get("chat-slider-temp");
        const display = elements.get("chat-val-temp");

        setFlagValues({ temperature: 0.5 });
        api.refreshSidebarUI();
        assert.equal(display.textContent, "0.50");
        assert.equal(Number(slider.value), 0.5);

        setFlagValues({ temperature: "" });
        api.refreshSidebarUI();
        assert.equal(display.textContent, "0.80", "cleared value must fall back to the default, not stay stale");
        assert.equal(Number(slider.value), 0.8);

        setFlagValues({ temperature: "abc" });
        api.refreshSidebarUI();
        assert.equal(display.textContent, "0.80", "non-numeric value must fall back to the default, not NaN");
        assert.ok(!display.textContent.includes("NaN"));

        const maxTokensSlider = elements.get("chat-slider-max-tokens");
        const maxTokensDisplay = elements.get("chat-val-max-tokens");
        setFlagValues({ n_predict: "abc" });
        api.refreshSidebarUI();
        assert.equal(maxTokensDisplay.textContent, "Server default", "non-numeric n_predict is omitted from requests");
        assert.equal(Number(maxTokensSlider.value), -1);

        setFlagValues({ n_predict: "-1" });
        api.refreshSidebarUI();
        assert.equal(maxTokensDisplay.textContent, "Server default", "the -1 sentinel inherits the server limit");
        assert.equal(Number(maxTokensSlider.value), -1);

        setFlagValues({ n_predict: "2048" });
        api.refreshSidebarUI();
        assert.equal(maxTokensDisplay.textContent, "2048", "numeric-string n_predict must render as a number");
        assert.equal(Number(maxTokensSlider.value), 2048);
    }

    // Display and wire values agree for inherited limits, small values, and
    // values above the configured context / former slider cap.
    for (const value of [undefined, "", "abc", -1, "-1", 0, 17, "2049", 200000]) {
        let payload;
        const { api, elements } = makeContext({
            flagValues: { n_predict: value, ctx_size: 1024 },
            fetchImpl: makeFetch("complete", { onRequest: (body) => { payload = body; } }),
        });
        api.refreshSidebarUI();
        await api._testSendMessage("check limit");
        const expected = [undefined, "", "abc", -1, "-1"].includes(value) ? undefined : Number(value);
        assert.equal(payload.max_tokens, expected);
        const label = expected === undefined ? "Server default" : String(expected);
        assert.equal(elements.get("chat-val-max-tokens").textContent, label);
        const slider = elements.get("chat-slider-max-tokens");
        assert.equal(Number(slider.value), expected === undefined ? -1 : expected);
        assert.equal(slider.getAttribute("aria-valuetext"), label);
        assert.ok(Number(slider.max) >= Number(slider.value));
    }

    // Saved sources are restored through the safe source renderer; legacy
    // conversations without sources continue to load.
    {
        const { api, elements } = makeContext({
            fetchImpl: makeFetch("complete"),
            seedConversations: [{ id: "sources", messages: [
                { role: "user", content: "question" },
                { role: "assistant", content: "answer", sources: [
                    { index: 1, title: "Reference", url: "https://example.com/reference" },
                    { index: 2, title: "Unsafe", url: "javascript:alert(1)" },
                ] },
                { role: "assistant", content: "legacy answer" },
            ] }],
        });
        await api._testLoadConversation("sources");
        const chips = elements.get("chat-messages").querySelectorAll(".chat-source-chip");
        assert.equal(chips.length, 2);
        assert.equal(chips[0].tagName, "A");
        assert.equal(chips[0].href, "https://example.com/reference");
        assert.equal(chips[0].textContent, "[1] Reference");
        assert.equal(chips[1].tagName, "SPAN");
        assert.equal(chips[1].href, undefined);
    }

    // Every failure preserves the user prompt and any partial answer across
    // reload. Retry sends the original prompt once and preserves the draft.
    for (const failure of ["network", "http", "empty-body", "fail", "eof", "error"]) {
        let mode = failure;
        const requests = [];
        const { api, elements, getStoredConversations } = makeContext({
            fetchImpl: (...args) => makeFetch(mode, { onRequest: body => requests.push(body) })(...args),
        });
        await api._testSendMessage("keep my prompt");
        const convo = getStoredConversations()[0];
        assert.equal(convo.messages.length, 2, failure);
        const failed = convo.messages[1];
        assert.equal(failed.status, "failed", failure);
        assert.equal(failed.content, ["fail", "eof", "error"].includes(failure) ? PARTIAL_TOKEN : "");
        assert.ok(!failed.content.includes("failure"), "error text must not become model context");
        await api._testLoadConversation(convo.id);
        const container = elements.get("chat-messages");
        const retry = container.querySelectorAll(".chat-response-action").find(el => el.textContent === "Retry");
        assert.ok(retry, `${failure} offers Retry after reload`);
        assert.match(container.querySelector(".chat-response-status").textContent, /Incomplete/);
        elements.get("chat-input").value = "unsent draft";
        mode = "complete";
        await retry._listeners.click[0]();
        assert.equal(elements.get("chat-input").value, "unsent draft", "retry must not clear the next draft");
        assert.deepEqual(requests[1].messages, [{ role: "user", content: "keep my prompt" }]);
        const recovered = getStoredConversations()[0].messages;
        assert.equal(recovered.length, 2);
        assert.equal(recovered[1].status, "complete");
        assert.equal(recovered[1].versions[0].status, "failed", "failed attempt remains recoverable");
    }

    // Regeneration is transactional: original remains visible and saved during
    // the attempt, and failure or cancellation keeps it selected.
    for (const failure of ["network", "http", "empty-body", "fail", "eof", "error", "hang"]) {
        let mode = "complete";
        let streamPending = false;
        const requests = [];
        const { api, elements, getStoredConversations, setStatus } = makeContext({
            fetchImpl: (...args) => makeFetch(mode, {
                onRequest: body => requests.push(body),
                onStreamPending: () => { streamPending = true; },
            })(...args),
            seedConversations: [{ id: "original", messages: [
                { role: "user", content: "question" },
                { role: "assistant", content: "original answer", reasoning: "original reasoning",
                    sources: [{ index: 1, title: "Original source", url: "https://example.com" }] },
            ] }],
        });
        await api._testLoadConversation("original");
        setStatus({ running: false });
        await api._testRegenerateResponse();
        assert.equal(requests.length, 0, "offline regeneration must be a no-op");
        setStatus({ running: true, active_process_tool: "llama-server" });
        mode = failure;
        const pending = api._testRegenerateResponse();
        await api._testRegenerateResponse();
        assert.equal(requests.length, 1, "repeated clicks must not start a second regeneration");
        assert.equal(getStoredConversations()[0].messages[1].content, "original answer");
        assert.ok(elements.get("chat-messages").querySelectorAll(".chat-bubble").some(el => el.dataset.rawText === "original answer"));
        if (failure === "hang") {
            await flushUntil(() => streamPending, "regeneration to stream");
            await api.abortActiveStream();
        }
        await pending;
        let result = getStoredConversations()[0].messages[1];
        assert.equal(result.content, "original answer", failure);
        assert.equal(result.reasoning, "original reasoning");
        assert.equal(result.versionIndex, 0);
        assert.equal(result.versions[1].status, failure === "hang" ? "stopped" : "failed");
        assert.deepEqual(requests[0].messages, [{ role: "user", content: "question" }]);
        await api._testLoadConversation("original");
        mode = "complete";
        await api._testRegenerateResponse();
        result = getStoredConversations()[0].messages[1];
        assert.equal(result.content, PARTIAL_TOKEN);
        assert.equal(result.versions.length, 3);
        assert.equal(result.versionIndex, 2);
        // Navigate back through the failed attempt to the original, including
        // its reasoning and sources, without issuing another model request.
        for (let step = 0; step < 2; step++) {
            const previous = elements.get("chat-messages").querySelectorAll(".chat-response-action")
                .find(el => el.textContent === "Previous answer");
            previous._listeners.click[0]();
        }
        assert.equal(getStoredConversations()[0].messages[1].content, "original answer");
        assert.equal(elements.get("chat-messages").querySelector(".chat-source-chip").textContent, "[1] Original source");
        assert.equal(requests.length, 2);
        await api._testSendMessage("follow up");
        assert.deepEqual(requests[2].messages[1], {
            role: "assistant", content: "original answer", reasoning_content: "original reasoning",
        }, "only the selected answer is sent; recovery metadata stays local");
    }

    // A terminal event at EOF is valid even without a final newline or DONE.
    for (const finishReason of ["stop", "length"]) {
        const { api, getStoredConversations } = makeContext({
            fetchImpl: makeFetch("eof", { chunk: `data: ${JSON.stringify({ choices: [{
                delta: { content: "finished" }, finish_reason: finishReason,
            }] })}` }),
        });
        await api._testSendMessage("question");
        assert.equal(getStoredConversations()[0].messages[1].status, finishReason === "length" ? "length" : "complete");
    }

    // Finishing another turn must not rebuild earlier answers or move model
    // transition dividers. Old answer controls cannot rewrite later context.
    {
        const { api, elements } = makeContext({ fetchImpl: makeFetch("complete") });
        await api._testSendMessage("first");
        await api._testRegenerateResponse();
        const container = elements.get("chat-messages");
        const firstAnswer = container.querySelectorAll(".chat-message")[1];
        assert.ok(firstAnswer.querySelector(".chat-response-action"));
        api.addModelTransitionDivider("A", "B");
        const divider = container.querySelector(".chat-model-divider");
        await api._testSendMessage("second");
        assert.equal(container.querySelectorAll(".chat-message")[1], firstAnswer, "previous response DOM is preserved");
        assert.equal(firstAnswer.querySelector(".chat-response-action"), null);
        assert.ok(container.children.indexOf(divider) > container.children.indexOf(firstAnswer));
        assert.ok(container.children.indexOf(divider) < container.children.indexOf(container.querySelectorAll(".chat-message")[2]));
    }

    // Reasoning-only partial output remains saved and visibly incomplete.
    {
        const { api, elements, getStoredConversations } = makeContext({
            fetchImpl: makeFetch("fail", { chunk: 'data: {"choices":[{"delta":{"reasoning_content":"partial reasoning"}}]}\n\n' }),
        });
        await api._testSendMessage("think");
        const convo = getStoredConversations()[0];
        assert.equal(convo.messages[1].reasoning, "partial reasoning");
        assert.equal(convo.messages[1].status, "failed");
        await api._testLoadConversation(convo.id);
        assert.equal(elements.get("chat-messages").querySelector(".chat-reasoning-body").innerHTML.includes("partial reasoning"), true);
        assert.match(elements.get("chat-messages").querySelector(".chat-response-status").textContent, /Incomplete/);
    }

    // Conversation changes still await regeneration's abort before loading or
    // clearing state; an attempt can never be saved into the destination chat.
    for (const action of ["load", "new", "clear"]) {
        let streamPending = false;
        const { api, getStoredConversations } = makeContext({
            fetchImpl: makeFetch("hang", { onStreamPending: () => { streamPending = true; } }),
            seedConversations: [
                { id: "original", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "original" }] },
                { id: "other", messages: [{ role: "user", content: "other q" }] },
            ],
        });
        await api._testLoadConversation("original");
        const pending = api._testRegenerateResponse();
        await flushUntil(() => streamPending, "regeneration to hang");
        if (action === "load") await api._testLoadConversation("other");
        if (action === "new") await api._testStartNewChat();
        if (action === "clear") await api._testClearChat();
        await pending;
        const stored = getStoredConversations();
        assert.deepEqual(stored.find(c => c.id === "other").messages, [{ role: "user", content: "other q" }]);
        const original = stored.find(c => c.id === "original");
        if (action === "clear") assert.equal(original, undefined);
        else {
            assert.equal(original.messages[1].content, "original");
            assert.equal(original.messages[1].versions[1].content, PARTIAL_TOKEN);
            assert.equal(original.messages[1].versions[1].status, "stopped");
        }
    }

    // Preview counts the same selected history, reasoning, system prompt and
    // draft as a real request. Stale responses cannot replace a newer model's meter.
    {
        const pending = [];
        const ctx = makeContext({
            fetchImpl: (url, options) => {
                const done = deferred();
                pending.push({ done, body: JSON.parse(options.body), signal: options.signal });
                return done.promise;
            },
            extraElementIds: ["chat-context-label", "chat-context-bar", "chat-context-prompt", "chat-context-reserve", "chat-web-search-toggle"],
            seedConversations: [{ id: "budget", systemPrompt: "Rules", messages: [
                { role: "user", content: "q" },
                { role: "assistant", content: "chosen", reasoning: "thought", versions: [{ content: "discarded" }] },
            ] }],
        });
        ctx.api.refreshSidebarUI();
        assert.equal(pending.length, 0, "empty chat must not call the template/token counter");
        assert.match(ctx.elements.get("chat-context-label").textContent, /Type a message/);
        ctx.elements.get("chat-system-prompt").value = "Rules only";
        ctx.elements.get("chat-input").value = "  \n ";
        ctx.api.refreshSidebarUI();
        assert.equal(pending.length, 0, "system-only chat with whitespace draft must stay idle");
        assert.equal(ctx.elements.get("chat-context-bar").hidden, true);
        await ctx.api._testLoadConversation("budget");
        ctx.elements.get("chat-input").value = "draft";
        ctx.elements.get("chat-web-search-toggle").checked = true;
        ctx.setFlagValues({ n_predict: 512, ctx_size: 999999 });
        ctx.api.refreshSidebarUI();
        assert.equal(pending[0].signal.aborted, true);
        assert.deepEqual(pending.at(-1).body.messages, [
            { role: "system", content: "Rules" }, { role: "user", content: "q" },
            { role: "assistant", content: "chosen", reasoning_content: "thought" },
            { role: "user", content: "draft" },
        ]);
        assert.equal(pending.at(-1).body.max_tokens, 512);
        assert.equal(pending.at(-1).body.web_search, true);
        const budget = { status: "ok", capacity: 4096, prompt_tokens: 100, reply_reserve: 512, remaining: 3484, reserve_source: "request", search_pending: true };
        pending.at(-1).done.resolve({ ok: true, json: async () => budget });
        await flush();
        assert.match(ctx.elements.get("chat-context-label").textContent, /4,096/);
        assert.match(ctx.elements.get("chat-context-label").textContent, /Web results/);
        pending[0].done.resolve({ ok: true, json: async () => ({ ...budget, capacity: 123 }) });
        await flush();
        assert.match(ctx.elements.get("chat-context-label").textContent, /4,096/);
        ctx.setStatus({ running: true, active_process_tool: "llama-server", runtime_generation: 2,
            active_runtime: { tool: "llama-server", model: "replacement" } });
        ctx.api.updateStatusBadge();
        assert.equal(pending.at(-1).body.model, "replacement");
        ctx.setStatus({ running: false });
        ctx.api.updateStatusBadge();
        pending.at(-1).done.resolve({ ok: true, json: async () => budget });
        await flush();
        assert.match(ctx.elements.get("chat-context-label").textContent, /Start or connect/);
        assert.equal(ctx.elements.get("chat-context-bar").hidden, true);
        ctx.setStatus({ running: true, active_process_tool: "llama-server" });
        ctx.elements.get("chat-input").value = "";
        const requestCount = pending.length;
        await ctx.api._testClearChat();
        assert.equal(pending.length, requestCount, "clearing chat must not send an empty preview");
        assert.match(ctx.elements.get("chat-context-label").textContent, /Type a message/);
    }

    // Compaction commits separately from the transcript and follows the same
    // cancellation ordering as generation when switching conversations.
    {
        const messages = Array.from({ length: 6 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: index < 2 ? "Older detail ".repeat(200) : `Recent ${index}`,
            ...(index === 1 ? { sources: [{ url: "https://example.com" }], versions: [{ content: "Original answer" }], versionIndex: 0 } : {}),
        }));
        const seed = [{ id: "compact", messages, systemPrompt: "Keep these instructions" }, { id: "other-convo", messages: [{ role: "user", content: "Other chat" }] }];
        const bodies = [];
        let hang = false;
        let changeRuntime = false;
        const pendingStream = deferred();
        const fetchImpl = (url, options) => {
            if (String(url).endsWith("/context")) {
                const body = JSON.parse(options.body);
                const prompt = Math.ceil(JSON.stringify(body.messages).length / 4);
                const remaining = 4096 - prompt - (body.max_tokens || 0);
                return Promise.resolve({ ok: true, json: async () => ({ status: remaining < 0 ? "overflow" : "ok", prompt_tokens: prompt, capacity: 4096, remaining }) });
            }
            const body = JSON.parse(options.body || "{}");
            return makeFetch(hang && body.gui_require_context ? "hang" : "complete", {
                chunk: 'data: {"choices":[{"delta":{"content":"Saved decisions and open questions."},"finish_reason":"stop"}]}\n\n',
                onRequest: request => {
                    bodies.push(request);
                    if (changeRuntime && request.gui_require_context) {
                        changeRuntime = false;
                        ctx.setStatus({ running: true, active_process_tool: "llama-server", runtime_generation: 2,
                            active_runtime: { tool: "llama-server", model: "replacement" } });
                    }
                }, onStreamPending: () => pendingStream.resolve(),
            })(url, options);
        };
        const ctx = makeContext({ fetchImpl, seedConversations: seed,
            extraElementIds: ["btn-chat-compact", "chat-compaction-status"] });
        await ctx.api._testLoadConversation("compact");
        ctx.elements.get("chat-input").value = "Preserve my draft";
        await ctx.api._testCompactConversation();
        assert.deepEqual(JSON.parse(JSON.stringify(ctx.api._testGetState().chatMessages)), messages);
        assert.equal(ctx.api._testGetState().chatCompactions.length, 1);
        assert.equal(ctx.elements.get("chat-input").value, "Preserve my draft");
        assert.equal(ctx.elements.get("chat-messages").querySelectorAll(".chat-compaction-marker").length, 1);
        assert.equal(ctx.getStoredConversations().find(item => item.id === "compact").compactions.length, 1);
        await ctx.api._testLoadConversation("other-convo");
        assert.equal(ctx.elements.get("chat-messages").querySelectorAll(".chat-compaction-marker").length, 0);
        await ctx.api._testLoadConversation("compact");
        await ctx.api._testSendMessage("Continue");
        assert.equal(bodies.at(-1).messages[0].content, "Keep these instructions");
        assert.equal(bodies.at(-1).messages[2].content, "Saved decisions and open questions.");
        assert.ok(!JSON.stringify(bodies.at(-1)).includes("Older detail"));
        ctx.api._testUndoCompaction();
        await ctx.api._testRegenerateResponse();
        assert.ok(JSON.stringify(bodies.at(-1)).includes("Older detail"));
        assert.equal(ctx.api._testGetState().chatCompactions.length, 0);

        changeRuntime = true;
        await ctx.api._testCompactConversation();
        assert.equal(ctx.api._testGetState().chatCompactions.length, 0, "a model switch invalidates an otherwise complete summary");
        assert.match(ctx.elements.get("chat-compaction-status").textContent, /cancelled/);

        hang = true;
        const pending = ctx.api._testCompactConversation();
        await pendingStream.promise;
        assert.equal(ctx.elements.get("btn-chat-compact").textContent, "Cancel compaction");
        await ctx.api._testLoadConversation("other-convo");
        await pending;
        assert.equal(ctx.api._testGetState().currentConversationId, "other-convo");
        assert.equal(ctx.api._testGetState().chatCompactions.length, 0);
        assert.equal(ctx.getStoredConversations().find(item => item.id === "compact").compactions.length, 0);
        assert.equal(ctx.elements.get("chat-compaction-status").hidden, true);
        hang = false;
        await ctx.api._testLoadConversation("compact");
        await ctx.api._testCompactConversation();
        assert.equal(ctx.api._testGetState().chatCompactions.length, 1);
        for (let i = 0; i < 4; i++) ctx.api._testUndoMessage();
        assert.equal(ctx.api._testGetState().chatCompactions.length, 0, "undo across the summary boundary restores raw context");
    }

    // Deleting the active transcript must settle streaming autosaves before
    // removing storage, and later New Chat must not recreate the deleted entry.
    for (const streaming of [false, true]) {
        let pending = false;
        const ctx = makeContext({
            seedConversations: [{ id: "delete-me", title: "Delete me", messages: [{ role: "user", content: "private transcript" }] }],
            fetchImpl: makeFetch(streaming ? "hang" : "complete", { onStreamPending: () => { pending = true; } }),
        });
        await ctx.api._testLoadConversation("delete-me");
        const send = streaming ? ctx.api._testSendMessage("follow up") : Promise.resolve();
        if (streaming) await flushUntil(() => pending, "the deletable stream to hang");
        const deleteButton = ctx.elements.get("chat-history-list").querySelector(".chat-history-item-delete");
        await deleteButton._listeners.click[0]({ stopPropagation() {} });
        await send;
        assert.equal(ctx.getStoredConversations().length, 0);
        assert.equal(ctx.api._testGetState().chatMessages.length, 0);
        await ctx.api._testStartNewChat();
        assert.equal(ctx.getStoredConversations().length, 0, "New Chat must not resurrect deleted messages");
    }
    {
        const ctx = await runAbortScenario(api => api._testDeleteAllConversations());
        assert.equal(ctx.getStoredConversations().length, 0, "Delete All must include the stream's final autosave");
        assert.equal(ctx.api._testGetState().chatMessages.length, 0);
        await ctx.api._testStartNewChat();
        assert.equal(ctx.getStoredConversations().length, 0);
    }
    {
        let pending = false;
        let accepted = false;
        const ctx = makeContext({
            seedConversations: ["active", "other"].map(id => ({ id, title: id, messages: [{ role: "user", content: id }] })),
            fetchImpl: makeFetch("hang", { onStreamPending: () => { pending = true; } }),
            confirmImpl: async () => accepted,
        });
        await ctx.api._testLoadConversation("active");
        const send = ctx.api._testSendMessage("Keep generating");
        await flushUntil(() => pending, "stream while deleting another conversation");
        const buttons = ctx.elements.get("chat-history-list").querySelectorAll(".chat-history-item-delete");
        await buttons[0]._listeners.click[0]({ stopPropagation() {} });
        assert.equal(ctx.api._testGetState().chatStreaming, true, "cancelling deletion leaves generation running");
        accepted = true;
        await buttons[1]._listeners.click[0]({ stopPropagation() {} });
        assert.equal(ctx.api._testGetState().chatStreaming, true, "deleting an inactive chat leaves generation running");
        assert.equal(ctx.getStoredConversations().some(c => c.id === "other"), false);
        await ctx.api.abortActiveStream();
        await send;
        assert.equal(ctx.getStoredConversations().some(c => c.id === "active"), true);
    }
    {
        let requests = 0;
        const status = (port, generation) => ({ running: false, runtime_generation: 0,
            external_chat_target: { connected: true, host: "127.0.0.1", port, generation } });
        const ctx = makeContext({ status: status(9001, 1), fetchImpl: makeFetch("complete", {
            onPropsRequest: () => {
                requests += 1;
                return Promise.resolve({ ok: true, json: async () => ({
                    chat_template_caps: { supports_reasoning_effort: requests > 1 },
                }) });
            },
        }) });
        await ctx.api.refreshTemplateCaps();
        await ctx.api.refreshTemplateCaps();
        assert.equal(requests, 1, "polls of the same target should reuse capabilities");
        ctx.setStatus(status(9002, 2));
        await ctx.api.refreshTemplateCaps();
        assert.equal(requests, 2, "another external target must refresh capabilities");
        ctx.setStatus(status(9002, 3));
        await ctx.api.refreshTemplateCaps();
        assert.equal(requests, 3, "reconnecting the same endpoint must refresh capabilities");
        assert.equal(ctx.elements.get("chat-thinking-effort-cap-hint").textContent, "");
    }

    // The server may send finish_reason first, then a separate empty-choices
    // usage/timings event. The client must consume both and save supplied
    // values without deriving a speed.
    {
        const finish = { choices: [{ delta: { content: "metadata answer" }, finish_reason: "stop" }] };
        const usage = { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }, timings: { predicted_per_second: 7.5 } };
        const chunk = [finish, usage].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
        let requestBody;
        const ctx = makeContext({ fetchImpl: makeFetch("complete", { chunk, onRequest: body => { requestBody = body; } }) });
        await ctx.api._testSendMessage("metadata");
        assert.deepEqual(requestBody.stream_options, { include_usage: true });
        const assistant = ctx.getStoredConversations()[0].messages[1];
        assert.equal(assistant.status, "complete");
        assert.deepEqual(assistant.metadata, {
            stop_reason: "stop",
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
            timings: { predicted_per_second: 7.5 },
        });
    }

    // Once a reader scrolls away during generation, later content and
    // reasoning chunks preserve that new position and leave Jump to latest
    // available after the stream finishes.
    {
        let ctx;
        const fetchImpl = async (_url, _options) => {
            const container = ctx.elements.get("chat-messages");
            const encoder = new TextEncoder();
            let reads = 0;
            return { ok: true, body: { getReader: () => ({
                read: async () => {
                    reads += 1;
                    if (reads === 1) return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"one"}}]}\n\n') };
                    if (reads === 2) {
                        container.scrollTop = 100;
                        container._listeners.scroll?.forEach(listener => listener());
                        return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"thought","content":"two"}}]}\n\n') };
                    }
                    if (reads === 3) return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"three"}}]}\n\n') };
                    if (reads === 4) return { done: false, value: encoder.encode("data: [DONE]\n\n") };
                    return { done: true };
                },
                cancel: async () => {},
            }) } };
        };
        ctx = makeContext({ fetchImpl, extraElementIds: ["btn-chat-jump-latest", "btn-chat-send", "btn-chat-stop", "btn-chat-undo", "btn-chat-regenerate"] });
        const container = ctx.elements.get("chat-messages");
        container.clientHeight = 200;
        container.scrollHeight = 1200;
        container.scrollTop = 1050;
        ctx.api.init();
        await ctx.api._testSendMessage("scroll test");
        assert.equal(container.scrollTop, 100, "streaming output must preserve the user's latest away position");
        assert.equal(ctx.elements.get("btn-chat-jump-latest").hidden, false, "Jump to latest stays visible after away-stream completion");
        ctx.elements.get("btn-chat-jump-latest")._listeners.click[0]();
        assert.equal(container.scrollTop, container.scrollHeight);
        assert.equal(ctx.elements.get("btn-chat-jump-latest").hidden, true);
    }

    // Editing stages the later tail before truncation, keeps the original
    // transcript intact until resend, and never adds a duplicate user turn.
    {
        const ctx = makeContext({
            fetchImpl: makeFetch("complete"),
            seedConversations: [{ id: "edit-chat", title: "Keep title", messages: [
                { role: "user", content: "original question" },
                { role: "assistant", content: "old answer" },
                { role: "user", content: "later question" },
                { role: "assistant", content: "later answer" },
            ] }],
        });
        await ctx.api._testLoadConversation("edit-chat");
        await ctx.api._testEditUserMessage(0);
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages).map(message => message.content), [
            "original question", "old answer", "later question", "later answer",
        ]);
        assert.equal(ctx.elements.get("chat-input").value, "original question");
        ctx.api._testCancelEdit();
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages).map(message => message.content), [
            "original question", "old answer", "later question", "later answer",
        ]);
        await ctx.api._testEditUserMessage(0);
        ctx.elements.get("chat-input").value = "revised question";
        await ctx.api._testSendMessage(ctx.elements.get("chat-input").value);
        const state = plain(ctx.api._testGetState());
        assert.deepEqual(state.chatMessages.map(message => message.content), ["revised question", PARTIAL_TOKEN]);
        const stored = ctx.getStoredConversations();
        const active = stored.find(item => item.id === "edit-chat");
        const beforeEdit = stored.find(item => item.id !== "edit-chat" && /before edit/.test(item.title));
        assert.equal(active.title, "Keep title");
        assert.ok(beforeEdit, "edit must create a selectable before-edit history copy");
        assert.deepEqual(beforeEdit.messages.map(message => message.content), [
            "original question", "old answer", "later question", "later answer",
        ]);
        await ctx.api._testLoadConversation(beforeEdit.id);
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages).map(message => message.content), [
            "original question", "old answer", "later question", "later answer",
        ], "loading the history copy must restore the removed later turns");
        await ctx.api._testLoadConversation("edit-chat");
    }

    // A staged edit belongs to its source conversation and is discarded when
    // the user loads another conversation before resending.
    {
        const ctx = makeContext({
            fetchImpl: makeFetch("complete"),
            seedConversations: [
                { id: "edit-source", messages: [{ role: "user", content: "source" }, { role: "assistant", content: "tail" }] },
                { id: "edit-destination", messages: [{ role: "user", content: "destination" }] },
            ],
        });
        await ctx.api._testLoadConversation("edit-source");
        await ctx.api._testEditUserMessage(0);
        await ctx.api._testLoadConversation("edit-destination");
        assert.equal(ctx.api._testGetState().pendingEdit, null);
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages).map(message => message.content), ["destination"]);
    }

    // A failed branch write must leave the original transcript and staged
    // edit intact; the resend cannot truncate later turns without recovery.
    {
        let requests = 0;
        const ctx = makeContext({
            storageMode: "fail-set",
            fetchImpl: makeFetch("complete", { onRequest: () => { requests += 1; } }),
            seedConversations: [{ id: "edit-fail", messages: [
                { role: "user", content: "original" },
                { role: "assistant", content: "later answer" },
            ] }],
        });
        await ctx.api._testLoadConversation("edit-fail");
        await ctx.api._testEditUserMessage(0);
        ctx.elements.get("chat-input").value = "revised";
        await ctx.api._testSendMessage("revised");
        assert.equal(requests, 0, "storage failure must stop the resend before generation");
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages).map(message => message.content), ["original", "later answer"]);
        assert.equal(ctx.api._testGetState().pendingEdit.originalText, "original");
    }

    // The before-edit copy remains recoverable when creating it at the
    // 50-entry boundary; the oldest entry is removed without a restore copy.
    {
        const saved = [{ id: "edit-full", title: "Full edit", messages: [
            { role: "user", content: "before" }, { role: "assistant", content: "answer" },
        ] }];
        for (let index = 1; index < 50; index += 1) {
            saved.push({ id: `saved-${index}`, title: `Saved ${index}`, messages: [{ role: "user", content: `saved ${index}` }] });
        }
        const ctx = makeContext({ fetchImpl: makeFetch("complete"), seedConversations: saved });
        await ctx.api._testLoadConversation("edit-full");
        await ctx.api._testEditUserMessage(0);
        ctx.elements.get("chat-input").value = "edited";
        await ctx.api._testSendMessage("edited");
        assert.ok(ctx.getStoredConversations().some(item => /before edit/.test(item.title)), "backup survives retention pruning");
        assert.equal(ctx.getStoredConversations().length, 50);
        assert.equal(ctx.getStoredConversations().some(item => item.id === "saved-49"), false);
        assert.equal(ctx.getStoredDeletedConversations().length, 0);
    }

    // Auto-compaction preflight for retry measures the exact request that will
    // replace the old assistant answer, without duplicating its user prompt.
    {
        const contextBodies = [];
        const generationBodies = [];
        const ctx = makeContext({
            fetchImpl: (url, options) => {
                const body = JSON.parse(options.body || "{}");
                if (String(url).endsWith("/context")) {
                    contextBodies.push(body);
                    return Promise.resolve({ ok: true, json: async () => ({ status: "warning", prompt_tokens: 100, capacity: 4096, remaining: 100 }) });
                }
                generationBodies.push(body);
                return makeFetch("complete")(url, options);
            },
            seedConversations: [{ id: "retry-auto", messages: [
                { role: "user", content: "question" },
                { role: "assistant", content: "old answer" },
            ] }],
        });
        await ctx.api._testLoadConversation("retry-auto");
        ctx.api._testSetAutoCompaction(true);
        await ctx.api._testRegenerateResponse();
        assert.deepEqual(contextBodies.at(-1).messages.map(message => message.content), ["question"]);
        assert.deepEqual(generationBodies.at(-1).messages.map(message => message.content), ["question"]);
    }

    // Auto-compaction is opt-in. A fresh exact-draft preview can trigger one
    // summary, after which the compacted request is remeasured before send.
    {
        let contextRequests = 0;
        let generationRequests = 0;
        const summary = "Preserved decisions and open questions.";
        const transcript = Array.from({ length: 6 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user", content: `turn ${index}`,
        }));
        const fetchImpl = async (url, options) => {
            const body = JSON.parse(options.body || "{}");
            if (String(url).endsWith("/context")) {
                contextRequests += 1;
                const prompt = JSON.stringify(body.messages || []).includes(summary) ? 300 : 600;
                const isInitial = body.messages?.at(-1)?.content === "pending draft"
                    && body.messages.length >= transcript.length + 1
                    && !JSON.stringify(body.messages).includes(summary);
                return { ok: true, json: async () => ({
                    status: isInitial ? "overflow" : "ok", prompt_tokens: prompt, capacity: 4096,
                    reply_reserve: body.max_tokens || 0, remaining: isInitial ? -1 : 4096 - prompt,
                }) };
            }
            generationRequests += 1;
            const event = body.gui_require_context
                ? { choices: [{ delta: { content: summary }, finish_reason: "stop" }] }
                : { choices: [{ delta: { content: "sent after compaction" }, finish_reason: "stop" }] };
            const usage = body.gui_require_context ? "" : `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 4, total_tokens: 29 }, timings: { predicted_per_second: 6 } })}\n\n`;
            const encoded = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n${usage}`);
            let reads = 0;
            return { ok: true, body: { getReader: () => ({
                read: async () => {
                    reads += 1;
                    if (reads === 1) return { done: false, value: encoded };
                    if (!body.gui_require_context) {
                        if (reads === 2) return { done: false, value: new TextEncoder().encode("data: [DONE]\n\n") };
                    }
                    return { done: true };
                }, cancel: async () => {},
            }) } };
        };
        const ctx = makeContext({ fetchImpl, seedConversations: [{ id: "auto", messages: transcript }], extraElementIds: [
            "chat-context-label", "chat-context-bar", "chat-context-prompt", "chat-context-reserve", "chat-compaction-status", "btn-chat-compact",
        ] });
        await ctx.api._testLoadConversation("auto");
        ctx.api._testSetAutoCompaction(true);
        await ctx.api._testSendMessage("pending draft");
        const state = plain(ctx.api._testGetState());
        assert.equal(state.chatCompactions.length, 1);
        assert.equal(state.chatMessages.at(-2).content, "pending draft");
        assert.equal(state.chatMessages.at(-1).content, "sent after compaction");
        assert.ok(contextRequests >= 4, "preflight, compaction, and post-compaction previews all run");
        assert.equal(generationRequests >= 2, true, "summary and final answer requests both run");
    }

    // A failed automatic summary keeps the transcript and does not send the
    // pending draft onward.
    {
        let normalRequests = 0;
        const transcript = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
        const fetchImpl = async (url, options) => {
            const body = JSON.parse(options.body || "{}");
            if (String(url).endsWith("/context")) return { ok: true, json: async () => ({
                status: body.gui_require_context ? "ok" : "overflow", prompt_tokens: 200, capacity: 4096,
                remaining: body.gui_require_context ? 3000 : -1,
            }) };
            normalRequests += 1;
            if (body.gui_require_context) {
                let read = false;
                return { ok: true, body: { getReader: () => ({
                    read: async () => {
                        if (read) return { done: true };
                        read = true;
                        return { done: false, value: new TextEncoder().encode('data: {"error":{"message":"summary failed"}}\n\n') };
                    }, cancel: async () => {},
                }) } };
            }
            throw new Error("final request must not run after failed auto-compaction");
        };
        const ctx = makeContext({ fetchImpl, seedConversations: [{ id: "auto-fail", messages: transcript }], extraElementIds: [
            "chat-context-label", "chat-context-bar", "chat-context-prompt", "chat-context-reserve", "chat-compaction-status", "btn-chat-compact",
        ] });
        await ctx.api._testLoadConversation("auto-fail");
        const before = plain(ctx.api._testGetState().chatMessages);
        ctx.api._testSetAutoCompaction(true);
        await ctx.api._testSendMessage("pending draft");
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages), before);
        assert.equal(normalRequests, 1);
        assert.match(ctx.elements.get("chat-compaction-status").textContent, /summary failed|Previous context kept/);
    }

    // User-assigned titles survive later saves; search, export, and deletion
    // operate on the same local conversation data.
    {
        const ctx = makeContext({
            fetchImpl: makeFetch("complete"),
            seedConversations: [
                { id: "alpha", title: "Custom Alpha", messages: [{ role: "user", content: "Find the alpha" }] },
                { id: "beta", title: "Beta", messages: [{ role: "user", content: "Other topic" }] },
            ],
            extraElementIds: ["chat-history-search", "chat-history-retention",
                "btn-chat-send", "btn-chat-stop", "btn-chat-undo", "btn-chat-regenerate"],
        });
        ctx.api.init();
        ctx.elements.get("chat-history-search").value = "ALPHA";
        ctx.elements.get("chat-history-search")._listeners.input[0]();
        assert.equal(ctx.elements.get("chat-history-list").children.length, 1);
        assert.equal(ctx.elements.get("chat-history-list").children[0].children[1].textContent, "Find the alpha");
        assert.equal(ctx.api._testRenameConversation("alpha", "Renamed Alpha"), true);
        assert.equal(ctx.api._testExportConversation("alpha", "text").includes("FIND"), false);
        await ctx.api._testLoadConversation("alpha");
        await ctx.api._testSendMessage("Follow up");
        assert.equal(ctx.getStoredConversations().find(item => item.id === "alpha").title, "Renamed Alpha");
        await ctx.api._testDeleteConversation("alpha");
        assert.equal(ctx.getStoredConversations().some(item => item.id === "alpha"), false);
        assert.equal(ctx.getStoredDeletedConversations().length, 0);
    }

    // UI actions ask once before any mutation; a cancelled dialog preserves
    // both the active transcript and saved history. Legacy trash is inert.
    for (const action of ["single", "all", "clear"]) {
        let accepted = false;
        const confirmations = [];
        const saved = ["alpha", "beta"].map(id => ({ id, title: id, systemPrompt: "Keep prompt", messages: [{ role: "user", content: id }] }));
        const legacyDeleted = [{ id: "legacy", title: "Old deleted chat", messages: [] }];
        const ctx = makeContext({
            fetchImpl: makeFetch("complete"),
            seedConversations: saved,
            seedDeletedConversations: legacyDeleted,
            confirmImpl: async (...args) => { confirmations.push(args); return accepted; },
            extraElementIds: ["btn-chat-send", "btn-chat-stop", "btn-chat-undo", "btn-chat-regenerate", "btn-chat-clear", "btn-delete-all-history"],
        });
        ctx.api.init();
        await ctx.api._testLoadConversation("alpha");
        const click = () => {
            const button = action === "single" ? ctx.elements.get("chat-history-list").querySelector(".chat-history-item-delete")
                : ctx.elements.get(action === "all" ? "btn-delete-all-history" : "btn-chat-clear");
            return button._listeners.click[0]({ stopPropagation() {} });
        };
        await click();
        assert.equal(confirmations.length, 1);
        assert.match(confirmations[0][1], /cannot be undone/);
        assert.deepEqual(ctx.getStoredConversations(), saved);
        assert.equal(ctx.api._testGetState().currentConversationId, "alpha");
        assert.equal(ctx.elements.get("chat-system-prompt").value, "Keep prompt");
        accepted = true;
        await click();
        assert.equal(confirmations.length, 2, "one confirmation for each attempt, including Delete All and Clear");
        assert.deepEqual(ctx.getStoredConversations().map(c => c.id), action === "all" ? [] : ["beta"]);
        assert.equal(ctx.api._testGetState().currentConversationId, null);
        assert.equal(ctx.api._testGetState().chatMessages.length, 0);
        assert.deepEqual(ctx.getStoredDeletedConversations(), legacyDeleted, "new deletions must not update or use legacy trash");
    }
    for (const action of ["_testDeleteConversation", "_testDeleteAllConversations", "_testClearChat"]) {
        const saved = [{ id: "keep", title: "Keep", messages: [{ role: "user", content: "Keep this transcript" }] }];
        const ctx = makeContext({ fetchImpl: makeFetch("complete"), seedConversations: saved, storageMode: "fail-set" });
        await ctx.api._testLoadConversation("keep");
        await ctx.api[action]("keep");
        assert.deepEqual(ctx.getStoredConversations(), saved);
        assert.equal(ctx.api._testGetState().currentConversationId, "keep");
        assert.equal(ctx.api._testGetState().chatMessages[0].content, "Keep this transcript");
    }

    // Character import preserves the previous chat and saves an immediately
    // reloadable prompt/greeting, including cards with no first message.
    {
        const ctx = makeContext({ fetchImpl: makeFetch("complete"), extraElementIds: ["chat-character-status"] });
        await ctx.api._testSendMessage("Before character import");
        const previous = ctx.getStoredConversations()[0];
        await ctx.api._testImportCharacterCard(cardFile());
        const loaded = ctx.getStoredConversations()[0];
        assert.equal(loaded.title, character.name);
        assert.equal(loaded.messages[0].role, "assistant");
        assert.match(loaded.systemPrompt, /Éloïse is an astronomer/);
        assert.deepEqual(ctx.getStoredConversations().find(c => c.id === previous.id).messages, previous.messages);
        assert.equal(ctx.elements.get("chat-sys-char-count").textContent, loaded.systemPrompt.length + " chars");
        await ctx.api._testLoadConversation(previous.id);
        assert.equal(ctx.elements.get("chat-system-prompt").value, previous.systemPrompt);
        await ctx.api._testLoadConversation(loaded.id);
        assert.equal(ctx.elements.get("chat-system-prompt").value, loaded.systemPrompt);
        await ctx.api._testImportCharacterCard(cardFile({ name: "Quiet", description: "Silent observer" }));
        const quiet = ctx.getStoredConversations()[0];
        assert.equal(quiet.title, "Quiet");
        assert.equal(quiet.messages.length, 0);
        await ctx.api._testStartNewChat();
        await ctx.api._testLoadConversation(quiet.id);
        assert.match(ctx.elements.get("chat-system-prompt").value, /Silent observer/);
        const count = ctx.getStoredConversations().length;
        await ctx.api._testImportCharacterCard(cardFile({ invalid: true }));
        assert.equal(ctx.getStoredConversations().length, count);
        assert.match(ctx.elements.get("chat-system-prompt").value, /Silent observer/);

        const beforeRejectedCard = ctx.getStoredConversations();
        for (const invalid of [
            { name: "x".repeat(257), description: "Too long a name" },
            { name: "x".repeat(256), description: "{{char}}".repeat(5000) },
        ]) {
            await ctx.api._testImportCharacterCard(cardFile(invalid));
            assert.deepEqual(ctx.getStoredConversations(), beforeRejectedCard);
            assert.equal(ctx.api._testGetState().currentConversationId, quiet.id);
            assert.match(ctx.elements.get("chat-system-prompt").value, /Silent observer/);
            assert.match(ctx.elements.get("chat-character-status").textContent, /256 characters|expanded text limit/);
        }

        const pending = deferred();
        const file = cardFile();
        const importing = ctx.api._testImportCharacterCard({ ...file, arrayBuffer: () => pending.promise });
        await ctx.api._testStartNewChat();
        pending.resolve(await file.arrayBuffer());
        await importing;
        assert.equal(ctx.elements.get("chat-system-prompt").value, "");
        assert.match(ctx.elements.get("chat-character-status").textContent, /Chat changed/);
    }
    {
        const original = { id: "before", title: "Before", messages: [{ role: "user", content: "Keep me" }], systemPrompt: "Original prompt" };
        const ctx = makeContext({ fetchImpl: makeFetch("complete"), seedConversations: [original], storageMode: "fail-set", extraElementIds: ["chat-character-status"] });
        await ctx.api._testLoadConversation(original.id);
        await ctx.api._testImportCharacterCard(cardFile());
        assert.equal(ctx.elements.get("chat-system-prompt").value, "Original prompt");
        assert.match(ctx.elements.get("chat-character-status").textContent, /Could not save/);
        assert.equal(ctx.getStoredConversations().length, 1);
    }

    // A fragmented tool call gets one bounded continuation, with its trace saved
    // on the answer and replayed intact for reloads, previews and regeneration.
    const toolChunk = [
        { choices: [{ delta: { reasoning_content: "Need the current clock.", tool_calls: [{ index: 0, id: "clock-1", type: "function", function: { name: "get_", arguments: "{" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "datetime", arguments: "}" } }] }, finish_reason: "tool_calls" }] },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    for (const action of ["_testLoadConversation", "_testStartNewChat", "_testClearChat"]) {
        const boundary = deferred();
        let atBoundary = false;
        let requestCount = 0;
        const ctx = makeContext({
            fetchImpl: makeFetch("complete", {
                chunk: toolChunk,
                onRequest: () => { requestCount += 1; },
                onCancel: () => { atBoundary = true; return boundary.promise; },
            }),
            seedConversations: [{ id: "other", messages: [{ role: "user", content: "Keep the target chat" }] }],
        });
        ctx.tools.setEnabled(true);
        let executions = 0;
        const execute = ctx.tools.executeCalls;
        ctx.tools.executeCalls = calls => { executions += 1; return execute(calls); };
        const sending = ctx.api._testSendMessage("Check the clock");
        await flushUntil(() => atBoundary, "round one to finish while reader cancellation is pending");
        const originalId = ctx.api._testGetState().currentConversationId;
        const changing = ctx.api[action]("other");
        assert.equal(ctx.api._testGetState().currentConversationId, originalId,
            "conversation changes wait for the outgoing stream to settle");
        boundary.resolve();
        await Promise.all([sending, changing]);
        assert.equal(requestCount, 1, "an aborted first round never starts the continuation");
        assert.equal(executions, 0, "an aborted first round never executes the clock");
        assert.equal(ctx.api._testGetState().chatStreaming, false);
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages).map(msg => msg.content),
            action === "_testLoadConversation" ? ["Keep the target chat"] : []);
        if (action !== "_testClearChat") {
            assert.equal(ctx.getStoredConversations().find(convo => convo.id === originalId).messages.at(-1).status, "stopped",
                "the original abort is preserved instead of a DOM error");
        }
    }
    {
        const requests = [];
        let count = 0;
        const ctx = makeContext({ fetchImpl: (url, options) => {
            if (!url.includes("/api/chat/completions")) return makeFetch("complete")(url, options);
            count += 1;
            return makeFetch("complete", { chunk: count % 2 ? toolChunk : 'data: {"choices":[{"delta":{"content":"It is the current local time."},"finish_reason":"stop"}]}\n\n',
                onRequest: body => requests.push(body) })(url, options);
        }, extraElementIds: ["chat-web-search-toggle"] });
        ctx.tools.setEnabled(true);
        ctx.elements.get("chat-web-search-toggle").checked = true;
        await ctx.api._testSendMessage("What time is it?");
        assert.equal(requests.length, 2);
        assert.equal(requests[0].tools[0].function.name, "get_datetime");
        assert.equal(requests[1].tool_choice, "none");
        assert.equal(requests[1].web_search, true, "continuation retains web-search context injection");
        assert.deepEqual(requests[1].messages.map(msg => msg.role), ["system", "user", "assistant", "tool"]);
        assert.match(requests[0].messages[0].content, /get_datetime.*today.*web search/);
        assert.equal(requests[1].messages[2].reasoning_content, "Need the current clock.");
        assert.equal(requests[1].messages[3].tool_call_id, "clock-1");
        const answer = ctx.api._testGetState().chatMessages.at(-1);
        assert.equal(answer.content, "It is the current local time.");
        assert.equal(answer.toolMessages.length, 2);
        assert.equal(answer.status, "complete");
        const saved = ctx.getStoredConversations()[0];
        await ctx.api._testLoadConversation(saved.id);
        assert.deepEqual(plain(ctx.api._testGetState().chatMessages.at(-1).toolMessages), saved.messages.at(-1).toolMessages);
        ctx.tools.setEnabled(false);
        assert.equal(ctx.tools.getDefinitions().length, 0);
        assert.equal(ctx.tools.requestMessages(ctx.api._testGetState().chatMessages)[2].role, "tool", "disabling keeps historical results");
        ctx.tools.setEnabled(true);
        await ctx.api._testRegenerateResponse();
        assert.equal(requests[2].messages.length, 2, "regeneration excludes the previous answer and its tool exchange");
        const versions = ctx.api._testGetState().chatMessages.at(-1).versions;
        assert.equal(versions.length, 2);
        assert.equal(versions[0].toolMessages.length, 2);
        assert.equal(versions[1].toolMessages.length, 2);
    }
    for (const mode of ["disabled", "unknown", "incomplete", "repeat", "network", "cancel", "revoked"]) {
        let count = 0;
        let pending = false;
        const ctx = makeContext({ fetchImpl: (url, options) => {
            if (!url.includes("/api/chat/completions")) return makeFetch("complete")(url, options);
            count += 1;
            if (mode === "revoked") ctx.tools.setEnabled(false);
            if (count === 2 && mode === "network") return makeFetch("network")(url, options);
            if (count === 2 && mode === "cancel") return makeFetch("hang", { onStreamPending: () => { pending = true; } })(url, options);
            const chunk = mode === "unknown" ? toolChunk.replace('"datetime"', '"shell_command"').replace('"get_"', '"exec_"')
                : mode === "incomplete" ? toolChunk.replace('"tool_calls"}', '"length"}') : toolChunk;
            return makeFetch("complete", { chunk })(url, options);
        } });
        if (mode !== "disabled") ctx.tools.setEnabled(true);
        const sending = ctx.api._testSendMessage("What time is it?");
        if (mode === "cancel") {
            await flushUntil(() => pending, "the tool continuation to wait");
            await ctx.api._testStartNewChat();
        }
        await sending;
        assert.ok(count <= 2, "no unbounded tool loop");
        if (mode === "cancel") {
            assert.equal(ctx.api._testGetState().chatMessages.length, 0, "cancelled continuation cannot leak into the new conversation");
            assert.equal(ctx.getStoredConversations()[0].messages.at(-1).status, "stopped");
        } else {
            assert.equal(ctx.api._testGetState().chatMessages.at(-1).status, "failed", mode);
            assert.equal(count, ["repeat", "network"].includes(mode) ? 2 : 1, mode);
        }
    }

    // Workspace snapshots preserve the supported conversation shape and local
    // recovery preferences while dropping unknown fields and live state. The
    // raw restoreSnapshot API is inert staging for an observer before its
    // coordinator grants ownership; durable history remains owner-gated.
    {
        const original = [{ id: "snapshot", title: "Saved title", titleCustom: true,
            systemPrompt: "Saved rules", thinkingEffort: "high", messages: [
                { role: "user", content: "Question", metadata: { secret: "drop" }, unknown: "drop" },
                { role: "assistant", content: "Answer", reasoning: "Thought", status: "complete",
                    sources: [{ index: 1, title: "Reference", url: "https://example.com", secret: "drop" }],
                    metadata: { usage: { prompt_tokens: 10, total_tokens: 12, credential: "drop" }, timings: { predicted_per_second: 2 } },
                    versions: [{ content: "Old answer", status: "failed", metadata: { stop_reason: "error" } }],
                },
            ] }];
        let requests = 0;
        const ctx = makeContext({ fetchImpl: (url, options) => {
            if (String(url).includes("/api/chat/completions")) requests += 1;
            return makeFetch("complete")(url, options);
        }, seedConversations: original,
            flagValues: { temperature: 0.4, top_p: 0.9 }, extraElementIds: [
                "chat-web-search-toggle", "chat-web-search-max-results", "chat-auto-compact-toggle", "chat-datetime-enabled",
                "btn-chat-send", "btn-chat-stop", "btn-chat-undo", "btn-chat-regenerate",
            ] });
        await ctx.api._testLoadConversation("snapshot");
        ctx.api.init();
        ctx.elements.get("chat-input").value = "Draft text";
        ctx.elements.get("chat-system-prompt").value = "Live rules";
        ctx.elements.get("chat-web-search-toggle").checked = true;
        ctx.elements.get("chat-web-search-max-results").value = "7";
        ctx.tools.setEnabled(true);
        let checkpoints = 0;
        ctx.api.configureWorkspace({ detachedView: true, checkpoint: () => { checkpoints += 1; return true; } });
        ctx.elements.get("chat-input")._listeners.input[0]();
        assert.ok(checkpoints >= 1, "draft changes checkpoint the recoverable workspace");
        const snapshot = plain(ctx.api.captureSnapshot({ transferId: "t-1", sourceInstanceId: "main", revision: 4, secret: "drop" }));
        assert.equal(snapshot.kind, "llama-gui-chat-workspace");
        assert.equal(snapshot.schemaVersion, 1);
        assert.equal(snapshot.conversation.titleCustom, true);
        assert.deepEqual(snapshot.metadata, { transferId: "t-1", sourceInstanceId: "main", revision: 4 });
        assert.equal(snapshot.messages[0].unknown, undefined);
        assert.equal(snapshot.messages[1].sources[0].secret, undefined);
        assert.equal(snapshot.messages[1].metadata.usage.credential, undefined);
        assert.equal(snapshot.messages[1].metadata.timings.predicted_per_second, 2);
        assert.equal(snapshot.inputs.systemPrompt, "Live rules");
        assert.equal(snapshot.inputs.draft, "Draft text");
        assert.equal(snapshot.inputs.datetimeEnabled, true);
        assert.equal(snapshot.inputs.samplers, undefined, "samplers are read through the shared adapter, never restored");
        assert.equal(ctx.api.validateSnapshot(snapshot), true);
        ctx.tools.setEnabled(false);
        assert.equal(ctx.elements.get("chat-datetime-enabled").checked, false);
        const invalid = JSON.parse(JSON.stringify(snapshot));
        invalid.metadata.secret = "reject";
        assert.equal(ctx.api.validateSnapshot(invalid), false);
        await ctx.api._testStartNewChat();
        const storedBeforeRestore = ctx.getStoredConversations();
        const checkpointsBeforeRestore = checkpoints;
        assert.equal(ctx.api.setOwnership(false), true);
        assert.equal(ctx.api.restoreSnapshot(snapshot), true);
        assert.equal(ctx.api._testGetState().currentConversationId, "snapshot");
        assert.equal(ctx.elements.get("chat-system-prompt").value, "Live rules");
        assert.equal(ctx.elements.get("chat-input").value, "Draft text");
        assert.equal(ctx.tools.isEnabled(), true);
        assert.equal(ctx.elements.get("chat-datetime-enabled").checked, true,
            "snapshot restoration synchronizes the visible date/time setting");
        assert.deepEqual(ctx.getStoredConversations(), storedBeforeRestore, "restore is inert and does not write history");
        assert.equal(checkpoints, checkpointsBeforeRestore, "restore does not checkpoint by itself");
        assert.equal(await ctx.api._testSendMessage("observer restore"), false);
        assert.equal(requests, 0, "observer restore cannot send through the host");
        assert.deepEqual(ctx.getStoredConversations(), storedBeforeRestore, "observer restore cannot save history");
    }

    // Ownership, host availability, and suspension gate sends; the intentional
    // suspended transfer save remains available to the owner.
    {
        let requests = 0;
        let checkpoint = 0;
        const workspaceInputIds = [
            "chat-system-prompt", "chat-thinking-effort", "chat-datetime-enabled",
            "chat-web-search-toggle", "chat-web-search-max-results", "chat-auto-compact-toggle",
            "chat-slider-temp", "chat-slider-top-p", "chat-slider-top-k", "chat-slider-min-p",
            "chat-slider-repeat", "chat-slider-max-tokens", "chat-num-temp", "chat-num-top-p",
            "chat-num-top-k", "chat-num-min-p", "chat-num-repeat", "chat-num-max-tokens",
        ];
        const ctx = makeContext({ fetchImpl: (url, options) => {
            if (String(url).includes("/api/chat/completions")) requests += 1;
            return makeFetch("complete")(url, options);
        }, seedConversations: [{ id: "owned", messages: [{ role: "user", content: "Keep" }] }],
            extraElementIds: workspaceInputIds });
        await ctx.api._testLoadConversation("owned");
        ctx.api.configureWorkspace({ checkpoint: () => { checkpoint += 1; return true; }, onChange: () => {} });
        assert.equal(ctx.api.setOwnership(false), true);
        assert.equal(ctx.api.getTransferState().allowed, false);
        for (const id of workspaceInputIds) {
            assert.equal(ctx.elements.get(id).disabled, true, `${id} must be inert without workspace ownership`);
        }
        await ctx.api._testSendMessage("blocked");
        assert.equal(requests, 0);
        assert.equal(ctx.api.setOwnership(true), true);
        for (const id of workspaceInputIds) {
            assert.equal(ctx.elements.get(id).disabled, false, `${id} must unlock with workspace ownership`);
        }
        assert.equal(ctx.api.suspendTransfer(), true);
        assert.equal(ctx.api.getTransferState().allowed, false);
        await ctx.api._testSendMessage("suspended");
        assert.equal(requests, 0);
        assert.equal(ctx.api.saveForTransfer(), true);
        assert.equal(checkpoint, 1);
        assert.equal(ctx.api.resumeTransfer(), true);
        ctx.api.setHostAvailable(false);
        for (const id of workspaceInputIds) {
            assert.equal(ctx.elements.get(id).disabled, true, `${id} must be inert while the host is unavailable`);
        }
        await ctx.api._testSendMessage("offline host");
        assert.equal(requests, 0);
        ctx.api.setHostAvailable(true);
    }

    // Revocation during a pending stream prevents its stale assistant from
    // being finalized into durable history.
    {
        let streamPending = false;
        const ctx = makeContext({ fetchImpl: makeFetch("hang", { onStreamPending: () => { streamPending = true; } }) });
        const sending = ctx.api._testSendMessage("ownership race");
        await flushUntil(() => streamPending, "ownership-race stream");
        ctx.api.setOwnership(false);
        await sending;
        const stored = ctx.getStoredConversations()[0];
        assert.deepEqual(stored.messages.map(message => message.role), ["user"]);
    }

    // A failed durable invalidation blocks destructive history operations.
    {
        const saved = [{ id: "protected", title: "Protected", messages: [{ role: "user", content: "Do not delete" }] }];
        const ctx = makeContext({ fetchImpl: makeFetch("complete"), seedConversations: saved });
        await ctx.api._testLoadConversation("protected");
        ctx.api.configureWorkspace({ invalidate: () => false });
        assert.equal(await ctx.api._testDeleteConversation("protected"), false);
        assert.deepEqual(ctx.getStoredConversations(), saved);
        assert.equal(ctx.api._testGetState().currentConversationId, "protected");
    }

    // Confirmation applies only in the epoch in which it was requested, and a
    // replacement stream restores as a stopped version beside the selected one.
    {
        const confirmation = deferred();
        const saved = [{ id: "confirm", title: "Confirm", messages: [{ role: "user", content: "Keep" }] }];
        const ctx = makeContext({ fetchImpl: makeFetch("complete"), seedConversations: saved,
            confirmImpl: () => confirmation.promise, extraElementIds: [
                "btn-chat-send", "btn-chat-stop", "btn-chat-undo", "btn-chat-regenerate", "btn-chat-clear", "btn-delete-all-history",
            ] });
        ctx.api.init();
        await ctx.api._testLoadConversation("confirm");
        const deleteButton = ctx.elements.get("chat-history-list").querySelector(".chat-history-item-delete");
        const deleting = deleteButton._listeners.click[0]({ stopPropagation() {} });
        await flush();
        ctx.api.setOwnership(false);
        confirmation.resolve(true);
        await deleting;
        assert.deepEqual(ctx.getStoredConversations(), saved, "stale confirmation cannot delete after revocation");
    }
    {
        let streamPending = false;
        const ctx = makeContext({ fetchImpl: makeFetch("hang", { onStreamPending: () => { streamPending = true; } }),
            seedConversations: [{ id: "versioned", messages: [
                { role: "user", content: "Question" }, { role: "assistant", content: "Original" },
            ] }] });
        await ctx.api._testLoadConversation("versioned");
        const sending = ctx.api._testRegenerateResponse();
        await flushUntil(() => streamPending, "replacement stream");
        const snapshot = plain(ctx.api.captureSnapshot({ transferId: "version-recovery" }));
        ctx.api.setOwnership(false);
        await sending;
        assert.equal(ctx.api.restoreSnapshot(snapshot), true);
        const answer = plain(ctx.api._testGetState().chatMessages.at(-1));
        assert.equal(answer.content, "Original");
        assert.equal(answer.versionIndex, 0);
        assert.equal(answer.versions.length, 2);
        assert.equal(answer.versions[1].content, PARTIAL_TOKEN);
        assert.equal(answer.versions[1].status, "stopped");
    }

    // Integration fixture: both real Chat UI instances use the coordinator's
    // exact peer references and shared recovery store for A → B → A transfer.
    // This intentionally asserts the complete round trip so a checkpoint made
    // by saveForTransfer cannot silently leave the prepared revision stale.
    // Both contexts share one Map, which faithfully models same-partition
    // localStorage here: stored values are strings (immutable, so no caller
    // can mutate another context's state without a setItem), and each context
    // parses its own copy on read.
    {
        const sharedUiStorage = new Map();
        const recoveryStorage = new IntegrationRecoveryStorage();
        const locks = new FakeLocks();
        const fixtureConversation = [{ id: "roundtrip", title: "Fixture title", titleCustom: true,
            systemPrompt: "Fixture system", thinkingEffort: "medium", timestamp: Date.now(),
            messages: [
                { role: "user", content: "Fixture question", reasoning: "", status: "complete" },
                { role: "assistant", content: "Fixture answer", reasoning: "Fixture thought", status: "complete",
                    sources: [{ index: 1, title: "Fixture source", url: "https://example.test/source" }],
                    metadata: { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }, timings: { predicted_per_second: 3 } },
                },
            ], compactions: [], }];
        const ctxA = makeContext({ fetchImpl: makeFetch("complete"), seedConversations: fixtureConversation,
            sharedStorageMap: sharedUiStorage, loadChatWindow: true, extraElementIds: [
                "chat-web-search-toggle", "chat-web-search-max-results", "chat-auto-compact-toggle",
            ] });
        const ctxB = makeContext({ fetchImpl: makeFetch("complete"), sharedStorageMap: sharedUiStorage, loadChatWindow: true,
            extraElementIds: ["chat-web-search-toggle", "chat-web-search-max-results", "chat-auto-compact-toggle"] });
        const peerA = {};
        const peerB = {};
        const origin = "http://127.0.0.1:5240";
        const sessionId = "real-ui-roundtrip";
        const sent = [];
        let coordinatorA;
        let coordinatorB;
        const sendA = (message, messageOrigin, target) => {
            sent.push({ from: "A", message: plain(message), origin: messageOrigin, target });
            const handled = coordinatorB.receiveMessage({ data: plain(message), origin: messageOrigin, source: peerA });
            sent.at(-1).handled = handled;
            return handled;
        };
        const sendB = (message, messageOrigin, target) => {
            sent.push({ from: "B", message: plain(message), origin: messageOrigin, target });
            const handled = coordinatorA.receiveMessage({ data: plain(message), origin: messageOrigin, source: peerB });
            sent.at(-1).handled = handled;
            return handled;
        };
        coordinatorA = ctxA.chatWindow.createCoordinator({ instanceId: "A", sessionId, origin, locks,
            storage: recoveryStorage, chatUi: ctxA.api, transport: { send: sendA }, transferTimeoutMs: 500, window: ctxA.window });
        coordinatorB = ctxB.chatWindow.createCoordinator({ instanceId: "B", sessionId, origin, locks,
            storage: recoveryStorage, chatUi: ctxB.api, transport: { send: sendB }, transferTimeoutMs: 500, window: ctxB.window });
        ctxA.api.configureWorkspace({
            checkpoint: snapshot => coordinatorA.checkpoint(snapshot),
            invalidate: () => coordinatorA.invalidateRecovery().ok,
        });
        ctxB.api.configureWorkspace({
            checkpoint: snapshot => coordinatorB.checkpoint(snapshot),
            invalidate: () => coordinatorB.invalidateRecovery().ok,
        });
        coordinatorA.attachPeer(peerB, { peerId: "B", sessionId, origin });
        coordinatorB.attachPeer(peerA, { peerId: "A", sessionId, origin });
        assert.equal((await coordinatorA.initialize({ recover: false })).ok, true);
        assert.equal((await coordinatorB.initialize({ acquire: false, recover: false })).ok, true);
        assert.equal(coordinatorA.beginHandshake(), true);
        await flush();
        assert.equal(coordinatorA.isPeerVerified(), true);
        assert.equal(coordinatorB.isPeerVerified(), true);
        assert.equal(await ctxA.api._testLoadConversation("roundtrip"), true);
        ctxA.elements.get("chat-input").value = "Draft survives both transfers";
        ctxA.elements.get("chat-system-prompt").value = "Updated fixture system";
        const first = await coordinatorA.beginTransfer({ destinationId: "B", transferId: "a-to-b", timeoutMs: 500 });
        assert.equal(first, true, `A → B transfer failed: A=${JSON.stringify(coordinatorA.getState())} B=${JSON.stringify(coordinatorB.getState())} sent=${JSON.stringify(sent)}`);
        assert.equal(coordinatorB.isOwner(), true);
        assert.equal(ctxB.elements.get("chat-input").value, "Draft survives both transfers");
        assert.equal(ctxB.elements.get("chat-system-prompt").value, "Updated fixture system");
        const firstRecord = JSON.parse(recoveryStorage.getItem(coordinatorA.storageKey));
        assert.equal(firstRecord.phase, "prepared", "A → B leaves a durable prepared checkpoint");
        assert.ok(Number.isInteger(firstRecord.revision) && firstRecord.revision > 0,
            "A → B checkpoint has a positive durable revision");
        assert.equal(firstRecord.revision, coordinatorA.getState().revision,
            "A → B checkpoint revision matches the completed source transfer");
        assert.deepEqual(firstRecord.transfer, {
            sourceId: "A", destinationId: "B", sourceInstanceId: "A", destinationInstanceId: "B",
            transferId: "a-to-b", revision: firstRecord.revision,
        }, "A → B checkpoint identifies both transfer endpoints");
        const second = await coordinatorB.beginTransfer({ destinationId: "A", transferId: "b-to-a", timeoutMs: 500 });
        assert.equal(second, true, `B → A transfer failed: ${JSON.stringify(coordinatorB.getState())}`);
        assert.equal(coordinatorA.isOwner(), true);
        assert.equal(coordinatorB.isOwner(), false);
        assert.equal(ctxA.elements.get("chat-input").value, "Draft survives both transfers");
        assert.equal(ctxA.api._testGetState().chatMessages.at(-1).content, "Fixture answer");
        assert.equal(ctxA.api._testGetState().chatMessages.at(-1).metadata.timings.predicted_per_second, 3);
        const secondRecord = JSON.parse(recoveryStorage.getItem(coordinatorA.storageKey));
        assert.equal(secondRecord.phase, "prepared", "B → A leaves a durable prepared checkpoint");
        assert.ok(secondRecord.revision > firstRecord.revision, "B → A advances the durable revision");
        assert.deepEqual(secondRecord.transfer, {
            sourceId: "B", destinationId: "A", sourceInstanceId: "B", destinationInstanceId: "A",
            transferId: "b-to-a", revision: secondRecord.revision,
        }, "B → A checkpoint identifies the reversed endpoints");
        const finalConversations = ctxA.getStoredConversations();
        assert.equal(finalConversations.length, 1, "A → B → A never duplicates durable history");
        assert.equal(finalConversations[0].id, "roundtrip");
        for (const entry of sent) {
            assert.equal(entry.origin, origin);
            assert.equal(entry.target, entry.from === "A" ? peerB : peerA, "transport keeps the registered peer reference");
        }
        coordinatorA.dispose();
        coordinatorB.dispose();
    }

    console.log("chat_ui_unit.cjs: all tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
