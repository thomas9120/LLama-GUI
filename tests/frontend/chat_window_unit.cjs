const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "ui", "js", "chat-window.js"), "utf8");

function loadApi() {
    const window = {
        location: { origin: "http://127.0.0.1:5240" },
        console: { debug() {}, warn() {} },
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        crypto: { randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })() },
    };
    const context = { window, console: window.console, setTimeout, clearTimeout };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "chat-window.js" });
    return context.window.LlamaGui.chatWindow;
}

class FakeStorage {
    constructor() { this.values = new Map(); this.failRead = false; this.failWrite = false; this.failRemove = false; }
    getItem(key) { if (this.failRead) throw new Error("blocked"); return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { if (this.failWrite) throw new Error("quota"); this.values.set(key, value); }
    removeItem(key) { if (this.failRemove) throw new Error("blocked"); this.values.delete(key); }
}

class FakeLocks {
    constructor() { this.held = null; this.queue = []; this.calls = []; }
    request(name, options, callback) {
        assert.equal(options.mode, "exclusive");
        assert.equal(options.ifAvailable && Boolean(options.signal), false,
            "ifAvailable requests must not carry AbortSignal");
        this.calls.push({ name, options });
        return new Promise((resolve, reject) => {
            const request = { name, options, callback, resolve, reject, cancelled: false };
            const enqueue = () => {
                if (request.cancelled) return;
                if (this.held) {
                    if (options.ifAvailable) {
                        Promise.resolve().then(() => callback(null)).then(resolve, reject);
                    } else {
                        this.queue.push(request);
                        if (options.signal) options.signal.addEventListener("abort", () => {
                            request.cancelled = true;
                            this.queue = this.queue.filter(item => item !== request);
                            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                        }, { once: true });
                    }
                    return;
                }
                this.grant(request);
            };
            Promise.resolve().then(enqueue);
        });
    }
    grant(request) {
        if (request.cancelled) return;
        this.held = request;
        Promise.resolve().then(() => request.callback({ name: request.name, mode: "exclusive" }))
            .then(request.resolve, request.reject)
            .finally(() => {
                if (this.held === request) this.held = null;
                const next = this.queue.shift();
                if (next) this.grant(next);
            });
    }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeUi(name) {
    const state = {
        conversationId: "",
        title: `${name} title`,
        draft: `${name} draft`,
        messages: [{ role: "user", content: `${name} message`, reasoning: "reasoning", sources: [{ title: "source", url: "https://example.test" }] }],
        compactions: [{ end: 0, summary: "summary" }],
    };
    const ui = {
        name, owner: true, suspended: false, busy: false, hostAvailable: true,
        saves: 0, captures: 0, restores: 0, interrupted: 0,
        getTransferState() { return { allowed: this.owner && !this.suspended && !this.busy, reason: this.busy ? "busy" : "not-owner" }; },
        suspendTransfer() {
            if (!this.getTransferState().allowed) return false;
            this.suspended = true;
            return true;
        },
        resumeTransfer() { this.suspended = false; },
        setOwnership(active) { this.owner = Boolean(active); return true; },
        captureSnapshot(metadata) {
            this.captures += 1;
            return { version: 1, kind: "llama-gui-chat-workspace", metadata: clone(metadata), state: clone(state) };
        },
        validateSnapshot(snapshot) { return Boolean(snapshot && snapshot.version === 1 && snapshot.kind === "llama-gui-chat-workspace" && snapshot.state); },
        restoreSnapshot(snapshot) {
            if (!this.validateSnapshot(snapshot)) return false;
            Object.assign(state, clone(snapshot.state));
            this.restores += 1;
            this.suspended = false;
            return true;
        },
        saveForTransfer() {
            this.saves += 1;
            if (!state.conversationId) state.conversationId = `${name}-saved-${this.saves}`;
            return true;
        },
        setHostAvailable(active) { this.hostAvailable = Boolean(active); },
        snapshotState() { return clone(state); },
    };
    return ui;
}

function makePeerPair(api, options = {}) {
    const locks = options.locks || new FakeLocks();
    const storage = options.storage || new FakeStorage();
    const sessionId = options.sessionId || "session-1";
    const origin = "http://127.0.0.1:5240";
    const peerA = {};
    const peerB = {};
    const uiA = makeUi("A");
    const uiB = makeUi("B");
    let a;
    let b;
    const sendA = message => b.receiveMessage({ data: clone(message), origin, source: peerA });
    const sendB = message => a.receiveMessage({ data: clone(message), origin, source: peerB });
    a = api.createCoordinator({ instanceId: "A", sessionId, origin, locks, storage, chatUi: uiA, transport: { send: sendA }, transferTimeoutMs: 100 });
    b = api.createCoordinator({ instanceId: "B", sessionId, origin, locks, storage, chatUi: uiB, transport: { send: sendB }, transferTimeoutMs: 100 });
    a.attachPeer(peerB, { peerId: "B", sessionId, origin });
    b.attachPeer(peerA, { peerId: "A", sessionId, origin });
    return { a, b, uiA, uiB, locks, storage, peerA, peerB, sessionId, origin };
}

async function flush() { await new Promise(resolve => setImmediate(resolve)); }

async function preparePair(pair) {
    assert.equal((await pair.a.initialize({ recover: false })).ok, true, "source initializes as lock owner");
    assert.equal((await pair.b.initialize({ acquire: false, recover: false })).ok, true, "receiver stays inert");
    assert.equal(pair.a.beginHandshake(), true, "registered peer can start a cold handshake");
    await flush();
    assert.equal(pair.a.isPeerVerified(), true, `A handshake failed ${JSON.stringify(pair.a.getState())}`);
    assert.equal(pair.b.isPeerVerified(), true, `B handshake failed ${JSON.stringify(pair.b.getState())}`);
}

(async () => {
    const api = loadApi();

    // The adapter preserves explicit null/unset values, exposes only the Chat
    // request settings, and never hands a peer the host's control methods.
    {
        const calls = [];
        const core = {
            getFlagValues: () => ({ temperature: null, top_p: 0.9, ctx_size: 4096, api_key: "secret" }),
            setMultipleFlagValues: patch => calls.push(patch),
        };
        const adapter = api.createHostAdapter({
            flagCore: core,
            getChatSamplerFlagIds: () => ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "n_predict"],
            getChatModelName: () => "model.gguf",
            getStatus: () => ({ status: "running", phase: "ready", busy: false, api_key_configured: true, activeRuntime: { model: "model.gguf", alias: "safe" }, runtime_generation: 2 }),
            getInference: () => ({ targetKey: "runtime-1", seq: 3, session: { prompt: 4, generated: 3, total: 7 }, speed: { prompt: 1.2, generated: 4.5, promptIsLive: true, generatedIsLive: false }, context: { percent: 20 }, api_key: "secret" }),
        });
        assert.deepEqual(clone(adapter.getSettings()), { temperature: null, top_p: 0.9, ctx_size: 4096, selected_model: "model.gguf" });
        assert.deepEqual(clone(adapter.getStatus()), { status: "running", phase: "ready", busy: false, activeRuntime: { model: "model.gguf", alias: "safe" }, runtime_generation: 2 });
        assert.deepEqual(clone(adapter.getInference()), { targetKey: "runtime-1", seq: 3, session: { prompt: 4, generated: 3, total: 7 }, speed: { prompt: 1.2, generated: 4.5, promptIsLive: true, generatedIsLive: false }, context: { percent: 20 } });
        adapter.setSettings({ temperature: 0.2, n_predict: 32 });
        assert.deepEqual(clone(calls), [{ temperature: 0.2, n_predict: 32 }]);
        assert.throws(() => adapter.setSettings({ ctx_size: 8192 }), /not writable/);
        assert.throws(() => adapter.setSettings({ api_key: "bad" }), /not writable/);
        adapter.invalidateSession();
        assert.equal(adapter.isSessionValid(), false);
        assert.throws(() => adapter.getSettings(), /no longer available/);
        assert.equal(Object.prototype.hasOwnProperty.call(adapter, "reviveSession"), false);
    }

    // Unavailable locks keep a usable single-window owner while explaining why
    // detach is unavailable.
    {
        const ui = makeUi("single");
        const c = api.createCoordinator({ instanceId: "single", origin: "http://127.0.0.1:5240", locks: null, storage: new FakeStorage(), chatUi: ui });
        const initialized = await c.initialize();
        assert.equal(initialized.reason, "single-window");
        assert.equal(c.getState().popoutAvailable, false);
        assert.equal(c.isOwner(), true);
        assert.match(c.getState().reason, /Web Locks/);
        assert.equal(c.beginHandshake(), false);
    }

    // A registered but unverified peer is allowed to receive only the cold
    // hello. Wrong source/origin/version/epoch messages are ignored.
    {
        const messages = [];
        const c = api.createCoordinator({ instanceId: "source", sessionId: "s", origin: "https://gui.test", locks: new FakeLocks(), storage: new FakeStorage(), chatUi: makeUi("source"), transport: { send: m => messages.push(m) } });
        const peer = {};
        c.attachPeer(peer, { peerId: "receiver", sessionId: "s", origin: "https://gui.test" });
        assert.equal(c.beginHandshake(), true);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, "hello");
        assert.equal(c.receiveMessage({ data: messages[0], origin: "https://evil.test", source: peer }), false);
        assert.equal(c.receiveMessage({ data: Object.assign({}, messages[0], { version: 99 }), origin: "https://gui.test", source: peer }), false);
        assert.equal(c.receiveMessage({ data: Object.assign({}, messages[0], { epoch: -1 }), origin: "https://gui.test", source: {} }), false);
    }

    // Full A -> B -> A -> B sequence. saveForTransfer runs before capture,
    // proving an unsaved conversation ID is not lost or duplicated.
    {
        const pair = makePeerPair(api);
        await preparePair(pair);
        const first = await pair.a.beginTransfer({ destinationId: "B", timeoutMs: 100 });
        assert.equal(first, true);
        assert.equal(pair.uiA.owner, false);
        assert.equal(pair.uiB.owner, true);
        assert.equal(pair.uiA.saves, 1);
        assert.equal(pair.uiA.snapshotState().conversationId, "A-saved-1");
        assert.equal(pair.uiB.snapshotState().conversationId, "A-saved-1");
        assert.equal(pair.uiB.restores, 2, "receiver restores inertly then after lock revalidation");
        const reverse = await pair.b.beginTransfer({ destinationId: "A", timeoutMs: 100 });
        assert.equal(reverse, true, `reverse failed A=${JSON.stringify(pair.a.getState())} B=${JSON.stringify(pair.b.getState())}`);
        assert.equal(pair.uiA.owner, true);
        assert.equal(pair.uiB.owner, false);
        const third = await pair.a.beginTransfer({ destinationId: "B", timeoutMs: 100 });
        assert.equal(third, true);
        assert.equal(pair.uiB.owner, true);
        assert.equal(pair.uiA.owner, false);
        assert.equal(pair.uiB.snapshotState().conversationId, "A-saved-1");
        assert.equal(pair.uiA.saves, 2);
    }

    // Storage quota/read failures abort before source release and preserve the
    // usable owner/history. A receiver that disappears also times out before
    // commit, leaving no queued stale lock callback.
    {
        const storage = new FakeStorage();
        const pair = makePeerPair(api, { storage });
        await preparePair(pair);
        storage.failWrite = true;
        assert.equal(await pair.a.beginTransfer({ destinationId: "B", timeoutMs: 20 }), false);
        assert.equal(pair.a.isOwner(), true);
        assert.equal(pair.uiA.suspended, false);
        storage.failWrite = false;
        pair.b.dispose();
        assert.equal(await pair.a.beginTransfer({ destinationId: "B", timeoutMs: 10 }), false);
        assert.equal(pair.a.isOwner(), true);
        assert.equal(pair.locks.queue.length, 0);
    }

    // Durable tombstones win over an interrupted destructive history write;
    // stale checkpoints and nonowners cannot overwrite them.
    {
        const locks = new FakeLocks();
        const storage = new FakeStorage();
        const ui = makeUi("delete");
        const c = api.createCoordinator({ instanceId: "delete", sessionId: "d", origin: "http://127.0.0.1:5240", locks, storage, chatUi: ui });
        await c.initialize({ recover: false });
        assert.equal(c.checkpoint(c.captureSnapshot({ sourceId: "delete", destinationId: "delete", transferId: "initial", revision: 1 }), { sourceId: "delete", destinationId: "delete", transferId: "initial", revision: 1 }), true);
        assert.equal(c.invalidateRecovery({ sourceId: "delete", destinationId: "delete", transferId: "delete", revision: 2 }, "clear" ).ok, true);
        assert.equal(c.readRecovery().reason, "invalidated");
        assert.equal(c.checkpoint(c.captureSnapshot({ sourceId: "delete", destinationId: "delete", transferId: "stale", revision: 2 }), { sourceId: "delete", destinationId: "delete", transferId: "stale", revision: 2 }), false);
        c.releaseOwnership();
        await flush();
        const recoveredUi = makeUi("recovered");
        const recovered = api.createCoordinator({ instanceId: "recovered", sessionId: "d", origin: "http://127.0.0.1:5240", locks, storage, chatUi: recoveredUi });
        await recovered.initialize();
        assert.equal(recoveredUi.restores, 0);
        const freshSnapshot = recovered.captureSnapshot({ sourceId: "recovered", destinationId: "recovered", transferId: "fresh", revision: 3 });
        assert.equal(recovered.validateSnapshot(freshSnapshot), true, JSON.stringify({ state: recovered.getState(), recovery: recovered.readRecovery(), owner: recovered.isOwner() }));
        assert.equal(recovered.checkpoint(freshSnapshot, { sourceId: "recovered", destinationId: "recovered", transferId: "fresh", revision: 3 }), true,
            "a fresh owner can checkpoint above the durable tombstone revision");
    }

    // Third page contention and host-session revocation fail closed.
    {
        const pair = makePeerPair(api);
        await pair.a.initialize({ recover: false });
        const thirdUi = makeUi("third");
        const third = api.createCoordinator({ instanceId: "third", sessionId: pair.sessionId, origin: pair.origin, locks: pair.locks, storage: pair.storage, chatUi: thirdUi });
        assert.equal((await third.initialize({ recover: false })).reason, "lock-busy");
        assert.equal(thirdUi.owner, false);
        const host = api.createHostAdapter({ flagCore: { getFlagValues: () => ({ temperature: 0.8 }), setFlagValue() {} } });
        const hostLocks = new FakeLocks();
        const hostStorage = new FakeStorage();
        const hostUi = makeUi("host");
        let finishAbort;
        hostUi.abortActiveStream = () => new Promise(resolve => { finishAbort = resolve; });
        const hostCoordinator = api.createCoordinator({ instanceId: "host", sessionId: "host-session", origin: pair.origin, locks: hostLocks, storage: hostStorage, chatUi: hostUi, hostAdapter: host });
        await hostCoordinator.initialize({ recover: false });
        assert.equal(hostCoordinator.getPeerHostAdapter({}), null);
        host.invalidateSession();
        await flush();
        assert.equal(typeof finishAbort, "function");
        assert.equal(hostUi.hostAvailable, false, "new mutations pause before abort settles");
        const contender = api.createCoordinator({ instanceId: "host-contender", sessionId: "host-session", origin: pair.origin, locks: hostLocks, storage: hostStorage, chatUi: makeUi("contender") });
        assert.equal((await contender.initialize({ recover: false })).reason, "lock-busy");
        finishAbort();
        await flush();
        assert.equal(hostCoordinator.isOwner(), false);
        assert.equal(hostCoordinator.getState().hostAvailable, false);
        assert.equal(hostCoordinator.getPeerHostAdapter(), null);
    }

    // Disposing a receiver while asynchronous restore is pending must never
    // allow the continuation to reactivate a Chat without its lock.
    {
        const pair = makePeerPair(api);
        await preparePair(pair);
        let finishRestore;
        const snapshot = pair.uiA.captureSnapshot({});
        pair.a.releaseOwnership();
        await flush();
        pair.uiB.restoreSnapshot = () => new Promise(resolve => { finishRestore = resolve; });
        const activating = pair.b.acquireOwnership({ snapshot });
        await flush();
        assert.equal(typeof finishRestore, "function");
        pair.b.dispose();
        finishRestore(true);
        assert.equal(await activating, false);
        assert.equal(pair.uiB.owner, false);
        assert.equal(pair.b.isOwner(), false);
    }

    console.log("chat window coordinator tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
