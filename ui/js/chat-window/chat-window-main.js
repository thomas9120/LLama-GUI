// Stable public Chat-window facade. Package evaluation does not start either view.
(function () {
    "use strict";
    const root = typeof window !== "undefined" ? window : globalThis;
    const I = root.LlamaGui._chatWindowInternal;
    const { PROTOCOL, PROTOCOL_VERSION, SNAPSHOT_VERSION, SNAPSHOT_KIND, RECOVERY_VERSION,
        DEFAULT_LOCK_NAME, DEFAULT_RECOVERY_KEY, CHAT_READONLY_SETTING_FIELDS } = I.protocol;
    const { createHostAdapter } = I.hostAdapter;
    const { createCoordinator } = I.coordinator;
    const { isDetachedView, isClosedWindow } = I.bootstrap;
    const { startDetachedView } = I.detachedView;

    const api = {
        PROTOCOL, PROTOCOL_VERSION, SNAPSHOT_VERSION, SNAPSHOT_KIND, RECOVERY_VERSION,
        DEFAULT_LOCK_NAME, DEFAULT_RECOVERY_KEY, CHAT_READONLY_SETTING_FIELDS,
        createHostAdapter, createCoordinator,
        isDetachedView,
        startHostView(options) { return I.hostView.startHostView(options, api); },
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

    root.LlamaGui.chatWindow = api;
})();
