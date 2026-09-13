// Main-page output transport. The cursor owns response consumption; app callbacks
// own cross-panel and process-lifecycle transitions. Creation starts no polling.
(function () {
    "use strict";
    const root = window.LlamaGui = window.LlamaGui || {};

    function create({ fetchJson, appendOutput, getLifecycleSnapshot,
        onGenerationChanged, onExit, onConnectionLost }) {
        const processOutputCursor = root.outputCursor.create(appendOutput);
        let outputTimer = null;
        let pollOutputActiveEpoch = null;
        let pollOutputFailCount = 0;

        function startOutputPolling(initialCursor = null) {
            processOutputCursor.reset(initialCursor);
            pollOutputFailCount = 0;
            if (outputTimer) clearInterval(outputTimer);
            outputTimer = setInterval(pollOutput, 300);
        }

        function stopOutputPolling() {
            if (outputTimer) {
                clearInterval(outputTimer);
                outputTimer = null;
            }
            processOutputCursor.reset();
        }

        async function pollOutput() {
            const request = processOutputCursor.getRequest();
            if (pollOutputActiveEpoch === request.epoch) return;
            pollOutputActiveEpoch = request.epoch;
            try {
                const data = await fetchJson(request.url);
                // A superseded response must not reset the new cursor or reconcile
                // its runtime, even when the transport cannot be cancelled.
                if (!processOutputCursor.isCurrent(request.epoch)) return;
                const observedGeneration = Number(data && data.runtime_generation);
                const expectedGeneration = Number(getLifecycleSnapshot().activeRuntime?.generation);
                if (
                    data && data.running
                    && Number.isSafeInteger(observedGeneration)
                    && observedGeneration >= 1
                    && (!Number.isSafeInteger(expectedGeneration) || observedGeneration !== expectedGeneration)
                ) {
                    processOutputCursor.reset();
                    await onGenerationChanged();
                    return;
                }
                const consumed = processOutputCursor.consume(data, request.epoch);
                if (!consumed.current) return;
                if (!data.running) {
                    stopOutputPolling();
                    onExit();
                }
                pollOutputFailCount = 0;
            } catch (e) {
                if (!processOutputCursor.isCurrent(request.epoch)) return;
                pollOutputFailCount++;
                if (pollOutputFailCount <= 5) {
                    appendOutput("Output polling error (retry " + pollOutputFailCount + "/5): " + e.message);
                } else {
                    appendOutput("Connection to server lost: " + e.message);
                    stopOutputPolling();
                    onConnectionLost();
                }
            } finally {
                if (pollOutputActiveEpoch === request.epoch) pollOutputActiveEpoch = null;
            }
        }

        const api = {
            start: startOutputPolling,
            stop: stopOutputPolling,
            invalidate: processOutputCursor.invalidate,
            isActive: () => outputTimer !== null,
        };
        if (window.__LLAMA_GUI_TEST_HOOKS__) {
            api._test = { getUrl: processOutputCursor.getUrl };
        }
        return api;
    }

    root.processOutput = { create };
})();
