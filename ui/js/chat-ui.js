(function () {
    window.LlamaGui = window.LlamaGui || {};

    let flagCore = null;
    let confirmAction = null;
    let getServerEndpointConfig = null;
    let getLatestStatus = null;
    let snapshotStatsBaseline = null;

    let chatMessages = [];
    let chatStreaming = false;
    let chatAbortController = null;
    let currentConversationId = null;

    const CHAT_CONVERSATIONS_STORAGE_KEY = "llama_gui_conversations";
    const CHAT_WEB_SEARCH_STORAGE_KEY = "llama_gui_chat_web_search_enabled";
    const CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY = "llama_gui_chat_web_search_max_results";
    const CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
    const CHAT_WEB_SEARCH_MIN_RESULTS = 1;
    const CHAT_WEB_SEARCH_MAX_RESULTS = 10;

    const chatRendering = window.LlamaGui.chatRendering;
    const {
        renderChatMessage,
        setChatWebStatus,
        renderChatSources,
        renderChatTypingIndicator,
        removeChatTypingIndicator,
        appendChatStreamToken,
    } = chatRendering;

    function configure(options) {
        flagCore = options.flagCore;
        confirmAction = options.confirmAction;
        getServerEndpointConfig = options.getServerEndpointConfig;
        getLatestStatus = options.getLatestStatus;
        snapshotStatsBaseline = options.snapshotStatsBaseline;
    }

    function refreshSidebarUI() {
        const values = flagCore.getFlagValues();
        for (const [sliderId, meta] of Object.entries(CHAT_SAMPLER_SLIDER_MAP)) {
            const slider = document.getElementById(sliderId);
            const display = document.getElementById(sliderId.replace("slider", "val"));
            if (!slider || !display) continue;
            const val = values[meta.flag];
            if (val !== undefined && val !== null && val !== "") {
                slider.value = val;
                display.textContent = parseFloat(val).toFixed(meta.decimals);
            }
        }
        const maxTokensSlider = document.getElementById("chat-slider-max-tokens");
        const maxTokensDisplay = document.getElementById("chat-val-max-tokens");
        if (maxTokensSlider && maxTokensDisplay) {
            const ctxSize = parseInt(values.ctx_size, 10);
            const sliderMax = (Number.isFinite(ctxSize) && ctxSize > 0) ? Math.min(ctxSize, 131072) : 32768;
            maxTokensSlider.max = sliderMax;
            const nPredict = values.n_predict;
            if (nPredict !== undefined && nPredict !== null && nPredict !== "" && nPredict !== -1) {
                maxTokensSlider.value = Math.min(nPredict, sliderMax);
                maxTokensDisplay.textContent = parseInt(Math.min(nPredict, sliderMax), 10);
            } else {
                maxTokensSlider.value = 512;
                maxTokensDisplay.textContent = "512";
            }
        }
    }

    function getChatModelName() {
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

    function getChatRequestMessages(messages) {
        return messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
        }));
    }

    function updateStatusBadge() {
        const runningBadge = document.getElementById("chat-status-badge");
        const noServerBadge = document.getElementById("chat-no-server-badge");
        if (!runningBadge || !noServerBadge) return;

        const latestStatus = getLatestStatus ? getLatestStatus() : null;
        const isRunning = !!(latestStatus && latestStatus.running);
        runningBadge.style.display = isRunning ? "" : "none";
        noServerBadge.style.display = isRunning ? "none" : "";
    }

    function showChatSendButton(show) {
        const sendBtn = document.getElementById("btn-chat-send");
        const stopBtn = document.getElementById("btn-chat-stop");
        if (sendBtn) sendBtn.style.display = show ? "flex" : "none";
        if (stopBtn) stopBtn.style.display = show ? "none" : "flex";
    }

    function getChatSamplerParams() {
        const params = {};
        const values = flagCore.getFlagValues();
        const temp = values.temperature;
        if (temp !== undefined && temp !== null) params.temperature = temp;
        const topP = values.top_p;
        if (topP !== undefined && topP !== null) params.top_p = topP;
        const topK = values.top_k;
        if (topK !== undefined && topK !== null && topK !== 0) params.top_k = topK;
        const minP = values.min_p;
        if (minP !== undefined && minP !== null) params.min_p = minP;
        const repeatPenalty = values.repeat_penalty;
        if (repeatPenalty !== undefined && repeatPenalty !== null && repeatPenalty !== 1.0) {
            params.repeat_penalty = repeatPenalty;
        }
        const nPredict = values.n_predict;
        if (nPredict !== undefined && nPredict !== null && nPredict !== -1) {
            params.max_tokens = nPredict;
        }
        return params;
    }

    async function sendMessage(userText) {
        if (chatStreaming || !userText.trim()) return;

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

        const endpoint = getServerEndpointConfig();
        const body = {
            model: getChatModelName(),
            messages,
            stream: true,
            host: endpoint.host,
            port: endpoint.port,
            ...getChatSamplerParams(),
        };
        if (isChatWebSearchEnabled()) {
            body.web_search = true;
            body.web_search_max_results = getChatWebSearchMaxResults();
        }

        chatAbortController = new AbortController();

        try {
            const resp = await fetch("/api/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
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

            const bubble = renderChatMessage("assistant", "");
            if (!resp.body) {
                renderChatMessage("assistant", "Error: Response body is empty.");
                chatStreaming = false;
                showChatSendButton(true);
                return;
            }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let fullContent = "";
            let responseSources = [];
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
                            fullContent += `Error: ${message}`;
                            appendChatStreamToken(bubble, `Error: ${message}`);
                            continue;
                        }
                        const delta = parsed.choices?.[0]?.delta?.content;
                        if (delta) {
                            fullContent += delta;
                            appendChatStreamToken(bubble, delta);
                        }
                    } catch (_) {
                        // skip malformed chunks
                    }
                }
            }

            if (streamDone) {
                await reader.cancel().catch(() => {});
            }
            setChatWebStatus(bubble, "");
            if (fullContent) {
                chatMessages.push({ role: "assistant", content: fullContent, sources: responseSources });
                saveCurrentConversation();
            }
        } catch (e) {
            removeChatTypingIndicator();
            if (e.name !== "AbortError") {
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
        if (!lastUserMsg || lastUserMsg.role !== "user") return;

        chatMessages.pop();
        const container = document.getElementById("chat-messages");
        const msgs = container.querySelectorAll(".chat-message");
        if (msgs.length > 0) msgs[msgs.length - 1].remove();

        sendMessage(lastUserMsg.content);
    }

    function getStoredConversations() {
        try {
            return JSON.parse(localStorage.getItem(CHAT_CONVERSATIONS_STORAGE_KEY)) || [];
        } catch (_) {
            return [];
        }
    }

    function saveConversationsToStorage(list) {
        try {
            localStorage.setItem(CHAT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(list));
        } catch (e) {
            console.warn("Failed to save conversations to localStorage:", e);
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

    function loadConversation(id) {
        const conversations = getStoredConversations();
        const convo = conversations.find(c => c.id === id);
        if (!convo) return;

        if (chatStreaming) stopStream();

        currentConversationId = convo.id;
        chatMessages = convo.messages.slice();

        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        if (sysPrompt) {
            sysPrompt.value = convo.systemPrompt || "";
            if (sysCharCount) sysCharCount.textContent = (convo.systemPrompt || "").length + " chars";
        }

        const container = document.getElementById("chat-messages");
        container.querySelectorAll(".chat-message").forEach(el => el.remove());
        const empty = document.getElementById("chat-empty");

        if (chatMessages.length === 0) {
            if (empty) empty.style.display = "";
        } else {
            if (empty) empty.style.display = "none";
            for (const msg of chatMessages) {
                renderChatMessage(msg.role, msg.content);
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

    function startNewChat() {
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
            preview.textContent = lastMsg ? lastMsg.content.trim().replace(/\n/g, " ").slice(0, 60) : "";

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

    function clearChat() {
        if (chatStreaming) stopStream();
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
        if (snapshotStatsBaseline) snapshotStatsBaseline();
    }

    function init() {
        const chatInput = document.getElementById("chat-input");
        const sendBtn = document.getElementById("btn-chat-send");
        const stopBtn = document.getElementById("btn-chat-stop");
        const undoBtn = document.getElementById("btn-chat-undo");
        const regenBtn = document.getElementById("btn-chat-regenerate");
        const sysPrompt = document.getElementById("chat-system-prompt");
        const sysCharCount = document.getElementById("chat-sys-char-count");
        const sidebar = document.getElementById("chat-sidebar");
        const btnCollapse = document.getElementById("btn-collapse-sidebar");
        const btnOpen = document.getElementById("btn-open-sidebar");
        const webSearchToggle = document.getElementById("chat-web-search-toggle");
        const webSearchMaxResults = document.getElementById("chat-web-search-max-results");

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

        chatInput.addEventListener("input", () => {
            chatInput.style.height = "auto";
            chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
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

        sysPrompt.addEventListener("input", () => {
            sysCharCount.textContent = sysPrompt.value.length + " chars";
        });
        sysCharCount.textContent = "0 chars";

        btnCollapse.addEventListener("click", () => {
            sidebar.classList.add("collapsed");
            btnOpen.style.display = "flex";
        });

        btnOpen.addEventListener("click", () => {
            sidebar.classList.remove("collapsed");
            btnOpen.style.display = "none";
        });

        const historyPanel = document.getElementById("chat-history-panel");
        const btnCollapseHistory = document.getElementById("btn-collapse-history");
        const btnOpenHistory = document.getElementById("btn-open-history");

        if (btnCollapseHistory && historyPanel) {
            btnCollapseHistory.addEventListener("click", () => {
                historyPanel.classList.add("collapsed");
                if (btnOpenHistory) btnOpenHistory.style.display = "flex";
            });
        }

        if (btnOpenHistory && historyPanel) {
            btnOpenHistory.addEventListener("click", () => {
                historyPanel.classList.remove("collapsed");
                btnOpenHistory.style.display = "none";
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
                    clearChat();
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

        document.querySelectorAll("#chat-empty .suggestion-chip").forEach(chip => {
            chip.addEventListener("click", () => {
                const prompt = chip.dataset.prompt;
                if (prompt) sendMessage(prompt);
            });
        });

        refreshSidebarUI();
    }

    window.LlamaGui.chatUi = {
        configure,
        init,
        refreshSidebarUI,
        updateStatusBadge,
    };
})();
