const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const renderingSource = fs.readFileSync(path.join(ROOT, "ui", "js", "chat-rendering.js"), "utf8");
const appDataSource = fs.readFileSync(path.join(ROOT, "ui", "js", "app-data.js"), "utf8");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "chat-ui.js"), "utf8");

const STORAGE_KEY = "llama_gui_conversations";
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
                return Promise.resolve();
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
    flagValues = {},
    status,
    storageMode = "normal",
    extraElementIds = [],
}) {
    const elements = new Map();
    const storageMap = new Map();
    if (seedConversations.length) {
        storageMap.set(STORAGE_KEY, JSON.stringify(seedConversations));
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
            setItem: (key, value) => storageMap.set(key, String(value)),
            removeItem: (key) => storageMap.delete(key),
        };

    const context = {
        // Must be set before chat-ui.js is evaluated: the _test* hooks are only
        // attached to the namespace when this opt-in flag is present.
        window: { LlamaGui: {}, __LLAMA_GUI_TEST_HOOKS__: true },
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
        clearTimeout: () => {},
        setTimeout: (handler) => {
            handler();
            return 1;
        },
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(renderingSource, context, { filename: "ui/js/chat-rendering.js" });
    vm.runInContext(appDataSource, context, { filename: "ui/js/app-data.js" });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/js/chat-compaction.js"), "utf8"), context, { filename: "ui/js/chat-compaction.js" });
    vm.runInContext(source, context, { filename: "ui/js/chat-ui.js" });

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
        confirmAction: async () => true,
        getLatestStatus: () => mutable.status,
        getLifecycleSnapshot: () => mutable.lifecycle || null,
        snapshotStatsBaseline: () => {},
        getApiAuthorizationHeaders: (headers) => headers,
        switchTab: () => {},
    });

    const getStoredConversations = () => JSON.parse(storageMap.get(STORAGE_KEY) || "[]");
    return {
        api,
        elements,
        getStoredConversations,
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
        const { api, getStoredConversations } = makeContext({ fetchImpl: makeFetch("complete") });
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
        for (const key of ["top_k", "repeat_penalty", "max_tokens"]) {
            assert.ok(!(key in body), `string form of the "${key}" disable sentinel must be omitted`);
        }
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

    console.log("chat_ui_unit.cjs: all tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
