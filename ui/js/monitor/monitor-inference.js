// Monitor and fixed-bar rendering of the single shared inference snapshot.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;

    function setInferenceText(id, text) {
        const el = I.dom.byId(id);
        if (el) el.textContent = text;
    }

    function renderInferenceAvailability(snapshot) {
        const state = I.dependencies.getLifecycleSnapshot?.() || {};
        let message = "";
        if (!snapshot?.targetKey) {
            message = state.phase === "starting" || state.phase === "loading"
                ? "Waiting for llama-server to become ready. Follow loading progress in Process Output."
                : state.phase === "stopping"
                    ? "The process is stopping. Inference readings will resume when a server is ready."
                    : state.activeRuntime && state.activeRuntime.tool !== "llama-server"
                        ? `${state.activeRuntime.tool} does not expose server inference metrics. Follow its output above; system readings remain available independently.`
                        : "Start or connect to a llama-server to view token, request, and context activity. GPU monitoring tools are not required.";
        } else if (snapshot.seq === 1) {
            message = "Waiting for the first inference sample from this server.";
        } else {
            const notes = [];
            if (snapshot.sources?.metrics !== "ok") notes.push("Session counters unavailable: check the server connection and whether --metrics is enabled.");
            if (snapshot.sources?.slots !== "ok") notes.push("Slot activity and context unavailable: check the server connection and whether /slots is enabled.");
            message = notes.join(" ");
        }
        I.dom.setText(I.dom.byId("monitor-inference-note"), message);
        I.dom.byId("monitor-inference-note")?.classList.toggle("hidden", !message);
    }

    function renderInferenceSnapshot(snapshot) {
        renderInferenceAvailability(snapshot);
        const kicker = I.dom.byId("monitor-inference-kicker");
        const badge = I.dom.byId("monitor-inference-state-badge");
        const body = I.dom.byId("monitor-inference-body");
        const empty = I.dom.byId("monitor-inference-empty");
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
        const stateText = activityUnknown ? "Activity unknown" : processing > 0 ? "Processing" : "Idle";
        const external = String(snapshot.targetKey).startsWith("ext:");
        const target = external ? I.dependencies.getLatestStatus?.()?.external_chat_target : null;
        kicker.textContent = external && target?.host && target?.port
            ? `External llama-server · ${target.host}:${target.port}`
            : `Llama server · ${stateText}`;
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
            session.prompt === null ? "--" : `${I.dom.formatTokens(session.prompt)} tokens`);
        setInferenceText("monitor-inference-generated",
            session.generated === null ? "--" : `${I.dom.formatTokens(session.generated)} tokens`);
        setInferenceText("monitor-inference-total",
            session.total === null ? "--" : `${I.dom.formatTokens(session.total)} tokens`);

        const context = snapshot.context;
        const contextLabel = I.dom.byId("monitor-inference-context-label");
        const contextReading = I.dom.byId("monitor-inference-context-reading");
        const contextBarHolder = I.dom.byId("monitor-inference-context-bar");
        if (contextLabel) {
            contextLabel.textContent = context
                ? `Context \u00b7 most-filled slot (${context.isProcessing ? "active" : "idle"})`
                : "Context \u00b7 most-filled slot";
        }
        if (contextReading) {
            contextReading.textContent = context
                ? `${I.dom.formatTokens(context.used)} / ${I.dom.formatTokens(context.total)} \u00b7 ${I.dom.formatTokens(context.remaining)} remaining`
                : "Not available";
            contextReading.classList.toggle("monitor-not-available", !context);
            contextReading.classList.toggle("monitor-metric-reading", Boolean(context));
        }
        if (contextBarHolder) {
            let bar = contextBarHolder.querySelector(".progress-bar");
            if (!bar) {
                bar = I.dom.makeProgressBar("Most-filled slot context usage", null);
                contextBarHolder.replaceChildren(bar);
            }
            I.dom.updateProgressBar(bar, context ? context.percent : null, "Most-filled slot context usage");
            const fill = bar.querySelector(".progress-fill");
            if (fill) {
                fill.classList.toggle("progress-fill-critical", Boolean(context) && snapshot.contextLevel === "critical");
                fill.classList.toggle("progress-fill-warning", Boolean(context) && snapshot.contextLevel === "warning");
            }
        }

        const speed = snapshot.speed || {};
        setInferenceText("monitor-inference-prompt-speed-label",
            speed.promptIsLive ? "Live prompt speed" : "Avg prompt speed");
        setInferenceText("monitor-inference-gen-speed-label",
            speed.generatedIsLive ? "Live generation speed" : "Avg generation speed");
        setInferenceText("monitor-inference-prompt-speed",
            speed.prompt === null || speed.prompt === undefined ? "--" : `${I.dom.formatSpeed(speed.prompt)} tok/s`);
        setInferenceText("monitor-inference-gen-speed",
            speed.generated === null || speed.generated === undefined ? "--" : `${I.dom.formatSpeed(speed.generated)} tok/s`);

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

    function renderStatsBarFromSnapshot(snapshot, targetDocument = document) {
        const doc = targetDocument || document;
        const get = id => doc.getElementById(id);
        const set = (id, value, format) => {
            const element = get(id);
            if (element) element.textContent = value === null || value === undefined ? "--" : format(value);
        };
        const bar = get("stats-bar");
        if (!bar) return;
        if (!snapshot || !snapshot.targetKey) {
            bar.classList.add("hidden");
            for (const id of ["stats-prompt-tokens", "stats-prompt-speed", "stats-gen-tokens", "stats-gen-speed", "stats-context"]) {
                const element = get(id);
                if (element) element.textContent = "--";
            }
            const kv = get("stats-kv-usage");
            if (kv) kv.textContent = "--%";
            return;
        }
        bar.classList.remove("hidden");
        set("stats-prompt-tokens", snapshot.session?.prompt, value => Math.round(value).toLocaleString());
        set("stats-prompt-speed", snapshot.speed?.prompt, value => value.toFixed(1));
        set("stats-prompt-speed-label", snapshot.speed?.promptIsLive, live => live ? "tok/s prompt live" : "tok/s prompt avg");
        set("stats-gen-tokens", snapshot.session?.generated, value => Math.round(value).toLocaleString());
        set("stats-gen-speed", snapshot.speed?.generated, value => value.toFixed(1));
        set("stats-gen-speed-label", snapshot.speed?.generatedIsLive, live => live ? "tok/s gen live" : "tok/s gen avg");
        set("stats-context", snapshot.session?.total, value => Math.round(value).toLocaleString());
        set("stats-kv-usage", snapshot.context ? snapshot.context.percent : null, value => `${Math.round(value)}%`);
    }

    I.inference = {
        renderInferenceAvailability,
        renderInferenceSnapshot,
        renderStatsBarFromSnapshot,
    };
})();
