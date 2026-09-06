(function () {
    "use strict";

    const root = window.LlamaGui = window.LlamaGui || {};
    const listeners = new Set();
    const DEFAULT_HEALTH_POLL_MS = 500;
    const DEFAULT_SLOW_LOAD_WARNING_MS = 120000;

    let deps = {};
    let transitionId = 0;
    let snapshot = createSnapshot();

    function createSnapshot(overrides = {}) {
        return Object.assign({
            phase: "idle",
            operation: null,
            transitionId,
            activeRuntime: null,
            ready: false,
            busy: false,
            error: "",
        }, overrides);
    }

    function copyRuntime(runtime) {
        return runtime && typeof runtime === "object" ? JSON.parse(JSON.stringify(runtime)) : null;
    }

    function copySnapshot(value = snapshot) {
        return Object.assign({}, value, { activeRuntime: copyRuntime(value.activeRuntime) });
    }

    function configure(options = {}) {
        deps = Object.assign({}, deps, options || {});
    }

    function getSnapshot() {
        return copySnapshot();
    }

    function notify() {
        const current = getSnapshot();
        for (const listener of listeners) {
            try {
                listener(current);
            } catch (error) {
                console.warn("Process lifecycle subscriber failed", error);
            }
        }
    }

    function subscribe(listener, options = {}) {
        if (typeof listener !== "function") {
            throw new TypeError("Process lifecycle subscriber must be a function");
        }
        listeners.add(listener);
        if (options.emitCurrent !== false) {
            try {
                listener(getSnapshot());
            } catch (error) {
                console.warn("Process lifecycle subscriber failed during initial emit", error);
            }
        }
        return () => listeners.delete(listener);
    }

    function runtimeEquivalent(a, b) {
        if (a === b) return true;
        if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every((key) => key === "launch_settings"
            ? JSON.stringify(a[key]) === JSON.stringify(b[key])
            : a[key] === b[key]);
    }

    function patchChangesState(patch) {
        for (const field of ["phase", "operation", "ready", "busy", "error"]) {
            if (
                Object.prototype.hasOwnProperty.call(patch, field)
                && patch[field] !== snapshot[field]
            ) {
                return true;
            }
        }
        if (Object.prototype.hasOwnProperty.call(patch, "activeRuntime")) {
            return !runtimeEquivalent(patch.activeRuntime, snapshot.activeRuntime);
        }
        return false;
    }

    function updateSnapshot(patch, expectedTransition = null) {
        if (expectedTransition !== null && expectedTransition !== transitionId) return false;
        // Health polling applies the same phase/ready patch every tick while a
        // model loads; notifying on those no-op patches re-rendered the whole
        // UI twice per second for the entire load. Only real state changes
        // reach subscribers.
        const changed = patchChangesState(patch);
        snapshot = Object.assign({}, snapshot, patch, { transitionId });
        if (Object.prototype.hasOwnProperty.call(patch, "activeRuntime")) {
            snapshot.activeRuntime = copyRuntime(patch.activeRuntime);
        }
        if (changed) notify();
        return true;
    }

    function beginTransition(operation, options = {}) {
        if (snapshot.busy && !options.replace) return null;
        transitionId += 1;
        snapshot = createSnapshot({
            phase: options.phase || snapshot.phase,
            operation,
            transitionId,
            activeRuntime: snapshot.activeRuntime,
            ready: options.ready === undefined ? snapshot.ready : Boolean(options.ready),
            busy: true,
            error: "",
        });
        notify();
        return transitionId;
    }

    function isCurrent(id) {
        return id === transitionId;
    }

    function finishTransition(id, patch = {}) {
        return updateSnapshot(Object.assign({ busy: false, operation: null }, patch), id);
    }

    function result(ok, extra = {}) {
        return Object.assign({ ok, snapshot: getSnapshot() }, extra);
    }

    function errorMessage(error, fallback) {
        if (error && typeof error.message === "string" && error.message) return error.message;
        if (typeof error === "string" && error) return error;
        return fallback;
    }

    function getHook(options, name) {
        return options && typeof options[name] === "function" ? options[name] : deps[name];
    }

    async function callOptionalHook(options, name, ...args) {
        const hook = getHook(options, name);
        if (typeof hook !== "function") return undefined;
        try {
            return await hook(...args);
        } catch (error) {
            console.warn(`Process lifecycle hook failed: ${name}`, error);
            return undefined;
        }
    }

    async function refreshStatus() {
        let status;
        if (typeof deps.refreshStatus === "function") {
            status = await deps.refreshStatus();
        } else {
            if (typeof deps.fetchJson !== "function") {
                throw new Error("Process lifecycle dependency missing: fetchJson");
            }
            status = await deps.fetchJson("/api/status");
        }
        if (!status || typeof status !== "object" || Array.isArray(status)) {
            throw new Error("Could not obtain authoritative process status.");
        }
        return status;
    }

    function runtimeFromStatus(status) {
        return status && status.active_runtime && typeof status.active_runtime === "object"
            ? copyRuntime(status.active_runtime)
            : null;
    }

    function runtimeGeneration(runtime) {
        const generation = runtime && Number(runtime.generation);
        return Number.isSafeInteger(generation) && generation >= 1 ? generation : null;
    }

    function statusIsRunning(status) {
        return Boolean(status && status.running);
    }

    function statusMatchesGeneration(status, generation) {
        return runtimeGeneration(runtimeFromStatus(status)) === generation;
    }

    function healthPollDelay() {
        const configured = Number(deps.healthPollMs);
        return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_HEALTH_POLL_MS;
    }

    function slowLoadWarningDelay() {
        const configured = Number(deps.slowLoadWarningMs);
        return Number.isFinite(configured) && configured >= 0
            ? configured
            : DEFAULT_SLOW_LOAD_WARNING_MS;
    }

    function delay(ms) {
        if (typeof deps.delay === "function") return deps.delay(ms);
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function settleAsFailed(id, message, options = {}) {
        if (!isCurrent(id)) return result(false, { cancelled: true });
        let status = null;
        try {
            status = await refreshStatus();
        } catch (error) {
            console.debug("Failed to refresh runtime status after lifecycle error", error);
        }
        if (!isCurrent(id)) return result(false, { cancelled: true });
        const runtime = status ? runtimeFromStatus(status) : snapshot.activeRuntime;
        finishTransition(id, {
            phase: "failed",
            activeRuntime: runtime,
            ready: false,
            error: message,
        });
        await callOptionalHook(options, "onFailed", message, getSnapshot(), status);
        return result(false, { error: message, status });
    }

    async function waitForReady(id, runtime, options = {}) {
        const generation = runtimeGeneration(runtime);
        if (generation === null) {
            return settleAsFailed(id, "Launch did not provide a runtime generation.", options);
        }
        const waitStartedAt = Date.now();
        let slowLoadWarningShown = false;

        while (isCurrent(id)) {
            let health;
            try {
                if (typeof deps.fetchJson !== "function") {
                    throw new Error("Process lifecycle dependency missing: fetchJson");
                }
                health = await deps.fetchJson(`/api/llama/health?expected_generation=${encodeURIComponent(generation)}`);
            } catch (error) {
                if (!isCurrent(id)) return result(false, { cancelled: true });
                let status = null;
                try {
                    status = await refreshStatus();
                } catch (statusError) {
                    console.debug("Failed to refresh runtime status while waiting for health", statusError);
                }
                if (!isCurrent(id)) return result(false, { cancelled: true });
                if (!statusIsRunning(status) || !statusMatchesGeneration(status, generation)) {
                    return settleAsFailed(id, errorMessage(error, "The launched process exited before it became ready."), options);
                }
                updateSnapshot({ phase: "starting", ready: false }, id);
                await delay(healthPollDelay());
                continue;
            }

            if (!isCurrent(id)) return result(false, { cancelled: true });
            const state = String(health && health.state || "").toLowerCase();
            const healthGeneration = Number(health && health.generation);
            if (
                Number.isSafeInteger(healthGeneration)
                && healthGeneration >= 1
                && healthGeneration !== generation
            ) {
                return settleAsFailed(id, "Another runtime replaced the launched process.", options);
            }
            if (state === "ready" && health.ready !== false) {
                let status = null;
                try {
                    status = await refreshStatus();
                } catch (error) {
                    console.debug("Failed to refresh runtime status after readiness", error);
                }
                if (!isCurrent(id)) return result(false, { cancelled: true });
                const authoritativeRuntime = runtimeFromStatus(status) || runtime;
                if (runtimeGeneration(authoritativeRuntime) !== generation || (status && !statusIsRunning(status))) {
                    return settleAsFailed(id, "The launched runtime changed before readiness was confirmed.", options);
                }
                updateSnapshot({
                    phase: "ready",
                    activeRuntime: authoritativeRuntime,
                    ready: true,
                    error: "",
                }, id);
                await callOptionalHook(options, "startStats", authoritativeRuntime, getSnapshot());
                if (!isCurrent(id)) return result(false, { cancelled: true });
                await callOptionalHook(options, "postReady", authoritativeRuntime, getSnapshot());
                if (!isCurrent(id)) return result(false, { cancelled: true });
                finishTransition(id);
                return result(true, { runtime: copyRuntime(authoritativeRuntime), status, health });
            }

            if (
                state === "failed"
                || state === "exited"
                || state === "stopped"
                || state === "error"
                || state === "superseded"
            ) {
                const message = health && (health.error || health.message)
                    ? String(health.error || health.message)
                    : state === "superseded"
                        ? "Another runtime replaced the launched process."
                        : "The launched process exited before it became ready.";
                return settleAsFailed(id, message, options);
            }

            if (
                !slowLoadWarningShown
                && Date.now() - waitStartedAt >= slowLoadWarningDelay()
            ) {
                slowLoadWarningShown = true;
                await callOptionalHook(
                    options,
                    "onSlowLoad",
                    "Model loading is taking longer than expected. Check the process output for GPU driver, device, or memory errors; Stop remains available.",
                    copyRuntime(runtime),
                    getSnapshot(),
                    health
                );
                if (!isCurrent(id)) return result(false, { cancelled: true });
            }

            updateSnapshot({
                phase: state === "loading" ? "loading" : "starting",
                ready: false,
            }, id);
            await delay(healthPollDelay());
        }
        return result(false, { cancelled: true });
    }

    async function resolveLaunchRequest(source, options = {}) {
        if (
            source
            && typeof source === "object"
            && !Array.isArray(source)
            && source.tool
            && Array.isArray(source.args)
        ) {
            return source;
        }
        const builder = getHook(options, "buildLaunchRequest");
        if (typeof builder !== "function") {
            throw new Error("Process lifecycle launch request is missing");
        }
        return builder(source);
    }

    async function stopUnexpectedLaunch(launchResult) {
        if (typeof deps.fetchJson !== "function") return;
        let generation = runtimeGeneration(launchResult && launchResult.active_runtime);
        if (generation === null) {
            const rawGeneration = Number(launchResult && launchResult.generation);
            if (Number.isSafeInteger(rawGeneration) && rawGeneration >= 1) generation = rawGeneration;
        }
        if (generation === null) {
            console.warn("Could not safely stop a stale launch without its runtime generation");
            return;
        }
        try {
            await deps.fetchJson("/api/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expected_generation: generation }),
            });
        } catch (error) {
            console.warn("Failed to stop a stale launched runtime", error);
        }
    }

    async function launchWithin(id, requestSource, options = {}) {
        let request;
        try {
            request = await resolveLaunchRequest(requestSource, options);
        } catch (error) {
            return settleAsFailed(id, errorMessage(error, "Could not build launch request."), options);
        }
        if (!isCurrent(id)) return result(false, { cancelled: true });
        if (!request || typeof request !== "object" || !request.tool || !Array.isArray(request.args)) {
            return settleAsFailed(id, "Launch request is invalid.", options);
        }

        updateSnapshot({ phase: "starting", ready: false, error: "" }, id);
        let launchResult;
        try {
            if (typeof deps.fetchJson !== "function") {
                throw new Error("Process lifecycle dependency missing: fetchJson");
            }
            const launchBody = { tool: request.tool, args: request.args };
            if (request.launch_context !== undefined) launchBody.launch_context = request.launch_context;
            if (request.launch_settings !== undefined) launchBody.launch_settings = request.launch_settings;
            launchResult = await deps.fetchJson("/api/launch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(launchBody),
            });
        } catch (error) {
            if (!isCurrent(id)) return result(false, { cancelled: true });
            return settleAsFailed(id, errorMessage(error, "Launch failed."), options);
        }

        if (!isCurrent(id)) {
            await stopUnexpectedLaunch(launchResult);
            return result(false, { cancelled: true });
        }
        if (!launchResult || launchResult.error) {
            return settleAsFailed(id, String(launchResult && launchResult.error || "Launch failed."), options);
        }

        let status = null;
        let runtime = copyRuntime(launchResult.active_runtime);
        if (!runtime) {
            try {
                status = await refreshStatus();
                runtime = runtimeFromStatus(status);
            } catch (error) {
                return settleAsFailed(id, errorMessage(error, "Could not confirm the launched runtime."), options);
            }
        }
        if (!isCurrent(id)) {
            await stopUnexpectedLaunch(launchResult);
            return result(false, { cancelled: true });
        }
        if (!runtime) return settleAsFailed(id, "Launch succeeded without an active runtime.", options);

        updateSnapshot({ activeRuntime: runtime, phase: "starting", ready: false }, id);
        await callOptionalHook(options, "startOutput", launchResult.output_cursor, runtime, getSnapshot(), launchResult);

        const waitForServer = options.waitForReady !== false && request.tool === "llama-server";
        if (waitForServer) return waitForReady(id, runtime, options);

        updateSnapshot({
            phase: "running",
            activeRuntime: runtime,
            ready: true,
            error: "",
        }, id);
        await callOptionalHook(options, "postReady", runtime, getSnapshot());
        if (!isCurrent(id)) return result(false, { cancelled: true });
        finishTransition(id);
        return result(true, { runtime: copyRuntime(runtime), status, launchResult });
    }

    async function launch(requestSource, options = {}) {
        const id = beginTransition(options.operation || "manual-launch", { phase: "starting", ready: false });
        if (id === null) return result(false, { busy: true, error: "Another process action is already in progress." });
        await callOptionalHook(options, "invalidateOutput", getSnapshot());
        await callOptionalHook(options, "invalidateStats", getSnapshot());
        return launchWithin(id, requestSource, options);
    }

    async function stopWithin(id, options = {}) {
        const expectedRuntime = options.runtime || snapshot.activeRuntime;
        const wasReady = snapshot.ready;
        const expectedGeneration = options.expectedGeneration === undefined
            ? runtimeGeneration(expectedRuntime)
            : Number(options.expectedGeneration);
        updateSnapshot({ phase: "stopping", ready: false }, id);

        let stopResult;
        try {
            if (typeof deps.fetchJson !== "function") {
                throw new Error("Process lifecycle dependency missing: fetchJson");
            }
            const body = Number.isSafeInteger(expectedGeneration) && expectedGeneration >= 1
                ? { expected_generation: expectedGeneration }
                : {};
            stopResult = await deps.fetchJson("/api/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (error) {
            if (!isCurrent(id)) return result(false, { cancelled: true });
            return settleAsFailed(id, errorMessage(error, "Stop request failed."), options);
        }
        if (!isCurrent(id)) return result(false, { cancelled: true });

        let status;
        try {
            status = await refreshStatus();
        } catch (error) {
            return settleAsFailed(id, errorMessage(error, "Could not confirm that the process stopped."), options);
        }
        if (!isCurrent(id)) return result(false, { cancelled: true });

        const currentRuntime = runtimeFromStatus(status);
        const currentGeneration = runtimeGeneration(currentRuntime);
        if (statusIsRunning(status)) {
            const changed = Number.isSafeInteger(expectedGeneration)
                && currentGeneration !== null
                && currentGeneration !== expectedGeneration;
            const message = changed
                ? "Another runtime replaced the process before it could be stopped."
                : stopResult && stopResult.stopped === false
                    ? "The running process refused to stop."
                    : "The process is still running after the stop request.";
            finishTransition(id, {
                phase: "failed",
                activeRuntime: currentRuntime || expectedRuntime,
                ready: wasReady && !changed,
                error: message,
            });
            if (options.notifyFailure === true) {
                await callOptionalHook(options, "onFailed", message, getSnapshot(), status);
            }
            return result(false, { error: message, status, stopResult, conflict: changed });
        }

        updateSnapshot({ activeRuntime: null, phase: "idle", ready: false, error: "" }, id);
        return result(true, { status, stopResult });
    }

    async function stop(options = {}) {
        const id = beginTransition(options.operation || "manual-stop", {
            replace: true,
            phase: "stopping",
        });
        await callOptionalHook(options, "abortChat", getSnapshot());
        if (!isCurrent(id)) return result(false, { cancelled: true });
        await callOptionalHook(options, "invalidateOutput", getSnapshot());
        await callOptionalHook(options, "invalidateStats", getSnapshot());
        if (!isCurrent(id)) return result(false, { cancelled: true });
        const stopped = await stopWithin(id, options);
        if (stopped.ok && isCurrent(id)) finishTransition(id, { phase: "idle", activeRuntime: null, ready: false });
        return stopped.ok ? result(true, { status: stopped.status, stopResult: stopped.stopResult }) : stopped;
    }

    function normalizePreparedTarget(value) {
        if (value && value.ok === false) {
            throw new Error(String(value.error || "Target preflight failed."));
        }
        return value && Object.prototype.hasOwnProperty.call(value, "target") ? value.target : value;
    }

    async function switchRuntime(options = {}) {
        const id = beginTransition(options.operation || "model-switch", {
            phase: snapshot.phase,
            ready: snapshot.ready,
        });
        if (id === null) return result(false, { busy: true, error: "Another process action is already in progress." });

        let target;
        try {
            const resolveTarget = getHook(options, "resolveTarget");
            if (typeof resolveTarget !== "function") throw new Error("Target resolver is missing.");
            target = await resolveTarget(options.slot);
            if (!isCurrent(id)) return result(false, { cancelled: true });
            const prepareTarget = getHook(options, "prepareTarget");
            if (typeof prepareTarget === "function") target = await prepareTarget(target);
            target = normalizePreparedTarget(target);
            if (!target) throw new Error("Target preflight did not return a launch target.");
        } catch (error) {
            if (!isCurrent(id)) return result(false, { cancelled: true });
            const message = errorMessage(error, "Target preflight failed.");
            finishTransition(id, { error: message });
            await callOptionalHook(options, "onFailed", message, getSnapshot(), null);
            return result(false, { error: message, preflight: true });
        }

        let status;
        try {
            status = await refreshStatus();
        } catch (error) {
            return settleAsFailed(id, errorMessage(error, "Could not read the active runtime."), options);
        }
        if (!isCurrent(id)) return result(false, { cancelled: true });
        const activeRuntime = runtimeFromStatus(status);
        if (options.expectedGeneration !== undefined && (
            !statusIsRunning(status)
            || runtimeGeneration(activeRuntime) !== Number(options.expectedGeneration)
        )) {
            const message = "The running process changed before restart. Review the current process and try again.";
            finishTransition(id, { error: message });
            await callOptionalHook(options, "onFailed", message, getSnapshot(), status);
            return result(false, { error: message, conflict: true, status });
        }
        if (statusIsRunning(status) && activeRuntime && activeRuntime.tool !== "llama-server") {
            const message = `Cannot switch models while ${activeRuntime.tool} is running.`;
            finishTransition(id, { activeRuntime, ready: false, error: message });
            await callOptionalHook(options, "onFailed", message, getSnapshot(), status);
            return result(false, { error: message });
        }

        await callOptionalHook(options, "abortChat", getSnapshot(), target);
        if (!isCurrent(id)) return result(false, { cancelled: true });
        await callOptionalHook(options, "invalidateOutput", getSnapshot(), target);
        await callOptionalHook(options, "invalidateStats", getSnapshot(), target);
        if (!isCurrent(id)) return result(false, { cancelled: true });

        if (statusIsRunning(status)) {
            const stopped = await stopWithin(id, {
                runtime: activeRuntime,
                notifyFailure: true,
                onFailed: getHook(options, "onFailed"),
            });
            if (!stopped.ok) return stopped;
        }
        if (!isCurrent(id)) return result(false, { cancelled: true });

        try {
            const applyTarget = getHook(options, "applyTarget");
            if (typeof applyTarget !== "function") throw new Error("Target apply hook is missing.");
            await applyTarget(target);
        } catch (error) {
            return settleAsFailed(id, errorMessage(error, "Could not apply the target configuration."), options);
        }
        if (!isCurrent(id)) return result(false, { cancelled: true });

        const launchResult = await launchWithin(id, target, Object.assign({}, options, {
            operation: "model-switch",
            waitForReady: true,
        }));
        if (launchResult.ok) launchResult.target = target;
        return launchResult;
    }

    async function reconcile(status, options = {}) {
        if (!status || typeof status !== "object" || Array.isArray(status)) {
            return result(false, { error: "Authoritative process status is invalid." });
        }
        if (snapshot.busy) return result(false, { busy: true });

        const authoritativeRuntime = runtimeFromStatus(status);
        const currentGeneration = runtimeGeneration(snapshot.activeRuntime);
        const authoritativeGeneration = runtimeGeneration(authoritativeRuntime);
        const sameRuntime = statusIsRunning(status)
            && snapshot.activeRuntime
            && authoritativeRuntime
            && currentGeneration === authoritativeGeneration
            && snapshot.activeRuntime.tool === authoritativeRuntime.tool;
        const sameRuntimeIsHealthy = sameRuntime
            && snapshot.phase !== "failed"
            && snapshot.ready === true;
        if (sameRuntimeIsHealthy || (!statusIsRunning(status) && !snapshot.activeRuntime)) {
            return result(true, { unchanged: true, status });
        }

        await callOptionalHook(options, "invalidateOutput", getSnapshot());
        await callOptionalHook(options, "invalidateStats", getSnapshot());
        return restore(status, options);
    }

    async function restore(status, options = {}) {
        const id = beginTransition(options.operation || "restore", { replace: true, ready: false });
        const runtime = runtimeFromStatus(status);
        if (!statusIsRunning(status) || !runtime) {
            finishTransition(id, { phase: "idle", activeRuntime: null, ready: false, error: "" });
            return result(true, { status });
        }

        updateSnapshot({ activeRuntime: runtime, phase: runtime.tool === "llama-server" ? "starting" : "running" }, id);
        await callOptionalHook(options, "startOutput", status.output_cursor, runtime, getSnapshot());
        if (runtime.tool !== "llama-server") {
            finishTransition(id, { phase: "running", activeRuntime: runtime, ready: true });
            return result(true, { runtime, status });
        }
        return waitForReady(id, runtime, options);
    }

    root.processLifecycle = {
        configure,
        getSnapshot,
        subscribe,
        restore,
        launch,
        stop,
        switchRuntime,
        reconcile,
    };
})();
