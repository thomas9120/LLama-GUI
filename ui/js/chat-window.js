(function () {
    "use strict";

    // Phase 2 deliberately has no module-load side effects.  The host calls
    // createCoordinator()/configure() during the normal or detached bootstrap.
    const PROTOCOL = "llama-gui-chat-window";
    const PROTOCOL_VERSION = 1;
    const SNAPSHOT_VERSION = 1;
    const SNAPSHOT_KIND = "llama-gui-chat-workspace";
    const RECOVERY_VERSION = 1;
    const DEFAULT_LOCK_NAME = "llama-gui:chat-workspace";
    const DEFAULT_RECOVERY_KEY = "llama-gui:chat-recovery:v1";

    // Sampler fields come from Chat's existing control definitions. Keep only
    // launch fields that Chat reads but never writes here.
    const CHAT_READONLY_SETTING_FIELDS = Object.freeze(["ctx_size", "alias", "reasoning_format"]);
    // "prompt_tokens" and the other token accounting fields are valid Chat
    // metadata.  Reject credential-shaped names only; settings are separately
    // protected by the explicit allowlists below.
    const SECRET_KEY = /^(?:api[_-]?key|hf[_-]?token|access[_-]?token|auth(?:orization)?|password|passwd|secret|credential|cookie|bearer)$/i;
    const RUNTIME_FIELDS = Object.freeze([
        "tool", "source", "slot", "preset", "model", "model_name", "model_path", "model_alias",
        "alias", "backend", "phase", "busy", "status", "running", "ready", "healthy", "loaded",
        "generation", "runtime_generation", "active_runtime", "activeRuntime", "external_chat_target",
        "externalChatTarget", "external_target", "target", "host", "port", "connected", "reachable",
        "message", "error",
    ]);
    const INFERENCE_FIELDS = Object.freeze([
        "targetKey", "seq", "sources", "session", "context", "requests", "slots", "speed",
        "contextLevel", "baselinePending",
    ]);
    const INFERENCE_SESSION_FIELDS = Object.freeze(["prompt", "generated", "total"]);
    const INFERENCE_SPEED_FIELDS = Object.freeze(["prompt", "generated", "promptIsLive", "generatedIsLive"]);
    const INFERENCE_CONTEXT_FIELDS = Object.freeze(["percent", "used", "size", "capacity", "level"]);
    const INFERENCE_REQUEST_FIELDS = Object.freeze(["processing", "queued", "processingBest"]);
    const INFERENCE_SOURCE_FIELDS = Object.freeze(["metrics", "slots"]);
    const INFERENCE_SLOTS_FIELDS = Object.freeze(["busy", "total"]);

    function getWindow(options) {
        return options && options.window ? options.window
            : (typeof window !== "undefined" ? window : null);
    }

    function getConsole(options) {
        const target = getWindow(options);
        return target && target.console ? target.console : (typeof console !== "undefined" ? console : null);
    }

    function debug(options, message, error) {
        const logger = getConsole(options);
        if (logger && typeof logger.debug === "function") logger.debug(message, error);
    }

    function warn(options, message, error) {
        const logger = getConsole(options);
        if (logger && typeof logger.warn === "function") logger.warn(message, error);
    }

    function defer() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isJsonValue(value, seen) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (typeof value !== "object") return false;
        if (seen.has(value)) return false;
        seen.add(value);
        if (Array.isArray(value)) return value.every(item => isJsonValue(item, seen));
        return Object.keys(value).every(key => !SECRET_KEY.test(key) && isJsonValue(value[key], seen));
    }

    function cloneJson(value, options, label) {
        if (!isJsonValue(value, new Set())) {
            warn(options, `${label || "JSON value"} contains unsupported or sensitive data`);
            return null;
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            warn(options, `Unable to clone ${label || "JSON value"}`, error);
            return null;
        }
    }

    function pickJson(value, fields, options, label) {
        if (value === null || value === undefined || typeof value !== "object") {
            return value === undefined ? null : cloneJson(value, options, label);
        }
        if (Array.isArray(value)) return value.map(item => pickJson(item, fields, options, label));
        const picked = {};
        for (const field of fields) {
            if (Object.prototype.hasOwnProperty.call(value, field)) {
                const item = value[field];
                const nestedFields = field === "active_runtime" || field === "activeRuntime"
                    || field === "target" || field === "external_chat_target" || field === "externalChatTarget"
                    || field === "external_target" ? RUNTIME_FIELDS
                    : field === "session" ? INFERENCE_SESSION_FIELDS
                        : field === "speed" ? INFERENCE_SPEED_FIELDS
                            : field === "context" ? INFERENCE_CONTEXT_FIELDS
                                : field === "requests" ? INFERENCE_REQUEST_FIELDS
                                    : field === "sources" ? INFERENCE_SOURCE_FIELDS
                                        : field === "slots" ? INFERENCE_SLOTS_FIELDS : null;
                if (nestedFields) {
                    picked[field] = pickJson(item, nestedFields, options, `${label || "state"}.${field}`);
                } else {
                    const safe = cloneJson(item, options, `${label || "state"}.${field}`);
                    if (safe !== null || item === null) picked[field] = safe;
                }
            }
        }
        return picked;
    }

    function getOrigin(options) {
        const target = getWindow(options);
        if (options && typeof options.origin === "string") return options.origin;
        if (target && target.location && typeof target.location.origin === "string") return target.location.origin;
        return "";
    }

    function randomId(prefix, options) {
        const target = getWindow(options);
        const cryptoObject = target && target.crypto;
        if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
            try { return `${prefix}-${cryptoObject.randomUUID()}`; } catch (error) { debug(options, "randomUUID unavailable", error); }
        }
        const random = Math.random().toString(36).slice(2);
        return `${prefix}-${Date.now().toString(36)}-${random}`;
    }

    function result(ok, reason, extra) {
        return Object.assign({ ok: Boolean(ok), reason: reason || (ok ? "ok" : "unavailable") }, extra || {});
    }

    function deriveSettingFields(config) {
        const target = getWindow(config);
        let fields = config && Array.isArray(config.fields) ? config.fields : null;
        const getter = config && (config.getChatSamplerFlagIds || config.getRequestSettingFields);
        if (!fields && typeof getter === "function") {
            try { fields = getter(); } catch (error) { debug(config, "Unable to read Chat sampler fields", error); }
        }
        if (!fields && target && target.LlamaGui && target.LlamaGui.chatUi
            && typeof target.LlamaGui.chatUi.getChatSamplerFlagIds === "function") {
            try { fields = target.LlamaGui.chatUi.getChatSamplerFlagIds(); } catch (error) { debug(config, "Unable to read Chat sampler fields", error); }
        }
        const samplerFields = Array.isArray(fields) ? fields.filter(field => typeof field === "string") : [];
        return Object.freeze(Array.from(new Set(samplerFields.concat(CHAT_READONLY_SETTING_FIELDS))));
    }

    function getStorage(options) {
        if (options && Object.prototype.hasOwnProperty.call(options, "storage")) return options.storage;
        const target = getWindow(options);
        if (!target) return null;
        try { return target.localStorage; } catch (error) {
            debug(options, "localStorage is unavailable", error);
            return null;
        }
    }

    function createHostAdapter(options) {
        const config = Object.assign({}, options || {});
        const core = config.flagCore || (getWindow(config)?.LlamaGui && getWindow(config).LlamaGui.flagCore);
        const fields = deriveSettingFields(config);
        const writableFields = fields.filter(field => !CHAT_READONLY_SETTING_FIELDS.includes(field));
        const listeners = new Set();
        let valid = true;
        let hostUnsubscribe = null;

        function assertValid() {
            if (!valid) throw new Error("Chat host session is no longer available.");
        }

        function readSettings() {
            assertValid();
            let values = {};
            if (core && typeof core.getFlagValues === "function") values = core.getFlagValues() || {};
            const selectedModel = typeof config.getChatModelName === "function" ? config.getChatModelName()
                : typeof config.getSelectedModel === "function" ? config.getSelectedModel() : undefined;
            const output = {};
            for (const field of fields) {
                if (Object.prototype.hasOwnProperty.call(values, field)) {
                    const value = cloneJson(values[field], config, `setting ${field}`);
                    if (value !== null || values[field] === null) output[field] = value;
                }
            }
            if (selectedModel !== undefined) {
                const value = cloneJson(selectedModel, config, "selected model");
                if (value !== null || selectedModel === null) output.selected_model = value;
            }
            return output;
        }

        function readRuntime() {
            assertValid();
            const getter = config.getActiveRuntime || config.getRuntime || config.getStatus;
            if (typeof getter !== "function") return null;
            return pickJson(getter(), RUNTIME_FIELDS, config, "runtime state");
        }

        function writeSettings(patch) {
            assertValid();
            if (!isObject(patch)) throw new TypeError("Chat settings patch must be an object.");
            const allowed = {};
            for (const [field, value] of Object.entries(patch)) {
                if (!writableFields.includes(field) || SECRET_KEY.test(field)) {
                    throw new Error(`Chat setting is not writable: ${field}`);
                }
                if (!isJsonValue(value, new Set())) throw new TypeError(`Chat setting is not JSON-safe: ${field}`);
                allowed[field] = cloneJson(value, config, `setting ${field}`);
            }
            if (!Object.keys(allowed).length) return readSettings();
            if (core && typeof core.setMultipleFlagValues === "function") core.setMultipleFlagValues(allowed);
            else if (core && typeof core.setFlagValue === "function") {
                for (const [field, value] of Object.entries(allowed)) core.setFlagValue(field, value);
            } else {
                throw new Error("Chat host settings writer is unavailable.");
            }
            notify({ type: "settings", fields: Object.keys(allowed) });
            return readSettings();
        }

        function notify(change) {
            const safe = { type: isObject(change) && typeof change.type === "string" ? change.type : "host-change" };
            if (isObject(change)) {
                if (Array.isArray(change.fields)) safe.fields = change.fields.filter(field => fields.includes(field));
                if (typeof change.reason === "string") safe.reason = change.reason;
                if (change.runtime !== undefined) safe.runtime = pickJson(change.runtime, RUNTIME_FIELDS, config, "runtime change");
                if (change.status !== undefined) safe.status = pickJson(change.status, RUNTIME_FIELDS, config, "status change");
                if (change.inference !== undefined) safe.inference = pickJson(change.inference, INFERENCE_FIELDS, config, "inference change");
            }
            for (const listener of Array.from(listeners)) {
                try { listener(safe); } catch (error) { warn(config, "Chat host listener failed", error); }
            }
        }

        function subscribe(listener) {
            if (typeof listener !== "function") return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        }

        if (typeof config.observeHostChanges === "function") {
            try {
                hostUnsubscribe = config.observeHostChanges(notify);
            } catch (error) {
                warn(config, "Unable to observe host changes", error);
            }
        }

        const adapter = {
            getSettings: readSettings,
            readSettings,
            setSettings: writeSettings,
            writeSettings,
            getRuntime: readRuntime,
            getActiveRuntime: readRuntime,
            getStatus: typeof config.getStatus === "function" ? () => { assertValid(); return pickJson(config.getStatus(), RUNTIME_FIELDS, config, "status"); } : readRuntime,
            getInference: typeof config.getInference === "function" ? () => { assertValid(); return pickJson(config.getInference(), INFERENCE_FIELDS, config, "inference state"); } : () => null,
            resetInferenceBaseline: typeof config.resetInferenceBaseline === "function" ? (...args) => { assertValid(); return config.resetInferenceBaseline(...args); } : () => undefined,
            getAuthorizationHeaders: typeof config.getAuthorizationHeaders === "function" ? (...args) => { assertValid(); return config.getAuthorizationHeaders(...args); } : () => ({}),
            bringToFront: typeof config.bringToFront === "function" ? (...args) => { assertValid(); return config.bringToFront(...args); } : () => false,
            navigate: typeof config.navigate === "function" ? (...args) => { assertValid(); return config.navigate(...args); } : () => false,
            subscribe,
            notify,
            isSessionValid: () => valid,
            invalidateSession() {
                if (!valid) return false;
                valid = false;
                notify({ type: "session-invalidated" });
                return true;
            },
            dispose() {
                if (typeof hostUnsubscribe === "function") {
                    try { hostUnsubscribe(); } catch (error) { debug(config, "Host observer cleanup failed", error); }
                }
                hostUnsubscribe = null;
                listeners.clear();
                valid = false;
            },
            fields,
        };
        return Object.freeze(adapter);
    }

    function createCoordinator(options) {
        const config = Object.assign({}, options || {});
        const targetWindow = getWindow(config);
        const ui = config.chatUi || config.ui || {};
        const host = config.hostAdapter || null;
        const storage = getStorage(config);
        const storageKey = typeof config.recoveryKey === "string" ? config.recoveryKey : DEFAULT_RECOVERY_KEY;
        const lockName = typeof config.lockName === "string" ? config.lockName : DEFAULT_LOCK_NAME;
        const lockManager = Object.prototype.hasOwnProperty.call(config, "locks") ? config.locks
            : targetWindow && targetWindow.navigator ? targetWindow.navigator.locks : null;
        const origin = getOrigin(config);
        const secureContext = targetWindow && typeof targetWindow.isSecureContext === "boolean" ? targetWindow.isSecureContext : true;
        const chatSettingFields = deriveSettingFields(config);
        const instanceId = config.instanceId || randomId("chat", config);
        const sessionId = config.sessionId || randomId("session", config);
        const now = typeof config.now === "function" ? config.now : () => Date.now();
        const transport = config.transport || {};
        const listeners = new Set();
        let peer = null;
        let peerId = null;
        let peerOrigin = origin;
        let peerVerified = false;
        let peerSession = null;
        let messageListenerInstalled = false;
        let adapterUnsubscribe = null;
        let lockRequest = null;
        let ownershipActive = false;
        let lockHeld = false;
        let localEpoch = 0;
        let revision = Number.isInteger(config.revision) && config.revision >= 0 ? config.revision : 0;
        let transfer = null;
        let disposed = false;
        const pending = new Map();
        let state = {
            instanceId, sessionId, role: "single-window", status: "idle", ownership: false,
            lockAvailable: Boolean(secureContext && lockManager && typeof lockManager.request === "function"),
            popoutAvailable: Boolean(secureContext && lockManager && typeof lockManager.request === "function" && origin),
            hostAvailable: !host || typeof host.isSessionValid !== "function" || host.isSessionValid(),
            reason: "",
            transferId: null, epoch: localEpoch, revision,
        };

        function emit() {
            const snapshot = Object.assign({}, state, {
                transfer: transfer ? {
                    id: transfer.id, phase: transfer.phase, sourceId: transfer.sourceId,
                    destinationId: transfer.destinationId, revision: transfer.revision,
                } : null,
            });
            for (const listener of Array.from(listeners)) {
                try { listener(snapshot); } catch (error) { warn(config, "Chat window state listener failed", error); }
            }
        }

        function setState(patch) {
            state = Object.assign({}, state, patch || {}, { epoch: localEpoch, revision });
            emit();
        }

        function uiCall(name, args, fallback) {
            if (typeof ui[name] !== "function") return fallback;
            try { return ui[name](...(args || [])); } catch (error) {
                warn(config, `Chat UI ${name} failed`, error);
                return fallback;
            }
        }

        async function uiAwait(name, args, fallback) {
            const value = uiCall(name, args, fallback);
            try { return await value; } catch (error) {
                warn(config, `Chat UI ${name} failed`, error);
                return fallback;
            }
        }

        function storageRead() {
            if (!storage || typeof storage.getItem !== "function") return result(false, "storage-unavailable");
            try { return result(true, "ok", { value: storage.getItem(storageKey) }); } catch (error) {
                debug(config, "Recovery storage read failed", error);
                return result(false, "storage-unavailable");
            }
        }

        function storageWrite(value) {
            if (!storage || typeof storage.setItem !== "function") return result(false, "storage-unavailable");
            try { storage.setItem(storageKey, JSON.stringify(value)); return result(true, "ok"); } catch (error) {
                debug(config, "Recovery storage write failed", error);
                return result(false, "storage-write-failed");
            }
        }

        function storageRemove() {
            if (!storage || typeof storage.removeItem !== "function") return result(false, "storage-unavailable");
            try { storage.removeItem(storageKey); return result(true, "ok"); } catch (error) {
                debug(config, "Recovery storage removal failed", error);
                return result(false, "storage-write-failed");
            }
        }

        function validateMetadata(metadata) {
            if (!isObject(metadata)) return null;
            const sourceId = String(metadata.sourceId || metadata.sourceInstanceId || "");
            const destinationId = String(metadata.destinationId || metadata.destinationInstanceId || "");
            const transferId = String(metadata.transferId || "");
            const value = Number(metadata.revision);
            if (!sourceId || !destinationId || !transferId || !Number.isInteger(value) || value < 0) return null;
            return {
                sourceId, destinationId, sourceInstanceId: sourceId,
                destinationInstanceId: destinationId, transferId, revision: value,
            };
        }

        function validateSnapshot(snapshot) {
            if (!isObject(snapshot) || (!Object.prototype.hasOwnProperty.call(snapshot, "version") && !Object.prototype.hasOwnProperty.call(snapshot, "schemaVersion"))) return false;
            if ((snapshot.version ?? snapshot.schemaVersion) !== SNAPSHOT_VERSION) return false;
            if (snapshot.kind !== undefined && snapshot.kind !== SNAPSHOT_KIND) return false;
            if (!isJsonValue(snapshot, new Set())) return false;
            if (typeof ui.validateSnapshot === "function") {
                try { return ui.validateSnapshot(snapshot) === true; } catch (error) {
                    warn(config, "Chat snapshot validation failed", error);
                    return false;
                }
            }
            return true;
        }

        function readRecovery() {
            const raw = storageRead();
            if (!raw.ok) return raw;
            if (raw.value === null || raw.value === "") return result(true, "empty", { record: null });
            let record;
            try { record = JSON.parse(raw.value); } catch (error) {
                debug(config, "Ignoring malformed chat recovery record", error);
                return result(false, "invalid-recovery");
            }
            if (!isObject(record) || record.version !== RECOVERY_VERSION || !Number.isInteger(record.revision) || record.revision < 0) return result(false, "invalid-recovery");
            if (record.invalidated === true) {
                return validateMetadata(record.transfer) ? result(true, "invalidated", { record }) : result(false, "invalid-recovery");
            }
            if (!validateSnapshot(record.snapshot) || !validateMetadata(record.transfer)) return result(false, "invalid-recovery");
            return result(true, "ok", { record });
        }

        function canWrite(expectedEpoch) {
            return ownershipActive && (!lockSupport() || lockHeld)
                && (expectedEpoch === undefined || expectedEpoch === localEpoch);
        }

        function writeCheckpoint(snapshot, metadata, phase, expectedEpoch) {
            if (!canWrite(expectedEpoch)) return result(false, "not-owner");
            const transferMetadata = validateMetadata(metadata);
            if (!transferMetadata || !validateSnapshot(snapshot)) return result(false, "invalid-snapshot");
            const previous = readRecovery();
            if (!previous.ok && previous.reason !== "empty" && previous.reason !== "invalidated") return previous;
            if (previous.record && transferMetadata.revision <= previous.record.revision) return result(false, "stale-revision");
            const safeSnapshot = cloneJson(snapshot, config, "chat snapshot");
            if (safeSnapshot === null) return result(false, "invalid-snapshot");
            if (!safeSnapshot.kind) safeSnapshot.kind = SNAPSHOT_KIND;
            const record = {
                version: RECOVERY_VERSION,
                revision: transferMetadata.revision,
                invalidated: false,
                transfer: transferMetadata,
                phase: phase || "checkpoint",
                snapshot: safeSnapshot,
                writtenAt: now(),
            };
            return storageWrite(record);
        }

        function invalidateRecovery(metadata, reason, expectedEpoch) {
            if (!canWrite(expectedEpoch)) return result(false, "not-owner");
            const stored = readRecovery();
            if (!stored.ok && stored.reason !== "empty" && stored.reason !== "invalidated") return stored;
            const priorRevision = stored.record && Number.isInteger(stored.record.revision) ? stored.record.revision : revision;
            const transferMetadata = validateMetadata(Object.assign({
                sourceId: instanceId, destinationId: instanceId, transferId: `tombstone-${Math.max(revision, priorRevision) + 1}`,
                revision: Math.max(revision, priorRevision) + 1,
            }, metadata || {}));
            if (!transferMetadata) return result(false, "invalid-revision");
            if (transferMetadata.revision <= priorRevision) return result(false, "stale-revision");
            const tombstone = {
                version: RECOVERY_VERSION,
                revision: transferMetadata.revision,
                invalidated: true,
                reason: String(reason || "destructive-change"),
                transfer: transferMetadata,
                snapshot: null,
                writtenAt: now(),
            };
            const outcome = storageWrite(tombstone);
            if (outcome.ok) {
                revision = transferMetadata.revision;
                setState({ reason: "" });
            }
            return outcome;
        }

        function clearRecovery(expectedEpoch) {
            if (!canWrite(expectedEpoch)) return result(false, "not-owner");
            return storageRemove();
        }

        function setUiOwnership(active) {
            if (typeof ui.setOwnership !== "function") return false;
            try {
                ui.setOwnership(Boolean(active));
                return true;
            } catch (error) {
                warn(config, "Chat UI setOwnership failed", error);
                return false;
            }
        }

        function setUiHostAvailable(active) {
            uiCall("setHostAvailable", [Boolean(active)], undefined);
        }

        function lockSupport() {
            return Boolean(secureContext && lockManager && typeof lockManager.request === "function");
        }

        function cancelPendingLock() {
            if (!lockRequest) return false;
            if (lockHeld) return false;
            lockRequest.cancelled = true;
            if (lockRequest.controller && typeof lockRequest.controller.abort === "function") lockRequest.controller.abort();
            if (lockRequest.waiting) lockRequest.waiting.resolve(false);
            lockRequest = null;
            return true;
        }

        function acquireLock(options) {
            const lockOptions = Object.assign({ ifAvailable: true }, options || {});
            if (!lockSupport()) return Promise.resolve(result(false, "locks-unavailable"));
            if (lockHeld) return Promise.resolve(result(true, "lock-acquired"));
            cancelPendingLock();
            const request = {
                token: randomId("lock", config), cancelled: false, waiting: defer(), hold: defer(), controller: null,
            };
            lockRequest = request;
            if (typeof AbortController === "function") request.controller = new AbortController();
            const requestOptions = { mode: "exclusive", ifAvailable: Boolean(lockOptions.ifAvailable) };
            // The Web Locks specification rejects a signal together with
            // ifAvailable.  Only queued receiver acquisitions are abortable.
            if (request.controller && !requestOptions.ifAvailable) requestOptions.signal = request.controller.signal;
            const callback = lock => {
                if (request.cancelled || lockRequest !== request) return undefined;
                if (!lock) {
                    request.waiting.resolve(result(false, "lock-busy"));
                    return undefined;
                }
                lockHeld = true;
                request.waiting.resolve(result(true, "lock-acquired"));
                return request.hold.promise;
            };
            let pendingRequest;
            try { pendingRequest = lockManager.request(lockName, requestOptions, callback); } catch (error) {
                request.waiting.resolve(result(false, "lock-error"));
                warn(config, "Web Lock request failed", error);
                return request.waiting.promise;
            }
            Promise.resolve(pendingRequest).catch(error => {
                if (!request.cancelled) {
                    request.waiting.resolve(result(false, "lock-error"));
                    warn(config, "Web Lock request failed", error);
                }
            }).finally(() => {
                if (lockRequest === request && request.cancelled) lockRequest = null;
            });
            return request.waiting.promise.then(outcome => {
                if (!outcome.ok && lockRequest === request) lockRequest = null;
                return outcome;
            });
        }

        function releaseLock() {
            const request = lockRequest;
            if (!request || !lockHeld) return false;
            lockHeld = false;
            request.cancelled = true;
            request.hold.resolve();
            if (request.controller && typeof request.controller.abort === "function") request.controller.abort();
            if (lockRequest === request) lockRequest = null;
            return true;
        }

        async function revalidateTransfer(expected) {
            const raw = readRecovery();
            if (!raw.ok || !raw.record || raw.record.invalidated) return false;
            const record = raw.record;
            return record.revision === expected.revision
                && record.transfer.transferId === expected.transferId
                && record.transfer.sourceId === expected.sourceId
                && record.transfer.destinationId === expected.destinationId
                && validateSnapshot(record.snapshot);
        }

        async function activateAfterLock(expected, snapshot) {
            if (!lockHeld || disposed) return false;
            const activationEpoch = localEpoch;
            if (expected && !(await revalidateTransfer(expected))) return false;
            if (snapshot && !validateSnapshot(snapshot)) return false;
            const record = expected ? readRecovery() : result(true, "empty", { record: null });
            const toRestore = snapshot || (record.ok && record.record ? record.record.snapshot : null);
            if (toRestore && !await uiAwait("restoreSnapshot", [toRestore], false)) return false;
            if (!lockHeld || disposed || !state.hostAvailable || localEpoch !== activationEpoch) return false;
            if (!setUiOwnership(true)) return false;
            ownershipActive = true;
            localEpoch += 1;
            setState({ role: "owner", status: "active", ownership: true, reason: "" });
            uiCall("resumeTransfer", [], undefined);
            return true;
        }

        async function acquireOwnership(options) {
            const acquireOptions = Object.assign({ ifAvailable: true, activate: true }, options || {});
            if (disposed || (host && typeof host.isSessionValid === "function" && !host.isSessionValid())) return false;
            if (ownershipActive && !acquireOptions.expectedTransfer) return true;
            if (!lockSupport()) {
                if (acquireOptions.allowSingleWindow === false) {
                    setState({ lockAvailable: false, popoutAvailable: false, reason: "exclusive Web Locks are unavailable" });
                    return false;
                }
                ownershipActive = true;
                localEpoch += 1;
                setUiOwnership(true);
                setState({ role: "single-window", status: "active", ownership: true, lockAvailable: false, popoutAvailable: false, reason: "exclusive Web Locks are unavailable" });
                return true;
            }
            const outcome = await acquireLock(acquireOptions);
            if (!outcome.ok) {
                setState({ status: outcome.reason === "lock-busy" ? "observer" : "error", ownership: false, reason: outcome.reason });
                return false;
            }
            if (!acquireOptions.activate) {
                setState({ status: "locked", reason: "" });
                return true;
            }
            const activated = await activateAfterLock(acquireOptions.expectedTransfer, acquireOptions.snapshot);
            if (!activated) {
                releaseLock();
                setState({ status: "observer", ownership: false, reason: "transfer-record-invalid" });
                return false;
            }
            return true;
        }

        function releaseOwnership() {
            if (!ownershipActive && !lockHeld) return false;
            ownershipActive = false;
            localEpoch += 1;
            setUiOwnership(false);
            releaseLock();
            setState({ role: "observer", status: "released", ownership: false });
            return true;
        }

        function verifyMessage(event) {
            const message = event && event.data;
            if (!isObject(message) || message.channel !== PROTOCOL || message.version !== PROTOCOL_VERSION) return null;
            if (origin && event.origin !== origin) return null;
            // Registration is required before any handshake message is
            // accepted.  Same-origin alone is not an identity check.
            if (!peer || event.source !== peer) return null;
            if (peerSession && message.sessionId !== peerSession) return null;
            if (message.sessionId !== sessionId) return null;
            if (peerId && message.sourceId !== peerId) return null;
            if (message.destinationId && message.destinationId !== instanceId) return null;
            if (typeof message.sourceId !== "string" || typeof message.epoch !== "number") return null;
            if (message.epoch < 0 || !Number.isInteger(message.epoch)) return null;
            return message;
        }

        function send(kind, payload, metadata) {
            if (!peer || (!peerVerified && kind !== "hello")) return false;
            const details = metadata || {};
            const message = Object.assign({
                channel: PROTOCOL, version: PROTOCOL_VERSION, type: kind,
                sessionId, sourceId: instanceId, destinationId: peerId || undefined,
                epoch: localEpoch,
            }, details);
            if (payload !== undefined) message.payload = payload;
            try {
                if (typeof transport.send === "function") transport.send(message, peerOrigin, peer);
                else if (typeof peer.postMessage === "function") peer.postMessage(message, peerOrigin);
                else return false;
                return true;
            } catch (error) {
                debug(config, `Unable to send ${kind} message`, error);
                return false;
            }
        }

        function addPending(key) {
            const waiting = defer();
            pending.set(key, waiting);
            return waiting.promise.finally(() => { if (pending.get(key) === waiting) pending.delete(key); });
        }

        function resolvePending(key, value) {
            const waiting = pending.get(key);
            if (waiting) waiting.resolve(value);
        }

        function rejectPending(key, value) {
            const waiting = pending.get(key);
            if (waiting) waiting.resolve(value);
        }

        function cancelPendingMessages(value) {
            for (const waiting of Array.from(pending.values())) waiting.resolve(value || null);
            pending.clear();
        }

        function waitForPending(key, timeoutMs) {
            const waiting = pending.get(key);
            if (!waiting) return Promise.resolve(null);
            const configured = timeoutMs === undefined ? config.transferTimeoutMs : timeoutMs;
            const limit = Number.isFinite(Number(configured)) ? Number(configured) : 10000;
            if (limit <= 0 || typeof setTimeout !== "function") return waiting.promise;
            return new Promise(resolve => {
                let settled = false;
                const finish = value => {
                    if (settled) return;
                    settled = true;
                    if (pending.get(key) === waiting) pending.delete(key);
                    resolve(value);
                };
                waiting.promise.then(finish, () => finish(null));
                setTimeout(() => { waiting.resolve(null); finish(null); }, limit);
            });
        }

        async function prepareSourceTransfer(options) {
            const transferOptions = Object.assign({}, options || {});
            if (!peerVerified || !ownershipActive || !lockSupport()) return false;
            if (transfer && transfer.phase === "owned" && ownershipActive) transfer = null;
            if (transfer) return false;
            const allowed = uiCall("getTransferState", [], { allowed: true });
            if (!allowed || allowed.allowed !== true) {
                setState({ reason: allowed && allowed.reason ? allowed.reason : "chat is busy" });
                return false;
            }
            const destinationId = String(transferOptions.destinationId || peerId || "");
            if (!destinationId) return false;
            const transferId = String(transferOptions.transferId || randomId("transfer", config));
            const suspended = await uiAwait("suspendTransfer", [], false);
            if (!suspended || !ownershipActive) {
                uiCall("resumeTransfer", [], undefined);
                return false;
            }
            const transferEpoch = localEpoch;
            // suspendTransfer() performs the second idle/ownership check.  A
            // suspended Chat intentionally reports transfers as unavailable.
            if (!await uiAwait("saveForTransfer", [], false) || !ownershipActive || localEpoch !== transferEpoch) {
                uiCall("resumeTransfer", [], undefined);
                return false;
            }
            // Saving may itself checkpoint through Chat's workspace hook.
            // Choose the handoff revision only after that durable write.
            const transferRevision = Math.max(revision + 1, Number.isInteger(transferOptions.revision) ? transferOptions.revision : 0);
            const metadata = {
                sourceId: instanceId, destinationId, sourceInstanceId: instanceId,
                destinationInstanceId: destinationId, transferId, revision: transferRevision,
            };
            const snapshot = await uiAwait("captureSnapshot", [metadata], null);
            if (!snapshot || !validateSnapshot(snapshot) || !ownershipActive || localEpoch !== transferEpoch) {
                uiCall("resumeTransfer", [], undefined);
                return false;
            }
            const checkpoint = writeCheckpoint(snapshot, metadata, "prepared", transferEpoch);
            if (!checkpoint.ok) {
                uiCall("resumeTransfer", [], undefined);
                setState({ reason: checkpoint.reason });
                return false;
            }
            revision = transferRevision;
            const normalizedSnapshot = cloneJson(snapshot, config, "chat snapshot");
            if (normalizedSnapshot && !normalizedSnapshot.kind) normalizedSnapshot.kind = SNAPSHOT_KIND;
            transfer = { id: transferId, phase: "preparing", sourceId: instanceId, destinationId, revision: transferRevision, snapshot: normalizedSnapshot, epoch: transferEpoch };
            setState({ status: "preparing", transferId, reason: "" });
            const key = `ready:${transferId}`;
            const ready = addPending(key);
            if (!send("prepare", { snapshot: normalizedSnapshot }, { transferId, revision: transferRevision, epoch: transfer.epoch })) {
                pending.delete(key);
                transfer = null;
                uiCall("resumeTransfer", [], undefined);
                return false;
            }
            const readyMessage = await waitForPending(key, transferOptions.timeoutMs);
            if (!readyMessage || readyMessage.type !== "ready" || !transfer || transfer.phase !== "preparing") {
                transfer = null;
                uiCall("resumeTransfer", [], undefined);
                return false;
            }
            transfer.phase = "committed";
            setState({ status: "committing" });
            const ackKey = `owner:${transferId}`;
            const ack = addPending(ackKey);
            if (!send("commit", undefined, { transferId, revision: transferRevision, epoch: transfer.epoch })) {
                pending.delete(ackKey);
                transfer = null;
                uiCall("resumeTransfer", [], undefined);
                return false;
            }
            if (!setUiOwnership(false)) {
                pending.delete(ackKey);
                transfer = null;
                uiCall("resumeTransfer", [], undefined);
                return false;
            }
            ownershipActive = false;
            localEpoch += 1;
            releaseLock();
            transfer.phase = "awaiting-ack";
            setState({ role: "observer", status: "released", ownership: false });
            const ownerAck = await waitForPending(ackKey, transferOptions.timeoutMs);
            if (ownerAck && ownerAck.type === "owner-ack") {
                transfer.phase = "complete";
                setState({ status: "detached" });
                return true;
            }
            // A receiver that disappeared after release cannot be replaced by
            // a timeout.  Keep this page inert; explicit recovery must acquire
            // the lock and revalidate the durable record.
            setState({ status: "recovery-required", reason: "receiver did not acknowledge ownership" });
            return false;
        }

        async function handlePrepare(message) {
            if (!peerVerified || !isObject(message.payload) || !validateSnapshot(message.payload.snapshot)) {
                send("reject", undefined, { transferId: message.transferId, revision: message.revision, reason: "invalid-snapshot" });
                return;
            }
            if (transfer && transfer.id === message.transferId && transfer.phase !== "failed") {
                if (transfer.phase === "prepared") send("ready", undefined, { transferId: transfer.id, revision: transfer.revision, epoch: localEpoch });
                return;
            }
            if (ownershipActive || lockHeld) {
                send("reject", undefined, { transferId: message.transferId, revision: message.revision, reason: "workspace-owned" });
                return;
            }
            const metadata = validateMetadata({
                sourceId: message.sourceId, destinationId: instanceId,
                transferId: message.transferId, revision: message.revision,
            });
            if (!metadata || message.epoch < 0) {
                send("reject", undefined, { transferId: message.transferId, revision: message.revision, reason: "invalid-transfer" });
                return;
            }
            transfer = {
                id: metadata.transferId, phase: "restoring", sourceId: metadata.sourceId,
                destinationId: metadata.destinationId, revision: metadata.revision,
                snapshot: message.payload.snapshot, epoch: message.epoch,
            };
            uiCall("setOwnership", [false], undefined);
            if (!await uiAwait("restoreSnapshot", [message.payload.snapshot], false)) {
                transfer.phase = "failed";
                send("reject", undefined, { transferId: message.transferId, revision: message.revision, reason: "restore-failed" });
                return;
            }
            transfer.phase = "prepared";
            setState({ status: "prepared", transferId: transfer.id, role: "observer", ownership: false });
            send("ready", undefined, { transferId: transfer.id, revision: transfer.revision, epoch: transfer.epoch });
        }

        async function handleCommit(message) {
            if (!transfer || transfer.id !== message.transferId || transfer.phase === "failed") return;
            if (transfer.phase === "acquiring") return;
            if (transfer.revision !== message.revision || transfer.epoch !== message.epoch || transfer.phase === "owned") {
                if (transfer.phase === "owned") send("owner-ack", undefined, { transferId: transfer.id, revision: transfer.revision, epoch: transfer.epoch });
                return;
            }
            transfer.phase = "acquiring";
            setState({ status: "acquiring" });
            const acquired = await acquireOwnership({ ifAvailable: false, expectedTransfer: {
                sourceId: transfer.sourceId, destinationId: transfer.destinationId,
                transferId: transfer.id, revision: transfer.revision,
            }, snapshot: transfer.snapshot });
            if (!acquired) {
                transfer.phase = "failed";
                setState({ status: "recovery-required", reason: "ownership acquisition failed" });
                send("reject", undefined, { transferId: transfer.id, revision: transfer.revision, reason: "ownership-failed" });
                return;
            }
            revision = Math.max(revision, transfer.revision);
            transfer.phase = "owned";
            setState({ status: "active", role: "owner", ownership: true });
            send("owner-ack", undefined, { transferId: transfer.id, revision: transfer.revision, epoch: transfer.epoch });
        }

        function handleMessage(event) {
            const message = verifyMessage(event);
            if (!message) return false;
            if (message.type === "hello") {
                if (!peerSession) peerSession = message.sessionId;
                peerVerified = true;
                setState({ popoutAvailable: lockSupport(), hostAvailable: !host || host.isSessionValid() });
                send("hello-ack", undefined, { epoch: localEpoch });
                return true;
            }
            if (!peerVerified && message.type !== "hello-ack") return false;
            if (message.type === "hello-ack") {
                peerVerified = true;
                setState({ popoutAvailable: lockSupport(), hostAvailable: !host || host.isSessionValid() });
                return true;
            }
            if (message.type === "ready") {
                if (transfer && transfer.id === message.transferId && transfer.revision === message.revision && transfer.epoch === message.epoch && transfer.phase === "preparing") resolvePending(`ready:${message.transferId}`, message);
                return true;
            }
            if (message.type === "owner-ack") {
                if (transfer && transfer.id === message.transferId && transfer.revision === message.revision && transfer.epoch === message.epoch && transfer.phase === "awaiting-ack") resolvePending(`owner:${message.transferId}`, message);
                return true;
            }
            if (message.type === "reject") {
                rejectPending(`ready:${message.transferId}`, message);
                rejectPending(`owner:${message.transferId}`, message);
                return true;
            }
            if (message.type === "prepare") { void handlePrepare(message); return true; }
            if (message.type === "commit") { void handleCommit(message); return true; }
            if (message.type === "host-update") {
                if (typeof config.onHostUpdate === "function") {
                    try { config.onHostUpdate(message.payload || {}); } catch (error) { warn(config, "Host update listener failed", error); }
                }
                return true;
            }
            return false;
        }

        function installMessageListener() {
            if (messageListenerInstalled || !targetWindow || typeof targetWindow.addEventListener !== "function") return;
            targetWindow.addEventListener("message", handleMessage);
            messageListenerInstalled = true;
        }

        function uninstallMessageListener() {
            if (!messageListenerInstalled || !targetWindow || typeof targetWindow.removeEventListener !== "function") return;
            targetWindow.removeEventListener("message", handleMessage);
            messageListenerInstalled = false;
        }

        function attachPeer(nextPeer, options) {
            const peerOptions = Object.assign({}, options || {});
            if (!nextPeer) return result(false, "peer-unavailable");
            peer = nextPeer;
            peerId = peerOptions.peerId ? String(peerOptions.peerId) : peerId;
            peerOrigin = typeof peerOptions.origin === "string" ? peerOptions.origin : origin;
            peerSession = peerOptions.sessionId ? String(peerOptions.sessionId) : sessionId;
            peerVerified = Boolean(peerOptions.verified === true);
            installMessageListener();
            if (peerOptions.verified === true) send("hello", undefined, { epoch: localEpoch });
            return result(true, "peer-attached", { instanceId, sessionId, origin: peerOrigin });
        }

        function beginHandshake() {
            installMessageListener();
            return send("hello", undefined, { epoch: localEpoch });
        }

        async function initialize(options) {
            const initOptions = Object.assign({ acquire: true, recover: true }, options || {});
            if (disposed) return result(false, "disposed");
            // chat-ui starts in legacy single-window ownership.  Revoke that
            // optimistic state before any lock attempt, while preserving an
            // already initialized owner's active stream on repeated calls.
            if (!ownershipActive && !lockHeld) setUiOwnership(false);
            installMessageListener();
            if (host && typeof host.subscribe === "function" && !adapterUnsubscribe) {
                adapterUnsubscribe = host.subscribe(change => {
                    if (change && change.type === "session-invalidated") {
                        void invalidateSession();
                        return;
                    }
                    if (!state.hostAvailable) return;
                    const hostState = {
                        settings: typeof host.getSettings === "function" ? host.getSettings() : {},
                        runtime: typeof host.getRuntime === "function" ? host.getRuntime() : null,
                        status: typeof host.getStatus === "function" ? host.getStatus() : null,
                        change: isObject(change) ? {
                            type: typeof change.type === "string" ? change.type : "host-change",
                            fields: Array.isArray(change.fields) ? change.fields : undefined,
                        } : { type: "host-change" },
                    };
                    send("host-update", hostState, { epoch: localEpoch });
                    if (typeof config.onHostChange === "function") {
                        try { config.onHostChange(change); } catch (error) { warn(config, "Host change listener failed", error); }
                    }
                });
            }
            if (!lockSupport()) {
                setState({ lockAvailable: false, popoutAvailable: false, reason: "exclusive Web Locks are unavailable" });
                if (initOptions.acquire) await acquireOwnership({ allowSingleWindow: true });
                return result(true, "single-window", { popoutAvailable: false });
            }
            if (initOptions.acquire) {
                if (!await acquireOwnership({ ifAvailable: true, allowSingleWindow: false, activate: false })) return result(false, "lock-busy");
                const durable = readRecovery();
                if (durable.record && Number.isInteger(durable.record.revision)) revision = Math.max(revision, durable.record.revision);
                if (!(initOptions.recover && await recover())) await activateAfterLock(null, null);
            }
            if (peer && !peerVerified) beginHandshake();
            return result(true, "initialized", { popoutAvailable: true });
        }

        async function recover() {
            if (!ownershipActive && !lockHeld && !await acquireOwnership({ ifAvailable: true, allowSingleWindow: false, activate: false })) return false;
            if (!lockHeld && lockSupport()) return false;
            const stored = readRecovery();
            if (stored.record && Number.isInteger(stored.record.revision)) revision = Math.max(revision, stored.record.revision);
            if (!stored.ok || !stored.record || stored.record.invalidated) return false;
            revision = Math.max(revision, stored.record.revision);
            if (!validateSnapshot(stored.record.snapshot)) return false;
            const restored = await activateAfterLock(null, stored.record.snapshot);
            if (!restored) return false;
            if (transfer && transfer.phase !== "owned") transfer = null;
            setState({ reason: "" });
            return true;
        }

        function checkpointSnapshot(snapshot, metadata) {
            if (!canWrite(localEpoch) || !validateSnapshot(snapshot)) return false;
            const transferMetadata = validateMetadata(Object.assign({
                sourceId: instanceId, destinationId: instanceId,
                transferId: `checkpoint-${revision + 1}`, revision: revision + 1,
            }, metadata || {}));
            if (!transferMetadata) return false;
            const outcome = writeCheckpoint(snapshot, transferMetadata, "checkpoint", localEpoch);
            if (outcome.ok) revision = Math.max(revision, transferMetadata.revision);
            return outcome.ok;
        }

        async function invalidateSession() {
            if (!state.hostAvailable && !peerVerified) return false;
            state = Object.assign({}, state, { hostAvailable: false });
            // Quarantine mutation entry points immediately. Chat retains its
            // partial checkpoint while the awaited abort settles.
            setUiHostAvailable(false);
            const activeEpoch = localEpoch;
            if (ownershipActive && typeof ui.abortActiveStream === "function") await uiAwait("abortActiveStream", [], undefined);
            if (ownershipActive && localEpoch === activeEpoch) {
                const snapshotMetadata = {
                    sourceId: instanceId, destinationId: instanceId,
                    transferId: `host-revocation-${revision + 1}`, revision: revision + 1,
                };
                const snapshot = uiCall("captureSnapshot", [snapshotMetadata], null);
                if (snapshot && validateSnapshot(snapshot)) writeCheckpoint(snapshot, snapshotMetadata, "host-revocation", activeEpoch);
            }
            localEpoch += 1;
            peerVerified = false;
            cancelPendingMessages(null);
            cancelPendingLock();
            if (ownershipActive || lockHeld) {
                ownershipActive = false;
                setUiOwnership(false);
                releaseLock();
            }
            setState({ role: "observer", status: "host-unavailable", ownership: false, reason: "host session invalidated" });
            return true;
        }

        function getPeerHostAdapter(candidate) {
            if (!peerVerified || (candidate && candidate !== peer) || !state.hostAvailable || !host) return null;
            // Cross-window consumers receive only the narrow live bridge. They
            // cannot invalidate/dispose the host or publish forged notices.
            return Object.freeze({
                getSettings: host.getSettings,
                setSettings: host.setSettings,
                getRuntime: host.getRuntime,
                getActiveRuntime: host.getActiveRuntime,
                getStatus: host.getStatus,
                getInference: host.getInference,
                resetInferenceBaseline: host.resetInferenceBaseline,
                getAuthorizationHeaders: host.getAuthorizationHeaders,
                bringToFront: host.bringToFront,
                navigate: host.navigate,
                isSessionValid: host.isSessionValid,
                fields: host.fields,
            });
        }

        function dispose() {
            disposed = true;
            localEpoch += 1;
            ownershipActive = false;
            setUiOwnership(false);
            setUiHostAvailable(false);
            cancelPendingLock();
            releaseLock();
            uninstallMessageListener();
            if (typeof adapterUnsubscribe === "function") adapterUnsubscribe();
            adapterUnsubscribe = null;
            listeners.clear();
            cancelPendingMessages(null);
            peerVerified = false;
            ownershipActive = false;
        }

        const coordinator = {
            PROTOCOL, PROTOCOL_VERSION, SNAPSHOT_VERSION, SNAPSHOT_KIND, RECOVERY_VERSION,
            instanceId, sessionId, lockName, storageKey, origin,
            CHAT_SETTING_FIELDS: chatSettingFields,
            initialize,
            attachPeer, beginHandshake,
            receiveMessage: handleMessage,
            acquireOwnership,
            releaseOwnership,
            beginTransfer: prepareSourceTransfer,
            cancelTransfer() {
                if (!transfer || (transfer.phase !== "preparing" && transfer.phase !== "committed")) return false;
                for (const key of [`ready:${transfer.id}`, `owner:${transfer.id}`]) rejectPending(key, { type: "reject", reason: "cancelled" });
                const beforeRelease = transfer.phase === "preparing" || transfer.phase === "committed";
                if (beforeRelease && !ownershipActive) return false;
                transfer.phase = "failed";
                uiCall("resumeTransfer", [], undefined);
                transfer = null;
                setState({ status: "active", transferId: null, reason: "transfer cancelled" });
                return true;
            },
            captureSnapshot: metadata => {
                const safeMetadata = validateMetadata(metadata);
                if (!safeMetadata) return null;
                const snapshot = uiCall("captureSnapshot", [safeMetadata], null);
                return snapshot && validateSnapshot(snapshot) ? cloneJson(snapshot, config, "chat snapshot") : null;
            },
            validateSnapshot,
            restoreSnapshot: snapshot => validateSnapshot(snapshot) && uiCall("restoreSnapshot", [snapshot], false) !== false,
            checkpoint: checkpointSnapshot,
            readRecovery,
            invalidateRecovery,
            clearRecovery,
            recover,
            invalidateSession,
            getPeerHostAdapter,
            getTransferState: () => uiCall("getTransferState", [], { allowed: false, reason: "chat UI unavailable" }),
            getState: () => Object.assign({}, state, { transfer: transfer ? Object.assign({}, transfer, { snapshot: undefined }) : null }),
            isOwner: () => ownershipActive,
            isPeerVerified: () => peerVerified,
            subscribe(listener) {
                if (typeof listener !== "function") return () => {};
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            dispose,
        };
        return Object.freeze(coordinator);
    }

    const api = {
        PROTOCOL, PROTOCOL_VERSION, SNAPSHOT_VERSION, SNAPSHOT_KIND, RECOVERY_VERSION,
        DEFAULT_LOCK_NAME, DEFAULT_RECOVERY_KEY, CHAT_READONLY_SETTING_FIELDS,
        createHostAdapter, createCoordinator,
        configure(options) {
            if (!api._coordinator) api._coordinator = createCoordinator(options);
            return api._coordinator.initialize(options);
        },
        get coordinator() { return api._coordinator || null; },
    };

    const root = typeof window !== "undefined" ? window : globalThis;
    root.LlamaGui = root.LlamaGui || {};
    root.LlamaGui.chatWindow = api;
})();
