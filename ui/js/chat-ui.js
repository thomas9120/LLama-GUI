(function () {
    window.LlamaGui = window.LlamaGui || {};

    let flagCore = null;
    let confirmAction = null;
    let getLatestStatus = null;
    let getLifecycleSnapshot = null;
    let snapshotStatsBaseline = null;
    let getApiAuthorizationHeaders = (headers) => headers || {};
    let switchTab = () => {};

    let chatMessages = [];
    let chatStreaming = false;
    let chatAbortController = null;
    let chatStreamPromise = null;
    let sendPreflightPromise = null;
    let sendAttemptToken = 0;
    let currentConversationId = null;
    let chatFocusMode = false;
    const chatPanelLayouts = [];
    let contextTimer = null;
    let contextController = null;
    let contextKey = null;
    let contextRevision = 0;
    let chatCompactions = [];
    let compactionController = null;
    let compactionPromise = null;
    let compactionKey = null;
    let latestContextBudget = null;
    let latestContextBodyKey = null;
    let pendingEdit = null;
    let chatScrollState = null;
    let autoCompactionAttempted = false;
    let chatHistoryFilter = "";
    let characterImportPending = false;
    const compaction = window.LlamaGui.chatCompaction;

    const CHAT_CONVERSATIONS_STORAGE_KEY = "llama_gui_conversations";
    const CHAT_SETTINGS_COLLAPSED_STORAGE_KEY = "llama_gui_chat_settings_collapsed";
    const CHAT_HISTORY_COLLAPSED_STORAGE_KEY = "llama_gui_chat_history_collapsed";
    const CHAT_WEB_SEARCH_STORAGE_KEY = "llama_gui_chat_web_search_enabled";
    const CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY = "llama_gui_chat_web_search_max_results";
    const CHAT_AUTO_COMPACTION_STORAGE_KEY = "llama_gui_chat_auto_compaction";
    const CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
    const CHAT_WEB_SEARCH_MIN_RESULTS = 1;
    const CHAT_WEB_SEARCH_MAX_RESULTS = 10;
    const CHAT_THINKING_EFFORTS = ["auto", "off", "low", "medium", "high", "xhigh"];
    const CHAT_MAX_STORED_CONVERSATIONS = 50;
    const CHAT_CONSTRAINED_LAYOUT_QUERY = "(max-width: 1320px)";
    const CHAT_NUMERIC_INPUTS = {
        "chat-num-temp": { flag: "temperature", integer: false },
        "chat-num-top-p": { flag: "top_p", integer: false },
        "chat-num-top-k": { flag: "top_k", integer: true },
        "chat-num-min-p": { flag: "min_p", integer: false },
        "chat-num-repeat": { flag: "repeat_penalty", integer: false },
        "chat-num-max-tokens": { flag: "n_predict", integer: true },
    };

    // localStorage may be blocked entirely (e.g. "block all cookies"). The
    // Chat tab must still work with per-session defaults, so every storage
    // read/write goes through these tolerant helpers instead of throwing and
    // aborting init() before the button handlers are wired.
    function getStoredItem(storageKey) {
        try {
            return localStorage.getItem(storageKey);
        } catch (e) {
            console.debug("Chat storage read failed", e);
            return null;
        }
    }

    function setStoredItem(storageKey, value) {
        try {
            localStorage.setItem(storageKey, value);
            return true;
        } catch (e) {
            console.warn("Chat storage write failed", e);
            return false;
        }
    }

    const chatRendering = window.LlamaGui.chatRendering;
    const {
        renderChatMessage,
        setChatWebStatus,
        renderChatSources,
        renderChatTypingIndicator,
        removeChatTypingIndicator,
        appendChatStreamToken,
        appendChatReasoningStreamToken,
        splitReasoningFromContent,
        setChatResponseMetadata,
        isChatNearBottom: renderingIsChatNearBottom,
        scrollChatToLatest: renderingScrollChatToLatest,
    } = chatRendering;

    function configure(options) {
        flagCore = options.flagCore;
        confirmAction = options.confirmAction;
        getLatestStatus = options.getLatestStatus;
        getLifecycleSnapshot = options.getLifecycleSnapshot || getLifecycleSnapshot;
        snapshotStatsBaseline = options.snapshotStatsBaseline;
        getApiAuthorizationHeaders = options.getApiAuthorizationHeaders || getApiAuthorizationHeaders;
        switchTab = options.switchTab || switchTab;
    }

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
        const values = flagCore.getFlagValues();
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
        scheduleContextPreview();
    }

    function getChatModelName() {
        const lifecycle = getLifecycleSnapshot ? getLifecycleSnapshot() : null;
        const status = getLatestStatus();
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
        const values = flagCore.getFlagValues();
        const alias = String(values.alias || "").split(",")[0].trim();
        if (alias) return alias;
        const selectedModel = flagCore.getSelectedModel();
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
        return clampChatWebSearchMaxResults(input ? input.value : getStoredItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY));
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

    function getChatThinkingParams() {
        const effort = getChatThinkingEffort();
        if (effort === "auto") return {};
        if (effort === "off") {
            return {
                reasoning_effort: "none",
                chat_template_kwargs: {
                    enable_thinking: false,
                    reasoning_effort: "none",
                },
            };
        }
        // Top-level reasoning_effort is honored natively by llama.cpp b10434+
        // (and takes final precedence over the server default); the nested
        // chat_template_kwargs copy stays as the fallback for older builds
        // that ignored top-level values other than "none". Both are harmless
        // together, so we send them through the whole compatibility window.
        return {
            reasoning_effort: effort,
            chat_template_kwargs: {
                enable_thinking: true,
                reasoning_effort: effort,
            },
        };
    }

    function getChatRequestMessages(messages) {
        return window.LlamaGui.chatTools.requestMessages(messages);
    }

    function getChatDeltaText(delta, keys) {
        if (!delta) return "";
        for (const key of keys) {
            const value = delta[key];
            if (typeof value === "string" && value) return value;
        }
        return "";
    }

    function shouldExtractEmbeddedReasoning() {
        const values = flagCore ? flagCore.getFlagValues() : {};
        const format = values.reasoning_format || "auto";
        return format === "auto" || format === "deepseek";
    }

    function getMessagePreviewText(message) {
        if (!message) return "";
        const content = String(message.content || "").trim();
        const text = content || String(message.reasoning || "").trim();
        return text.replace(/\n/g, " ").slice(0, 60);
    }

    function getExternalTarget() {
        const latestStatus = getLatestStatus ? getLatestStatus() : null;
        const target = latestStatus && latestStatus.external_chat_target;
        return target && target.connected ? target : null;
    }

    function isServerRunning() {
        const lifecycle = getLifecycleSnapshot ? getLifecycleSnapshot() : null;
        if (lifecycle && lifecycle.activeRuntime && lifecycle.activeRuntime.tool === "llama-server") {
            return lifecycle.ready === true;
        }
        const latestStatus = getLatestStatus ? getLatestStatus() : null;
        // Lifecycle clears the runtime before the shared status poll catches up
        // after Stop. Only fall back when lifecycle state is unavailable.
        if (!lifecycle && latestStatus && latestStatus.running && latestStatus.active_process_tool === "llama-server") {
            return true;
        }
        // A llama-server registered on the API tab is just as good a chat target
        // as one this GUI launched.
        return Boolean(getExternalTarget());
    }

    function updateChatAvailability(isRunning) {
        const chatInput = document.getElementById("chat-input");
        const sendBtn = document.getElementById("btn-chat-send");
        const note = document.getElementById("chat-no-server-note");
        const lifecycle = getLifecycleSnapshot ? getLifecycleSnapshot() : null;
        const isLoading = Boolean(
            lifecycle
            && lifecycle.activeRuntime
            && lifecycle.activeRuntime.tool === "llama-server"
            && (lifecycle.phase === "starting" || lifecycle.phase === "loading")
        );
        const canSend = Boolean(isRunning) && !chatStreaming && !compactionController && !sendPreflightPromise;
        const characterButton = document.getElementById("btn-chat-load-character");
        if (characterButton) characterButton.disabled = characterImportPending || chatStreaming || Boolean(compactionController) || Boolean(sendPreflightPromise);

        if (chatInput) {
            chatInput.disabled = !isRunning;
            chatInput.placeholder = isRunning
                ? "Type a message..."
                : isLoading
                    ? "Waiting for the model to finish loading..."
                    : "Start llama-server, or connect to a running one on the API tab...";
        }
        if (sendBtn) {
            sendBtn.disabled = !canSend;
            sendBtn.title = isRunning ? "" : "Start llama-server, or connect to a running one on the API tab, before sending chat messages.";
        }
        const container = document.getElementById("chat-messages");
        if (container) {
            for (const button of container.querySelectorAll(".chat-response-action")) {
                button.disabled = chatStreaming || Boolean(compactionController) || (button.dataset.requiresServer === "true" && !isRunning);
            }
        }
        updateCompactionControls();
        if (note) {
            note.classList.toggle("hidden", Boolean(isRunning));
            const message = note.querySelector("span");
            if (message) {
                message.textContent = isLoading
                    ? "llama-server is loading the selected model. Chat will unlock when it is ready."
                    : "Start llama-server, or connect to a running one on the API tab, before sending chat messages.";
            }
        }
    }

    function updateStatusBadge() {
        scheduleContextPreview();
        const runningBadge = document.getElementById("chat-status-badge");
        const noServerBadge = document.getElementById("chat-no-server-badge");
        if (!runningBadge || !noServerBadge) return;

        const isRunning = isServerRunning();
        const lifecycle = getLifecycleSnapshot ? getLifecycleSnapshot() : null;
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

    // llama.cpp b10434+ reports chat_template_caps.supports_reasoning_effort
    // on /props. The cap is boolean-only (it cannot say which levels a model
    // accepts), so an unsupported template only earns an explanatory hint —
    // never a disabled control. Fetched once per server generation.
    let templateCapsKey = null;
    let templateCapsRequest = null;

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
        if (!isServerRunning()) return null;
        const lifecycle = getLifecycleSnapshot ? getLifecycleSnapshot() : null;
        const lifecycleGeneration = lifecycle && lifecycle.activeRuntime
            ? lifecycle.activeRuntime.generation
            : null;
        const latestStatus = getLatestStatus ? getLatestStatus() : null;
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
            templateCapsKey = null;
            templateCapsRequest = null;
            setThinkingEffortCapHint(false);
            return;
        }
        if (key === templateCapsKey || (templateCapsRequest && templateCapsRequest.key === key)) return;
        const request = { key };
        templateCapsRequest = request;
        try {
            const resp = await fetch("/api/llama/props", {
                headers: getApiAuthorizationHeaders({}),
            });
            if (!resp || !resp.ok || typeof resp.json !== "function") return;
            const props = await resp.json();
            if (templateCapsRequest !== request || getTemplateCapsKey() !== key) return;
            const caps = props && props.chat_template_caps;
            templateCapsKey = key;
            setThinkingEffortCapHint(Boolean(caps && caps.supports_reasoning_effort === false));
        } catch (error) {
            console.debug("Could not read chat template capabilities", error);
        } finally {
            if (templateCapsRequest === request) templateCapsRequest = null;
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
        let preferredCollapsed = getStoredItem(storageKey) !== "false";
        const applyLayout = () => setChatPanelCollapsed(panel, openButton, collapseButton,
            chatFocusMode || shouldUseConstrainedChatLayout() || preferredCollapsed);
        chatPanelLayouts.push(applyLayout);
        applyLayout();
        openButton.addEventListener("click", () => {
            if (!chatFocusMode) {
                preferredCollapsed = false;
                setStoredItem(storageKey, "false");
            }
            setChatPanelCollapsed(panel, openButton, collapseButton, false);
            collapseButton.focus();
        });
        collapseButton.addEventListener("click", () => {
            if (!chatFocusMode) {
                preferredCollapsed = true;
                setStoredItem(storageKey, "true");
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
        focusBtn.setAttribute("aria-pressed", String(chatFocusMode));
        focusBtn.title = chatFocusMode ? "Exit Focus Chat" : "Focus Chat";
        const label = document.getElementById("chat-focus-label");
        if (label) label.textContent = chatFocusMode ? "Exit Focus" : "Focus";
    }

    function setChatFocusMode(enabled) {
        chatFocusMode = Boolean(enabled);
        document.body.classList.toggle("chat-focus-mode", chatFocusMode);
        chatPanelLayouts.forEach(applyLayout => applyLayout());
        updateChatFocusButton();
    }

    function onTabChanged(tabId) {
        if (tabId !== "chat" && chatFocusMode) {
            setChatFocusMode(false);
        }
    }

    function showChatSendButton(show) {
        const sendBtn = document.getElementById("btn-chat-send");
        const stopBtn = document.getElementById("btn-chat-stop");
        if (sendBtn) sendBtn.style.display = show ? "flex" : "none";
        if (stopBtn) stopBtn.style.display = show ? "none" : "flex";
        updateChatAvailability(isServerRunning());
    }

    function getChatSamplerParams() {
        const params = {};
        const values = flagCore.getFlagValues();
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

    function buildChatBody(history, draft = "", includeUsage = false) {
        const messages = [];
        const systemPrompt = [
            (document.getElementById("chat-system-prompt")?.value || "").trim(),
            window.LlamaGui.chatTools.getInstructions(),
        ].filter(Boolean).join("\n\n");
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        messages.push(...getChatRequestMessages(compaction.workingMessages(history, chatCompactions.at(-1))));
        if (draft.trim()) messages.push({ role: "user", content: draft.trim() });
        const body = {
            model: getChatModelName(), messages, stream: true,
            ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
            ...getChatSamplerParams(), ...getChatThinkingParams(),
        };
        if (isChatWebSearchEnabled()) {
            body.web_search = true;
            body.web_search_max_results = getChatWebSearchMaxResults();
        }
        const tools = window.LlamaGui.chatTools.getDefinitions();
        if (tools.length) body.tools = tools;
        return body;
    }

    function getCompactionKey() {
        const status = getLatestStatus ? getLatestStatus() : null;
        return JSON.stringify([getTemplateCapsKey(), status?.active_runtime, status?.external_chat_target,
            buildChatBody(chatMessages), document.getElementById("chat-input")?.value || ""]);
    }

    function getChatRuntimeKey() {
        const status = getLatestStatus ? getLatestStatus() : null;
        return JSON.stringify([getTemplateCapsKey(), status?.active_runtime, status?.external_chat_target]);
    }

    function updateCompactionControls() {
        const button = document.getElementById("btn-chat-compact");
        if (!button) return;
        const available = compaction.boundary(chatMessages) > (chatCompactions.at(-1)?.end || 0);
        button.disabled = !compactionController && (!available || chatStreaming || !isServerRunning());
        button.textContent = compactionController ? "Cancel compaction" : "Compact conversation";
        button.title = "Summarize older messages; keep the transcript and last two turns unchanged.";
        for (const id of ["btn-chat-undo-compaction", "btn-chat-tools-undo-compaction"]) {
            const undo = document.getElementById(id);
            if (undo) undo.disabled = chatStreaming || Boolean(compactionController);
        }
        for (const id of ["btn-chat-view-summary", "btn-chat-tools-undo-compaction"]) {
            const action = document.getElementById(id);
            if (action) action.hidden = !chatCompactions.length;
        }
        const trigger = document.getElementById("btn-chat-tools");
        if (trigger) trigger.title = compactionController ? "Compacting conversation — open to cancel" : "Context usage and compaction";
    }

    function renderCompactionMarker() {
        const container = document.getElementById("chat-messages");
        container?.querySelectorAll(".chat-compaction-marker").forEach(el => el.remove());
        const record = chatCompactions.at(-1);
        if (!container || !record) return;
        const marker = document.createElement("details");
        marker.className = "chat-compaction-marker";
        const heading = document.createElement("summary");
        heading.textContent = `Earlier ${record.end} messages compacted · View summary`;
        marker.appendChild(heading);
        const note = document.createElement("p");
        note.textContent = "The original messages remain above. Only this summary and the recent messages are sent to the model. Summaries may omit details; review before continuing.";
        marker.appendChild(note);
        const summary = document.createElement("pre");
        summary.textContent = record.summary;
        marker.appendChild(summary);
        const undo = document.createElement("button");
        undo.id = "btn-chat-undo-compaction";
        undo.type = "button";
        undo.className = "btn btn-xs";
        undo.textContent = "Undo compaction";
        undo.addEventListener("click", undoCompaction);
        marker.appendChild(undo);
        container.insertBefore(marker, container.querySelectorAll(".chat-message")[record.end] || null);
    }

    function undoCompaction() {
        if (chatStreaming || compactionController || !chatCompactions.length) return;
        chatCompactions.pop();
        saveCurrentConversation();
        renderCompactionMarker();
        updateCompactionControls();
        scheduleContextPreview(true);
    }

    function compactConversation(draftOverride = null) {
        if (chatStreaming || compactionController || !isServerRunning()) return Promise.resolve();
        const controller = new AbortController();
        compactionController = controller;
        compactionKey = getCompactionKey();
        cancelContextPreview();
        updateChatAvailability(isServerRunning());
        const status = document.getElementById("chat-compaction-status");
        const report = message => { if (status) { status.textContent = message; status.hidden = !message; } };
        report("Measuring space for a summary…");
        const draft = draftOverride === null ? document.getElementById("chat-input")?.value || "" : draftOverride;
        const pending = (async () => {
            let applied = false;
            try {
                const record = await compaction.compact({
                    messages: chatMessages.map(msg => ({ role: msg.role, content: msg.content, reasoning_content: msg.reasoning || msg.reasoning_content, sources: msg.sources, status: msg.status, toolMessages: msg.toolMessages })),
                    previous: chatCompactions.at(-1), body: buildChatBody(chatMessages),
                    draft, signal: controller.signal,
                    headers: getApiAuthorizationHeaders({ "Content-Type": "application/json" }), onProgress: report,
                });
                if (controller.signal.aborted || !isServerRunning() || compactionKey !== getCompactionKey()) {
                    throw Object.assign(new Error("Chat changed"), { name: "AbortError" });
                }
                chatCompactions.push(record);
                saveCurrentConversation();
                renderCompactionMarker();
                report("");
                applied = true;
            } catch (error) {
                console.debug("Chat compaction did not apply", error);
                report(error.name === "AbortError" ? "Compaction cancelled; previous context kept."
                    : `${error.message} Previous context kept. You can retry Compact conversation.`);
            } finally {
                compactionController = null;
                compactionKey = null;
                updateChatAvailability(isServerRunning());
                scheduleContextPreview(true);
            }
            return applied;
        })();
        compactionPromise = pending;
        pending.then(() => { if (compactionPromise === pending) compactionPromise = null; });
        return pending;
    }

    function setChatToolsOpen(open, showContext = false, restoreFocus = false) {
        const panel = document.getElementById("chat-tools");
        const trigger = document.getElementById("btn-chat-tools");
        if (!panel || !trigger) return;
        panel.hidden = !open;
        trigger.setAttribute("aria-expanded", String(open));
        const details = document.getElementById("chat-context-details");
        if (details && (!open || showContext)) details.open = open;
        if (open) panel.querySelector("summary")?.focus();
        else if (restoreFocus) trigger.focus();
    }

    function initChatTools() {
        const panel = document.getElementById("chat-tools");
        const trigger = document.getElementById("btn-chat-tools");
        if (!panel || !trigger) return;
        trigger.addEventListener("click", () => setChatToolsOpen(panel.hidden));
        document.getElementById("btn-chat-context-details")?.addEventListener("click", () => setChatToolsOpen(true, true));
        document.getElementById("btn-chat-view-summary")?.addEventListener("click", () => {
            setChatToolsOpen(false);
            const marker = document.querySelector(".chat-compaction-marker");
            if (marker) {
                marker.open = true;
                marker.querySelector("summary")?.focus();
                marker.scrollIntoView({ block: "nearest" });
            }
        });
        document.getElementById("btn-chat-tools-undo-compaction")?.addEventListener("click", () => {
            undoCompaction();
            setChatToolsOpen(false, false, true);
        });
        document.addEventListener("click", event => {
            if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)
                && !document.getElementById("btn-chat-context-details")?.contains(event.target)) setChatToolsOpen(false);
        });
        document.addEventListener("keydown", event => {
            if (event.key === "Escape" && !panel.hidden) {
                event.preventDefault();
                setChatToolsOpen(false, false, true);
            }
        });
        document.addEventListener("focusin", event => {
            if (!panel.hidden && !panel.contains(event.target) && event.target !== trigger) setChatToolsOpen(false);
        });
    }

    function renderContextBudget(budget, bodyKey = null) {
        if (budget && (Number.isFinite(budget.prompt_tokens) || budget.status)) {
            latestContextBudget = budget;
            if (bodyKey) latestContextBodyKey = bodyKey;
        }
        const label = document.getElementById("chat-context-label");
        const bar = document.getElementById("chat-context-bar");
        const promptFill = document.getElementById("chat-context-prompt");
        const reserveFill = document.getElementById("chat-context-reserve");
        if (!label || !bar || !promptFill || !reserveFill) return;
        const measured = Number.isFinite(budget.prompt_tokens) && budget.capacity > 0;
        const used = measured ? budget.prompt_tokens : 0;
        const reserve = measured && Number.isFinite(budget.reply_reserve) ? budget.reply_reserve : 0;
        const percent = measured ? Math.min(100, 100 * (used + reserve) / budget.capacity) : 0;
        bar.hidden = !measured;
        bar.setAttribute("aria-valuenow", String(Math.round(percent)));
        bar.dataset.status = budget.status;
        promptFill.style.width = `${measured ? Math.min(100, 100 * used / budget.capacity) : 0}%`;
        reserveFill.style.width = `${measured ? Math.max(0, Math.min(100 - 100 * used / budget.capacity, 100 * reserve / budget.capacity)) : 0}%`;
        label.textContent = measured
            ? `${used.toLocaleString()} prompt + ${reserve.toLocaleString()} reply ${budget.reserve_source === "planning" ? "headroom" : "reserved"} / ${budget.capacity.toLocaleString()} tokens. ${Math.max(0, budget.remaining).toLocaleString()} free. ${budget.message || ""}`
            : budget.message || "Context count unavailable.";
        if (budget.search_pending) label.textContent += " Web results are added and checked when you send.";
        if (budget.includes_search) label.textContent += " Includes web results.";
        bar.setAttribute("aria-valuetext", label.textContent);
        const warning = document.getElementById("chat-context-warning");
        const warningText = document.getElementById("chat-context-warning-text");
        if (warning && warningText) {
            warning.hidden = !["warning", "overflow"].includes(budget.status);
            warningText.textContent = budget.status === "overflow"
                ? "This request exceeds the context limit." : "Context is nearly full.";
        }
    }

    function cancelContextPreview() {
        contextRevision += 1;
        if (contextTimer !== null) clearTimeout(contextTimer);
        contextTimer = null;
        if (contextController) contextController.abort();
        contextController = null;
    }

    function contextBodyKey(body) {
        return JSON.stringify(body || {});
    }

    function isAutoCompactionEnabled() {
        const toggle = document.getElementById("chat-auto-compact-toggle");
        if (toggle) return Boolean(toggle.checked);
        return getStoredItem(CHAT_AUTO_COMPACTION_STORAGE_KEY) === "true";
    }

    function setAutoCompactionEnabled(enabled) {
        const value = Boolean(enabled);
        const toggle = document.getElementById("chat-auto-compact-toggle");
        if (toggle) toggle.checked = value;
        setStoredItem(CHAT_AUTO_COMPACTION_STORAGE_KEY, String(value));
    }

    function ensureAutoCompactionControl() {
        let toggle = document.getElementById("chat-auto-compact-toggle");
        if (!toggle) {
            const compactButton = document.getElementById("btn-chat-compact");
            const parent = compactButton?.parentNode;
            if (!parent || typeof document.createElement !== "function") return null;
            const label = document.createElement("label");
            label.className = "chat-auto-compact-setting";
            toggle = document.createElement("input");
            toggle.type = "checkbox";
            toggle.id = "chat-auto-compact-toggle";
            const text = document.createElement("span");
            text.textContent = "Compact automatically when context is nearly full";
            label.appendChild(toggle);
            label.appendChild(text);
            parent.appendChild(label);
        }
        toggle.checked = getStoredItem(CHAT_AUTO_COMPACTION_STORAGE_KEY) === "true";
        toggle.title = "Before sending, summarize older turns only when the current context preview is near or over capacity.";
        toggle.setAttribute("aria-label", "Compact automatically when context is nearly full");
        if (!toggle.dataset.chatAutoCompactionWired) {
            toggle.dataset.chatAutoCompactionWired = "1";
            toggle.addEventListener("change", () => {
                setAutoCompactionEnabled(toggle.checked);
                scheduleContextPreview(true);
            });
        }
        return toggle;
    }

    function ensureEditStatusControl() {
        if (document.getElementById("chat-edit-status")) return document.getElementById("chat-edit-status");
        const input = document.getElementById("chat-input");
        const parent = input?.parentNode;
        if (!parent || typeof document.createElement !== "function") return null;
        const status = document.createElement("div");
        status.id = "chat-edit-status";
        status.hidden = true;
        const message = document.createElement("span");
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn btn-xs";
        cancel.textContent = "Cancel edit";
        cancel.addEventListener("click", cancelEdit);
        status.appendChild(message);
        status.appendChild(cancel);
        parent.appendChild(status);
        return status;
    }

    function scheduleContextPreview(force = false) {
        if (!document.getElementById("chat-context-label") || !flagCore) return;
        const status = getLatestStatus ? getLatestStatus() : null;
        const body = buildChatBody(chatMessages, document.getElementById("chat-input")?.value || "");
        const key = JSON.stringify([getTemplateCapsKey(), status?.active_runtime,
            status?.external_chat_target, body]);
        if (!force && key === contextKey) return;
        contextKey = key;
        cancelContextPreview();
        if (compactionController) {
            if (!isServerRunning() || compactionKey !== getCompactionKey()) compactionController.abort();
            return;
        }
        if (!isServerRunning()) {
            latestContextBudget = null;
            latestContextBodyKey = null;
            renderContextBudget({ message: "Start or connect to a server to measure context." });
            return;
        }
        if (chatStreaming) return;
        if (!body.messages.some(msg => msg.role !== "system" && msg.role !== "developer")) {
            latestContextBudget = null;
            latestContextBodyKey = null;
            renderContextBudget({ status: "empty", message: "Type a message to measure context." });
            return;
        }
        renderContextBudget({ message: "Measuring context…" });
        const revision = contextRevision;
        contextTimer = setTimeout(() => {
            contextTimer = null;
            void refreshContextPreview(body, revision);
        }, 500);
    }

    async function refreshContextPreview(body, revision) {
        const controller = new AbortController();
        contextController = controller;
        try {
            const response = await fetch("/api/chat/context", {
                method: "POST", headers: getApiAuthorizationHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify(body), signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const budget = await response.json();
            if (revision === contextRevision && !chatStreaming) {
                renderContextBudget(budget, contextBodyKey(body));
                return budget;
            }
            return null;
        } catch (error) {
            if (error.name !== "AbortError" && revision === contextRevision) {
                console.debug("Could not measure chat context", error);
                renderContextBudget({ message: "Context count unavailable; the server will validate the request." });
            }
            return null;
        } finally {
            if (contextController === controller) contextController = null;
        }
    }

    async function maybeCompactBeforeSend(userText, attemptToken, retry = false) {
        if (attemptToken !== sendAttemptToken) return false;
        if (!isAutoCompactionEnabled() || autoCompactionAttempted || pendingEdit) return true;
        const replacementIndex = retry && chatMessages[chatMessages.length - 1]?.role === "assistant"
            ? chatMessages.length - 1 : -1;
        const history = replacementIndex >= 0 ? chatMessages.slice(0, replacementIndex) : chatMessages;
        const draft = replacementIndex >= 0 ? "" : userText;
        const body = buildChatBody(history, draft);
        const runtimeKey = getChatRuntimeKey();
        const stale = () => attemptToken !== sendAttemptToken || runtimeKey !== getChatRuntimeKey();
        cancelContextPreview();
        const revision = contextRevision;
        const budget = await refreshContextPreview(body, revision);
        if (stale()) return false;
        const key = contextBodyKey(body);
        const nearFull = budget && ["warning", "overflow"].includes(budget.status)
            && latestContextBodyKey === key;
        if (!nearFull || compaction.boundary(chatMessages) <= (chatCompactions.at(-1)?.end || 0)) return true;

        autoCompactionAttempted = true;
        const compacted = await compactConversation(draft);
        if (stale()) return false;
        if (!compacted) return false;

        const afterHistory = replacementIndex >= 0 ? chatMessages.slice(0, replacementIndex) : chatMessages;
        const afterBody = buildChatBody(afterHistory, draft);
        cancelContextPreview();
        const afterRevision = contextRevision;
        const measured = await refreshContextPreview(afterBody, afterRevision);
        if (stale()) return false;
        if (!measured) {
            const status = document.getElementById("chat-compaction-status");
            if (status) {
                status.textContent = "The summary was saved, but context could not be rechecked. Sending is paused; try again when the server is ready.";
                status.hidden = false;
            }
            return false;
        }
        if (measured.status === "overflow") {
            const status = document.getElementById("chat-compaction-status");
            if (status) {
                status.textContent = "The compacted context still exceeds the limit. Shorten the draft, lower Max Tokens, or increase context before sending.";
                status.hidden = false;
            }
            return false;
        }
        return true;
    }

    function sendMessage(userText, retry = false) {
        if (chatStreaming || compactionController || sendPreflightPromise || !userText.trim()) return Promise.resolve();
        autoCompactionAttempted = false;
        const attemptToken = ++sendAttemptToken;
        const pending = runMessage(userText, retry, attemptToken);
        sendPreflightPromise = pending;
        chatStreamPromise = pending;
        const clearPending = () => {
            if (chatStreamPromise === pending) chatStreamPromise = null;
            if (sendPreflightPromise === pending) {
                sendPreflightPromise = null;
                updateChatAvailability(isServerRunning());
            }
        };
        pending.then(clearPending, clearPending);
        return pending;
    }

    function getChatMessagesContainer() {
        return document.getElementById("chat-messages");
    }

    function isChatNearBottom(container) {
        return !container || renderingIsChatNearBottom(container);
    }

    function updateChatJumpButton(show) {
        const button = document.getElementById("btn-chat-jump-latest");
        if (!button) return;
        button.hidden = !show;
        button.setAttribute("aria-hidden", String(!show));
        button.textContent = "Jump to latest";
    }

    function captureChatScrollState() {
        const container = getChatMessagesContainer();
        const follow = isChatNearBottom(container);
        chatScrollState = { follow, top: container ? container.scrollTop : 0 };
        updateChatJumpButton(!follow);
        return chatScrollState;
    }

    function followChatOutput() {
        const container = getChatMessagesContainer();
        if (!container || !chatScrollState?.follow) {
            if (container && chatScrollState) container.scrollTop = chatScrollState.top;
            updateChatJumpButton(Boolean(chatScrollState && !chatScrollState.follow));
            return;
        }
        renderingScrollChatToLatest(container);
        updateChatJumpButton(false);
    }

    function restoreChatScrollPosition() {
        const container = getChatMessagesContainer();
        if (container && chatScrollState && !chatScrollState.follow) container.scrollTop = chatScrollState.top;
    }

    function jumpToLatest() {
        const container = getChatMessagesContainer();
        if (!container) return;
        chatScrollState = { follow: true, top: container.scrollHeight };
        renderingScrollChatToLatest(container);
        updateChatJumpButton(false);
    }

    function wireChatScrollControls() {
        const container = getChatMessagesContainer();
        const button = document.getElementById("btn-chat-jump-latest");
        if (button && !button.dataset.chatJumpWired) {
            button.dataset.chatJumpWired = "1";
            button.addEventListener("click", jumpToLatest);
        }
        if (container && !container.dataset.chatScrollWired) {
            container.dataset.chatScrollWired = "1";
            container.addEventListener("scroll", () => {
                const near = isChatNearBottom(container);
                if (chatScrollState) {
                    chatScrollState.follow = near;
                    if (!near) chatScrollState.top = container.scrollTop;
                }
                updateChatJumpButton(!near);
            });
        }
    }

    function updateResponseMetadata(metadata, event, finishReason) {
        if (event?.usage && typeof event.usage === "object") metadata.usage = { ...event.usage };
        if (event?.timings && typeof event.timings === "object") metadata.timings = { ...event.timings };
        if (finishReason) metadata.stop_reason = String(finishReason);
    }

    async function editUserMessage(index) {
        if (chatStreaming || compactionController || !chatMessages[index] || chatMessages[index].role !== "user") return false;
        const stored = getStoredConversations();
        const active = currentConversationId && stored.find(item => item.id === currentConversationId);
        const backupTitle = `${active?.title || generateConversationTitle(chatMessages)} — before edit`;
        const confirmed = typeof confirmAction === "function"
            ? await confirmAction("Edit and resend", `A selectable history copy named “${backupTitle}” will preserve the current conversation and later turns. The active conversation will be truncated only when you resend. Continue?`, "Edit message")
            : true;
        if (!confirmed) return false;
        const input = document.getElementById("chat-input");
        if (!input) return false;
        pendingEdit = {
            index,
            originalText: chatMessages[index].content,
            tail: chatMessages.slice(index + 1),
        };
        input.value = chatMessages[index].content || "";
        input.focus?.();
        const status = document.getElementById("chat-edit-status");
        if (status) {
            if (status.children[0]) status.children[0].textContent = `A history copy named “${backupTitle}” will preserve later turns when you resend.`;
            status.hidden = false;
        }
        return true;
    }

    function cancelEdit() {
        if (!pendingEdit) return;
        const input = document.getElementById("chat-input");
        if (input) input.value = pendingEdit.originalText || "";
        discardPendingEdit();
        const status = document.getElementById("chat-edit-status");
        if (status) { if (status.children[0]) status.children[0].textContent = ""; status.hidden = true; }
    }

    function discardPendingEdit() {
        pendingEdit = null;
        const status = document.getElementById("chat-edit-status");
        if (status) { if (status.children[0]) status.children[0].textContent = ""; status.hidden = true; }
    }

    function createConversationId() {
        return (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
            ? crypto.randomUUID()
            : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0;
                return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
              });
    }

    function persistEditBranch(edit) {
        if (!edit) return false;
        const conversations = getStoredConversations();
        const existing = currentConversationId && conversations.find(item => item.id === currentConversationId);
        if (!existing) return false;
        let backup;
        try {
            backup = JSON.parse(JSON.stringify(existing));
        } catch (error) {
            console.warn("Could not prepare the before-edit history copy", error);
            return false;
        }
        const baseTitle = existing.title || generateConversationTitle(existing.messages || chatMessages);
        backup.id = createConversationId();
        backup.title = `${baseTitle} — before edit`;
        backup.titleCustom = true;
        backup.timestamp = Date.now();
        backup.backupOf = existing.id;
        return saveConversationsToStorage([backup, ...conversations]);
    }

    function finalizeAssistantResponse(content, reasoning, sources, status, error, replacementIndex, metadata = {}, toolMessages = []) {
        let finalContent = content;
        let finalReasoning = reasoning;
        if (!finalReasoning && shouldExtractEmbeddedReasoning()) {
            const split = splitReasoningFromContent(finalContent);
            if (split.reasoning) {
                finalContent = split.content;
                finalReasoning = split.reasoning;
            }
        }
        const result = { content: finalContent, reasoning: finalReasoning, sources, status, error, metadata };
        if (toolMessages.length) result.toolMessages = toolMessages;
        const previous = replacementIndex >= 0 ? chatMessages[replacementIndex] : null;
        if (previous) {
            const versions = Array.isArray(previous.versions) ? previous.versions.slice() : [{
                content: previous.content, reasoning: previous.reasoning || "",
                sources: previous.sources || [], status: previous.status || "complete", error: previous.error || "",
                metadata: previous.metadata || {},
                ...(previous.toolMessages ? { toolMessages: previous.toolMessages } : {}),
            }];
            versions.push(result);
            // An unsuccessful attempt is still recoverable, but never replaces
            // the answer the user was reading. Only completed output is selected.
            const selected = status === "complete" || status === "length"
                ? versions.length - 1 : (previous.versionIndex || 0);
            chatMessages[replacementIndex] = {
                role: "assistant", ...versions[selected], versions, versionIndex: selected,
            };
        } else {
            chatMessages.push({ role: "assistant", ...result });
        }
        saveCurrentConversation();
        renderConversationMessages(replacementIndex >= 0 ? replacementIndex : chatMessages.length - 1);
    }

    function renderConversationMessages(startIndex = 0) {
        const container = document.getElementById("chat-messages");
        const previousElements = Array.from(container.querySelectorAll(".chat-message"));
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = chatMessages.length ? "none" : "";
        chatMessages.forEach((msg, index) => {
            if (index < startIndex) {
                // Earlier assistant actions no longer target the latest turn,
                // while user edit actions remain available for every turn.
                if (msg.role === "assistant") {
                    previousElements[index]?.querySelectorAll(".chat-response-action").forEach(el => el.remove());
                }
                return;
            }
            const bubble = renderChatMessage(msg.role, msg.content, { reasoning: msg.reasoning });
            const previousElement = previousElements[index];
            if (previousElement) {
                container.insertBefore(bubble.closest(".chat-message"), previousElement);
                previousElement.remove();
            }
            if (msg.role !== "assistant") {
                const footer = document.createElement("div");
                footer.className = "chat-response-footer chat-user-footer";
                const editButton = document.createElement("button");
                editButton.type = "button";
                editButton.className = "btn btn-xs chat-response-action";
                editButton.textContent = "Edit and resend";
                editButton.addEventListener("click", () => { void editUserMessage(index); });
                footer.appendChild(editButton);
                bubble.closest(".chat-message-content")?.appendChild(footer);
                return;
            }
            renderChatSources(bubble, msg.sources);
            window.LlamaGui.chatTools.renderResults(bubble, msg.toolMessages);
            setChatResponseMetadata(bubble, msg.metadata || {});
            if (!msg.content) bubble.classList.add("hidden");
            const footer = document.createElement("div");
            footer.className = "chat-response-footer";
            const label = document.createElement("span");
            label.className = "chat-response-status";
            label.textContent = msg.status === "failed" ? `Incomplete — ${msg.error || "Request failed"}`
                : msg.status === "stopped" ? "Stopped — response may be incomplete"
                : msg.status === "length" ? "Output limit reached" : "";
            footer.appendChild(label);
            const latest = index === chatMessages.length - 1;
            const addAction = (text, action, requiresServer = false) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "btn btn-xs chat-response-action";
                button.textContent = text;
                button.dataset.requiresServer = String(requiresServer);
                button.addEventListener("click", () => {
                    if (!chatStreaming && !compactionController && chatMessages[index] === msg) return action();
                });
                footer.appendChild(button);
            };
            if (Array.isArray(msg.versions) && msg.versions.length > 1) {
                const selected = msg.versionIndex || 0;
                const versionLabel = document.createElement("span");
                versionLabel.textContent = `Answer ${selected + 1} of ${msg.versions.length}`;
                footer.appendChild(versionLabel);
                const lastAttempt = msg.versions[msg.versions.length - 1];
                if (selected < msg.versions.length - 1 && ["failed", "stopped"].includes(lastAttempt.status)) {
                    label.textContent += `${label.textContent ? ". " : ""}Latest attempt ${lastAttempt.status}; previous answer kept.`;
                }
                // Choosing a different answer after later turns would rewrite
                // their context. Branch/edit support is a separate change.
                const selectVersion = (value) => {
                    chatMessages[index] = { role: "assistant", ...msg.versions[value], versions: msg.versions, versionIndex: value };
                    saveCurrentConversation();
                    renderConversationMessages(index);
                };
                if (latest && selected > 0) addAction("Previous answer", () => selectVersion(selected - 1));
                if (latest && selected < msg.versions.length - 1) addAction("Next answer", () => selectVersion(selected + 1));
            }
            const lastAttempt = Array.isArray(msg.versions) ? msg.versions[msg.versions.length - 1] : msg;
            if (latest && [msg.status, lastAttempt.status].some(value => ["failed", "stopped", "length"].includes(value))) {
                addAction("Retry", regenerateResponse, true);
            }
            bubble.closest(".chat-message-content").appendChild(footer);
        });
        previousElements.slice(chatMessages.length).forEach(el => el.remove());
        renderCompactionMarker();
        updateChatAvailability(isServerRunning());
        scheduleContextPreview();
    }

    async function runMessage(userText, retry = false, attemptToken = sendAttemptToken) {
        if (chatStreaming || compactionController || !userText.trim()) return;
        if (!isServerRunning()) {
            updateStatusBadge();
            return;
        }

        const trimmedText = userText.trim();
        if (!await maybeCompactBeforeSend(trimmedText, attemptToken, retry) || attemptToken !== sendAttemptToken) return;
        const editing = pendingEdit && !retry ? pendingEdit : null;
        if (editing && (editing.index >= chatMessages.length || chatMessages[editing.index]?.role !== "user")) {
            cancelEdit();
            return;
        }
        captureChatScrollState();

        cancelContextPreview();
        const replacementIndex = retry && chatMessages[chatMessages.length - 1]?.role === "assistant"
            ? chatMessages.length - 1 : -1;
        if (editing) {
            if (!persistEditBranch(editing)) {
                const editStatus = document.getElementById("chat-edit-status");
                if (editStatus) {
                    if (editStatus.children[0]) editStatus.children[0].textContent = "The before-edit history copy could not be saved. Your original conversation is still intact; try again or cancel.";
                    editStatus.hidden = false;
                }
                return;
            }
            chatMessages = chatMessages.slice(0, editing.index + 1);
            chatMessages[editing.index] = { ...chatMessages[editing.index], content: trimmedText };
            chatCompactions = chatCompactions.filter(record => record.end <= editing.index);
            pendingEdit = null;
            const editStatus = document.getElementById("chat-edit-status");
            if (editStatus) { if (editStatus.children[0]) editStatus.children[0].textContent = ""; editStatus.hidden = true; }
            renderConversationMessages(editing.index);
            saveCurrentConversation();
        } else if (!retry) {
            chatMessages.push({ role: "user", content: trimmedText });
            renderConversationMessages(chatMessages.length - 1);
            saveCurrentConversation();
        }

        const chatInput = document.getElementById("chat-input");
        if (!retry) {
            chatInput.value = "";
            chatInput.style.height = "auto";
        }

        chatStreaming = true;
        showChatSendButton(false);
        renderChatTypingIndicator();
        restoreChatScrollPosition();

        const body = buildChatBody(replacementIndex >= 0 ? chatMessages.slice(0, replacementIndex) : chatMessages, "", true);
        renderContextBudget({ message: body.web_search ? "Waiting for web results before measuring context…" : "Checking context before generating…" });

        chatAbortController = new AbortController();
        let bubble = null;
        let fullContent = "";
        let fullReasoning = "";
        let responseSources = [];
        let status = "complete";
        let error = "";
        const responseMetadata = {};
        const toolMessages = [];
        let reader = null;

        try {
            // One date/time exchange per answer, then require a final response.
            for (let round = 0; round < 2; round += 1) {
                chatAbortController.signal.throwIfAborted();
                const toolCalls = [];
                let roundFinishReason = "";
                const resp = await fetch("/api/chat/completions", {
                    method: "POST",
                    headers: getApiAuthorizationHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(body),
                    signal: chatAbortController.signal,
                });

                removeChatTypingIndicator();

                if (!resp.ok) {
                    const errText = await resp.text().catch(() => resp.statusText);
                    throw new Error(`HTTP ${resp.status} - ${errText}`);
                }

                if (!resp.body) {
                    throw new Error("Response body is empty.");
                }
                bubble = renderChatMessage("assistant", "");
                reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let streamDone = false;
                let receivedFinish = false;

                while (!streamDone) {
                    const { done, value } = await reader.read();
                    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    if (done && buffer) {
                        lines.push(buffer);
                        buffer = "";
                    }

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith("data:")) continue;
                        const data = trimmed.slice(5).trimStart();
                        if (data === "[DONE]") {
                            streamDone = true;
                            setChatWebStatus(bubble, "");
                            break;
                        }

                        let parsed;
                        try {
                            parsed = JSON.parse(data);
                        } catch (e) {
                            console.debug("Skipping malformed chat stream chunk", e);
                            continue;
                        }
                        if (parsed.type === "context_budget") {
                            renderContextBudget(parsed);
                            continue;
                        }
                        if (parsed.type === "web_status") {
                            setChatWebStatus(bubble, parsed.content || "");
                            continue;
                        }
                        if (parsed.type === "web_sources") {
                            responseSources = parsed.sources || [];
                            renderChatSources(bubble, responseSources);
                            continue;
                        }
                        if (parsed.error) {
                            const message = parsed.error.message || "Unknown error";
                            throw new Error(message);
                        }
                        const delta = parsed.choices?.[0]?.delta;
                        const finishReason = parsed.choices?.[0]?.finish_reason;
                        if (finishReason) {
                            roundFinishReason = finishReason;
                            receivedFinish = true;
                            updateResponseMetadata(responseMetadata, parsed, finishReason);
                            if (finishReason === "length") status = "length";
                        }
                        updateResponseMetadata(responseMetadata, parsed);
                        if (delta?.tool_calls !== undefined) {
                            if (!body.tools?.length) throw new Error("The model requested a tool while Chat tools are disabled.");
                            window.LlamaGui.chatTools.collectCalls(toolCalls, delta.tool_calls);
                        }
                        const reasoningDelta = getChatDeltaText(delta, ["reasoning_content", "reasoning"]);
                        if (reasoningDelta) {
                            fullReasoning += reasoningDelta;
                            appendChatReasoningStreamToken(bubble, reasoningDelta);
                            followChatOutput();
                        }
                        const contentDelta = getChatDeltaText(delta, ["content"]);
                        if (contentDelta) {
                            fullContent += contentDelta;
                            appendChatStreamToken(bubble, contentDelta);
                            followChatOutput();
                        }
                    }
                    if (done) {
                        if (!streamDone && !receivedFinish) throw new Error("Connection closed before the response completed.");
                        break;
                    }
                }

                await reader.cancel().catch(e => console.debug("Failed to close chat stream reader", e));
                reader = null;
                // Conversation changes await this stream. Check abort after the last
                // await before executing tools and removing the provisional message.
                chatAbortController.signal.throwIfAborted();
                if (toolCalls.length || roundFinishReason === "tool_calls") {
                    if (round > 0) throw new Error("The model requested more tools instead of answering. Retry the reply.");
                    if (!toolCalls.length || roundFinishReason !== "tool_calls") {
                        throw new Error("The date/time tool call was incomplete. Retry the reply.");
                    }
                    const results = window.LlamaGui.chatTools.executeCalls(toolCalls);
                    toolMessages.push({
                        role: "assistant", content: fullContent, tool_calls: toolCalls,
                        ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
                    }, ...results);
                    body.messages.push(...toolMessages);
                    body.tool_choice = "none";
                    fullContent = "";
                    fullReasoning = "";
                    for (const key of Object.keys(responseMetadata)) delete responseMetadata[key];
                    bubble.closest(".chat-message").remove();
                    bubble = null;
                    renderChatTypingIndicator();
                    continue;
                }
                break;
            }

            if (!fullContent && !fullReasoning) throw new Error("The server returned no answer.");
        } catch (e) {
            removeChatTypingIndicator();
            if (e.name === "AbortError") {
                status = "stopped";
            } else {
                status = "failed";
                error = e.message || "Request failed.";
            }
        } finally {
            if (reader) await reader.cancel().catch((e) => console.debug("Failed to close chat stream reader", e));
            removeChatTypingIndicator();
            finalizeAssistantResponse(fullContent, fullReasoning, responseSources, status, error, replacementIndex, responseMetadata, toolMessages);
            chatStreaming = false;
            chatAbortController = null;
            showChatSendButton(true);
            updateChatAvailability(isServerRunning());
            if (chatScrollState?.follow) followChatOutput();
            else updateChatJumpButton(true);
            if (status !== "failed") scheduleContextPreview(true);
            const chatInput = document.getElementById("chat-input");
            if (chatInput) chatInput.focus();
        }
    }

    function stopStream() {
        if (chatAbortController) {
            chatAbortController.abort();
        }
        removeChatTypingIndicator();
    }

    async function abortActiveStream() {
        sendAttemptToken += 1;
        cancelContextPreview();
        const compactPending = compactionPromise;
        if (compactionController) compactionController.abort();
        if (compactPending) await compactPending;
        const pending = chatStreamPromise;
        stopStream();
        if (pending) {
            await pending.catch((error) => console.debug("Chat stream did not settle cleanly", error));
        }
    }

    function addModelTransitionDivider(previousLabel, nextLabel) {
        const container = document.getElementById("chat-messages");
        if (!container) return;
        const previousScroll = captureChatScrollState();
        const divider = document.createElement("div");
        divider.className = "chat-model-divider";
        divider.setAttribute("role", "separator");
        const from = String(previousLabel || "previous model").trim() || "previous model";
        const to = String(nextLabel || "new model").trim() || "new model";
        divider.textContent = `Model switched: ${from} → ${to}`;
        container.appendChild(divider);
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "none";
        if (previousScroll.follow) followChatOutput();
        else restoreChatScrollPosition();
    }

    function undoMessage() {
        if (chatStreaming || compactionController || chatMessages.length === 0) return;
        chatMessages.pop();
        while (chatCompactions.length && !compaction.valid(chatCompactions.at(-1), chatMessages)) chatCompactions.pop();
        const container = document.getElementById("chat-messages");
        const msgs = container.querySelectorAll(".chat-message");
        if (msgs.length > 0) msgs[msgs.length - 1].remove();

        if (chatMessages.length === 0) {
            const empty = document.getElementById("chat-empty");
            if (empty) empty.style.display = "";
            if (currentConversationId) {
                const conversations = getStoredConversations();
                saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId));
                currentConversationId = null;
                renderHistoryList();
            }
        } else {
            saveCurrentConversation();
        }
        renderConversationMessages(Math.max(0, chatMessages.length - 1));
    }

    function regenerateResponse() {
        if (chatStreaming || compactionController || !isServerRunning() || chatMessages.length === 0) return Promise.resolve();
        const lastIndex = chatMessages.length - 1;
        const userIndex = chatMessages[lastIndex].role === "assistant" ? lastIndex - 1 : lastIndex;
        const userMessage = chatMessages[userIndex];
        if (!userMessage || userMessage.role !== "user") return Promise.resolve();
        return sendMessage(userMessage.content, true);
    }

    function getStoredConversations() {
        try {
            const parsed = JSON.parse(getStoredItem(CHAT_CONVERSATIONS_STORAGE_KEY) || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.debug("Failed to read stored conversations", e);
            return [];
        }
    }

    function renderHistoryRetention(count = getStoredConversations().length) {
        const label = document.getElementById("chat-history-retention");
        if (!label) return;
        label.textContent = historyRetentionNotice
            ? `History keeps ${CHAT_MAX_STORED_CONVERSATIONS} conversations; older entries have been removed.`
            : `History retention: ${count} of ${CHAT_MAX_STORED_CONVERSATIONS} conversations saved.`;
    }

    let historyRetentionNotice = false;

    function saveConversationsToStorage(list) {
        const all = Array.isArray(list) ? list : [];
        const pruned = all.slice(0, CHAT_MAX_STORED_CONVERSATIONS);
        const saved = setStoredItem(CHAT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(pruned));
        historyRetentionNotice = saved && all.length > CHAT_MAX_STORED_CONVERSATIONS;
        if (!saved && typeof window.showToast === "function") {
            window.showToast("Conversation history could not be saved. Your active chat remains available for this session.", "warning");
        }
        renderHistoryRetention(pruned.length);
        return saved;
    }

    function saveCurrentConversation() {
        if (chatMessages.length === 0 && !currentConversationId) return true;
        const sysPrompt = document.getElementById("chat-system-prompt");
        const conversations = getStoredConversations();
        const existing = currentConversationId
            ? conversations.find(c => c.id === currentConversationId)
            : null;

        if (existing) {
            existing.messages = chatMessages.slice();
            existing.compactions = chatCompactions.slice();
            existing.systemPrompt = sysPrompt ? sysPrompt.value : "";
            existing.thinkingEffort = getChatThinkingEffort();
            existing.timestamp = Date.now();
            if (!existing.title) existing.title = generateConversationTitle(chatMessages);
        } else {
            const convo = {
                id: createConversationId(),
                title: generateConversationTitle(chatMessages),
                messages: chatMessages.slice(),
                compactions: chatCompactions.slice(),
                systemPrompt: sysPrompt ? sysPrompt.value : "",
                thinkingEffort: getChatThinkingEffort(),
                timestamp: Date.now()
            };
            conversations.unshift(convo);
            currentConversationId = convo.id;
        }

        const saved = saveConversationsToStorage(conversations);
        renderHistoryList();
        return saved;
    }

    function generateConversationTitle(messages) {
        const first = messages.find(m => m.role === "user");
        if (!first) return "Untitled";
        const text = first.content.trim().replace(/\n/g, " ");
        return text.length > 50 ? text.slice(0, 50) + "..." : text;
    }

    async function loadConversation(id) {
        reportCharacterImport();
        setChatToolsOpen(false);
        // Must await: abort() rejects the pending read on a later microtask, so a
        // bare stopStream() lets the AbortError handler run after the reassignments
        // below and finalize the old reply into the conversation we just loaded.
        if (chatStreaming || compactionController || sendPreflightPromise) await abortActiveStream();
        discardPendingEdit();

        // Read storage only after the abort has settled: finalizing the aborted
        // reply writes to storage, so a snapshot taken earlier would be stale and
        // reloading the streaming conversation would drop the in-flight turn.
        const conversations = getStoredConversations();
        const convo = conversations.find(c => c.id === id);
        if (!convo) return;

        currentConversationId = convo.id;
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        chatMessages = convo.messages.slice();
        chatCompactions = (Array.isArray(convo.compactions) ? convo.compactions : [])
            .filter(record => compaction.valid(record, chatMessages));

        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) {
            sysPrompt.value = convo.systemPrompt || "";
            if (sysCharCount) sysCharCount.textContent = (convo.systemPrompt || "").length + " chars";
        }
        setChatThinkingEffort(convo.thinkingEffort);

        renderConversationMessages();

        renderHistoryList();
        if (snapshotStatsBaseline) snapshotStatsBaseline();
    }

    function renameConversation(id, title) {
        const normalized = String(title || "").trim().replace(/\s+/g, " ");
        if (!normalized) return false;
        const conversations = getStoredConversations();
        const convo = conversations.find(item => item.id === id);
        if (!convo) return false;
        const previous = convo.title;
        convo.title = normalized.slice(0, 120);
        convo.titleCustom = true;
        if (!saveConversationsToStorage(conversations)) {
            convo.title = previous;
            return false;
        }
        renderHistoryList();
        return true;
    }

    function requestConversationRename(id) {
        const convo = getStoredConversations().find(item => item.id === id);
        if (!convo) return;
        const prompt = typeof window.prompt === "function" ? window.prompt("Conversation name", convo.title || "") : "";
        if (prompt !== null && prompt !== undefined) renameConversation(id, prompt);
    }

    function exportConversation(id, format = "json") {
        const convo = getStoredConversations().find(item => item.id === id);
        if (!convo) return "";
        const isText = format === "text";
        const data = isText
            ? convo.messages.map(message => `${String(message.role || "").toUpperCase()}:\n${message.content || ""}`).join("\n\n")
            : JSON.stringify(convo, null, 2);
        if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || !document.createElement) return data;
        const blob = new Blob([data], { type: isText ? "text/plain" : "application/json" });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = `${(convo.title || "conversation").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "conversation"}.${isText ? "txt" : "json"}`;
        anchor.click();
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(href);
        return data;
    }

    function resetActiveChatState() {
        currentConversationId = null;
        chatMessages = [];
        chatCompactions = [];
        discardPendingEdit();
        const container = document.getElementById("chat-messages");
        container?.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        renderCompactionMarker();
        updateCompactionControls();
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        setChatThinkingEffort("auto");
        scheduleContextPreview(true);
    }

    async function deleteConversation(id) {
        if (currentConversationId === id && (chatStreaming || compactionController || sendPreflightPromise)) await abortActiveStream();
        const conversations = getStoredConversations();
        const deleted = conversations.find(c => c.id === id);
        if (!deleted) return false;
        const filtered = conversations.filter(c => c.id !== id);
        if (!saveConversationsToStorage(filtered)) return false;
        if (currentConversationId === id) resetActiveChatState();

        renderHistoryList();
        return true;
    }

    async function deleteAllConversations() {
        if (chatStreaming || compactionController || sendPreflightPromise) await abortActiveStream();
        if (!saveConversationsToStorage([])) return false;
        resetActiveChatState();
        renderHistoryList();
        return true;
    }

    async function startNewChat() {
        reportCharacterImport();
        setChatToolsOpen(false);
        // Stop before saving: an in-flight stream would otherwise keep appending
        // tokens into the fresh chat and leave the composer disabled.
        if (chatStreaming || compactionController || sendPreflightPromise) await abortActiveStream();
        discardPendingEdit();
        saveCurrentConversation();
        currentConversationId = null;
        chatMessages = [];
        chatCompactions = [];
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        renderCompactionMarker();
        updateCompactionControls();
        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        setChatThinkingEffort("auto");
        scheduleContextPreview(true);
        renderHistoryList();
        if (snapshotStatsBaseline) snapshotStatsBaseline();
    }

    function renderHistoryList() {
        const list = document.getElementById("chat-history-list");
        if (!list) return;

        const conversations = getStoredConversations();
        list.innerHTML = "";
        renderHistoryRetention(conversations.length);
        const query = chatHistoryFilter.trim().toLocaleLowerCase();
        const visibleConversations = query
            ? conversations.filter(convo => `${convo.title || ""} ${JSON.stringify(convo.messages || [])}`.toLocaleLowerCase().includes(query))
            : conversations;

        if (visibleConversations.length === 0) {
            const empty = document.createElement("div");
            empty.className = "chat-history-empty";
            empty.textContent = query ? "No conversations match your search" : "No saved conversations";
            list.appendChild(empty);
            return;
        }

        for (const convo of visibleConversations) {
            const item = document.createElement("div");
            item.className = "chat-history-item" + (convo.id === currentConversationId ? " active" : "");

            const header = document.createElement("div");
            header.className = "chat-history-item-header";

            const title = document.createElement("div");
            title.className = "chat-history-item-title";
            title.textContent = convo.title;

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "btn btn-xs chat-history-item-delete";
            deleteBtn.textContent = "Delete";
            deleteBtn.title = "Delete conversation";
            deleteBtn.setAttribute("aria-label", "Delete conversation");
            deleteBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const confirmed = await confirmAction("Delete Conversation", `Delete "${convo.title || "Untitled"}"? This cannot be undone.`, "Delete");
                if (confirmed) return deleteConversation(convo.id);
            });

            const renameBtn = document.createElement("button");
            renameBtn.className = "btn btn-xs chat-history-item-rename";
            renameBtn.textContent = "Rename";
            renameBtn.title = "Rename conversation";
            renameBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                requestConversationRename(convo.id);
            });

            const exportBtn = document.createElement("button");
            exportBtn.className = "btn btn-xs chat-history-item-export";
            exportBtn.textContent = "Export";
            exportBtn.title = "Export conversation as JSON";
            exportBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                exportConversation(convo.id);
            });

            header.appendChild(title);

            const actions = document.createElement("div");
            actions.className = "chat-history-item-actions";
            actions.appendChild(renameBtn);
            actions.appendChild(exportBtn);
            actions.appendChild(deleteBtn);

            const preview = document.createElement("div");
            preview.className = "chat-history-item-preview";
            const lastMsg = convo.messages[convo.messages.length - 1];
            preview.textContent = getMessagePreviewText(lastMsg);

            const time = document.createElement("div");
            time.className = "chat-history-item-time";
            time.textContent = formatHistoryTime(convo.timestamp);

            item.appendChild(header);
            item.appendChild(preview);
            item.appendChild(time);
            item.appendChild(actions);

            item.addEventListener("click", () => loadConversation(convo.id));
            list.appendChild(item);
        }
    }

    function formatHistoryTime(ts) {
        const d = new Date(ts);
        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return "Just now";
        if (diffMin < 60) return diffMin + "m ago";
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return diffHr + "h ago";
        return d.toLocaleDateString();
    }

    async function clearChat() {
        setChatToolsOpen(false);
        if (chatStreaming || compactionController || sendPreflightPromise) await abortActiveStream();
        discardPendingEdit();
        if (currentConversationId) {
            const deleted = await deleteConversation(currentConversationId);
            if (!deleted) return;
            if (snapshotStatsBaseline) snapshotStatsBaseline();
            return;
        }
        chatMessages = [];
        chatCompactions = [];
        const compactStatus = document.getElementById("chat-compaction-status");
        if (compactStatus) { compactStatus.textContent = ""; compactStatus.hidden = true; }
        renderCompactionMarker();
        updateCompactionControls();
        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        setChatThinkingEffort("auto");
        scheduleContextPreview(true);
        if (snapshotStatsBaseline) snapshotStatsBaseline();
    }

    function reportCharacterImport(message = "") {
        const status = document.getElementById("chat-character-status");
        if (status) { status.textContent = message; status.hidden = !message; }
    }

    async function importCharacterCard(file) {
        if (!file || characterImportPending || chatStreaming || compactionController || sendPreflightPromise) return;
        characterImportPending = true;
        updateChatAvailability(isServerRunning());
        reportCharacterImport("Reading character card…");
        const originalMessages = chatMessages;
        const originalLength = chatMessages.length;
        const originalPrompt = document.getElementById("chat-system-prompt").value;
        try {
            const card = await window.LlamaGui.characterCards.readFile(file);
            if (chatMessages !== originalMessages || chatMessages.length !== originalLength
                || document.getElementById("chat-system-prompt").value !== originalPrompt
                || chatStreaming || compactionController || sendPreflightPromise) {
                throw new Error("Chat changed while reading the card. Please load it again.");
            }
            if (!saveCurrentConversation()) throw new Error("Could not save the current conversation. The character was not loaded.");
            const conversation = {
                id: createConversationId(), title: card.name.slice(0, 120),
                messages: card.greeting.trim() ? [{ role: "assistant", content: card.greeting }] : [],
                compactions: [], systemPrompt: card.systemPrompt, thinkingEffort: "auto", timestamp: Date.now(),
            };
            const conversations = getStoredConversations();
            conversations.unshift(conversation);
            if (!saveConversationsToStorage(conversations)) throw new Error("Could not save the character chat. The current conversation is still open.");
            await loadConversation(conversation.id);
            reportCharacterImport([`Started a chat with ${card.name}.`, ...card.notices].join(" "));
        } catch (error) {
            console.debug("Character card import did not complete", error);
            reportCharacterImport(error.message || "Could not read the character card. Try another JSON or PNG file.");
        } finally {
            characterImportPending = false;
            updateChatAvailability(isServerRunning());
        }
    }

    function init() {
        initChatTools();
        window.LlamaGui.chatTools.init(() => scheduleContextPreview(true));
        ensureAutoCompactionControl();
        ensureEditStatusControl();
        wireChatScrollControls();
        const chatInput = document.getElementById("chat-input");
        const sendBtn = document.getElementById("btn-chat-send");
        const stopBtn = document.getElementById("btn-chat-stop");
        const undoBtn = document.getElementById("btn-chat-undo");
        const regenBtn = document.getElementById("btn-chat-regenerate");
        const focusBtn = document.getElementById("btn-chat-focus");
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        const characterFile = document.getElementById("chat-character-file");
        document.getElementById("btn-chat-load-character")?.addEventListener("click", () => characterFile?.click());
        characterFile?.addEventListener("change", () => {
            const file = characterFile.files?.[0];
            characterFile.value = "";
            void importCharacterCard(file);
        });
        const webSearchToggle = document.getElementById("chat-web-search-toggle");
        const webSearchMaxResults = document.getElementById("chat-web-search-max-results");
        const thinkingEffort = document.getElementById("chat-thinking-effort");
        const openQuickLaunchBtn = document.getElementById("btn-chat-open-quick-launch");

        updateStatusBadge();

        if (webSearchToggle) {
            webSearchToggle.checked = getStoredItem(CHAT_WEB_SEARCH_STORAGE_KEY) === "true";
            webSearchToggle.addEventListener("change", () => {
                setStoredItem(CHAT_WEB_SEARCH_STORAGE_KEY, String(webSearchToggle.checked));
                scheduleContextPreview();
            });
        }

        if (webSearchMaxResults) {
            webSearchMaxResults.value = String(clampChatWebSearchMaxResults(
                getStoredItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY)
            ));
            webSearchMaxResults.addEventListener("change", () => {
                const value = clampChatWebSearchMaxResults(webSearchMaxResults.value);
                webSearchMaxResults.value = String(value);
                setStoredItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
            webSearchMaxResults.addEventListener("input", () => {
                const value = clampChatWebSearchMaxResults(webSearchMaxResults.value);
                setStoredItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
        }

        if (thinkingEffort) {
            thinkingEffort.title = "Auto lets the loaded model choose. Off asks for a direct answer; levels request more or less reasoning when supported.";
            setChatThinkingEffort(thinkingEffort.value);
            thinkingEffort.addEventListener("change", () => {
                setChatThinkingEffort(thinkingEffort.value);
                refreshSidebarUI();
                saveCurrentConversation();
                scheduleContextPreview();
            });
        }

        chatInput.addEventListener("input", () => {
            scheduleContextPreview();
            chatInput.style.height = "auto";
            chatInput.style.height = Math.min(chatInput.scrollHeight, 220) + "px";
        });

        chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(chatInput.value);
            }
        });

        sendBtn.addEventListener("click", () => sendMessage(chatInput.value));
        stopBtn.addEventListener("click", stopStream);
        document.getElementById("btn-chat-compact")?.addEventListener("click", () => {
            if (compactionController) compactionController.abort();
            else void compactConversation();
        });
        undoBtn.addEventListener("click", undoMessage);
        regenBtn.addEventListener("click", regenerateResponse);
        if (focusBtn) {
            focusBtn.addEventListener("click", () => setChatFocusMode(!chatFocusMode));
            updateChatFocusButton();
        }
        if (openQuickLaunchBtn) {
            openQuickLaunchBtn.addEventListener("click", () => switchTab("quick-launch"));
        }

        sysPrompt.addEventListener("input", () => {
            scheduleContextPreview();
            sysCharCount.textContent = sysPrompt.value.length + " chars";
        });
        sysCharCount.textContent = "0 chars";

        initChatPanel("chat-sidebar", "btn-open-sidebar", "btn-collapse-sidebar", CHAT_SETTINGS_COLLAPSED_STORAGE_KEY);
        initChatPanel("chat-history-panel", "btn-open-history", "btn-collapse-history", CHAT_HISTORY_COLLAPSED_STORAGE_KEY);

        const newChatBtn = document.getElementById("btn-chat-new");
        if (newChatBtn) {
            newChatBtn.addEventListener("click", startNewChat);
        }

        const deleteAllBtn = document.getElementById("btn-delete-all-history");
        if (deleteAllBtn) {
            deleteAllBtn.addEventListener("click", async () => {
                if (getStoredConversations().length === 0) return;
                const confirmed = await confirmAction("Delete All Conversations", "Delete all saved conversations? This cannot be undone.", "Delete All");
                if (confirmed) {
                    await deleteAllConversations();
                }
            });
        }

        const historySearch = document.getElementById("chat-history-search");
        if (historySearch) {
            chatHistoryFilter = historySearch.value || "";
            historySearch.addEventListener("input", () => {
                chatHistoryFilter = historySearch.value || "";
                renderHistoryList();
            });
        }
        renderHistoryList();

        for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
            const slider = document.getElementById(sliderId);
            const display = document.getElementById(sliderId.replace("slider", "val"));
            if (!slider || !display) continue;

            slider.addEventListener("input", () => {
                const raw = parseFloat(slider.value);
                display.textContent = raw.toFixed(meta.decimals);
                const val = meta.flag === "top_k" ? parseInt(slider.value, 10) : parseFloat(slider.value);
                flagCore.setFlagValue(meta.flag, val);
                if (meta.flag === "n_predict") refreshSidebarUI();
            });
        }

        for (const [inputId, meta] of Object.entries(CHAT_NUMERIC_INPUTS)) {
            const input = document.getElementById(inputId);
            if (!input) continue;
            input.addEventListener("change", () => {
                const raw = String(input.value || "").trim();
                const parsed = Number(raw);
                if (raw && Number.isFinite(parsed) && (!meta.integer || Number.isInteger(parsed))) {
                    flagCore.setFlagValue(meta.flag, parsed);
                }
                refreshSidebarUI();
            });
            input.addEventListener("input", () => {
                const raw = String(input.value || "").trim();
                const parsed = Number(raw);
                if (raw && Number.isFinite(parsed) && (!meta.integer || Number.isInteger(parsed))) {
                    flagCore.setFlagValue(meta.flag, parsed);
                }
                scheduleContextPreview();
            });
        }

        const clearBtn = document.getElementById("btn-chat-clear");
        if (clearBtn) {
            clearBtn.addEventListener("click", async () => {
                const confirmed = await confirmAction("Clear Current Chat", "Clear this chat, including its saved conversation and system prompt? This cannot be undone.", "Clear Chat");
                if (confirmed) await clearChat();
            });
        }

        refreshSidebarUI();
    }

    window.LlamaGui.chatUi = {
        configure,
        init,
        onTabChanged,
        refreshSidebarUI,
        updateStatusBadge,
        refreshTemplateCaps,
        abortActiveStream,
        addModelTransitionDivider,
    };

    // Test-only hooks. These are live mutators that bypass the confirm flows
    // wired up in init(), so they stay off the shipped namespace unless the
    // harness opts in before this file is evaluated.
    if (window.__LLAMA_GUI_TEST_HOOKS__) {
        Object.assign(window.LlamaGui.chatUi, {
            _testSendMessage: sendMessage,
            _testLoadConversation: loadConversation,
            _testClearChat: clearChat,
            _testStartNewChat: startNewChat,
            _testImportCharacterCard: importCharacterCard,
            _testDeleteAllConversations: deleteAllConversations,
            _testRegenerateResponse: regenerateResponse,
            _testCompactConversation: compactConversation,
            _testUndoCompaction: undoCompaction,
            _testUndoMessage: undoMessage,
            _testEditUserMessage: editUserMessage,
            _testCancelEdit: cancelEdit,
            _testRenameConversation: renameConversation,
            _testExportConversation: exportConversation,
            _testDeleteConversation: deleteConversation,
            _testSetAutoCompaction: setAutoCompactionEnabled,
            _testGetState: () => ({
                chatMessages: chatMessages.slice(),
                currentConversationId,
                chatStreaming,
                chatCompactions: chatCompactions.slice(),
                pendingEdit: pendingEdit ? { ...pendingEdit, tail: pendingEdit.tail.slice() } : null,
            }),
        });
    }
})();
