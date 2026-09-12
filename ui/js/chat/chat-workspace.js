// Chat package (2/8): workspace ownership, transfer snapshots, validation and restore, sampler value plumbing.
(function () {
    window.LlamaGui = window.LlamaGui || {};

    const I = window.LlamaGui._chatInternal;
    const S = I.state;
    const {
        CHAT_SETTINGS_COLLAPSED_STORAGE_KEY,
        CHAT_HISTORY_COLLAPSED_STORAGE_KEY,
        CHAT_WEB_SEARCH_DEFAULT_MAX_RESULTS,
        CHAT_WEB_SEARCH_MIN_RESULTS,
        CHAT_WEB_SEARCH_MAX_RESULTS,
        CHAT_THINKING_EFFORTS,
        CHAT_WORKSPACE_SCHEMA_VERSION,
        CHAT_WORKSPACE_KIND,
        CHAT_MESSAGE_KEYS,
        CHAT_MESSAGE_ROLES,
        CHAT_SOURCE_KEYS,
        CHAT_TOOL_CALL_KEYS,
        CHAT_TOOL_FUNCTION_KEYS,
        CHAT_METADATA_KEYS,
        CHAT_METADATA_NESTED_KEYS,
        CHAT_TRANSFER_METADATA_KEYS,
        CHAT_NUMERIC_INPUTS,
    } = I.consts;

    function notifyWorkspaceChange() {
        updateBeforeUnloadGuard();
        if (typeof S.workspaceConfig.onChange !== "function") return;
        try {
            S.workspaceConfig.onChange();
        } catch (error) {
            console.warn("Chat workspace change callback failed", error);
        }
    }

    function workspaceMutationAllowed(expectedEpoch = S.workspaceEpoch) {
        return S.workspaceOwned && !S.workspaceSuspended && S.workspaceHostAvailable && expectedEpoch === S.workspaceEpoch;
    }

    function workspacePersistentWriteAllowed() {
        return S.workspaceOwned && S.workspaceHostAvailable && (!S.workspaceSuspended || S.workspaceTransferSave);
    }

    function workspaceBusyReason() {
        if (S.confirmationPending) return "A confirmation is pending.";
        if (S.characterImportPending) return "A character card is being imported.";
        if (S.pendingEdit) return "An edit is pending.";
        if (S.compactionController) return "Compaction is in progress.";
        if (S.sendPreflightPromise) return "A send is being prepared.";
        if (S.chatStreaming) return "A response is streaming.";
        return "";
    }

    function beforeUnloadIsRisky() {
        return S.workspaceOwned && S.workspaceHostAvailable
            && (S.chatStreaming || S.compactionController || S.sendPreflightPromise || S.workspaceCheckpointPending);
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
        if (risky && !S.beforeUnloadInstalled) {
            target.addEventListener("beforeunload", handleBeforeUnload);
            S.beforeUnloadInstalled = true;
        } else if (!risky && S.beforeUnloadInstalled) {
            target.removeEventListener?.("beforeunload", handleBeforeUnload);
            S.beforeUnloadInstalled = false;
        }
    }

    async function requestConfirmation(...args) {
        if (!workspaceMutationAllowed()) return false;
        const ownerEpoch = S.workspaceEpoch;
        S.confirmationPending += 1;
        I.updateChatAvailability(I.isServerRunning());
        notifyWorkspaceChange();
        try {
            const confirmed = typeof S.confirmAction === "function" ? await S.confirmAction(...args) : true;
            return Boolean(confirmed) && workspaceMutationAllowed(ownerEpoch);
        } finally {
            S.confirmationPending = Math.max(0, S.confirmationPending - 1);
            I.updateChatAvailability(I.isServerRunning());
            notifyWorkspaceChange();
        }
    }

    function getTransferState() {
        if (!S.workspaceOwned) return { allowed: false, reason: "Chat is owned by another window." };
        if (!S.workspaceHostAvailable) return { allowed: false, reason: "The chat host is unavailable." };
        if (S.workspaceSuspended) return { allowed: false, reason: "Chat transfer is already suspended." };
        const reason = workspaceBusyReason();
        if (reason) return { allowed: false, reason };
        return { allowed: true, reason: "" };
    }

    function configureWorkspace(options = {}) {
        S.workspaceConfig = {
            checkpoint: typeof options.checkpoint === "function" ? options.checkpoint : null,
            invalidate: typeof options.invalidate === "function" ? options.invalidate : null,
            onChange: typeof options.onChange === "function" ? options.onChange : null,
            detachedView: options.detachedView === true,
        };
        window.LlamaGui.chatTools.configureWorkspace?.({
            canMutate: () => workspaceMutationAllowed() || S.workspaceRestoreInProgress,
            onChange: notifyWorkspaceChange,
        });
        notifyWorkspaceChange();
        if (S.flagCore) I.updateChatAvailability(I.isServerRunning());
    }

    function suspendTransfer() {
        if (!getTransferState().allowed) return false;
        S.workspaceSuspended = true;
        clearWorkspaceCheckpointTimer();
        I.cancelContextPreview();
        I.updateChatAvailability(I.isServerRunning());
        notifyWorkspaceChange();
        return true;
    }

    function resumeTransfer() {
        if (!S.workspaceOwned) return false;
        S.workspaceSuspended = false;
        I.updateChatAvailability(I.isServerRunning());
        notifyWorkspaceChange();
        return true;
    }

    function setOwnership(active) {
        S.workspaceEpoch += 1;
        S.workspaceOwned = active === true;
        S.workspaceSuspended = !S.workspaceOwned;
        if (!S.workspaceOwned) {
            clearWorkspaceCheckpointTimer();
            S.workspaceCheckpointPending = false;
            I.cancelContextPreview();
            if (S.chatAbortController) S.chatAbortController.abort();
            if (S.compactionController) S.compactionController.abort();
        }
        I.updateChatAvailability(I.isServerRunning());
        notifyWorkspaceChange();
        return true;
    }

    function setHostAvailable(available) {
        const next = available === true;
        if (next !== S.workspaceHostAvailable) S.workspaceEpoch += 1;
        S.workspaceHostAvailable = next;
        if (!S.workspaceHostAvailable) {
            clearWorkspaceCheckpointTimer();
            S.workspaceCheckpointPending = false;
            I.cancelContextPreview();
            if (S.compactionController) S.compactionController.abort();
        }
        I.updateChatAvailability(I.isServerRunning());
        notifyWorkspaceChange();
    }

    function getChatSamplerValues() {
        const values = S.flagCore?.getFlagValues?.() || {};
        const result = {};
        for (const meta of Object.values(CHAT_NUMERIC_INPUTS)) {
            const value = I.normalizeSamplerNumber(values[meta.flag]);
            if (value !== null) result[meta.flag] = value;
        }
        return result;
    }

    function getChatSamplerFlagIds() {
        return Object.values(CHAT_NUMERIC_INPUTS).map(meta => meta.flag);
    }

    function setChatSamplerValue(flag, value) {
        const meta = Object.values(CHAT_NUMERIC_INPUTS).find(item => item.flag === flag);
        const normalized = I.normalizeSamplerNumber(value);
        if (!meta || normalized === null || (meta.integer && !Number.isInteger(normalized)) || !workspaceMutationAllowed()) return false;
        S.flagCore?.setFlagValue?.(flag, normalized);
        I.refreshSidebarUI();
        requestWorkspaceCheckpoint({ reason: "sampler" });
        return true;
    }

    function captureLayout() {
        return {
            focusMode: Boolean(S.chatFocusMode),
            settingsCollapsed: I.getStoredItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY) !== "false",
            historyCollapsed: I.getStoredItem(CHAT_HISTORY_COLLAPSED_STORAGE_KEY) !== "false",
        };
    }

    function restoreLayout(layout) {
        if (!layout || typeof layout !== "object") return false;
        if (typeof layout.focusMode !== "boolean"
            || typeof layout.settingsCollapsed !== "boolean"
            || typeof layout.historyCollapsed !== "boolean") return false;
        S.chatFocusMode = layout.focusMode;
        document.body?.classList.toggle("chat-focus-mode", S.chatFocusMode);
        I.updateChatFocusButton();
        if (!S.workspaceConfig.detachedView && workspaceMutationAllowed()) {
            I.setStoredItem(CHAT_SETTINGS_COLLAPSED_STORAGE_KEY, String(layout.settingsCollapsed));
            I.setStoredItem(CHAT_HISTORY_COLLAPSED_STORAGE_KEY, String(layout.historyCollapsed));
        }
        S.chatPanelLayouts.forEach(applyLayout => applyLayout());
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
        const active = S.currentConversationId && I.getStoredConversations().find(item => item.id === S.currentConversationId);
        return {
            id: S.currentConversationId || null,
            title: active?.title || S.workspaceConversationTitle || (S.chatMessages.length ? I.generateConversationTitle(S.chatMessages) : null),
            titleCustom: Boolean(active?.titleCustom ?? S.workspaceConversationTitleCustom),
        };
    }

    function captureSnapshot(metadata = {}) {
        const container = I.getChatMessagesContainer();
        const input = document.getElementById("chat-input");
        return {
            kind: CHAT_WORKSPACE_KIND,
            schemaVersion: CHAT_WORKSPACE_SCHEMA_VERSION,
            metadata: sanitizeTransferMetadata(metadata),
            conversation: getConversationTitleState(),
            messages: S.chatMessages.map(copyMessage).filter(Boolean),
            compactions: S.chatCompactions.map(copyCompaction).filter(Boolean),
            inputs: {
                systemPrompt: String(document.getElementById("chat-system-prompt")?.value || ""),
                thinkingEffort: I.getChatThinkingEffort(),
                draft: String(input?.value || ""),
                webSearchEnabled: I.isChatWebSearchEnabled(),
                webSearchMaxResults: I.getChatWebSearchMaxResults(),
                datetimeEnabled: Boolean(window.LlamaGui.chatTools.isEnabled?.()),
                autoCompaction: I.isAutoCompactionEnabled(),
            },
            view: {
                scroll: {
                    follow: Boolean(S.chatScrollState?.follow ?? I.isChatNearBottom(container)),
                    top: Number.isFinite(S.chatScrollState?.top) ? S.chatScrollState.top : Number(container?.scrollTop) || 0,
                },
                draftSelection: input && Number.isInteger(input.selectionStart) && Number.isInteger(input.selectionEnd)
                    ? { start: input.selectionStart, end: input.selectionEnd } : null,
            },
            streaming: copyStreamingCheckpoint(S.streamingCheckpoint),
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
        S.workspaceRestoreInProgress = true;
        try {
            S.currentConversationId = snapshot.conversation.id;
            S.workspaceConversationTitle = snapshot.conversation.title;
            S.workspaceConversationTitleCustom = snapshot.conversation.titleCustom;
            S.chatMessages = snapshot.messages.map(copyMessage).filter(Boolean);
            S.chatCompactions = snapshot.compactions.map(copyCompaction).filter(Boolean);
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
            I.setChatThinkingEffort(inputs.thinkingEffort);
            const webSearchToggle = document.getElementById("chat-web-search-toggle");
            if (webSearchToggle) webSearchToggle.checked = inputs.webSearchEnabled;
            const webSearchMaxResults = document.getElementById("chat-web-search-max-results");
            if (webSearchMaxResults) webSearchMaxResults.value = String(inputs.webSearchMaxResults);
            const autoToggle = document.getElementById("chat-auto-compact-toggle");
            if (autoToggle) autoToggle.checked = inputs.autoCompaction;
            window.LlamaGui.chatTools.setEnabled(inputs.datetimeEnabled, { persist: false });
            S.chatScrollState = { ...snapshot.view.scroll };
            S.streamingCheckpoint = copyStreamingCheckpoint(snapshot.streaming);
            if (S.streamingCheckpoint?.active) {
                const partial = {
                    role: "assistant",
                    content: S.streamingCheckpoint.content || "",
                    reasoning: S.streamingCheckpoint.reasoning || "",
                    sources: S.streamingCheckpoint.sources || [],
                    status: "stopped",
                    error: S.streamingCheckpoint.error || "",
                    metadata: S.streamingCheckpoint.metadata || {},
                    ...(S.streamingCheckpoint.toolMessages ? { toolMessages: S.streamingCheckpoint.toolMessages } : {}),
                };
                if (Number.isInteger(S.streamingCheckpoint.replacementIndex)
                    && S.streamingCheckpoint.replacementIndex >= 0
                    && S.streamingCheckpoint.replacementIndex < S.chatMessages.length) {
                    const previous = S.chatMessages[S.streamingCheckpoint.replacementIndex];
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
                    S.chatMessages[S.streamingCheckpoint.replacementIndex] = {
                        role: "assistant", ...previousVersions[selected], versions: previousVersions, versionIndex: selected,
                    };
                } else if (partial.content || partial.reasoning || partial.toolMessages?.length) {
                    S.chatMessages.push(partial);
                }
                S.streamingCheckpoint.active = false;
            }
            S.chatStreaming = false;
            S.chatAbortController = null;
            I.cancelContextPreview();
            I.renderConversationMessages();
            I.renderHistoryList();
            I.restoreChatScrollPosition();
            return true;
        } finally {
            S.workspaceRestoreInProgress = false;
            notifyWorkspaceChange();
        }
    }

    // Recovery can acquire the workspace lock before it knows whether a
    // valid checkpoint exists. Clear only this in-memory view for the empty
    // or tombstoned case; callers still decide when durable deletion occurs.
    function resetWorkspace() {
        if (!S.workspaceHostAvailable || !S.workspaceOwned) return false;
        S.workspaceRestoreInProgress = true;
        try {
            S.currentConversationId = null;
            S.workspaceConversationTitle = null;
            S.workspaceConversationTitleCustom = false;
            S.chatMessages = [];
            S.chatCompactions = [];
            S.streamingCheckpoint = null;
            S.workspaceCheckpointPending = false;
            S.chatStreaming = false;
            if (S.chatAbortController) S.chatAbortController.abort();
            if (S.compactionController) S.compactionController.abort();
            S.chatAbortController = null;
            I.discardPendingEdit();
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
            I.setChatThinkingEffort("auto");
            window.LlamaGui.chatTools.setEnabled(false, { persist: false });
            I.renderConversationMessages();
            I.renderHistoryList();
            notifyWorkspaceChange();
            return true;
        } finally {
            S.workspaceRestoreInProgress = false;
        }
    }

    function checkpointWorkspaceNow(metadata = {}) {
        if (typeof S.workspaceConfig.checkpoint !== "function") {
            S.workspaceCheckpointPending = false;
            updateBeforeUnloadGuard();
            return true;
        }
        if ((!S.workspaceOwned || !S.workspaceHostAvailable || S.workspaceSuspended) && !S.workspaceTransferSave) return false;
        try {
            const checkpointed = S.workspaceConfig.checkpoint(captureSnapshot(metadata)) !== false;
            if (checkpointed) S.workspaceCheckpointPending = false;
            updateBeforeUnloadGuard();
            return checkpointed;
        } catch (error) {
            console.warn("Chat workspace checkpoint failed", error);
            return false;
        }
    }

    function clearWorkspaceCheckpointTimer() {
        if (S.workspaceCheckpointTimer !== null) clearTimeout(S.workspaceCheckpointTimer);
        S.workspaceCheckpointTimer = null;
    }

    function requestWorkspaceCheckpoint(metadata = {}) {
        if (typeof S.workspaceConfig.checkpoint !== "function" || S.workspaceSuspended || !S.workspaceOwned || !S.workspaceHostAvailable) return;
        if (S.workspaceCheckpointTimer !== null) return;
        S.workspaceCheckpointPending = true;
        updateBeforeUnloadGuard();
        S.workspaceCheckpointTimer = setTimeout(() => {
            S.workspaceCheckpointTimer = null;
            checkpointWorkspaceNow(metadata);
        }, 750);
    }

    function invalidateWorkspace() {
        clearWorkspaceCheckpointTimer();
        if (typeof S.workspaceConfig.invalidate !== "function") return true;
        try {
            return S.workspaceConfig.invalidate() !== false;
        } catch (error) {
            console.warn("Chat workspace invalidation failed", error);
            return false;
        }
    }

    function saveForTransfer() {
        if (!S.workspaceOwned || !S.workspaceSuspended || !S.workspaceHostAvailable) return false;
        S.workspaceTransferSave = true;
        try {
            const saved = I.saveCurrentConversation({ skipCheckpoint: true });
            const checkpointed = checkpointWorkspaceNow({ reason: "transfer-save" });
            return saved && checkpointed;
        } finally {
            S.workspaceTransferSave = false;
        }
    }

    Object.assign(I, {
        notifyWorkspaceChange,
        workspaceMutationAllowed,
        workspacePersistentWriteAllowed,
        workspaceBusyReason,
        beforeUnloadIsRisky,
        handleBeforeUnload,
        updateBeforeUnloadGuard,
        requestConfirmation,
        getTransferState,
        configureWorkspace,
        suspendTransfer,
        resumeTransfer,
        setOwnership,
        setHostAvailable,
        getChatSamplerValues,
        getChatSamplerFlagIds,
        setChatSamplerValue,
        captureLayout,
        restoreLayout,
        copyScalar,
        copyKnownObject,
        copyMetadata,
        copySource,
        copyToolCall,
        copyMessage,
        copyCompaction,
        copyStreamingCheckpoint,
        sanitizeTransferMetadata,
        validateTransferMetadata,
        getConversationTitleState,
        captureSnapshot,
        hasOnlyKnownKeys,
        isSafeScalar,
        validateMetadata,
        validateSource,
        validateToolCall,
        validateMessage,
        validateSnapshot,
        restoreSnapshot,
        resetWorkspace,
        checkpointWorkspaceNow,
        clearWorkspaceCheckpointTimer,
        requestWorkspaceCheckpoint,
        invalidateWorkspace,
        saveForTransfer,
    });
})();
