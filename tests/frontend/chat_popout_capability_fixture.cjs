const http = require("node:http");

const PROTOCOL_VERSION = 1;
const STORAGE_PREFIX = "chat-popout-capability:";

function pageHtml() {
    return `<!doctype html>
<meta charset="utf-8">
<title>Chat pop-out capability fixture</title>
<main>
  <h1>Disposable chat pop-out fixture</h1>
  <p id="role"></p>
  <button id="btn-popout" type="button">Pop out</button>
  <button id="btn-open-attacker" type="button">Open attacker</button>
  <p id="status" role="status"></p>
  <dl>
    <dt>Secure context</dt><dd id="secure-context"></dd>
    <dt>Storage</dt><dd id="storage-capability"></dd>
    <dt>Web Locks</dt><dd id="locks-capability"></dd>
    <dt>Opener</dt><dd id="opener-capability"></dd>
  </dl>
</main>
<script>
(() => {
    const params = new URLSearchParams(location.search);
    const role = params.get("role") || "main";
    const mode = params.get("mode") || "normal";
    const nonce = params.get("nonce") || "missing";
    const protocolVersion = ${PROTOCOL_VERSION};
    const storageKey = ${JSON.stringify(STORAGE_PREFIX)} + nonce;
    const state = {
        role,
        mode,
        nonce,
        origin: location.origin,
        storageKey,
        popup: null,
        popupState: "idle",
        popupClosedObserved: false,
        popupOpened: false,
        openerPresent: false,
        hello: null,
        ready: null,
        focusAck: null,
        rejected: [],
        fallback: "",
        attackerOpened: false,
        lock: { status: "idle", name: "", events: [] },
        releaseLock: null,
    };

    const status = document.getElementById("status");
    const setStatus = (message) => {
        state.fallback = String(message || "");
        status.textContent = state.fallback;
    };
    const hasWebLocks = () => Boolean(
        navigator.locks && typeof navigator.locks.request === "function"
    );
    const probeStorage = () => {
        try {
            const storage = window.localStorage;
            const probeKey = storageKey + ":probe";
            storage.setItem(probeKey, nonce);
            const value = storage.getItem(probeKey);
            storage.removeItem(probeKey);
            return { available: value === nonce, value: storage.getItem(storageKey) };
        } catch (error) {
            return { available: false, value: null };
        }
    };
    const capabilities = () => ({
        secureContext: window.isSecureContext === true,
        storage: probeStorage().available,
        webLocks: hasWebLocks(),
        popup: typeof window.open === "function",
        opener: role !== "popup" || Boolean(window.opener),
    });
    const setCapabilityText = () => {
        const caps = capabilities();
        document.getElementById("secure-context").textContent = String(caps.secureContext);
        document.getElementById("storage-capability").textContent = String(caps.storage);
        document.getElementById("locks-capability").textContent = String(caps.webLocks);
        document.getElementById("opener-capability").textContent = String(caps.opener);
        return caps;
    };
    const getState = () => ({
        role: state.role,
        mode: state.mode,
        nonce: state.nonce,
        origin: state.origin,
        storageKey: state.storageKey,
        popupOpened: state.popupOpened,
        popupState: state.popupState,
        popupClosedObserved: state.popupClosedObserved,
        openerPresent: state.openerPresent,
        hello: state.hello,
        ready: state.ready,
        focusAck: state.focusAck,
        rejected: state.rejected.slice(),
        fallback: state.fallback,
        attackerOpened: state.attackerOpened,
        lock: { ...state.lock, events: state.lock.events.slice() },
    });
    const sourceMatches = (event) => Boolean(state.popup && event.source === state.popup);
    const recordRejected = (reason, event, data) => {
        state.rejected.push({
            reason,
            origin: event.origin,
            sourceMatches: sourceMatches(event),
            version: data && data.version,
        });
    };
    const validMessage = (event, data, requirePopup = true) => {
        if (event.origin !== state.origin) {
            recordRejected("origin", event, data);
            return false;
        }
        if (requirePopup && !sourceMatches(event)) {
            recordRejected("source", event, data);
            return false;
        }
        if (!data || data.version !== protocolVersion) {
            recordRejected("version", event, data);
            return false;
        }
        if (data.nonce !== nonce) {
            recordRejected("nonce", event, data);
            return false;
        }
        return true;
    };
    const postTo = (target, message) => {
        if (target && typeof target.postMessage === "function") {
            target.postMessage(message, state.origin);
        }
    };

    window.__fixture = {
        getState,
        getCapabilities: setCapabilityText,
        storageKey,
        writeStorage() {
            try {
                window.localStorage.setItem(storageKey, nonce);
                return true;
            } catch (error) {
                return false;
            }
        },
        readStorage() {
            try { return window.localStorage.getItem(storageKey); } catch (error) { return null; }
        },
        storageKeys() {
            try { return Object.keys(window.localStorage); } catch (error) { return []; }
        },
        sendInvalidVersion() {
            postTo(window.opener, {
                type: "chat-popout:hello",
                version: protocolVersion + 1,
                nonce,
            });
        },
        async lockQuery() {
            if (!navigator.locks || typeof navigator.locks.query !== "function") return null;
            return navigator.locks.query();
        },
        acquireLock(name) {
            if (!hasWebLocks()) return false;
            state.lock = { status: "waiting", name: String(name), events: [] };
            navigator.locks.request(String(name), { mode: "exclusive" }, async () => {
                state.lock.status = "held";
                state.lock.events.push("acquired");
                await new Promise((resolve) => { state.releaseLock = resolve; });
                state.lock.events.push("released");
                state.lock.status = "released";
                state.releaseLock = null;
            }).catch((error) => {
                state.lock.status = "error";
                state.lock.events.push(String(error && error.name || "lock-error"));
            });
            return true;
        },
        releaseLock() {
            if (state.releaseLock) {
                state.releaseLock();
                return true;
            }
            return false;
        },
    };

    document.getElementById("role").textContent = "Role: " + role;
    setCapabilityText();

    if (role === "attacker") {
        const targetOrigin = params.get("targetOrigin") || "";
        window.addEventListener("load", () => {
            if (window.opener) {
                window.opener.postMessage({
                    type: "chat-popout:hello",
                    version: protocolVersion,
                    nonce,
                }, targetOrigin);
            }
        }, { once: true });
        return;
    }

    if (role === "popup") {
        if (mode === "no-opener") {
            try { window.opener = null; } catch (error) {
                console.debug("Fixture could not simulate a missing opener", error);
            }
        }
        const openerRef = window.opener;
        state.openerPresent = Boolean(openerRef);
        document.getElementById("btn-popout").hidden = true;
        document.getElementById("btn-open-attacker").hidden = true;
        if (!openerRef) {
            setStatus("Pop out unavailable: the receiver could not verify its opener and origin.");
            state.popupState = "fallback";
            return;
        }
        window.addEventListener("message", (event) => {
            const data = event.data;
            if (!validMessage(event, data, false) || event.source !== openerRef) {
                if (event.origin === state.origin && event.source !== openerRef) {
                    recordRejected("source", event, data);
                }
                return;
            }
            if (data.type !== "chat-popout:ready") return;
            state.ready = { origin: event.origin, sourceMatches: event.source === openerRef, version: data.version };
            window.focus();
            postTo(openerRef, {
                type: "chat-popout:focused",
                version: protocolVersion,
                nonce,
                focused: document.hasFocus(),
            });
        });
        const storage = probeStorage();
        if (!storage.available) {
            setStatus("Pop out unavailable: the receiver has no usable storage partition.");
            state.popupState = "fallback";
            return;
        }
        postTo(openerRef, {
            type: "chat-popout:hello",
            version: protocolVersion,
            nonce,
            storageValue: storage.value,
        });
        return;
    }

    window.addEventListener("message", (event) => {
        const data = event.data;
        if (!validMessage(event, data)) return;
        if (data.type === "chat-popout:hello") {
            state.hello = {
                origin: event.origin,
                sourceMatches: sourceMatches(event),
                version: data.version,
                nonce: data.nonce,
                storageValue: data.storageValue,
            };
            state.popupState = "verified-pending-focus";
            postTo(event.source, {
                type: "chat-popout:ready",
                version: protocolVersion,
                nonce,
            });
        } else if (data.type === "chat-popout:focused") {
            state.focusAck = {
                origin: event.origin,
                sourceMatches: sourceMatches(event),
                version: data.version,
                focused: data.focused === true,
            };
            state.popupState = "verified";
        }
    });

    document.getElementById("btn-popout").addEventListener("click", () => {
        const caps = setCapabilityText();
        if (!caps.secureContext) {
            setStatus("Pop out unavailable: this page is not a secure context.");
            state.popupState = "fallback";
            return;
        }
        if (!caps.storage) {
            setStatus("Pop out unavailable: storage partition is unavailable.");
            state.popupState = "fallback";
            return;
        }
        if (!caps.webLocks) {
            setStatus("Pop out unavailable: this browser does not provide exclusive Web Locks.");
            state.popupState = "fallback";
            return;
        }
        if (typeof window.open !== "function") {
            setStatus("Pop out unavailable: this browser cannot open a named window.");
            state.popupState = "fallback";
            return;
        }
        const childUrl = new URL(location.href);
        childUrl.searchParams.set("role", "popup");
        state.popupState = "opening";
        state.popup = window.open(childUrl.href, "llama-gui-chat-capability", "popup,width=720,height=640,resizable=yes");
        state.popupOpened = Boolean(state.popup);
        if (!state.popup) {
            setStatus("Pop out unavailable: the popup was blocked or no window reference was returned.");
            state.popupState = "fallback";
            return;
        }
        const closeTimer = window.setInterval(() => {
            if (state.popup && state.popup.closed) {
                state.popupClosedObserved = true;
                state.popupState = "closed";
                window.clearInterval(closeTimer);
            }
        }, 25);
        window.setTimeout(() => {
            if (state.popupState === "opening" || state.popupState === "verified-pending-focus") {
                setStatus("Pop out unavailable: the receiver did not complete the verified handshake.");
                state.popupState = "fallback";
            }
        }, 1500);
    });

    document.getElementById("btn-open-attacker").addEventListener("click", () => {
        const attackerUrl = new URL(location.href);
        attackerUrl.hostname = "localhost";
        attackerUrl.searchParams.set("role", "attacker");
        attackerUrl.searchParams.set("targetOrigin", location.origin);
        state.attackerOpened = Boolean(window.open(attackerUrl.href, "chat-popout-attacker", "popup,width=480,height=320"));
    });
})();
</script>`;
}

function startCapabilityFixture() {
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url, headers: { ...request.headers } });
        if (request.method === "GET" && new URL(request.url, "http://127.0.0.1").pathname === "/") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            response.end(pageHtml());
            return;
        }
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
    });
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", onError);
            const address = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${address.port}/`,
                requests,
                async close() {
                    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
                    await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
                },
            });
        });
    });
}

module.exports = {
    PROTOCOL_VERSION,
    STORAGE_PREFIX,
    startCapabilityFixture,
};
