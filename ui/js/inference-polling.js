// Main-page inference transport and target lifecycle. Creation is inert.
(function () {
    "use strict";
    const root = window.LlamaGui = window.LlamaGui || {};

    function create({ inferenceStats, fetch, getServerEndpointConfig,
        getApiAuthorizationHeaders, getLifecycleSnapshot }) {
        let inferenceTimer = null;
        let inferenceInitialTimer = null;
        let statsEpoch = 0;
        let statsActiveEpoch = null;
        let statsAbortController = null;
        let statsDocumentVisible = true;
        let externalTargetRevision = 0;

        function startStatsPolling(runtime, lifecycleState) {
            stopStatsPolling();
            // Fresh processes start their counters at zero. Restored processes need a
            // first-poll baseline so their lifetime counters do not become session totals.
            const freshLaunch = lifecycleState && lifecycleState.operation !== "restore";
            const generation = Number(runtime && runtime.generation);
            const key = Number.isSafeInteger(generation) && generation >= 1 ? `gui:${generation}` : null;
            inferenceStats.setTarget(key, { zeroBaseline: freshLaunch });
            beginInferencePolling();
        }

        function stopStatsPolling() {
            statsEpoch += 1;
            clearInferenceTimers();
            if (statsAbortController) {
                statsAbortController.abort();
                statsAbortController = null;
            }
            statsActiveEpoch = null;
            inferenceStats.setTarget(null);
        }

        function clearInferenceTimers() {
            if (inferenceInitialTimer) {
                clearTimeout(inferenceInitialTimer);
                inferenceInitialTimer = null;
            }
            if (inferenceTimer) {
                clearTimeout(inferenceTimer);
                inferenceTimer = null;
            }
        }

        function inferencePollingActive() {
            return Boolean(inferenceInitialTimer || inferenceTimer || statsActiveEpoch !== null);
        }

        function beginInferencePolling() {
            if (!inferenceStats.getTargetKey() || !statsDocumentVisible) return;
            clearInferenceTimers();
            const epoch = statsEpoch;
            inferenceInitialTimer = setTimeout(() => {
                inferenceInitialTimer = null;
                pollStats(epoch);
            }, 2000);
        }

        function scheduleNextInferencePoll(epoch) {
            if (epoch !== statsEpoch || !statsDocumentVisible || !inferenceStats.getTargetKey()) return;
            if (inferenceTimer) clearTimeout(inferenceTimer);
            inferenceTimer = setTimeout(() => {
                inferenceTimer = null;
                pollStats(epoch);
            }, 3000);
        }

        async function pollStats(epoch = statsEpoch) {
            if (epoch !== statsEpoch || statsActiveEpoch === epoch) return;
            statsActiveEpoch = epoch;
            const controller = new AbortController();
            statsAbortController = controller;
            try {
                const { host, port } = getServerEndpointConfig();
                const params = new URLSearchParams({ host, port: String(port) });
                const headers = getApiAuthorizationHeaders();
                // Fetch /metrics and /slots independently: a disabled or unavailable
                // metrics endpoint must not suppress slot-based context, and vice versa.
                const [metricsResp, slotsResp] = await Promise.all([
                    fetch(`/api/llama/metrics?${params.toString()}`, { headers, signal: controller.signal }).catch(error => {
                        if (error && error.name !== "AbortError" && epoch === statsEpoch) {
                            console.debug("Failed to fetch llama-server metric stats", error);
                        }
                        return null;
                    }),
                    fetch(`/api/llama/slots?${params.toString()}`, { headers, signal: controller.signal }).catch(error => {
                        if (error && error.name !== "AbortError" && epoch === statsEpoch) {
                            console.debug("Failed to fetch llama-server slot stats", error);
                        }
                        return null;
                    }),
                ]);
                if (epoch !== statsEpoch) return;

                let metricsOk = false;
                let metricsValues = null;
                if (metricsResp && metricsResp.ok) {
                    try {
                        const text = await metricsResp.text();
                        if (epoch !== statsEpoch) return;
                        metricsValues = root.inferenceStats.parseMetricsText(text);
                        metricsOk = true;
                    } catch (e) {
                        console.debug("Failed to parse llama-server metric stats", e);
                    }
                }

                let slotsOk = false;
                let slotsNormalized = null;
                if (slotsResp && slotsResp.ok) {
                    let slotsPayload = null;
                    try {
                        slotsPayload = await slotsResp.json();
                    } catch (e) {
                        console.debug("Failed to parse llama-server slot stats", e);
                    }
                    if (epoch !== statsEpoch) return;
                    slotsNormalized = root.inferenceStats.normalizeSlots(slotsPayload);
                    slotsOk = slotsNormalized !== null;
                }

                if (epoch !== statsEpoch) return;
                inferenceStats.applyPollResult({
                    metricsOk,
                    metricsValues,
                    slotsOk,
                    slotsNormalized,
                    now: Date.now(),
                });
                scheduleNextInferencePoll(epoch);
            } catch (e) {
                if (e && e.name !== "AbortError" && epoch === statsEpoch) {
                    console.debug("Failed to fetch llama-server metrics", e);
                }
                if (epoch === statsEpoch) scheduleNextInferencePoll(epoch);
            } finally {
                if (statsActiveEpoch === epoch) statsActiveEpoch = null;
                if (statsAbortController === controller) statsAbortController = null;
            }
        }

        function resolveInferenceTargetKey(status) {
            if (status && status.running && status.active_runtime
                && status.active_runtime.tool === "llama-server") {
                const generation = Number(status.active_runtime.generation);
                if (Number.isSafeInteger(generation) && generation >= 1) return `gui:${generation}`;
            }
            const target = status && status.external_chat_target;
            if (target && target.connected) {
                const host = String(target.host || "").trim().toLowerCase() || "127.0.0.1";
                const port = Number(target.port);
                const normalizedPort = Number.isFinite(port) && port > 0 ? port : 0;
                // The revision changes on every successful external connect/restore so
                // even a reconnect to the same address starts a fresh baseline. The
                // API key is deliberately excluded from the identity.
                return `ext:${externalTargetRevision}:${host}:${normalizedPort}`;
            }
            return null;
        }

        function reconcileInferenceTarget(status) {
            const key = resolveInferenceTargetKey(status);
            const current = inferenceStats.getTargetKey();
            if (!key) {
                if (current !== null) stopStatsPolling();
                return;
            }
            if (key !== current) {
                if (key.startsWith("gui:")) {
                    // GUI-owned launches and restores belong to the process lifecycle,
                    // which sets the correct baseline through startStatsPolling. Do not
                    // preempt an in-progress transition from here.
                    const lifecycle = getLifecycleSnapshot();
                    const lifecycleGeneration = Number(
                        lifecycle.activeRuntime && lifecycle.activeRuntime.generation
                    );
                    if (!lifecycle.ready || lifecycleGeneration !== Number(key.slice(4))) return;
                }
                // A target discovered through status (startup restore, external
                // connect/restore, or an out-of-band replacement) never had its
                // counters start at zero in this session: the first valid counter
                // sample becomes the baseline.
                // Invalidate delayed responses from the previous external connection,
                // including a reconnect to the same host with a new revision.
                stopStatsPolling();
                inferenceStats.setTarget(key, { zeroBaseline: false });
            }
            if (!inferencePollingActive()) beginInferencePolling();
        }

        function markExternalTargetChanged() {
            externalTargetRevision += 1;
        }

        // Both document visibility and detached-Chat changes use this transition.
        // Pausing invalidates transport work but retains the target and its baseline.
        function setActive(active) {
            statsDocumentVisible = Boolean(active);
            if (!inferenceStats.getTargetKey()) return;
            if (statsDocumentVisible) {
                clearInferenceTimers();
                pollStats(statsEpoch);
            } else {
                statsEpoch += 1;
                clearInferenceTimers();
                if (statsAbortController) {
                    statsAbortController.abort();
                    statsAbortController = null;
                }
                statsActiveEpoch = null;
            }
        }

        const api = {
            start: startStatsPolling,
            stop: stopStatsPolling,
            reconcileTarget: reconcileInferenceTarget,
            markExternalTargetChanged,
            setActive,
        };
        if (window.__LLAMA_GUI_TEST_HOOKS__) {
            api._test = {
                poll: pollStats,
                getState: () => ({
                    active: inferencePollingActive(),
                    documentVisible: statsDocumentVisible,
                    hasInitialTimer: inferenceInitialTimer !== null,
                    hasTimer: inferenceTimer !== null,
                    inFlight: statsActiveEpoch !== null,
                    hasAbortController: statsAbortController !== null,
                }),
            };
        }
        return api;
    }

    root.inferencePolling = { create };
})();
