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
    const context = { window, console: window.console, setTimeout, clearTimeout, AbortController };
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
    const initialState = {
        conversationId: "",
        title: `${name} title`,
        draft: `${name} draft`,
        messages: [{ role: "user", content: `${name} message`, reasoning: "reasoning", sources: [{ title: "source", url: "https://example.test" }] }],
        compactions: [{ end: 0, summary: "summary" }],
    };
    const state = clone(initialState);
    const ui = {
        name, owner: true, suspended: false, busy: false, hostAvailable: true,
        saves: 0, captures: 0, restores: 0, resets: 0, interrupted: 0,
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
        resetWorkspace() {
            Object.keys(state).forEach(key => delete state[key]);
            Object.assign(state, { conversationId: "", title: "", draft: "", messages: [], compactions: [] });
            this.resets += 1;
            this.suspended = false;
            return true;
        },
        setSnapshotState(nextState) { Object.assign(state, clone(nextState)); },
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
    const transferTimeoutMs = options.transferTimeoutMs === undefined ? 100 : options.transferTimeoutMs;
    const origin = "http://127.0.0.1:5240";
    const peerA = {};
    const peerB = {};
    const uiA = makeUi("A");
    const uiB = makeUi("B");
    let a;
    let b;
    const sent = [];
    const deliver = (from, message, target, source) => {
        sent.push({ from, message: clone(message) });
        if (typeof options.drop === "function" && options.drop(from, message)) return;
        target.receiveMessage({ data: clone(message), origin, source });
    };
    const sendA = message => deliver("A", message, b, peerA);
    const sendB = message => deliver("B", message, a, peerB);
    a = api.createCoordinator({ instanceId: "A", sessionId, origin, locks, storage, chatUi: uiA, transport: { send: sendA }, transferTimeoutMs });
    b = api.createCoordinator({ instanceId: "B", sessionId, origin, locks, storage, chatUi: uiB, transport: { send: sendB }, transferTimeoutMs });
    a.attachPeer(peerB, { peerId: "B", sessionId, origin });
    b.attachPeer(peerA, { peerId: "A", sessionId, origin });
    return { a, b, uiA, uiB, locks, storage, peerA, peerB, sessionId, origin, sent };
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

function waitForCoordinatorState(coordinator, predicate, description, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        const finish = (state) => {
            if (settled) return;
            let matches = false;
            try { matches = predicate(state); } catch (error) {
                settled = true;
                clearTimeout(timer);
                unsubscribe();
                reject(error);
                return;
            }
            if (!matches) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(state);
        };
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            unsubscribe();
            reject(new Error(`timed out after ${timeoutMs} ms waiting for ${description}`));
        }, timeoutMs);
        unsubscribe = coordinator.subscribe(finish);
        finish(coordinator.getState());
    });
}

function waitForCondition(predicate, description, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            try {
                if (predicate()) {
                    resolve();
                    return;
                }
            } catch (error) {
                reject(error);
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error(`timed out after ${timeoutMs} ms waiting for ${description}`));
                return;
            }
            setTimeout(check, 5);
        };
        check();
    });
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
        assert.equal(c.receiveMessage({ data: Object.assign({}, messages[0], { sessionId: "other-session" }), origin: "https://gui.test", source: peer }), false);
        assert.equal(c.receiveMessage({ data: Object.assign({}, messages[0], { sourceId: "attacker" }), origin: "https://gui.test", source: peer }), false);
        assert.equal(c.receiveMessage({ data: Object.assign({}, messages[0], { epoch: -1 }), origin: "https://gui.test", source: {} }), false);
    }

    // A coordinator without a trustworthy origin must reject every hello,
    // including an event whose origin is itself empty.
    {
        const messages = [];
        const c = api.createCoordinator({ instanceId: "no-origin", sessionId: "s", origin: "", locks: new FakeLocks(),
            storage: new FakeStorage(), chatUi: makeUi("no-origin"), transport: { send: message => messages.push(message) } });
        const peer = {};
        c.attachPeer(peer, { peerId: "receiver", sessionId: "s", origin: "" });
        const hello = {
            channel: "llama-gui-chat-window", version: 1, type: "hello", sessionId: "s",
            sourceId: "receiver", destinationId: "no-origin", epoch: 0,
        };
        assert.equal(c.receiveMessage({ data: hello, origin: "", source: peer }), false);
        assert.equal(c.receiveMessage({ data: hello, origin: "https://evil.test", source: peer }), false);
        assert.equal(c.isPeerVerified(), false);
        assert.deepEqual(messages, []);
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

    // A receiver queued behind a still-held lock must time out its commit
    // acquisition. Releasing the competing owner afterward must not grant the
    // canceled request or activate the receiver late.
    {
        const pair = makePeerPair(api);
        await preparePair(pair);
        const snapshot = pair.uiA.captureSnapshot({ sourceId: "A", destinationId: "B", transferId: "held", revision: 1 });
        assert.equal(pair.a.checkpoint(snapshot, {
            sourceId: "A", destinationId: "B", transferId: "held", revision: 1,
        }), true, "the queued commit must have a valid durable record to revalidate");
        const epoch = pair.a.getState().epoch;
        const baseMessage = {
            channel: "llama-gui-chat-window", version: 1, sessionId: pair.sessionId,
            sourceId: "A", destinationId: "B", epoch, transferId: "held", revision: 1,
        };
        assert.equal(pair.b.receiveMessage({
            data: Object.assign({}, baseMessage, { type: "prepare", payload: { snapshot } }),
            origin: pair.origin, source: pair.peerA,
        }), true);
        await waitForCoordinatorState(pair.b, state => state.transfer?.phase === "prepared", "receiver prepare");
        assert.equal(pair.b.receiveMessage({
            data: Object.assign({}, baseMessage, { type: "commit" }),
            origin: pair.origin, source: pair.peerA,
        }), true);
        await waitForCoordinatorState(pair.b, state => state.status === "acquiring", "receiver lock acquisition");
        const failed = await waitForCoordinatorState(pair.b, state => state.status === "recovery-required", "receiver lock timeout");
        assert.equal(failed.transfer?.phase, "failed");
        assert.equal(pair.sent.some(item => item.from === "B"
            && item.message.type === "reject" && item.message.reason === "ownership-failed"), true,
        "timed-out receiver must reject the transfer");
        assert.equal(pair.locks.queue.length, 0);
        pair.a.releaseOwnership();
        await flush();
        assert.equal(pair.b.isOwner(), false, "a timed-out commit cannot acquire after the competing lock is released");
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

    // A receiver close/reject before readiness resumes the source. A receiver
    // disappearing after release leaves exactly one owner and requires explicit
    // recovery; a timeout must never reactivate the source.
    {
        const beforeReady = makePeerPair(api, { drop: (from, message) => from === "B" && message.type === "ready" });
        await preparePair(beforeReady);
        assert.equal(await beforeReady.a.beginTransfer({ destinationId: "B", timeoutMs: 20 }), false);
        assert.equal(beforeReady.a.isOwner(), true);
        assert.equal(beforeReady.uiA.owner, true);
        assert.equal(beforeReady.b.isOwner(), false);
        beforeReady.b.dispose();

        const afterRelease = makePeerPair(api, { drop: (from, message) => from === "B" && message.type === "owner-ack" });
        await preparePair(afterRelease);
        assert.equal(await afterRelease.a.beginTransfer({ destinationId: "B", timeoutMs: 20 }), false);
        assert.equal(afterRelease.a.isOwner(), false);
        assert.equal(afterRelease.b.isOwner(), true);
        assert.equal(afterRelease.a.getState().status, "recovery-required");
        assert.equal(afterRelease.uiA.owner, false);
        assert.equal(afterRelease.uiB.owner, true);
    }

    // Invalidation while a receiver is awaiting restore must retire the
    // stale continuation. It cannot publish ready or leave a lockless owner
    // after the restore promise settles.
    {
        const pair = makePeerPair(api);
        await preparePair(pair);
        let finishRestore;
        let restoreStarted = false;
        pair.uiB.restoreSnapshot = () => new Promise(resolve => {
            restoreStarted = true;
            finishRestore = resolve;
        });
        const snapshot = pair.uiA.captureSnapshot({ sourceId: "A", destinationId: "B", transferId: "prepare-invalidation", revision: 1 });
        const message = {
            channel: "llama-gui-chat-window", version: 1, type: "prepare", sessionId: pair.sessionId,
            sourceId: "A", destinationId: "B", epoch: pair.a.getState().epoch,
            transferId: "prepare-invalidation", revision: 1, payload: { snapshot },
        };
        assert.equal(pair.b.receiveMessage({ data: message, origin: pair.origin, source: pair.peerA }), true);
        await waitForCondition(() => restoreStarted, "receiver restore to start");
        assert.equal(pair.b.getState().transfer?.phase, "restoring");
        assert.equal(await pair.b.invalidateSession(), true);
        finishRestore(true);
        await flush();
        assert.equal(pair.b.isOwner(), false);
        assert.notEqual(pair.b.getState().transfer?.phase, "prepared");
        assert.equal(pair.sent.some(item => item.from === "B" && item.message.type === "ready"), false,
            "an invalidated restore must not publish ready");
    }

    // The commit path awaits a second restore while holding the destination
    // lock. Invalidation during that await must release the lock and prevent
    // a late restore completion from publishing ownership or owner-ack.
    {
        const pair = makePeerPair(api, { transferTimeoutMs: 1000 });
        await preparePair(pair);
        let restoreCalls = 0;
        let finishPrepare;
        let finishCommit;
        pair.uiB.restoreSnapshot = () => {
            restoreCalls += 1;
            return new Promise(resolve => {
                if (restoreCalls === 1) finishPrepare = resolve;
                else finishCommit = resolve;
            });
        };
        const transfer = pair.a.beginTransfer({ destinationId: "B", transferId: "commit-invalidation", timeoutMs: 100 });
        await waitForCondition(() => restoreCalls === 1, "prepare restore to start");
        finishPrepare(true);
        await waitForCoordinatorState(pair.b, state => state.status === "prepared", "receiver prepared state");
        await waitForCondition(() => restoreCalls === 2, "commit restore to start");
        assert.equal(pair.b.getState().status, "acquiring");
        assert.equal(await pair.b.invalidateSession(), true);
        finishCommit(true);
        assert.equal(await transfer, false);
        await flush();
        assert.equal(pair.b.isOwner(), false, "an invalidated commit cannot become owner after restore settles");
        assert.equal(pair.a.isOwner(), false);
        assert.equal(pair.sent.some(item => item.from === "B" && item.message.type === "owner-ack"), false,
            "an invalidated commit must not publish owner-ack");
    }

    // A source that times out waiting for owner-ack remains recoverable.
    // A delayed ack and a later competing-lock release cannot reactivate it;
    // explicit recovery must make a fresh peer transfer valid again.
    {
        let droppedAck = null;
        let dropNextAck = true;
        const hookedPair = makePeerPair(api, {
            transferTimeoutMs: 100,
            drop: (from, message) => {
                if (from === "B" && message.type === "owner-ack" && dropNextAck) {
                    dropNextAck = false;
                    droppedAck = clone(message);
                    return true;
                }
                return false;
            },
        });
        await preparePair(hookedPair);
        const first = hookedPair.a.beginTransfer({ destinationId: "B", transferId: "owner-ack-timeout", timeoutMs: 100 });
        await waitForCoordinatorState(hookedPair.b, state => state.ownership === true && state.status === "active", "receiver ownership");
        assert.equal(await first, false);
        const sourceState = hookedPair.a.getState();
        assert.equal(sourceState.status, "recovery-required");
        assert.equal(sourceState.ownership, false);
        assert.ok(droppedAck, "the receiver must have attempted the owner acknowledgment");
        assert.equal(hookedPair.a.receiveMessage({ data: droppedAck, origin: hookedPair.origin, source: hookedPair.peerB }), true);
        await flush();
        assert.equal(hookedPair.a.isOwner(), false);
        hookedPair.b.releaseOwnership();
        await flush();
        assert.equal(hookedPair.a.isOwner(), false, "releasing the receiver lock cannot reactivate the timed-out source");

        assert.equal(await hookedPair.a.recover(), true, "source can explicitly recover after the receiver releases ownership");
        assert.equal(hookedPair.a.isOwner(), true);
        assert.equal(await hookedPair.a.beginTransfer({ destinationId: "B", transferId: "fresh-transfer", timeoutMs: 100 }), true,
            "a fresh peer transfer remains possible after recovery");
        assert.equal(hookedPair.b.isOwner(), true);
        hookedPair.b.releaseOwnership();
    }

    // Invalidating while owner-ack is pending retires the operation.  A late
    // acknowledgment must not resurrect ownership or transfer state.
    {
        let droppedAck = null;
        const invalidatedPair = makePeerPair(api, {
            transferTimeoutMs: 100,
            drop: (from, message) => {
                if (from === "B" && message.type === "owner-ack" && droppedAck === null) {
                    droppedAck = clone(message);
                    return true;
                }
                return false;
            },
        });
        await preparePair(invalidatedPair);
        const pending = invalidatedPair.a.beginTransfer({ destinationId: "B", transferId: "owner-ack-invalidation", timeoutMs: 1000 });
        await waitForCoordinatorState(invalidatedPair.b, state => state.ownership === true && state.status === "active", "receiver ownership before invalidation");
        await waitForCoordinatorState(invalidatedPair.a, state => state.transfer?.phase === "awaiting-ack", "source owner-ack wait");
        assert.equal(await invalidatedPair.a.invalidateSession(), true);
        assert.equal(await pending, false, "invalidating the source cancels the pending owner acknowledgment");
        assert.ok(droppedAck, "the invalidated transfer must have produced a delayed owner acknowledgment");
        assert.equal(invalidatedPair.a.receiveMessage({ data: droppedAck, origin: invalidatedPair.origin, source: invalidatedPair.peerB }), false,
            "a late owner acknowledgment is rejected after invalidation");
        await flush();
        assert.equal(invalidatedPair.a.isOwner(), false);
        assert.equal(invalidatedPair.a.getState().transfer, null, "invalidation retires the pending transfer");
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
        recoveredUi.setSnapshotState({ conversationId: "stale-deleted", title: "Stale chat", draft: "stale draft", messages: [{ role: "user", content: "stale" }], compactions: [{ end: 1, summary: "stale" }] });
        const recovered = api.createCoordinator({ instanceId: "recovered", sessionId: "d", origin: "http://127.0.0.1:5240", locks, storage, chatUi: recoveredUi });
        assert.equal((await recovered.initialize()).ok, true);
        assert.equal(recoveredUi.restores, 0);
        assert.equal(recoveredUi.resets, 1, "tombstone recovery resets the existing UI while holding the lock");
        assert.deepEqual(recoveredUi.snapshotState(), { conversationId: "", title: "", draft: "", messages: [], compactions: [] });
        const freshSnapshot = recovered.captureSnapshot({ sourceId: "recovered", destinationId: "recovered", transferId: "fresh", revision: 3 });
        assert.equal(recovered.validateSnapshot(freshSnapshot), true, JSON.stringify({ state: recovered.getState(), recovery: recovered.readRecovery(), owner: recovered.isOwner() }));
        assert.equal(recovered.checkpoint(freshSnapshot, { sourceId: "recovered", destinationId: "recovered", transferId: "fresh", revision: 3 }), true,
            "a fresh owner can checkpoint above the durable tombstone revision");
        assert.equal(recovered.invalidateRecovery({ sourceId: "recovered", destinationId: "recovered", transferId: "reset-again", revision: 4 }, "clear").ok, true);
        recovered.releaseOwnership();
        await flush();

        const missingResetUi = makeUi("missing-reset");
        delete missingResetUi.resetWorkspace;
        const missingReset = api.createCoordinator({ instanceId: "missing-reset", sessionId: "d", origin: "http://127.0.0.1:5240", locks, storage, chatUi: missingResetUi });
        const missingResetResult = await missingReset.initialize();
        assert.equal(missingResetResult.ok, false, "tombstone recovery fails closed when the reset hook is unavailable");
        assert.equal(missingResetResult.reason, "recovery-reset-failed");
        assert.equal(missingReset.isOwner(), false);
    }

    // Malformed recovery is discarded only by the explicit recovery action.
    {
        const storage = new FakeStorage();
        const locks = new FakeLocks();
        const ui = makeUi("malformed");
        const coordinator = api.createCoordinator({ instanceId: "malformed", sessionId: "m", origin: "http://127.0.0.1:5240", locks, storage, chatUi: ui });
        storage.setItem(coordinator.storageKey, "{broken");
        assert.equal((await coordinator.initialize()).reason, "invalid-recovery");
        assert.equal(coordinator.isOwner(), false);
        assert.equal(storage.getItem(coordinator.storageKey), "{broken");
        storage.failRemove = true;
        assert.equal(await coordinator.recover({ clearInvalid: true }), false);
        assert.equal(coordinator.isOwner(), false);
        storage.failRemove = false;
        assert.equal(await coordinator.recover({ clearInvalid: true }), true);
        assert.equal(ui.resets, 1);
        assert.deepEqual(ui.snapshotState().messages, []);
        assert.equal(coordinator.isOwner(), true);
        coordinator.dispose();
    }

    // Reinitializing an owner is idempotent and a remote abort rejection is
    // propagated as a negative acknowledgment to the requesting coordinator.
    {
        const locks = new FakeLocks();
        const storage = new FakeStorage();
        const owner = api.createCoordinator({ instanceId: "owner", sessionId: "owner-session", origin: "http://127.0.0.1:5240", locks, storage, chatUi: makeUi("owner") });
        assert.equal((await owner.initialize({ recover: false })).ok, true);
        const lockCalls = locks.calls.length;
        const repeated = await owner.initialize({ recover: false });
        assert.equal(repeated.ok, true);
        assert.equal(repeated.reason, "already-owner");
        assert.equal(owner.isOwner(), true);
        assert.equal(locks.calls.length, lockCalls, "repeated initialize does not reacquire the owner lock");

        const pair = makePeerPair(api);
        await preparePair(pair);
        pair.a.releaseOwnership();
        await flush();
        assert.equal((await pair.b.acquireOwnership({ activate: true })), true);
        pair.uiB.abortActiveStream = () => Promise.reject(new Error("synthetic abort failure"));
        await assert.rejects(pair.a.abortActiveStream(), /active Chat stream could not be stopped/);
        const negativeAck = pair.sent.find(item => item.from === "B" && item.message.type === "abort-ack");
        assert.equal(negativeAck?.message.payload?.ok, false, "remote abort failure is sent as a negative acknowledgment");
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
