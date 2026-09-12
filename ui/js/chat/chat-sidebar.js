// Chat package (3/8): sidebar rendering, sampler inputs, web-search and thinking controls, status badge, template caps, focus mode, panel layout.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = window.LlamaGui._chatInternal;
    const S = I.state;
    const {
        CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY,
        CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS,
        CHAT_WEB_SEARCH_MIN_RESULTS,
        CHAT_WEB_SEARCH_MAX_RESULTS,
        CHAT_THINKING_EFFORTS,
        CHAT_CONSTRAINED_LAYOUT_QUERY,
        CHAT_NUMERIC_INPUTS,
    } = I.consts;

    // Flag values can arrive as numeric strings or NaN (imported sampler presets
    // are copied verbatim, and cleared inputs yield ""). Everything that reads a
    // sampler value for display or for the wire must go through this so string
    // sentinels ("0", "1.0", "-1") compare equal to their numeric forms.
    function normalizeSamplerNumber(value) {
        if (value === undefined || value === null || value === "") return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function refreshSidebarUI() {
        const values = S.flagCore.getFlagValues();
        for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
            const slider = document.getElementById(sliderId);
            const display = document.getElementById(sliderId.replace("slider", "val"));
            if (!slider || !display || meta.fallback === undefined) continue;
            const num = normalizeSamplerNumber(values[meta.flag]);
            const effective = num !== null ? num : meta.fallback;
            slider.value = effective;
            display.textContent = effective.toFixed(meta.decimals);
        }
        const maxTokensSlider = document.getElementById("chat-slider-max-tokens");
        const maxTokensDisplay = document.getElementById("chat-val-max-tokens");
        if (maxTokensSlider && maxTokensDisplay) {
            const ctxSize = parseInt(values.ctx_size, 10);
            const sliderMax = (Number.isFinite(ctxSize) && ctxSize > 0) ? Math.min(ctxSize, 131072) : 32768;
            const nPredict = normalizeSamplerNumber(values.n_predict);
            const effective = nPredict === null ? -1 : nPredict;
            // Reflect the shared request value, even outside the usual slider
            // range. Refreshing Chat must never silently clamp launch state.
            maxTokensSlider.min = Math.min(-1, effective);
            maxTokensSlider.max = Math.max(sliderMax, effective);
            maxTokensSlider.value = effective;
            const label = effective === -1 ? "Server default" : String(effective);
            maxTokensDisplay.textContent = label;
            maxTokensSlider.setAttribute("aria-valuetext", label);
        }
        for (const [inputId, meta] of Object.entries(CHAT_NUMERIC_INPUTS)) {
            const input = document.getElementById(inputId);
            if (!input) continue;
            const value = normalizeSamplerNumber(values[meta.flag]);
            input.value = value === null ? "" : String(value);
            input.setAttribute("aria-valuetext", value === null || value === -1 ? "Server default" : String(value));
        }
        const modelIndicator = document.getElementById("chat-active-model");
        if (modelIndicator) {
            const fullModelName = getChatModelName();
            const compactModelName = fullModelName.split(/[\\/]/).pop() || fullModelName;
            modelIndicator.textContent = compactModelName;
            modelIndicator.title = fullModelName;
        }
        I.scheduleContextPreview();
    }

    function getChatModelName() {
        const lifecycle = S.getLifecycleSnapshot ? S.getLifecycleSnapshot() : null;
        const status = S.getLatestStatus();
        const lifecycleRuntime = lifecycle && lifecycle.activeRuntime
            && lifecycle.activeRuntime.tool === "llama-server"
            ? lifecycle.activeRuntime
            : null;
        const statusRuntime = status && status.running && status.active_runtime
            && status.active_runtime.tool === "llama-server"
            ? status.active_runtime
            : null;
        const runtime = lifecycleRuntime || statusRuntime;
        if (runtime) {
            const activeAlias = String(runtime.alias || "").split(",")[0].trim();
            if (activeAlias) return activeAlias;
            const activeModel = String(runtime.model || "").trim();
            if (activeModel) return activeModel;
        }
        const values = S.flagCore.getFlagValues();
        const alias = String(values.alias || "").split(",")[0].trim();
        if (alias) return alias;
        const selectedModel = S.flagCore.getSelectedModel();
        if (selectedModel) return selectedModel;
        return "local-model";
    }

    function isChatWebSearchEnabled() {
        const toggle = document.getElementById("chat-web-search-toggle");
        return Boolean(toggle && toggle.checked);
    }

    function clampChatWebSearchMaxResults(value) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS;
        return Math.max(CHAT_WEB_SEARCH_MIN_RESULTS, Math.min(parsed, CHAT_WEB_SEARCH_MAX_RESULTS));
    }

    function getChatWebSearchMaxResults() {
        const input = document.getElementById("chat-web-search-max-results");
        return clampChatWebSearchMaxResults(input ? input.value : I.getStoredItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY));
    }

    function normalizeChatThinkingEffort(value) {
        const normalized = String(value || "").toLowerCase();
        return CHAT_THINKING_EFFORTS.includes(normalized) ? normalized : "auto";
    }

    function getChatThinkingEffort() {
        const select = document.getElementById("chat-thinking-effort");
        return normalizeChatThinkingEffort(select ? select.value : "auto");
    }

    function setChatThinkingEffort(value) {
        const select = document.getElementById("chat-thinking-effort");
        if (select) select.value = normalizeChatThinkingEffort(value);
    }

    function setChatPreference(storageKey, value) {
        if (!I.workspaceMutationAllowed()) return false;
        const saved = I.setStoredItem(storageKey, value);
        if (saved) {
            I.notifyWorkspaceChange();
            I.requestWorkspaceCheckpoint({ reason: "chat-preference" });
        }
        return saved;
    }

    function updateChatAvailability(isRunning) {
        const chatInput = document.getElementById("chat-input");
        const sendBtn = document.getElementById("btn-chat-send");
        const note = document.getElementById("chat-no-server-note");
        const lifecycle = S.getLifecycleSnapshot ? S.getLifecycleSnapshot() : null;
        const isLoading = Boolean(
            lifecycle
            && lifecycle.activeRuntime
            && lifecycle.activeRuntime.tool === "llama-server"
            && (lifecycle.phase === "starting" || lifecycle.phase === "loading")
        );
        const canOperate = I.workspaceMutationAllowed();
        const canSend = Boolean(isRunning) && canOperate && !S.chatStreaming && !S.compactionController && !S.sendPreflightPromise;
        const characterButton = document.getElementById("btn-chat-load-character");
        if (characterButton) characterButton.disabled = !canOperate || S.characterImportPending || S.chatStreaming || Boolean(S.compactionController) || Boolean(S.sendPreflightPromise);
        const workspaceInputIds = [
            "chat-system-prompt", "chat-thinking-effort", "chat-datetime-enabled",
            "chat-web-search-toggle", "chat-web-search-max-results", "chat-auto-compact-toggle",
            ...Object.keys(CHAT_SAMPLER_SLIDER_MAP), ...Object.keys(CHAT_NUMERIC_INPUTS),
        ];
        for (const id of workspaceInputIds) {
            const input = document.getElementById(id);
            if (input) input.disabled = !canOperate;
        }

        if (chatInput) {
            chatInput.disabled = !isRunning || !canOperate;
            chatInput.placeholder = !canOperate
                ? (S.workspaceOwned ? "Chat is temporarily unavailable while the other window is active." : "Chat is open in another window.")
                : isRunning
                ? "Type a message..."
                : isLoading
                    ? "Waiting for the model to finish loading..."
                    : "Start llama-server, or connect to a running one on the API tab...";
        }
        if (sendBtn) {
            sendBtn.disabled = !canSend;
            sendBtn.title = !canOperate ? "Chat is currently owned by another window or transfer is in progress." : isRunning ? "" : "Start llama-server, or connect to a running one on the API tab, before sending chat messages.";
        }
        const container = document.getElementById("chat-messages");
        if (container) {
            for (const button of container.querySelectorAll(".chat-response-action")) {
                button.disabled = !canOperate || S.chatStreaming || Boolean(S.compactionController) || (button.dataset.requiresServer === "true" && !isRunning);
            }
        }
        I.updateCompactionControls();
        if (note) {
            note.classList.toggle("hidden", Boolean(isRunning));
            const message = note.querySelector("span");
            if (message) {
                message.textContent = isLoading
                    ? "llama-server is loading the selected model. Chat will unlock when it is ready."
                    : "Start llama-server, or connect to a running one on the API tab, before sending chat messages.";
            }
        }
        I.notifyWorkspaceChange();
    }

    function updateStatusBadge() {
        I.scheduleContextPreview();
        const runningBadge = document.getElementById("chat-status-badge");
        const noServerBadge = document.getElementById("chat-no-server-badge");
        if (!runningBadge || !noServerBadge) return;

        const isRunning = I.isServerRunning();
        const lifecycle = S.getLifecycleSnapshot ? S.getLifecycleSnapshot() : null;
        const isLoading = Boolean(
            lifecycle
            && lifecycle.activeRuntime
            && lifecycle.activeRuntime.tool === "llama-server"
            && (lifecycle.phase === "starting" || lifecycle.phase === "loading")
        );
        runningBadge.style.display = isRunning ? "" : "none";
        noServerBadge.style.display = isRunning ? "none" : "";
        noServerBadge.textContent = isLoading ? "Loading Model" : "No Server";
        updateChatAvailability(isRunning);
        refreshSidebarUI();
        void refreshTemplateCaps();
    }

    function setThinkingEffortCapHint(unsupported) {
        const hint = document.getElementById("chat-thinking-effort-cap-hint");
        if (!hint) return;
        hint.textContent = unsupported
            ? "This model may ignore the reasoning setting."
            : "";
        hint.title = unsupported
            ? "The loaded chat template does not advertise reasoning-effort support."
            : "";
        hint.classList.toggle("hidden", !unsupported);
    }

    function getTemplateCapsKey() {
        if (!I.isServerRunning()) return null;
        const lifecycle = S.getLifecycleSnapshot ? S.getLifecycleSnapshot() : null;
        const lifecycleGeneration = lifecycle && lifecycle.activeRuntime
            ? lifecycle.activeRuntime.generation
            : null;
        const latestStatus = S.getLatestStatus ? S.getLatestStatus() : null;
        const statusGeneration = latestStatus ? latestStatus.runtime_generation : null;
        const runtime = lifecycle?.activeRuntime || latestStatus?.active_runtime;
        const external = latestStatus?.external_chat_target;
        if ((!runtime || runtime.tool !== "llama-server") && external?.connected) {
            return JSON.stringify(["external", external.host, external.port, external.generation]);
        }
        return String(lifecycleGeneration !== null && lifecycleGeneration !== undefined
            ? lifecycleGeneration
            : (statusGeneration !== null && statusGeneration !== undefined ? statusGeneration : "running"));
    }

    async function refreshTemplateCaps() {
        if (!document.getElementById("chat-thinking-effort-cap-hint")) return;
        const key = getTemplateCapsKey();
        if (key === null) {
            S.templateCapsKey = null;
            S.templateCapsRequest = null;
            setThinkingEffortCapHint(false);
            return;
        }
        if (key === S.templateCapsKey || (S.templateCapsRequest && S.templateCapsRequest.key === key)) return;
        const request = { key };
        S.templateCapsRequest = request;
        try {
            const resp = await fetch("/api/llama/props", {
                headers: S.getApiAuthorizationHeaders({}),
            });
            if (!resp || !resp.ok || typeof resp.json !== "function") return;
            const props = await resp.json();
            if (S.templateCapsRequest !== request || getTemplateCapsKey() !== key) return;
            const caps = props && props.chat_template_caps;
            S.templateCapsKey = key;
            setThinkingEffortCapHint(Boolean(caps && caps.supports_reasoning_effort === false));
        } catch (error) {
            console.debug("Could not read chat template capabilities", error);
        } finally {
            if (S.templateCapsRequest === request) S.templateCapsRequest = null;
        }
    }

    function setChatPanelCollapsed(panel, openButton, collapseButton, collapsed) {
        if (!panel) return;
        const restoreFocus = collapsed ? panel.contains?.(document.activeElement) : document.activeElement === openButton;
        panel.classList.toggle("collapsed", collapsed);
        panel.inert = collapsed;
        panel.setAttribute("aria-hidden", String(collapsed));
        if (openButton) {
            openButton.style.display = collapsed ? "flex" : "none";
            openButton.setAttribute("aria-expanded", String(!collapsed));
        }
        if (collapseButton) {
            collapseButton.setAttribute("aria-expanded", String(!collapsed));
        }
        if (restoreFocus) (collapsed ? openButton : collapseButton)?.focus();
    }

    function shouldUseConstrainedChatLayout() {
        return Boolean(window.matchMedia && window.matchMedia(CHAT_CONSTRAINED_LAYOUT_QUERY).matches);
    }

    function initChatPanel(panelId, openId, collapseId, storageKey) {
        const panel = document.getElementById(panelId);
        const openButton = document.getElementById(openId);
        const collapseButton = document.getElementById(collapseId);
        if (!panel || !openButton || !collapseButton) return;
        // Focus mode and responsive collapse leave the normal panel preference intact.
        let preferredCollapsed = I.getStoredItem(storageKey) !== "false";
        const applyLayout = () => setChatPanelCollapsed(panel, openButton, collapseButton,
            S.chatFocusMode || shouldUseConstrainedChatLayout() || preferredCollapsed);
        S.chatPanelLayouts.push(applyLayout);
        applyLayout();
        openButton.addEventListener("click", () => {
            if (!S.chatFocusMode) {
                preferredCollapsed = false;
                if (!S.workspaceConfig.detachedView && I.workspaceMutationAllowed()) I.setStoredItem(storageKey, "false");
            }
            setChatPanelCollapsed(panel, openButton, collapseButton, false);
            collapseButton.focus();
        });
        collapseButton.addEventListener("click", () => {
            if (!S.chatFocusMode) {
                preferredCollapsed = true;
                if (!S.workspaceConfig.detachedView && I.workspaceMutationAllowed()) I.setStoredItem(storageKey, "true");
            }
            setChatPanelCollapsed(panel, openButton, collapseButton, true);
            openButton.focus();
        });
        const media = window.matchMedia?.(CHAT_CONSTRAINED_LAYOUT_QUERY);
        if (media?.addEventListener) media.addEventListener("change", applyLayout);
        else if (media?.addListener) media.addListener(applyLayout);
    }

    function updateChatFocusButton() {
        const focusBtn = document.getElementById("btn-chat-focus");
        if (!focusBtn) return;
        focusBtn.setAttribute("aria-pressed", String(S.chatFocusMode));
        focusBtn.title = S.chatFocusMode ? "Exit Focus Chat" : "Focus Chat";
        const label = document.getElementById("chat-focus-label");
        if (label) label.textContent = S.chatFocusMode ? "Exit Focus" : "Focus";
    }

    function setChatFocusMode(enabled) {
        S.chatFocusMode = Boolean(enabled);
        document.body.classList.toggle("chat-focus-mode", S.chatFocusMode);
        S.chatPanelLayouts.forEach(applyLayout => applyLayout());
        updateChatFocusButton();
    }

    function onTabChanged(tabId) {
        if (tabId !== "chat" && S.chatFocusMode) {
            setChatFocusMode(false);
        }
    }

    function showChatSendButton(show) {
        const sendBtn = document.getElementById("btn-chat-send");
        const stopBtn = document.getElementById("btn-chat-stop");
        if (sendBtn) sendBtn.style.display = show ? "flex" : "none";
        if (stopBtn) stopBtn.style.display = show ? "none" : "flex";
        updateChatAvailability(I.isServerRunning());
    }

    function getChatSamplerParams() {
        const params = {};
        const values = S.flagCore.getFlagValues();
        const temp = normalizeSamplerNumber(values.temperature);
        if (temp !== null) params.temperature = temp;
        const topP = normalizeSamplerNumber(values.top_p);
        if (topP !== null) params.top_p = topP;
        const topK = normalizeSamplerNumber(values.top_k);
        if (topK !== null) params.top_k = topK;
        const minP = normalizeSamplerNumber(values.min_p);
        if (minP !== null) params.min_p = minP;
        const repeatPenalty = normalizeSamplerNumber(values.repeat_penalty);
        if (repeatPenalty !== null) params.repeat_penalty = repeatPenalty;
        const nPredict = normalizeSamplerNumber(values.n_predict);
        if (nPredict !== null && nPredict !== -1) params.max_tokens = nPredict;
        return params;
    }

    Object.assign(I, {
        normalizeSamplerNumber,
        refreshSidebarUI,
        getChatModelName,
        isChatWebSearchEnabled,
        clampChatWebSearchMaxResults,
        getChatWebSearchMaxResults,
        normalizeChatThinkingEffort,
        getChatThinkingEffort,
        setChatThinkingEffort,
        setChatPreference,
        updateChatAvailability,
        updateStatusBadge,
        setThinkingEffortCapHint,
        getTemplateCapsKey,
        refreshTemplateCaps,
        setChatPanelCollapsed,
        shouldUseConstrainedChatLayout,
        initChatPanel,
        updateChatFocusButton,
        setChatFocusMode,
        onTabChanged,
        showChatSendButton,
        getChatSamplerParams,
    });
})();
