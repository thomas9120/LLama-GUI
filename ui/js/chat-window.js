// Chat pop-out window: verified window bootstrap, origin-scoped Web Lock host adapter,
// versioned recovery record, and ownership/recovery coordination with the main window.
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
        let transferOperation = null;
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

        function retireTransfer() {
            if (transfer) transfer.cancelled = true;
            if (transferOperation) transferOperation.cancelled = true;
            transfer = null;
            transferOperation = null;
        }

        function isCurrentTransfer(candidate, phases) {
            if (!candidate || transfer !== candidate || candidate.cancelled || disposed) return false;
            return !phases || phases.includes(candidate.phase);
        }

        function isCurrentTransferOperation(operation) {
            return Boolean(operation && transferOperation === operation && !operation.cancelled
                && !disposed && state.hostAvailable && ownershipActive && localEpoch === operation.epoch);
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
                const outcome = ui.setOwnership(Boolean(active));
                return outcome === undefined ? true : outcome === true;
            } catch (error) {
                warn(config, "Chat UI setOwnership failed", error);
                return false;
            }
        }

        function setUiHostAvailable(active) {
            uiCall("setHostAvailable", [Boolean(active)], undefined);
        }

        // Recovery may need to clear a tombstoned or malformed workspace while
        // this coordinator owns the lock. Keep the UI API owner-gated; the
        // temporary ownership flag exists only for this synchronous reset.
        function resetWorkspaceUnderLock() {
            if (!lockHeld || typeof ui.resetWorkspace !== "function") return false;
            const wasOwner = ownershipActive;
            if (!wasOwner && !setUiOwnership(true)) return false;
            try { return ui.resetWorkspace() === true; }
            catch (error) {
                warn(config, "Chat workspace reset failed", error);
                return false;
            }
            finally { if (!wasOwner) setUiOwnership(false); }
        }

        function lockSupport() {
            return Boolean(secureContext && lockManager && typeof lockManager.request === "function");
        }

        function cancelPendingLock(reason = "cancelled", expectedRequest) {
            const request = lockRequest;
            if (!request || (expectedRequest && request !== expectedRequest) || lockHeld) return false;
            request.cancelled = true;
            if (request.timer !== null && typeof clearTimeout === "function") clearTimeout(request.timer);
            request.timer = null;
            if (request.controller && typeof request.controller.abort === "function") request.controller.abort();
            if (request.waiting) request.waiting.resolve(result(false, reason));
            if (lockRequest === request) lockRequest = null;
            return true;
        }

        function acquireLock(options) {
            const lockOptions = Object.assign({ ifAvailable: true }, options || {});
            if (!lockSupport()) return Promise.resolve(result(false, "locks-unavailable"));
            if (lockHeld) return Promise.resolve(result(true, "lock-acquired", { request: lockRequest }));
            cancelPendingLock();
            const request = {
                token: randomId("lock", config), cancelled: false, waiting: defer(), hold: defer(), controller: null,
                timer: null,
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
                if (request.timer !== null && typeof clearTimeout === "function") clearTimeout(request.timer);
                request.timer = null;
                lockHeld = true;
                request.waiting.resolve(result(true, "lock-acquired", { request }));
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
                if (request.timer !== null && typeof clearTimeout === "function") clearTimeout(request.timer);
                request.timer = null;
                if (lockRequest === request && request.cancelled) lockRequest = null;
            });
            const configuredTimeout = lockOptions.timeoutMs === undefined
                ? (config.transferTimeoutMs === undefined ? 10000 : config.transferTimeoutMs)
                : lockOptions.timeoutMs;
            const configuredValue = Number(configuredTimeout);
            const timeoutMs = Number.isFinite(configuredValue) && configuredValue > 0 ? configuredValue : 10000;
            if (!requestOptions.ifAvailable && lockRequest === request && !lockHeld
                && Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof setTimeout === "function") {
                request.timer = setTimeout(() => {
                    cancelPendingLock("lock-timeout", request);
                }, timeoutMs);
            }
            return request.waiting.promise.then(outcome => {
                if (!outcome.ok && lockRequest === request) lockRequest = null;
                return outcome;
            });
        }

        function releaseLock(expectedRequest) {
            const request = lockRequest;
            if (!request || !lockHeld || (expectedRequest && request !== expectedRequest)) return false;
            lockHeld = false;
            request.cancelled = true;
            if (request.timer !== null && typeof clearTimeout === "function") clearTimeout(request.timer);
            request.timer = null;
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
            if (disposed || !state.hostAvailable || (host && typeof host.isSessionValid === "function" && !host.isSessionValid())) return false;
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
            const acquisitionEpoch = localEpoch;
            const outcome = await acquireLock(acquireOptions);
            if (outcome.ok && acquireOptions.transferToken) {
                Object.defineProperty(acquireOptions.transferToken, "lockRequest", {
                    configurable: true, value: outcome.request,
                });
            }
            if (disposed || localEpoch !== acquisitionEpoch || !state.hostAvailable) {
                if (outcome.ok && lockHeld) releaseLock(outcome.request);
                return false;
            }
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
                releaseLock(outcome.request);
                if (!disposed && state.hostAvailable && localEpoch === acquisitionEpoch) {
                    setState({ status: "observer", ownership: false, reason: "transfer-record-invalid" });
                }
                return false;
            }
            return true;
        }

        function releaseOwnership(expectedRequest) {
            if (expectedRequest && lockRequest !== expectedRequest) return false;
            if (!ownershipActive && !lockHeld) return false;
            ownershipActive = false;
            localEpoch += 1;
            setUiOwnership(false);
            releaseLock(expectedRequest);
            setState({ role: "observer", status: "released", ownership: false });
            return true;
        }

        function verifyMessage(event) {
            const message = event && event.data;
            if (!isObject(message) || message.channel !== PROTOCOL || message.version !== PROTOCOL_VERSION) return null;
            if (!origin || event.origin !== origin) return null;
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
                let timer;
                const finish = value => {
                    if (settled) return;
                    settled = true;
                    if (timer !== undefined) clearTimeout(timer);
                    if (pending.get(key) === waiting) pending.delete(key);
                    resolve(value);
                };
                waiting.promise.then(finish, () => finish(null));
                timer = setTimeout(() => { waiting.resolve(null); finish(null); }, limit);
            });
        }

        async function prepareSourceTransfer(options) {
            const transferOptions = Object.assign({}, options || {});
            if (!peerVerified || !ownershipActive || !lockSupport()) return false;
            if (transfer && transfer.phase === "owned" && ownershipActive) retireTransfer();
            if (transfer || transferOperation) return false;
            const allowed = uiCall("getTransferState", [], { allowed: true });
            if (!allowed || allowed.allowed !== true) {
                setState({ reason: allowed && allowed.reason ? allowed.reason : "chat is busy" });
                return false;
            }
            const destinationId = String(transferOptions.destinationId || peerId || "");
            if (!destinationId) return false;
            const transferId = String(transferOptions.transferId || randomId("transfer", config));
            const operation = { id: transferId, epoch: localEpoch, cancelled: false };
            transferOperation = operation;
            const abortSourceAttempt = () => {
                if (transferOperation !== operation || operation.cancelled) return;
                const resume = ownershipActive && state.hostAvailable;
                retireTransfer();
                if (resume) uiCall("resumeTransfer", [], undefined);
            };
            const suspended = await uiAwait("suspendTransfer", [], false);
            if (!suspended || !isCurrentTransferOperation(operation)) {
                abortSourceAttempt();
                return false;
            }
            // suspendTransfer() performs the second idle/ownership check.  A
            // suspended Chat intentionally reports transfers as unavailable.
            if (!await uiAwait("saveForTransfer", [], false) || !isCurrentTransferOperation(operation)) {
                abortSourceAttempt();
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
            if (!snapshot || !validateSnapshot(snapshot) || !isCurrentTransferOperation(operation)) {
                abortSourceAttempt();
                return false;
            }
            const checkpoint = writeCheckpoint(snapshot, metadata, "prepared", operation.epoch);
            if (!checkpoint.ok) {
                abortSourceAttempt();
                setState({ reason: checkpoint.reason });
                return false;
            }
            revision = transferRevision;
            const normalizedSnapshot = cloneJson(snapshot, config, "chat snapshot");
            if (normalizedSnapshot && !normalizedSnapshot.kind) normalizedSnapshot.kind = SNAPSHOT_KIND;
            transfer = { id: transferId, phase: "preparing", sourceId: instanceId, destinationId, revision: transferRevision, snapshot: normalizedSnapshot, epoch: operation.epoch };
            const sourceTransfer = transfer;
            setState({ status: "preparing", transferId, reason: "" });
            const key = `ready:${transferId}`;
            const ready = addPending(key);
            if (!send("prepare", { snapshot: normalizedSnapshot }, { transferId, revision: transferRevision, epoch: sourceTransfer.epoch })) {
                pending.delete(key);
                abortSourceAttempt();
                return false;
            }
            const readyMessage = await waitForPending(key, transferOptions.timeoutMs);
            if (!readyMessage || readyMessage.type !== "ready" || !isCurrentTransfer(sourceTransfer, ["preparing"])) {
                abortSourceAttempt();
                return false;
            }
            sourceTransfer.phase = "committed";
            setState({ status: "committing" });
            const ackKey = `owner:${transferId}`;
            const ack = addPending(ackKey);
            if (!send("commit", undefined, { transferId, revision: transferRevision, epoch: sourceTransfer.epoch })) {
                pending.delete(ackKey);
                abortSourceAttempt();
                return false;
            }
            if (!setUiOwnership(false)) {
                pending.delete(ackKey);
                abortSourceAttempt();
                return false;
            }
            ownershipActive = false;
            localEpoch += 1;
            releaseLock();
            sourceTransfer.phase = "awaiting-ack";
            setState({ role: "observer", status: "released", ownership: false });
            const ownerAck = await waitForPending(ackKey, transferOptions.timeoutMs);
            if (ownerAck && ownerAck.type === "owner-ack" && isCurrentTransfer(sourceTransfer, ["awaiting-ack"]) && !operation.cancelled && state.hostAvailable) {
                sourceTransfer.phase = "complete";
                transferOperation = null;
                setState({ status: "detached" });
                return true;
            }
            // A receiver that disappeared after release cannot be replaced by
            // a timeout.  Keep this page inert; explicit recovery must acquire
            // the lock and revalidate the durable record.
            if (isCurrentTransfer(sourceTransfer, ["awaiting-ack"]) && !operation.cancelled) {
                retireTransfer();
                setState({ status: "recovery-required", reason: "receiver did not acknowledge ownership" });
            }
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
            const preparedTransfer = transfer;
            uiCall("setOwnership", [false], undefined);
            if (!await uiAwait("restoreSnapshot", [message.payload.snapshot], false)) {
                if (!isCurrentTransfer(preparedTransfer, ["restoring"])) return;
                preparedTransfer.phase = "failed";
                send("reject", undefined, { transferId: message.transferId, revision: message.revision, reason: "restore-failed" });
                return;
            }
            if (!isCurrentTransfer(preparedTransfer, ["restoring"]) || !state.hostAvailable || !peerVerified) return;
            preparedTransfer.phase = "prepared";
            setState({ status: "prepared", transferId: preparedTransfer.id, role: "observer", ownership: false });
            send("ready", undefined, { transferId: preparedTransfer.id, revision: preparedTransfer.revision, epoch: preparedTransfer.epoch });
        }

        async function handleCommit(message) {
            if (!transfer || transfer.id !== message.transferId || transfer.phase === "failed") return;
            if (transfer.phase === "acquiring") return;
            if (transfer.revision !== message.revision || transfer.epoch !== message.epoch || transfer.phase === "owned") {
                if (transfer.phase === "owned") send("owner-ack", undefined, { transferId: transfer.id, revision: transfer.revision, epoch: transfer.epoch });
                return;
            }
            const committingTransfer = transfer;
            committingTransfer.phase = "acquiring";
            setState({ status: "acquiring" });
            const acquired = await acquireOwnership({ ifAvailable: false, expectedTransfer: {
                sourceId: committingTransfer.sourceId, destinationId: committingTransfer.destinationId,
                transferId: committingTransfer.id, revision: committingTransfer.revision,
            }, snapshot: committingTransfer.snapshot, timeoutMs: config.transferTimeoutMs, transferToken: committingTransfer });
            if (!isCurrentTransfer(committingTransfer, ["acquiring"]) || !state.hostAvailable || !peerVerified) {
                if (acquired && ownershipActive && committingTransfer.lockRequest
                    && lockHeld && lockRequest === committingTransfer.lockRequest) {
                    releaseOwnership(committingTransfer.lockRequest);
                }
                return;
            }
            if (!acquired) {
                committingTransfer.phase = "failed";
                setState({ status: "recovery-required", reason: "ownership acquisition failed" });
                send("reject", undefined, { transferId: committingTransfer.id, revision: committingTransfer.revision, reason: "ownership-failed" });
                return;
            }
            revision = Math.max(revision, committingTransfer.revision);
            committingTransfer.phase = "owned";
            setState({ status: "active", role: "owner", ownership: true });
            send("owner-ack", undefined, { transferId: committingTransfer.id, revision: committingTransfer.revision, epoch: committingTransfer.epoch });
        }

        function sendHostUpdate(change) {
            if (!host || !peerVerified || !state.hostAvailable) return false;
            const safeChange = isObject(change) ? change : {};
            const read = getter => {
                try { return typeof getter === "function" ? getter() : null; }
                catch (error) { debug(config, "Host state read failed", error); return null; }
            };
            const payload = {
                settings: read(host.getSettings),
                runtime: read(host.getRuntime),
                status: read(host.getStatus),
                inference: read(host.getInference),
                change: {
                    type: typeof safeChange.type === "string" ? safeChange.type : "host-change",
                    fields: Array.isArray(safeChange.fields) ? safeChange.fields : undefined,
                },
            };
            return send("host-update", payload, { epoch: localEpoch });
        }

        function handleMessage(event) {
            const message = verifyMessage(event);
            if (!message) return false;
            if (message.type === "hello") {
                if (typeof config.verifyPeerProof === "function" && !config.verifyPeerProof(message.payload || {})) return false;
                if (!peerSession) peerSession = message.sessionId;
                if (!peerId) peerId = message.sourceId;
                peerVerified = true;
                setState({ popoutAvailable: lockSupport(), hostAvailable: !host || host.isSessionValid() });
                send("hello-ack", undefined, { epoch: localEpoch });
                sendHostUpdate({ type: "hello" });
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
            if (message.type === "abort") {
                const requestId = typeof message.requestId === "string" ? message.requestId : "";
                if (typeof ui.abortActiveStream !== "function") {
                    send("abort-ack", { ok: false }, { epoch: localEpoch, requestId });
                    return true;
                }
                Promise.resolve().then(() => ui.abortActiveStream()).then(ok => {
                    send("abort-ack", { ok: ok !== false }, { epoch: localEpoch, requestId });
                }).catch(error => {
                    warn(config, "Chat abort request failed", error);
                    send("abort-ack", { ok: false }, { epoch: localEpoch, requestId });
                });
                return true;
            }
            if (message.type === "abort-ack") {
                if (typeof message.requestId === "string") resolvePending(`abort:${message.requestId}`, message);
                return true;
            }
            if (message.type === "return-request") {
                if (typeof config.onReturnRequest === "function") {
                    try { void config.onReturnRequest(message); } catch (error) { warn(config, "Return request failed", error); }
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
            const replacingPeer = peer !== null && peer !== nextPeer;
            if (replacingPeer) {
                cancelPendingMessages(null);
                peerId = null;
                peerSession = null;
                peerVerified = false;
                if (transfer && transfer.phase === "owned" && ownershipActive) retireTransfer();
            }
            peer = nextPeer;
            peerId = peerOptions.peerId ? String(peerOptions.peerId) : null;
            peerOrigin = typeof peerOptions.origin === "string" ? peerOptions.origin : origin;
            peerSession = peerOptions.sessionId ? String(peerOptions.sessionId) : sessionId;
            peerVerified = Boolean(peerOptions.verified === true);
            installMessageListener();
            if (peerOptions.verified === true) send("hello", undefined, { epoch: localEpoch });
            return result(true, "peer-attached", { instanceId, sessionId, origin: peerOrigin });
        }

        function beginHandshake(payload) {
            installMessageListener();
            return send("hello", payload === undefined ? undefined : payload, { epoch: localEpoch });
        }

        async function initialize(options) {
            const initOptions = Object.assign({ acquire: true, recover: true }, options || {});
            if (disposed) return result(false, "disposed");
            if (ownershipActive) return result(true, "already-owner", { popoutAvailable: lockSupport() });
            // The Chat package starts in legacy single-window ownership.  Revoke that
            // optimistic state before any lock attempt, while preserving an
            // already initialized owner's active stream on repeated calls.
            if (!ownershipActive) setUiOwnership(false);
            installMessageListener();
            if (host && typeof host.subscribe === "function" && !adapterUnsubscribe) {
                adapterUnsubscribe = host.subscribe(change => {
                    if (change && change.type === "session-invalidated") {
                        void invalidateSession();
                        return;
                    }
                    if (!state.hostAvailable) return;
                    sendHostUpdate(change);
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
                if (initOptions.recover && durable.ok && durable.record && !durable.record.invalidated) {
                    if (!await recover()) {
                        releaseOwnership();
                        setState({ status: "recovery-required", ownership: false, reason: "saved Chat workspace could not be restored" });
                        return result(false, "recovery-failed");
                    }
                } else {
                    if (durable.reason === "invalid-recovery") {
                        releaseOwnership();
                        setState({ status: "recovery-required", ownership: false, reason: "saved Chat workspace is invalid" });
                        return result(false, "invalid-recovery");
                    }
                    if (durable.ok && durable.record?.invalidated && !resetWorkspaceUnderLock()) {
                        releaseOwnership();
                        setState({ status: "recovery-required", ownership: false, reason: "saved Chat workspace was cleared" });
                        return result(false, "recovery-reset-failed");
                    }
                    if (transfer || transferOperation) retireTransfer();
                    if (!await activateAfterLock(null, null)) {
                        releaseOwnership();
                        return result(false, "activation-failed");
                    }
                }
            }
            if (peer && !peerVerified) beginHandshake();
            return result(true, "initialized", { popoutAvailable: true });
        }

        async function recover(options) {
            const recoverOptions = options || {};
            if (!ownershipActive && !lockHeld && !await acquireOwnership({ ifAvailable: true, allowSingleWindow: false, activate: false })) return false;
            if (!lockHeld && lockSupport()) return false;
            const stored = readRecovery();
            if (stored.record && Number.isInteger(stored.record.revision)) revision = Math.max(revision, stored.record.revision);
            if (!stored.ok || !stored.record || stored.record.invalidated) {
                if (recoverOptions.clearInvalid !== true || stored.reason !== "invalid-recovery") return false;
                const removed = storageRemove();
                if (!removed.ok || !resetWorkspaceUnderLock()) return false;
                const activated = await activateAfterLock(null, null);
                if (!activated) return false;
                if (transfer || transferOperation) retireTransfer();
                setState({ reason: "" });
                return true;
            }
            revision = Math.max(revision, stored.record.revision);
            if (!validateSnapshot(stored.record.snapshot)) return false;
            const restored = await activateAfterLock(null, stored.record.snapshot);
            if (!restored) return false;
            if ((transfer && transfer.phase !== "owned") || (!transfer && transferOperation)) retireTransfer();
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
            if (peerVerified) {
                send("host-update", { change: { type: "session-invalidated" } }, { epoch: localEpoch });
            }
            retireTransfer();
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
            // Retain a held Web Lock while paused: a fresh document must
            // observe lock-busy (explicit recovery) rather than silently
            // adopting this quarantined checkpoint, however it races our
            // revocation write. The browser releases the lock when this
            // document unloads; dispose() covers explicit teardown.
            if (ownershipActive) {
                ownershipActive = false;
                setUiOwnership(false);
            }
            setState({ role: "observer", status: "host-unavailable", ownership: false, reason: "host session invalidated" });
            return true;
        }

        function getPeerHostAdapter(candidate) {
            if (!peerVerified || candidate !== peer || !state.hostAvailable || !host) return null;
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
            retireTransfer();
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
                retireTransfer();
                uiCall("resumeTransfer", [], undefined);
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
            checkpoint: checkpointSnapshot,
            readRecovery,
            invalidateRecovery,
            clearRecovery,
            recover,
            resetWorkspace: resetWorkspaceUnderLock,
            invalidateSession,
            abortActiveStream() {
                const failed = reason => Promise.reject(new Error(reason));
                if (disposed) return failed("Chat window coordinator is disposed.");
                if (!state.hostAvailable) return failed("Chat host is unavailable.");
                if (ownershipActive) return uiAwait("abortActiveStream", [], false).then(ok => {
                    if (ok === false) throw new Error("The active Chat stream could not be stopped.");
                    return true;
                });
                if (!peerVerified) return failed("The active Chat owner is unavailable.");
                const requestId = randomId("abort", config);
                const key = `abort:${requestId}`;
                addPending(key);
                if (!send("abort", undefined, { epoch: localEpoch, requestId })) {
                    pending.delete(key);
                    return failed("The active Chat owner could not be reached.");
                }
                return waitForPending(key, 5000).then(message => {
                    if (!message || message.payload?.ok !== true) throw new Error("The active Chat stream could not be stopped.");
                    return true;
                });
            },
            requestReturn() {
                if (disposed || !peerVerified || !state.hostAvailable) return false;
                return send("return-request", undefined, { epoch: localEpoch });
            },
            getPeerHostAdapter,
            getSessionInfo: () => ({ instanceId, sessionId, origin, protocolVersion: PROTOCOL_VERSION }),
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

    const DETACHED_QUERY_PARAM = "chat-window";
    const POPUP_NAME = "llama-gui-chat";
    const POPUP_FEATURES = "popup=yes,width=960,height=760,resizable=yes,scrollbars=yes";
    const DEFAULT_POPOUT_TITLE = "Open Chat in a separate window";

    function isDetachedView(target) {
        const current = target || (typeof window !== "undefined" ? window : null);
        try {
            const href = current && current.location && typeof current.location.href === "string"
                ? current.location.href : "";
            if (!href) return false;
            if (typeof URL === "function") return new URL(href).searchParams.get(DETACHED_QUERY_PARAM) === "1";
            const query = href.split("?", 2)[1]?.split("#", 1)[0] || "";
            return query.split("&").some(part => {
                const [key, value] = part.split("=", 2);
                return decodeURIComponent(key || "") === DETACHED_QUERY_PARAM && decodeURIComponent(value || "") === "1";
            });
        } catch (error) {
            if (current && current.console && typeof current.console.debug === "function") {
                current.console.debug("Unable to determine Chat window mode", error);
            }
            return false;
        }
    }

    function isClosedWindow(value) {
        try { return !value || value.closed === true; } catch (error) { return true; }
    }

    function safeRead(getter, fallback, logger) {
        try { return typeof getter === "function" ? getter() : fallback; }
        catch (error) {
            if (logger && typeof logger.debug === "function") logger.debug("Chat window host read failed", error);
            return fallback;
        }
    }

    function createFlagCoreBridge(host, options = {}) {
        const listeners = new Set();
        let values = {};
        let selectedModel = "";
        const logger = options.window && options.window.console;

        function refresh(nextSettings) {
            const settings = nextSettings && typeof nextSettings === "object" ? nextSettings
                : safeRead(host && host.getSettings, {}, logger);
            values = Object.assign({}, settings || {});
            selectedModel = values.selected_model === null || values.selected_model === undefined
                ? "" : String(values.selected_model);
            for (const listener of Array.from(listeners)) {
                try { listener(values); } catch (error) {
                    if (logger && typeof logger.warn === "function") logger.warn("Detached Chat settings listener failed", error);
                }
            }
            return values;
        }

        function currentValues() {
            const live = safeRead(host && host.getSettings, null, logger);
            if (live && typeof live === "object" && !Array.isArray(live)) refresh(live);
            return Object.assign({}, values);
        }

        function write(patch) {
            if (!host || typeof host.setSettings !== "function") throw new Error("Chat host settings writer is unavailable.");
            try {
                if (typeof host.isSessionValid === "function" && host.isSessionValid() !== true) {
                    throw new Error("Chat host is not connected.");
                }
            } catch (error) {
                options.onUnavailable?.(error);
                return currentValues();
            }
            let resultValue;
            try { resultValue = host.setSettings(patch); } catch (error) {
                logger?.warn?.("Chat host settings write failed", error);
                options.onUnavailable?.(error);
                return currentValues();
            }
            refresh(resultValue);
            return values;
        }

        refresh();
        return Object.freeze({
            getFlagValues: currentValues,
            getSelectedModel: () => {
                currentValues();
                return selectedModel;
            },
            getCurrentTool: () => "llama-server",
            setFlagValue: (field, value) => write({ [field]: value }),
            setMultipleFlagValues: patch => write(patch),
            subscribe(listener) {
                if (typeof listener !== "function") return () => {};
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            refresh,
        });
    }

    function waitForPeer(coordinator, timeoutMs = 10000) {
        if (coordinator.isPeerVerified()) return Promise.resolve(true);
        const limit = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 10000;
        return new Promise(resolve => {
            let finished = false;
            const finish = value => {
                if (finished) return;
                finished = true;
                if (unsubscribe) unsubscribe();
                if (timer) clearInterval(timer);
                resolve(Boolean(value));
            };
            const unsubscribe = coordinator.subscribe(() => {
                if (coordinator.isPeerVerified()) finish(true);
            });
            const timer = typeof setInterval === "function" ? setInterval(() => {
                if (coordinator.isPeerVerified()) finish(true);
            }, 50) : null;
            if (typeof setTimeout === "function") setTimeout(() => finish(coordinator.isPeerVerified()), limit);
            else finish(coordinator.isPeerVerified());
        });
    }

    function whenDomReady(target) {
        if (!target || !target.document || target.document.readyState !== "loading") return Promise.resolve();
        return new Promise(resolve => target.document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }

    function showDetachedError(target, title, message, options = {}) {
        const doc = target && target.document;
        const placeholder = doc?.getElementById("chat-window-placeholder");
        const layout = doc?.getElementById("chat-layout");
        const heading = placeholder?.querySelector("h3");
        const detail = placeholder?.querySelector("p");
        const showWindow = doc?.getElementById("btn-chat-show-window");
        const returnHere = doc?.getElementById("btn-chat-return-here");
        const fullGui = doc?.getElementById("chat-window-open-full-gui");
        const headerActions = doc?.querySelectorAll("#section-chat .chat-header-actions button");
        if (heading) {
            heading.textContent = title;
            heading.tabIndex = -1;
        }
        if (detail) detail.textContent = message;
        if (layout) layout.hidden = true;
        if (placeholder) placeholder.hidden = false;
        if (showWindow) {
            showWindow.hidden = true;
            showWindow.disabled = true;
            showWindow.setAttribute("aria-disabled", "true");
        }
        if (returnHere) {
            returnHere.hidden = true;
            returnHere.disabled = true;
            returnHere.setAttribute("aria-disabled", "true");
        }
        headerActions?.forEach(button => {
            button.disabled = true;
            button.setAttribute("aria-disabled", "true");
        });
        if (fullGui) {
            fullGui.hidden = options.fullGuiLink !== true;
            if (options.fullGuiLink === true) {
                try {
                    const url = new URL(target.location.href);
                    url.searchParams.delete(DETACHED_QUERY_PARAM);
                    fullGui.href = url.href;
                } catch (error) {
                    fullGui.hidden = true;
                    target.console?.debug?.("Unable to build full GUI recovery link", error);
                }
            }
        }
        doc?.body?.setAttribute("data-chat-window-error", "true");
        heading?.focus?.();
    }

    function startHostView(options = {}) {
        const target = options.window || (typeof window !== "undefined" ? window : null);
        const chatUi = options.chatUi || target?.LlamaGui?.chatUi;
        const flagCore = options.flagCore || target?.LlamaGui?.flagCore;
        if (!target || !chatUi || !flagCore) return Promise.resolve(result(false, "chat-host-unavailable"));
        if (api._hostView) return api._hostView.ready;

        let popup = null;
        let popupProof = null;
        let detached = false;
        let mainLayout = null;
        let originalFocus = null;
        let closedCheckTimer = null;
        const storage = getStorage({ window: target });
        const logger = target.console;
        const getStatus = () => safeRead(options.getLatestStatus, null, logger);
        const getLifecycle = () => safeRead(options.getLifecycleSnapshot, null, logger);
        function setHostStatus(message) {
            const status = target.document?.getElementById("chat-window-host-status");
            if (!status) return;
            status.textContent = message || "";
            status.hidden = !message;
        }
        const hostAdapter = createHostAdapter({
            window: target,
            storage,
            flagCore,
            getChatSamplerFlagIds: () => chatUi.getChatSamplerFlagIds?.() || [],
            getSelectedModel: () => typeof flagCore.getSelectedModel === "function"
                ? flagCore.getSelectedModel() : undefined,
            getActiveRuntime: getLifecycle,
            getStatus,
            getInference: () => safeRead(options.getInferenceSnapshot, null, logger),
            resetInferenceBaseline: options.resetInferenceBaseline,
            getAuthorizationHeaders: options.getApiAuthorizationHeaders,
            bringToFront: () => {
                try { target.focus(); return true; } catch (error) {
                    logger?.debug?.("Main Chat focus failed", error);
                    return false;
                }
            },
            navigate: tabId => {
                if (typeof options.switchTab !== "function") return false;
                try {
                    options.switchTab(tabId);
                    try { target.focus(); } catch (error) { logger?.debug?.("Main Chat focus failed", error); }
                    return true;
                } catch (error) { return false; }
            },
        });
        const coordinator = createCoordinator({
            window: target,
            chatUi,
            flagCore,
            hostAdapter,
            verifyPeerProof: payload => Boolean(popupProof && payload && payload.proof
                && payload.proof.key === popupProof.key && payload.proof.value === popupProof.value),
        });

        function notifyHostChange(change) {
            if (change && change.type === "session-invalidated") {
                return hostAdapter.invalidateSession();
            }
            return hostAdapter.notify(change);
        }

        function setButtonDisabled(button, disabled) {
            if (!button) return;
            const value = Boolean(disabled);
            button.disabled = value;
            button.setAttribute("aria-disabled", String(value));
        }

        function canFocus(element) {
            if (!element || element.hidden || element.disabled || element.getAttribute?.("aria-disabled") === "true"
                || element.isConnected === false || typeof element.focus !== "function") return false;
            if (typeof element.getClientRects === "function") {
                try {
                    const rects = element.getClientRects();
                    if (rects && rects.length === 0) return false;
                } catch (error) {
                    logger?.debug?.("Unable to inspect Chat focus target visibility", error);
                    return false;
                }
            }
            return true;
        }

        function focusFirst(...elements) {
            for (const element of elements) {
                if (!canFocus(element)) continue;
                try {
                    element.focus();
                    if (!target.document || !target.document.activeElement || target.document.activeElement === element) return true;
                } catch (error) {
                    logger?.debug?.("Chat focus target failed", error);
                }
            }
            return false;
        }

        function focusPlaceholderAction() {
            return focusFirst(
                target.document.getElementById("btn-chat-show-window"),
                target.document.getElementById("btn-chat-return-here"),
            );
        }

        function focusMainChatFallback() {
            const body = target.document?.body;
            const documentElement = target.document?.documentElement;
            const previousFocus = originalFocus && originalFocus !== body && originalFocus !== documentElement
                ? originalFocus : null;
            return focusFirst(
                target.document.getElementById("chat-input"),
                previousFocus,
                target.document.getElementById("btn-chat-new"),
                target.document.getElementById("btn-open-history"),
                target.document.getElementById("btn-chat-popout"),
            );
        }

        function isLiveDetached() {
            return detached && !isClosedWindow(popup);
        }

        function notifyDetachedChange() {
            if (typeof options.onDetachedChange !== "function") return;
            try { options.onDetachedChange(isLiveDetached()); } catch (error) { logger?.warn?.("Chat detached-state callback failed", error); }
        }

        function setDetachedUi(active, reason) {
            detached = Boolean(active);
            const state = coordinator.getState();
            const placeholder = target.document.getElementById("chat-window-placeholder");
            const layout = target.document.getElementById("chat-layout");
            const popout = target.document.getElementById("btn-chat-popout");
            const returnHere = target.document.getElementById("btn-chat-return-here");
            const showWindow = target.document.getElementById("btn-chat-show-window");
            if (placeholder) placeholder.hidden = !detached;
            if (layout) layout.hidden = detached;
            if (popout) {
                setButtonDisabled(popout, detached || !coordinator.isOwner() || !state.popoutAvailable);
                if (reason) popout.title = reason;
            }
            if (returnHere) {
                returnHere.hidden = !detached;
                if (detached) setButtonDisabled(returnHere, Boolean(state.transfer
                    && !isClosedWindow(popup) && state.transfer.phase !== "complete"));
            }
            if (returnHere && !detached) returnHere.textContent = "Return chat here";
            if (showWindow) showWindow.hidden = !detached;
            if (!detached) {
                const heading = placeholder?.querySelector("h3");
                const message = placeholder?.querySelector("p");
                if (heading) heading.textContent = "Chat is open in another window";
                if (message) message.textContent = "Use the separate Chat window to continue this conversation.";
            }
            notifyDetachedChange();
            if (detached) focusPlaceholderAction();
        }

        function restoreSourceAfterFailure() {
            setDetachedUi(false);
            if (mainLayout) chatUi.restoreLayout?.(mainLayout);
            mainLayout = null;
            try { target.focus(); } catch (error) { logger?.debug?.("Main Chat focus failed", error); }
            const previousFocus = originalFocus;
            originalFocus = null;
            focusFirst(target.document.getElementById("chat-input"), previousFocus,
                target.document.getElementById("btn-chat-new"),
                target.document.getElementById("btn-open-history"),
                target.document.getElementById("btn-chat-popout"));
        }

        function showRecoveryMessage() {
            const placeholder = target.document.getElementById("chat-window-placeholder");
            const heading = placeholder?.querySelector("h3");
            const message = placeholder?.querySelector("p");
            const showWindow = target.document.getElementById("btn-chat-show-window");
            const returnHere = target.document.getElementById("btn-chat-return-here");
            const focusWasOnShowWindow = target.document.activeElement === showWindow;
            if (heading) heading.textContent = "The Chat window was closed";
            if (message) message.textContent = "Recover the saved Chat workspace here when you are ready.";
            if (showWindow) showWindow.hidden = true;
            if (returnHere) {
                returnHere.hidden = false;
                setButtonDisabled(returnHere, false);
                returnHere.textContent = "Recover chat here";
            }
            if (focusWasOnShowWindow) focusPlaceholderAction();
        }

        function showObserverRecovery(reason) {
            const placeholder = target.document.getElementById("chat-window-placeholder");
            const layout = target.document.getElementById("chat-layout");
            const heading = placeholder?.querySelector("h3");
            const message = placeholder?.querySelector("p");
            const showWindow = target.document.getElementById("btn-chat-show-window");
            const returnHere = target.document.getElementById("btn-chat-return-here");
            if (layout) layout.hidden = true;
            if (placeholder) placeholder.hidden = false;
            if (heading) heading.textContent = "Chat is open in another window";
            if (message) message.textContent = reason || "Close the other Chat window, then recover the saved workspace here.";
            if (showWindow) showWindow.hidden = true;
            if (returnHere) {
                returnHere.hidden = false;
                setButtonDisabled(returnHere, false);
                returnHere.textContent = "Recover chat here";
            }
        }

        function updateControls(state) {
            const transferState = coordinator.getTransferState();
            const popout = target.document.getElementById("btn-chat-popout");
            if (popout) {
                const popoutDisabled = detached || !coordinator.isOwner() || state.popoutAvailable !== true
                    || transferState.allowed !== true;
                setButtonDisabled(popout, popoutDisabled);
                popout.title = popoutDisabled
                    ? (transferState.reason || state.reason || DEFAULT_POPOUT_TITLE)
                    : DEFAULT_POPOUT_TITLE;
            }
            const returnHere = target.document.getElementById("btn-chat-return-here");
            if (returnHere && detached) {
                setButtonDisabled(returnHere, Boolean(state.transfer && !isClosedWindow(popup)
                    && state.transfer.phase !== "complete"));
            }
            if (state.status === "detached" && !detached) setDetachedUi(true);
            if (state.ownership && detached) {
                detached = false;
                setDetachedUi(false);
                if (mainLayout) chatUi.restoreLayout?.(mainLayout);
                focusMainChatFallback();
                mainLayout = null;
            }
        }

        async function openPopout() {
            if (isClosedWindow(popup) === false) {
                try { popup.focus(); } catch (error) { logger?.debug?.("Chat popout focus failed", error); }
                return true;
            }
            setHostStatus("");
            const state = coordinator.getState();
            const transferState = coordinator.getTransferState();
            if (!state.popoutAvailable || !coordinator.isOwner() || transferState.allowed !== true) {
                setDetachedUi(false, transferState.reason || state.reason || "Chat popout is unavailable in this browser.");
                return false;
            }
            if (!storage || typeof storage.setItem !== "function") {
                setDetachedUi(false, "Chat popout requires available same-origin storage.");
                setHostStatus("Chat remains available in this window. Separate Chat windows require available same-origin storage.");
                return false;
            }
            const key = `llama-gui:chat-window-probe:${randomId("probe", { window: target })}`;
            const value = randomId("partition", { window: target });
            try { storage.setItem(key, value); } catch (error) {
                logger?.debug?.("Chat popout storage probe failed", error);
                setDetachedUi(false, "Chat popout requires available same-origin storage.");
                setHostStatus("Chat remains available in this window. Separate Chat windows require available same-origin storage.");
                return false;
            }
            popupProof = { key, value };
            let opened = null;
            try {
                originalFocus = target.document.activeElement;
                const url = new URL(target.location.href);
                url.searchParams.set(DETACHED_QUERY_PARAM, "1");
                url.searchParams.delete("preset");
                opened = target.open(url.href, POPUP_NAME, POPUP_FEATURES);
            } catch (error) {
                logger?.debug?.("Chat popout could not be opened", error);
            }
            if (!opened) {
                try { storage.removeItem(key); } catch (error) { logger?.debug?.("Chat popout probe cleanup failed", error); }
                popupProof = null;
                originalFocus = null;
                setDetachedUi(false, "Allow popups for this page to open Chat in a separate window.");
                setHostStatus("Chat remains available in this window. Allow popups for this page to open Chat in a separate window.");
                return false;
            }
            popup = opened;
            mainLayout = chatUi.captureLayout?.() || null;
            coordinator.attachPeer(popup, { origin: getOrigin({ window: target }), sessionId: coordinator.sessionId });
            if (!closedCheckTimer && typeof setInterval === "function") {
                closedCheckTimer = setInterval(() => {
                    if (!isClosedWindow(popup)) return;
                    popup = null;
                    popupProof = null;
                    if (detached) showRecoveryMessage();
                    notifyDetachedChange();
                    if (closedCheckTimer) { clearInterval(closedCheckTimer); closedCheckTimer = null; }
                }, 500);
            }
            const ready = await waitForPeer(coordinator, 10000);
            if (!ready || isClosedWindow(popup)) {
                try { storage.removeItem(key); } catch (error) { logger?.debug?.("Chat popout probe cleanup failed", error); }
                popupProof = null;
                if (!isClosedWindow(popup)) {
                    try { popup.close(); } catch (error) { logger?.debug?.("Failed Chat popup close", error); }
                }
                popup = null;
                restoreSourceAfterFailure();
                setHostStatus("Chat remains available in this window. The separate Chat window could not connect, so the current workspace was preserved.");
                return false;
            }
            try { storage.removeItem(key); } catch (error) { logger?.debug?.("Chat popout probe cleanup failed", error); }
            if (!await coordinator.beginTransfer({ timeoutMs: 10000 })) {
                popupProof = null;
                if (coordinator.getState().status === "recovery-required") {
                    setDetachedUi(true, "Chat ownership needs explicit recovery from the saved workspace.");
                    try { target.focus(); } catch (error) { logger?.debug?.("Main Chat focus failed", error); }
                } else {
                    try { popup?.close?.(); } catch (error) { logger?.debug?.("Failed Chat popup close", error); }
                    popup = null;
                    restoreSourceAfterFailure();
                    setHostStatus("Chat remains available in this window. The separate Chat window could not take ownership, so the current workspace was preserved.");
                }
                return false;
            }
            popupProof = null;
            setHostStatus("");
            setDetachedUi(true);
            if (isClosedWindow(popup)) showRecoveryMessage();
            return true;
        }

        async function requestReturn() {
            if (!detached) return false;
            if (isClosedWindow(popup)) return recoverMain();
            return coordinator.requestReturn();
        }

        async function recoverMain() {
            const locked = await coordinator.acquireOwnership({ ifAvailable: true, activate: false });
            if (!locked) return false;
            const record = coordinator.readRecovery();
            if (!record.ok && record.reason !== "empty" && record.reason !== "invalidated") {
                if (record.reason !== "invalid-recovery") {
                    coordinator.releaseOwnership();
                    return false;
                }
                const recoveredInvalid = await coordinator.recover({ clearInvalid: true });
                if (recoveredInvalid) {
                    setDetachedUi(false);
                    mainLayout = null;
                    focusMainChatFallback();
                } else {
                    coordinator.releaseOwnership();
                }
                return recoveredInvalid;
            }
            let recovered = false;
            if (record.ok && record.record && !record.record.invalidated) {
                recovered = await coordinator.recover();
                if (!recovered) {
                    coordinator.releaseOwnership();
                    return false;
                }
            } else {
                if (!coordinator.resetWorkspace()) {
                    coordinator.releaseOwnership();
                    return false;
                }
                recovered = await coordinator.acquireOwnership({ ifAvailable: true, activate: true });
            }
            if (recovered) {
                setDetachedUi(false);
                mainLayout = null;
                focusMainChatFallback();
            }
            return recovered;
        }

        function getBootstrapInfo(candidate) {
            if (candidate !== popup || isClosedWindow(popup) || !popupProof) return null;
            return {
                instanceId: coordinator.instanceId,
                sessionId: coordinator.sessionId,
                origin: getOrigin({ window: target }),
                protocolVersion: PROTOCOL_VERSION,
                proofKey: popupProof.key,
                proofValue: popupProof.value,
            };
        }

        chatUi.configureWorkspace({
            checkpoint: snapshot => coordinator.checkpoint(snapshot),
            invalidate: () => coordinator.invalidateRecovery().ok,
            onChange: () => updateControls(coordinator.getState()),
            detachedView: false,
        });
        coordinator.subscribe(updateControls);
        target.document.getElementById("btn-chat-popout")?.addEventListener("click", () => { void openPopout(); });
        target.document.getElementById("btn-chat-show-window")?.addEventListener("click", () => {
            if (!isClosedWindow(popup)) popup.focus();
        });
        target.document.getElementById("btn-chat-return-here")?.addEventListener("click", () => {
            void (detached ? requestReturn() : recoverMain());
        });
        if (typeof target.addEventListener === "function") {
            target.addEventListener("pagehide", () => {
                // A reload mid-handshake would otherwise orphan the storage
                // probe key, so remove the pending proof before invalidating.
                try {
                    if (popupProof) storage.removeItem(popupProof.key);
                } catch (error) { logger?.debug?.("Chat popout probe cleanup failed", error); }
                popupProof = null;
                notifyHostChange({ type: "session-invalidated" });
            });
            target.addEventListener("pageshow", event => {
                // A cached document's host adapter was revoked on pagehide.
                // Rebuild the host session and reacquire ownership normally.
                if (event.persisted) target.location.reload();
            });
        }
        // Chat starts with legacy single-window ownership. Revoke it before
        // init() so the first render cannot write over a recovery snapshot;
        // coordinator.initialize() then acquires and restores under the lock.
        chatUi.setOwnership?.(false);
        const ready = (async () => {
            try {
                if (typeof options.initializeChat === "function") await options.initializeChat();
                const outcome = await coordinator.initialize({ acquire: true, recover: true });
                if (!outcome.ok && (outcome.reason === "lock-busy" || outcome.reason === "recovery-failed"
                    || outcome.reason === "invalid-recovery" || outcome.reason === "recovery-reset-failed")) {
                    showObserverRecovery(outcome.reason === "lock-busy"
                        ? "Chat is active in another window. Close it, then recover the saved workspace here."
                        : "The saved Chat workspace needs recovery. Choose Recover chat here to start with a safe workspace.");
                }
                return outcome;
            } catch (error) {
                try { coordinator.dispose(); } catch (disposeError) {
                    logger?.debug?.("Unable to dispose Chat coordinator after startup failure", disposeError);
                }
                setHostStatus("Chat is unavailable in this window. Reload this page to restore Chat.");
                try {
                    showDetachedError(target, "Chat unavailable", "Chat could not start in this window. Other GUI sections remain available; reload this page to restore Chat and runtime controls.");
                } catch (showError) {
                    logger?.warn?.("Unable to show Chat startup failure", showError);
                }
                logger?.warn?.("Chat host startup failed", error);
                return result(false, "chat-init-failed");
            }
        })();
        api._hostView = { coordinator, hostAdapter, openPopout, requestReturn, getBootstrapInfo, notifyHostChange,
            isDetached: () => detached, ready,
            get popup() { return popup; } };
        return ready;
    }

    async function startDetachedView(options = {}) {
        const target = options.window || (typeof window !== "undefined" ? window : null);
        if (!target) return result(false, "chat-host-unavailable");
        const holder = { coordinator: null, hostCheckTimer: null };
        try {
            return await startDetachedViewImpl(options, holder);
        } catch (error) {
            if (holder.hostCheckTimer !== null) clearInterval(holder.hostCheckTimer);
            holder.coordinator?.dispose?.();
            debug({ window: target }, "Detached Chat bootstrap failed", error);
            try {
                showDetachedError(target, "Chat window unavailable", "This Chat window could not connect to the main GUI. Close it, then choose Recover chat here in the main Chat window.");
            } catch (showError) {
                debug({ window: target }, "Unable to show detached Chat error", showError);
            }
            return result(false, "detached-init-failed");
        }
    }

    async function startDetachedViewImpl(options = {}, holder = {}) {
        const target = options.window || (typeof window !== "undefined" ? window : null);
        if (!target) return result(false, "chat-host-unavailable");
        await whenDomReady(target);
        target.document?.body?.classList.add("chat-window-detached");
        const opener = target && target.opener;
        const chatUi = options.chatUi || target?.LlamaGui?.chatUi;
        let openerChatWindow = null;
        try { openerChatWindow = opener?.LlamaGui?.chatWindow || null; } catch (error) {
            debug({ window: target }, "Unable to inspect Chat opener", error);
        }
        if (!opener || !chatUi || !openerChatWindow) {
            showDetachedError(target, "Chat window unavailable", "This page was opened without a verified connection to the main GUI. Open the full GUI in this browser, then choose Chat and Pop out; a GUI opened in another browser cannot share this Chat.", { fullGuiLink: true });
            return result(false, "chat-host-unavailable");
        }
        let descriptor;
        try { descriptor = openerChatWindow.getBootstrapInfo(target); } catch (error) { descriptor = null; }
        if (!descriptor || descriptor.origin !== getOrigin({ window: target }) || !descriptor.proofKey || !descriptor.proofValue) {
            showDetachedError(target, "Chat window unavailable", "Close this window, then choose Recover chat here in the main Chat window.");
            return result(false, "chat-host-unavailable");
        }
        const storage = getStorage({ window: target });
        let proofMatches = false;
        try { proofMatches = storage && storage.getItem(descriptor.proofKey) === descriptor.proofValue; } catch (error) { proofMatches = false; }
        if (!proofMatches) {
            showDetachedError(target, "Chat window unavailable", "This window could not verify the main Chat storage partition.");
            return result(false, "storage-partition-mismatch");
        }
        const remoteState = { settings: {}, runtime: null, status: null, inference: null };
        let remoteAdapter = null;
        let hostLossStarted = false;
        let hostCheckTimer = null;
        let coordinator;
        function markHostUnavailable(error) {
            remoteAdapter = null;
            if (hostCheckTimer !== null) {
                clearInterval(hostCheckTimer);
                hostCheckTimer = null;
            }
            const hostStatus = target.document?.getElementById("chat-window-host-status");
            if (hostStatus) {
                hostStatus.textContent = "The main Chat window is unavailable. This workspace is paused; return to the main window to recover. Interrupted data may be checkpointed; messages will not be resent automatically.";
                hostStatus.hidden = false;
            }
            if (error && target.console?.debug) target.console.debug("Chat host bridge became unavailable", error);
            if (coordinator && !hostLossStarted) {
                hostLossStarted = true;
                void coordinator.invalidateSession().catch(reason => target.console?.debug?.("Chat host quarantine failed", reason));
            } else {
                chatUi.setHostAvailable?.(false);
            }
        }
        function hasCurrentHostSession() {
            if (!remoteAdapter || hostLossStarted) return false;
            try {
                const current = !isClosedWindow(opener)
                    ? opener?.LlamaGui?.chatWindow?.getSessionInfo?.(target) : null;
                if (current && current.origin === descriptor.origin && current.sessionId === descriptor.sessionId
                    && current.valid === true && remoteAdapter.isSessionValid?.() === true) return true;
            } catch (error) {
                target.console?.debug?.("Unable to verify current Chat host session", error);
            }
            markHostUnavailable(new Error("The main Chat session changed or closed."));
            return false;
        }
        const remoteHost = {
            getSettings: () => hasCurrentHostSession() ? remoteAdapter.getSettings() : Object.assign({}, remoteState.settings),
            setSettings: patch => {
                if (!hasCurrentHostSession()) throw new Error("Chat host is not connected.");
                return remoteAdapter.setSettings(patch);
            },
            getAuthorizationHeaders: (...args) => {
                if (!hasCurrentHostSession()) throw new Error("Chat host is not connected.");
                return remoteAdapter.getAuthorizationHeaders(...args);
            },
            resetInferenceBaseline: () => hasCurrentHostSession() ? remoteAdapter.resetInferenceBaseline() : undefined,
            navigate: (...args) => hasCurrentHostSession() ? remoteAdapter.navigate(...args) : false,
            isSessionValid: hasCurrentHostSession,
        };
        const bridge = createFlagCoreBridge(remoteHost, { window: target, onUnavailable: markHostUnavailable });
        let returnPromise = null;
        async function transferToMain() {
            if (returnPromise) return returnPromise;
            if (!coordinator || !coordinator.isOwner() || !hasCurrentHostSession()) return false;
            const allowed = coordinator.getTransferState();
            if (!allowed || allowed.allowed !== true) return false;
            returnPromise = coordinator.beginTransfer({ destinationId: descriptor.instanceId, timeoutMs: 10000 })
                .then(returned => {
                    if (returned) {
                        try { opener.focus(); } catch (error) { target.console?.debug?.("Main Chat focus failed", error); }
                        try { target.close(); } catch (error) { target.console?.debug?.("Chat window close failed", error); }
                    }
                    return returned;
                })
                .finally(() => { returnPromise = null; });
            return returnPromise;
        }
        function updateReturnControl() {
            const button = target.document?.getElementById("btn-chat-return");
            if (!button || !coordinator) return;
            const allowed = coordinator.getTransferState();
            const disabled = !coordinator.isOwner() || allowed.allowed !== true;
            button.disabled = disabled;
            button.setAttribute("aria-disabled", String(disabled));
            button.title = allowed.reason || "Return Chat to the main window";
        }
        const updateRemote = payload => {
            const next = payload && typeof payload === "object" ? payload : {};
            if (next.settings && typeof next.settings === "object") {
                remoteState.settings = Object.assign({}, next.settings);
                bridge.refresh(remoteState.settings);
            }
            if (Object.prototype.hasOwnProperty.call(next, "runtime")) remoteState.runtime = next.runtime;
            if (Object.prototype.hasOwnProperty.call(next, "status")) remoteState.status = next.status;
            if (Object.prototype.hasOwnProperty.call(next, "inference")) remoteState.inference = next.inference;
            if (next.change?.type === "session-invalidated") {
                markHostUnavailable();
            }
            chatUi.refreshSidebarUI?.();
            chatUi.updateStatusBadge?.();
            if (remoteState.inference && options.monitorUi) {
                options.monitorUi.renderInferenceSnapshot?.(remoteState.inference);
                options.monitorUi.renderStatsBarFromSnapshot?.(remoteState.inference, target.document);
            }
        };
        coordinator = createCoordinator({
            window: target,
            chatUi,
            sessionId: descriptor.sessionId,
            onHostUpdate: updateRemote,
            onReturnRequest: () => { void transferToMain(); },
        });
        holder.coordinator = coordinator;
        if (typeof target.addEventListener === "function") {
            target.addEventListener("pagehide", () => {
                const transferState = coordinator.getState().transfer;
                if (transferState?.phase === "complete") return;
                void coordinator.invalidateSession().catch(error => target.console?.debug?.("Chat popup quarantine failed", error));
            });
        }
        chatUi.configure({
            flagCore: bridge,
            confirmAction: options.confirmAction || target.confirmAction || ((title, message) => target.confirm(title, message)),
            getLatestStatus: () => remoteState.status,
            getLifecycleSnapshot: () => remoteState.runtime,
            snapshotStatsBaseline: remoteHost.resetInferenceBaseline,
            switchTab: remoteHost.navigate,
            getApiAuthorizationHeaders: remoteHost.getAuthorizationHeaders,
        });
        chatUi.configureWorkspace({
            checkpoint: snapshot => coordinator.checkpoint(snapshot),
            invalidate: () => coordinator.invalidateRecovery().ok,
            onChange: updateReturnControl,
            detachedView: true,
        });
        const initialized = await coordinator.initialize({ acquire: false, recover: false });
        if (!coordinator.getState().lockAvailable) {
            await whenDomReady(target);
            showDetachedError(target, "Chat popout unavailable", "This browser does not support the exclusive lock required for a shared Chat.");
            return result(false, "locks-unavailable");
        }
        // The popup starts as an observer like the host path above: revoke
        // ownership before init() so nothing is mutable before the verified
        // handoff grants it. Host availability is granted after the handshake.
        chatUi.setOwnership?.(false);
        chatUi.setHostAvailable?.(false);
        await whenDomReady(target);
        options.themeUi?.init?.();
        chatUi.init();
        target.document.getElementById("btn-chat-return")?.removeAttribute("hidden");
        target.document.getElementById("btn-chat-return")?.addEventListener("click", () => { void transferToMain(); });
        coordinator.attachPeer(opener, {
            origin: descriptor.origin,
            peerId: descriptor.instanceId,
            sessionId: descriptor.sessionId,
        });
        coordinator.beginHandshake({ proof: { key: descriptor.proofKey, value: descriptor.proofValue } });
        const verified = await waitForPeer(coordinator, 10000);
        if (!verified) {
            chatUi.setHostAvailable?.(false);
            showDetachedError(target, "Chat host unavailable", "Return to the main window and open Chat again.");
            return result(false, "host-handshake-failed");
        }
        remoteAdapter = openerChatWindow.getPeerHostAdapter(target);
        if (!remoteAdapter) {
            chatUi.setHostAvailable?.(false);
            showDetachedError(target, "Chat host unavailable", "Close this window, then choose Recover chat here in the main Chat window.");
            return result(false, "host-adapter-unavailable");
        }
        updateRemote({
            settings: remoteAdapter.getSettings(), runtime: remoteAdapter.getRuntime(),
            status: remoteAdapter.getStatus(), inference: remoteAdapter.getInference(),
        });
        chatUi.setHostAvailable?.(true);
        const hostStatus = target.document.getElementById("chat-window-host-status");
        if (hostStatus) hostStatus.hidden = true;
        updateReturnControl();
        options.monitorUi?.renderInferenceSnapshot?.(remoteState.inference);
        options.monitorUi?.renderStatsBarFromSnapshot?.(remoteState.inference, target.document);
        hostCheckTimer = setInterval(hasCurrentHostSession, 500);
        holder.hostCheckTimer = hostCheckTimer;
        return Object.assign(result(true, "detached-ready"), { coordinator, hostAdapter: remoteAdapter, initialized });
    }

    const api = {
        PROTOCOL, PROTOCOL_VERSION, SNAPSHOT_VERSION, SNAPSHOT_KIND, RECOVERY_VERSION,
        DEFAULT_LOCK_NAME, DEFAULT_RECOVERY_KEY, CHAT_READONLY_SETTING_FIELDS,
        createHostAdapter, createCoordinator,
        isDetachedView,
        startHostView,
        startDetachedView,
        notifyHostChange(change) {
            return api._hostView ? api._hostView.notifyHostChange(change) : false;
        },
        getPeerHostAdapter(candidate) {
            return api._hostView?.coordinator.getPeerHostAdapter(candidate) || null;
        },
        getSessionInfo(candidate) {
            const view = api._hostView;
            if (!view || candidate !== view.popup) return null;
            return Object.assign(view.coordinator.getSessionInfo(), { valid: view.hostAdapter.isSessionValid() });
        },
        hasDetachedView: () => Boolean(api._hostView && api._hostView.isDetached?.()
            && !isClosedWindow(api._hostView.popup)),
        abortActiveStream: () => api._hostView ? api._hostView.coordinator.abortActiveStream() : Promise.resolve(false),
        getBootstrapInfo(candidate) {
            return api._hostView?.getBootstrapInfo(candidate) || null;
        },
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
