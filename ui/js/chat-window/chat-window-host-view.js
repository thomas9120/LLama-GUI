// Main-window Chat bootstrap and popup controls; the facade supplies its live host-view holder.
(function () {
    "use strict";
    const root = typeof window !== "undefined" ? window : globalThis;
    const I = root.LlamaGui._chatWindowInternal;
    const { PROTOCOL_VERSION, result } = I.protocol;
    const { DETACHED_QUERY_PARAM, getOrigin, randomId, getStorage, isClosedWindow, safeRead, waitForPeer, showDetachedError } = I.bootstrap;
    const { createHostAdapter } = I.hostAdapter;
    const { createCoordinator } = I.coordinator;

    const POPUP_NAME = "llama-gui-chat";
    const POPUP_FEATURES = "popup=yes,width=960,height=760,resizable=yes,scrollbars=yes";
    const DEFAULT_POPOUT_TITLE = "Open Chat in a separate window";

    function startHostView(options = {}, api) {
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

    I.hostView = Object.freeze({ startHostView });
})();
