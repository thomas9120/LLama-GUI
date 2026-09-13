// System telemetry polling, visibility gates, request generations, and live badge.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;

    const POLL_INTERVAL_MS = 2000;
    let panelVisible = false;
    let documentVisible = true;
    let pollTimer = null;
    let pollController = null;
    let pollGeneration = 0;
    let lastSample = null;
    let lastSuccessAt = 0;
    let lastPollFailed = false;
    let everSucceeded = false;
    function requireDep(name) {
        const value = I.dependencies[name];
        if (typeof value !== "function") {
            throw new Error(`Monitor UI dependency missing: ${name}`);
        }
        return value;
    }

    function currentStatusState() {
        if (!panelVisible || !documentVisible) return "paused";
        if (!everSucceeded) return "unavailable";
        if (pollController) return "refreshing";
        if (lastPollFailed) return "stale";
        return "live";
    }

    function renderLiveBadge() {
        const badge = I.dom.byId("monitor-live-badge");
        const updated = I.dom.byId("monitor-last-updated");
        if (updated) updated.textContent = I.dom.formatClock(lastSuccessAt || null);
        if (!badge) return;
        const state = currentStatusState();
        const labels = {
            live: "Live \u00b7 ~2 s",
            refreshing: "Refreshing\u2026",
            stale: "Stale \u00b7 retrying",
            unavailable: "Unavailable",
            paused: "Paused",
        };
        badge.textContent = `System telemetry · ${labels[state]}`;
        badge.classList.toggle("badge-green", state === "live");
        badge.classList.toggle("badge-neutral", state === "refreshing" || state === "paused");
        badge.classList.toggle("badge-yellow", state === "stale");
        badge.classList.toggle("badge-dim", state === "unavailable");
    }

    function pollingShouldRun() {
        return panelVisible && documentVisible;
    }

    function cancelScheduledPoll() {
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function abortInFlight() {
        if (pollController) {
            pollController.abort();
            pollController = null;
        }
    }

    function scheduleNextPoll() {
        cancelScheduledPoll();
        if (!pollingShouldRun()) return;
        const interval = Number(I.dependencies.pollIntervalMs);
        const delay = Number.isFinite(interval) && interval > 0 ? interval : POLL_INTERVAL_MS;
        pollTimer = setTimeout(() => {
            pollTimer = null;
            pollSystemStats(false);
        }, delay);
    }

    async function pollSystemStats(forceRefresh) {
        if (pollController) pollController.abort();
        const generation = ++pollGeneration;
        const controller = new AbortController();
        pollController = controller;
        if (forceRefresh) renderLiveBadge();
        try {
            const fetchJson = requireDep("fetchJson");
            const url = forceRefresh ? "/api/system-stats?refresh=1" : "/api/system-stats";
            const data = await fetchJson(url, { signal: controller.signal });
            if (generation !== pollGeneration) return;
            lastSample = data;
            lastSuccessAt = Number(data && data.sampled_at) || Date.now() / 1000;
            lastPollFailed = false;
            everSucceeded = true;
            I.system.renderSample(data);
        } catch (error) {
            if (generation !== pollGeneration) return;
            if (error && error.name === "AbortError") return;
            console.warn("Monitor system stats poll failed", error);
            lastPollFailed = true;
        } finally {
            if (pollController === controller) pollController = null;
            if (generation === pollGeneration) {
                renderLiveBadge();
                scheduleNextPoll();
            }
        }
    }

    function recheck() {
        // Recheck aborts any in-flight poll and forces a backend cache bypass.
        pollSystemStats(true);
    }

    function reevaluatePolling() {
        if (pollingShouldRun()) {
            if (!pollController && !pollTimer) pollSystemStats(false);
            else scheduleNextPoll();
        } else {
            cancelScheduledPoll();
            abortInFlight();
            pollGeneration += 1;
            renderLiveBadge();
        }
    }

    function onTabChanged(tabId) {
        panelVisible = tabId === "monitor";
        if (panelVisible) {
            I.preferences.applyHiddenCardsToDom();
            I.preferences.applyCardOrderToDom();
            I.terminal.updateProcessHeader();
            I.terminal.scrollTerminalToBottom();
        }
        reevaluatePolling();
    }

    function setDocumentVisibility(visible) {
        documentVisible = Boolean(visible);
        reevaluatePolling();
    }

    function reset() {
        cancelScheduledPoll();
        abortInFlight();
        pollGeneration += 1;
        panelVisible = false;
        documentVisible = true;
        lastSample = null;
        lastSuccessAt = 0;
        lastPollFailed = false;
        everSucceeded = false;
    }
    function getSampleInterval() {
        return Number(lastSample && lastSample.interval_seconds);
    }

    I.polling = {
        getSampleInterval,
        onTabChanged,
        recheck,
        renderLiveBadge,
        reset,
        setDocumentVisibility,
    };
})();
