// Pure inference parsing and target-keyed state; app.js owns polling and UI callbacks.
(function () {
    "use strict";

    const root = window.LlamaGui = window.LlamaGui || {};

    function finiteOrNull(value) {
        if (value === null || value === undefined) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function finiteNonNegativeOrNull(value) {
        const num = finiteOrNull(value);
        return num !== null && num >= 0 ? num : null;
    }

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
            const samplePrompt = finiteNonNegativeOrNull(slot && slot.n_prompt_tokens_processed);
            const sampleGen = finiteNonNegativeOrNull(nextToken && nextToken.n_decoded);
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
        let rawSeconds = { prompt: null, gen: null };
        let lastInput = null;
        let lastSlotSample = null;
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
            rawSeconds = { prompt: null, gen: null };
            lastInput = null;
            lastSlotSample = null;
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
                speed: { prompt: null, generated: null, promptIsLive: false, generatedIsLive: false },
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
                processing = finiteNonNegativeOrNull(metricsValues["llamacpp:requests_processing"]);
                deferred = finiteNonNegativeOrNull(metricsValues["llamacpp:requests_deferred"]);

                // A cumulative counter going down without an observed target
                // change means the upstream server restarted. Rebase instead
                // of clamping a cross-restart delta to zero.
                for (const name of ["prompt", "gen"]) {
                    const current = currentCounters[name];
                    const seconds = currentSeconds[name];
                    const rolled = (current !== null && raw[name] !== null && current < raw[name])
                        || (seconds !== null && rawSeconds[name] !== null && seconds < rawSeconds[name]);
                    if (seconds !== null) rawSeconds[name] = seconds;
                    if (rolled) {
                        lastSlotSample = null;
                        baseline[name] = current;
                        averageBaseline[name] = null;
                    }
                    if (current === null) continue;
                    raw[name] = current;
                    // Restored targets baseline each counter independently so a
                    // field that appears late does not inherit another field's
                    // first sample.
                    if (baseline[name] === null) baseline[name] = current;
                    sampled = true;

                    const averageBase = averageBaseline[name];
                    if (seconds !== null && (!averageBase
                        || current < averageBase.tokens || seconds < averageBase.seconds)) {
                        averageBaseline[name] = { tokens: current, seconds };
                    }
                }
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

            const processingBest = processing !== null ? processing : slotsProcessing;

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

            // Completed-request metrics can stand still throughout a long reply.
            // Sample the same active tasks across adjacent polls for a live rate.
            const now = finiteNonNegativeOrNull(input && input.now);
            const samples = slotsNormalized?.samples || [];
            const elapsed = now !== null && lastSlotSample ? (now - lastSlotSample.now) / 1000 : 0;
            let livePromptSpeed = null;
            let liveGenSpeed = null;
            const promptRates = new Map();
            // A hidden tab or a failed poll must not dilute the live reading.
            if (elapsed > 0 && elapsed <= 15) {
                for (const sample of samples) {
                    const previous = lastSlotSample.samples.find(item => item.key === sample.key);
                    // Both samples must still be in prefill. The processed
                    // counter excludes cached tokens; context occupancy does not.
                    if (previous?.genTokens === 0 && sample.genTokens === 0
                        && previous.promptTokens > 0 && sample.promptTokens !== null
                        && sample.promptTokens >= previous.promptTokens) {
                        // Prompt counts arrive in batches, often slower than polling.
                        // Average from the first observed nonzero count and update
                        // only on progress, retaining the rate between batches.
                        const start = lastSlotSample.promptRates.get(sample.key) || {
                            tokens: previous.promptTokens, now: lastSlotSample.now, speed: null,
                        };
                        const speed = sample.promptTokens > previous.promptTokens
                            ? (sample.promptTokens - start.tokens) / ((now - start.now) / 1000)
                            : start.speed;
                        promptRates.set(sample.key, { ...start, speed });
                        if (speed !== null) livePromptSpeed = (livePromptSpeed ?? 0) + speed;
                    }
                    if (previous?.genTokens > 0 && sample.genTokens !== null
                        && sample.genTokens >= previous.genTokens) {
                        liveGenSpeed = (liveGenSpeed ?? 0) + (sample.genTokens - previous.genTokens) / elapsed;
                    }
                }
            }
            lastSlotSample = slotsOk && now !== null ? { now, samples, promptRates } : null;

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
                    prompt: livePromptSpeed ?? averagePromptSpeed,
                    generated: liveGenSpeed ?? averageGenSpeed,
                    promptIsLive: livePromptSpeed !== null,
                    generatedIsLive: liveGenSpeed !== null,
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
            lastSlotSample = null;
            if (!sampled) {
                baseline = { prompt: null, gen: null };
                averageBaseline = { prompt: null, gen: null };
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
            rawSeconds = seconds;
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

    root.inferenceStats = { parseMetricsText, normalizeSlots, createInferenceStats };
})();
