// Monitor initialization and stable public facade. Loading/configuration remain inert.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;
    const root = window.LlamaGui;

    function configure(nextDeps) {
        I.dependencies = Object.assign({}, I.dependencies, nextDeps || {});
    }

    function resetForTests() {
        I.polling.reset();
        I.preferences.reset();
    }

    function init() {
        I.preferences.loadHiddenCards();
        I.preferences.loadCardOrder();

        const recheckBtn = I.dom.byId("btn-monitor-recheck");
        if (recheckBtn) recheckBtn.addEventListener("click", I.polling.recheck);

        for (const [id, tab] of [["btn-monitor-configure", "configure"], ["btn-monitor-quick-launch", "quick-launch"], ["btn-monitor-api", "api"]]) {
            I.dom.byId(id)?.addEventListener("click", () => I.dependencies.switchTab(tab));
        }
        I.dom.byId("btn-monitor-review")?.addEventListener("click", () => I.dependencies.reviewLaunchChanges());

        const resetBtn = I.dom.byId("btn-reset-inference");
        if (resetBtn) {
            resetBtn.addEventListener("click", () => {
                if (typeof I.dependencies.resetStatsBaseline === "function") I.dependencies.resetStatsBaseline();
            });
        }

        I.preferences.bindControls();

        I.terminal.updateProcessHeader();
        I.polling.renderLiveBadge();
        I.preferences.applyHiddenCardsToDom();
        I.preferences.applyCardOrderToDom();
    }

    root.monitorUi = {
        configure,
        init,
        onTabChanged: I.polling.onTabChanged,
        setDocumentVisibility: I.polling.setDocumentVisibility,
        recheck: I.polling.recheck,
        appendOutputLine: I.terminal.appendOutputLine,
        clearTerminal: I.terminal.clearTerminal,
        updateProcessHeader: I.terminal.updateProcessHeader,
        renderRuntime: I.terminal.renderRuntime,
        renderInferenceSnapshot: I.inference.renderInferenceSnapshot,
        renderStatsBarFromSnapshot: I.inference.renderStatsBarFromSnapshot,
        // Compatibility aliases; new consumers use root.inferenceStats directly.
        createInferenceStats: root.inferenceStats.createInferenceStats,
        parseMetricsText: root.inferenceStats.parseMetricsText,
        normalizeSlots: root.inferenceStats.normalizeSlots,
        // Exported for unit tests:
        formatBytes: I.dom.formatBytes,
        formatRate: I.dom.formatRate,
        formatPercentValue: I.dom.formatPercentValue,
        formatTokens: I.dom.formatTokens,
        formatClock: I.dom.formatClock,
        shortGpuId: I.dom.shortGpuId,
        normalizeHiddenEntries: I.preferences.normalizeHiddenEntries,
        isSessionOnlyKey: I.preferences.isSessionOnlyKey,
        normalizeOrderEntries: I.preferences.normalizeOrderEntries,
        _resetForTests: resetForTests,
    };
})();
