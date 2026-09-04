// Monitor tab UI: system/GPU polling, process-output terminal, shared
// inference snapshot rendering, and card visibility preferences.
//
// Ownership rules (see docs/monitor-tab-docs/monitor-plan.md):
// - Process lifecycle, launch/stop, and cursor ownership stay in app.js;
//   this module only renders output lines and clears the terminal.
// - Inference telemetry is fetched by app.js's existing stats poller; this
//   module renders snapshots and hosts the pure normalization engine so both
//   views share one baseline.
(function () {
    "use strict";

    const root = window.LlamaGui = window.LlamaGui || {};

    // ════════════════════════════════════════════════════════════════════
    // Pure formatting helpers
    // ════════════════════════════════════════════════════════════════════

    const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

    function finiteOrNull(value) {
        if (value === null || value === undefined) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function finiteNonNegativeOrNull(value) {
        const num = finiteOrNull(value);
        return num !== null && num >= 0 ? num : null;
    }

    function clampPercent(value) {
        const num = finiteOrNull(value);
        if (num === null) return null;
        return Math.max(0, Math.min(100, num));
    }

    function formatBytes(bytes) {
        const value = finiteNonNegativeOrNull(bytes);
        if (value === null) return "Not available";
        let scaled = value;
        let unitIndex = 0;
        while (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
            scaled /= 1024;
            unitIndex += 1;
        }
        const digits = unitIndex === 0 ? 0 : (scaled >= 100 ? 0 : 1);
        return `${scaled.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
    }

    function formatRate(bytesPerSecond) {
        const value = finiteNonNegativeOrNull(bytesPerSecond);
        if (value === null) return "Not available";
        return `${formatBytes(value)}/s`;
    }

    function formatPercentValue(value, digits = 0) {
        const clamped = clampPercent(value);
        if (clamped === null) return "Not available";
        return clamped.toFixed(digits);
    }

    function formatTokens(value) {
        const num = finiteNonNegativeOrNull(value);
        if (num === null) return "--";
        return Math.round(num).toLocaleString();
    }

    function formatSpeed(tokensPerSecond) {
        const num = finiteNonNegativeOrNull(tokensPerSecond);
        if (num === null) return "--";
        return num.toFixed(1);
    }

    function formatClock(epochSeconds) {
        const num = finiteOrNull(epochSeconds);
        if (num === null) return "--:--:--";
        const date = new Date(num * 1000);
        const pad = (part) => String(part).padStart(2, "0");
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function shortGpuId(id) {
        const text = String(id || "");
        if (text.length <= 24) return text;
        return `${text.slice(0, 12)}\u2026${text.slice(-5)}`;
    }

    // ════════════════════════════════════════════════════════════════════
    // llama-server observability normalization (shared with the fixed bar)
    // ════════════════════════════════════════════════════════════════════

    function parseMetricsText(text) {
        const metrics = {};
        for (const line of String(text || "").split("\n")) {
            if (line.startsWith("#") || !line.trim()) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const value = parseFloat(parts[1]);
                if (Number.isFinite(value)) metrics[parts[0]] = value;
            }
        }
        return metrics;
    }

    // Normalize one /slots response. Returns null when the payload is not a
    // slot array so callers can distinguish "unavailable" from "zero slots".
    function normalizeSlots(slots) {
        if (!Array.isArray(slots)) return null;
        let busiest = null;
        let processing = 0;
        const samples = [];
        for (const slot of slots) {
            const isProcessing = Boolean(slot && slot.is_processing);
            if (isProcessing) processing += 1;

            const nextToken = Array.isArray(slot && slot.next_token)
                ? slot.next_token[0]
                : slot && slot.next_token;
            const samplePrompt = Number(slot && slot.n_prompt_tokens_processed);
            const sampleGen = Number(nextToken && nextToken.n_decoded);
            const slotId = slot && slot.id;
            const taskId = slot && slot.id_task;
            if (isProcessing
                && slotId !== null && slotId !== undefined && slotId !== ""
                && taskId !== null && taskId !== undefined && taskId !== "") {
                samples.push({
                    key: `${slotId}:${taskId}`,
                    promptTokens: Number.isFinite(samplePrompt) && samplePrompt >= 0 ? samplePrompt : null,
                    genTokens: Number.isFinite(sampleGen) && sampleGen >= 0 ? sampleGen : null,
                });
            }

            const nCtx = Number(slot && slot.n_ctx);
            if (!Number.isFinite(nCtx) || nCtx <= 0) continue;
            // Current llama-server reports total tokens held by the slot as
            // n_prompt_tokens (prompt + generated, including accepted MTP draft
            // tokens). Older builds only expose generated tokens via next_token,
            // which is an object in current builds and was an array before.
            let used = Number(slot && slot.n_prompt_tokens);
            if (!Number.isFinite(used) || used < 0) {
                used = Number(nextToken && nextToken.n_decoded);
            }
            if (!Number.isFinite(used) || used < 0) continue;
            const usage = Math.max(0, Math.min(1, used / nCtx));
            if (!busiest || usage > busiest.percent / 100) {
                busiest = {
                    used: Math.round(used),
                    total: Math.round(nCtx),
                    remaining: Math.max(0, Math.round(nCtx - used)),
                    percent: usage * 100,
                    isProcessing,
                    slotId: slot.id !== undefined ? slot.id : null,
                };
            }
        }
        return {
            processing,
            busySlots: processing,
            totalSlots: slots.length,
            samples,
            busiest,
        };
    }

    // Target-keyed, sequenced inference state shared by the fixed stats bar
    // and the Monitor Inference card. Pure state machine: no DOM, no fetch.
    function createInferenceStats(options = {}) {
        const onSnapshot = typeof options.onSnapshot === "function" ? options.onSnapshot : null;
        let targetKey = null;
        let seq = 0;
        let baseline = null;
        let averageBaseline = null;
        let raw = { prompt: null, gen: null };
        let sampled = false;
        let rate = { at: 0, slots: {} };
        let lastInput = null;
        let lastSnapshot = null;

        function emit(snapshot) {
            lastSnapshot = snapshot;
            if (onSnapshot) onSnapshot(snapshot);
            return snapshot;
        }

        function getTargetKey() {
            return targetKey;
        }

        function getSnapshot() {
            return lastSnapshot;
        }

        function setTarget(key, settings = {}) {
            if (key === targetKey) return lastSnapshot;
            targetKey = key;
            seq = 0;
            baseline = {
                prompt: settings.zeroBaseline ? 0 : null,
                gen: settings.zeroBaseline ? 0 : null,
            };
            averageBaseline = {
                prompt: settings.zeroBaseline ? { tokens: 0, seconds: 0 } : null,
                gen: settings.zeroBaseline ? { tokens: 0, seconds: 0 } : null,
            };
            raw = { prompt: null, gen: null };
            sampled = false;
            rate = { at: 0, slots: {} };
            lastInput = null;
            if (!key) return emit(null);
            seq += 1;
            return emit({
                targetKey,
                seq,
                sources: { metrics: "unavailable", slots: "unavailable" },
                session: { prompt: null, generated: null, total: null },
                context: null,
                requests: { processing: null, queued: null, processingBest: null },
                slots: null,
                speed: { prompt: null, generated: null },
                contextLevel: "normal",
                baselinePending: true,
            });
        }

        function sessionValue(current, base) {
            if (current === null || base === null) return null;
            return Math.max(0, current - base);
        }

        function averageValue(tokens, seconds, base) {
            if (tokens === null || seconds === null || !base) return null;
            const elapsed = seconds - base.seconds;
            return elapsed > 0 ? Math.max(0, tokens - base.tokens) / elapsed : null;
        }

        function rebuild() {
            const input = lastInput;
            seq += 1;
            const metricsValues = input && input.metricsOk && input.metricsValues ? input.metricsValues : null;
            const slotsNormalized = input && input.slotsOk && input.slotsNormalized ? input.slotsNormalized : null;
            const metricsOk = Boolean(metricsValues);
            const slotsOk = Boolean(slotsNormalized);
            const now = input && Number.isFinite(input.now) ? input.now : 0;

            let promptSpeedGauge = null;
            let genSpeedGauge = null;
            let processing = null;
            let deferred = null;
            let currentCounters = { prompt: null, gen: null };
            let currentSeconds = { prompt: null, gen: null };
            if (metricsValues) {
                currentCounters = {
                    prompt: finiteNonNegativeOrNull(metricsValues["llamacpp:prompt_tokens_total"]),
                    gen: finiteNonNegativeOrNull(metricsValues["llamacpp:tokens_predicted_total"]),
                };
                currentSeconds = {
                    prompt: finiteNonNegativeOrNull(metricsValues["llamacpp:prompt_seconds_total"]),
                    gen: finiteNonNegativeOrNull(metricsValues["llamacpp:tokens_predicted_seconds_total"]),
                };
                promptSpeedGauge = finiteNonNegativeOrNull(metricsValues["llamacpp:prompt_tokens_seconds"]);
                genSpeedGauge = finiteNonNegativeOrNull(metricsValues["llamacpp:predicted_tokens_seconds"]);
                processing = finiteNonNegativeOrNull(metricsValues["llamacpp:requests_processing"]);
                deferred = finiteNonNegativeOrNull(metricsValues["llamacpp:requests_deferred"]);

                // A cumulative counter going down without an observed target
                // change means the upstream server restarted. Rebase instead
                // of clamping a cross-restart delta to zero.
                let counterRolled = false;
                for (const name of ["prompt", "gen"]) {
                    const current = currentCounters[name];
                    if (current === null) continue;
                    if (raw[name] !== null && current < raw[name]) {
                        baseline[name] = current;
                        counterRolled = true;
                    }
                    raw[name] = current;
                    // Restored targets baseline each counter independently so a
                    // field that appears late does not inherit another field's
                    // first sample.
                    if (baseline[name] === null) baseline[name] = current;
                    sampled = true;

                    const seconds = currentSeconds[name];
                    const averageBase = averageBaseline[name];
                    if (seconds !== null && (!averageBase
                        || current < averageBase.tokens || seconds < averageBase.seconds)) {
                        averageBaseline[name] = { tokens: current, seconds };
                    }
                }
                if (counterRolled) rate = { at: 0, slots: {} };
            }

            let context = null;
            let slotsInfo = null;
            let slotsProcessing = null;
            if (slotsNormalized) {
                context = slotsNormalized.busiest || null;
                slotsProcessing = finiteNonNegativeOrNull(slotsNormalized.processing);
                const busy = finiteNonNegativeOrNull(slotsNormalized.busySlots);
                const total = finiteNonNegativeOrNull(slotsNormalized.totalSlots);
                if (busy !== null && total !== null) slotsInfo = { busy, total };
            }

            // Slot-derived live speeds require both samples to share a stable
            // slot/task identity; otherwise fall back to the metrics gauges.
            let livePromptSpeed;
            let liveGenSpeed;
            const processingBest = processing !== null ? processing : slotsProcessing;
            if (slotsNormalized && rate.at > 0) {
                const elapsed = (now - rate.at) / 1000;
                if (elapsed >= 1 && elapsed <= 30) {
                    let promptDelta = 0;
                    let genDelta = 0;
                    const allProcessingSampled = slotsNormalized.samples.length === slotsNormalized.processing;
                    let promptComparable = allProcessingSampled && slotsNormalized.samples.length > 0;
                    let genComparable = promptComparable;
                    for (const sample of slotsNormalized.samples) {
                        const previous = rate.slots[sample.key];
                        if (!previous) {
                            promptComparable = false;
                            genComparable = false;
                            continue;
                        }
                        if (sample.promptTokens !== null && previous.promptTokens !== null
                            && sample.promptTokens >= previous.promptTokens) {
                            promptDelta += sample.promptTokens - previous.promptTokens;
                        } else promptComparable = false;
                        if (sample.genTokens !== null && previous.genTokens !== null
                            && sample.genTokens >= previous.genTokens) {
                            genDelta += sample.genTokens - previous.genTokens;
                        } else genComparable = false;
                    }
                    if (promptComparable) livePromptSpeed = promptDelta / elapsed;
                    else if (processingBest === 0) livePromptSpeed = 0;
                    if (genComparable) liveGenSpeed = genDelta / elapsed;
                    else if (processingBest === 0) liveGenSpeed = 0;
                }
            }
            if (slotsNormalized) {
                rate = {
                    at: now,
                    slots: Object.fromEntries(slotsNormalized.samples.map(sample => [sample.key, sample])),
                };
            }

            // Session counters come from /metrics only: when that source is
            // unavailable they are marked unavailable, never carried forward.
            const sessionPrompt = metricsOk ? sessionValue(
                metricsValues && finiteNonNegativeOrNull(metricsValues["llamacpp:prompt_tokens_total"]),
                baseline.prompt,
            ) : null;
            const sessionGen = metricsOk ? sessionValue(
                metricsValues && finiteNonNegativeOrNull(metricsValues["llamacpp:tokens_predicted_total"]),
                baseline.gen,
            ) : null;
            const sessionTotal = sessionPrompt !== null && sessionGen !== null
                ? sessionPrompt + sessionGen
                : null;
            const averagePromptSpeed = averageValue(
                currentCounters.prompt, currentSeconds.prompt, averageBaseline.prompt,
            );
            const averageGenSpeed = averageValue(
                currentCounters.gen, currentSeconds.gen, averageBaseline.gen,
            );

            const percent = context ? context.percent : null;
            const contextLevel = percent === null
                ? "normal"
                : percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal";

            const snapshot = {
                targetKey,
                seq,
                sources: {
                    metrics: metricsOk ? "ok" : "unavailable",
                    slots: slotsOk ? "ok" : "unavailable",
                },
                session: { prompt: sessionPrompt, generated: sessionGen, total: sessionTotal },
                context,
                requests: { processing, queued: deferred, processingBest },
                slots: slotsInfo,
                speed: {
                    prompt: currentSeconds.prompt !== null
                        ? averagePromptSpeed
                        : livePromptSpeed !== undefined ? livePromptSpeed : promptSpeedGauge,
                    generated: currentSeconds.gen !== null
                        ? averageGenSpeed
                        : liveGenSpeed !== undefined ? liveGenSpeed : genSpeedGauge,
                },
                contextLevel,
                baselinePending: !sampled,
            };
            return emit(snapshot);
        }

        function applyPollResult(input) {
            if (!targetKey) return null;
            lastInput = input;
            return rebuild();
        }

        // The one and only reset operation. With valid raw counters it
        // re-renders both views as zero immediately; otherwise the reset
        // stays pending until the next valid sample establishes the baseline.
        function resetBaseline() {
            if (!sampled) {
                baseline = { prompt: null, gen: null };
                return false;
            }
            const metricsValues = lastInput && lastInput.metricsOk && lastInput.metricsValues
                ? lastInput.metricsValues
                : null;
            const current = {
                prompt: metricsValues
                    ? finiteNonNegativeOrNull(metricsValues["llamacpp:prompt_tokens_total"])
                    : null,
                gen: metricsValues
                    ? finiteNonNegativeOrNull(metricsValues["llamacpp:tokens_predicted_total"])
                    : null,
            };
            const seconds = {
                prompt: metricsValues
                    ? finiteNonNegativeOrNull(metricsValues["llamacpp:prompt_seconds_total"])
                    : null,
                gen: metricsValues
                    ? finiteNonNegativeOrNull(metricsValues["llamacpp:tokens_predicted_seconds_total"])
                    : null,
            };
            // Reset only what the current payload can prove. Missing fields
            // stay pending so their next valid sample starts at zero instead
            // of including tokens from before the reset.
            baseline = { prompt: current.prompt, gen: current.gen };
            averageBaseline = {
                prompt: current.prompt !== null && seconds.prompt !== null
                    ? { tokens: current.prompt, seconds: seconds.prompt } : null,
                gen: current.gen !== null && seconds.gen !== null
                    ? { tokens: current.gen, seconds: seconds.gen } : null,
            };
            raw = { prompt: current.prompt, gen: current.gen };
            if (lastInput) rebuild();
            return true;
        }

        return {
            getTargetKey,
            getSnapshot,
            setTarget,
            applyPollResult,
            resetBaseline,
        };
    }

    // ════════════════════════════════════════════════════════════════════
    // Hidden-card preference store (view-only; telemetry is unaffected)
    // ════════════════════════════════════════════════════════════════════

    const HIDDEN_STORAGE_KEY = "llama_gui_monitor_hidden_cards";
    const HIDDEN_MAX_ENTRIES = 100;
    const HIDDEN_MAX_KEY_LENGTH = 256;
    const HIDDEN_MAX_LABEL_LENGTH = 120;

    const ORDER_STORAGE_KEY = "llama_gui_monitor_card_order";
    const ORDER_MAX_ENTRIES = 100;
    const ORDER_MAX_KEY_LENGTH = 256;
    // Cards reorder within their own container flow only (metrics grid, GPU
    // grid, state cards, setup cards). TODO: upgrade path is a single
    // flattened grid if cross-container moves are ever wanted.
    const ORDER_CONTAINER_SELECTOR = ".monitor-drag-container";
    // Chromium suppresses clicks and text selection under a draggable
    // ancestor, so the dedicated grip is the only draggable element.
    const ORDER_DRAG_HANDLE_SELECTOR = ".monitor-drag-handle";

    function isSessionOnlyKey(key) {
        // Index-fallback GPU identities are not stable across boots, so their
        // hides last for the session only.
        return typeof key === "string" && key.startsWith("gpu:") && key.includes(":index:");
    }

    function normalizeHiddenEntries(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        const entries = [];
        for (const entry of value) {
            if (entries.length >= HIDDEN_MAX_ENTRIES) break;
            if (!entry || typeof entry !== "object") continue;
            const key = typeof entry.key === "string" ? entry.key : "";
            const label = typeof entry.label === "string" ? entry.label : "";
            if (!key || key.length > HIDDEN_MAX_KEY_LENGTH || seen.has(key)) continue;
            seen.add(key);
            entries.push({ key, label: label.slice(0, HIDDEN_MAX_LABEL_LENGTH) });
        }
        return entries;
    }

    function normalizeOrderEntries(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        const order = [];
        for (const key of value) {
            if (order.length >= ORDER_MAX_ENTRIES) break;
            if (typeof key !== "string" || !key || key.length > ORDER_MAX_KEY_LENGTH) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            order.push(key);
        }
        return order;
    }

    // ════════════════════════════════════════════════════════════════════
    // Module state
    // ════════════════════════════════════════════════════════════════════

    const POLL_INTERVAL_MS = 2000;
    const TERMINAL_MAX_LINES = 5000;
    const TERMINAL_TRIM = 1000;

    let deps = {};
    let panelVisible = false;
    let documentVisible = true;
    let pollTimer = null;
    let pollController = null;
    let pollGeneration = 0;
    let lastSample = null;
    let lastSuccessAt = 0;
    let lastPollFailed = false;
    let everSucceeded = false;
    // key -> { label, sessionOnly }
    let hiddenCards = new Map();
    // Effective card order (keys may exist across all containers); session-only
    // index-fallback keys may ride along in memory but are never persisted.
    let cardOrder = [];
    let dragKey = null;
    let dragContainer = null;
    let dragActive = false;
    // A sample that landed mid-drag; the GPU rebuild would destroy the dragged
    // node and cancel the drag, so it is deferred until the drag ends.
    let deferredRender = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function requireDep(name) {
        const value = deps[name];
        if (typeof value !== "function") {
            throw new Error(`Monitor UI dependency missing: ${name}`);
        }
        return value;
    }

    function configure(nextDeps) {
        deps = Object.assign({}, deps, nextDeps || {});
    }

    // ════════════════════════════════════════════════════════════════════
    // Live-status badge
    // ════════════════════════════════════════════════════════════════════

    function currentStatusState() {
        if (!panelVisible || !documentVisible) return "paused";
        if (!everSucceeded) return "unavailable";
        if (pollController) return "refreshing";
        if (lastPollFailed) return "stale";
        return "live";
    }

    function renderLiveBadge() {
        const badge = byId("monitor-live-badge");
        const updated = byId("monitor-last-updated");
        if (updated) updated.textContent = formatClock(lastSuccessAt || null);
        if (!badge) return;
        const state = currentStatusState();
        const labels = {
            live: "Live \u00b7 ~2 s",
            refreshing: "Refreshing\u2026",
            stale: "Stale \u00b7 retrying",
            unavailable: "Unavailable",
            paused: "Paused",
        };
        badge.textContent = labels[state];
        badge.classList.toggle("badge-green", state === "live");
        badge.classList.toggle("badge-neutral", state === "refreshing" || state === "paused");
        badge.classList.toggle("badge-yellow", state === "stale");
        badge.classList.toggle("badge-dim", state === "unavailable");
    }

    // ════════════════════════════════════════════════════════════════════
    // System/GPU polling
    // ════════════════════════════════════════════════════════════════════

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
        const interval = Number(deps.pollIntervalMs);
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
            renderSample(data);
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
            applyHiddenCardsToDom();
            applyCardOrderToDom();
            updateProcessHeader();
            scrollTerminalToBottom();
        }
        reevaluatePolling();
    }

    function setDocumentVisibility(visible) {
        documentVisible = Boolean(visible);
        reevaluatePolling();
    }

    // ════════════════════════════════════════════════════════════════════
    // Rendering: DOM construction helpers
    // ════════════════════════════════════════════════════════════════════

    function makeEl(tagName, className, text) {
        const el = document.createElement(tagName);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function setText(el, text) {
        const value = text === null || text === undefined ? "" : String(text);
        // Writing only on change keeps a value the user is selecting intact:
        // replacing the text node collapses their selection on every poll.
        if (el && el.textContent !== value) el.textContent = value;
    }

    function makeProgressBar(label, percent) {
        const bar = makeEl("div", "progress-bar");
        bar.setAttribute("role", "meter");
        bar.setAttribute("aria-label", label);
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.appendChild(makeEl("div", "progress-fill"));
        updateProgressBar(bar, percent, label);
        return bar;
    }

    function updateProgressBar(bar, percent, label) {
        if (!bar) return;
        if (label !== undefined) bar.setAttribute("aria-label", label);
        const clamped = clampPercent(percent);
        const fill = bar.querySelector(".progress-fill");
        if (fill) {
            const width = clamped === null ? "0%" : `${clamped}%`;
            if (fill.style.width !== width) fill.style.width = width;
        }
        // Unavailable meters keep their node (so focus and selection survive)
        // but render as an empty, hidden track rather than a fake zero.
        bar.classList.toggle("hidden", clamped === null);
        if (clamped === null) {
            bar.removeAttribute("aria-valuenow");
            bar.setAttribute("aria-valuetext", "Not available");
        } else {
            const now = String(Math.round(clamped * 10) / 10);
            if (bar.getAttribute("aria-valuenow") !== now) bar.setAttribute("aria-valuenow", now);
            bar.removeAttribute("aria-valuetext");
        }
    }

    function makeMetricRow(labelText, metricName) {
        const row = makeEl("div", "monitor-metric-row");
        if (metricName) row.dataset.metric = metricName;
        row.appendChild(makeEl("span", "monitor-metric-label", labelText));
        row.appendChild(makeEl("span", "monitor-metric-reading", ""));
        return row;
    }

    function metricRow(card, metricName) {
        return card && card.querySelector
            ? card.querySelector(`.monitor-metric-row[data-metric="${metricName}"]`)
            : null;
    }

    function updateMetricRow(row, readingText, unavailable) {
        if (!row) return;
        const reading = row.querySelector(".monitor-metric-reading");
        if (!reading) return;
        setText(reading, unavailable ? "Not available" : readingText);
        reading.classList.toggle("monitor-not-available", Boolean(unavailable));
    }

    // Fixed probe diagnostics from the backend, shown only when a vendor probe
    // failed or found nothing. Unknown reason values render verbatim so a
    // newer backend stays legible instead of vanishing.
    const PROBE_REASON_LABELS = {
        not_found: "Tool not found",
        timeout: "Probe timed out",
        exit_code: "Non-zero exit",
        parse_error: "Unparsable output",
        no_devices: "No usable devices",
        launch_failed: "Could not launch tool",
    };

    function appendProbeDetailRows(parent, details) {
        if (!details || typeof details !== "object") return;
        const reason = details.reason;
        if (typeof reason !== "string" || !reason) return;
        const wrap = makeEl("div", "monitor-probe-details");
        wrap.appendChild(makeMetricRow("Reason", "probe-reason"));
        updateMetricRow(metricRow(wrap, "probe-reason"), PROBE_REASON_LABELS[reason] || reason, false);
        if (typeof details.executable === "string" && details.executable) {
            const row = makeMetricRow("Tool", "probe-tool");
            updateMetricRow(row, details.executable, false);
            wrap.appendChild(row);
        }
        if (typeof details.exit_code === "number") {
            const row = makeMetricRow("Exit code", "probe-exit-code");
            updateMetricRow(row, String(details.exit_code), false);
            wrap.appendChild(row);
        }
        if (typeof details.stderr === "string" && details.stderr) {
            const row = makeMetricRow("Stderr", "probe-stderr");
            updateMetricRow(row, details.stderr, false);
            wrap.appendChild(row);
        }
        parent.appendChild(wrap);
    }

    function makeHideButton(key, label) {
        const button = makeEl("button", "btn btn-sm btn-ghost monitor-hide-btn", "Hide");
        button.type = "button";
        button.setAttribute("aria-label", `Hide ${label} monitor`);
        button.title = `Hide ${label}`;
        button.addEventListener("click", () => {
            // Resolve from the card at click time: in-place updates rewrite a
            // card's label (a GPU index or name) long after construction.
            const card = typeof button.closest === "function"
                ? button.closest("[data-monitor-key]")
                : null;
            hideCard(key, (card && card.dataset.monitorLabel) || label || key);
        });
        return button;
    }

    function makeDragHandle(label) {
        const button = makeEl("button", "btn btn-sm btn-ghost monitor-drag-handle", "⠿");
        button.type = "button";
        button.draggable = true;
        button.title = "Drag to reorder; use arrow keys to move";
        button.setAttribute("aria-label", `Move ${label} monitor; use arrow keys`);
        return button;
    }

    function cardShell(key, label, kickerText, titleText, iconClass, iconSvg) {
        const card = makeEl("div", "card");
        card.dataset.monitorKey = key;
        card.dataset.monitorLabel = label;

        const header = makeEl("div", "card-header");
        const heading = makeEl("div");
        heading.appendChild(makeEl("div", "card-kicker", kickerText));
        heading.appendChild(makeEl("div", "card-title", titleText));
        header.appendChild(heading);

        const tools = makeEl("div", "monitor-card-tools");
        tools.appendChild(makeDragHandle(label));
        tools.appendChild(makeHideButton(key, label));
        if (iconClass && iconSvg) {
            const iconWrap = makeEl("div", `card-icon ${iconClass}`);
            const icon = makeEl("span", "icon icon-lg");
            icon.innerHTML = `<svg viewBox="0 0 24 24">${iconSvg}</svg>`;
            iconWrap.appendChild(icon);
            tools.appendChild(iconWrap);
        }
        header.appendChild(tools);
        card.appendChild(header);
        return card;
    }

    const GPU_ICON_SVG = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>';
    const PROVIDER_LABELS = { nvidia: "NVIDIA", amd: "AMD" };
    const GPU_MONITORING_GUIDE_URL = "https://github.com/thomas9120/LLama-GUI/blob/main/docs/gpu-monitoring.md";

    function providerLabel(provider) {
        return PROVIDER_LABELS[String(provider || "").toLowerCase()] || String(provider || "GPU");
    }

    // ════════════════════════════════════════════════════════════════════
    // Rendering: system cards (static markup, values updated in place)
    // ════════════════════════════════════════════════════════════════════

    function setMetricCard(prefix, available, percent, subText) {
        const valueEl = byId(`monitor-${prefix}-value`);
        const subEl = byId(`monitor-${prefix}-sub`);
        const barHolder = byId(`monitor-${prefix}-bar`);
        if (valueEl) {
            if (available && clampPercent(percent) !== null) {
                if (valueEl.childElementCount !== 2) {
                    valueEl.replaceChildren(
                        makeEl("span", ""),
                        makeEl("span", "monitor-metric-unit", "%"),
                    );
                }
                setText(valueEl.children[0], formatPercentValue(percent, 1));
            } else {
                setText(valueEl, available ? "--" : "Not available");
            }
        }
        setText(subEl, available ? (subText || "") : "Collector unavailable");
        if (barHolder) {
            let bar = barHolder.querySelector(".progress-bar");
            if (!bar) {
                bar = makeProgressBar(`${prefix} usage`, null);
                barHolder.replaceChildren(bar);
            }
            updateProgressBar(bar, available ? percent : null, `${prefix} usage`);
        }
    }

    function renderSystemMetrics(system) {
        const data = system || {};
        const cpu = data.cpu || {};
        const memory = data.memory || {};
        const disk = data.disk || {};

        const interval = Number(lastSample && lastSample.interval_seconds);
        const intervalText = Number.isFinite(interval) && interval > 0
            ? ` \u00b7 ${interval.toFixed(1)} s sample`
            : "";

        setMetricCard("cpu", cpu.available === true, cpu.percent,
            cpu.available === true && cpu.percent !== null && cpu.percent !== undefined
                ? `CPU busy${intervalText}`
                : cpu.available === true ? `Waiting for first sample${intervalText}` : "");

        const memUsed = Number(memory.used_bytes);
        const memTotal = Number(memory.total_bytes);
        setMetricCard("memory", memory.available === true, memory.percent,
            memory.available === true && Number.isFinite(memUsed) && Number.isFinite(memTotal)
                ? `${formatBytes(memUsed)} used of ${formatBytes(memTotal)}`
                : memory.available === true ? "Waiting for first sample" : "");

        const diskUsed = Number(disk.used_bytes);
        const diskTotal = Number(disk.total_bytes);
        const diskLabel = String(disk.path_label || "").trim();
        setMetricCard("disk", disk.available === true, disk.percent,
            disk.available === true && Number.isFinite(diskUsed) && Number.isFinite(diskTotal)
                ? `${formatBytes(diskUsed)} used of ${formatBytes(diskTotal)}${diskLabel ? ` \u00b7 ${diskLabel}` : ""}`
                : disk.available === true ? "Waiting for first sample" : "");

        const ioGrid = byId("monitor-disk-io");
        if (ioGrid) {
            const readRate = disk.read_bytes_per_second;
            const writeRate = disk.write_bytes_per_second;
            const supported = readRate !== null && readRate !== undefined
                || writeRate !== null && writeRate !== undefined;
            ioGrid.classList.toggle("hidden", !supported);
            const readEl = byId("monitor-disk-read");
            const writeEl = byId("monitor-disk-write");
            if (readEl) readEl.textContent = formatRate(readRate);
            if (writeEl) writeEl.textContent = formatRate(writeRate);
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Rendering: GPU + setup + state cards (rebuilt per sample)
    // ════════════════════════════════════════════════════════════════════

    function gpuCardKey(gpu) {
        return `gpu:${String(gpu && gpu.id || "")}`;
    }

    function gpuCardName(gpu) {
        return String(gpu && gpu.name || "").trim() || `${providerLabel(gpu && gpu.provider)} GPU`;
    }

    function gpuCardIndex(gpu) {
        return Number.isFinite(Number(gpu && gpu.index)) ? Number(gpu.index) : null;
    }

    function makeGpuCard(gpu) {
        const card = cardShell(gpuCardKey(gpu), "", "", "", "icon-green", GPU_ICON_SVG);
        const utilBlock = makeEl("div", "monitor-metric-block");
        utilBlock.appendChild(makeMetricRow("Utilization", "utilization"));
        utilBlock.appendChild(makeProgressBar("", null));
        card.appendChild(utilBlock);

        const memBlock = makeEl("div", "monitor-metric-block");
        memBlock.appendChild(makeMetricRow("VRAM", "vram"));
        memBlock.appendChild(makeProgressBar("", null));
        card.appendChild(memBlock);

        const meta = makeEl("div", "monitor-gpu-meta");
        meta.appendChild(makeMetricRow("Temperature", "temperature"));
        meta.appendChild(makeMetricRow("GPU ID", "gpu-id"));
        card.appendChild(meta);

        updateGpuCard(card, gpu);
        return card;
    }

    function updateGpuCard(card, gpu) {
        const id = String(gpu && gpu.id || "");
        const index = gpuCardIndex(gpu);
        const name = gpuCardName(gpu);
        const provider = providerLabel(gpu && gpu.provider);
        const label = index === null ? name : `GPU ${index} \u00b7 ${name}`;
        const kicker = index === null ? provider : `GPU ${index} \u00b7 ${provider}`;

        card.dataset.monitorLabel = label;
        setText(card.querySelector(".card-kicker"), kicker);
        setText(card.querySelector(".card-title"), name);
        const hideBtn = card.querySelector(".monitor-hide-btn");
        if (hideBtn) {
            hideBtn.setAttribute("aria-label", `Hide ${label} monitor`);
            hideBtn.title = `Hide ${label}`;
        }

        const util = gpu && gpu.utilization_percent;
        const hasUtil = util !== null && util !== undefined;
        updateMetricRow(metricRow(card, "utilization"),
            hasUtil ? `${formatPercentValue(util)}%` : "", !hasUtil);

        const memUsed = gpu && gpu.memory_used_bytes;
        const memTotal = gpu && gpu.memory_total_bytes;
        const hasMemory = memUsed !== null && memUsed !== undefined
            && memTotal !== null && memTotal !== undefined && Number(memTotal) > 0;
        updateMetricRow(metricRow(card, "vram"),
            hasMemory ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)}` : "", !hasMemory);

        const temp = gpu && gpu.temperature_c;
        const hasTemp = temp !== null && temp !== undefined;
        updateMetricRow(metricRow(card, "temperature"),
            hasTemp ? `${Math.round(Number(temp))} \u00b0C` : "", !hasTemp);

        updateMetricRow(metricRow(card, "gpu-id"), shortGpuId(id), !id);
        const idReading = metricRow(card, "gpu-id");
        if (idReading) {
            const reading = idReading.querySelector(".monitor-metric-reading");
            if (reading) reading.title = id;
        }

        const bars = card.querySelectorAll(".progress-bar");
        updateProgressBar(bars[0], hasUtil ? util : null, `${label} utilization`);
        updateProgressBar(bars[1],
            hasMemory ? Number(memUsed) / Number(memTotal) * 100 : null,
            `${label} memory`);
    }

    function makeStateCard(entry) {
        const provider = String(entry && entry.provider || "");
        const unsupported = entry && entry.state === "unsupported";
        const key = provider ? `state:${provider}` : "state:generic";
        const title = provider
            ? unsupported
                ? `${providerLabel(provider)} SMI monitoring unavailable`
                : `${providerLabel(provider)} telemetry unavailable`
            : "No supported GPU telemetry detected";
        const card = makeEl("div", "card");
        card.dataset.monitorKey = key;
        card.dataset.monitorLabel = title;

        const tools = makeEl("div", "monitor-card-tools");
        tools.style.justifyContent = "flex-end";
        tools.appendChild(makeDragHandle(title));
        tools.appendChild(makeHideButton(key, title));
        card.appendChild(tools);

        const empty = makeEl("div", "empty-state");
        empty.appendChild(makeEl("div", "empty-state-title", title));
        const message = String(entry && entry.message || "").trim()
            || (provider
                ? `System metrics keep updating. Use the ${providerLabel(provider)} setup card and Recheck when ready.`
                : "No supported vendor tool or GPU backend identified NVIDIA or AMD hardware. System metrics keep updating; Recheck after changing the installed backend or driver environment.");
        empty.appendChild(makeEl("p", "", message));
        appendProbeDetailRows(empty, entry && entry.details);
        const guide = makeEl("a", "btn btn-sm monitor-setup-guide", "GPU monitoring setup guide");
        guide.href = GPU_MONITORING_GUIDE_URL;
        guide.target = "_blank";
        guide.rel = "noopener noreferrer";
        empty.appendChild(guide);
        card.appendChild(empty);
        return card;
    }

    function makeSetupCard(entry) {
        const provider = String(entry && entry.provider || "");
        const key = `setup:${provider}`;
        const label = `${providerLabel(provider)} monitoring setup`;
        const card = cardShell(
            key,
            label,
            "GPU Monitoring Setup",
            providerLabel(provider),
            provider === "amd" ? "icon-magenta" : "icon-blue",
            GPU_ICON_SVG,
        );

        if (entry.state === "error") {
            card.appendChild(makeEl("p", "help-text", String(entry.message || "The vendor probe failed. Check the vendor runtime installation, then Recheck.")));
        } else if (provider === "nvidia") {
            card.appendChild(makeEl("p", "help-text", String(entry.message || "nvidia-smi was not found. It ships with the NVIDIA driver environment \u2014 Llama GUI does not install or upgrade drivers. Install or update the driver using the official documentation, then Recheck.")));
        } else {
            if (entry.package_manager) {
                const detected = makeMetricRow("Detected", "package-manager");
                updateMetricRow(detected, `Linux \u00b7 ${entry.package_manager}`, false);
                card.appendChild(detected);
            }
            card.appendChild(makeEl("p", "help-text", String(entry.message || "amd-smi was not found. The AMD repository and a compatible amdgpu driver must already be configured; then install AMD SMI once with the command shown. Llama GUI shows the command but never runs it.")));
            if (entry.command) {
                const row = makeEl("div", "monitor-command-row");
                const command = makeEl("code", "monitor-command", entry.command);
                row.appendChild(command);
                const copyBtn = makeEl("button", "btn btn-sm", "Copy");
                copyBtn.type = "button";
                copyBtn.title = "Copy install command";
                copyBtn.addEventListener("click", () => {
                    const copyText = deps.copyText;
                    const notify = (message, type) => {
                        if (typeof deps.showToast === "function") deps.showToast(message, type);
                    };
                    if (typeof copyText !== "function") {
                        notify("Could not copy command", "error");
                        return;
                    }
                    // copyText resolves to a success flag; only claim a copy
                    // that actually reached the clipboard.
                    Promise.resolve(copyText(entry.command)).then(
                        (copied) => notify(
                            copied ? "Command copied" : "Could not copy command",
                            copied ? "info" : "error",
                        ),
                        (error) => {
                            console.warn("Could not copy install command", error);
                            notify("Could not copy command", "error");
                        },
                    );
                });
                row.appendChild(copyBtn);
                card.appendChild(row);
            }
        }

        if (entry.docs_url) {
            const actions = makeEl("div", "form-row");
            actions.style.marginBottom = "0";
            const link = makeEl("a", "btn", provider === "nvidia"
                ? "Open NVIDIA driver documentation"
                : "Open AMD SMI installation docs");
            link.href = entry.docs_url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            actions.appendChild(link);
            card.appendChild(actions);
        }
        appendProbeDetailRows(card, entry.details);
        return card;
    }

    function stateCardKey(entry) {
        const provider = String(entry && entry.provider || "");
        return provider ? `state:${provider}` : "state:generic";
    }

    function setupCardKey(entry) {
        return `setup:${String(entry && entry.provider || "")}`;
    }

    // State and setup cards are pure text plus their own controls, so a card
    // can be reused untouched whenever the backend repeats the same advice.
    function stateCardSignature(entry) {
        return JSON.stringify([
            stateCardKey(entry),
            String(entry && entry.state || ""),
            String(entry && entry.message || ""),
            (entry && entry.details) || null,
        ]);
    }

    function setupCardSignature(entry) {
        return JSON.stringify([
            String(entry && entry.state || ""),
            String(entry && entry.package_manager || ""),
            String(entry && entry.command || ""),
            String(entry && entry.docs_url || ""),
            String(entry && entry.message || ""),
            (entry && entry.details) || null,
        ]);
    }

    // Rebuilt cards are reconciled by key so a periodic refresh updates values
    // in place. A wholesale replaceChildren() would discard the user's focus
    // (the Hide/Copy buttons and setup links) and any text selection every
    // two seconds, and would restart every progress-bar animation.
    // `signatureOf` returning undefined means "always reusable"; when it
    // returns a string, a card whose signature changed is rebuilt so its
    // structure and listeners match the new payload.
    function reconcileCards(container, entries, handlers) {
        if (!container) return;
        const { keyOf, signatureOf, create, update } = handlers;
        const existing = new Map();
        for (const child of Array.from(container.children)) {
            const key = child && child.dataset ? child.dataset.monitorKey : null;
            if (key && !existing.has(key)) existing.set(key, child);
        }
        const wanted = new Set();
        const desired = [];
        for (const entry of entries) {
            const key = keyOf(entry);
            wanted.add(key);
            const signature = signatureOf ? signatureOf(entry) : undefined;
            let card = existing.get(key);
            if (card && signature !== undefined && card.dataset.monitorSig !== signature) {
                card.remove();
                card = null;
            }
            if (!card) {
                card = create(entry);
                card.dataset.monitorKey = key;
                if (signature !== undefined) card.dataset.monitorSig = signature;
                container.appendChild(card);
            } else if (update) {
                update(card, entry);
            }
            desired.push(card);
        }
        for (const [key, card] of existing) {
            if (!wanted.has(key)) card.remove();
        }
        // Reorder only where it differs. Re-appending a card removes and
        // re-inserts it, which drops focus and collapses a selection even
        // though the node itself survives.
        let inOrder = container.children.length === desired.length;
        for (let i = 0; inOrder && i < desired.length; i += 1) {
            if (container.children[i] !== desired[i]) inOrder = false;
        }
        if (!inOrder) {
            for (const card of desired) container.appendChild(card);
        }
    }

    function renderGpuArea(sample) {
        const gpuGrid = byId("monitor-gpu-grid");
        const stateWrap = byId("monitor-gpu-states");
        const setupSection = byId("monitor-gpu-setup");
        const setupCards = byId("monitor-setup-cards");
        if (!gpuGrid || !stateWrap || !setupSection || !setupCards) return;

        const gpus = Array.isArray(sample && sample.gpus) ? sample.gpus : [];
        const setupEntries = Array.isArray(sample && sample.gpu_setup) ? sample.gpu_setup : [];

        reconcileCards(gpuGrid, gpus, {
            keyOf: gpuCardKey,
            create: makeGpuCard,
            update: updateGpuCard,
        });
        gpuGrid.classList.toggle("hidden", gpus.length === 0);

        // State cards: one per provider whose probe is not working, or the
        // backend's platform-specific generic state. Keep a generic fallback
        // for older backends that do not send that state yet.
        const stateEntries = setupEntries.slice();
        if (gpus.length === 0 && setupEntries.length === 0) stateEntries.push(null);
        reconcileCards(stateWrap, stateEntries, {
            keyOf: stateCardKey,
            signatureOf: stateCardSignature,
            create: makeStateCard,
        });

        // Setup cards exist only for setup_required/error states.
        const actionable = setupEntries.filter(entry =>
            entry.state === "setup_required" || entry.state === "error");
        reconcileCards(setupCards, actionable, {
            keyOf: setupCardKey,
            signatureOf: setupCardSignature,
            create: makeSetupCard,
        });
        setupSection.classList.toggle("hidden", actionable.length === 0);

        applyHiddenCardsToDom();
        applyCardOrderToDom();
    }

    function renderSample(sample) {
        if (!sample) return;
        if (dragActive) {
            // A periodic rebuild would destroy the node being dragged and
            // cancel the drag; keep it fresh and render after the drag ends.
            deferredRender = sample;
            return;
        }
        renderSystemMetrics(sample.system);
        renderGpuArea(sample);
    }

    // ════════════════════════════════════════════════════════════════════
    // Rendering: process output card header
    // ════════════════════════════════════════════════════════════════════

    function updateProcessHeader() {
        const toolBadge = byId("monitor-process-tool");
        const stateBadge = byId("monitor-process-state");
        const externalNote = byId("monitor-external-note");
        const noProcessNote = byId("monitor-no-process-note");
        const terminal = byId("output-terminal");

        let lifecycle = null;
        let status = null;
        if (typeof deps.getLifecycleSnapshot === "function") lifecycle = deps.getLifecycleSnapshot();
        if (typeof deps.getLatestStatus === "function") status = deps.getLatestStatus();

        const runtime = lifecycle && lifecycle.activeRuntime;
        const phase = lifecycle && lifecycle.phase;
        const phaseLabels = { starting: "Starting", loading: "Loading", stopping: "Stopping" };
        const transitional = Object.prototype.hasOwnProperty.call(phaseLabels, phase);
        const running = Boolean(runtime) || Boolean(transitional);
        const tool = runtime && runtime.tool ? runtime.tool : "";
        const externalTarget = status && status.external_chat_target;
        const externalConnected = Boolean(externalTarget && externalTarget.connected);

        if (toolBadge) {
            if (running && tool) {
                toolBadge.textContent = tool;
                toolBadge.classList.remove("hidden");
                toolBadge.classList.remove("badge-accent");
                toolBadge.classList.add("badge-neutral");
            } else if (!running && externalConnected) {
                toolBadge.textContent = "external server";
                toolBadge.classList.remove("hidden");
                toolBadge.classList.remove("badge-neutral");
                toolBadge.classList.add("badge-accent");
            } else {
                toolBadge.classList.add("hidden");
            }
        }
        if (stateBadge) {
            if (running) {
                stateBadge.textContent = phaseLabels[phase] || "Running";
                stateBadge.classList.remove("hidden", "badge-dim", "badge-green", "badge-yellow");
                stateBadge.classList.add(transitional ? "badge-yellow" : "badge-green");
            } else {
                stateBadge.textContent = "No process running";
                stateBadge.classList.remove("hidden", "badge-green", "badge-yellow");
                stateBadge.classList.add("badge-dim");
            }
        }
        const externalOnly = externalConnected && !running;
        if (externalNote) externalNote.classList.toggle("hidden", !externalOnly);
        if (noProcessNote) noProcessNote.classList.toggle("hidden", running || externalOnly);
        if (terminal) terminal.classList.toggle("hidden", externalOnly);
        // #input-row visibility belongs to app.js, which owns process
        // lifecycle and sets it from the active runtime before calling
        // updateProcessHeader(); touching it here would fight that.
    }

    // ════════════════════════════════════════════════════════════════════
    // Process output terminal (rendering only; cursor stays in app.js)
    // ════════════════════════════════════════════════════════════════════

    function terminalEl() {
        return byId("output-terminal");
    }

    function scrollTerminalToBottom() {
        const terminal = terminalEl();
        if (terminal) terminal.scrollTop = terminal.scrollHeight;
    }

    function trimTerminal() {
        const terminal = terminalEl();
        if (!terminal) return;
        if (terminal.childElementCount <= TERMINAL_MAX_LINES) return;
        const range = document.createRange ? document.createRange() : null;
        if (range) {
            range.setStartBefore(terminal.firstElementChild);
            range.setEndAfter(terminal.children[TERMINAL_TRIM - 1]);
            range.deleteContents();
        } else {
            for (let i = 0; i < TERMINAL_TRIM; i += 1) {
                if (terminal.firstElementChild) terminal.firstElementChild.remove();
            }
        }
    }

    function appendOutputLine(text) {
        const terminal = terminalEl();
        if (!terminal) return;
        const line = document.createElement("div");
        line.textContent = text;
        terminal.appendChild(line);
        trimTerminal();
        scrollTerminalToBottom();
    }

    function clearTerminal() {
        const terminal = terminalEl();
        if (terminal) terminal.replaceChildren();
        // Advance the cursor epoch without discarding the cursor; otherwise
        // the next cursorless request would replay the whole backend backlog.
        if (typeof deps.invalidateCursor === "function") deps.invalidateCursor();
    }

    // ════════════════════════════════════════════════════════════════════
    // Inference card (snapshots supplied by app.js's shared poller)
    // ════════════════════════════════════════════════════════════════════

    function setInferenceText(id, text) {
        const el = byId(id);
        if (el) el.textContent = text;
    }

    function renderInferenceSnapshot(snapshot) {
        const kicker = byId("monitor-inference-kicker");
        const badge = byId("monitor-inference-state-badge");
        const body = byId("monitor-inference-body");
        const empty = byId("monitor-inference-empty");
        if (!kicker || !badge || !body || !empty) return;

        if (!snapshot || !snapshot.targetKey) {
            kicker.textContent = "Llama server";
            badge.textContent = "Unavailable";
            badge.classList.remove("badge-green", "badge-neutral");
            badge.classList.add("badge-dim");
            badge.classList.remove("hidden");
            body.classList.add("hidden");
            empty.classList.remove("hidden");
            return;
        }

        const processing = snapshot.requests ? snapshot.requests.processingBest : null;
        const activityUnknown = processing === null || processing === undefined;
        const stateText = activityUnknown ? "Activity unknown" : processing > 0 ? "Generating" : "Idle";
        kicker.textContent = `Llama server \u00b7 ${stateText}`;
        if (processing !== null && processing > 0) {
            badge.textContent = `${processing} active`;
            badge.classList.remove("badge-dim", "badge-neutral");
            badge.classList.add("badge-green");
        } else if (activityUnknown) {
            badge.textContent = stateText;
            badge.classList.remove("badge-green", "badge-neutral");
            badge.classList.add("badge-dim");
        } else {
            badge.textContent = stateText;
            badge.classList.remove("badge-green", "badge-dim");
            badge.classList.add("badge-neutral");
        }
        badge.classList.remove("hidden");
        empty.classList.add("hidden");
        body.classList.remove("hidden");

        const session = snapshot.session || {};
        setInferenceText("monitor-inference-prompt",
            session.prompt === null ? "--" : `${formatTokens(session.prompt)} tokens`);
        setInferenceText("monitor-inference-generated",
            session.generated === null ? "--" : `${formatTokens(session.generated)} tokens`);
        setInferenceText("monitor-inference-total",
            session.total === null ? "--" : `${formatTokens(session.total)} tokens`);

        const context = snapshot.context;
        const contextLabel = byId("monitor-inference-context-label");
        const contextReading = byId("monitor-inference-context-reading");
        const contextBarHolder = byId("monitor-inference-context-bar");
        if (contextLabel) {
            contextLabel.textContent = context
                ? `Context \u00b7 most-filled slot (${context.isProcessing ? "active" : "idle"})`
                : "Context \u00b7 most-filled slot";
        }
        if (contextReading) {
            contextReading.textContent = context
                ? `${formatTokens(context.used)} / ${formatTokens(context.total)} \u00b7 ${formatTokens(context.remaining)} remaining`
                : "Not available";
            contextReading.classList.toggle("monitor-not-available", !context);
            contextReading.classList.toggle("monitor-metric-reading", Boolean(context));
        }
        if (contextBarHolder) {
            const bar = makeProgressBar("Most-filled slot context usage", context ? context.percent : null);
            const fill = bar.querySelector(".progress-fill");
            if (fill && context) {
                if (snapshot.contextLevel === "critical") fill.classList.add("progress-fill-critical");
                else if (snapshot.contextLevel === "warning") fill.classList.add("progress-fill-warning");
            }
            contextBarHolder.replaceChildren(bar);
        }

        const speed = snapshot.speed || {};
        setInferenceText("monitor-inference-prompt-speed",
            speed.prompt === null || speed.prompt === undefined ? "--" : `${formatSpeed(speed.prompt)} tok/s`);
        setInferenceText("monitor-inference-gen-speed",
            speed.generated === null || speed.generated === undefined ? "--" : `${formatSpeed(speed.generated)} tok/s`);

        const requests = snapshot.requests || {};
        const requestParts = [];
        if (requests.processing !== null && requests.processing !== undefined) {
            requestParts.push(`${requests.processing} active`);
        }
        if (requests.queued !== null && requests.queued !== undefined) {
            requestParts.push(`${requests.queued} queued`);
        }
        setInferenceText("monitor-inference-requests", requestParts.length ? requestParts.join(" \u00b7 ") : "--");

        setInferenceText("monitor-inference-slots", snapshot.slots
            ? `${snapshot.slots.busy} / ${snapshot.slots.total} busy`
            : "--");
    }

    // ════════════════════════════════════════════════════════════════════
    // Hidden-card behavior
    // ════════════════════════════════════════════════════════════════════

    function loadHiddenCards() {
        hiddenCards = new Map();
        try {
            const raw = localStorage.getItem(HIDDEN_STORAGE_KEY);
            if (!raw) return;
            for (const entry of normalizeHiddenEntries(JSON.parse(raw))) {
                hiddenCards.set(entry.key, { label: entry.label, sessionOnly: isSessionOnlyKey(entry.key) });
            }
        } catch (error) {
            console.debug("Could not read hidden monitor cards", error);
        }
    }

    function persistHiddenCards() {
        try {
            const entries = [];
            for (const [key, value] of hiddenCards) {
                if (value.sessionOnly) continue;
                entries.push({ key, label: value.label });
            }
            const retained = entries.slice(-HIDDEN_MAX_ENTRIES);
            localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(retained));
            if (entries.length > HIDDEN_MAX_ENTRIES) {
                const retainedKeys = new Set(retained.map(entry => entry.key));
                for (const [key, value] of hiddenCards) {
                    if (!value.sessionOnly && !retainedKeys.has(key)) hiddenCards.delete(key);
                }
            }
        } catch (error) {
            console.debug("Could not persist hidden monitor cards", error);
        }
    }

    function hiddenBarEls() {
        return {
            controls: byId("monitor-hidden-controls"),
            count: byId("monitor-hidden-count"),
            items: byId("monitor-restore-items"),
        };
    }

    function applyHiddenCardsToDom() {
        const cards = Array.from(document.querySelectorAll("[data-monitor-key]"));
        const relevant = [];
        for (const card of cards) {
            const key = card.dataset.monitorKey;
            const hidden = hiddenCards.has(key);
            card.classList.toggle("hidden", hidden);
            if (hidden) relevant.push(card);
        }

        const { controls, count, items } = hiddenBarEls();
        if (!controls || !count || !items) return;
        controls.classList.toggle("hidden", relevant.length === 0);
        if (relevant.length === 0) controls.open = false;
        count.textContent = relevant.length === 1 ? "1 card hidden" : `${relevant.length} cards hidden`;

        items.replaceChildren();
        for (const card of relevant) {
            const key = card.dataset.monitorKey;
            const label = card.dataset.monitorLabel || key;
            const row = makeEl("div", "monitor-restore-row");
            row.appendChild(makeEl("span", "", label));
            const restore = makeEl("button", "btn btn-sm btn-ghost", "Show");
            restore.type = "button";
            restore.setAttribute("aria-label", `Show ${label} monitor`);
            restore.addEventListener("click", () => restoreCard(key, card));
            row.appendChild(restore);
            items.appendChild(row);
        }
    }

    function hideCard(key, label) {
        if (!key) return;
        hiddenCards.delete(key);
        hiddenCards.set(key, { label: label || key, sessionOnly: isSessionOnlyKey(key) });
        persistHiddenCards();
        applyHiddenCardsToDom();
        // Hiding the focused card moves focus to the restore control.
        const { controls } = hiddenBarEls();
        if (controls) {
            const summary = controls.querySelector("summary");
            if (summary && typeof summary.focus === "function") summary.focus();
        }
    }

    function restoreCard(key, cardEl) {
        hiddenCards.delete(key);
        persistHiddenCards();
        applyHiddenCardsToDom();
        const card = cardEl || document.querySelector(`[data-monitor-key="${CSS.escape ? CSS.escape(key) : key}"]`);
        if (card) {
            const target = card.querySelector(".card-title") || card.querySelector(".monitor-hide-btn") || card;
            if (target && typeof target.focus === "function") {
                if (!target.hasAttribute || !target.hasAttribute("tabindex")) {
                    if (typeof target.setAttribute === "function") target.setAttribute("tabindex", "-1");
                }
                target.focus();
            }
        }
    }

    function showAllCards() {
        hiddenCards = new Map();
        persistHiddenCards();
        applyHiddenCardsToDom();
    }

    // ════════════════════════════════════════════════════════════════════
    // Card ordering (drag and drop, per container)
    // ════════════════════════════════════════════════════════════════════

    function loadCardOrder() {
        cardOrder = [];
        try {
            const raw = localStorage.getItem(ORDER_STORAGE_KEY);
            if (raw) cardOrder = normalizeOrderEntries(JSON.parse(raw));
        } catch (error) {
            console.debug("Could not read monitor card order", error);
        }
    }

    function persistCardOrder() {
        try {
            // Index-fallback GPU keys are session-only, exactly like hides.
            const retained = normalizeOrderEntries(
                cardOrder.filter(key => !isSessionOnlyKey(key))
            );
            localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(retained));
        } catch (error) {
            console.debug("Could not persist monitor card order", error);
        }
    }

    function applyCardOrderToDom() {
        if (typeof document.querySelectorAll !== "function") return;
        for (const container of document.querySelectorAll(ORDER_CONTAINER_SELECTOR)) {
            if (!container || !container.children) continue;
            const cards = Array.from(container.children).filter(
                child => child && child.dataset && child.dataset.monitorKey
            );
            if (cards.length < 2) continue;
            // Cards absent from the persisted order keep their current DOM
            // order after every known card.
            const currentIndex = new Map();
            cards.forEach((card, index) => currentIndex.set(card.dataset.monitorKey, index));
            const orderOf = (card) => {
                const known = cardOrder.indexOf(card.dataset.monitorKey);
                return known !== -1 ? known : cardOrder.length + currentIndex.get(card.dataset.monitorKey);
            };
            const sorted = cards.slice().sort((a, b) => orderOf(a) - orderOf(b));
            // Re-appending a card removes and re-inserts it, which drops focus
            // and collapses a selection even though the node survives; only
            // touch the DOM when the order is actually wrong.
            let inOrder = true;
            for (let i = 0; i < sorted.length; i += 1) {
                if (sorted[i] !== cards[i]) { inOrder = false; break; }
            }
            if (inOrder) continue;
            for (const card of sorted) container.appendChild(card);
        }
    }

    function monitorCardFromEvent(event) {
        const target = event && event.target;
        if (!target || typeof target.closest !== "function") return null;
        return target.closest("[data-monitor-key]");
    }

    function clearDropMarkers() {
        if (typeof document.querySelectorAll !== "function") return;
        for (const card of document.querySelectorAll("[data-monitor-key]")) {
            card.classList.remove("drop-before", "drop-after", "drop-horizontal");
        }
    }

    // Merge one container's new key order into the global order. Only relative
    // order within the same container matters, so the container keys simply
    // move behind the others; unknown keys stay untouched and dead keys stay
    // inert (they can resurrect a card that reappears).
    function updateCardOrder(containerKeys) {
        const other = cardOrder.filter(key => !containerKeys.includes(key));
        cardOrder = other.concat(containerKeys);
        persistCardOrder();
        applyCardOrderToDom();
    }

    function dropPlacement(container, dropCard, clientX, clientY) {
        const rect = typeof dropCard.getBoundingClientRect === "function"
            ? dropCard.getBoundingClientRect()
            : null;
        if (!rect) return { before: false, horizontal: false };
        const horizontal = Array.from(container.children).some((other) => {
            if (other === dropCard || (other.classList && other.classList.contains("hidden"))
                    || typeof other.getBoundingClientRect !== "function") return false;
            const otherRect = other.getBoundingClientRect();
            return rect.width > 0 && otherRect.width > 0
                && Math.max(rect.top, otherRect.top) < Math.min(rect.bottom, otherRect.bottom);
        });
        const point = Number(horizontal ? clientX : clientY);
        const midpoint = horizontal
            ? rect.left + rect.width / 2
            : rect.top + rect.height / 2;
        return {
            before: Number.isFinite(point) ? point < midpoint : false,
            horizontal,
        };
    }

    function reorderCard(container, draggedKey, dropCard, clientX, clientY) {
        const keys = Array.from(container.children)
            .filter(child => child && child.dataset && child.dataset.monitorKey)
            .map(child => child.dataset.monitorKey);
        const remaining = keys.filter(key => key !== draggedKey);
        if (remaining.length === keys.length) return;
        let insertAt;
        if (dropCard) {
            const index = remaining.indexOf(dropCard.dataset.monitorKey);
            if (index === -1) return;
            const { before } = dropPlacement(container, dropCard, clientX, clientY);
            insertAt = before ? index : index + 1;
        } else {
            // Dropped on empty container space: append at the end.
            insertAt = remaining.length;
        }
        remaining.splice(insertAt, 0, draggedKey);
        updateCardOrder(remaining);
    }

    function onKeyDown(container, event) {
        const target = event && event.target;
        if (!target || typeof target.closest !== "function"
                || !target.closest(ORDER_DRAG_HANDLE_SELECTOR)) return;
        const offset = event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
        if (!offset) return;
        event.preventDefault();
        const card = monitorCardFromEvent(event);
        const cards = Array.from(container.children).filter(
            child => child && child.dataset && child.dataset.monitorKey
                && !(child.classList && child.classList.contains("hidden"))
        );
        const index = cards.indexOf(card);
        const targetCard = cards[index + offset];
        if (index === -1 || !targetCard) return;
        const keys = Array.from(container.children)
            .filter(child => child && child.dataset && child.dataset.monitorKey)
            .map(child => child.dataset.monitorKey)
            .filter(key => key !== card.dataset.monitorKey);
        const targetIndex = keys.indexOf(targetCard.dataset.monitorKey);
        keys.splice(offset < 0 ? targetIndex : targetIndex + 1, 0, card.dataset.monitorKey);
        updateCardOrder(keys);
        if (typeof target.focus === "function") target.focus();
    }

    function onDragStart(container, event) {
        const target = event && event.target;
        if (!target || typeof target.closest !== "function"
                || !target.closest(ORDER_DRAG_HANDLE_SELECTOR)) return;
        const card = monitorCardFromEvent(event);
        if (!card) return;
        dragKey = card.dataset.monitorKey;
        dragContainer = container;
        dragActive = true;
        card.classList.add("dragging");
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            try {
                event.dataTransfer.setData("text/plain", dragKey);
            } catch (error) {
                console.debug("Could not set drag payload", error);
            }
        }
    }

    function onDragOver(container, event) {
        if (!dragActive || !dragKey) return;
        if (dragContainer !== container) {
            clearDropMarkers();
            return;
        }
        const card = monitorCardFromEvent(event);
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        clearDropMarkers();
        if (card && card.dataset.monitorKey !== dragKey) {
            event.preventDefault();
            const { before, horizontal } = dropPlacement(
                container, card, event.clientX, event.clientY
            );
            card.classList.toggle("drop-horizontal", horizontal);
            card.classList.add(before ? "drop-before" : "drop-after");
        } else if (!card) {
            event.preventDefault();
            // Empty container space appends at the end: mark the last card.
            const cards = Array.from(container.children).filter(
                child => child && child.dataset && child.dataset.monitorKey
            );
            const last = cards[cards.length - 1];
            if (last) last.classList.add("drop-after");
        }
    }

    function onDrop(container, event) {
        if (!dragActive || !dragKey || dragContainer !== container) return;
        event.preventDefault();
        reorderCard(
            container, dragKey, monitorCardFromEvent(event), event.clientX, event.clientY
        );
        finishDrag();
    }

    function finishDrag() {
        if (!dragActive) return;
        dragKey = null;
        dragContainer = null;
        dragActive = false;
        if (typeof document.querySelectorAll === "function") {
            for (const card of document.querySelectorAll("[data-monitor-key]")) {
                card.classList.remove("dragging", "drop-before", "drop-after", "drop-horizontal");
            }
        }
        if (deferredRender !== null) {
            const sample = deferredRender;
            deferredRender = null;
            renderSample(sample);
        }
    }

    // Test-only: drop module polling/preference state between scenarios.
    function resetForTests() {
        cancelScheduledPoll();
        abortInFlight();
        pollGeneration += 1;
        panelVisible = false;
        documentVisible = true;
        lastSample = null;
        lastSuccessAt = 0;
        lastPollFailed = false;
        everSucceeded = false;
        hiddenCards = new Map();
        cardOrder = [];
        dragKey = null;
        dragContainer = null;
        dragActive = false;
        deferredRender = null;
    }

    // ════════════════════════════════════════════════════════════════════
    // Init / wiring
    // ════════════════════════════════════════════════════════════════════

    function init() {
        loadHiddenCards();
        loadCardOrder();

        const recheckBtn = byId("btn-monitor-recheck");
        if (recheckBtn) recheckBtn.addEventListener("click", recheck);

        const resetBtn = byId("btn-reset-inference");
        if (resetBtn) {
            resetBtn.addEventListener("click", () => {
                if (typeof deps.resetStatsBaseline === "function") deps.resetStatsBaseline();
            });
        }

        const showAllBtn = byId("btn-monitor-show-all");
        if (showAllBtn) showAllBtn.addEventListener("click", showAllCards);

        // Static cards (system/inference) declare their hide buttons inline.
        const staticHideButtons = document.querySelectorAll
            ? document.querySelectorAll("[data-monitor-hide]")
            : [];
        for (const button of staticHideButtons) {
            button.addEventListener("click", () => {
                const key = button.dataset.monitorHide;
                const card = typeof button.closest === "function"
                    ? button.closest("[data-monitor-key]")
                    : null;
                const label = (card && card.dataset.monitorLabel) || key;
                hideCard(key, label);
            });
        }

        // Drag-and-drop reordering, delegated per container so per-sample card
        // rebuilds need no re-binding. Cards move within their own container
        // only (see ORDER_CONTAINER_SELECTOR).
        if (typeof document.querySelectorAll === "function") {
            for (const container of document.querySelectorAll(ORDER_CONTAINER_SELECTOR)) {
                container.addEventListener("keydown", (event) => onKeyDown(container, event));
                container.addEventListener("dragstart", (event) => onDragStart(container, event));
                container.addEventListener("dragover", (event) => onDragOver(container, event));
                container.addEventListener("drop", (event) => onDrop(container, event));
                container.addEventListener("dragend", () => finishDrag());
            }
        }

        updateProcessHeader();
        renderLiveBadge();
        applyHiddenCardsToDom();
        applyCardOrderToDom();
    }

    root.monitorUi = {
        configure,
        init,
        onTabChanged,
        setDocumentVisibility,
        recheck,
        appendOutputLine,
        clearTerminal,
        updateProcessHeader,
        renderInferenceSnapshot,
        // Shared stats helpers used by app.js's single poller:
        createInferenceStats,
        parseMetricsText,
        normalizeSlots,
        // Exported for unit tests:
        formatBytes,
        formatRate,
        formatPercentValue,
        formatTokens,
        formatClock,
        shortGpuId,
        normalizeHiddenEntries,
        isSessionOnlyKey,
        normalizeOrderEntries,
        _resetForTests: resetForTests,
    };
})();
