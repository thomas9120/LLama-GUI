// Runtime/header presentation and terminal output; lifecycle and cursors stay in app.js.
(() => {
    "use strict";
    const I = window.LlamaGui._monitorInternal;

    const TERMINAL_MAX_LINES = 5000;
    const TERMINAL_TRIM = 1000;
    function renderRuntime() {
        const state = I.dependencies.getLifecycleSnapshot?.() || {};
        const runtime = state.activeRuntime;
        const target = I.dependencies.getLatestStatus?.()?.external_chat_target;
        const external = !runtime && state.phase === "idle" && target?.connected;
        const phases = { idle: "Stopped", starting: "Starting", loading: "Loading model", ready: "Ready", running: "Running", stopping: "Stopping", failed: "Action failed" };
        const phaseLabel = external ? "External server"
            : runtime && state.phase === "failed" ? "Process active · action failed"
                : phases[state.phase] || "Checking…";
        const badge = I.dom.byId("monitor-runtime-state");
        I.dom.setText(badge, phaseLabel);
        if (badge) {
            badge.classList.toggle("badge-green", state.phase === "ready" || state.phase === "running");
            badge.classList.toggle("badge-yellow", Boolean(state.busy) || state.phase === "failed");
        }
        const model = runtime ? String(runtime.alias || runtime.model || "Model unavailable")
            : external ? String(target.label || "Managed outside Llama GUI") : "No local process running";
        const modelEl = I.dom.byId("monitor-runtime-model");
        I.dom.setText(modelEl, runtime && !runtime.alias ? model.split(/[\\/]/).pop() : model);
        if (modelEl) modelEl.title = model;
        I.dom.setText(I.dom.byId("monitor-runtime-build"), runtime
            ? [runtime.tool, runtime.backend, runtime.version].filter(Boolean).join(" · ")
            : external ? "llama-server · Managed outside Llama GUI" : "Launch a model to follow its output and activity here.");
        const endpoint = runtime?.tool === "llama-server" ? runtime : external ? target : null;
        I.dom.setText(I.dom.byId("monitor-runtime-endpoint"), endpoint?.host && endpoint?.port
            ? `Endpoint: ${endpoint.host}:${endpoint.port}` : "");

        const comparison = I.dependencies.compareLaunchSettings?.(runtime);
        const count = comparison?.available ? comparison.changes.length : 0;
        const modelChanged = comparison?.available && (comparison.modelChanged || comparison.modelRootChanged);
        const review = I.dom.byId("btn-monitor-review");
        if (review) {
            review.classList.toggle("hidden", !count && !modelChanged);
            I.dom.setText(review, count ? `Review changes · ${count}` : "Review model change");
        }
        const note = count || modelChanged
            ? "Edits are pending for the next launch. The count covers recorded GUI settings; API keys and Custom Launch Args are excluded."
            : "";
        I.dom.setText(I.dom.byId("monitor-runtime-note"), note);
        I.dom.byId("monitor-runtime-note")?.classList.toggle("hidden", !note);
        I.dom.setText(I.dom.byId("monitor-runtime-error"), state.error || "");
        I.dom.byId("monitor-runtime-error")?.classList.toggle("hidden", !state.error);
        I.dom.byId("btn-monitor-quick-launch")?.classList.toggle("hidden", Boolean(runtime) || Boolean(state.busy) || Boolean(external));
        I.dom.byId("btn-monitor-api")?.classList.toggle("hidden", !external);
    }

    function updateProcessHeader() {
        renderRuntime();
        const toolBadge = I.dom.byId("monitor-process-tool");
        const stateBadge = I.dom.byId("monitor-process-state");
        const externalNote = I.dom.byId("monitor-external-note");
        const noProcessNote = I.dom.byId("monitor-no-process-note");
        const terminal = I.dom.byId("output-terminal");

        let lifecycle = null;
        let status = null;
        if (typeof I.dependencies.getLifecycleSnapshot === "function") lifecycle = I.dependencies.getLifecycleSnapshot();
        if (typeof I.dependencies.getLatestStatus === "function") status = I.dependencies.getLatestStatus();

        const runtime = lifecycle && lifecycle.activeRuntime;
        const phase = lifecycle && lifecycle.phase;
        const phaseLabels = { starting: "Starting", loading: "Loading", stopping: "Stopping" };
        const transitional = Object.prototype.hasOwnProperty.call(phaseLabels, phase);
        const running = Boolean(runtime) || Boolean(transitional);
        const tool = runtime && runtime.tool ? runtime.tool : "";
        const externalTarget = status && status.external_chat_target;
        const externalConnected = phase === "idle" && Boolean(externalTarget && externalTarget.connected);
        const navLive = I.dom.byId("monitor-nav-live");
        if (navLive) navLive.classList.toggle("hidden",
            !((tool === "llama-server" && phase === "ready") || (!running && externalConnected)));

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
                stateBadge.textContent = phaseLabels[phase] || (phase === "failed" ? "Action failed" : phase === "ready" ? "Ready" : "Running");
                stateBadge.classList.remove("hidden", "badge-dim", "badge-green", "badge-yellow");
                stateBadge.classList.add(transitional || phase === "failed" ? "badge-yellow" : "badge-green");
            } else {
                stateBadge.textContent = "No process running";
                stateBadge.classList.remove("hidden", "badge-green", "badge-yellow");
                stateBadge.classList.add("badge-dim");
            }
        }
        const externalOnly = externalConnected && !running;
        const hasOutput = Boolean(terminal?.children.length);
        I.dom.setText(I.dom.byId("monitor-output-title"), !running && !externalOnly && hasOutput ? "Last run output" : "Process Output");
        I.dom.setText(noProcessNote, hasOutput
            ? "No process running — the most recent output backlog is retained until the next launch."
            : "Process output will appear here when you launch a model.");
        if (externalNote) externalNote.classList.toggle("hidden", !externalOnly);
        if (noProcessNote) noProcessNote.classList.toggle("hidden", running || externalOnly);
        if (terminal) terminal.classList.toggle("hidden", externalOnly || (!running && !hasOutput));
        I.inference.renderInferenceAvailability(I.dependencies.getInferenceSnapshot?.());
        // #input-row visibility belongs to app.js, which owns process
        // lifecycle and sets it from the active runtime before calling
        // updateProcessHeader(); touching it here would fight that.
    }

    function terminalEl() {
        return I.dom.byId("output-terminal");
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
        if (terminal.children.length === 1) updateProcessHeader();
        trimTerminal();
        scrollTerminalToBottom();
    }

    function clearTerminal() {
        const terminal = terminalEl();
        if (terminal) terminal.replaceChildren();
        // Advance the cursor epoch without discarding the cursor; otherwise
        // the next cursorless request would replay the whole backend backlog.
        if (typeof I.dependencies.invalidateCursor === "function") I.dependencies.invalidateCursor();
        updateProcessHeader();
    }

    I.terminal = {
        appendOutputLine,
        clearTerminal,
        renderRuntime,
        scrollTerminalToBottom,
        updateProcessHeader,
    };
})();
