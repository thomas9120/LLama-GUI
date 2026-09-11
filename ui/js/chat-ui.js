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
    let workspaceConversationTitle = null;
    let workspaceConversationTitleCustom = false;
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
    let workspaceConfig = { checkpoint: null, invalidate: null, onChange: null, detachedView: false };
    let workspaceOwned = true;
    let workspaceSuspended = false;
    let workspaceHostAvailable = true;
    let workspaceEpoch = 0;
    let workspaceCheckpointTimer = null;
    let workspaceCheckpointPending = false;
    let workspaceTransferSave = false;
    let confirmationPending = 0;
    let streamingCheckpoint = null;
    let workspaceRestoreInProgress = false;
    let beforeUnloadInstalled = false;
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
    const CHAT_WORKSPACE_SCHEMA_VERSION = 1;
    const CHAT_WORKSPACE_KIND = "llama-gui-chat-workspace";
    const CHAT_MESSAGE_KEYS = [
        "role", "content", "reasoning", "reasoning_content", "sources", "status", "error", "metadata",
        "toolMessages", "tool_calls", "tool_call_id", "name", "id", "function", "versions", "versionIndex",
    ];
    const CHAT_MESSAGE_ROLES = ["user", "assistant", "tool", "system", "developer"];
    const CHAT_SOURCE_KEYS = ["url", "title", "index", "snippet", "domain", "date"];
    const CHAT_TOOL_CALL_KEYS = ["id", "type", "function"];
    const CHAT_TOOL_FUNCTION_KEYS = ["name", "arguments"];
    const CHAT_METADATA_KEYS = [
        "usage", "timings", "stop_reason", "stopReason", "finish_reason", "finishReason",
        "prompt_tokens", "completion_tokens", "total_tokens", "promptTokens", "completionTokens", "totalTokens",
        "tokens_per_second", "tokensPerSecond", "completion_tokens_per_second", "completionTokensPerSecond",
        "predicted_per_second", "predictedPerSecond", "prompt_per_second", "promptPerSecond",
        "prompt_n", "predicted_n", "prompt_ms", "predicted_ms", "time_to_first_token",
    ];
    const CHAT_METADATA_NESTED_KEYS = [
        "prompt_tokens", "completion_tokens", "total_tokens", "promptTokens", "completionTokens", "totalTokens",
        "tokens_per_second", "tokensPerSecond", "completion_tokens_per_second", "completionTokensPerSecond",
        "predicted_per_second", "predictedPerSecond", "prompt_per_second", "promptPerSecond",
        "prompt_n", "predicted_n", "prompt_ms", "predicted_ms", "time_to_first_token",
    ];
    const CHAT_TRANSFER_METADATA_KEYS = [
        "transferId", "sourceInstanceId", "destinationInstanceId", "revision", "epoch", "reason",
    ];
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

    function notifyWorkspaceChange() {
        updateBeforeUnloadGuard();
        if (typeof workspaceConfig.onChange !== "function") return;
        try {
            workspaceConfig.onChange();
        } catch (error) {
            console.warn("Chat workspace change callback failed", error);
        }
    }

    function workspaceMutationAllowed(expectedEpoch = workspaceEpoch) {
        return workspaceOwned && !workspaceSuspended && workspaceHostAvailable && expectedEpoch === workspaceEpoch;
    }

    function workspacePersistentWriteAllowed() {
        return workspaceOwned && workspaceHostAvailable && (!workspaceSuspended || workspaceTransferSave);
    }

    function workspaceBusyReason() {
        if (confirmationPending) return "A confirmation is pending.";
        if (characterImportPending) return "A character card is being imported.";
        if (pendingEdit) return "An edit is pending.";
        if (compactionController) return "Compaction is in progress.";
        if (sendPreflightPromise) return "A send is being prepared.";
        if (chatStreaming) return "A response is streaming.";
        return "";
    }

    function beforeUnloadIsRisky() {
        return workspaceOwned && workspaceHostAvailable
            && (chatStreaming || compactionController || sendPreflightPromise || workspaceCheckpointPending);
    }

    function handleBeforeUnload(event) {
        if (!beforeUnloadIsRisky()) return;
        event.preventDefault();
        event.returnValue = "";
    }

    function updateBeforeUnloadGuard() {
        const target = typeof window !== "undefined" ? window : null;
        if (!target || typeof target.addEventListener !== "function") return;
        const risky = beforeUnloadIsRisky();
        if (risky && !beforeUnloadInstalled) {
            target.addEventListener("beforeunload", handleBeforeUnload);
            beforeUnloadInstalled = true;
        } else if (!risky && beforeUnloadInstalled) {
            target.removeEventListener?.("beforeunload", handleBeforeUnload);
            beforeUnloadInstalled = false;
        }
    }

    async function requestConfirmation(...args) {
        if (!workspaceMutationAllowed()) return false;
        const ownerEpoch = workspaceEpoch;
        confirmationPending += 1;
        updateChatAvailability(isServerRunning());
        notifyWorkspaceChange();
        try {
            const confirmed = typeof confirmAction === "function" ? await confirmAction(...args) : true;
            return Boolean(confirmed) && workspaceMutationAllowed(ownerEpoch);
        } finally {
            confirmationPending = Math.max(0, confirmationPending - 1);
            updateChatAvailability(isServerRunning());
            notifyWorkspaceChange();
        }
    }

    function getTransferState() {
        if (!workspaceOwned) return { allowed: false, reason: "Chat is owned by another window." };
        if (!workspaceHostAvailable) return { allowed: false, reason: "The chat host is unavailable." };
        if (workspaceSuspended) return { allowed: false, reason: "Chat transfer is already suspended." };
        const reason = workspaceBusyReason();
        if (reason) return { allowed: false, reason };
        return { allowed: true, reason: "" };
    }

    function configureWorkspace(options = {}) {
        workspaceConfig = {
            checkpoint: typeof options.checkpoint === "function" ? options.checkpoint : null,
            invalidate: typeof options.invalidate === "function" ? options.invalidate : null,
            onChange: typeof options.onChange === "function" ? options.onChange : null,
            detachedView: options.detachedView === true,
        };
        window.LlamaGui.chatTools.configureWorkspace?.({
            detachedView: workspaceConfig.detachedView,
            canMutate: () => workspaceMutationAllowed() || workspaceRestoreInProgress,
            onChange: notifyWorkspaceChange,
        });
        notifyWorkspaceChange();
        if (flagCore) updateChatAvailability(isServerRunning());
    }

    function suspendTransfer() {
        if (!getTransferState().allowed) return false;
        workspaceSuspended = true;
        clearWorkspaceCheckpointTimer();
        cancelContextPreview();
        updateChatAvailability(isServerRunning());
        notifyWorkspaceChange();
        return true;
    }

    function resumeTransfer() {
        if (!workspaceOwned) return false;
        workspaceSuspended = false;
        updateChatAvailability(isServerRunning());
        notifyWorkspaceChange();
        return true;
    }

    function setOwnership(active) {
        workspaceEpoch += 1;
        workspaceOwned = active === true;
        workspaceSuspended = !workspaceOwned;
        if (!workspaceOwned) {
            clearWorkspaceCheckpointTimer();
            workspaceCheckpointPending = false;
            cancelContextPreview();
            if (chatAbortController) chatAbortController.abort();
            if (compactionController) compactionController.abort();
        }
        updateChatAvailability(isServerRunning());
        notifyWorkspaceChange();
        return true;
    }

    function setHostAvailable(available) {
        const next = available === true;
        if (next !== workspaceHostAvailable) workspaceEpoch += 1;
        workspaceHostAvailable = next;
        if (!workspaceHostAvailable) {
            clearWorkspaceCheckpointTimer();
            workspaceCheckpointPending = false;
            cancelContextPreview();
            if (compactionController) compactionController.abort();
        }
        updateChatAvailability(isServerRunning());
        notifyWorkspaceChange();
    }

    function getChatSamplerValues() {
        const values = flagCore?.getFlagValues?.() || {};
        const result = {};
        for (const meta of Object.values(CHAT_NUMERIC_INPUTS)) {
            const value = normalizeSamplerNumber(values[meta.flag]);
            if (value !== null) result[meta.flag] = value;
        }
        return result;
    }

    function getChatSamplerFlagIds() {
        return Object.values(CHAT_NUMERIC_INPUTS).map(meta => meta.flag);
    }

    function setChatSamplerValue(flag, value) {
        const meta = Object.values(CHAT_NUMERIC_INPUTS).find(item => item.flag === flag);
        const normalized = normalizeSamplerNumber(value);
        if (!meta || normalized === null || (meta.integer && !Number.isInteger(normalized)) || !workspaceMutationAllowed()) return false;
        flagCore?.setFlagValue?.(flag, normalized);
        refreshSidebarUI();
        requestWorkspaceCheckpoint({ reason: "sampler" });
        return true;
    }

    function captureLayout() {
        return {
            focusMode: Boolean(chatFocusMode),
            settingsCollapsed: getStoredItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY) !== "false",
            historyCollapsed: getStoredItem(CHAT_HISTORY_COLLAPSED_STORAGE_KEY) !== "false",
        };
    }

    function restoreLayout(layout) {
        if (!layout || typeof layout !== "object") return false;
        if (typeof layout.focusMode !== "boolean"
            || typeof layout.settingsCollapsed !== "boolean"
            || typeof layout.historyCollapsed !== "boolean") return false;
        chatFocusMode = layout.focusMode;
        document.body?.classList.toggle("chat-focus-mode", chatFocusMode);
        updateChatFocusButton();
        if (!workspaceConfig.detachedView && workspaceMutationAllowed()) {
            setStoredItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY, String(layout.settingsCollapsed));
            setStoredItem(CHAT_HISTORY_COLLAPSED_STORAGE_KEY, String(layout.historyCollapsed));
        }
        chatPanelLayouts.forEach(applyLayout => applyLayout());
        return true;
    }

    function copyScalar(value) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number" && Number.isFinite(value)) return value;
        return undefined;
    }

    function copyKnownObject(value, keys) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const result = {};
        for (const key of keys) {
            const copied = copyScalar(value[key]);
            if (copied !== undefined) result[key] = copied;
        }
        return result;
    }

    function copyMetadata(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const result = {};
        for (const key of CHAT_METADATA_KEYS) {
            const source = value[key];
            if ((key === "usage" || key === "timings") && source && typeof source === "object" && !Array.isArray(source)) {
                const nested = copyKnownObject(source, CHAT_METADATA_NESTED_KEYS);
                if (Object.keys(nested).length) result[key] = nested;
            } else {
                const copied = copyScalar(source);
                if (copied !== undefined) result[key] = copied;
            }
        }
        return result;
    }

    function copySource(value) {
        return copyKnownObject(value, CHAT_SOURCE_KEYS);
    }

    function copyToolCall(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const result = copyKnownObject(value, ["id", "type"]);
        const fn = copyKnownObject(value.function, CHAT_TOOL_FUNCTION_KEYS);
        if (fn && Object.keys(fn).length) result.function = fn;
        return result;
    }

    function copyMessage(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const result = {};
        for (const key of CHAT_MESSAGE_KEYS) {
            const source = value[key];
            if (key === "sources" && Array.isArray(source)) {
                result.sources = source.map(copySource).filter(Boolean);
            } else if (key === "metadata") {
                const metadata = copyMetadata(source);
                if (metadata && Object.keys(metadata).length) result.metadata = metadata;
            } else if (key === "toolMessages" && Array.isArray(source)) {
                result.toolMessages = source.map(copyMessage).filter(Boolean);
            } else if (key === "tool_calls" && Array.isArray(source)) {
                result.tool_calls = source.map(copyToolCall).filter(Boolean);
            } else if (key === "versions" && Array.isArray(source)) {
                result.versions = source.map(copyMessage).filter(Boolean);
            } else {
                const copied = copyScalar(source);
                if (copied !== undefined) result[key] = copied;
            }
        }
        return result;
    }

    function copyCompaction(value) {
        return copyKnownObject(value, ["end", "summary", "savedTokens"]);
    }

    function copyStreamingCheckpoint(value) {
        if (!value || typeof value !== "object") return null;
        const result = copyKnownObject(value, ["active", "replacementIndex", "content", "reasoning", "status", "error", "userText"]);
        if (Array.isArray(value.sources)) result.sources = value.sources.map(copySource).filter(Boolean);
        const metadata = copyMetadata(value.metadata);
        if (metadata && Object.keys(metadata).length) result.metadata = metadata;
        if (Array.isArray(value.toolMessages)) result.toolMessages = value.toolMessages.map(copyMessage).filter(Boolean);
        return result;
    }

    function sanitizeTransferMetadata(value) {
        const result = {};
        if (!value || typeof value !== "object" || Array.isArray(value)) return result;
        for (const key of CHAT_TRANSFER_METADATA_KEYS) {
            const copied = copyScalar(value[key]);
            if (copied !== undefined) result[key] = copied;
        }
        return result;
    }

    function validateTransferMetadata(value) {
        return hasOnlyKnownKeys(value, CHAT_TRANSFER_METADATA_KEYS)
            && Object.values(value).every(item => isSafeScalar(item));
    }

    function getConversationTitleState() {
        const active = currentConversationId && getStoredConversations().find(item => item.id === currentConversationId);
        return {
            id: currentConversationId || null,
            title: active?.title || workspaceConversationTitle || (chatMessages.length ? generateConversationTitle(chatMessages) : null),
            titleCustom: Boolean(active?.titleCustom ?? workspaceConversationTitleCustom),
        };
    }

    function captureSnapshot(metadata = {}) {
        const container = getChatMessagesContainer();
        const input = document.getElementById("chat-input");
        return {
            kind: CHAT_WORKSPACE_KIND,
            schemaVersion: CHAT_WORKSPACE_SCHEMA_VERSION,
            metadata: sanitizeTransferMetadata(metadata),
            conversation: getConversationTitleState(),
            messages: chatMessages.map(copyMessage).filter(Boolean),
            compactions: chatCompactions.map(copyCompaction).filter(Boolean),
            inputs: {
                systemPrompt: String(document.getElementById("chat-system-prompt")?.value || ""),
                thinkingEffort: getChatThinkingEffort(),
                draft: String(input?.value || ""),
                webSearchEnabled: isChatWebSearchEnabled(),
                webSearchMaxResults: getChatWebSearchMaxResults(),
                datetimeEnabled: Boolean(window.LlamaGui.chatTools.isEnabled?.()),
                autoCompaction: isAutoCompactionEnabled(),
            },
            view: {
                scroll: {
                    follow: Boolean(chatScrollState?.follow ?? isChatNearBottom(container)),
                    top: Number.isFinite(chatScrollState?.top) ? chatScrollState.top : Number(container?.scrollTop) || 0,
                },
                draftSelection: input && Number.isInteger(input.selectionStart) && Number.isInteger(input.selectionEnd)
                    ? { start: input.selectionStart, end: input.selectionEnd } : null,
            },
            streaming: copyStreamingCheckpoint(streamingCheckpoint),
        };
    }

    function hasOnlyKnownKeys(value, keys) {
        return value && typeof value === "object" && !Array.isArray(value)
            && Object.keys(value).every(key => keys.includes(key));
    }

    function isSafeScalar(value) {
        return value === null || typeof value === "string" || typeof value === "boolean"
            || (typeof value === "number" && Number.isFinite(value));
    }

    function validateMetadata(value) {
        if (!hasOnlyKnownKeys(value, CHAT_METADATA_KEYS)) return false;
        for (const [key, item] of Object.entries(value)) {
            if (key === "usage" || key === "timings") {
                if (!hasOnlyKnownKeys(item, CHAT_METADATA_NESTED_KEYS)
                    || Object.values(item).some(nested => !isSafeScalar(nested))) return false;
            } else if (!isSafeScalar(item)) return false;
        }
        return true;
    }

    function validateSource(value) {
        return hasOnlyKnownKeys(value, CHAT_SOURCE_KEYS)
            && Object.values(value).every(item => isSafeScalar(item));
    }

    function validateToolCall(value) {
        if (!hasOnlyKnownKeys(value, CHAT_TOOL_CALL_KEYS)
            || (value.id !== undefined && !isSafeScalar(value.id))
            || (value.type !== undefined && !isSafeScalar(value.type))) return false;
        if (value.function === undefined) return true;
        return hasOnlyKnownKeys(value.function, CHAT_TOOL_FUNCTION_KEYS)
            && Object.values(value.function).every(item => isSafeScalar(item));
    }

    function validateMessage(value, allowMissingRole = false) {
        if (!hasOnlyKnownKeys(value, CHAT_MESSAGE_KEYS)) return false;
        if ((!allowMissingRole && !CHAT_MESSAGE_ROLES.includes(value.role))
            || (allowMissingRole && value.role !== undefined && !CHAT_MESSAGE_ROLES.includes(value.role))
            || typeof value.content !== "string") return false;
        for (const [key, item] of Object.entries(value)) {
            if (["sources"].includes(key)) {
                if (!Array.isArray(item) || item.some(source => !validateSource(source))) return false;
            } else if (["toolMessages", "versions"].includes(key)) {
                if (!Array.isArray(item) || item.some(message => !validateMessage(message, key === "versions"))) return false;
            } else if (key === "tool_calls") {
                if (!Array.isArray(item) || item.some(call => !validateToolCall(call))) return false;
            } else if (key === "metadata") {
                if (!validateMetadata(item)) return false;
            } else if (!isSafeScalar(item)) return false;
        }
        return true;
    }

    function validateSnapshot(snapshot) {
        const topKeys = ["kind", "schemaVersion", "metadata", "conversation", "messages", "compactions", "inputs", "view", "streaming"];
        if (!hasOnlyKnownKeys(snapshot, topKeys)
            || snapshot.kind !== CHAT_WORKSPACE_KIND
            || snapshot.schemaVersion !== CHAT_WORKSPACE_SCHEMA_VERSION
            || !validateTransferMetadata(snapshot.metadata)
            || !Array.isArray(snapshot.messages) || snapshot.messages.some(message => !validateMessage(message))
            || !Array.isArray(snapshot.compactions)
            || snapshot.compactions.some(record => !hasOnlyKnownKeys(record, ["end", "summary", "savedTokens"])
                || typeof record.end !== "number" || !Number.isInteger(record.end) || record.end < 0
                || typeof record.summary !== "string"
                || (record.savedTokens !== undefined && !isSafeScalar(record.savedTokens)))) return false;

        const conversation = snapshot.conversation;
        if (!hasOnlyKnownKeys(conversation, ["id", "title", "titleCustom"])
            || (conversation.id !== null && typeof conversation.id !== "string")
            || (conversation.title !== null && typeof conversation.title !== "string")
            || typeof conversation.titleCustom !== "boolean") return false;

        const inputs = snapshot.inputs;
        const inputKeys = ["systemPrompt", "thinkingEffort", "draft", "webSearchEnabled", "webSearchMaxResults", "datetimeEnabled", "autoCompaction"];
        if (!hasOnlyKnownKeys(inputs, inputKeys)
            || typeof inputs.systemPrompt !== "string"
            || !CHAT_THINKING_EFFORTS.includes(inputs.thinkingEffort)
            || typeof inputs.draft !== "string"
            || typeof inputs.webSearchEnabled !== "boolean"
            || !Number.isInteger(inputs.webSearchMaxResults) || inputs.webSearchMaxResults < CHAT_WEB_SEARCH_MIN_RESULTS || inputs.webSearchMaxResults > CHAT_WEB_SEARCH_MAX_RESULTS
            || typeof inputs.datetimeEnabled !== "boolean"
            || typeof inputs.autoCompaction !== "boolean") return false;

        const view = snapshot.view;
        if (!hasOnlyKnownKeys(view, ["scroll", "draftSelection"])
            || !hasOnlyKnownKeys(view.scroll, ["follow", "top"])
            || typeof view.scroll.follow !== "boolean" || typeof view.scroll.top !== "number" || !Number.isFinite(view.scroll.top)) return false;
        if (view.draftSelection !== null
            && (!hasOnlyKnownKeys(view.draftSelection, ["start", "end"])
                || !Number.isInteger(view.draftSelection.start) || view.draftSelection.start < 0
                || !Number.isInteger(view.draftSelection.end) || view.draftSelection.end < view.draftSelection.start)) return false;

        if (snapshot.streaming !== null) {
            const streamingKeys = ["active", "replacementIndex", "content", "reasoning", "status", "error", "userText", "sources", "metadata", "toolMessages"];
            if (!hasOnlyKnownKeys(snapshot.streaming, streamingKeys)
                || (snapshot.streaming.active !== undefined && typeof snapshot.streaming.active !== "boolean")
                || (snapshot.streaming.replacementIndex !== undefined && (!Number.isInteger(snapshot.streaming.replacementIndex) || snapshot.streaming.replacementIndex < -1))
                || Object.entries(snapshot.streaming).some(([key, value]) => ["active", "replacementIndex", "content", "reasoning", "status", "error", "userText"].includes(key) && !isSafeScalar(value))) return false;
            if (snapshot.streaming.sources && (!Array.isArray(snapshot.streaming.sources) || snapshot.streaming.sources.some(source => !validateSource(source)))) return false;
            if (snapshot.streaming.metadata && !validateMetadata(snapshot.streaming.metadata)) return false;
            if (snapshot.streaming.toolMessages && (!Array.isArray(snapshot.streaming.toolMessages) || snapshot.streaming.toolMessages.some(message => !validateMessage(message)))) return false;
        }
        return true;
    }

    // Stage a validated workspace before ownership is activated. Restoring does
    // not grant permission to send or persist; those paths retain owner guards.
    function restoreSnapshot(snapshot) {
        if (!validateSnapshot(snapshot)) return false;
        workspaceRestoreInProgress = true;
        try {
            currentConversationId = snapshot.conversation.id;
            workspaceConversationTitle = snapshot.conversation.title;
            workspaceConversationTitleCustom = snapshot.conversation.titleCustom;
            chatMessages = snapshot.messages.map(copyMessage).filter(Boolean);
            chatCompactions = snapshot.compactions.map(copyCompaction).filter(Boolean);
            const inputs = snapshot.inputs;
            const systemPrompt = document.getElementById("chat-system-prompt");
            const sysCharCount = document.getElementById("chat-sys-char-count");
            if (systemPrompt) systemPrompt.value = inputs.systemPrompt;
            if (sysCharCount) sysCharCount.textContent = `${inputs.systemPrompt.length} chars`;
            const chatInput = document.getElementById("chat-input");
            if (chatInput) {
                chatInput.value = inputs.draft;
                if (snapshot.view.draftSelection) {
                    chatInput.selectionStart = snapshot.view.draftSelection.start;
                    chatInput.selectionEnd = snapshot.view.draftSelection.end;
                }
            }
            setChatThinkingEffort(inputs.thinkingEffort);
            const webSearchToggle = document.getElementById("chat-web-search-toggle");
            if (webSearchToggle) webSearchToggle.checked = inputs.webSearchEnabled;
            const webSearchMaxResults = document.getElementById("chat-web-search-max-results");
            if (webSearchMaxResults) webSearchMaxResults.value = String(inputs.webSearchMaxResults);
            const autoToggle = document.getElementById("chat-auto-compact-toggle");
            if (autoToggle) autoToggle.checked = inputs.autoCompaction;
            window.LlamaGui.chatTools.setEnabled(inputs.datetimeEnabled, { persist: false });
            chatScrollState = { ...snapshot.view.scroll };
            streamingCheckpoint = copyStreamingCheckpoint(snapshot.streaming);
            if (streamingCheckpoint?.active) {
                const partial = {
                    role: "assistant",
                    content: streamingCheckpoint.content || "",
                    reasoning: streamingCheckpoint.reasoning || "",
                    sources: streamingCheckpoint.sources || [],
                    status: "stopped",
                    error: streamingCheckpoint.error || "",
                    metadata: streamingCheckpoint.metadata || {},
                    ...(streamingCheckpoint.toolMessages ? { toolMessages: streamingCheckpoint.toolMessages } : {}),
                };
                if (Number.isInteger(streamingCheckpoint.replacementIndex)
                    && streamingCheckpoint.replacementIndex >= 0
                    && streamingCheckpoint.replacementIndex < chatMessages.length) {
                    const previous = chatMessages[streamingCheckpoint.replacementIndex];
                    const previousVersions = Array.isArray(previous.versions)
                        ? previous.versions.map(copyMessage).filter(Boolean)
                        : [copyMessage(previous)];
                    const attempted = { ...partial };
                    delete attempted.role;
                    const selected = Math.min(
                        Math.max(0, Number.isInteger(previous.versionIndex) ? previous.versionIndex : 0),
                        Math.max(0, previousVersions.length - 1),
                    );
                    previousVersions.push(attempted);
                    chatMessages[streamingCheckpoint.replacementIndex] = {
                        role: "assistant", ...previousVersions[selected], versions: previousVersions, versionIndex: selected,
                    };
                } else if (partial.content || partial.reasoning || partial.toolMessages?.length) {
                    chatMessages.push(partial);
                }
                streamingCheckpoint.active = false;
            }
            chatStreaming = false;
            chatAbortController = null;
            cancelContextPreview();
            renderConversationMessages();
            renderHistoryList();
            restoreChatScrollPosition();
            return true;
        } finally {
            workspaceRestoreInProgress = false;
            notifyWorkspaceChange();
        }
    }

    // Recovery can acquire the workspace lock before it knows whether a
    // valid checkpoint exists. Clear only this in-memory view for the empty
    // or tombstoned case; callers still decide when durable deletion occurs.
    function resetWorkspace() {
        if (!workspaceHostAvailable || !workspaceOwned) return false;
        workspaceRestoreInProgress = true;
        try {
            currentConversationId = null;
            workspaceConversationTitle = null;
            workspaceConversationTitleCustom = false;
            chatMessages = [];
            chatCompactions = [];
            streamingCheckpoint = null;
            workspaceCheckpointPending = false;
            chatStreaming = false;
            if (chatAbortController) chatAbortController.abort();
            if (compactionController) compactionController.abort();
            chatAbortController = null;
            discardPendingEdit();
            const systemPrompt = document.getElementById("chat-system-prompt");
            const sysCharCount = document.getElementById("chat-sys-char-count");
            if (systemPrompt) systemPrompt.value = "";
            if (sysCharCount) sysCharCount.textContent = "0 chars";
            const chatInput = document.getElementById("chat-input");
            if (chatInput) {
                chatInput.value = "";
                chatInput.selectionStart = 0;
                chatInput.selectionEnd = 0;
            }
            const webSearchToggle = document.getElementById("chat-web-search-toggle");
            if (webSearchToggle) webSearchToggle.checked = false;
            const webSearchMaxResults = document.getElementById("chat-web-search-max-results");
            if (webSearchMaxResults) webSearchMaxResults.value = String(CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS);
            const autoToggle = document.getElementById("chat-auto-compact-toggle");
            if (autoToggle) autoToggle.checked = true;
            setChatThinkingEffort("auto");
            window.LlamaGui.chatTools.setEnabled(false, { persist: false });
            renderConversationMessages();
            renderHistoryList();
            notifyWorkspaceChange();
            return true;
        } finally {
            workspaceRestoreInProgress = false;
        }
    }

    function checkpointWorkspaceNow(metadata = {}) {
        if (typeof workspaceConfig.checkpoint !== "function") {
            workspaceCheckpointPending = false;
            updateBeforeUnloadGuard();
            return true;
        }
        if ((!workspaceOwned || !workspaceHostAvailable || workspaceSuspended) && !workspaceTransferSave) return false;
        try {
            const checkpointed = workspaceConfig.checkpoint(captureSnapshot(metadata)) !== false;
            if (checkpointed) workspaceCheckpointPending = false;
            updateBeforeUnloadGuard();
            return checkpointed;
        } catch (error) {
            console.warn("Chat workspace checkpoint failed", error);
            return false;
        }
    }

    function clearWorkspaceCheckpointTimer() {
        if (workspaceCheckpointTimer !== null) clearTimeout(workspaceCheckpointTimer);
        workspaceCheckpointTimer = null;
    }

    function requestWorkspaceCheckpoint(metadata = {}) {
        if (typeof workspaceConfig.checkpoint !== "function" || workspaceSuspended || !workspaceOwned || !workspaceHostAvailable) return;
        if (workspaceCheckpointTimer !== null) return;
        workspaceCheckpointPending = true;
        updateBeforeUnloadGuard();
        workspaceCheckpointTimer = setTimeout(() => {
            workspaceCheckpointTimer = null;
            checkpointWorkspaceNow(metadata);
        }, 750);
    }

    function invalidateWorkspace() {
        clearWorkspaceCheckpointTimer();
        if (typeof workspaceConfig.invalidate !== "function") return true;
        try {
            return workspaceConfig.invalidate() !== false;
        } catch (error) {
            console.warn("Chat workspace invalidation failed", error);
            return false;
        }
    }

    function saveForTransfer() {
        if (!workspaceOwned || !workspaceSuspended || !workspaceHostAvailable) return false;
        workspaceTransferSave = true;
        try {
            const saved = saveCurrentConversation({ skipCheckpoint: true });
            const checkpointed = checkpointWorkspaceNow({ reason: "transfer-save" });
            return saved && checkpointed;
        } finally {
            workspaceTransferSave = false;
        }
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

    function setChatPreference(storageKey, value) {
        if (!workspaceMutationAllowed()) return false;
        const saved = setStoredItem(storageKey, value);
        if (saved) {
            notifyWorkspaceChange();
            requestWorkspaceCheckpoint({ reason: "chat-preference" });
        }
        return saved;
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
        const canOperate = workspaceMutationAllowed();
        const canSend = Boolean(isRunning) && canOperate && !chatStreaming && !compactionController && !sendPreflightPromise;
        const characterButton = document.getElementById("btn-chat-load-character");
        if (characterButton) characterButton.disabled = !canOperate || characterImportPending || chatStreaming || Boolean(compactionController) || Boolean(sendPreflightPromise);

        if (chatInput) {
            chatInput.disabled = !isRunning || !canOperate;
            chatInput.placeholder = !canOperate
                ? (workspaceOwned ? "Chat is temporarily unavailable while the other window is active." : "Chat is open in another window.")
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
                button.disabled = !canOperate || chatStreaming || Boolean(compactionController) || (button.dataset.requiresServer === "true" && !isRunning);
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
        notifyWorkspaceChange();
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
                if (!workspaceConfig.detachedView && workspaceMutationAllowed()) setStoredItem(storageKey, "false");
            }
            setChatPanelCollapsed(panel, openButton, collapseButton, false);
            collapseButton.focus();
        });
        collapseButton.addEventListener("click", () => {
            if (!chatFocusMode) {
                preferredCollapsed = true;
                if (!workspaceConfig.detachedView && workspaceMutationAllowed()) setStoredItem(storageKey, "true");
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
        button.disabled = !compactionController && (!available || chatStreaming || !isServerRunning() || !workspaceMutationAllowed());
        button.textContent = compactionController ? "Cancel compaction" : "Compact conversation";
        button.title = "Summarize older messages; keep the transcript and last two turns unchanged.";
        for (const id of ["btn-chat-undo-compaction", "btn-chat-tools-undo-compaction"]) {
            const undo = document.getElementById(id);
            if (undo) undo.disabled = !workspaceMutationAllowed() || chatStreaming || Boolean(compactionController);
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
        if (!workspaceMutationAllowed() || chatStreaming || compactionController || !chatCompactions.length) return false;
        if (!invalidateWorkspace()) return false;
        const previous = chatCompactions.slice();
        chatCompactions.pop();
        if (!saveCurrentConversation()) {
            chatCompactions = previous;
            return false;
        }
        requestWorkspaceCheckpoint({ reason: "undo-compaction" });
        renderCompactionMarker();
        updateCompactionControls();
        scheduleContextPreview(true);
        return true;
    }

    function compactConversation(draftOverride = null) {
        if (!workspaceMutationAllowed() || chatStreaming || compactionController || !isServerRunning()) return Promise.resolve(false);
        const ownerEpoch = workspaceEpoch;
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
                if (controller.signal.aborted || !workspaceMutationAllowed(ownerEpoch) || !isServerRunning() || compactionKey !== getCompactionKey()) {
                    throw Object.assign(new Error("Chat changed"), { name: "AbortError" });
                }
                chatCompactions.push(record);
                if (!saveCurrentConversation()) {
                    chatCompactions.pop();
                    throw new Error("Could not save the compaction.");
                }
                requestWorkspaceCheckpoint({ reason: "compaction" });
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

    function setAutoCompactionEnabled(enabled, options = {}) {
        if (!workspaceMutationAllowed() && options.force !== true) return false;
        const value = Boolean(enabled);
        const toggle = document.getElementById("chat-auto-compact-toggle");
        if (toggle) toggle.checked = value;
        if (options.persist !== false && workspaceMutationAllowed()) {
            setStoredItem(CHAT_AUTO_COMPACTION_STORAGE_KEY, String(value));
        }
        notifyWorkspaceChange();
        requestWorkspaceCheckpoint({ reason: "auto-compaction" });
        return true;
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
        if (!workspaceMutationAllowed()) {
            cancelContextPreview();
            latestContextBudget = null;
            latestContextBodyKey = null;
            renderContextBudget({ message: workspaceOwned ? "Chat context preview is paused during transfer." : "Chat is open in another window." });
            return;
        }
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
        if (!workspaceMutationAllowed()) return null;
        const ownerEpoch = workspaceEpoch;
        const controller = new AbortController();
        contextController = controller;
        try {
            const response = await fetch("/api/chat/context", {
                method: "POST", headers: getApiAuthorizationHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify(body), signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const budget = await response.json();
            if (workspaceMutationAllowed(ownerEpoch) && revision === contextRevision && !chatStreaming) {
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

    async function maybeCompactBeforeSend(userText, attemptToken, retry = false, ownerEpoch = workspaceEpoch) {
        if (!workspaceMutationAllowed(ownerEpoch) || attemptToken !== sendAttemptToken) return false;
        if (!isAutoCompactionEnabled() || autoCompactionAttempted || pendingEdit) return true;
        const replacementIndex = retry && chatMessages[chatMessages.length - 1]?.role === "assistant"
            ? chatMessages.length - 1 : -1;
        const history = replacementIndex >= 0 ? chatMessages.slice(0, replacementIndex) : chatMessages;
        const draft = replacementIndex >= 0 ? "" : userText;
        const body = buildChatBody(history, draft);
        const runtimeKey = getChatRuntimeKey();
        const stale = () => !workspaceMutationAllowed(ownerEpoch) || attemptToken !== sendAttemptToken || runtimeKey !== getChatRuntimeKey();
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
        if (!workspaceMutationAllowed() || chatStreaming || compactionController || sendPreflightPromise || !userText.trim()) return Promise.resolve(false);
        autoCompactionAttempted = false;
        const attemptToken = ++sendAttemptToken;
        const ownerEpoch = workspaceEpoch;
        const pending = runMessage(userText, retry, attemptToken, ownerEpoch);
        sendPreflightPromise = pending;
        chatStreamPromise = pending;
        updateChatAvailability(isServerRunning());
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
        if (!workspaceMutationAllowed() || chatStreaming || compactionController || !chatMessages[index] || chatMessages[index].role !== "user") return false;
        const ownerEpoch = workspaceEpoch;
        const stored = getStoredConversations();
        const active = currentConversationId && stored.find(item => item.id === currentConversationId);
        const backupTitle = `${active?.title || generateConversationTitle(chatMessages)} — before edit`;
        const confirmed = await requestConfirmation("Edit and resend", `A selectable history copy named “${backupTitle}” will preserve the current conversation and later turns. The active conversation will be truncated only when you resend. Continue?`, "Edit message");
        if (!confirmed || !workspaceMutationAllowed(ownerEpoch)) return false;
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
        if (!workspacePersistentWriteAllowed() || !edit) return false;
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

    function finalizeAssistantResponse(content, reasoning, sources, status, error, replacementIndex, metadata = {}, toolMessages = [], expectedEpoch = workspaceEpoch) {
        if (!workspaceMutationAllowed(expectedEpoch)) return false;
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
        streamingCheckpoint = null;
        requestWorkspaceCheckpoint({ reason: "response-finalized" });
        notifyWorkspaceChange();
        return true;
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
                    if (workspaceMutationAllowed() && !chatStreaming && !compactionController && chatMessages[index] === msg) return action();
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
                    if (!workspaceMutationAllowed()) return false;
                    const previous = chatMessages[index];
                    chatMessages[index] = { role: "assistant", ...msg.versions[value], versions: msg.versions, versionIndex: value };
                    if (!saveCurrentConversation()) {
                        chatMessages[index] = previous;
                        return false;
                    }
                    renderConversationMessages(index);
                    requestWorkspaceCheckpoint({ reason: "select-version" });
                    return true;
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

    async function runMessage(userText, retry = false, attemptToken = sendAttemptToken, ownerEpoch = workspaceEpoch) {
        if (!workspaceMutationAllowed(ownerEpoch) || chatStreaming || compactionController || !userText.trim()) return false;
        if (!isServerRunning()) {
            updateStatusBadge();
            return;
        }

        const trimmedText = userText.trim();
        if (!await maybeCompactBeforeSend(trimmedText, attemptToken, retry, ownerEpoch)
            || !workspaceMutationAllowed(ownerEpoch) || attemptToken !== sendAttemptToken) return false;
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
            if (!invalidateWorkspace()) return false;
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
        streamingCheckpoint = {
            active: true, replacementIndex, content: "", reasoning: "", sources: [], status: "streaming", error: "",
            userText: trimmedText, metadata: {}, toolMessages: [],
        };
        requestWorkspaceCheckpoint({ reason: "response-started" });
        notifyWorkspaceChange();
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

                if (!workspaceMutationAllowed(ownerEpoch)) throw Object.assign(new Error("Chat ownership changed"), { name: "AbortError" });

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
                    if (!workspaceMutationAllowed(ownerEpoch)) throw Object.assign(new Error("Chat ownership changed"), { name: "AbortError" });
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
                            streamingCheckpoint.sources = responseSources;
                            requestWorkspaceCheckpoint({ reason: "response-progress" });
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
                            streamingCheckpoint.status = finishReason === "length" ? "length" : "complete";
                            if (finishReason === "length") status = "length";
                        }
                        updateResponseMetadata(responseMetadata, parsed);
                        streamingCheckpoint.metadata = responseMetadata;
                        if (delta?.tool_calls !== undefined) {
                            if (!body.tools?.length) throw new Error("The model requested a tool while Chat tools are disabled.");
                            window.LlamaGui.chatTools.collectCalls(toolCalls, delta.tool_calls);
                        }
                        const reasoningDelta = getChatDeltaText(delta, ["reasoning_content", "reasoning"]);
                        if (reasoningDelta) {
                            fullReasoning += reasoningDelta;
                            streamingCheckpoint.reasoning = fullReasoning;
                            appendChatReasoningStreamToken(bubble, reasoningDelta);
                            followChatOutput();
                        }
                        const contentDelta = getChatDeltaText(delta, ["content"]);
                        if (contentDelta) {
                            fullContent += contentDelta;
                            streamingCheckpoint.content = fullContent;
                            appendChatStreamToken(bubble, contentDelta);
                            followChatOutput();
                        }
                        if (reasoningDelta || contentDelta) requestWorkspaceCheckpoint({ reason: "response-progress" });
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
                if (!workspaceMutationAllowed(ownerEpoch)) throw Object.assign(new Error("Chat ownership changed"), { name: "AbortError" });
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
                    streamingCheckpoint.toolMessages = toolMessages;
                    requestWorkspaceCheckpoint({ reason: "response-progress" });
                    body.messages.push(...toolMessages);
                    body.tool_choice = "none";
                    fullContent = "";
                    fullReasoning = "";
                    streamingCheckpoint.content = "";
                    streamingCheckpoint.reasoning = "";
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
            if (workspaceMutationAllowed(ownerEpoch)) {
                streamingCheckpoint.status = status;
                streamingCheckpoint.error = error;
                finalizeAssistantResponse(fullContent, fullReasoning, responseSources, status, error, replacementIndex, responseMetadata, toolMessages, ownerEpoch);
            }
            chatStreaming = false;
            chatAbortController = null;
            showChatSendButton(true);
            updateChatAvailability(isServerRunning());
            if (chatScrollState?.follow) followChatOutput();
            else updateChatJumpButton(true);
            if (status !== "failed") scheduleContextPreview(true);
            const chatInput = document.getElementById("chat-input");
            if (chatInput) chatInput.focus();
            notifyWorkspaceChange();
        }
        return workspaceMutationAllowed(ownerEpoch);
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
        if (!workspaceMutationAllowed() || chatStreaming || compactionController || chatMessages.length === 0) return false;
        if (currentConversationId && !invalidateWorkspace()) return false;
        const previousMessages = chatMessages.slice();
        const previousCompactions = chatCompactions.slice();
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
                if (!saveConversationsToStorage(conversations.filter(c => c.id !== currentConversationId))) {
                    chatMessages = previousMessages;
                    chatCompactions = previousCompactions;
                    return false;
                }
                currentConversationId = null;
                workspaceConversationTitle = null;
                workspaceConversationTitleCustom = false;
                renderHistoryList();
            }
        } else {
            if (!saveCurrentConversation()) {
                chatMessages = previousMessages;
                chatCompactions = previousCompactions;
                return false;
            }
        }
        renderConversationMessages(Math.max(0, chatMessages.length - 1));
        requestWorkspaceCheckpoint({ reason: "undo-message" });
        notifyWorkspaceChange();
        return true;
    }

    function regenerateResponse() {
        if (!workspaceMutationAllowed() || chatStreaming || compactionController || !isServerRunning() || chatMessages.length === 0) return Promise.resolve(false);
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
        if (!workspacePersistentWriteAllowed()) return false;
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

    function saveCurrentConversation(options = {}) {
        if (!workspacePersistentWriteAllowed()) return false;
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
            const newId = currentConversationId || createConversationId();
            const convo = {
                id: newId,
                title: workspaceConversationTitle || generateConversationTitle(chatMessages),
                titleCustom: workspaceConversationTitleCustom,
                messages: chatMessages.slice(),
                compactions: chatCompactions.slice(),
                systemPrompt: sysPrompt ? sysPrompt.value : "",
                thinkingEffort: getChatThinkingEffort(),
                timestamp: Date.now()
            };
            conversations.unshift(convo);
        }

        const saved = saveConversationsToStorage(conversations);
        if (saved && !currentConversationId) currentConversationId = conversations[0].id;
        renderHistoryList();
        if (saved && !options.skipCheckpoint) requestWorkspaceCheckpoint({ reason: "conversation-save" });
        if (saved) notifyWorkspaceChange();
        return saved;
    }

    function generateConversationTitle(messages) {
        const first = messages.find(m => m.role === "user");
        if (!first) return "Untitled";
        const text = first.content.trim().replace(/\n/g, " ");
        return text.length > 50 ? text.slice(0, 50) + "..." : text;
    }

    async function loadConversation(id) {
        if (!workspaceMutationAllowed()) return false;
        const ownerEpoch = workspaceEpoch;
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
        if (!workspaceMutationAllowed(ownerEpoch)) return false;
        const conversations = getStoredConversations();
        const convo = conversations.find(c => c.id === id);
        if (!convo || !workspaceMutationAllowed(ownerEpoch)) return false;
        if (!invalidateWorkspace()) return false;

        currentConversationId = convo.id;
        workspaceConversationTitle = convo.title || null;
        workspaceConversationTitleCustom = Boolean(convo.titleCustom);
        streamingCheckpoint = null;
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
        requestWorkspaceCheckpoint({ reason: "conversation-load" });
        notifyWorkspaceChange();
        return true;
    }

    function renameConversation(id, title) {
        if (!workspaceMutationAllowed()) return false;
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
        if (id === currentConversationId) {
            workspaceConversationTitle = convo.title;
            workspaceConversationTitleCustom = true;
        }
        renderHistoryList();
        requestWorkspaceCheckpoint({ reason: "rename" });
        return true;
    }

    function requestConversationRename(id) {
        if (!workspaceMutationAllowed()) return false;
        const convo = getStoredConversations().find(item => item.id === id);
        if (!convo) return false;
        const prompt = typeof window.prompt === "function" ? window.prompt("Conversation name", convo.title || "") : "";
        if (prompt !== null && prompt !== undefined) renameConversation(id, prompt);
        return true;
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
        workspaceConversationTitle = null;
        workspaceConversationTitleCustom = false;
        chatMessages = [];
        chatCompactions = [];
        streamingCheckpoint = null;
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
        if (!workspaceMutationAllowed()) return false;
        const ownerEpoch = workspaceEpoch;
        if (currentConversationId === id && (chatStreaming || compactionController || sendPreflightPromise)) await abortActiveStream();
        if (!workspaceMutationAllowed(ownerEpoch)) return false;
        const conversations = getStoredConversations();
        const deleted = conversations.find(c => c.id === id);
        if (!deleted) return false;
        const filtered = conversations.filter(c => c.id !== id);
        if (!invalidateWorkspace()) return false;
        if (!saveConversationsToStorage(filtered)) return false;
        if (currentConversationId === id) resetActiveChatState();

        renderHistoryList();
        notifyWorkspaceChange();
        return true;
    }

    async function deleteAllConversations() {
        if (!workspaceMutationAllowed()) return false;
        const ownerEpoch = workspaceEpoch;
        if (chatStreaming || compactionController || sendPreflightPromise) await abortActiveStream();
        if (!workspaceMutationAllowed(ownerEpoch) || !invalidateWorkspace()) return false;
        if (!saveConversationsToStorage([])) return false;
        resetActiveChatState();
        renderHistoryList();
        notifyWorkspaceChange();
        return true;
    }

    async function startNewChat() {
        if (!workspaceMutationAllowed()) return false;
        const ownerEpoch = workspaceEpoch;
        reportCharacterImport();
        setChatToolsOpen(false);
        // Stop before saving: an in-flight stream would otherwise keep appending
        // tokens into the fresh chat and leave the composer disabled.
        if (chatStreaming || compactionController || sendPreflightPromise) await abortActiveStream();
        if (!workspaceMutationAllowed(ownerEpoch)) return false;
        discardPendingEdit();
        if (!saveCurrentConversation()) return false;
        if (!invalidateWorkspace()) return false;
        currentConversationId = null;
        workspaceConversationTitle = null;
        workspaceConversationTitleCustom = false;
        chatMessages = [];
        chatCompactions = [];
        streamingCheckpoint = null;
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
        notifyWorkspaceChange();
        return true;
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
                const confirmed = await requestConfirmation("Delete Conversation", `Delete "${convo.title || "Untitled"}"? This cannot be undone.`, "Delete");
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
        if (!workspaceMutationAllowed()) return false;
        const ownerEpoch = workspaceEpoch;
        setChatToolsOpen(false);
        if (chatStreaming || compactionController || sendPreflightPromise) await abortActiveStream();
        if (!workspaceMutationAllowed(ownerEpoch)) return false;
        discardPendingEdit();
        if (currentConversationId) {
            const deleted = await deleteConversation(currentConversationId);
            if (!deleted) return;
            if (snapshotStatsBaseline) snapshotStatsBaseline();
            return true;
        }
        if (!invalidateWorkspace()) return false;
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
        notifyWorkspaceChange();
        return true;
    }

    function reportCharacterImport(message = "") {
        const status = document.getElementById("chat-character-status");
        if (status) { status.textContent = message; status.hidden = !message; }
    }

    async function importCharacterCard(file) {
        if (!workspaceMutationAllowed() || !file || characterImportPending || chatStreaming || compactionController || sendPreflightPromise) return false;
        const ownerEpoch = workspaceEpoch;
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
                || !workspaceMutationAllowed(ownerEpoch) || chatStreaming || compactionController || sendPreflightPromise) {
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
            if (!invalidateWorkspace()) throw new Error("The chat changed while importing the character. Please try again.");
            if (!saveConversationsToStorage(conversations)) throw new Error("Could not save the character chat. The current conversation is still open.");
            if (!workspaceMutationAllowed(ownerEpoch) || !(await loadConversation(conversation.id))) {
                throw new Error("The chat changed while loading the character. Please try again.");
            }
            reportCharacterImport([`Started a chat with ${card.name}.`, ...card.notices].join(" "));
        } catch (error) {
            console.debug("Character card import did not complete", error);
            reportCharacterImport(error.message || "Could not read the character card. Try another JSON or PNG file.");
        } finally {
            characterImportPending = false;
            updateChatAvailability(isServerRunning());
            notifyWorkspaceChange();
        }
        return true;
    }

    function init() {
        initChatTools();
        window.LlamaGui.chatTools.init(() => {
            scheduleContextPreview(true);
            requestWorkspaceCheckpoint({ reason: "datetime-preference" });
        });
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
                if (!workspaceMutationAllowed()) return;
                setChatPreference(CHAT_WEB_SEARCH_STORAGE_KEY, String(webSearchToggle.checked));
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
                setChatPreference(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
            webSearchMaxResults.addEventListener("input", () => {
                const value = clampChatWebSearchMaxResults(webSearchMaxResults.value);
                setChatPreference(CHAT_WEB_SEARCH_MAX_RESULTS_STORAGE_KEY, String(value));
            });
        }

        if (thinkingEffort) {
            thinkingEffort.title = "Auto lets the loaded model choose. Off asks for a direct answer; levels request more or less reasoning when supported.";
            setChatThinkingEffort(thinkingEffort.value);
            thinkingEffort.addEventListener("change", () => {
                if (!workspaceMutationAllowed()) return;
                setChatThinkingEffort(thinkingEffort.value);
                refreshSidebarUI();
                saveCurrentConversation();
                scheduleContextPreview();
            });
        }

        chatInput.addEventListener("input", () => {
            scheduleContextPreview();
            requestWorkspaceCheckpoint({ reason: "draft" });
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
            if (!workspaceMutationAllowed()) return;
            scheduleContextPreview();
            sysCharCount.textContent = sysPrompt.value.length + " chars";
            requestWorkspaceCheckpoint({ reason: "system-prompt" });
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
                const confirmed = await requestConfirmation("Delete All Conversations", "Delete all saved conversations? This cannot be undone.", "Delete All");
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
                if (!workspaceMutationAllowed()) return;
                const raw = parseFloat(slider.value);
                display.textContent = raw.toFixed(meta.decimals);
                const val = meta.flag === "top_k" ? parseInt(slider.value, 10) : parseFloat(slider.value);
                setChatSamplerValue(meta.flag, val);
            });
        }

        for (const [inputId, meta] of Object.entries(CHAT_NUMERIC_INPUTS)) {
            const input = document.getElementById(inputId);
            if (!input) continue;
            input.addEventListener("change", () => {
                if (!workspaceMutationAllowed()) return;
                const raw = String(input.value || "").trim();
                const parsed = Number(raw);
                if (raw && Number.isFinite(parsed) && (!meta.integer || Number.isInteger(parsed))) {
                    setChatSamplerValue(meta.flag, parsed);
                }
                refreshSidebarUI();
            });
            input.addEventListener("input", () => {
                if (!workspaceMutationAllowed()) return;
                const raw = String(input.value || "").trim();
                const parsed = Number(raw);
                if (raw && Number.isFinite(parsed) && (!meta.integer || Number.isInteger(parsed))) {
                    setChatSamplerValue(meta.flag, parsed);
                }
                scheduleContextPreview();
            });
        }

        const clearBtn = document.getElementById("btn-chat-clear");
        if (clearBtn) {
            clearBtn.addEventListener("click", async () => {
                const confirmed = await requestConfirmation("Clear Current Chat", "Clear this chat, including its saved conversation and system prompt? This cannot be undone.", "Clear Chat");
                if (confirmed) await clearChat();
            });
        }

        refreshSidebarUI();
    }

    window.LlamaGui.chatUi = {
        configure,
        configureWorkspace,
        getTransferState,
        suspendTransfer,
        resumeTransfer,
        setOwnership,
        setHostAvailable,
        captureSnapshot,
        validateSnapshot,
        restoreSnapshot,
        resetWorkspace,
        saveForTransfer,
        captureLayout,
        restoreLayout,
        getChatSamplerValues,
        getChatSamplerFlagIds,
        setChatSamplerValue,
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
