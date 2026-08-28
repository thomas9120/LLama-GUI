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

    const chatRendering = window.LlamaGui.chatRendering;
    const {
        renderChatMessage,
        setChatWebStatus,
        renderChatSources,
        renderChatTypingIndicator,
        removeChatTypingIndicator,
        appendChatStreamToken,
        finalizeChatStreamMarkdown,
        appendChatReasoningStreamToken,
        finalizeChatReasoningMarkdown,
        setChatReasoningContent,
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
            maxTokensSlider.max = sliderMax;
            const nPredict = normalizeSamplerNumber(values.n_predict);
            if (nPredict !== null && nPredict !== -1) {
                const clamped = Math.trunc(Math.min(nPredict, sliderMax));
                maxTokensSlider.value = clamped;
                maxTokensDisplay.textContent = String(clamped);
            } else {
                maxTokensSlider.value = 512;
                maxTokensDisplay.textContent = "512";
            }
        }
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
        return clampChatWebSearchMaxResults(input ? input.value : localStorage.getItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY));
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
        return messages.map((msg) => {
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
        const canSend = Boolean(isRunning) && !chatStreaming;

        if (chatInput) {
            chatInput.disabled = !isRunning;
            chatInput.placeholder = isRunning
                ? "Type a message..."
                : isLoading
                    ? "Waiting for the model to finish loading..."
                    : "请先启动 llama-server，或在 API 页连接一个运行中的服务器…";
        }
        if (sendBtn) {
            sendBtn.disabled = !canSend;
            sendBtn.title = isRunning ? "" : "发送消息前，请先启动 llama-server，或在 API 页连接一个运行中的服务器。";
        }
        if (note) {
            note.classList.toggle("hidden", Boolean(isRunning));
            const message = note.querySelector("span");
            if (message) {
                message.textContent = isLoading
                    ? "llama-server is loading the selected model. Chat will unlock when it is ready."
                    : "发送消息前，请先启动 llama-server，或在 API 页连接一个运行中的服务器。";
            }
        }
    }

    function updateStatusBadge() {
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

    function sendMessage(userText) {
        if (chatStreaming || !userText.trim()) return Promise.resolve();
        const pending = runMessage(userText);
        chatStreamPromise = pending;
        const clearPending = () => {
            if (chatStreamPromise === pending) chatStreamPromise = null;
        };
        pending.then(clearPending, clearPending);
        return pending;
    }

    function finalizeAssistantResponse(bubble, content, reasoning, sources, errored) {
        if (!bubble) return;

        setChatWebStatus(bubble, "");
        let finalContent = content;
        let finalReasoning = reasoning;
        if (!finalReasoning && shouldExtractEmbeddedReasoning()) {
            const split = splitReasoningFromContent(finalContent);
            if (split.reasoning) {
                finalContent = split.content;
                finalReasoning = split.reasoning;
                bubble.dataset.rawText = finalContent;
                if (!finalContent) {
                    bubble.textContent = "";
                    delete bubble.dataset.streamingTextInitialized;
                }
                setChatReasoningContent(bubble, finalReasoning);
            }
        }
        if (finalReasoning) {
            finalizeChatReasoningMarkdown(bubble);
        }
        if (finalContent) {
            finalizeChatStreamMarkdown(bubble);
            bubble.classList.remove("hidden");
        } else if (finalReasoning) {
            bubble.classList.add("hidden");
        }
        if ((finalContent || finalReasoning) && !errored) {
            const assistantMessage = { role: "assistant", content: finalContent, sources };
            if (finalReasoning) assistantMessage.reasoning = finalReasoning;
            chatMessages.push(assistantMessage);
            saveCurrentConversation();
        }
    }

    async function runMessage(userText) {
        if (chatStreaming || !userText.trim()) return;
        if (!isServerRunning()) {
            updateStatusBadge();
            return;
        }

        const systemPrompt = (document.getElementById("chat-system-prompt").value || "").trim();
        chatMessages.push({ role: "user", content: userText.trim() });
        renderChatMessage("user", userText.trim());

        const chatInput = document.getElementById("chat-input");
        chatInput.value = "";
        chatInput.style.height = "auto";

        chatStreaming = true;
        showChatSendButton(false);
        renderChatTypingIndicator();

        const messages = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push(...getChatRequestMessages(chatMessages));

        const body = {
            model: getChatModelName(),
            messages,
            stream: true,
            ...getChatSamplerParams(),
            ...getChatThinkingParams(),
        };
        if (isChatWebSearchEnabled()) {
            body.web_search = true;
            body.web_search_max_results = getChatWebSearchMaxResults();
        }

        chatAbortController = new AbortController();
        let bubble = null;
        let fullContent = "";
        let fullReasoning = "";
        let responseSources = [];
        let errored = false;

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
                renderChatMessage("assistant", `Error: ${resp.status} - ${errText}`);
                chatStreaming = false;
                showChatSendButton(true);
                return;
            }

            if (!resp.body) {
                renderChatMessage("assistant", "Error: Response body is empty.");
                chatStreaming = false;
                showChatSendButton(true);
                return;
            }
            bubble = renderChatMessage("assistant", "");
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let streamDone = false;

            while (!streamDone) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: ")) continue;
                    const data = trimmed.slice(6);
                    if (data === "[DONE]") {
                        streamDone = true;
                        setChatWebStatus(bubble, "");
                        break;
                    }

                    try {
                        const parsed = JSON.parse(data);
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
                            appendChatStreamToken(bubble, `Error: ${message}`);
                            errored = true;
                            streamDone = true;
                            break;
                        }
                        const delta = parsed.choices?.[0]?.delta;
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
                    } catch (e) {
                        console.debug("Skipping malformed chat stream chunk", e);
                    }
                }
            }

            if (streamDone) {
                await reader.cancel().catch((e) => console.debug("Failed to cancel completed chat stream reader", e));
            }
            finalizeAssistantResponse(bubble, fullContent, fullReasoning, responseSources, errored);
        } catch (e) {
            removeChatTypingIndicator();
            if (e.name === "AbortError") {
                if (fullContent || fullReasoning) {
                    finalizeAssistantResponse(bubble, fullContent, fullReasoning, responseSources, false);
                } else if (bubble) {
                    const message = bubble.closest(".chat-message");
                    if (message) message.remove();
                }
            } else {
                renderChatMessage("assistant", "Error: " + e.message);
            }
        } finally {
            chatStreaming = false;
            chatAbortController = null;
            showChatSendButton(true);
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
        if (chatStreaming || chatMessages.length === 0) return;
        chatMessages.pop();
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
    }

    function regenerateResponse() {
        if (chatStreaming || chatMessages.length === 0) return;
        const lastMsg = chatMessages[chatMessages.length - 1];
        if (lastMsg.role === "assistant") {
            chatMessages.pop();
            const container = document.getElementById("chat-messages");
            const msgs = container.querySelectorAll(".chat-message");
            if (msgs.length > 0) msgs[msgs.length - 1].remove();
        }

        const lastUserMsg = chatMessages[chatMessages.length - 1];
        if (!lastUserMsg || lastUserMsg.role !== "user") {
            // The pop above already mutated chatMessages and the DOM; persist it the
            // same way undoMessage() does, or the removed message reappears on reload.
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
            return;
        }

        chatMessages.pop();
        const container = document.getElementById("chat-messages");
        const msgs = container.querySelectorAll(".chat-message");
        if (msgs.length > 0) msgs[msgs.length - 1].remove();

        sendMessage(lastUserMsg.content);
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
        if (chatStreaming) await abortActiveStream();

        // Read storage only after the abort has settled: finalizing the aborted
        // reply writes to storage, so a snapshot taken earlier would be stale and
        // reloading the streaming conversation would drop the in-flight turn.
        const conversations = getStoredConversations();
        const convo = conversations.find(c => c.id === id);
        if (!convo) return;

        currentConversationId = convo.id;
        chatMessages = convo.messages.slice();

        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) {
            sysPrompt.value = convo.systemPrompt || "";
            if (sysCharCount) sysCharCount.textContent = (convo.systemPrompt || "").length + " chars";
        }
        setChatThinkingEffort(convo.thinkingEffort);

        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");

        if (chatMessages.length === 0) {
            if (empty) empty.style.display = "";
        } else {
            if (empty) empty.style.display = "none";
            for (const msg of chatMessages) {
                renderChatMessage(msg.role, msg.content, { reasoning: msg.reasoning });
            }
        }

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
        if (chatStreaming) await abortActiveStream();
        saveCurrentConversation();
        currentConversationId = null;
        chatMessages = [];
        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        setChatThinkingEffort("auto");
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
            empty.textContent = "暂无会话记录";
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
        if (chatStreaming) await abortActiveStream();
        if (currentConversationId) {
            const conversations = getStoredConversations();
            saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId));
            currentConversationId = null;
            renderHistoryList();
        }
        chatMessages = [];
        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");
        if (empty) empty.style.display = "";
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) sysPrompt.value = "";
        if (sysCharCount) sysCharCount.textContent = "0 chars";
        setChatThinkingEffort("auto");
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
            webSearchToggle.checked = localStorage.getItem(CHAT_WEB_SEARCH_STORAGE_KEY) === "true";
            webSearchToggle.addEventListener("change", () => {
                localStorage.setItem(CHAT_WEB_SEARCH_STORAGE_KEY, String(webSearchToggle.checked));
            });
        }

        if (webSearchMaxResults) {
            webSearchMaxResults.value = String(clampChatWebSearchMaxResults(
                localStorage.getItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY)
            ));
            webSearchMaxResults.addEventListener("change", () => {
                const value = clampChatWebSearchMaxResults(webSearchMaxResults.value);
                webSearchMaxResults.value = String(value);
                localStorage.setItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
            webSearchMaxResults.addEventListener("input", () => {
                const value = clampChatWebSearchMaxResults(webSearchMaxResults.value);
                localStorage.setItem(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
        }

        if (thinkingEffort) {
            setChatThinkingEffort(thinkingEffort.value);
            thinkingEffort.addEventListener("change", () => {
                setChatThinkingEffort(thinkingEffort.value);
                saveCurrentConversation();
            });
        }

        chatInput.addEventListener("input", () => {
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
            sysCharCount.textContent = sysPrompt.value.length + " chars";
        });
        sysCharCount.textContent = "0 chars";

        const settingsCollapsed = localStorage.getItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY) === "true";
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
                localStorage.setItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY, "true");
            });
        }

        if (btnOpen && sidebar) {
            btnOpen.addEventListener("click", () => {
                setChatPanelCollapsed(sidebar, btnOpen, btnCollapse, false);
                localStorage.setItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY, "false");
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
                const confirmed = await confirmAction("删除全部会话", "删除所有会话？此操作不可撤销。", "全部删除");
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
            _testGetState: () => ({
                chatMessages: chatMessages.slice(),
                currentConversationId,
                chatStreaming,
            }),
        });
    }
})();
