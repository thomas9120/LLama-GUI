const assert = require("node:assert/strict");

// Small Web Locks stand-in shared by coordinator and real-UI unit tests. It
// keeps exclusive ownership until the callback's returned hold promise settles
// and rejects queued requests when their AbortSignal cancels them.
// This is a deterministic single-lock fixture; browser tests cover real
// cross-context scheduling and lock release when a window closes.
class FakeLocks {
    constructor() {
        this.name = null;
        this.held = null;
        this.queue = [];
        this.calls = [];
    }

    request(name, options, callback) {
        assert.equal(typeof name, "string");
        if (this.name === null) this.name = name;
        assert.equal(name, this.name, "FakeLocks supports a single lock name per instance");
        assert.equal(options.mode, "exclusive");
        assert.equal(options.ifAvailable && Boolean(options.signal), false,
            "ifAvailable requests must not carry AbortSignal");
        this.calls.push({ name, options });
        return new Promise((resolve, reject) => {
            const request = { name, options, callback, resolve, reject, cancelled: false };
            const enqueue = () => {
                if (options.signal?.aborted) {
                    request.cancelled = true;
                    reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                    return;
                }
                if (request.cancelled) return;
                if (this.held) {
                    if (options.ifAvailable) {
                        Promise.resolve().then(() => callback(null)).then(resolve, reject);
                    } else {
                        this.queue.push(request);
                        options.signal?.addEventListener("abort", () => {
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

module.exports = { FakeLocks };
