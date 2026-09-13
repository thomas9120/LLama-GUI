// Exclusive Chat workspace ownership, transfer, and recovery. All mutable state stays per coordinator.
(function () {
    "use strict";
    const root = typeof window !== "undefined" ? window : globalThis;
    const I = root.LlamaGui._chatWindowInternal;
    const { PROTOCOL, PROTOCOL_VERSION, SNAPSHOT_VERSION, SNAPSHOT_KIND, RECOVERY_VERSION, DEFAULT_LOCK_NAME, DEFAULT_RECOVERY_KEY, getWindow, debug, warn, isObject, isJsonValue, cloneJson, result } = I.protocol;
    const { deriveSettingFields } = I.hostAdapter;
    const { getOrigin, randomId, getStorage } = I.bootstrap;

    function defer() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
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

    I.coordinator = Object.freeze({ createCoordinator });
})();
