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
    let currentConversationId = null;
    let chatFocusMode = false;
    let contextTimer = null;
    let contextController = null;
    let contextKey = null;
    let contextRevision = 0;
    let chatCompactions = [];
    let compactionController = null;
    let compactionPromise = null;
    let compactionKey = null;
    const compaction = window.LlamaGui.chatCompaction;

    const CHAT_CONVERSATIONS_STORAGE_KEY = "llama_gui_conversations";
    const CHAT_SETTINGS_COLLAPSED_STORAGE_KEY = "llama_gui_chat_settings_collapsed";
    const CHAT_WEB_SEARCH_STORAGE_KEY = "llama_gui_chat_web_search_enabled";
    const CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY = "llama_gui_chat_web_search_max_results";
    const CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
    const CHAT_WEB_SEARCH_MIN_RESULTS = 1;
    const CHAT_WEB_SEARCH_MAX_RESULTS = 10;
    const CHAT_THINKING_EFFORTS = ["auto", "off", "low", "medium", "high", "xhigh"];
    const CHAT_MAX_STORED_CONVERSATIONS = 50;
    const CHAT_CONSTRAINED_LAYOUT_QUERY = "(max-width: 1320px)";

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
        return messages.filter((msg) => msg.role !== "assistant" || msg.content || msg.reasoning || msg.reasoning_content).map((msg) => {
            const requestMessage = {
                role: msg.role,
                content: msg.content,
            };
            const reasoning = typeof msg.reasoning === "string"
                ? msg.reasoning
                : (typeof msg.reasoning_content === "string" ? msg.reasoning_content : "");
            if (msg.role === "assistant" && reasoning) {
                requestMessage.reasoning_content = reasoning;
            }
            return requestMessage;
        });
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
        if (latestStatus && latestStatus.running && latestStatus.active_process_tool === "llama-server") {
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
        const canSend = Boolean(isRunning) && !chatStreaming && !compactionController;

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
            ? "The loaded chat template does not advertise reasoning-effort support \u2014 effort levels may have no effect."
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
        panel.classList.toggle("collapsed", collapsed);
        panel.setAttribute("aria-hidden", String(collapsed));
        if (openButton) {
            openButton.style.display = collapsed ? "flex" : "none";
            openButton.setAttribute("aria-expanded", String(!collapsed));
        }
        if (collapseButton) {
            collapseButton.setAttribute("aria-expanded", String(!collapsed));
        }
    }

    function shouldUseConstrainedChatLayout() {
        return Boolean(window.matchMedia && window.matchMedia(CHAT_CONSTRAINED_LAYOUT_QUERY).matches);
    }

    function collapseSettingsForConstrainedLayout(sidebar, openButton, collapseButton) {
        if (!shouldUseConstrainedChatLayout() || !sidebar || sidebar.classList.contains("collapsed")) return;
        setChatPanelCollapsed(sidebar, openButton, collapseButton, true);
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
        if (topK !== null && topK !== 0) params.top_k = topK;
        const minP = normalizeSamplerNumber(values.min_p);
        if (minP !== null) params.min_p = minP;
        const repeatPenalty = normalizeSamplerNumber(values.repeat_penalty);
        if (repeatPenalty !== null && repeatPenalty !== 1.0) params.repeat_penalty = repeatPenalty;
        const nPredict = normalizeSamplerNumber(values.n_predict);
        if (nPredict !== null && nPredict !== -1) params.max_tokens = nPredict;
        return params;
    }

    function buildChatBody(history, draft = "") {
        const messages = [];
        const systemPrompt = (document.getElementById("chat-system-prompt")?.value || "").trim();
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        messages.push(...getChatRequestMessages(compaction.workingMessages(history, chatCompactions.at(-1))));
        if (draft.trim()) messages.push({ role: "user", content: draft.trim() });
        const body = {
            model: getChatModelName(), messages, stream: true,
            ...getChatSamplerParams(), ...getChatThinkingParams(),
        };
        if (isChatWebSearchEnabled()) {
            body.web_search = true;
            body.web_search_max_results = getChatWebSearchMaxResults();
        }
        return body;
    }

    function getCompactionKey() {
        const status = getLatestStatus ? getLatestStatus() : null;
        return JSON.stringify([getTemplateCapsKey(), status?.active_runtime, status?.external_chat_target,
            buildChatBody(chatMessages), document.getElementById("chat-input")?.value || ""]);
    }

    function updateCompactionControls() {
        const button = document.getElementById("btn-chat-compact");
        if (!button) return;
        const available = compaction.boundary(chatMessages) > (chatCompactions.at(-1)?.end || 0);
        button.hidden = !available && !compactionController;
        button.disabled = !compactionController && (chatStreaming || !isServerRunning());
        button.textContent = compactionController ? "Cancel compaction" : "Compact now";
        button.title = "Summarize older messages; keep the transcript and last two turns unchanged.";
        const undo = document.getElementById("btn-chat-undo-compaction");
        if (undo) undo.disabled = chatStreaming || Boolean(compactionController);
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

    function compactConversation() {
        if (chatStreaming || compactionController || !isServerRunning()) return Promise.resolve();
        const controller = new AbortController();
        compactionController = controller;
        compactionKey = getCompactionKey();
        cancelContextPreview();
        updateChatAvailability(isServerRunning());
        const status = document.getElementById("chat-compaction-status");
        const report = message => { if (status) { status.textContent = message; status.hidden = !message; } };
        report("Measuring space for a summary…");
        const pending = (async () => {
            try {
                const record = await compaction.compact({
                    messages: chatMessages.map(msg => ({ role: msg.role, content: msg.content, reasoning_content: msg.reasoning || msg.reasoning_content, sources: msg.sources, status: msg.status })),
                    previous: chatCompactions.at(-1), body: buildChatBody(chatMessages),
                    draft: document.getElementById("chat-input")?.value || "", signal: controller.signal,
                    headers: getApiAuthorizationHeaders({ "Content-Type": "application/json" }), onProgress: report,
                });
                if (controller.signal.aborted || !isServerRunning() || compactionKey !== getCompactionKey()) {
                    throw Object.assign(new Error("Chat changed"), { name: "AbortError" });
                }
                chatCompactions.push(record);
                saveCurrentConversation();
                renderCompactionMarker();
                report("");
            } catch (error) {
                console.debug("Chat compaction did not apply", error);
                report(error.name === "AbortError" ? "Compaction cancelled; previous context kept."
                    : `${error.message} Previous context kept. You can retry Compact now.`);
            } finally {
                compactionController = null;
                compactionKey = null;
                updateChatAvailability(isServerRunning());
                scheduleContextPreview(true);
            }
        })();
        compactionPromise = pending;
        pending.then(() => { if (compactionPromise === pending) compactionPromise = null; });
        return pending;
    }

    function renderContextBudget(budget) {
        const label = document.getElementById("chat-context-label");
        const bar = document.getElementById("chat-context-bar");
        const promptFill = document.getElementById("chat-context-prompt");
        const reserveFill = document.getElementById("chat-context-reserve");
        if (!label || !bar || !promptFill || !reserveFill) return;
        const measured = Number.isFinite(budget.prompt_tokens) && budget.capacity > 0;
        const used = measured ? budget.prompt_tokens : 0;
        const reserve = measured ? budget.reply_reserve : 0;
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
    }

    function cancelContextPreview() {
        contextRevision += 1;
        if (contextTimer !== null) clearTimeout(contextTimer);
        contextTimer = null;
        if (contextController) contextController.abort();
        contextController = null;
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
            renderContextBudget({ message: "Start or connect to a server to measure context." });
            return;
        }
        if (chatStreaming) return;
        if (!body.messages.some(msg => msg.role !== "system" && msg.role !== "developer")) {
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
            if (revision === contextRevision && !chatStreaming) renderContextBudget(budget);
        } catch (error) {
            if (error.name !== "AbortError" && revision === contextRevision) {
                console.debug("Could not measure chat context", error);
                renderContextBudget({ message: "Context count unavailable; the server will validate the request." });
            }
        } finally {
            if (contextController === controller) contextController = null;
        }
    }

    function sendMessage(userText, retry = false) {
        if (chatStreaming || compactionController || !userText.trim()) return Promise.resolve();
        const pending = runMessage(userText, retry);
        chatStreamPromise = pending;
        const clearPending = () => {
            if (chatStreamPromise === pending) chatStreamPromise = null;
        };
        pending.then(clearPending, clearPending);
        return pending;
    }

    function finalizeAssistantResponse(content, reasoning, sources, status, error, replacementIndex) {
        let finalContent = content;
        let finalReasoning = reasoning;
        if (!finalReasoning && shouldExtractEmbeddedReasoning()) {
            const split = splitReasoningFromContent(finalContent);
            if (split.reasoning) {
                finalContent = split.content;
                finalReasoning = split.reasoning;
            }
        }
        const result = { content: finalContent, reasoning: finalReasoning, sources, status, error };
        const previous = replacementIndex >= 0 ? chatMessages[replacementIndex] : null;
        if (previous) {
            const versions = Array.isArray(previous.versions) ? previous.versions.slice() : [{
                content: previous.content, reasoning: previous.reasoning || "",
                sources: previous.sources || [], status: previous.status || "complete", error: previous.error || "",
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
                // Earlier responses keep their rendered markdown and open
                // reasoning panels. Their actions no longer target the last turn.
                previousElements[index]?.querySelectorAll(".chat-response-action").forEach(el => el.remove());
                return;
            }
            const bubble = renderChatMessage(msg.role, msg.content, { reasoning: msg.reasoning });
            const previousElement = previousElements[index];
            if (previousElement) {
                container.insertBefore(bubble.closest(".chat-message"), previousElement);
                previousElement.remove();
            }
            if (msg.role !== "assistant") return;
            renderChatSources(bubble, msg.sources);
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

    async function runMessage(userText, retry = false) {
        if (chatStreaming || compactionController || !userText.trim()) return;
        if (!isServerRunning()) {
            updateStatusBadge();
            return;
        }

        cancelContextPreview();
        const replacementIndex = retry && chatMessages[chatMessages.length - 1]?.role === "assistant"
            ? chatMessages.length - 1 : -1;
        if (!retry) {
            chatMessages.push({ role: "user", content: userText.trim() });
            renderChatMessage("user", userText.trim());
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

        const body = buildChatBody(replacementIndex >= 0 ? chatMessages.slice(0, replacementIndex) : chatMessages);
        renderContextBudget({ message: body.web_search ? "Waiting for web results before measuring context…" : "Checking context before generating…" });

        chatAbortController = new AbortController();
        let bubble = null;
        let fullContent = "";
        let fullReasoning = "";
        let responseSources = [];
        let status = "complete";
        let error = "";
        let reader = null;

        try {
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
                        receivedFinish = true;
                        if (finishReason === "length") status = "length";
                    }
                    const reasoningDelta = getChatDeltaText(delta, ["reasoning_content", "reasoning"]);
                    if (reasoningDelta) {
                        fullReasoning += reasoningDelta;
                        appendChatReasoningStreamToken(bubble, reasoningDelta);
                    }
                    const contentDelta = getChatDeltaText(delta, ["content"]);
                    if (contentDelta) {
                        fullContent += contentDelta;
                        appendChatStreamToken(bubble, contentDelta);
                    }
                }
                if (done) {
                    if (!streamDone && !receivedFinish) throw new Error("Connection closed before the response completed.");
                    break;
                }
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
            finalizeAssistantResponse(fullContent, fullReasoning, responseSources, status, error, replacementIndex);
            chatStreaming = false;
            chatAbortController = null;
            showChatSendButton(true);
            updateChatAvailability(isServerRunning());
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
        const divider = document.createElement("div");
        divider.className = "chat-model-divider";
        divider.setAttribute("role", "separator");
        const from = String(previousLabel || "previous model").trim() || "previous model";
        const to = String(nextLabel || "new model").trim() || "new model";
        divider.textContent = `Model switched: ${from} → ${to}`;
        container.appendChild(divider);
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "none";
        container.scrollTop = container.scrollHeight;
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
            return JSON.parse(localStorage.getItem(CHAT_CONVERSATIONS_STORAGE_KEY)) || [];
        } catch (e) {
            console.debug("Failed to read stored conversations", e);
            return [];
        }
    }

    function saveConversationsToStorage(list) {
        const pruned = Array.isArray(list) ? list.slice(0, CHAT_MAX_STORED_CONVERSATIONS) : [];
        try {
            localStorage.setItem(CHAT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(pruned));
        } catch (e) {
            console.warn("Failed to save conversations to localStorage:", e);
            if (typeof window.showToast === "function") {
                window.showToast("Conversation history is full. Recent chat is still active, but history was not saved.", "warning");
            }
        }
    }

    function saveCurrentConversation() {
        if (chatMessages.length === 0) return;
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
            existing.title = generateConversationTitle(chatMessages);
        } else {
            const convo = {
                id: (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
                    ? crypto.randomUUID()
                    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
                        const r = Math.random() * 16 | 0;
                        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
                      }),
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

        saveConversationsToStorage(conversations);
        renderHistoryList();
    }

    function generateConversationTitle(messages) {
        const first = messages.find(m => m.role === "user");
        if (!first) return "Untitled";
        const text = first.content.trim().replace(/\n/g, " ");
        return text.length > 50 ? text.slice(0, 50) + "..." : text;
    }

    async function loadConversation(id) {
        // Must await: abort() rejects the pending read on a later microtask, so a
        // bare stopStream() lets the AbortError handler run after the reassignments
        // below and finalize the old reply into the conversation we just loaded.
        if (chatStreaming || compactionController) await abortActiveStream();

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

    function deleteConversation(id) {
        const conversations = getStoredConversations();
        const filtered = conversations.filter(c => c.id !== id);
        saveConversationsToStorage(filtered);

        if (currentConversationId === id) {
            currentConversationId = null;
        }

        renderHistoryList();
    }

    function deleteAllConversations() {
        saveConversationsToStorage([]);
        currentConversationId = null;
        renderHistoryList();
    }

    async function startNewChat() {
        // Stop before saving: an in-flight stream would otherwise keep appending
        // tokens into the fresh chat and leave the composer disabled.
        if (chatStreaming || compactionController) await abortActiveStream();
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

        if (conversations.length === 0) {
            const empty = document.createElement("div");
            empty.className = "chat-history-empty";
            empty.textContent = "No saved conversations";
            list.appendChild(empty);
            return;
        }

        for (const convo of conversations) {
            const item = document.createElement("div");
            item.className = "chat-history-item" + (convo.id === currentConversationId ? " active" : "");

            const header = document.createElement("div");
            header.className = "chat-history-item-header";

            const title = document.createElement("div");
            title.className = "chat-history-item-title";
            title.textContent = convo.title;

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "chat-history-item-delete";
            deleteBtn.textContent = "\uD83D\uDDD1";
            deleteBtn.title = "Delete conversation";
            deleteBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                deleteConversation(convo.id);
            });

            header.appendChild(title);
            header.appendChild(deleteBtn);

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
        if (chatStreaming || compactionController) await abortActiveStream();
        if (currentConversationId) {
            const conversations = getStoredConversations();
            saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId));
            currentConversationId = null;
            renderHistoryList();
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

    function init() {
        const chatInput = document.getElementById("chat-input");
        const sendBtn = document.getElementById("btn-chat-send");
        const stopBtn = document.getElementById("btn-chat-stop");
        const undoBtn = document.getElementById("btn-chat-undo");
        const regenBtn = document.getElementById("btn-chat-regenerate");
        const focusBtn = document.getElementById("btn-chat-focus");
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        const sidebar = document.getElementById("chat-sidebar");
        const btnCollapse = document.getElementById("btn-collapse-sidebar");
        const btnOpen = document.getElementById("btn-open-sidebar");
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
            setChatThinkingEffort(thinkingEffort.value);
            thinkingEffort.addEventListener("change", () => {
                setChatThinkingEffort(thinkingEffort.value);
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

        const settingsCollapsed = getStoredItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY) === "true";
        setChatPanelCollapsed(sidebar, btnOpen, btnCollapse, settingsCollapsed);
        collapseSettingsForConstrainedLayout(sidebar, btnOpen, btnCollapse);

        if (window.matchMedia && sidebar) {
            const constrainedLayoutMedia = window.matchMedia(CHAT_CONSTRAINED_LAYOUT_QUERY);
            const onConstrainedLayoutChange = () => {
                collapseSettingsForConstrainedLayout(sidebar, btnOpen, btnCollapse);
            };
            if (constrainedLayoutMedia.addEventListener) {
                constrainedLayoutMedia.addEventListener("change", onConstrainedLayoutChange);
            } else if (constrainedLayoutMedia.addListener) {
                constrainedLayoutMedia.addListener(onConstrainedLayoutChange);
            }
        }

        if (btnCollapse && sidebar) {
            btnCollapse.addEventListener("click", () => {
                setChatPanelCollapsed(sidebar, btnOpen, btnCollapse, true);
                setStoredItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY, "true");
            });
        }

        if (btnOpen && sidebar) {
            btnOpen.addEventListener("click", () => {
                setChatPanelCollapsed(sidebar, btnOpen, btnCollapse, false);
                setStoredItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY, "false");
            });
        }

        const historyPanel = document.getElementById("chat-history-panel");
        const btnCollapseHistory = document.getElementById("btn-collapse-history");
        const btnOpenHistory = document.getElementById("btn-open-history");

        setChatPanelCollapsed(historyPanel, btnOpenHistory, btnCollapseHistory, false);

        if (btnCollapseHistory && historyPanel) {
            btnCollapseHistory.addEventListener("click", () => {
                setChatPanelCollapsed(historyPanel, btnOpenHistory, btnCollapseHistory, true);
            });
        }

        if (btnOpenHistory && historyPanel) {
            btnOpenHistory.addEventListener("click", () => {
                setChatPanelCollapsed(historyPanel, btnOpenHistory, btnCollapseHistory, false);
            });
        }

        const newChatBtn = document.getElementById("btn-chat-new");
        if (newChatBtn) {
            newChatBtn.addEventListener("click", startNewChat);
        }

        const deleteAllBtn = document.getElementById("btn-delete-all-history");
        if (deleteAllBtn) {
            deleteAllBtn.addEventListener("click", async () => {
                if (getStoredConversations().length === 0) return;
                const confirmed = await confirmAction("Delete All Conversations", "Delete all conversations? This cannot be undone.", "Delete All");
                if (confirmed) {
                    deleteAllConversations();
                    await clearChat();
                }
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

        const clearBtn = document.getElementById("btn-chat-clear");
        if (clearBtn) {
            clearBtn.addEventListener("click", clearChat);
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
            _testRegenerateResponse: regenerateResponse,
            _testCompactConversation: compactConversation,
            _testUndoCompaction: undoCompaction,
            _testUndoMessage: undoMessage,
            _testGetState: () => ({
                chatMessages: chatMessages.slice(),
                currentConversationId,
                chatStreaming,
                chatCompactions: chatCompactions.slice(),
            }),
        });
    }
})();
